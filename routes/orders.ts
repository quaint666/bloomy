// Bloomy — Order creation, ZaloPay integration, and order lookup.
// Mounted at /api/orders in server.js.

import crypto from "crypto";
import { Router } from "express";
import { z } from "zod";
import QRCode from "qrcode";
import rateLimit from "express-rate-limit";
import type { PoolClient } from "pg";
import pool = require("../db");
import { notifyOrderConfirmed } from "../email";
import type { EmailItem, EmailOrder } from "../email";
import { quote, normalizeCouponCode, CUSTOM_LIMITS, CUSTOM_STYLES, CUSTOM_STYLE_LABELS } from "../pricing";
import { isRealDate } from "./dates";
import { sessionIdSchema } from "./events";
import type { FulfillmentStatus, FulfillmentType, OrderChannel, PaymentMethod, PaymentStatus, ProductSize, Queryable, TimeWindow } from "../types";

// Hand-written to match schema.sql and the queries below; nothing checks a query against them.

// The cart lines placeOrder() prices, taken from quote() itself so there is one definition.
type QuoteItems = NonNullable<Parameters<typeof quote>[1]["items"]>;

// An order as the confirmation email wants it, plus the fulfilment status the caller checks.
type FullOrder = EmailOrder & { fulfillment_status: FulfillmentStatus };
// An order line. custom, flowers and style_label are filled in by addCustomDetails() right after the query.
interface OrderItem extends EmailItem { id: number; product_id: number | null; style: string }

// Everything placeOrder() needs; the caller has already validated it with its own schema.
interface PlaceOrderInput {
  rules: "web" | "pos";
  channel: OrderChannel;
  createdBy: number | null;
  initial: { paymentStatus: PaymentStatus; fulfillmentStatus: FulfillmentStatus };
  fulfillmentType: FulfillmentType;
  items: QuoteItems;
  couponCode?: string | null;
  wardId?: number | null;
  deliveryAddress?: string | null;
  deliveryDate: string;
  deliveryWindow: TimeWindow | null;
  senderName: string; senderPhone: string; recipientName: string; recipientPhone: string;
  notes?: string | null;
  customerEmail: string | null;
  source: string | null;
  paymentMethod: PaymentMethod;
  invoiceRequested: boolean;
  invoiceCompanyName?: string | null; invoiceTaxCode?: string | null; invoiceAddress?: string | null;
}
type PlaceOrderResult =
  | { ok: true; order: { id: number; token: string }; totalAmount: number }
  | { ok: false; status: number; body: Record<string, unknown> };
type ZaloStart = { ok: true; qr_data_url: string; order_url: string } | { ok: false; message: string };
// What ZaloPay answers; the shapes are its documented ones, taken on trust.
interface ZpCreateResponse { return_code: number; return_message: string; order_url: string }
interface ZpQueryResponse { return_code: number; is_processing: boolean; amount: number; zp_trans_id: string }

const router = Router();

// ---------------------------------------------------------------------------
// Vietnam-time helpers. The VPS itself runs in UTC — every date/time
// decision that matters for the cutoff, or for ZaloPay's own yymmdd
// requirement, goes through these, never a bare `new Date()`. Shifting the
// epoch by +7h and reading it back with the UTC getters sidesteps whatever
// timezone the OS/process actually thinks it's in.
// ---------------------------------------------------------------------------
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const DEFAULT_CUTOFF_HOUR_VN = 14; // the fallback rule when a date has no cutoff_overrides row

// End time of each delivery window, in minutes since midnight. Only ever
// matters for "morning" in practice — afternoon/evening both end after
// DEFAULT_CUTOFF_HOUR_VN, so the blanket default cutoff already rules today
// out before either of those end times could be reached. Kept general (not
// a morning-only special case) so this stays correct automatically if the
// window times or cutoff hour ever change.
const WINDOW_END_MINUTES: Record<TimeWindow, number> = {
  morning: 11 * 60 + 30,
  afternoon: 17 * 60,
  evening: 21 * 60,
};

function nowVNMinutes(): number {
  const d = nowVN();
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function nowVN(): Date {
  return new Date(Date.now() + VN_OFFSET_MS);
}

function todayVNDateString(): string {
  return nowVN().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function yymmddVN(): string {
  return nowVN().toISOString().slice(2, 10).replace(/-/g, ""); // "YYMMDD"
}

// Real, per-date checkout deadline as an exact instant — not an hour-of-day.
// A holiday's deadline can fall the night BEFORE its delivery date (e.g.
// 14/2 orders closing at 20:00 on 13/2), which a plain "hour today" model
// can't express. `client` accepts either a pooled client (inside a
// transaction) or the bare pool (read-only lookups, e.g. GET /deadline) —
// both expose the same .query() shape.
async function getEffectiveDeadline(client: Queryable, deliveryDateStr: string): Promise<Date> {
  const { rows } = await client.query<{ deadline: Date }>(
    `SELECT deadline FROM cutoff_overrides WHERE override_date = $1`,
    [deliveryDateStr]
  );
  if (rows.length > 0) return new Date(rows[0].deadline);

  // Default rule: DEFAULT_CUTOFF_HOUR_VN o'clock, Vietnam time, on the
  // delivery date itself. VN is UTC+7, so 14:00 +07:00 == 07:00 UTC on the
  // same calendar date — expressed once here rather than as a second magic
  // literal elsewhere.
  const utcHour = String(DEFAULT_CUTOFF_HOUR_VN - 7).padStart(2, "0");
  return new Date(`${deliveryDateStr}T${utcHour}:00:00.000Z`);
}

// ---------------------------------------------------------------------------
// Rate limiting. Order creation and the two payment-check routes are the
// only unauthenticated POSTs that do real work (a DB write, or a live
// ZaloPay API call) — worth a limiter now that a successful order can also
// trigger an email. Generous on purpose: the whole team testing from one
// network, or the Teams demo machine, shouldn't self-throttle.
// ---------------------------------------------------------------------------
const orderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
});

