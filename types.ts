// Bloomy — the database's enum types as TypeScript unions, and the row shapes that more than one
// module reads, so each has a single name. schema.sql is the source of truth: when something there
// changes, change it here in the same commit. Nothing checks that the two agree.
import type { Pool } from "pg";
import type {} from "express-session"; // loads its types, so the augmentation below has something to extend
import type {
  AdminRole, AdminUser, CouponRow, CouponType, CustomStyle, FulfillmentStatus, FulfillmentType, OrderChannel,
  PaymentMethod, PaymentStatus, ProductSize, ProductStatus, SizePrice, TimeWindow,
} from "./shared/api-types";

// These are written in shared/api-types.ts, because the browser reads them too.
export type {
  AdminRole, AdminUser, CouponRow, CouponType, CustomStyle, FulfillmentStatus, FulfillmentType, OrderChannel,
  PaymentMethod, PaymentStatus, ProductSize, ProductStatus, SizePrice, TimeWindow,
};

// Either the pool or a client inside a transaction: both have the same .query().
export type Queryable = Pick<Pool, "query">;

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
