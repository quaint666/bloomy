// The ZaloPay payment callback, POST /api/orders/ipn: what ZaloPay sends when a payment is made, and what is done with
// anything else that reaches the address (it is public, and only the signature protects it).
//
// Run from the repo root with the server running on the same database and the same ZALOPAY_KEY2:
//   BASE=http://localhost:3000 ZALOPAY_KEY2=<the server's> node tests/ipn_test.mjs     (npm test sets both)
//
// IT CREATES ORDER ROWS (straight into the table: no stock is taken and no limiter is used) and removes them in a finally
// block. Local database only; EMAIL_MODE=log, so the "paid" email goes to the server log.
//
// Proves: a correctly signed, correctly priced callback marks the order paid (once; a repeat changes nothing); a wrong
// signature, a wrong amount, a made-up order or a payment after a cancellation is handled as the code says; a body that is
// not what ZaloPay sends is refused with -1 ("do not retry"), never 0 ("temporary error, try again"), which would invite
// ZaloPay to repeat it. Does NOT prove: ZaloPay itself (unreachable here), or the email that follows a payment.

import { createRequire } from "node:module";
import path from "node:path";
import crypto from "node:crypto";

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const KEY2 = process.env.ZALOPAY_KEY2;
if (!KEY2) { console.log("FAIL set ZALOPAY_KEY2 to the value the server was started with"); process.exit(2); }
const require = createRequire(path.join(process.cwd(), "package.json"));
const { Pool } = require("pg");
const pool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1", port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || "quaint", database: process.env.DB_NAME || "bloomy", password: process.env.DB_PASSWORD || "dev",
});

