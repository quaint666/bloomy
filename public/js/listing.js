// Bloomy — Product Listing page logic.
// The category pills (with the seasonal sub-pills) and the tag chips are built from
// GET /api/categories and GET /api/tags, so a new category or tag needs no edit here.
// State (category, tags, search, sort) is read from the URL on load — so the
// homepage's category cards, the nav search box, a product's tag links and a copied
// link all land on the right filtered page — and written back as the person clicks.
//
// Tags: one chip toggles one tag. Within a group (e.g. two flowers) a product needs
// ONE of them; across groups (a flower and a colour) it needs one of EACH. The
// server does that (see routes/products.js); this page just sends ?tag=3&tag=8.
//
// URL param names vs API param names — deliberately different: the page's own URL
// uses "q" for search (matching the nav search box's form, name="q") while the fetch
// to /api/products uses "search", the API's name — translated in buildApiUrl().

let state = {
  category: "all",
  tags: [], // tag ids
  search: "",
  sort: "default",
};
let categoryTree = [];
let tagGroups = [];

const byId = (id) => document.getElementById(id);

function readStateFromUrl() {
  const params = new URLSearchParams(window.location.search);
  state.category = params.get("category") || "all";
  state.tags = params
    .getAll("tag")
    .flatMap((v) => v.split(","))
    .map((v) => parseInt(v, 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  state.search = params.get("q") || "";
  state.sort = params.get("sort") || "default";
}

function syncStateToUrl() {
  const params = new URLSearchParams();
  if (state.category !== "all") params.set("category", state.category);
  state.tags.forEach((id) => params.append("tag", id));
  if (state.search) params.set("q", state.search);
  if (state.sort !== "default") params.set("sort", state.sort);

  const query = params.toString();
  history.replaceState(null, "", window.location.pathname + (query ? `?${query}` : ""));
}

function buildApiUrl() {
  const params = new URLSearchParams();
  if (state.category !== "all") params.set("category", state.category);
  state.tags.forEach((id) => params.append("tag", id));
  if (state.search) params.set("search", state.search); // translated from "q"
  if (state.sort !== "default") params.set("sort", state.sort);

  const query = params.toString();
  return "/api/products" + (query ? `?${query}` : "");
}

const hasFilters = () => state.category !== "all" || state.tags.length > 0 || state.search !== "";

function renderProducts(products) {
  const grid = byId("product-grid");
  const emptyMsg = byId("listing-empty");
  byId("result-count").textContent = products.length;

  if (products.length === 0) {
    grid.innerHTML = "";
    emptyMsg.textContent = "Không tìm thấy sản phẩm phù hợp.";
    emptyMsg.hidden = false;
    return;
  }

  const esc = window.Bloomy.escapeHtml;
  emptyMsg.hidden = true;
  grid.innerHTML = products
    .map(
      (p, i) => `
    <a href="product.html?id=${p.id}" class="product-card">
      <img class="product-card__image" src="${p.image}" alt="${esc(p.name)}"${i >= 8 ? ' loading="lazy"' : ""}>
      <div class="product-card__name">${esc(p.name)}</div>
      <div class="product-card__price">${window.Bloomy.formatCardPrice(p)}</div>
    </a>
  `
    )
    .join("");
}

async function fetchAndRender() {
  try {
    const res = await fetch(buildApiUrl());
    renderProducts(await res.json());
  } catch (err) {
    console.error("Bloomy: failed to load products", err);
    // Clear the grey placeholders and say so, instead of leaving them shimmering for ever.
    byId("product-grid").innerHTML = "";
    byId("listing-empty").textContent = "Không thể tải sản phẩm lúc này. Vui lòng tải lại trang.";
    byId("listing-empty").hidden = false;
  } finally {
    document.body.classList.add("is-ready");
  }
}

// ---- category pills (top row, plus a second row for a parent that has children)
function pillButton(label, category) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "pill";
  b.dataset.category = String(category);
  b.textContent = label;
  return b;
}

// The top-level category the current selection belongs to (a child counts as its parent).
function activeParent() {
  const id = Number(state.category);
  return categoryTree.find((c) => c.id === id || c.children.some((ch) => ch.id === id));
}

function renderSubPills() {
  const box = byId("sub-pills");
  box.innerHTML = "";
  const parent = activeParent();
  if (!parent || parent.children.length === 0) {
    box.hidden = true;
    return;
  }
  box.appendChild(pillButton(`Tất cả ${parent.name.toLowerCase()}`, parent.id));
  parent.children.forEach((ch) => box.appendChild(pillButton(ch.name, ch.id)));
  box.hidden = false;
}

function renderCategoryPills() {
  const box = byId("category-pills");
  box.innerHTML = "";
  box.appendChild(pillButton("Tất cả", "all"));
  categoryTree.forEach((c) => box.appendChild(pillButton(c.name, c.id)));
  renderSubPills();
}

function renderTagFilters() {
  const box = byId("tag-filters");
  box.innerHTML = "";
  tagGroups.forEach((g) => {
    const row = document.createElement("div");
    row.className = "tag-group";
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", g.label);
    const label = document.createElement("span");
    label.className = "tag-group__label";
    label.textContent = g.label;
    row.appendChild(label);
    // Chips sit in their own wrapper so wrapped lines line up under the first chip, not under the label.
    const chips = document.createElement("div");
    chips.className = "tag-group__chips";
    g.tags.forEach((t) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tag-chip";
      b.dataset.tag = String(t.id);
      b.textContent = t.name;
      chips.appendChild(b);
    });
    row.appendChild(chips);
    box.appendChild(row);
  });
  // No tags (or the API failed) means nothing to open, so the toggle stays hidden.
  byId("filter-toggle").hidden = tagGroups.length === 0;
}

