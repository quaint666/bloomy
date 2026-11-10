// Bloomy — Product Detail page logic.
// Reads ?id= from the URL, fetches GET /api/products/:id, renders the
// three availability states (available/sold_out_today/discontinued), the
// size picker (only when the product has more than one size — the price and
// the flower list follow the chosen size), handles the quantity stepper +
// add-to-cart (product + size), loads up to
// 4 related products from the same category, injects schema.org Product
// structured data, and shows a holiday-cutoff advisory when one falls in
// the next 7 days.

let currentProduct = null;
let selectedSize = null; // one of currentProduct.sizes
let quantity = 1;

function getProductId() {
  const params = new URLSearchParams(window.location.search);
  return parseInt(params.get("id"), 10);
}

const AVAILABILITY_SCHEMA_MAP = {
  available: "https://schema.org/InStock",
  sold_out_today: "https://schema.org/OutOfStock",
  discontinued: "https://schema.org/Discontinued",
};

// Inserts a schema.org Product block so search engines can read price and
// availability directly — ties the availability pillar (available /
// sold_out_today / discontinued) into a machine-readable format. Called
// once per product load; there's only ever one product per page, so no
// need to guard against duplicate script tags.
function injectProductJsonLd(product) {
  // The canonical address (written by the server), not the address bar: that one may carry
  // ?utm_source=... and the like.
  const pageUrl = document.querySelector('link[rel="canonical"]')?.href || window.location.href;
  const data = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    image: new URL(product.image, window.location.origin).href,
    // Several sizes → a price range (AggregateOffer); one size → one Offer.
    offers:
      product.sizes.length > 1
        ? {
            "@type": "AggregateOffer",
            priceCurrency: "VND",
            lowPrice: Math.min(...product.sizes.map((s) => s.price)),
            highPrice: Math.max(...product.sizes.map((s) => s.price)),
            offerCount: product.sizes.length,
            availability: AVAILABILITY_SCHEMA_MAP[product.status] || "https://schema.org/InStock",
            url: pageUrl,
          }
        : {
            "@type": "Offer",
            priceCurrency: "VND",
            price: product.price,
            availability: AVAILABILITY_SCHEMA_MAP[product.status] || "https://schema.org/InStock",
            url: pageUrl,
          },
  };
  if (product.description) data.description = product.description;

  const script = document.createElement("script");
  script.type = "application/ld+json";
  script.textContent = JSON.stringify(data);
  document.head.appendChild(script);
}

function renderProduct(product) {
  currentProduct = product;

  // (The <title>, description and share tags are written by the server, from the product's own
  // SEO fields when it has them: render.js. Setting document.title here would overwrite them.)
  document.getElementById("breadcrumb-name").textContent = product.name;

  document.getElementById("product-image").src = product.image;
  document.getElementById("product-image").alt = product.name;
  document.getElementById("product-name").textContent = product.name;
  document.getElementById("product-description").textContent = product.description || "";
  const shortEl = document.getElementById("product-short");
  shortEl.textContent = product.short_description || "";
  shortEl.hidden = !product.short_description;

  // Default to Vừa when the product has it, otherwise its only size.
  selectedSize = product.sizes.find((s) => s.size === "m") || product.sizes[0];
  renderSizePicker(product);
  renderSelectedSize();

  if (product.product_type === "external") {
    renderExternal(product);
  } else {
    applyStatusState(product.status);
  }
  injectProductJsonLd(product);

  document.getElementById("product-detail").hidden = false;
  // Tabs, gallery thumbnails, attributes and reviews. They must never take the
  // product itself down with them.
  try {
    initProductExtras(product);
  } catch (err) {
    console.error("Bloomy: product extras failed", err);
  }
}

