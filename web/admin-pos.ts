// Bloomy — POS "Bán tại quầy".
// Left: the catalog (public list with sizes). Right: the ticket, priced by the
// server with POST /api/orders/quote — prices, coupon, "Thiếu hoa", VAT rate all
// come from there; this page never does money maths. The cashier presses
//   cash    -> the sale is created already paid and handed over, receipt shown
//   ZaloPay -> the sale is created pending, a QR is shown, the page polls
//              GET /api/orders/:token until it is paid, then shows the receipt
// Below: web pickup orders waiting at the counter, each with an "Đã nhận" button.
// Everything typed by customers is put on the page with textContent.

import type { ApiErrorBody, CouponResult, CouponStatus, PaymentMethod, PosPickup, PosSaleBody, PosZaloPaySaleBody, ProductListItem, ProductSize, PublicOrderResponse, PublicSettings, QuoteBody, QuoteLine, SizePrice, ZaloPayQrBody } from "../shared/api-types";
import { MAX_QUANTITY, WINDOW_TEXT } from "../shared/rules";
import { adminApi } from "./lib/api";
import { byId, el } from "./lib/dom";
import { formatVND } from "./lib/format";
import { isProductSize, SIZE_LABELS } from "./lib/labels";

const PAYMENT_LABELS: Record<PaymentMethod, string> = { cash: "Tiền mặt", zalopay: "ZaloPay", cod: "COD" };
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // ZaloPay's own order-expiry window

// qol2_test calls this by name on the page's window, so it is put there on purpose.
declare global {
  interface Window {
    pollPickups: () => Promise<void>;
  }
}

// A catalog product: the listing row, with its sizes (the list is asked for with ?sizes=1).
type PosProduct = ProductListItem & { sizes: SizePrice[] };
interface TicketLine { productId: number; size: ProductSize; name: string; quantity: number }
// What the QR screen needs from a sale: the id and token, the amount, and the QR image (or why there is none).
type QrSale = Pick<PosZaloPaySaleBody, "id" | "token" | "total_amount" | "qr_data_url" | "message">;

let products: PosProduct[] = []; // sellable products, each with its sizes
let ticket: TicketLine[] = [];
let couponCode = ""; // the code typed; the server decides whether it applies
let lastQuote: QuoteBody | null = null;
let quoteSeq = 0;
let quoteTimer: number | undefined;
let sale: { id: number; token: string } | null = null; // while a ZaloPay QR is on screen
let pollTimer: number | undefined;
let sending = false;

// Vietnam's date as YYYY-MM-DD (the coupon window is checked against it).
function todayVN(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" });
}

function orderCode(id: number): string {
  return `BLOMY${String(id).padStart(6, "0")}`;
}

function notify(text: string, ok: boolean): void {
  const n = byId("pos-notice");
  n.textContent = text;
  n.className = `admin-form__msg ${ok ? "is-ok" : "is-error"}`;
  n.hidden = !text;
}

function showView(view: "sell" | "qr" | "receipt"): void {
  byId("pos-layout").hidden = view !== "sell";
  byId("pos-qr-panel").hidden = view !== "qr";
  byId("pos-receipt-panel").hidden = view !== "receipt";
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------
function findProduct(id: number): PosProduct | undefined {
  return products.find((p) => p.id === id);
}

function renderCatalog(): void {
  const term = byId("pos-search", HTMLInputElement).value.trim().toLowerCase();
  const grid = byId("pos-products");
  grid.innerHTML = "";
  products
    .filter((p) => !term || p.name.toLowerCase().includes(term))
    .forEach((p) => {
      const card = el("div", "pos-product");
      const img = el("img");
      img.src = String(p.image); // a product with no picture has been given the address "null", as before
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
        btn.dataset.id = String(p.id);
        btn.dataset.size = s.size;
        btn.disabled = soldOut;
        sizes.appendChild(btn);
      });
      card.appendChild(sizes);
      grid.appendChild(card);
    });
}

