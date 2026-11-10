// Bloomy — Order Confirmation page logic.

const WINDOW_LABELS = {
  morning: { label: "Buổi sáng", time: "8:00 – 11:30" },
  afternoon: { label: "Buổi chiều", time: "13:00 – 17:00" },
  evening: { label: "Buổi tối", time: "18:00 – 21:00" },
};

const FULFILLMENT_LABELS = {
  new: "Mới nhận",
  delivering: "Đang giao",
  delivered: "Đã giao",
  cancelled: "Đã huỷ",
};

// Pickup orders reuse the same statuses underneath, with pickup wording.
const PICKUP_FULFILLMENT_LABELS = {
  new: "Mới nhận",
  delivering: "Sẵn sàng nhận",
  delivered: "Đã nhận",
  cancelled: "Đã huỷ",
};

const PAYMENT_STATUS_TEXT = {
  cod: {
    pending: {
      title: "Thanh toán khi nhận hàng (COD)",
      desc: "Chưa thanh toán — trả tiền mặt khi giao hoa.",
    },
    paid: {
      title: "Thanh toán khi nhận hàng (COD)",
      desc: "Đã thanh toán.",
    },
    refunded: {
      title: "Thanh toán khi nhận hàng (COD)",
      desc: "Đã hoàn tiền.",
    },
  },
  cash: {
    pending: {
      title: "Tiền mặt tại shop",
      desc: "Chưa thanh toán — trả tiền mặt khi nhận hoa tại shop.",
    },
    paid: {
      title: "Tiền mặt tại shop",
      desc: "Đã thanh toán.",
    },
    refunded: {
      title: "Tiền mặt tại shop",
      desc: "Đã hoàn tiền.",
    },
  },
  zalopay: {
    paid: {
      title: "Thanh toán qua ZaloPay",
      desc: "Đã thanh toán.",
    },
    pending: {
      title: "Thanh toán qua ZaloPay",
      // Two genuinely different situations share this text on purpose:
      // (a) a QR was shown and the IPN just hasn't landed yet, (b)
      // createOrder itself failed and no QR was ever shown. The retry
      // button below covers both — clicking it always gets a fresh QR
      // regardless of which case this order is actually in.
      desc: "Chưa thanh toán. Nếu bạn đã quét mã nhưng chưa được xác nhận, hãy thử xác minh lại hoặc thanh toán lại bên dưới.",
    },
    failed: {
      title: "Thanh toán qua ZaloPay",
      desc: "Thanh toán không thành công — vui lòng thử lại bên dưới.",
    },
    refunded: {
      title: "Thanh toán qua ZaloPay",
      desc: "Đã hoàn tiền.",
    },
  },
};

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — matches ZaloPay's own order-expiry window

let currentToken = null;
let currentTotalAmount = null;
let pollTimer = null;
let pollStartedAt = null;

// "b***@gmail.com" — enough for the customer to spot a typo without
// putting the full address back on a page anyone with the confirmation
// link can open.
function maskEmail(email) {
  const at = email.indexOf("@");
  if (at <= 0) return email;
  return `${email[0]}***${email.slice(at)}`;
}

function renderItems(items) {
  const esc = window.Bloomy.escapeHtml;
  const list = document.getElementById("confirmation-items");
  list.innerHTML = items
    .map((item) => {
      // A custom bouquet has no product row: one shared picture, what it was
      // made of, the style and the note — all from the order's own copy.
      const title = item.custom
        ? item.name
        : `${item.name}${item.size && item.product_id ? ` (${window.Bloomy.SIZE_LABELS[item.size]})` : ""}`;
      const detail = item.custom
        ? `<p class="checkout-summary__item-detail">${esc(item.style_label)}: ${esc(item.flowers.map((f) => `${f.name} × ${f.stems}`).join(", "))}${item.note ? ` — Ghi chú: ${esc(item.note)}` : ""}</p>`
        : "";
      return `
    <div class="checkout-summary__item">
      <img src="${item.custom ? window.Bloomy.CUSTOM_IMAGE : item.image}" alt="${esc(title)}">
      <div class="checkout-summary__item-info">
        <p class="checkout-summary__item-name">${esc(title)}</p>
        ${detail}
        <p class="checkout-summary__item-qty">${window.Bloomy.formatVND(item.price)} × ${item.quantity}</p>
      </div>
      <span class="checkout-summary__item-total">${window.Bloomy.formatVND(item.price * item.quantity)}</span>
    </div>
  `;
    })
    .join("");
}