// ---- the collapsible tag panel ("Bộ lọc") — closed by default, open on load if the URL already has tags
function setFilterPanel(open) {
  byId("tag-filters").hidden = !open;
  byId("filter-toggle").setAttribute("aria-expanded", String(open));
}

function applyStateToControls() {
  const parent = activeParent();
  const topActive = state.category === "all" ? "all" : String(parent ? parent.id : state.category);
  byId("category-pills").querySelectorAll(".pill").forEach((pill) => {
    const on = pill.dataset.category === topActive;
    pill.classList.toggle("is-active", on);
    pill.setAttribute("aria-pressed", String(on));
  });
  byId("sub-pills").querySelectorAll(".pill").forEach((pill) => {
    const on = pill.dataset.category === String(state.category);
    pill.classList.toggle("is-active", on);
    pill.setAttribute("aria-pressed", String(on));
  });
  byId("tag-filters").querySelectorAll(".tag-chip").forEach((chip) => {
    chip.setAttribute("aria-pressed", String(state.tags.includes(Number(chip.dataset.tag))));
  });
  // The count on the toggle keeps selected tags visible while the panel is collapsed.
  const count = byId("filter-count");
  count.textContent = String(state.tags.length);
  count.hidden = state.tags.length === 0;
  byId("filter-toggle").setAttribute(
    "aria-label",
    state.tags.length ? `Bộ lọc, đã chọn ${state.tags.length}` : "Bộ lọc"
  );
  byId("listing-search-input").value = state.search;
  byId("sort-select").value = state.sort;
  byId("clear-filters").hidden = !hasFilters();
}

function onFilterChange() {
  renderSubPills();
  applyStateToControls();
  syncStateToUrl();
  fetchAndRender();
}

function initFilterClicks() {
  const onPill = (e) => {
    const pill = e.target.closest(".pill");
    if (!pill) return;
    state.category = pill.dataset.category;
    onFilterChange();
  };
  byId("category-pills").addEventListener("click", onPill);
  byId("sub-pills").addEventListener("click", onPill);

  byId("tag-filters").addEventListener("click", (e) => {
    const chip = e.target.closest(".tag-chip");
    if (!chip) return;
    const id = Number(chip.dataset.tag);
    state.tags = state.tags.includes(id) ? state.tags.filter((t) => t !== id) : [...state.tags, id];
    onFilterChange();
  });

  byId("filter-toggle").addEventListener("click", () => {
    setFilterPanel(byId("tag-filters").hidden);
  });

  byId("clear-filters").addEventListener("click", () => {
    state.category = "all";
    state.tags = [];
    state.search = "";
    onFilterChange();
  });
}

async function loadFilters() {
  try {
    const [cats, tags] = await Promise.all([fetch("/api/categories"), fetch("/api/tags")]);
    if (cats.ok) categoryTree = await cats.json();
    if (tags.ok) tagGroups = (await tags.json()).groups;
  } catch (err) {
    // Products still list without the filters; only the pills and chips are missing.
    console.error("Bloomy: failed to load the filters", err);
  }
  renderCategoryPills();
  renderTagFilters();
  applyStateToControls();
}

const SEARCH_DEBOUNCE_MS = 1000;

function runSearch(input) {
  state.search = input.value.trim();
  applyStateToControls();
  syncStateToUrl();
  fetchAndRender();
}

function initSearch() {
  const input = byId("listing-search-input");
  let debounceTimer = null;

  // Auto-searches ~1s after typing stops — no need to press Enter.
  // Debounced (not fired on every keystroke) so typing "hoa ly" doesn't
  // fire 6 separate fetches, only one, after the person actually pauses.
  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runSearch(input), SEARCH_DEBOUNCE_MS);
  });

  // Enter still fires immediately, canceling any pending debounce —
  // for anyone who doesn't want to wait out the 1s delay.
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    clearTimeout(debounceTimer);
    runSearch(input);
  });
}

function initSort() {
  const select = byId("sort-select");
  select.addEventListener("change", () => {
    state.sort = select.value;
    syncStateToUrl();
    fetchAndRender();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  readStateFromUrl();
  setFilterPanel(state.tags.length > 0);
  applyStateToControls();
  initFilterClicks();
  initSearch();
  initSort();
  loadFilters();
  fetchAndRender();
});
