// Bloomy — the category tree for the listing's pills (public, read-only).
// GET /api/categories -> [{ id, name, count, children: [{ id, name, count }] }]
// `count` is the number of products that can be bought (not discontinued). A
// category with none is left out, so a pill never leads to an empty page. Only
// "Hoa theo mùa" has children (Tết, Xuân, Hè, Thu, Đông).
// getCategoryTree() holds that rule once: the route below and the footer's
// "Danh mục" list (render.js) both call it, so they cannot disagree.

import { Router } from "express";
import pool = require("../db");

interface CategoryRow { id: number; name: string; parent_id: number | null; count: number }
interface CategoryChild { id: number; name: string; count: number }
interface CategoryParent { id: number; name: string; own: number; children: CategoryChild[] }
interface CategoryNode { id: number; name: string; count: number; children: CategoryChild[] }

const router = Router();

async function getCategoryTree(): Promise<CategoryNode[]> {
  const { rows } = await pool.query<CategoryRow>(
      `SELECT c.id, c.name, c.parent_id,
              COUNT(p.id) FILTER (WHERE p.status <> 'discontinued')::int AS count
       FROM categories c LEFT JOIN products p ON p.category_id = c.id
       GROUP BY c.id ORDER BY c.id`
  );
  const parents = rows
    .filter((r) => r.parent_id === null)
    .map((r): CategoryParent => ({ id: r.id, name: r.name, own: r.count, children: [] }));
  const byId = new Map<number, CategoryParent>(parents.map((p) => [p.id, p]));
  rows
    .filter((r) => r.parent_id !== null && r.count > 0)
    .forEach((r) => byId.get(r.parent_id!)?.children.push({ id: r.id, name: r.name, count: r.count }));
  return parents
    .map((p) => ({ id: p.id, name: p.name, count: p.own + p.children.reduce((sum, c) => sum + c.count, 0), children: p.children }))
    .filter((p) => p.count > 0);
}

router.get("/", async (req, res, next) => {
  try {
    res.json(await getCategoryTree());
  } catch (err) {
    next(err);
  }
});

export = Object.assign(router, { getCategoryTree });
