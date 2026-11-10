// Bloomy — product reviews (public).
// GET  /api/products/:id/reviews   approved reviews, newest first, plus the count and
//                                  average, plus the limits the form must follow
// POST /api/products/:id/reviews   { name, stars, comment, website } — saved as NOT
//                                  approved; a manager approves it in admin
// GET  /api/reviews/latest?limit=3 the newest approved reviews across products (homepage)
//
// This is the one place customers type text that other customers then read, so:
//  - nothing shows until a manager approves it (no email or phone is collected);
//  - the lengths are enforced here and by the database (schema.sql);
//  - a hidden "website" field catches simple bots: if it is filled the request is
//    answered as a success and silently dropped;
//  - an IP can only post so many in an hour;
//  - every page puts the text in with textContent, never as markup.

import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import pool = require("../db");

interface ReviewRow { id: number; name: string; stars: number; comment: string; created_at: Date }
interface LatestReviewRow extends ReviewRow { product_id: number; product_name: string }
interface ReviewSummary { count: number; average: number }

const router = Router();

// The database has the same limits as CHECKs on reviews — change both together.
// The form reads them from GET .../reviews, so no page types a number of its own.
const REVIEW_LIMITS = { name_max: 60, comment_min: 10, comment_max: 500 };
const LATEST_MAX = 12;

const postLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
});

const reviewSchema = z.object({
  name: z.string().trim().min(1).max(REVIEW_LIMITS.name_max),
  stars: z.number().int().min(1).max(5),
  comment: z.string().trim().min(REVIEW_LIMITS.comment_min).max(REVIEW_LIMITS.comment_max),
  website: z.string().optional(), // the honeypot
});

async function productExists(id: number): Promise<boolean> {
  const { rows } = await pool.query("SELECT 1 FROM products WHERE id = $1", [id]);
  return rows.length > 0;
}

router.get("/products/:id/reviews", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || !(await productExists(id))) return res.status(404).json({ error: "Product not found" });

    const { rows: reviews } = await pool.query<ReviewRow>(
      `SELECT id, name, stars, comment, created_at FROM reviews
       WHERE product_id = $1 AND approved ORDER BY created_at DESC, id DESC LIMIT 50`,
      [id]
    );
    const { rows: summary } = await pool.query<ReviewSummary>(
      `SELECT COUNT(*)::int AS count, COALESCE(ROUND(AVG(stars), 1), 0)::float AS average
       FROM reviews WHERE product_id = $1 AND approved`,
      [id]
    );
    res.json({ summary: summary[0], reviews, limits: REVIEW_LIMITS });
  } catch (err) {
    next(err);
  }
});

router.post("/products/:id/reviews", postLimiter, async (req, res, next) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || !(await productExists(id))) return res.status(404).json({ error: "Product not found" });

    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_payload", limits: REVIEW_LIMITS });

    // A person never sees this field. A bot that fills it gets the same answer a
    // real reviewer would, and nothing is stored.
    if (parsed.data.website) return res.status(201).json({ ok: true });

    await pool.query(
      `INSERT INTO reviews (product_id, name, stars, comment) VALUES ($1, $2, $3, $4)`,
      [id, parsed.data.name, parsed.data.stars, parsed.data.comment]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get("/reviews/latest", async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 3, 1), LATEST_MAX);
    const { rows } = await pool.query<LatestReviewRow>(
      `SELECT r.id, r.name, r.stars, r.comment, r.created_at, r.product_id, p.name AS product_name
       FROM reviews r JOIN products p ON p.id = r.product_id
       WHERE r.approved AND p.status <> 'discontinued'
       ORDER BY r.created_at DESC, r.id DESC LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

export = router;