async function loadCatalog(): Promise<void> {
  try {
    const result = await adminApi<ProductListItem[]>("GET", "/api/products?sizes=1");
    if (!result.ok) throw new Error(`catalog: ${result.res.status}`);
    // The external vase is sold on another site, never at the counter.
    products = result.data.filter((p) => p.product_type === "standard").map((p) => ({ ...p, sizes: p.sizes ?? [] }));
    renderCatalog();
  } catch (err) {
    byId("pos-error").textContent = "Không thể tải danh sách sản phẩm.";
    byId("pos-error").hidden = false;
  }
}

// ---------------------------------------------------------------------------
// Ticket
// ---------------------------------------------------------------------------
function addLine(productId: number, size: ProductSize): void {
  const p = findProduct(productId);
  if (!p) return;
  const existing = ticket.find((l) => l.productId === productId && l.size === size);
  if (existing) existing.quantity = Math.min(MAX_QUANTITY, existing.quantity + 1);
  else ticket.push({ productId, size, name: p.name, quantity: 1 });
  afterTicketChange();
}

function afterTicketChange(): void {
  renderTicket();
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(refreshQuote, 250);
}

function renderTicket(): void {
  const box = byId("pos-lines");
  box.innerHTML = "";
  byId("pos-empty").hidden = ticket.length > 0;
  const priced = new Map<string, QuoteLine>((lastQuote ? lastQuote.lines : []).map((l) => [`${l.productId}:${l.size}`, l]));
  ticket.forEach((line, i) => {
    const p = findProduct(line.productId);
    const q = priced.get(`${line.productId}:${line.size}`);
    const row = el("div", "pos-line");
    const name = el("div", "pos-line__name", p && p.sizes.length > 1 ? `${line.name} (${SIZE_LABELS[line.size]})` : line.name);
    if (q && q.short_flowers.length > 0) name.appendChild(el("span", "admin-table__warning", `Thiếu: ${q.short_flowers.join(", ")}`));
    const qty = el("div", "pos-line__qty");
    const steps: [string, number][] = [["−", -1], ["+", 1]];
    steps.forEach(([text, delta], idx) => {
      const b = el("button", "btn btn-outline", text);
      b.type = "button";
      b.dataset.act = "qty";
      b.dataset.index = String(i);
      b.dataset.delta = String(delta);
      b.setAttribute("aria-label", delta < 0 ? "Giảm số lượng" : "Tăng số lượng");
      if (idx === 0) qty.append(b, el("span", null, String(line.quantity)));
      else qty.appendChild(b);
    });
    const amount = el("div", "pos-line__amount", q && !q.problem ? formatVND(q.lineTotal) : "…");
    const del = el("button", "btn btn-outline", "×");
    del.type = "button";
    del.dataset.act = "remove";
    del.dataset.index = String(i);
    del.setAttribute("aria-label", "Xóa dòng");
    row.append(name, qty, amount, del);
    box.appendChild(row);
  });
}

const COUPON_TEXT: Record<CouponStatus, (c: CouponResult) => string> = {
  applied: (c) => `Đã áp dụng mã ${c.code}.`,
  not_found: () => "Mã giảm giá không tồn tại.",
  inactive: () => "Mã giảm giá đã tắt.",
  below_minimum: (c) => `Mã ${c.code} áp dụng cho phiếu từ ${formatVND(c.min_subtotal ?? 0)}.`,
  outside_dates: (c) => `Mã ${c.code} không áp dụng cho hôm nay.`,
  needs_date: () => "",
};

// Why this ticket can't be sold right now ("" = it can).
function blockedReason(): string {
  if (!lastQuote) return "";
  const bad = lastQuote.lines.find((l) => l.problem || l.status !== "available");
  if (bad) {
    if (bad.problem) return "Có sản phẩm không còn bán.";
    return `${bad.name} ${bad.status === "sold_out_today" ? "đã hết hàng hôm nay" : "đã ngừng kinh doanh"}.`;
  }
  if (lastQuote.short_flowers.length > 0) return `Thiếu hoa: ${lastQuote.short_flowers.join(", ")}.`;
  return "";
}

