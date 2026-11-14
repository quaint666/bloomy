// Bloomy — POS ("Bán tại quầy"): counter sales, plus the hand-over of web
// pickup orders. Employee and up (so also managers and owners).
//
// POST /api/admin/pos/orders                 — ring up a sale { items, coupon_code?,
//        sender_*, recipient_*, customer_email?, payment_method: "cash" | "zalopay" }
// POST /api/admin/pos/orders/:id/cancel      — drop an unpaid ZaloPay sale (stems go back)
// GET  /api/admin/pos/pickups                — open web pickup orders waiting to be handed over
// POST /api/admin/pos/pickups/:id/handover   — hand one over ("Đã nhận")
//
// A counter sale is written by the SAME function as a web order
// (placeOrder in orders.js), as a pickup order for today with no time window:
//  - cash:    the cashier presses "Đã thu tiền mặt" at the moment of cash and
//             flowers, so it is created already paid and handed over.
//  - ZaloPay: created pending with a QR on screen; when the payment lands
//             (IPN or the manual verify) markOrderPaid also marks it handed over.
// The screen polls GET /api/orders/:token (our own database only, no limiter) to
// see the payment arrive, and keeps the public verify/retry routes as fallback.
// An employee can only cancel an UNPAID counter sale; refunding a paid one stays
// with managers on the Orders page.

import { Router } from "express";
import { z } from "zod";
import pool = require("../db");
import { requireRole } from "./admin-auth";
import ordersRouter = require("./orders");
import { notifyOrderConfirmed } from "../email";
import type { FulfillmentStatus, FulfillmentType, OrderChannel, PaymentMethod, PaymentStatus } from "../types";
import type { PosCashSaleBody, PosPickup, PosPickupItem, PosPickupRow, PosZaloPaySaleBody } from "../shared/api-types";

const router = Router();

const requireEmployee = requireRole("employee");
const { itemsSchema, nameSchema, phoneSchema, optionalEmailSchema } = ordersRouter.schemas;

const posSchema = z.object({
  items: itemsSchema,
  coupon_code: z.string().max(40).optional().nullable(),
  sender_name: nameSchema,
  sender_phone: phoneSchema,
  recipient_name: nameSchema,
  recipient_phone: phoneSchema,
  customer_email: optionalEmailSchema,
  payment_method: z.enum(["cash", "zalopay"]),
});

