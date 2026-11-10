// Bloomy — Checkout page logic.
// Every amount on this page comes from POST /api/orders/quote (pricing.js
// on the server): re-asked whenever something that changes the price does —
// delivery or pickup, the ward, the delivery date (a coupon can depend on
// it). The browser never computes money itself.

let cart = [];
let lastQuote = null;
let quoteRequestId = 0;
let blockedReason = ""; // non-empty = the cart can't be ordered as it is
let currentToken = null;
let pollTimer = null;
let pollStartedAt = null;
let orderPlaced = false; // true from the moment the server accepts the order: the cart is cleared by us then, so cart-change events are ignored
let started = false; // the form is set up once, the first time the cart has something in it
let quotePending = false; // a price is on its way: the order button waits for it
let quoteTimer = null;

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — matches ZaloPay's own order-expiry window

// Same Vietnam-time approach as routes/orders.js, on purpose — a customer's
// device clock/timezone can't be trusted any more than the server's could,
// and this is only ever an advisory hint anyway. The server-side check at
// submission is the real enforcement regardless of what this computes.
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
function nowVN() {
  return new Date(Date.now() + VN_OFFSET_MS);
}
function todayVNDateString() {
  return nowVN().toISOString().slice(0, 10);
}
function tomorrowVNDateString() {
  const d = nowVN();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Mirrors routes/orders.js's WINDOW_END_MINUTES exactly — only ever matters
// for "morning" in practice under the DEFAULT rule, same-day, since
// afternoon/evening both end after 14:00, which already rules today out
// before either end time could be reached. A holiday override's own
// deadline (see below) always closes a date well before this could matter,
// so this stays a same-day-only, default-rule-only check.
const WINDOW_END_MINUTES = {
  morning: 11 * 60 + 30,
  afternoon: 17 * 60,
  evening: 21 * 60,
};

function nowVNMinutes() {
  const d = nowVN();
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// ---------------------------------------------------------------------------
// Real per-date deadline, fetched from the server (GET /api/orders/deadline)
// so a holiday/peak-day override is reflected here instead of a hardcoded
// "14:00". Memoized per date for the lifetime of this page load — the date
// picker doesn't need a fresh fetch every time the same date is reselected.
// Falls back to the plain default-rule instant (14:00 VN, i.e. 07:00 UTC)
// on any fetch failure — never blocks the customer from proceeding; the
// server re-checks authoritatively at submission regardless.
// ---------------------------------------------------------------------------
const deadlineCache = {};

async function getEffectiveDeadlineInfo(dateStr) {
  if (deadlineCache[dateStr]) return deadlineCache[dateStr];

  try {
    const res = await fetch(`/api/orders/deadline?date=${dateStr}`);
    if (!res.ok) throw new Error("bad response");
    const data = await res.json();
    const info = { deadline: new Date(data.deadline), isOverride: data.is_override };
    deadlineCache[dateStr] = info;
    return info;
  } catch (err) {
    console.error("Bloomy: failed to fetch deadline, falling back to default 14:00", err);
    return { deadline: new Date(`${dateStr}T07:00:00.000Z`), isOverride: false };
  }
}

// Greys out (and unchecks, if it was selected) every window once the
// selected date's own deadline has passed — plus, same-day only, any
// individual window whose own end time has passed under the still-open
// default rule (the gap a blanket deadline alone doesn't cover). Re-run on
// every date change, since switching dates must re-enable everything first.
function updateWindowAvailability(pastDeadline) {
  const dateInput = document.getElementById("delivery-date");
  const isToday = dateInput.value === todayVNDateString();
  const nowMinutes = nowVNMinutes();

  document.querySelectorAll(".window-option input").forEach((input) => {
    const windowEnded = isToday && !pastDeadline && nowMinutes > WINDOW_END_MINUTES[input.value];
    const ended = pastDeadline || windowEnded;
    input.disabled = ended;
    if (ended && input.checked) {
      input.checked = false;
    }
  });
}

// Fills in the cutoff-notice line for whatever's actually true of the
// selected date: blocked entirely, the plain default rule (only really
// binding when the picked date is today), or a specific override deadline
// (worth surfacing regardless of which date is picked — a holiday's
// deadline can fall well before the delivery date itself).
function updateCutoffNotice(deadline, pastDeadline, isOverride) {
  const span = document.querySelector("#checkout-cutoff-notice span");

  if (pastDeadline) {
    span.textContent = "Đã quá giờ nhận đơn cho ngày này. Vui lòng chọn ngày giao khác.";
    return;
  }

  if (!isOverride) {
    span.innerHTML =
      "Đặt trước <strong>14:00</strong> để được giao trong ngày, sau giờ này đơn sẽ giao vào ngày hôm sau.";
    return;
  }

  const vn = new Date(deadline.getTime() + VN_OFFSET_MS);
  const time = vn.toISOString().slice(11, 16);
  const dateLabel = vn.toISOString().slice(0, 10).split("-").reverse().join("/");
  span.innerHTML = `Ngày này chỉ nhận đơn đến <strong>${time} ngày ${dateLabel}</strong>.`;
}

// The one function that ties the three pieces above together — called at
// init and on every date change. requestId guards against rapid date
// changes resolving out of order: if the user picks date A then quickly
// date B, A's fetch can resolve AFTER B's and would otherwise overwrite
// B's already-correct UI with stale data for a date that's no longer
// selected. Only the most recent call's result is ever applied.
let cutoffRequestId = 0;

async function refreshCutoffState() {
  const requestId = ++cutoffRequestId;
  const dateInput = document.getElementById("delivery-date");
  const selectedDate = dateInput.value;

  if (!selectedDate) {
    // Nothing picked yet — plain default copy, and never pre-disable
    // windows before there's a date to evaluate them against.
    updateCutoffNotice(null, false, false);
    updateWindowAvailability(false);
    updateSubmitState();
    return;
  }

  const { deadline, isOverride } = await getEffectiveDeadlineInfo(selectedDate);
  if (requestId !== cutoffRequestId) return; // superseded by a newer date change

  const pastDeadline = Date.now() > deadline.getTime();
  updateCutoffNotice(deadline, pastDeadline, isOverride);
  updateWindowAvailability(pastDeadline);
  updateSubmitState();
}

// Summary column: each line, then goods, coupon, shipping, total — all from
// the last quote.
function renderSummary() {
  const list = document.getElementById("checkout-summary-items");
  const esc = window.Bloomy.escapeHtml;
  const quoteLines = new Map((lastQuote ? lastQuote.lines : []).map((l) => [l.custom ? l.key : `${l.productId}:${l.size}`, l]));
  // Redrawing replaces the buttons; keep keyboard focus on the same one.
  const focused = list.contains(document.activeElement) && document.activeElement.dataset.act
    ? { act: document.activeElement.dataset.act, i: document.activeElement.dataset.i }
    : null;
  list.innerHTML = cart
    .map((item, index) => {
      const q = quoteLines.get(item.custom ? item.key : `${item.productId}:${item.size}`);
      const unit = q && !q.problem ? window.Bloomy.formatVND(q.unitPrice) : "…";
      const line = q && !q.problem ? window.Bloomy.formatVND(q.lineTotal) : "…";
      const short = q && q.short_flowers.length > 0
        ? `<p class="checkout-summary__item-short">Tạm thiếu hoa: ${esc(q.short_flowers.join(", "))}</p>`
        : "";
      // A custom bouquet: one shared picture, what it is made of, the note.
      const image = item.custom ? window.Bloomy.CUSTOM_IMAGE : item.image;
      const title = item.custom
        ? "Bó hoa tùy chỉnh"
        : `${item.name}${q && q.sizes && q.sizes.length > 1 ? ` (${window.Bloomy.SIZE_LABELS[item.size] || ""})` : ""}`;
      const detail = item.custom
        ? `<p class="checkout-summary__item-detail">${esc(window.Bloomy.describeCustom(item, q))}${item.custom.note ? ` — Ghi chú: ${esc(item.custom.note)}` : ""}</p>`
        : "";
      return `
    <div class="checkout-summary__item">
      <img src="${image}" alt="${esc(title)}">
      <div class="checkout-summary__item-info">
        <p class="checkout-summary__item-name">${esc(title)}</p>
        ${detail}
        <p class="checkout-summary__item-qty">${unit} × ${item.quantity}</p>
        <div class="checkout-summary__controls">
          <div class="qty-stepper">
            <button type="button" data-act="minus" data-i="${index}" aria-label="Giảm số lượng: ${esc(title)}">−</button>
            <span>${item.quantity}</span>
            <button type="button" data-act="plus" data-i="${index}" aria-label="Tăng số lượng: ${esc(title)}">+</button>
          </div>
          <button type="button" class="checkout-summary__remove" data-act="remove" data-i="${index}" aria-label="Xóa khỏi đơn: ${esc(title)}">Xóa</button>
        </div>
        ${short}
      </div>
      <span class="checkout-summary__item-total">${line}</span>
    </div>
  `;
    })
    .join("");
  if (focused) list.querySelector(`[data-act="${focused.act}"][data-i="${focused.i}"]`)?.focus();

  const subtotalEl = document.getElementById("checkout-subtotal");
  const shippingEl = document.getElementById("checkout-shipping");
  const totalEl = document.getElementById("checkout-total");
  const discountRow = document.getElementById("checkout-discount-row");
  const couponMsg = document.getElementById("checkout-coupon-msg");

  if (!lastQuote) {
    subtotalEl.textContent = "…";
    shippingEl.textContent = "…";
    totalEl.textContent = "…";
    discountRow.hidden = true;
    couponMsg.hidden = true;
    return;
  }

  subtotalEl.textContent = window.Bloomy.formatVND(lastQuote.subtotal);

  const coupon = lastQuote.coupon;
  if (coupon && coupon.status === "applied") {
    document.getElementById("checkout-discount-label").textContent = `Giảm giá (${coupon.code})`;
    document.getElementById("checkout-discount").textContent = `−${window.Bloomy.formatVND(lastQuote.discount)}`;
    discountRow.hidden = false;
    couponMsg.hidden = true;
  } else {
    discountRow.hidden = true;
    // A code carried from the cart that doesn't apply (yet) is said out
    // loud here; it is simply not sent with the order.
    const text = coupon ? couponNotAppliedText(coupon) : "";
    couponMsg.textContent = text;
    couponMsg.hidden = !text;
  }

  if (getFulfillmentType() === "pickup") {
    shippingEl.textContent = "Miễn phí (nhận tại shop)";
  } else if (lastQuote.shipping_fee === null) {
    shippingEl.textContent = "Chọn phường để tính";
  } else {
    shippingEl.textContent = window.Bloomy.formatVND(lastQuote.shipping_fee);
  }
  totalEl.textContent = window.Bloomy.formatVND(lastQuote.total);
}

// The + / − / Xóa buttons in the summary change the same cart the cart page
// does. They only change it: saveCart() then fires bloomy:cart-changed and
// onCartChanged() below redraws everything. "−" at 1 removes the line, as on
// the cart page.
function onSummaryClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn || orderPlaced) return;
  const item = cart[Number(btn.dataset.i)];
  if (!item) return;
  const api = window.Bloomy.cart;
  const act = btn.dataset.act;
  const next = item.quantity + (act === "plus" ? 1 : -1);
  if (item.custom) {
    if (act === "remove") api.removeCustomItem(item.key);
    else api.updateCustomQuantity(item.key, next);
  } else if (act === "remove") {
    api.removeItem(item.productId, item.size);
  } else {
    api.updateQuantity(item.productId, item.size, next);
  }
}

