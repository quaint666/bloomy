// Bloomy — Checkout-funnel events (anonymous).
//
// POST /api/events { session_id, event } — one row in funnel_events.
//
// Only the four browser-side events are accepted here. `order_placed` is
// deliberately NOT: it is written by POST /api/orders after the order
// commits, so a visitor can't fake a conversion by calling this route.
//
// Best-effort telemetry. The browser never waits on this and ignores the
// response, so a failure here only means one missing data point.

import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import pool = require("../db");

const router = Router();

// Its own limiter (not orders.js's orderLimiter), so event traffic can never
// eat into the budget for real orders. At most 4 events per session reach
// this route (the browser sends each once), so this is generous for a
// shared network like a classroom or the Teams demo machine.
const eventLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
});

// Exported so orders.js validates its optional session_id the same way.
const sessionIdSchema = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9-]+$/);

const eventSchema = z.object({
  session_id: sessionIdSchema,
  event: z.enum(["visit", "product_view", "add_to_cart", "checkout_view"]),
});

router.post("/", eventLimiter, async (req, res, next) => {
  const parsed = eventSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload" });
  }

  try {
    await pool.query(`INSERT INTO funnel_events (session_id, event) VALUES ($1, $2)`, [
      parsed.data.session_id,
      parsed.data.event,
    ]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export = Object.assign(router, { sessionIdSchema });
