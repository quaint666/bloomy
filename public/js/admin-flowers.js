// Bloomy — Admin flower stock ("Kho hoa").
// One row per flower with its stock. The number box + "Nhập thêm" adds that
// many stems, "Giảm" removes them; the server refuses to go below 0. Stock
// is changed relative to what's there (+n / −n), not overwritten, so two
// admins adjusting at once both count.

const LOW_STOCK = 20; // highlighted below this many stems

function formatVND(price) {
  return price.toLocaleString("vi-VN") + "đ";
}

let allFlowers = [];

function renderTable(flowers) {
  const body = document.getElementById("admin-flowers-body");
  body.innerHTML = "";

  flowers.forEach((flower) => {
    const row = document.createElement("tr");
    if (flower.stock < LOW_STOCK) row.className = "admin-table__row--low";

    const skuCell = document.createElement("td");
    skuCell.textContent = flower.sku;

    const nameCell = document.createElement("td");
    nameCell.textContent = flower.name;

    const priceCell = document.createElement("td");
    priceCell.textContent = formatVND(flower.price);

    const stockCell = document.createElement("td");
    stockCell.className = "admin-flowers__stock";
    stockCell.textContent = `${flower.stock} cành`;

    const adjustCell = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "admin-flowers__adjust";
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.max = "10000";
    input.step = "1";
    input.value = "10";
    input.className = "admin-form__input admin-flowers__amount";
    input.setAttribute("aria-label", `Số cành ${flower.name}`);
    const add = document.createElement("button");
    add.type = "button";
    add.className = "btn btn-outline admin-table__action-btn";
    add.textContent = "Nhập thêm";
    add.dataset.flowerId = flower.id;
    add.dataset.sign = "1";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn btn-outline admin-table__action-btn";
    remove.textContent = "Giảm";
    remove.dataset.flowerId = flower.id;
    remove.dataset.sign = "-1";
    wrap.append(input, add, remove);
    adjustCell.appendChild(wrap);

    row.append(skuCell, nameCell, priceCell, stockCell, adjustCell);
    body.appendChild(row);
  });
}

async function loadFlowers() {
  const errorEl = document.getElementById("admin-flowers-error");
  try {
    const res = await fetch("/api/admin/flowers");
    if (res.status === 401) {
      window.location.href = "admin-login.html";
      return;
    }
    if (!res.ok) throw new Error("Failed to load flowers");
    allFlowers = await res.json();
    applySearch();
  } catch (err) {
    errorEl.textContent = "Không thể tải kho hoa.";
    errorEl.hidden = false;
  }
}

function applySearch() {
  const term = document.getElementById("admin-flowers-search").value.trim().toLowerCase();
  renderTable(
    term
      ? allFlowers.filter((f) => f.name.toLowerCase().includes(term) || f.sku.toLowerCase().includes(term))
      : allFlowers
  );
}

document.getElementById("admin-flowers-search").addEventListener("input", applySearch);

document.getElementById("admin-flowers-body").addEventListener("click", async (e) => {
  const button = e.target.closest("[data-flower-id]");
  if (!button) return;
  const amount = parseInt(button.closest("td").querySelector("input").value, 10);
  if (!Number.isInteger(amount) || amount < 1 || amount > 10000) {
    alert("Nhập số cành từ 1 đến 10000.");
    return;
  }
  const delta = amount * Number(button.dataset.sign);
  button.disabled = true;
  try {
    const res = await fetch(`/api/admin/flowers/${button.dataset.flowerId}/stock`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delta }),
    });
    if (res.status === 409) {
      alert("Không thể giảm quá số cành đang có.");
    } else if (!res.ok) {
      throw new Error("Failed to update stock");
    }
  } catch (err) {
    alert("Không thể cập nhật tồn kho. Vui lòng thử lại.");
  } finally {
    loadFlowers();
  }
});

loadFlowers();
