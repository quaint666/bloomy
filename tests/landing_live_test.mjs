// The landing page as a visitor uses it: the real /landing with its real scripts (main.js, landing.js, checkout.js)
// run in jsdom against the running server. Cards, sizes, add to cart, the form appearing on the same page, the
// campaign coupon applying through the one-page checkout, a real order placed from the landing page, and the
// payment view taking over the page.
//
// Run from the repo root with the server running on the same database:
//   export DB_HOST=127.0.0.1 DB_PORT=5433 DB_PASSWORD=dev
//   BASE=http://localhost:3000 node tests/landing_live_test.mjs
//
// IT PLACES ONE REAL (cash, pickup) ORDER and deletes it afterwards; it also moves the campaign coupon's window around
// today and sets a product "sold out today" for a moment, then restores everything. EMAIL_MODE=log only, never
// production. The server rate-limits quotes and deadline lookups per IP: do not run the whole suite more than about
// twice in 15 minutes.
//
// Proves: the behaviours above, in a DOM. Does NOT prove: how it looks, mobile layout, real touch input, the ZaloPay QR
// flow (the payment view is opened by calling its function with a fake QR), or other browsers.

import { createRequire } from "node:module";
import path from "node:path";
import jsdom from "jsdom";
const { JSDOM, VirtualConsole, requestInterceptor } = jsdom;

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const require = createRequire(path.join(process.cwd(), "package.json"));
const { Pool } = require("pg");
const pool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1", port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || "quaint", database: process.env.DB_NAME || "bloomy", password: process.env.DB_PASSWORD || "dev",
});

