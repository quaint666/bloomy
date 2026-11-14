// Bloomy — Product SEO panel (manager and up).
//   GET   /api/admin/seo            every product, with its health dot
//   GET   /api/admin/seo/:id        one product: its seo fields, what the page says now,
//                                   the search-result preview and the checks
//   POST  /api/admin/seo/:id/preview   the same, for fields typed but NOT saved (writes nothing)
//   PATCH /api/admin/seo/:id        save any of seo_keyword, seo_title, seo_description
//                                   ("" or null clears one: the page then uses the product's own name/description)
// The page head (render.js) and this panel use the same functions (seo.js), so the preview
// and the checks are what the page really says. Product names and descriptions are not edited here.

import { Router } from "express";
import type { Request } from "express";
import pool = require("../db");
import { requireAdmin } from "./admin-auth";
import * as seo from "../seo";
import type { SeoDetailBody, SeoListItem } from "../shared/api-types";

type SeoProduct = Parameters<typeof seo.effective>[0];

const router = Router();

const COLUMNS = "id, name, status, image, short_description, description, seo_keyword, seo_title, seo_description";

function detail(product: SeoProduct, base: string): SeoDetailBody {
  const e = seo.effective(product, base);
  return {
    product: { id: product.id, name: product.name, status: product.status, image: product.image, short_description: product.short_description, description: product.description },
    fields: { seo_keyword: product.seo_keyword, seo_title: product.seo_title, seo_description: product.seo_description },
    effective: { title: e.title, description: e.description, url: e.canonical, robots: e.robots },
    preview: seo.snippet(product, base),
    checks: seo.checks(product, base),
    health: seo.health(product, base),
  };
}

function parseId(req: Request): number | null {
  return /^\d{1,9}$/.test(String(req.params.id)) ? Number(req.params.id) : null;
}

async function loadProduct(id: number): Promise<SeoProduct | null> {
  const { rows } = await pool.query<SeoProduct>(`SELECT ${COLUMNS} FROM products WHERE id = $1`, [id]);
  return rows[0] || null;
}

router.get("/", requireAdmin, async (req, res, next) => {
  try {
    const base = seo.baseUrl(req);
    const { rows } = await pool.query<SeoProduct>(`SELECT ${COLUMNS} FROM products ORDER BY id`);
    const list: SeoListItem[] = rows.map((p) => ({ id: p.id, name: p.name, status: p.status, keyword: p.seo_keyword, health: seo.health(p, base) }));
    res.json(list);
  } catch (err) {
    next(err);
  }
});

router.get("/:id", requireAdmin, async (req, res, next) => {
  try {
    const id = parseId(req);
    const product = id && (await loadProduct(id));
    if (!product) return res.status(404).json({ error: "not_found" });
    res.json(detail(product, seo.baseUrl(req)));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/preview", requireAdmin, async (req, res, next) => {
  try {
    const id = parseId(req);
    const product = id && (await loadProduct(id));
    if (!product) return res.status(404).json({ error: "not_found" });
    const cleaned = seo.cleanFields(req.body || {});
    if (cleaned.field) return res.status(400).json({ error: "invalid_field", field: cleaned.field });
    res.json(detail({ ...product, ...cleaned.values }, seo.baseUrl(req)));
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", requireAdmin, async (req, res, next) => {
  try {
    const id = parseId(req);
    if (!id) return res.status(404).json({ error: "not_found" });
    const cleaned = seo.cleanFields(req.body || {});
    if (cleaned.field) return res.status(400).json({ error: "invalid_field", field: cleaned.field });
    const keys = Object.keys(cleaned.values) as (keyof typeof cleaned.values)[];
    if (keys.length === 0) return res.status(400).json({ error: "nothing_to_update" });
    const sets = keys.map((k, i) => `${k} = $${i + 1}`);
    const { rowCount } = await pool.query(`UPDATE products SET ${sets.join(", ")} WHERE id = $${keys.length + 1}`, [...keys.map((k) => cleaned.values[k]), id]);
    if (rowCount === 0) return res.status(404).json({ error: "not_found" });
    res.json(detail((await loadProduct(id))!, seo.baseUrl(req)));
  } catch (err) {
    next(err);
  }
});

export = router;
