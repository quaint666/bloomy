// The statistics screen's API (GET /api/admin/stats?range=7|30|all). Run from the repo root with the server running on the same
// database:  node tests/admin_stats_test.mjs   (npm test sets it up). IT WRITES orders (straight into the table) and removes them.
//
// The other suites leave orders behind in the database while they run, so every figure is checked as the CHANGE the orders written
// here make: the stats are read before and after, and the difference must be exactly what these seven orders add up to.
//
// Proves: revenue is goods after the coupon without the delivery fee, and only for orders that are neither cancelled nor refunded;
// paid revenue only counts paid ones; VAT is summed per order from the total (rounded per order, as the orders list shows it);
// cancelled, refunded, unpaid-ZaloPay and cancelled-but-not-refunded orders each land in their own figure; the status counts and
// cancelled add up to the total; the channel and source breakdowns; the 7 and 30 day ranges leave out an old order and "all" keeps it;
// an employee is refused. Does NOT prove: the page (jsdom and browser suites), the funnel or the availability figures.

import { createRequire } from "node:module";
import path from "node:path";
import crypto from "node:crypto";
import { makeAdmin } from "./lib/admin-session.mjs";

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const require = createRequire(path.join(process.cwd(), "package.json"));
const { Pool } = require("pg");
const pool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1", port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || "quaint", database: process.env.DB_NAME || "bloomy", password: process.env.DB_PASSWORD || "dev",
});
let passed = 0, failed = 0;
function check(name, cond, extra = "") { if (cond) passed++; else { failed++; console.log(`FAIL ${name}${extra ? " :: " + extra : ""}`); } }
{
  const row = (await pool.query("SELECT shop_address, contact_phone FROM settings")).rows[0];
  const api = await (await fetch(BASE + "/api/settings")).json();
  if (!row || row.shop_address !== api.shop_address || row.contact_phone !== api.contact_phone) { console.log("FAIL this script is connected to a different database than the server at " + BASE); process.exit(2); }
}

