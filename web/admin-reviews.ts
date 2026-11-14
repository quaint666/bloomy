// Bloomy — Review approval ("Đánh giá"), manager and up.
// Waiting reviews first. "Duyệt" makes a review public, "Ẩn" takes it back to
// waiting, "Xóa" removes it. Review text is customer-typed, so everything here is
// put in with textContent.

import type { AdminReviewsResponse } from "../shared/api-types";
import { adminApi } from "./lib/api";
import { byId, el } from "./lib/dom";

type Review = AdminReviewsResponse["reviews"][number];

const stars = (n: number): string => "★".repeat(n) + "☆".repeat(5 - n);
const when = (iso: string): string => new Date(iso).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "short", timeStyle: "short" });

let reviews: Review[] = [];

function render(): void {
  const body = byId("admin-reviews-body");
  body.innerHTML = "";
  byId("admin-reviews-empty").hidden = reviews.length > 0;
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
    toggle.dataset.id = String(r.id);
    const del = el("button", "btn btn-outline admin-table__action-btn", "Xóa");
    del.type = "button";
    del.dataset.action = "delete";
    del.dataset.id = String(r.id);
    wrap.append(toggle, del);
    actions.appendChild(wrap);
    row.appendChild(actions);
    body.appendChild(row);
  });
}

async function load(): Promise<void> {
  const errorEl = byId("admin-reviews-error");
  try {
    const filter = byId("admin-reviews-filter", HTMLSelectElement).value;
    const result = await adminApi<AdminReviewsResponse>("GET", `/api/admin/reviews${filter === "all" ? "" : `?status=${filter}`}`);
    if (!result.ok) throw new Error(`reviews: ${result.res.status}`);
    const { data } = result;
    reviews = data.reviews;
    byId("admin-reviews-counts").textContent = `Chờ duyệt: ${data.counts.pending} · Đã duyệt: ${data.counts.approved}`;
    render();
    errorEl.hidden = true;
  } catch (err) {
    errorEl.textContent = "Không thể tải danh sách đánh giá.";
    errorEl.hidden = false;
  }
}

byId("admin-reviews-filter", HTMLSelectElement).addEventListener("change", load);

byId("admin-reviews-body").addEventListener("click", async (e) => {
  if (!(e.target instanceof Element)) return;
  const btn = e.target.closest<HTMLButtonElement>("[data-action]");
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
