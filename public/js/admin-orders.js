// Bloomy — Admin order list, delivery sheet.
//
// Each order is one table row plus a detail row that opens when the row is
// clicked: what was ordered (size by size), the money (goods, coupon,
// shipping, total, VAT amount), the customer's note and invoice request, and
// the two fields the shop fills in — the GHTK tracking code and an internal
// note. Keeping those in the detail row keeps the table itself narrow.

const WINDOW_LABELS = {
  morning: "Buổi sáng",
  afternoon: "Buổi chiều",
  evening: "Buổi tối",
};

const PAYMENT_METHOD_LABELS = {
  cod: "COD",
  zalopay: "ZaloPay",
  cash: "Tiền mặt",
};

const PAYMENT_STATUS_LABELS = {
  pending: "Chưa thanh toán",
  paid: "Đã thanh toán",
  failed: "Thất bại",
  refunded: "Đã hoàn tiền",
};

const FULFILLMENT_LABELS = {
  new: "Mới",
  delivering: "Đang giao",
  delivered: "Đã giao",
  cancelled: "Đã huỷ",
};

// Pickup orders use the same statuses underneath, worded for the counter.
const PICKUP_FULFILLMENT_LABELS = {
  new: "Mới",
  delivering: "Sẵn sàng nhận",
  delivered: "Đã nhận",
  cancelled: "Đã huỷ",
};

const SIZE_LABELS = { s: "Nhỏ", m: "Vừa", l: "Lớn" };

// Mirrors routes/admin-orders.js's own ALLOWED_FULFILLMENT_TRANSITIONS —
// kept in sync by hand. This copy only shapes which options the dropdown
// offers; the server re-validates every change regardless; it is not the
// source of truth.
const ALLOWED_FULFILLMENT_TRANSITIONS = {
  new: ["delivering", "cancelled"],
  delivering: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
};

function formatVND(price) {
  return price.toLocaleString("vi-VN") + "đ";
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString("vi-VN");
}

function orderCode(order) {
  return `BLOMY${String(order.id).padStart(6, "0")}`;
}

function typeLabel(order) {
  const base = order.channel === "pos" ? "Tại quầy" : order.fulfillment_type === "pickup" ? "Nhận tại shop" : "Giao tận nơi";
  // Flags orders that contain a made-to-order bouquet, so staff notice it.
  return order.has_custom ? `${base} · Tùy chỉnh` : base;
}

function fulfillmentLabels(order) {
  return order.fulfillment_type === "pickup" ? PICKUP_FULFILLMENT_LABELS : FULFILLMENT_LABELS;
}

// One line of text for an item, used in the order's detail row AND on the
// delivery sheet. A custom bouquet spells out what to make and the note — the
// florist has nothing else to work from.
function itemLine(item) {
  if (item.custom) {
    const made = item.flowers.map((f) => `${f.name} × ${f.stems}`).join(", ");
    return `${item.name} (${item.style_label}: ${made}) × ${item.quantity}${item.note ? ` — Ghi chú: ${item.note}` : ""}`;
  }
  const size = item.size && SIZE_LABELS[item.size] ? ` (${SIZE_LABELS[item.size]})` : "";
  return `${item.name}${size} × ${item.quantity}`;
}

// Everything built with textContent / createElement, never innerHTML with
// order data: names, notes and addresses are typed by customers.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

// Payment-side actions: mark-paid (COD / cash, paid in person) or reverify
// (ZaloPay) while still pending/failed, plus a manual refund button once
// paid. Nothing shown once refunded — there's nowhere further for a refunded
// order to go. Returns the buttons (or nothing) for the payment cell.
function buildActionButtons(order) {
  const buttons = [];

  if (order.payment_status === "pending" || order.payment_status === "failed") {
    const button = el("button", "btn btn-outline admin-table__action-btn");
    button.dataset.orderId = order.id;

    if (order.payment_method === "cod" || order.payment_method === "cash") {
      button.textContent = "Đánh dấu đã thanh toán";
      button.dataset.action = "mark-paid";
    } else {
      button.textContent = "Xác minh lại";
      button.dataset.action = "reverify";
    }
    buttons.push(button);
  }

  if (order.payment_status === "paid") {
    const refundBtn = el("button", "btn btn-outline admin-table__action-btn", "Hoàn tiền");
    refundBtn.dataset.orderId = order.id;
    refundBtn.dataset.action = "refund";
    buttons.push(refundBtn);
  }

  return buttons;
}