// Lighter limit for the two public read-only lookups below (deadline,
// upcoming-cutoffs) — cheap indexed queries, but Checkout calls /deadline
// once per date change, so this needs more headroom than order creation.
const publicReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
});

// Cart and Checkout re-quote on every quantity, ward, date or coupon change,
// so this one needs far more headroom than order creation. Still read-only.
const quoteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
});

// ---------------------------------------------------------------------------
// ZaloPay — request signing. Three genuinely different HMAC recipes across
// this feature (create, query, IPN) — kept in separate, narrowly-named
// functions on purpose, see chat notes on how easy these are to cross-wire.
// ---------------------------------------------------------------------------
const ZP_ENDPOINT = process.env.ZALOPAY_ENDPOINT; // required and checked at startup (server.js)
const ZP_APP_ID = process.env.ZALOPAY_APP_ID;
const ZP_KEY1 = process.env.ZALOPAY_KEY1!; // required, checked at startup (server.js)
const ZP_KEY2 = process.env.ZALOPAY_KEY2!;
// Real public origin (e.g. https://bloomy.quaintshomelabdomain.uk) — ZaloPay's
// sandbox server calls this from the outside, so it can never be localhost.
// Also used to build the confirmation link in order emails.
const BLOOMY_BASE_URL = process.env.BLOOMY_BASE_URL;
// A ZaloPay call that hangs would hold the request (and a shutdown) open for minutes. Kept under the
// 8 s shutdown grace in server.js; a timeout lands in the same catch as any other connection failure.
const ZP_TIMEOUT_MS = 6000;

function hmacSHA256(key: string, data: string): string {
  return crypto.createHmac("sha256", key).update(data).digest("hex");
}

async function zaloCreateOrder({ appTransId, amount, description }: { appTransId: string; amount: number; description: string }): Promise<ZpCreateResponse> {
  const appTime = Date.now();
  const embedData = "{}";
  const item = "[]";
  const appUser = "guest"; // Bloomy has no accounts — no real user id to send

  const mac = hmacSHA256(
    ZP_KEY1,
    `${ZP_APP_ID}|${appTransId}|${appUser}|${amount}|${appTime}|${embedData}|${item}`
  );

  const res = await fetch(`${ZP_ENDPOINT}/v2/create`, {
    method: "POST",
    signal: AbortSignal.timeout(ZP_TIMEOUT_MS),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: Number(ZP_APP_ID), // must be a real number under application/json, not a string
      app_user: appUser,
      app_trans_id: appTransId,
      app_time: appTime,
      amount,
      description,
      embed_data: embedData,
      item,
      callback_url: `${BLOOMY_BASE_URL}/api/orders/ipn`,
      mac,
    }),
  });

  if (!res.ok) throw new Error(`ZaloPay createOrder HTTP ${res.status}`);
  return res.json() as Promise<ZpCreateResponse>;
}

async function zaloQueryOrder(appTransId: string): Promise<ZpQueryResponse> {
  // Query's mac embeds key1 itself inside the signed string — unusual, but
  // that's exactly what ZaloPay's own spec calls for here, not a typo.
  const mac = hmacSHA256(ZP_KEY1, `${ZP_APP_ID}|${appTransId}|${ZP_KEY1}`);

  const res = await fetch(`${ZP_ENDPOINT}/v2/query`, {
    method: "POST",
    signal: AbortSignal.timeout(ZP_TIMEOUT_MS),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: Number(ZP_APP_ID), app_trans_id: appTransId, mac }),
  });

  if (!res.ok) throw new Error(`ZaloPay query HTTP ${res.status}`);
  return res.json() as Promise<ZpQueryResponse>;
}

// ---------------------------------------------------------------------------
// Fetches one order plus its line items (with product names) in the shape
// email.js expects. The single place that assembles that shape — both the
// COD immediate-send path and markOrderPaid's post-payment send reuse this,
// rather than each building their own copy of the same query.
// ---------------------------------------------------------------------------
async function getFullOrderForEmail(orderId: number): Promise<FullOrder | null> {
  const { rows } = await pool.query<Omit<FullOrder, "items">>(
    `SELECT o.id, o.token, o.channel, o.fulfillment_type, o.sender_name, o.sender_phone,
            o.recipient_name, o.recipient_phone, w.name AS ward_name, o.delivery_address,
            o.delivery_date, o.delivery_window, o.notes, o.customer_email, o.source,
            o.subtotal, o.discount, o.shipping_fee, o.total_amount, o.vat_rate, o.coupon_code,
            o.payment_method, o.payment_status, o.fulfillment_status,
            o.invoice_requested, o.invoice_company_name, o.invoice_tax_code, o.invoice_address,
            s.shop_address
     FROM orders o
     LEFT JOIN wards w ON w.id = o.ward_id
     CROSS JOIN settings s
     WHERE o.id = $1`,
    [orderId]
  );
  if (rows.length === 0) return null;
  const order = rows[0];

  // Names, sizes and prices are snapshots on order_items — no join to
  // products, so an order reads the same even if the catalog changes later.
  const { rows: items } = await pool.query<OrderItem>(
    `SELECT id, product_id, name, size, style, note, quantity, price_at_purchase AS price
     FROM order_items WHERE order_id = $1 ORDER BY id`,
    [orderId]
  );
  await addCustomDetails(pool, items);

  return {
    ...order,
    delivery_date: order.delivery_date, // already a plain string — see db.js
    items,
  };
}

