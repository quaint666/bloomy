// Bloomy — Admin flower stock ("Kho hoa").
// GET   /api/admin/flowers            — every flower with its price and stock
// PATCH /api/admin/flowers/:id/stock  — { delta } add (+) or remove (−) stems
//
// Stock is the stems the shop has on hand. Orders take stems when placed;
// cancelling an order while it's still "new" gives them back (see
// admin-orders.js). Everything else — a delivery, waste, a recount — is
// corrected here by hand. The database refuses stock below 0, and the
// UPDATE below checks first so the admin gets a clear error instead.

import { Router } from "express";
import pool = require("../db");
import { requireAdmin } from "./admin-auth";

interface FlowerStockRow { id: number; sku: string; name: string; price: number; stock: number }

const router = Router();

router.get("/", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query<FlowerStockRow>(
      `SELECT id, sku, name, price, stock FROM flowers ORDER BY name`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id/stock", requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const { delta } = req.body;
    if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 10000) {
      return res.status(400).json({ error: "invalid_delta" });
    }

    // Relative update (stock + delta), not "set to N": two admins adjusting
    // at once both count, instead of the second overwriting the first.
    const { rows } = await pool.query<{ id: number; stock: number }>(
      `UPDATE flowers SET stock = stock + $1
       WHERE id = $2 AND stock + $1 >= 0
       RETURNING id, stock`,
      [delta, id]
    );
    if (rows.length === 0) {
      const exists = await pool.query(`SELECT 1 FROM flowers WHERE id = $1`, [id]);
      if (exists.rows.length === 0) return res.status(404).json({ error: "flower_not_found" });
      return res.status(409).json({ error: "below_zero" });
    }
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

export = router;
