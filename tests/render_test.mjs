// Checks the page renderer (render.js, partials/): shared header/footer, {{tokens}}, caching, safety.
//
// Run from the repo root with the server already running on the same database:
//   BASE=http://127.0.0.1:3000 node tests/render_test.mjs
// Needs the same DB_* variables the server uses (default: the values in .env are NOT read here, so export
// DB_HOST DB_PORT DB_USER DB_NAME DB_PASSWORD if they differ from 127.0.0.1:5432 quaint/bloomy).
//
// It briefly changes the shop settings row to odd values and puts the original values back in a finally
// block. Run it against a local or test database, never production.
//
// What this proves: the 12 customer pages and "/" come out whole (no raw include comments, no leftover
// {{tokens}}), the header has the agreed links, the footer's category list matches the database (and leaves
// out empty categories), the About page links to Story and Commitment, the values match /api/settings, hostile
// values are escaped, caching works, admin pages and other files are left alone, the server still serves pages
// when the database is down, and it refuses to start without partials/.
// What it does NOT prove: that anything looks right in a browser, or that the Docker image contains
// partials/ (that is only known after a CI build).

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { JSDOM } from "jsdom";

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const ROOT = process.cwd();
const require = createRequire(path.join(ROOT, "package.json"));
const { Pool } = require("pg");

let passed = 0, failed = 0;
function check(name, cond, extra = "") {
  if (cond) passed++;
  else { failed++; console.log(`FAIL ${name}${extra ? " :: " + extra : ""}`); }
}
const get = (p, opts) => fetch(BASE + p, { redirect: "manual", ...opts });

const CUSTOMER_PAGES = ["/", "/index.html", "/products.html", "/product.html?id=1", "/cart.html", "/checkout.html",
  "/order-confirmation.html", "/about.html", "/story.html", "/commitment.html", "/custom-bouquet.html", "/terms.html", "/privacy.html"];

// The landing page exists only while a campaign is switched on (landing_test.mjs covers the on/off rules).
if ((await get("/api/campaigns/active")).status === 200) CUSTOMER_PAGES.push("/landing");

// The blog: its index and every post in content/posts.json (blog_test.mjs covers the blog itself).
CUSTOMER_PAGES.push("/blog", ...JSON.parse(fs.readFileSync(path.join(ROOT, "content", "posts.json"), "utf8")).map((p) => `/blog/${p.slug}`));

// Written independently of render.js on purpose.
const money = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "đ";
const phone = (d) => (/^\d{10}$/.test(d) ? `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}` : d);

const pool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1", port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || "quaint", database: process.env.DB_NAME || "bloomy", password: process.env.DB_PASSWORD || "dev",
});

function dom(html) { return new JSDOM(html).window.document; }
const links = (el) => [...el.querySelectorAll("a")].map((a) => a.getAttribute("href") + "|" + a.textContent.trim());

// Stop early if this script's database is not the server's database (a very easy mistake: the test and the
// server read DB_HOST/DB_PORT/DB_PASSWORD from their own shell). Everything below changes rows and expects the
// server to see the change.
{
  const row = (await pool.query("SELECT shop_address, contact_phone, contact_email, vat_rate FROM settings")).rows[0];
  const api = await (await get("/api/settings")).json();
  if (!row || row.shop_address !== api.shop_address || row.contact_phone !== api.contact_phone || row.contact_email !== api.contact_email || row.vat_rate !== api.vat_rate) {
    console.log("FAIL this script is connected to a different database than the server at " + BASE + " (settings differ). Export the same DB_HOST / DB_PORT / DB_PASSWORD as the server and run again.");
    process.exit(2);
  }
}

