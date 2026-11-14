// Bloomy — Admin stats view.
// GET /api/admin/stats?range=7|30|all — the metrics locked in v7 §59, plus
// additions beyond the locked spec, each flagged rather than silently folded in.
//
// Two definitions drive almost everything below:
//
// - RANGE: a rolling window on when the order was PLACED (orders.created_at,
//   availability_checks.checked_at, funnel_events.created_at) — not delivery
//   date, and not payment time (orders has no paid_at). So with a range
//   selected, paid_revenue means "orders placed in the range that are paid
//   now", not "money received in the range". `range` is whitelisted to
//   7 / 30 / anything-else-means-all and is passed as a query parameter,
//   never interpolated into the SQL.
// - VALID ORDER: not cancelled AND not refunded. total_revenue, paid_revenue,
//   average_order_value, top_products and source_breakdown all use this ONE
//   population. (v7 §59's total_revenue already excluded cancelled orders;
//   this pass also excludes refunded ones, since that money went back.)
//   Unpaid ZaloPay orders stay in it on purpose and are shown separately.
//
// REVENUE: what customers paid for goods after the coupon, WITHOUT shipping
// (subtotal − discount). Shipping is passed on to the delivery partner, so
// it isn't the shop's sales. Money-owed figures (refunded, unpaid ZaloPay,
// cancelled-unrefunded) stay on total_amount, since that is the real amount
// that moved or is owed.
//
// VAT: prices are tax-inclusive and only the rate is stored per order.
// vat_total = Σ per-order VAT, each round(total × rate / (100 + rate)) over
// the whole order total (goods after coupon plus shipping) — the same
// formula as pricing.js vatAmount(), so an order's VAT in the orders list
// and in this sum always agree.
//
// Additions beyond the locked spec:
// - cancelled_orders / cancellation_rate, refunded_orders / refunded_amount.
// - unpaid_zalopay_*: ZaloPay orders still pending/failed and not cancelled —
//   the payment drop-off signal.
// - cancelled_unrefunded_*: orders that were paid and then cancelled but not
//   yet marked refunded (orders.js allows this state). Money in hand that is
//   owed back; it is in neither revenue figure, so it gets its own row.
// - status_counts: orders in the range by fulfillment status. Together with
//   cancelled_orders they add up to total_orders.
// - availability: all five rejection reasons, which add up to the rejected
//   total behind rejection_rate. Counts are per cart ITEM, not per customer.
// - funnel: distinct sessions per step, limited to sessions whose `visit`
//   falls in the range, so every step is a subset of visits and conversion
//   can never exceed 100%. Steps are counted separately (sessions are per
//   browser tab), so they are not strictly nested. Isolated on purpose: if
//   funnel_events doesn't exist yet (app deployed before the schema apply)
//   only the funnel comes back null and the rest of the page still loads.

import { Router } from "express";
import pool = require("../db");
import { requireAdmin } from "./admin-auth";
import type { ProductSize } from "../types";
import type { AdminStatsBody } from "../shared/api-types";

// What the queries return. COUNT(...)::int is a number; SUM(...)::bigint comes back from node-postgres as a
// string, so those columns are typed string and converted below.
interface OrdersRow {
  total_orders: number; cancelled_orders: number; refunded_orders: number; refunded_amount: string;
  valid_orders: number; total_revenue: string; paid_revenue: string; vat_total: string;
  unpaid_zalopay_orders: number; unpaid_zalopay_amount: string;
  cancelled_unrefunded_orders: number; cancelled_unrefunded_amount: string;
  status_new: number; status_delivering: number; status_delivered: number;
}
interface TopProductRow { name: string; size: ProductSize | null; quantity_sold: number }
interface ChecksRow {
  total_checks: number; rejected_checks: number; sold_out_today_hits: number; cutoff_hits: number;
  discontinued_hits: number; window_passed_hits: number; flower_shortage_hits: number;
}
interface SourceRow { source: string; order_count: number; revenue: string }
interface FunnelRow { event: string; sessions: number }
interface ChannelRow { channel: string; order_count: number; revenue: string }

const router = Router();

const GOODS = `(subtotal - discount)`;
const VAT = `ROUND(total_amount * vat_rate / (100.0 + vat_rate))`;

// `days` is null for "all". Used as ($1::int IS NULL OR col >= ...) so the
// query shape is the same either way.
function rangeFilter(column: string): string {
  return `($1::int IS NULL OR ${column} >= now() - $1::int * interval '1 day')`;
}

