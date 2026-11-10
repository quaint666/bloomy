// Bloomy — Product page extras: the tabs, the gallery thumbnails, the attribute
// list and the reviews. product.js calls initProductExtras(product) once the
// product has loaded. Everything that comes from the server or from customers
// (names, tags, review text) is put in with textContent, never as markup.

const EXTRAS_TAB_HASHES = { "#reviews": "tab-reviews", "#care": "tab-care", "#shipping": "tab-ship", "#composition": "tab-comp" };

const exById = (id) => document.getElementById(id);

function exMake(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function exLink(href, text) {
  const a = exMake("a", null, text);
  a.href = href;
  return a;
}

const exStars = (n) => "★".repeat(n) + "☆".repeat(5 - n);
const exDate = (iso) => new Date(iso).toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });

// ---- attributes: code, category (with its parent) and tags, each a link into the listing
function renderAttributes(product) {
  const dl = exById("product-attributes");
  dl.innerHTML = "";
  const row = (label, nodes) => {
    const dd = exMake("dd");
    nodes.forEach((n, i) => {
      if (i > 0) dd.append(", ");
      dd.append(n);
    });
    dl.append(exMake("dt", null, label), dd);
  };
  if (product.sku) row("Mã sản phẩm", [document.createTextNode(product.sku)]);
  if (product.category) {
    const c = product.category;
    const nodes = [];
    if (c.parent_id) nodes.push(exLink(`products.html?category=${c.parent_id}`, c.parent_name));
    nodes.push(exLink(`products.html?category=${c.id}`, c.name));
    const dd = exMake("dd");
    nodes.forEach((n, i) => {
      if (i > 0) dd.append(" › ");
      dd.append(n);
    });
    dl.append(exMake("dt", null, "Danh mục"), dd);
  }
  const groups = new Map();
  (product.tags || []).forEach((t) => {
    if (!groups.has(t.kind_label)) groups.set(t.kind_label, []);
    groups.get(t.kind_label).push(t);
  });
  groups.forEach((tags, label) => row(label, tags.map((t) => exLink(`products.html?tag=${t.id}`, t.name))));
}

// ---- gallery: the main photo plus product_images, as thumbnails (only if there are extras)
function renderGallery(product) {
  const box = exById("gallery-thumbs");
  const photos = [product.image, ...(product.images || [])];
  if (photos.length < 2) {
    box.hidden = true;
    return;
  }
  box.innerHTML = "";
  const main = exById("product-image");
  photos.forEach((src, i) => {
    const btn = exMake("button", "gallery-thumb");
    btn.type = "button";
    btn.setAttribute("aria-label", `Xem ảnh ${i + 1}`);
    btn.setAttribute("aria-pressed", String(i === 0));
    const img = exMake("img");
    img.src = src;
    img.alt = "";
    img.loading = "lazy";
    btn.appendChild(img);
    btn.addEventListener("click", () => {
      main.src = src;
      box.querySelectorAll(".gallery-thumb").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    });
    box.appendChild(btn);
  });
  box.hidden = false;
}

// ---- tabs: roving tabindex, arrow keys / Home / End, and #reviews opens that tab
function initTabs() {
  const list = document.querySelector("#product-tabs [role='tablist']");
  const tabs = [...list.querySelectorAll("[role='tab']")];
  const select = (tab, focus) => {
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      exById(t.getAttribute("aria-controls")).hidden = !on;
    });
    if (focus) tab.focus();
  };
  tabs.forEach((t) => t.addEventListener("click", () => select(t, false)));
  list.addEventListener("keydown", (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let next = null;
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
    select(exById(id), false);
    exById("product-tabs").scrollIntoView?.();
  };
  window.addEventListener("hashchange", fromHash);
  fromHash();
}

// ---- reviews
function renderReviews(data) {
  const { summary, reviews } = data;
  exById("tab-reviews-count").textContent = summary.count > 0 ? `(${summary.count})` : "";
  exById("reviews-summary").textContent =
    summary.count > 0
      ? `${summary.average.toLocaleString("vi-VN")} ★ — ${summary.count} đánh giá`
      : "Chưa có đánh giá nào. Hãy là người đầu tiên!";
  const list = exById("reviews-list");
  list.innerHTML = "";
  reviews.forEach((r) => {
    const li = exMake("li", "review");
    const head = exMake("div", "review__head");
    head.append(exMake("span", "review__stars", exStars(r.stars)), exMake("strong", "review__name", r.name), exMake("span", "review__date", exDate(r.created_at)));
    li.append(head, exMake("p", "review__comment", r.comment));
    list.appendChild(li);
  });
}

function initReviewForm(productId, limits) {
  const form = exById("review-form");
  exById("review-name").maxLength = limits.name_max;
  exById("review-comment").maxLength = limits.comment_max;
  exById("review-hint").textContent = `Nhận xét từ ${limits.comment_min} đến ${limits.comment_max} ký tự. Đánh giá sẽ hiện sau khi Bloomy duyệt.`;

  const row = exById("review-stars");
  for (let n = 1; n <= 5; n++) {
    const label = exMake("label", "review-star");
    const input = exMake("input");
    input.type = "radio";
    input.name = "review-stars";
    input.value = String(n);
    input.className = "visually-hidden";
    input.setAttribute("aria-label", `${n} sao`);
    input.addEventListener("change", () => {
      row.querySelectorAll(".review-star").forEach((l, i) => l.classList.toggle("is-on", i < n));
    });
    label.append(input, exMake("span", null, "★"));
    row.appendChild(label);
  }

  const msg = exById("review-msg");
  const say = (text, ok) => {
    msg.textContent = text;
    msg.className = `review-form__msg ${ok ? "is-ok" : "is-error"}`;
    msg.hidden = false;
  };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const stars = form.querySelector('input[name="review-stars"]:checked');
    const name = exById("review-name").value.trim();
    const comment = exById("review-comment").value.trim();
    if (!name || !stars || comment.length < limits.comment_min) {
      say(`Vui lòng nhập tên, chọn số sao và viết nhận xét từ ${limits.comment_min} ký tự.`, false);
      return;
    }
    const button = exById("review-submit");
    button.disabled = true;
    try {
      const res = await fetch(`/api/products/${productId}/reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, stars: Number(stars.value), comment, website: exById("review-website").value }),
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

async function loadReviews(productId) {
  const res = await fetch(`/api/products/${productId}/reviews`);
  if (!res.ok) throw new Error(`reviews: ${res.status}`);
  const data = await res.json();
  renderReviews(data);
  initReviewForm(productId, data.limits);
}

function initProductExtras(product) {
  renderAttributes(product);
  renderGallery(product);
  exById("product-tabs").hidden = false;
  initTabs();
  loadReviews(product.id).catch((err) => {
    console.error("Bloomy: failed to load reviews", err);
    exById("reviews-summary").textContent = "Không tải được đánh giá.";
  });
}