// ---------------------------------------------------------------- 1. every page is whole
const settings = await (await get("/api/settings")).json();
const tree = await (await get("/api/categories")).json(); // top-level categories that have something to buy
const HEADER_LINKS = [["Trang chủ", "index.html"], ["Sản phẩm", "products.html"], ["Hoa tự chọn", "custom-bouquet.html"], ["Về Bloomy", "about.html"], ["Blog", "blog"], ["Liên hệ", `https://zalo.me/${settings.contact_phone}`]];
const footerCategoryLinks = (d) => {
  const col = [...d.querySelectorAll(".site-footer__col")].find((c) => c.querySelector("h3")?.textContent.trim() === "Danh mục");
  return col ? [...col.querySelectorAll("li a")].map((a) => [a.getAttribute("href"), a.textContent.trim()]) : null;
};
for (const p of CUSTOMER_PAGES) {
  const r = await get(p);
  const html = await r.text();
  check(`${p} 200`, r.status === 200, String(r.status));
  check(`${p} html utf-8`, /^text\/html; charset=utf-8/i.test(r.headers.get("content-type") || ""), r.headers.get("content-type"));
  check(`${p} no raw include comment`, !html.includes("<!--include"));
  check(`${p} no leftover {{token}}`, !/\{\{/.test(html));
  check(`${p} no data-setting left`, !/data-setting/.test(html));
  const d = dom(html);
  check(`${p} one header`, d.querySelectorAll("header.site-nav").length === 1);
  check(`${p} one footer`, d.querySelectorAll("footer.site-footer").length === 1);
  check(`${p} one floating contact`, d.querySelectorAll(".floating-contact").length === 1);
  const desk = d.querySelector(".site-nav__links"), mob = d.querySelector(".site-nav__mobile-panel");
  const dl = links(desk), ml = links(mob).filter((x) => !x.startsWith("null|"));
  check(`${p} desktop and mobile nav links match`, JSON.stringify(dl) === JSON.stringify(ml), JSON.stringify([dl.length, ml.length]));
  check(`${p} header has the 6 agreed links in order`, JSON.stringify(dl) === JSON.stringify(HEADER_LINKS.map(([text, href]) => `${href}|${text}`)), JSON.stringify(dl));
  const fcl = footerCategoryLinks(d);
  check(`${p} footer lists the categories from the database`, JSON.stringify(fcl) === JSON.stringify(tree.map((c) => [`products.html?category=${c.id}`, c.name])), JSON.stringify(fcl));
  check(`${p} footer still links Story and Commitment`, !!d.querySelector('footer a[href="story.html"]') && !!d.querySelector('footer a[href="commitment.html"]'));
  check(`${p} header no longer links Story or Commitment`, !d.querySelector('header a[href="story.html"], header a[href="commitment.html"]'));
  // Real values, formatted
  const ft = d.querySelector(".site-footer__contact").textContent;
  check(`${p} footer phone`, ft.includes(phone(settings.contact_phone)), ft.replace(/\s+/g, " "));
  check(`${p} footer email`, ft.includes(settings.contact_email));
  check(`${p} footer address`, ft.includes(settings.shop_address));
  const lc = d.querySelector(".floating-contact");
  check(`${p} hotline link`, lc.querySelector(".floating-contact__hotline").getAttribute("href") === `tel:${settings.contact_phone}`);
  check(`${p} zalo link`, lc.querySelector(".floating-contact__zalo").getAttribute("href") === `https://zalo.me/${settings.contact_phone}`);
  // Only the shared blocks: a few pages have their own hidden/JS-filled href="#" (e.g. the product page's external-buy link).
  const shared = [...d.querySelectorAll("header.site-nav a, footer.site-footer a, .floating-contact a")];
  check(`${p} shared blocks have no empty or "#" link`, !shared.some((a) => ["", "#"].includes(a.getAttribute("href"))), "found a bare # or empty href");
}

// ---------------------------------------------------------------- 2. per-page values (terms/privacy/product/checkout)
{
  const t = dom(await (await get("/terms.html")).text()).body.textContent;
  check("terms shows fee range", t.includes(money(settings.min_fee)) && t.includes(money(settings.max_fee)));
  check("terms shows VAT", t.includes(String(settings.vat_rate)));
  const maps = dom(await (await get("/terms.html")).text()).querySelector(`a[href^="https://www.google.com/maps"]`);
  check("maps link built from address", maps && maps.getAttribute("href") === `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(settings.shop_address)}`);
}

// ---------------------------------------------------------------- 3. caching
{
  const r1 = await get("/about.html");
  const etag = r1.headers.get("etag");
  check("page has ETag", !!etag);
  check("page Cache-Control is no-cache", r1.headers.get("cache-control") === "no-cache", r1.headers.get("cache-control"));
  // node:http, not fetch: fetch adds "Cache-Control: no-cache" to a conditional request, and Express then (correctly) answers 200.
  const status = await new Promise((resolve, reject) => {
    const u = new URL(BASE + "/about.html");
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { "If-None-Match": etag } }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject);
  });
  check("unchanged page -> 304", status === 304, String(status));
  const h = await get("/about.html", { method: "HEAD" });
  check("HEAD 200 with no body", h.status === 200 && (await h.text()) === "");
  const hdr = await get("/");
  check("security headers still present on pages", !!hdr.headers.get("content-security-policy") && !!hdr.headers.get("x-content-type-options"));
}

