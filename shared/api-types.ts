// Bloomy — the shapes the server sends and the browser reads, written once. Types only: nothing here
// exists at run time (import it with `import type`), so the server image needs no copy of this file.

// What res.json() puts on the wire for T. JSON has no Date, so a Date arrives as an ISO string.
export type Wire<T> = T extends Date ? string
  : T extends readonly (infer U)[] ? Wire<U>[]
  : T extends object ? { [K in keyof T]: Wire<T[K]> }
  : T;

// Unions the browser reads too (types.ts re-exports them for the server).
export type ProductSize = "s" | "m" | "l";
export type CustomStyle = "bo" | "gio" | "hop"; // the wrap styles of a custom bouquet (pricing.ts holds their labels)
export type ProductStatus = "available" | "sold_out_today" | "discontinued";
export type CouponType = "fixed" | "percent";

// One size of a product and its price, as the listing, the campaign and the quote return it.
export interface SizePrice { size: ProductSize; price: number }

// The orders table's enum values (schema.sql is the source; types.ts re-exports these for the server).
export type OrderChannel = "web" | "pos";
export type FulfillmentType = "delivery" | "pickup";
export type PaymentMethod = "cod" | "zalopay" | "cash";
export type PaymentStatus = "pending" | "paid" | "failed" | "refunded";
export type FulfillmentStatus = "new" | "delivering" | "delivered" | "cancelled";
export type TimeWindow = "morning" | "afternoon" | "evening";

// A row of coupons. Dates are "YYYY-MM-DD" strings (db.ts).
export interface CouponRow {
  code: string; type: CouponType; value: number; min_subtotal: number;
  starts_on: string | null; ends_on: string | null; active: boolean;
}

// The three admin roles, and the logged-in account as requireRole() reads it from admin_users.
export type AdminRole = "owner" | "manager" | "employee";
export interface AdminUser { id: number; username: string; role: AdminRole; active: boolean }

// Any failed reply. `error` is a code the page turns into text; the rest depends on the code (retry_after
// for two_factor_locked, min and max for invalid_username and invalid_password, field for a rejected setting).
export interface ApiErrorBody {
  error: string; retry_after?: number; min?: number; max?: number; field?: string;
  reason?: string; short_flowers?: string[]; // an order refused for stock: why, and which flowers are short
  message?: string; // a payment provider's own words, when it refused (zalopay_retry_failed)
  details?: { fieldErrors?: Record<string, string[] | undefined> }; // invalid_payload: which fields failed (zod's flatten())
}

// GET /api/admin/me, POST /api/admin/login (an account with 2FA first only asks for the code) and
// GET /api/admin/users (routes/admin-auth.ts, routes/admin-users.ts). The routes check their replies against these.
export interface AdminMeBody { username: string; role: AdminRole; landing: string }
export type AdminLoginBody = { success: true; role: AdminRole; landing: string } | { needs_code: true };
export interface AdminUsersBody { me: number; users: AdminUser[] }

// /api/admin/coupons (routes/admin-coupons.ts): a coupon with its id (the list, and what a create or a change answers).
export interface AdminCouponRow extends CouponRow { id: number }

// GET /api/admin/products (routes/admin-products.ts): the list, with how many products may be featured at once.
export interface AdminProductRow {
  id: number; sku: string; name: string; status: ProductStatus; featured: boolean;
  product_type: "standard" | "external"; category_name: string; min_price: number; max_price: number;
  size_count: number; has_recipe: boolean;
}
export interface AdminProductsBody { featured_limit: number; products: AdminProductRow[] }

