// Bloomy — rules the server and the browser both apply, written once (runtime code, unlike api-types.ts: the server
// compiles it to shared/rules.js, esbuild bundles it into each page script that imports it). The server is still the
// one that enforces them; the browser copies only shape what it offers.
import type { AdminRole, FulfillmentStatus, TimeWindow } from "./api-types";

// The most of one line an order may hold. The order route refuses more, so the cart, the POS ticket, the product
// page and the custom-bouquet builder never go above it.
export const MAX_QUANTITY = 99;

// An admin page or route needs at least this rank.
export const ROLE_RANK: Record<AdminRole, number> = { employee: 1, manager: 2, owner: 3 };

// Which fulfilment status an order may move to from each status. delivered and cancelled are both terminal.
export const ALLOWED_FULFILLMENT_TRANSITIONS: Record<FulfillmentStatus, FulfillmentStatus[]> = {
  new: ["delivering", "cancelled"],
  delivering: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
};

// True when a value read from a request is one of the fulfilment statuses.
export const isFulfillmentStatus = (value: unknown): value is FulfillmentStatus =>
  typeof value === "string" && Object.hasOwn(ALLOWED_FULFILLMENT_TRANSITIONS, value);

// The delivery windows as the customer reads them (the confirmation page and the order email).
export const WINDOW_TEXT: Record<TimeWindow, { label: string; time: string }> = {
  morning: { label: "Buổi sáng", time: "8:00 – 11:30" },
  afternoon: { label: "Buổi chiều", time: "13:00 – 17:00" },
  evening: { label: "Buổi tối", time: "18:00 – 21:00" },
};

// End time of each delivery window, in minutes since midnight, Vietnam time. Only "morning" ever matters in practice,
// since afternoon and evening both end after the default cutoff, which already rules today out.
export const WINDOW_END_MINUTES: Record<TimeWindow, number> = {
  morning: 11 * 60 + 30,
  afternoon: 17 * 60,
  evening: 21 * 60,
};

// The cutoff for a date with no override: this hour, Vietnam time, on the delivery date itself.
export const DEFAULT_CUTOFF_HOUR_VN = 14;
