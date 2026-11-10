// Bloomy — Admin product list: SKU, price range over the sizes, a flag for
// products whose flowers aren't listed yet, status, and the "featured"
// (homepage) checkbox.

const STATUS_LABELS = {
  available: "Còn hàng",
  sold_out_today: "Hết hàng hôm nay",
  discontinued: "Ngừng kinh doanh",
};

function formatVND(price) {
  return price.toLocaleString("vi-VN") + "đ";
}

function buildStatusSelect(product) {
  const select = document.createElement("select");
  select.className = "admin-table__status-select";
  select.dataset.productId = product.id;

  Object.entries(STATUS_LABELS).forEach(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    if (value === product.status) option.selected = true;
    select.appendChild(option);
  });

  return select;
}

// Kept in memory once fetched — the search box filters this array
// client-side rather than re-querying the server. Simple choice, made
// deliberately: the admin's full catalog is ~50 rows, small enough that
// a server round-trip per keystroke buys nothing a local filter doesn't
// already give for free. (The customer-facing Listing page's debounced
// server search exists for a different reason — it also handles category
// and sort together, and paginates a possibly-larger public catalog.)
let allProducts = [];
let featuredLimit = 0; // sent by the server with the list

// Counted over the WHOLE catalog, not just the rows the search box shows.
function featuredCount() {
  return allProducts.filter((p) => p.featured).length;
}

// Redraws the table for the current search text (and the featured count).
function refreshTable() {
  const term = document.getElementById("admin-products-search").value.trim().toLowerCase();
  renderTable(
    term
      ? allProducts.filter((p) => p.name.toLowerCase().includes(term) || p.sku.toLowerCase().includes(term))
      : allProducts
  );
}

function renderTable(products) {
  const body = document.getElementById("admin-products-body");
  body.innerHTML = "";

  products.forEach((product) => {
    const row = document.createElement("tr");

    const idCell = document.createElement("td");
    idCell.textContent = product.id;

    const skuCell = document.createElement("td");
    skuCell.textContent = product.sku;

    // Name, plus a warning for a flower product with no recipe — its orders
    // would take no flowers from stock. External products never have one.
    const nameCell = document.createElement("td");
    nameCell.textContent = product.name;
    if (product.product_type === "external") {
      const tag = document.createElement("span");
      tag.className = "admin-table__tag";
      tag.textContent = "Bán ở trang khác";
      nameCell.appendChild(tag);
    } else if (!product.has_recipe) {
      const warn = document.createElement("span");
      warn.className = "admin-table__warning";
      warn.textContent = "Chưa có công thức";
      nameCell.appendChild(warn);
    }

    const categoryCell = document.createElement("td");
    categoryCell.textContent = product.category_name;

    const priceCell = document.createElement("td");
    priceCell.textContent =
      product.min_price === product.max_price
        ? formatVND(product.min_price)
        : `${formatVND(product.min_price)} – ${formatVND(product.max_price)}`;

    const sizeCell = document.createElement("td");
    sizeCell.textContent = product.size_count > 1 ? `${product.size_count} size` : "1 size";

    const statusCell = document.createElement("td");
    statusCell.appendChild(buildStatusSelect(product));

    const featuredCell = document.createElement("td");
    const featured = document.createElement("input");
    featured.type = "checkbox";
    featured.className = "admin-table__featured";
    featured.dataset.productId = product.id;
    featured.checked = product.featured;
    // At the limit, the boxes that are still empty are greyed out; the ticked
    // ones stay usable so one can be removed to make room.
    if (!product.featured && featuredCount() >= featuredLimit) {
      featured.disabled = true;
      featured.title = `Đã đủ ${featuredLimit} sản phẩm nổi bật — bỏ chọn một sản phẩm khác trước`;
    }
    featured.setAttribute("aria-label", `Hiện ${product.name} ở trang chủ`);
    featuredCell.appendChild(featured);

    row.append(idCell, skuCell, nameCell, categoryCell, priceCell, sizeCell, statusCell, featuredCell);
    body.appendChild(row);
  });
}

async function loadProducts() {
  const errorEl = document.getElementById("admin-products-error");

  try {
    const res = await fetch("/api/admin/products");

    if (res.status === 401) {
      window.location.href = "admin-login.html";
      return;
    }

    if (!res.ok) throw new Error("Failed to load products");

    const data = await res.json();
    allProducts = data.products;
    featuredLimit = data.featured_limit;
    // A discontinued product still holds a slot (it just isn't shown on the
    // homepage) — untick it to make room for another.
    document.getElementById("admin-featured-note").textContent =
      `"Nổi bật" = hiện ở trang chủ, tối đa ${featuredLimit} sản phẩm. Sản phẩm ngừng kinh doanh vẫn chiếm chỗ nhưng không hiện — bỏ chọn để nhường chỗ.`;
    refreshTable();
  } catch (err) {
    errorEl.textContent = "Không thể tải danh sách sản phẩm.";
    errorEl.hidden = false;
  }
}

document.getElementById("admin-products-search").addEventListener("input", refreshTable);

document.getElementById("admin-products-body").addEventListener("change", async (e) => {
  // "Nổi bật" checkbox
  if (e.target.classList.contains("admin-table__featured")) {
    const box = e.target;
    try {
      const res = await fetch(`/api/admin/products/${box.dataset.productId}/featured`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featured: box.checked }),
      });
      if (res.status === 409) {
        alert(`Đã đủ ${featuredLimit} sản phẩm nổi bật. Hãy bỏ chọn một sản phẩm khác trước.`);
        loadProducts();
        return;
      }
      if (!res.ok) throw new Error("Failed to update featured");
      const product = allProducts.find((p) => p.id === Number(box.dataset.productId));
      if (product) product.featured = box.checked;
      refreshTable(); // greys out / re-enables the other boxes
    } catch (err) {
      alert("Không thể cập nhật. Vui lòng thử lại.");
      loadProducts();
    }
    return;
  }

  const select = e.target;
  if (!select.classList.contains("admin-table__status-select")) return;

  const productId = select.dataset.productId;
  const status = select.value;

  try {
    const res = await fetch(`/api/admin/products/${productId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });

    if (!res.ok) throw new Error("Failed to update status");
  } catch (err) {
    alert("Không thể cập nhật trạng thái. Vui lòng thử lại.");
    loadProducts(); // revert the dropdown to the real DB state
  }
});

loadProducts();
