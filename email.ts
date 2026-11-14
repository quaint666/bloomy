// Bloomy — order-confirmation email (customer) and new-order notification
// (shop), sent through Resend's HTTP API rather than SMTP — DigitalOcean
// blocks outbound SMTP ports (25/465/587) on Droplets by default, so this
// goes over HTTPS instead, same pattern as the ZaloPay calls in orders.js.
//
// EMAIL_MODE controls what actually happens:
//   "send" — real delivery via the Resend API.
//   anything else (missing, "log", a typo) — the email is only printed to
//     the console. This is the deliberate default: local dev/testing never
//     needs a real API key, and a misconfigured env var fails CLOSED (no
//     send) rather than failing open into real sends nobody intended.
//
// Required env vars when EMAIL_MODE=send: RESEND_API_KEY, EMAIL_FROM,
// SHOP_NOTIFICATION_EMAIL, BLOOMY_BASE_URL (the last one already exists
// for ZaloPay's callback_url).

import type { FulfillmentType, OrderChannel, PaymentMethod, PaymentStatus, ProductSize, TimeWindow } from "./types";
import { WINDOW_TEXT } from "./shared/rules";

// The order as getFullOrderForEmail() in routes/orders.js assembles it: the orders row, the ward name,
// the shop address and the items. Hand-written to match schema.sql; nothing checks it against the query.
interface EmailItem {
  name: string; size: ProductSize | null; quantity: number; price: number; note: string | null;
  custom: boolean; flowers?: { name: string; stems: number }[]; style_label?: string | null;
}
interface EmailOrder {
  id: number; token: string; channel: OrderChannel; fulfillment_type: FulfillmentType;
  sender_name: string; sender_phone: string; recipient_name: string; recipient_phone: string;
  ward_name: string | null; delivery_address: string | null; delivery_date: string;
  delivery_window: TimeWindow | null; notes: string | null; customer_email: string | null; source: string | null;
  subtotal: number; discount: number; shipping_fee: number; total_amount: number; vat_rate: number;
  coupon_code: string | null; payment_method: PaymentMethod; payment_status: PaymentStatus;
  invoice_requested: boolean; invoice_company_name: string | null; invoice_tax_code: string | null;
  invoice_address: string | null; shop_address: string; items: EmailItem[];
}
interface SendResult { ok: boolean; mode?: "log" | "send"; skipped?: true }

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_MODE = process.env.EMAIL_MODE || "log";
const EMAIL_FROM = process.env.EMAIL_FROM || "Bloomy <orders@bloomy.quaintshomelabdomain.uk>";
const SHOP_NOTIFICATION_EMAIL = process.env.SHOP_NOTIFICATION_EMAIL;
const BLOOMY_BASE_URL = process.env.BLOOMY_BASE_URL;

const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  pending: "Chờ thanh toán",
  paid: "Đã thanh toán",
  failed: "Thanh toán thất bại",
  refunded: "Đã hoàn tiền",
};

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cod: "Thanh toán khi nhận hàng (COD)",
  zalopay: "ZaloPay",
  cash: "Tiền mặt tại shop",
};

const SIZE_LABELS: Record<ProductSize, string> = { s: "Nhỏ", m: "Vừa", l: "Lớn" };

// "Buổi sáng (8–12h)" for a booked order; a counter (POS) sale has no window.
function windowText(order: EmailOrder): string {
  const win = order.delivery_window ? WINDOW_TEXT[order.delivery_window] : undefined;
  return win ? `${win.label} (${win.time})` : "tại quầy";
}

function formatVND(amount: number): string {
  return new Intl.NumberFormat("vi-VN").format(amount) + "đ";
}

// Shown in the CUSTOMER email when an invoice was requested. Deliberately a
// fixed sentence: the company name, tax code and address are customer-typed,
// and the customer email never carries customer-typed text (see the note
// above sendOrderConfirmationEmail). The full details go to the shop inbox.
const INVOICE_NOTE =
  "Bloomy đã ghi nhận yêu cầu xuất hóa đơn của bạn và sẽ gửi hóa đơn điện tử qua email này.";

