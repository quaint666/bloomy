// The seeded catalogue: 100 or more products a customer can buy, the six occasions Peekbox links to, a picture and a
// recipe for every product, and the pages of the listing that follow from the count.
//
// Run from the repo root with the server running on the same database (a seeded one, e.g. the local setup in CLAUDE.md):
//   export DB_HOST=127.0.0.1 DB_PORT=5433 DB_PASSWORD=dev
//   BASE=http://localhost:3000 node tests/catalogue_test.mjs
//
// It only reads. Proves: the occasion tags have exactly the names and order Peekbox expects (they are the contract with
// the other shop: Peekbox's content/data/hampers.json), each has products, every product has sizes with a recipe, and its
// picture exists, is a WebP, and (for the second catalogue) is the same 560x700 as the first.
// Does NOT prove: that the pictures show what the name says (someone has to look), or that the prices are sensible.

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const ROOT = process.cwd();
const require = createRequire(path.join(ROOT, "package.json"));
const { Pool } = require("pg");
const { LISTING_PAGE_SIZE } = require(path.join(ROOT, "shared", "rules.js"));
const pool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1", port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || "quaint", database: process.env.DB_NAME || "bloomy", password: process.env.DB_PASSWORD || "dev",
});

let passed = 0, failed = 0;
function check(name, cond, extra = "") { if (cond) passed++; else { failed++; console.log(`FAIL ${name}${extra ? " :: " + extra : ""}`); } }
const j = async (p) => (await fetch(`${BASE}${p}`)).json();

// The names (and the calendar order) Peekbox uses for its six occasions. Change them there and here together.
const OCCASIONS = ["Tết", "Valentine", "8/3 và 20/10", "Trung thu", "20/11", "Giáng sinh"];
const MIN_LISTED = 100;
const SECOND_CATALOGUE_FROM = 52; // BLM-0052 and up (gen_products2.py)

{ // stop early if this script's database is not the server's
  const row = (await pool.query("SELECT shop_address FROM settings")).rows[0];
  const api = await j("/api/settings");
  if (!row || row.shop_address !== api.shop_address) { console.log("FAIL this script is connected to a different database than the server at " + BASE); process.exit(2); }
}

// ---- how many, and the pages that follow
const all = await j("/api/products");
check(`at least ${MIN_LISTED} products can be bought (listed)`, all.length >= MIN_LISTED, String(all.length));
const first = await j("/api/products?page=1");
check("the listing's pages add up: ceil(total / page size)", first.total === all.length && first.pages === Math.ceil(all.length / LISTING_PAGE_SIZE) && first.items.length === LISTING_PAGE_SIZE, JSON.stringify({ total: first.total, pages: first.pages, n: first.items.length }));

// ---- the occasions
const { groups } = await j("/api/tags");
const dip = groups.find((g) => g.kind === "occasion");
check("the 'Dịp' group has exactly Peekbox's six occasions, in calendar order", !!dip && JSON.stringify(dip.tags.map((t) => t.name)) === JSON.stringify(OCCASIONS), JSON.stringify(dip?.tags.map((t) => t.name)));
for (const t of dip?.tags ?? []) {
  const n = (await j(`/api/products?tag=${t.id}`)).length;
  check(`occasion "${t.name}" has at least 5 products to link to`, n >= 5, String(n));
}
check("the occasions are spread: no more than half of the shop sits under one", (await Promise.all((dip?.tags ?? []).map(async (t) => (await j(`/api/products?tag=${t.id}`)).length))).every((n) => n <= all.length / 2));

// ---- every product: sizes, recipes, picture
const products = (await pool.query("SELECT id, sku, name, image, product_type, status FROM products ORDER BY id")).rows;
const sizes = (await pool.query("SELECT product_id, size, price, id FROM product_sizes")).rows;
const recipeCount = new Map((await pool.query("SELECT size_id, count(*)::int AS n FROM recipes GROUP BY size_id")).rows.map((r) => [r.size_id, r.n]));
const standard = products.filter((p) => p.product_type === "standard");
check("setup: standard products exist", standard.length >= MIN_LISTED);

const noSize = standard.filter((p) => !sizes.some((s) => s.product_id === p.id));
check("every standard product has at least one size", noSize.length === 0, noSize.map((p) => p.sku).join(","));
const noRecipe = sizes.filter((s) => standard.some((p) => p.id === s.product_id) && !recipeCount.get(s.id));
check("every size of a standard product has a recipe (stems to deduct from stock)", noRecipe.length === 0, `${noRecipe.length} sizes`);
const order = { s: 0, m: 1, l: 2 };
const badOrder = standard.filter((p) => { const ps = sizes.filter((s) => s.product_id === p.id).sort((a, b) => order[a.size] - order[b.size]); return ps.some((s, i) => i > 0 && s.price <= ps[i - 1].price); });
check("a larger size always costs more than a smaller one", badOrder.length === 0, badOrder.map((p) => p.sku).join(","));
check("names are unique", new Set(products.map((p) => p.name)).size === products.length);
check("each product has its own picture file", new Set(products.map((p) => p.image)).size === products.length);

// WebP header: width and height of a lossy ("VP8 ") or extended ("VP8X") file.
function webpSize(buf) {
  if (buf.length < 30 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return null;
  const kind = buf.toString("ascii", 12, 16);
  if (kind === "VP8 ") return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  if (kind === "VP8X") return { w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1 };
  return { w: 0, h: 0 };
}
const missing = [], notWebp = [], wrongSize = [];
for (const p of products) {
  const file = path.join(ROOT, "public", p.image);
  if (!fs.existsSync(file)) { missing.push(p.sku); continue; }
  const dim = webpSize(fs.readFileSync(file));
  if (!dim) { if (p.product_type === "standard") notWebp.push(p.sku); continue; } // the external vase is a JPG on purpose
  if (Number(p.sku.slice(4)) >= SECOND_CATALOGUE_FROM && p.product_type === "standard" && (dim.w !== 560 || dim.h !== 700)) wrongSize.push(`${p.sku} ${dim.w}x${dim.h}`);
}
check("every product's picture file exists", missing.length === 0, missing.join(","));
check("every picture of a product sold here is a WebP", notWebp.length === 0, notWebp.join(","));
check("the second catalogue's pictures are 560x700, like the first's", wrongSize.length === 0, wrongSize.join(", "));

await pool.end();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
