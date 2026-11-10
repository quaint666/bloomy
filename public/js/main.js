// ==========================================================================
// Bloomy — Shared site JS, loaded on every customer-facing page.
// Handles: sticky-nav scroll shadow, mobile menu toggle, cart badge count,
// traffic-source capture, Google Analytics. Exposes window.Bloomy.cart helpers so Cart/
// Checkout/product-detail pages can read and write the same localStorage
// shape without duplicating logic.
// ==========================================================================

// v2: lines are (product, size). The old "bloomy_cart" key held a price per
// product and no size — it is simply ignored (old carts are dropped).
const CART_KEY = "bloomy_cart_v2";

const SIZE_LABELS = { s: "Nhỏ", m: "Vừa", l: "Lớn" };

// ---------------------------------------------------------------------------
// Google Analytics 4: page views and where visitors come from. Customer pages
// only — the admin pages never load this file.
//  - Sent only from the real site's address, so browsing the local copy or
//    running the tests never adds to the real property.
//  - No inline script (the CSP forbids it): the loader is built here.
//  - The order-confirmation address carries the order's secret token in its
//    query string. That part is never given to Google, neither as the page
//    address nor as the referrer.
//  - Google signals and ad personalisation are off: GA is used for counting
//    visits only, and that is all privacy.html says.
// The Measurement ID lives here and nowhere else.
// ---------------------------------------------------------------------------
const GA_MEASUREMENT_ID = "G-SJ1XV11XC2";
const GA_HOSTS = ["bloomy.quaintshomelabdomain.uk"];

function addressForAnalytics(url) {
  try {
    const u = new URL(url);
    if (u.pathname.endsWith("/order-confirmation.html")) u.search = "";
    return u.href;
  } catch {
    return "";
  }
}

function initAnalytics() {
  if (!GA_HOSTS.includes(window.location.hostname)) return;
  window.dataLayer = window.dataLayer || [];
  // Google's tag reads the `arguments` object itself, so this stays a plain function.
  window.gtag = function () {
    window.dataLayer.push(arguments);
  };
  window.gtag("js", new Date());
  const config = { allow_google_signals: false, allow_ad_personalization_signals: false };
  const here = addressForAnalytics(window.location.href);
  if (here) config.page_location = here;
  const from = document.referrer ? addressForAnalytics(document.referrer) : "";
  if (from) config.page_referrer = from;
  window.gtag("config", GA_MEASUREMENT_ID, config);
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  document.head.appendChild(script);
}

initAnalytics();

// Same ceiling the order route accepts per line (routes/orders.js); the
// cart never holds more, or the server would refuse to price it.
const MAX_QUANTITY = 99;

/**
 * Cart shape: JSON array of { productId, size, name, image, quantity } in
 * localStorage. Name and image are kept so the cart can draw its rows
 * instantly; prices are NOT stored — they depend on size, coupon, ward and
 * settings, so Cart and Checkout always ask the server (quote() below).
 */
function getCart() {
  try {
    const raw = localStorage.getItem(CART_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error("Bloomy: failed to read cart from localStorage", err);
    return [];
  }
}

function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  updateCartBadge();
  // Lets a page that shows the cart live (Checkout, the landing page) redraw itself.
  window.dispatchEvent(new CustomEvent("bloomy:cart-changed"));
}

function getCartCount(cart) {
  return cart.reduce((total, item) => total + item.quantity, 0);
}

function sameLine(item, productId, size) {
  return item.productId === productId && item.size === size;
}

// Adds `quantity` of `product` in `size` to the cart. The same product in
// the same size increments the existing line; another size is its own line.
// `product` is {id, name, image}.
function addItem(product, size, quantity) {
  const cart = getCart();
  const existing = cart.find((item) => sameLine(item, product.id, size));
  if (existing) {
    existing.quantity = Math.min(MAX_QUANTITY, existing.quantity + quantity);
  } else {
    cart.push({ productId: product.id, size, name: product.name, image: product.image, quantity: Math.min(MAX_QUANTITY, quantity) });
  }
  saveCart(cart);
}

