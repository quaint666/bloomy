// Bloomy — Product Listing / Detail / Status API routes.
// GET /api/products
//   ?category=<id>        filter to one category (omit or "all" = every category).
//                          A parent category also matches its children, so
//                          "Hoa theo mùa" (5) returns the Tết/Xuân/Hè/Thu/Đông
//                          products, which sit in the child categories.
//   ?search=<term>        ILIKE match against name (exact diacritics required —
//                          no unaccent extension, see chat notes)
//   ?sort=price_asc|price_desc   omit = default order (id ASC)
//   ?featured=1           only products marked "Nổi bật" in admin (homepage)
//   ?sizes=1              also return each product's sizes [{size, price}] (POS screen)
//   ?tag=3&tag=8          tag filter: a product must carry AT LEAST ONE of the chosen
//                          tags of each kind (hồng OR tulip), and that for EVERY kind
//                          chosen (hồng-or-tulip AND đỏ). Unknown ids are ignored.
// All combine with AND — e.g. ?category=3&search=giỏ&sort=price_asc
//
// Discontinued products are never listed (listing, nav search, related
// products, homepage). Their own page still loads via GET /:id, so old
// links and bookmarks keep working.
//
// Prices live on product_sizes, not products. `price` in the response is the
// product's LOWEST size price (what the card shows as "Từ X đ"), and sorting
// uses that same number. `has_sizes` is true when the product has more than
// one size, so the card knows whether to say "Từ".
//
// GET /api/products/status?ids=1,4,9
//   Lightweight status-only lookup for Cart's discontinued-check —
//   returns just {id, status} pairs, not full rows.
//
// GET /api/products/:id
//   Full product detail for the Product Detail page, including its sizes,
//   each with the flowers (and stem counts) one bouquet of that size uses.
//   Declared AFTER /status so "/status" never matches as an :id.

import { Router } from "express";
import pool = require("../db");
import { TAG_KIND_LABELS } from "./tags";
import type { ProductStatus, SizePrice } from "../types";

type TagKind = keyof typeof TAG_KIND_LABELS;
type ProductType = "standard" | "external";
// `sizes` is added to the listing rows only when ?sizes=1, so it is optional.
interface ProductListRow {
  id: number; name: string; image: string | null; category_id: number; product_type: ProductType;
  status: ProductStatus; price: number; has_sizes: boolean; sizes?: SizePrice[];
}
interface ProductDetailRow {
  id: number; category_id: number; sku: string; name: string; short_description: string | null;
  description: string | null; image: string | null; status: ProductStatus; product_type: ProductType;
  style: string | null; external_url: string | null;
}
interface SizeFlowerRow {
  id: number; size: SizePrice["size"]; sku: string; price: number;
  flower_id: number | null; flower_name: string | null; quantity: number | null;
}
interface DetailSize { id: number; size: SizePrice["size"]; sku: string; price: number; flowers: { id: number; name: string | null; quantity: number | null }[] }
interface CategoryRef { id: number; name: string; parent_id: number | null; parent_name: string | null }
// The detail row, plus what the handler adds to it before sending.
interface ProductDetail extends ProductDetailRow {
  sizes?: DetailSize[]; price?: number;
  tags?: { id: number; kind: TagKind; name: string; kind_label: string }[];
  images?: string[]; category?: CategoryRef;
}

const router = Router();

