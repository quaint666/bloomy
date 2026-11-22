// The quality-of-life changes, checked as far as a DOM can:
//   A. the stylesheet rules (nothing to run: the CSS files are read)
//        - the motion block is scoped to customer pages, short, and does not override reduced-motion
//        - every duration is a --motion-* token (a typed number in a customer stylesheet fails); the page cross-fade rules
//        - the category filter bar is see-through like the header, its underline is 3px
//   A2. no customer stylesheet has a bare `fr` grid column (it cannot shrink: sideways scroll on a phone)
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
  // The durations are tokens (--motion-* in :root); read them, then look at what each rule resolves to.
  const tokens = Object.fromEntries([...stripComments(style).matchAll(/--(motion-[a-z]+):\s*(\d+)ms/g)].map((m) => [m[1], Number(m[2]) / 1000]));
  check("the motion tokens exist (press, fast, base, slow, enter, page, stagger)", ["motion-press", "motion-fast", "motion-base", "motion-slow", "motion-enter", "motion-page", "motion-stagger"].every((n) => n in tokens), JSON.stringify(tokens));
  const resolved = block.replace(/var\(--(motion-[a-z]+)\)/g, (_m, n) => `${tokens[n] ?? "NaN"}s`);
  const secs = [...resolved.matchAll(/(?:animation|transition)(?:-duration)?:[^;]*?(\d*\.?\d+)(ms|s)\b/g)].map((m) => (m[2] === "ms" ? Number(m[1]) / 1000 : Number(m[1])));
  check("every duration in the motion block is half a second or less", secs.length >= 6 && secs.every((s) => s <= 0.5), JSON.stringify(secs));
  // Enforced: a customer stylesheet never types a duration; it uses a token. Exempt: the loading shimmer (a loop, not an
  // interaction), the footer failsafe (a timer, not motion) and the reduced-motion rule's 0.01ms. Admin stylesheets are exempt.
  const rawDurations = [];
  for (const f of fs.readdirSync(path.join(ROOT, "public", "css")).filter((n) => n.endsWith(".css") && !n.startsWith("admin"))) {
    stripComments(css(f)).split("\n").forEach((line, i) => {
      if (/(?:^|[\s{;])(?:transition|animation)(?:-duration|-delay)?\s*:/.test(line) && /\d(?:ms|s)\b/.test(line) && !/shimmer|failsafe|0\.01ms/.test(line)) rawDurations.push(`${f}:${i + 1}`);
    });
  }
  check("no customer stylesheet types a duration: every transition and animation uses a --motion-* token", rawDurations.length === 0, rawDurations.join(", "));
  // The page cross-fade: on for customer pages without reduce-motion, short, the header stays put, admin pages opt out.
  const fadeStyle = stripComments(style), fadeAdmin = stripComments(css("admin.css"));
  check("page cross-fade: opted into only under no-preference, over --motion-page (group, old and new: the group alone otherwise holds the fade open for 250 ms), with the header named so it stays put", /@media \(prefers-reduced-motion: no-preference\)\s*\{\s*@view-transition\s*\{\s*navigation:\s*auto;?\s*\}[^@]*::view-transition-group\(\*\),\s*::view-transition-old\(\*\),\s*::view-transition-new\(\*\)\s*\{\s*animation-duration:\s*var\(--motion-page\);?\s*\}\s*\.site-nav\s*\{\s*view-transition-name:\s*site-nav;?\s*\}/.test(fadeStyle) && (fadeStyle.match(/@view-transition/g) || []).length === 1);
  check("page cross-fade: it is short (the page ignores clicks while it plays): --motion-page is 200 ms or less", tokens["motion-page"] <= 0.2, String(tokens["motion-page"]));
  // ---- The pink. --primary (the soft one) is for fills and LARGE text; --primary-text (deeper) is for small text and for a button
  // with white text. The token values are checked against WCAG AA here (computed from the stylesheet itself), and a rule that sets
  // the soft pink as a small-text colour or as a fill under white text fails. Heading accents (`... em`) and the one big numeral
  // are the large-text exceptions; the four fills below carry no text.
  const hslTok = (name) => { const m = stripComments(style).match(new RegExp(`--${name}:\\s*(\\d+(?:\\.\\d+)?) (\\d+(?:\\.\\d+)?)% (\\d+(?:\\.\\d+)?)%`)); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
  const toRgb = ([h, sat, l]) => { sat /= 100; l /= 100; const k = (n) => (n + h / 30) % 12, a = sat * Math.min(l, 1 - l); const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)); return [f(0), f(8), f(4)].map((v) => Math.round(v * 255)); };
  const relLum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (a, b) => { const x = relLum(a), y = relLum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const white = [255, 255, 255], softPink = hslTok("primary"), textPink = hslTok("primary-text"), hoverPink = hslTok("primary-text-hover"), cream = hslTok("secondary");
  const have = softPink && textPink && hoverPink && cream;
  const cr = (fg, bg) => (have ? contrast(toRgb(fg), toRgb(bg)) : 0);
  check("pink: --primary is 3:1 or better on white and on the cream sections (large text and fills)", have && cr(softPink, [0, 0, 100]) >= 3 && cr(softPink, cream) >= 3, have ? `${cr(softPink, [0, 0, 100]).toFixed(2)} / ${cr(softPink, cream).toFixed(2)}` : "token missing");
  check("pink: --primary-text is 4.5:1 or better on white and on cream (small text), and white text on it too", have && cr(textPink, [0, 0, 100]) >= 4.5 && cr(textPink, cream) >= 4.5, have ? `${cr(textPink, [0, 0, 100]).toFixed(2)} / ${cr(textPink, cream).toFixed(2)}` : "token missing");
  check("pink: white text on --primary-text-hover (the button under the mouse) is 4.5:1 or better", have && cr([0, 0, 100], hoverPink) >= 4.5, have ? cr([0, 0, 100], hoverPink).toFixed(2) : "token missing");
  const parseRules = (src) => [...stripComments(src).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim().replace(/\s+/g, " "), body: m[2] }));
  const FILL_OK = new Set([".reading-progress__bar", ".hero__badge::before", '.tag-chip[aria-pressed="true"]::before', ".timeline__dot"]);
  const softText = [], softFill = [];
  for (const f of fs.readdirSync(path.join(ROOT, "public", "css")).filter((n) => n.endsWith(".css") && !n.startsWith("admin"))) {
    for (const { sel, body } of parseRules(css(f))) {
      if (/(?:^|[;\s])color:\s*hsl\(var\(--primary\)\)/.test(body) && !(/(^|\s)em$/.test(sel) || sel === ".about-stat__number")) softText.push(`${f}: ${sel}`);
      if (/background(?:-color)?:\s*hsl\(var\(--primary\)(?:\s*\/\s*0\.9)?\)/.test(body) && !FILL_OK.has(sel)) softFill.push(`${f}: ${sel}`);
    }
  }
  check("pink: small text uses --primary-text; the soft --primary is only a heading accent (`em`) or the big numeral", softText.length === 0, softText.slice(0, 4).join(" | "));
  check("pink: a fill under white text uses --primary-text (the soft --primary is a fill only for the four decorative bits)", softFill.length === 0, softFill.slice(0, 4).join(" | "));
  // ---- The home hero: the photo in an arch beside the text, on a blush-to-peach wash. The text never sits on the photo, so its
  // contrast is a calculation from the two ends of the wash (not a guess about a picture).
  const publicFile = (f) => fs.readFileSync(path.join(ROOT, "public", f), "utf8");
  const heroDoc = new JSDOM(publicFile("index.html")).window.document;
  const heroArch = heroDoc.querySelector(".hero__arch"), heroNote = heroDoc.querySelector(".hero__note");
  check("hero: the photo has alt text and its size (the page does not jump while it loads), and no scrim is left over it", !!heroArch && (heroArch.getAttribute("alt") || "").length > 0 && heroArch.hasAttribute("width") && heroArch.hasAttribute("height") && !heroDoc.querySelector(".hero__scrim, .hero__bg"));
  check("hero: the note is a link to the custom bouquet page, and that page does have the message step the note promises", !!heroNote && heroNote.getAttribute("href") === "custom-bouquet.html" && /Lời nhắn/.test(publicFile("custom-bouquet.html")) && /lời nhắn/i.test(heroNote.textContent || ""));
  const homeCss = stripComments(css("home.css"));
  const heroTok = (n) => { const m = homeCss.match(new RegExp(`--${n}:\\s*(\\d+(?:\\.\\d+)?) (\\d+(?:\\.\\d+)?)% (\\d+(?:\\.\\d+)?)%`)); return m ? m.slice(1, 4).map(Number) : null; };
  const blush = heroTok("hero-blush"), peach = heroTok("hero-peach"), mutedFg = hslTok("muted-foreground");
  const heroOk = !!(blush && peach && mutedFg && textPink && [blush, peach].every((bg) => cr(textPink, bg) >= 4.5 && cr(mutedFg, bg) >= 4.5));
  check("hero: the pink small text and the muted text pass AA (4.5:1) on both ends of the wash", heroOk, heroOk ? "" : "token missing or too light");
  check("hero: the text column is never wider than the page: its grid columns are minmax(0, ...) and the arch has a fixed aspect ratio", /\.hero__grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,/.test(homeCss) && /\.hero__arch\s*\{[^}]*aspect-ratio:\s*460\s*\/\s*524/.test(homeCss));
  const adminPages = fs.readdirSync(path.join(ROOT, "public")).filter((f) => /^admin-.*\.html$/.test(f));
  const adminOrder = adminPages.filter((f) => { const h = fs.readFileSync(path.join(ROOT, "public", f), "utf8"); return h.indexOf("css/style.css") >= 0 && h.indexOf("css/admin.css") > h.indexOf("css/style.css"); });
  check("page cross-fade: admin.css opts out (navigation: none) and every admin page loads it after style.css, so the later rule wins", /@view-transition\s*\{\s*navigation:\s*none;?\s*\}/.test(fadeAdmin) && adminPages.length >= 14 && adminOrder.length === adminPages.length, `${adminOrder.length}/${adminPages.length}`);
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
  // The admin pages on a phone (found with a real Firefox and WebKit at 390 px: the sign-out button sat off the screen and six pages were
  // 120 to 410 px wider than it). jsdom cannot see layout, so these pin the rules that fixed it; the browser pass looks at the result.
  const adminMedia = (query) => { const out = []; let at = admin.indexOf(`@media (${query}) {`); while (at >= 0) { let depth = 0, k = admin.indexOf("{", at); const start = k; for (; k < admin.length; k++) { if (admin[k] === "{") depth++; else if (admin[k] === "}" && --depth === 0) break; } out.push(admin.slice(start, k)); at = admin.indexOf(`@media (${query}) {`, k); } return out.join("\n"); };
  const narrow = adminMedia("max-width: 640px");
  check("admin.css: at 640 px the admin bar wraps (the sign-out button stays on the screen) and who is signed in takes its own line", /\.admin-nav__inner\s*\{[^}]*flex-wrap:\s*wrap/.test(narrow) && /\.admin-nav__who\s*\{[^}]*flex-basis:\s*100%/.test(narrow));
  check("admin.css: at 900 px an admin table scrolls inside the page instead of widening it", /\.admin-table\s*\{[^}]*display:\s*block[^}]*overflow-x:\s*auto/.test(adminMedia("max-width: 900px")));
  check("admin.css: the page header wraps (title, search and button do not fit one line on a phone)", /\.admin-page__header\s*\{[^}]*flex-wrap:\s*wrap/.test(admin));
  check("admin.css: the POS layout is one column of minmax(0, 1fr) on a narrow screen, never a bare 1fr", /\.pos-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(adminMedia("max-width: 900px")) && !/\.pos-layout\s*\{[^}]*grid-template-columns:\s*1fr\s*;/.test(adminMedia("max-width: 900px")));
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
  const rule = (sel) => (listing.match(new RegExp(`(?:^|\\})\\s*${sel.replace(/[.\[\]()\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`)) || [])[1] || "";
  const bar = rule(".listing-filters");
  check("the category bar is see-through and blurred like the header (80% background, backdrop blur)", /background-color:\s*hsl\(var\(--background\)\s*\/\s*0\.8\)/.test(bar) && /backdrop-filter:\s*blur\(12px\)/.test(bar) && /-webkit-backdrop-filter:\s*blur\(12px\)/.test(bar), bar.replace(/\s+/g, " "));
  const header = stripComments(style).match(/\.site-nav\s*\{([^}]*)\}/)[1];
  check("…using the same alpha and blur as the header, so they read as one glass", header.includes("hsl(var(--background) / 0.8)") && header.includes("blur(12px)"));
  const pill = rule(".pill");
  check("the tab underline is 3px (was 2px)", /border-bottom:\s*3px solid transparent/.test(pill), pill.replace(/\s+/g, " "));
  check("…the active tab's underline is still the brand colour", /\.pill\.is-active[^{]*\{[^}]*border-bottom-color:\s*hsl\(var\(--primary\)\)/.test(listing));
  check("…and the bar keeps its height (one pixel less padding below)", /padding:\s*16px 2px 13px/.test(pill));
}

