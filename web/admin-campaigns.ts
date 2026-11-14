// Bloomy — Campaign editor ("Chiến dịch"), manager and up. The list of campaigns on the left; on the right
// the one being edited: its words, its coupon, its picture (chosen from the image files already on the
// website) and its products in the order they are shown. Nothing changes on the site until Lưu.
// Everything from the server goes in with textContent (or as a validated file path in an img src).

import type { ApiErrorBody, CampaignDetail, CampaignListItem, CampaignOptions, ProductStatus } from "../shared/api-types";
import { adminApi } from "./lib/api";
import { byId, el } from "./lib/dom";

const STATUS_LABELS: Record<ProductStatus, string> = { available: "Đang bán", sold_out_today: "Hết hôm nay", discontinued: "Ngừng bán" };
const FIELD_LABELS: Record<string, string> = { name: "Tên chiến dịch", headline: "Tiêu đề lớn", subheadline: "Dòng giới thiệu", coupon_code: "Mã giảm giá", hero_image: "Ảnh", product_ids: "Danh sách sản phẩm" };

// What the form holds. A blank string stands for "none" in the three optional fields.
interface Draft { name: string; headline: string; subheadline: string; coupon_code: string; hero_image: string; product_ids: number[] }
// What fillForm reads: a campaign from the server, or the blank one a new campaign starts from.
type FormSource = Pick<CampaignDetail, "name" | "headline" | "subheadline" | "coupon_code" | "hero_image" | "active"> & { products: { id: number }[] };

let campaigns: CampaignListItem[] = []; // the list
// The limits shown here are the ones the server sends; these are only what the form uses until they arrive.
let options: CampaignOptions = { coupons: [], products: [], images: [], limits: { name: 80, headline: 120, subheadline: 200, products: 12 } };
let selectedId: number | "new" | null = null; // an id, "new", or null
let saved: string | null = null; // the draft as last saved (to know whether anything is unsaved)
let draft: Draft | null = null; // what the form holds

const chars = (s: string): number => [...s.normalize("NFC")].length;
const productById = (id: number) => options.products.find((p) => p.id === id);

// The form is only drawn once there is a draft; these run after that.
function currentDraft(): Draft {
  if (!draft) throw new Error("No campaign is open");
  return draft;
}

function showError(message?: string): void {
  const box = byId("camp-error");
  box.textContent = message || "";
  box.hidden = !message;
}

function notice(message?: string): void {
  const n = byId("camp-notice");
  n.textContent = message || "";
  n.hidden = !message;
}

function errorText(data: ApiErrorBody | null): string {
  switch (data && data.error) {
    case "invalid_field":
      return `${(data?.field && FIELD_LABELS[data.field]) || "Một trường"} không hợp lệ hoặc quá dài.`;
    case "campaign_active":
      return "Chiến dịch đang chạy không xóa được. Hãy chọn chiến dịch khác (hoặc tắt) trong Cài đặt trước.";
    case "not_found":
      return "Không tìm thấy chiến dịch này.";
    default:
      return "Có lỗi xảy ra. Vui lòng thử lại.";
  }
}

// ---------- the list ----------

function renderList(): void {
  const ul = byId("camp-list");
  ul.replaceChildren();
  campaigns.forEach((c) => {
    const li = el("li");
    const btn = el("button", "admin-seo__row");
    btn.type = "button";
    btn.dataset.id = String(c.id);
    if (c.id === selectedId) btn.classList.add("is-selected");
    const main = el("span", "admin-seo__row-main");
    main.append(el("span", "admin-seo__row-name", c.name), el("span", "admin-seo__row-sub", `${c.product_count} sản phẩm · ${c.coupon_code || "không có mã"}`));
    btn.append(main);
    if (c.active) btn.append(el("span", "admin-camp__badge", "Đang chạy"));
    li.append(btn);
    ul.append(li);
  });
  if (selectedId === "new") {
    const li = el("li");
    const btn = el("button", "admin-seo__row is-selected");
    btn.type = "button";
    btn.append(el("span", "admin-seo__row-name", "Chiến dịch mới (chưa lưu)"));
    li.append(btn);
    ul.append(li);
  }
}

