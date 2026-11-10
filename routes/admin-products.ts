// Bloomy — Admin product list, status and "featured" toggles.
// GET   /api/admin/products               — every product: SKU, category, price range
//                                           over its sizes, size count, whether it has a
//                                           flower recipe, status, featured
// PATCH /api/admin/products/:id/status    — update one product's status
// PATCH /api/admin/products/:id/featured  — { featured: true|false } homepage cards
//
// Every route here is requireAdmin-gated explicitly (per the confirmed gap
// noted in fundamentals §6 — the middleware doesn't apply itself globally).

import { Router } from "express";
import pool = require("../db");
import { requireAdmin } from "./admin-auth";
import { csvSafe, sendCsv } from "./csv";
import type { ProductSize, ProductStatus } from "../types";

interface ProductAdminRow {
  id: number; sku: string; name: string; status: ProductStatus; featured: boolean;
  product_type: "standard" | "external"; category_name: string; min_price: number; max_price: number;
  size_count: number; has_recipe: boolean;
}
// COUNT(*) OVER (...) is a bigint, which node-postgres returns as a string.
interface ProductCsvRow {
  id: number; product_sku: string; size_sku: string; name: string; category: string; style: string | null;
  size: ProductSize; size_count: string; price: number; status: ProductStatus; featured: boolean;
  product_type: string; external_url: string | null;
}

const router = Router();

// How many products can be "Nổi bật" (shown on the homepage) at once. This is
// the only place the number lives: the admin page gets it with the product
// list, and the homepage just shows whatever is featured (it never counts).
const FEATURED_LIMIT = 4;

const VALID_STATUSES: ProductStatus[] = ["available", "sold_out_today", "discontinued"];

router.get("/", requireAdmin, async (req, res, next) => {
  try {
    // has_recipe: at least one size lists its flowers. External products
    // never have one; the page shows "chưa có công thức" only for standard ones.
    const result = await pool.query<ProductAdminRow>(
      `SELECT p.id, p.sku, p.name, p.status, p.featured, p.product_type, c.name AS category_name,
              MIN(ps.price) AS min_price, MAX(ps.price) AS max_price, COUNT(ps.id)::int AS size_count,
              EXISTS (SELECT 1 FROM recipes r JOIN product_sizes s2 ON s2.id = r.size_id
                      WHERE s2.product_id = p.id) AS has_recipe
       FROM products p
       JOIN categories c ON c.id = p.category_id
       JOIN product_sizes ps ON ps.product_id = p.id
       GROUP BY p.id, c.name
       ORDER BY p.id ASC`
    );
    res.json({ featured_limit: FEATURED_LIMIT, products: result.rows });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id/status", requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const { status } = req.body;

    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid product id" });
    }

    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const result = await pool.query<{ id: number; status: ProductStatus }>(
      "UPDATE products SET status = $1 WHERE id = $2 RETURNING id, status",
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// Product export for Excel/Sheets, one row per size. A single-size product has a
// blank size (it shows no size anywhere). Category is the full path, e.g.
// "Hoa theo mùa › Mùa xuân".
router.get("/products.csv", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query<ProductCsvRow>(
      `SELECT p.id, p.sku AS product_sku, ps.sku AS size_sku, p.name,
              COALESCE(parent.name || ' › ', '') || c.name AS category,
              p.style, ps.size, COUNT(*) OVER (PARTITION BY p.id) AS size_count,
              ps.price, p.status, p.featured, p.product_type, p.external_url
       FROM products p
       JOIN categories c ON c.id = p.category_id
       LEFT JOIN categories parent ON parent.id = c.parent_id
       JOIN product_sizes ps ON ps.product_id = p.id
       ORDER BY p.id, ps.size`
    );
    const SIZE_LABELS: Record<ProductSize, string> = { s: "Nhỏ", m: "Vừa", l: "Lớn" };
    const header = ["product_id", "product_sku", "size_sku", "name", "category", "style", "size", "price", "status", "featured", "product_type", "external_url"];
    const lines = [header.join(",")];
    for (const r of rows) {
      lines.push(
        [r.id, r.product_sku, r.size_sku, r.name, r.category, r.style, Number(r.size_count) > 1 ? SIZE_LABELS[r.size] : "", r.price, r.status, r.featured, r.product_type, r.external_url]
          .map(csvSafe)
          .join(",")
      );
    }
    sendCsv(res, "products", lines);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id/featured", requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const { featured } = req.body;
    if (isNaN(id)) return res.status(400).json({ error: "Invalid product id" });
    if (typeof featured !== "boolean") return res.status(400).json({ error: "Invalid featured" });

    // Ticking a box is refused once FEATURED_LIMIT products are already
    // featured (a product that is already featured stays so). The count and
    // the update are one statement, so the page greying out the boxes is a
    // convenience, not the rule — the rule holds even for a stale tab.
    const result = await pool.query<{ id: number; featured: boolean }>(
      `UPDATE products SET featured = $1
       WHERE id = $2 AND ($1 = false OR featured OR (SELECT COUNT(*) FROM products WHERE featured) < $3)
       RETURNING id, featured`,
      [featured, id, FEATURED_LIMIT]
    );
    if (result.rows.length === 0) {
      const exists = await pool.query("SELECT 1 FROM products WHERE id = $1", [id]);
      if (exists.rows.length === 0) return res.status(404).json({ error: "Product not found" });
      return res.status(409).json({ error: "featured_limit" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

export = router;
