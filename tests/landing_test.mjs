// The landing page and the homepage card as the SERVER sends them (no browser): what they say, that it all comes
// from the database as it is NOW, that nothing typed by the owner can inject markup, and the on/off rules
// (redirects, sitemap, homepage card).
//
// Run from the repo root with the server running on the same database:
//   export DB_HOST=127.0.0.1 DB_PORT=5433 DB_PASSWORD=dev
//   BASE=http://localhost:3000 node tests/landing_test.mjs
//
// It temporarily edits a campaign, its coupon and the active campaign, and starts a second server (with an
// unreachable database) on port 39703. Everything is put back in a finally block. Local or test database only.
//
// Proves: wording and coupon chip follow the database at once (percent/fixed, minimum, window, switched off, ended),
// hostile text is escaped in the page, the head and the card, /landing redirects when no campaign is on and keeps
// the query string, /landing.html goes to /landing, the card and the sitemap entry exist only while a campaign is on,
// and a database outage cannot break the homepage or leave a half-page at /landing.
// Does NOT prove: how any of it looks, or what the page does in a browser (see landing_live_test.mjs).

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import path from "node:path";
import jsdom from "jsdom";
const { JSDOM } = jsdom;

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p, opts) => fetch(BASE + p, { redirect: "manual", ...opts });
const dom = (html) => new JSDOM(html).window.document;
const money = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "đ"; // written independently of render.js
const vnDate = (offsetDays) => new Date(Date.now() + 7 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
const dm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const chipText = (d) => d.querySelector(".campaign-chip__text")?.textContent;
const chipCode = (d) => d.querySelector(".campaign-chip__code")?.textContent;

// Stop early if this script's database is not the server's database.
{
  const row = (await pool.query("SELECT shop_address, contact_phone, contact_email, vat_rate FROM settings")).rows[0];
  const api = await (await get("/api/settings")).json();
  if (!row || row.shop_address !== api.shop_address || row.contact_phone !== api.contact_phone || row.contact_email !== api.contact_email || row.vat_rate !== api.vat_rate) {
    console.log("FAIL this script is connected to a different database than the server at " + BASE + " (settings differ). Export the same DB_HOST / DB_PORT / DB_PASSWORD as the server and run again.");
    process.exit(2);
  }
}

const original = {
  active: (await pool.query("SELECT active_campaign_id FROM settings")).rows[0].active_campaign_id,
  campaigns: (await pool.query("SELECT id, name, headline, subheadline, hero_image, coupon_code FROM campaigns ORDER BY id")).rows,
  coupons: (await pool.query("SELECT code, type, value, min_subtotal, starts_on::text AS starts_on, ends_on::text AS ends_on, active FROM coupons")).rows,
};
const camp = original.campaigns[0];
const coupon = original.coupons.find((c) => c.code === camp.coupon_code);
const setCoupon = (fields) => pool.query(
  "UPDATE coupons SET type=$2, value=$3, min_subtotal=$4, starts_on=$5, ends_on=$6, active=$7 WHERE code=$1",
  [coupon.code, fields.type, fields.value, fields.min_subtotal, fields.starts_on, fields.ends_on, fields.active]);
const baseCoupon = { type: "percent", value: 20, min_subtotal: 0, starts_on: vnDate(1), ends_on: vnDate(10), active: true };

try {
  await pool.query("UPDATE settings SET active_campaign_id=$1", [camp.id]);
  await setCoupon(baseCoupon);

  // ------------------------------------------------------------ 1. the landing page says what the database says
  {
    const r = await get("/landing");
    const html = await r.text();
    const d = dom(html);
    check("/landing is 200 html with no-cache", r.status === 200 && /text\/html/.test(r.headers.get("content-type")) && r.headers.get("cache-control") === "no-cache", `${r.status} ${r.headers.get("cache-control")}`);
    check("…nothing left unfilled (no raw include, no {{token}})", !html.includes("<!--include") && !/\{\{/.test(html));
    check("…title is the campaign's name", d.title === `${camp.name} — Bloomy`, d.title);
    // The ZaloPay view (hidden until an order is placed, and then the hero is hidden) has an h1 of its own: one is visible at a time.
    const visibleH1 = [...d.querySelectorAll("h1")].filter((h) => !h.closest("#payment-waiting"));
    check("…one visible h1: the headline", visibleH1.length === 1 && visibleH1[0].textContent === camp.headline && d.getElementById("payment-waiting").hidden === true);
    check("…the name and subheadline are on the page", d.querySelector(".landing-hero__name").textContent === camp.name && d.querySelector(".landing-hero__sub").textContent === camp.subheadline);
    check("…the meta description and og tags carry the headline", d.querySelector('meta[name="description"]').getAttribute("content") === camp.headline && d.querySelector('meta[property="og:title"]').getAttribute("content") === `${camp.name} — Bloomy`);
    check("…data-coupon holds the coupon's code", d.getElementById("landing-main").dataset.coupon === coupon.code);
    check("…chip: code, discount and the delivery window, from the coupon row", chipCode(d) === coupon.code && chipText(d) === `Giảm 20% · đơn giao từ ${dm(baseCoupon.starts_on)} đến ${dm(baseCoupon.ends_on)}`, chipText(d));
    check("…the shared order form, summary and payment view are on the page", !!d.querySelector("#checkout-form") && !!d.querySelector("#checkout-summary-items") && !!d.querySelector("#payment-waiting") && !!d.querySelector("#checkout-empty"));
    check("…the order form sits inside the page's own wrapper (hidden until the cart has something)", d.querySelector("#checkout-form-view #checkout-form") !== null && d.getElementById("checkout-form-view").hidden === true);
    const scripts = [...d.querySelectorAll("script[src]")].map((s) => s.getAttribute("src").replace(/\?v=[0-9a-f]{8}$/, ""));
    check("…loads main.js first, then landing.js and checkout.js", scripts[0] === "js/main.js" && scripts.slice(1).sort().join() === "js/checkout.js,js/landing.js" && [...d.querySelectorAll("script[src]")].every((s) => s.hasAttribute("defer")), scripts.join());
    check("…no hero photo element when the campaign has none", d.querySelector(".landing-hero__media") === null && d.querySelector(".landing-hero__image") === null);
    check("…the shared header and footer are there", !!d.querySelector("header.site-nav") && !!d.querySelector("footer.site-footer") && !!d.querySelector(".floating-contact"));
  }

  // ------------------------------------------------------------ 2. the chip follows the coupon, and never promises what is over
  {
    const chip = async () => { const d = dom(await (await get("/landing")).text()); return { text: chipText(d), code: chipCode(d), data: d.getElementById("landing-main").dataset.coupon }; };
    await setCoupon({ ...baseCoupon, type: "fixed", value: 50000, min_subtotal: 800000 });
    let c = await chip();
    check("fixed discount with a minimum is worded as such", c.text === `Giảm ${money(50000)} cho đơn từ ${money(800000)} · đơn giao từ ${dm(baseCoupon.starts_on)} đến ${dm(baseCoupon.ends_on)}`, c.text);
    await setCoupon({ ...baseCoupon, starts_on: null, ends_on: null });
    c = await chip();
    check("no window → no date part", c.text === "Giảm 20%", c.text);
    await setCoupon({ ...baseCoupon, starts_on: vnDate(2), ends_on: null });
    check("only a start date → \"đơn giao từ …\"", (await chip()).text === `Giảm 20% · đơn giao từ ${dm(vnDate(2))}`);
    await setCoupon({ ...baseCoupon, starts_on: null, ends_on: vnDate(4) });
    check("only an end date → \"đơn giao đến …\"", (await chip()).text === `Giảm 20% · đơn giao đến ${dm(vnDate(4))}`);
    await setCoupon({ ...baseCoupon, active: false });
    c = await chip();
    check("a switched-off coupon: no chip and an empty data-coupon", c.text === undefined && c.data === "", JSON.stringify(c));
    await setCoupon({ ...baseCoupon, starts_on: vnDate(-10), ends_on: vnDate(-1) });
    c = await chip();
    check("a coupon whose window has ended: no chip and an empty data-coupon", c.text === undefined && c.data === "", JSON.stringify(c));
    await setCoupon({ ...baseCoupon, starts_on: vnDate(-1), ends_on: vnDate(0) });
    check("a window that ends today still shows (today is not over)", (await chip()).text !== undefined);
    await setCoupon(baseCoupon);
    await pool.query("UPDATE campaigns SET coupon_code = NULL WHERE id=$1", [camp.id]);
    c = await chip();
    check("a campaign without a coupon: no chip, the page still works", c.text === undefined && (await get("/landing")).status === 200);
    await pool.query("UPDATE campaigns SET coupon_code=$1 WHERE id=$2", [camp.coupon_code, camp.id]);
  }

  // ------------------------------------------------------------ 3. nothing the owner types can inject markup
  {
    const evil = `</title><script>alert(1)</script>"><img src=x onerror=alert(2)> & 'q'`;
    await pool.query("UPDATE campaigns SET name=$1, headline=$1, subheadline=$1, hero_image=$2 WHERE id=$3", [evil, `images/a"><script>alert(3)</script>.webp`, camp.id]);
    const html = await (await get("/landing")).text();
    const d = dom(html);
    check("hostile wording: no script element, no injected <img onerror>", ![...d.querySelectorAll("script")].some((s) => /alert/.test(s.textContent)) && !d.querySelector("img[onerror]"));
    check("…title and h1 show it as plain text", d.title === `${evil} — Bloomy` && d.querySelector("h1").textContent === evil);
    check("…the meta description attribute holds it exactly (no attribute break-out)", d.querySelector('meta[name="description"]').getAttribute("content") === evil);
    const img = d.querySelector(".landing-hero__image");
    check("…the hero image src is one attribute with the exact value", !!img && img.getAttribute("src") === `images/a"><script>alert(3)</script>.webp` && d.querySelectorAll(".landing-hero__image").length === 1);
    const home = dom(await (await get("/")).text());
    check("…the homepage card shows it as plain text too", home.querySelector(".campaign-card__headline")?.textContent === evil && !home.querySelector(".campaign-card img[onerror]"));
    await pool.query("UPDATE campaigns SET subheadline=NULL, hero_image=NULL WHERE id=$1", [camp.id]);
    const plain = dom(await (await get("/landing")).text());
    check("no subheadline → the paragraph is empty (the stylesheet hides it)", plain.querySelector(".landing-hero__sub").textContent === "");
    check("…and the homepage card leaves the paragraph out", dom(await (await get("/")).text()).querySelector(".campaign-card__sub") === null);
    await pool.query("UPDATE campaigns SET name=$1, headline=$2, subheadline=$3, hero_image=$4 WHERE id=$5", [camp.name, camp.headline, camp.subheadline, camp.hero_image, camp.id]);
  }

  // ------------------------------------------------------------ 3b. a picture sits BESIDE the text, on the page and on the card
  {
    await pool.query("UPDATE campaigns SET hero_image=$1 WHERE id=$2", ["images/chien-dich-thu-nghiem.webp", camp.id]);
    const d = dom(await (await get("/landing")).text());
    const inner = d.querySelector(".landing-hero__inner");
    const media = inner.querySelector(":scope > .landing-hero__media");
    const img = media?.querySelector("img.landing-hero__image");
    check("with a picture: the hero has a media block next to the text block, both inside the hero", !!media && !!inner.querySelector(":scope > .landing-hero__text") && inner.children.length === 2, inner.innerHTML.slice(0, 80));
    check("…the picture is the chosen file, decorative (alt empty), and loaded first (it is what the page opens with)", img.getAttribute("src") === "images/chien-dich-thu-nghiem.webp" && img.getAttribute("alt") === "" && img.getAttribute("fetchpriority") === "high" && !img.hasAttribute("loading"));
    check("…the text is all still there (name, one h1, subheadline, chip)", !!inner.querySelector(".landing-hero__name") && inner.querySelectorAll("h1").length === 1 && !!inner.querySelector(".campaign-chip"));
    const home = dom(await (await get("/")).text());
    const card = home.querySelector(".campaign-card");
    const cardImg = card.querySelector(".campaign-card__media img.campaign-card__image");
    check("the homepage card shows the same picture beside its text (lazy: it is below the fold)", !!cardImg && cardImg.getAttribute("src") === "images/chien-dich-thu-nghiem.webp" && cardImg.getAttribute("alt") === "" && cardImg.getAttribute("loading") === "lazy" && !!card.querySelector(".campaign-card__text .campaign-card__headline"));
    await pool.query("UPDATE campaigns SET hero_image=NULL WHERE id=$1", [camp.id]);
    const bare = dom(await (await get("/")).text());
    check("without a picture the card has no media block (the text takes the full width)", bare.querySelector(".campaign-card__media") === null && !!bare.querySelector(".campaign-card__text"));
    await pool.query("UPDATE campaigns SET hero_image=$1 WHERE id=$2", [camp.hero_image, camp.id]);
  }

  // ------------------------------------------------------------ 4. the homepage card and the sitemap while a campaign is on
  {
    const home = dom(await (await get("/")).text());
    const card = home.querySelector(".campaign-card");
    check("homepage: the card is there with name, headline, subheadline", !!card && card.querySelector(".campaign-card__name").textContent === camp.name && card.querySelector(".campaign-card__headline").textContent === camp.headline && card.querySelector(".campaign-card__sub").textContent === camp.subheadline);
    check("…with the same live chip as the landing page", chipCode(home) === coupon.code && chipText(home) === chipText(dom(await (await get("/landing")).text())));
    check("…and a button to /landing", card.querySelector("a.btn")?.getAttribute("href") === "landing" && card.querySelector("a.btn").textContent === "Xem ưu đãi");
    const sections = [...home.querySelectorAll("main > section")].map((s) => s.className.split(" ")[0]);
    check("…placed after the category tiles and before the featured products", sections.indexOf("category-nav") < sections.indexOf("campaign-card-section") && sections.indexOf("campaign-card-section") < sections.indexOf("featured"), sections.join());
    const map = await (await get("/sitemap.xml")).text();
    check("sitemap lists /landing while a campaign is on", /<loc>[^<]*\/landing<\/loc>/.test(map));
  }

  // ------------------------------------------------------------ 5. no campaign on: redirects, no card, no sitemap entry
  {
    await pool.query("UPDATE settings SET active_campaign_id=NULL");
    const r = await get("/landing");
    check("no campaign: /landing → 302 to /products.html", r.status === 302 && r.headers.get("location") === "/products.html", `${r.status} ${r.headers.get("location")}`);
    const q = await get("/landing?utm_source=zalo");
    check("…and keeps the query string (traffic source)", q.headers.get("location") === "/products.html?utm_source=zalo", q.headers.get("location"));
    const old = await get("/landing.html?utm_source=zalo");
    check("/landing.html → 301 to /landing, query kept", old.status === 301 && old.headers.get("location") === "/landing?utm_source=zalo", `${old.status} ${old.headers.get("location")}`);
    const homeHtml = await (await get("/")).text();
    check("homepage: no card and nothing left over", !homeHtml.includes("campaign-card") && !/\{\{/.test(homeHtml) && !homeHtml.includes("Xem ưu đãi"));
    check("homepage is otherwise complete", !!dom(homeHtml).querySelector("section.featured") && !!dom(homeHtml).querySelector("section.category-nav"));
    check("sitemap leaves /landing out", !/\/landing/.test(await (await get("/sitemap.xml")).text()));
    const noCache = await get("/products.html");
    check("the redirect target loads", noCache.status === 200);
    await pool.query("UPDATE settings SET active_campaign_id=$1", [camp.id]);
    check("switching it on again brings the page back (no restart)", (await get("/landing")).status === 200);
  }

  // ------------------------------------------------------------ 6. database down: a second server
  {
    const port = 39703;
    const env = { ...process.env, PORT: String(port), DB_PORT: "1", SESSION_SECRET: process.env.SESSION_SECRET || "x", BLOOMY_BASE_URL: process.env.BLOOMY_BASE_URL || "http://localhost",
      ZALOPAY_ENDPOINT: process.env.ZALOPAY_ENDPOINT || "https://sb-openapi.zalopay.vn", ZALOPAY_APP_ID: process.env.ZALOPAY_APP_ID || "1", ZALOPAY_KEY1: process.env.ZALOPAY_KEY1 || "a", ZALOPAY_KEY2: process.env.ZALOPAY_KEY2 || "b", DB_PASSWORD: process.env.DB_PASSWORD || "dev", EMAIL_MODE: "log" };
    const child = spawn("node", ["server.js"], { cwd: ROOT, env, stdio: "ignore" });
    try {
      let up = false;
      for (let i = 0; i < 30 && !up; i++) { await sleep(300); try { up = (await fetch(`http://127.0.0.1:${port}/css/style.css`)).ok; } catch {} }
      check("server with unreachable DB starts", up);
      const l = await fetch(`http://127.0.0.1:${port}/landing`, { redirect: "manual" });
      check("DB down: /landing redirects to the products, never a half-page", l.status === 302 && l.headers.get("location") === "/products.html", `${l.status} ${l.headers.get("location")}`);
      const h = await fetch(`http://127.0.0.1:${port}/`);
      const hh = await h.text();
      check("DB down: the homepage still loads, without a card, with nothing unfilled", h.status === 200 && !hh.includes("campaign-card") && !/\{\{/.test(hh));
    } finally { child.kill(); }
  }
} finally {
  await pool.query("UPDATE settings SET active_campaign_id=$1", [original.active]);
  for (const c of original.campaigns) await pool.query("UPDATE campaigns SET name=$2, headline=$3, subheadline=$4, hero_image=$5, coupon_code=$6 WHERE id=$1", [c.id, c.name, c.headline, c.subheadline, c.hero_image, c.coupon_code]);
  for (const c of original.coupons) await pool.query("UPDATE coupons SET type=$2, value=$3, min_subtotal=$4, starts_on=$5, ends_on=$6, active=$7 WHERE code=$1", [c.code, c.type, c.value, c.min_subtotal, c.starts_on, c.ends_on, c.active]);
}
const back = (await pool.query("SELECT (SELECT active_campaign_id FROM settings) a, (SELECT name FROM campaigns WHERE id=$1) n, (SELECT starts_on::text||ends_on::text FROM coupons WHERE code=$2) w", [camp.id, coupon.code])).rows[0];
check("cleanup: campaign, coupon window and active pointer restored", back.a === original.active && back.n === camp.name && back.w === (coupon.starts_on ?? "") + (coupon.ends_on ?? ""), JSON.stringify(back));
await pool.end();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