function renderOrder(order) {
  document.getElementById("order-code").textContent = order.order_code;

  const pickup = order.fulfillment_type === "pickup";

  // Shown only once the shop has entered the GHTK code.
  const trackingEl = document.getElementById("confirmation-tracking");
  if (order.tracking_code) {
    document.getElementById("confirmation-tracking-code").textContent = order.tracking_code;
    trackingEl.hidden = false;
  } else {
    trackingEl.hidden = true;
  }

  document.getElementById("confirmation-place-title").textContent = pickup ? "Thông tin nhận hoa" : "Thông tin giao hàng";
  document.getElementById("confirmation-date-label").textContent = pickup ? "Ngày nhận" : "Ngày giao";
  document.getElementById("confirmation-date").textContent = order.delivery_date;
  const win = WINDOW_LABELS[order.delivery_window];
  // A counter (POS) sale has no time window.
  document.getElementById("confirmation-window").textContent = win ? win.label : "Mua tại quầy";
  document.getElementById("confirmation-window-time").textContent = win ? win.time : "";

  document.getElementById("confirmation-recipient-name").textContent = order.recipient_name;
  document.getElementById("confirmation-recipient-phone").textContent = order.recipient_phone;
  if (pickup) {
    document.getElementById("confirmation-address-label").textContent = "Nhận tại shop";
    window.Bloomy.getSettings().then((settings) => {
      document.getElementById("confirmation-address").textContent = settings ? settings.shop_address : "";
    });
  } else {
    document.getElementById("confirmation-address-label").textContent = "Địa chỉ giao hàng";
    document.getElementById("confirmation-address").textContent = `${order.delivery_address}, ${order.ward_name}`;
  }
  document.getElementById("confirmation-sender-name").textContent = order.sender_name;
  document.getElementById("confirmation-sender-phone").textContent = order.sender_phone;

  const statusText =
    (PAYMENT_STATUS_TEXT[order.payment_method] || {})[order.payment_status] ||
    PAYMENT_STATUS_TEXT.cod.pending;
  document.getElementById("payment-status-title").textContent = statusText.title;
  document.getElementById("payment-status-desc").textContent = statusText.desc;

  const fulfillmentLabels = pickup ? PICKUP_FULFILLMENT_LABELS : FULFILLMENT_LABELS;
  document.getElementById("confirmation-fulfillment").textContent =
    `${pickup ? "Trạng thái nhận hoa" : "Trạng thái giao hàng"}: ${fulfillmentLabels[order.fulfillment_status] || fulfillmentLabels.new}`;

  const emailNoteEl = document.getElementById("confirmation-email-note");
  if (order.customer_email) {
    emailNoteEl.textContent = `Đã gửi xác nhận tới ${maskEmail(order.customer_email)}`;
    emailNoteEl.hidden = false;
  } else {
    emailNoteEl.hidden = true;
  }

  // Invoice recap: only a status line, never the typed company details —
  // the page is reachable by anyone holding the order link, so it just
  // confirms the request was recorded (the email goes to the address given).
  const invoiceNoteEl = document.getElementById("confirmation-invoice-note");
  if (order.invoice_requested) {
    invoiceNoteEl.textContent = "Đã ghi nhận yêu cầu xuất hóa đơn — hóa đơn điện tử sẽ được gửi qua email của bạn.";
    invoiceNoteEl.hidden = false;
  } else {
    invoiceNoteEl.hidden = true;
  }

  const heroIcon = document.getElementById("confirmation-hero-icon");
  const heroEyebrow = document.getElementById("confirmation-hero-eyebrow");
  const heroHeading = document.getElementById("confirmation-hero-heading");
  const heroSubtitle = document.getElementById("confirmation-hero-subtitle");

  // Four hero framings, checked in this order — cancelled and refunded
  // both override the celebratory/needs-payment framing below regardless
  // of the raw payment_status combination, the same kind of mismatch the
  // needsPayment branch was already built to avoid for ZaloPay-unpaid.
  if (order.fulfillment_status === "cancelled") {
    heroIcon.innerHTML =
      '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
    heroEyebrow.textContent = "Đơn hàng đã huỷ";
    heroHeading.innerHTML = "Đơn hàng này <em>đã được huỷ</em>";
    heroSubtitle.textContent =
      "Nếu bạn đã thanh toán, Bloomy sẽ liên hệ để xử lý hoàn tiền theo Điều khoản dịch vụ. Có thắc mắc, vui lòng liên hệ qua Zalo hoặc hotline.";
  } else if (order.payment_status === "refunded") {
    // Reachable even for a non-cancelled order — e.g. a damaged-bouquet
    // refund under terms.html §6 happens after delivery, so
    // fulfillment_status can be "delivered" here, not "cancelled".
    heroIcon.innerHTML =
      '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 10h11a5 5 0 010 10H9"/><polyline points="7 6 3 10 7 14"/></svg>';
    heroEyebrow.textContent = "Đã hoàn tiền";
    heroHeading.innerHTML = "Đơn hàng đã được <em>hoàn tiền</em>";
    heroSubtitle.textContent =
      "Bloomy đã ghi nhận hoàn tiền cho đơn hàng này. Có thắc mắc, vui lòng liên hệ qua Zalo hoặc hotline.";
  } else {
    const needsPayment = order.payment_method === "zalopay" && ["pending", "failed"].includes(order.payment_status);

    if (needsPayment) {
      heroIcon.innerHTML =
        '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
      heroEyebrow.textContent = "Cần hoàn tất thanh toán";
      heroHeading.innerHTML = "Đơn hàng đã được <em>ghi nhận</em>";
      heroSubtitle.textContent =
        "Đơn hàng của bạn đã được lưu lại, nhưng thanh toán chưa hoàn tất. Vui lòng thanh toán để Bloomy tiến hành giao hoa đúng ngày & khung giờ bạn đã chọn.";
    } else {
      heroIcon.innerHTML =
        '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="16 9 11 15 8 12"/></svg>';
      heroEyebrow.textContent = "Đặt hàng thành công";
      heroHeading.innerHTML = "Cảm ơn bạn — <em>hoa đang trên đường!</em>";
      heroSubtitle.textContent = pickup
        ? "Bloomy đã nhận được đơn hàng của bạn. Hoa sẽ sẵn sàng tại shop đúng ngày & khung giờ bạn đã chọn."
        : "Bloomy đã nhận được đơn hàng của bạn. Chúng tôi sẽ liên hệ xác nhận và giao hoa đúng ngày & khung giờ bạn đã chọn.";
    }
  }

  // Retry button only makes sense for a ZaloPay order that's still
  // pending/failed AND not cancelled — never for COD, never once paid or
  // refunded, and never for a cancelled order (matches the same
  // pending/failed + not-cancelled guard routes/orders.js's own
  // retry-zalopay-payment route enforces server-side).
  const retryBtn = document.getElementById("retry-zalopay-btn");
  retryBtn.hidden = !(
    order.fulfillment_status !== "cancelled" &&
    order.payment_method === "zalopay" &&
    ["pending", "failed"].includes(order.payment_status)
  );

  renderItems(order.items);
  // Every amount is the order's own stored figure — not recomputed
  // client-side from the items list, same trust rule as everywhere else.
  document.getElementById("confirmation-subtotal").textContent = window.Bloomy.formatVND(order.subtotal);
  const discountRow = document.getElementById("confirmation-discount-row");
  if (order.discount > 0) {
    document.getElementById("confirmation-discount-label").textContent = `Giảm giá (${order.coupon_code})`;
    document.getElementById("confirmation-discount").textContent = `−${window.Bloomy.formatVND(order.discount)}`;
    discountRow.hidden = false;
  } else {
    discountRow.hidden = true;
  }
  document.getElementById("confirmation-shipping").textContent = pickup
    ? "Miễn phí (nhận tại shop)"
    : window.Bloomy.formatVND(order.shipping_fee);
  document.getElementById("confirmation-total").textContent = window.Bloomy.formatVND(order.total_amount);
  // The rate stored on this order (it may differ from today's setting).
  document.getElementById("confirmation-vat-rate").textContent = order.vat_rate;

  currentToken = order.token;
  currentTotalAmount = order.total_amount;
}

