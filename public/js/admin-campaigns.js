// Bloomy — Campaign editor ("Chiến dịch"), manager and up. The list of campaigns on the left; on the right
// the one being edited: its words, its coupon, its picture (chosen from the image files already on the
// website) and its products in the order they are shown. Nothing changes on the site until Lưu.
// Everything from the server goes in with textContent (or as a validated file path in an img src).

const STATUS_LABELS = { available: "Đang bán", sold_out_today: "Hết hôm nay", discontinued: "Ngừng bán" };
const FIELD_LABELS = { name: "Tên chiến dịch", headline: "Tiêu đề lớn", subheadline: "Dòng giới thiệu", coupon_code: "Mã giảm giá", hero_image: "Ảnh", product_ids: "Danh sách sản phẩm" };

let campaigns = []; // the list
let options = { coupons: [], products: [], images: [], limits: { products: 12 } };
let selectedId = null; // an id, "new", or null
let saved = null; // the draft as last saved (to know whether anything is unsaved)
let draft = null; // what the form holds

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

const chars = (s) => [...s.normalize("NFC")].length;
const productById = (id) => options.products.find((p) => p.id === id);

function showError(message) {
  const box = $("camp-error");
  box.textContent = message || "";
  box.hidden = !message;
}

function notice(message) {
  const n = $("camp-notice");
  n.textContent = message || "";
  n.hidden = !message;
}

function errorText(data) {
  switch (data && data.error) {
    case "invalid_field":
      return `${FIELD_LABELS[data.field] || "Một trường"} không hợp lệ hoặc quá dài.`;
    case "campaign_active":
      return "Chiến dịch đang chạy không xóa được. Hãy chọn chiến dịch khác (hoặc tắt) trong Cài đặt trước.";
    case "not_found":
      return "Không tìm thấy chiến dịch này.";
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
    return { ok: false, data: null };
  }
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { ok: res.ok, data };
}

// ---------- the list ----------

