// Cross-browser check: Firefox and WebKit (Safari's engine) on the pages a customer uses, at a desktop and a phone width.
// jsdom cannot see CSS or layout, so this is what looks at them in real engines.
//
//   node tests/cross_browser_check.mjs [baseUrl] [--only firefox|webkit] [--shots <folder>]     (from the repo root)
//
// Needs a Bloomy server running with the seeded catalogue (default http://localhost:3000; `npm run build && node server.js`
// after the setup in CLAUDE.md), Firefox, and for WebKit: MiniBrowser and WebKitWebDriver (webkitgtk6.0), xvfb-run and
// dbus-run-session. It is NOT one of the suites (its name does not end in _test.mjs): it needs browsers, is run on purpose,
// and is not part of `npm test` or CI. Read-only against the server: it only loads pages. The one "write" is a line in
// the BROWSER's own localStorage cart; no order is placed. Use a local server (on the live site the page views would reach
// Google Analytics; this is not for that, see post_deploy_browser_check.mjs).
//
// How the browsers are driven, with no extra package:
//   Firefox  headless, started with its own remote agent (WebDriver BiDi over a WebSocket), a private profile, no display.
//   WebKit   MiniBrowser under WebKitWebDriver on a private Xvfb screen (so no window opens on yours), classic WebDriver.
// Only the processes started here are killed (their process group), never anything of yours.
// WebKit gets the site through a small pass-through proxy that removes ONE directive from the Content-Security-Policy,
// `upgrade-insecure-requests`: WebKit upgrades even http://localhost sub-requests to https, which a local http server
// cannot answer (Firefox and Chromium exempt localhost), so no script or picture would load. Production is https, where
// that directive does nothing; the rest of the policy (script-src, img-src, ...) is still enforced. Not tested here: the
// directive itself over https.
//
// Per browser and per width (1440, 390 and 360 px: a desktop, a recent iPhone, a common small Android) it checks the product list (grid columns, 20 cards, no horizontal scroll,
// the page bar on ONE line, page 2 by a real-position click and the scroll back to the grid, the Valentine filter and its
// "Dịp" chips), a product page (sizes, price, add to cart and the cart badge), the cart and the checkout page, and the
// home page, then every other page type (the sitemap, the blog posts, the sign-in page, an order page, a variety of product pages); and on each page that the scripts ran (window.Bloomy; the admin pages do not load it) and no picture is broken. Firefox also reports
// JavaScript errors from its log; classic WebDriver has no console, so for WebKit "the scripts ran" is the stand-in.
//
// Proves: those pages lay out and behave as stated in Firefox and in WebKitGTK. Does NOT prove: real Safari (fonts, the
// iPhone toolbar, touch, the date picker), real phones, the dark theme, or how anything looks to the eye (use --shots
// and look). WebKitGTK is not Safari: it shares the engine, not the platform.

import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const BASE = (argv.find((a, i) => !a.startsWith("--") && !["--only", "--shots"].includes(argv[i - 1])) || "http://localhost:3000").replace(/\/$/, "");
const ONLY = flag("--only");
const SHOTS = flag("--shots");
const VIEWPORTS = [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844 }, { name: "small phone", width: 360, height: 740 }];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once("error", reject); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const killGroup = (child, sig = "SIGKILL") => { if (child?.pid && child.exitCode === null) { try { process.kill(-child.pid, sig); } catch { /* gone */ } } };
const cleanEnv = (extra = {}) => { const e = { ...process.env, ...extra }; delete e.DISPLAY; delete e.WAYLAND_DISPLAY; return e; };

// ============================================================ what the page-side code can use
const PRE = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = fn(); if (v) return v; } catch { /* not yet */ } await sleep(50); } return null; };
const q = (s) => document.querySelector(s);
const overflow = () => document.documentElement.scrollWidth - document.documentElement.clientWidth;
// the elements that stick out past the right edge of the screen (the widest first): what to look at when overflow() > 0
const offenders = () => overflow() <= 0 ? [] : [...document.querySelectorAll("body *")].map((e) => ({ e, r: e.getBoundingClientRect() })).filter((x) => x.r.width > 0 && x.r.right > document.documentElement.clientWidth + 0.5)
  .sort((a, b) => b.r.right - a.r.right).slice(0, 4).map((x) => x.e.tagName.toLowerCase() + (typeof x.e.className === "string" && x.e.className ? "." + x.e.className.trim().split(/\\s+/).join(".") : "") + " right=" + Math.round(x.r.right));