// Switches a line to another size of the same product. If the cart already
// has that size, the two lines merge into one (quantities add up).
function changeSize(productId, fromSize, toSize) {
  if (fromSize === toSize) return;
  const cart = getCart();
  const line = cart.find((i) => sameLine(i, productId, fromSize));
  if (!line) return;
  const target = cart.find((i) => sameLine(i, productId, toSize));
  if (target) {
    target.quantity = Math.min(MAX_QUANTITY, target.quantity + line.quantity);
    cart.splice(cart.indexOf(line), 1);
  } else {
    line.size = toSize;
  }
  saveCart(cart);
}

// Sets a line's quantity directly. Dropping to 0 or below removes the line
// entirely — same code path as removeItem, per the agreed "−" at quantity 1
// removes the row, no separate confirm step.
function updateQuantity(productId, size, quantity) {
  if (quantity < 1) {
    removeItem(productId, size);
    return;
  }
  const cart = getCart();
  const item = cart.find((i) => sameLine(i, productId, size));
  if (item) {
    item.quantity = Math.min(MAX_QUANTITY, quantity);
    saveCart(cart);
  }
}

function removeItem(productId, size) {
  const cart = getCart().filter((item) => !sameLine(item, productId, size));
  saveCart(cart);
}

function clearCart() {
  saveCart([]);
}

// ---------------------------------------------------------------------------
// Custom bouquet lines: { custom: { flowers: [{ flowerId, name, stems }], style,
// note }, key, quantity }. Two lines are the same bouquet (and merge) when the
// flowers, the style and the note are identical, so `key` is built from exactly
// those. No price is stored: Cart and Checkout always ask the server.
// ---------------------------------------------------------------------------
function customKey(custom) {
  const flowers = [...custom.flowers]
    .sort((a, b) => a.flowerId - b.flowerId)
    .map((f) => `${f.flowerId}:${f.stems}`)
    .join(",");
  return `c|${custom.style}|${flowers}|${(custom.note || "").trim()}`;
}

function addCustomItem(custom, quantity) {
  const clean = { ...custom, note: (custom.note || "").trim() };
  const key = customKey(clean);
  const cart = getCart();
  const existing = cart.find((i) => i.custom && i.key === key);
  if (existing) existing.quantity = Math.min(MAX_QUANTITY, existing.quantity + quantity);
  else cart.push({ custom: clean, key, quantity: Math.min(MAX_QUANTITY, quantity) });
  saveCart(cart);
}

// Dropping to 0 or below removes the line, like updateQuantity.
function updateCustomQuantity(key, quantity) {
  if (quantity < 1) return removeCustomItem(key);
  const cart = getCart();
  const item = cart.find((i) => i.custom && i.key === key);
  if (item) {
    item.quantity = Math.min(MAX_QUANTITY, quantity);
    saveCart(cart);
  }
}

function removeCustomItem(key) {
  saveCart(getCart().filter((i) => !(i.custom && i.key === key)));
}

// What the server is sent for the cart: product lines as { productId, size,
// quantity }, custom bouquets as { custom, quantity, key } — no names, no prices.
function toQuoteItems(cart = getCart()) {
  return cart.map((i) =>
    i.custom
      ? {
          custom: {
            flowers: i.custom.flowers.map((f) => ({ flowerId: f.flowerId, stems: f.stems })),
            style: i.custom.style,
            note: i.custom.note || null,
          },
          quantity: i.quantity,
          key: i.key,
        }
      : { productId: i.productId, size: i.size, quantity: i.quantity }
  );
}

// "Giỏ: Hồng đỏ × 10, Cúc trắng × 5" — the style label comes from the server's
// quote line when there is one.
function describeCustom(item, quoteLine) {
  const made = item.custom.flowers.map((f) => `${f.name} × ${f.stems}`).join(", ");
  return quoteLine && quoteLine.style_label ? `${quoteLine.style_label}: ${made}` : made;
}

// Everything customer-typed (a bouquet's note) goes through this before it is
// put into innerHTML.
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// The picture for every custom bouquet line (cart, checkout, confirmation) and
// the homepage section: ONE file, so a real photo replaces it by replacing the
// file. index.html's section uses the same path.
const CUSTOM_BOUQUET_IMAGE = "images/custom-bouquet.webp";

