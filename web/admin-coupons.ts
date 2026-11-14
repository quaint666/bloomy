// Bloomy — Coupons ("Mã giảm giá"), manager and up. Create a code, switch it
// on/off, move its dates. What a code is worth is locked once it exists (see
// routes/admin-coupons.js). Everything from the server goes in with textContent.

import type { AdminCouponRow, ApiErrorBody, CouponType } from "../shared/api-types";
import { adminApi } from "./lib/api";
import { byId, el } from "./lib/dom";
import { formatVND } from "./lib/format";

const TYPE_LABELS: Record<CouponType, string> = { fixed: "Giảm số tiền (đ)", percent: "Giảm theo %" };

let editingCoupon: AdminCouponRow | null = null; // the row whose dates are being edited

function viDate(iso: string): string {
  return iso.split("-").reverse().join("/");
}

function windowText(c: AdminCouponRow): string {
  const { starts_on: from, ends_on: to } = c;
  if (from && to) return `${viDate(from)} – ${viDate(to)}`;
  if (from) return `Từ ${viDate(from)}`;
  if (to) return `Đến ${viDate(to)}`;
  return "Không giới hạn";
}

function errorText(data: ApiErrorBody | null): string {
  switch (data && data.error) {
    case "code_taken":
      return "Mã này đã tồn tại.";
    case "invalid_code":
      return `Mã gồm chữ in hoa, số, dấu - và _, từ ${data?.min} đến ${data?.max} ký tự.`;
    case "invalid_type":
      return "Loại mã không hợp lệ.";
    case "invalid_value":
      return `Mức giảm phải là số nguyên từ 1 đến ${data?.max}.`;
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

function showNotice(text: string, ok: boolean): void {
  const n = byId("admin-coupons-notice");
  n.textContent = text;
  n.className = `admin-form__msg ${ok ? "is-ok" : "is-error"}`;
  n.hidden = false;
}

let coupons: AdminCouponRow[] = [];

function renderTable(): void {
  const body = byId("admin-coupons-body");
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
    toggle.dataset.id = String(c.id);
    const dates = el("button", "btn btn-outline admin-table__action-btn", "Sửa ngày");
    dates.type = "button";
    dates.dataset.action = "dates";
    dates.dataset.id = String(c.id);
    wrap.append(toggle, dates);
    actions.appendChild(wrap);
    row.appendChild(actions);
    body.appendChild(row);
  });
}

async function loadCoupons(): Promise<void> {
  const errorEl = byId("admin-coupons-error");
  try {
    const result = await adminApi<AdminCouponRow[]>("GET", "/api/admin/coupons");
    if (!result.ok) throw new Error(`coupons: ${result.res.status}`);
    coupons = result.data;
    renderTable();
    errorEl.hidden = true;
  } catch (err) {
    errorEl.textContent = "Không thể tải danh sách mã giảm giá.";
    errorEl.hidden = false;
  }
}

// ---- create
function syncValueLabel(): void {
  byId("coupon-value-label").textContent = byId("coupon-type", HTMLSelectElement).value === "percent" ? "Mức giảm (%)" : "Số tiền giảm (đ)";
}

function initCreateForm(): void {
  const typeField = byId("coupon-type", HTMLSelectElement);
  Object.entries(TYPE_LABELS).forEach(([value, label]) => {
    const option = el("option", null, label);
    option.value = value;
    typeField.appendChild(option);
  });
  syncValueLabel();
  typeField.addEventListener("change", syncValueLabel);

  const form = byId("admin-coupon-form", HTMLFormElement);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const minField = byId("coupon-min", HTMLInputElement);
    const result = await adminApi<AdminCouponRow>("POST", "/api/admin/coupons", {
      code: byId("coupon-code", HTMLInputElement).value,
      type: typeField.value,
      value: Number(byId("coupon-value", HTMLInputElement).value),
      min_subtotal: minField.value === "" ? 0 : Number(minField.value),
      starts_on: byId("coupon-from", HTMLInputElement).value || null,
      ends_on: byId("coupon-to", HTMLInputElement).value || null,
    });
    if (!result.ok) {
      showNotice(errorText(result.data), false);
      return;
    }
    form.reset();
    syncValueLabel();
    showNotice(`Đã tạo mã “${result.data.code}”.`, true);
    loadCoupons();
  });
}

// ---- switch on/off, edit dates
byId("admin-coupons-body").addEventListener("click", async (e) => {
  if (!(e.target instanceof Element)) return;
  const btn = e.target.closest<HTMLButtonElement>("[data-action]");
  if (!btn) return;
  const coupon = coupons.find((c) => c.id === Number(btn.dataset.id));
  if (!coupon) return;

  if (btn.dataset.action === "toggle") {
    const result = await adminApi<AdminCouponRow>("PATCH", `/api/admin/coupons/${coupon.id}`, { active: !coupon.active });
    if (!result.ok) showNotice(errorText(result.data), false);
    else showNotice(`Đã ${result.data.active ? "bật" : "tắt"} mã “${result.data.code}”.`, true);
    loadCoupons();
    return;
  }

  editingCoupon = coupon;
  byId("admin-coupon-dialog-title").textContent = `Đổi ngày áp dụng của “${coupon.code}”`;
  byId("edit-from", HTMLInputElement).value = coupon.starts_on || "";
  byId("edit-to", HTMLInputElement).value = coupon.ends_on || "";
  byId("admin-coupon-dialog-msg").hidden = true;
  byId("admin-coupon-dialog", HTMLDialogElement).showModal();
});

byId("admin-coupon-dialog-cancel").addEventListener("click", () => byId("admin-coupon-dialog", HTMLDialogElement).close());

byId("admin-coupon-dialog-form", HTMLFormElement).addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!editingCoupon) return;
  const msg = byId("admin-coupon-dialog-msg");
  const result = await adminApi<AdminCouponRow>("PATCH", `/api/admin/coupons/${editingCoupon.id}`, {
    starts_on: byId("edit-from", HTMLInputElement).value || null,
    ends_on: byId("edit-to", HTMLInputElement).value || null,
  });
  if (!result.ok) {
    msg.textContent = errorText(result.data);
    msg.hidden = false;
    return;
  }
  byId("admin-coupon-dialog", HTMLDialogElement).close();
  showNotice(`Đã cập nhật ngày của “${result.data.code}”.`, true);
  loadCoupons();
});

initCreateForm();
loadCoupons();