// HTML-escapes a value before it's interpolated into an email template.
// Only the shop-notification email ever puts customer-typed text (name,
// address, notes) into HTML — the customer's own email deliberately
// contains NO customer-typed text at all (see sendOrderConfirmationEmail
// below), so this mainly protects the shop's inbox rendering, not a
// security boundary against the customer themselves.
function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sendEmail({ to, subject, html, text }: { to: string; subject: string; html: string; text: string }): Promise<SendResult> {
  if (EMAIL_MODE !== "send") {
    console.log(`Bloomy: [email:${EMAIL_MODE}] would send to ${to} — "${subject}"\n${text}\n`);
    return { ok: true, mode: "log" };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html, text }),
      // Without this, a hung Resend request leaves a dangling promise
      // forever — harmless to the response (this is always called
      // fire-and-forget), but it'd sit as an unresolved handle indefinitely.
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error(`Bloomy: Resend send failed (${res.status})`, errBody);
      return { ok: false };
    }
    return { ok: true, mode: "send" };
  } catch (err) {
    console.error("Bloomy: email send threw", err);
    return { ok: false };
  }
}

// "Bó Hồng Đỏ Classic (Vừa)" — the size only for products that have sizes.
function itemName(item: EmailItem): string {
  return item.size && SIZE_LABELS[item.size] ? `${item.name} (${SIZE_LABELS[item.size]})` : item.name;
}

// What a custom bouquet is made of — the shop needs it to make the bouquet.
function customDetail(item: EmailItem): string {
  if (!item.custom) return "";
  const made = item.flowers!.map((f) => `${f.name} × ${f.stems}`).join(", ");
  return `${item.style_label}: ${made}${item.note ? ` — Ghi chú: ${item.note}` : ""}`;
}

function itemsHtml(items: EmailItem[]): string {
  return items
    .map(
      (item) => `
      <tr>
        <td style="padding:6px 0;">${escapeHtml(itemName(item))} × ${item.quantity}${
          item.custom ? `<br><span style="color:#777; font-size:12px;">${escapeHtml(customDetail(item))}</span>` : ""
        }</td>
        <td style="padding:6px 0; text-align:right;">${formatVND(item.price * item.quantity)}</td>
      </tr>`
    )
    .join("");
}

function itemsText(items: EmailItem[]): string {
  return items
    .map(
      (item) =>
        `- ${itemName(item)} × ${item.quantity}: ${formatVND(item.price * item.quantity)}` +
        (item.custom ? `\n    ${customDetail(item)}` : "")
    )
    .join("\n");
}

// Money lines shared by both emails: goods, coupon, shipping, total.
// Prices are tax-inclusive; only the rate is stated, never an amount.
function moneyLines(order: EmailOrder): [string, string][] {
  const lines: [string, string][] = [[`Tạm tính`, formatVND(order.subtotal)]];
  if (order.discount > 0) lines.push([`Mã giảm giá ${order.coupon_code}`, `−${formatVND(order.discount)}`]);
  lines.push([
    "Phí giao hàng",
    order.fulfillment_type === "pickup" ? "Nhận tại shop (miễn phí)" : formatVND(order.shipping_fee),
  ]);
  return lines;
}

function moneyHtml(order: EmailOrder): string {
  const rows = moneyLines(order)
    .map(([label, value]) => `<tr><td style="padding:4px 0;">${escapeHtml(label)}</td><td style="padding:4px 0; text-align:right;">${escapeHtml(value)}</td></tr>`)
    .join("");
  return `<table style="width:100%; border-collapse:collapse; margin-top:8px;">${rows}</table>
      <p>Tổng cộng: <strong>${formatVND(order.total_amount)}</strong> (đã bao gồm VAT ${order.vat_rate}%)</p>`;
}