// ---------------------------------------------------------------- 3b. asset fingerprints (css/x.css -> css/x.css?v=<8 hex of the file's sha1>)
// The server must be started from this same checkout: the hashes are computed here, from public/, independently of render.js.
{
  const seen = new Set(), unversioned = [], wrongHash = [];
  let count = 0;
  for (const p of CUSTOMER_PAGES) {
    const d = dom(await (await get(p)).text());
    const local = [...d.querySelectorAll("link[rel=stylesheet][href], script[src]")].map((e) => e.getAttribute("href") || e.getAttribute("src")).filter((u) => /^(css|js)\//.test(u));
    for (const u of local) {
      count++;
      const m = /^((?:css|js)\/[\w.-]+\.(?:css|js))\?v=([0-9a-f]{8})$/.exec(u);
      if (!m) { unversioned.push(`${p}: ${u}`); continue; }
      seen.add(u);
      const want = crypto.createHash("sha1").update(fs.readFileSync(path.join(ROOT, "public", m[1]))).digest("hex").slice(0, 8);
      if (m[2] !== want) wrongHash.push(`${p}: ${u} (file says ${want})`);
    }
  }
  check("fingerprints: the pages name css/ and js/ files (not a vacuous pass)", count >= CUSTOMER_PAGES.length * 2, String(count));
  check("every css/ and js/ address on every customer page ends in ?v=<8 hex>", unversioned.length === 0, unversioned.slice(0, 3).join(" | "));
  check("…and the 8 hex are the first 8 of the file's sha1", wrongHash.length === 0, wrongHash.slice(0, 3).join(" | "));
  const bad = [];
  for (const u of seen) {
    const r = await get(`/${u}`);
    const type = r.headers.get("content-type") || "";
    if (r.status !== 200 || !(u.startsWith("css/") ? /text\/css/ : /javascript/).test(type)) bad.push(`${u} -> ${r.status} ${type}`);
  }
  check("…and every versioned address is served (200, the right type)", bad.length === 0, bad.slice(0, 3).join(" | "));
}

// ---------------------------------------------------------------- 4. things the renderer must NOT touch
{
  const adminDisk = fs.readFileSync(path.join(ROOT, "public", "admin-login.html"), "utf8");
  const r = await get("/admin-login.html");
  check("admin page served byte-for-byte", (await r.text()) === adminDisk);
  check("admin page keeps X-Robots-Tag", /noindex/.test(r.headers.get("x-robots-tag") || ""));
  const css = await get("/css/style.css");
  check("css served as css", /text\/css/.test(css.headers.get("content-type") || ""));
  const js = await get("/js/main.js");
  const mainJs = await js.text();
  check("main.js no longer fills settings", !mainJs.includes("fillSettings") && !mainJs.includes("data-setting"));
  for (const p of ["/partials/header.html", "/partials/checkout-form.html", "/partials/", "/render.js", "/server.js", "/schema.sql", "/package.json", "/%2e%2e/server.js", "/..%2fserver.js"]) {
    const x = await get(p);
    check(`${p} not served`, x.status === 404 || x.status === 400 || x.status === 403, String(x.status));
  }
  const nope = await get("/nope.html");
  check("missing page -> 404 (not 500)", nope.status === 404, String(nope.status));
  const post = await get("/about.html", { method: "POST" });
  check("POST to a page is not rendered", post.status !== 200, String(post.status));
  const q = await get("/products.html?category=1&q=h%E1%BB%93ng");
  check("page with a query string renders", q.status === 200);
  const api = await get("/api/settings");
  const j = await api.json();
  check("/api/settings keeps its 6 fields", JSON.stringify(Object.keys(j).sort()) === JSON.stringify(["contact_email", "contact_phone", "max_fee", "min_fee", "shop_address", "vat_rate"]), Object.keys(j).join());
  check("/sitemap.xml still works", (await get("/sitemap.xml")).status === 200);
  check("/healthz still works", (await get("/healthz")).status === 200);
  // Every response says which build it came from (the tag when run from the image, "dev" otherwise).
  for (const p of ["/healthz", "/", "/css/style.css", "/api/does-not-exist"]) {
    const r = await get(p);
    check(`${p} carries X-Bloomy-Build`, !!r.headers.get("x-bloomy-build"), `${r.status}`);
  }
}

// ---------------------------------------------------------------- 4b. About cards, care text, homepage tiles, the checkout partials
{
  const co = dom(await (await get("/checkout.html")).text());
  const one = (sel) => co.querySelectorAll(sel).length === 1;
  check("checkout page: the shared form and summary are in, once", one("#checkout-form-view #checkout-form") && one("#checkout-summary-items") && one("#place-order-btn"));
  check("checkout page: the payment view is in, once, outside the form view", one("#payment-waiting") && !co.querySelector("#checkout-form-view #payment-waiting"));
  check("checkout page: the empty-cart guard stays on the page itself", one("#checkout-empty"));
  check("checkout page: still loads main.js then checkout.js", [...co.querySelectorAll("script[src]")].map((s) => s.getAttribute("src").replace(/\?v=[0-9a-f]{8}$/, "")).join() === "js/main.js,js/checkout.js");
  const about = dom(await (await get("/about.html")).text());
  const cards = [...about.querySelectorAll(".about-more a.about-more__card")].map((a) => a.getAttribute("href"));
  check("About page has the Story and Commitment cards", JSON.stringify(cards) === JSON.stringify(["story.html", "commitment.html"]), JSON.stringify(cards));
  const product = dom(await (await get("/product.html?id=9")).text());
  const care = [...product.querySelectorAll("#panel-care li")].map((li) => li.textContent);
  check("care tab has 6 points", care.length === 6, String(care.length));
  check("care tab keeps the 1–2 cm / 1–2 day facts and the 5-day line", care.join(" ").includes("1–2 cm") && care.join(" ").includes("1–2 ngày") && care.join(" ").includes("khoảng 5 ngày"));
  const commitment = dom(await (await get("/commitment.html")).text()).body.textContent;
  check("care tab and commitment page both say 5 days (no conflicting number)", commitment.includes("5 ngày") && !/\b(3|4|6|7|10) ngày\b/.test(care.join(" ")));
  // The homepage's category tiles are typed into index.html. Not fixed, but drift must not go unnoticed.
  const home = dom(await (await get("/")).text());
  const tiles = [...home.querySelectorAll("a.category-nav__item")].map((a) => [a.getAttribute("href"), a.textContent.replace(/\s+/g, " ").trim()]);
  const expected = tree.map((c) => [`products.html?category=${c.id}`, c.name]);
  check("homepage category tiles match the database categories", JSON.stringify(tiles) === JSON.stringify(expected), JSON.stringify(tiles));
}

// ---------------------------------------------------------------- 5. values change -> next request shows them; hostile text is escaped
{
  const before = (await pool.query("SELECT shop_address, contact_phone, contact_email, vat_rate, ring1_fee, ring2_fee, ring3_fee FROM settings")).rows[0];
  const evil = `"><script>alert(1)</script> & 'q' <b>`;
  try {
    await pool.query("UPDATE settings SET shop_address=$1, contact_phone=$2, contact_email=$3, vat_rate=$4, ring1_fee=$5, ring2_fee=$6, ring3_fee=$7",
      [evil, "09123456789", "a&b@x.vn", 8, 1000000, 5000, 123456]);
    const html = await (await get("/terms.html")).text();
    check("hostile address: no script element injected", !/<script>alert/.test(html) && !html.includes('"><script'));
    const d = dom(html);
    const ft = d.querySelector(".site-footer__contact").textContent;
    check("hostile address shown as plain text", ft.includes(evil));
    check("11-digit phone shown as typed", ft.includes("09123456789") && !ft.includes("0912 345 6789"));
    check("fee range formatted (min 5.000đ, max 1.000.000đ)", d.body.textContent.includes("5.000đ") && d.body.textContent.includes("1.000.000đ"));
    check("VAT updated", d.body.textContent.includes("8"));
    const maps = d.querySelector(`a[href^="https://www.google.com/maps"]`).getAttribute("href");
    check("maps link URL-encodes the address", maps === `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(evil)}`);
    check("email ampersand escaped in HTML", html.includes("a&amp;b@x.vn"));
  } finally {
    await pool.query("UPDATE settings SET shop_address=$1, contact_phone=$2, contact_email=$3, vat_rate=$4, ring1_fee=$5, ring2_fee=$6, ring3_fee=$7",
      [before.shop_address, before.contact_phone, before.contact_email, before.vat_rate, before.ring1_fee, before.ring2_fee, before.ring3_fee]);
  }
  const back = (await pool.query("SELECT shop_address, contact_phone FROM settings")).rows[0];
  check("settings restored", back.shop_address === before.shop_address && back.contact_phone === before.contact_phone);
}

// ---------------------------------------------------------------- 5b. footer categories follow the database
{
  const first = (await pool.query("SELECT id, name FROM categories WHERE parent_id IS NULL ORDER BY id LIMIT 1")).rows[0];
  const evilName = `<img src=x onerror=alert(1)> & "q" 'x'`;
  try {
    await pool.query("UPDATE categories SET name=$1 WHERE id=$2", [evilName, first.id]);
    await pool.query("INSERT INTO categories (id, name) VALUES (9999, 'Danh mục rỗng thử nghiệm')"); // explicit id: the sequence is untouched
    const html = await (await get("/about.html")).text();
    const links = footerCategoryLinks(dom(html));
    check("hostile category name: no element injected", !/<img src=x/.test(html));
    check("hostile category name shown as plain text", links.some(([, t]) => t === evilName));
    check("a category with nothing to buy is left out of the footer", !html.includes("Danh mục rỗng thử nghiệm"));
    const apiNow = await (await get("/api/categories")).json();
    check("…and out of /api/categories too (same rule)", !apiNow.some((c) => c.id === 9999));
  } finally {
    await pool.query("DELETE FROM categories WHERE id=9999");
    await pool.query("UPDATE categories SET name=$1 WHERE id=$2", [first.name, first.id]);
  }
  const back = (await pool.query("SELECT name FROM categories WHERE id=$1", [first.id])).rows[0];
  check("category restored", back.name === first.name);
}

// ---------------------------------------------------------------- 6. a second server: database down, and partials/ missing
function serverEnv(port, extra = {}) {
  return { ...process.env, PORT: String(port), SESSION_SECRET: process.env.SESSION_SECRET || "x", BLOOMY_BASE_URL: process.env.BLOOMY_BASE_URL || "http://localhost",
    ZALOPAY_ENDPOINT: process.env.ZALOPAY_ENDPOINT || "https://sb-openapi.zalopay.vn", ZALOPAY_APP_ID: process.env.ZALOPAY_APP_ID || "1", ZALOPAY_KEY1: process.env.ZALOPAY_KEY1 || "a", ZALOPAY_KEY2: process.env.ZALOPAY_KEY2 || "b",
    DB_PASSWORD: process.env.DB_PASSWORD || "dev", EMAIL_MODE: "log", ...extra };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
{
  const port = 39701;
  const child = spawn("node", ["server.js"], { cwd: ROOT, env: serverEnv(port, { DB_PORT: "1" }), stdio: "ignore" });
  try {
    let up = false;
    for (let i = 0; i < 30 && !up; i++) { await sleep(300); try { up = (await fetch(`http://127.0.0.1:${port}/css/style.css`)).ok; } catch {} }
    check("server with unreachable DB still starts", up);
    const r = await fetch(`http://127.0.0.1:${port}/`);
    const html = await r.text();
    check("DB down: page still 200", r.status === 200, String(r.status));
    const d = dom(html);
    check("DB down: footer values empty, not 'undefined'", !/undefined|null/.test(d.querySelector(".site-footer__contact").textContent));
    const bad = [...d.querySelectorAll("a")].filter((a) => ["", null].includes(a.getAttribute("href")));
    check("DB down: no link with an empty href", bad.length === 0);
    check("DB down: Zalo/hotline links fall back to #", d.querySelector(".floating-contact__zalo").getAttribute("href") === "#" && d.querySelector(".floating-contact__hotline").getAttribute("href") === "#");
    check("DB down: footer category list is empty (no broken links)", JSON.stringify(footerCategoryLinks(d)) === "[]", JSON.stringify(footerCategoryLinks(d)));
    check("DB down: API says 500, not a fake 200", (await fetch(`http://127.0.0.1:${port}/api/settings`)).status === 500);
  } finally { child.kill(); }
}
{
  // a copy of the app WITHOUT partials/ must refuse to start with a clear message
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bloomy-nopartials-"));
  for (const f of ["server.js", "render.js", "blog.js", "seo.js", "totp.js", "db.js", "email.js", "pricing.js", "create-admin.js", "package.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
  fs.cpSync(path.join(ROOT, "routes"), path.join(tmp, "routes"), { recursive: true });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(tmp, "node_modules"));
  let err = "", code = null;
  const child = spawn("node", ["server.js"], { cwd: tmp, env: serverEnv(39702), stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (b) => (err += b));
  code = await new Promise((resolve) => { const t = setTimeout(() => { child.kill(); resolve("still running"); }, 8000); child.on("exit", (c) => { clearTimeout(t); resolve(c); }); });
  check("no partials/ -> server exits at startup", code !== "still running" && code !== 0, String(code));
  check("no partials/ -> message names the missing partial", /partial not found/.test(err), err.split("\n").find((l) => /partial/.test(l)) || err.slice(0, 120));
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 7. startup checks of BLOOMY_BASE_URL and ZALOPAY_ENDPOINT
// Both are joined with a path (/api/orders/ipn, /v2/create): a trailing slash makes the ZaloPay callback "//api/orders/ipn" (a 404 here) and a wrong
// ZaloPay address fails every ZaloPay checkout. A value that cannot be used must stop the server at start, say which variable and why, and never
// print the value (it could carry a password).
{
  let nextPort = 39710;
  // Start a server with these variables (undefined removes one), wait until it exits or answers, stop it, return what happened.
  const start = (vars) => new Promise((resolve) => {
    const env = { ...serverEnv(nextPort++, { DB_PORT: "1" }), ...vars };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const port = env.PORT;
    const child = spawn("node", ["server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", done = false;
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (out += b));
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); clearInterval(poll); child.kill(); resolve({ ...r, out }); };
    const timer = setTimeout(() => finish({ code: "timeout", up: false }), 8000);
    child.on("exit", (code) => finish({ code, up: false }));
    const poll = setInterval(async () => { try { if ((await fetch(`http://127.0.0.1:${port}/css/style.css`)).ok) finish({ code: null, up: true }); } catch {} }, 200);
  });
  const GOOD_ZP = "https://sb-openapi.zalopay.vn", GOOD_BASE = "https://shop.example";
  const refuses = [
    ["ZALOPAY_ENDPOINT missing", { ZALOPAY_ENDPOINT: undefined }, /missing required environment variables: ZALOPAY_ENDPOINT/, null],
    ["ZALOPAY_ENDPOINT with a trailing slash", { ZALOPAY_ENDPOINT: GOOD_ZP + "/" }, /ZALOPAY_ENDPOINT must have no path and no trailing slash/, GOOD_ZP + "/"],
    ["ZALOPAY_ENDPOINT with a path", { ZALOPAY_ENDPOINT: GOOD_ZP + "/v2" }, /ZALOPAY_ENDPOINT must have no path/, "/v2"],
    ["ZALOPAY_ENDPOINT over plain http", { ZALOPAY_ENDPOINT: "http://sb-openapi.zalopay.vn" }, /ZALOPAY_ENDPOINT must start with https/, "http://sb-openapi"],
    ["ZALOPAY_ENDPOINT without a scheme", { ZALOPAY_ENDPOINT: "sb-openapi.zalopay.vn" }, /ZALOPAY_ENDPOINT is not an absolute URL/, "sb-openapi.zalopay"],
    ["BLOOMY_BASE_URL with a trailing slash", { BLOOMY_BASE_URL: GOOD_BASE + "/" }, /BLOOMY_BASE_URL must have no path and no trailing slash/, GOOD_BASE + "/"],
    ["BLOOMY_BASE_URL with a path", { BLOOMY_BASE_URL: GOOD_BASE + "/shop" }, /BLOOMY_BASE_URL must have no path/, "/shop"],
    ["BLOOMY_BASE_URL over plain http (not localhost)", { BLOOMY_BASE_URL: "http://shop.example" }, /BLOOMY_BASE_URL must start with https/, "http://shop.example"],
    ["BLOOMY_BASE_URL with credentials", { BLOOMY_BASE_URL: "https://admin:hunter2@shop.example" }, /BLOOMY_BASE_URL must not contain a user name or password/, "hunter2"],
    ["BLOOMY_BASE_URL with a query", { BLOOMY_BASE_URL: GOOD_BASE + "?a=1" }, /BLOOMY_BASE_URL must not contain a query/, "a=1"],
    ["BLOOMY_BASE_URL with a space", { BLOOMY_BASE_URL: GOOD_BASE + " " }, /BLOOMY_BASE_URL must not contain spaces/, null],
  ];
  for (const [name, vars, message, secret] of refuses) {
    const r = await start({ ZALOPAY_ENDPOINT: GOOD_ZP, BLOOMY_BASE_URL: GOOD_BASE, ...vars });
    check(`${name}: the server exits with code 1`, r.code === 1, String(r.code));
    check(`${name}: the message names the variable and the reason`, message.test(r.out), r.out.split("\n").find((l) => /Bloomy:/.test(l)) || r.out.slice(0, 120));
    if (secret) check(`${name}: the value is not printed`, !r.out.includes(secret), r.out.slice(0, 120));
  }
  const accepts = [
    ["https base and https ZaloPay endpoint", { ZALOPAY_ENDPOINT: GOOD_ZP, BLOOMY_BASE_URL: GOOD_BASE }],
    ["http://localhost:3000 as the base (development, CI)", { ZALOPAY_ENDPOINT: GOOD_ZP, BLOOMY_BASE_URL: "http://localhost:3000" }],
    ["http://127.0.0.1:3000 as the base", { ZALOPAY_ENDPOINT: GOOD_ZP, BLOOMY_BASE_URL: "http://127.0.0.1:3000" }],
  ];
  for (const [name, vars] of accepts) {
    const r = await start(vars);
    check(`${name}: the server starts`, r.up, `${r.code} ${r.out.slice(0, 100)}`);
    check(`${name}: logs the ZaloPay host`, /Bloomy: ZaloPay endpoint host: sb-openapi\.zalopay\.vn/.test(r.out), r.out.slice(0, 100));
  }
}

await pool.end();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
