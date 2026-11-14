// Bloomy — product tags for the listing's filter chips (public, read-only).
// GET /api/tags -> { groups: [{ kind, label, tags: [{ id, name }] }] }
// Only tags carried by at least one product that can be bought (not discontinued),
// so a chip never leads to an empty page. The group labels are defined here and
// nowhere else; GET /api/products/:id uses them too.

import { Router } from "express";
import pool = require("../db");
import type { TagsBody } from "../shared/api-types";

type TagKind = "flower" | "color";
interface TagRow { id: number; kind: TagKind; name: string }

const router = Router();

const TAG_KIND_LABELS: Record<TagKind, string> = { flower: "Loại hoa", color: "Màu sắc" };

router.get("/", async (req, res, next) => {
  try {
    const { rows } = await pool.query<TagRow>(
      `SELECT DISTINCT t.id, t.kind, t.name
       FROM tags t
       JOIN product_tags pt ON pt.tag_id = t.id
       JOIN products p ON p.id = pt.product_id
       WHERE p.status <> 'discontinued'`
    );
    const vi = (a: TagRow, b: TagRow) => a.name.localeCompare(b.name, "vi");
    const groups = Object.entries(TAG_KIND_LABELS)
      .map(([kind, label]) => ({
        kind,
        label,
        tags: rows.filter((r) => r.kind === kind).sort(vi).map(({ id, name }) => ({ id, name })),
      }))
      .filter((g) => g.tags.length > 0);
    const body: TagsBody = { groups };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

export = Object.assign(router, { TAG_KIND_LABELS });
