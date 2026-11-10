// Bloomy — POS "Bán tại quầy".
// Left: the catalog (public list with sizes). Right: the ticket, priced by the
// server with POST /api/orders/quote — prices, coupon, "Thiếu hoa", VAT rate all
// come from there; this page never does money maths. The cashier presses
//   cash    -> the sale is created already paid and handed over, receipt shown
//   ZaloPay -> the sale is created pending, a QR is shown, the page polls
//              GET /api/orders/:token until it is paid, then shows the receipt
// Below: web pickup orders waiting at the counter, each with an "Đã nhận" button.
// Everything typed by customers is put on the page with textContent.

const SIZE_LABELS = { s: "Nhỏ", m: "Vừa", l: "Lớn" };
const PAYMENT_LABELS = { cash: "Tiền mặt", zalopay: "ZaloPay", cod: "COD" };
const WINDOW_LABELS = { morning: "Buổi sáng", afternoon: "Buổi chiều", evening: "Buổi tối" };
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // ZaloPay's own order-expiry window

let products = []; // sellable products, each with its sizes
let ticket = []; // [{ productId, size, name, quantity }]
let couponCode = ""; // the code typed; the server decides whether it applies
let lastQuote = null;
let quoteSeq = 0;
let quoteTimer = null;
let sale = null; // { id, token } while a ZaloPay QR is on screen
let pollTimer = null;
let sending = false;

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function formatVND(price) {
  return price.toLocaleString("vi-VN") + "đ";
}

// Vietnam's date as YYYY-MM-DD (the coupon window is checked against it).
function todayVN() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" });
}

function orderCode(id) {
  return `BLOMY${String(id).padStart(6, "0")}`;
}

function notify(text, ok) {
  const n = $("pos-notice");
  n.textContent = text;
  n.className = `admin-form__msg ${ok ? "is-ok" : "is-error"}`;
  n.hidden = !text;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    window.location.href = "admin-login.html";
    return { res, data: null };
  }
  return { res, data: await res.json().catch(() => null) };
}

