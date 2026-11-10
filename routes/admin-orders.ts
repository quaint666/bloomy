// Bloomy — Admin order list, delivery sheet, CSV export, status actions.
//
// GET    /api/admin/orders                 — full order list, each with its lines
// GET    /api/admin/orders/delivery-sheet   — one date's delivery + pickup orders, by window
// GET    /api/admin/orders/orders.csv       — full order export
// PATCH  /api/admin/orders/:id              — GHTK tracking code and internal admin note
// PATCH  /api/admin/orders/:id/mark-paid    — COD or cash only, direct toggle (the one
//   deliberate exception to "no order management" — v9 §46/§81: COD and cash at the
//   shop are paid in person, so there's no external system to verify against; the
//   admin marking it paid IS the source of truth here)
// POST   /api/admin/orders/:id/reverify     — ZaloPay only, real re-check (never a blind
//   toggle — reuses orders.js's own zaloQueryOrder + markOrderPaid)
// PATCH  /api/admin/orders/:id/fulfillment  — new/delivering/delivered/cancelled, transition-guarded;
//   cancelling from "new" returns the order's stems to flower stock (once)
// PATCH  /api/admin/orders/:id/refund       — paid → refunded only

import { Router } from "express";
import pool = require("../db");
import { requireAdmin } from "./admin-auth";
import ordersRouter = require("./orders");
import { vatAmount } from "../pricing";
import { isRealDate } from "./dates";
import { csvSafe, sendCsv } from "./csv";
import type { FulfillmentStatus, FulfillmentType, OrderChannel, PaymentMethod, PaymentStatus, ProductSize, TimeWindow } from "../types";

// One row of the order list (ORDER_LIST_COLUMNS below).
interface OrderListRow {
  id: number; token: string; channel: OrderChannel; fulfillment_type: FulfillmentType;
  sender_name: string; sender_phone: string; recipient_name: string; recipient_phone: string;
  ward_name: string | null; delivery_address: string | null; delivery_date: string;
  delivery_window: TimeWindow | null; notes: string | null; customer_email: string | null; source: string | null;
  subtotal: number; discount: number; shipping_fee: number; total_amount: number; vat_rate: number;
  coupon_code: string | null; payment_method: PaymentMethod; payment_status: PaymentStatus;
  fulfillment_status: FulfillmentStatus; tracking_code: string | null; admin_note: string | null; created_at: Date;
  invoice_requested: boolean; invoice_company_name: string | null; invoice_tax_code: string | null;
  invoice_address: string | null;
}
// A line as the order query returns it; addCustomDetails() then adds custom, flowers and style_label.
type ItemRow = Parameters<typeof ordersRouter.addCustomDetails>[1][number] & { order_id: number };
type ListItem = Pick<ItemRow, "name" | "size" | "quantity" | "price" | "custom" | "style_label" | "flowers" | "note">;
interface OrderWithItems extends OrderListRow { vat_amount: number; has_custom: boolean; items: ListItem[] }

const router = Router();

const ORDER_LIST_COLUMNS = `
  o.id, o.token, o.channel, o.fulfillment_type, o.sender_name, o.sender_phone,
  o.recipient_name, o.recipient_phone, w.name AS ward_name, o.delivery_address,
  o.delivery_date, o.delivery_window, o.notes, o.customer_email, o.source,
  o.subtotal, o.discount, o.shipping_fee, o.total_amount, o.vat_rate, o.coupon_code,
  o.payment_method, o.payment_status, o.fulfillment_status, o.tracking_code, o.admin_note,
  o.created_at, o.invoice_requested, o.invoice_company_name, o.invoice_tax_code, o.invoice_address
`;
const ORDER_FROM = `FROM orders o LEFT JOIN wards w ON w.id = o.ward_id`;

// Attaches each order's lines (snapshot name, size, quantity, price) and its
// VAT amount. One query for all lines, not one per order.
async function withItems(orders: OrderListRow[]): Promise<OrderWithItems[]> {
  if (orders.length === 0) return [];
  const { rows } = await pool.query<ItemRow>(
    `SELECT id, order_id, product_id, name, size, style, note, quantity, price_at_purchase AS price
     FROM order_items WHERE order_id = ANY($1) ORDER BY id`,
    [orders.map((o) => o.id)]
  );
  // A custom bouquet carries its flowers and the customer's note: the shop
  // needs both to make it (see addCustomDetails in orders.js).
  await ordersRouter.addCustomDetails(pool, rows);
  const byOrder = new Map<number, ListItem[]>();
  for (const r of rows) {
    if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, []);
    byOrder.get(r.order_id)!.push({
      name: r.name, size: r.size, quantity: r.quantity, price: r.price,
      custom: r.custom, style_label: r.style_label, flowers: r.flowers, note: r.note,
    });
  }
  return orders.map((o) => {
    const items = byOrder.get(o.id) || [];
    return { ...o, vat_amount: vatAmount(o.total_amount, o.vat_rate), has_custom: items.some((i) => i.custom), items };
  });
}