// ---------------------------------------------------------------------------
// The ONLY place payment_status ever becomes 'paid'. Called by the manual
// verify-payment route below, by admin's re-verify action, and by the IPN
// webhook handler — exported off the router (see bottom of file) so those
// routes reuse it instead of duplicating the write.
//
// WHERE payment_status IN ('pending', 'failed') — not just "!= 'paid'":
// this still lets a genuinely late ZaloPay payment on a *cancelled* order
// register as paid (the money really did arrive; the admin needs to see
// that so a refund can happen), but it protects an already-`refunded` order
// from being silently flipped back to 'paid' by a stray IPN retry or a
// re-verify click on stale data.
// ---------------------------------------------------------------------------
async function markOrderPaid(orderId: number, zpTransId: string): Promise<boolean> {
  const { rows } = await pool.query<{ id: number }>(
    // A counter (POS) sale is handed over the moment it is paid, so it also
    // becomes delivered — unless it was cancelled meanwhile (then it stays
    // cancelled and shows as paid + cancelled: a refund is owed).
    `UPDATE orders SET payment_status = 'paid', zp_trans_id = $1,
       fulfillment_status = CASE WHEN channel = 'pos' AND fulfillment_status = 'new'
                                 THEN 'delivered'::fulfillment_status ELSE fulfillment_status END
     WHERE id = $2 AND payment_status IN ('pending', 'failed')
     RETURNING id`,
    [zpTransId, orderId]
  );
  const didTransition = rows.length > 0;

  if (didTransition) {
    // Fire-and-forget — a slow or failed email must never block the IPN
    // response, the customer's manual verify click, or admin's re-verify.
    getFullOrderForEmail(orderId)
      .then((order) => {
        // A cancelled order never gets "your order is confirmed" — even
        // though the WHERE guard above still lets its payment_status
        // become 'paid' when money genuinely arrives late. The admin sees
        // paid + cancelled together and knows a refund is owed.
        if (order && order.fulfillment_status !== "cancelled") {
          return notifyOrderConfirmed(order);
        }
      })
      .catch((err) => console.error("Bloomy: post-payment email failed", err));
  }

  return didTransition;
}

// ---------------------------------------------------------------------------
// Custom-bouquet lines (product_id NULL) need more than "name × quantity" to be
// made: the flowers they hold and the style. Adds, to every item in the list:
//   custom (true/false), and for custom lines: flowers [{ name, stems }]
//   (one bouquet's worth, biggest first) and style_label ("Giỏ", "Hộp" ...).
// One query for all the custom lines of however many orders are in `items`.
// ---------------------------------------------------------------------------
async function addCustomDetails(db: Queryable, items: OrderItem[]): Promise<OrderItem[]> {
  for (const item of items) item.custom = item.product_id === null;
  const custom = items.filter((i) => i.custom);
  if (custom.length === 0) return items;
  const { rows } = await db.query<{ order_item_id: number; name: string; stems: number }>(
    `SELECT oif.order_item_id, f.name, oif.stems
     FROM order_item_flowers oif JOIN flowers f ON f.id = oif.flower_id
     WHERE oif.order_item_id = ANY($1)
     ORDER BY oif.stems DESC, f.name`,
    [custom.map((i) => i.id)]
  );
  const byItem = new Map<number, { name: string; stems: number }[]>();
  for (const r of rows) {
    if (!byItem.has(r.order_item_id)) byItem.set(r.order_item_id, []);
    byItem.get(r.order_item_id)!.push({ name: r.name, stems: r.stems });
  }
  for (const item of custom) {
    item.flowers = byItem.get(item.id) || [];
    item.style_label = (CUSTOM_STYLE_LABELS as Record<string, string>)[item.style] || null;
  }
  return items;
}

// ---------------------------------------------------------------------------
// Starting a ZaloPay payment for an order: a fresh app_trans_id (so a retry
// never collides with an earlier attempt), createOrder, and the QR image.
// Used by the web order route, the retry route and the POS route — it was
// already copied twice before POS needed it a third time.
// Returns { ok: true, qr_data_url, order_url } or { ok: false, message }.
// ---------------------------------------------------------------------------
async function startZaloPayPayment(orderId: number, amount: number): Promise<ZaloStart> {
  const appTransId = `${yymmddVN()}_${orderId}_${Date.now()}`;
  await pool.query(`UPDATE orders SET app_trans_id = $1 WHERE id = $2`, [appTransId, orderId]);

  try {
    const zpRes = await zaloCreateOrder({
      appTransId,
      amount,
      description: `Bloomy don hang #${orderId}`,
    });
    if (zpRes.return_code !== 1) return { ok: false, message: zpRes.return_message };

    // qr_code (not used here) is a VietQR-format payload — the method
    // already confirmed blocked on this sandbox account. order_url is
    // what Wallet QR actually needs, and ZaloPay expects us to encode it
    // into an image, not hand us one. Opening order_url directly (vs.
    // scanning) surfaces ZaloPay's own method picker.
    const qrDataUrl = await QRCode.toDataURL(zpRes.order_url);
    return { ok: true, qr_data_url: qrDataUrl, order_url: zpRes.order_url };
  } catch (err) {
    console.error("Bloomy: ZaloPay createOrder failed", err);
    return { ok: false, message: "Không thể kết nối ZaloPay, vui lòng thử lại." };
  }
}