function showView(view) {
  $("pos-layout").hidden = view !== "sell";
  $("pos-qr-panel").hidden = view !== "qr";
  $("pos-receipt-panel").hidden = view !== "receipt";
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------
function findProduct(id) {
  return products.find((p) => p.id === id);
}

function renderCatalog() {
  const term = $("pos-search").value.trim().toLowerCase();
  const grid = $("pos-products");
  grid.innerHTML = "";
  products
    .filter((p) => !term || p.name.toLowerCase().includes(term))
    .forEach((p) => {
      const card = el("div", "pos-product");
      const img = el("img");
      img.src = p.image;
      img.alt = p.name;
      img.loading = "lazy";
      card.append(img, el("div", "pos-product__name", p.name));
      const soldOut = p.status !== "available";
      if (soldOut) card.appendChild(el("span", "admin-table__warning", "Hết hàng hôm nay"));
      const sizes = el("div", "pos-product__sizes");
      p.sizes.forEach((s) => {
        const label = p.sizes.length > 1 ? `${SIZE_LABELS[s.size]} · ${formatVND(s.price)}` : `Thêm · ${formatVND(s.price)}`;
        const btn = el("button", "btn btn-outline", label);
        btn.type = "button";
        btn.dataset.id = p.id;
        btn.dataset.size = s.size;
        btn.disabled = soldOut;
        sizes.appendChild(btn);
      });
      card.appendChild(sizes);
      grid.appendChild(card);
    });
}

async function loadCatalog() {
  try {
    const res = await fetch("/api/products?sizes=1");
    if (!res.ok) throw new Error(`catalog: ${res.status}`);
    // The external vase is sold on another site, never at the counter.
    products = (await res.json()).filter((p) => p.product_type === "standard");
    renderCatalog();
  } catch (err) {
    $("pos-error").textContent = "Không thể tải danh sách sản phẩm.";
    $("pos-error").hidden = false;
  }
}

// ---------------------------------------------------------------------------
// Ticket
// ---------------------------------------------------------------------------
function addLine(productId, size) {
  const p = findProduct(productId);
  if (!p) return;
  const existing = ticket.find((l) => l.productId === productId && l.size === size);
  if (existing) existing.quantity = Math.min(99, existing.quantity + 1);
  else ticket.push({ productId, size, name: p.name, quantity: 1 });
  afterTicketChange();
}

function afterTicketChange() {
  renderTicket();
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(refreshQuote, 250);
}

function renderTicket() {
  const box = $("pos-lines");
  box.innerHTML = "";
  $("pos-empty").hidden = ticket.length > 0;
  const priced = new Map((lastQuote ? lastQuote.lines : []).map((l) => [`${l.productId}:${l.size}`, l]));
  ticket.forEach((line, i) => {
    const p = findProduct(line.productId);
    const q = priced.get(`${line.productId}:${line.size}`);
    const row = el("div", "pos-line");
    const name = el("div", "pos-line__name", p && p.sizes.length > 1 ? `${line.name} (${SIZE_LABELS[line.size]})` : line.name);
    if (q && q.short_flowers.length > 0) name.appendChild(el("span", "admin-table__warning", `Thiếu: ${q.short_flowers.join(", ")}`));
    const qty = el("div", "pos-line__qty");
    [["−", -1], ["+", 1]].forEach(([text, delta], idx) => {
      const b = el("button", "btn btn-outline", text);
      b.type = "button";
      b.dataset.act = "qty";
      b.dataset.index = i;
      b.dataset.delta = delta;
      b.setAttribute("aria-label", delta < 0 ? "Giảm số lượng" : "Tăng số lượng");
      if (idx === 0) qty.append(b, el("span", null, String(line.quantity)));
      else qty.appendChild(b);
    });
    const amount = el("div", "pos-line__amount", q && !q.problem ? formatVND(q.lineTotal) : "…");
    const del = el("button", "btn btn-outline", "×");
    del.type = "button";
    del.dataset.act = "remove";
    del.dataset.index = i;
    del.setAttribute("aria-label", "Xóa dòng");
    row.append(name, qty, amount, del);
    box.appendChild(row);
  });
}

const COUPON_TEXT = {
  applied: (c) => `Đã áp dụng mã ${c.code}.`,
  not_found: () => "Mã giảm giá không tồn tại.",
  inactive: () => "Mã giảm giá đã tắt.",
  below_minimum: (c) => `Mã ${c.code} áp dụng cho phiếu từ ${formatVND(c.min_subtotal)}.`,
  outside_dates: (c) => `Mã ${c.code} không áp dụng cho hôm nay.`,
  needs_date: () => "",
};

// Why this ticket can't be sold right now ("" = it can).
function blockedReason() {
  if (!lastQuote) return "";
  const bad = lastQuote.lines.find((l) => l.problem || l.status !== "available");
  if (bad) {
    if (bad.problem) return "Có sản phẩm không còn bán.";
    return `${bad.name} ${bad.status === "sold_out_today" ? "đã hết hàng hôm nay" : "đã ngừng kinh doanh"}.`;
  }
  if (lastQuote.short_flowers.length > 0) return `Thiếu hoa: ${lastQuote.short_flowers.join(", ")}.`;
  return "";
}

function renderTotals() {
  const q = lastQuote;
  $("pos-subtotal").textContent = q ? formatVND(q.subtotal) : ticket.length ? "…" : "0đ";
  $("pos-total").textContent = q ? formatVND(q.total) : ticket.length ? "…" : "0đ";
  $("pos-vat").textContent = q ? String(q.vat_rate) : "…";
  const applied = q && q.coupon && q.coupon.status === "applied";
  $("pos-discount-row").hidden = !applied;
  if (applied) {
    $("pos-discount-label").textContent = `Giảm giá (${q.coupon.code})`;
    $("pos-discount").textContent = `−${formatVND(q.discount)}`;
  }
  const cm = $("pos-coupon-msg");
  const text = q && q.coupon ? COUPON_TEXT[q.coupon.status](q.coupon) : "";
  cm.textContent = text;
  cm.className = `admin-form__msg ${applied ? "is-ok" : "is-error"}`;
  cm.hidden = !text;
  const reason = blockedReason();
  $("pos-short").textContent = reason;
  $("pos-short").hidden = !reason;
  updateSubmit();
}

function paymentMethod() {
  return document.querySelector('input[name="pos-pay"]:checked').value;
}

function updateSubmit() {
  $("pos-submit").textContent = paymentMethod() === "cash" ? "Đã thu tiền mặt" : "Tạo mã QR ZaloPay";
  $("pos-submit").disabled = sending || ticket.length === 0 || !lastQuote || blockedReason() !== "";
}

// Re-prices the ticket. quoteSeq drops an answer that arrives after a newer change.
async function refreshQuote() {
  if (ticket.length === 0) {
    lastQuote = null;
    renderTicket();
    renderTotals();
    return;
  }
  const seq = ++quoteSeq;
  try {
    const { res, data } = await api("POST", "/api/orders/quote", {
      items: ticket.map((l) => ({ productId: l.productId, size: l.size, quantity: l.quantity })),
      coupon_code: couponCode || null,
      fulfillment_type: "pickup",
      delivery_date: todayVN(),
    });
    if (seq !== quoteSeq) return;
    if (!res.ok) throw new Error(`quote: ${res.status}`);
    lastQuote = data;
  } catch (err) {
    if (seq !== quoteSeq) return;
    lastQuote = null;
    notify("Không tính được giá. Vui lòng thử lại.", false);
  }
  renderTicket();
  renderTotals();
}

// ---------------------------------------------------------------------------
// Taking the sale
// ---------------------------------------------------------------------------
function saleErrorText(data) {
  switch (data && data.error) {
    case "unavailable":
      if (data.reason === "rejected_flower_shortage") return `Thiếu hoa: ${(data.short_flowers || []).join(", ")}.`;
      if (data.reason === "rejected_sold_out_today") return "Có sản phẩm đã hết hàng hôm nay.";
      return "Có sản phẩm đã ngừng kinh doanh.";
    case "coupon_not_applied":
      return "Mã giảm giá không áp dụng cho phiếu này.";
    case "invalid_item":
      return "Một sản phẩm trong phiếu không còn bán theo lựa chọn này.";
    case "invalid_payload":
      return "Kiểm tra lại tên và số điện thoại khách.";
    default:
      return "Không thể tạo đơn. Vui lòng thử lại.";
  }
}

async function submitSale(e) {
  e.preventDefault();
  if ($("pos-submit").disabled) return;
  const same = $("pos-same").checked;
  const name = $("pos-name").value;
  const phone = $("pos-phone").value;
  const applied = lastQuote && lastQuote.coupon && lastQuote.coupon.status === "applied";
  sending = true;
  updateSubmit();
  notify("", true);
  try {
    const { res, data } = await api("POST", "/api/admin/pos/orders", {
      items: ticket.map((l) => ({ productId: l.productId, size: l.size, quantity: l.quantity })),
      coupon_code: applied ? lastQuote.coupon.code : null,
      sender_name: name,
      sender_phone: phone,
      recipient_name: same ? name : $("pos-rname").value,
      recipient_phone: same ? phone : $("pos-rphone").value,
      customer_email: $("pos-email").value,
      payment_method: paymentMethod(),
    });
    if (!res.ok) {
      notify(saleErrorText(data), false);
      refreshQuote(); // stock may have changed under us
      return;
    }
    if (data.payment_method === "cash") await showReceipt(data.token);
    else showQr(data);
  } catch (err) {
    notify("Không thể kết nối máy chủ. Vui lòng thử lại.", false);
  } finally {
    sending = false;
    updateSubmit();
  }
}

// ---------------------------------------------------------------------------
// ZaloPay QR
// ---------------------------------------------------------------------------
function showQr(data) {
  sale = { id: data.id, token: data.token };
  $("pos-qr-amount").textContent = `Số tiền: ${formatVND(data.total_amount)}`;
  const img = $("pos-qr-img");
  if (data.qr_data_url) {
    img.src = data.qr_data_url;
    img.hidden = false;
    $("pos-qr-status").textContent = "Đang chờ khách quét mã…";
    $("pos-qr-status").className = "admin-form__msg";
    startPolling();
  } else {
    img.hidden = true;
    $("pos-qr-status").textContent = `Chưa tạo được mã QR: ${data.message || "lỗi ZaloPay"}. Bấm “Tạo lại mã QR” hoặc “Hủy đơn”.`;
    $("pos-qr-status").className = "admin-form__msg is-error";
  }
  showView("qr");
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

// Reads our own database only (GET /api/orders/:token): whatever the IPN has
// already recorded. The manual "Xác minh lại" asks ZaloPay itself.
function startPolling() {
  stopPolling();
  const started = Date.now();
  pollTimer = setInterval(async () => {
    if (!sale) return;
    if (Date.now() - started > POLL_TIMEOUT_MS) {
      stopPolling();
      $("pos-qr-status").textContent = "Chưa nhận được thanh toán. Nếu khách đã trả, bấm “Xác minh lại”.";
      return;
    }
    try {
      const res = await fetch(`/api/orders/${sale.token}`);
      if (!res.ok) return;
      const order = await res.json();
      if (order.payment_status === "paid") showReceipt(sale.token);
    } catch (err) {
      // a missed poll is fine; the next one tries again
    }
  }, POLL_INTERVAL_MS);
}

async function verifyQr() {
  if (!sale) return;
  const { res, data } = await api("POST", `/api/orders/${sale.token}/verify-payment`);
  if (res.ok && data.payment_status === "paid") return showReceipt(sale.token);
  $("pos-qr-status").textContent = res.status === 429 ? "Hỏi ZaloPay quá nhiều lần, đợi một lúc rồi thử lại." : "ZaloPay chưa xác nhận thanh toán.";
}

async function retryQr() {
  if (!sale) return;
  const { res, data } = await api("POST", `/api/orders/${sale.token}/retry-zalopay-payment`);
  if (!res.ok) {
    $("pos-qr-status").textContent = "Vẫn chưa tạo được mã QR. Thử lại hoặc hủy đơn.";
    return;
  }
  showQr({ id: sale.id, token: sale.token, total_amount: lastTotal(), qr_data_url: data.qr_data_url });
}

// The amount on screen is the one the sale was created with.
function lastTotal() {
  return Number($("pos-qr-amount").textContent.replace(/[^0-9]/g, "")) || 0;
}

async function cancelQr() {
  if (!sale || !confirm("Hủy đơn này? Hoa sẽ được trả lại kho.")) return;
  const { res, data } = await api("POST", `/api/admin/pos/orders/${sale.id}/cancel`);
  if (res.ok) {
    resetSale();
    notify("Đã hủy đơn, hoa đã trả lại kho.", true);
    return;
  }
  if (data && data.error === "not_cancellable") {
    // The payment may have landed a moment ago.
    const o = await (await fetch(`/api/orders/${sale.token}`)).json().catch(() => null);
    if (o && o.payment_status === "paid") return showReceipt(sale.token);
  }
  $("pos-qr-status").textContent = "Không hủy được đơn này.";
}

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------
async function showReceipt(token) {
  stopPolling();
  const [orderRes, settingsRes] = await Promise.all([fetch(`/api/orders/${token}`), fetch("/api/settings")]);
  const order = await orderRes.json();
  const settings = settingsRes.ok ? await settingsRes.json() : null;

  const box = $("pos-receipt");
  box.innerHTML = "";
  const row = (label, value, strong) => {
    const r = el("div", `pos-receipt__row${strong ? " is-total" : ""}`);
    r.append(el("span", null, label), el("span", null, value));
    return r;
  };
  box.appendChild(el("h2", "pos-receipt__title", "Bloomy"));
  if (settings) {
    box.appendChild(el("p", "pos-receipt__small", settings.shop_address));
    box.appendChild(el("p", "pos-receipt__small", `ĐT / Zalo: ${settings.contact_phone}`));
  }
  box.appendChild(el("p", "pos-receipt__heading", "HÓA ĐƠN BÁN HÀNG"));
  box.appendChild(row("Mã đơn", order.order_code));
  box.appendChild(row("Ngày", new Date(order.created_at).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })));
  box.appendChild(el("hr"));
  order.items.forEach((item) => {
    const size = item.size ? ` (${SIZE_LABELS[item.size]})` : "";
    box.appendChild(row(`${item.name}${size} × ${item.quantity}`, formatVND(item.price * item.quantity)));
  });
  box.appendChild(el("hr"));
  box.appendChild(row("Tạm tính", formatVND(order.subtotal)));
  if (order.discount > 0) box.appendChild(row(`Giảm giá (${order.coupon_code})`, `−${formatVND(order.discount)}`));
  box.appendChild(row("Tổng cộng", formatVND(order.total_amount), true));
  box.appendChild(el("p", "pos-receipt__small", `Đã bao gồm VAT ${order.vat_rate}%`));
  box.appendChild(row("Thanh toán", PAYMENT_LABELS[order.payment_method] || order.payment_method));
  box.appendChild(el("p", "pos-receipt__small pos-receipt__thanks", "Cảm ơn quý khách!"));

  sale = null;
  showView("receipt");
}

