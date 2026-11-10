// Bloomy — Cart page logic.
// Rows are drawn straight away from localStorage (name, picture, size,
// quantity). Prices, the coupon result and any problem with a line come
// from one server call — POST /api/orders/quote — so the cart shows exactly
// what an order would charge. Shipping isn't known here (no ward yet); it
// is added at checkout.
//
// Checkout is blocked while a line can't be ordered: discontinued, no
// longer sold in that size, or the shop doesn't have enough of one of its
// flowers (named on the line). The order route re-checks all of it anyway.

let lastQuote = null;
let quoteRequestId = 0;
let quoteTimer = null;

const COUPON_MESSAGES = {
  not_found: () => "Mã giảm giá không tồn tại.",
  inactive: () => "Mã giảm giá đã hết hiệu lực.",
  below_minimum: (c) => `Mã ${c.code} áp dụng cho đơn từ ${window.Bloomy.formatVND(c.min_subtotal)}.`,
  needs_date: (c) => `Mã ${c.code} áp dụng cho ngày giao ${dateRange(c)} — sẽ kiểm tra khi bạn chọn ngày ở bước đặt hàng.`,
  outside_dates: (c) => `Mã ${c.code} chỉ áp dụng cho ngày giao ${dateRange(c)}.`,
  applied: (c) => `Đã áp dụng mã ${c.code}.`,
};

function viDate(iso) {
  return iso.split("-").reverse().join("/");
}

function dateRange(c) {
  if (c.starts_on && c.ends_on) return `từ ${viDate(c.starts_on)} đến ${viDate(c.ends_on)}`;
  if (c.starts_on) return `từ ${viDate(c.starts_on)}`;
  return `đến ${viDate(c.ends_on)}`;
}

// How a cart line is found in the quote: a product by "id:size", a custom
// bouquet by the key the browser gave it (the server echoes it back).
function lineKey(item) {
  return item.custom ? item.key : `${item.productId}:${item.size}`;
}

// The quantity stepper, the line subtotal and the remove button — the same on
// a product row and a custom-bouquet row.
function lineControlsHtml(quantity, lineTotal) {
  return `
      <div class="qty-stepper">
        <button type="button" class="qty-minus" aria-label="Giảm số lượng">−</button>
        <span>${quantity}</span>
        <button type="button" class="qty-plus" aria-label="Tăng số lượng">+</button>
      </div>
      <div class="cart-item__line-subtotal">
        <p class="cart-item__line-subtotal-label">Tạm tính</p>
        <p class="cart-item__line-subtotal-value">${lineTotal}</p>
      </div>
      <button type="button" class="cart-item__remove" aria-label="Xóa sản phẩm">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 012-2h2a2 2 0 012 2v2"/></svg>
      </button>`;
}

// A custom bouquet row: no product page to link to, one shared picture, what it
// is made of and the customer's note. Everything customer-typed is escaped, and
// the row is found by its position (data-custom-index), never by putting the
// note into an attribute.
function customRowHtml(item, index, q) {
  const esc = window.Bloomy.escapeHtml;
  const invalid = Boolean(q && q.problem);
  const fresh = q && q.quantity === item.quantity;
  const badge = invalid
    ? `<div class="cart-item__badge-row"><span class="status-badge status-badge--discontinued">Bó hoa chưa hợp lệ</span></div>`
    : "";
  const short =
    q && q.short_flowers && q.short_flowers.length > 0
      ? `<p class="cart-item__short">Tạm thiếu hoa: ${esc(q.short_flowers.join(", "))}</p>`
      : "";
  const unit = q && !q.problem ? window.Bloomy.formatVND(q.unitPrice) : "…";
  const lineTotal = fresh && !q.problem ? window.Bloomy.formatVND(q.lineTotal) : "…";
  return `
    <div class="cart-item ${invalid ? "is-discontinued" : ""}" data-custom-index="${index}">
      <div class="cart-item__link">
        <img class="cart-item__image" src="${window.Bloomy.CUSTOM_IMAGE}" alt="Bó hoa tùy chỉnh">
        <div class="cart-item__info">
          ${badge}
          <p class="cart-item__name">Bó hoa tùy chỉnh</p>
          <p class="cart-item__composition">${esc(window.Bloomy.describeCustom(item, q))}</p>
          ${item.custom.note ? `<p class="cart-item__composition">Ghi chú: ${esc(item.custom.note)}</p>` : ""}
          ${short}
          <p class="cart-item__price">${unit}</p>
        </div>
      </div>
      ${lineControlsHtml(item.quantity, lineTotal)}
    </div>
  `;
}