function moneyText(order: EmailOrder): string {
  return [
    ...moneyLines(order).map(([label, value]) => `${label}: ${value}`),
    `Tổng cộng: ${formatVND(order.total_amount)} (đã bao gồm VAT ${order.vat_rate}%)`,
  ].join("\n");
}

// Where the flowers go: the delivery address with its ward, or the shop
// for a pickup order.
function placeLine(order: EmailOrder): string {
  return order.fulfillment_type === "pickup"
    ? `Nhận tại shop: ${order.shop_address}`
    : `Giao đến: ${order.delivery_address}, ${order.ward_name}`;
}

// ---------------------------------------------------------------------------
// Customer email — Bloomy-generated content only. Deliberately contains NO
// customer-typed text (name, address, notes) anywhere in the body: the
// email address itself is customer-typed and could be mistyped or entered
// for someone else, so nothing free-text rides along with it. Two risks
// this avoids: using Bloomy as a spam relay (a link/ad planted in a name
// or notes field, sent to a stranger's inbox), and a typo leaking the
// recipient's name/phone/address to someone else. See chat notes for the
// full reasoning. Skipped entirely — silently, not an error — when the
// order has no customer_email.
// ---------------------------------------------------------------------------
async function sendOrderConfirmationEmail(order: EmailOrder): Promise<SendResult> {
  if (!order.customer_email) return { ok: true, skipped: true };

  const orderCode = `BLOMY${String(order.id).padStart(6, "0")}`;
  const link = `${BLOOMY_BASE_URL}/order-confirmation.html?token=${order.token}`;

  const html = `
    <div style="font-family:sans-serif; max-width:480px; margin:0 auto; color:#2b2b2b;">
      <h2>Cảm ơn bạn đã đặt hoa tại Bloomy 🌸</h2>
      <p>Mã đơn hàng: <strong>${orderCode}</strong></p>
      <table style="width:100%; border-collapse:collapse;">${itemsHtml(order.items)}</table>
      ${moneyHtml(order)}
      <p>${escapeHtml(placeLine(order))}</p>
      <p>${order.fulfillment_type === "pickup" ? "Ngày nhận" : "Ngày giao"}: <strong>${order.delivery_date}</strong> — ${windowText(order)}</p>
      <p>Thanh toán: ${PAYMENT_METHOD_LABELS[order.payment_method]} — <strong>${PAYMENT_STATUS_LABELS[order.payment_status]}</strong></p>
      ${order.invoice_requested ? `<p>${INVOICE_NOTE}</p>` : ""}
      <p><a href="${link}">Xem chi tiết đơn hàng</a></p>
    </div>`;

  const text = [
    "Cảm ơn bạn đã đặt hoa tại Bloomy.",
    `Mã đơn hàng: ${orderCode}`,
    "",
    itemsText(order.items),
    "",
    moneyText(order),
    placeLine(order),
    `${order.fulfillment_type === "pickup" ? "Ngày nhận" : "Ngày giao"}: ${order.delivery_date} — ${windowText(order)}`,
    `Thanh toán: ${PAYMENT_METHOD_LABELS[order.payment_method]} — ${PAYMENT_STATUS_LABELS[order.payment_status]}`,
    order.invoice_requested ? INVOICE_NOTE : null,
    `Xem chi tiết đơn hàng: ${link}`,
  ]
    .filter((line) => line !== null)
    .join("\n");

  return sendEmail({
    to: order.customer_email,
    subject: `Bloomy — Xác nhận đơn hàng ${orderCode}`,
    html,
    text,
  });
}

