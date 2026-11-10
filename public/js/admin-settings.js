// Bloomy — Shop settings ("Cài đặt"), owner only. One form for the single
// settings row. What the server rejects it names by field (see
// routes/admin-settings.js); the public pages pick up the new values from
// GET /api/settings, so nothing else needs editing.

const FIELDS = [
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

const $ = (id) => document.getElementById(id);

function showMessage(text, ok) {
  const m = $("admin-settings-msg");
  m.textContent = text;
  m.className = `admin-form__msg ${ok ? "is-ok" : "is-error"}`;
  m.hidden = false;
}

function fill(settings) {
  // The campaign dropdown: "Không có" stays first, the rest come from the server.
  const select = $("set-campaign");
  select.length = 1;
  (settings.campaigns || []).forEach((c) => select.append(new Option(c.name, c.id)));
  FIELDS.forEach((f) => {
    $(f.input).value = settings[f.key] ?? "";
  });
}

// One fee field per custom-bouquet style. The styles and their labels come from
// the server (pricing.js), so a new style appears here without editing this page.
async function addStyleFields() {
  const res = await fetch("/api/flowers");
  if (!res.ok) throw new Error(`styles: ${res.status}`);
  const { styles } = await res.json();
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
    $("set-styles").appendChild(label);
    FIELDS.push({ key: `style_fee_${s.key}`, input: input.id, label: `Phí kiểu gói ${s.label}`, number: true });
  });
}

async function loadSettings() {
  const errorEl = $("admin-settings-error");
  try {
    await addStyleFields();
    const res = await fetch("/api/admin/settings");
    if (res.status === 401) {
      window.location.href = "admin-login.html";
      return;
    }
    if (!res.ok) throw new Error(`settings: ${res.status}`);
    fill(await res.json());
    errorEl.hidden = true;
  } catch (err) {
    errorEl.textContent = "Không thể tải cài đặt.";
    errorEl.hidden = false;
  }
}

$("admin-settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {};
  FIELDS.forEach((f) => {
    const raw = $(f.input).value;
    body[f.key] = f.number ? (raw === "" ? null : Number(raw)) : raw;
  });
  const res = await fetch("/api/admin/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    window.location.href = "admin-login.html";
    return;
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (data && data.error === "campaign_empty") {
      showMessage("Chiến dịch này chưa có sản phẩm nào đang bán. Hãy thêm sản phẩm trong mục Chiến dịch trước khi bật.", false);
      return;
    }
    const field = data && FIELDS.find((f) => f.key === data.field);
    showMessage(field ? `“${field.label}” chưa hợp lệ.` : "Có lỗi xảy ra. Vui lòng thử lại.", false);
    return;
  }
  fill(data);
  showMessage("Đã lưu cài đặt. Website dùng giá trị mới ngay.", true);
});

loadSettings();