// /api/admin/seo (routes/admin-seo.ts, built from seo.ts, the code the product page itself uses): the list, and one
// product with its fields, the search-result preview and the checks. A field is null (or absent) when nothing is written.
export type SeoLevel = "good" | "warn" | "bad";
export interface SeoCheck { id: string; level: SeoLevel; text: string }
export interface SeoListItem { id: number; name: string; status: ProductStatus; keyword: string | null | undefined; health: SeoLevel }
export interface SeoDetailBody {
  product: { id: number; name: string; status: ProductStatus; image: string | null; short_description: string | null; description: string | null };
  fields: { seo_keyword?: string | null; seo_title?: string | null; seo_description?: string | null };
  effective: { title: string; description: string; url: string; robots: string | null };
  preview: { title: string; url: string; description: string };
  checks: SeoCheck[];
  health: SeoLevel;
}

// /api/admin/campaigns (routes/admin-campaigns.ts): the list, one campaign with its products in their shown order
// (also what a create or a change answers), and what the editor may choose from.
export interface CampaignListItem {
  id: number; name: string; headline: string; coupon_code: string | null; hero_image: string | null;
  product_count: number; active: boolean;
}
export interface CampaignProduct { id: number; name: string; status: ProductStatus; image: string | null }
export interface CampaignDetail {
  id: number; name: string; headline: string; subheadline: string | null; coupon_code: string | null;
  hero_image: string | null; active: boolean; products: CampaignProduct[];
}
export interface CampaignLimits { name: number; headline: number; subheadline: number; products: number }
export interface CampaignOptions {
  coupons: CouponRow[]; products: CampaignProduct[];
  images: string[]; limits: CampaignLimits;
}

// /api/admin/orders (routes/admin-orders.ts). A line of an order: a custom bouquet (custom: true) carries its
// flowers, its wrap style and the customer's note, which the florist needs to make it.
export interface AdminOrderItem {
  name: string; size: ProductSize | null; quantity: number; price: number; note: string | null;
  custom: boolean; flowers?: { name: string; stems: number }[]; style_label?: string | null;
}
// One row of the order list as the database returns it, and the order the route builds from it. On the wire
// created_at is a string (AdminOrdersResponse); delivery_date is already a "YYYY-MM-DD" string (db.ts).
export interface AdminOrderRow {
  id: number; token: string; channel: OrderChannel; fulfillment_type: FulfillmentType;
  sender_name: string; sender_phone: string; recipient_name: string; recipient_phone: string;
  ward_name: string | null; delivery_address: string | null; delivery_date: string;
  delivery_window: TimeWindow | null; notes: string | null; customer_email: string | null; source: string | null;
  subtotal: number; discount: number; shipping_fee: number; total_amount: number; vat_rate: number;
  coupon_code: string | null; payment_method: PaymentMethod; payment_status: PaymentStatus;
  fulfillment_status: FulfillmentStatus; tracking_code: string | null; admin_note: string | null; created_at: Date;
  invoice_requested: boolean; invoice_company_name: string | null; invoice_tax_code: string | null;
  invoice_address: string | null;
}
export interface AdminOrder extends AdminOrderRow { vat_amount: number; has_custom: boolean; items: AdminOrderItem[] }
export type AdminOrdersResponse = Wire<AdminOrder[]>;
// GET /api/admin/orders/delivery-sheet: one date's web orders by delivery window, and how many unpaid ZaloPay
// orders that day are left off the sheet.
export interface DeliverySheetBody { date: string; windows: Record<TimeWindow, AdminOrder[]>; pending_zalopay_count: number }
export type DeliverySheetResponse = Wire<DeliverySheetBody>;
// POST .../reverify answers the payment status ZaloPay confirmed (or the one the order already had).
export interface PaymentStatusBody { payment_status: PaymentStatus }

// The owner's two-factor login (routes/admin-auth.ts, /api/admin/me/2fa): its state, the first step's secret and QR code,
// and the one-time recovery codes. Every other answer is { success: true } or an ApiErrorBody.
export interface TwoFactorState { enabled: boolean; recovery_remaining: number }
export interface TwoFactorSetupBody { secret: string; qr: string }
export interface RecoveryCodesBody { success: true; recovery_codes: string[] }
export interface SuccessBody { success: true }

