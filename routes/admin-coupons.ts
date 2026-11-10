// Bloomy — Coupons ("Mã giảm giá"). Manager and up.
// GET   /api/admin/coupons        — every coupon
// POST  /api/admin/coupons        — create { code, type, value, min_subtotal?, starts_on?, ends_on? }
// PATCH /api/admin/coupons/:id    — { active?, starts_on?, ends_on? } (null clears a date)
//
// What a coupon IS (code, type, value, minimum order) is locked once created:
// a manager can switch it off or move its dates, but can't quietly change what
// a code is worth. To change the value, make a new code. Coupons are never
// deleted — an order keeps only the code text, so the row is the only record of
// what that code was. Dates are inclusive and checked against the DELIVERY date
// (see pricing.js).

import { Router } from "express";
import pool = require("../db");
import { requireAdmin } from "./admin-auth";
import { normalizeCouponCode } from "../pricing";
import { isRealDate } from "./dates";
import type { CouponRow } from "../types";

interface CouponAdminRow extends CouponRow { id: number }

const router = Router();

// Same rule as the CHECK on coupons.code in schema.sql — change both together.
const COUPON_CODE_MIN = 3;
const COUPON_CODE_MAX = 20;
const COUPON_CODE_PATTERN = new RegExp(`^[A-Z0-9_-]{${COUPON_CODE_MIN},${COUPON_CODE_MAX}}$`);
const MAX_AMOUNT = 100_000_000;

// undefined = not sent, null = clear it, string = a real date, false = invalid
function readDate(value: unknown): string | null | undefined | false {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return isRealDate(value) ? (value as string) : false; // isRealDate has checked it is a string
}

const COLUMNS = "id, code, type, value, min_subtotal, starts_on, ends_on, active";

router.get("/", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query<CouponAdminRow>(`SELECT ${COLUMNS} FROM coupons ORDER BY active DESC, id DESC`);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post("/", requireAdmin, async (req, res, next) => {
  try {
    const code = normalizeCouponCode(req.body.code);
    const { type, value } = req.body;
    const minSubtotal = req.body.min_subtotal === undefined || req.body.min_subtotal === "" ? 0 : req.body.min_subtotal;
    const startsOn = readDate(req.body.starts_on);
    const endsOn = readDate(req.body.ends_on);

    if (!code || !COUPON_CODE_PATTERN.test(code)) return res.status(400).json({ error: "invalid_code", min: COUPON_CODE_MIN, max: COUPON_CODE_MAX });
    if (type !== "fixed" && type !== "percent") return res.status(400).json({ error: "invalid_type" });
    const maxValue = type === "percent" ? 100 : MAX_AMOUNT;
    if (!Number.isInteger(value) || value < 1 || value > maxValue) return res.status(400).json({ error: "invalid_value", max: maxValue });
    if (!Number.isInteger(minSubtotal) || minSubtotal < 0 || minSubtotal > MAX_AMOUNT) return res.status(400).json({ error: "invalid_min_subtotal" });
    if (startsOn === false || endsOn === false) return res.status(400).json({ error: "invalid_date" });
    if (startsOn && endsOn && startsOn > endsOn) return res.status(400).json({ error: "invalid_dates" });

    try {
      const { rows } = await pool.query<CouponAdminRow>(
        `INSERT INTO coupons (code, type, value, min_subtotal, starts_on, ends_on)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
        [code, type, value, minSubtotal, startsOn ?? null, endsOn ?? null]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return res.status(409).json({ error: "code_taken" });
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });

    const { active } = req.body;
    const startsOn = readDate(req.body.starts_on);
    const endsOn = readDate(req.body.ends_on);
    if (active === undefined && startsOn === undefined && endsOn === undefined) {
      return res.status(400).json({ error: "nothing_to_update" });
    }
    if (active !== undefined && typeof active !== "boolean") return res.status(400).json({ error: "invalid_active" });
    if (startsOn === false || endsOn === false) return res.status(400).json({ error: "invalid_date" });

    try {
      // Each column changes only when it was sent ($2/$4/$6 say which).
      const { rows } = await pool.query<CouponAdminRow>(
        `UPDATE coupons SET
           active    = CASE WHEN $2 THEN $3 ELSE active END,
           starts_on = CASE WHEN $4 THEN $5::date ELSE starts_on END,
           ends_on   = CASE WHEN $6 THEN $7::date ELSE ends_on END
         WHERE id = $1
         RETURNING ${COLUMNS}`,
        [id, active !== undefined, active ?? null, startsOn !== undefined, startsOn ?? null, endsOn !== undefined, endsOn ?? null]
      );
      if (rows.length === 0) return res.status(404).json({ error: "coupon_not_found" });
      res.json(rows[0]);
    } catch (err) {
      if ((err as { code?: string }).code === "23514") return res.status(400).json({ error: "invalid_dates" }); // starts after it ends
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

export = router;