function couponNotAppliedText(c) {
  const range = [c.starts_on, c.ends_on].filter(Boolean).map((d) => d.split("-").reverse().join("/")).join(" – ");
  switch (c.status) {
    case "needs_date": return `Mã ${c.code} sẽ được kiểm tra khi bạn chọn ngày giao.`;
    case "outside_dates": return `Mã ${c.code} chỉ áp dụng cho ngày giao ${range} — đơn này không được giảm.`;
    case "below_minimum": return `Mã ${c.code} áp dụng cho đơn từ ${window.Bloomy.formatVND(c.min_subtotal)} — đơn này không được giảm.`;
    case "inactive": return `Mã ${c.code} đã hết hiệu lực.`;
    case "not_found": return `Mã ${c.code} không tồn tại.`;
    default: return "";
  }
}

function getFulfillmentType() {
  const checked = document.querySelector('input[name="fulfillment_type"]:checked');
  return checked ? checked.value : "delivery";
}

// Re-prices the cart with whatever is chosen so far. requestId keeps a slow
// answer for an older choice from overwriting a newer one.
async function refreshQuote() {
  if (cart.length === 0) return;
  const requestId = ++quoteRequestId;
  quotePending = true;
  updateSubmitState();
  const isDelivery = getFulfillmentType() === "delivery";
  const wardValue = document.getElementById("ward-id").value;
  try {
    const result = await window.Bloomy.quote({
      coupon_code: window.Bloomy.getCoupon() || null,
      fulfillment_type: getFulfillmentType(),
      ward_id: isDelivery && wardValue ? parseInt(wardValue, 10) : null,
      delivery_date: document.getElementById("delivery-date").value || null,
    });
    if (requestId !== quoteRequestId) return;
    lastQuote = result;
  } catch (err) {
    if (requestId !== quoteRequestId) return;
    console.error("Bloomy: failed to price the order", err);
    lastQuote = null; // fail open: the order route prices and checks again
  }
  quotePending = false;

  // A line that can't be ordered blocks the button, with the reason shown.
  blockedReason = "";
  if (lastQuote) {
    if (lastQuote.lines.some((l) => l.problem || l.status === "discontinued")) {
      blockedReason = "Một sản phẩm trong giỏ không còn bán. Vui lòng quay lại giỏ hàng để xoá sản phẩm này trước khi đặt hàng.";
    } else if (lastQuote.short_flowers.length > 0) {
      blockedReason = `Bloomy tạm thiếu ${lastQuote.short_flowers.join(", ")} cho đơn này. Vui lòng quay lại giỏ hàng để giảm số lượng hoặc chọn sản phẩm khác.`;
    }
  }
  const errorEl = document.getElementById("checkout-error");
  if (blockedReason) {
    showError(blockedReason);
    errorEl.dataset.source = "quote";
  } else if (errorEl.dataset.source === "quote") {
    clearError(); // the problem this quote reported earlier is gone
  }

  renderSummary();
  if (lastQuote) {
    // "Sold out today" is per product, all sizes: today can't be picked.
    await applyDateMin(lastQuote.lines.some((l) => l.status === "sold_out_today"));
  }
  updateSubmitState();
}

