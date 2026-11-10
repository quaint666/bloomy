// Campaigns: the data (schema + seed), GET /api/campaigns/active, and the owner's dropdown in Cài đặt
// (GET/PATCH /api/admin/settings).
//
// Run from the repo root with the server running on the same database:
//   export DB_HOST=127.0.0.1 DB_PORT=5433 DB_PASSWORD=dev
//   BASE=http://localhost:3000 node tests/campaign_test.mjs
//
// It briefly changes a coupon's end date, a product's status and the active campaign, and creates two staff
// accounts (an owner and a manager, named zz.test.*) for the admin checks; everything is put back / deleted in a
// finally block. Local or test database only, never production.
//
// Proves: the seeded campaigns are well-formed, the API returns the coupon LIVE (a changed window shows at once),
// hides discontinued products, keeps the shown order, answers 404 when none is on; only an owner can change the
// active campaign, unknown ids are refused; the database itself refuses a bad coupon reference and switches the
// page off when its campaign is deleted; /api/settings still shows only its 6 fields.
// Does NOT prove: anything about the landing page itself (not built yet at this step), or how Cài đặt looks.

import { createRequire } from "node:module";
import path from "node:path";
import jsdom from "jsdom";
const { JSDOM, VirtualConsole, requestInterceptor } = jsdom;

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const require = createRequire(path.join(process.cwd(), "package.json"));
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const pool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1", port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || "quaint", database: process.env.DB_NAME || "bloomy", password: process.env.DB_PASSWORD || "dev",
});