const broken = () => [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && i.getAttribute("src")).length;
// is the element what a click at its centre would hit (nothing sticky or floating on top of it)?
const reachable = (el) => { el.scrollIntoView({ block: "center", behavior: "instant" }); const r = el.getBoundingClientRect(); // "instant": the page may smooth-scroll, and the position is read right away
   const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!top && (top === el || el.contains(top) || top.closest("button,a") === el); };
`;

// ============================================================ the proxy (WebKit only, see the header)
async function proxyTo(target) {
  const t = new URL(target);
  const server = http.createServer((req, res) => {
    const up = http.request({ host: t.hostname, port: t.port || 80, method: req.method, path: req.url, headers: req.headers }, (r) => {
      const headers = { ...r.headers };
      for (const k of Object.keys(headers)) if (k.toLowerCase().startsWith("content-security-policy")) headers[k] = String(headers[k]).replace(/;?\s*upgrade-insecure-requests/gi, "");
      res.writeHead(r.statusCode, headers);
      r.pipe(res);
    });
    up.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  const port = await freePort();
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

// ============================================================ the drivers
// A page object: goto(url), eval(fn) (fn runs in the page, may be async, returns JSON-able data), resize(w, h), shot(file), errors()
async function firefox() {
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bloomy-ff-"));
  const child = spawn("firefox", ["--headless", "--no-remote", `--remote-debugging-port=${port}`, "-profile", profile, "about:blank"], { env: cleanEnv({ MOZ_HEADLESS: "1" }), stdio: "ignore", detached: true });
  let ws = null;
  for (let i = 0; i < 60 && !ws; i++) {
    await sleep(500);
    ws = await new Promise((resolve) => { const s = new WebSocket(`ws://127.0.0.1:${port}/session`); s.onopen = () => resolve(s); s.onerror = () => resolve(null); });
  }
  if (!ws) { killGroup(child); throw new Error("Firefox did not offer WebDriver BiDi on its debugging port"); }
  let id = 0; const waiting = new Map(); const errors = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) { const { resolve, reject } = waiting.get(d.id); waiting.delete(d.id); d.type === "error" ? reject(new Error(`${d.error}: ${d.message}`)) : resolve(d.result); }
    else if (d.method === "log.entryAdded" && d.params.level === "error") errors.push(`${d.params.type}: ${d.params.text}`.slice(0, 200));
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; waiting.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("session.new", { capabilities: {} });
  await send("session.subscribe", { events: ["log.entryAdded"] });
  const { context } = await send("browsingContext.create", { type: "tab" }); // a fresh foreground tab (focus and keys need it)
  const version = (await send("session.status").catch(() => ({})))?.message || "";
  return {
    name: "Firefox", version: version || "160",
    errors: () => errors.splice(0),
    resize: (w, h) => send("browsingContext.setViewport", { context, viewport: { width: w, height: h }, devicePixelRatio: 1 }),
    goto: (url) => send("browsingContext.navigate", { context, url, wait: "complete" }),
    eval: async (fn) => {
      const expression = `(async () => { ${PRE} return JSON.stringify(await (${fn.toString()})()); })()`;
      const r = await send("script.evaluate", { expression, target: { context }, awaitPromise: true, resultOwnership: "none" });
      if (r.type !== "success") throw new Error(`page script failed: ${r.exceptionDetails?.text ?? JSON.stringify(r).slice(0, 200)}`);
      return JSON.parse(r.result.value);
    },
    shot: async (file) => { const r = await send("browsingContext.captureScreenshot", { context, origin: "viewport" }); fs.writeFileSync(file, Buffer.from(r.data, "base64")); },
    close: async () => { try { await send("browser.close"); } catch { /* closing */ } killGroup(child); fs.rmSync(profile, { recursive: true, force: true }); },
  };
}