function initCopyButton(orderCode) {
  const btn = document.getElementById("copy-order-code-btn");
  const originalHTML = btn.innerHTML;
  const checkIcon =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';

  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(orderCode);
      btn.innerHTML = checkIcon;
      setTimeout(() => {
        btn.innerHTML = originalHTML;
      }, 1500);
    } catch (err) {
      console.error("Bloomy: clipboard copy failed", err);
    }
  });
}

// ---------------------------------------------------------------------------
// ZaloPay retry-payment flow — same shape as Checkout's own payment-waiting
// view (QR render + polling + manual-verify fallback), entered from here
// instead of from a fresh checkout submission. Reuses the existing
// /verify-payment route for the manual button (already generic — works for
// any zalopay order regardless of how it was created); only the QR-request
// step itself is new (/retry-zalopay-payment), since the original
// /api/orders route only ever creates the FIRST attempt.
// ---------------------------------------------------------------------------
async function handleRetryZaloPay() {
  const retryBtn = document.getElementById("retry-zalopay-btn");
  retryBtn.disabled = true;

  document.getElementById("payment-waiting").hidden = false;
  document.getElementById("payment-waiting-amount").textContent = window.Bloomy.formatVND(currentTotalAmount);

  const img = document.getElementById("zalopay-qr");
  const loading = document.getElementById("zalopay-qr-loading");
  img.hidden = true;
  loading.hidden = false;
  loading.textContent = "Đang tạo mã QR...";

  try {
    const res = await fetch(`/api/orders/${currentToken}/retry-zalopay-payment`, { method: "POST" });
    const data = await res.json();

    if (!res.ok) {
      loading.textContent = data.message || "Không thể tạo mã QR. Vui lòng liên hệ Bloomy qua Zalo.";
      retryBtn.disabled = false;
      return;
    }

    img.src = data.qr_data_url;
    img.hidden = false;
    loading.hidden = true;

    // Same order_url the QR encodes — opened directly it lands on ZaloPay's
    // own method picker (wallet QR, domestic card, international card).
    // Mirrors Checkout's showPaymentWaiting.
    const altLink = document.getElementById("zalopay-alt-link");
    if (data.order_url) {
      altLink.href = data.order_url;
      altLink.hidden = false;
    } else {
      altLink.hidden = true;
    }

    startPolling();
  } catch (err) {
    console.error("Bloomy: ZaloPay retry-payment failed", err);
    loading.textContent = "Có lỗi xảy ra, vui lòng thử lại.";
    retryBtn.disabled = false;
  }
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
      // Already on Confirmation — a full reload re-renders everything
      // (payment status text, hides the retry button/QR view) from the
      // now-paid order, rather than hand-patching each piece of the DOM.
      window.location.reload();
    }
  } catch (err) {
    console.error("Bloomy: payment status poll failed", err);
    // Fail silent — the next tick just tries again.
  }
}

// The manual fallback — actually asks ZaloPay via the server's
// verify-payment route, never just trusts the click. Same route Checkout's
// own manual button calls; genuinely reusable as-is since it only needs
// the token, which this page already has.
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
      window.location.reload();
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

async function init() {
  try {
    await initConfirmation();
  } finally {
    document.body.classList.add("is-ready");
  }
}

async function initConfirmation() {
  const token = new URLSearchParams(window.location.search).get("token");

  if (!token) {
    document.getElementById("confirmation-not-found").hidden = false;
    return;
  }

  try {
    const res = await fetch(`/api/orders/${token}`);
    if (!res.ok) {
      document.getElementById("confirmation-not-found").hidden = false;
      return;
    }
    const order = await res.json();

    document.getElementById("confirmation-content").hidden = false;
    renderOrder(order);
    initCopyButton(order.order_code);

    document.getElementById("retry-zalopay-btn").addEventListener("click", handleRetryZaloPay);
    document.getElementById("verify-payment-btn").addEventListener("click", handleManualVerify);
  } catch (err) {
    console.error("Bloomy: failed to load order", err);
    document.getElementById("confirmation-not-found").hidden = false;
  }
}

document.addEventListener("DOMContentLoaded", init);