function resetSale() {
  stopPolling();
  sale = null;
  ticket = [];
  couponCode = "";
  lastQuote = null;
  ["pos-coupon", "pos-name", "pos-phone", "pos-email", "pos-rname", "pos-rphone"].forEach((id) => {
    $(id).value = "";
  });
  $("pos-same").checked = true;
  $("pos-recipient").hidden = true;
  document.querySelector('input[name="pos-pay"][value="cash"]').checked = true;
  renderTicket();
  renderTotals();
  showView("sell");
  loadPickups();
}

// ---------------------------------------------------------------------------
// Web pickup orders waiting at the counter
// ---------------------------------------------------------------------------
// The ids seen on the last look. null until the first look, so opening the page never announces
// the orders that were already waiting.
let knownPickupIds = null;
let pickupNoticeTimer = null;
const PICKUP_NOTICE_MS = 10 * 1000; // how long the "new order" notice stays

async function fetchPickups() {
  const { res, data } = await api("GET", "/api/admin/pos/pickups");
  if (!res.ok) throw new Error(`pickups: ${res.status}`);
  return data;
}

function setPickupCount(n) {
  // The number shows on the toggle even while the list is closed.
  const count = $("pos-pickups-count");
  count.textContent = n;
  count.hidden = n === 0;
}

