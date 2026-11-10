// Bloomy — Campaign editor (manager and up): what the landing page of an occasion says and shows.
//   GET    /api/admin/campaigns            every campaign (name, coupon, image, how many products, is it on)
//   GET    /api/admin/campaigns/options    what the editor can choose from: coupons, images, products
//   GET    /api/admin/campaigns/:id        one campaign with its products in their shown order
//   POST   /api/admin/campaigns            create  { name, headline, subheadline?, coupon_code?, hero_image?, product_ids? }
//   PATCH  /api/admin/campaigns/:id        change any of those (product_ids replaces the whole list, in order)
//   DELETE /api/admin/campaigns/:id        remove one (refused while it is the campaign that is on)
// Switching a campaign ON stays the owner's choice in Cài đặt (routes/admin-settings.js).
//
// Images are CHOSEN, not uploaded: the editor offers the picture files already in public/images/
// (BLOOMY_IMAGES_DIR overrides the folder, for tests). A new picture is added the way product
// pictures are — into the repo, optimised, deployed — so this app still never writes to disk and
// there is no upload code to attack. The server accepts only a file that is in that list.

import { Router } from "express";
import type { Request } from "express";
import fs from "fs";
import path from "path";
import type { PoolClient } from "pg";
import pool = require("../db");
import { requireAdmin } from "./admin-auth";
import type { ProductStatus } from "../types";

// What the editor may set. Only the fields that were sent are present.
interface CampaignValues {
  name?: string; headline?: string; subheadline?: string | null;
  coupon_code?: string | null; hero_image?: string | null; product_ids?: number[];
}
type Cleaned = { values: CampaignValues; field?: undefined } | { field: keyof CampaignValues; values?: undefined };
interface CampaignProduct { id: number; name: string; status: ProductStatus; image: string | null }
interface CampaignDetail {
  id: number; name: string; headline: string; subheadline: string | null; coupon_code: string | null;
  hero_image: string | null; active: boolean; products: CampaignProduct[];
}

const router = Router();

const IMAGES_DIR = process.env.BLOOMY_IMAGES_DIR || path.join(__dirname, "..", "public", "images");
const IMAGE_RE = /\.(webp|jpe?g|png)$/i;
const NOT_HERO_RE = /^(og-image|favicon|apple-touch-icon)|logo/i; // site furniture, not a picture for a page
const LIMITS = { name: 80, headline: 120, subheadline: 200, products: 12 };

const norm = (s: unknown): string => String(s).normalize("NFC").replace(/\s+/g, " ").trim();
const len = (s: string): number => [...s].length;

