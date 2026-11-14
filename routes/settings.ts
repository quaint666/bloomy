// Bloomy — public shop settings and the delivery ward list.
// Mounted at /api/settings in server.js. Read-only, no login.
//
// GET /api/settings        — the values pages display: shop address, hotline/Zalo
//                            number, contact email, VAT rate, and the
//                            lowest/highest delivery fee.
//                            The page renderer (render.js) puts the same values
//                            into the pages as {{tokens}}, so each value is
//                            stored once (in the settings row) instead of
//                            typed into every page. Page scripts that need the
//                            raw values (Checkout, Confirmation) call this.
// GET /api/settings/wards  — wards for Checkout's dropdown (id + name).
//                            Rings and fees stay server-side; the fee comes
//                            back from /api/orders/quote once a ward is picked.

import { Router } from "express";
import pool = require("../db");
import type { PublicSettings, Ward } from "../shared/api-types";


const router = Router();

// The one query behind both GET /api/settings and the rendered pages
// (render.js), so the two can never disagree.
async function getPublicSettings(): Promise<PublicSettings | undefined> {
  const { rows } = await pool.query<PublicSettings>(
    `SELECT shop_address, contact_phone, contact_email, vat_rate,
            LEAST(ring1_fee, ring2_fee, ring3_fee) AS min_fee,
            GREATEST(ring1_fee, ring2_fee, ring3_fee) AS max_fee
     FROM settings`
  );
  return rows[0];
}

router.get("/", async (req, res, next) => {
  try {
    const settings = await getPublicSettings();
    // No row means the seed was never loaded: say so, instead of an empty 200 that pages read as "no settings".
    if (!settings) return res.status(503).json({ error: "settings_missing" });
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

router.get("/wards", async (req, res, next) => {
  try {
    const { rows } = await pool.query<Ward>(`SELECT id, name FROM wards`);
    // Sorted here, not in SQL: Node's Vietnamese collation puts "Bà Điểm"
    // and "Bảy Hiền" where a Vietnamese reader expects them; a plain
    // ORDER BY on the database's default collation may not.
    rows.sort((a, b) => a.name.localeCompare(b.name, "vi"));
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

export = Object.assign(router, { getPublicSettings });