// Sets the date input's floor. Called once synchronously-ish (awaited) with
// the deadline-only answer (best info available before any per-item status
// is known), then again after every quote, which carries each line's status.
async function applyDateMin(anySoldOutToday) {
  const dateInput = document.getElementById("delivery-date");
  const today = todayVNDateString();
  const { deadline } = await getEffectiveDeadlineInfo(today);
  const todayUnavailable = Date.now() > deadline.getTime() || anySoldOutToday;
  dateInput.min = todayUnavailable ? tomorrowVNDateString() : today;

  if (dateInput.value && dateInput.value < dateInput.min) {
    dateInput.value = "";
  }
}

function showError(message) {
  const el = document.getElementById("checkout-error");
  el.textContent = message;
  el.hidden = false;
}

function clearError() {
  const el = document.getElementById("checkout-error");
  el.hidden = true;
  el.textContent = "";
  delete el.dataset.source;
}

function updateSubmitState() {
  const form = document.getElementById("checkout-form");
  const btn = document.getElementById("place-order-btn");
  const help = document.getElementById("place-order-help");
  const valid = form.checkValidity();
  btn.disabled = !valid || Boolean(blockedReason) || quotePending;
  help.hidden = valid;
}

// Maps the server's rejection shape (routes/orders.js) to real copy.
function errorMessageFor(data) {
  if (data.error === "unavailable") {
    const messages = {
      rejected_discontinued: "Một sản phẩm trong đơn đã ngừng kinh doanh. Vui lòng quay lại giỏ hàng.",
      rejected_sold_out_today: "Một sản phẩm không thể giao trong hôm nay. Vui lòng chọn ngày khác.",
      rejected_past_cutoff: "Đã quá giờ nhận đơn cho ngày đã chọn. Vui lòng chọn ngày giao khác.",
      rejected_window_passed: "Khung giờ này đã kết thúc cho hôm nay. Vui lòng chọn khung giờ hoặc ngày khác.",
      rejected_flower_shortage:
        data.short_flowers && data.short_flowers.length > 0
          ? `Bloomy vừa hết ${data.short_flowers.join(", ")} cho đơn này. Vui lòng quay lại giỏ hàng để giảm số lượng hoặc chọn sản phẩm khác.`
          : "Bloomy vừa hết một số loại hoa cho đơn này. Vui lòng quay lại giỏ hàng để điều chỉnh.",
    };
    return messages[data.reason] || "Rất tiếc, đơn hàng không thể xử lý. Vui lòng thử lại.";
  }
  if (data.error === "coupon_not_applied") {
    return "Mã giảm giá không còn áp dụng cho đơn này. Vui lòng xem lại tổng tiền rồi đặt lại.";
  }
  if (data.error === "invalid_item") {
    return "Một sản phẩm trong giỏ không còn bán theo lựa chọn này. Vui lòng quay lại giỏ hàng.";
  }
  if (data.error === "unknown_ward") return "Vui lòng chọn lại phường / xã giao hàng.";
  if (data.error === "invalid_date") return "Ngày giao không hợp lệ.";

  if (data.error === "invalid_payload") {
    const fieldErrors = data.details?.fieldErrors || {};
    if (Object.keys(fieldErrors).some((key) => key.startsWith("invoice_"))) {
      return "Vui lòng kiểm tra lại thông tin xuất hóa đơn (tên công ty, mã số thuế, địa chỉ và email nhận hóa đơn).";
    }
    if (fieldErrors.sender_phone || fieldErrors.recipient_phone) {
      return "Số điện thoại chỉ được chứa số. Vui lòng kiểm tra lại.";
    }
    if (fieldErrors.customer_email) {
      return "Email không hợp lệ. Vui lòng kiểm tra lại hoặc để trống.";
    }
    return "Vui lòng kiểm tra lại thông tin đã nhập.";
  }

  return "Rất tiếc, đơn hàng không thể xử lý. Vui lòng thử lại.";
}