// Fulfillment dropdown — only ever offers the current value plus its
// allowed next values (see ALLOWED_FULFILLMENT_TRANSITIONS above), not all
// four unconditionally. A terminal state (delivered/cancelled) has nothing
// to move to, so it renders as a single disabled option instead of a live
// dropdown — same for any refunded order, regardless of where
// fulfillment_status happened to be when the refund was recorded, matching
// the server's own guard on PATCH /:id/fulfillment.
function buildFulfillmentSelect(order) {
  const select = el("select", "admin-table__status-select");
  select.dataset.orderId = order.id;
  select.dataset.role = "fulfillment";
  select.dataset.from = order.fulfillment_status;

  const labels = fulfillmentLabels(order);
  const allowedNext =
    order.payment_status === "refunded" ? [] : ALLOWED_FULFILLMENT_TRANSITIONS[order.fulfillment_status];
  const options = [order.fulfillment_status, ...allowedNext];
  options.forEach((value) => {
    const option = el("option", null, labels[value]);
    option.value = value;
    if (value === order.fulfillment_status) option.selected = true;
    select.appendChild(option);
  });

  if (options.length === 1) select.disabled = true;
  return select;
}

function buildNamePhoneCell(name, phone) {
  const wrapper = el("div", "admin-table__name-phone");
  wrapper.append(document.createTextNode(name), el("span", "admin-table__phone", phone));
  return wrapper;
}

// ---------------------------------------------------------------------------
// Detail row
// ---------------------------------------------------------------------------
function buildDetailBlock(title) {
  const block = el("div", "admin-order-detail__block");
  block.appendChild(el("h3", "admin-order-detail__title", title));
  return block;
}

function moneyRow(label, value, strong) {
  const row = el("div", `admin-order-detail__money-row${strong ? " is-total" : ""}`);
  row.append(el("span", null, label), el("span", null, value));
  return row;
}