const manager = await makeAdmin(pool, BASE, "stats", "manager");
const employee = await makeAdmin(pool, BASE, "stats", "employee");
const stats = async (range) => (await manager.api("GET", `/api/admin/stats${range ? `?range=${range}` : ""}`)).data;
const date = new Date(Date.now() + 7 * 3600e3 + 3 * 86400e3).toISOString().slice(0, 10);
const tokens = [];
const ward = (await pool.query("SELECT id FROM wards ORDER BY id LIMIT 1")).rows[0].id;
async function order(o) {
  const token = crypto.randomBytes(24).toString("hex");
  tokens.push(token);
  const delivery = o.type === "delivery", pos = o.channel === "pos";
  await pool.query(
    `INSERT INTO orders (token, channel, fulfillment_type, sender_name, sender_phone, recipient_name, recipient_phone, ward_id, delivery_address, delivery_date, delivery_window,
                         subtotal, discount, shipping_fee, total_amount, vat_rate, payment_method, payment_status, fulfillment_status, source, created_by, created_at)
     VALUES ($1, $2, $3, 'Kiểm thử', '0912345678', 'Kiểm thử', '0987654321', $4, $5, $6, $7, $8, $9, $10, $11, 10, $12, $13, $14, $15, $16, now() - ($17 || ' days')::interval)`,
    [token, pos ? "pos" : "web", o.type ?? "pickup", delivery ? ward : null, delivery ? "1 Đường thử" : null, date, pos ? null : "morning",
     o.subtotal, o.discount ?? 0, o.shipping ?? 0, o.subtotal - (o.discount ?? 0) + (o.shipping ?? 0), o.method, o.payment, o.fulfillment, o.source ?? null, pos ? manager.id : null, String(o.daysAgo ?? 0)]);
}
const before = { all: await stats(), d7: await stats("7"), d30: await stats("30") };
try {
  check("an employee is refused the statistics (403)", (await employee.api("GET", "/api/admin/stats")).status === 403);
  await order({ subtotal: 500000, discount: 50000, method: "cash", payment: "paid", fulfillment: "delivered", source: "facebook" });                       // A: valid, paid, goods 450000, vat of 450000
  await order({ subtotal: 300000, shipping: 25000, type: "delivery", method: "cod", payment: "pending", fulfillment: "new" });                           // B: valid, goods 300000, total 325000
  await order({ subtotal: 200000, method: "zalopay", payment: "pending", fulfillment: "new" });                                                          // C: valid, unpaid ZaloPay
  await order({ subtotal: 400000, method: "zalopay", payment: "paid", fulfillment: "cancelled" });                                                       // D: cancelled, paid, not refunded
  await order({ subtotal: 100000, method: "zalopay", payment: "refunded", fulfillment: "new" });                                                         // E: refunded
  await order({ subtotal: 80000, channel: "pos", method: "cash", payment: "paid", fulfillment: "delivered" });                                           // F: a counter sale
  await order({ subtotal: 60000, method: "cash", payment: "paid", fulfillment: "delivered", daysAgo: 40 });                                              // G: valid, but 40 days old
  const after = { all: await stats(), d7: await stats("7"), d30: await stats("30") };
  const d = (range, key) => Number(after[range][key]) - Number(before[range][key]);
  const row = (range, list, name, field) => (after[range][list].find((r) => (r.channel ?? r.source) === name)?.[field] ?? 0) - (before[range][list].find((r) => (r.channel ?? r.source) === name)?.[field] ?? 0);

  for (const [range, label, includesOld] of [["all", "all time", true], ["d30", "30 days", false], ["d7", "7 days", false]]) {
    const old = includesOld ? 1 : 0;   // G is in "all" only
    check(`${label}: total orders +${6 + old}`, d(range, "total_orders") === 6 + old, String(d(range, "total_orders")));
    check(`${label}: revenue is goods after the coupon, no delivery fee, no cancelled or refunded order (+${450000 + 300000 + 200000 + 80000 + old * 60000})`, d(range, "total_revenue") === 450000 + 300000 + 200000 + 80000 + old * 60000, String(d(range, "total_revenue")));
    check(`${label}: paid revenue counts the paid valid orders only (+${450000 + 80000 + old * 60000})`, d(range, "paid_revenue") === 450000 + 80000 + old * 60000, String(d(range, "paid_revenue")));
    check(`${label}: VAT is rounded per order from its total (+${40909 + 29545 + 18182 + 7273 + old * 5455})`, d(range, "vat_total") === 40909 + 29545 + 18182 + 7273 + old * 5455, String(d(range, "vat_total")));
    check(`${label}: cancelled +1, refunded +1 with its amount, unpaid ZaloPay +1 with its amount, cancelled-but-not-refunded +1 with its amount`, d(range, "cancelled_orders") === 1 && d(range, "refunded_orders") === 1 && d(range, "refunded_amount") === 100000 && d(range, "unpaid_zalopay_orders") === 1 && d(range, "unpaid_zalopay_amount") === 200000 && d(range, "cancelled_unrefunded_orders") === 1 && d(range, "cancelled_unrefunded_amount") === 400000);
    const sc = (k) => after[range].status_counts[k] - before[range].status_counts[k];
    check(`${label}: status counts new +3, delivered +${2 + old}, and with cancelled they add up to the total`, sc("new") === 3 && sc("delivered") === 2 + old && sc("new") + sc("delivering") + sc("delivered") + d(range, "cancelled_orders") === d(range, "total_orders"), JSON.stringify(after[range].status_counts));
    check(`${label}: channels: delivery +1 (B), pos +1 (F), pickup +${2 + old} (A, C${old ? ", G" : ""})`, row(range, "channel_breakdown", "delivery", "order_count") === 1 && row(range, "channel_breakdown", "pos", "order_count") === 1 && row(range, "channel_breakdown", "pickup", "order_count") === 2 + old && row(range, "channel_breakdown", "pos", "revenue") === 80000);
    check(`${label}: sources: facebook +1 with 450000, direct +${2 + old} (web only: the counter sale is not "direct")`, row(range, "source_breakdown", "facebook", "order_count") === 1 && row(range, "source_breakdown", "facebook", "revenue") === 450000 && row(range, "source_breakdown", "direct", "order_count") === 2 + old, `${row(range, "source_breakdown", "direct", "order_count")}`);
  }
  check("a range that is not 7 or 30 means all time (the same answer as no range)", (await stats("999")).total_orders === after.all.total_orders);
  check("average order value is revenue over valid orders (rounded)", after.all.average_order_value === Math.round(after.all.total_revenue / (await pool.query("SELECT COUNT(*)::int AS n FROM orders WHERE fulfillment_status <> 'cancelled' AND payment_status <> 'refunded'")).rows[0].n));
} finally {
  await pool.query("DELETE FROM orders WHERE token = ANY($1)", [tokens]);
  await manager.cleanup(); await employee.cleanup();
}
check("cleanup: no test orders left", Number((await pool.query("SELECT COUNT(*) FROM orders WHERE token = ANY($1)", [tokens])).rows[0].count) === 0);
await pool.end();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