function hidePickupNotice() {
  clearTimeout(pickupNoticeTimer);
  $("pos-new-pickup").hidden = true;
}

// A notice (top right, for 10 seconds) when an order turns up that was not there on the last look.
function noteNewPickups(data) {
  const ids = data.map((o) => o.id);
  const fresh = knownPickupIds === null ? [] : data.filter((o) => !knownPickupIds.has(o.id));
  knownPickupIds = new Set(ids);
  if (fresh.length === 0) return;
  $("pos-new-pickup-text").textContent =
    fresh.length === 1 ? `Có đơn nhận tại shop mới: ${orderCode(fresh[0].id)}` : `Có ${fresh.length} đơn nhận tại shop mới`;
  $("pos-new-pickup").hidden = false;
  clearTimeout(pickupNoticeTimer);
  pickupNoticeTimer = setTimeout(hidePickupNotice, PICKUP_NOTICE_MS);
}

// What the page does every 20 seconds: look, update the number, announce anything new. An OPEN list
// is not redrawn (it would change under the cursor); it has its own Làm mới button.
async function pollPickups() {
  try {
    const data = await fetchPickups();
    setPickupCount(data.length);
    noteNewPickups(data);
    if ($("pos-pickups").hidden) drawPickups(data);
  } catch (err) {
    // a missed look is not worth a message: the next one is 20 seconds away
  }
}

