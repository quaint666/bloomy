// Bloomy — the active campaign (public, read-only).
// GET /api/campaigns/active -> the campaign the owner switched on in Cài đặt, with
//   its coupon read LIVE from `coupons` and its products in card shape (like
//   /api/products?sizes=1), in the order they are shown:
//   { id, name, headline, subheadline, hero_image,
//     coupon: { code, type, value, min_subtotal, starts_on, ends_on, active } | null,
//     products: [{ id, name, image, status, price, has_sizes, sizes: [{ size, price }] }] }
//   404 { error: "no_active_campaign" } when none is on.
// Discontinued products are left out (the same rule as the product list). Nothing
// about the coupon is copied into the campaign, so a changed window shows at once.
// getActiveCampaign() is the one place this is read: the landing page and the
// homepage card (render.js) call it too, with { includeProducts: false } (they
// only need the wording and the coupon; the landing page's cards come from this API).

import { Router } from "express";
import pool = require("../db");
import type { CouponRow, SizePrice } from "../types";
import type { ActiveCampaign, CampaignCard } from "../shared/api-types";

interface CampaignRow {
  id: number; name: string; headline: string; subheadline: string | null;
  coupon_code: string | null; hero_image: string | null;
}
// `sizes` is filled in after the query, so it is optional until then.
type CampaignProduct = CampaignCard;
type Campaign = ActiveCampaign;

const router = Router();

async function getActiveCampaign({ includeProducts = true }: { includeProducts?: boolean } = {}): Promise<Campaign | null> {
  const { rows } = await pool.query<CampaignRow>(
    `SELECT c.id, c.name, c.headline, c.subheadline, c.hero_image, c.coupon_code
     FROM settings s JOIN campaigns c ON c.id = s.active_campaign_id`
  );
  const c = rows[0];
  if (!c) return null;

  let coupon: CouponRow | null = null;
  if (c.coupon_code) {
    const { rows: couponRows } = await pool.query<CouponRow>(
      `SELECT code, type, value, min_subtotal, starts_on, ends_on, active FROM coupons WHERE code = $1`,
      [c.coupon_code]
    );
    coupon = couponRows[0] || null;
  }

  if (!includeProducts) {
    return { id: c.id, name: c.name, headline: c.headline, subheadline: c.subheadline, hero_image: c.hero_image, coupon };
  }

  const { rows: products } = await pool.query<CampaignProduct>(
    `SELECT p.id, p.name, p.image, p.status, MIN(ps.price) AS price, COUNT(ps.id) > 1 AS has_sizes
     FROM campaign_products cp
     JOIN products p ON p.id = cp.product_id
     JOIN product_sizes ps ON ps.product_id = p.id
     WHERE cp.campaign_id = $1 AND p.status <> 'discontinued'
     GROUP BY p.id, cp.sort_order
     ORDER BY cp.sort_order, p.id`,
    [c.id]
  );
  if (products.length > 0) {
    const { rows: sizeRows } = await pool.query<SizePrice & { product_id: number }>(
      `SELECT product_id, size, price FROM product_sizes WHERE product_id = ANY($1) ORDER BY product_id, size`,
      [products.map((p) => p.id)]
    );
    const byProduct = new Map<number, SizePrice[]>();
    for (const s of sizeRows) {
      if (!byProduct.has(s.product_id)) byProduct.set(s.product_id, []);
      byProduct.get(s.product_id)!.push({ size: s.size, price: s.price });
    }
    products.forEach((p) => {
      p.sizes = byProduct.get(p.id) || [];
    });
  }

  return { id: c.id, name: c.name, headline: c.headline, subheadline: c.subheadline, hero_image: c.hero_image, coupon, products };
}

router.get("/active", async (req, res, next) => {
  try {
    const campaign = await getActiveCampaign();
    if (!campaign) return res.status(404).json({ error: "no_active_campaign" });
    res.json(campaign);
  } catch (err) {
    next(err);
  }
});

export = Object.assign(router, { getActiveCampaign });
