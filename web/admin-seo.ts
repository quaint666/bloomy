// Bloomy — Product SEO ("SEO"), manager and up. A list of products with a health dot; pick
// one to write its keyword, title and description. The preview and the checks come from the
// server (the same code the product page itself uses), asked again shortly after each key
// press, so what you see is what the page will say. Nothing changes on the site until Lưu.
// Everything from the server goes in with textContent.

import type { ApiErrorBody, ProductStatus, SeoDetailBody, SeoLevel, SeoListItem } from "../shared/api-types";
import { adminApi } from "./lib/api";
import { byId, el } from "./lib/dom";

const LEVEL_LABELS: Record<SeoLevel, string> = { good: "Tốt", warn: "Cần cải thiện", bad: "Chưa ổn" };
const STATUS_LABELS: Record<ProductStatus, string> = { available: "Đang bán", sold_out_today: "Hết hôm nay", discontinued: "Ngừng bán" };
const FIELD_LABELS: Record<string, string> = { seo_keyword: "Từ khóa chính", seo_title: "Tiêu đề SEO", seo_description: "Mô tả" };
const FIELD_KEYS = ["seo_keyword", "seo_title", "seo_description"] as const;
const PREVIEW_DELAY_MS = 300;

let products: SeoListItem[] = []; // the list: { id, name, status, keyword, health }
let selectedId: number | null = null;
let saved: SeoDetailBody["fields"] | null = null; // the three fields as last saved, to know whether anything is unsaved
let previewTimer: number | undefined;
let requestCounter = 0; // an older answer must never overwrite a newer one

function chars(s: string): number {
  return [...s.normalize("NFC")].length;
}

function showError(message?: string): void {
  const box = byId("admin-seo-error");
  box.textContent = message || "";
  box.hidden = !message;
}

function errorText(data: ApiErrorBody | null): string {
  if (data && data.error === "invalid_field") return `${(data.field && FIELD_LABELS[data.field]) || "Trường"} không hợp lệ hoặc quá dài.`;
  return "Có lỗi xảy ra. Vui lòng thử lại.";
}

// ---------- the list ----------

function dot(level: SeoLevel): HTMLElement {
  const wrap = el("span", "admin-seo__health");
  wrap.append(el("span", `admin-seo__dot admin-seo__dot--${level}`), el("span", "admin-seo__health-text", LEVEL_LABELS[level]));
  return wrap;
}

function renderList(): void {
  const q = byId("seo-search", HTMLInputElement).value.trim().toLowerCase();
  const ul = byId("seo-products");
  ul.replaceChildren();
  products
    .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.keyword || "").toLowerCase().includes(q))
    .forEach((p) => {
      const li = el("li");
      const btn = el("button", "admin-seo__row");
      btn.type = "button";
      btn.dataset.id = String(p.id);
      if (p.id === selectedId) btn.classList.add("is-selected");
      const main = el("span", "admin-seo__row-main");
      main.append(el("span", "admin-seo__row-name", p.name), el("span", "admin-seo__row-sub", `${p.keyword || "Chưa có từ khóa"} · ${STATUS_LABELS[p.status] || p.status}`));
      btn.append(main, dot(p.health));
      li.append(btn);
      ul.append(li);
    });
}

async function loadList(): Promise<void> {
  const result = await adminApi<SeoListItem[]>("GET", "/api/admin/seo");
  if (!result.ok) return showError("Không tải được danh sách sản phẩm.");
  products = result.data;
  renderList();
}

// ---------- one product ----------

function fieldValues(): Record<(typeof FIELD_KEYS)[number], string> {
  return {
    seo_keyword: byId("seo-keyword", HTMLInputElement).value,
    seo_title: byId("seo-title", HTMLInputElement).value,
    seo_description: byId("seo-description", HTMLTextAreaElement).value,
  };
}

const clean = (s: string): string => s.normalize("NFC").replace(/\s+/g, " ").trim();

function isDirty(): boolean {
  if (!saved) return false;
  const now = fieldValues();
  const was = saved;
  return FIELD_KEYS.some((k) => clean(now[k]) !== clean(was[k] || ""));
}