// The coupon code typed in the cart, carried to checkout for this visit only.
// Only the code text is kept; the server decides whether and how much it
// discounts, every time.
const COUPON_KEY = "bloomy_coupon";
function getCoupon() {
  try {
    return sessionStorage.getItem(COUPON_KEY) || "";
  } catch (err) {
    return "";
  }
}
function setCoupon(code) {
  try {
    if (code) sessionStorage.setItem(COUPON_KEY, code);
    else sessionStorage.removeItem(COUPON_KEY);
  } catch (err) {
    // sessionStorage unavailable — the coupon just won't carry over.
  }
}

// Asks the server to price the current cart. `extra` adds checkout choices:
// { coupon_code, fulfillment_type, ward_id, delivery_date }. Returns the
// quote object, or throws.
async function quoteItems(items, extra = {}) {
  const res = await fetch("/api/orders/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items, ...extra }),
  });
  if (!res.ok) throw new Error(`quote failed: ${res.status}`);
  return res.json();
}

// The whole cart, priced.
function quote(extra = {}) {
  return quoteItems(toQuoteItems(), extra);
}

// Format at render time only, never store formatted strings — price stays
// a plain integer everywhere except display.
function formatVND(price) {
  return price.toLocaleString("vi-VN") + "đ";
}

// Card price: "Từ 460.000đ" when the product comes in several sizes.
function formatCardPrice(product) {
  return (product.has_sizes ? "Từ " : "") + formatVND(product.price);
}

// ---------------------------------------------------------------------------
// Shop settings (address, phone, email, VAT rate, delivery fee range) are
// stored once in the database. The server (render.js) puts them into every
// page as {{tokens}} before the page is sent, so nothing is filled in here.
// getSettings() is only for page scripts that need the raw values (Checkout's
// pickup address, for example). One request per page.
// ---------------------------------------------------------------------------
let settingsPromise = null;
function getSettings() {
  if (!settingsPromise) {
    settingsPromise = fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("settings"))))
      .catch((err) => {
        console.error("Bloomy: failed to load shop settings", err);
        settingsPromise = null; // allow a later retry
        return null;
      });
  }
  return settingsPromise;
}

// Shown at the bottom of every page's footer. Defined here once instead of
// copied into each page (it was only ever on the homepage).
const PROJECT_NOTICE =
  "Đây là dự án học tập của sinh viên UEH (môn Công nghệ Thương mại điện tử), không phải cửa hàng thật. " +
  "Đơn hàng sẽ không được giao, số liệu và đánh giá chỉ mang tính minh họa.";

function addProjectNotice() {
  const footer = document.querySelector(".site-footer");
  if (!footer || footer.querySelector(".site-footer__notice")) return;
  const notice = document.createElement("div");
  notice.className = "container site-footer__notice";
  notice.textContent = PROJECT_NOTICE;
  footer.appendChild(notice);
}

// The count last drawn. null until the first draw, so loading a page with items already in
// the cart does not pop the badge: only a count that goes UP does.
let lastBadgeCount = null;

function updateCartBadge() {
  const count = getCartCount(getCart());
  const grew = lastBadgeCount !== null && count > lastBadgeCount;
  lastBadgeCount = count;
  document.querySelectorAll("[data-cart-count]").forEach((el) => {
    el.textContent = count;
    if (count === 0) {
      el.setAttribute("hidden", "");
    } else {
      el.removeAttribute("hidden");
    }
    if (grew) {
      el.classList.remove("is-bumped");
      void el.offsetWidth; // restart the animation if it is still running from the last add
      el.classList.add("is-bumped");
    }
  });
}

document.addEventListener("animationend", (e) => {
  if (e.target.matches && e.target.matches("[data-cart-count]")) e.target.classList.remove("is-bumped");
});

