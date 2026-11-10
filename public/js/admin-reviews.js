// Bloomy — Review approval ("Đánh giá"), manager and up.
// Waiting reviews first. "Duyệt" makes a review public, "Ẩn" takes it back to
// waiting, "Xóa" removes it. Review text is customer-typed, so everything here is
// put in with textContent.

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

const stars = (n) => "★".repeat(n) + "☆".repeat(5 - n);
const when = (iso) => new Date(iso).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "short", timeStyle: "short" });

async function api(method, url) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" } });
  if (res.status === 401) {
    window.location.href = "admin-login.html";
    return { res, data: null };
  }
  return { res, data: await res.json().catch(() => null) };
}

let reviews = [];

function render() {
  const body = $("admin-reviews-body");
  body.innerHTML = "";
  $("admin-reviews-empty").hidden = reviews.length > 0;
  reviews.forEach((r) => {
    const row = el("tr");
    const product = el("td");
    const link = el("a", null, r.product_name);
    link.href = `product.html?id=${r.product_id}#reviews`;
    link.target = "_blank";
    link.rel = "noopener";
    product.appendChild(link);
    row.append(product, el("td", null, r.name), el("td", null, stars(r.stars)), el("td", "admin-reviews__comment", r.comment), el("td", null, when(r.created_at)), el("td", null, r.approved ? "Đã duyệt" : "Chờ duyệt"));
    const actions = el("td");
    const wrap = el("div", "admin-users__actions");
    const toggle = el("button", "btn btn-outline admin-table__action-btn", r.approved ? "Ẩn" : "Duyệt");
    toggle.type = "button";
    toggle.dataset.action = "toggle";
    toggle.dataset.id = r.id;
    const del = el("button", "btn btn-outline admin-table__action-btn", "Xóa");
    del.type = "button";
    del.dataset.action = "delete";
    del.dataset.id = r.id;
    wrap.append(toggle, del);
    actions.appendChild(wrap);
    row.appendChild(actions);
    body.appendChild(row);
  });
}

async function load() {
  const errorEl = $("admin-reviews-error");
  try {
    const filter = $("admin-reviews-filter").value;
    const { res, data } = await api("GET", `/api/admin/reviews${filter === "all" ? "" : `?status=${filter}`}`);
    if (!res.ok) throw new Error(`reviews: ${res.status}`);
    reviews = data.reviews;
    $("admin-reviews-counts").textContent = `Chờ duyệt: ${data.counts.pending} · Đã duyệt: ${data.counts.approved}`;
    render();
    errorEl.hidden = true;
  } catch (err) {
    errorEl.textContent = "Không thể tải danh sách đánh giá.";
    errorEl.hidden = false;
  }
}

$("admin-reviews-filter").addEventListener("change", load);

$("admin-reviews-body").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const review = reviews.find((r) => r.id === Number(btn.dataset.id));
  if (!review) return;
  btn.disabled = true;
  if (btn.dataset.action === "delete") {
    if (confirm("Xóa đánh giá này? Không thể hoàn tác.")) await fetch(`/api/admin/reviews/${review.id}`, { method: "DELETE" });
  } else {
    await fetch(`/api/admin/reviews/${review.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: !review.approved }),
    });
  }
  load(); // always redraw from the real state
});

load();