async function webkit() {
  const port = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bloomy-wk-"));
  const env = cleanEnv({ XDG_CONFIG_HOME: `${home}/config`, XDG_DATA_HOME: `${home}/data`, XDG_CACHE_HOME: `${home}/cache`, XDG_STATE_HOME: `${home}/state`,
    GSETTINGS_BACKEND: "keyfile", GDK_BACKEND: "x11", GTK_A11Y: "none", WEBKIT_DISABLE_DMABUF_RENDERER: "1", LIBGL_ALWAYS_SOFTWARE: "1" });
  // a tall private screen, so a window of any page height fits; nothing opens on the real display
  const child = spawn("dbus-run-session", ["--", "xvfb-run", "-a", "-s", "-screen 0 1700x6000x24", "WebKitWebDriver", "--host=127.0.0.1", `--port=${port}`], { env, stdio: "ignore", detached: true });
  const api = `http://127.0.0.1:${port}`;
  const call = async (method, p, body) => { const r = await fetch(api + p, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${p}: ${j.value?.message ?? r.status}`); return j.value; };
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await sleep(500); up = await fetch(`${api}/status`).then((r) => r.ok).catch(() => false); }
  if (!up) { killGroup(child); throw new Error("WebKitWebDriver did not start (is webkitgtk6.0 installed? xvfb-run? dbus-run-session?)"); }
  const caps = { capabilities: { alwaysMatch: { browserName: "MiniBrowser", "webkitgtk:browserOptions": { binary: "/usr/libexec/webkitgtk-6.0/MiniBrowser", args: ["--automation"] } } } };
  const session = (await call("POST", "/session", caps)).sessionId;
  const s = (p) => `/session/${session}${p}`;
  return {
    name: "WebKit (MiniBrowser)", version: "WebKitGTK",
    errors: () => [], // classic WebDriver has no console log
    resize: (w, h) => call("POST", s("/window/rect"), { x: 0, y: 0, width: w, height: h }),
    goto: (url) => call("POST", s("/url"), { url }),
    eval: async (fn) => {
      const script = `const done = arguments[arguments.length - 1]; (async () => { ${PRE} return JSON.stringify(await (${fn.toString()})()); })().then(done, (e) => done("__PAGE_ERROR__" + e));`;
      const out = await call("POST", s("/execute/async"), { script, args: [] });
      if (typeof out === "string" && out.startsWith("__PAGE_ERROR__")) throw new Error(`page script failed: ${out.slice(14, 200)}`);
      return JSON.parse(out);
    },
    shot: async (file) => { fs.writeFileSync(file, Buffer.from(await call("GET", s("/screenshot")), "base64")); },
    close: async () => { try { await call("DELETE", s("")); } catch { /* closing */ } killGroup(child); fs.rmSync(home, { recursive: true, force: true }); },
  };
}

// ============================================================ the pages' measurements (run inside the browser)
const measureListing = async () => {
  await waitFor(() => document.querySelectorAll("#product-grid .product-card").length > 0);
  const bar = q("#pagination");
  const nums = bar ? [...bar.querySelectorAll(".pagination__btn")].filter((b) => /^\d+$/.test(b.textContent)) : [];
  return {
    width: innerWidth, cols: getComputedStyle(q("#product-grid")).gridTemplateColumns.trim().split(/\s+/).length,
    cards: document.querySelectorAll("#product-grid .product-card").length, count: q("#result-count")?.textContent,
    barHidden: !bar || bar.hidden, pages: nums.length, barRows: new Set(bar ? [...bar.querySelectorAll(".pagination__btn")].map((b) => b.offsetTop) : []).size,
    overflow: overflow(), off: offenders(), broken: broken(), bloomy: typeof window.Bloomy, ready: document.body.classList.contains("is-ready"),
  };
};
const clickPage2 = async () => {
  const btn = q('#pagination [data-page="2"]');
  const reach = reachable(btn);
  const before = scrollY;
  btn.click();
  await waitFor(() => q('#pagination [aria-current="page"]')?.textContent === "2");
  await sleep(400);
  return { reach, url: location.search, current: q('#pagination [aria-current="page"]')?.textContent, cards: document.querySelectorAll("#product-grid .product-card").length, scrolled: scrollY > 0, gridTop: Math.round(q(".listing-grid-section").getBoundingClientRect().top), before };
};
const measureFilter = async () => {
  await waitFor(() => document.querySelectorAll("#product-grid .product-card").length > 0);
  const groups = [...document.querySelectorAll(".tag-group")].map((g) => g.getAttribute("aria-label"));
  return { count: q("#result-count")?.textContent, groups, panelOpen: !q("#tag-filters")?.hidden, overflow: overflow(), off: offenders(), checked: [...document.querySelectorAll('.tag-chip[aria-pressed="true"]')].map((c) => c.textContent) };
};
const measureProduct = async () => {
  await waitFor(() => q("#product-name")?.textContent.trim());
  const sizes = document.querySelectorAll("#size-picker .size-picker__option").length;
  const add = q("#add-to-cart");
  const reach = reachable(add);
  add.click();
  await waitFor(() => JSON.parse(localStorage.getItem("bloomy_cart_v2") || "[]").length > 0, 3000);
  await sleep(300);
  return { name: q("#product-name").textContent.trim(), sizes, price: q("#product-price")?.textContent.trim(), reach, cart: JSON.parse(localStorage.getItem("bloomy_cart_v2") || "[]").length,
    badge: [...document.querySelectorAll("[data-cart-count]")].map((e) => e.textContent.trim()).join(","), overflow: overflow(), off: offenders(), broken: broken(), bloomy: typeof window.Bloomy };
};
const measureCart = async () => {
  await waitFor(() => !q("#cart-contents")?.hidden || !q("#cart-empty")?.hidden);
  await sleep(1200); // as in the checkout: let the price request finish before leaving
  return { shown: !q("#cart-contents")?.hidden, empty: !q("#cart-empty")?.hidden, lines: document.querySelectorAll("#cart-items-list > *").length, total: q("#cart-total")?.textContent.trim(), checkout: !!q("#checkout-btn"), overflow: overflow(), off: offenders(), broken: broken() };
};
const measureCheckout = async () => {
  await waitFor(() => !q("#checkout-form-view")?.hidden || !q("#checkout-empty")?.hidden);
  await sleep(1200); // let the price request finish: leaving the page at once cancels it, and Firefox logs that as an error
  return { form: !q("#checkout-form-view")?.hidden, fields: document.querySelectorAll("#checkout-form-view input, #checkout-form-view select").length, overflow: overflow(), off: offenders(), bloomy: typeof window.Bloomy };
};
const measureHome = async () => { await sleep(600); return { overflow: overflow(), off: offenders(), broken: broken(), bloomy: typeof window.Bloomy, title: document.title }; };

// every other customer page, found rather than listed: the sitemap's pages (static pages, the blog and its posts, the
// landing page), the sign-in page, an order page for a made-up token, and a VARIETY of product pages (by status, type,
// style and one size or several). Only "no horizontal scroll, the scripts ran, no broken picture" is checked on them
// (the pages above get more).
async function sweepPages(api, done) {
  const sitemap = await (await fetch(`${BASE}/sitemap.xml`)).text();
  const fromMap = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => new URL(m[1]).pathname + new URL(m[1]).search).filter((x) => !x.startsWith("/product.html"));
  const list = await api("/api/products");
  const maxId = Math.max(...list.map((p) => p.id)) + 3;
  const seen = new Map();
  for (let id = 1; id <= maxId; id++) {
    const d = await fetch(`${BASE}/api/products/${id}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!d) continue;
    const key = `${d.status}|${d.product_type}|${d.style}|${d.sizes.length > 1 ? "sizes" : "one"}`;
    if (!seen.has(key)) seen.set(key, d.id);
  }
  const products = [...seen.values()].map((id) => `/product.html?id=${id}`);
  const pages = [...new Set([...fromMap, "/admin-login.html", "/order-confirmation.html?token=zz-fake-token-0123456789", ...products])].filter((x) => !done.includes(x));
  return { pages, products: seen.size };
}

