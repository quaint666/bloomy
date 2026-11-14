// Bloomy — Shop settings ("Cài đặt"), owner only. One form for the single
// settings row. What the server rejects it names by field (see
// routes/admin-settings.js); the public pages pick up the new values from
// GET /api/settings, so nothing else needs editing.

import type { AdminSettingsBody, FlowerStyle } from "../shared/api-types";
import { adminApi } from "./lib/api";
import { byId } from "./lib/dom";

interface Field {
  key: string;
  input: string;
  label: string;
  number: boolean;
}

const FIELDS: Field[] = [
  { key: "shop_address", input: "set-address", label: "Địa chỉ shop", number: false },
  { key: "contact_phone", input: "set-phone", label: "Số điện thoại / Zalo", number: false },
  { key: "contact_email", input: "set-email", label: "Email liên hệ", number: false },
  { key: "vat_rate", input: "set-vat", label: "Thuế VAT", number: true },
  { key: "ring1_fee", input: "set-ring1", label: "Phí giao vòng 1", number: true },
  { key: "ring2_fee", input: "set-ring2", label: "Phí giao vòng 2", number: true },
  { key: "ring3_fee", input: "set-ring3", label: "Phí giao vòng 3", number: true },
  // A campaign's id, or "" = none (sent as null). The options come from the server.
  { key: "active_campaign_id", input: "set-campaign", label: "Chiến dịch đang chạy", number: true },
];

// The form controls are inputs, except the campaign dropdown.
function fieldById(id: string): HTMLInputElement | HTMLSelectElement {
  const node = byId(id);
  if (node instanceof HTMLInputElement || node instanceof HTMLSelectElement) return node;
  throw new Error(`#${id} is not a form field`);
}

function showMessage(text: string, ok: boolean): void {
  const m = byId("admin-settings-msg");
  m.textContent = text;
  m.className = `admin-form__msg ${ok ? "is-ok" : "is-error"}`;
  m.hidden = false;
}

function fill(settings: AdminSettingsBody): void {
  // The campaign dropdown: "Không có" stays first, the rest come from the server.
  const select = byId("set-campaign", HTMLSelectElement);
  select.length = 1;
  (settings.campaigns || []).forEach((c) => select.append(new Option(c.name, String(c.id))));
  const values = new Map<string, unknown>(Object.entries(settings));
  FIELDS.forEach((f) => {
    fieldById(f.input).value = String(values.get(f.key) ?? "");
  });
}

// One fee field per custom-bouquet style. The styles and their labels come from
// the server (pricing.js), so a new style appears here without editing this page.
async function addStyleFields(): Promise<void> {
  const res = await fetch("/api/flowers");
  if (!res.ok) throw new Error(`styles: ${res.status}`);
  const { styles }: { styles: FlowerStyle[] } = await res.json();
  styles.forEach((s) => {
    const label = document.createElement("label");
    label.className = "admin-form__label";
    label.append(`Phí kiểu gói: ${s.label} (đ)`);
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = "1000";
    input.required = true;
    input.className = "admin-form__input";
    input.id = `set-style-${s.key}`;
    label.appendChild(input);
    byId("set-styles").appendChild(label);
    FIELDS.push({ key: `style_fee_${s.key}`, input: input.id, label: `Phí kiểu gói ${s.label}`, number: true });
  });
}

async function loadSettings(): Promise<void> {
  const errorEl = byId("admin-settings-error");
  try {
    await addStyleFields();
    const result = await adminApi<AdminSettingsBody>("GET", "/api/admin/settings");
    if (result.res.status === 401) return; // adminApi has already sent the person to the login page
    if (!result.ok) throw new Error(`settings: ${result.res.status}`);
    fill(result.data);
    errorEl.hidden = true;
  } catch (err) {
    errorEl.textContent = "Không thể tải cài đặt.";
    errorEl.hidden = false;
  }
}

byId("admin-settings-form", HTMLFormElement).addEventListener("submit", async (e) => {
  e.preventDefault();
  const body: Record<string, string | number | null> = {};
  FIELDS.forEach((f) => {
    const raw = fieldById(f.input).value;
    body[f.key] = f.number ? (raw === "" ? null : Number(raw)) : raw;
  });
  const result = await adminApi<AdminSettingsBody>("PATCH", "/api/admin/settings", body);
  if (result.res.status === 401) return; // adminApi has already sent the person to the login page
  if (!result.ok) {
    const data = result.data;
    if (data && data.error === "campaign_empty") {
      showMessage("Chiến dịch này chưa có sản phẩm nào đang bán. Hãy thêm sản phẩm trong mục Chiến dịch trước khi bật.", false);
      return;
    }
    const field = data && FIELDS.find((f) => f.key === data.field);
    showMessage(field ? `“${field.label}” chưa hợp lệ.` : "Có lỗi xảy ra. Vui lòng thử lại.", false);
    return;
  }
  fill(result.data);
  showMessage("Đã lưu cài đặt. Website dùng giá trị mới ngay.", true);
});

loadSettings();