// GET /api/admin/flowers (routes/admin-flowers.ts). PATCH .../stock answers { id, stock }.
export interface AdminFlowerRow { id: number; sku: string; name: string; price: number; stock: number }

// GET /api/admin/cutoffs (routes/admin-cutoffs.ts): the deadline is a Date in the database, an ISO string on the wire.
export interface AdminCutoffRow { id: number; override_date: string; deadline: Date; note: string | null }
export type AdminCutoffsResponse = Wire<AdminCutoffRow[]>;

// GET and PATCH /api/admin/settings (routes/admin-settings.ts): the settings row, plus the campaigns for the dropdown.
export interface AdminSettingsRow {
  shop_address: string; contact_phone: string; contact_email: string; vat_rate: number;
  ring1_fee: number; ring2_fee: number; ring3_fee: number;
  style_fee_bo: number; style_fee_gio: number; style_fee_hop: number;
  active_campaign_id: number | null;
}
export interface AdminSettingsBody extends AdminSettingsRow { campaigns: { id: number; name: string }[] }

// GET /api/flowers (routes/flowers.ts): the settings page reads the wrap styles and their fees from it.
export interface FlowerStyle { key: CustomStyle; label: string; fee: number }

// GET /api/admin/stats (routes/admin-stats.ts). Money is whole đồng as numbers (the route converts the SQL bigint
// strings); a rate is null when there is nothing to divide by; funnel is null when the table is not there yet.
export interface AdminStatsBody {
  total_orders: number; total_revenue: number; paid_revenue: number; vat_total: number;
  average_order_value: number | null;
  cancelled_orders: number; cancellation_rate: number | null;
  refunded_orders: number; refunded_amount: number;
  unpaid_zalopay_orders: number; unpaid_zalopay_amount: number;
  cancelled_unrefunded_orders: number; cancelled_unrefunded_amount: number;
  status_counts: { new: number; delivering: number; delivered: number };
  top_products: { name: string; size: ProductSize | null; quantity_sold: number }[];
  source_breakdown: { source: string; order_count: number; revenue: number }[];
  channel_breakdown: { channel: string; order_count: number; revenue: number }[];
  rejection_rate: number | null;
  sold_out_today_hits: number; cutoff_hits: number; discontinued_hits: number;
  window_passed_hits: number; flower_shortage_hits: number;
  funnel: Record<string, number> | null; conversion_rate: number | null;
}

// GET /api/admin/reviews (routes/admin-reviews.ts): a row as the database returns it, the body the route
// builds from it (the route checks its reply against this type), and what the browser reads back.
export interface AdminReviewRow {
  id: number; product_id: number; product_name: string; name: string; stars: number;
  comment: string; approved: boolean; created_at: Date;
}
export interface AdminReviewsBody { counts: { pending: number; approved: number }; reviews: AdminReviewRow[] }
export type AdminReviewsResponse = Wire<AdminReviewsBody>;

// POST /api/orders/quote (pricing.ts quote(), routes/orders.ts): the cart priced by the server. The browser never
// does money maths. A line that cannot be sold carries `problem` and fewer fields; stock levels are not sent.
export type LineProblem = "unknown_product" | "unknown_size" | "external" | "invalid_custom";
export type CouponStatus = "applied" | "not_found" | "inactive" | "below_minimum" | "needs_date" | "outside_dates";
export interface QuoteFlower { flower_id: number; name: string; stems: number; price: number }
export interface QuoteLine {
  productId: number | null;
  size: ProductSize | null;
  quantity: number;
  problem: LineProblem | null;
  unitPrice: number;
  lineTotal: number;
  flowers: QuoteFlower[];
  short_flowers: string[];
  sizes: SizePrice[];
  custom?: true;
  key?: string | null;
  name?: string;
  image?: string | null;
  style?: string | null;
  style_label?: string | null;
  style_fee?: number;
  status?: ProductStatus;
  note?: string | null;
}
export interface CouponResult {
  code: string; status: CouponStatus; discount: number;
  type?: CouponType; value?: number; min_subtotal?: number;
  starts_on?: string | null; ends_on?: string | null;
}
export interface QuoteWard { id: number; name: string; ring: 1 | 2 | 3 }
export interface QuoteBody {
  lines: QuoteLine[];
  subtotal: number;
  coupon: CouponResult | null;
  discount: number;
  ward: QuoteWard | null;
  shipping_fee: number | null;
  total: number;
  vat_rate: number;
  short_flowers: string[];
}

