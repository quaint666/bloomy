// Google Analytics 4 as far as it can be checked without Google: the security headers that let it run (and no
// more), which pages load it, what the loader does on the real site's address and what it does everywhere else,
// and that the order-confirmation token never reaches it.
//
// Run from the repo root with the server running (no database access is needed or used):
//   BASE=http://localhost:3000 node tests/analytics_test.mjs
//
// Proves: the Content-Security-Policy allows Google's hosts for the plain GA4 tag and nothing broader, the
// Referrer-Policy stays no-referrer, the loader runs only on the real site's hostname (so local browsing and the
// tests never reach the real property), builds no inline script, cleans the confirmation address and referrer, and
// the Measurement ID lives in one place. privacy.html mentions it.
// Does NOT prove: that Google receives anything, that a real browser's CSP lets every request through (open the
// browser console on the real site after deploying: a "Refused to ..." line means a host is missing), or anything
// about the Analytics property's own settings.

import fs from "node:fs";
import path from "node:path";
import jsdom from "jsdom";
const { JSDOM } = jsdom;

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const ROOT = process.cwd();
let passed = 0, failed = 0;
function check(name, cond, extra = "") { if (cond) passed++; else { failed++; console.log(`FAIL ${name}${extra ? " :: " + extra : ""}`); } }
const get = (p, opts) => fetch(BASE + p, { redirect: "manual", ...opts });
const ID = "G-SJ1XV11XC2";
const REAL_HOST = "bloomy.quaintshomelabdomain.uk";

// ---------------------------------------------------------------- 1. the headers
{
  const directive = (csp, name) => (csp.split(";").map((s) => s.trim()).find((s) => s.startsWith(name + " ")) || "").slice(name.length + 1).split(/\s+/).filter(Boolean).sort();
  for (const p of ["/", "/checkout.html", "/blog", "/admin-login.html"]) {
    const r = await get(p);
    const csp = r.headers.get("content-security-policy") || "";
    check(`${p}: script-src is 'self' plus the Google Tag Manager host, nothing else`, JSON.stringify(directive(csp, "script-src")) === JSON.stringify(["'self'", "https://www.googletagmanager.com"].sort()), csp);
    check(`${p}: img-src is 'self', data: and Google's two image hosts`, JSON.stringify(directive(csp, "img-src")) === JSON.stringify(["'self'", "data:", "https://*.google-analytics.com", "https://*.googletagmanager.com"].sort()));
    check(`${p}: connect-src is 'self' plus the three hosts Google lists for GA4`, JSON.stringify(directive(csp, "connect-src")) === JSON.stringify(["'self'", "https://*.google-analytics.com", "https://*.analytics.google.com", "https://*.googletagmanager.com"].sort()));
    check(`${p}: nothing was loosened (default-src, style-src, font-src and script-src-attr unchanged; no unsafe-inline / unsafe-eval / bare *)`,
      JSON.stringify(directive(csp, "default-src")) === JSON.stringify(["'self'"]) && JSON.stringify(directive(csp, "style-src")) === JSON.stringify(["'self'"]) && JSON.stringify(directive(csp, "font-src")) === JSON.stringify(["'self'"]) && JSON.stringify(directive(csp, "script-src-attr")) === JSON.stringify(["'none'"]) && !/unsafe-inline|unsafe-eval|\s\*(\s|;|$)/.test(csp));
    check(`${p}: no advertising hosts are allowed (doubleclick, googlesyndication, googleadservices, or any google.com other than analytics.google.com)`, !/doubleclick|googlesyndication|googleadservices|(?<!analytics\.)google\.com/.test(csp));
    check(`${p}: Referrer-Policy is no-referrer`, r.headers.get("referrer-policy") === "no-referrer", r.headers.get("referrer-policy"));
  }
  const conf = await get("/order-confirmation.html?token=abc");
  check("the order-confirmation page (which carries a secret token) is sent with no-referrer too", conf.headers.get("referrer-policy") === "no-referrer");
}

// ---------------------------------------------------------------- 2. which pages load main.js (and so the loader)
{
  const customer = ["/", "/products.html", "/product.html?id=9", "/cart.html", "/checkout.html", "/order-confirmation.html", "/about.html", "/story.html", "/commitment.html", "/custom-bouquet.html", "/terms.html", "/privacy.html", "/landing", "/blog"];
  const posts = JSON.parse(fs.readFileSync(path.join(ROOT, "content", "posts.json"), "utf8")).map((p) => `/blog/${p.slug}`);
  const missing = [], inline = [];
  for (const p of [...customer, ...posts]) {
    const r = await get(p);
    if (r.status >= 300) continue; // /landing redirects when no campaign is on
    const d = new JSDOM(await r.text()).window.document;
    if (![...d.querySelectorAll("script[src]")].some((s) => /(^|\/)js\/main\.js(\?v=[0-9a-f]{8})?$/.test(s.getAttribute("src")))) missing.push(p);
    if ([...d.querySelectorAll("script:not([src])")].some((s) => !/ld\+json/.test(s.type))) inline.push(p);
  }
  check("every customer page, the landing page and the blog load js/main.js (so they all report)", missing.length === 0, missing.join(", "));
  check("no customer page has an inline script (the CSP would refuse it)", inline.length === 0, inline.join(", "));
  const adminPages = fs.readdirSync(path.join(ROOT, "public")).filter((f) => /^admin-.*\.html$/.test(f));
  const adminWithMain = adminPages.filter((f) => /js\/main\.js/.test(fs.readFileSync(path.join(ROOT, "public", f), "utf8")));
  check("no admin page loads js/main.js (staff are never counted)", adminPages.length >= 10 && adminWithMain.length === 0, adminWithMain.join(", "));
}