// Size buttons ("Nhỏ · 460.000đ"), only when there is a choice to make.
// A single-size product shows no picker at all — it reads as a plain product.
function renderSizePicker(product) {
  const picker = document.getElementById("size-picker");
  if (product.sizes.length < 2) {
    picker.hidden = true;
    return;
  }
  picker.innerHTML = product.sizes
    .map(
      (s) => `
    <button type="button" class="size-picker__option" role="radio" data-size="${s.size}"
            aria-checked="${s.size === selectedSize.size}">
      <span class="size-picker__name">${window.Bloomy.SIZE_LABELS[s.size]}</span>
      <span class="size-picker__price">${window.Bloomy.formatVND(s.price)}</span>
    </button>`
    )
    .join("");
  picker.hidden = false;
  picker.querySelectorAll(".size-picker__option").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedSize = currentProduct.sizes.find((s) => s.size === btn.dataset.size);
      picker.querySelectorAll(".size-picker__option").forEach((b) => {
        b.setAttribute("aria-checked", String(b === btn));
      });
      renderSelectedSize();
    });
  });
}

// Price and flower list of the chosen size. Greenery and wrapping are in
// the description, not here — only the tracked flowers are listed.
function renderSelectedSize() {
  document.getElementById("product-price").textContent = window.Bloomy.formatVND(selectedSize.price);
  const box = document.getElementById("composition-box");
  document.getElementById("composition-empty").hidden = selectedSize.flowers.length > 0;
  if (selectedSize.flowers.length === 0) {
    box.hidden = true;
    return;
  }
  const label = document.getElementById("composition-label");
  label.textContent =
    currentProduct.sizes.length > 1
      ? `Thành phần (size ${window.Bloomy.SIZE_LABELS[selectedSize.size]})`
      : "Thành phần bó hoa";
  document.getElementById("product-composition").textContent = selectedSize.flowers
    .map((f) => `${f.name} × ${f.quantity}`)
    .join(", ");
  box.hidden = false;
}

// A product sold on another site: no cart, no quantity — one button that
// opens the seller's page, labelled with its domain (e.g. "Mua tại ironstyle.vn").
function renderExternal(product) {
  document.querySelector(".product-detail__actions .qty-stepper").hidden = true;
  document.getElementById("add-to-cart").hidden = true;
  const link = document.getElementById("external-buy");
  let host = "";
  try {
    host = new URL(product.external_url).hostname.replace(/^www\./, "");
  } catch (err) {
    host = "";
  }
  link.textContent = host ? `Mua tại ${host}` : "Mua tại cửa hàng đối tác";
  link.href = product.external_url;
  link.hidden = false;
}

// The three states are locked from design review — nothing here is a new
// decision, just building what was already reviewed:
// - available: nothing extra shown, button enabled
// - sold_out_today: orange advisory shown, button stays enabled
// - discontinued: dark badge shown, button disabled + relabeled
function applyStatusState(status) {
  const badge = document.getElementById("status-badge");
  const advisory = document.getElementById("sold-out-advisory");
  const button = document.getElementById("add-to-cart");
  const label = document.getElementById("add-to-cart-label");

  badge.hidden = status !== "discontinued";
  advisory.hidden = status !== "sold_out_today";

  if (status === "discontinued") {
    button.disabled = true;
    label.textContent = "Ngừng kinh doanh";
  } else {
    button.disabled = false;
    label.textContent = "Thêm vào giỏ";
  }
}

// Advisory-only, same fail-silent pattern as fetchRelatedProducts below —
// a secondary notice, not core functionality. Shows only the SOONEST
// upcoming override, as a single line, not a list.
async function checkUpcomingCutoffs() {
  try {
    const res = await fetch("/api/orders/upcoming-cutoffs");
    if (!res.ok) return;
    const overrides = await res.json();
    if (overrides.length === 0) return;

    const next = overrides[0];
    const vn = new Date(new Date(next.deadline).getTime() + 7 * 60 * 60 * 1000);
    const time = vn.toISOString().slice(11, 16);
    const deadlineDate = vn.toISOString().slice(0, 10).split("-").reverse().join("/");
    const overrideDate = next.override_date.split("-").reverse().join("/");
    const label = next.note ? `${overrideDate} (${next.note})` : overrideDate;

    const el = document.getElementById("holiday-advisory");
    el.textContent = `Lưu ý: đơn giao ngày ${label} chỉ được nhận đến ${time} ngày ${deadlineDate}.`;
    el.hidden = false;
  } catch (err) {
    console.error("Bloomy: failed to load upcoming cutoffs", err);
  }
}

