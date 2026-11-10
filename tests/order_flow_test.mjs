// Order flow through the API: price a cart, apply a coupon, place a pickup/cash order and a delivery/COD
// order, check what was stored and that the flower stock went down by the recipe — then undo all of it.
//
// Run from the repo root with the server running on the same database:
//   export DB_HOST=127.0.0.1 DB_PORT=5433 DB_PASSWORD=dev
//   BASE=http://localhost:3000 node tests/order_flow_test.mjs
//
// IT CREATES REAL ORDER ROWS (and takes flower stock) and removes them in a finally block. The server also
// "sends" the confirmation emails: with EMAIL_MODE=log (the default) they only go to the server log. NEVER run it
// against a server started with EMAIL_MODE=send, and never against production.
//
// Proves: the quote's arithmetic (subtotal, coupon rules, delivery fee by ward, total), that an order is stored with
// the same total the quote showed, that stock is taken by the recipe, that the funnel event is recorded, that the
// obvious bad requests are refused. Does NOT prove: the ZaloPay path (needs ZaloPay), or anything about the browser
// (see checkout_live_test.mjs for the page).

import { createRequire } from "node:module";
import path from "node:path";
import crypto from "node:crypto";

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const require = createRequire(path.join(process.cwd(), "package.json"));
const { Pool } = require("pg");
const pool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1", port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || "quaint", database: process.env.DB_NAME || "bloomy", password: process.env.DB_PASSWORD || "dev",
});

