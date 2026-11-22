// Bloomy — product tags for the listing's filter chips (public, read-only).
// GET /api/tags -> { groups: [{ kind, label, tags: [{ id, name }] }] }
// Only tags carried by at least one product that can be bought (not discontinued),
// so a chip never leads to an empty page. The group labels are defined here and
// nowhere else; GET /api/products/:id uses them too.

import { Router } from "express";
import rateLimit from "express-rate-limit";
import { SITE_LIMIT } from "./site-limit";
import pool = require("../db");
import type { TagsBody } from "../shared/api-types";

type TagKind = "flower" | "color" | "occasion";
interface TagRow { id: number; kind: TagKind; name: string }

const router = Router();
// The site-wide cap, here as well as in server.ts: CodeQL cannot follow this file's `export = Object.assign(router, ...)` to the app-wide one.
router.use(rateLimit(SITE_LIMIT));

// The order here is the order the groups are shown in (the listing's chips and the product page).
const TAG_KIND_LABELS: Record<TagKind, string> = { flower: "Loại hoa", color: "Màu sắc", occasion: "Dịp" };

// One order for tags everywhere: by group, then by name (Vietnamese alphabet), except the occasions, which run in
// calendar order (Tết first), which is the order they were added in: their ids. Peekbox links to them by name.
const KIND_RANK = Object.keys(TAG_KIND_LABELS);
const compareTags = (a: TagRow, b: TagRow): number =>
  a.kind !== b.kind ? KIND_RANK.indexOf(a.kind) - KIND_RANK.indexOf(b.kind)
  : a.kind === "occasion" ? a.id - b.id
  : a.name.localeCompare(b.name, "vi");

router.get("/", async (_req, res, next) => {
  try {
    const { rows } = await pool.query<TagRow>(
      `SELECT DISTINCT t.id, t.kind, t.name
       FROM tags t
       JOIN product_tags pt ON pt.tag_id = t.id
       JOIN products p ON p.id = pt.product_id
       WHERE p.status <> 'discontinued'`
    );
    const groups = Object.entries(TAG_KIND_LABELS)
      .map(([kind, label]) => ({
        kind,
        label,
        tags: rows.filter((r) => r.kind === kind).sort(compareTags).map(({ id, name }) => ({ id, name })),
      }))
      .filter((g) => g.tags.length > 0);
    const body: TagsBody = { groups };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

export = Object.assign(router, { TAG_KIND_LABELS, compareTags });
