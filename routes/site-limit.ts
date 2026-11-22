// Bloomy — the per-address cap on requests to the whole site (see server.ts, where it is applied to everything, and the four
// routers that also carry it themselves). One place for the figure and what is not counted.
//
// 3000 requests per 15 minutes per address (SITE_REQUESTS_PER_15_MIN, optional, a whole number of 10 or more; a bad value stops
// the server at start). It sits far above what a person or the shop's own screens use (the POS polls every 3 s while a QR is
// open), on top of the stricter limiters some routes have (login, orders, quotes, reviews), so it only meets a script.
// Pictures, styles, scripts, fonts and the health check are not counted: a page loads many of them, and the health check must
// never be refused.
import type { Options } from "express-rate-limit";

const SITE_REQUESTS_PER_15_MIN = Number(process.env.SITE_REQUESTS_PER_15_MIN || 3000);
if (!Number.isInteger(SITE_REQUESTS_PER_15_MIN) || SITE_REQUESTS_PER_15_MIN < 10) {
  console.error("Bloomy: SITE_REQUESTS_PER_15_MIN must be a whole number of 10 or more");
  process.exit(1);
}

export const SITE_LIMIT: Partial<Options> = {
  windowMs: 15 * 60 * 1000,
  max: SITE_REQUESTS_PER_15_MIN,
  skip: (req) => req.path === "/healthz" || /^\/(css|js|images|fonts)\//.test(req.path),
};