function buildDetailRow(order) {
  const row = el("tr", "admin-table__detail");
  row.dataset.detailFor = order.id;
  row.hidden = !expandedIds.has(order.id);
  const cell = el("td");
  cell.colSpan = COLUMN_COUNT;
  const grid = el("div", "admin-order-detail");

  // What was ordered
  const items = buildDetailBlock("Sản phẩm");
  const list = el("ul", "admin-order-detail__items");
  order.items.forEach((item) => {
    const li = el("li");
    li.append(el("span", null, itemLine(item)), el("span", null, formatVND(item.price * item.quantity)));
    list.appendChild(li);
  });
  items.appendChild(list);

  // Money
  const money = buildDetailBlock("Thanh toán");
  money.appendChild(moneyRow("Tạm tính", formatVND(order.subtotal)));
  if (order.discount > 0) money.appendChild(moneyRow(`Giảm giá (${order.coupon_code})`, `−${formatVND(order.discount)}`));
  money.appendChild(
    moneyRow("Phí giao hàng", order.fulfillment_type === "pickup" ? "Nhận tại shop" : formatVND(order.shipping_fee))
  );
  money.appendChild(moneyRow("Tổng cộng", formatVND(order.total_amount), true));
  money.appendChild(moneyRow(`Trong đó VAT ${order.vat_rate}%`, formatVND(order.vat_amount)));
  money.appendChild(moneyRow("Phương thức", PAYMENT_METHOD_LABELS[order.payment_method]));

  // Customer's note + invoice request
  const customer = buildDetailBlock("Khách hàng");
  customer.appendChild(
    el(
      "p",
      "admin-order-detail__text",
      order.fulfillment_type === "pickup" ? "Nhận tại shop." : `Giao đến: ${order.delivery_address}, ${order.ward_name}`
    )
  );
  customer.appendChild(el("p", "admin-order-detail__text", order.notes ? `Lời nhắn: ${order.notes}` : "Không có lời nhắn."));
  if (order.customer_email) customer.appendChild(el("p", "admin-order-detail__text", `Email: ${order.customer_email}`));
  if (order.invoice_requested) {
    customer.appendChild(
      el(
        "p",
        "admin-order-detail__text",
        `Xuất hóa đơn: ${order.invoice_company_name} — MST ${order.invoice_tax_code} — ${order.invoice_address}`
      )
    );
  }

  // Shop's own fields
  const shop = buildDetailBlock("Cửa hàng");
  const form = el("form", "admin-order-detail__form");
  form.dataset.orderId = order.id;
  if (order.fulfillment_type === "delivery") {
    const trackingLabel = el("label", "admin-form__label", "Mã vận đơn GHTK");
    const tracking = el("input", "admin-form__input");
    tracking.name = "tracking_code";
    tracking.maxLength = 50;
    tracking.value = order.tracking_code || "";
    trackingLabel.appendChild(tracking);
    form.appendChild(trackingLabel);
  }
  const noteLabel = el("label", "admin-form__label", "Ghi chú nội bộ (khách không thấy)");
  const note = el("textarea", "admin-form__input");
  note.name = "admin_note";
  note.rows = 2;
  note.maxLength = 1000;
  note.value = order.admin_note || "";
  noteLabel.appendChild(note);
  form.appendChild(noteLabel);
  const save = el("button", "btn btn-outline", "Lưu");
  save.type = "submit";
  form.appendChild(save);
  shop.appendChild(form);

  grid.append(items, money, customer, shop);
  cell.appendChild(grid);
  row.appendChild(cell);
  return row;
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------
const COLUMN_COUNT = 6;

// Kept in memory once fetched — same reasoning as Products' search: small
// dataset, filtering the already-loaded array beats a server round-trip
// per keystroke.
let allOrders = [];
// Which detail rows are open — survives the reload after every action.
const expandedIds = new Set();

function renderTable(orders) {
  const body = document.getElementById("admin-orders-body");
  body.innerHTML = "";

  orders.forEach((order) => {
    const row = el("tr", "admin-table__order-row");
    row.dataset.orderId = order.id;

    // Six columns, each holding what belongs together, so the table fits
    // without sideways scrolling. The long text lives in the detail row.

    // Code (opens the detail row) with the order type under it
    const codeCell = el("td");
    const toggle = el("button", "admin-table__expand", orderCode(order));
    toggle.type = "button";
    toggle.dataset.toggle = order.id;
    toggle.setAttribute("aria-expanded", String(expandedIds.has(order.id)));
    codeCell.append(toggle, el("span", "admin-table__sub", typeLabel(order)));

    // Sender and recipient, one above the other
    const peopleCell = el("td");
    peopleCell.append(
      buildNamePhoneCell(`Gửi: ${order.sender_name}`, order.sender_phone),
      buildNamePhoneCell(`Nhận: ${order.recipient_name}`, order.recipient_phone)
    );
    peopleCell.lastChild.classList.add("admin-table__name-phone--spaced");

    // Where and when. Long addresses are cut to two lines (full text on
    // hover and in the detail row).
    const placeCell = el("td");
    const address =
      order.fulfillment_type === "delivery" ? `${order.delivery_address}, ${order.ward_name}` : "Nhận tại shop";
    const addressEl = el("span", "admin-table__place", address);
    addressEl.title = address;
    const when = order.delivery_window
      ? `${formatDate(order.delivery_date)} — ${WINDOW_LABELS[order.delivery_window]}`
      : formatDate(order.delivery_date);
    placeCell.append(addressEl, el("span", "admin-table__sub", when));

    // Total with the payment method under it
    const totalCell = el("td");
    totalCell.append(el("span", null, formatVND(order.total_amount)), el("span", "admin-table__sub", PAYMENT_METHOD_LABELS[order.payment_method]));

    // Payment status with its action button under it
    const payCell = el("td");
    payCell.appendChild(el("span", null, PAYMENT_STATUS_LABELS[order.payment_status]));
    buildActionButtons(order).forEach((button) => payCell.appendChild(button));

    const fulfillmentCell = el("td");
    fulfillmentCell.appendChild(buildFulfillmentSelect(order));

    row.append(codeCell, peopleCell, placeCell, totalCell, payCell, fulfillmentCell);
    body.appendChild(row);
    body.appendChild(buildDetailRow(order));
  });
}

async function loadOrders() {
  const errorEl = document.getElementById("admin-orders-error");
  try {
    const res = await fetch("/api/admin/orders");
    if (res.status === 401) {
      window.location.href = "admin-login.html";
      return;
    }
    if (!res.ok) throw new Error("Failed to load orders");
    allOrders = await res.json();
    applyFilters();
  } catch (err) {
    errorEl.textContent = "Không thể tải danh sách đơn hàng.";
    errorEl.hidden = false;
  }
}

function applyFilters() {
  const term = document.getElementById("admin-orders-search").value.trim().toLowerCase();
  const digitsOnly = term.replace(/\D/g, "");
  const statusFilter = document.getElementById("admin-orders-status-filter").value;

  const filtered = allOrders.filter((order) => {
    if (statusFilter !== "all" && order.payment_status !== statusFilter) {
      return false;
    }
    if (!term) return true;

    const matchesText =
      orderCode(order).toLowerCase().includes(term) ||
      order.sender_name.toLowerCase().includes(term) ||
      order.recipient_name.toLowerCase().includes(term) ||
      (order.tracking_code || "").toLowerCase().includes(term);
    const matchesInvoice =
      order.invoice_requested &&
      (order.invoice_company_name.toLowerCase().includes(term) ||
        order.invoice_tax_code.includes(term));
    const matchesPhone =
      digitsOnly.length > 0 &&
      (order.sender_phone.includes(digitsOnly) || order.recipient_phone.includes(digitsOnly));

    return matchesText || matchesPhone || matchesInvoice;
  });

  renderTable(filtered);
}

document.getElementById("admin-orders-search").addEventListener("input", applyFilters);
document.getElementById("admin-orders-status-filter").addEventListener("change", applyFilters);

document.getElementById("admin-orders-body").addEventListener("click", async (e) => {
  // Open / close the detail row
  const toggle = e.target.closest("[data-toggle]");
  if (toggle) {
    const id = parseInt(toggle.dataset.toggle, 10);
    const detail = document.querySelector(`[data-detail-for="${id}"]`);
    const open = detail.hidden;
    detail.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (open) expandedIds.add(id);
    else expandedIds.delete(id);
    return;
  }

  const button = e.target.closest(".admin-table__action-btn");
  if (!button) return;

  const action = button.dataset.action;
  if (action === "refund" && !confirm("Xác nhận đã hoàn tiền cho đơn này? Thao tác này không thể hoàn tác.")) {
    return;
  }

  const orderId = button.dataset.orderId;
  button.disabled = true;

  try {
    const url =
      action === "mark-paid" ? `/api/admin/orders/${orderId}/mark-paid`
      : action === "refund" ? `/api/admin/orders/${orderId}/refund`
      : `/api/admin/orders/${orderId}/reverify`;
    const method = action === "reverify" ? "POST" : "PATCH";

    const res = await fetch(url, { method });
    if (!res.ok) throw new Error("Action failed");
    const data = await res.json();

    if (action === "reverify" && data.payment_status === "pending") {
      alert("ZaloPay chưa xác nhận thanh toán cho đơn này.");
    }
  } catch (err) {
    alert("Không thể thực hiện thao tác. Vui lòng thử lại.");
  } finally {
    loadOrders(); // always resync with the real DB state
  }
});

// Saving the GHTK code and the internal note
document.getElementById("admin-orders-body").addEventListener("submit", async (e) => {
  const form = e.target.closest(".admin-order-detail__form");
  if (!form) return;
  e.preventDefault();
  const body = { admin_note: form.elements.admin_note.value };
  if (form.elements.tracking_code) body.tracking_code = form.elements.tracking_code.value;
  try {
    const res = await fetch(`/api/admin/orders/${form.dataset.orderId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("Failed to save");
  } catch (err) {
    alert("Không thể lưu. Vui lòng thử lại.");
  } finally {
    loadOrders();
  }
});

document.getElementById("admin-orders-body").addEventListener("change", async (e) => {
  const select = e.target;
  if (!select.classList.contains("admin-table__status-select") || select.dataset.role !== "fulfillment") return;

  const orderId = select.dataset.orderId;
  const status = select.value;

  // Cancelling a "new" order gives its flowers back to stock; once it is
  // being delivered the bouquet is made, so nothing comes back. Say so.
  if (status === "cancelled") {
    const message =
      select.dataset.from === "new"
        ? "Huỷ đơn này? Số hoa của đơn sẽ được trả lại kho."
        : "Huỷ đơn này? Bó hoa đã làm nên số hoa sẽ KHÔNG được trả lại kho.";
    if (!confirm(message)) {
      loadOrders();
      return;
    }
  }

  try {
    const res = await fetch(`/api/admin/orders/${orderId}/fulfillment`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) throw new Error("Failed to update fulfillment status");
  } catch (err) {
    alert("Không thể cập nhật trạng thái. Vui lòng thử lại.");
  } finally {
    loadOrders(); // revert the dropdown to the real DB state on failure too
  }
});

// ---------------------------------------------------------------------------
// Delivery sheet — a separate read-only view of one date's orders (delivery
// and pickup) grouped by window, with what each order contains, for the
// florist's daily work plan. Toggled in place of the table; print styles
// (admin.css) hide everything else when printed.
// ---------------------------------------------------------------------------
let sheetMode = false;

function setSheetMode(on) {
  sheetMode = on;
  document.getElementById("admin-orders-table-wrap").hidden = on;
  document.getElementById("admin-delivery-sheet").hidden = !on;
  document.getElementById("admin-sheet-toggle").textContent = on ? "Xem danh sách" : "Phiếu giao hàng";
  if (on) loadDeliverySheet(document.getElementById("admin-sheet-date").value || undefined);
}

document.getElementById("admin-sheet-toggle").addEventListener("click", () => setSheetMode(!sheetMode));
document.getElementById("admin-sheet-date").addEventListener("change", (e) => loadDeliverySheet(e.target.value));
document.getElementById("admin-sheet-print").addEventListener("click", () => window.print());

const WINDOW_ORDER = ["morning", "afternoon", "evening"];

async function loadDeliverySheet(date) {
  const titleEl = document.getElementById("admin-sheet-title");
  const pendingNote = document.getElementById("admin-sheet-pending-note");
  const container = document.getElementById("admin-sheet-windows");

  try {
    const url = date ? `/api/admin/orders/delivery-sheet?date=${date}` : `/api/admin/orders/delivery-sheet`;
    const res = await fetch(url);
    if (res.status === 401) {
      window.location.href = "admin-login.html";
      return;
    }
    if (!res.ok) throw new Error("Failed to load delivery sheet");
    const data = await res.json();

    document.getElementById("admin-sheet-date").value = data.date;
    titleEl.textContent = `Phiếu giao hàng — ${formatDate(data.date)}`;

    if (data.pending_zalopay_count > 0) {
      pendingNote.textContent = `${data.pending_zalopay_count} đơn ZaloPay chưa thanh toán trong ngày này (không hiển thị ở đây).`;
      pendingNote.hidden = false;
    } else {
      pendingNote.hidden = true;
    }

    container.innerHTML = "";
    WINDOW_ORDER.forEach((win) => {
      const orders = data.windows[win];
      const section = el("div", "admin-delivery-sheet__window");
      section.appendChild(el("h3", "admin-delivery-sheet__window-title", `${WINDOW_LABELS[win]} (${orders.length})`));

      if (orders.length === 0) {
        section.appendChild(el("p", "admin-delivery-sheet__empty", "Không có đơn."));
      } else {
        orders.forEach((order) => {
          const item = el("div", "admin-delivery-sheet__order");

          const top = el("div", "admin-delivery-sheet__order-top");
          top.append(el("span", null, `${orderCode(order)} · ${typeLabel(order)}`), el("span", null, formatVND(order.total_amount)));

          const recipient = el("p", null, `${order.recipient_name} — ${order.recipient_phone}`);
          const place = el(
            "p",
            null,
            order.fulfillment_type === "pickup" ? "Khách đến nhận tại shop" : `${order.delivery_address}, ${order.ward_name}`
          );
          const contents = el("p", "admin-delivery-sheet__order-items", order.items.map(itemLine).join("; "));
          item.append(top, recipient, place, contents);

          if (order.notes) {
            item.appendChild(el("p", "admin-delivery-sheet__order-notes", `Ghi chú: ${order.notes}`));
          }
          section.appendChild(item);
        });
      }
      container.appendChild(section);
    });
  } catch (err) {
    titleEl.textContent = "";
    container.innerHTML = "";
    pendingNote.textContent = "Không thể tải phiếu giao hàng.";
    pendingNote.hidden = false;
  }
}

loadOrders();
