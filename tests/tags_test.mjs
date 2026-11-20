// The tags: GET /api/tags (the listing's chips), the tags on GET /api/products/:id, and ?tag= filtering, with the
// "occasion" kind (Dịp) next to the flower and colour kinds.
//
// Run from the repo root with the server running on the same database:
//   export DB_HOST=127.0.0.1 DB_PORT=5433 DB_PASSWORD=dev
//   BASE=http://localhost:3000 node tests/tags_test.mjs
//
// It adds a few occasion tags named "zz test ..." (and links them to products) and removes them again in a finally
// block. Local or test database only, never production.
//
// Proves: "Dịp" is a group of its own, shown after the flower and colour groups, its tags in the order they were added
// (calendar order, not alphabetical) while the other groups stay alphabetical; a tag nobody can buy is not offered; the
// product page lists the same tags in the same order; ?tag= is OR within the occasions and AND with another kind.
// Does NOT prove: how the chips look.

import { createRequire } from "node:module";
import path from "node:path";

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const ROOT = process.cwd();
const require = createRequire(path.join(ROOT, "package.json"));
const { Pool } = require("pg");
const pool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1", port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || "quaint", database: process.env.DB_NAME || "bloomy", password: process.env.DB_PASSWORD || "dev",
});

let passed = 0, failed = 0;
function check(name, cond, extra = "") { if (cond) passed++; else { failed++; console.log(`FAIL ${name}${extra ? " :: " + extra : ""}`); } }
const j = async (p) => (await fetch(`${BASE}${p}`)).json();
const ids = (list) => list.map((x) => x.id).sort((a, b) => a - b);

// Stop early if this script's database is not the server's database.
{
  const row = (await pool.query("SELECT shop_address FROM settings")).rows[0];
  const api = await j("/api/settings");
  if (!row || row.shop_address !== api.shop_address) {
    console.log("FAIL this script is connected to a different database than the server at " + BASE + ". Export the same DB_HOST / DB_PORT / DB_PASSWORD as the server and run again.");
    process.exit(2);
  }
}

await pool.query("DELETE FROM tags WHERE kind = 'occasion' AND name LIKE 'zz test%'");
try {
  // Two buyable products and one that is discontinued, found by what they are, not by id.
  const buyable = (await pool.query("SELECT id FROM products WHERE status <> 'discontinued' ORDER BY id LIMIT 80")).rows.map((r) => r.id);
  const gone = (await pool.query("SELECT id FROM products WHERE status = 'discontinued' ORDER BY id LIMIT 1")).rows[0]?.id;
  check("setup: the seed has a discontinued product", gone !== undefined);
  // p1 and p2 must differ in a flower tag, so the AND check below has something to tell them apart.
  const flowerTags = async (id) => (await pool.query("SELECT t.id FROM product_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.product_id = $1 AND t.kind = 'flower'", [id])).rows.map((r) => r.id);
  let p1, p2, onlyP2;
  for (const a of buyable) {
    const fa = await flowerTags(a);
    for (const b of buyable) {
      if (a === b) continue;
      const only = (await flowerTags(b)).filter((t) => !fa.includes(t));
      if (fa.length && only.length) { p1 = a; p2 = b; onlyP2 = only[0]; break; }
    }
    if (p1) break;
  }
  check("setup: two products that differ in a flower tag", p1 !== undefined);

  // Inserted C, A, B on purpose: calendar (id) order must win over the alphabet. D is carried only by a discontinued
  // product and E by nothing, so neither may be offered.
  const tag = async (name) => (await pool.query("INSERT INTO tags (kind, name) VALUES ('occasion', $1) RETURNING id", [name])).rows[0].id;
  const C = await tag("zz test C"), A = await tag("zz test A"), B = await tag("zz test B"), D = await tag("zz test D"); await tag("zz test E");
  const link = (p, t) => pool.query("INSERT INTO product_tags (product_id, tag_id) VALUES ($1, $2)", [p, t]);
  await link(p1, C); await link(p1, A); await link(p2, B); await link(gone, D);

  // ---- GET /api/tags
  const { groups } = await j("/api/tags");
  const kinds = groups.map((g) => g.kind);
  const dip = groups.find((g) => g.kind === "occasion");
  check("a group 'Dịp' exists, the last one, after the flower and colour groups", !!dip && dip.label === "Dịp" && kinds.at(-1) === "occasion" && kinds.indexOf("flower") < kinds.indexOf("color"), JSON.stringify(kinds));
  const test = (dip?.tags || []).filter((t) => t.name.startsWith("zz test")).map((t) => t.name);
  check("the occasions are in the order they were added (C, A, B), not alphabetical", JSON.stringify(test) === JSON.stringify(["zz test C", "zz test A", "zz test B"]), JSON.stringify(test));
  check("an occasion only a discontinued product has, and one nobody has, are not offered", !test.includes("zz test D") && !test.includes("zz test E"));
  for (const g of groups.filter((x) => x.kind !== "occasion")) {
    const names = g.tags.map((t) => t.name);
    check(`the ${g.kind} group is still alphabetical`, JSON.stringify(names) === JSON.stringify([...names].sort((a, b) => a.localeCompare(b, "vi"))));
  }

  // ---- the product page
  const detail = await j(`/api/products/${p1}`);
  const rank = { flower: 0, color: 1, occasion: 2 };
  check("the product's tags are grouped flower, colour, occasion", detail.tags.every((t, i) => i === 0 || rank[detail.tags[i - 1].kind] <= rank[t.kind]), JSON.stringify(detail.tags.map((t) => t.kind)));
  const mine = detail.tags.filter((t) => t.kind === "occasion");
  check("its occasion tags carry the label 'Dịp' and run in the same order (C, A)", JSON.stringify(mine.map((t) => t.name)) === JSON.stringify(["zz test C", "zz test A"]) && mine.every((t) => t.kind_label === "Dịp"), JSON.stringify(mine));

  // ---- ?tag= filtering
  check("?tag=<occasion> lists the products that carry it", JSON.stringify(ids(await j(`/api/products?tag=${C}`))) === JSON.stringify([p1]));
  check("two occasions are OR: either one is enough", JSON.stringify(ids(await j(`/api/products?tag=${C}&tag=${B}`))) === JSON.stringify([p1, p2].sort((a, b) => a - b)));
  check("an occasion and a flower are AND: p2 has the flower but not occasion C", (await j(`/api/products?tag=${C}&tag=${onlyP2}`)).length === 0);
  check("an occasion and a flower both on the product: it is listed", ids(await j(`/api/products?tag=${B}&tag=${onlyP2}`)).includes(p2));
  check("a discontinued product's occasion lists nothing", (await j(`/api/products?tag=${D}`)).length === 0);
} finally {
  await pool.query("DELETE FROM tags WHERE kind = 'occasion' AND name LIKE 'zz test%'");
}
check("cleanup: no test tags left", Number((await pool.query("SELECT COUNT(*) FROM tags WHERE name LIKE 'zz test%'")).rows[0].count) === 0);
await pool.end();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
