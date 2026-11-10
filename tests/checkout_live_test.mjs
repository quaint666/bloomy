// The checkout page as a visitor uses it: the real checkout.html with its real scripts (main.js, checkout.js) run
// in jsdom against the running server. Checks the live cart (the + / − / Xóa buttons in the summary, an empty cart,
// a cart filled while the page is open), the order button waiting for a fresh price, and that placing an order does
// not make the page flip to "empty cart".
//
// Run from the repo root with the server running on the same database:
//   export DB_HOST=127.0.0.1 DB_PORT=5433 DB_PASSWORD=dev
//   BASE=http://localhost:3000 node tests/checkout_live_test.mjs
//
// IT PLACES ONE REAL (cash, pickup) ORDER through the page and deletes it afterwards, restoring the flower stock.
// Same rules as order_flow_test.mjs: EMAIL_MODE=log only, never production. The server rate-limits quotes and
// deadline lookups per IP: running the whole test suite more than about twice in 15 minutes can hit those limits.
//
// Proves: the behaviours listed above, in a DOM. Does NOT prove: how it looks, mobile layout, real touch input,
// the ZaloPay QR flow (the waiting view is opened by calling its function with a fake QR), or other browsers.

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
async function until(fn, ms = 8000, step = 40) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(step); }
  return false;
}

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
const line = (qty) => ({ productId: 9, size: "m", name: "Bó Hồng Đỏ Classic", image: "images/bohongdoclasic.webp", quantity: qty });
const deliveryDate = new Date(Date.now() + 7 * 3600e3 + 3 * 86400e3).toISOString().slice(0, 10);
const money = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "đ";

