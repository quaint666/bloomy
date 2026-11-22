// The admin order screen's API (routes/admin-orders.ts): the status machine, paying and refunding, and what the delivery sheet
// counts. Orders are written straight into the tables (with the lines and the flowers they took, as POST /api/orders leaves
// them), so no order limiter is used and every figure is known.
//
// Run from the repo root with the server running on the same database:  node tests/admin_orders_test.mjs   (npm test sets it up)
// IT WRITES orders and changes flower stock, and puts everything back in a finally block. Local database only.
//
// Proves: a refund before delivery cancels the order and returns its stems exactly once (two clicks, two parallel requests);
// a refund after it went out keeps its status and stems; unpaid, unknown and already-refunded orders are refused; the status
// transitions follow the table (a ZaloPay order needs its payment before it goes out, COD/cash is marked paid on delivery, a
// cancel returns the stems once); mark-paid is for COD/cash only and only from pending/failed; the delivery sheet leaves out
// cancelled and unpaid ZaloPay orders and counts only the unpaid ones, never a refunded one.
// Does NOT prove: the screen (web/admin-orders.ts), ZaloPay's re-verify (ZaloPay is unreachable), or the emails.

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

const date = new Date(Date.now() + 7 * 3600e3 + 3 * 86400e3).toISOString().slice(0, 10);
const STEMS = 7, QTY = 2; // one bouquet uses 7 stems of the flower; the line has 2 bouquets: 14 stems taken
const flower = (await pool.query("SELECT id, stock FROM flowers ORDER BY id LIMIT 1")).rows[0];
const flowerStockBefore = flower.stock;
await pool.query("UPDATE flowers SET stock = 1000 WHERE id = $1", [flower.id]);
const stock = async () => (await pool.query("SELECT stock FROM flowers WHERE id = $1", [flower.id])).rows[0].stock;
const tokens = [];

// An order as the checkout leaves it: the row, one line of two bouquets, the flowers one bouquet uses, and the stems taken.
async function order({ method = "zalopay", payment = "paid", fulfillment = "new", type = "pickup", wardId = null, sender = "Kiểm thử gửi" } = {}) {
  const token = crypto.randomBytes(24).toString("hex");
  tokens.push(token);
  const delivery = type === "delivery";
  const { rows } = await pool.query(
    `INSERT INTO orders (token, channel, fulfillment_type, sender_name, sender_phone, recipient_name, recipient_phone, ward_id, delivery_address,
                         delivery_date, delivery_window, subtotal, discount, shipping_fee, total_amount, vat_rate, payment_method, payment_status, fulfillment_status, app_trans_id)
     VALUES ($1, 'web', $2, $10, '0912345678', 'Kiểm thử nhận', '0987654321', $3, $4, $5, 'morning', 900000, 0, 0, 900000, 10, $6, $7, $8, $9) RETURNING id`,
    [token, type, delivery ? wardId : null, delivery ? "1 Đường thử" : null, date, method, payment, fulfillment, method === "zalopay" ? `t${crypto.randomBytes(4).toString("hex")}` : null, sender]);
  const id = rows[0].id;
  const item = (await pool.query("INSERT INTO order_items (order_id, product_id, name, size, style, quantity, price_at_purchase) SELECT $1, id, 'Bó thử', 'm', style, $2, 450000 FROM products WHERE id = 9 RETURNING id", [id, QTY])).rows[0].id;
  await pool.query("INSERT INTO order_item_flowers (order_item_id, flower_id, stems, price_per_stem) VALUES ($1, $2, $3, 1000)", [item, flower.id, STEMS]);
  await pool.query("UPDATE flowers SET stock = stock - $2 WHERE id = $1", [flower.id, STEMS * QTY]);
  return id;
}
const state = async (id) => (await pool.query("SELECT payment_status, fulfillment_status FROM orders WHERE id = $1", [id])).rows[0];