// ?tag=3&tag=8 (or ?tag=3,8) -> [3, 8]. Anything that isn't a whole number is dropped.
function readIds(value: unknown): number[] {
  return ([] as unknown[])
    .concat(value ?? [])
    .flatMap((v) => String(v).split(","))
    .map((v) => parseInt(v, 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

router.get("/", async (req, res, next) => {
  try {
    const { category, search, sort, limit, featured } = req.query;

    let query = `SELECT p.id, p.name, p.image, p.category_id, p.product_type, p.status,
                        MIN(ps.price) AS price, COUNT(ps.id) > 1 AS has_sizes
                 FROM products p
                 JOIN product_sizes ps ON ps.product_id = p.id`;
    const conditions = ["p.status <> 'discontinued'"];
    const values: unknown[] = [];

    if (featured === "1") {
      conditions.push("p.featured");
    }

    // One EXISTS per tag kind: OR inside a kind, AND between kinds.
    const tagIds = readIds(req.query.tag);
    if (tagIds.length > 0) {
      const { rows: tagRows } = await pool.query<{ id: number; kind: string }>("SELECT id, kind FROM tags WHERE id = ANY($1)", [tagIds]);
      const idsByKind = new Map<string, number[]>();
      for (const t of tagRows) {
        if (!idsByKind.has(t.kind)) idsByKind.set(t.kind, []);
        idsByKind.get(t.kind)!.push(t.id);
      }
      for (const ids of idsByKind.values()) {
        values.push(ids);
        conditions.push(
          `EXISTS (SELECT 1 FROM product_tags pt WHERE pt.product_id = p.id AND pt.tag_id = ANY($${values.length}))`
        );
      }
    }

    if (category && category !== "all") {
      values.push(category);
      conditions.push(
        `(p.category_id = $${values.length}
          OR p.category_id IN (SELECT id FROM categories WHERE parent_id = $${values.length}))`
      );
    }

    if (search) {
      values.push(`%${search}%`);
      conditions.push(`p.name ILIKE $${values.length}`);
    }

    query += " WHERE " + conditions.join(" AND ");

    query += " GROUP BY p.id";

    if (sort === "price_asc") {
      query += " ORDER BY price ASC, p.id ASC";
    } else if (sort === "price_desc") {
      query += " ORDER BY price DESC, p.id ASC";
    } else {
      query += " ORDER BY p.id ASC";
    }

    // Optional — Listing never sends this, so its existing behavior
    // (return everything matching) is unchanged. Nav search sends
    // ?limit=5 specifically to keep its dropdown short.
    const parsedLimit = parseInt(String(limit), 10);
    if (!isNaN(parsedLimit) && parsedLimit > 0) {
      values.push(parsedLimit);
      query += ` LIMIT $${values.length}`;
    }

    const result = await pool.query<ProductListRow>(query, values);

    // ?sizes=1 adds every size of each product (the POS screen needs them; the
    // customer pages only need the lowest price above). Sizes come in
    // Nhỏ, Vừa, Lớn order.
    if (req.query.sizes === "1" && result.rows.length > 0) {
      const { rows: sizeRows } = await pool.query<SizePrice & { product_id: number }>(
        `SELECT product_id, size, price FROM product_sizes WHERE product_id = ANY($1) ORDER BY product_id, size`,
        [result.rows.map((r) => r.id)]
      );
      const byProduct = new Map<number, SizePrice[]>();
      for (const s of sizeRows) {
        if (!byProduct.has(s.product_id)) byProduct.set(s.product_id, []);
        byProduct.get(s.product_id)!.push({ size: s.size, price: s.price });
      }
      result.rows.forEach((r) => {
        r.sizes = byProduct.get(r.id) || [];
      });
    }

    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.get("/status", async (req, res, next) => {
  try {
    const { ids } = req.query;

    if (!ids) {
      return res.json([]);
    }

    // "1,4,9" -> [1, 4, 9], dropping anything that isn't a real integer
    // (bad input shouldn't 500 — it should just be excluded from the check)
    // The same reader as ?tag=, so a repeated ?ids=1&ids=2 works too (it used to answer 500).
    const idList = readIds(ids);

    if (idList.length === 0) {
      return res.json([]);
    }

    const result = await pool.query<{ id: number; status: ProductStatus }>(
      "SELECT id, status FROM products WHERE id = ANY($1)",
      [idList]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid product id" });
    }

    const result = await pool.query<ProductDetailRow>(
      `SELECT id, category_id, sku, name, short_description, description, image,
              status, product_type, style, external_url
       FROM products WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Product not found" });
    }

    const product: ProductDetail = result.rows[0];

    // One row per (size, flower). LEFT JOIN so a size with no recipe (the
    // external product) still comes back, just with no flowers. ORDER BY
    // ps.size follows the enum order: s, m, l.
    const { rows } = await pool.query<SizeFlowerRow>(
      `SELECT ps.id, ps.size, ps.sku, ps.price,
              f.id AS flower_id, f.name AS flower_name, r.quantity
       FROM product_sizes ps
       LEFT JOIN recipes r ON r.size_id = ps.id
       LEFT JOIN flowers f ON f.id = r.flower_id
       WHERE ps.product_id = $1
       ORDER BY ps.size, r.quantity DESC, f.name`,
      [id]
    );

    // Group the flat rows into sizes, each with its own flower list.
    const sizes: DetailSize[] = [];
    for (const row of rows) {
      let size = sizes[sizes.length - 1];
      if (!size || size.id !== row.id) {
        size = { id: row.id, size: row.size, sku: row.sku, price: row.price, flowers: [] };
        sizes.push(size);
      }
      if (row.flower_id !== null) {
        size.flowers.push({ id: row.flower_id, name: row.flower_name, quantity: row.quantity });
      }
    }

    product.sizes = sizes;
    // Lowest size price, same meaning as `price` in the listing response.
    product.price = Math.min(...sizes.map((s) => s.price));

    // Tags (with their group's label), the gallery photos beyond the main one,
    // and the category with its parent — what the product page's tabs show.
    const { rows: tags } = await pool.query<{ id: number; kind: TagKind; name: string }>(
      `SELECT t.id, t.kind, t.name FROM product_tags pt JOIN tags t ON t.id = pt.tag_id
       WHERE pt.product_id = $1 ORDER BY t.kind, t.name`,
      [id]
    );
    product.tags = tags.map((t) => ({ ...t, kind_label: TAG_KIND_LABELS[t.kind] }));
    const { rows: images } = await pool.query<{ image: string }>(
      `SELECT image FROM product_images WHERE product_id = $1 ORDER BY sort_order, id`,
      [id]
    );
    product.images = images.map((r) => r.image);
    const { rows: cat } = await pool.query<CategoryRef>(
      `SELECT c.id, c.name, par.id AS parent_id, par.name AS parent_name
       FROM categories c LEFT JOIN categories par ON par.id = c.parent_id WHERE c.id = $1`,
      [product.category_id]
    );
    product.category = cat[0];

    res.json(product);
  } catch (err) {
    next(err);
  }
});

export = router;