function renderList() {
  const ul = $("camp-list");
  ul.replaceChildren();
  campaigns.forEach((c) => {
    const li = el("li");
    const btn = el("button", "admin-seo__row");
    btn.type = "button";
    btn.dataset.id = c.id;
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

async function loadList() {
  const { ok, data } = await api("GET", "/api/admin/campaigns");
  if (!ok) return showError("Không tải được danh sách chiến dịch.");
  campaigns = data;
  renderList();
}

// ---------- the form ----------

const snapshot = (d) => JSON.stringify({ name: d.name.trim(), headline: d.headline.trim(), subheadline: d.subheadline.trim(), coupon_code: d.coupon_code || null, hero_image: d.hero_image || null, product_ids: d.product_ids });
const isDirty = () => draft !== null && saved !== null && snapshot(draft) !== saved;

function updateCounts() {
  $("camp-name-count").textContent = `(${chars($("camp-name").value)}/80)`;
  $("camp-headline-count").textContent = `(${chars($("camp-headline").value)}/120)`;
  $("camp-sub-count").textContent = `(${chars($("camp-sub").value)}/200)`;
}

function renderCouponSelect() {
  const sel = $("camp-coupon");
  sel.replaceChildren(new Option("Không dùng mã giảm giá", ""));
  options.coupons.forEach((c) => {
    const what = c.type === "percent" ? `giảm ${c.value}%` : `giảm ${c.value.toLocaleString("vi-VN")}đ`;
    sel.append(new Option(`${c.code} — ${what}${c.active ? "" : " (đang tắt)"}`, c.code));
  });
  sel.value = draft.coupon_code || "";
}

function renderImage() {
  const box = $("camp-image-box");
  box.replaceChildren();
  if (draft.hero_image) {
    const img = el("img", "admin-camp__image-preview");
    img.src = draft.hero_image;
    img.alt = "";
    box.append(img, el("span", "admin-camp__image-name", draft.hero_image.replace(/^images\//, "")));
  } else {
    box.append(el("span", "admin-camp__image-none", "Chưa chọn ảnh: trang chỉ có chữ."));
  }
  $("camp-image-clear").disabled = !draft.hero_image;
}

function renderProducts() {
  const ol = $("camp-products");
  ol.replaceChildren();
  draft.product_ids.forEach((id, i) => {
    const p = productById(id);
    const li = el("li", "admin-camp__product");
    li.dataset.id = id;
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
    down.disabled = i === draft.product_ids.length - 1;
    down.setAttribute("aria-label", `Chuyển xuống: ${p ? p.name : id}`);
    const del = el("button", "admin-camp__icon", "✕");
    del.type = "button";
    del.dataset.act = "remove";
    del.setAttribute("aria-label", `Bỏ khỏi chiến dịch: ${p ? p.name : id}`);
    li.append(up, down, del);
    ol.append(li);
  });
  $("camp-products-heading").textContent = `Sản phẩm (${draft.product_ids.length}/${options.limits.products}, theo thứ tự hiển thị)`;
  const buyable = draft.product_ids.filter((id) => productById(id) && productById(id).status !== "discontinued").length;
  const hint = $("camp-products-hint");
  hint.hidden = buyable > 0;
  hint.textContent = draft.product_ids.length === 0 ? "Chưa có sản phẩm nào: chủ shop chưa bật được chiến dịch này." : "Không còn sản phẩm nào đang bán: chủ shop chưa bật được chiến dịch này.";
  // what can still be added: not in the list, and not discontinued
  const sel = $("camp-add-select");
  sel.replaceChildren(new Option("Chọn sản phẩm để thêm...", ""));
  options.products
    .filter((p) => !draft.product_ids.includes(p.id) && p.status !== "discontinued")
    .forEach((p) => sel.append(new Option(`${p.name}${p.status === "sold_out_today" ? " (hết hôm nay)" : ""}`, String(p.id))));
  const full = draft.product_ids.length >= options.limits.products;
  sel.disabled = full;
  $("camp-add").disabled = full;
}

function fillForm(d, isNew) {
  draft = { name: d.name, headline: d.headline, subheadline: d.subheadline || "", coupon_code: d.coupon_code || "", hero_image: d.hero_image || "", product_ids: (d.products || []).map((p) => p.id) };
  saved = snapshot(draft);
  $("camp-panel").hidden = false;
  $("camp-title").textContent = isNew ? "Chiến dịch mới" : d.name;
  $("camp-name").value = draft.name;
  $("camp-headline").value = draft.headline;
  $("camp-sub").value = draft.subheadline;
  renderCouponSelect();
  renderImage();
  renderProducts();
  updateCounts();
  $("camp-active-note").hidden = !d.active;
  $("camp-delete").hidden = isNew;
  $("camp-delete").disabled = Boolean(d.active);
  $("camp-delete").title = d.active ? "Chiến dịch đang chạy không xóa được" : "";
  notice("");
}

function readForm() {
  draft.name = $("camp-name").value;
  draft.headline = $("camp-headline").value;
  draft.subheadline = $("camp-sub").value;
  draft.coupon_code = $("camp-coupon").value;
}

async function selectCampaign(id) {
  if (id !== selectedId && isDirty() && !window.confirm("Bỏ các thay đổi chưa lưu?")) return;
  showError("");
  const { ok, data } = await api("GET", `/api/admin/campaigns/${id}`);
  if (!ok) return showError(errorText(data));
  selectedId = id;
  fillForm(data, false);
  renderList();
}

function startNew() {
  if (isDirty() && !window.confirm("Bỏ các thay đổi chưa lưu?")) return;
  showError("");
  selectedId = "new";
  fillForm({ name: "", headline: "", subheadline: "", coupon_code: "", hero_image: "", products: [], active: false }, true);
  renderList();
  $("camp-name").focus();
}

async function save(e) {
  e.preventDefault();
  readForm();
  const body = { name: draft.name, headline: draft.headline, subheadline: draft.subheadline, coupon_code: draft.coupon_code || null, hero_image: draft.hero_image || null, product_ids: draft.product_ids };
  const creating = selectedId === "new";
  const { ok, data } = creating ? await api("POST", "/api/admin/campaigns", body) : await api("PATCH", `/api/admin/campaigns/${selectedId}`, body);
  if (!ok) return showError(errorText(data));
  showError("");
  selectedId = data.id;
  fillForm(data, false);
  await loadList();
  notice(creating ? "Đã tạo chiến dịch. Chủ shop bật trong Cài đặt." : data.active ? "Đã lưu. Trang ưu đãi dùng nội dung này ngay." : "Đã lưu.");
}

async function remove() {
  if (selectedId === "new" || !window.confirm(`Xóa chiến dịch “${$("camp-title").textContent}”? Không hoàn tác được.`)) return;
  const { ok, data } = await api("DELETE", `/api/admin/campaigns/${selectedId}`);
  if (!ok) return showError(errorText(data));
  showError("");
  selectedId = null;
  saved = null;
  draft = null;
  $("camp-panel").hidden = true;
  await loadList();
}

// ---------- the picture chooser ----------

function renderImageGrid() {
  const q = $("camp-image-search").value.trim().toLowerCase();
  const grid = $("camp-image-grid");
  grid.replaceChildren();
  const shown = options.images.filter((p) => !q || p.toLowerCase().includes(q));
  shown.forEach((path) => {
    const li = el("li");
    const btn = el("button", "admin-camp__image-option");
    btn.type = "button";
    btn.dataset.path = path;
    if (path === draft.hero_image) btn.classList.add("is-selected");
    const img = el("img");
    img.src = path;
    img.alt = "";
    img.loading = "lazy";
    btn.append(img, el("span", null, path.replace(/^images\//, "")));
    li.append(btn);
    grid.append(li);
  });
  $("camp-image-empty").hidden = shown.length > 0;
}

function init() {
  $("camp-new").addEventListener("click", startNew);
  $("camp-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-id]");
    if (btn) selectCampaign(Number(btn.dataset.id));
  });
  $("camp-form").addEventListener("submit", save);
  $("camp-delete").addEventListener("click", remove);
  ["camp-name", "camp-headline", "camp-sub"].forEach((id) => $(id).addEventListener("input", () => { readForm(); updateCounts(); }));
  $("camp-coupon").addEventListener("change", readForm);

  $("camp-image-choose").addEventListener("click", () => {
    $("camp-image-search").value = "";
    renderImageGrid();
    $("camp-image-dialog").showModal();
  });
  $("camp-image-search").addEventListener("input", renderImageGrid);
  $("camp-image-cancel").addEventListener("click", () => $("camp-image-dialog").close());
  $("camp-image-grid").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-path]");
    if (!btn) return;
    draft.hero_image = btn.dataset.path;
    renderImage();
    $("camp-image-dialog").close();
  });
  $("camp-image-clear").addEventListener("click", () => {
    draft.hero_image = "";
    renderImage();
  });

  $("camp-add").addEventListener("click", () => {
    const id = Number($("camp-add-select").value);
    if (!id || draft.product_ids.includes(id) || draft.product_ids.length >= options.limits.products) return;
    draft.product_ids.push(id);
    renderProducts();
  });
  $("camp-products").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = Number(btn.closest("li").dataset.id);
    const i = draft.product_ids.indexOf(id);
    if (btn.dataset.act === "remove") draft.product_ids.splice(i, 1);
    if (btn.dataset.act === "up" && i > 0) [draft.product_ids[i - 1], draft.product_ids[i]] = [draft.product_ids[i], draft.product_ids[i - 1]];
    if (btn.dataset.act === "down" && i < draft.product_ids.length - 1) [draft.product_ids[i + 1], draft.product_ids[i]] = [draft.product_ids[i], draft.product_ids[i + 1]];
    renderProducts();
    // keep keyboard focus on the same kind of button, on the row the product moved to
    const moved = $("camp-products").querySelector(`li[data-id="${id}"] button[data-act="${btn.dataset.act}"]:not(:disabled)`) || $("camp-products").querySelector(`li[data-id="${id}"] button:not(:disabled)`);
    if (moved) moved.focus();
  });
  window.addEventListener("beforeunload", (e) => {
    if (isDirty()) e.preventDefault();
  });

  // The choices first (the form needs them to draw itself), then the list.
  (async () => {
    const opt = await api("GET", "/api/admin/campaigns/options");
    if (opt.ok) options = opt.data;
    else showError("Không tải được danh sách mã, ảnh và sản phẩm.");
    await loadList();
  })();
}

document.addEventListener("DOMContentLoaded", init);