// ============================================================ the checks
const results = [];
async function runBrowser(driver, site) {
  const log = (name, cond, extra = "") => { results.push({ browser: driver.name, name, ok: Boolean(cond) }); console.log(`${cond ? "ok  " : "FAIL"}  ${driver.name} :: ${name}${!cond && extra ? " :: " + extra : ""}`); };
  const shot = async (tag) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await driver.shot(path.join(SHOTS, `${driver.name.split(" ")[0].toLowerCase()}-${tag}.png`)).catch(() => {}); } };
  const api = async (p) => (await fetch(BASE + p)).json(); // the data comes from the server directly; the pages come through `site`
  const ev = (fn) => driver.eval(fn).catch((e) => ({ __error: e.message }));
  const all = await api("/api/products");
  const first = await api("/api/products?page=1");
  const pages = first.pages;
  const withSizes = all.find((p) => p.has_sizes) ?? all[0];
  const extraProducts = [all.find((p) => !p.has_sizes && p.product_type === "standard" && p.status === "available"), all.find((p) => p.has_sizes && p.id !== withSizes.id && p.category_id !== withSizes.category_id)].filter(Boolean).map((p) => p.id);
  const valentine = (await api("/api/tags")).groups.find((g) => g.kind === "occasion")?.tags.find((t) => t.name === "Valentine");
  const sweep = await sweepPages(api, ["/", "/products.html", "/cart.html", "/checkout.html"]);
  const valentineCount = valentine ? (await api(`/api/products?tag=${valentine.id}`)).length : null;

  for (const vp of VIEWPORTS) {
    const tag = (s) => `${vp.name} ${vp.width}px: ${s}`;
    await driver.resize(vp.width, vp.height);
    await driver.goto(`${site}/`);
    await ev(() => { localStorage.clear(); return 1; });
    const home = await ev(measureHome);
    log(tag("home: no horizontal scroll, the scripts ran, no broken picture"), home.overflow <= 0 && home.bloomy === "object" && home.broken === 0, JSON.stringify(home));
    await shot(`${vp.name}-home`);

    await driver.goto(`${site}/products.html`);
    const list = await ev(measureListing);
    log(tag(`list: ${vp.width > 900 ? 4 : 2} columns, 20 cards, the count is the total`), list.cols === (vp.width > 900 ? 4 : 2) && list.cards === 20 && list.count === String(first.total), JSON.stringify(list));
    log(tag("list: no horizontal scroll, scripts ran, no broken picture"), list.overflow <= 0 && list.bloomy === "object" && list.ready && list.broken === 0, JSON.stringify(list));
    log(tag(`list: the page bar shows ${pages} pages on ONE line`), !list.barHidden && list.pages === pages && list.barRows === 1, JSON.stringify(list));
    await shot(`${vp.name}-list`);
    const p2 = await ev(clickPage2);
    log(tag("list: page 2 opens (a click at the button's real position reaches it), 20 cards, ?page=2"), p2.reach && p2.current === "2" && p2.url?.includes("page=2") && p2.cards === 20, JSON.stringify(p2));
    log(tag("list: the page scrolled back to the grid after the click"), p2.scrolled && p2.gridTop < vp.height / 2, JSON.stringify(p2));
    await shot(`${vp.name}-list-page2`);

    if (valentine) {
      await driver.goto(`${site}/products.html?tag=${valentine.id}`);
      const f = await ev(measureFilter);
      log(tag(`filter: Valentine lists ${valentineCount}, its chip is on, the "Dịp" group is there, the panel is open`), f.count === String(valentineCount) && f.checked?.includes("Valentine") && f.groups?.includes("Dịp") && f.panelOpen, JSON.stringify(f));
      log(tag("filter: no horizontal scroll"), f.overflow <= 0, JSON.stringify(f));
      await shot(`${vp.name}-filter`);
    }

    await driver.goto(`${site}/product.html?id=${withSizes.id}`);
    const prod = await ev(measureProduct);
    log(tag("product: name, sizes and a price in dong are shown"), (prod.name?.length ?? 0) > 0 && prod.sizes >= 2 && /đ/.test(prod.price ?? ""), JSON.stringify(prod));
    log(tag("product: the add button is reachable, adds one line, the cart badge says 1"), prod.reach && prod.cart === 1 && prod.badge?.split(",").includes("1"), JSON.stringify(prod));
    log(tag("product: no horizontal scroll, scripts ran, no broken picture"), prod.overflow <= 0 && prod.bloomy === "object" && prod.broken === 0, JSON.stringify(prod));
    await shot(`${vp.name}-product`);
    let lines = 1;
    for (const id of extraProducts) { // more lines make the cart and checkout pages heavier
      await driver.goto(`${site}/product.html?id=${id}`);
      const more = await ev(measureProduct);
      if (more.cart === lines + 1) lines++;
    }

    await driver.goto(`${site}/cart.html`);
    const cart = await ev(measureCart);
    log(tag(`cart: the ${lines} line${lines > 1 ? "s are" : " is"} there with a total and a checkout button`), cart.shown && cart.lines === lines && /đ/.test(cart.total ?? "") && cart.checkout, JSON.stringify(cart));
    log(tag("cart: no horizontal scroll, no broken picture"), cart.overflow <= 0 && cart.broken === 0, JSON.stringify(cart));
    await shot(`${vp.name}-cart`);

    await driver.goto(`${site}/checkout.html`);
    const co = await ev(measureCheckout);
    log(tag("checkout: the form is shown (with items in the cart), no horizontal scroll"), co.form && co.fields >= 6 && co.overflow <= 0 && co.bloomy === "object", JSON.stringify(co));
    await shot(`${vp.name}-checkout`);

    const bad = [];
    for (const page of sweep.pages) {
      await driver.goto(`${site}${page}`);
      const m = await ev(measureHome);
      // (admin pages never load main.js, so window.Bloomy is not expected there)
      if (!(m.overflow <= 0 && (m.bloomy === "object" || page.startsWith("/admin-")) && m.broken === 0)) bad.push(`${page} ${JSON.stringify({ o: m.overflow, off: m.off, b: m.bloomy, br: m.broken, err: m.__error })}`);
      await shot(`${vp.name}-sweep-${page.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "")}`);
    }
    log(tag(`the other ${sweep.pages.length} pages (sitemap, blog, sign-in, order page, ${sweep.products} kinds of product page): no horizontal scroll, scripts ran, no broken picture`), bad.length === 0, bad.join(" | "));
  }
  const errs = driver.errors();
  if (driver.name === "Firefox") log("no JavaScript error in the browser's log on any page", errs.length === 0, errs.slice(0, 3).join(" | "));
}

// ============================================================ go
try { const r = await fetch(`${BASE}/healthz`); if (!r.ok) throw new Error(String(r.status)); }
catch (e) { console.error(`cross_browser_check: no Bloomy server answers at ${BASE} (${e.message}). Start one first.`); process.exit(2); }

const wanted = [["firefox", firefox], ["webkit", webkit]].filter(([n]) => !ONLY || ONLY === n);
if (wanted.length === 0) { console.error(`cross_browser_check: --only takes firefox or webkit`); process.exit(2); }
for (const [name, start] of wanted) {
  let driver = null, proxy = null;
  try {
    driver = await start();
    proxy = name === "webkit" ? await proxyTo(BASE) : null;
    console.log(`\n== ${driver.name}${proxy ? " (through the CSP proxy, see the header)" : ""} ==`);
    await runBrowser(driver, proxy ? proxy.url : BASE);
  } catch (e) {
    results.push({ browser: name, name: "the browser ran the checks", ok: false });
    console.log(`FAIL  ${name} :: could not run: ${e.message}`);
  } finally { if (driver) await driver.close(); if (proxy) await proxy.close(); }
}
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed (${[...new Set(results.map((r) => r.browser))].join(", ")})`);
process.exit(bad.length ? 1 : 0);
