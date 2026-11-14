// Bloomy — the custom-bouquet builder's data (public, read-only).
// GET /api/flowers  ->  { flowers, styles, limits }
//   flowers: every flower with its price per stem and whether it's in stock.
//            Never the stock COUNT — only yes/no, so out-of-stock ones can be
//            greyed out without telling anyone how many stems the shop holds.
//   styles:  the wrap styles with their fees (from Cài đặt).
//   limits:  min/max stems and the note length (from pricing.js).
// The page builds itself from this, so it types no price, fee or limit of its own.
// The price of an actual bouquet always comes from POST /api/orders/quote.

import { Router } from "express";
import pool = require("../db");
import { CUSTOM_LIMITS, CUSTOM_STYLE_LABELS } from "../pricing";
import type { CustomStyle } from "../types";
import type { BuilderFlower, FlowersBody, FlowerStyle } from "../shared/api-types";

interface StyleFees { style_fee_bo: number; style_fee_gio: number; style_fee_hop: number }

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const { rows } = await pool.query<BuilderFlower>(
      `SELECT id, name, family, price, stock > 0 AS in_stock FROM flowers`
    );
    // Vietnamese alphabetical order in Node (the database's collation may not
    // put "Cẩm chướng" or "Hướng dương" where a Vietnamese reader expects them).
    const vi = (a: string, b: string) => a.localeCompare(b, "vi");
    rows.sort((a, b) => vi(a.family, b.family) || vi(a.name, b.name));

    const { rows: settings } = await pool.query<StyleFees>(
      `SELECT style_fee_bo, style_fee_gio, style_fee_hop FROM settings`
    );
    if (settings.length === 0) return res.status(503).json({ error: "settings_missing" });
    // Object.entries loses the key type: these keys are exactly the CustomStyle values.
    const styles: FlowerStyle[] = (Object.entries(CUSTOM_STYLE_LABELS) as [CustomStyle, string][]).map(([key, label]) => ({
      key,
      label,
      fee: settings[0][`style_fee_${key}` as const],
    }));
    const body: FlowersBody = { flowers: rows, styles, limits: CUSTOM_LIMITS };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

export = router;