// Scripts are loaded for real; stylesheets are answered with an empty one (nothing here is about looks). Every fetch
// the page makes goes to the real server and is logged.
const noCss = requestInterceptor(async (request) => (/\.css(\?|$)/.test(request.url) ? new Response("", { headers: { "Content-Type": "text/css" } }) : undefined));
const tokens = [];
async function open(cart) {
  const log = [];
  const dom = new JSDOM(await (await fetch(`${BASE}/checkout.html`)).text(), {
    url: `${BASE}/checkout.html`, runScripts: "dangerously", resources: { interceptors: [noCss] }, pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(), // navigation to the confirmation page is "not implemented" in jsdom: ignore
    beforeParse(w) {
      w.localStorage.setItem(CART_KEY, JSON.stringify(cart));
      w.fetch = (u, o = {}) => {
        const url = new URL(u, `${BASE}/checkout.html`);
        const entry = { path: url.pathname, method: o.method || "GET" };
        log.push(entry);
        return fetch(url, o).then((res) => {
          if (entry.path === "/api/orders" && entry.method === "POST") res.clone().json().then((d) => d?.token && tokens.push(d.token)).catch(() => {});
          return res;
        });
      };
    },
  });
  const w = dom.window, d = w.document;
  await until(() => w.Bloomy && d.body.classList.contains("is-ready"));
  const api = {
    w, d, log, dom,
    cart: () => JSON.parse(w.localStorage.getItem(CART_KEY) || "[]"),
    empty: () => !d.getElementById("checkout-empty").hidden,
    form: () => !d.getElementById("checkout-form-view").hidden,
    rows: () => [...d.querySelectorAll(".checkout-summary__item")],
    total: () => d.getElementById("checkout-total").textContent,
    btn: () => d.getElementById("place-order-btn"),
    count: (p, m = "POST") => log.filter((e) => e.path === p && e.method === m).length,
    click: (act, i = 0) => d.querySelector(`[data-act="${act}"][data-i="${i}"]`).click(),
    set(sel, v) { const el = d.querySelector(sel); el.value = v; el.dispatchEvent(new w.Event("input", { bubbles: true })); el.dispatchEvent(new w.Event("change", { bubbles: true })); },
    tick(sel) { d.querySelector(sel).click(); },
    fillPickupCash() {
      api.tick('input[name="fulfillment_type"][value="pickup"]');
      api.tick('input[name="payment_method"][value="cash"]');
      api.set("#delivery-date", deliveryDate);
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
};

try {
  const unit = (await (await fetch(`${BASE}/api/products/9`)).json()).sizes.find((s) => s.size === "m").price;

  // ---------------------------------------------------------------- 1. a direct visit with an empty cart
  {
    const p = await open([]);
    check("empty cart: the empty message shows, the form is hidden", p.empty() && !p.form());
    await sleep(700);
    check("empty cart: nothing was set up (no quote, no wards, no deadline lookups)", p.count("/api/orders/quote") === 0 && p.count("/api/settings/wards", "GET") === 0 && p.count("/api/orders/deadline", "GET") === 0, JSON.stringify(p.log.map((e) => e.path)));
    p.close();
  }

  // ---------------------------------------------------------------- 2. a cart with one line: the summary's buttons
  {
    const p = await open([line(1)]);
    check("cart with a line: the form shows, the empty message does not", p.form() && !p.empty());
    check("summary: one row with − / + / Xóa buttons", p.rows().length === 1 && !!p.d.querySelector('[data-act="minus"]') && !!p.d.querySelector('[data-act="plus"]') && !!p.d.querySelector('[data-act="remove"]'));
    check("summary: buttons have accessible names", [...p.d.querySelectorAll("[data-act]")].every((b) => (b.getAttribute("aria-label") || "").includes("Bó Hồng Đỏ Classic")));
    check("first price arrives", await until(() => p.total() === money(unit)), p.total());
    p.fillPickupCash();
    check("form filled: the order button is enabled once the price is known", await until(() => !p.btn().disabled), String(p.btn().disabled));

    p.click("plus");
    check("+ changes the stored cart (quantity 2)", p.cart()[0].quantity === 2, JSON.stringify(p.cart()));
    check("+ redraws the summary at once", p.rows()[0].querySelector(".qty-stepper span").textContent === "2");
    check("…and the order button waits for the new price", p.btn().disabled === true);
    check("…then the new total arrives and the button is enabled again", await until(() => p.total() === money(unit * 2) && !p.btn().disabled), `${p.total()} / disabled=${p.btn().disabled}`);

    const quotesBefore = p.count("/api/orders/quote");
    p.click("plus"); p.click("plus");
    check("two quick clicks: quantity 4", p.cart()[0].quantity === 4);
    check("…settle on the right total", await until(() => p.total() === money(unit * 4)), p.total());
    check("…with one request for the two clicks, not two", p.count("/api/orders/quote") - quotesBefore === 1, String(p.count("/api/orders/quote") - quotesBefore));

    p.click("minus"); p.click("minus"); p.click("minus");
    check("three − clicks: quantity 1", p.cart()[0]?.quantity === 1, JSON.stringify(p.cart()));
    p.click("minus");
    check("− at 1 removes the line (as on the cart page)", p.cart().length === 0);
    check("…the page shows the empty message and hides the form", p.empty() && !p.form());
    const q = p.count("/api/orders/quote");
    await sleep(500);
    check("…and sends no more price requests", p.count("/api/orders/quote") === q);
    p.close();
  }

  // ---------------------------------------------------------------- 3. the cart is filled while the page is open (the landing page's case)
  {
    const p = await open([]);
    check("starts empty", p.empty() && !p.form());
    p.w.Bloomy.cart.addItem({ id: 9, name: "Bó Hồng Đỏ Classic", image: "images/bohongdoclasic.webp" }, "m", 1);
    check("adding a product turns the empty message into the form", await until(() => p.form() && !p.empty()));
    check("…the summary has the line", p.rows().length === 1);
    check("…the form is set up now: wards were loaded", await until(() => p.count("/api/settings/wards", "GET") === 1), String(p.count("/api/settings/wards", "GET")));
    check("…and priced", await until(() => p.total() === money(unit)), p.total());
    p.w.Bloomy.cart.addItem({ id: 9, name: "Bó Hồng Đỏ Classic", image: "images/bohongdoclasic.webp" }, "m", 1);
    check("adding the same product again raises its quantity to 2", await until(() => p.rows().length === 1 && p.rows()[0].querySelector(".qty-stepper span").textContent === "2"));
    check("…and the total follows", await until(() => p.total() === money(unit * 2)), p.total());
    p.w.Bloomy.cart.clearCart();
    check("emptying the cart from outside shows the empty message again", await until(() => p.empty() && !p.form()));
    p.close();
  }

  // ---------------------------------------------------------------- 4. a custom bouquet line
  {
    const flowers = await (await fetch(`${BASE}/api/flowers`)).json();
    const f = (Array.isArray(flowers) ? flowers : flowers.flowers)[0];
    const p = await open([]);
    const note = 'Chúc "mừng" <b>ĐẬM</b> & hơn';
    p.w.Bloomy.cart.addCustomItem({ flowers: [{ flowerId: f.id, name: f.name, stems: 5 }], style: "bo", note }, 1);
    check("custom bouquet: the line appears with its buttons", await until(() => p.form() && p.rows().length === 1 && !!p.d.querySelector('[data-act="plus"]')));
    check("custom bouquet: the note is shown as text, not as markup", p.d.querySelector(".checkout-summary__item b") === null && p.rows()[0].textContent.includes("<b>ĐẬM</b>"));
    p.click("plus");
    check("custom bouquet: + raises its quantity", p.cart()[0].quantity === 2);
    p.click("remove");
    check("custom bouquet: Xóa removes it", p.cart().length === 0 && p.empty());
    p.close();
  }

  // ---------------------------------------------------------------- 5. the payment view
  {
    const p = await open([line(1)]);
    await until(() => p.total() === money(unit));
    let fired = 0;
    p.d.addEventListener("bloomy:payment-waiting", () => fired++);
    p.w.showPaymentWaiting({ token: "t".repeat(48), total_amount: unit, qr_data_url: "data:image/png;base64,iVBORw0KGgo=", order_url: "https://example.com/pay" });
    p.w.eval("clearInterval(pollTimer)"); // the fake order would be polled forever
    check("payment view: shown, with the amount, and the form is hidden", !p.d.getElementById("payment-waiting").hidden && !p.form() && p.d.getElementById("payment-waiting-amount").textContent === money(unit));
    check("payment view: announces itself (bloomy:payment-waiting)", fired === 1, String(fired));
    p.close();
  }

  // ---------------------------------------------------------------- 6. placing an order must not flip the page to "empty cart"
  {
    const p = await open([line(1)]);
    await until(() => p.total() === money(unit));
    p.fillPickupCash();
    check("order: button enabled", await until(() => !p.btn().disabled));
    const quotesBeforeSubmit = p.count("/api/orders/quote");
    p.btn().click();
    check("order: exactly one POST /api/orders", await until(() => p.count("/api/orders") >= 1) && p.count("/api/orders") === 1, String(p.count("/api/orders")));
    check("order: the server accepted it (a token came back)", await until(() => tokens.length === 1), String(tokens.length));
    check("order: the cart was cleared", await until(() => p.cart().length === 0));
    await sleep(600);
    check("order: the page did NOT switch to the empty-cart message", !p.empty());
    check("order: no price request was fired by the cart emptying", p.count("/api/orders/quote") === quotesBeforeSubmit, `${p.count("/api/orders/quote")} vs ${quotesBeforeSubmit}`);
    check("order: still exactly one POST /api/orders", p.count("/api/orders") === 1);
    p.close();
  }
} finally {
  if (tokens.length) await pool.query("DELETE FROM orders WHERE token = ANY($1)", [tokens]);
  for (const [id, stock] of before.stock) await pool.query("UPDATE flowers SET stock=$1 WHERE id=$2 AND stock <> $1", [stock, id]);
  await pool.query("DELETE FROM availability_checks WHERE id > $1", [before.availMax]);
  await pool.query("DELETE FROM funnel_events WHERE id > $1", [before.funnelMax]);
}
check("cleanup: no test orders left", Number((await pool.query("SELECT COUNT(*) FROM orders WHERE id > $1", [before.orderMax])).rows[0].count) === 0);
await pool.end();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