async function handleSubmit(e) {
  e.preventDefault();
  const form = e.target;

  // Belt-and-suspenders — updateSubmitState already keeps the button
  // disabled until valid, but an Enter-key submit can slip in ahead of that
  // state syncing. Native reportValidity() surfaces the browser's own
  // "please fill this in" bubble if so.
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  clearError();
  const btn = document.getElementById("place-order-btn");
  btn.disabled = true;
  btn.textContent = "Đang xử lý...";

  const formData = new FormData(form);
  const invoiceRequested = formData.get("invoice_requested") === "yes";
  const isDelivery = formData.get("fulfillment_type") === "delivery";
  const payload = {
    items: window.Bloomy.cart.toQuoteItems(cart),
    fulfillment_type: formData.get("fulfillment_type"),
    // Ward and street only for delivery (the inputs are disabled for pickup).
    ...(isDelivery && {
      ward_id: parseInt(formData.get("ward_id"), 10),
      delivery_address: formData.get("delivery_address"),
    }),
    // Sent only when the last quote said it applies — a code that doesn't
    // apply is shown as such in the summary, never sent to fail the order.
    coupon_code: lastQuote && lastQuote.coupon && lastQuote.coupon.status === "applied" ? lastQuote.coupon.code : null,
    sender_name: formData.get("sender_name"),
    sender_phone: formData.get("sender_phone"),
    recipient_name: formData.get("recipient_name"),
    recipient_phone: formData.get("recipient_phone"),
    notes: formData.get("notes") || null,
    customer_email: formData.get("customer_email") || undefined,
    source: window.Bloomy.getSource(),
    session_id: window.Bloomy.getSessionId?.(), // undefined (and dropped from the JSON) if main.js is an older copy
    delivery_date: formData.get("delivery_date"),
    delivery_window: formData.get("delivery_window"),
    payment_method: formData.get("payment_method"),
    consent: formData.get("consent") === "yes",
    invoice_requested: invoiceRequested,
    // Only sent when requested; the inputs are disabled otherwise.
    ...(invoiceRequested && {
      invoice_company_name: formData.get("invoice_company_name"),
      invoice_tax_code: formData.get("invoice_tax_code"),
      invoice_address: formData.get("invoice_address"),
    }),
  };

  try {
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (!res.ok) {
      showError(errorMessageFor(data));
      btn.disabled = false;
      btn.textContent = "Đặt hàng";
      return;
    }

    // The order is real and committed from here on, regardless of method.
    // orderPlaced first: clearCart() fires bloomy:cart-changed, and the page
    // must not react to the cart emptying itself (it would flip to "empty").
    orderPlaced = true;
    window.Bloomy.cart.clearCart();

    // The coupon belonged to this cart; it doesn't follow the customer on.
    window.Bloomy.setCoupon("");

    if (data.payment_method === "cod" || data.payment_method === "cash") {
      window.location.href = `order-confirmation.html?token=${data.token}`;
      return;
    }

    if (data.zalopay_error) {
      // Order exists but createOrder itself failed — Confirmation becomes
      // the source of truth from here; a proper retry-payment action is
      // Confirmation-phase work, not this page's.
      window.location.href = `order-confirmation.html?token=${data.token}`;
      return;
    }

    showPaymentWaiting(data);
  } catch (err) {
    console.error("Bloomy: checkout submission failed", err);
    showError("Có lỗi xảy ra, vui lòng thử lại.");
    btn.disabled = false;
    btn.textContent = "Đặt hàng";
  }
}

