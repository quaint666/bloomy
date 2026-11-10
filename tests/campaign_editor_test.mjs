// The campaign editor: its API (roles, options, create, edit, delete, every refusal), what an edit does to the
// public page, the guard on switching a campaign ON, and the editor page itself (real page and script in jsdom).
//
// Run from the repo root (the server for the browser part is started by the test itself, on port 39708, with a
// temporary folder of pictures, so no picture files are needed):
//   export DB_HOST=127.0.0.1 DB_PORT=5433 DB_PASSWORD=dev
//   BASE=http://localhost:3000 node tests/campaign_editor_test.mjs
//
// It creates campaigns named "zz test ..." and three staff accounts named zz.test.*, edits the seeded campaign
// for a moment (headline, picture, product order) and the active campaign pointer, and puts everything back in a
// finally block. Local or test database only, never production.
//
// Proves: only managers and up can use it; the picture must be one of the files offered (no other path, no URL,
// not the logo or the share image); text, coupon and product list are validated; the list keeps its order; an
// edit shows on the public page and API at once; a campaign that is on cannot be deleted; a campaign with
// nothing to sell cannot be switched on (but an unrelated settings save is never blocked by it); the page
// works end to end.
// Does NOT prove: how the page looks, or real mouse/keyboard use.

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import jsdom from "jsdom";
const { JSDOM, VirtualConsole, requestInterceptor } = jsdom;

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const ROOT = process.cwd();
const require = createRequire(path.join(ROOT, "package.json"));
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const pool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1", port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || "quaint", database: process.env.DB_NAME || "bloomy", password: process.env.DB_PASSWORD || "dev",
});

let passed = 0, failed = 0;
// A page script that fails on its own (a rejected request nobody handled) is a failure, not a crash.
process.on("unhandledRejection", (e) => { failed++; console.log(`FAIL a page script failed on its own :: ${String(e).slice(0, 160)}`); });
function check(name, cond, extra = "") { if (cond) passed++; else { failed++; console.log(`FAIL ${name}${extra ? " :: " + extra : ""}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000, step = 40) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(step); } return false; }
const noCss = requestInterceptor(async (request) => (request.url.endsWith(".css") ? new Response("", { headers: { "Content-Type": "text/css" } }) : undefined));

// Stop early if this script's database is not the server's database.
{
  const row = (await pool.query("SELECT shop_address, contact_phone, contact_email, vat_rate FROM settings")).rows[0];
  const api = await (await fetch(`${BASE}/api/settings`)).json();
  if (!row || row.shop_address !== api.shop_address || row.contact_phone !== api.contact_phone || row.contact_email !== api.contact_email || row.vat_rate !== api.vat_rate) {
    console.log("FAIL this script is connected to a different database than the server at " + BASE + " (settings differ). Export the same DB_HOST / DB_PORT / DB_PASSWORD as the server and run again.");
    process.exit(2);
  }
}

// ---- a server of our own, with a temporary folder of pictures
const imagesDir = fs.mkdtempSync(path.join(os.tmpdir(), "bloomy-images-"));
for (const f of ["campaign-20-10.webp", "bo-hoa-hong.jpg", "Anh-Mau.PNG", "banner.jpeg", "logo-bloomy.png", "bloomylogo.png", "og-image.jpg", "favicon.png", "apple-touch-icon.png", "notes.txt", "script.js"]) fs.writeFileSync(path.join(imagesDir, f), "x");
fs.mkdirSync(path.join(imagesDir, "sub.webp")); // a folder that looks like a picture
const PORT = 39708, X = `http://127.0.0.1:${PORT}`;
const child = spawn("node", ["server.js"], { cwd: ROOT, stdio: "ignore", env: { ...process.env, PORT: String(PORT), BLOOMY_IMAGES_DIR: imagesDir, SESSION_SECRET: process.env.SESSION_SECRET || "x", BLOOMY_BASE_URL: "http://localhost",
  ZALOPAY_ENDPOINT: process.env.ZALOPAY_ENDPOINT || "https://sb-openapi.zalopay.vn", ZALOPAY_APP_ID: process.env.ZALOPAY_APP_ID || "1", ZALOPAY_KEY1: process.env.ZALOPAY_KEY1 || "a", ZALOPAY_KEY2: process.env.ZALOPAY_KEY2 || "b", DB_PASSWORD: process.env.DB_PASSWORD || "dev", EMAIL_MODE: "log" } });
let up = false;
for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(`${X}/css/style.css`)).ok; } catch {} }
check("the test's own server starts", up);