let passed = 0, failed = 0;
function check(name, cond, extra = "") { if (cond) passed++; else { failed++; console.log(`FAIL ${name}${extra ? " :: " + extra : ""}`); } }
const getJson = async (p) => (await fetch(BASE + p)).json();
const post = async (p, body) => {
  const res = await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stop early if this script's database is not the server's database.
{
  const row = (await pool.query("SELECT shop_address, contact_phone, contact_email, vat_rate FROM settings")).rows[0];
  const api = await getJson("/api/settings");
  if (!row || row.shop_address !== api.shop_address || row.contact_phone !== api.contact_phone || row.contact_email !== api.contact_email || row.vat_rate !== api.vat_rate) {
    console.log("FAIL this script is connected to a different database than the server at " + BASE + " (settings differ). Export the same DB_HOST / DB_PORT / DB_PASSWORD as the server and run again.");
    process.exit(2);
  }
}

// A delivery date comfortably after any same-day / next-day cutoff (Vietnam time, +3 days).
const deliveryDate = new Date(Date.now() + 7 * 3600e3 + 3 * 86400e3).toISOString().slice(0, 10);
const PRODUCT_ID = 9, SIZE = "m"; // "Bó Hồng Đỏ Classic" in the seed: three sizes, one flower in the recipe

const before = {
  orderMax: (await pool.query("SELECT COALESCE(MAX(id),0) AS m FROM orders")).rows[0].m,
  funnelMax: (await pool.query("SELECT COALESCE(MAX(id),0) AS m FROM funnel_events")).rows[0].m,
  availMax: (await pool.query("SELECT COALESCE(MAX(id),0) AS m FROM availability_checks")).rows[0].m,
};
const tokens = [];
let touchedFlowers = [];
const stockBefore = new Map();

try {
  const product = await getJson(`/api/products/${PRODUCT_ID}`);
  const size = product.sizes.find((s) => s.size === SIZE);
  check("seed product 9 has the size used here", !!size, JSON.stringify(product.sizes?.map((s) => s.size)));
  const settings = (await pool.query("SELECT ring1_fee, ring2_fee, ring3_fee FROM settings")).rows[0];
  const items = (q) => [{ productId: PRODUCT_ID, size: SIZE, quantity: q }];

  // ---- 1. quotes
  const q1 = (await post("/api/orders/quote", { items: items(1), fulfillment_type: "pickup", delivery_date: deliveryDate })).data;
  check("pickup quote: subtotal is the size price", q1.subtotal === size.price, `${q1.subtotal} vs ${size.price}`);
  check("pickup quote: no delivery fee, no coupon, total = subtotal", q1.shipping_fee === 0 && q1.coupon === null && q1.discount === 0 && q1.total === q1.subtotal);
  check("pickup quote: nothing short of stock", q1.short_flowers.length === 0 && q1.lines[0].problem === null);

  const coupon = (await pool.query("SELECT code, type, value, min_subtotal FROM coupons WHERE code='BLOOMY50'")).rows[0];
  check("seed coupon BLOOMY50 exists (fixed discount with a minimum)", coupon && coupon.type === "fixed" && coupon.min_subtotal > 0);
  const cBelow = (await post("/api/orders/quote", { items: items(1), coupon_code: "BLOOMY50", fulfillment_type: "pickup", delivery_date: deliveryDate })).data;
  check("coupon below the minimum is not applied", size.price < coupon.min_subtotal && cBelow.coupon.status === "below_minimum" && cBelow.discount === 0 && cBelow.total === cBelow.subtotal, JSON.stringify(cBelow.coupon));
  const qty = Math.ceil(coupon.min_subtotal / size.price);
  const cOk = (await post("/api/orders/quote", { items: items(qty), coupon_code: "BLOOMY50", fulfillment_type: "pickup", delivery_date: deliveryDate })).data;
  check("coupon at/above the minimum is applied", cOk.coupon.status === "applied" && cOk.discount === Number(coupon.value), JSON.stringify(cOk.coupon));
  check("…and the total is subtotal − discount", cOk.total === cOk.subtotal - cOk.discount, `${cOk.total} vs ${cOk.subtotal - cOk.discount}`);
  const cNone = (await post("/api/orders/quote", { items: items(1), coupon_code: "NOPE", fulfillment_type: "pickup" })).data;
  check("unknown coupon code → not_found, no discount", cNone.coupon.status === "not_found" && cNone.discount === 0);

  const ward = (await pool.query("SELECT id, ring FROM wards ORDER BY id LIMIT 1")).rows[0];
  const fee = settings[`ring${ward.ring}_fee`];
  const qDel = (await post("/api/orders/quote", { items: items(1), fulfillment_type: "delivery", ward_id: ward.id, delivery_date: deliveryDate })).data;
  check("delivery quote: fee follows the ward's ring", qDel.shipping_fee === fee, `${qDel.shipping_fee} vs ${fee}`);
  check("delivery quote: total = subtotal + fee", qDel.total === qDel.subtotal + fee);
  const qNoWard = (await post("/api/orders/quote", { items: items(1), fulfillment_type: "delivery", delivery_date: deliveryDate })).data;
  check("delivery without a ward: fee unknown (null), not 0", qNoWard.shipping_fee === null);

  // ---- 1b. a date that matches YYYY-MM-DD but is not a real day is refused with a 400, not a 500
  for (const bad of ["2026-02-30", "2026-13-01", "2027-02-29", "0000-01-01"]) {
    const dl = await fetch(`${BASE}/api/orders/deadline?date=${bad}`);
    check(`deadline for ${bad} → 400`, dl.status === 400, String(dl.status));
  }
  const leap = await fetch(`${BASE}/api/orders/deadline?date=2028-02-29`);
  check("deadline for the real day 2028-02-29 → 200", leap.status === 200, String(leap.status));
  check("quote with an impossible delivery_date → 400", (await post("/api/orders/quote", { items: items(1), fulfillment_type: "pickup", delivery_date: "2026-02-30" })).status === 400);
  const ordersBeforeBad = (await pool.query("SELECT COUNT(*)::int AS n FROM orders")).rows[0].n;
  const badOrder = await post("/api/orders", { sender_name: "Kiểm thử", sender_phone: "0912345678", recipient_name: "Kiểm thử", recipient_phone: "0987654321", items: items(1), fulfillment_type: "pickup", delivery_date: "2099-02-30", delivery_window: "morning", payment_method: "cash", consent: true });
  check("order with a future impossible delivery_date → 400", badOrder.status === 400, String(badOrder.status));
  check("... and no order row was written", (await pool.query("SELECT COUNT(*)::int AS n FROM orders")).rows[0].n === ordersBeforeBad);

  // ---- 2. stock before placing anything
  const recipe = size.flowers; // [{id, name, quantity}] for ONE bouquet of this size
  touchedFlowers = recipe.map((f) => f.id);
  for (const id of touchedFlowers) stockBefore.set(id, (await pool.query("SELECT stock FROM flowers WHERE id=$1", [id])).rows[0].stock);

  const person = { sender_name: "Kiểm thử Người gửi", sender_phone: "0912345678", recipient_name: "Kiểm thử Người nhận", recipient_phone: "0987654321" };
  const sessionId = `test-${crypto.randomUUID()}`;

  // ---- 3. place a pickup / cash order
  const pickup = await post("/api/orders", { ...person, items: items(1), fulfillment_type: "pickup", delivery_date: deliveryDate, delivery_window: "morning", payment_method: "cash", consent: true, session_id: sessionId });
  check("pickup/cash order accepted (201)", pickup.status === 201, JSON.stringify(pickup));
  if (pickup.data?.token) tokens.push(pickup.data.token);
  check("…token is 48 hex characters", /^[0-9a-f]{48}$/.test(pickup.data?.token || ""));
  check("…stored total equals the quote's total", pickup.data?.total_amount === q1.total, `${pickup.data?.total_amount} vs ${q1.total}`);
  const stored = pickup.data?.token ? await getJson(`/api/orders/${pickup.data.token}`) : {};
  check("…confirmation lookup shows pickup, cash, pending payment, new", stored.fulfillment_type === "pickup" && stored.payment_method === "cash" && stored.payment_status === "pending" && stored.fulfillment_status === "new");
  check("…and no delivery address or fee", stored.delivery_address === null && stored.shipping_fee === 0 && stored.ward_name === null);

  const afterOne = new Map();
  for (const id of touchedFlowers) afterOne.set(id, (await pool.query("SELECT stock FROM flowers WHERE id=$1", [id])).rows[0].stock);
  check("stock went down by exactly the recipe", recipe.every((f) => afterOne.get(f.id) === stockBefore.get(f.id) - f.quantity), JSON.stringify(recipe.map((f) => [f.id, stockBefore.get(f.id), afterOne.get(f.id), f.quantity])));
  let funnel = 0;
  for (let i = 0; i < 10 && !funnel; i++) { funnel = Number((await pool.query("SELECT COUNT(*) FROM funnel_events WHERE session_id=$1 AND event='order_placed'", [sessionId])).rows[0].count); if (!funnel) await sleep(150); }
  check("the order_placed funnel event was recorded", funnel === 1, String(funnel));

  // ---- 4. place a delivery / COD order
  const addr = "12 Đường Thử Nghiệm";
  const del = await post("/api/orders", { ...person, items: items(1), fulfillment_type: "delivery", ward_id: ward.id, delivery_address: addr, delivery_date: deliveryDate, delivery_window: "afternoon", payment_method: "cod", consent: true, notes: "Lời nhắn thử" });
  check("delivery/COD order accepted (201)", del.status === 201, JSON.stringify(del));
  if (del.data?.token) tokens.push(del.data.token);
  check("…total includes the delivery fee", del.data?.total_amount === qDel.total, `${del.data?.total_amount} vs ${qDel.total}`);
  const row = (await pool.query("SELECT shipping_fee, ward_id, delivery_address, notes, payment_method, subtotal, total_amount FROM orders WHERE token=$1", [del.data?.token])).rows[0] || {};
  check("…stored with the ward, address, note and fee", row.ward_id === ward.id && row.delivery_address === addr && row.notes === "Lời nhắn thử" && row.shipping_fee === fee && row.total_amount === row.subtotal + fee, JSON.stringify(row));

  // ---- 5. refusals
  const base = { ...person, items: items(1), fulfillment_type: "pickup", delivery_date: deliveryDate, delivery_window: "morning", payment_method: "cash", consent: true };
  const noConsent = await post("/api/orders", { ...base, consent: false });
  check("no consent → 400", noConsent.status === 400, String(noConsent.status));
  const pickupCod = await post("/api/orders", { ...base, payment_method: "cod" });
  check("pickup paid by COD → 400", pickupCod.status === 400, String(pickupCod.status));
  const noWard = await post("/api/orders", { ...base, fulfillment_type: "delivery", payment_method: "cod" });
  check("delivery without ward/address → 400", noWard.status === 400, String(noWard.status));
  const ghost = await post("/api/orders", { ...base, items: [{ productId: 999999, size: "m", quantity: 1 }] });
  check("unknown product → 400", ghost.status === 400 && ghost.data?.reason === "unknown_product", JSON.stringify(ghost));
  const tooMany = await post("/api/orders", { ...base, items: items(100) });
  check("quantity above the cap → 400", tooMany.status === 400, String(tooMany.status));
  const afterRefusals = (await pool.query("SELECT COUNT(*) FROM orders WHERE id > $1", [before.orderMax])).rows[0].count;
  check("refused requests stored nothing (only the 2 real orders exist)", Number(afterRefusals) === 2, String(afterRefusals));
} finally {
  // Undo everything this run created.
  if (tokens.length) await pool.query("DELETE FROM orders WHERE token = ANY($1)", [tokens]);
  for (const [id, stock] of stockBefore) await pool.query("UPDATE flowers SET stock=$1 WHERE id=$2", [stock, id]);
  await pool.query("DELETE FROM availability_checks WHERE id > $1", [before.availMax]);
  await pool.query("DELETE FROM funnel_events WHERE id > $1", [before.funnelMax]);
}
const left = Number((await pool.query("SELECT COUNT(*) FROM orders WHERE id > $1", [before.orderMax])).rows[0].count);
check("cleanup: no test orders left", left === 0, String(left));
let stockOk = true;
for (const [id, stock] of stockBefore) if ((await pool.query("SELECT stock FROM flowers WHERE id=$1", [id])).rows[0].stock !== stock) stockOk = false;
check("cleanup: flower stock restored", stockOk);

await pool.end();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