function showPaymentWaiting(data) {
  currentToken = data.token;
  document.getElementById("checkout-form-view").hidden = true;
  document.getElementById("payment-waiting").hidden = false;
  // A page that shows more than the checkout (the landing page) hides the rest.
  document.dispatchEvent(new CustomEvent("bloomy:payment-waiting"));

  // The amount ZaloPay will charge, as the server stored it on the order.
  document.getElementById("payment-waiting-amount").textContent = window.Bloomy.formatVND(data.total_amount);

  const img = document.getElementById("zalopay-qr");
  const loading = document.getElementById("zalopay-qr-loading");
  if (data.qr_data_url) {
    img.src = data.qr_data_url;
    img.hidden = false;
    loading.hidden = true;
  } else {
    // Shouldn't normally happen (a missing QR without zalopay_error means
    // the server thought it succeeded but sent nothing) — surfacing it
    // plainly beats leaving "Đang tạo mã QR..." spinning forever.
    loading.textContent = "Không thể tạo mã QR. Vui lòng liên hệ Bloomy qua Zalo.";
    console.error("Bloomy: order created but no qr_data_url in response", data);
  }

  // Same order_url the QR encodes — opened directly (vs. scanned) it lands
  // on ZaloPay's own method picker: wallet QR, domestic card/account,
  // international card. Confirmed live on this sandbox account 2026-09-13.
  const altLink = document.getElementById("zalopay-alt-link");
  if (data.order_url) {
    altLink.href = data.order_url;
    altLink.hidden = false;
  } else {
    altLink.hidden = true;
  }

  startPolling();
}