async function loadList(): Promise<void> {
  const result = await adminApi<CampaignListItem[]>("GET", "/api/admin/campaigns");
  if (!result.ok) return showError("Không tải được danh sách chiến dịch.");
  campaigns = result.data;
  renderList();
}

// ---------- the form ----------

const snapshot = (d: Draft): string => JSON.stringify({ name: d.name.trim(), headline: d.headline.trim(), subheadline: d.subheadline.trim(), coupon_code: d.coupon_code || null, hero_image: d.hero_image || null, product_ids: d.product_ids });
const isDirty = (): boolean => draft !== null && saved !== null && snapshot(draft) !== saved;

function updateCounts(): void {
  byId("camp-name-count").textContent = `(${chars(byId("camp-name", HTMLInputElement).value)}/80)`;
  byId("camp-headline-count").textContent = `(${chars(byId("camp-headline", HTMLInputElement).value)}/120)`;
  byId("camp-sub-count").textContent = `(${chars(byId("camp-sub", HTMLTextAreaElement).value)}/200)`;
}

function renderCouponSelect(): void {
  const sel = byId("camp-coupon", HTMLSelectElement);
  sel.replaceChildren(new Option("Không dùng mã giảm giá", ""));
  options.coupons.forEach((c) => {
    const what = c.type === "percent" ? `giảm ${c.value}%` : `giảm ${c.value.toLocaleString("vi-VN")}đ`;
    sel.append(new Option(`${c.code} — ${what}${c.active ? "" : " (đang tắt)"}`, c.code));
  });
  sel.value = currentDraft().coupon_code || "";
}