function renderNotFound() {
  document.getElementById("not-found").hidden = false;
  document.body.classList.add("is-ready");
  document.getElementById("breadcrumb-name").textContent = "";
}

async function fetchProduct(id) {
  try {
    const res = await fetch(`/api/products/${id}`);
    if (!res.ok) {
      renderNotFound();
      return;
    }
    const product = await res.json();
    renderProduct(product);
    // Optional call: if main.js is an older cached copy without track(), this
    // must stay a no-op — anything thrown in this try block lands in the
    // catch below and shows "not found" over a product that did load.
    window.Bloomy.track?.("product_view");
    try {
      // The strip shows what was seen BEFORE this one; then this one is remembered.
      renderRecentlyViewed(product.id);
      window.Bloomy.recent?.add({ id: product.id, name: product.name, image: product.image });
    } catch (err) {
      console.error("Bloomy: recently viewed failed", err);
    }
    fetchRelatedProducts(product);
  } catch (err) {
    console.error("Bloomy: failed to load product", err);
    renderNotFound();
  }
}

async function fetchRelatedProducts(product) {
  try {
    const res = await fetch(`/api/products?category=${product.category_id}`);
    const products = await res.json();

    // Exclude the current product, cap at 4. No hardcoded-4 fallback needed
    // — every category has more than 4 products (confirmed in chat).
    const related = products.filter((p) => p.id !== product.id).slice(0, 4);

    if (related.length === 0) return;

    const grid = document.getElementById("related-grid");
    grid.innerHTML = related
      .map(
        (p) => `
      <a href="product.html?id=${p.id}" class="product-card">
        <img class="product-card__image" src="${p.image}" alt="${window.Bloomy.escapeHtml(p.name)}" loading="lazy">
        <div class="product-card__name">${window.Bloomy.escapeHtml(p.name)}</div>
        <div class="product-card__price">${window.Bloomy.formatCardPrice(p)}</div>
      </a>
    `
      )
      .join("");

    document.getElementById("related-products").hidden = false;
  } catch (err) {
    // Related products are a nice-to-have, not core functionality —
    // fail silently rather than showing an error for a secondary section.
    console.error("Bloomy: failed to load related products", err);
  } finally {
    document.body.classList.add("is-ready");
  }
}

function updateQtyDisplay() {
  document.getElementById("qty-value").textContent = quantity;
}

function initQtyStepper() {
  document.getElementById("qty-minus").addEventListener("click", () => {
    if (quantity > 1) {
      quantity -= 1;
      updateQtyDisplay();
    }
  });

  document.getElementById("qty-plus").addEventListener("click", () => {
    if (quantity < 99) {
      quantity += 1;
      updateQtyDisplay();
    }
  });
}

let addToCartTimeout = null;

