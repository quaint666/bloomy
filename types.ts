// Bloomy — the database's enum types as TypeScript unions, and the row shapes that more than one
// module reads, so each has a single name. schema.sql is the source of truth: when something there
// changes, change it here in the same commit. Nothing checks that the two agree.
import type { Pool } from "pg";
import type {} from "express-session"; // loads its types, so the augmentation below has something to extend

export type ProductSize = "s" | "m" | "l";
export type ProductStatus = "available" | "sold_out_today" | "discontinued";
export type OrderChannel = "web" | "pos";
export type FulfillmentType = "delivery" | "pickup";
export type PaymentMethod = "cod" | "zalopay" | "cash";
export type PaymentStatus = "pending" | "paid" | "failed" | "refunded";
export type FulfillmentStatus = "new" | "delivering" | "delivered" | "cancelled";
export type TimeWindow = "morning" | "afternoon" | "evening";
export type CouponType = "fixed" | "percent";
export type CustomStyle = "bo" | "gio" | "hop"; // the wrap styles of a custom bouquet (pricing.ts holds their labels)

// A row of coupons. Dates are "YYYY-MM-DD" strings (db.ts).
export interface CouponRow {
  code: string; type: CouponType; value: number; min_subtotal: number;
  starts_on: string | null; ends_on: string | null; active: boolean;
}

// One size of a product and its price, as the listing, the campaign and the quote return it.
export interface SizePrice { size: ProductSize; price: number }

export type AdminRole = "owner" | "manager" | "employee";

// Either the pool or a client inside a transaction: both have the same .query().
export type Queryable = Pick<Pool, "query">;

// The logged-in account, as requireRole() reads it from admin_users on every request.
export interface AdminUser { id: number; username: string; role: AdminRole; active: boolean }

// What a session holds (express-session), and what requireRole() puts on the request.
declare module "express-session" {
  interface SessionData { adminId?: number; pendingTotp?: string }
}
declare global {
  namespace Express {
    // Set by requireRole(); present only on routes behind it, hence optional.
    interface Request { admin?: AdminUser }
  }
}
