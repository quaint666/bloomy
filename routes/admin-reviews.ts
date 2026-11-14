// Bloomy — Review approval ("Đánh giá"). Manager and up.
// GET    /api/admin/reviews?status=pending|approved   all by default, waiting ones first
// PATCH  /api/admin/reviews/:id   { approved: true|false }   approve, or hide again
// DELETE /api/admin/reviews/:id   remove (spam)
// A review only shows on the site while approved is true. "Chờ duyệt" and "đã ẩn"
// are the same state (not approved), which is why there is one switch, not two.

import { Router } from "express";
import pool = require("../db");
import { requireAdmin } from "./admin-auth";
import type { AdminReviewRow, AdminReviewsBody } from "../shared/api-types";

const router = Router();

router.get("/", requireAdmin, async (req, res, next) => {
  try {
    const status = req.query.status;
    const where = status === "pending" ? "WHERE NOT r.approved" : status === "approved" ? "WHERE r.approved" : "";
    const { rows: reviews } = await pool.query<AdminReviewRow>(
      `SELECT r.id, r.product_id, p.name AS product_name, r.name, r.stars, r.comment, r.approved, r.created_at
       FROM reviews r JOIN products p ON p.id = r.product_id
       ${where}
       ORDER BY r.approved, r.created_at DESC, r.id DESC LIMIT 200`
    );
    const { rows: counts } = await pool.query<{ pending: number; approved: number }>(
      `SELECT COUNT(*) FILTER (WHERE NOT approved)::int AS pending, COUNT(*) FILTER (WHERE approved)::int AS approved FROM reviews`
    );
    const body: AdminReviewsBody = { counts: counts[0], reviews };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });
    if (typeof req.body.approved !== "boolean") return res.status(400).json({ error: "invalid_approved" });
    const { rows } = await pool.query<{ id: number; approved: boolean }>("UPDATE reviews SET approved = $2 WHERE id = $1 RETURNING id, approved", [id, req.body.approved]);
    if (rows.length === 0) return res.status(404).json({ error: "review_not_found" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });
    const { rowCount } = await pool.query("DELETE FROM reviews WHERE id = $1", [id]);
    if (rowCount === 0) return res.status(404).json({ error: "review_not_found" });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

export = router;