function updateCounts(): void {
  byId("seo-title-count").textContent = `(${chars(byId("seo-title", HTMLInputElement).value)} ký tự)`;
  byId("seo-description-count").textContent = `(${chars(byId("seo-description", HTMLTextAreaElement).value)} ký tự)`;
}

function renderPreview(d: SeoDetailBody): void {
  byId("seo-prev-url").textContent = d.preview.url;
  byId("seo-prev-title").textContent = d.preview.title;
  byId("seo-prev-desc").textContent = d.preview.description;
  byId("seo-robots-note").hidden = !d.effective.robots;
  const ul = byId("seo-checks");
  ul.replaceChildren();
  d.checks.forEach((c) => {
    const li = el("li", `admin-seo__check admin-seo__check--${c.level}`);
    li.append(el("span", "admin-seo__check-level", LEVEL_LABELS[c.level]), el("span", "admin-seo__check-text", c.text));
    ul.append(li);
  });
}

function fillForm(d: SeoDetailBody): void {
  byId("seo-panel").hidden = false;
  byId("seo-product-name").textContent = d.product.name;
  byId("seo-keyword", HTMLInputElement).value = d.fields.seo_keyword || "";
  byId("seo-title", HTMLInputElement).value = d.fields.seo_title || "";
  byId("seo-description", HTMLTextAreaElement).value = d.fields.seo_description || "";
  saved = { ...d.fields };
  byId("seo-notice").hidden = true;
  updateCounts();
  renderPreview(d);
}

async function select(id: number): Promise<void> {
  if (id !== selectedId && isDirty() && !window.confirm("Bỏ các thay đổi chưa lưu?")) return;
  showError("");
  const mine = ++requestCounter;
  const result = await adminApi<SeoDetailBody>("GET", `/api/admin/seo/${id}`);
  if (mine !== requestCounter) return;
  if (!result.ok) return showError("Không tải được sản phẩm này.");
  selectedId = id;
  fillForm(result.data);
  renderList();
}

// Asks the server what the page WOULD say with what is typed now (writes nothing).
async function preview(): Promise<void> {
  const mine = ++requestCounter;
  const result = await adminApi<SeoDetailBody>("POST", `/api/admin/seo/${selectedId}/preview`, fieldValues());
  if (mine !== requestCounter) return;
  if (!result.ok) return showError(errorText(result.data));
  showError("");
  renderPreview(result.data);
}

function schedulePreview(): void {
  updateCounts();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(preview, PREVIEW_DELAY_MS);
}

async function save(e: Event): Promise<void> {
  e.preventDefault();
  clearTimeout(previewTimer);
  const mine = ++requestCounter;
  const result = await adminApi<SeoDetailBody>("PATCH", `/api/admin/seo/${selectedId}`, fieldValues());
  if (mine !== requestCounter) return;
  if (!result.ok) return showError(errorText(result.data));
  const { data } = result;
  showError("");
  fillForm(data);
  const notice = byId("seo-notice");
  notice.textContent = "Đã lưu. Trang sản phẩm dùng nội dung này ngay.";
  notice.hidden = false;
  const row = products.find((p) => p.id === selectedId);
  if (row) {
    row.keyword = data.fields.seo_keyword;
    row.health = data.health;
  }
  renderList();
}

function init(): void {
  byId("seo-search", HTMLInputElement).addEventListener("input", renderList);
  byId("seo-products").addEventListener("click", (e) => {
    if (!(e.target instanceof Element)) return;
    const btn = e.target.closest<HTMLButtonElement>("button[data-id]");
    if (btn) select(Number(btn.dataset.id));
  });
  ["seo-keyword", "seo-title", "seo-description"].forEach((id) => byId(id).addEventListener("input", schedulePreview));
  byId("seo-form", HTMLFormElement).addEventListener("submit", save);
  window.addEventListener("beforeunload", (e) => {
    if (isDirty()) e.preventDefault();
  });
  loadList();
}

document.addEventListener("DOMContentLoaded", init);
