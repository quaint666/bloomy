// Product reviews, the one place visitors type text that other visitors then read:
//   GET  /api/products/:id/reviews    GET /api/reviews/latest    POST /api/products/:id/reviews
//
// Run from the repo root with the server running on the same database:
//   BASE=http://localhost:3000 node tests/reviews_test.mjs        (npm test starts a fresh server and sets both)
//
// IT WRITES review rows and removes them in a finally block (local database only). The review limiters live in the
// server's memory and last an hour (10 posts per address, 2 accepted per product), and this suite uses the whole
// of them: run it on a fresh server (npm test does), not twice against the same one.
//
// Proves: a new review is stored unapproved and is not shown anywhere until a manager approves it; the length and star rules
// refuse bad input (and a refusal stores nothing and does not use up the visitor's two reviews for that product); the
// hidden "website" field makes a bot's post look like a success and stores nothing; an unknown product is a 404; the
// limits (2 accepted per product, 10 posts in all) answer 429; approved text comes back as text, summary and all.
// Does NOT prove: the page (a form in jsdom is in other suites) or the admin screen that approves reviews.

import { createRequire } from "node:module";
import path from "node:path";

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const require = createRequire(path.join(process.cwd(), "package.json"));
const { Pool } = require("pg");
const pool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1", port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || "quaint", database: process.env.DB_NAME || "bloomy", password: process.env.DB_PASSWORD || "dev",
});

let passed = 0, failed = 0;
function check(name, cond, extra = "") { if (cond) passed++; else { failed++; console.log(`FAIL ${name}${extra ? " :: " + extra : ""}`); } }
const get = async (p) => { const r = await fetch(BASE + p); let data = null; try { data = await r.json(); } catch { /* not JSON */ } return { status: r.status, data }; };
const post = async (id, body) => {
  const r = await fetch(`${BASE}/api/products/${id}/reviews`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, data };
};

// Stop early if this script's database is not the server's database.
{
  const row = (await pool.query("SELECT shop_address, contact_phone FROM settings")).rows[0];
  const api = (await get("/api/settings")).data;
  if (!row || row.shop_address !== api.shop_address || row.contact_phone !== api.contact_phone) {
    console.log("FAIL this script is connected to a different database than the server at " + BASE);
    process.exit(2);
  }
}

const [P1, P2, P3, P4] = (await pool.query("SELECT id FROM products WHERE status <> 'discontinued' ORDER BY id LIMIT 4")).rows.map((r) => r.id);
const before = Number((await pool.query("SELECT COALESCE(MAX(id),0) AS m FROM reviews")).rows[0].m);
const good = { name: "  Kiểm Thử  ", stars: 5, comment: "  Hoa tươi, giao đúng giờ, gói rất đẹp.  " };
const countFor = async (id) => Number((await pool.query("SELECT COUNT(*) FROM reviews WHERE product_id=$1 AND id > $2", [id, before])).rows[0].count);