async function loadPickups() {
  try {
    const data = await fetchPickups();
    drawPickups(data);
    noteNewPickups(data);
  } catch (err) {
    notify("Không thể tải danh sách đơn nhận tại shop.", false);
  }
}

function drawPickups(data) {
  const body = $("pos-pickups-body");
  body.innerHTML = "";
  $("pos-pickups-empty").hidden = data.length > 0;
  setPickupCount(data.length);
  data.forEach((o) => {
    const row = el("tr");
    row.appendChild(el("td", null, orderCode(o.id)));
    const who = el("td");
    who.append(el("div", null, o.recipient_name), el("span", "admin-table__sub", o.recipient_phone));
    row.appendChild(who);
    row.appendChild(el("td", null, o.items.map((i) => `${i.name}${i.size ? ` (${SIZE_LABELS[i.size]})` : ""} × ${i.quantity}`).join("; ")));
    row.appendChild(el("td", null, `${o.delivery_date.split("-").reverse().join("/")} — ${WINDOW_LABELS[o.delivery_window] || ""}`));
    const unpaidZalo = o.payment_method === "zalopay" && o.payment_status !== "paid";
    row.appendChild(el("td", null, `${PAYMENT_LABELS[o.payment_method]} · ${o.payment_status === "paid" ? "Đã thanh toán" : "Chưa thanh toán"}`));
    const act = el("td");
    const btn = el("button", "btn btn-outline admin-table__action-btn", "Đã nhận");
    btn.type = "button";
    btn.dataset.id = o.id;
    btn.disabled = unpaidZalo;
    if (unpaidZalo) btn.title = "Đơn ZaloPay chưa thanh toán";
    act.appendChild(btn);
    row.appendChild(act);
    body.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
$("pos-search").addEventListener("input", renderCatalog);

$("pos-products").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-id]");
  if (btn && !btn.disabled) addLine(Number(btn.dataset.id), btn.dataset.size);
});