function initAddToCart() {
  const button = document.getElementById("add-to-cart");
  const label = document.getElementById("add-to-cart-label");

  button.addEventListener("click", () => {
    if (!currentProduct || currentProduct.status === "discontinued" || currentProduct.product_type === "external") return;

    window.Bloomy.cart.addItem(
      { id: currentProduct.id, name: currentProduct.name, image: currentProduct.image },
      selectedSize.size,
      quantity
    );
    window.Bloomy.track?.("add_to_cart");

    // Brief inline confirmation — the only feedback that clicking Add did
    // anything, otherwise the nav cart badge (small, top-right corner) is
    // the sole signal. Re-clicking during the window just re-triggers it.
    // The toast says what happened and offers the next step, wherever the visitor is on the page.
    window.Bloomy.toast?.(`Đã thêm “${currentProduct.name}” vào giỏ`, [
      { label: "Xem giỏ hàng", href: "cart.html" },
      { label: "Thanh toán", href: "checkout.html" },
    ]);

    clearTimeout(addToCartTimeout);
    button.classList.remove("is-added");
    void button.offsetWidth; // restart the pop if it is still running
    button.classList.add("is-added");
    button.addEventListener("animationend", () => button.classList.remove("is-added"), { once: true });
    label.textContent = "Đã thêm ✓";
    addToCartTimeout = setTimeout(() => {
      label.textContent = "Thêm vào giỏ";
    }, 1500);
  });
}

// ---------------------------------------------------------------------------
// Recently viewed: the products seen before this one, in this browser only.
// Built with DOM calls and textContent: the list comes from localStorage.
// ---------------------------------------------------------------------------
function renderRecentlyViewed(currentId) {
  const section = document.getElementById("recent-viewed");
  const list = document.getElementById("recent-list");
  if (!section || !list) return;
  const items = (window.Bloomy.recent?.get() || []).filter((i) => i.id !== currentId);
  list.replaceChildren();
  items.forEach((i) => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.className = "recent-viewed__link";
    a.href = `product.html?id=${i.id}`;
    const img = document.createElement("img");
    img.className = "recent-viewed__image";
    img.src = i.image;
    img.alt = "";
    img.loading = "lazy";
    const name = document.createElement("span");
    name.className = "recent-viewed__name";
    name.textContent = i.name;
    a.append(img, name);
    li.appendChild(a);
    list.appendChild(li);
  });
  section.hidden = items.length === 0;
}

// ---------------------------------------------------------------------------
// Share. Where the browser has a share sheet (phones: Zalo, Messenger... are in it) it is used;
// otherwise a small menu: copy the link, or Facebook. The address shared is the page's canonical
// one (no utm tags). Zalo has no plain share link (only its own script, which this site does not load).
// ---------------------------------------------------------------------------
function shareAddress() {
  return document.querySelector('link[rel="canonical"]')?.href || window.location.href.split("#")[0];
}

function initShare() {
  const button = document.getElementById("share-button");
  const menu = document.getElementById("share-menu");
  if (!button || !menu) return;
  const facebook = document.getElementById("share-facebook");
  const reportShare = (method) => window.gtag?.("event", "share", { method, content_type: "product", item_id: String(currentProduct ? currentProduct.id : "") });

  const setOpen = (open) => {
    if (open) facebook.href = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareAddress())}`;
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  };

  button.addEventListener("click", async () => {
    if (!currentProduct) return;
    if (navigator.share) {
      try {
        await navigator.share({ title: document.title, text: currentProduct.name, url: shareAddress() });
        reportShare("native");
        return;
      } catch (err) {
        if (err && err.name === "AbortError") return; // the person closed the sheet
        // anything else: fall back to the menu below
      }
    }
    setOpen(menu.hidden);
  });

  document.getElementById("share-copy").addEventListener("click", async () => {
    const ok = await window.Bloomy.copyText(shareAddress());
    setOpen(false);
    window.Bloomy.toast?.(ok ? "Đã sao chép liên kết sản phẩm" : "Không sao chép được. Hãy chép liên kết từ thanh địa chỉ.");
    if (ok) reportShare("copy_link");
  });
  facebook.addEventListener("click", () => {
    facebook.href = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareAddress())}`;
    reportShare("facebook");
    setOpen(false);
  });
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !button.contains(e.target)) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) {
      setOpen(false);
      button.focus();
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const id = getProductId();

  if (isNaN(id)) {
    renderNotFound();
    return;
  }

  initQtyStepper();
  initAddToCart();
  initShare();
  fetchProduct(id);
  checkUpcomingCutoffs();
});