try {
  // ---- 1. what the form is told, and what is shown before anything is posted
  const start = await get(`/api/products/${P1}/reviews`);
  check("the list answers with its summary, reviews and the limits the form must follow", start.status === 200 && Array.isArray(start.data?.reviews) && start.data?.summary && start.data?.limits?.name_max === 60 && start.data?.limits?.comment_min === 10 && start.data?.limits?.comment_max === 500, JSON.stringify(start.data?.limits));
  const startCount = start.data.summary.count;

  // ---- 2. refusals: a 400, nothing stored, and none of them uses up the two reviews allowed for this product
  const refusals = [
    ["an empty name", { ...good, name: "   " }],
    ["no stars (0)", { ...good, stars: 0 }],
    ["six stars", { ...good, stars: 6 }],
    ["a comment shorter than the minimum", { ...good, comment: "ngắn" }],
    ["a comment longer than the maximum", { ...good, comment: "x".repeat(501) }],
  ];
  for (const [name, body] of refusals) {
    const r = await post(P1, body);
    check(`${name} → 400 with the limits`, r.status === 400 && r.data?.error === "invalid_payload" && r.data?.limits?.comment_max === 500, JSON.stringify(r));
  }
  check("…and none of them stored a row", (await countFor(P1)) === 0);

  // ---- 3. an unknown product
  const ghost = await post(99999999, good);
  check("a product that does not exist → 404", ghost.status === 404, JSON.stringify(ghost));

  // ---- 4. the hidden field: a bot sees a success, nothing is stored
  const bot = await post(P1, { ...good, website: "http://spam.example" });
  check("a post with the hidden website field filled answers 201 like a real one", bot.status === 201 && bot.data?.ok === true, JSON.stringify(bot));
  check("…and stores nothing", (await countFor(P1)) === 0);

  // ---- 5. a real review: stored, trimmed, not approved, not shown
  const real = await post(P1, good);
  check("a good review → 201", real.status === 201 && real.data?.ok === true, JSON.stringify(real));
  const row = (await pool.query("SELECT name, stars, comment, approved FROM reviews WHERE product_id=$1 AND id > $2", [P1, before])).rows[0];
  check("…stored trimmed, with its stars, and NOT approved", row && row.name === "Kiểm Thử" && row.stars === 5 && row.comment === "Hoa tươi, giao đúng giờ, gói rất đẹp." && row.approved === false, JSON.stringify(row));
  const hidden = await get(`/api/products/${P1}/reviews`);
  check("…not in the product's list, and the count did not change", hidden.data.reviews.every((x) => x.comment !== good.comment.trim()) && hidden.data.summary.count === startCount);
  const latest = await get("/api/reviews/latest?limit=12");
  check("…not on the home page's latest reviews either", latest.status === 200 && latest.data.every((x) => x.comment !== good.comment.trim()));

  // ---- 6. the limits
  const third = await post(P1, good);
  check("a third review for the same product within the hour → 429 (2 allowed: the bot's counted as one, the real one as the other)", third.status === 429, JSON.stringify(third));
  check("…and stored nothing more (only the real one is there)", (await countFor(P1)) === 1);
  const other = await post(P2, good);
  check("another product is not held back by it", other.status === 201, JSON.stringify(other));
  const another = await post(P3, good);
  check("…nor a third product", another.status === 201, JSON.stringify(another));
  const over = await post(P4, good);
  check("the 11th post of the hour from one address → 429, whatever the product", over.status === 429, JSON.stringify(over));
  check("…and stored nothing", (await countFor(P4)) === 0);

  // ---- 7. once a manager approves it: shown, as text, with the summary
  await pool.query("UPDATE reviews SET approved = true WHERE product_id=$1 AND id > $2", [P1, before]);
  const shown = await get(`/api/products/${P1}/reviews`);
  const mine = shown.data.reviews.find((x) => x.comment === good.comment.trim());
  check("an approved review is listed with its name, stars and comment", !!mine && mine.name === "Kiểm Thử" && mine.stars === 5, JSON.stringify(shown.data.reviews.slice(0, 2)));
  check("…and the summary counts it", shown.data.summary.count === startCount + 1, JSON.stringify(shown.data.summary));
  const nowLatest = await get("/api/reviews/latest?limit=12");
  check("…and the latest reviews show it with its product", nowLatest.data.some((x) => x.comment === good.comment.trim() && x.product_id === P1 && typeof x.product_name === "string"));
  check("latest: a limit above the maximum is cut to 12, a nonsense one falls back to 3", (await get("/api/reviews/latest?limit=999")).data.length <= 12 && (await get("/api/reviews/latest?limit=abc")).data.length <= 3);
  check("a product id that is not a number → 404", (await get("/api/products/abc/reviews")).status === 404);
} finally {
  await pool.query("DELETE FROM reviews WHERE id > $1", [before]);
}
check("cleanup: no test reviews left", Number((await pool.query("SELECT COUNT(*) FROM reviews WHERE id > $1", [before])).rows[0].count) === 0);

await pool.end();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