// Draws every row from localStorage. Prices come from lastQuote when it
// matches the current cart; until then they show "…".
function renderCart() {
  const cart = window.Bloomy.cart.getCart();

  if (cart.length === 0) {
    document.getElementById("cart-empty").hidden = false;
    document.getElementById("cart-contents").hidden = true;
    return;
  }

  document.getElementById("cart-empty").hidden = true;
  document.getElementById("cart-contents").hidden = false;

  const count = window.Bloomy.cart.getCartCount(cart);
  document.getElementById("cart-item-count").textContent =
    `${count} sản phẩm trong giỏ — xem lại và chỉnh số lượng trước khi đặt nhé.`;

  const quoteLines = new Map((lastQuote ? lastQuote.lines : []).map((l) => [l.custom ? l.key : `${l.productId}:${l.size}`, l]));
  // Sizes each product comes in, from any line of that product in the last
  // quote — so the dropdown stays put while a size change is being re-priced.
  const sizesByProduct = new Map();
  (lastQuote ? lastQuote.lines : []).forEach((l) => {
    if (l.sizes && l.sizes.length > 0) sizesByProduct.set(l.productId, l.sizes);
  });

  const list = document.getElementById("cart-items-list");
  list.innerHTML = cart
    .map((item, index) => {
      if (item.custom) return customRowHtml(item, index, quoteLines.get(lineKey(item)));
      const q = quoteLines.get(lineKey(item));
      const fresh = q && q.quantity === item.quantity;
      const unavailable = q && (q.problem || q.status === "discontinued");
      const badge = unavailable
        ? `<div class="cart-item__badge-row"><span class="status-badge status-badge--discontinued">${
            q.problem ? "Không còn bán" : "Ngừng kinh doanh"
          }</span></div>`
        : "";
      const short =
        q && q.short_flowers && q.short_flowers.length > 0
          ? `<p class="cart-item__short">Tạm thiếu hoa: ${q.short_flowers.join(", ")}</p>`
          : "";
      const unit = q && !q.problem ? window.Bloomy.formatVND(q.unitPrice) : "…";
      const lineTotal = fresh && !q.problem ? window.Bloomy.formatVND(q.lineTotal) : "…";
      // Several sizes = a dropdown to switch (own cell, not inside the
      // product link, so opening it never navigates away). A single-size
      // product shows no size at all.
      const sizes = sizesByProduct.get(item.productId) || [];
      const sizeSelect =
        sizes.length > 1
          ? `<div class="cart-item__size">
        <select class="cart-item__size-select" aria-label="Đổi size ${item.name}">
          ${sizes
            .map(
              (s) =>
                `<option value="${s.size}"${s.size === item.size ? " selected" : ""}>${window.Bloomy.SIZE_LABELS[s.size]} · ${window.Bloomy.formatVND(s.price)}</option>`
            )
            .join("")}
        </select>
      </div>`
          : "";
      return `
    <div class="cart-item ${unavailable ? "is-discontinued" : ""}" data-product-id="${item.productId}" data-size="${item.size}">
      <a href="product.html?id=${item.productId}" class="cart-item__link">
        <img class="cart-item__image" src="${item.image}" alt="${item.name}">
        <div class="cart-item__info">
          ${badge}
          <p class="cart-item__name">${item.name}</p>
          ${short}
          <p class="cart-item__price">${unit}</p>
        </div>
      </a>
      ${sizeSelect}
      ${lineControlsHtml(item.quantity, lineTotal)}
    </div>
  `;
    })
    .join("");

  renderSummary(count);
  attachLineItemHandlers();
}

function renderSummary(count) {
  document.getElementById("cart-summary-label").textContent = `Tạm tính (${count})`;
  const subtotalEl = document.getElementById("cart-subtotal");
  const totalEl = document.getElementById("cart-total");
  const discountRow = document.getElementById("cart-discount-row");
  const msg = document.getElementById("coupon-msg");

  if (!lastQuote) {
    subtotalEl.textContent = "…";
    totalEl.textContent = "…";
    discountRow.hidden = true;
    applyCheckoutGate();
    return;
  }

  subtotalEl.textContent = window.Bloomy.formatVND(lastQuote.subtotal);
  totalEl.textContent = window.Bloomy.formatVND(lastQuote.subtotal - lastQuote.discount);

  const coupon = lastQuote.coupon;
  if (coupon && coupon.status === "applied") {
    document.getElementById("cart-discount-label").textContent = `Giảm giá (${coupon.code})`;
    document.getElementById("cart-discount").textContent = `−${window.Bloomy.formatVND(lastQuote.discount)}`;
    discountRow.hidden = false;
  } else {
    discountRow.hidden = true;
  }

  if (coupon) {
    msg.textContent = COUPON_MESSAGES[coupon.status](coupon);
    msg.className = `cart-coupon__msg ${coupon.status === "applied" ? "is-ok" : coupon.status === "needs_date" ? "" : "is-error"}`;
    msg.hidden = false;
  } else {
    msg.hidden = true;
  }

  applyCheckoutGate();
}