function startPolling() {
  pollStartedAt = Date.now();
  pollTimer = setInterval(async () => {
    if (Date.now() - pollStartedAt > POLL_TIMEOUT_MS) {
      clearInterval(pollTimer);
      document.getElementById("payment-status-msg").textContent =
        "Chưa nhận được xác nhận thanh toán. Nếu bạn đã thanh toán, hãy bấm nút bên dưới.";
      return;
    }
    await checkPaymentStatus();
  }, POLL_INTERVAL_MS);
}

// Reads our own DB state only (GET /api/orders/:token) — reflects whatever
// the IPN handler has already written, never talks to ZaloPay directly.
async function checkPaymentStatus() {
  try {
    const res = await fetch(`/api/orders/${currentToken}`);
    if (!res.ok) return;
    const order = await res.json();
    if (order.payment_status === "paid") {
      clearInterval(pollTimer);
      window.location.href = `order-confirmation.html?token=${currentToken}`;
    }
  } catch (err) {
    console.error("Bloomy: payment status poll failed", err);
    // Fail silent — the next tick just tries again.
  }
}

// The manual fallback — actually asks ZaloPay via the server's
// verify-payment route, never just trusts the click.
async function handleManualVerify() {
  const btn = document.getElementById("verify-payment-btn");
  const msg = document.getElementById("payment-status-msg");
  btn.disabled = true;
  msg.textContent = "Đang kiểm tra với ZaloPay...";

  try {
    const res = await fetch(`/api/orders/${currentToken}/verify-payment`, { method: "POST" });
    const data = await res.json();

    if (data.payment_status === "paid") {
      clearInterval(pollTimer);
      window.location.href = `order-confirmation.html?token=${currentToken}`;
    } else {
      msg.textContent = "Chưa nhận được thanh toán. Vui lòng thử lại sau ít phút.";
    }
  } catch (err) {
    console.error("Bloomy: manual verify failed", err);
    msg.textContent = "Có lỗi khi kiểm tra, vui lòng thử lại.";
  } finally {
    btn.disabled = false;
  }
}

// Live, per-field feedback — shows only after the field's first blur (so a
// blank field doesn't show red the moment the page loads), then updates on
// every keystroke after that. This is the only path that actually reaches
// the person: the submit button is disabled while the pattern doesn't
// match, so there's never a submit attempt for the browser's native
// validation bubble to fire on.
function wireFieldValidation(inputId, errorId) {
  const input = document.getElementById(inputId);
  const errorEl = document.getElementById(errorId);
  let touched = false;

  function isValidPhone(value) {
    // \s strips ANY whitespace-like character, not just a literal ASCII
    // space — a number pasted from Contacts/Notes/etc. can carry a
    // non-breaking space or similar that looks identical but wouldn't
    // match a literal " " in a pattern.
    const digitsOnly = value.replace(/\s/g, "");
    return /^[0-9]{9,12}$/.test(digitsOnly);
  }

  function refreshValidity() {
    const valid = isValidPhone(input.value);
    // Drives the native validity API (checkValidity/validity.valid), which
    // updateSubmitState already reads — this must run on every keystroke,
    // not just after the first blur, or the submit button could stay
    // wrongly enabled for bad input right up until the field is blurred.
    input.setCustomValidity(valid ? "" : "Chỉ nhập số, 9–12 chữ số");
    if (touched) errorEl.hidden = valid;
  }

  input.addEventListener("blur", () => {
    touched = true;
    refreshValidity();
  });
  input.addEventListener("input", refreshValidity);
}