// GET /api/products (routes/products.ts): a row of the listing. `sizes` is there only when asked for with ?sizes=1.
export type ProductType = "standard" | "external";
export interface ProductListItem {
  id: number; name: string; image: string | null; category_id: number; product_type: ProductType;
  status: ProductStatus; price: number; has_sizes: boolean; sizes?: SizePrice[];
}

// GET /api/settings (routes/settings.ts): the values pages display.
export interface PublicSettings {
  shop_address: string; contact_phone: string; contact_email: string; vat_rate: number;
  min_fee: number; max_fee: number;
}

// GET /api/orders/:token (routes/orders.ts): the order as its owner (or the counter) may see it. admin_note is never in it.
export interface PublicOrderItem {
  id: number; product_id: number | null; name: string; size: ProductSize | null; style: string; note: string | null;
  image: string | null; quantity: number; price: number;
  custom: boolean; flowers?: { name: string; stems: number }[]; style_label?: string | null;
}
export interface PublicOrder {
  order_code: string; token: string; fulfillment_type: FulfillmentType;
  sender_name: string; sender_phone: string; recipient_name: string; recipient_phone: string;
  ward_name: string | null; delivery_address: string | null; delivery_date: string;
  delivery_window: TimeWindow | null; notes: string | null; customer_email: string | null;
  subtotal: number; discount: number; shipping_fee: number; total_amount: number; vat_rate: number;
  coupon_code: string | null; payment_method: PaymentMethod; payment_status: PaymentStatus;
  fulfillment_status: FulfillmentStatus; tracking_code: string | null; created_at: Date;
  invoice_requested: boolean; invoice_company_name: string | null; invoice_tax_code: string | null;
  invoice_address: string | null; items: PublicOrderItem[];
}
export type PublicOrderResponse = Wire<PublicOrder>;
// POST /api/orders/:token/retry-zalopay-payment: a fresh QR code for an order whose first one was never made.
export interface ZaloPayQrBody { qr_data_url: string; order_url: string }

// /api/admin/pos (routes/admin-pos.ts): the counter. A sale is created at once; cash is paid, ZaloPay comes back
// with a QR code (or zalopay_error and a message when ZaloPay could not make one).
export interface PosCashSaleBody { id: number; token: string; payment_method: "cash"; total_amount: number }
export interface PosZaloPaySaleBody {
  id: number; token: string; payment_method: "zalopay"; total_amount: number;
  zalopay_error?: true; message?: string; qr_data_url?: string; order_url?: string;
}
export type PosSaleBody = PosCashSaleBody | PosZaloPaySaleBody;
export interface PosPickupItem { name: string; size: ProductSize | null; quantity: number }
export interface PosPickupRow {
  id: number; token: string; sender_name: string; sender_phone: string; recipient_name: string; recipient_phone: string;
  delivery_date: string; delivery_window: TimeWindow | null; payment_method: PaymentMethod; payment_status: PaymentStatus;
  fulfillment_status: FulfillmentStatus; total_amount: number;
}
export interface PosPickup extends PosPickupRow { items: PosPickupItem[] }

// GET /api/categories (routes/categories.ts): the listing's pills. `count` is the products that can be bought.
export interface CategoryChild { id: number; name: string; count: number }
export interface CategoryNode { id: number; name: string; count: number; children: CategoryChild[] }
// GET /api/tags (routes/tags.ts): the listing's filter chips, grouped by kind.
export interface TagGroup { kind: string; label: string; tags: { id: number; name: string }[] }
export interface TagsBody { groups: TagGroup[] }

