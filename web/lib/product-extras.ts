// Bloomy — Product page extras: the tabs, the gallery thumbnails, the attribute
// list and the reviews. product.ts calls initProductExtras(product) once the
// product has loaded. Everything that comes from the server or from customers
// (names, tags, review text) is put in with textContent, never as markup.

import type { ProductDetailBody, ProductTag, ReviewLimits, ReviewsResponse } from "../../shared/api-types";
import { byId, el } from "./dom";

const EXTRAS_TAB_HASHES: Record<string, string> = { "#reviews": "tab-reviews", "#care": "tab-care", "#shipping": "tab-ship", "#composition": "tab-comp" };

function exLink(href: string, text: string | null): HTMLAnchorElement {
  const a = el("a", null, text);
  a.href = href;
  return a;
}

const exStars = (n: number): string => "★".repeat(n) + "☆".repeat(5 - n);
const exDate = (iso: string): string => new Date(iso).toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });

// ---- attributes: code, category (with its parent) and tags, each a link into the listing
function renderAttributes(product: ProductDetailBody): void {
  const dl = byId("product-attributes");
  dl.innerHTML = "";
  const row = (label: string, nodes: Node[]) => {
    const dd = el("dd");
    nodes.forEach((n, i) => {
      if (i > 0) dd.append(", ");
      dd.append(n);
    });
    dl.append(el("dt", null, label), dd);
  };
  if (product.sku) row("Mã sản phẩm", [document.createTextNode(product.sku)]);
  if (product.category) {
    const c = product.category;
    const nodes: HTMLAnchorElement[] = [];
    if (c.parent_id) nodes.push(exLink(`products.html?category=${c.parent_id}`, c.parent_name));
    nodes.push(exLink(`products.html?category=${c.id}`, c.name));
    const dd = el("dd");
    nodes.forEach((n, i) => {
      if (i > 0) dd.append(" › ");
      dd.append(n);
    });
    dl.append(el("dt", null, "Danh mục"), dd);
  }
  const groups = new Map<string, ProductTag[]>();
  (product.tags || []).forEach((t) => {
    let group = groups.get(t.kind_label);
    if (!group) {
      group = [];
      groups.set(t.kind_label, group);
    }
    group.push(t);
  });
  groups.forEach((tags, label) => row(label, tags.map((t) => exLink(`products.html?tag=${t.id}`, t.name))));
}

// ---- gallery: the main photo plus product_images, as thumbnails (only if there are extras)
function renderGallery(product: ProductDetailBody): void {
  const box = byId("gallery-thumbs");
  const photos = [product.image, ...(product.images || [])];
  if (photos.length < 2) {
    box.hidden = true;
    return;
  }
  box.innerHTML = "";
  const main = byId("product-image", HTMLImageElement);
  photos.forEach((src, i) => {
    const btn = el("button", "gallery-thumb");
    btn.type = "button";
    btn.setAttribute("aria-label", `Xem ảnh ${i + 1}`);
    btn.setAttribute("aria-pressed", String(i === 0));
    const img = el("img");
    img.src = String(src); // a product with no picture has been given the address "null", as before
    img.alt = "";
    img.loading = "lazy";
    btn.appendChild(img);
    btn.addEventListener("click", () => {
      main.src = String(src);
      box.querySelectorAll(".gallery-thumb").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    });
    box.appendChild(btn);
  });
  box.hidden = false;
}

// ---- tabs: roving tabindex, arrow keys / Home / End, and #reviews opens that tab
function initTabs(): void {
  const list = document.querySelector<HTMLElement>("#product-tabs [role='tablist']");
  if (!list) throw new Error("Missing the tab list");
  const tabs = [...list.querySelectorAll<HTMLElement>("[role='tab']")];
  const select = (tab: HTMLElement, focus: boolean) => {
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      byId(t.getAttribute("aria-controls") ?? "").hidden = !on;
    });
    if (focus) tab.focus();
  };
  tabs.forEach((t) => t.addEventListener("click", () => select(t, false)));
  list.addEventListener("keydown", (e) => {
    const active = document.activeElement;
    const i = active instanceof HTMLElement ? tabs.indexOf(active) : -1;
    if (i < 0) return;
    let next: HTMLElement | undefined;
    if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
    else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (e.key === "Home") next = tabs[0];
    else if (e.key === "End") next = tabs[tabs.length - 1];
    if (next) {
      e.preventDefault();
      select(next, true);
    }
  });
  const fromHash = () => {
    const id = EXTRAS_TAB_HASHES[window.location.hash];
    if (!id) return;
    select(byId(id), false);
    byId("product-tabs").scrollIntoView?.();
  };
  window.addEventListener("hashchange", fromHash);
  fromHash();
}