const tempUsers = [], created = [];
// Leftovers from an earlier run that was killed half-way would clash with the accounts made below.
await pool.query("DELETE FROM admin_users WHERE username LIKE 'zz.test.%'");
await pool.query("DELETE FROM campaigns WHERE name LIKE 'zz test%'");
const original = {
  active: (await pool.query("SELECT active_campaign_id FROM settings")).rows[0].active_campaign_id,
  vat: (await pool.query("SELECT vat_rate FROM settings")).rows[0].vat_rate,
};
const seeded = (await pool.query("SELECT id, name, headline, subheadline, coupon_code, hero_image FROM campaigns ORDER BY id")).rows;
const seededProducts = (await pool.query("SELECT campaign_id, product_id, sort_order FROM campaign_products ORDER BY campaign_id, sort_order")).rows;
const productStatus = new Map();

try {
  const hash = await bcrypt.hash("zz-test-password-1", 10);
  for (const [name, role] of [["zz.test.owner", "owner"], ["zz.test.manager", "manager"], ["zz.test.employee", "employee"]]) {
    tempUsers.push((await pool.query("INSERT INTO admin_users (username, password, role) VALUES ($1, $2, $3) RETURNING id", [name, hash, role])).rows[0].id);
  }
  const login = async (username) => { const r = await fetch(`${X}/api/admin/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: "zz-test-password-1" }) }); return { status: r.status, cookie: (r.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ") }; };
  const who = { owner: await login("zz.test.owner"), manager: await login("zz.test.manager"), employee: await login("zz.test.employee") };
  check("test owner, manager and employee can log in", Object.values(who).every((w) => w.status === 200));
  const call = async (cookie, method, p, body, base = "/api/admin/campaigns") => {
    const res = await fetch(`${X}${base}${p}`, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch {}
    return { status: res.status, data };
  };
  const M = who.manager.cookie, O = who.owner.cookie;
  const refused = async (label, method, p, body, field) => { const r = await call(M, method, p, body); if (r.data?.id && method === "POST") created.push(r.data.id); /* it should not exist: if it does, still clean it up */ check(`${label} → 400 invalid_field (${field})`, r.status === 400 && r.data?.error === "invalid_field" && r.data?.field === field, JSON.stringify(r)); };

  // ============================================================ roles
  for (const [label, method, p, body] of [["list", "GET", "", null], ["options", "GET", "/options", null], ["one", "GET", `/${seeded[0].id}`, null], ["create", "POST", "", { name: "x", headline: "y" }], ["edit", "PATCH", `/${seeded[0].id}`, { name: "x" }], ["delete", "DELETE", "/999999", null]]) {
    check(`not logged in: ${label} → 401`, (await call(null, method, p, body)).status === 401);
    check(`employee: ${label} → 403`, (await call(who.employee.cookie, method, p, body)).status === 403);
  }
  check("owner can use it too", (await call(O, "GET", "")).status === 200);

  // ============================================================ the list and the choices
  const list = (await call(M, "GET", "")).data;
  check("list: every campaign with id, name, headline, coupon, picture, product count and whether it is on", list.length === seeded.length && list.every((c) => Object.keys(c).sort().join() === "active,coupon_code,headline,hero_image,id,name,product_count"));
  check("list: exactly the active campaign says active", list.filter((c) => c.active).map((c) => c.id).join() === String(original.active ?? ""), JSON.stringify(list.map((c) => [c.id, c.active])));
  check("list: product counts match the database", list.every((c) => c.product_count === seededProducts.filter((r) => r.campaign_id === c.id).length));
  const opt = (await call(M, "GET", "/options")).data;
  check("options: every coupon, every product, and the limits", opt.coupons.length === Number((await pool.query("SELECT COUNT(*) FROM coupons")).rows[0].count) && opt.products.length === Number((await pool.query("SELECT COUNT(*) FROM products")).rows[0].count) && opt.limits.products === 12 && opt.limits.name === 80 && opt.limits.headline === 120 && opt.limits.subheadline === 200);
  check("options: the pictures offered are the picture files only (campaign-… first; no logo, favicon or share image; no text or script files; no folders)", JSON.stringify(opt.images) === JSON.stringify(["images/campaign-20-10.webp", "images/Anh-Mau.PNG", "images/banner.jpeg", "images/bo-hoa-hong.jpg"]), JSON.stringify(opt.images));
  const one = (await call(M, "GET", `/${seeded[0].id}`)).data;
  check("one campaign: its words, coupon, picture and its products in the stored order, with status", one.id === seeded[0].id && one.name === seeded[0].name && JSON.stringify(one.products.map((p) => p.id)) === JSON.stringify(seededProducts.filter((r) => r.campaign_id === seeded[0].id).map((r) => r.product_id)) && one.products.every((p) => p.status && p.name && "image" in p));
  check("an unknown or malformed id → 404", (await call(M, "GET", "/999999")).status === 404 && (await call(M, "GET", "/abc")).status === 404 && (await call(M, "GET", "/0")).status === 404);

  // ============================================================ create
  const avail = (await pool.query("SELECT id FROM products WHERE status='available' ORDER BY id LIMIT 14")).rows.map((r) => r.id);
  const gone = (await pool.query("SELECT id FROM products WHERE status='discontinued' ORDER BY id LIMIT 1")).rows[0].id;
  const minimal = await call(M, "POST", "", { name: "  zz test   tối giản ", headline: "Tiêu đề thử" });
  check("create: only a name and a headline → 201, tidied, no coupon, no picture, no products, not on", minimal.status === 201 && minimal.data.name === "zz test tối giản" && minimal.data.coupon_code === null && minimal.data.hero_image === null && minimal.data.subheadline === null && minimal.data.products.length === 0 && minimal.data.active === false, JSON.stringify(minimal));
  created.push(minimal.data.id);
  const coupon = opt.coupons[0].code;
  const full = await call(M, "POST", "", { name: "zz test đầy đủ", headline: "Một tiêu đề", subheadline: "Một dòng giới thiệu.", coupon_code: coupon, hero_image: "images/campaign-20-10.webp", product_ids: [avail[3], avail[1], avail[2]] });
  check("create: everything at once → 201, products in the order sent", full.status === 201 && full.data.coupon_code === coupon && full.data.hero_image === "images/campaign-20-10.webp" && JSON.stringify(full.data.products.map((p) => p.id)) === JSON.stringify([avail[3], avail[1], avail[2]]), JSON.stringify(full.data?.products?.map((p) => p.id)));
  created.push(full.data.id);
  check("create: it is in the list with the right count, not active", (await call(M, "GET", "")).data.some((c) => c.id === full.data.id && c.product_count === 3 && c.active === false));
  check("create: sort positions are 1, 2, 3 in the database", JSON.stringify((await pool.query("SELECT sort_order FROM campaign_products WHERE campaign_id=$1 ORDER BY sort_order", [full.data.id])).rows.map((r) => r.sort_order)) === "[1,2,3]");

  // ============================================================ refusals
  await refused("create without a name", "POST", "", { headline: "h" }, "name");
  await refused("create without a headline", "POST", "", { name: "n" }, "headline");
  await refused("a blank name", "POST", "", { name: "   ", headline: "h" }, "name");
  await refused("a name of 81 characters", "POST", "", { name: "n".repeat(81), headline: "h" }, "name");
  await refused("a headline of 121 characters", "POST", "", { name: "n", headline: "h".repeat(121) }, "headline");
  await refused("a subheadline of 201 characters", "POST", "", { name: "n", headline: "h", subheadline: "s".repeat(201) }, "subheadline");
  await refused("a number as the name", "POST", "", { name: 5, headline: "h" }, "name");
  await refused("a control character in the headline", "POST", "", { name: "n", headline: "a\u0000b" }, "headline");
  await refused("a coupon that does not exist", "POST", "", { name: "n", headline: "h", coupon_code: "NO_SUCH" }, "coupon_code");
  await refused("a picture that is not on the list", "POST", "", { name: "n", headline: "h", hero_image: "images/other.webp" }, "hero_image");
  await refused("a picture path that climbs out of the folder", "POST", "", { name: "n", headline: "h", hero_image: "images/../server.js" }, "hero_image");
  await refused("a picture that is a web address", "POST", "", { name: "n", headline: "h", hero_image: "https://evil.example/x.jpg" }, "hero_image");
  await refused("the logo (not offered)", "POST", "", { name: "n", headline: "h", hero_image: "images/logo-bloomy.png" }, "hero_image");
  await refused("the share image (not offered)", "POST", "", { name: "n", headline: "h", hero_image: "images/og-image.jpg" }, "hero_image");
  await refused("a text file (not a picture)", "POST", "", { name: "n", headline: "h", hero_image: "images/notes.txt" }, "hero_image");
  await refused("the bare file name without images/", "POST", "", { name: "n", headline: "h", hero_image: "campaign-20-10.webp" }, "hero_image");
  await refused("products that are not a list", "POST", "", { name: "n", headline: "h", product_ids: "1,2" }, "product_ids");
  await refused("13 products", "POST", "", { name: "n", headline: "h", product_ids: [...avail, 99999].slice(0, 13) }, "product_ids");
  await refused("the same product twice", "POST", "", { name: "n", headline: "h", product_ids: [avail[0], avail[0]] }, "product_ids");
  await refused("a product that does not exist", "POST", "", { name: "n", headline: "h", product_ids: [avail[0], 999999] }, "product_ids");
  await refused("a product id that is not a whole positive number", "POST", "", { name: "n", headline: "h", product_ids: [0] }, "product_ids");
  await refused("a product id as text", "POST", "", { name: "n", headline: "h", product_ids: ["5"] }, "product_ids");
  const nothingMade = Number((await pool.query("SELECT COUNT(*) FROM campaigns WHERE name LIKE 'n' OR name LIKE 'zz test%'")).rows[0].count);
  check("refused requests created nothing (only the two campaigns made above exist)", nothingMade === 2, String(nothingMade));
  check("12 products is allowed (the limit is inclusive)", (await call(M, "POST", "", { name: "zz test mười hai", headline: "h", product_ids: avail.slice(0, 12) }).then((r) => { if (r.data?.id) created.push(r.data.id); return r.status === 201; })));

  // ============================================================ edit
  const id = full.data.id;
  const e1 = await call(M, "PATCH", `/${id}`, { headline: "Tiêu đề mới" });
  check("edit: one field changes, the rest stay", e1.status === 200 && e1.data.headline === "Tiêu đề mới" && e1.data.name === "zz test đầy đủ" && e1.data.coupon_code === coupon && e1.data.hero_image === "images/campaign-20-10.webp" && e1.data.products.length === 3);
  const e2 = await call(M, "PATCH", `/${id}`, { product_ids: [avail[2], avail[3]] });
  check("edit: the product list is replaced, in the new order", JSON.stringify(e2.data.products.map((p) => p.id)) === JSON.stringify([avail[2], avail[3]]));
  check("edit: an empty list clears the products", (await call(M, "PATCH", `/${id}`, { product_ids: [] })).data.products.length === 0);
  const e3 = await call(M, "PATCH", `/${id}`, { subheadline: "", coupon_code: null, hero_image: null });
  check("edit: blank/null clears the subheadline, the coupon and the picture", e3.data.subheadline === null && e3.data.coupon_code === null && e3.data.hero_image === null);
  await refused("edit: a blank name can never be saved", "PATCH", `/${id}`, { name: "" }, "name");
  await refused("edit: an unknown picture is refused", "PATCH", `/${id}`, { hero_image: "images/nope.webp" }, "hero_image");
  check("edit: nothing to change → 400", (await call(M, "PATCH", `/${id}`, {})).data?.error === "nothing_to_update");
  check("edit: unknown campaign → 404", (await call(M, "PATCH", "/999999", { name: "x" })).status === 404);
  check("edit: a refused edit changed nothing (the headline is still the last good one)", (await call(M, "GET", `/${id}`)).data.headline === "Tiêu đề mới");

  // ============================================================ what an edit does to the public page
  {
    const target = seeded[0];
    await pool.query("UPDATE settings SET active_campaign_id=$1", [target.id]);
    const before = (await call(M, "GET", `/${target.id}`)).data;
    const firstTwo = before.products.slice(0, 2).map((p) => p.id);
    const swapped = [firstTwo[1], firstTwo[0], ...before.products.slice(2).map((p) => p.id)];
    const edit = await call(M, "PATCH", `/${target.id}`, { headline: "Tiêu đề do quản lý sửa", hero_image: "images/bo-hoa-hong.jpg", product_ids: swapped });
    check("edit the active campaign: 200", edit.status === 200 && edit.data.active === true);
    const html = await (await fetch(`${X}/landing`)).text();
    const d = new JSDOM(html).window.document;
    check("…the landing page shows the new headline and the chosen picture beside the text at once", d.querySelector("h1")?.textContent === "Tiêu đề do quản lý sửa" && d.querySelector(".landing-hero__media img")?.getAttribute("src") === "images/bo-hoa-hong.jpg");
    const apiNow = await (await fetch(`${X}/api/campaigns/active`)).json();
    check("…the public API serves the products in the new order", JSON.stringify(apiNow.products.map((p) => p.id).slice(0, 2)) === JSON.stringify(swapped.filter((n) => apiNow.products.some((p) => p.id === n)).slice(0, 2)) && apiNow.headline === "Tiêu đề do quản lý sửa");
    const home = new JSDOM(await (await fetch(`${X}/`)).text()).window.document;
    check("…and the homepage card shows the headline and the same picture", home.querySelector(".campaign-card__headline")?.textContent === "Tiêu đề do quản lý sửa" && home.querySelector(".campaign-card__image")?.getAttribute("src") === "images/bo-hoa-hong.jpg");
    await call(M, "PATCH", `/${target.id}`, { headline: target.headline, hero_image: target.hero_image, product_ids: before.products.map((p) => p.id) });
  }

  // ============================================================ delete
  {
    const del = await call(M, "POST", "", { name: "zz test xóa", headline: "h", product_ids: [avail[0], avail[1]] });
    created.push(del.data.id);
    check("delete: a campaign that is not on is removed (200)", (await call(M, "DELETE", `/${del.data.id}`)).data?.ok === true);
    check("…it is gone from the list and its product rows are gone too", !(await call(M, "GET", "")).data.some((c) => c.id === del.data.id) && Number((await pool.query("SELECT COUNT(*) FROM campaign_products WHERE campaign_id=$1", [del.data.id])).rows[0].count) === 0);
    await pool.query("UPDATE settings SET active_campaign_id=$1", [seeded[0].id]);
    const r = await call(M, "DELETE", `/${seeded[0].id}`);
    check("delete: the campaign that is on cannot be deleted (409)", r.status === 409 && r.data.error === "campaign_active");
    check("…and it is still there", (await call(M, "GET", `/${seeded[0].id}`)).status === 200);
    check("delete: unknown → 404", (await call(M, "DELETE", "/999999")).status === 404);
  }

  // ============================================================ switching a campaign ON
  {
    const setActive = (cookie, value, extra = {}) => call(cookie, "PATCH", "", { active_campaign_id: value, ...extra }, "/api/admin/settings");
    const empty = minimal.data.id;
    const r1 = await setActive(O, empty);
    check("a campaign with no products cannot be switched on (400 campaign_empty)", r1.status === 400 && r1.data.error === "campaign_empty" && r1.data.field === "active_campaign_id", JSON.stringify(r1));
    check("…and the pointer did not move", (await pool.query("SELECT active_campaign_id FROM settings")).rows[0].active_campaign_id === seeded[0].id);
    const onlyGone = await call(M, "POST", "", { name: "zz test ngừng bán", headline: "h", product_ids: [gone] });
    created.push(onlyGone.data.id);
    const r2 = await setActive(O, onlyGone.data.id);
    check("one that holds only discontinued products cannot be switched on either", r2.status === 400 && r2.data.error === "campaign_empty");
    const r3 = await setActive(O, full.data.id);
    check("…while the campaign with no products yet can't, one with an available product can (after adding one)", r3.status === 400);
    await call(M, "PATCH", `/${full.data.id}`, { product_ids: [avail[0]] });
    const r4 = await setActive(O, full.data.id);
    check("a campaign with a buyable product switches on (200)", r4.status === 200 && r4.data.active_campaign_id === full.data.id);
    // the campaign that is on runs out of products; an unrelated settings save must still work
    productStatus.set(avail[0], "available");
    await pool.query("UPDATE products SET status='discontinued' WHERE id=$1", [avail[0]]);
    const r5 = await setActive(O, full.data.id, { vat_rate: original.vat });
    check("saving other settings while the campaign that is on has run out of products is NOT blocked (the same choice is not a change)", r5.status === 200 && r5.data.active_campaign_id === full.data.id, JSON.stringify(r5));
    const r6 = await setActive(O, minimal.data.id);
    check("…but switching to another empty campaign still is", r6.status === 400 && r6.data.error === "campaign_empty");
    const r7 = await setActive(O, null);
    check("switching everything off is always allowed", r7.status === 200 && r7.data.active_campaign_id === null);
    await pool.query("UPDATE products SET status='available' WHERE id=$1", [avail[0]]);
    check("the public landing page redirects when none is on", (await fetch(`${X}/landing`, { redirect: "manual" })).status === 302);
    await pool.query("UPDATE settings SET active_campaign_id=$1", [seeded[0].id]);
  }

  // ============================================================ the page
  {
    const html = await (await fetch(`${X}/admin-campaigns.html`)).text();
    const page = async (role = "manager", confirmAnswer = true) => {
      const asked = [];
      const dom = new JSDOM(html, { url: `${X}/admin-campaigns.html`, runScripts: "dangerously", resources: { interceptors: [noCss] }, pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
        beforeParse(w) {
          w.confirm = (m) => { asked.push(m); return confirmAnswer; };
          if (!w.HTMLDialogElement.prototype.showModal) { w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); }; w.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); }; }
          w.fetch = (u, o = {}) => fetch(new URL(u, `${X}/admin-campaigns.html`), { ...o, headers: { ...(o.headers || {}), Cookie: who[role].cookie } });
        } });
      const d = dom.window.document;
      const total = Number((await pool.query("SELECT COUNT(*) FROM campaigns")).rows[0].count);
      await until(() => d.querySelectorAll("#camp-list .admin-seo__row").length === total);
      const $ = (i) => d.getElementById(i);
      const type = (i, v) => { $(i).value = v; $(i).dispatchEvent(new dom.window.Event("input", { bubbles: true })); };
      const rowOf = (cid) => d.querySelector(`#camp-list button[data-id="${cid}"]`);
      return { dom, w: dom.window, d, $, type, rowOf, asked, total, close: () => dom.window.close() };
    };

    const p = await page();
    check("page: a row per campaign, the one that is on says so, the editor starts closed", p.d.querySelectorAll("#camp-list .admin-seo__row").length === p.total && p.rowOf(seeded[0].id).textContent.includes("Đang chạy") && p.$("camp-panel").hidden && !!p.d.querySelector('#admin-nav-links a[href="admin-campaigns.html"]'));
    p.rowOf(seeded[0].id).click();
    const db = (await pool.query("SELECT name, headline, subheadline, coupon_code FROM campaigns WHERE id=$1", [seeded[0].id])).rows[0];
    check("page: picking a campaign fills the form from the database", await until(() => !p.$("camp-panel").hidden && p.$("camp-name").value === db.name) && p.$("camp-headline").value === db.headline && p.$("camp-sub").value === (db.subheadline || "") && p.$("camp-coupon").value === (db.coupon_code || ""));
    check("page: the coupon list has \"không dùng mã\" and every coupon", p.$("camp-coupon").options.length === opt.coupons.length + 1);
    check("page: the campaign that is on shows the note with a link to the page, and cannot be deleted from here", !p.$("camp-active-note").hidden && p.$("camp-active-note").querySelector("a").getAttribute("href") === "landing" && p.$("camp-delete").disabled === true);
    const rows = () => [...p.d.querySelectorAll("#camp-products li")];
    check("page: its products are listed in order, each with up, down and remove buttons", rows().length === seededProducts.filter((r) => r.campaign_id === seeded[0].id).length && rows().every((li) => li.querySelectorAll("button").length === 3) && rows()[0].querySelector('[data-act="up"]').disabled && rows().at(-1).querySelector('[data-act="down"]').disabled);
    check("page: the heading counts them (n/12)", /\(\d+\/12/.test(p.$("camp-products-heading").textContent));
    p.type("camp-headline", "Một tiêu đề đang sửa");
    check("page: typing updates the character counts", p.$("camp-headline-count").textContent === `(${[..."Một tiêu đề đang sửa"].length}/120)`);
    p.close();

    const q = await page("manager", false);
    q.rowOf(seeded[0].id).click();
    await until(() => !q.$("camp-panel").hidden);
    q.type("camp-headline", "chưa lưu");
    q.rowOf(seeded[1].id).click();
    await sleep(200);
    check("page: switching with unsaved typing asks first, and \"no\" stays put", q.asked.length === 1 && /thay đổi chưa lưu/.test(q.asked[0]) && q.$("camp-headline").value === "chưa lưu");
    q.close();

    // choose a picture, change the products, save
    const r = await page();
    const target = seeded[0];
    r.rowOf(target.id).click();
    await until(() => !r.$("camp-panel").hidden && r.$("camp-name").value === target.name);
    r.$("camp-image-choose").click();
    const options = () => [...r.d.querySelectorAll("#camp-image-grid button")].map((b) => b.dataset.path);
    check("picture chooser: opens and lists exactly the pictures offered", r.$("camp-image-dialog").hasAttribute("open") && JSON.stringify(options()) === JSON.stringify(opt.images));
    r.$("camp-image-search").value = "hoa";
    r.$("camp-image-search").dispatchEvent(new r.w.Event("input", { bubbles: true }));
    check("picture chooser: the search narrows it", JSON.stringify(options()) === JSON.stringify(["images/bo-hoa-hong.jpg"]), JSON.stringify(options()));
    r.$("camp-image-grid").querySelector("button").click();
    check("picture chooser: choosing one closes it and shows it in the form", !r.$("camp-image-dialog").hasAttribute("open") && r.$("camp-image-box").querySelector("img")?.getAttribute("src") === "images/bo-hoa-hong.jpg" && r.$("camp-image-clear").disabled === false);
    const ids = () => [...r.d.querySelectorAll("#camp-products li")].map((li) => Number(li.dataset.id));
    const startIds = ids();
    r.d.querySelector('#camp-products li:first-child [data-act="down"]').click();
    check("products: ▼ moves the first one down", ids()[1] === startIds[0] && ids()[0] === startIds[1]);
    r.d.querySelector('#camp-products li:nth-child(2) [data-act="up"]').click();
    check("products: ▲ moves it back", JSON.stringify(ids()) === JSON.stringify(startIds));
    r.d.querySelector('#camp-products li:last-child [data-act="remove"]').click();
    check("products: ✕ removes one", ids().length === startIds.length - 1 && r.$("camp-add-select").querySelectorAll("option").length > 1);
    const addable = [...r.$("camp-add-select").options].find((o) => o.value);
    check("products: the add list never offers a discontinued product or one already in the list", ![...r.$("camp-add-select").options].some((o) => o.value && (Number(o.value) === gone || ids().includes(Number(o.value)))));
    r.$("camp-add-select").value = addable.value;
    r.$("camp-add").click();
    check("products: choosing one and Thêm adds it at the end", ids().at(-1) === Number(addable.value));
    const finalIds = ids();
    r.type("camp-headline", "Tiêu đề lưu từ trang");
    r.d.getElementById("camp-form").requestSubmit();
    check("save: the notice says it is saved (and that the page now uses it, since it is on)", await until(() => !r.$("camp-notice").hidden && /Đã lưu/.test(r.$("camp-notice").textContent)) && /ngay/.test(r.$("camp-notice").textContent));
    const row = (await pool.query("SELECT headline, hero_image FROM campaigns WHERE id=$1", [target.id])).rows[0];
    const order = (await pool.query("SELECT product_id FROM campaign_products WHERE campaign_id=$1 ORDER BY sort_order", [target.id])).rows.map((x) => x.product_id);
    check("save: the database has the headline, the picture and the product order from the page", row.headline === "Tiêu đề lưu từ trang" && row.hero_image === "images/bo-hoa-hong.jpg" && JSON.stringify(order) === JSON.stringify(finalIds), JSON.stringify([row, order, finalIds]));
    check("save: the public landing page shows it", new JSDOM(await (await fetch(`${X}/landing`)).text()).window.document.querySelector("h1").textContent === "Tiêu đề lưu từ trang");
    r.$("camp-image-clear").click();
    check("picture: \"Bỏ ảnh\" clears it", r.$("camp-image-box").querySelector("img") === null && r.$("camp-image-clear").disabled === true);
    r.type("camp-name", "n".repeat(81));
    r.d.getElementById("camp-form").requestSubmit();
    check("save: a refusal is shown in words and saves nothing", await until(() => !r.$("camp-error").hidden && /Tên chiến dịch/.test(r.$("camp-error").textContent)) && (await pool.query("SELECT name FROM campaigns WHERE id=$1", [target.id])).rows[0].name === target.name);
    await call(M, "PATCH", `/${target.id}`, { headline: target.headline, hero_image: target.hero_image, product_ids: seededProducts.filter((x) => x.campaign_id === target.id).map((x) => x.product_id) });
    r.close();

    // create and delete from the page
    const s = await page();
    s.$("camp-new").click();
    check("new: a blank form opens, with no delete button and a row marked unsaved", !s.$("camp-panel").hidden && s.$("camp-name").value === "" && s.$("camp-delete").hidden && /chưa lưu/.test(s.$("camp-list").textContent));
    s.d.getElementById("camp-form").requestSubmit();
    await sleep(200);
    check("new: a blank name or headline cannot be submitted (the form's own check)", (await pool.query("SELECT COUNT(*) FROM campaigns WHERE name LIKE 'zz test từ trang%'")).rows[0].count === "0");
    const evil = `zz test từ trang <img src=x onerror=alert(1)> & "q"`;
    s.type("camp-name", evil);
    s.type("camp-headline", "Tiêu đề từ trang");
    s.d.getElementById("camp-form").requestSubmit();
    check("new: saving creates it, selects it and says so", await until(() => /Đã tạo/.test(s.$("camp-notice").textContent) && !s.$("camp-notice").hidden));
    const madeRow = (await pool.query("SELECT id, name FROM campaigns WHERE name LIKE 'zz test từ trang%'")).rows[0];
    if (madeRow) created.push(madeRow.id);
    check("new: it exists in the database with the exact text", madeRow?.name === evil);
    check("new: a hostile name is shown as plain text in the list and the heading (nothing injected)", !s.d.querySelector("img[onerror]") && s.$("camp-title").textContent === evil && [...s.d.querySelectorAll("#camp-list .admin-seo__row-name")].some((n) => n.textContent === evil));
    check("new: the delete button is now there and enabled (it is not the active campaign)", s.$("camp-delete").hidden === false && s.$("camp-delete").disabled === false);
    s.$("camp-delete").click();
    // the page hides the editor at once, then reloads the list: wait for the row to go (it is not instant)
    check("delete from the page: asks, then removes it from the list and the database", await until(() => s.$("camp-panel").hidden) && (await until(() => !s.rowOf(madeRow.id))) && (await pool.query("SELECT COUNT(*) FROM campaigns WHERE id=$1", [madeRow.id])).rows[0].count === "0" && s.asked.length >= 1);
    await sleep(300); // let the page finish what it was doing before its server goes away
    s.close();
  }
} finally {
  child.kill();
  await pool.query("UPDATE settings SET active_campaign_id=$1, vat_rate=$2", [original.active, original.vat]);
  if (created.length) await pool.query("DELETE FROM campaigns WHERE id = ANY($1)", [created]);
  await pool.query("DELETE FROM campaigns WHERE name LIKE 'zz test%'");
  for (const c of seeded) await pool.query("UPDATE campaigns SET name=$2, headline=$3, subheadline=$4, coupon_code=$5, hero_image=$6 WHERE id=$1", [c.id, c.name, c.headline, c.subheadline, c.coupon_code, c.hero_image]);
  for (const c of seeded) {
    await pool.query("DELETE FROM campaign_products WHERE campaign_id=$1", [c.id]);
    for (const r of seededProducts.filter((x) => x.campaign_id === c.id)) await pool.query("INSERT INTO campaign_products (campaign_id, product_id, sort_order) VALUES ($1,$2,$3)", [r.campaign_id, r.product_id, r.sort_order]);
  }
  for (const [pid, st] of productStatus) await pool.query("UPDATE products SET status=$1 WHERE id=$2", [st, pid]);
  for (const id of tempUsers) {
    await pool.query("DELETE FROM session WHERE sess::text LIKE $1", [`%"adminId":${id}%`]);
    await pool.query("DELETE FROM admin_users WHERE id = $1", [id]);
  }
  fs.rmSync(imagesDir, { recursive: true, force: true });
}
const now = (await pool.query("SELECT id, name, headline, subheadline, coupon_code, hero_image FROM campaigns ORDER BY id")).rows;
const nowProducts = (await pool.query("SELECT campaign_id, product_id, sort_order FROM campaign_products ORDER BY campaign_id, sort_order")).rows;
check("cleanup: the campaigns, their products and the active pointer are exactly as they were", JSON.stringify(now) === JSON.stringify(seeded) && JSON.stringify(nowProducts) === JSON.stringify(seededProducts) && (await pool.query("SELECT active_campaign_id, vat_rate FROM settings")).rows[0].active_campaign_id === original.active);
check("cleanup: test staff accounts removed", Number((await pool.query("SELECT COUNT(*) FROM admin_users WHERE username LIKE 'zz.test.%'")).rows[0].count) === 0);
await pool.end();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