function renderTotals(): void {
  const q = lastQuote;
  byId("pos-subtotal").textContent = q ? formatVND(q.subtotal) : ticket.length ? "…" : "0đ";
  byId("pos-total").textContent = q ? formatVND(q.total) : ticket.length ? "…" : "0đ";
  byId("pos-vat").textContent = q ? String(q.vat_rate) : "…";
  const coupon = q && q.coupon;
  const applied = q !== null && coupon !== null && coupon.status === "applied";
  byId("pos-discount-row").hidden = !applied;
  if (q && coupon && applied) {
    byId("pos-discount-label").textContent = `Giảm giá (${coupon.code})`;
    byId("pos-discount").textContent = `−${formatVND(q.discount)}`;
  }
  const cm = byId("pos-coupon-msg");
  const text = coupon ? COUPON_TEXT[coupon.status](coupon) : "";
  cm.textContent = text;
  cm.className = `admin-form__msg ${applied ? "is-ok" : "is-error"}`;
  cm.hidden = !text;
  const reason = blockedReason();
  byId("pos-short").textContent = reason;
  byId("pos-short").hidden = !reason;
  updateSubmit();
}

function paymentMethod(): "cash" | "zalopay" {
  const checked = document.querySelector<HTMLInputElement>('input[name="pos-pay"]:checked');
  if (!checked) throw new Error("No payment method chosen");
  return checked.value === "cash" ? "cash" : "zalopay";
}

function updateSubmit(): void {
  byId("pos-submit").textContent = paymentMethod() === "cash" ? "Đã thu tiền mặt" : "Tạo mã QR ZaloPay";
  byId("pos-submit", HTMLButtonElement).disabled = sending || ticket.length === 0 || !lastQuote || blockedReason() !== "";
}