// ---- reviews
function renderReviews(data: ReviewsResponse): void {
  const { summary, reviews } = data;
  byId("tab-reviews-count").textContent = summary.count > 0 ? `(${summary.count})` : "";
  byId("reviews-summary").textContent =
    summary.count > 0
      ? `${summary.average.toLocaleString("vi-VN")} ★ — ${summary.count} đánh giá`
      : "Chưa có đánh giá nào. Hãy là người đầu tiên!";
  const list = byId("reviews-list");
  list.innerHTML = "";
  reviews.forEach((r) => {
    const li = el("li", "review");
    const head = el("div", "review__head");
    head.append(el("span", "review__stars", exStars(r.stars)), el("strong", "review__name", r.name), el("span", "review__date", exDate(r.created_at)));
    li.append(head, el("p", "review__comment", r.comment));
    list.appendChild(li);
  });
}

function initReviewForm(productId: number, limits: ReviewLimits): void {
  const form = byId("review-form", HTMLFormElement);
  byId("review-name", HTMLInputElement).maxLength = limits.name_max;
  byId("review-comment", HTMLTextAreaElement).maxLength = limits.comment_max;
  byId("review-hint").textContent = `Nhận xét từ ${limits.comment_min} đến ${limits.comment_max} ký tự. Đánh giá sẽ hiện sau khi Bloomy duyệt.`;

  const row = byId("review-stars");
  for (let n = 1; n <= 5; n++) {
    const label = el("label", "review-star");
    const input = el("input");
    input.type = "radio";
    input.name = "review-stars";
    input.value = String(n);
    input.className = "visually-hidden";
    input.setAttribute("aria-label", `${n} sao`);
    input.addEventListener("change", () => {
      row.querySelectorAll(".review-star").forEach((l, i) => l.classList.toggle("is-on", i < n));
    });
    label.append(input, el("span", null, "★"));
    row.appendChild(label);
  }

  const msg = byId("review-msg");
  const say = (text: string, ok: boolean) => {
    msg.textContent = text;
    msg.className = `review-form__msg ${ok ? "is-ok" : "is-error"}`;
    msg.hidden = false;
  };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const stars = form.querySelector<HTMLInputElement>('input[name="review-stars"]:checked');
    const name = byId("review-name", HTMLInputElement).value.trim();
    const comment = byId("review-comment", HTMLTextAreaElement).value.trim();
    if (!name || !stars || comment.length < limits.comment_min) {
      say(`Vui lòng nhập tên, chọn số sao và viết nhận xét từ ${limits.comment_min} ký tự.`, false);
      return;
    }
    const button = byId("review-submit", HTMLButtonElement);
    button.disabled = true;
    try {
      const res = await fetch(`/api/products/${productId}/reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, stars: Number(stars.value), comment, website: byId("review-website", HTMLInputElement).value }),
      });
      if (res.status === 201) {
        form.reset();
        row.querySelectorAll(".review-star").forEach((l) => l.classList.remove("is-on"));
        say("Cảm ơn bạn! Đánh giá sẽ hiện sau khi Bloomy duyệt.", true);
      } else if (res.status === 429) {
        say("Bạn đã gửi quá nhiều đánh giá. Vui lòng thử lại sau.", false);
      } else if (res.status === 400) {
        say("Đánh giá chưa hợp lệ. Vui lòng kiểm tra lại tên, số sao và nhận xét.", false);
      } else {
        say("Không gửi được đánh giá. Vui lòng thử lại.", false);
      }
    } catch (err) {
      say("Không thể kết nối máy chủ. Vui lòng thử lại.", false);
    } finally {
      button.disabled = false;
    }
  });
}

async function loadReviews(productId: number): Promise<void> {
  const res = await fetch(`/api/products/${productId}/reviews`);
  if (!res.ok) throw new Error(`reviews: ${res.status}`);
  const data: ReviewsResponse = await res.json();
  renderReviews(data);
  initReviewForm(productId, data.limits);
}

export function initProductExtras(product: ProductDetailBody): void {
  renderAttributes(product);
  renderGallery(product);
  byId("product-tabs").hidden = false;
  initTabs();
  loadReviews(product.id).catch((err) => {
    console.error("Bloomy: failed to load reviews", err);
    byId("reviews-summary").textContent = "Không tải được đánh giá.";
  });
}