function validOrder(prefix = ""): string {
  return `${prefix}fulfillment_status != 'cancelled' AND ${prefix}payment_status != 'refunded'`;
}

function parseRangeDays(value: unknown): 7 | 30 | null {
  if (value === "7") return 7;
  if (value === "30") return 30;
  return null;
}

router.get("/", requireAdmin, async (req, res, next) => {
  try {
    const days = parseRangeDays(req.query.range);
    const params = [days];

    const [ordersResult, topProductsResult, checksResult, sourceResult, funnelResult, channelResult] = await Promise.all([
      pool.query<OrdersRow>(
        `SELECT
           COUNT(*)::int AS total_orders,
           COUNT(*) FILTER (WHERE fulfillment_status = 'cancelled')::int AS cancelled_orders,
           COUNT(*) FILTER (WHERE payment_status = 'refunded')::int AS refunded_orders,
           COALESCE(SUM(total_amount) FILTER (WHERE payment_status = 'refunded'), 0)::bigint AS refunded_amount,
           COUNT(*) FILTER (WHERE ${validOrder()})::int AS valid_orders,
           COALESCE(SUM(${GOODS}) FILTER (WHERE ${validOrder()}), 0)::bigint AS total_revenue,
           COALESCE(SUM(${GOODS}) FILTER (WHERE ${validOrder()} AND payment_status = 'paid'), 0)::bigint AS paid_revenue,
           COALESCE(SUM(${VAT}) FILTER (WHERE ${validOrder()}), 0)::bigint AS vat_total,
           COUNT(*) FILTER (WHERE payment_method = 'zalopay' AND payment_status IN ('pending', 'failed')
                              AND fulfillment_status != 'cancelled')::int AS unpaid_zalopay_orders,
           COALESCE(SUM(total_amount) FILTER (WHERE payment_method = 'zalopay' AND payment_status IN ('pending', 'failed')
                              AND fulfillment_status != 'cancelled'), 0)::bigint AS unpaid_zalopay_amount,
           COUNT(*) FILTER (WHERE fulfillment_status = 'cancelled' AND payment_status = 'paid')::int AS cancelled_unrefunded_orders,
           COALESCE(SUM(total_amount) FILTER (WHERE fulfillment_status = 'cancelled' AND payment_status = 'paid'), 0)::bigint AS cancelled_unrefunded_amount,
           COUNT(*) FILTER (WHERE fulfillment_status = 'new')::int AS status_new,
           COUNT(*) FILTER (WHERE fulfillment_status = 'delivering')::int AS status_delivering,
           COUNT(*) FILTER (WHERE fulfillment_status = 'delivered')::int AS status_delivered
         FROM orders
         WHERE ${rangeFilter("created_at")}`,
        params
      ),
      pool.query<TopProductRow>(
        // Per product AND size, from the order's own snapshot (no join to
        // products: a line keeps its name even if the catalog changes).
        `SELECT oi.name, oi.size, SUM(oi.quantity)::int AS quantity_sold
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE ${validOrder("o.")} AND ${rangeFilter("o.created_at")}
         GROUP BY oi.name, oi.size
         ORDER BY quantity_sold DESC, oi.name
         LIMIT 5`,
        params
      ),
      pool.query<ChecksRow>(
        `SELECT
           COUNT(*)::int AS total_checks,
           COUNT(*) FILTER (WHERE result != 'available')::int AS rejected_checks,
           COUNT(*) FILTER (WHERE result = 'rejected_sold_out_today')::int AS sold_out_today_hits,
           COUNT(*) FILTER (WHERE result = 'rejected_past_cutoff')::int AS cutoff_hits,
           COUNT(*) FILTER (WHERE result = 'rejected_discontinued')::int AS discontinued_hits,
           COUNT(*) FILTER (WHERE result = 'rejected_window_passed')::int AS window_passed_hits,
           COUNT(*) FILTER (WHERE result = 'rejected_flower_shortage')::int AS flower_shortage_hits
         FROM availability_checks
         WHERE ${rangeFilter("checked_at")}`,
        params
      ),
      pool.query<SourceRow>(
        // Web traffic only: a counter (POS) sale has no traffic source and
        // would otherwise inflate "direct". Counter sales are their own row
        // in channel_breakdown below.
        `SELECT
           COALESCE(source, 'direct') AS source,
           COUNT(*)::int AS order_count,
           COALESCE(SUM(${GOODS}), 0)::bigint AS revenue
         FROM orders
         WHERE channel = 'web' AND ${validOrder()} AND ${rangeFilter("created_at")}
         GROUP BY COALESCE(source, 'direct')
         ORDER BY order_count DESC, source`,
        params
      ),
      pool
        .query<FunnelRow>(
          `WITH cohort AS (
             SELECT DISTINCT session_id FROM funnel_events
             WHERE event = 'visit' AND ${rangeFilter("created_at")}
           )
           SELECT e.event, COUNT(DISTINCT e.session_id)::int AS sessions
           FROM funnel_events e
           JOIN cohort c ON c.session_id = e.session_id
           GROUP BY e.event`,
          params
        )
        .catch((err) => {
          console.error("Bloomy: funnel stats query failed (is funnel_events applied?)", err);
          return null;
        }),
      pool.query<ChannelRow>(
        `SELECT
           CASE WHEN channel = 'pos' THEN 'pos' ELSE fulfillment_type::text END AS channel,
           COUNT(*)::int AS order_count,
           COALESCE(SUM(${GOODS}), 0)::bigint AS revenue
         FROM orders
         WHERE ${validOrder()} AND ${rangeFilter("created_at")}
         GROUP BY 1
         ORDER BY order_count DESC`,
        params
      ),
    ]);

    // Money sums are bigint in SQL (an int4 SUM overflows at ~2.1 billion VND
    // all-time and would 500 the whole page); node-postgres returns bigint as
    // a string, so they are converted back to numbers here.
    const raw = ordersResult.rows[0];
    const o = {
      ...raw,
      refunded_amount: Number(raw.refunded_amount),
      total_revenue: Number(raw.total_revenue),
      paid_revenue: Number(raw.paid_revenue),
      vat_total: Number(raw.vat_total),
      unpaid_zalopay_amount: Number(raw.unpaid_zalopay_amount),
      cancelled_unrefunded_amount: Number(raw.cancelled_unrefunded_amount),
    };
    const sourceRows = sourceResult.rows.map((row) => ({ ...row, revenue: Number(row.revenue) }));
    // channel: "delivery" / "pickup" (web orders) or "pos" (counter sales)
    const channelRows = channelResult.rows.map((row) => ({ ...row, revenue: Number(row.revenue) }));
    const checks = checksResult.rows[0];

    const rejectionRate = checks.total_checks > 0 ? checks.rejected_checks / checks.total_checks : null;
    const cancellationRate = o.total_orders > 0 ? o.cancelled_orders / o.total_orders : null;
    const averageOrderValue = o.valid_orders > 0 ? Math.round(o.total_revenue / o.valid_orders) : null;

    let funnel: Record<string, number> | null = null;
    let conversionRate: number | null = null;
    if (funnelResult) {
      funnel = { visit: 0, product_view: 0, add_to_cart: 0, checkout_view: 0, order_placed: 0 };
      for (const row of funnelResult.rows) funnel[row.event] = row.sessions;
      conversionRate = funnel.visit > 0 ? funnel.order_placed / funnel.visit : null;
    }

    const body: AdminStatsBody = {
      total_orders: o.total_orders,
      total_revenue: o.total_revenue,
      paid_revenue: o.paid_revenue,
      vat_total: o.vat_total,
      average_order_value: averageOrderValue,
      cancelled_orders: o.cancelled_orders,
      cancellation_rate: cancellationRate,
      refunded_orders: o.refunded_orders,
      refunded_amount: o.refunded_amount,
      unpaid_zalopay_orders: o.unpaid_zalopay_orders,
      unpaid_zalopay_amount: o.unpaid_zalopay_amount,
      cancelled_unrefunded_orders: o.cancelled_unrefunded_orders,
      cancelled_unrefunded_amount: o.cancelled_unrefunded_amount,
      status_counts: { new: o.status_new, delivering: o.status_delivering, delivered: o.status_delivered },
      top_products: topProductsResult.rows,
      source_breakdown: sourceRows,
      channel_breakdown: channelRows,
      rejection_rate: rejectionRate,
      sold_out_today_hits: checks.sold_out_today_hits,
      cutoff_hits: checks.cutoff_hits,
      discontinued_hits: checks.discontinued_hits,
      window_passed_hits: checks.window_passed_hits,
      flower_shortage_hits: checks.flower_shortage_hits,
      funnel,
      conversion_rate: conversionRate,
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

export = router;