// GET /api/campaigns/active (routes/campaigns.ts): the campaign the owner switched on, with its coupon read live
// and its products in card shape (as /api/products?sizes=1), in the order they are shown.
export interface CampaignCard {
  id: number; name: string; image: string | null; status: ProductStatus; price: number; has_sizes: boolean; sizes?: SizePrice[];
}
export interface ActiveCampaign {
  id: number; name: string; headline: string; subheadline: string | null; hero_image: string | null;
  coupon: CouponRow | null; products?: CampaignCard[];
}

// A review as the public sees it (routes/reviews.ts; nothing shows until a manager approves it), and the newest ones
// across products for the homepage.
export interface PublicReview { id: number; name: string; stars: number; comment: string; created_at: Date }
export interface LatestReview extends PublicReview { product_id: number; product_name: string }
export type LatestReviewsResponse = Wire<LatestReview[]>;

// GET /api/products/:id (routes/products.ts): one product for its page. Each size carries the flowers (and stems) one
// bouquet of that size uses; a size with no recipe (the external vase) has none.
export interface ProductDetailFlower { id: number; name: string | null; quantity: number | null }
export interface ProductDetailSize { id: number; size: ProductSize; sku: string; price: number; flowers: ProductDetailFlower[] }
export interface ProductTag { id: number; kind: string; name: string; kind_label: string }
export interface CategoryRef { id: number; name: string; parent_id: number | null; parent_name: string | null }
export interface ProductDetailBody {
  id: number; category_id: number; sku: string; name: string; short_description: string | null;
  description: string | null; image: string | null; status: ProductStatus; product_type: ProductType;
  style: string | null; external_url: string | null;
  sizes: ProductDetailSize[]; price: number; tags: ProductTag[]; images: string[]; category: CategoryRef | undefined;
}

// GET /api/products/:id/reviews (routes/reviews.ts): the approved reviews (newest first, at most 50), their count and
// average, and the limits the form enforces (the database has the same ones).
export interface ReviewSummary { count: number; average: number }
export interface ReviewLimits { name_max: number; comment_min: number; comment_max: number }
export interface ReviewsBody { summary: ReviewSummary; reviews: PublicReview[]; limits: ReviewLimits }
export type ReviewsResponse = Wire<ReviewsBody>;

// GET /api/orders/upcoming-cutoffs (routes/orders.ts): a day that closes early within the next 7 days. The deadline is
// already an ISO string.
export interface UpcomingCutoff { override_date: string; deadline: string; note: string | null }

// GET /api/flowers (routes/flowers.ts): the custom-bouquet builder's data. in_stock is yes or no, never a count.
export interface BuilderFlower { id: number; name: string; family: string; price: number; in_stock: boolean }
export interface CustomLimits { min_stems: number; max_stems: number; note_max: number }
export interface FlowersBody { flowers: BuilderFlower[]; styles: FlowerStyle[]; limits: CustomLimits }

// POST /api/orders (routes/orders.ts): the order was written. Cash and COD are done; a ZaloPay order comes back with its
// QR code and payment address, or with zalopay_error and a message when ZaloPay could not make one (the order exists).
export interface CashOrderBody { token: string; payment_method: "cod" | "cash"; total_amount: number }
export interface ZaloPayOrderBody {
  token: string; payment_method: "zalopay"; total_amount: number;
  zalopay_error?: true; message?: string; qr_data_url?: string; order_url?: string;
}
export type PlacedOrderBody = CashOrderBody | ZaloPayOrderBody;
// GET /api/orders/deadline?date=: when orders for that date close, and whether a holiday override set it.
export interface DeadlineBody { date: string; deadline: string; is_override: boolean }
// GET /api/settings/wards: the checkout's ward dropdown.
export interface Ward { id: number; name: string }