// ---------------------------------------------------------------------------
// Traffic-source capture (?utm_source=facebook, ?utm_source=zalo, etc.) —
// sessionStorage, not localStorage: a source tag should only describe THIS
// visit/session, not linger forever the way the cart does. First tagged
// visit in the session wins; later page views with no (or a different) tag
// don't overwrite it. The server is the one that maps an unrecognized value
// to "other" (routes/orders.js's checkoutSchema) — this stays a dumb
// passthrough on purpose, not a second copy of that allowlist.
// ---------------------------------------------------------------------------
const SOURCE_KEY = "bloomy_source";

function captureSource() {
  try {
    const params = new URLSearchParams(window.location.search);
    const source = params.get("utm_source");
    if (source && !sessionStorage.getItem(SOURCE_KEY)) {
      sessionStorage.setItem(SOURCE_KEY, source.toLowerCase());
    }
  } catch (err) {
    console.error("Bloomy: failed to capture traffic source", err);
  }
}

function getSource() {
  try {
    return sessionStorage.getItem(SOURCE_KEY) || undefined;
  } catch (err) {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Anonymous checkout-funnel tracking (admin stats page's funnel).
// A random id per browser tab/visit lives in sessionStorage — the same
// lifetime as the traffic source above — and is not tied to a person, a
// cookie, or an order. track() sends each event at most once per session
// (the server counts distinct sessions per step anyway), fire-and-forget:
// it never blocks the UI and fails silently on purpose, because a missing
// data point must never become a user-visible error. If sessionStorage is
// unavailable, tracking is skipped entirely.
// `order_placed` is not sent from here — the server records it when an order
// commits (routes/orders.js), using the id from getSessionId().
// ---------------------------------------------------------------------------
const SESSION_ID_KEY = "bloomy_session_id";
const SENT_EVENTS_KEY = "bloomy_events_sent";

function getSessionId() {
  try {
    let id = sessionStorage.getItem(SESSION_ID_KEY);
    if (!id) {
      // crypto.randomUUID only exists in secure contexts (HTTPS/localhost),
      // so plain-http dev access needs the fallback.
      id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
      sessionStorage.setItem(SESSION_ID_KEY, id);
    }
    return id;
  } catch (err) {
    return undefined;
  }
}

function track(event) {
  try {
    const sessionId = getSessionId();
    if (!sessionId) return;

    const sent = JSON.parse(sessionStorage.getItem(SENT_EVENTS_KEY) || "[]");
    if (sent.includes(event)) return;
    sent.push(event);
    sessionStorage.setItem(SENT_EVENTS_KEY, JSON.stringify(sent));

    fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, event }),
      keepalive: true,
    }).catch(() => {});
  } catch (err) {
    // Telemetry only — deliberately silent.
  }
}

// ---------------------------------------------------------------------------
// Small shared helpers: copy to the clipboard, a toast, recently viewed
// products, a back-to-top button.
// ---------------------------------------------------------------------------

// Copies text; true when it worked. The clipboard API needs https (the real site has it); the
// fallback covers plain http (the local copy) and older browsers.
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext !== false) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    // fall through to the older way
  }
  try {
    const box = document.createElement("textarea");
    box.value = text;
    box.setAttribute("readonly", "");
    box.className = "visually-hidden";
    document.body.appendChild(box);
    box.select();
    const ok = document.execCommand("copy");
    box.remove();
    return ok;
  } catch (err) {
    return false;
  }
}

// One toast at a time, bottom centre: a short message, optional links, closes by itself after
// 5 seconds (not while the mouse or keyboard focus is on it). Text goes in with textContent.
let toastTimer = null;

function hideToast() {
  clearTimeout(toastTimer);
  const el = document.getElementById("bloomy-toast");
  if (el) {
    el.hidden = true;
    el.classList.remove("is-visible");
  }
}

function toastElement() {
  let el = document.getElementById("bloomy-toast");
  if (el) return el;
  el = document.createElement("div");
  el.id = "bloomy-toast";
  el.className = "toast";
  el.setAttribute("role", "status");
  el.hidden = true;
  const text = document.createElement("span");
  text.className = "toast__text";
  const links = document.createElement("span");
  links.className = "toast__links";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast__close";
  close.setAttribute("aria-label", "Đóng thông báo");
  close.textContent = "×";
  close.addEventListener("click", hideToast);
  el.append(text, links, close);
  const pause = () => clearTimeout(toastTimer);
  const resume = () => {
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 2000);
  };
  el.addEventListener("mouseenter", pause);
  el.addEventListener("focusin", pause);
  el.addEventListener("mouseleave", resume);
  el.addEventListener("focusout", resume);
  document.body.appendChild(el);
  return el;
}

