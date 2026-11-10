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
(function () {
  const Bloomy = window.Bloomy;
  const esc = Bloomy.escapeHtml;

  // 1. The campaign's coupon goes into the cart's coupon slot (same as typing it on the
  //    cart page), right now, at the top level — see above. The server put the code in data-coupon only when the coupon is still
  //    on offer; whether it applies to a given delivery date is checked by the quote, and
  //    the summary says so when it does not.
  const code = document.getElementById("landing-main").dataset.coupon;
  if (code) Bloomy.setCoupon(code);

  // 2. When the ZaloPay QR view opens, only the QR should be on the page.
  document.addEventListener("bloomy:payment-waiting", () => {
    document.body.classList.add("is-paying");
    window.scrollTo(0, 0);
  });

  // 3. The cards.
  let products = [];

  function defaultSize(p) {
    return (p.sizes.find((s) => s.size === "m") || p.sizes[0]).size; // same default as the product page
  }

  function cardHtml(p) {
    const size = defaultSize(p);
    const price = p.sizes.find((s) => s.size === size).price;
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

  function render() {
    document.getElementById("landing-grid").innerHTML = products.map(cardHtml).join("");
  }

  function selectedSize(card, p) {
    const chosen = card.querySelector('input[type="radio"]:checked');
    return chosen ? chosen.value : p.sizes[0].size;
  }

  const grid = document.getElementById("landing-grid");

  // Changing the size changes the price shown on that card.
  grid.addEventListener("change", (e) => {
    const input = e.target.closest('input[type="radio"]');
    if (!input) return;
    const card = input.closest(".landing-card");
    const p = products.find((x) => x.id === Number(card.dataset.id));
    const s = p.sizes.find((x) => x.size === input.value);
    card.querySelector(".landing-card__price").textContent = Bloomy.formatVND(s.price);
  });

  // Adding puts the line in the cart; checkout.js hears bloomy:cart-changed and shows the form below.
  grid.addEventListener("click", (e) => {
    const btn = e.target.closest(".landing-card__add");
    if (!btn) return;
    const card = btn.closest(".landing-card");
    const p = products.find((x) => x.id === Number(card.dataset.id));
    const size = selectedSize(card, p);
    Bloomy.cart.addItem({ id: p.id, name: p.name, image: p.image }, size, 1);
    btn.classList.remove("is-added");
    void btn.offsetWidth; // restart the pop if it is still running
    btn.classList.add("is-added");
    btn.addEventListener("animationend", () => btn.classList.remove("is-added"), { once: true });
    const line = Bloomy.cart.getCart().find((i) => !i.custom && i.productId === p.id && i.size === size);
    const msg = card.querySelector(".landing-card__added");
    msg.textContent = `Đã thêm vào đơn (${line ? line.quantity : 1}). `;
    const link = document.createElement("a");
    link.href = "#landing-order";
    link.textContent = "Xem đơn bên dưới";
    msg.appendChild(link);
    msg.hidden = false;
    Bloomy.track?.("add_to_cart");
  });

  async function load() {
    try {
      const res = await fetch("/api/campaigns/active");
      if (!res.ok) throw new Error(`campaign: ${res.status}`);
      products = (await res.json()).products;
      render();
      // Every product of the campaign may have been discontinued since it was set up.
      document.getElementById("landing-empty").hidden = products.length > 0;
    } catch (err) {
      console.error("Bloomy: failed to load the campaign's products", err);
      document.getElementById("landing-grid").replaceChildren(); // the grey placeholders must not stay
      document.getElementById("landing-error").hidden = false;
    }
  }

  document.addEventListener("DOMContentLoaded", load);
})();
