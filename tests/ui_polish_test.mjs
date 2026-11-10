// The quality-of-life changes, checked as far as a DOM can:
//   A. the stylesheet rules (nothing to run: the CSS files are read)
//        - the motion block is scoped to customer pages, short, and does not override reduced-motion
//        - the category filter bar is see-through like the header, its underline is 3px
//   B. the cart badge pops only when the count goes UP; the add buttons pop (product page, landing page)
//   C. the admin menu: one button naming the page you are on, a panel with the right links for each role,
//      Escape and a click elsewhere close it
//   D. the POS pickup list: closed by default, the number shows on the button, opening shows the orders,
//      "Đã nhận" removes one, the old list at the bottom of the page is gone
//
// Run from the repo root with the server running on the same database:
//   export DB_HOST=127.0.0.1 DB_PORT=5433 DB_PASSWORD=dev
//   BASE=http://localhost:3000 node tests/ui_polish_test.mjs
//
// Part D places one real pickup order (cash) and removes it afterwards, restoring the flower stock; the test also
// creates three staff accounts named zz.test.* (owner, manager, employee) and deletes them. EMAIL_MODE=log only,
// never production. Rate limits apply (about twice in 15 minutes for the whole suite).
//
// Does NOT prove: how any of it looks or feels, that the animations run, or what a real browser's reduced-motion
// setting does (the rule is checked in the stylesheet, not in a browser).

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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
function check(name, cond, extra = "") { if (cond) passed++; else { failed++; console.log(`FAIL ${name}${extra ? " :: " + extra : ""}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000, step = 40) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(step); } return false; }
const noCss = requestInterceptor(async (request) => (/\.css(\?|$)/.test(request.url) ? new Response("", { headers: { "Content-Type": "text/css" } }) : undefined));
const css = (f) => fs.readFileSync(path.join(ROOT, "public", "css", f), "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

// ============================================================ A. the stylesheets
{
  const style = css("style.css");
  const marker = "==== Motion (customer pages only)";
  check("style.css has the motion block", style.includes(marker));
  const block = stripComments(style.slice(style.lastIndexOf("/*", style.indexOf(marker))));
  // top-level rules of the block: "selector { ... }", with @keyframes / @media bodies kept whole
  const rules = [];
  let depth = 0, start = 0;
  for (let i = 0; i < block.length; i++) {
    if (block[i] === "{") depth++;
    if (block[i] === "}") { depth--; if (depth === 0) { rules.push(block.slice(start, i + 1).trim()); start = i + 1; } }
  }
  const SCOPE = "body:not([data-min-role]):not(.admin-login-page)";
  const plain = rules.filter((r) => !r.startsWith("@"));
  const offScope = plain.filter((r) => !r.startsWith(SCOPE) && !r.startsWith("html")).map((r) => r.slice(0, 60));
  check("every motion rule is scoped to customer pages (admin and login pages stay plain)", plain.length > 15 && offScope.length === 0, offScope.join(" | "));
  const unscopedHtml = plain.filter((r) => r.startsWith("html")).filter((r) => /animation|transition/.test(r));
  check("the only unscoped rules are the sticky-header scroll padding, nothing that animates", unscopedHtml.length === 0);
  const keyframes = rules.filter((r) => r.startsWith("@keyframes")).length;
  check("three keyframes (rise, pop, badge)", keyframes === 3, String(keyframes));
  const secs = [...block.matchAll(/(?:animation|transition)(?:-duration)?:[^;]*?(\d*\.?\d+)(ms|s)\b/g)].map((m) => (m[2] === "ms" ? Number(m[1]) / 1000 : Number(m[1])));
  check("every duration in the motion block is half a second or less", secs.length >= 6 && secs.every((s) => s <= 0.5), JSON.stringify(secs));
  check("cards rise from 40% opacity, never from 0 (an element at opacity 0 delays the page's Largest Contentful Paint)", /@keyframes bloomy-rise\s*\{\s*from\s*\{[^}]*opacity:\s*0\.4/.test(block) && !/@keyframes bloomy-rise\s*\{\s*from\s*\{[^}]*opacity:\s*0[;\s]/.test(block));
  const reduced = style.slice(0, style.indexOf(marker));
  check("the site-wide reduced-motion rule is still there and still zeroes every animation and transition", /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?animation-duration:\s*0\.01ms !important[\s\S]*?transition-duration:\s*0\.01ms !important/.test(reduced));
  check("smooth scrolling is inside the no-preference media query (it must not override reduced-motion)", /@media \(prefers-reduced-motion: no-preference\)\s*\{\s*html\s*\{\s*scroll-behavior:\s*smooth/.test(block) && (block.match(/scroll-behavior:\s*smooth/g) || []).length === 1);
  // the scope prefix matches a customer <body> and neither admin kind
  const probe = (bodyAttrs) => new JSDOM(`<!DOCTYPE html><body ${bodyAttrs}><button class="btn"></button></body>`).window.document.querySelectorAll(`${SCOPE} .btn`).length;
  check("the scope matches customer pages and misses both admin page kinds", probe("") === 1 && probe('class="defer-footer"') === 1 && probe('data-min-role="manager"') === 0 && probe('class="admin-login-page"') === 0);

  // ---- the hidden attribute must win, always (this broke the admin menu: its rule lost to a later display rule)
  const clean = stripComments(style);
  check("style.css has a global [hidden] rule that wins over any display (an author display otherwise beats the browser's own)", /(^|\})\s*\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/.test(clean));
  const admin = stripComments(css("admin.css"));
  const gridAt = admin.indexOf(".admin-nav__links.is-collapsible {");
  const hiddenAt = admin.indexOf(".admin-nav__links.is-collapsible[hidden]");
  check("admin.css: the menu panel's own hidden rule comes AFTER its grid rule (equal specificity: the later one wins)", gridAt > 0 && hiddenAt > gridAt, `${gridAt} / ${hiddenAt}`);
  check("no second scroll offset on the page (the site already has [id] { scroll-margin-top }, a scroll-padding on top of it doubles the gap)", /\[id\]\s*\{\s*scroll-margin-top/.test(clean) && !/scroll-padding-top/.test(clean));
  // ---- .admin-form__hint is absolutely positioned: only valid inside .admin-form__field
  const adminHtml = fs.readdirSync(path.join(ROOT, "public")).filter((f) => /^admin-.*\.html$/.test(f));
  const strays = [];
  for (const f of adminHtml) {
    const doc = new JSDOM(fs.readFileSync(path.join(ROOT, "public", f), "utf8")).window.document;
    doc.querySelectorAll(".admin-form__hint").forEach((n) => { if (!n.closest(".admin-form__field")) strays.push(`${f}: ${n.id || n.textContent.slice(0, 30)}`); });
  }
  check("no admin page uses .admin-form__hint outside an .admin-form__field (it would land at the page's left edge)", strays.length === 0, strays.join(" | "));
  const seoDoc = new JSDOM(fs.readFileSync(path.join(ROOT, "public", "admin-seo.html"), "utf8")).window.document;
  const note = seoDoc.getElementById("seo-robots-note");
  check("SEO page: the noindex heads-up sits right under the product's name, as a note in the normal flow", !!note && note.classList.contains("admin-note") && note.previousElementSibling?.id === "seo-product-name");
  check(".admin-note is in the normal flow (no absolute positioning)", /\.admin-note\s*\{[^}]*\}/.test(admin) && !/\.admin-note\s*\{[^}]*position:\s*(absolute|fixed)/.test(admin));

  const listing = stripComments(css("listing.css"));
  const rule = (sel) => (listing.match(new RegExp(`(?:^|\\})\\s*${sel.replace(/[.\[\]()]/g, "\\$&")}\\s*\\{([^}]*)\\}`)) || [])[1] || "";
  const bar = rule(".listing-filters");
  check("the category bar is see-through and blurred like the header (80% background, backdrop blur)", /background-color:\s*hsl\(var\(--background\)\s*\/\s*0\.8\)/.test(bar) && /backdrop-filter:\s*blur\(12px\)/.test(bar) && /-webkit-backdrop-filter:\s*blur\(12px\)/.test(bar), bar.replace(/\s+/g, " "));
  const header = stripComments(style).match(/\.site-nav\s*\{([^}]*)\}/)[1];
  check("…using the same alpha and blur as the header, so they read as one glass", header.includes("hsl(var(--background) / 0.8)") && header.includes("blur(12px)"));
  const pill = rule(".pill");
  check("the tab underline is 3px (was 2px)", /border-bottom:\s*3px solid transparent/.test(pill), pill.replace(/\s+/g, " "));
  check("…the active tab's underline is still the brand colour", /\.pill\.is-active[^{]*\{[^}]*border-bottom-color:\s*hsl\(var\(--primary\)\)/.test(listing));
  check("…and the bar keeps its height (one pixel less padding below)", /padding:\s*16px 2px 13px/.test(pill));
}

// ---- log in the test staff
const tempUsers = [];
const hash = await bcrypt.hash("zz-test-password-1", 10);
for (const [name, role] of [["zz.test.owner", "owner"], ["zz.test.manager", "manager"], ["zz.test.employee", "employee"]]) {
  tempUsers.push((await pool.query("INSERT INTO admin_users (username, password, role) VALUES ($1, $2, $3) RETURNING id", [name, hash, role])).rows[0].id);
}
async function login(username) {
  const r = await fetch(`${BASE}/api/admin/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: "zz-test-password-1" }) });
  return { status: r.status, cookie: (r.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ") };
}

const before = {
  funnelMax: (await pool.query("SELECT COALESCE(MAX(id),0) AS m FROM funnel_events")).rows[0].m,
  availMax: (await pool.query("SELECT COALESCE(MAX(id),0) AS m FROM availability_checks")).rows[0].m,
  orderMax: (await pool.query("SELECT COALESCE(MAX(id),0) AS m FROM orders")).rows[0].m,
  stock: new Map((await pool.query("SELECT id, stock FROM flowers")).rows.map((r) => [r.id, r.stock])),
};
const orderTokens = [];

try {
  const who = { owner: await login("zz.test.owner"), manager: await login("zz.test.manager"), employee: await login("zz.test.employee") };
  check("test owner, manager and employee can log in", Object.values(who).every((w) => w.status === 200));

  // ============================================================ B. the badge and the add buttons
  {
    const page = await (await fetch(`${BASE}/`)).text();
    const mainJs = await (await fetch(`${BASE}/js/main.js`)).text();
    const open = (cart) => {
      const dom = new JSDOM(page, { url: `${BASE}/`, runScripts: "outside-only", pretendToBeVisual: true });
      const w = dom.window;
      w.localStorage.setItem("bloomy_cart_v2", JSON.stringify(cart));
      w.eval(mainJs);
      w.updateCartBadge(); // what the page's own start-up does
      return w;
    };
    const line = (id, size, quantity) => ({ productId: id, size, name: "x", image: "images/x.webp", quantity });
    const w = open([line(9, "m", 2)]);
    const badges = () => [...w.document.querySelectorAll("[data-cart-count]")];
    check("a page that loads with items already in the cart does NOT pop the badge", badges().length >= 1 && badges().every((b) => b.textContent === "2" && !b.classList.contains("is-bumped")));
    w.Bloomy.cart.addItem({ id: 9, name: "x", image: "images/x.webp" }, "m", 1);
    check("adding an item makes the badge pop", badges().every((b) => b.textContent === "3" && b.classList.contains("is-bumped")));
    badges().forEach((b) => b.dispatchEvent(new w.Event("animationend", { bubbles: true })));
    check("when the animation ends the class is taken off again", badges().every((b) => !b.classList.contains("is-bumped")));
    w.Bloomy.cart.updateQuantity(9, "m", 1);
    check("a count that goes DOWN does not pop", badges().every((b) => b.textContent === "1" && !b.classList.contains("is-bumped")));
    w.Bloomy.cart.addItem({ id: 9, name: "x", image: "images/x.webp" }, "m", 1);
    check("adding again pops again", badges().every((b) => b.classList.contains("is-bumped")));
    w.Bloomy.cart.addItem({ id: 9, name: "x", image: "images/x.webp" }, "m", 1);
    check("…and a second add while it is still popping keeps it popping", badges().every((b) => b.classList.contains("is-bumped") && b.textContent === "3"));
    w.close();
  }
  {
    // the product page's add button
    const html = await (await fetch(`${BASE}/product.html?id=9`)).text();
    const dom = new JSDOM(html, { url: `${BASE}/product.html?id=9`, runScripts: "dangerously", resources: { interceptors: [noCss] }, pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
      beforeParse(w) { w.fetch = (u, o) => fetch(new URL(u, `${BASE}/product.html?id=9`), o); } });
    const d = dom.window.document;
    await until(() => d.querySelector('script[type="application/ld+json"]'));
    const btn = d.getElementById("add-to-cart");
    btn.click();
    check("product page: Thêm vào giỏ → the button says \"Đã thêm ✓\" and pops", d.getElementById("add-to-cart-label").textContent === "Đã thêm ✓" && btn.classList.contains("is-added"));
    btn.dispatchEvent(new dom.window.Event("animationend"));
    check("…the pop class comes off when the animation ends, the label stays a moment", !btn.classList.contains("is-added") && d.getElementById("add-to-cart-label").textContent === "Đã thêm ✓");
    btn.click();
    check("…and clicking again pops again", btn.classList.contains("is-added"));
    check("…and the header badge popped too", [...d.querySelectorAll("[data-cart-count]")].every((b) => b.classList.contains("is-bumped")));
    dom.window.close();
  }
  {
    // the landing page's add buttons
    const r = await fetch(`${BASE}/landing`, { redirect: "manual" });
    if (r.status === 200) {
      const dom = new JSDOM(await r.text(), { url: `${BASE}/landing`, runScripts: "dangerously", resources: { interceptors: [noCss] }, pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
        beforeParse(w) { w.scrollTo = () => {}; w.fetch = (u, o) => fetch(new URL(u, `${BASE}/landing`), o); } });
      const d = dom.window.document;
      await until(() => d.querySelectorAll(".landing-card__add").length > 0);
      const add = d.querySelector(".landing-card__add");
      add.click();
      check("landing page: the add button pops, and the card confirms", add.classList.contains("is-added") && !d.querySelector(".landing-card__added").hidden);
      dom.window.close();
    }
  }

  // ============================================================ C. the admin menu
  const EXPECTED = {
    employee: { page: "admin-pos.html", label: "Menu", links: ["admin-pos.html", "admin-account.html"] },
    manager: { page: "admin-seo.html", label: "Menu", links: ["admin-pos.html", "admin-products.html", "admin-seo.html", "admin-campaigns.html", "admin-flowers.html", "admin-orders.html", "admin-coupons.html", "admin-reviews.html", "admin-stats.html", "admin-cutoffs.html", "admin-account.html"] },
    owner: { page: "admin-settings.html", label: "Menu", links: ["admin-pos.html", "admin-products.html", "admin-seo.html", "admin-campaigns.html", "admin-flowers.html", "admin-orders.html", "admin-coupons.html", "admin-reviews.html", "admin-stats.html", "admin-cutoffs.html", "admin-settings.html", "admin-users.html", "admin-account.html"] },
  };
  async function openAdmin(role, page) {
    const html = await (await fetch(`${BASE}/${page}`)).text();
    const dom = new JSDOM(html, { url: `${BASE}/${page}`, runScripts: "dangerously", resources: { interceptors: [noCss] }, pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
      beforeParse(w) { w.fetch = (u, o = {}) => fetch(new URL(u, `${BASE}/${page}`), { ...o, headers: { ...(o.headers || {}), Cookie: who[role].cookie } }); } });
    const d = dom.window.document;
    await until(() => d.querySelector(".admin-nav__menu"));
    return { dom, w: dom.window, d };
  }
  for (const role of ["employee", "manager", "owner"]) {
    const exp = EXPECTED[role];
    const { dom, w, d } = await openAdmin(role, exp.page);
    const btn = d.querySelector(".admin-nav__menu"), panel = d.getElementById("admin-nav-links");
    check(`${role}: one menu button that just says "${exp.label}", closed at first`, !!btn && btn.textContent.trim() === exp.label && btn.getAttribute("aria-expanded") === "false" && panel.hidden === true && btn.getAttribute("aria-controls") === "admin-nav-links");
    check(`${role}: the button comes before the links in the page (so Tab reaches it first)`, !!(btn.compareDocumentPosition(panel) & w.Node.DOCUMENT_POSITION_FOLLOWING));
    btn.click();
    check(`${role}: clicking opens the panel and says so (aria-expanded)`, panel.hidden === false && btn.getAttribute("aria-expanded") === "true");
    const hrefs = [...panel.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    check(`${role}: the panel has exactly the links this role may open, in order`, JSON.stringify(hrefs) === JSON.stringify(exp.links), JSON.stringify(hrefs));
    const cur = panel.querySelector('a[aria-current="page"]');
    check(`${role}: the current page is marked (aria-current and is-active)`, !!cur && cur.getAttribute("href") === exp.page && cur.classList.contains("is-active") && panel.querySelectorAll('a[aria-current="page"]').length === 1);
    check(`${role}: the name and the logout button are still in the header`, !!d.querySelector(".admin-nav__who") && !!d.getElementById("admin-logout"));
    d.body.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    check(`${role}: a click elsewhere closes it`, panel.hidden === true && btn.getAttribute("aria-expanded") === "false");
    btn.click();
    panel.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    check(`${role}: a click inside the panel (not on a link) leaves it open`, panel.hidden === false);
    d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    check(`${role}: Escape closes it and puts focus back on the button`, panel.hidden === true && d.activeElement === btn);
    btn.click(); btn.click();
    check(`${role}: the button toggles (open, then closed)`, panel.hidden === true);
    dom.window.close();
  }
  {
    const adminPages = fs.readdirSync(path.join(ROOT, "public")).filter((f) => /^admin-.*\.html$/.test(f) && f !== "admin-login.html");
    const without = adminPages.filter((f) => !fs.readFileSync(path.join(ROOT, "public", f), "utf8").includes('id="admin-nav-links"'));
    check("every admin page (but the login) still has the header the menu builds on", adminPages.length === 13 && without.length === 0, without.join(", "));
  }

  // ============================================================ D. the POS pickup list
  {
    const deliveryDate = new Date(Date.now() + 7 * 3600e3 + 3 * 86400e3).toISOString().slice(0, 10);
    const place = async () => {
      const res = await fetch(`${BASE}/api/orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        items: [{ productId: 9, size: "m", quantity: 1 }], fulfillment_type: "pickup", delivery_date: deliveryDate, delivery_window: "morning", payment_method: "cash", consent: true,
        sender_name: "Kiểm thử Người gửi", sender_phone: "0912345678", recipient_name: "Kiểm thử POS", recipient_phone: "0987654321", session_id: `test-${crypto.randomUUID()}` }) });
      const data = await res.json();
      if (data.token) orderTokens.push(data.token);
      return { status: res.status, token: data.token };
    };
    const open = async () => {
      const calls = [];
      const html = await (await fetch(`${BASE}/admin-pos.html`)).text();
      const dom = new JSDOM(html, { url: `${BASE}/admin-pos.html`, runScripts: "dangerously", resources: { interceptors: [noCss] }, pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
        beforeParse(w) { w.fetch = (u, o = {}) => { const url = new URL(u, `${BASE}/admin-pos.html`); calls.push(`${o.method || "GET"} ${url.pathname}`); return fetch(url, { ...o, headers: { ...(o.headers || {}), Cookie: who.employee.cookie } }); }; } });
      const d = dom.window.document;
      await until(() => d.getElementById("pos-products").children.length > 0);
      await sleep(300);
      return { dom, d, calls };
    };
    const pending = async () => Number((await pool.query("SELECT COUNT(*) FROM orders WHERE channel='web' AND fulfillment_type='pickup' AND fulfillment_status='new'")).rows[0].count);
    const startPending = await pending();

    const none = await open();
    const T = none.d.getElementById("pos-pickups-toggle");
    check("POS: the pickup list is a toggle in the page header, closed by default", !!T && T.closest(".admin-page__header") !== null && T.getAttribute("aria-expanded") === "false" && none.d.getElementById("pos-pickups").hidden === true);
    check("POS: the old list at the bottom of the page is gone (the section now comes BEFORE the sale)", !!(none.d.getElementById("pos-pickups").compareDocumentPosition(none.d.getElementById("pos-layout")) & none.dom.window.Node.DOCUMENT_POSITION_FOLLOWING) && none.d.querySelectorAll("#pos-pickups-body").length === 1);
    if (startPending === 0) check("POS: with nothing waiting the number is not shown", none.d.getElementById("pos-pickups-count").hidden === true);
    none.dom.window.close();

    const made = await place();
    check("a web pickup order (cash) was placed for the test", made.status === 201 && !!made.token, JSON.stringify(made));
    const p = await open();
    const count = p.d.getElementById("pos-pickups-count");
    const n = await pending();
    check("POS: the waiting number shows on the button although the list is closed", count.hidden === false && count.textContent === String(n) && p.d.getElementById("pos-pickups").hidden === true, `${count.textContent} vs ${n}`);
    const getsBefore = p.calls.filter((c) => c === "GET /api/admin/pos/pickups").length;
    p.d.getElementById("pos-pickups-toggle").click();
    check("POS: clicking opens the list (aria-expanded) and reloads it", p.d.getElementById("pos-pickups").hidden === false && p.d.getElementById("pos-pickups-toggle").getAttribute("aria-expanded") === "true" && (await until(() => p.calls.filter((c) => c === "GET /api/admin/pos/pickups").length > getsBefore)));
    const rowOf = () => [...p.d.querySelectorAll("#pos-pickups-body tr")].find((tr) => tr.textContent.includes("Kiểm thử POS"));
    check("POS: the order is in the list, with its handover button", await until(() => !!rowOf()) && !!rowOf().querySelector("button[data-id]"));
    p.d.getElementById("pos-pickups-toggle").click();
    check("POS: clicking again closes it, and the number stays", p.d.getElementById("pos-pickups").hidden === true && p.d.getElementById("pos-pickups-count").hidden === false);
    p.d.getElementById("pos-pickups-toggle").click();
    await until(() => !!rowOf());
    rowOf().querySelector("button[data-id]").click();
    check("POS: \"Đã nhận\" hands it over: the row goes, and the number comes down", await until(() => !rowOf()) && (await until(() => (p.d.getElementById("pos-pickups-count").hidden ? 0 : Number(p.d.getElementById("pos-pickups-count").textContent)) === startPending)));
    check("POS: the order is marked delivered in the database", (await pool.query("SELECT fulfillment_status FROM orders WHERE token=$1", [made.token])).rows[0].fulfillment_status === "delivered");
    p.dom.window.close();
  }
} finally {
  if (orderTokens.length) await pool.query("DELETE FROM orders WHERE token = ANY($1)", [orderTokens]);
  for (const [id, stock] of before.stock) await pool.query("UPDATE flowers SET stock=$1 WHERE id=$2 AND stock <> $1", [stock, id]);
  await pool.query("DELETE FROM availability_checks WHERE id > $1", [before.availMax]);
  await pool.query("DELETE FROM funnel_events WHERE id > $1", [before.funnelMax]);
  for (const id of tempUsers) {
    await pool.query("DELETE FROM session WHERE sess::text LIKE $1", [`%"adminId":${id}%`]);
    await pool.query("DELETE FROM admin_users WHERE id = $1", [id]);
  }
}
check("cleanup: no test orders left", Number((await pool.query("SELECT COUNT(*) FROM orders WHERE id > $1", [before.orderMax])).rows[0].count) === 0);
check("cleanup: test staff accounts removed", Number((await pool.query("SELECT COUNT(*) FROM admin_users WHERE username LIKE 'zz.test.%'")).rows[0].count) === 0);
await pool.end();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