let passed = 0, failed = 0;
function check(name, cond, extra = "") { if (cond) passed++; else { failed++; console.log(`FAIL ${name}${extra ? " :: " + extra : ""}`); } }
const sign = (data) => crypto.createHmac("sha256", KEY2).update(data).digest("hex");
const ipn = async (body, contentType = "application/json") => {
  const res = await fetch(`${BASE}/api/orders/ipn`, { method: "POST", headers: { "Content-Type": contentType }, body: typeof body === "string" ? body : JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, data };
};
const signed = (payload) => { const data = JSON.stringify(payload); return { data, mac: sign(data) }; };
const state = async (id) => (await pool.query("SELECT payment_status, zp_trans_id, fulfillment_status FROM orders WHERE id=$1", [id])).rows[0];

// Stop early if this script's database is not the server's database.
{
  const row = (await pool.query("SELECT shop_address, contact_phone FROM settings")).rows[0];
  const api = await (await fetch(BASE + "/api/settings")).json();
  if (!row || row.shop_address !== api.shop_address || row.contact_phone !== api.contact_phone) {
    console.log("FAIL this script is connected to a different database than the server at " + BASE);
    process.exit(2);
  }
}

const deliveryDate = new Date(Date.now() + 7 * 3600e3 + 3 * 86400e3).toISOString().slice(0, 10);
const tokens = [];

// A ZaloPay order waiting for payment (a pickup order, so it needs no ward or address), written straight into the table:
// going through POST /api/orders would spend the order limiter, which every suite of a CI run shares (20 per 15 minutes).
async function waitingOrder() {
  const token = crypto.randomBytes(24).toString("hex");
  tokens.push(token);
  const appTransId = `${new Date().toISOString().slice(2, 10).replaceAll("-", "")}_t${crypto.randomBytes(5).toString("hex")}`;
  const { rows } = await pool.query(
    `INSERT INTO orders (token, channel, fulfillment_type, sender_name, sender_phone, recipient_name, recipient_phone, delivery_date, delivery_window,
                         subtotal, discount, shipping_fee, total_amount, vat_rate, payment_method, app_trans_id)
     VALUES ($1, 'web', 'pickup', 'Kiểm thử gửi', '0912345678', 'Kiểm thử nhận', '0987654321', $2, 'morning', 450000, 0, 0, 450000, 10, 'zalopay', $3)
     RETURNING id, total_amount`,
    [token, deliveryDate, appTransId]);
  return { id: rows[0].id, total: rows[0].total_amount, appTransId };
}

try {
  // ---- 1. a good callback
  const a = await waitingOrder();
  check("the new order waits for payment", (await state(a.id)).payment_status === "pending");
  const ok = await ipn(signed({ app_trans_id: a.appTransId, amount: a.total, zp_trans_id: "111" }));
  check("a signed callback with the right amount is acknowledged (return_code 1)", ok.status === 200 && ok.data?.return_code === 1, JSON.stringify(ok));
  const paid = await state(a.id);
  check("…and the order is paid, with ZaloPay's number", paid.payment_status === "paid" && paid.zp_trans_id === "111", JSON.stringify(paid));
  const again = await ipn(signed({ app_trans_id: a.appTransId, amount: a.total, zp_trans_id: "222" }));
  check("the same callback again is acknowledged and changes nothing (ZaloPay retries)", again.data?.return_code === 1 && (await state(a.id)).zp_trans_id === "111", JSON.stringify(again));

  // ---- 2. callbacks that must not pay an order
  const b = await waitingOrder();
  const bad = await ipn({ data: JSON.stringify({ app_trans_id: b.appTransId, amount: b.total, zp_trans_id: "333" }), mac: "0".repeat(64) });
  check("a wrong signature is refused (-1) and pays nothing", bad.data?.return_code === -1 && (await state(b.id)).payment_status === "pending", JSON.stringify(bad));
  const short = await ipn({ data: JSON.stringify({ app_trans_id: b.appTransId, amount: b.total, zp_trans_id: "333" }), mac: "abcd" });
  check("a signature of the wrong length is refused (-1)", short.data?.return_code === -1 && (await state(b.id)).payment_status === "pending", JSON.stringify(short));
  const wrongAmount = await ipn(signed({ app_trans_id: b.appTransId, amount: b.total - 1, zp_trans_id: "333" }));
  check("a signed callback for the wrong amount is refused (-1) and pays nothing", wrongAmount.data?.return_code === -1 && (await state(b.id)).payment_status === "pending", JSON.stringify(wrongAmount));
  const ghost = await ipn(signed({ app_trans_id: "000000_nosuchorder", amount: 1, zp_trans_id: "1" }));
  check("a signed callback for an order we do not have is acknowledged (1): retrying cannot help", ghost.data?.return_code === 1, JSON.stringify(ghost));

  // ---- 3. bodies that are not what ZaloPay sends: refused with -1, never 0 (0 means "try again")
  const refused = (name, res) => check(`${name} → -1, not 0`, res.status === 200 && res.data?.return_code === -1, JSON.stringify(res));
  refused("an empty JSON body", await ipn({}));
  refused("no body at all", await ipn("", "application/json"));
  refused("a plain-text body", await ipn("hello", "text/plain"));
  refused("no data", await ipn({ mac: "ab" }));
  refused("no mac", await ipn({ data: "{}" }));
  refused("data that is not text", await ipn({ data: { app_trans_id: "x" }, mac: "ab" }));
  refused("mac that is not text", await ipn({ data: "{}", mac: 12 }));
  refused("signed data that is not JSON", await ipn({ data: "not json", mac: sign("not json") }));
  refused("signed JSON that is not an object", await ipn(signed("just a string")));
  refused("signed JSON null", await ipn({ data: "null", mac: sign("null") }));
  refused("signed JSON without an order number", await ipn(signed({ amount: 1 })));
  refused("signed JSON whose order number is not text", await ipn(signed({ app_trans_id: 123, amount: 1 })));
  check("…and none of those paid or changed anything (the second order is still waiting)", (await state(b.id)).payment_status === "pending");

  // ---- 4. money that arrives after the order was cancelled
  const c = await waitingOrder();
  await pool.query("UPDATE orders SET fulfillment_status='cancelled' WHERE id=$1", [c.id]);
  const late = await ipn(signed({ app_trans_id: c.appTransId, amount: c.total, zp_trans_id: "444" }));
  const lateState = await state(c.id);
  check("a payment that arrives after a cancellation is recorded as paid and the order stays cancelled (the admin sees a refund is owed)", late.data?.return_code === 1 && lateState.payment_status === "paid" && lateState.fulfillment_status === "cancelled", JSON.stringify(lateState));
} finally {
  if (tokens.length) await pool.query("DELETE FROM orders WHERE token = ANY($1)", [tokens]);
}
const left = Number((await pool.query("SELECT COUNT(*) FROM orders WHERE token = ANY($1)", [tokens])).rows[0].count);
check("cleanup: no test orders left", left === 0, String(left));

await pool.end();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