// "images/<file>" for every picture the editor may offer; the campaign ones first.
async function listImages(): Promise<string[]> {
  let names: string[];
  try {
    // Files only: a folder that happens to be called x.webp is not a picture.
    names = (await fs.promises.readdir(IMAGES_DIR, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const own = (n: string) => /^(campaign|landing|hero)-/i.test(n);
  return names
    .filter((n) => IMAGE_RE.test(n) && !NOT_HERO_RE.test(n))
    .sort((a, b) => (own(a) === own(b) ? a.localeCompare(b) : own(a) ? -1 : 1))
    .map((n) => `images/${n}`);
}

const parseId = (req: Request): number | null => (/^\d{1,9}$/.test(String(req.params.id)) ? Number(req.params.id) : null);

// Checks the request body. Returns { values } holding only what was sent (text trimmed, "" -> null where
// that is allowed) or { field } naming the first thing wrong. `creating`: name and headline are required.
// `body` is the raw JSON from req.body: every field is checked below before it is stored.
async function clean(body: Record<string, any>, creating: boolean): Promise<Cleaned> {
  const values: CampaignValues = {};
  // A text field. Returns the field's name when it is wrong, null when it is fine (or not sent).
  const text = (key: "name" | "headline" | "subheadline", max: number, required: boolean): keyof CampaignValues | null => {
    const raw = body[key];
    if (raw === undefined) return required && creating ? key : null; // not sent: only a problem when creating
    if (raw !== null && typeof raw !== "string") return key;
    if (typeof raw === "string" && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) return key;
    const v = raw === null ? "" : norm(raw);
    if (v === "") {
      if (required) return key; // name and headline can never be blank
      (values as Record<string, string | null>)[key] = null; // the optional subheadline: blank clears it
      return null;
    }
    if (len(v) > max) return key;
    values[key] = v;
    return null;
  };
  for (const bad of [text("name", LIMITS.name, true), text("headline", LIMITS.headline, true), text("subheadline", LIMITS.subheadline, false)]) {
    if (bad) return { field: bad };
  }

  if (body.coupon_code !== undefined) {
    if (body.coupon_code === null || body.coupon_code === "") values.coupon_code = null;
    else {
      if (typeof body.coupon_code !== "string") return { field: "coupon_code" };
      const { rowCount } = await pool.query("SELECT 1 FROM coupons WHERE code = $1", [body.coupon_code]);
      if (rowCount !== 1) return { field: "coupon_code" };
      values.coupon_code = body.coupon_code;
    }
  }

  if (body.hero_image !== undefined) {
    if (body.hero_image === null || body.hero_image === "") values.hero_image = null;
    else {
      if (typeof body.hero_image !== "string" || !(await listImages()).includes(body.hero_image)) return { field: "hero_image" };
      values.hero_image = body.hero_image;
    }
  }

  if (body.product_ids !== undefined) {
    const ids = body.product_ids;
    if (!Array.isArray(ids) || ids.length > LIMITS.products || !ids.every((n) => Number.isInteger(n) && n > 0) || new Set(ids).size !== ids.length) return { field: "product_ids" };
    if (ids.length > 0) {
      const { rows } = await pool.query("SELECT id FROM products WHERE id = ANY($1)", [ids]);
      if (rows.length !== ids.length) return { field: "product_ids" };
    }
    values.product_ids = ids;
  }
  return { values };
}

async function detail(id: number): Promise<CampaignDetail | null> {
  const { rows } = await pool.query<Omit<CampaignDetail, "products" | "active"> & { active: boolean | null }>(
    `SELECT c.id, c.name, c.headline, c.subheadline, c.coupon_code, c.hero_image,
            (s.active_campaign_id = c.id) AS active
     FROM campaigns c CROSS JOIN settings s WHERE c.id = $1`,
    [id]
  );
  if (!rows[0]) return null;
  const { rows: products } = await pool.query<CampaignProduct>(
    `SELECT p.id, p.name, p.status, p.image
     FROM campaign_products cp JOIN products p ON p.id = cp.product_id
     WHERE cp.campaign_id = $1 ORDER BY cp.sort_order, p.id`,
    [id]
  );
  return { ...rows[0], active: rows[0].active === true, products };
}

router.get("/", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.headline, c.coupon_code, c.hero_image,
              (SELECT COUNT(*) FROM campaign_products cp WHERE cp.campaign_id = c.id)::int AS product_count,
              (s.active_campaign_id = c.id) AS active
       FROM campaigns c CROSS JOIN settings s ORDER BY c.id`
    );
    res.json(rows.map((r) => ({ ...r, active: r.active === true })));
  } catch (err) {
    next(err);
  }
});

router.get("/options", requireAdmin, async (req, res, next) => {
  try {
    const [coupons, products, images] = await Promise.all([
      pool.query("SELECT code, type, value, min_subtotal, starts_on, ends_on, active FROM coupons ORDER BY code"),
      pool.query("SELECT id, name, status, image FROM products ORDER BY id"),
      listImages(),
    ]);
    res.json({ coupons: coupons.rows, products: products.rows, images, limits: LIMITS });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", requireAdmin, async (req, res, next) => {
  try {
    const id = parseId(req);
    const campaign = id && (await detail(id));
    if (!campaign) return res.status(404).json({ error: "not_found" });
    res.json(campaign);
  } catch (err) {
    next(err);
  }
});

// Writes the campaign row and (when product_ids was sent) its product list, in one transaction.
async function save(client: PoolClient, id: number, values: CampaignValues): Promise<void> {
  const cols = (["name", "headline", "subheadline", "coupon_code", "hero_image"] as const).filter((k) => k in values);
  if (cols.length) await client.query(`UPDATE campaigns SET ${cols.map((k, i) => `${k} = $${i + 1}`).join(", ")} WHERE id = $${cols.length + 1}`, [...cols.map((k) => values[k]), id]);
  if (values.product_ids) {
    await client.query("DELETE FROM campaign_products WHERE campaign_id = $1", [id]);
    for (let i = 0; i < values.product_ids.length; i++) {
      await client.query("INSERT INTO campaign_products (campaign_id, product_id, sort_order) VALUES ($1, $2, $3)", [id, values.product_ids[i], i + 1]);
    }
  }
}

router.post("/", requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const cleaned = await clean(req.body || {}, true);
    if (cleaned.field) return res.status(400).json({ error: "invalid_field", field: cleaned.field });
    const v = cleaned.values;
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: number }>(
      "INSERT INTO campaigns (name, headline, subheadline, coupon_code, hero_image) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [v.name, v.headline, v.subheadline ?? null, v.coupon_code ?? null, v.hero_image ?? null]
    );
    await save(client, rows[0].id, { product_ids: v.product_ids || [] });
    await client.query("COMMIT");
    res.status(201).json(await detail(rows[0].id));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.patch("/:id", requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = parseId(req);
    if (!id || !(await detail(id))) return res.status(404).json({ error: "not_found" });
    const cleaned = await clean(req.body || {}, false);
    if (cleaned.field) return res.status(400).json({ error: "invalid_field", field: cleaned.field });
    if (Object.keys(cleaned.values).length === 0) return res.status(400).json({ error: "nothing_to_update" });
    await client.query("BEGIN");
    await save(client, id, cleaned.values);
    await client.query("COMMIT");
    res.json(await detail(id));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    const id = parseId(req);
    const campaign = id && (await detail(id));
    if (!campaign) return res.status(404).json({ error: "not_found" });
    if (campaign.active) return res.status(409).json({ error: "campaign_active" });
    await pool.query("DELETE FROM campaigns WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export = Object.assign(router, { listImages, LIMITS });