// ---------------------------------------------------------------------------
// Gives an order's flowers back to stock: stems x line quantity, read from the
// order's own order_item_flowers copy (not today's recipe). The caller runs it
// in the same transaction as the status change that justifies it (cancelling
// an order that is still "new"), so it can never happen twice.
// ---------------------------------------------------------------------------
async function returnOrderStock(client: Queryable, orderId: number): Promise<void> {
  await client.query(
    `UPDATE flowers f SET stock = f.stock + x.stems
     FROM (SELECT oif.flower_id, SUM(oif.stems * oi.quantity)::int AS stems
           FROM order_item_flowers oif
           JOIN order_items oi ON oi.id = oif.order_item_id
           WHERE oi.order_id = $1
           GROUP BY oif.flower_id) x
     WHERE f.id = x.flower_id`,
    [orderId]
  );
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------
// Tax code: 10 digits, or 10 + 3-digit branch suffix with an optional hyphen.
const TAX_CODE_RE = /^\d{10}(-?\d{3})?$/;
function cleanTaxCode(raw: string | null | undefined): string {
  return (raw || "").replace(/\s/g, "");
}
// Stored in one canonical form: the 13-digit branch form always gets its hyphen.
function normalizeTaxCode(raw: string | null | undefined): string {
  const s = cleanTaxCode(raw);
  return s.length === 13 ? `${s.slice(0, 10)}-${s.slice(10)}` : s;
}

// One cart line: a product in one size. Quantity is capped so a typo can't
// ask for 10.000 bouquets (stock would refuse it anyway).
const productItemSchema = z.object({
  productId: z.number().int().positive(),
  size: z.enum(["s", "m", "l"]),
  quantity: z.number().int().positive().max(99),
});

// A custom bouquet line. Counts and lengths come from pricing.js; whether the
// flowers exist and the stem TOTAL is in range is checked by quote().
const customItemSchema = z.object({
  custom: z.object({
    flowers: z
      .array(z.object({ flowerId: z.number().int().positive(), stems: z.number().int().positive().max(CUSTOM_LIMITS.max_stems) }))
      .min(1)
      .max(CUSTOM_LIMITS.max_stems),
    style: z.enum(CUSTOM_STYLES),
    note: z.string().trim().max(CUSTOM_LIMITS.note_max).optional().nullable(),
  }),
  quantity: z.number().int().positive().max(99),
  key: z.string().max(300).optional(),
});

// Product lines only — the POS screen sells these and nothing else.
const itemsSchema = z.array(productItemSchema).min(1).max(50);
// What the website cart and checkout may send: product lines and custom bouquets.
const webItemsSchema = z.array(z.union([productItemSchema, customItemSchema])).min(1).max(50);

// Field rules shared by the web checkout and the POS screen (exported at the
// bottom as router.schemas), so a phone or email rule is written once.
const nameSchema = z.string().trim().min(1).max(100);
const phoneSchema = z
  .string()
  .transform((v) => v.replace(/\s/g, ""))
  .pipe(z.string().regex(/^[0-9]{9,12}$/, "invalid phone"));
const optionalEmailSchema = z
  .union([z.literal(""), z.string().trim().toLowerCase().max(254).email()])
  .optional()
  .transform((v) => (v ? v : null));

const checkoutSchema = z.object({
  items: webItemsSchema,
  fulfillment_type: z.enum(["delivery", "pickup"]),
  // Delivery only. Pickup sends neither (or nulls) — anything sent with a
  // pickup order is dropped below, never stored.
  ward_id: z.number().int().positive().optional().nullable(),
  coupon_code: z.string().max(40).optional().nullable(),
  sender_name: nameSchema,
  sender_phone: phoneSchema,
  recipient_name: nameSchema,
  recipient_phone: phoneSchema,
  delivery_address: z.string().trim().max(300).optional().nullable(),
  notes: z.string().trim().max(300).optional().nullable(),
  // Optional. Empty string (an unfilled optional field) and a genuinely
  // missing field both collapse to null — anything else must be a real,
  // well-formed address or the whole request is rejected (better to tell
  // the customer "invalid email" than silently drop what they typed).
  customer_email: optionalEmailSchema,
  // Traffic-source tag, captured client-side from ?utm_source=. Anything
  // outside the known set is folded to "other" rather than rejected — an
  // unrecognized tag is still worth counting, just not worth trusting as a
  // clean label.
  source: z
    .string()
    .trim()
    .toLowerCase()
    .optional()
    .transform((v) => {
      if (!v) return null;
      const known = ["facebook", "zalo", "instagram", "tiktok", "google"];
      return known.includes(v) ? v : "other";
    }),
  delivery_date: z.string().refine(isRealDate, "invalid_date"),
  delivery_window: z.enum(["morning", "afternoon", "evening"]),
  // Delivery pays COD or ZaloPay; pickup pays cash at the shop or ZaloPay.
  // Checked in the superRefine below (and again by the database).
  payment_method: z.enum(["cod", "zalopay", "cash"]),
  consent: z.literal(true),
  // Anonymous funnel-tracking id from the browser. Purely telemetry: a
  // missing or malformed value becomes undefined instead of rejecting the
  // order, because a stats nicety must never be able to cost a customer
  // their order.
  session_id: sessionIdSchema.optional().catch(undefined),
  // Optional invoice request. Unlike session_id above this is real order
  // data, so malformed input IS rejected. The cross-field rule is in the
  // superRefine below. A tax code is 10 digits, or 10 + a 3-digit branch
  // suffix (hyphen optional); the exact format check is our own assumption.
  invoice_requested: z.boolean().default(false),
  invoice_company_name: z.string().trim().max(200).optional().nullable(),
  invoice_tax_code: z.string().max(30).optional().nullable(),
  invoice_address: z.string().trim().max(300).optional().nullable(),
}).superRefine((val, ctx) => {
  const fail = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
  if (val.fulfillment_type === "delivery") {
    if (!val.ward_id) fail("ward_id", "required");
    if (!val.delivery_address) fail("delivery_address", "required");
    if (val.payment_method === "cash") fail("payment_method", "not_for_delivery");
  } else if (val.payment_method === "cod") {
    fail("payment_method", "not_for_pickup");
  }
  if (!val.invoice_requested) return;
  if (!val.invoice_company_name) fail("invoice_company_name", "required");
  if (!TAX_CODE_RE.test(cleanTaxCode(val.invoice_tax_code))) fail("invoice_tax_code", "invalid");
  if (!val.invoice_address) fail("invoice_address", "required");
  // The e-invoice is delivered electronically, so an email is mandatory
  // when an invoice is requested (it is optional otherwise).
  if (!val.customer_email) fail("invoice_requested", "email_required");
});

// ---------------------------------------------------------------------------
// POST /api/orders/quote
// Prices a cart for display. Cart sends only items and a coupon code;
// Checkout adds fulfillment type, ward and delivery date as they're picked.
// Read-only — nothing is reserved. POST /api/orders below calls the same
// quote() again, and that second call is the one that counts.
// ---------------------------------------------------------------------------
const quoteSchema = z.object({
  items: webItemsSchema,
  coupon_code: z.string().max(40).optional().nullable(),
  fulfillment_type: z.enum(["delivery", "pickup"]).optional().nullable(),
  ward_id: z.number().int().positive().optional().nullable(),
  delivery_date: z.string().refine(isRealDate, "invalid_date").optional().nullable(),
});

router.post("/quote", quoteLimiter, async (req, res, next) => {
  const parsed = quoteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload" });
  }
  const body = parsed.data;
  try {
    const result = await quote(pool, {
      items: body.items,
      couponCode: body.coupon_code,
      fulfillmentType: body.fulfillment_type || null,
      wardId: body.ward_id || null,
      deliveryDate: body.delivery_date || null,
    });
    // stock_needed is for the order route only; stock levels stay private.
    delete (result as { stock_needed?: unknown }).stock_needed;
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// placeOrder — the ONE place an order is written. The web checkout and the
// POS screen both call it, so they can't drift apart.
//
// All-or-nothing: prices the cart with quote(), runs the availability rules,
// then in ONE transaction writes the order, its lines, the flowers each line
// uses, and subtracts those stems from stock. A rejection writes nothing,
// except (web only) the availability_checks rows.
//
// `o` is already validated by the caller's own schema:
//   rules      "web"  cutoff, window, sold-out-today and flower rules; every check logged
//              "pos"  instant hand-over, so no cutoff or window; the other rules still
//                     apply. Nothing is logged: availability_checks needs a window.
//   channel, createdBy, initial { paymentStatus, fulfillmentStatus }, and the order fields
// Returns { ok: true, order: { id, token }, totalAmount }
//      or { ok: false, status, body } for the caller to send as the response.
// The caller owns the client, the catch around throws, and everything AFTER the
// commit (funnel event, emails, taking payment).
// ---------------------------------------------------------------------------
async function placeOrder(client: PoolClient, o: PlaceOrderInput): Promise<PlaceOrderResult> {
  const isDelivery = o.fulfillmentType === "delivery";
  const isWeb = o.rules === "web";

  const priced = await quote(client, {
    items: o.items,
    couponCode: o.couponCode,
    fulfillmentType: o.fulfillmentType,
    wardId: isDelivery ? o.wardId : null,
    deliveryDate: o.deliveryDate,
  });

  // Lines that can never be sold (bad id, a size the product doesn't
  // have, the external vase) are request errors, not availability results.
  const badLine = priced.lines.find((l) => l.problem);
  if (badLine) {
    return { ok: false, status: 400, body: { error: "invalid_item", reason: badLine.problem, productId: badLine.productId } };
  }
  if (isDelivery && !priced.ward) {
    return { ok: false, status: 400, body: { error: "unknown_ward" } };
  }
  // A code the customer typed must actually apply — never silently
  // dropped, or they'd pay more than they expected.
  if (priced.coupon && priced.coupon.status !== "applied") {
    return { ok: false, status: 400, body: { error: "coupon_not_applied", reason: priced.coupon.status } };
  }

  const isToday = o.deliveryDate === todayVNDateString();
  let pastCutoff = false;
  let windowAlreadyEnded = false;
  if (isWeb) {
    const deadline = await getEffectiveDeadline(client, o.deliveryDate);
    pastCutoff = Date.now() > deadline.getTime();
    // Only checked when pastCutoff is false — once the (default or
    // override) deadline has already passed, the whole date is blocked
    // regardless of window, so this only ever fires in the gap before the
    // deadline where a window's own end time has already passed (morning,
    // specifically, under the default rule — see WINDOW_END_MINUTES above).
    windowAlreadyEnded = isToday && !pastCutoff && nowVNMinutes() > WINDOW_END_MINUTES[o.deliveryWindow!]; // a web order always has a window
  }

  // Run (and, for the web, log) the check for EVERY line — never short-circuit
  // on the first rejection, or the availability_checks rejection-rate metric
  // undercounts. Flower shortage is per order, not per date: stock is the
  // stems the shop has now, whatever day the order is for.
  const results: { productId: number | null; result: string; short_flowers: string[] }[] = [];
  for (const line of priced.lines) {
    let result = "available";
    if (line.status === "discontinued") {
      result = "rejected_discontinued";
    } else if (pastCutoff) {
      result = "rejected_past_cutoff";
    } else if (windowAlreadyEnded) {
      result = "rejected_window_passed";
    } else if (isToday && line.status === "sold_out_today") {
      result = "rejected_sold_out_today";
    } else if (line.short_flowers.length > 0) {
      result = "rejected_flower_shortage";
    }
    results.push({ productId: line.productId, result, short_flowers: line.short_flowers });

    // A custom bouquet has no product row, and availability_checks needs one.
    if (isWeb && !line.custom) {
      await client.query(
        `INSERT INTO availability_checks (product_id, requested_date, requested_window, result)
         VALUES ($1, $2, $3, $4)`,
        [line.productId, o.deliveryDate, o.deliveryWindow, result]
      );
    }
  }

  // Kept simple on purpose: surfaces the FIRST rejected line, not every
  // one at once. A customer with two problems fixes them one round-trip
  // at a time rather than getting a combined error list — fine at this
  // scale, flagging the trade-off rather than silently picking it.
  const rejected = results.find((r) => r.result !== "available");
  if (rejected) {
    return {
      ok: false,
      status: 400,
      body: { error: "unavailable", reason: rejected.result, productId: rejected.productId, short_flowers: rejected.short_flowers },
    };
  }

  const totalAmount = priced.total;
  const token = crypto.randomBytes(24).toString("hex"); // IDOR fix — unguessable confirmation URL

  await client.query("BEGIN");

  const { rows: orderRows } = await client.query<{ id: number; token: string }>(
    `INSERT INTO orders
      (token, channel, fulfillment_type, sender_name, sender_phone, recipient_name, recipient_phone,
       ward_id, delivery_address, delivery_date, delivery_window, notes, customer_email, source,
       subtotal, discount, shipping_fee, total_amount, vat_rate, coupon_code,
       payment_method, payment_status, fulfillment_status,
       invoice_requested, invoice_company_name, invoice_tax_code, invoice_address, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
     RETURNING id, token`,
    [
      token,
      o.channel,
      o.fulfillmentType,
      o.senderName,
      o.senderPhone,
      o.recipientName,
      o.recipientPhone,
      isDelivery ? priced.ward!.id : null, // a delivery order without a known ward was refused above
      isDelivery ? o.deliveryAddress : null,
      o.deliveryDate,
      o.deliveryWindow,
      o.notes || null,
      o.customerEmail,
      o.source,
      priced.subtotal,
      priced.discount,
      priced.shipping_fee,
      totalAmount,
      priced.vat_rate,
      priced.coupon ? priced.coupon.code : null,
      o.paymentMethod,
      o.initial.paymentStatus,
      o.initial.fulfillmentStatus,
      // Invoice details are stored only when an invoice was actually
      // requested, so stray values sent without the flag never land.
      o.invoiceRequested,
      o.invoiceRequested ? o.invoiceCompanyName : null,
      o.invoiceRequested ? normalizeTaxCode(o.invoiceTaxCode) : null,
      o.invoiceRequested ? o.invoiceAddress : null,
      o.createdBy,
    ]
  );
  const order = orderRows[0];

  // Each line keeps a snapshot (name, size, style, price) and the flowers
  // ONE bouquet of it uses — that copy, not the current recipe, is what a
  // cancellation later returns to stock.
  for (const line of priced.lines) {
    const { rows: itemRows } = await client.query<{ id: number }>(
      `INSERT INTO order_items (order_id, product_id, name, size, style, quantity, price_at_purchase, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      // A size is stored only when the customer actually had a choice. A
      // single-size product is just "the product": no size on the order,
      // so no size shows in the email, confirmation, admin or CSV.
      [order.id, line.productId, line.name, line.sizes.length > 1 ? line.size : null, line.style, line.quantity, line.unitPrice, line.custom ? line.note : null]
    );
    for (const f of line.flowers) {
      await client.query(
        `INSERT INTO order_item_flowers (order_item_id, flower_id, stems, price_per_stem)
         VALUES ($1, $2, $3, $4)`,
        [itemRows[0].id, f.flower_id, f.stems, f.price]
      );
    }
  }

  // Take the stems. "stock >= n" makes each update all-or-nothing, so two
  // orders racing for the last stems can't both win: the loser updates
  // zero rows and its whole transaction is rolled back. Rows are touched
  // in flower-id order so concurrent orders can't deadlock each other.
  for (const need of priced.stock_needed) {
    const { rowCount } = await client.query(
      `UPDATE flowers SET stock = stock - $1 WHERE id = $2 AND stock >= $1`,
      [need.stems, need.flower_id]
    );
    if (rowCount === 0) {
      await client.query("ROLLBACK");
      return { ok: false, status: 409, body: { error: "unavailable", reason: "rejected_flower_shortage" } };
    }
  }

  await client.query("COMMIT");
  return { ok: true, order, totalAmount };
}

// ---------------------------------------------------------------------------
// POST /api/orders
// The customer checkout: validates the payload, hands the order to
// placeOrder(), then does what only the web needs after the commit — the
// funnel event, the COD/cash confirmation email, or starting ZaloPay.
// ---------------------------------------------------------------------------
router.post("/", orderLimiter, async (req, res, next) => {
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
  }
  const body = parsed.data;

  if (body.delivery_date < todayVNDateString()) {
    return res.status(400).json({ error: "invalid_date" });
  }

  const client = await pool.connect();
  try {
    const result = await placeOrder(client, {
      rules: "web",
      channel: "web",
      createdBy: null,
      initial: { paymentStatus: "pending", fulfillmentStatus: "new" },
      fulfillmentType: body.fulfillment_type,
      items: body.items,
      couponCode: body.coupon_code,
      wardId: body.ward_id,
      deliveryAddress: body.delivery_address,
      deliveryDate: body.delivery_date,
      deliveryWindow: body.delivery_window,
      senderName: body.sender_name,
      senderPhone: body.sender_phone,
      recipientName: body.recipient_name,
      recipientPhone: body.recipient_phone,
      notes: body.notes,
      customerEmail: body.customer_email,
      source: body.source,
      paymentMethod: body.payment_method,
      invoiceRequested: body.invoice_requested,
      invoiceCompanyName: body.invoice_company_name,
      invoiceTaxCode: body.invoice_tax_code,
      invoiceAddress: body.invoice_address,
    });
    if (!result.ok) return res.status(result.status).json(result.body);
    const { order, totalAmount } = result;

    // Funnel step "order placed". Written here, after COMMIT and before the
    // payment branch, so it covers every method and only ever exists for
    // an order that really committed. Fire-and-forget with its own catch
    // (same pattern as the emails): never inside the transaction, never
    // awaited, so a stats failure can't touch the order or the response.
    // "Placed" means the order row exists, not that it has been paid.
    if (body.session_id) {
      pool
        .query(`INSERT INTO funnel_events (session_id, event) VALUES ($1, 'order_placed')`, [body.session_id])
        .catch((err) => console.error("Bloomy: funnel order_placed insert failed", err));
    }

    if (body.payment_method === "cod" || body.payment_method === "cash") {
      // COD and cash-at-the-shop are "confirmed" the moment they're placed —
      // pending payment here means "pay on delivery / at pickup," not
      // "still needs confirming" — so the email fires right away.
      // Fire-and-forget: never awaited on the response path.
      getFullOrderForEmail(order.id)
        .then((fullOrder) => fullOrder && notifyOrderConfirmed(fullOrder))
        .catch((err) => console.error("Bloomy: order confirmation email failed", err));

      return res.status(201).json({ token: order.token, payment_method: body.payment_method, total_amount: totalAmount });
    }

    // ZaloPay — the order row already exists and is safely committed before
    // this point, per the locked "write orders first, then call ZaloPay"
    // ordering. If createOrder itself fails, the order still exists as
    // pending/zalopay; a fresh app_trans_id means a later retry won't
    // collide with this attempt. No email yet — ZaloPay orders are only
    // confirmed once markOrderPaid() actually flips them to paid.
    const zp = await startZaloPayPayment(order.id, totalAmount);
    if (!zp.ok) {
      return res.status(201).json({
        token: order.token,
        payment_method: "zalopay",
        total_amount: totalAmount,
        zalopay_error: true,
        message: zp.message,
      });
    }
    return res.status(201).json({
      token: order.token,
      payment_method: "zalopay",
      total_amount: totalAmount,
      qr_data_url: zp.qr_data_url,
      order_url: zp.order_url,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// POST /api/orders/ipn
// ZaloPay's real webhook — called from their servers, not the browser, the
// moment a payment actually succeeds. This is what makes Checkout's polling
// resolve on its own; without it, only the manual verify-payment fallback
// ever marks anything paid. Response shape is dictated by ZaloPay's own
// docs: {return_code: 1} acks (stop retrying), {return_code: 0} tells them
// to retry (up to 3 times), used here for anything unexpected rather than
// a hard failure, since a transient DB hiccup shouldn't be treated the same
// as a genuinely invalid callback.
// ---------------------------------------------------------------------------
router.post("/ipn", async (req, res) => {
  try {
    const { data, mac } = req.body;
    const expectedMac = hmacSHA256(ZP_KEY2, data);

    const macBuf = Buffer.from(mac || "", "hex");
    const expectedBuf = Buffer.from(expectedMac, "hex");
    const macValid = macBuf.length === expectedBuf.length && crypto.timingSafeEqual(macBuf, expectedBuf);

    if (!macValid) {
      return res.json({ return_code: -1, return_message: "mac not equal" });
    }

    const payload = JSON.parse(data);
    const { rows } = await pool.query<{ id: number; total_amount: number; payment_status: PaymentStatus }>(
      `SELECT id, total_amount, payment_status FROM orders WHERE app_trans_id = $1`,
      [payload.app_trans_id]
    );

    if (rows.length === 0) {
      // Shouldn't happen (app_trans_id always comes from a real committed
      // order), but ack anyway — retrying won't make the order appear.
      console.error("Bloomy: IPN received for unknown app_trans_id", payload.app_trans_id);
      return res.json({ return_code: 1, return_message: "success" });
    }

    const order = rows[0];
    if (payload.amount !== order.total_amount) {
      console.error("Bloomy: IPN amount mismatch", { orderId: order.id, expected: order.total_amount, got: payload.amount });
      return res.json({ return_code: -1, return_message: "amount mismatch" });
    }

    await markOrderPaid(order.id, payload.zp_trans_id); // idempotent — safe on ZaloPay's retries too

    return res.json({ return_code: 1, return_message: "success" });
  } catch (err) {
    console.error("Bloomy: IPN handling failed", err);
    return res.json({ return_code: 0, return_message: "temporary error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/orders/deadline?date=YYYY-MM-DD
// Public, unauthenticated, read-only — same trust level as GET
// /api/products. Lets Checkout show the REAL deadline for the date the
// customer picked (default 14:00, or an admin-set override) instead of a
// hardcoded "14:00" string. is_override tells the frontend which copy to
// show — the default rule only matters when the picked date is today (a
// future date's own same-day 14:00 hasn't arrived yet), but an override
// deadline is worth surfacing regardless of which date is picked, since it
// can fall well before the delivery date itself. Registered before GET
// /:token, since that route's :token param would otherwise swallow this
// literal path.
// ---------------------------------------------------------------------------
router.get("/deadline", publicReadLimiter, async (req, res, next) => {
  try {
    const date = req.query.date;
    if (!isRealDate(date)) {
      return res.status(400).json({ error: "invalid_date" });
    }
    const { rows } = await pool.query<{ deadline: Date }>(
      `SELECT deadline FROM cutoff_overrides WHERE override_date = $1`,
      [date]
    );
    const isOverride = rows.length > 0;
    const deadline = isOverride ? new Date(rows[0].deadline) : await getEffectiveDeadline(pool, date as string); // isRealDate has checked it is a string
    res.json({ date, deadline: deadline.toISOString(), is_override: isOverride });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/orders/upcoming-cutoffs
// Public, unauthenticated, read-only. Overrides falling in the next 7 real
// calendar days from now — lets Product Detail show a "this date closes
// early" advisory before the customer has picked any delivery date at all
// (unlike /deadline above, which needs one specific date to check).
// ---------------------------------------------------------------------------
router.get("/upcoming-cutoffs", publicReadLimiter, async (req, res, next) => {
  try {
    const from = todayVNDateString();
    const until = (() => {
      const d = nowVN();
      d.setUTCDate(d.getUTCDate() + 7);
      return d.toISOString().slice(0, 10);
    })();

    // deadline > now() matters as much as the date range: without it, an
    // override for TODAY whose deadline already passed this morning would
    // still show "chỉ nhận đơn đến 08:00" all afternoon — technically
    // true of a date in the window, but stale and misleading as advice.
    const { rows } = await pool.query<{ override_date: string; deadline: Date; note: string | null }>(
      `SELECT override_date, deadline, note FROM cutoff_overrides
       WHERE override_date BETWEEN $1 AND $2 AND deadline > now()
       ORDER BY override_date`,
      [from, until]
    );

    // override_date now comes back as a plain "YYYY-MM-DD" string directly
    // (see db.js's type-parser override) — no conversion needed.
    res.json(
      rows.map((r) => ({
        override_date: r.override_date,
        deadline: r.deadline.toISOString(),
        note: r.note,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/orders/:token
// Used by Checkout's polling loop and by Order Confirmation. Token is the
// IDOR-safe lookup key — the sequential id is never exposed directly, only
// as part of the cosmetic order_code below (harmless: order_code is never
// accepted anywhere as a lookup key, only token is).
// ---------------------------------------------------------------------------
router.get("/:token", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.id, o.token, o.fulfillment_type, o.sender_name, o.sender_phone,
              o.recipient_name, o.recipient_phone, w.name AS ward_name, o.delivery_address,
              o.delivery_date, o.delivery_window, o.notes, o.customer_email,
              o.subtotal, o.discount, o.shipping_fee, o.total_amount, o.vat_rate, o.coupon_code,
              o.payment_method, o.payment_status, o.fulfillment_status, o.tracking_code, o.created_at,
              o.invoice_requested, o.invoice_company_name, o.invoice_tax_code, o.invoice_address
       FROM orders o LEFT JOIN wards w ON w.id = o.ward_id
       WHERE o.token = $1`,
      [req.params.token]
    );
    if (rows.length === 0) return res.status(404).json({ error: "not_found" });
    const order = rows[0];

    // Name, size and price come from the order's own snapshot; the product
    // join is only for the picture (LEFT JOIN: a line may have no product).
    const { rows: items } = await pool.query(
      `SELECT oi.id, oi.product_id, oi.name, oi.size, oi.style, oi.note, p.image,
              oi.quantity, oi.price_at_purchase AS price
       FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1
       ORDER BY oi.id`,
      [order.id]
    );
    await addCustomDetails(pool, items);

    // admin_note is deliberately NOT selected above: it's internal only.
    const { id, ...publicFields } = order;
    res.json({
      // node-postgres returns delivery_date as a plain "YYYY-MM-DD" string
      // (see db.js's type-parser override) — no conversion needed.
      order_code: `BLOMY${String(id).padStart(6, "0")}`,
      ...publicFields,
      items,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/orders/:token/verify-payment
// The manual "Tôi đã thanh toán" fallback. Never trusts the click itself —
// always re-asks ZaloPay via /v2/query and only marks paid on what ZaloPay
// actually reports. Same shape Admin's re-verify action reuses.
// ---------------------------------------------------------------------------
router.post("/:token/verify-payment", orderLimiter, async (req, res, next) => {
  try {
    const { rows } = await pool.query<{ id: number; payment_method: PaymentMethod; payment_status: PaymentStatus; app_trans_id: string | null; total_amount: number }>(
      `SELECT id, payment_method, payment_status, app_trans_id, total_amount
       FROM orders WHERE token = $1`,
      [req.params.token]
    );
    if (rows.length === 0) return res.status(404).json({ error: "not_found" });
    const order = rows[0];

    if (order.payment_method !== "zalopay") {
      return res.status(400).json({ error: "not_zalopay_order" });
    }
    if (order.payment_status === "paid" || order.payment_status === "refunded") {
      return res.json({ payment_status: order.payment_status });
    }
    if (!order.app_trans_id) {
      return res.status(409).json({ error: "no_zalopay_attempt_yet" });
    }

    const zpRes = await zaloQueryOrder(order.app_trans_id);

    if (zpRes.return_code === 1 && zpRes.is_processing === false && zpRes.amount === order.total_amount) {
      await markOrderPaid(order.id, zpRes.zp_trans_id);
      return res.json({ payment_status: "paid" });
    }

    return res.json({ payment_status: "pending" });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/orders/:token/retry-zalopay-payment
// Closes the gap where zaloCreateOrder() failed at checkout (network error,
// or ZaloPay declining the create-order call) — the order exists as
// zalopay/pending with no QR ever successfully shown. A fresh app_trans_id
// is required each attempt; ZaloPay won't accept reusing one it never
// actually accepted the first time.
// ---------------------------------------------------------------------------
router.post("/:token/retry-zalopay-payment", orderLimiter, async (req, res, next) => {
  try {
    const { rows } = await pool.query<{ id: number; payment_method: PaymentMethod; payment_status: PaymentStatus; fulfillment_status: FulfillmentStatus; total_amount: number }>(
      `SELECT id, payment_method, payment_status, fulfillment_status, total_amount
       FROM orders WHERE token = $1`,
      [req.params.token]
    );
    if (rows.length === 0) return res.status(404).json({ error: "not_found" });
    const order = rows[0];

    if (order.payment_method !== "zalopay") {
      return res.status(400).json({ error: "not_zalopay_order" });
    }
    if (order.payment_status === "paid" || order.payment_status === "refunded") {
      return res.status(400).json({ error: "not_eligible_for_retry" });
    }
    if (order.fulfillment_status === "cancelled") {
      return res.status(400).json({ error: "order_cancelled" });
    }

    const zp = await startZaloPayPayment(order.id, order.total_amount);
    if (!zp.ok) {
      return res.status(502).json({ error: "zalopay_retry_failed", message: zp.message });
    }
    return res.json({ qr_data_url: zp.qr_data_url, order_url: zp.order_url });
  } catch (err) {
    console.error("Bloomy: ZaloPay retry-payment failed", err);
    return res.status(502).json({
      error: "zalopay_retry_failed",
      message: "Không thể kết nối ZaloPay, vui lòng thử lại.",
    });
  }
});

// markOrderPaid and zaloQueryOrder are reused by admin's re-verify action; todayVNDateString by the delivery-sheet
// route's default date; the rest by the POS routes (routes/admin-pos.js) and the admin cancel.
export = Object.assign(router, {
  markOrderPaid,
  zaloQueryOrder,
  todayVNDateString,
  placeOrder,
  startZaloPayPayment,
  returnOrderStock,
  getFullOrderForEmail,
  addCustomDetails,
  schemas: { itemsSchema, nameSchema, phoneSchema, optionalEmailSchema },
});