function renderImage(): void {
  const d = currentDraft();
  const box = byId("camp-image-box");
  box.replaceChildren();
  if (d.hero_image) {
    const img = el("img", "admin-camp__image-preview");
    img.src = d.hero_image;
    img.alt = "";
    box.append(img, el("span", "admin-camp__image-name", d.hero_image.replace(/^images\//, "")));
  } else {
    box.append(el("span", "admin-camp__image-none", "Chưa chọn ảnh: trang chỉ có chữ."));
  }
  byId("camp-image-clear", HTMLButtonElement).disabled = !d.hero_image;
}

function renderProducts(): void {
  const d = currentDraft();
  const ol = byId("camp-products");
  ol.replaceChildren();
  d.product_ids.forEach((id, i) => {
    const p = productById(id);
    const li = el("li", "admin-camp__product");
    li.dataset.id = String(id);
    li.append(el("span", "admin-camp__product-name", p ? p.name : `Sản phẩm #${id}`));
    if (p && p.status !== "available") li.append(el("span", `admin-camp__status admin-camp__status--${p.status}`, STATUS_LABELS[p.status]));
    const up = el("button", "admin-camp__icon", "▲");
    up.type = "button";
    up.dataset.act = "up";
    up.disabled = i === 0;
    up.setAttribute("aria-label", `Chuyển lên: ${p ? p.name : id}`);
    const down = el("button", "admin-camp__icon", "▼");
    down.type = "button";
    down.dataset.act = "down";
    down.disabled = i === d.product_ids.length - 1;
    down.setAttribute("aria-label", `Chuyển xuống: ${p ? p.name : id}`);
    const del = el("button", "admin-camp__icon", "✕");
    del.type = "button";
    del.dataset.act = "remove";
    del.setAttribute("aria-label", `Bỏ khỏi chiến dịch: ${p ? p.name : id}`);
    li.append(up, down, del);
    ol.append(li);
  });
  byId("camp-products-heading").textContent = `Sản phẩm (${d.product_ids.length}/${options.limits.products}, theo thứ tự hiển thị)`;
  const buyable = d.product_ids.filter((id) => productById(id) && productById(id)?.status !== "discontinued").length;
  const hint = byId("camp-products-hint");
  hint.hidden = buyable > 0;
  hint.textContent = d.product_ids.length === 0 ? "Chưa có sản phẩm nào: chủ shop chưa bật được chiến dịch này." : "Không còn sản phẩm nào đang bán: chủ shop chưa bật được chiến dịch này.";
  // what can still be added: not in the list, and not discontinued
  const sel = byId("camp-add-select", HTMLSelectElement);
  sel.replaceChildren(new Option("Chọn sản phẩm để thêm...", ""));
  options.products
    .filter((p) => !d.product_ids.includes(p.id) && p.status !== "discontinued")
    .forEach((p) => sel.append(new Option(`${p.name}${p.status === "sold_out_today" ? " (hết hôm nay)" : ""}`, String(p.id))));
  const full = d.product_ids.length >= options.limits.products;
  sel.disabled = full;
  byId("camp-add", HTMLButtonElement).disabled = full;
}

function fillForm(d: FormSource, isNew: boolean): void {
  const next: Draft = { name: d.name, headline: d.headline, subheadline: d.subheadline || "", coupon_code: d.coupon_code || "", hero_image: d.hero_image || "", product_ids: (d.products || []).map((p) => p.id) };
  draft = next;
  saved = snapshot(next);
  byId("camp-panel").hidden = false;
  byId("camp-title").textContent = isNew ? "Chiến dịch mới" : d.name;
  byId("camp-name", HTMLInputElement).value = next.name;
  byId("camp-headline", HTMLInputElement).value = next.headline;
  byId("camp-sub", HTMLTextAreaElement).value = next.subheadline;
  renderCouponSelect();
  renderImage();
  renderProducts();
  updateCounts();
  byId("camp-active-note").hidden = !d.active;
  const del = byId("camp-delete", HTMLButtonElement);
  del.hidden = isNew;
  del.disabled = Boolean(d.active);
  del.title = d.active ? "Chiến dịch đang chạy không xóa được" : "";
  notice("");
}

function readForm(): void {
  const d = currentDraft();
  d.name = byId("camp-name", HTMLInputElement).value;
  d.headline = byId("camp-headline", HTMLInputElement).value;
  d.subheadline = byId("camp-sub", HTMLTextAreaElement).value;
  d.coupon_code = byId("camp-coupon", HTMLSelectElement).value;
}

async function selectCampaign(id: number): Promise<void> {
  if (id !== selectedId && isDirty() && !window.confirm("Bỏ các thay đổi chưa lưu?")) return;
  showError("");
  const result = await adminApi<CampaignDetail>("GET", `/api/admin/campaigns/${id}`);
  if (!result.ok) return showError(errorText(result.data));
  selectedId = id;
  fillForm(result.data, false);
  renderList();
}

function startNew(): void {
  if (isDirty() && !window.confirm("Bỏ các thay đổi chưa lưu?")) return;
  showError("");
  selectedId = "new";
  fillForm({ name: "", headline: "", subheadline: "", coupon_code: "", hero_image: "", products: [], active: false }, true);
  renderList();
  byId("camp-name").focus();
}

async function save(e: Event): Promise<void> {
  e.preventDefault();
  readForm();
  const d = currentDraft();
  const body = { name: d.name, headline: d.headline, subheadline: d.subheadline, coupon_code: d.coupon_code || null, hero_image: d.hero_image || null, product_ids: d.product_ids };
  const creating = selectedId === "new";
  const result = creating ? await adminApi<CampaignDetail>("POST", "/api/admin/campaigns", body) : await adminApi<CampaignDetail>("PATCH", `/api/admin/campaigns/${selectedId}`, body);
  if (!result.ok) return showError(errorText(result.data));
  const { data } = result;
  showError("");
  selectedId = data.id;
  fillForm(data, false);
  await loadList();
  notice(creating ? "Đã tạo chiến dịch. Chủ shop bật trong Cài đặt." : data.active ? "Đã lưu. Trang ưu đãi dùng nội dung này ngay." : "Đã lưu.");
}

async function remove(): Promise<void> {
  if (selectedId === "new" || !window.confirm(`Xóa chiến dịch “${byId("camp-title").textContent}”? Không hoàn tác được.`)) return;
  const result = await adminApi<{ ok: true }>("DELETE", `/api/admin/campaigns/${selectedId}`);
  if (!result.ok) return showError(errorText(result.data));
  showError("");
  selectedId = null;
  saved = null;
  draft = null;
  byId("camp-panel").hidden = true;
  await loadList();
}

// ---------- the picture chooser ----------

function renderImageGrid(): void {
  const q = byId("camp-image-search", HTMLInputElement).value.trim().toLowerCase();
  const grid = byId("camp-image-grid");
  grid.replaceChildren();
  const shown = options.images.filter((p) => !q || p.toLowerCase().includes(q));
  shown.forEach((path) => {
    const li = el("li");
    const btn = el("button", "admin-camp__image-option");
    btn.type = "button";
    btn.dataset.path = path;
    if (path === currentDraft().hero_image) btn.classList.add("is-selected");
    const img = el("img");
    img.src = path;
    img.alt = "";
    img.loading = "lazy";
    btn.append(img, el("span", null, path.replace(/^images\//, "")));
    li.append(btn);
    grid.append(li);
  });
  byId("camp-image-empty").hidden = shown.length > 0;
}

function swap(ids: number[], i: number, j: number): void {
  const a = ids[i];
  const b = ids[j];
  if (a === undefined || b === undefined) return;
  ids[i] = b;
  ids[j] = a;
}

function init(): void {
  byId("camp-new").addEventListener("click", startNew);
  byId("camp-list").addEventListener("click", (e) => {
    if (!(e.target instanceof Element)) return;
    const btn = e.target.closest<HTMLButtonElement>("button[data-id]");
    if (btn) selectCampaign(Number(btn.dataset.id));
  });
  byId("camp-form", HTMLFormElement).addEventListener("submit", save);
  byId("camp-delete").addEventListener("click", remove);
  ["camp-name", "camp-headline", "camp-sub"].forEach((id) => byId(id).addEventListener("input", () => { readForm(); updateCounts(); }));
  byId("camp-coupon").addEventListener("change", readForm);

  const dialog = byId("camp-image-dialog", HTMLDialogElement);
  byId("camp-image-choose").addEventListener("click", () => {
    byId("camp-image-search", HTMLInputElement).value = "";
    renderImageGrid();
    dialog.showModal();
  });
  byId("camp-image-search").addEventListener("input", renderImageGrid);
  byId("camp-image-cancel").addEventListener("click", () => dialog.close());
  byId("camp-image-grid").addEventListener("click", (e) => {
    if (!(e.target instanceof Element)) return;
    const btn = e.target.closest<HTMLButtonElement>("button[data-path]");
    if (!btn) return;
    currentDraft().hero_image = btn.dataset.path || "";
    renderImage();
    dialog.close();
  });
  byId("camp-image-clear").addEventListener("click", () => {
    currentDraft().hero_image = "";
    renderImage();
  });

  byId("camp-add").addEventListener("click", () => {
    const d = currentDraft();
    const id = Number(byId("camp-add-select", HTMLSelectElement).value);
    if (!id || d.product_ids.includes(id) || d.product_ids.length >= options.limits.products) return;
    d.product_ids.push(id);
    renderProducts();
  });
  byId("camp-products").addEventListener("click", (e) => {
    if (!(e.target instanceof Element)) return;
    const btn = e.target.closest<HTMLButtonElement>("button[data-act]");
    if (!btn) return;
    const ids = currentDraft().product_ids;
    const li = btn.closest<HTMLElement>("li");
    if (!li) return;
    const id = Number(li.dataset.id);
    const i = ids.indexOf(id);
    if (btn.dataset.act === "remove") ids.splice(i, 1);
    if (btn.dataset.act === "up" && i > 0) swap(ids, i - 1, i);
    if (btn.dataset.act === "down" && i < ids.length - 1) swap(ids, i + 1, i);
    renderProducts();
    // keep keyboard focus on the same kind of button, on the row the product moved to
    const moved = byId("camp-products").querySelector<HTMLButtonElement>(`li[data-id="${id}"] button[data-act="${btn.dataset.act}"]:not(:disabled)`) || byId("camp-products").querySelector<HTMLButtonElement>(`li[data-id="${id}"] button:not(:disabled)`);
    if (moved) moved.focus();
  });
  window.addEventListener("beforeunload", (e) => {
    if (isDirty()) e.preventDefault();
  });

  // The choices first (the form needs them to draw itself), then the list.
  (async () => {
    const opt = await adminApi<CampaignOptions>("GET", "/api/admin/campaigns/options");
    if (opt.ok) options = opt.data;
    else showError("Không tải được danh sách mã, ảnh và sản phẩm.");
    await loadList();
  })();
}

document.addEventListener("DOMContentLoaded", init);