const manager = await makeAdmin(pool, BASE, "orders", "manager");
const { api } = manager;
try {
  const ward = (await pool.query("SELECT id FROM wards ORDER BY id LIMIT 1")).rows[0].id;
  const taken = STEMS * QTY;

  // ---- 1. refund
  {
    const id = await order();
    const before = await stock();
    const r = await api("PATCH", `/api/admin/orders/${id}/refund`);
    check("refund of a paid order that is still new → 200 refunded, and the answer says it is now cancelled", r.status === 200 && r.data?.payment_status === "refunded" && r.data?.fulfillment_status === "cancelled", JSON.stringify(r.data));
    check("…the order is refunded and cancelled in the database", JSON.stringify(await state(id)) === JSON.stringify({ payment_status: "refunded", fulfillment_status: "cancelled" }));
    check(`…and its ${taken} stems are back in the stock (not before, not twice)`, (await stock()) === before + taken, `${before} -> ${await stock()}`);
    const again = await api("PATCH", `/api/admin/orders/${id}/refund`);
    check("a second refund → 409 not_eligible_for_refund and no more stems come back", again.status === 409 && again.data?.error === "not_eligible_for_refund" && (await stock()) === before + taken, JSON.stringify(again.data));
    const cancel = await api("PATCH", `/api/admin/orders/${id}/fulfillment`, { status: "cancelled" });
    check("…and cancelling it again is refused (409) with nothing returned", cancel.status === 409 && (await stock()) === before + taken);
  }
  {
    const id = await order();
    const before = await stock();
    const both = await Promise.all([api("PATCH", `/api/admin/orders/${id}/refund`), api("PATCH", `/api/admin/orders/${id}/refund`)]);
    check("two refunds at the same moment: exactly one wins (200) and one is refused (409)", both.map((x) => x.status).sort().join() === "200,409", both.map((x) => x.status).join());
    check("…and the stems came back once", (await stock()) === before + taken, `${before} -> ${await stock()}`);
  }
  {
    const id = await order({ fulfillment: "delivering" });
    const before = await stock();
    const r = await api("PATCH", `/api/admin/orders/${id}/refund`);
    check("refund of an order already out for delivery → 200, it stays 'delivering', its stems are not returned (the bouquet is made)", r.status === 200 && r.data?.fulfillment_status === "delivering" && (await state(id)).fulfillment_status === "delivering" && (await stock()) === before, JSON.stringify(r.data));
  }
  {
    const id = await order({ method: "cod", payment: "paid", fulfillment: "delivered", type: "delivery", wardId: ward });
    const before = await stock();
    const r = await api("PATCH", `/api/admin/orders/${id}/refund`);
    check("refund of a delivered COD order → 200, it stays delivered, no stems returned", r.status === 200 && (await state(id)).fulfillment_status === "delivered" && (await stock()) === before);
  }
  for (const [name, opts] of [["an unpaid order", { payment: "pending" }], ["a failed payment", { payment: "failed" }]]) {
    const id = await order(opts);
    const r = await api("PATCH", `/api/admin/orders/${id}/refund`);
    check(`refund of ${name} → 409`, r.status === 409 && (await state(id)).payment_status === opts.payment, JSON.stringify(r.data));
  }
  check("refund of an order that does not exist → 409 (nothing to refund)", (await api("PATCH", "/api/admin/orders/99999999/refund")).status === 409);
  check("refund with an id that is not a number → 400", (await api("PATCH", "/api/admin/orders/abc/refund")).status === 400);

  // ---- 2. the status machine
  {
    const id = await order({ payment: "pending" });
    const out = await api("PATCH", `/api/admin/orders/${id}/fulfillment`, { status: "delivering" });
    check("a ZaloPay order that is not paid cannot go out for delivery (409 zalopay_not_paid_yet)", out.status === 409 && out.data?.error === "zalopay_not_paid_yet", JSON.stringify(out.data));
    const skip = await api("PATCH", `/api/admin/orders/${id}/fulfillment`, { status: "delivered" });
    check("new → delivered directly is refused (409 invalid_transition)", skip.status === 409 && skip.data?.error === "invalid_transition");
  }
  {
    const id = await order({ method: "cod", payment: "pending", type: "delivery", wardId: ward });
    check("a COD order may go out unpaid", (await api("PATCH", `/api/admin/orders/${id}/fulfillment`, { status: "delivering" })).status === 200);
    const done = await api("PATCH", `/api/admin/orders/${id}/fulfillment`, { status: "delivered" });
    check("…and delivering it marks it paid in the same step (the money changed hands at the door)", done.status === 200 && done.data?.payment_status === "paid" && done.data?.fulfillment_status === "delivered", JSON.stringify(done.data));
    check("a delivered order has no next status (409)", (await api("PATCH", `/api/admin/orders/${id}/fulfillment`, { status: "cancelled" })).status === 409);
  }
  {
    const id = await order({ method: "cash", payment: "pending", type: "pickup" });
    await api("PATCH", `/api/admin/orders/${id}/fulfillment`, { status: "delivering" });
    const done = await api("PATCH", `/api/admin/orders/${id}/fulfillment`, { status: "delivered" });
    check("a cash pickup order is marked paid when handed over", done.data?.payment_status === "paid");
  }
  {
    const id = await order({ payment: "pending" });
    const before = await stock();
    const c = await api("PATCH", `/api/admin/orders/${id}/fulfillment`, { status: "cancelled" });
    check(`cancelling a new order → 200 and its ${taken} stems come back`, c.status === 200 && (await stock()) === before + taken, `${before} -> ${await stock()}`);
    const c2 = await api("PATCH", `/api/admin/orders/${id}/fulfillment`, { status: "cancelled" });
    check("cancelling it again → 409 and nothing more comes back", c2.status === 409 && (await stock()) === before + taken);
    const both = await (async () => { const id2 = await order({ payment: "pending" }); const b = await stock(); const r = await Promise.all([api("PATCH", `/api/admin/orders/${id2}/fulfillment`, { status: "cancelled" }), api("PATCH", `/api/admin/orders/${id2}/fulfillment`, { status: "cancelled" })]); return { codes: r.map((x) => x.status).sort().join(), delta: (await stock()) - b }; })();
    check("two cancels at once: one wins, the stems return once", both.codes === "200,409" && both.delta === taken, JSON.stringify(both));
  }
  {
    const id = await order({ payment: "paid", fulfillment: "delivering" });
    const before = await stock();
    const c = await api("PATCH", `/api/admin/orders/${id}/fulfillment`, { status: "cancelled" });
    check("cancelling an order already out for delivery is allowed but returns no stems (the flowers are spent)", c.status === 200 && (await stock()) === before);
  }
  check("an unknown status → 400 invalid_status", (await api("PATCH", `/api/admin/orders/1/fulfillment`, { status: "teleported" })).data?.error === "invalid_status");
  check("an order that does not exist → 404", (await api("PATCH", "/api/admin/orders/99999999/fulfillment", { status: "delivering" })).status === 404);

  // ---- 3. mark-paid
  {
    const cod = await order({ method: "cod", payment: "pending", type: "delivery", wardId: ward });
    const r = await api("PATCH", `/api/admin/orders/${cod}/mark-paid`);
    check("mark-paid on a COD order that is pending → 200 paid", r.status === 200 && r.data?.payment_status === "paid", JSON.stringify(r.data));
    check("…a second time → 409 not_eligible_for_mark_paid", (await api("PATCH", `/api/admin/orders/${cod}/mark-paid`)).status === 409);
    const zp = await order({ payment: "pending" });
    const z = await api("PATCH", `/api/admin/orders/${zp}/mark-paid`);
    check("mark-paid on a ZaloPay order → 400 not_paid_in_person (ZaloPay must confirm it)", z.status === 400 && z.data?.error === "not_paid_in_person" && (await state(zp)).payment_status === "pending");
    const refunded = await order({ method: "cod", payment: "refunded", type: "delivery", wardId: ward });
    check("mark-paid on a refunded order → 409 (never flipped back to paid)", (await api("PATCH", `/api/admin/orders/${refunded}/mark-paid`)).status === 409 && (await state(refunded)).payment_status === "refunded");
  }

  // ---- 4. the delivery sheet
  {
    const listed = await order({ payment: "paid" });
    const unpaid = await order({ payment: "pending" });
    const refunded = await order({ payment: "paid" });
    await api("PATCH", `/api/admin/orders/${refunded}/refund`);
    const cancelled = await order({ payment: "paid" });
    await api("PATCH", `/api/admin/orders/${cancelled}/fulfillment`, { status: "cancelled" });
    const cod = await order({ method: "cod", payment: "pending", type: "delivery", wardId: ward });
    const sheet = (await api("GET", `/api/admin/orders/delivery-sheet?date=${date}`)).data;
    const ids = Object.values(sheet.windows).flat().map((o) => o.id);
    check("the sheet lists a paid ZaloPay order and a COD order", ids.includes(listed) && ids.includes(cod));
    check("…and leaves out an unpaid ZaloPay order, a cancelled one and a refunded one", !ids.includes(unpaid) && !ids.includes(cancelled) && !ids.includes(refunded), JSON.stringify(ids));
    const before = sheet.pending_zalopay_count;
    check("pending_zalopay_count counts the unpaid ZaloPay order and not the refunded or cancelled ones", before >= 1 && before === Number((await pool.query("SELECT COUNT(*) FROM orders WHERE delivery_date=$1 AND channel='web' AND payment_method='zalopay' AND payment_status IN ('pending','failed') AND fulfillment_status<>'cancelled'", [date])).rows[0].count), String(before));
  }

  // ---- 5. the CSV export: a cell that a spreadsheet would read as a formula is made text
  {
    const names = ['=HYPERLINK("http://x.example")', "\t=1+1", "\r@SUM(A1)", "-2+3", "+1", "Bình thường"];
    for (const sender of names) await order({ payment: "pending", sender });
    const csv = await api("GET", "/api/admin/orders/orders.csv");
    const text = csv.text;
    const raw = new Uint8Array(await (await fetch(`${BASE}/api/admin/orders/orders.csv`, { headers: { cookie: manager.cookie } })).arrayBuffer());
    check("the export is a CSV download that starts with a byte-order mark (Excel then reads the Vietnamese as UTF-8)", csv.status === 200 && /text\/csv/.test(csv.res.headers.get("content-type") ?? "") && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf);
    check("a name that starts with = + - @ is written as text (a leading quote)", text.includes('"\'=HYPERLINK(""http://x.example"")"') && text.includes('"\'-2+3"') && text.includes('"\'+1"') && !text.includes(',"=HYPERLINK'));
    check("…also one that starts with a tab or a carriage return", text.includes('"\'\t=1+1"') && text.includes('"\'\r@SUM(A1)"'));
    check("…and an ordinary name is left alone", text.includes('"Bình thường"') && !text.includes("'Bình thường"));
  }

  // ---- 6. the order list is capped at the newest 1000
  {
    await pool.query(
      `INSERT INTO orders (token, channel, fulfillment_type, sender_name, sender_phone, recipient_name, recipient_phone, delivery_date, delivery_window,
                           subtotal, discount, shipping_fee, total_amount, vat_rate, payment_method, payment_status, fulfillment_status, created_at)
       SELECT 'zz-limit-' || g, 'web', 'pickup', 'Giới hạn', '0912345678', 'Giới hạn', '0987654321', $1, 'morning', 1000, 0, 0, 1000, 10, 'cash', 'pending', 'new', now() + g * interval '1 second'
       FROM generate_series(1, 1001) g`, [date]);
    const list = await api("GET", "/api/admin/orders");
    check("with more than 1000 orders the list holds 1000, the newest first (the 1001st-newest is left out)", list.status === 200 && list.data.length === 1000 && list.data[0].token === "zz-limit-1001" && !list.data.some((o) => o.token === "zz-limit-1"), `${list.data?.length}`);
    check("…and the CSV export still has every order", (await api("GET", "/api/admin/orders/orders.csv")).text.split("\r\n").length > 1001);
  }
} finally {
  await pool.query("DELETE FROM orders WHERE token LIKE 'zz-limit-%'");
  if (tokens.length) await pool.query("DELETE FROM orders WHERE token = ANY($1)", [tokens]);
  await pool.query("UPDATE flowers SET stock = $2 WHERE id = $1", [flower.id, flowerStockBefore]);
  await manager.cleanup();
}
check("cleanup: no test orders left, the flower's stock is as it was", Number((await pool.query("SELECT COUNT(*) FROM orders WHERE token = ANY($1)", [tokens])).rows[0].count) === 0 && (await stock()) === flowerStockBefore);

await pool.end();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
