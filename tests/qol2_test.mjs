// The second round of small improvements, checked in a DOM (real pages and scripts in jsdom, against the running server):
//   A. share button        B. add-to-cart toast        C. back to top          D. recently viewed
//   E. skeleton cards      F. copyable coupon          G. blog reading bar     H. POS new-order notice and "/" shortcut
//   I. last admin page     J. stylesheet rules (nothing to run: the CSS is read)
//
// Run from the repo root with the server running on the same database:
//   export DB_HOST=127.0.0.1 DB_PORT=5433 DB_PASSWORD=dev
//   BASE=http://localhost:3000 node tests/qol2_test.mjs
//
// It places a few real pickup orders (cash) for part H and deletes them afterwards (restoring the flower stock), moves
// the campaign coupon's window around today for a moment, and creates two staff accounts named zz.test.* (employee,
// manager). EMAIL_MODE=log only, never production. Rate limits apply (about twice in 15 minutes for the whole suite).
//
// Does NOT prove: how any of it looks or feels, that a real phone's share sheet opens (navigator.share is a stub here),
// that the page transition runs, or what real browsers do with the clipboard.

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
process.on("unhandledRejection", (e) => { failed++; console.log(`FAIL a page script failed on its own :: ${String(e).slice(0, 160)}`); });
function check(name, cond, extra = "") { if (cond) passed++; else { failed++; console.log(`FAIL ${name}${extra ? " :: " + extra : ""}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000, step = 40) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(step); } return false; }
const noCss = requestInterceptor(async (request) => (/\.css(\?|$)/.test(request.url) ? new Response("", { headers: { "Content-Type": "text/css" } }) : undefined));
const css = (f) => fs.readFileSync(path.join(ROOT, "public", "css", f), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const vnDate = (n) => new Date(Date.now() + 7 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);

// Stop early if this script's database is not the server's database.
{
  const row = (await pool.query("SELECT shop_address, contact_phone, contact_email, vat_rate FROM settings")).rows[0];
  const api = await (await fetch(`${BASE}/api/settings`)).json();
  if (!row || row.shop_address !== api.shop_address || row.contact_phone !== api.contact_phone || row.contact_email !== api.contact_email || row.vat_rate !== api.vat_rate) {
    console.log("FAIL this script is connected to a different database than the server at " + BASE + " (settings differ). Export the same DB_HOST / DB_PORT / DB_PASSWORD as the server and run again.");
    process.exit(2);
  }
}

// A page with its scripts, whose timers and a few browser features we can see and control.
//   timers: every setTimeout the page asks for ({id, ms, fn}); cleared: ids passed to clearTimeout
async function openPage(urlPath, { storage = {}, cookie, share, clipboard, execCommand, matchReduce, rejectApi, scrollTo } = {}) {
  const url = `${BASE}${urlPath}`;
  const html = await (await fetch(url, { redirect: "manual", headers: cookie ? { Cookie: cookie } : {} })).text();
  const timers = [], cleared = [], calls = [], events = [], scrolls = [];
  let nextId = 1;
  const dom = new JSDOM(html, { url, runScripts: "dangerously", resources: { interceptors: [noCss] }, pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
    beforeParse(w) {
      for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
      w.setTimeout = (fn, ms) => { const id = nextId++; timers.push({ id, ms, fn }); return id; };
      w.clearTimeout = (id) => { cleared.push(id); };
      w.scrollTo = (...a) => scrolls.push(a);
      w.matchMedia = (q) => ({ matches: /reduce/.test(q) ? Boolean(matchReduce) : false, media: q, addEventListener() {}, removeEventListener() {} });
      if (share) Object.defineProperty(w.navigator, "share", { value: share, configurable: true });
      if (clipboard) Object.defineProperty(w.navigator, "clipboard", { value: clipboard, configurable: true });
      if (execCommand) w.document.execCommand = execCommand;
      w.gtag = (...a) => events.push(a);
      w.fetch = (u, o = {}) => {
        const target = new URL(u, url);
        calls.push(`${o.method || "GET"} ${target.pathname}`);
        if (rejectApi && rejectApi.test(target.pathname)) return Promise.reject(new TypeError("network down (test)"));
        return fetch(target, { ...o, headers: { ...(o.headers || {}), ...(cookie ? { Cookie: cookie } : {}) } });
      };
    } });
  const w = dom.window, d = w.document;
  return { dom, w, d, timers, cleared, calls, events, scrolls, close: () => w.close(), $: (id) => d.getElementById(id), ready: (sel) => until(() => d.querySelector(sel)) };
}

// ---- staff and bookkeeping for part H
const tempUsers = [], orderTokens = [];
await pool.query("DELETE FROM admin_users WHERE username LIKE 'zz.test.%'");
const before = {
  funnelMax: (await pool.query("SELECT COALESCE(MAX(id),0) AS m FROM funnel_events")).rows[0].m,
  availMax: (await pool.query("SELECT COALESCE(MAX(id),0) AS m FROM availability_checks")).rows[0].m,
  orderMax: (await pool.query("SELECT COALESCE(MAX(id),0) AS m FROM orders")).rows[0].m,
  stock: new Map((await pool.query("SELECT id, stock FROM flowers")).rows.map((r) => [r.id, r.stock])),
  active: (await pool.query("SELECT active_campaign_id FROM settings")).rows[0].active_campaign_id,
};
let touchedCoupon = null;

try {
  const hash = await bcrypt.hash("zz-test-password-1", 10);
  for (const [name, role] of [["zz.test.employee", "employee"], ["zz.test.manager", "manager"]]) tempUsers.push((await pool.query("INSERT INTO admin_users (username, password, role) VALUES ($1, $2, $3) RETURNING id", [name, hash, role])).rows[0].id);
  const login = async (u) => { const r = await fetch(`${BASE}/api/admin/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: u, password: "zz-test-password-1" }) }); return { status: r.status, cookie: (r.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ") }; };
  const staff = { employee: await login("zz.test.employee"), manager: await login("zz.test.manager") };
  check("test employee and manager can log in", staff.employee.status === 200 && staff.manager.status === 200);

  // ============================================================ A. the share button
  {
    const P = "/product.html?id=9&utm_source=zalo";
    const page = async (opts) => { const p = await openPage(P, opts); await p.ready('script[type="application/ld+json"]'); return p; };

    // where the browser has a share sheet
    const shared = [];
    let p = await page({ share: async (data) => { shared.push(data); } });
    const canonical = p.d.querySelector('link[rel="canonical"]').getAttribute("href");
    check("the page's canonical address has no utm tags (that is what gets shared)", canonical.endsWith("/product.html?id=9") && !canonical.includes("utm"), canonical);
    p.$("share-button").click();
    await sleep(80);
    check("share sheet available: Chia sẻ opens it with the title, the product's name and the canonical address", shared.length === 1 && shared[0].url === canonical && shared[0].title === p.d.title && shared[0].text === p.$("product-name").textContent, JSON.stringify(shared));
    check("…and the small menu stays closed", p.$("share-menu").hidden === true && p.$("share-button").getAttribute("aria-expanded") === "false");
    check("…the share is reported to Google Analytics as a 'share' event", p.events.some((e) => e[0] === "event" && e[1] === "share" && e[2].method === "native" && e[2].item_id === "9"), JSON.stringify(p.events));
    p.close();

    // the person closes the sheet
    p = await page({ share: async () => { const e = new Error("closed"); e.name = "AbortError"; throw e; } });
    p.$("share-button").click();
    await sleep(80);
    check("closing the share sheet (AbortError) does nothing more: no menu, no event", p.$("share-menu").hidden === true && p.events.length === 0);
    p.close();

    // the sheet fails for another reason: fall back to the menu
    p = await page({ share: async () => { throw new Error("not allowed"); } });
    p.$("share-button").click();
    await sleep(80);
    check("a share sheet that fails for another reason falls back to the menu", p.$("share-menu").hidden === false);
    p.close();

    // no share sheet: the menu
    const copied = [];
    p = await page({ clipboard: { writeText: async (t) => { copied.push(t); } } });
    const menu = p.$("share-menu"), button = p.$("share-button");
    check("no share sheet: the menu starts closed", menu.hidden === true && button.getAttribute("aria-expanded") === "false");
    button.click();
    check("…Chia sẻ opens it", menu.hidden === false && button.getAttribute("aria-expanded") === "true");
    const fb = p.$("share-facebook");
    check("…Facebook link: opens in a new tab safely, sharing the canonical address (encoded)", fb.getAttribute("href") === `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(canonical)}` && fb.target === "_blank" && /noopener/.test(fb.rel), fb.getAttribute("href"));
    button.click();
    check("…clicking the button again closes it", menu.hidden === true && button.getAttribute("aria-expanded") === "false");
    button.click();
    p.d.body.dispatchEvent(new p.w.MouseEvent("click", { bubbles: true }));
    check("…a click elsewhere closes it", menu.hidden === true);
    button.click();
    menu.dispatchEvent(new p.w.MouseEvent("click", { bubbles: true }));
    check("…a click inside the menu (not on an item) leaves it open", menu.hidden === false);
    p.d.dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    check("…Escape closes it and puts focus back on the button", menu.hidden === true && p.d.activeElement === button);
    button.click();
    p.$("share-copy").click();
    check("Sao chép liên kết copies the canonical address", await until(() => copied.length === 1) && copied[0] === canonical, JSON.stringify(copied));
    await until(() => p.$("bloomy-toast") && p.$("bloomy-toast").hidden === false);
    const toast = p.$("bloomy-toast");
    check("…the menu closes and a toast confirms", menu.hidden === true && !!toast && toast.hidden === false && toast.querySelector(".toast__text").textContent === "Đã sao chép liên kết sản phẩm");
    check("…and it is reported as a copy_link share", p.events.some((e) => e[1] === "share" && e[2].method === "copy_link"));
    p.close();

    // no clipboard API: the older way; and a failure that says so
    const cmds = [];
    p = await page({ execCommand: (c) => { cmds.push(c); return true; } });
    p.$("share-button").click();
    p.$("share-copy").click();
    check("no clipboard API: the older copy command is used", await until(() => cmds.includes("copy")) && p.$("bloomy-toast").querySelector(".toast__text").textContent === "Đã sao chép liên kết sản phẩm");
    p.close();
    p = await page({ execCommand: () => false });
    p.$("share-button").click();
    p.$("share-copy").click();
    check("when nothing can copy, the toast says so and tells the person what to do", await until(() => p.$("bloomy-toast") && /Không sao chép được/.test(p.$("bloomy-toast").querySelector(".toast__text").textContent)) && p.events.every((e) => e[1] !== "share"));
    p.close();
  }

  // ============================================================ B. the add-to-cart toast
  {
    const p = await openPage("/product.html?id=9");
    await p.ready('script[type="application/ld+json"]');
    p.$("add-to-cart").click();
    const toast = p.$("bloomy-toast");
    const links = [...toast.querySelectorAll(".toast__links a")].map((a) => [a.textContent, a.getAttribute("href")]);
    check("add to cart: a toast says what was added, in plain text", !toast.hidden && toast.getAttribute("role") === "status" && toast.querySelector(".toast__text").textContent === `Đã thêm “${p.$("product-name").textContent}” vào giỏ`, toast.querySelector(".toast__text").textContent);
    check("…and offers the next step: Xem giỏ hàng and Thanh toán", JSON.stringify(links) === JSON.stringify([["Xem giỏ hàng", "cart.html"], ["Thanh toán", "checkout.html"]]), JSON.stringify(links));
    const timer = p.timers.filter((t) => t.ms === 5000).at(-1);
    check("…it closes itself after 5 seconds", !!timer);
    toast.dispatchEvent(new p.w.MouseEvent("mouseenter"));
    check("…the mouse on it stops the clock", p.cleared.includes(timer.id));
    toast.dispatchEvent(new p.w.MouseEvent("mouseleave"));
    check("…and leaving gives it 2 more seconds", p.timers.some((t) => t.ms === 2000));
    p.timers.filter((t) => t.ms === 2000).at(-1).fn();
    check("…then it is gone", toast.hidden === true && !toast.classList.contains("is-visible"));
    p.$("add-to-cart").click();
    check("a second add shows it again (one toast element, never a pile)", toast.hidden === false && p.d.querySelectorAll("#bloomy-toast").length === 1);
    toast.querySelector(".toast__close").click();
    check("the × closes it", toast.hidden === true && toast.querySelector(".toast__close").getAttribute("aria-label") === "Đóng thông báo");
    p.close();
  }

  // ============================================================ C. back to top
  {
    const page = await (await fetch(`${BASE}/`)).text();
    const mainJs = await (await fetch(`${BASE}/js/main.js`)).text();
    const run = (reduce) => {
      const dom = new JSDOM(page, { url: `${BASE}/`, runScripts: "outside-only", pretendToBeVisual: true });
      const w = dom.window;
      let y = 0; const scrolls = [];
      Object.defineProperty(w, "scrollY", { get: () => y, configurable: true });
      w.scrollTo = (...a) => scrolls.push(a);
      w.matchMedia = (q) => ({ matches: /reduce/.test(q) ? reduce : false });
      w.eval(mainJs);
      w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
      const btn = w.document.querySelector(".back-to-top");
      const at = async (pos) => { y = pos; w.dispatchEvent(new w.Event("scroll")); await sleep(60); };
      return { w, btn, at, scrolls };
    };
    const r = run(false);
    check("back to top: one round button with a name, hidden at the top of the page", !!r.btn && r.btn.hidden === true && r.btn.getAttribute("aria-label") === "Lên đầu trang" && r.w.document.querySelectorAll(".back-to-top").length === 1);
    await r.at(599);
    check("…still hidden just short of 600px", r.btn.hidden === true);
    await r.at(600);
    check("…shown from 600px down", r.btn.hidden === false);
    await r.at(100);
    check("…and hidden again when scrolled back up", r.btn.hidden === true);
    await r.at(2000);
    r.btn.click();
    check("clicking scrolls to the top, smoothly", r.scrolls.length === 1 && r.scrolls[0][0].top === 0 && r.scrolls[0][0].behavior === "smooth", JSON.stringify(r.scrolls));
    r.w.close();
    const q = run(true);
    await q.at(2000);
    q.btn.click();
    check("with reduced motion on, it jumps instead (scrollTo's own smooth ignores the CSS rule)", q.scrolls[0][0].behavior === "auto", JSON.stringify(q.scrolls));
    q.w.close();
  }

  // ============================================================ D. recently viewed
  {
    const seen = async (id, storage) => { const p = await openPage(`/product.html?id=${id}`, { storage }); await p.ready('script[type="application/ld+json"]'); const stored = p.w.localStorage.getItem("bloomy_recent_v1"); const strip = [...p.d.querySelectorAll("#recent-list li a")].map((a) => a.getAttribute("href")); const hidden = p.$("recent-viewed").hidden; p.close(); return { stored, strip, hidden }; };
    const a = await seen(9, {});
    check("first product ever seen: no strip (nothing earlier)", a.hidden === true && a.strip.length === 0);
    const b = await seen(5, { bloomy_recent_v1: a.stored });
    check("second product: the strip shows the first one, linking to it", b.hidden === false && JSON.stringify(b.strip) === JSON.stringify(["product.html?id=9"]), JSON.stringify(b.strip));
    const c = await seen(3, { bloomy_recent_v1: b.stored });
    check("third: newest first, and the product being looked at is not in its own strip", JSON.stringify(c.strip) === JSON.stringify(["product.html?id=5", "product.html?id=9"]) && !c.strip.includes("product.html?id=3"), JSON.stringify(c.strip));
    check("…the order remembered is newest first, no duplicates", JSON.parse(c.stored).map((i) => i.id).join() === "3,5,9");
    const again = await seen(9, { bloomy_recent_v1: c.stored });
    check("visiting one again moves it to the front (never twice)", JSON.parse(again.stored).map((i) => i.id).join() === "9,3,5");
    const many = Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, name: `Sản phẩm ${i}`, image: `images/p${i}.webp` }));
    const m = await seen(9, { bloomy_recent_v1: JSON.stringify(many) });
    check("at most 8 are remembered, and the strip shows at most 8 (the ones seen before this visit)", JSON.parse(m.stored).length === 8 && m.strip.length === 8 && JSON.parse(m.stored)[0].id === 9, `${JSON.parse(m.stored).length}/${m.strip.length}`);
    // localStorage is the visitor's own: anything odd in it is dropped, and names are only ever text
    const hostile = [
      { id: 21, name: "Tốt", image: "images/tot.webp" },
      { id: "22", name: "id là chữ", image: "images/x.webp" }, { id: -1, name: "id âm", image: "images/x.webp" }, { id: 1.5, name: "id lẻ", image: "images/x.webp" },
      { id: 23, name: "ảnh ngoài", image: "https://evil.example/x.jpg" }, { id: 24, name: "ảnh leo thư mục", image: "images/../server.js" }, { id: 25, name: "ảnh javascript", image: "javascript:alert(1)" },
      { id: 26, name: "x".repeat(201), image: "images/x.webp" }, { id: 27, name: 5, image: "images/x.webp" }, null, "chuỗi", 7,
      { id: 28, name: `<img src=x onerror=alert(1)> & "q"`, image: "images/thu.webp" },
    ];
    const h = await openPage("/product.html?id=9", { storage: { bloomy_recent_v1: JSON.stringify(hostile) } });
    await h.ready('script[type="application/ld+json"]');
    const ids = [...h.d.querySelectorAll("#recent-list li a")].map((x) => x.getAttribute("href"));
    check("odd entries in localStorage are dropped (text ids, negative or fractional ids, outside or climbing or javascript: pictures, long or non-text names, non-objects)", JSON.stringify(ids) === JSON.stringify(["product.html?id=21", "product.html?id=28"]), JSON.stringify(ids));
    const names = [...h.d.querySelectorAll(".recent-viewed__name")].map((x) => x.textContent);
    check("…a name with markup in it is shown as plain text (nothing injected)", names[1] === `<img src=x onerror=alert(1)> & "q"` && !h.d.querySelector("#recent-list img[onerror]") && h.d.querySelectorAll("#recent-list img").length === 2);
    h.close();
    for (const bad of ["{ not json", "42", '"text"', "null"]) {
      const x = await openPage("/product.html?id=9", { storage: { bloomy_recent_v1: bad } });
      await x.ready('script[type="application/ld+json"]');
      check(`unreadable storage (${bad}) is ignored: no strip, the product page still works`, x.$("recent-viewed").hidden === true && x.$("product-name").textContent.length > 0);
      x.close();
    }
  }

  // ============================================================ E. skeleton cards
  {
    const countSkeletons = async (p) => { const d = new JSDOM(await (await fetch(`${BASE}${p}`, { redirect: "manual" })).text()).window.document; const cards = [...d.querySelectorAll(".skeleton-card")]; return { n: cards.length, hidden: cards.every((c) => c.getAttribute("aria-hidden") === "true"), inGrid: cards.every((c) => c.parentElement.matches("[data-featured-grid], #product-grid, #landing-grid")) }; };
    const home = await countSkeletons("/"), list = await countSkeletons("/products.html"), land = await countSkeletons("/landing");
    check("the home page, the product list and the landing page send grey placeholders in their grids (4, 8, 3), hidden from screen readers", home.n === 4 && list.n === 8 && land.n === 3 && home.hidden && list.hidden && land.hidden && home.inGrid && list.inGrid && land.inGrid, JSON.stringify([home, list, land]));
    const p = await openPage("/products.html");
    await until(() => p.d.querySelectorAll("#product-grid .product-card").length > 0);
    check("product list: once the cards arrive the placeholders are gone", p.d.querySelectorAll("#product-grid .skeleton-card").length === 0 && p.d.querySelectorAll("#product-grid .product-card").length > 8);
    p.close();
    const f = await openPage("/products.html", { rejectApi: /^\/api\/products$/ });
    check("product list, API down: the placeholders are cleared and a message says so (not left shimmering)", await until(() => f.d.body.classList.contains("is-ready")) && f.d.querySelectorAll("#product-grid .skeleton-card").length === 0 && f.$("listing-empty").hidden === false && /Không thể tải sản phẩm/.test(f.$("listing-empty").textContent), f.$("listing-empty").textContent);
    f.close();
    const h = await openPage("/");
    await until(() => h.d.querySelectorAll("[data-featured-grid] .product-card").length > 0);
    check("home page: the featured cards replace the placeholders", h.d.querySelectorAll("[data-featured-grid] .skeleton-card").length === 0 && h.d.querySelectorAll("[data-featured-grid] .product-card").length > 0);
    h.close();
    const hf = await openPage("/", { rejectApi: /^\/api\/products$/ });
    check("home page, API down: the whole featured section is hidden, placeholders and all", await until(() => hf.$("featured").hidden === true));
    hf.close();
    const l = await openPage("/landing");
    if (await until(() => l.d.querySelectorAll("#landing-grid .landing-card").length > 0, 3000) || true) {
      check("landing page: the product cards replace the placeholders", l.d.querySelectorAll("#landing-grid .skeleton-card").length === 0 && l.d.querySelectorAll("#landing-grid .landing-card").length > 0);
    }
    l.close();
    const lf = await openPage("/landing", { rejectApi: /^\/api\/campaigns\/active$/ });
    check("landing page, API down: the placeholders go and the error shows", await until(() => lf.$("landing-error").hidden === false) && lf.d.querySelectorAll("#landing-grid .skeleton-card").length === 0);
    lf.close();
  }

  // ============================================================ F. the copyable coupon
  {
    const camp = (await pool.query("SELECT id, coupon_code FROM campaigns ORDER BY id LIMIT 1")).rows[0];
    await pool.query("UPDATE settings SET active_campaign_id=$1", [camp.id]);
    touchedCoupon = (await pool.query("SELECT code, type, value, min_subtotal, starts_on::text AS starts_on, ends_on::text AS ends_on, active FROM coupons WHERE code=$1", [camp.coupon_code])).rows[0];
    await pool.query("UPDATE coupons SET starts_on=$2, ends_on=$3, active=true WHERE code=$1", [camp.coupon_code, vnDate(1), vnDate(20)]);
    for (const where of ["/landing", "/"]) {
      const copied = [];
      const p = await openPage(where, { clipboard: { writeText: async (t) => { copied.push(t); } } });
      await until(() => p.w.Bloomy && p.w.Bloomy.copyText); // the page's scripts have run: something is listening for the click
      const btn = p.d.querySelector(".campaign-chip__copy");
      check(`${where}: the coupon chip has a copy button for the code, with a name`, !!btn && btn.dataset.copy === camp.coupon_code && btn.getAttribute("aria-label") === `Sao chép mã ${camp.coupon_code}` && btn.textContent === "Sao chép");
      btn.click();
      check(`${where}: clicking copies the code`, await until(() => copied.length === 1) && copied[0] === camp.coupon_code, JSON.stringify(copied));
      check(`${where}: the button says so and pops`, await until(() => btn.textContent === "Đã sao chép ✓") && btn.classList.contains("is-added"));
      p.timers.filter((t) => t.ms === 2000).at(-1).fn();
      check(`${where}: after 2 seconds it is the same button again`, btn.textContent === "Sao chép");
      p.close();
    }
    const failing = await openPage("/landing", { execCommand: () => false });
    await until(() => failing.w.Bloomy && failing.w.Bloomy.copyText);
    failing.d.querySelector(".campaign-chip__copy").click();
    check("when nothing can copy, the button says so", await until(() => failing.d.querySelector(".campaign-chip__copy").textContent === "Không sao chép được"));
    failing.close();
  }

  // ============================================================ G. the reading bar on blog posts
  {
    const posts = JSON.parse(fs.readFileSync(path.join(ROOT, "content", "posts.json"), "utf8"));
    const slug = posts[0].slug;
    const p = await openPage(`/blog/${slug}`);
    await until(() => typeof p.w.readingProgress === "function");
    const rp = p.w.readingProgress;
    check("reading bar: 0 at the top, half-way through, 1 at the end and beyond, never outside 0–1", rp(0, 2000, 1000) === 0 && rp(100, 2000, 1000) === 0 && rp(-500, 2000, 1000) === 0.5 && rp(-1000, 2000, 1000) === 1 && rp(-5000, 2000, 1000) === 1);
    check("…and a short article (shorter than the window) does not divide by zero", Number.isFinite(rp(-10, 300, 1000)) && rp(0, 300, 1000) === 0);
    const bar = p.$("reading-progress-bar");
    check("the bar sits in a hidden-from-screen-readers strip and starts empty", bar.closest(".reading-progress").getAttribute("aria-hidden") === "true" && /scaleX\(0\)/.test(bar.style.transform));
    const article = p.d.querySelector(".blog-article");
    let top = -500;
    article.getBoundingClientRect = () => ({ top, height: 2000, bottom: top + 2000 });
    Object.defineProperty(p.w, "innerHeight", { value: 1000, configurable: true });
    p.w.dispatchEvent(new p.w.Event("scroll"));
    check("scrolling moves the bar (500px into a 2000px article in a 1000px window → half)", await until(() => /scaleX\(0\.5\)/.test(bar.style.transform)), bar.style.transform);
    top = -1500;
    p.w.dispatchEvent(new p.w.Event("scroll"));
    check("…and it ends full", await until(() => /scaleX\(1\)/.test(bar.style.transform)), bar.style.transform);
    p.close();
    const index = new JSDOM(await (await fetch(`${BASE}/blog`)).text()).window.document;
    check("only posts have the bar (the blog index does not)", index.querySelector(".reading-progress") === null);
  }

  // ============================================================ H. the POS: new-order notice and the "/" shortcut
  {
    const day = vnDate(3);
    const place = async (name) => {
      const res = await fetch(`${BASE}/api/orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        items: [{ productId: 9, size: "m", quantity: 1 }], fulfillment_type: "pickup", delivery_date: day, delivery_window: "morning", payment_method: "cash", consent: true,
        sender_name: "Kiểm thử Người gửi", sender_phone: "0912345678", recipient_name: name, recipient_phone: "0987654321", session_id: `test-${crypto.randomUUID()}` }) });
      const data = await res.json();
      orderTokens.push(data.token);
      const id = (await pool.query("SELECT id FROM orders WHERE token=$1", [data.token])).rows[0].id;
      return { status: res.status, id, code: `BLOMY${String(id).padStart(6, "0")}` };
    };
    const first = await place("Kiểm thử Có sẵn");
    check("(a pickup order is already waiting when the POS page opens)", first.status === 201);
    const p = await openPage("/admin-pos.html", { cookie: staff.employee.cookie });
    await until(() => p.$("pos-products").children.length > 0);
    await sleep(300);
    const banner = () => p.$("pos-new-pickup");
    check("POS: opening the page does not announce the orders that were already waiting", banner().hidden === true && p.$("pos-pickups-count").hidden === false);
    check("POS: the notice is a status message in the page (top right), with Xem and a close button", banner().getAttribute("role") === "status" && !!p.$("pos-new-pickup-open") && p.$("pos-new-pickup-close").getAttribute("aria-label") === "Đóng thông báo");

    const second = await place("Kiểm thử Mới Một");
    await p.w.pollPickups();
    check("POS: a new order turns up → the notice appears with its code", banner().hidden === false && p.$("pos-new-pickup-text").textContent === `Có đơn nhận tại shop mới: ${second.code}`, p.$("pos-new-pickup-text").textContent);
    check("…and the number on the toggle follows", p.$("pos-pickups-count").textContent === String((await pool.query("SELECT COUNT(*) FROM orders WHERE channel='web' AND fulfillment_type='pickup' AND fulfillment_status='new'")).rows[0].count));
    const timer = p.timers.filter((t) => t.ms === 10000).at(-1);
    check("…it is set to go away after 10 seconds", !!timer);
    timer.fn();
    check("…and it does", banner().hidden === true);
    await p.w.pollPickups();
    check("POS: looking again with nothing new says nothing", banner().hidden === true);

    const third = await place("Kiểm thử Mới Hai"), fourth = await place("Kiểm thử Mới Ba");
    await p.w.pollPickups();
    check("POS: two new orders at once → one notice saying how many", banner().hidden === false && p.$("pos-new-pickup-text").textContent === "Có 2 đơn nhận tại shop mới", p.$("pos-new-pickup-text").textContent);
    const loads = () => p.calls.filter((c) => c === "GET /api/admin/pos/pickups").length;
    const loadsBefore = loads();
    p.$("pos-new-pickup-open").click();
    check("POS: Xem hides the notice and opens the list with the orders in it", banner().hidden === true && p.$("pos-pickups").hidden === false && (await until(() => [...p.d.querySelectorAll("#pos-pickups-body tr")].some((tr) => tr.textContent.includes(third.code)))));
    await until(() => loads() > loadsBefore); // opening reloads the list: let that reload finish drawing before the next step
    await sleep(200);

    // an open list is not redrawn under the cursor, but a new order is still announced
    const firstRow = p.d.querySelector("#pos-pickups-body tr");
    firstRow.setAttribute("data-mark", "same-row");
    const fifth = await place("Kiểm thử Mới Bốn");
    await p.w.pollPickups();
    check("POS: with the list open, a new order is still announced", banner().hidden === false && p.$("pos-new-pickup-text").textContent === `Có đơn nhận tại shop mới: ${fifth.code}`);
    const rowsNow = [...p.d.querySelectorAll("#pos-pickups-body tr")];
    check("…but the open list is not redrawn (the row under the cursor is the same row)", rowsNow.some((tr) => tr.getAttribute("data-mark") === "same-row") && !rowsNow.some((tr) => tr.textContent.includes(fifth.code)), `rows=${rowsNow.length} marked=${rowsNow.filter((tr) => tr.getAttribute("data-mark")).length} hasFifth=${rowsNow.some((tr) => tr.textContent.includes(fifth.code))}`);
    p.$("pos-new-pickup-close").click();
    check("POS: × closes the notice", banner().hidden === true);
    p.$("pos-pickups-refresh").click();
    check("POS: Làm mới brings the list up to date", await until(() => [...p.d.querySelectorAll("#pos-pickups-body tr")].some((tr) => tr.textContent.includes(fifth.code))));

    // "/" jumps to the search
    const search = p.$("pos-search");
    const press = (target, init = {}) => { const e = new p.w.KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true, ...init }); target.dispatchEvent(e); return e; };
    const e1 = press(p.d.body);
    check("POS: pressing / focuses the product search (and the slash is not typed)", p.d.activeElement === search && e1.defaultPrevented === true);
    p.d.activeElement.blur();
    p.$("pos-pickups-refresh").focus();
    const e2 = press(p.d.body, { ctrlKey: true });
    check("POS: Ctrl+/ is left alone", p.d.activeElement !== search && e2.defaultPrevented === false);
    search.focus();
    const typed = press(search);
    check("POS: a / typed inside a field is a normal character (not hijacked)", typed.defaultPrevented === false && p.d.activeElement === search);
    check("POS: the search box says so", /nhấn \/ để tìm nhanh/.test(search.placeholder));
    p.close();
  }

  // ============================================================ I. the last admin page
  {
    const m = await openPage("/admin-seo.html", { cookie: staff.manager.cookie });
    await until(() => m.d.querySelector(".admin-nav__menu"));
    check("admin: a page that opens is remembered as the last one", m.w.localStorage.getItem("bloomy_admin_last") === "admin-seo.html");
    m.close();
    const e = await openPage("/admin-settings.html", { cookie: staff.employee.cookie });
    await sleep(600);
    check("admin: a page the person may not open (owner-only, as an employee) is NOT remembered", e.w.localStorage.getItem("bloomy_admin_last") === null);
    e.close();
    const l = await openPage("/admin-login.html");
    await until(() => typeof l.w.afterLoginTarget === "function");
    const go = (last, landing) => { l.w.localStorage.clear(); if (last !== undefined) l.w.localStorage.setItem("bloomy_admin_last", last); return l.w.afterLoginTarget(landing); };
    check("login: opens the last admin page used", go("admin-stats.html", "admin-pos.html") === "admin-stats.html");
    check("login: nothing remembered → where the server says this role starts", go(undefined, "admin-pos.html") === "admin-pos.html");
    check("login: no landing either → the products page", go(undefined, undefined) === "admin-products.html");
    for (const bad of ["https://evil.example/x", "//evil.example", "../server.js", "admin-login.html", "javascript:alert(1)", "admin-.html/../x", "ADMIN-POS.HTML", "admin pos.html", ""]) {
      check(`login: a remembered value that is not an admin page name (${JSON.stringify(bad)}) is ignored`, go(bad, "admin-pos.html") === "admin-pos.html", String(go(bad, "admin-pos.html")));
    }
    l.close();
  }
} finally {
  if (orderTokens.length) await pool.query("DELETE FROM orders WHERE token = ANY($1)", [orderTokens]);
  for (const [id, stock] of before.stock) await pool.query("UPDATE flowers SET stock=$1 WHERE id=$2 AND stock <> $1", [stock, id]);
  await pool.query("DELETE FROM availability_checks WHERE id > $1", [before.availMax]);
  await pool.query("DELETE FROM funnel_events WHERE id > $1", [before.funnelMax]);
  if (touchedCoupon) await pool.query("UPDATE coupons SET starts_on=$2, ends_on=$3, active=$4 WHERE code=$1", [touchedCoupon.code, touchedCoupon.starts_on, touchedCoupon.ends_on, touchedCoupon.active]);
  await pool.query("UPDATE settings SET active_campaign_id=$1", [before.active]);
  for (const id of tempUsers) {
    await pool.query("DELETE FROM session WHERE sess::text LIKE $1", [`%"adminId":${id}%`]);
    await pool.query("DELETE FROM admin_users WHERE id = $1", [id]);
  }
}

// ============================================================ J. the stylesheets
{
  const style = strip(css("style.css"));
  check("toast: fixed bottom centre, above the page, with a short rise", /\.toast\s*\{[^}]*position:\s*fixed[^}]*bottom:\s*24px/.test(style) && /@keyframes bloomy-toast-in/.test(style));
  check("back to top: fixed bottom left (the contact buttons are bottom right)", /\.back-to-top\s*\{[^}]*position:\s*fixed[^}]*left:\s*24px/.test(style));
  check("skeleton cards: a square image box and two lines, with a shimmer", /\.skeleton-card__image\s*\{[^}]*aspect-ratio:\s*1 \/ 1/.test(style) && /@keyframes bloomy-shimmer/.test(style));
  check("the same focus ring covers inputs, textareas, summaries and anything given a tabindex", /textarea:focus-visible/.test(style) && /summary:focus-visible/.test(style) && /\[tabindex\]:not\(\[tabindex="-1"\]\):focus-visible/.test(style));
  const vt = style.slice(style.lastIndexOf("@media (prefers-reduced-motion: no-preference)"));
  check("page transitions: gone for good (a page that fades out and in made navigation feel slower, so it was removed)", !/@view-transition/.test(style) && !/view-transition-name/.test(style));
  const raw = css("style.css"); // with its comments: the markers are comments
  const sharedAt = raw.indexOf("/* ==== Shared pieces"), motionAt = raw.indexOf("/* ==== Motion (customer pages only)");
  check("the shared pieces (toast, back to top, skeleton, copy button) sit before the motion block, so its customer-only scoping check stays meaningful", sharedAt > 0 && motionAt > sharedAt && /\.toast\s*\{/.test(raw.slice(sharedAt, motionAt)) && !/\.toast\s*\{/.test(raw.slice(motionAt)));
  const blog = strip(css("blog.css"));
  check("reading bar: fixed at the very top, ignores the mouse, moves by transform (no layout work)", /\.reading-progress\s*\{[^}]*position:\s*fixed[^}]*top:\s*0/.test(blog) && /pointer-events:\s*none/.test(blog) && /\.reading-progress__bar\s*\{[^}]*transform:\s*scaleX\(0\)/.test(blog));
  const admin = strip(css("admin.css"));
  check("POS notice: fixed top right, above the page", /\.pos-new-pickup\s*\{[^}]*position:\s*fixed[^}]*top:\s*16px[^}]*right:\s*16px/.test(admin));
  const product = strip(css("product.css"));
  check("share menu and the recently-viewed strip are styled", /\.share-menu\s*\{[^}]*position:\s*absolute/.test(product) && /\.recent-viewed__list\s*\{[^}]*overflow-x:\s*auto/.test(product));
}
check("cleanup: no test orders left", Number((await pool.query("SELECT COUNT(*) FROM orders WHERE id > $1", [before.orderMax])).rows[0].count) === 0);
check("cleanup: test staff accounts removed, the active campaign is as it was", Number((await pool.query("SELECT COUNT(*) FROM admin_users WHERE username LIKE 'zz.test.%'")).rows[0].count) === 0 && (await pool.query("SELECT active_campaign_id FROM settings")).rows[0].active_campaign_id === before.active);
await pool.end();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