router.post("/orders", requireEmployee, async (req, res, next) => {
  const parsed = posSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
  }
  const body = parsed.data;
  const isCash = body.payment_method === "cash";

  const client = await pool.connect();
  try {
    const result = await ordersRouter.placeOrder(client, {
      rules: "pos",
      channel: "pos",
      createdBy: req.admin!.id,
      initial: isCash
        ? { paymentStatus: "paid", fulfillmentStatus: "delivered" }
        : { paymentStatus: "pending", fulfillmentStatus: "new" },
      fulfillmentType: "pickup",
      items: body.items,
      couponCode: body.coupon_code,
      wardId: null,
      deliveryAddress: null,
      // Today in Vietnam, decided by the server — never by the browser's clock.
      deliveryDate: ordersRouter.todayVNDateString(),
      deliveryWindow: null,
      senderName: body.sender_name,
      senderPhone: body.sender_phone,
      recipientName: body.recipient_name,
      recipientPhone: body.recipient_phone,
      notes: null,
      customerEmail: body.customer_email,
      source: null,
      paymentMethod: body.payment_method,
      invoiceRequested: false,
    });
    if (!result.ok) return res.status(result.status).json(result.body);
    const { order, totalAmount } = result;

    if (isCash) {
      // Paid on the spot, so the receipt email (if an address was given) goes now.
      ordersRouter
        .getFullOrderForEmail(order.id)
        .then((full) => full && notifyOrderConfirmed(full))
        .catch((err) => console.error("Bloomy: POS confirmation email failed", err));
      const cash: PosCashSaleBody = { id: order.id, token: order.token, payment_method: "cash", total_amount: totalAmount };
      return res.status(201).json(cash);
    }

    const zp = await ordersRouter.startZaloPayPayment(order.id, totalAmount);
    if (!zp.ok) {
      // The sale exists (pending, stems taken): the screen offers "tạo lại mã QR" or cancel.
      const failed: PosZaloPaySaleBody = {
        id: order.id,
        token: order.token,
        payment_method: "zalopay",
        total_amount: totalAmount,
        zalopay_error: true,
        message: zp.message,
      };
      return res.status(201).json(failed);
    }
    const withQr: PosZaloPaySaleBody = {
      id: order.id,
      token: order.token,
      payment_method: "zalopay",
      total_amount: totalAmount,
      qr_data_url: zp.qr_data_url,
      order_url: zp.order_url,
    };
    return res.status(201).json(withQr);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// Cancels a counter sale that was never paid (the customer walked away from the
// QR). Only a POS order that is still "new" and unpaid; the status change and the
// stock return are one transaction, so the stems can only come back once. If the
// payment arrives late anyway, markOrderPaid still records it (paid + cancelled)
// and a manager sees that a refund is owed.
router.post("/orders/:id/cancel", requireEmployee, async (req, res, next) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: number; fulfillment_status: FulfillmentStatus }>(
      `UPDATE orders SET fulfillment_status = 'cancelled'
       WHERE id = $1 AND channel = 'pos' AND fulfillment_status = 'new' AND payment_status = 'pending'
       RETURNING id, fulfillment_status`,
      [id]
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      const exists = await pool.query("SELECT 1 FROM orders WHERE id = $1 AND channel = 'pos'", [id]);
      return res.status(exists.rows.length ? 409 : 404).json({ error: exists.rows.length ? "not_cancellable" : "order_not_found" });
    }
    await ordersRouter.returnOrderStock(client, id);
    await client.query("COMMIT");
    res.json(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// Web pickup orders still waiting at the counter (any date, oldest first), with
// what each contains. A ZaloPay one that isn't paid yet is listed but can't be
// handed over.
router.get("/pickups", requireEmployee, async (req, res, next) => {
  try {
    const { rows: orders } = await pool.query<PosPickupRow>(
      `SELECT id, token, sender_name, sender_phone, recipient_name, recipient_phone,
              delivery_date, delivery_window, payment_method, payment_status,
              fulfillment_status, total_amount
       FROM orders
       WHERE channel = 'web' AND fulfillment_type = 'pickup'
         AND fulfillment_status IN ('new', 'delivering') AND payment_status <> 'refunded'
       ORDER BY delivery_date, delivery_window, id
       LIMIT 100`
    );
    const byOrder = new Map<number, PosPickupItem[]>();
    if (orders.length > 0) {
      const { rows: items } = await pool.query<PosPickupItem & { order_id: number }>(
        `SELECT order_id, name, size, quantity FROM order_items WHERE order_id = ANY($1) ORDER BY id`,
        [orders.map((o) => o.id)]
      );
      for (const item of items) {
        if (!byOrder.has(item.order_id)) byOrder.set(item.order_id, []);
        byOrder.get(item.order_id)!.push({ name: item.name, size: item.size, quantity: item.quantity });
      }
    }
    const pickups: PosPickup[] = orders.map((o) => ({ ...o, items: byOrder.get(o.id) || [] }));
    res.json(pickups);
  } catch (err) {
    next(err);
  }
});

// "Đã nhận": straight to handed over from new or delivering (the Orders page keeps
// its two steps). A cash order is paid at the counter, so it is marked paid in the
// same update; a ZaloPay order must already be paid.
router.post("/pickups/:id/handover", requireEmployee, async (req, res, next) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: number; channel: OrderChannel; fulfillment_type: FulfillmentType; fulfillment_status: FulfillmentStatus; payment_method: PaymentMethod; payment_status: PaymentStatus }>(
      `SELECT id, channel, fulfillment_type, fulfillment_status, payment_method, payment_status
       FROM orders WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "order_not_found" });
    }
    const o = rows[0];
    if (o.channel !== "web" || o.fulfillment_type !== "pickup" || !["new", "delivering"].includes(o.fulfillment_status) || o.payment_status === "refunded") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "not_a_pickup_to_hand_over" });
    }
    if (o.payment_method === "zalopay" && o.payment_status !== "paid") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "zalopay_not_paid_yet" });
    }
    const { rows: done } = await client.query<{ id: number; fulfillment_status: FulfillmentStatus; payment_status: PaymentStatus }>(
      `UPDATE orders SET fulfillment_status = 'delivered',
         payment_status = CASE WHEN payment_method = 'cash' AND payment_status = 'pending'
                               THEN 'paid'::payment_status ELSE payment_status END
       WHERE id = $1
       RETURNING id, fulfillment_status, payment_status`,
      [id]
    );
    await client.query("COMMIT");
    res.json(done[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

export = router;