// ---------------------------------------------------------------- 3. one place for the Measurement ID
{
  const found = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(html|js|css|json)$/.test(e.name) && fs.readFileSync(p, "utf8").includes(ID)) found.push(path.relative(ROOT, p)); } };
  walk(path.join(ROOT, "public")); walk(path.join(ROOT, "content")); walk(path.join(ROOT, "partials"));
  check("the Measurement ID appears in public/js/main.js and nowhere else in what is served", found.join() === path.join("public", "js", "main.js"), found.join());
}

// ---------------------------------------------------------------- 4. what the loader does, where
const mainJs = await (await get("/js/main.js")).text();
const page = await (await get("/")).text();
function run(url, referrer) {
  const dom = new JSDOM(page, { url, referrer, runScripts: "outside-only" });
  const w = dom.window;
  w.eval(mainJs);
  const layer = (w.dataLayer || []).map((a) => Array.from(a));
  const loaders = [...w.document.querySelectorAll("script")].filter((s) => /googletagmanager/.test(s.src || ""));
  const inlineBefore = [...new JSDOM(page).window.document.querySelectorAll("script:not([src])")].length;
  const inlineNow = [...w.document.querySelectorAll("script:not([src])")].length;
  return { w, layer, loaders, config: layer.find((a) => a[0] === "config"), js: layer.find((a) => a[0] === "js"), inlineAdded: inlineNow - inlineBefore };
}
{
  for (const url of ["http://127.0.0.1:3998/index.html", "http://localhost:3000/", `https://${REAL_HOST}.evil.example/`, `https://www.${REAL_HOST}/`, "https://example.com/", `https://evil.example/${REAL_HOST}/`]) {
    const r = run(url);
    check(`${url}: nothing loaded, no dataLayer, no gtag`, r.loaders.length === 0 && r.w.dataLayer === undefined && r.w.gtag === undefined);
  }
  const prod = run(`https://${REAL_HOST}/index.html?utm_source=zalo&utm_campaign=20-10`);
  check("real address: one loader script, async, from Google Tag Manager, with our ID", prod.loaders.length === 1 && prod.loaders[0].async === true && prod.loaders[0].src === `https://www.googletagmanager.com/gtag/js?id=${ID}`, prod.loaders.map((s) => s.src).join());
  check("…it was added to <head>, and builds no inline script (the CSP forbids those)", prod.loaders[0].parentElement.tagName === "HEAD" && prod.inlineAdded === 0);
  check("…the data layer holds a 'js' call and a 'config' call for our ID, in that order", prod.layer.length === 2 && prod.layer[0][0] === "js" && prod.layer[0][1] instanceof prod.w.Date && prod.layer[1][0] === "config" && prod.layer[1][1] === ID, JSON.stringify(prod.layer));
  check("…a normal page keeps its full address, utm tags included (that is how campaigns are told apart)", prod.config[2].page_location === `https://${REAL_HOST}/index.html?utm_source=zalo&utm_campaign=20-10`, prod.config[2].page_location);
  check("…Google signals and ad personalisation are off", prod.config[2].allow_google_signals === false && prod.config[2].allow_ad_personalization_signals === false);
  check("…no referrer given → none is sent", !("page_referrer" in prod.config[2]));
  const http = run(`http://${REAL_HOST}/about.html`);
  check("the real hostname over http also reports", http.loaders.length === 1);

  // the secret token
  const conf = run(`https://${REAL_HOST}/order-confirmation.html?token=abc123secretTOKEN`);
  check("order confirmation: the address given to Google has no query string at all", conf.config[2].page_location === `https://${REAL_HOST}/order-confirmation.html`, conf.config[2].page_location);
  check("…and the token appears nowhere in what was handed to Google", !JSON.stringify(conf.layer).includes("abc123secretTOKEN") && !conf.loaders[0].src.includes("abc123"));
  const viaConf = run(`https://${REAL_HOST}/index.html`, `https://${REAL_HOST}/order-confirmation.html?token=abc123secretTOKEN`);
  check("coming from the confirmation page: the referrer is cleaned too", viaConf.config[2].page_referrer === `https://${REAL_HOST}/order-confirmation.html` && !JSON.stringify(viaConf.layer).includes("abc123secretTOKEN"), String(viaConf.config[2].page_referrer));
  const ext = run(`https://${REAL_HOST}/index.html`, "https://www.facebook.com/?fbclid=xyz");
  check("an outside referrer (where the visitor really came from) is passed on as it is", ext.config[2].page_referrer === "https://www.facebook.com/?fbclid=xyz");
  const sub = run(`https://${REAL_HOST}/blog/cach-giu-hoa-tuoi-lau-tai-nha?utm_source=zalo`);
  check("a blog post reports with its address", sub.config[2].page_location.endsWith("/blog/cach-giu-hoa-tuoi-lau-tai-nha?utm_source=zalo"));
}

// ---------------------------------------------------------------- 5. privacy.html says so
{
  const html = await (await get("/privacy.html")).text();
  const text = new JSDOM(html).window.document.body.textContent.replace(/\s+/g, " ");
  check("privacy.html names Google Analytics, says it uses cookies and what it does not receive", text.includes("Google Analytics") && /cookie/.test(text) && text.includes("không nhận họ tên, số điện thoại, địa chỉ"));
  const updated = /Cập nhật lần cuối: (\d{2})\/(\d{2})\/(\d{4})/.exec(text);
  check("…and the page's \"last updated\" date is on or after the day this was added (06/10/2026)", !!updated && `${updated[3]}-${updated[2]}-${updated[1]}` >= "2026-10-06", updated?.[0]);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
