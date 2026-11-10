// Bloomy — Product SEO ("SEO"), manager and up. A list of products with a health dot; pick
// one to write its keyword, title and description. The preview and the checks come from the
// server (the same code the product page itself uses), asked again shortly after each key
// press, so what you see is what the page will say. Nothing changes on the site until Lưu.
// Everything from the server goes in with textContent.

const LEVEL_LABELS = { good: "Tốt", warn: "Cần cải thiện", bad: "Chưa ổn" };
const STATUS_LABELS = { available: "Đang bán", sold_out_today: "Hết hôm nay", discontinued: "Ngừng bán" };
const FIELD_LABELS = { seo_keyword: "Từ khóa chính", seo_title: "Tiêu đề SEO", seo_description: "Mô tả" };
const PREVIEW_DELAY_MS = 300;

let products = []; // the list: { id, name, status, keyword, health }
let selectedId = null;
let saved = null; // the three fields as last saved, to know whether anything is unsaved
let previewTimer = null;
let requestCounter = 0; // an older answer must never overwrite a newer one

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function chars(s) {
  return [...s.normalize("NFC")].length;
}

function showError(message) {
  const box = $("admin-seo-error");
  box.textContent = message || "";
  box.hidden = !message;
}

function errorText(data) {
  if (data && data.error === "invalid_field") return `${FIELD_LABELS[data.field] || "Trường"} không hợp lệ hoặc quá dài.`;
  return "Có lỗi xảy ra. Vui lòng thử lại.";
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    window.location.href = "admin-login.html";
    return { ok: false, data: null };
  }
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { ok: res.ok, data };
}

// ---------- the list ----------

function dot(level) {
  const wrap = el("span", "admin-seo__health");
  wrap.append(el("span", `admin-seo__dot admin-seo__dot--${level}`), el("span", "admin-seo__health-text", LEVEL_LABELS[level]));
  return wrap;
}

function renderList() {
  const q = $("seo-search").value.trim().toLowerCase();
  const ul = $("seo-products");
  ul.replaceChildren();
  products
    .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.keyword || "").toLowerCase().includes(q))
    .forEach((p) => {
      const li = el("li");
      const btn = el("button", "admin-seo__row");
      btn.type = "button";
      btn.dataset.id = p.id;
      if (p.id === selectedId) btn.classList.add("is-selected");
      const main = el("span", "admin-seo__row-main");
      main.append(el("span", "admin-seo__row-name", p.name), el("span", "admin-seo__row-sub", `${p.keyword || "Chưa có từ khóa"} · ${STATUS_LABELS[p.status] || p.status}`));
      btn.append(main, dot(p.health));
      li.append(btn);
      ul.append(li);
    });
}

async function loadList() {
  const { ok, data } = await api("GET", "/api/admin/seo");
  if (!ok) return showError("Không tải được danh sách sản phẩm.");
  products = data;
  renderList();
}

// ---------- one product ----------

function fieldValues() {
  return { seo_keyword: $("seo-keyword").value, seo_title: $("seo-title").value, seo_description: $("seo-description").value };
}

const clean = (s) => s.normalize("NFC").replace(/\s+/g, " ").trim();

function isDirty() {
  if (!saved) return false;
  const now = fieldValues();
  return Object.keys(now).some((k) => clean(now[k]) !== clean(saved[k] || ""));
}

function updateCounts() {
  $("seo-title-count").textContent = `(${chars($("seo-title").value)} ký tự)`;
  $("seo-description-count").textContent = `(${chars($("seo-description").value)} ký tự)`;
}

function renderPreview(d) {
  $("seo-prev-url").textContent = d.preview.url;
  $("seo-prev-title").textContent = d.preview.title;
  $("seo-prev-desc").textContent = d.preview.description;
  $("seo-robots-note").hidden = !d.effective.robots;
  const ul = $("seo-checks");
  ul.replaceChildren();
  d.checks.forEach((c) => {
    const li = el("li", `admin-seo__check admin-seo__check--${c.level}`);
    li.append(el("span", "admin-seo__check-level", LEVEL_LABELS[c.level]), el("span", "admin-seo__check-text", c.text));
    ul.append(li);
  });
}

function fillForm(d) {
  $("seo-panel").hidden = false;
  $("seo-product-name").textContent = d.product.name;
  $("seo-keyword").value = d.fields.seo_keyword || "";
  $("seo-title").value = d.fields.seo_title || "";
  $("seo-description").value = d.fields.seo_description || "";
  saved = { ...d.fields };
  $("seo-notice").hidden = true;
  updateCounts();
  renderPreview(d);
}

async function select(id) {
  if (id !== selectedId && isDirty() && !window.confirm("Bỏ các thay đổi chưa lưu?")) return;
  showError("");
  const mine = ++requestCounter;
  const { ok, data } = await api("GET", `/api/admin/seo/${id}`);
  if (mine !== requestCounter) return;
  if (!ok) return showError("Không tải được sản phẩm này.");
  selectedId = id;
  fillForm(data);
  renderList();
}

// Asks the server what the page WOULD say with what is typed now (writes nothing).
async function preview() {
  const mine = ++requestCounter;
  const { ok, data } = await api("POST", `/api/admin/seo/${selectedId}/preview`, fieldValues());
  if (mine !== requestCounter) return;
  if (!ok) return showError(errorText(data));
  showError("");
  renderPreview(data);
}

function schedulePreview() {
  updateCounts();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(preview, PREVIEW_DELAY_MS);
}

async function save(e) {
  e.preventDefault();
  clearTimeout(previewTimer);
  const mine = ++requestCounter;
  const { ok, data } = await api("PATCH", `/api/admin/seo/${selectedId}`, fieldValues());
  if (mine !== requestCounter) return;
  if (!ok) return showError(errorText(data));
  showError("");
  fillForm(data);
  const notice = $("seo-notice");
  notice.textContent = "Đã lưu. Trang sản phẩm dùng nội dung này ngay.";
  notice.hidden = false;
  const row = products.find((p) => p.id === selectedId);
  row.keyword = data.fields.seo_keyword;
  row.health = data.health;
  renderList();
}

function init() {
  $("seo-search").addEventListener("input", renderList);
  $("seo-products").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-id]");
    if (btn) select(Number(btn.dataset.id));
  });
  ["seo-keyword", "seo-title", "seo-description"].forEach((id) => $(id).addEventListener("input", schedulePreview));
  $("seo-form").addEventListener("submit", save);
  window.addEventListener("beforeunload", (e) => {
    if (isDirty()) e.preventDefault();
  });
  loadList();
}

document.addEventListener("DOMContentLoaded", init);