function showToast(message, links = [], ms = 5000) {
  const el = toastElement();
  el.querySelector(".toast__text").textContent = message;
  const box = el.querySelector(".toast__links");
  box.replaceChildren();
  links.forEach((l) => {
    const a = document.createElement("a");
    a.href = l.href;
    a.textContent = l.label;
    box.appendChild(a);
  });
  el.hidden = false;
  el.classList.remove("is-visible");
  void el.offsetWidth; // restart the rise-in if a toast is already showing
  el.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}

// Recently viewed products: the last 8, newest first, in this browser only. localStorage can be
// edited by anyone, so what comes out is checked before it is used (a whole number id, a short
// name, a picture path inside images/), and a bad entry is dropped.
const RECENT_KEY = "bloomy_recent_v1";
const RECENT_MAX = 8;

function getRecent() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((i) => i && Number.isInteger(i.id) && i.id > 0 && typeof i.name === "string" && i.name.length <= 200 && typeof i.image === "string" && /^images\/[A-Za-z0-9._-]+$/.test(i.image))
      .slice(0, RECENT_MAX);
  } catch (err) {
    return [];
  }
}

function rememberProduct(p) {
  try {
    const list = [{ id: p.id, name: p.name, image: p.image }, ...getRecent().filter((i) => i.id !== p.id)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch (err) {
    // storage full or blocked: not worth interrupting the page for
  }
}

// A round button, bottom left, that appears once the page is scrolled well down.
const BACK_TO_TOP_AFTER_PX = 600;

function initBackToTop() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "back-to-top";
  btn.hidden = true;
  btn.setAttribute("aria-label", "Lên đầu trang");
  const arrow = document.createElement("span");
  arrow.className = "back-to-top__arrow";
  arrow.setAttribute("aria-hidden", "true");
  btn.appendChild(arrow);
  document.body.appendChild(btn);
  let queued = false;
  const update = () => {
    queued = false;
    btn.hidden = window.scrollY < BACK_TO_TOP_AFTER_PX;
  };
  window.addEventListener("scroll", () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(update);
    }
  }, { passive: true });
  btn.addEventListener("click", () => {
    // Explicit here because scrollTo's own "smooth" ignores the CSS reduced-motion rule.
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  });
  update();
}

// Any element with data-copy="TEXT" (the coupon chips) copies that text when clicked.
document.addEventListener("click", async (e) => {
  const btn = e.target.closest && e.target.closest("[data-copy]");
  if (!btn) return;
  const ok = await copyText(btn.dataset.copy);
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.textContent = ok ? "Đã sao chép ✓" : "Không sao chép được";
  btn.classList.remove("is-added");
  void btn.offsetWidth;
  btn.classList.add("is-added");
  btn.addEventListener("animationend", () => btn.classList.remove("is-added"), { once: true });
  clearTimeout(btn._copyTimer);
  btn._copyTimer = setTimeout(() => {
    btn.textContent = btn.dataset.label;
  }, 2000);
});

window.Bloomy = window.Bloomy || {};
window.Bloomy.copyText = copyText;
window.Bloomy.toast = showToast;
window.Bloomy.recent = { get: getRecent, add: rememberProduct };
window.Bloomy.cart = {
  getCart, saveCart, getCartCount, addItem, updateQuantity, changeSize, removeItem, clearCart,
  addCustomItem, updateCustomQuantity, removeCustomItem, toQuoteItems,
};
window.Bloomy.quoteItems = quoteItems;
window.Bloomy.describeCustom = describeCustom;
window.Bloomy.escapeHtml = escapeHtml;
window.Bloomy.CUSTOM_IMAGE = CUSTOM_BOUQUET_IMAGE;
window.Bloomy.getCoupon = getCoupon;
window.Bloomy.setCoupon = setCoupon;
window.Bloomy.quote = quote;
window.Bloomy.getSettings = getSettings;
window.Bloomy.SIZE_LABELS = SIZE_LABELS;
window.Bloomy.formatVND = formatVND;
window.Bloomy.formatCardPrice = formatCardPrice;
window.Bloomy.getSource = getSource;
window.Bloomy.getSessionId = getSessionId;
window.Bloomy.track = track;