// Optional "Tôi muốn xuất hóa đơn" block. Unticked, its fields are disabled
// (so they're skipped by checkValidity and FormData) and the email stays
// optional. Ticked, they become required and the email becomes required too
// (the e-invoice is delivered by email). The tax-code check mirrors
// routes/orders.js (10 digits, or 10 + a 3-digit branch suffix); the server
// re-validates regardless.
function wireInvoiceToggle() {
  const toggle = document.getElementById("invoice-requested");
  const fields = document.getElementById("invoice-fields");
  const inputs = fields.querySelectorAll("input, textarea");
  const email = document.getElementById("sender-email");
  const emailOptional = document.getElementById("sender-email-optional");
  const taxInput = document.getElementById("invoice-tax-code");
  const taxError = document.getElementById("invoice-tax-code-error");
  let taxTouched = false;

  function isValidTaxCode(value) {
    return /^[0-9]{10}(-?[0-9]{3})?$/.test(value.replace(/\s/g, ""));
  }

  function refreshTaxValidity() {
    const valid = isValidTaxCode(taxInput.value);
    taxInput.setCustomValidity(valid ? "" : "Mã số thuế gồm 10 hoặc 13 chữ số");
    if (taxTouched) taxError.hidden = valid;
  }

  function apply() {
    const on = toggle.checked;
    fields.hidden = !on;
    inputs.forEach((el) => {
      el.disabled = !on;
      el.required = on;
    });
    email.required = on;
    emailOptional.hidden = on;
    if (on) {
      refreshTaxValidity();
    } else {
      taxInput.setCustomValidity("");
      taxError.hidden = true;
    }
    updateSubmitState();
  }

  taxInput.addEventListener("blur", () => {
    taxTouched = true;
    refreshTaxValidity();
  });
  taxInput.addEventListener("input", refreshTaxValidity);
  toggle.addEventListener("change", apply);
  apply();
}

// Delivery vs pickup: shows the matching block and payment options.
// Fields that don't apply are DISABLED, not just hidden, so the browser
// neither validates nor submits them.
function applyFulfillment() {
  const pickup = getFulfillmentType() === "pickup";

  const deliveryFields = document.getElementById("delivery-fields");
  deliveryFields.hidden = pickup;
  deliveryFields.querySelectorAll("select, textarea").forEach((el) => {
    el.disabled = pickup;
  });
  document.getElementById("pickup-info").hidden = !pickup;
  document.getElementById("same-person-wrap").hidden = !pickup;
  if (!pickup) setSamePerson(false);

  document.getElementById("date-section-title").textContent = pickup
    ? "Chọn ngày & khung giờ nhận"
    : "Chọn ngày & khung giờ giao";
  document.getElementById("delivery-date-label").textContent = pickup ? "NGÀY NHẬN HOA" : "NGÀY GIAO HÀNG";
  document.getElementById("delivery-window-label").textContent = pickup ? "KHUNG GIỜ NHẬN" : "KHUNG GIỜ GIAO";

  // COD is delivery-only, cash at the shop is pickup-only; ZaloPay is both.
  const allowed = pickup ? ["cash", "zalopay"] : ["cod", "zalopay"];
  document.querySelectorAll('input[name="payment_method"]').forEach((input) => {
    const ok = allowed.includes(input.value);
    input.disabled = !ok;
    input.closest(".payment-option").hidden = !ok;
    if (!ok && input.checked) input.checked = false;
  });
  if (!document.querySelector('input[name="payment_method"]:checked')) {
    document.querySelector(`input[name="payment_method"][value="${allowed[0]}"]`).checked = true;
  }
  updateSubmitState();
}

async function loadWards() {
  const select = document.getElementById("ward-id");
  try {
    const res = await fetch("/api/settings/wards");
    if (!res.ok) throw new Error(`wards: ${res.status}`);
    const wards = await res.json();
    select.insertAdjacentHTML(
      "beforeend",
      wards.map((w) => `<option value="${w.id}">${w.name}</option>`).join("")
    );
  } catch (err) {
    console.error("Bloomy: failed to load wards", err);
    showError("Không tải được danh sách phường. Vui lòng tải lại trang.");
  }
}