let passed = 0, failed = 0;
function check(name, cond, extra = "") { if (cond) passed++; else { failed++; console.log(`FAIL ${name}${extra ? " :: " + extra : ""}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, step = 40) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(step); } return false; }
const money = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "đ";
const vnDate = (offsetDays) => new Date(Date.now() + 7 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
const SIZE_LABEL = { s: "Nhỏ", m: "Vừa", l: "Lớn" };

// Stop early if this script's database is not the server's database.
{
  const row = (await pool.query("SELECT shop_address, contact_phone, contact_email, vat_rate FROM settings")).rows[0];
  const api = await (await fetch(`${BASE}/api/settings`)).json();
  if (!row || row.shop_address !== api.shop_address || row.contact_phone !== api.contact_phone || row.contact_email !== api.contact_email || row.vat_rate !== api.vat_rate) {
    console.log("FAIL this script is connected to a different database than the server at " + BASE + " (settings differ). Export the same DB_HOST / DB_PORT / DB_PASSWORD as the server and run again.");
    process.exit(2);
  }
}

const CART_KEY = "bloomy_cart_v2";
const noCss = requestInterceptor(async (request) => (/\.css(\?|$)/.test(request.url) ? new Response("", { headers: { "Content-Type": "text/css" } }) : undefined));
const tokens = [];
async function open(cart = []) {
  const log = [];
  const scrolls = [];
  const dom = new JSDOM(await (await fetch(`${BASE}/landing`)).text(), {
    url: `${BASE}/landing`, runScripts: "dangerously", resources: { interceptors: [noCss] }, pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
    beforeParse(w) {
      w.localStorage.setItem(CART_KEY, JSON.stringify(cart));
      w.scrollTo = (x, y) => scrolls.push([x, y]);
      w.fetch = (u, o = {}) => {
        const url = new URL(u, `${BASE}/landing`);
        const entry = { path: url.pathname, method: o.method || "GET", body: o.body ? JSON.parse(o.body) : null };
        log.push(entry);
        return fetch(url, o).then((res) => {
          if (entry.path === "/api/orders" && entry.method === "POST") res.clone().json().then((d) => d?.token && tokens.push(d.token)).catch(() => {});
          return res;
        });
      };
    },
  });
  const w = dom.window, d = w.document;
  await until(() => w.Bloomy && d.body.classList.contains("is-ready") && d.querySelectorAll(".landing-card").length > 0);
  const api = {
    w, d, log, scrolls,
    cart: () => JSON.parse(w.localStorage.getItem(CART_KEY) || "[]"),
    empty: () => !d.getElementById("checkout-empty").hidden,
    form: () => !d.getElementById("checkout-form-view").hidden,
    cards: () => [...d.querySelectorAll(".landing-card")],
    card: (id) => d.querySelector(`.landing-card[data-id="${id}"]`),
    total: () => d.getElementById("checkout-total").textContent,
    btn: () => d.getElementById("place-order-btn"),
    count: (p, m = "POST") => log.filter((e) => e.path === p && e.method === m).length,
    set(sel, v) { const el = d.querySelector(sel); el.value = v; el.dispatchEvent(new w.Event("input", { bubbles: true })); el.dispatchEvent(new w.Event("change", { bubbles: true })); },
    tick(sel) { d.querySelector(sel).click(); },
    fillPickupCash(date) {
      api.tick('input[name="fulfillment_type"][value="pickup"]');
      api.tick('input[name="payment_method"][value="cash"]');
      api.set("#delivery-date", date);
      api.tick('input[name="delivery_window"][value="morning"]');
      api.set("#sender-name", "Kiểm thử Người gửi"); api.set("#sender-phone", "0912345678");
      api.set("#recipient-name", "Kiểm thử Người nhận"); api.set("#recipient-phone", "0987654321");
      api.tick('input[name="consent"]');
    },
    close: () => dom.window.close(),
  };
  return api;
}

const before = {
  funnelMax: (await pool.query("SELECT COALESCE(MAX(id),0) AS m FROM funnel_events")).rows[0].m,
  availMax: (await pool.query("SELECT COALESCE(MAX(id),0) AS m FROM availability_checks")).rows[0].m,
  orderMax: (await pool.query("SELECT COALESCE(MAX(id),0) AS m FROM orders")).rows[0].m,
  stock: new Map((await pool.query("SELECT id, stock FROM flowers")).rows.map((r) => [r.id, r.stock])),
  active: (await pool.query("SELECT active_campaign_id FROM settings")).rows[0].active_campaign_id,
};
let touchedProduct = null, touchedCoupon = null;

try {
  const camp = (await pool.query("SELECT id, coupon_code FROM campaigns ORDER BY id LIMIT 1")).rows[0];
  await pool.query("UPDATE settings SET active_campaign_id=$1", [camp.id]);
  const code = camp.coupon_code;
  const c0 = (await pool.query("SELECT type, value, min_subtotal, starts_on::text AS starts_on, ends_on::text AS ends_on, active FROM coupons WHERE code=$1", [code])).rows[0];
  touchedCoupon = { code, ...c0 };
  // a window around today, so the discount can be checked whatever day this runs
  await pool.query("UPDATE coupons SET type='percent', value=20, min_subtotal=0, starts_on=$2, ends_on=$3, active=true WHERE code=$1", [code, vnDate(1), vnDate(20)]);
  const inWindow = vnDate(3), outOfWindow = vnDate(40);

  const campaign = await (await fetch(`${BASE}/api/campaigns/active`)).json();
  const products = campaign.products;
  check("the campaign has products to show", products.length >= 2, String(products.length));
  const multi = products.find((p) => p.has_sizes);
  const soldOut = products.find((p) => p.id !== products[0].id && p.id !== multi?.id) || products[1];
  touchedProduct = { id: soldOut.id, status: (await pool.query("SELECT status FROM products WHERE id=$1", [soldOut.id])).rows[0].status };
  await pool.query("UPDATE products SET status='sold_out_today' WHERE id=$1", [soldOut.id]);
  const apiNow = (await (await fetch(`${BASE}/api/campaigns/active`)).json()).products;

  // ---------------------------------------------------------------- 1. the cards
  {
    const p = await open();
    check("cards: one per product, in the campaign's order", await until(() => p.cards().length === apiNow.length) && JSON.stringify(p.cards().map((c) => Number(c.dataset.id))) === JSON.stringify(apiNow.map((x) => x.id)), JSON.stringify(p.cards().map((c) => c.dataset.id)));
    check("cards: each has a name linking to its product page, a photo and a price", p.cards().every((c) => c.querySelector(".landing-card__name a").getAttribute("href").startsWith("product.html?id=") && c.querySelector("img").getAttribute("src") && /đ$/.test(c.querySelector(".landing-card__price").textContent)));
    const okSizes = apiNow.every((x) => {
      const c = p.card(x.id), chips = [...c.querySelectorAll('input[type="radio"]')];
      if (!x.has_sizes) return chips.length === 0 && c.querySelector(".landing-card__price").textContent === money(x.sizes[0].price);
      const def = (x.sizes.find((s) => s.size === "m") || x.sizes[0]);
      return chips.length === x.sizes.length && chips.find((i) => i.checked)?.value === def.size && c.querySelector(".landing-card__price").textContent === money(def.price)
        && chips.every((i) => i.parentElement.textContent.trim() === SIZE_LABEL[i.value]);
    });
    check("cards: sizes only where there is a choice, \"Vừa\" (or the first) pre-selected, price is that size's", okSizes);
    const withSizes = apiNow.find((x) => x.has_sizes && x.sizes.some((s) => s.size === "l"));
    if (withSizes) {
      const c = p.card(withSizes.id);
      c.querySelector('input[value="l"]').click();
      check("cards: choosing another size changes that card's price", c.querySelector(".landing-card__price").textContent === money(withSizes.sizes.find((s) => s.size === "l").price));
    }
    check("cards: a product sold out today says so; the others do not", !!p.card(soldOut.id).querySelector(".landing-card__note") && p.cards().filter((c) => c.querySelector(".landing-card__note")).length === 1);
    check("cards: that product can still be added (only today's delivery is blocked)", !p.card(soldOut.id).querySelector(".landing-card__add").disabled);
    check("the page starts with the empty prompt, no form, nothing priced", p.empty() && !p.form() && p.count("/api/orders/quote") === 0);
    p.close();
  }

  // ---------------------------------------------------------------- 2. the coupon is in place before anything is priced
  {
    const p = await open();
    check("the campaign coupon is in the cart's coupon slot", p.w.sessionStorage.getItem("bloomy_coupon") === code, String(p.w.sessionStorage.getItem("bloomy_coupon")));
    p.close();
    const returning = await open([{ productId: apiNow[0].id, size: (apiNow[0].sizes.find((s) => s.size === "m") || apiNow[0].sizes[0]).size, name: apiNow[0].name, image: apiNow[0].image, quantity: 1 }]);
    check("a returning visitor (cart already full): the form shows at once", returning.form() && !returning.empty());
    check("…and the very first price request already carries the campaign coupon", await until(() => returning.count("/api/orders/quote") >= 1) && returning.log.find((e) => e.path === "/api/orders/quote").body.coupon_code === code, JSON.stringify(returning.log.find((e) => e.path === "/api/orders/quote")?.body?.coupon_code));
    returning.close();
  }

  // ---------------------------------------------------------------- 3. adding: the form appears on the same page
  const target = apiNow[0];
  const defaultSize = (target.sizes.find((s) => s.size === "m") || target.sizes[0]).size;
  const unit = target.sizes.find((s) => s.size === defaultSize).price;
  {
    const p = await open();
    p.card(target.id).querySelector(".landing-card__add").click();
    check("add: the cart gets one line with the chosen size", p.cart().length === 1 && p.cart()[0].productId === target.id && p.cart()[0].size === defaultSize && p.cart()[0].quantity === 1, JSON.stringify(p.cart()));
    check("add: the empty prompt gives way to the form, on the same page", await until(() => p.form() && !p.empty()));
    check("add: the summary shows the product, priced", await until(() => p.d.querySelectorAll(".checkout-summary__item").length === 1 && p.total() === money(unit) || p.total().includes("đ")), p.total());
    const said = p.card(target.id).querySelector(".landing-card__added");
    check("add: the card confirms, with a link to the order below", !said.hidden && said.textContent.includes("Đã thêm vào đơn (1)") && said.querySelector("a")?.getAttribute("href") === "#landing-order", said.textContent);
    p.card(target.id).querySelector(".landing-card__add").click();
    check("add again: quantity 2, the card says (2)", p.cart()[0].quantity === 2 && said.textContent.includes("(2)"));
    if (target.has_sizes && target.sizes.some((s) => s.size !== defaultSize)) {
      const other = target.sizes.find((s) => s.size !== defaultSize).size;
      p.card(target.id).querySelector(`input[value="${other}"]`).click();
      p.card(target.id).querySelector(".landing-card__add").click();
      check("another size of the same product is its own line", p.cart().length === 2 && p.cart().some((i) => i.size === other && i.quantity === 1), JSON.stringify(p.cart()));
    }
    p.close();
  }

  // ---------------------------------------------------------------- 4. the campaign coupon through the one-page checkout
  {
    const p = await open([{ productId: target.id, size: defaultSize, name: target.name, image: target.image, quantity: 2 }]);
    await until(() => p.total().includes("đ"));
    p.fillPickupCash(inWindow);
    check("in the coupon's window: the discount row appears with the code", await until(() => !p.d.getElementById("checkout-discount-row").hidden && p.d.getElementById("checkout-discount-label").textContent.includes(code)), p.d.getElementById("checkout-discount-label").textContent);
    const q = await (await fetch(`${BASE}/api/orders/quote`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: [{ productId: target.id, size: defaultSize, quantity: 2 }], coupon_code: code, fulfillment_type: "pickup", delivery_date: inWindow }) })).json();
    check("…the discount shown is the server's, and 20% of the goods", q.coupon.status === "applied" && q.discount > 0 && q.discount === Math.round(q.subtotal * 0.2) && p.d.getElementById("checkout-discount").textContent === `−${money(q.discount)}`, `${p.d.getElementById("checkout-discount").textContent} vs ${q.discount}`);
    check("…and the total is subtotal − discount", p.total() === money(q.subtotal - q.discount), `${p.total()} vs ${money(q.subtotal - q.discount)}`);
    p.set("#delivery-date", outOfWindow);
    check("delivery date outside the window: no discount, and the summary says why", await until(() => p.d.getElementById("checkout-discount-row").hidden && !p.d.getElementById("checkout-coupon-msg").hidden), p.d.getElementById("checkout-coupon-msg").textContent);
    p.close();
  }

  // ---------------------------------------------------------------- 5. a real order from the landing page
  {
    const p = await open();
    p.card(target.id).querySelector(".landing-card__add").click();
    await until(() => p.form() && p.total().includes("đ"));
    p.fillPickupCash(inWindow);
    check("order: the button is enabled once the price is known", await until(() => !p.btn().disabled && !p.d.getElementById("checkout-discount-row").hidden));
    p.btn().click();
    check("order: exactly one POST /api/orders, and the server accepted it", await until(() => tokens.length === 1) && p.count("/api/orders") === 1, `${tokens.length} / ${p.count("/api/orders")}`);
    const row = (await pool.query("SELECT coupon_code, discount, subtotal, total_amount, payment_method FROM orders WHERE token=$1", [tokens[0]])).rows[0] || {};
    check("order: stored with the campaign coupon and its discount", row.coupon_code === code && row.discount > 0 && row.total_amount === row.subtotal - row.discount, JSON.stringify(row));
    check("order: the cart was cleared", await until(() => p.cart().length === 0));
    await sleep(500);
    check("order: the page did not flip to the empty prompt, and the payment takeover is off (cash)", !p.empty() && !p.d.body.classList.contains("is-paying"));
    p.close();
  }

  // ---------------------------------------------------------------- 6. the payment view takes over the page
  {
    const p = await open([{ productId: target.id, size: defaultSize, name: target.name, image: target.image, quantity: 1 }]);
    await until(() => p.total().includes("đ"));
    p.w.showPaymentWaiting({ token: "t".repeat(48), total_amount: unit, qr_data_url: "data:image/png;base64,iVBORw0KGgo=", order_url: "https://example.com/pay" });
    p.w.eval("clearInterval(pollTimer)");
    check("payment view: shown, the form hidden", !p.d.getElementById("payment-waiting").hidden && !p.form());
    check("payment view: the page switches to \"paying\" mode (the stylesheet then hides hero, cards and order title) and scrolls to the top", p.d.body.classList.contains("is-paying") && p.scrolls.length === 1 && p.scrolls[0].join() === "0,0", JSON.stringify(p.scrolls));
    p.close();
  }
} finally {
  if (tokens.length) await pool.query("DELETE FROM orders WHERE token = ANY($1)", [tokens]);
  for (const [id, stock] of before.stock) await pool.query("UPDATE flowers SET stock=$1 WHERE id=$2 AND stock <> $1", [stock, id]);
  await pool.query("DELETE FROM availability_checks WHERE id > $1", [before.availMax]);
  await pool.query("DELETE FROM funnel_events WHERE id > $1", [before.funnelMax]);
  if (touchedProduct) await pool.query("UPDATE products SET status=$1 WHERE id=$2", [touchedProduct.status, touchedProduct.id]);
  if (touchedCoupon) await pool.query("UPDATE coupons SET type=$2, value=$3, min_subtotal=$4, starts_on=$5, ends_on=$6, active=$7 WHERE code=$1", [touchedCoupon.code, touchedCoupon.type, touchedCoupon.value, touchedCoupon.min_subtotal, touchedCoupon.starts_on, touchedCoupon.ends_on, touchedCoupon.active]);
  await pool.query("UPDATE settings SET active_campaign_id=$1", [before.active]);
}
check("cleanup: no test orders left", Number((await pool.query("SELECT COUNT(*) FROM orders WHERE id > $1", [before.orderMax])).rows[0].count) === 0);
await pool.end();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