function setNavHeightVar() {
  const nav = document.querySelector(".site-nav");
  if (!nav) return;
  document.documentElement.style.setProperty("--nav-height", `${nav.offsetHeight}px`);
}

function initScrollShadow() {
  const nav = document.querySelector(".site-nav");
  if (!nav) return;

  const applyShadowState = () => {
    nav.classList.toggle("is-scrolled", window.scrollY > 0);
  };

  applyShadowState();
  window.addEventListener("scroll", applyShadowState, { passive: true });
}

function initMobileMenu() {
  const nav = document.querySelector(".site-nav");
  const toggle = document.querySelector("[data-nav-toggle]");
  if (!nav || !toggle) return;

  toggle.addEventListener("click", () => {
    const isOpen = nav.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    toggle.setAttribute("aria-label", isOpen ? "Đóng menu" : "Mở menu");
  });
}

document.addEventListener("DOMContentLoaded", () => {
  captureSource();
  track("visit");
  setNavHeightVar();
  initScrollShadow();
  initMobileMenu();
  updateCartBadge();
  initNavSearch();
  addProjectNotice();
  initBackToTop();
});

window.addEventListener("resize", setNavHeightVar);

// ---- Nav search: live dropdown as you type ----
// Applies to every .site-nav__search form on the page (there are two —
// desktop nav and the mobile panel — same markup, same behavior for both).
// Submitting the form (Enter) still falls back to products.html?q=... via
// its existing action/method — untouched, that native behavior already
// worked before any of this JS existed.

const NAV_SEARCH_DEBOUNCE_MS = 1000; // matches Listing's own search debounce

function renderSearchResults(dropdown, products, query) {
  if (products.length === 0) {
    dropdown.innerHTML = `<p class="site-nav__search-empty">Không tìm thấy sản phẩm phù hợp.</p>`;
    dropdown.hidden = false;
    return;
  }

  dropdown.innerHTML = products
    .map(
      (p) => `
    <a href="product.html?id=${p.id}" class="site-nav__search-result">
      <img src="${p.image}" alt="${p.name}">
      <span class="site-nav__search-result-name">${p.name}</span>
      <span class="site-nav__search-result-price">${formatCardPrice(p)}</span>
    </a>
  `
    )
    .join("");
  dropdown.hidden = false;
}

async function runNavSearch(input, dropdown) {
  const query = input.value.trim();

  if (!query) {
    dropdown.hidden = true;
    dropdown.innerHTML = "";
    return;
  }

  try {
    const res = await fetch(`/api/products?search=${encodeURIComponent(query)}&limit=5`);
    const products = await res.json();
    renderSearchResults(dropdown, products, query);
  } catch (err) {
    console.error("Bloomy: nav search failed", err);
    dropdown.hidden = true;
  }
}

function initNavSearch() {
  document.querySelectorAll(".site-nav__search").forEach((form) => {
    const input = form.querySelector("input");
    if (!input) return;

    const dropdown = document.createElement("div");
    dropdown.className = "site-nav__search-results";
    dropdown.hidden = true;
    form.appendChild(dropdown);

    let debounceTimer = null;
    input.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => runNavSearch(input, dropdown), NAV_SEARCH_DEBOUNCE_MS);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        dropdown.hidden = true;
        input.blur();
      }
      // Enter is deliberately NOT intercepted here — the form's native
      // submit (action="products.html", input name="q") already handles
      // it correctly, matching Listing's own ?q= param reading.
    });

    document.addEventListener("click", (e) => {
      if (!form.contains(e.target)) {
        dropdown.hidden = true;
      }
    });
  });
}