// Re-prices the ticket. quoteSeq drops an answer that arrives after a newer change.
async function refreshQuote(): Promise<void> {
  if (ticket.length === 0) {
    lastQuote = null;
    renderTicket();
    renderTotals();
    return;
  }
  const seq = ++quoteSeq;
  try {
    const result = await adminApi<QuoteBody>("POST", "/api/orders/quote", {
      items: ticket.map((l) => ({ productId: l.productId, size: l.size, quantity: l.quantity })),
      coupon_code: couponCode || null,
      fulfillment_type: "pickup",
      delivery_date: todayVN(),
    });
    if (seq !== quoteSeq) return;
    if (!result.ok) throw new Error(`quote: ${result.res.status}`);
    lastQuote = result.data;
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
function saleErrorText(data: ApiErrorBody | null): string {
  switch (data && data.error) {
    case "unavailable":
      if (data?.reason === "rejected_flower_shortage") return `Thiếu hoa: ${(data.short_flowers || []).join(", ")}.`;
      if (data?.reason === "rejected_sold_out_today") return "Có sản phẩm đã hết hàng hôm nay.";
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

async function submitSale(e: Event): Promise<void> {
  e.preventDefault();
  if (byId("pos-submit", HTMLButtonElement).disabled) return;
  const same = byId("pos-same", HTMLInputElement).checked;
  const name = byId("pos-name", HTMLInputElement).value;
  const phone = byId("pos-phone", HTMLInputElement).value;
  const appliedCoupon = lastQuote && lastQuote.coupon && lastQuote.coupon.status === "applied" ? lastQuote.coupon : null;
  sending = true;
  updateSubmit();
  notify("", true);
  try {
    const result = await adminApi<PosSaleBody>("POST", "/api/admin/pos/orders", {
      items: ticket.map((l) => ({ productId: l.productId, size: l.size, quantity: l.quantity })),
      coupon_code: appliedCoupon ? appliedCoupon.code : null,
      sender_name: name,
      sender_phone: phone,
      recipient_name: same ? name : byId("pos-rname", HTMLInputElement).value,
      recipient_phone: same ? phone : byId("pos-rphone", HTMLInputElement).value,
      customer_email: byId("pos-email", HTMLInputElement).value,
      payment_method: paymentMethod(),
    });
    if (!result.ok) {
      notify(saleErrorText(result.data), false);
      refreshQuote(); // stock may have changed under us
      return;
    }
    if (result.data.payment_method === "cash") await showReceipt(result.data.token);
    else showQr(result.data);
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
function showQr(data: QrSale): void {
  sale = { id: data.id, token: data.token };
  byId("pos-qr-amount").textContent = `Số tiền: ${formatVND(data.total_amount)}`;
  const img = byId("pos-qr-img", HTMLImageElement);
  if (data.qr_data_url) {
    img.src = data.qr_data_url;
    img.hidden = false;
    byId("pos-qr-status").textContent = "Đang chờ khách quét mã…";
    byId("pos-qr-status").className = "admin-form__msg";
    startPolling();
  } else {
    img.hidden = true;
    byId("pos-qr-status").textContent = `Chưa tạo được mã QR: ${data.message || "lỗi ZaloPay"}. Bấm “Tạo lại mã QR” hoặc “Hủy đơn”.`;
    byId("pos-qr-status").className = "admin-form__msg is-error";
  }
  showView("qr");
}

function stopPolling(): void {
  clearInterval(pollTimer);
  pollTimer = undefined;
}

// Reads our own database only (GET /api/orders/:token): whatever the IPN has
// already recorded. The manual "Xác minh lại" asks ZaloPay itself.
function startPolling(): void {
  stopPolling();
  const started = Date.now();
  pollTimer = setInterval(async () => {
    if (!sale) return;
    if (Date.now() - started > POLL_TIMEOUT_MS) {
      stopPolling();
      byId("pos-qr-status").textContent = "Chưa nhận được thanh toán. Nếu khách đã trả, bấm “Xác minh lại”.";
      return;
    }
    try {
      const result = await adminApi<PublicOrderResponse>("GET", `/api/orders/${sale.token}`);
      if (!result.ok) return;
      if (result.data.payment_status === "paid") showReceipt(sale.token);
    } catch (err) {
      // a missed poll is fine; the next one tries again
    }
  }, POLL_INTERVAL_MS);
}

async function verifyQr(): Promise<void> {
  if (!sale) return;
  const result = await adminApi<{ payment_status: PublicOrderResponse["payment_status"] }>("POST", `/api/orders/${sale.token}/verify-payment`);
  if (result.ok && result.data.payment_status === "paid") return showReceipt(sale.token);
  byId("pos-qr-status").textContent = result.res.status === 429 ? "Hỏi ZaloPay quá nhiều lần, đợi một lúc rồi thử lại." : "ZaloPay chưa xác nhận thanh toán.";
}

async function retryQr(): Promise<void> {
  if (!sale) return;
  const result = await adminApi<ZaloPayQrBody>("POST", `/api/orders/${sale.token}/retry-zalopay-payment`);
  if (!result.ok) {
    byId("pos-qr-status").textContent = "Vẫn chưa tạo được mã QR. Thử lại hoặc hủy đơn.";
    return;
  }
  showQr({ id: sale.id, token: sale.token, total_amount: lastTotal(), qr_data_url: result.data.qr_data_url });
}

// The amount on screen is the one the sale was created with.
function lastTotal(): number {
  return Number((byId("pos-qr-amount").textContent ?? "").replace(/[^0-9]/g, "")) || 0;
}

async function cancelQr(): Promise<void> {
  if (!sale || !confirm("Hủy đơn này? Hoa sẽ được trả lại kho.")) return;
  const result = await adminApi<{ id: number }>("POST", `/api/admin/pos/orders/${sale.id}/cancel`);
  if (result.ok) {
    resetSale();
    notify("Đã hủy đơn, hoa đã trả lại kho.", true);
    return;
  }
  if (result.data && result.data.error === "not_cancellable") {
    // The payment may have landed a moment ago.
    const lookup = await adminApi<PublicOrderResponse>("GET", `/api/orders/${sale.token}`);
    if (lookup.ok && lookup.data.payment_status === "paid") return showReceipt(sale.token);
  }
  byId("pos-qr-status").textContent = "Không hủy được đơn này.";
}

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------
async function showReceipt(token: string): Promise<void> {
  stopPolling();
  const [orderRes, settingsRes] = await Promise.all([
    adminApi<PublicOrderResponse>("GET", `/api/orders/${token}`),
    adminApi<PublicSettings>("GET", "/api/settings"),
  ]);
  if (!orderRes.ok) throw new Error(`order: ${orderRes.res.status}`);
  const order = orderRes.data;
  const settings = settingsRes.ok ? settingsRes.data : null;

  const box = byId("pos-receipt");
  box.innerHTML = "";
  const row = (label: string, value: string, strong?: boolean): HTMLElement => {
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

function resetSale(): void {
  stopPolling();
  sale = null;
  ticket = [];
  couponCode = "";
  lastQuote = null;
  ["pos-coupon", "pos-name", "pos-phone", "pos-email", "pos-rname", "pos-rphone"].forEach((id) => {
    byId(id, HTMLInputElement).value = "";
  });
  byId("pos-same", HTMLInputElement).checked = true;
  byId("pos-recipient").hidden = true;
  const cash = document.querySelector<HTMLInputElement>('input[name="pos-pay"][value="cash"]');
  if (cash) cash.checked = true;
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
let knownPickupIds: Set<number> | null = null;
let pickupNoticeTimer: number | undefined;
const PICKUP_NOTICE_MS = 10 * 1000; // how long the "new order" notice stays

async function fetchPickups(): Promise<PosPickup[]> {
  const result = await adminApi<PosPickup[]>("GET", "/api/admin/pos/pickups");
  if (!result.ok) throw new Error(`pickups: ${result.res.status}`);
  return result.data;
}

function setPickupCount(n: number): void {
  // The number shows on the toggle even while the list is closed.
  const count = byId("pos-pickups-count");
  count.textContent = String(n);
  count.hidden = n === 0;
}

function hidePickupNotice(): void {
  clearTimeout(pickupNoticeTimer);
  byId("pos-new-pickup").hidden = true;
}

// A notice (top right, for 10 seconds) when an order turns up that was not there on the last look.
function noteNewPickups(data: PosPickup[]): void {
  const ids = data.map((o) => o.id);
  const known = knownPickupIds;
  const fresh = known === null ? [] : data.filter((o) => !known.has(o.id));
  knownPickupIds = new Set(ids);
  const first = fresh[0];
  if (!first) return;
  byId("pos-new-pickup-text").textContent =
    fresh.length === 1 ? `Có đơn nhận tại shop mới: ${orderCode(first.id)}` : `Có ${fresh.length} đơn nhận tại shop mới`;
  byId("pos-new-pickup").hidden = false;
  clearTimeout(pickupNoticeTimer);
  pickupNoticeTimer = setTimeout(hidePickupNotice, PICKUP_NOTICE_MS);
}

// What the page does every 20 seconds: look, update the number, announce anything new. An OPEN list
// is not redrawn (it would change under the cursor); it has its own Làm mới button.
async function pollPickups(): Promise<void> {
  try {
    const data = await fetchPickups();
    setPickupCount(data.length);
    noteNewPickups(data);
    if (byId("pos-pickups").hidden) drawPickups(data);
  } catch (err) {
    // a missed look is not worth a message: the next one is 20 seconds away
  }
}
window.pollPickups = pollPickups;

async function loadPickups(): Promise<void> {
  try {
    const data = await fetchPickups();
    drawPickups(data);
    noteNewPickups(data);
  } catch (err) {
    notify("Không thể tải danh sách đơn nhận tại shop.", false);
  }
}

function drawPickups(data: PosPickup[]): void {
  const body = byId("pos-pickups-body");
  body.innerHTML = "";
  byId("pos-pickups-empty").hidden = data.length > 0;
  setPickupCount(data.length);
  data.forEach((o) => {
    const row = el("tr");
    row.appendChild(el("td", null, orderCode(o.id)));
    const who = el("td");
    who.append(el("div", null, o.recipient_name), el("span", "admin-table__sub", o.recipient_phone));
    row.appendChild(who);
    row.appendChild(el("td", null, o.items.map((i) => `${i.name}${i.size ? ` (${SIZE_LABELS[i.size]})` : ""} × ${i.quantity}`).join("; ")));
    row.appendChild(el("td", null, `${o.delivery_date.split("-").reverse().join("/")} — ${(o.delivery_window && WINDOW_TEXT[o.delivery_window].label) || ""}`));
    const unpaidZalo = o.payment_method === "zalopay" && o.payment_status !== "paid";
    row.appendChild(el("td", null, `${PAYMENT_LABELS[o.payment_method]} · ${o.payment_status === "paid" ? "Đã thanh toán" : "Chưa thanh toán"}`));
    const act = el("td");
    const btn = el("button", "btn btn-outline admin-table__action-btn", "Đã nhận");
    btn.type = "button";
    btn.dataset.id = String(o.id);
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
byId("pos-search").addEventListener("input", renderCatalog);

byId("pos-products").addEventListener("click", (e) => {
  if (!(e.target instanceof Element)) return;
  const btn = e.target.closest<HTMLButtonElement>("button[data-id]");
  if (btn && !btn.disabled && isProductSize(btn.dataset.size)) addLine(Number(btn.dataset.id), btn.dataset.size);
});

byId("pos-lines").addEventListener("click", (e) => {
  if (!(e.target instanceof Element)) return;
  const btn = e.target.closest<HTMLButtonElement>("button[data-act]");
  if (!btn) return;
  const i = Number(btn.dataset.index);
  if (btn.dataset.act === "remove") ticket.splice(i, 1);
  else {
    const line = ticket[i];
    if (!line) return;
    line.quantity += Number(btn.dataset.delta);
    if (line.quantity < 1) ticket.splice(i, 1);
    else line.quantity = Math.min(MAX_QUANTITY, line.quantity);
  }
  afterTicketChange();
});

function applyCoupon(): void {
  couponCode = byId("pos-coupon", HTMLInputElement).value.trim().toUpperCase();
  refreshQuote();
}
byId("pos-coupon-apply").addEventListener("click", applyCoupon);
byId("pos-coupon").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    applyCoupon();
  }
});

byId("pos-same").addEventListener("change", () => {
  byId("pos-recipient").hidden = byId("pos-same", HTMLInputElement).checked;
});
document.querySelectorAll('input[name="pos-pay"]').forEach((r) => r.addEventListener("change", updateSubmit));
byId("pos-form", HTMLFormElement).addEventListener("submit", submitSale);
byId("pos-clear").addEventListener("click", resetSale);
byId("pos-qr-verify").addEventListener("click", verifyQr);
byId("pos-qr-retry").addEventListener("click", retryQr);
byId("pos-qr-cancel").addEventListener("click", cancelQr);
byId("pos-print").addEventListener("click", () => window.print());
byId("pos-new").addEventListener("click", () => {
  notify("", true);
  resetSale();
});
byId("pos-pickups-refresh").addEventListener("click", loadPickups);

// The pickup list is closed until asked for. Opening reloads it, so it is never stale.
byId("pos-pickups-toggle").addEventListener("click", () => {
  const panel = byId("pos-pickups");
  const open = panel.hidden;
  panel.hidden = !open;
  byId("pos-pickups-toggle").setAttribute("aria-expanded", String(open));
  if (open) loadPickups();
});
// The page keeps looking while it sits open at the counter (see pollPickups above).
setInterval(() => {
  if (!document.hidden) pollPickups();
}, 20 * 1000);

// The notice: "Xem" opens the list, × closes it (it also closes itself after 10 seconds).
byId("pos-new-pickup-open").addEventListener("click", () => {
  hidePickupNotice();
  if (byId("pos-pickups").hidden) byId("pos-pickups-toggle").click();
  else loadPickups();
});
byId("pos-new-pickup-close").addEventListener("click", hidePickupNotice);

// "/" jumps to the product search (unless you are already typing somewhere).
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  e.preventDefault();
  byId("pos-search").focus();
});

byId("pos-pickups-body").addEventListener("click", async (e) => {
  if (!(e.target instanceof Element)) return;
  const btn = e.target.closest<HTMLButtonElement>("button[data-id]");
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const result = await adminApi<{ id: number }>("POST", `/api/admin/pos/pickups/${btn.dataset.id}/handover`);
  if (result.ok) notify(`Đã giao ${orderCode(Number(btn.dataset.id))}.`, true);
  else notify(result.data && result.data.error === "zalopay_not_paid_yet" ? "Đơn ZaloPay này chưa thanh toán." : "Không thể cập nhật đơn này.", false);
  loadPickups();
});

renderTicket();
renderTotals();
loadCatalog();
loadPickups();