// Blocks checkout while any line can't be ordered, with the reason.
// A failed quote fails open: prices show "…" and the order route is still
// the real check.
function applyCheckoutGate() {
  const btn = document.getElementById("checkout-btn");
  const msg = document.getElementById("checkout-blocked-msg");
  let reason = "";
  if (lastQuote) {
    if (lastQuote.lines.some((l) => l.problem || l.status === "discontinued")) {
      reason = "Vui lòng xóa sản phẩm không còn bán khỏi giỏ hàng trước khi đặt hàng.";
    } else if (lastQuote.short_flowers.length > 0) {
      reason = `Bloomy tạm thiếu ${lastQuote.short_flowers.join(", ")} cho số lượng này. Vui lòng giảm số lượng hoặc chọn sản phẩm khác.`;
    }
  }
  btn.disabled = Boolean(reason);
  msg.textContent = reason;
  msg.hidden = !reason;
}

// Re-prices the cart. requestId drops answers that arrive after a newer
// change (fast +/− clicks), so only the latest cart is ever shown.
async function refreshQuote() {
  const requestId = ++quoteRequestId;
  try {
    const cart = window.Bloomy.cart.getCart();
    if (cart.length === 0) {
      lastQuote = null;
      return;
    }
    const result = await window.Bloomy.quote({ coupon_code: window.Bloomy.getCoupon() || null });
    if (requestId !== quoteRequestId) return;
    lastQuote = result;
    // A code that doesn't exist or was switched off isn't carried to checkout.
    if (result.coupon && (result.coupon.status === "not_found" || result.coupon.status === "inactive")) {
      window.Bloomy.setCoupon("");
    }
  } catch (err) {
    if (requestId !== quoteRequestId) return;
    console.error("Bloomy: failed to price the cart", err);
    lastQuote = null;
  }
  renderCart();
}

// Quantity clicks redraw at once and re-price after a short pause.
function scheduleQuote() {
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(refreshQuote, 350);
}

// Quantity and remove for a custom-bouquet row (found by its position in the cart).
function attachCustomHandlers(row) {
  const cartApi = window.Bloomy.cart;
  const item = cartApi.getCart()[Number(row.dataset.customIndex)];
  if (!item || !item.custom) return;
  const apply = (change) => {
    change();
    renderCart();
    scheduleQuote();
  };
  row.querySelector(".qty-minus").addEventListener("click", () => apply(() => cartApi.updateCustomQuantity(item.key, item.quantity - 1)));
  row.querySelector(".qty-plus").addEventListener("click", () => apply(() => cartApi.updateCustomQuantity(item.key, item.quantity + 1)));
  row.querySelector(".cart-item__remove").addEventListener("click", () => apply(() => cartApi.removeCustomItem(item.key)));
}

function attachLineItemHandlers() {
  document.querySelectorAll(".cart-item").forEach((row) => {
    if (row.dataset.customIndex !== undefined) {
      attachCustomHandlers(row);
      return;
    }
    const productId = parseInt(row.dataset.productId, 10);
    const size = row.dataset.size;
    const item = window.Bloomy.cart.getCart().find((i) => i.productId === productId && i.size === size);
    if (!item) return;

    const sizeSelect = row.querySelector(".cart-item__size-select");
    if (sizeSelect) {
      sizeSelect.addEventListener("change", () => {
        window.Bloomy.cart.changeSize(productId, size, sizeSelect.value);
        renderCart();
        scheduleQuote();
      });
    }

    row.querySelector(".qty-minus").addEventListener("click", () => {
      // At quantity 1, "−" removes the line — same behavior and same code
      // path as the trash button, agreed in chat.
      window.Bloomy.cart.updateQuantity(productId, size, item.quantity - 1);
      renderCart();
      scheduleQuote();
    });
    row.querySelector(".qty-plus").addEventListener("click", () => {
      window.Bloomy.cart.updateQuantity(productId, size, item.quantity + 1);
      renderCart();
      scheduleQuote();
    });
    row.querySelector(".cart-item__remove").addEventListener("click", () => {
      window.Bloomy.cart.removeItem(productId, size);
      renderCart();
      scheduleQuote();
    });
  });
}

function initCoupon() {
  const input = document.getElementById("coupon-input");
  input.value = window.Bloomy.getCoupon();
  const apply = () => {
    window.Bloomy.setCoupon(input.value.trim().toUpperCase());
    refreshQuote();
  };
  document.getElementById("coupon-apply").addEventListener("click", apply);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") apply();
  });
}

function initClearCart() {
  document.getElementById("clear-cart").addEventListener("click", () => {
    window.Bloomy.cart.clearCart();
    lastQuote = null;
    renderCart();
  });
}

function initCheckoutButton() {
  document.getElementById("checkout-btn").addEventListener("click", () => {
    if (document.getElementById("checkout-btn").disabled) return;
    window.location.href = "checkout.html";
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    renderCart();
    initCoupon();
    initClearCart();
    initCheckoutButton();
    await refreshQuote();
  } finally {
    document.body.classList.add("is-ready");
  }
});