$("pos-lines").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const i = Number(btn.dataset.index);
  if (btn.dataset.act === "remove") ticket.splice(i, 1);
  else {
    ticket[i].quantity += Number(btn.dataset.delta);
    if (ticket[i].quantity < 1) ticket.splice(i, 1);
    else ticket[i].quantity = Math.min(99, ticket[i].quantity);
  }
  afterTicketChange();
});

function applyCoupon() {
  couponCode = $("pos-coupon").value.trim().toUpperCase();
  refreshQuote();
}
$("pos-coupon-apply").addEventListener("click", applyCoupon);
$("pos-coupon").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    applyCoupon();
  }
});

$("pos-same").addEventListener("change", () => {
  $("pos-recipient").hidden = $("pos-same").checked;
});
document.querySelectorAll('input[name="pos-pay"]').forEach((r) => r.addEventListener("change", updateSubmit));
$("pos-form").addEventListener("submit", submitSale);
$("pos-clear").addEventListener("click", resetSale);
$("pos-qr-verify").addEventListener("click", verifyQr);
$("pos-qr-retry").addEventListener("click", retryQr);
$("pos-qr-cancel").addEventListener("click", cancelQr);
$("pos-print").addEventListener("click", () => window.print());
$("pos-new").addEventListener("click", () => {
  notify("", true);
  resetSale();
});
$("pos-pickups-refresh").addEventListener("click", loadPickups);

// The pickup list is closed until asked for. Opening reloads it, so it is never stale.
$("pos-pickups-toggle").addEventListener("click", () => {
  const panel = $("pos-pickups");
  const open = panel.hidden;
  panel.hidden = !open;
  $("pos-pickups-toggle").setAttribute("aria-expanded", String(open));
  if (open) loadPickups();
});
// The page keeps looking while it sits open at the counter (see pollPickups above).
setInterval(() => {
  if (!document.hidden) pollPickups();
}, 20 * 1000);

// The notice: "Xem" opens the list, × closes it (it also closes itself after 10 seconds).
$("pos-new-pickup-open").addEventListener("click", () => {
  hidePickupNotice();
  if ($("pos-pickups").hidden) $("pos-pickups-toggle").click();
  else loadPickups();
});
$("pos-new-pickup-close").addEventListener("click", hidePickupNotice);

// "/" jumps to the product search (unless you are already typing somewhere).
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  e.preventDefault();
  $("pos-search").focus();
});

$("pos-pickups-body").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-id]");
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const { res, data } = await api("POST", `/api/admin/pos/pickups/${btn.dataset.id}/handover`);
  if (res.ok) notify(`Đã giao ${orderCode(Number(btn.dataset.id))}.`, true);
  else notify(data && data.error === "zalopay_not_paid_yet" ? "Đơn ZaloPay này chưa thanh toán." : "Không thể cập nhật đơn này.", false);
  loadPickups();
});

renderTicket();
renderTotals();
loadCatalog();
loadPickups();