let passed = 0, failed = 0;
function check(name, cond, extra = "") { if (cond) passed++; else { failed++; console.log(`FAIL ${name}${extra ? " :: " + extra : ""}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000, step = 40) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(step); } return false; }
const noCss = requestInterceptor(async (request) => (request.url.endsWith(".css") ? new Response("", { headers: { "Content-Type": "text/css" } }) : undefined));
const j = async (p, opts) => { const res = await fetch(BASE + p, opts); let data = null; try { data = await res.json(); } catch {} return { status: res.status, data, res }; };

// Stop early if this script's database is not the server's database.
{
  const row = (await pool.query("SELECT shop_address, contact_phone, contact_email, vat_rate FROM settings")).rows[0];
  const api = (await j("/api/settings")).data;
  if (!row || row.shop_address !== api.shop_address || row.contact_phone !== api.contact_phone || row.contact_email !== api.contact_email || row.vat_rate !== api.vat_rate) {
    console.log("FAIL this script is connected to a different database than the server at " + BASE + " (settings differ). Export the same DB_HOST / DB_PORT / DB_PASSWORD as the server and run again.");
    process.exit(2);
  }
}

const original = (await pool.query("SELECT active_campaign_id FROM settings")).rows[0].active_campaign_id;
const tempUsers = [];
let touchedCoupon = null, touchedProduct = null, touchedSort = null;

async function login(username, password) {
  const r = await j("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  const cookie = (r.res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  return { status: r.status, cookie };
}
const admin = (cookie) => ({
  get: () => j("/api/admin/settings", { headers: { Cookie: cookie } }),
  patch: (body) => j("/api/admin/settings", { method: "PATCH", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) }),
});

try {
  // ------------------------------------------------------------ 1. the data
  const campaigns = (await pool.query("SELECT id, name, headline, coupon_code FROM campaigns ORDER BY id")).rows;
  check("at least two campaigns are seeded", campaigns.length >= 2, String(campaigns.length));
  for (const c of campaigns) {
    check(`campaign ${c.id}: has wording`, c.name.length > 0 && c.headline.length > 0);
    const coupon = c.coupon_code ? (await pool.query("SELECT type, value, starts_on, ends_on FROM coupons WHERE code=$1", [c.coupon_code])).rows[0] : null;
    check(`campaign ${c.id}: its coupon exists`, !c.coupon_code || !!coupon);
    if (coupon) check(`campaign ${c.id}: coupon has a sensible window`, !coupon.starts_on || !coupon.ends_on || coupon.starts_on <= coupon.ends_on);
    const n = Number((await pool.query("SELECT COUNT(*) FROM campaign_products WHERE campaign_id=$1", [c.id])).rows[0].count);
    check(`campaign ${c.id}: has products`, n > 0, String(n));
  }
  const dup = Number((await pool.query("SELECT COUNT(*) FROM (SELECT campaign_id, sort_order FROM campaign_products GROUP BY 1,2 HAVING COUNT(*) > 1) d")).rows[0].count);
  check("seed: no two products share a position in the same campaign", dup === 0, String(dup));

  // ------------------------------------------------------------ 2. the public API
  await pool.query("UPDATE settings SET active_campaign_id = $1", [campaigns[0].id]);
  const a = await j("/api/campaigns/active");
  check("active campaign: 200", a.status === 200, String(a.status));
  const c = a.data;
  check("…has its id, wording and a products list", c.id === campaigns[0].id && c.name === campaigns[0].name && c.headline === campaigns[0].headline && Array.isArray(c.products));
  check("…its keys are exactly the documented ones", JSON.stringify(Object.keys(c).sort()) === JSON.stringify(["coupon", "headline", "hero_image", "id", "name", "products", "subheadline"]), Object.keys(c).join());

  const dbCoupon = (await pool.query("SELECT code, type, value, min_subtotal, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on, active FROM coupons WHERE code=$1", [campaigns[0].coupon_code])).rows[0];
  check("…the coupon is the coupon table's row (same code, type, value, window)", c.coupon && c.coupon.code === dbCoupon.code && c.coupon.type === dbCoupon.type && c.coupon.value === dbCoupon.value && c.coupon.starts_on === dbCoupon.starts_on && c.coupon.ends_on === dbCoupon.ends_on, JSON.stringify(c.coupon));

  const expected = (await pool.query("SELECT cp.product_id FROM campaign_products cp JOIN products p ON p.id=cp.product_id WHERE cp.campaign_id=$1 AND p.status <> 'discontinued' ORDER BY cp.sort_order, cp.product_id", [c.id])).rows.map((r) => r.product_id);
  check("…products come in the campaign's own order", JSON.stringify(c.products.map((p) => p.id)) === JSON.stringify(expected), JSON.stringify([c.products.map((p) => p.id), expected]));
  check("…each product has what a card needs", c.products.every((p) => p.name && p.image && typeof p.price === "number" && typeof p.has_sizes === "boolean" && Array.isArray(p.sizes) && p.sizes.length > 0));
  check("…the shown price is the lowest size price, has_sizes matches", c.products.every((p) => p.price === Math.min(...p.sizes.map((s) => s.price)) && p.has_sizes === (p.sizes.length > 1)));
  const listed = (await j(`/api/products?sizes=1`)).data;
  check("…prices and sizes agree with the product list API", c.products.every((p) => { const q = listed.find((x) => x.id === p.id); return q && q.price === p.price && JSON.stringify(q.sizes) === JSON.stringify(p.sizes); }));

  // live coupon: move the end date in the coupon table, the API follows at once
  if (dbCoupon.ends_on) {
    touchedCoupon = { code: dbCoupon.code, ends_on: dbCoupon.ends_on };
    await pool.query("UPDATE coupons SET ends_on = ends_on + 3 WHERE code=$1", [dbCoupon.code]);
    const moved = (await pool.query("SELECT to_char(ends_on, 'YYYY-MM-DD') AS d FROM coupons WHERE code=$1", [dbCoupon.code])).rows[0].d;
    const live = (await j("/api/campaigns/active")).data;
    check("moving the coupon's end date shows in the API on the next request", live.coupon.ends_on === moved && moved !== dbCoupon.ends_on, `${live.coupon.ends_on} vs ${moved}`);
    await pool.query("UPDATE coupons SET active = false WHERE code=$1", [dbCoupon.code]);
    check("deactivating the coupon shows too (active: false)", (await j("/api/campaigns/active")).data.coupon.active === false);
  }

  // the order is the campaign's own, not the product ids' (move the first product to the end and the API follows)
  if (expected.length > 1) {
    const first = expected[0];
    touchedSort = { campaign: c.id, product: first, sort_order: (await pool.query("SELECT sort_order FROM campaign_products WHERE campaign_id=$1 AND product_id=$2", [c.id, first])).rows[0].sort_order };
    await pool.query("UPDATE campaign_products SET sort_order = 99 WHERE campaign_id=$1 AND product_id=$2", [c.id, first]);
    const reordered = (await j("/api/campaigns/active")).data.products.map((p) => p.id);
    check("changing a product's position changes the order the API returns", JSON.stringify(reordered) === JSON.stringify([...expected.slice(1), first]), JSON.stringify([reordered, [...expected.slice(1), first]]));
    await pool.query("UPDATE campaign_products SET sort_order=$1 WHERE campaign_id=$2 AND product_id=$3", [touchedSort.sort_order, c.id, first]);
    touchedSort = null;
  }

  // a discontinued product disappears
  if (expected.length > 1) {
    const victim = expected[0];
    touchedProduct = { id: victim, status: (await pool.query("SELECT status FROM products WHERE id=$1", [victim])).rows[0].status };
    await pool.query("UPDATE products SET status='discontinued' WHERE id=$1", [victim]);
    const after = (await j("/api/campaigns/active")).data;
    check("a discontinued product is left out", !after.products.some((p) => p.id === victim) && after.products.length === expected.length - 1);
    await pool.query("UPDATE products SET status=$1 WHERE id=$2", [touchedProduct.status, victim]);
    check("…and returns when it is available again", (await j("/api/campaigns/active")).data.products.some((p) => p.id === victim));
    touchedProduct = null;
  }

  // none active
  await pool.query("UPDATE settings SET active_campaign_id = NULL");
  const none = await j("/api/campaigns/active");
  check("no active campaign → 404 no_active_campaign", none.status === 404 && none.data?.error === "no_active_campaign", JSON.stringify(none));
  const pub = (await j("/api/settings")).data;
  check("/api/settings still shows only its 6 fields (nothing about campaigns)", JSON.stringify(Object.keys(pub).sort()) === JSON.stringify(["contact_email", "contact_phone", "max_fee", "min_fee", "shop_address", "vat_rate"]), Object.keys(pub).join());

  // ------------------------------------------------------------ 3. the database's own rules (rolled back)
  {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      let refused = false;
      await client.query("SAVEPOINT s1");
      try { await client.query("INSERT INTO campaigns (name, headline, coupon_code) VALUES ('x', 'y', 'NO_SUCH_CODE')"); } catch (e) { refused = e.code === "23503"; }
      await client.query("ROLLBACK TO s1");
      check("a campaign cannot point at a coupon that does not exist", refused);
      refused = false;
      try { await client.query("INSERT INTO campaigns (name, headline) VALUES ('', 'y')"); } catch (e) { refused = e.code === "23514"; }
      await client.query("ROLLBACK TO s1");
      check("an empty campaign name is refused", refused);
      const { rows } = await client.query("INSERT INTO campaigns (name, headline) VALUES ('Tạm', 'Tạm') RETURNING id");
      await client.query("UPDATE settings SET active_campaign_id = $1", [rows[0].id]);
      await client.query("DELETE FROM campaigns WHERE id = $1", [rows[0].id]);
      const ptr = (await client.query("SELECT active_campaign_id FROM settings")).rows[0].active_campaign_id;
      check("deleting the active campaign switches the page off (pointer becomes NULL)", ptr === null, String(ptr));
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }

  // ------------------------------------------------------------ 4. the owner's dropdown in Cài đặt
  const hash = await bcrypt.hash("zz-test-password-1", 10);
  for (const [name, role] of [["zz.test.owner", "owner"], ["zz.test.manager", "manager"]]) {
    const r = await pool.query("INSERT INTO admin_users (username, password, role) VALUES ($1, $2, $3) RETURNING id", [name, hash, role]);
    tempUsers.push(r.rows[0].id);
  }
  const owner = await login("zz.test.owner", "zz-test-password-1");
  const manager = await login("zz.test.manager", "zz-test-password-1");
  check("test owner and manager can log in", owner.status === 200 && manager.status === 200, `${owner.status}/${manager.status}`);
  const o = admin(owner.cookie), m = admin(manager.cookie);

  const g = await o.get();
  check("owner GET: 200 with active_campaign_id and the campaign list", g.status === 200 && "active_campaign_id" in g.data && Array.isArray(g.data.campaigns) && g.data.campaigns.length === campaigns.length, JSON.stringify(g.data)?.slice(0, 120));
  check("…the list is {id, name} for each campaign", g.data.campaigns.every((x) => Object.keys(x).sort().join() === "id,name"));
  check("…and the current value is the real one (none right now)", g.data.active_campaign_id === null);

  const setOn = await o.patch({ active_campaign_id: campaigns[1].id });
  check("owner PATCH: choose campaign 2 → 200, returned with the list", setOn.status === 200 && setOn.data.active_campaign_id === campaigns[1].id && Array.isArray(setOn.data.campaigns));
  const nowActive = await j("/api/campaigns/active");
  check("…and the public API now serves campaign 2", nowActive.status === 200 && nowActive.data.id === campaigns[1].id);
  const setOff = await o.patch({ active_campaign_id: null });
  check("owner PATCH: none (null) → 200", setOff.status === 200 && setOff.data.active_campaign_id === null);
  check("…and the public API answers 404 again", (await j("/api/campaigns/active")).status === 404);

  for (const [label, value] of [["an id that does not exist", 999999], ["a string", "1"], ["zero", 0], ["a decimal", 1.5], ["an object", {}]]) {
    const r = await o.patch({ active_campaign_id: value });
    check(`owner PATCH with ${label} → 400 invalid_field`, r.status === 400 && r.data?.field === "active_campaign_id", JSON.stringify(r));
  }
  const keep = await o.patch({ active_campaign_id: campaigns[0].id, vat_rate: 10 });
  check("it can be sent together with the other fields (as the page does)", keep.status === 200 && keep.data.vat_rate === 10 && keep.data.active_campaign_id === campaigns[0].id);
  const other = await o.patch({ vat_rate: 10 });
  check("a PATCH without it leaves the active campaign alone", other.status === 200 && other.data.active_campaign_id === campaigns[0].id);

  check("manager cannot read the settings (owner only)", (await m.get()).status === 403);
  const mp = await m.patch({ active_campaign_id: null });
  check("manager cannot change the active campaign", mp.status === 403, String(mp.status));
  check("…and nothing changed", (await pool.query("SELECT active_campaign_id FROM settings")).rows[0].active_campaign_id === campaigns[0].id);
  const anon = await j("/api/admin/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active_campaign_id: null }) });
  check("not logged in → 401", anon.status === 401, String(anon.status));

  // ------------------------------------------------------------ 5. the Cài đặt page's dropdown (real page + script in jsdom, logged in as the owner)
  {
    await pool.query("UPDATE settings SET active_campaign_id = $1", [campaigns[1].id]);
    const dom = new JSDOM(await (await fetch(`${BASE}/admin-settings.html`)).text(), {
      url: `${BASE}/admin-settings.html`, runScripts: "dangerously", resources: { interceptors: [noCss] }, pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
      beforeParse(w) { w.fetch = (u, o = {}) => fetch(new URL(u, `${BASE}/admin-settings.html`), { ...o, headers: { ...(o.headers || {}), Cookie: owner.cookie } }); },
    });
    const d = dom.window.document, sel = d.getElementById("set-campaign");
    const loaded = await until(() => sel.options.length === campaigns.length + 1 && sel.value === String(campaigns[1].id));
    check("Cài đặt page: the dropdown lists \"Không có\" and every campaign, with the current one chosen", loaded, `${sel.options.length} options, value=${sel.value}`);
    check("…the options carry the campaign names", [...sel.options].slice(1).map((o) => o.textContent).join("|") === campaigns.map((x) => x.name).join("|"));
    const save = async () => { d.getElementById("admin-settings-form").requestSubmit(); return until(async () => /Đã lưu/.test(d.getElementById("admin-settings-msg").textContent) && !d.getElementById("admin-settings-msg").hidden); };
    sel.value = "";
    d.getElementById("admin-settings-msg").hidden = true;
    check("choosing \"Không có\" and saving works", await save());
    check("…the database pointer is NULL", (await pool.query("SELECT active_campaign_id FROM settings")).rows[0].active_campaign_id === null);
    check("…the page keeps showing \"Không có\" after saving", sel.value === "");
    sel.value = String(campaigns[0].id);
    d.getElementById("admin-settings-msg").hidden = true;
    check("choosing a campaign and saving works", await save());
    check("…the database pointer is that campaign", (await pool.query("SELECT active_campaign_id FROM settings")).rows[0].active_campaign_id === campaigns[0].id);
    check("…and the public API serves it", (await j("/api/campaigns/active")).data?.id === campaigns[0].id);
    dom.window.close();
  }
} finally {
  await pool.query("UPDATE settings SET active_campaign_id = $1", [original]);
  if (touchedCoupon) await pool.query("UPDATE coupons SET ends_on = $1, active = true WHERE code = $2", [touchedCoupon.ends_on, touchedCoupon.code]);
  if (touchedProduct) await pool.query("UPDATE products SET status=$1 WHERE id=$2", [touchedProduct.status, touchedProduct.id]);
  if (touchedSort) await pool.query("UPDATE campaign_products SET sort_order=$1 WHERE campaign_id=$2 AND product_id=$3", [touchedSort.sort_order, touchedSort.campaign, touchedSort.product]);
  for (const id of tempUsers) {
    await pool.query("DELETE FROM session WHERE sess::text LIKE $1", [`%"adminId":${id}%`]);
    await pool.query("DELETE FROM admin_users WHERE id = $1", [id]);
  }
}
check("cleanup: active campaign restored", (await pool.query("SELECT active_campaign_id FROM settings")).rows[0].active_campaign_id === original);
check("cleanup: test staff accounts removed", Number((await pool.query("SELECT COUNT(*) FROM admin_users WHERE username LIKE 'zz.test.%'")).rows[0].count) === 0);
await pool.end();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