router.get("/", requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query<OrderListRow>(
      `SELECT ${ORDER_LIST_COLUMNS} ${ORDER_FROM} ORDER BY o.created_at DESC`
    );
    res.json(await withItems(result.rows));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/orders/delivery-sheet?date=YYYY-MM-DD
// The florist's daily work plan: what goes out (delivery) or gets collected
// (pickup), grouped by window, for one date (defaults to today, Vietnam
// time), with each order's lines. Excludes cancelled orders, POS sales
// (already handed over at the counter) and any ZaloPay order that isn't
// actually paid yet — those aren't confirmed. pending_zalopay_count exists
// specifically so an unpaid ZaloPay order for the day isn't silently
// forgotten just because it's excluded from the sheet itself.
// ---------------------------------------------------------------------------
router.get("/delivery-sheet", requireAdmin, async (req, res, next) => {
  try {
    const date = isRealDate(req.query.date)
      ? req.query.date
      : ordersRouter.todayVNDateString();

    const { rows } = await pool.query<OrderListRow>(
      `SELECT ${ORDER_LIST_COLUMNS} ${ORDER_FROM}
       WHERE o.delivery_date = $1
         AND o.channel = 'web'
         AND o.fulfillment_status != 'cancelled'
         AND NOT (o.payment_method = 'zalopay' AND o.payment_status != 'paid')
       ORDER BY o.delivery_window, o.id`,
      [date]
    );

    const windows: Record<TimeWindow, OrderWithItems[]> = { morning: [], afternoon: [], evening: [] };
    // Web orders always have a window (the database requires it); the
    // guard only keeps a bad row from crashing the whole sheet.
    for (const order of await withItems(rows)) {
      if (order.delivery_window && windows[order.delivery_window]) windows[order.delivery_window].push(order);
    }

    const { rows: pendingRows } = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM orders
       WHERE delivery_date = $1 AND channel = 'web' AND payment_method = 'zalopay'
         AND payment_status != 'paid' AND fulfillment_status != 'cancelled'`,
      [date]
    );

    res.json({ date, windows, pending_zalopay_count: pendingRows[0].count });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/orders/orders.csv
// Full order export for the analytics section — pivot tables, etc. UTF-8
// BOM prefix so Excel reads Vietnamese text correctly instead of garbling
// it; formula-injection guard on every field (see csvSafe above).
// ---------------------------------------------------------------------------
const SIZE_LABELS: Record<ProductSize, string> = { s: "Nhỏ", m: "Vừa", l: "Lớn" };

router.get("/orders.csv", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query<OrderListRow>(
      `SELECT ${ORDER_LIST_COLUMNS} ${ORDER_FROM} ORDER BY o.created_at DESC`
    );
    const orders = await withItems(rows);

    const header = [
      "id", "channel", "fulfillment_type", "sender_name", "sender_phone", "recipient_name", "recipient_phone",
      "ward", "delivery_address", "delivery_date", "delivery_window", "items", "notes", "customer_email", "source",
      "subtotal", "discount", "coupon_code", "shipping_fee", "total_amount", "vat_rate", "vat_amount",
      "payment_method", "payment_status", "fulfillment_status", "tracking_code", "admin_note", "created_at",
      "invoice_requested", "invoice_company_name", "invoice_tax_code", "invoice_address",
    ];
    const lines = [header.join(",")];

    for (const o of orders) {
      // One cell listing every line, e.g. "Bó Hồng Đỏ Classic (Vừa) x2; Hộp Quà Hoa Trắng x1"
      const items = o.items
        .map((i) => {
          if (i.custom) {
            const made = i.flowers!.map((f) => `${f.name} x${f.stems}`).join("; ");
            return `${i.name} [${i.style_label}: ${made}]${i.note ? ` ghi chú: ${i.note}` : ""} x${i.quantity}`;
          }
          return `${i.name}${i.size && SIZE_LABELS[i.size] ? ` (${SIZE_LABELS[i.size]})` : ""} x${i.quantity}`;
        })
        .join("; ");
      lines.push(
        [
          o.id, o.channel, o.fulfillment_type, o.sender_name, o.sender_phone, o.recipient_name, o.recipient_phone,
          o.ward_name, o.delivery_address, o.delivery_date, o.delivery_window, items,
          o.notes, o.customer_email, o.source, o.subtotal, o.discount, o.coupon_code, o.shipping_fee,
          o.total_amount, o.vat_rate, o.vat_amount, o.payment_method, o.payment_status, o.fulfillment_status,
          o.tracking_code, o.admin_note, o.created_at.toISOString(),
          o.invoice_requested, o.invoice_company_name, o.invoice_tax_code, o.invoice_address,
        ]
          .map(csvSafe)
          .join(",")
      );
    }

    sendCsv(res, "orders", lines);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/orders/:id   { tracking_code?, admin_note? }
// The GHTK tracking code (shown to the customer next to the order code) and
// the internal note (never shown to the customer). Empty text clears it.
// ---------------------------------------------------------------------------
function cleanText(value: unknown, max: number): string | null | undefined | false {
  if (value === undefined) return undefined; // not sent: leave the column alone
  if (value === null) return null;
  if (typeof value !== "string") return false; // wrong type: reject
  const v = value.trim();
  if (v.length > max) return false;
  return v || null;
}

router.patch("/:id", requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });

    const tracking = cleanText(req.body.tracking_code, 50);
    const note = cleanText(req.body.admin_note, 1000);
    if (tracking === false || note === false) return res.status(400).json({ error: "invalid_payload" });
    if (tracking === undefined && note === undefined) return res.status(400).json({ error: "nothing_to_update" });

    // Each column changes only when it was sent ($4 / $5 say which).
    const { rows } = await pool.query<{ id: number; tracking_code: string | null; admin_note: string | null }>(
      `UPDATE orders SET
         tracking_code = CASE WHEN $4 THEN $2 ELSE tracking_code END,
         admin_note    = CASE WHEN $5 THEN $3 ELSE admin_note END
       WHERE id = $1
       RETURNING id, tracking_code, admin_note`,
      [id, tracking ?? null, note ?? null, tracking !== undefined, note !== undefined]
    );
    if (rows.length === 0) return res.status(404).json({ error: "order_not_found" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id/mark-paid", requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid order id" });
    }

    const { rows } = await pool.query<{ id: number; payment_method: PaymentMethod; payment_status: PaymentStatus }>(
      `SELECT id, payment_method, payment_status FROM orders WHERE id = $1`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }
    const order = rows[0];
    if (order.payment_method !== "cod" && order.payment_method !== "cash") {
      return res.status(400).json({ error: "not_paid_in_person" });
    }
    // Previously unguarded — would silently flip an already-paid or a
    // refunded order back to 'paid'. Now only a genuine pending/failed →
    // paid transition is allowed.
    if (!["pending", "failed"].includes(order.payment_status)) {
      return res.status(409).json({ error: "not_eligible_for_mark_paid", payment_status: order.payment_status });
    }

    const updated = await pool.query<{ id: number; payment_status: PaymentStatus }>(
      `UPDATE orders SET payment_status = 'paid'
       WHERE id = $1 AND payment_status IN ('pending', 'failed')
       RETURNING id, payment_status`,
      [id]
    );
    if (updated.rows.length === 0) {
      // Lost a race with something else updating this order between the
      // SELECT above and this UPDATE — rare, but report it plainly rather
      // than pretending success.
      return res.status(409).json({ error: "not_eligible_for_mark_paid" });
    }
    res.json(updated.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/reverify", requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid order id" });
    }

    const { rows } = await pool.query<{ id: number; payment_method: PaymentMethod; payment_status: PaymentStatus; app_trans_id: string | null; total_amount: number }>(
      `SELECT id, payment_method, payment_status, app_trans_id, total_amount
       FROM orders WHERE id = $1`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }
    const order = rows[0];

    if (order.payment_method !== "zalopay") {
      return res.status(400).json({ error: "not_a_zalopay_order" });
    }
    if (order.payment_status === "paid" || order.payment_status === "refunded") {
      return res.json({ payment_status: order.payment_status });
    }
    if (!order.app_trans_id) {
      return res.status(409).json({ error: "no_zalopay_attempt_yet" });
    }

    const zpRes = await ordersRouter.zaloQueryOrder(order.app_trans_id);

    if (zpRes.return_code === 1 && zpRes.is_processing === false && zpRes.amount === order.total_amount) {
      await ordersRouter.markOrderPaid(order.id, zpRes.zp_trans_id);
      return res.json({ payment_status: "paid" });
    }

    return res.json({ payment_status: "pending" });
  } catch (err) {
    next(err);
  }
});

// Which fulfillment_status values a given current value may move to.
// delivered/cancelled are both terminal — no further changes from either.
const ALLOWED_FULFILLMENT_TRANSITIONS: Record<FulfillmentStatus, FulfillmentStatus[]> = {
  new: ["delivering", "cancelled"],
  delivering: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
};

router.patch("/:id/fulfillment", requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });

    const { status } = req.body;
    if (!["new", "delivering", "delivered", "cancelled"].includes(status)) {
      return res.status(400).json({ error: "invalid_status" });
    }

    const { rows } = await pool.query<{ id: number; fulfillment_status: FulfillmentStatus; payment_method: PaymentMethod; payment_status: PaymentStatus }>(
      `SELECT id, fulfillment_status, payment_method, payment_status FROM orders WHERE id = $1`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "order_not_found" });
    const order = rows[0];

    // Once refunded, an order is done regardless of where fulfillment_status
    // happened to be — there's no reason to keep moving a refunded order
    // toward delivery, and "cancelled" no longer means anything once the
    // money's already back. refund is a separate action (below) with no
    // fulfillment_status requirement, so this can be reached with
    // fulfillment_status still 'new'; treat it the same as any other
    // terminal state.
    const allowedNext: FulfillmentStatus[] =
      order.payment_status === "refunded" ? [] : ALLOWED_FULFILLMENT_TRANSITIONS[order.fulfillment_status] || [];
    if (!allowedNext.includes(status)) {
      return res.status(409).json({ error: "invalid_transition", from: order.fulfillment_status, to: status });
    }

    // An unpaid ZaloPay order can't start out for delivery — COD's own
    // "pay on delivery" model is exempt, since COD is never "paid" before
    // delivery by design.
    if (status === "delivering" && order.payment_method === "zalopay" && order.payment_status !== "paid") {
      return res.status(409).json({ error: "zalopay_not_paid_yet" });
    }

    // COD is collected at the door and cash at the counter — marking such
    // an order delivered ("Đã nhận" for pickup) means money changed hands,
    // so payment_status becomes 'paid' in the same update. Only when it's
    // still 'pending': never overwrite a 'refunded' order (shouldn't happen
    // given the transition table above, since 'delivered' is terminal, but
    // guarded explicitly rather than assumed).
    const paidInPerson = order.payment_method === "cod" || order.payment_method === "cash";
    const alsoMarkPaid = status === "delivered" && paidInPerson && order.payment_status === "pending";

    // Cancelling while still "new" returns the stems the order took; once
    // it reached "delivering" the bouquet is made and its flowers are spent.
    // The status UPDATE is guarded on the status we just read, inside one
    // transaction with the stock return, so two clicks (or two admin tabs)
    // can't return the same stems twice — the second UPDATE matches nothing.
    const returnStock = status === "cancelled" && order.fulfillment_status === "new";

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: updated } = await client.query<{ id: number; fulfillment_status: FulfillmentStatus; payment_status: PaymentStatus }>(
        `UPDATE orders SET fulfillment_status = $1,
           payment_status = CASE WHEN $4 THEN 'paid'::payment_status ELSE payment_status END
         WHERE id = $2 AND fulfillment_status = $3
         RETURNING id, fulfillment_status, payment_status`,
        [status, id, order.fulfillment_status, alsoMarkPaid]
      );
      if (updated.length === 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "invalid_transition" });
      }
      if (returnStock) {
        await ordersRouter.returnOrderStock(client, id);
      }
      await client.query("COMMIT");
      res.json(updated[0]);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/orders/:id/refund
// Manual, by design — matches terms.html §6: a ZaloPay refund happens in
// ZaloPay's own merchant portal first, a COD "refund" is settled directly
// with the customer over Zalo/hotline; this just records that it happened.
// Only allowed from 'paid', so an order can't be marked refunded twice or
// refunded before it was ever paid.
// ---------------------------------------------------------------------------
router.patch("/:id/refund", requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });

    const { rows } = await pool.query<{ id: number; payment_status: PaymentStatus }>(
      `UPDATE orders SET payment_status = 'refunded'
       WHERE id = $1 AND payment_status = 'paid'
       RETURNING id, payment_status`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(409).json({ error: "not_eligible_for_refund" });
    }
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

export = router;
