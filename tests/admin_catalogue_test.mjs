// The staff screens that manage what the shop sells and when: coupons, order cut-off overrides, flower stock, product status and
// the "featured" tick, and review moderation. Run from the repo root with the server running on the same database:
//   node tests/admin_catalogue_test.mjs        (npm test sets it up)
// IT WRITES coupons (ZZTEST*), cut-off overrides, stock and product flags, reviews, and puts everything back in a finally block.
//
// Proves: a coupon's code, type, value, minimum and dates are validated, a code cannot repeat (also in another case), and only
// active and the dates can change afterwards; a cut-off may only close a date EARLIER than the default 14:00, and the same date
// replaces the earlier override; flower stock changes by a relative amount, never below zero, and two changes at once both count;
// a product's status must be a real one; no more than 4 products can be featured, also when two ticks arrive at the same moment;
// a review is approved, un-approved or deleted, listed by status. Does NOT prove: the screens (jsdom suites and the browser pass).

import { createRequire } from "node:module";
import path from "node:path";
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

const manager = await makeAdmin(pool, BASE, "catalogue", "manager");
const employee = await makeAdmin(pool, BASE, "catalogue", "employee");
const { api } = manager;
const flowerBefore = (await pool.query("SELECT id, stock FROM flowers ORDER BY id LIMIT 1")).rows[0];
const featuredBefore = (await pool.query("SELECT id FROM products WHERE featured")).rows.map((r) => r.id);
const statusBefore = (await pool.query("SELECT id, status FROM products ORDER BY id LIMIT 3")).rows;
const reviewMax = Number((await pool.query("SELECT COALESCE(MAX(id),0) AS m FROM reviews")).rows[0].m);
const cutoffDates = ["2031-03-03", "2031-03-04"];
try {
  // ---- coupons
  const coupon = (b) => api("POST", "/api/admin/coupons", b);
  const good = { code: "ZZTEST10", type: "percent", value: 10, min_subtotal: 100000 };
  check("an employee cannot create a coupon (403)", (await employee.api("POST", "/api/admin/coupons", good)).status === 403);
  for (const [name, body, error] of [
    ["a code with a space", { ...good, code: "ZZ TEST" }, "invalid_code"], ["a code that is too short", { ...good, code: "ZZ" }, "invalid_code"], ["a code that is too long", { ...good, code: "Z".repeat(21) }, "invalid_code"],
    ["an unknown type", { ...good, type: "free" }, "invalid_type"], ["a percent of 0", { ...good, value: 0 }, "invalid_value"], ["a percent over 100", { ...good, value: 101 }, "invalid_value"],
    ["a fixed value that is not a whole number", { ...good, type: "fixed", value: 10.5 }, "invalid_value"], ["a fixed value over the limit", { ...good, type: "fixed", value: 100000001 }, "invalid_value"],
    ["a negative minimum", { ...good, min_subtotal: -1 }, "invalid_min_subtotal"], ["an impossible date", { ...good, starts_on: "2031-02-30" }, "invalid_date"], ["a start after the end", { ...good, starts_on: "2031-05-02", ends_on: "2031-05-01" }, "invalid_dates"],
  ]) {
    const r = await coupon(body);
    check(`coupon: ${name} → 400 ${error}`, r.status === 400 && r.data?.error === error, JSON.stringify(r.data));
  }
  const made = await coupon({ ...good, code: " zztest10 " });
  check("a good coupon → 201, the code trimmed and upper-cased, no dates, active", made.status === 201 && made.data?.code === "ZZTEST10" && made.data?.active === true && made.data?.starts_on === null, JSON.stringify(made.data));
  check("the same code again (also lower-case) → 409 code_taken", (await coupon({ ...good, code: "zztest10" })).status === 409);
  const id = made.data?.id;
  const patched = await api("PATCH", `/api/admin/coupons/${id}`, { active: false, starts_on: "2031-01-01", ends_on: "2031-12-31", code: "HACKED", value: 99, type: "fixed" });
  const stored = (await pool.query("SELECT code, type, value, active, starts_on::text AS s, ends_on::text AS e FROM coupons WHERE id=$1", [id])).rows[0];
  check("a patch changes active and the dates only; the code, type and value stay (they are locked after creation)", patched.status === 200 && stored.active === false && stored.s === "2031-01-01" && stored.e === "2031-12-31" && stored.code === "ZZTEST10" && stored.type === "percent" && stored.value === 10, JSON.stringify(stored));
  check("a patch that clears a date (null) clears it", (await api("PATCH", `/api/admin/coupons/${id}`, { ends_on: null })).data?.ends_on === null);
  check("a patch that would end before it starts → 400 invalid_dates", (await api("PATCH", `/api/admin/coupons/${id}`, { ends_on: "2030-01-01" })).data?.error === "invalid_dates");
  check("a patch with nothing to change → 400", (await api("PATCH", `/api/admin/coupons/${id}`, {})).data?.error === "nothing_to_update");
  check("active that is not a boolean → 400", (await api("PATCH", `/api/admin/coupons/${id}`, { active: "yes" })).data?.error === "invalid_active");
  check("a coupon that does not exist → 404", (await api("PATCH", "/api/admin/coupons/99999999", { active: true })).status === 404);
  check("the list has it, switched-off ones after active ones", (await api("GET", "/api/admin/coupons")).data?.some((c) => c.code === "ZZTEST10"));

  // ---- cut-off overrides
  const cut = (b) => api("POST", "/api/admin/cutoffs", b);
  const early = { override_date: cutoffDates[0], deadline_local: `${cutoffDates[0]}T09:30`, note: "  Tết  " };
  const c1 = await cut(early);
  check("an override earlier than the default 14:00 → 201, the note trimmed, stored as 09:30 Vietnam time", c1.status === 201 && c1.data?.note === "Tết" && new Date(c1.data.deadline).toISOString() === `${cutoffDates[0]}T02:30:00.000Z`, JSON.stringify(c1.data));
  check("one at 14:00 or later is refused (400 deadline_not_earlier_than_default): it may only close a date earlier", (await cut({ ...early, deadline_local: `${cutoffDates[0]}T14:00` })).data?.error === "deadline_not_earlier_than_default" && (await cut({ ...early, deadline_local: `${cutoffDates[0]}T20:00` })).status === 400);
  check("a date that does not exist → 400", (await cut({ ...early, override_date: "2031-02-30" })).status === 400);
  check("a time in the wrong format → 400", (await cut({ ...early, deadline_local: "9:30" })).status === 400);
  const c2 = await cut({ ...early, deadline_local: `${cutoffDates[0]}T08:00`, note: "đổi" });
  check("the same date again replaces the override (one row, the new time and note)", c2.status === 201 && Number((await pool.query("SELECT COUNT(*) FROM cutoff_overrides WHERE override_date=$1", [cutoffDates[0]])).rows[0].count) === 1 && c2.data?.note === "đổi", JSON.stringify(c2.data));
  check("a delete → 200, again → 404, a bad id → 400", (await api("DELETE", `/api/admin/cutoffs/${c2.data.id}`)).data?.deleted === true && (await api("DELETE", `/api/admin/cutoffs/${c2.data.id}`)).status === 404 && (await api("DELETE", "/api/admin/cutoffs/abc")).status === 400);
  const c3 = await cut({ override_date: cutoffDates[1], deadline_local: `${cutoffDates[1]}T10:00` });
  const dl = await (await fetch(`${BASE}/api/orders/deadline?date=${cutoffDates[1]}`)).json();
  check("the public deadline for that date shows the override", c3.status === 201 && dl.is_override === true, JSON.stringify(dl));

  // ---- flower stock
  const f = flowerBefore.id;
  await pool.query("UPDATE flowers SET stock = 100 WHERE id = $1", [f]);
  const stock = async () => (await pool.query("SELECT stock FROM flowers WHERE id=$1", [f])).rows[0].stock;
  check("stock +25 → 125", (await api("PATCH", `/api/admin/flowers/${f}/stock`, { delta: 25 })).data?.stock === 125);
  check("stock −20 → 105", (await api("PATCH", `/api/admin/flowers/${f}/stock`, { delta: -20 })).data?.stock === 105);
  const below = await api("PATCH", `/api/admin/flowers/${f}/stock`, { delta: -106 });
  check("below zero → 409 below_zero and nothing changes", below.status === 409 && below.data?.error === "below_zero" && (await stock()) === 105);
  for (const bad of [0, 1.5, "5", null, 10001, -10001]) check(`a delta of ${JSON.stringify(bad)} → 400 invalid_delta`, (await api("PATCH", `/api/admin/flowers/${f}/stock`, { delta: bad })).data?.error === "invalid_delta");
  check("a flower that does not exist → 404", (await api("PATCH", "/api/admin/flowers/99999999/stock", { delta: 1 })).status === 404);
  const par = await Promise.all(Array.from({ length: 10 }, () => api("PATCH", `/api/admin/flowers/${f}/stock`, { delta: 3 })));
  check("ten changes at the same moment all count (relative, not 'set to')", par.every((r) => r.status === 200) && (await stock()) === 135, String(await stock()));

  // ---- product status and featured
  const [p1, p2, p3] = statusBefore.map((p) => p.id);
  check("a product status that does not exist → 400", (await api("PATCH", `/api/admin/products/${p1}/status`, { status: "gone" })).status === 400);
  check("a product that does not exist → 404", (await api("PATCH", "/api/admin/products/99999999/status", { status: "available" })).status === 404);
  const so = await api("PATCH", `/api/admin/products/${p1}/status`, { status: "sold_out_today" });
  check("sold_out_today is accepted and shows on the public product", so.status === 200 && (await (await fetch(`${BASE}/api/products/${p1}`)).json()).status === "sold_out_today");
  await pool.query("UPDATE products SET featured = false");
  const ids = (await pool.query("SELECT id FROM products WHERE status <> 'discontinued' ORDER BY id LIMIT 8")).rows.map((r) => r.id);
  for (const pid of ids.slice(0, 4)) await api("PATCH", `/api/admin/products/${pid}/featured`, { featured: true });
  check("four products can be featured", Number((await pool.query("SELECT COUNT(*) FROM products WHERE featured")).rows[0].count) === 4);
  const fifth = await api("PATCH", `/api/admin/products/${ids[4]}/featured`, { featured: true });
  check("a fifth → 409 featured_limit", fifth.status === 409 && fifth.data?.error === "featured_limit");
  check("one already featured can be ticked again, and un-ticked", (await api("PATCH", `/api/admin/products/${ids[0]}/featured`, { featured: true })).status === 200 && (await api("PATCH", `/api/admin/products/${ids[0]}/featured`, { featured: false })).status === 200);
  // three featured now; two ticks at once for two others: the limit is 4, so at most one may win
  const race = await Promise.all([api("PATCH", `/api/admin/products/${ids[5]}/featured`, { featured: true }), api("PATCH", `/api/admin/products/${ids[6]}/featured`, { featured: true }), api("PATCH", `/api/admin/products/${ids[7]}/featured`, { featured: true })]);
  const nFeatured = Number((await pool.query("SELECT COUNT(*) FROM products WHERE featured")).rows[0].count);
  check("three ticks at the same moment with one place left: never more than 4 featured", nFeatured <= 4, `${nFeatured} featured; answers ${race.map((r) => r.status).join()}`);
  check("featured that is not a boolean → 400", (await api("PATCH", `/api/admin/products/${p2}/featured`, { featured: "yes" })).status === 400);

  // ---- reviews
  const rv = [];
  for (const [approved, name] of [[false, "Chờ duyệt"], [true, "Đã duyệt"]]) rv.push((await pool.query("INSERT INTO reviews (product_id, name, stars, comment, approved) VALUES ($1, $2, 4, 'Bình luận để kiểm thử.', $3) RETURNING id", [p3, name, approved])).rows[0].id);
  const pending = await api("GET", "/api/admin/reviews?status=pending");
  const approvedList = await api("GET", "/api/admin/reviews?status=approved");
  check("the list by status: pending has the unapproved one and not the approved one, and the counts add up", pending.data?.reviews.some((r) => r.id === rv[0]) && !pending.data.reviews.some((r) => r.id === rv[1]) && approvedList.data?.reviews.some((r) => r.id === rv[1]) && !approvedList.data.reviews.some((r) => r.id === rv[0]) && pending.data.counts.pending >= 1 && pending.data.counts.approved >= 1);
  check("approving it → 200 and it is on the public product", (await api("PATCH", `/api/admin/reviews/${rv[0]}`, { approved: true })).data?.approved === true && (await (await fetch(`${BASE}/api/products/${p3}/reviews`)).json()).reviews.some((r) => r.id === rv[0]));
  check("un-approving it takes it off the public product again", (await api("PATCH", `/api/admin/reviews/${rv[0]}`, { approved: false })).status === 200 && !(await (await fetch(`${BASE}/api/products/${p3}/reviews`)).json()).reviews.some((r) => r.id === rv[0]));
  check("approved that is not a boolean → 400", (await api("PATCH", `/api/admin/reviews/${rv[0]}`, { approved: 1 })).data?.error === "invalid_approved");
  check("a review that does not exist → 404 (patch and delete)", (await api("PATCH", "/api/admin/reviews/99999999", { approved: true })).status === 404 && (await api("DELETE", "/api/admin/reviews/99999999")).status === 404);
  check("a delete → 200 and it is gone", (await api("DELETE", `/api/admin/reviews/${rv[0]}`)).data?.deleted === true && Number((await pool.query("SELECT COUNT(*) FROM reviews WHERE id=$1", [rv[0]])).rows[0].count) === 0);
} finally {
  await pool.query("DELETE FROM coupons WHERE code LIKE 'ZZTEST%'");
  await pool.query("DELETE FROM cutoff_overrides WHERE override_date = ANY($1::date[])", [cutoffDates]);
  await pool.query("UPDATE flowers SET stock = $2 WHERE id = $1", [flowerBefore.id, flowerBefore.stock]);
  await pool.query("UPDATE products SET featured = (id = ANY($1))", [featuredBefore]);
  for (const p of statusBefore) await pool.query("UPDATE products SET status = $2 WHERE id = $1", [p.id, p.status]);
  await pool.query("DELETE FROM reviews WHERE id > $1", [reviewMax]);
  await manager.cleanup(); await employee.cleanup();
}
const left = (await pool.query("SELECT (SELECT COUNT(*) FROM coupons WHERE code LIKE 'ZZTEST%') AS c, (SELECT COUNT(*) FROM cutoff_overrides WHERE override_date = ANY($1::date[])) AS o, (SELECT COUNT(*) FROM reviews WHERE id > $2) AS r", [cutoffDates, reviewMax])).rows[0];
check("cleanup: no test coupons, overrides or reviews left", Number(left.c) + Number(left.o) + Number(left.r) === 0, JSON.stringify(left));
await pool.end();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