// ---------------------------------------------------------------------------
// Shop notification — always sent to the fixed shop inbox (SHOP_NOTIFICATION
// _EMAIL), full detail including customer-typed fields. Every customer-typed
// value is escaped before going into the HTML — this is Bloomy's own inbox,
// so it's a rendering/safety concern (a name or note breaking the layout or
// carrying a clickable link), not an XSS boundary against an outside party.
// ---------------------------------------------------------------------------
async function sendShopNotificationEmail(order: EmailOrder): Promise<SendResult> {
  if (!SHOP_NOTIFICATION_EMAIL) return { ok: true, skipped: true };

  const orderCode = `BLOMY${String(order.id).padStart(6, "0")}`;
  const adminLink = `${BLOOMY_BASE_URL}/admin-orders.html`;

  const html = `
    <div style="font-family:sans-serif; max-width:480px; margin:0 auto; color:#2b2b2b;">
      <h2>Đơn hàng mới — ${orderCode}</h2>
      <p>${escapeHtml(order.sender_name)} (${escapeHtml(order.sender_phone)})</p>
      <p>Người nhận: ${escapeHtml(order.recipient_name)} (${escapeHtml(order.recipient_phone)})</p>
      <p>${escapeHtml(placeLine(order))}</p>
      <p>Ngày: ${order.delivery_date} — ${windowText(order)}</p>
      ${order.notes ? `<p>Ghi chú: ${escapeHtml(order.notes)}</p>` : ""}
      <table style="width:100%; border-collapse:collapse;">${itemsHtml(order.items)}</table>
      ${moneyHtml(order)}
      <p>Thanh toán: ${PAYMENT_METHOD_LABELS[order.payment_method]} — ${PAYMENT_STATUS_LABELS[order.payment_status]}</p>
      ${
        order.invoice_requested
          ? `<p><strong>Yêu cầu xuất hóa đơn:</strong> ${escapeHtml(order.invoice_company_name)} — MST ${escapeHtml(order.invoice_tax_code)}<br>Địa chỉ: ${escapeHtml(order.invoice_address)}<br>Gửi hóa đơn tới: ${escapeHtml(order.customer_email)}</p>`
          : ""
      }
      <p>Nguồn: ${escapeHtml(order.source || "direct")}</p>
      <p><a href="${adminLink}">Xem trong Admin</a></p>
    </div>`;

  const text = [
    `Đơn hàng mới — ${orderCode}`,
    `${order.sender_name} (${order.sender_phone})`,
    `Người nhận: ${order.recipient_name} (${order.recipient_phone})`,
    placeLine(order),
    `Ngày: ${order.delivery_date} — ${windowText(order)}`,
    order.notes ? `Ghi chú: ${order.notes}` : null,
    "",
    itemsText(order.items),
    "",
    moneyText(order),
    `Thanh toán: ${PAYMENT_METHOD_LABELS[order.payment_method]} — ${PAYMENT_STATUS_LABELS[order.payment_status]}`,
    order.invoice_requested
      ? `Yêu cầu xuất hóa đơn: ${order.invoice_company_name} — MST ${order.invoice_tax_code} — Địa chỉ: ${order.invoice_address} — Gửi tới: ${order.customer_email}`
      : null,
    `Nguồn: ${order.source || "direct"}`,
  ]
    .filter((line) => line !== null)
    .join("\n");

  return sendEmail({ to: SHOP_NOTIFICATION_EMAIL, subject: `[Bloomy] Đơn mới ${orderCode}`, html, text });
}

// ---------------------------------------------------------------------------
// The one function orders.js calls — the single place either email is
// triggered from. Both sends run in parallel and never throw; a failed
// email must never fail or delay the order itself, so callers fire this
// without awaiting it on the response path.
// ---------------------------------------------------------------------------
async function notifyOrderConfirmed(order: EmailOrder): Promise<void> {
  // A counter (POS) sale is the shop's own sale: nobody needs telling at the
  // shop, so only the customer is emailed (and only if they gave an address).
  const sends = [sendOrderConfirmationEmail(order)];
  if (order.channel !== "pos") sends.push(sendShopNotificationEmail(order));
  await Promise.allSettled(sends);
}

export { notifyOrderConfirmed, escapeHtml, formatVND };

export type { EmailOrder, EmailItem };
