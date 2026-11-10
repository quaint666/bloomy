// Bloomy — Homepage logic.
// Fills the "Sản phẩm nổi bật" grid from GET /api/products?featured=1:
// whichever products are ticked "Nổi bật" in admin, never discontinued
// ones (the API already leaves those out). Admin caps how many can be
// featured, so no limit is sent from here. Same card markup as
// the listing page. If the request fails the section is hidden rather than
// shown empty.
// Also fills "Khách hàng nói gì" with the 3 newest APPROVED reviews across products
// (GET /api/reviews/latest), each linking to its product's reviews. With no
// approved reviews the section stays hidden. Review text is put in with textContent.

async function loadFeatured() {
  const grid = document.querySelector("[data-featured-grid]");
  if (!grid) return;
  try {
    const res = await fetch("/api/products?featured=1");
    if (!res.ok) throw new Error(`featured: ${res.status}`);
    const products = await res.json();
    if (products.length === 0) {
      document.getElementById("featured").hidden = true;
      return;
    }
    grid.innerHTML = products
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
  } catch (err) {
    console.error("Bloomy: failed to load featured products", err);
    document.getElementById("featured").hidden = true;
  }
}

// First letters of the first and last word ("Nguyễn Minh Anh" -> "NA"); a one-word
// name gives its first two letters. Anything that isn't a letter is skipped.
function initialsOf(name) {
  const letters = name
    .split(/\s+/)
    .map((w) => (w.match(/\p{L}/u) || [""])[0])
    .filter(Boolean);
  if (letters.length === 0) return "?";
  const pair = letters.length > 1 ? letters[0] + letters[letters.length - 1] : (name.match(/\p{L}/gu) || []).slice(0, 2).join("");
  return pair.toLocaleUpperCase("vi");
}

function testimonialCard(r) {
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const card = el("div", "testimonial-card");
  card.append(el("div", "testimonial-card__stars", "★".repeat(r.stars) + "☆".repeat(5 - r.stars)), el("p", "testimonial-card__quote", `"${r.comment}"`));
  const author = el("div", "testimonial-card__author");
  const who = document.createElement("div");
  const role = el("div", "testimonial-card__role", "Đánh giá ");
  const link = document.createElement("a");
  link.href = `product.html?id=${r.product_id}#reviews`;
  link.textContent = r.product_name;
  role.appendChild(link);
  who.append(el("div", "testimonial-card__name", r.name), role);
  author.append(el("div", "testimonial-card__avatar", initialsOf(r.name)), who);
  card.appendChild(author);
  return card;
}

async function loadTestimonials() {
  const section = document.getElementById("testimonials");
  if (!section) return;
  try {
    const res = await fetch("/api/reviews/latest?limit=3");
    if (!res.ok) throw new Error(`reviews: ${res.status}`);
    const reviews = await res.json();
    if (reviews.length === 0) return; // stays hidden
    const grid = document.getElementById("testimonials-grid");
    grid.innerHTML = "";
    reviews.forEach((r) => grid.appendChild(testimonialCard(r)));
    section.hidden = false;
  } catch (err) {
    console.error("Bloomy: failed to load reviews", err);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadFeatured();
  loadTestimonials();
});