// "Người nhận là người đặt" (pickup only): copies the sender's name and
// phone into the recipient fields and keeps them in step while ticked.
function setSamePerson(on) {
  const box = document.getElementById("same-person");
  box.checked = on;
  const name = document.getElementById("recipient-name");
  const phone = document.getElementById("recipient-phone");
  name.readOnly = on;
  phone.readOnly = on;
  if (on) {
    name.value = document.getElementById("sender-name").value;
    phone.value = document.getElementById("sender-phone").value;
    phone.dispatchEvent(new Event("input")); // re-run the phone check
  }
  updateSubmitState();
}

function initSamePerson() {
  const box = document.getElementById("same-person");
  box.addEventListener("change", () => setSamePerson(box.checked));
  ["sender-name", "sender-phone"].forEach((id) => {
    document.getElementById(id).addEventListener("input", () => {
      if (box.checked) setSamePerson(true);
    });
  });
}

async function init() {
  try {
    await initCheckout();
  } finally {
    document.body.classList.add("is-ready");
  }
}

async function initCheckout() {
  cart = window.Bloomy.cart.getCart();
  window.addEventListener("bloomy:cart-changed", onCartChanged);
  document.getElementById("checkout-summary-items").addEventListener("click", onSummaryClick);
  await applyCart();
}

// The cart changed: from this page's summary buttons, or from product cards
// on the same page (the landing page). Once the order exists the cart is
// cleared by us, so those events are ignored.
function onCartChanged() {
  if (orderPlaced) return;
  cart = window.Bloomy.cart.getCart();
  applyCart();
}

// Shows what the cart now calls for: the empty message, or the form with an
// up-to-date summary. The form itself is set up once, the first time the
// cart has something in it (a direct visit with an empty cart sets up nothing).
async function applyCart() {
  const emptyEl = document.getElementById("checkout-empty");
  const formView = document.getElementById("checkout-form-view");

  if (cart.length === 0) {
    clearTimeout(quoteTimer);
    quotePending = false;
    lastQuote = null;
    if (emptyEl) emptyEl.hidden = false;
    formView.hidden = true;
    return;
  }

  if (emptyEl) emptyEl.hidden = true;
  formView.hidden = false;

  if (started) {
    // Already set up: a different cart only means new lines and new prices.
    lastQuote = null;
    renderSummary();
    scheduleQuote();
    return;
  }
  started = true;
  window.Bloomy.track?.("checkout_view"); // optional call: tracking must never be able to break checkout

  renderSummary();
  loadWards();
  applyFulfillment();
  await applyDateMin(false); // best-known state before the first quote resolves
  refreshQuote(); // prices + per-line status; re-applies the date min once known
  await refreshCutoffState(); // notice text + window availability for whatever ended up selected (nothing, at this point)
  document.getElementById("delivery-date").addEventListener("change", () => {
    refreshCutoffState();
    refreshQuote(); // a coupon's date window is checked against this date
  });
  document.querySelectorAll('input[name="fulfillment_type"]').forEach((input) => {
    input.addEventListener("change", () => {
      applyFulfillment();
      refreshQuote();
    });
  });
  document.getElementById("ward-id").addEventListener("change", refreshQuote);
  initSamePerson();

  const form = document.getElementById("checkout-form");
  form.addEventListener("input", updateSubmitState);
  form.addEventListener("change", updateSubmitState);
  form.addEventListener("submit", handleSubmit);
  wireFieldValidation("sender-phone", "sender-phone-error");
  wireFieldValidation("recipient-phone", "recipient-phone-error");
  wireInvoiceToggle();
  updateSubmitState();

  document.getElementById("verify-payment-btn").addEventListener("click", handleManualVerify);
}

// Re-prices shortly after the last cart change (a few quick clicks on + make
// one request). The order button waits meanwhile, so a stale total or coupon
// can't be submitted.
function scheduleQuote() {
  quotePending = true;
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(refreshQuote, 250);
  updateSubmitState();
}

document.addEventListener("DOMContentLoaded", init);

// Guards against the browser restoring this exact page (bfcache) on
// back/forward navigation after a successful order — without this, the
// old filled-in form and old `cart` variable stay in memory and a second
// "Đặt hàng" click would create a real duplicate order. Forcing a reload
// makes init() run fresh, which correctly shows the empty-cart guard
// above once localStorage's cart is actually empty.
window.addEventListener("pageshow", (e) => {
  if (e.persisted) window.location.reload();
});
