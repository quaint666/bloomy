// Bloomy — Shop settings ("Cài đặt"). Owner only.
// GET   /api/admin/settings   — the single settings row
//                               (also lists the campaigns, for the dropdown)
// PATCH /api/admin/settings   — any of: shop_address, contact_phone, contact_email,
//                               vat_rate, ring1_fee, ring2_fee, ring3_fee,
//                               style_fee_bo, style_fee_gio, style_fee_hop,
//                               active_campaign_id (a campaign's id, or null = none)
//
// Orders copy the VAT rate and the shipping fee when they are placed, so a
// change here only affects NEW orders. The public pages read the address, phone,
// email and fee range through GET /api/settings (routes/settings.js).

import { Router } from "express";
import pool = require("../db");
import { requireRole } from "./admin-auth";

// The whole settings row, as COLUMNS below selects it.
interface SettingsRow {
  shop_address: string; contact_phone: string; contact_email: string; vat_rate: number;
  ring1_fee: number; ring2_fee: number; ring3_fee: number;
  style_fee_bo: number; style_fee_gio: number; style_fee_hop: number;
  active_campaign_id: number | null;
}
// `v` is a raw JSON value from req.body, of any type: each cleaner checks its own.
type Cleaner = (v: any) => unknown;

const router = Router();

const requireOwner = requireRole("owner");
const MAX_FEE = 10_000_000;

// One entry per editable field: how to clean the input, and whether it's valid.
// clean() returns the value to store, or undefined when the input is unusable.
const FIELDS: Record<string, Cleaner> = {
  shop_address: (v) => (typeof v === "string" && v.trim().length >= 5 && v.trim().length <= 200 ? v.trim() : undefined),
  // Same rule as the CHECK on settings.contact_phone: 8-12 digits (spaces and dots allowed in the input)
  contact_phone: (v) => {
    const digits = typeof v === "string" ? v.replace(/[\s.]/g, "") : "";
    return /^[0-9]{8,12}$/.test(digits) ? digits : undefined;
  },
  contact_email: (v) => {
    const email = typeof v === "string" ? v.trim().toLowerCase() : "";
    return email.length <= 254 && /^[^@ ]+@[^@ ]+\.[^@ ]+$/.test(email) ? email : undefined;
  },
  vat_rate: (v) => (Number.isInteger(v) && v >= 0 && v <= 100 ? v : undefined),
  ring1_fee: (v) => (Number.isInteger(v) && v >= 0 && v <= MAX_FEE ? v : undefined),
  ring2_fee: (v) => (Number.isInteger(v) && v >= 0 && v <= MAX_FEE ? v : undefined),
  ring3_fee: (v) => (Number.isInteger(v) && v >= 0 && v <= MAX_FEE ? v : undefined),
  // What a custom bouquet costs on top of its flowers, by style
  style_fee_bo: (v) => (Number.isInteger(v) && v >= 0 && v <= MAX_FEE ? v : undefined),
  style_fee_gio: (v) => (Number.isInteger(v) && v >= 0 && v <= MAX_FEE ? v : undefined),
  style_fee_hop: (v) => (Number.isInteger(v) && v >= 0 && v <= MAX_FEE ? v : undefined),
};
// active_campaign_id is not in FIELDS: it must also point at a campaign that
// exists, which needs a lookup (the PATCH below does it).
const COLUMNS = [...Object.keys(FIELDS), "active_campaign_id"].join(", ");

// The settings row plus the campaigns to choose from (id and name, for the dropdown).
async function readSettings(row: SettingsRow) {
  const { rows: campaigns } = await pool.query<{ id: number; name: string }>("SELECT id, name FROM campaigns ORDER BY id");
  return { ...row, campaigns };
}

router.get("/", requireOwner, async (req, res, next) => {
  try {
    const { rows } = await pool.query<SettingsRow>(`SELECT ${COLUMNS} FROM settings`);
    res.json(await readSettings(rows[0]));
  } catch (err) {
    next(err);
  }
});

router.patch("/", requireOwner, async (req, res, next) => {
  try {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [field, clean] of Object.entries(FIELDS)) {
      if (req.body[field] === undefined) continue;
      const value = clean(req.body[field]);
      if (value === undefined) return res.status(400).json({ error: "invalid_field", field });
      values.push(value);
      sets.push(`${field} = $${values.length}`);
    }
    if (req.body.active_campaign_id !== undefined) {
      const id = req.body.active_campaign_id;
      if (id !== null) {
        const exists = Number.isInteger(id) && id > 0 && (await pool.query("SELECT 1 FROM campaigns WHERE id = $1", [id])).rowCount === 1;
        if (!exists) return res.status(400).json({ error: "invalid_field", field: "active_campaign_id" });
        // Switching a campaign ON needs something to show: at least one product that can be bought.
        // Only when the choice CHANGES: the settings page sends every field each time, and saving a new
        // phone number must not fail because the campaign that is already on has run out of products.
        const { rows: now } = await pool.query<{ active_campaign_id: number | null }>("SELECT active_campaign_id FROM settings");
        if (now[0].active_campaign_id !== id) {
          const { rows: buyable } = await pool.query<{ n: number }>(
            `SELECT COUNT(*)::int AS n FROM campaign_products cp JOIN products p ON p.id = cp.product_id
             WHERE cp.campaign_id = $1 AND p.status <> 'discontinued'`,
            [id]
          );
          if (buyable[0].n === 0) return res.status(400).json({ error: "campaign_empty", field: "active_campaign_id" });
        }
      }
      values.push(id);
      sets.push(`active_campaign_id = $${values.length}`);
    }
    if (sets.length === 0) return res.status(400).json({ error: "nothing_to_update" });

    // The column names come from FIELDS above, never from the request.
    const { rows } = await pool.query<SettingsRow>(`UPDATE settings SET ${sets.join(", ")} WHERE id RETURNING ${COLUMNS}`, values);
    res.json(await readSettings(rows[0]));
  } catch (err) {
    next(err);
  }
});

export = router;
