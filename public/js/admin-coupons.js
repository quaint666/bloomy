// Bloomy — Coupons ("Mã giảm giá"), manager and up. Create a code, switch it
// on/off, move its dates. What a code is worth is locked once it exists (see
// routes/admin-coupons.js). Everything from the server goes in with textContent.

const TYPE_LABELS = { fixed: "Giảm số tiền (đ)", percent: "Giảm theo %" };

let editingCoupon = null; // the row whose dates are being edited

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

function viDate(iso) {
  return iso.split("-").reverse().join("/");
}

function windowText(c) {
  if (!c.starts_on && !c.ends_on) return "Không giới hạn";
  if (c.starts_on && c.ends_on) return `${viDate(c.starts_on)} – ${viDate(c.ends_on)}`;
  return c.starts_on ? `Từ ${viDate(c.starts_on)}` : `Đến ${viDate(c.ends_on)}`;
}

function errorText(data) {
  switch (data && data.error) {
    case "code_taken":
      return "Mã này đã tồn tại.";
    case "invalid_code":
      return `Mã gồm chữ in hoa, số, dấu - và _, từ ${data.min} đến ${data.max} ký tự.`;
    case "invalid_type":
      return "Loại mã không hợp lệ.";
    case "invalid_value":
      return `Mức giảm phải là số nguyên từ 1 đến ${data.max}.`;
    case "invalid_min_subtotal":
      return "Đơn tối thiểu không hợp lệ.";
    case "invalid_date":
      return "Ngày không hợp lệ.";
    case "invalid_dates":
      return "Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.";
    default:
      return "Có lỗi xảy ra. Vui lòng thử lại.";
  }
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

function showNotice(text, ok) {
  const n = $("admin-coupons-notice");
  n.textContent = text;
  n.className = `admin-form__msg ${ok ? "is-ok" : "is-error"}`;
  n.hidden = false;
}

let coupons = [];

function renderTable() {
  const body = $("admin-coupons-body");
  body.innerHTML = "";
  coupons.forEach((c) => {
    const row = el("tr");
    row.appendChild(el("td", null, c.code));
    row.appendChild(el("td", null, c.type === "percent" ? `${c.value}%` : formatVND(c.value)));
    row.appendChild(el("td", null, c.min_subtotal > 0 ? formatVND(c.min_subtotal) : "Không"));
    row.appendChild(el("td", null, windowText(c)));
    row.appendChild(el("td", null, c.active ? "Đang bật" : "Đã tắt"));
    const actions = el("td");
    const wrap = el("div", "admin-users__actions");
    const toggle = el("button", "btn btn-outline admin-table__action-btn", c.active ? "Tắt" : "Bật");
    toggle.type = "button";
    toggle.dataset.action = "toggle";
    toggle.dataset.id = c.id;
    const dates = el("button", "btn btn-outline admin-table__action-btn", "Sửa ngày");
    dates.type = "button";
    dates.dataset.action = "dates";
    dates.dataset.id = c.id;
    wrap.append(toggle, dates);
    actions.appendChild(wrap);
    row.appendChild(actions);
    body.appendChild(row);
  });
}

async function loadCoupons() {
  const errorEl = $("admin-coupons-error");
  try {
    const { res, data } = await api("GET", "/api/admin/coupons");
    if (!res.ok) throw new Error(`coupons: ${res.status}`);
    coupons = data;
    renderTable();
    errorEl.hidden = true;
  } catch (err) {
    errorEl.textContent = "Không thể tải danh sách mã giảm giá.";
    errorEl.hidden = false;
  }
}

// ---- create
function syncValueLabel() {
  $("coupon-value-label").textContent = $("coupon-type").value === "percent" ? "Mức giảm (%)" : "Số tiền giảm (đ)";
}

function initCreateForm() {
  const typeField = $("coupon-type");
  Object.entries(TYPE_LABELS).forEach(([value, label]) => {
    const option = el("option", null, label);
    option.value = value;
    typeField.appendChild(option);
  });
  syncValueLabel();
  typeField.addEventListener("change", syncValueLabel);

  $("admin-coupon-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { res, data } = await api("POST", "/api/admin/coupons", {
      code: $("coupon-code").value,
      type: typeField.value,
      value: Number($("coupon-value").value),
      min_subtotal: $("coupon-min").value === "" ? 0 : Number($("coupon-min").value),
      starts_on: $("coupon-from").value || null,
      ends_on: $("coupon-to").value || null,
    });
    if (!res.ok) {
      showNotice(errorText(data), false);
      return;
    }
    e.target.reset();
    syncValueLabel();
    showNotice(`Đã tạo mã “${data.code}”.`, true);
    loadCoupons();
  });
}

// ---- switch on/off, edit dates
$("admin-coupons-body").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const coupon = coupons.find((c) => c.id === Number(btn.dataset.id));
  if (!coupon) return;

  if (btn.dataset.action === "toggle") {
    const { res, data } = await api("PATCH", `/api/admin/coupons/${coupon.id}`, { active: !coupon.active });
    if (!res.ok) showNotice(errorText(data), false);
    else showNotice(`Đã ${data.active ? "bật" : "tắt"} mã “${data.code}”.`, true);
    loadCoupons();
    return;
  }

  editingCoupon = coupon;
  $("admin-coupon-dialog-title").textContent = `Đổi ngày áp dụng của “${coupon.code}”`;
  $("edit-from").value = coupon.starts_on || "";
  $("edit-to").value = coupon.ends_on || "";
  $("admin-coupon-dialog-msg").hidden = true;
  $("admin-coupon-dialog").showModal();
});

$("admin-coupon-dialog-cancel").addEventListener("click", () => $("admin-coupon-dialog").close());

$("admin-coupon-dialog-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("admin-coupon-dialog-msg");
  const { res, data } = await api("PATCH", `/api/admin/coupons/${editingCoupon.id}`, {
    starts_on: $("edit-from").value || null,
    ends_on: $("edit-to").value || null,
  });
  if (!res.ok) {
    msg.textContent = errorText(data);
    msg.hidden = false;
    return;
  }
  $("admin-coupon-dialog").close();
  showNotice(`Đã cập nhật ngày của “${data.code}”.`, true);
  loadCoupons();
});

initCreateForm();
loadCoupons();