// ============================================================ A2. no bare fr grid column on a customer page
// A bare `1fr` track cannot shrink below the min-content of what is in it, so a wide photo or a form pushes the whole
// page sideways on a phone (the cart and checkout did, found in Firefox and WebKit). `minmax(0, 1fr)` can shrink and
// otherwise lays out exactly the same. The admin stylesheets (staff pages, behind a login) are not held to this.
{
  const bareFr = (value) => { // does a bare `<n>fr` track appear outside minmax(...)? (parentheses are followed, so repeat(3, 1fr) counts and minmax(0, 1fr) does not)
    const stack = [];
    for (let i = 0; i < value.length; i++) {
      const c = value[i];
      if (c === "(") stack.push((value.slice(0, i).match(/([\w-]+)\s*$/) || [])[1] || "");
      else if (c === ")") stack.pop();
      else {
        const m = value.slice(i).match(/^\d*\.?\d+fr\b/);
        if (m && !/[\w.-]/.test(value[i - 1] || " ")) { if (!stack.includes("minmax")) return true; i += m[0].length - 1; }
      }
    }
    return false;
  };
  const blank = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")); // comments out, line numbers kept
  const found = [];
  for (const f of fs.readdirSync(path.join(ROOT, "public", "css")).filter((x) => x.endsWith(".css") && !x.startsWith("admin"))) {
    const src = blank(css(f));
    for (const m of src.matchAll(/grid-template-columns\s*:\s*([^;{}]+);/g)) if (bareFr(m[1])) found.push(`${f}:${src.slice(0, m.index).split("\n").length} ${m[0].trim()}`);
  }
  check("no customer stylesheet has a bare fr grid column (write minmax(0, 1fr))", found.length === 0, found.slice(0, 4).join(" | ") + (found.length > 4 ? ` ... (${found.length})` : ""));
  check("the bare-fr reader: finds 1fr, 1.6fr and repeat(3, 2fr); accepts minmax(0, 1fr), minmax(220px, 1fr), repeat(2, minmax(0, 1fr)) and auto-fill with min()",
    bareFr("1fr") && bareFr("96px 1.6fr") && bareFr("repeat(3, 2fr)") && !bareFr("minmax(0, 1fr)") && !bareFr("minmax(220px, 1fr) 96px") && !bareFr("repeat(2, minmax(0, 1fr))") && !bareFr("repeat(auto-fill, minmax(min(100%, 200px), 1fr))"));
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
