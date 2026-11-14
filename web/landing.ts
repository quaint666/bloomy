// Bloomy — Landing page: the campaign's product cards (size + add to cart) and
// the small bits of glue around the shared checkout (checkout.js does the form).
//
// All three scripts of this page (main.js, this file, checkout.js) are `defer`, so each
// runs its top-level code before DOMContentLoaded, which is when checkout.js starts. The
// coupon below is set at the top level of this file, so it is in the cart's coupon slot
// before the first price is asked for. (Tried: even with the scripts swapped and the
// coupon set later, at DOMContentLoaded, the first price still carried it, because
// checkout.js awaits a deadline lookup before its first quote. That is margin, not a
// promise: keep the coupon at the top level.)

import type { ActiveCampaign, CampaignCard, ProductSize, SizePrice } from "../shared/api-types";
import { byId } from "./lib/dom";
import { isProductSize } from "./lib/labels";

const Bloomy = window.Bloomy;
const esc = Bloomy.escapeHtml;

// A card of the campaign, with its sizes (the server always sends them).
type LandingProduct = CampaignCard & { sizes: SizePrice[] };

// 1. The campaign's coupon goes into the cart's coupon slot (same as typing it on the
//    cart page), right now, at the top level — see above. The server put the code in data-coupon only when the coupon is still
//    on offer; whether it applies to a given delivery date is checked by the quote, and
//    the summary says so when it does not.
const code = byId("landing-main").dataset.coupon;
if (code) Bloomy.setCoupon(code);

// 2. When the ZaloPay QR view opens, only the QR should be on the page.
document.addEventListener("bloomy:payment-waiting", () => {
  document.body.classList.add("is-paying");
  window.scrollTo(0, 0);
});

// 3. The cards.
let products: LandingProduct[] = [];

// The size of a card's line that is asked for by name; throws when the card has no such size (it always does).
function sizeEntry(p: LandingProduct, size: ProductSize): SizePrice {
  const entry = p.sizes.find((s) => s.size === size);
  if (!entry) throw new Error(`Product ${p.id} has no size ${size}`);
  return entry;
}

function defaultSize(p: LandingProduct): ProductSize {
  const chosen = p.sizes.find((s) => s.size === "m") || p.sizes[0]; // same default as the product page
  if (!chosen) throw new Error(`Product ${p.id} has no sizes`);
  return chosen.size;
}

function cardHtml(p: LandingProduct): string {
  const size = defaultSize(p);
  const price = sizeEntry(p, size).price;
  const chips = p.has_sizes
    ? `<div class="landing-sizes" role="radiogroup" aria-label="Kích cỡ: ${esc(p.name)}">${p.sizes
        .map(
          (s) => `<label class="landing-size"><input type="radio" class="visually-hidden" name="size-${p.id}" value="${s.size}"${s.size === size ? " checked" : ""}><span>${esc(Bloomy.SIZE_LABELS[s.size] || s.size)}</span></label>`
        )
        .join("")}</div>`
    : "";
  const note = p.status === "sold_out_today"
    ? `<p class="landing-card__note">Hôm nay đã hết loại hoa này. Bạn vẫn đặt được cho ngày giao sau.</p>`
    : "";
  return `
      <article class="landing-card" data-id="${p.id}">
        <a href="product.html?id=${p.id}" class="landing-card__media" tabindex="-1" aria-hidden="true"><img class="landing-card__image" src="${esc(p.image)}" alt="" loading="lazy"></a>
        <h3 class="landing-card__name"><a href="product.html?id=${p.id}">${esc(p.name)}</a></h3>
        <p class="landing-card__price">${Bloomy.formatVND(price)}</p>
        ${chips}
        ${note}
        <button type="button" class="btn btn-primary landing-card__add">Thêm vào giỏ</button>
        <p class="landing-card__added" role="status" hidden></p>
      </article>`;
}

function render(): void {
  byId("landing-grid").innerHTML = products.map(cardHtml).join("");
}

function selectedSize(card: HTMLElement, p: LandingProduct): ProductSize {
  const chosen = card.querySelector<HTMLInputElement>('input[type="radio"]:checked');
  if (chosen && isProductSize(chosen.value)) return chosen.value;
  return firstSize(p);
}

function firstSize(p: LandingProduct): ProductSize {
  const first = p.sizes[0];
  if (!first) throw new Error(`Product ${p.id} has no sizes`);
  return first.size;
}

const grid = byId("landing-grid");

// Changing the size changes the price shown on that card.
grid.addEventListener("change", (e) => {
  if (!(e.target instanceof Element)) return;
  const input = e.target.closest<HTMLInputElement>('input[type="radio"]');
  if (!input) return;
  const card = input.closest<HTMLElement>(".landing-card");
  if (!card) return;
  const p = products.find((x) => x.id === Number(card.dataset.id));
  const s = p && p.sizes.find((x) => x.size === input.value);
  const priceEl = card.querySelector(".landing-card__price");
  if (!s || !priceEl) return;
  priceEl.textContent = Bloomy.formatVND(s.price);
});

// Adding puts the line in the cart; checkout.js hears bloomy:cart-changed and shows the form below.
grid.addEventListener("click", (e) => {
  if (!(e.target instanceof Element)) return;
  const btn = e.target.closest<HTMLButtonElement>(".landing-card__add");
  if (!btn) return;
  const card = btn.closest<HTMLElement>(".landing-card");
  if (!card) return;
  const p = products.find((x) => x.id === Number(card.dataset.id));
  const msg = card.querySelector<HTMLElement>(".landing-card__added");
  if (!p || !msg) return;
  const size = selectedSize(card, p);
  Bloomy.cart.addItem({ id: p.id, name: p.name, image: p.image }, size, 1);
  btn.classList.remove("is-added");
  void btn.offsetWidth; // restart the pop if it is still running
  btn.classList.add("is-added");
  btn.addEventListener("animationend", () => btn.classList.remove("is-added"), { once: true });
  const line = Bloomy.cart.getCart().find((i) => !i.custom && i.productId === p.id && i.size === size);
  msg.textContent = `Đã thêm vào đơn (${line ? line.quantity : 1}). `;
  const link = document.createElement("a");
  link.href = "#landing-order";
  link.textContent = "Xem đơn bên dưới";
  msg.appendChild(link);
  msg.hidden = false;
  Bloomy.track?.("add_to_cart");
});

async function load(): Promise<void> {
  try {
    const res = await fetch("/api/campaigns/active");
    if (!res.ok) throw new Error(`campaign: ${res.status}`);
    const campaign: ActiveCampaign = await res.json();
    products = (campaign.products ?? []).map((p) => ({ ...p, sizes: p.sizes ?? [] }));
    render();
    // Every product of the campaign may have been discontinued since it was set up.
    byId("landing-empty").hidden = products.length > 0;
  } catch (err) {
    console.error("Bloomy: failed to load the campaign's products", err);
    byId("landing-grid").replaceChildren(); // the grey placeholders must not stay
    byId("landing-error").hidden = false;
  }
}

document.addEventListener("DOMContentLoaded", load);
