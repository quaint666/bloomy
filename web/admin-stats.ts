// Bloomy — Admin stats view.

import type { AdminStatsBody } from "../shared/api-types";
import { byId } from "./lib/dom";
import { formatVND } from "./lib/format";
import { SIZE_LABELS } from "./lib/labels";

const SOURCE_LABELS: Record<string, string> = {
  direct: "Trực tiếp",
  facebook: "Facebook",
  zalo: "Zalo",
  instagram: "Instagram",
  tiktok: "TikTok",
  google: "Google",
  other: "Khác",
};

const NO_DATA = "Chưa có dữ liệu";

const CHANNEL_LABELS: Record<string, string> = {
  delivery: "Giao tận nơi",
  pickup: "Nhận tại shop",
  pos: "Bán tại quầy",
};

const FUNNEL_STEPS = [
  { key: "visit", label: "Lượt truy cập" },
  { key: "product_view", label: "Xem sản phẩm" },
  { key: "add_to_cart", label: "Thêm vào giỏ" },
  { key: "checkout_view", label: "Vào trang thanh toán" },
  { key: "order_placed", label: "Đặt hàng (chuyển đổi)" },
];

function formatPercent(rate: number | null): string {
  if (rate === null) return NO_DATA;
  return (rate * 100).toFixed(1) + "%";
}

function setText(id: string, text: string | number): void {
  byId(id).textContent = String(text);
}

function emptyRow(body: HTMLElement, colSpan: number, text: string): void {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = colSpan;
  cell.textContent = text;
  row.appendChild(cell);
  body.appendChild(row);
}

function appendRow(body: HTMLElement, values: (string | number)[]): void {
  const row = document.createElement("tr");
  values.forEach((value) => {
    const cell = document.createElement("td");
    cell.textContent = String(value);
    row.appendChild(cell);
  });
  body.appendChild(row);
}

// Switching the range quickly can leave an older request finishing after a
// newer one; only the latest request is allowed to draw.
let latestRequest = 0;

async function loadStats(): Promise<void> {
  const errorEl = byId("admin-stats-error");
  const range = byId("admin-stats-range", HTMLSelectElement).value;
  const requestId = ++latestRequest;

  try {
    const res = await fetch(`/api/admin/stats?range=${encodeURIComponent(range)}`);
    if (requestId !== latestRequest) return;

    if (res.status === 401) {
      window.location.href = "admin-login.html";
      return;
    }

    if (!res.ok) throw new Error("Failed to load stats");

    const stats: AdminStatsBody = await res.json();
    if (requestId !== latestRequest) return;

    errorEl.hidden = true;

    setText("stat-total-orders", stats.total_orders);
    setText("stat-status-new", stats.status_counts.new);
    setText("stat-status-delivering", stats.status_counts.delivering);
    setText("stat-status-delivered", stats.status_counts.delivered);
    setText("stat-cancelled-orders", stats.cancelled_orders);
    setText("stat-cancellation-rate", formatPercent(stats.cancellation_rate));
    setText("stat-refunded-orders", stats.refunded_orders);
    setText(
      "stat-cancelled-unrefunded",
      stats.cancelled_unrefunded_orders === 0
        ? "0"
        : `${stats.cancelled_unrefunded_orders} đơn (${formatVND(stats.cancelled_unrefunded_amount)})`
    );

    setText("stat-total-revenue", formatVND(stats.total_revenue));
    setText("stat-paid-revenue", formatVND(stats.paid_revenue));
    setText(
      "stat-average-order-value",
      stats.average_order_value === null ? NO_DATA : formatVND(stats.average_order_value)
    );
    setText("stat-refunded-amount", formatVND(stats.refunded_amount));

    setText("stat-vat-total", formatVND(stats.vat_total));

    setText("stat-unpaid-zalopay-orders", stats.unpaid_zalopay_orders);
    setText("stat-unpaid-zalopay-amount", formatVND(stats.unpaid_zalopay_amount));

    setText("stat-rejection-rate", formatPercent(stats.rejection_rate));
    setText("stat-cutoff-hits", stats.cutoff_hits);
    setText("stat-sold-out-today", stats.sold_out_today_hits);
    setText("stat-discontinued-hits", stats.discontinued_hits);
    setText("stat-window-passed-hits", stats.window_passed_hits);
    setText("stat-flower-shortage-hits", stats.flower_shortage_hits);

    const channelBody = byId("admin-stats-channel-breakdown");
    channelBody.innerHTML = "";
    if (stats.channel_breakdown.length === 0) {
      emptyRow(channelBody, 3, "Chưa có dữ liệu đơn hàng.");
    } else {
      stats.channel_breakdown.forEach((row) => {
        appendRow(channelBody, [CHANNEL_LABELS[row.channel] || row.channel, row.order_count, formatVND(row.revenue)]);
      });
    }

    // Funnel: counts per step, each also shown as a share of visits (not as
    // step-to-step drop-off — steps are counted separately, see the route).
    // funnel is null when the table isn't available yet.
    const funnelBody = byId("admin-stats-funnel");
    funnelBody.innerHTML = "";
    const funnel = stats.funnel;
    if (funnel === null) {
      emptyRow(funnelBody, 3, NO_DATA);
    } else {
      const visits = funnel["visit"] ?? 0;
      FUNNEL_STEPS.forEach((step) => {
        const count = funnel[step.key] ?? 0;
        let share: number | null = null;
        if (step.key === "order_placed") {
          share = stats.conversion_rate;
        } else if (visits > 0) {
          share = count / visits;
        }
        appendRow(funnelBody, [step.label, count, formatPercent(share)]);
      });
    }

    const topProductsBody = byId("admin-stats-top-products");
    topProductsBody.innerHTML = "";
    if (stats.top_products.length === 0) {
      emptyRow(topProductsBody, 2, "Chưa có dữ liệu đơn hàng.");
    } else {
      stats.top_products.forEach((product) => {
        const size = product.size && SIZE_LABELS[product.size] ? ` (${SIZE_LABELS[product.size]})` : "";
        appendRow(topProductsBody, [`${product.name}${size}`, product.quantity_sold]);
      });
    }

    const sourceBody = byId("admin-stats-source-breakdown");
    sourceBody.innerHTML = "";
    if (stats.source_breakdown.length === 0) {
      emptyRow(sourceBody, 3, "Chưa có dữ liệu đơn hàng.");
    } else {
      stats.source_breakdown.forEach((row) => {
        appendRow(sourceBody, [SOURCE_LABELS[row.source] || row.source, row.order_count, formatVND(row.revenue)]);
      });
    }
  } catch (err) {
    if (requestId !== latestRequest) return;
    errorEl.textContent = "Không thể tải số liệu thống kê.";
    errorEl.hidden = false;
  }
}

byId("admin-stats-range", HTMLSelectElement).addEventListener("change", loadStats);

loadStats();
