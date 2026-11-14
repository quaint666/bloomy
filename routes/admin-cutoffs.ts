// Bloomy — Admin cutoff overrides (holiday/peak-day early deadlines).
//
// GET    /api/admin/cutoffs      — list all overrides, soonest date first
// POST   /api/admin/cutoffs      — create or replace the override for a date (upsert)
// DELETE /api/admin/cutoffs/:id  — remove an override (that date reverts to the default 14:00 rule)

import { Router } from "express";
import pool = require("../db");
import { requireAdmin } from "./admin-auth";
import { z } from "zod";
import { isRealDate } from "./dates";
import type { AdminCutoffRow } from "../shared/api-types";

const router = Router();

const overrideSchema = z.object({
  override_date: z.string().refine(isRealDate, "invalid_date"),
  // <input type="datetime-local"> sends a value with no timezone attached
  // ("2026-02-13T20:00") — always interpreted as Vietnam time (+07:00)
  // below, never the VPS's own (UTC) clock.
  deadline_local: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  note: z.string().trim().max(100).optional().nullable(),
});

router.get("/", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query<AdminCutoffRow>(
      `SELECT id, override_date, deadline, note FROM cutoff_overrides ORDER BY override_date`
    );
    // override_date now comes back as a plain "YYYY-MM-DD" string directly
    // (see db.js's type-parser override) — no per-row mapping needed.
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post("/", requireAdmin, async (req, res, next) => {
  const parsed = overrideSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
  }
  const { override_date, deadline_local, note } = parsed.data;
  const deadlineWithOffset = `${deadline_local}:00+07:00`; // append seconds + the fixed VN offset

  // An override exists to close a date EARLIER than the default 14:00 VN
  // rule — never later. Extending past the default is a different thing
  // (an informal "sure, we'll still take it" over the phone/Zalo), not
  // something the public checkout promise should silently grant through
  // this same mechanism — see chat notes. 14:00 +07:00 == 07:00 UTC on
  // the delivery date itself, same arithmetic as routes/orders.js's own
  // default-deadline computation.
  const defaultDeadline = new Date(`${override_date}T07:00:00.000Z`);
  if (new Date(deadlineWithOffset).getTime() >= defaultDeadline.getTime()) {
    return res.status(400).json({ error: "deadline_not_earlier_than_default" });
  }

  try {
    const { rows } = await pool.query<AdminCutoffRow>(
      `INSERT INTO cutoff_overrides (override_date, deadline, note)
       VALUES ($1, $2, $3)
       ON CONFLICT (override_date) DO UPDATE SET deadline = EXCLUDED.deadline, note = EXCLUDED.note
       RETURNING id, override_date, deadline, note`,
      [override_date, deadlineWithOffset, note || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });

    const { rows } = await pool.query(`DELETE FROM cutoff_overrides WHERE id = $1 RETURNING id`, [id]);
    if (rows.length === 0) return res.status(404).json({ error: "not_found" });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

export = router;
