// Bloomy — Express entry point.
// Serves the frontend (public/) — pages through render.js, everything else
// as static files — and mounts API routes.

import path from "path";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import session from "express-session";
import connectPgSimple = require("connect-pg-simple");
import { config } from "dotenv";

const pgSession = connectPgSimple(session);
config({ path: __dirname + "/.env" });

// Fail fast on missing config. Without this, a missing variable (e.g. a
// forgotten env_file line) lets the server start, print "running", then
// fail every request. Names only are printed, never values.
const REQUIRED_ENV = [
  "DB_PASSWORD", "SESSION_SECRET", "BLOOMY_BASE_URL",
  "ZALOPAY_APP_ID", "ZALOPAY_KEY1", "ZALOPAY_KEY2", "ZALOPAY_ENDPOINT",
  "TOTP_ENCRYPTION_KEY",
];
if (process.env.EMAIL_MODE === "send") {
  REQUIRED_ENV.push("RESEND_API_KEY", "EMAIL_FROM", "SHOP_NOTIFICATION_EMAIL");
}
const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missingEnv.length > 0) {
  console.error(`Bloomy: missing required environment variables: ${missingEnv.join(", ")}`);
  process.exit(1);
}
// Both are joined with a path ("/api/orders/ipn", "/v2/create"), so each must be a bare origin. A trailing slash, for
// one, makes the ZaloPay callback "//api/orders/ipn", which this app answers with a 404, and a wrong ZaloPay address
// fails every ZaloPay checkout. Only the variable's name and the reason are printed, never its value.
// https, except http for localhost (development, the CI smoke test); not tied to NODE_ENV, which the image fixes at production.
function badUrlReason(value: string): string | null {
  if (/\s/.test(value)) return "must not contain spaces";
  let u;
  try { u = new URL(value); } catch (err) { return "is not an absolute URL (https://host)"; }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return "must start with https:// (http:// is accepted only for localhost)";
  if (u.username || u.password) return "must not contain a user name or password";
  if (u.search || u.hash) return "must not contain a query or fragment";
  if (u.pathname !== "/" || value.endsWith("/")) return "must have no path and no trailing slash";
  return null;
}
const badUrls = ["BLOOMY_BASE_URL", "ZALOPAY_ENDPOINT"].map((name) => [name, badUrlReason(process.env[name]!)]).filter(([, why]) => why); // both were checked present above
if (badUrls.length > 0) {
  for (const [name, why] of badUrls) console.error(`Bloomy: ${name} ${why}`);
  process.exit(1);
}
console.log(`Bloomy: ZaloPay endpoint host: ${new URL(process.env.ZALOPAY_ENDPOINT!).host}`);

// Present is not enough: a key of the wrong length would only fail later, at the owner's first 2FA login.
import * as totp from "./totp";
try {
  totp.loadKey();
} catch (err) {
  console.error(`Bloomy: ${(err as Error).message}`);
  process.exit(1);
}

// These imports stay below the checks above on purpose: TypeScript keeps each require() where its import is
// written, so a missing variable still stops the server before any route module is loaded.
import pool = require("./db");
import productsRouter = require("./routes/products");
import ordersRouter = require("./routes/orders");
import eventsRouter = require("./routes/events");
import { router as adminAuthRouter } from "./routes/admin-auth";
import adminProductsRouter = require("./routes/admin-products");
import adminOrdersRouter = require("./routes/admin-orders");
import adminStatsRouter = require("./routes/admin-stats");
import adminCutoffsRouter = require("./routes/admin-cutoffs");
import settingsRouter = require("./routes/settings");
import { pageRenderer } from "./render";
import adminFlowersRouter = require("./routes/admin-flowers");
import adminUsersRouter = require("./routes/admin-users");
import adminPosRouter = require("./routes/admin-pos");
import adminCouponsRouter = require("./routes/admin-coupons");
import adminSettingsRouter = require("./routes/admin-settings");
import flowersRouter = require("./routes/flowers");
import categoriesRouter = require("./routes/categories");
import campaignsRouter = require("./routes/campaigns");
import adminSeoRouter = require("./routes/admin-seo");
import adminCampaignsRouter = require("./routes/admin-campaigns");
import { getActiveCampaign } from "./routes/campaigns";
import * as blog from "./blog";
import tagsRouter = require("./routes/tags");
import reviewsRouter = require("./routes/reviews");
import adminReviewsRouter = require("./routes/admin-reviews");

const app = express();

// Required now that nginx reverse-proxies to this app — without it, Express
// doesn't know the original request was HTTPS (req.protocol, and
// express-session's cookie.secure below both depend on this being set).
// Set to 2, not 1: two hops sit in front of Node now, Cloudflare's edge
// then nginx, so req.ip needs to walk back that many X-Forwarded-For
// entries to reach the real visitor instead of Cloudflare's own (rotating)
// edge IP — confirmed against a live debug log (Cloudflare's
// CF-Connecting-IP vs req.ip) after enabling the Cloudflare proxy, not
// assumed. This number must track the real proxy count exactly — it's
// also what every rate limiter's default IP-based key relies on.
app.set("trust proxy", 2);

// Which build is answering: the 12-character commit the image was built from (CI passes it as the BUILD_SHA
// build argument, see the Dockerfile; "dev" when run any other way). On every response, so a deploy check can
// tell the new process from the old one without reading Docker's own state.
const BUILD = process.env.BLOOMY_BUILD || "dev";
app.use((req: Request, res: Response, next: NextFunction) => {
  res.set("X-Bloomy-Build", BUILD);
  next();
});

// CSP is now on for real — verified rather than guessed: grepped every page
// for inline styles/scripts (none exist). Fonts are now self-hosted
// (public/fonts/), so Google Fonts' origins have been dropped entirely —
// the browser fetches from this site only, with ONE exception: Google
// Analytics 4 (js/main.js loads it on the real site's address; see there).
// Its hosts are the ones Google's CSP guide lists for the plain GA4 tag
// (no Google signals / ad features, which main.js switches off): the loader
// script, the hit beacons (img) and the hits themselves (connect). ZaloPay's
// own API calls are server-side only, not subject to this browser CSP. The
// QR image on Checkout is a data: URI, which is why img-src needs that
// explicitly or it'd silently break.
const GA_SCRIPT = "https://www.googletagmanager.com";
const GA_IMG = ["https://*.google-analytics.com", "https://*.googletagmanager.com"];
const GA_CONNECT = ["https://*.google-analytics.com", "https://*.analytics.google.com", "https://*.googletagmanager.com"];
// Helmet's default Referrer-Policy (no-referrer) is deliberate and stays: it is what keeps an
// order-confirmation address, with its secret token, from being passed on as a referrer.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", "data:", ...GA_IMG],
        scriptSrc: ["'self'", GA_SCRIPT],
        connectSrc: ["'self'", ...GA_CONNECT],
      },
    },
  })
);

// Session store — rows in the same Postgres instance already running
// (connect-pg-simple), not Redis or the default in-memory store. Design
// locked in fundamentals-learning-handoff.md §4: single VPS, single admin,
// no case for a separate service; MemoryStore would leak memory and wipe
// every session on restart, wrong even for a demo.
//
// Table name defaults to "session" — matches schema.sql exactly, no
// createTableIfMissing needed.
app.use(
  session({
    store: new pgSession({ pool }),
    secret: process.env.SESSION_SECRET!, // required, checked at startup
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 60 * 60 * 1000, // 1 hour, persistent — not cleared on browser close
    },
  })
);

// Needed from here on — Checkout's POST /api/orders is the first route with
// a JSON request body; every route before it has been GET-only.
app.use(express.json());

// Keep the admin pages out of search results. Sent as a header, not a
// <meta> tag, so one rule covers every admin-*.html page, current and future.
// Deliberately NOT in robots.txt: a Disallow stops Google from fetching the
// page, so it would never see this header, and robots.txt would publicly
// list the admin paths.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (/^\/admin-[^/]*\.html$/.test(req.path)) {
    res.set("X-Robots-Tag", "noindex, nofollow");
  }
  next();
});

// Pages — "/" and every /<name>.html except admin-*.html go through
// render.js, which pastes in the shared partials and fills the {{tokens}}
// (phone, email, address, fees) from the settings row. Must sit before
// express.static, or the static handler would serve those pages raw.
// pageRenderer() also checks at startup that partials/ is present.
app.use(pageRenderer());

// Static frontend — css/, js/, images/, fonts/ and the admin pages.
// __dirname-based path (not a bare relative one) — same gotcha as the
// dotenv path above: a bare relative path resolves against wherever
// `node` was launched from, not this file's own location.
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders(res, filePath) {
      if (filePath.endsWith(".woff2")) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else if (/\.(jpe?g|png|webp|svg)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=604800");
      }
    },
  })
);

// ---------------------------------------------------------------------------
// GET /sitemap.xml
// Dynamic, not a static file — always reflects the live catalog rather than
// going stale the moment a product is added/discontinued. Excludes
// discontinued products; includes sold_out_today ones (still a real,
// indexable page, just temporarily unavailable). BLOOMY_BASE_URL is the
// same env var ZaloPay's callback_url and the order-confirmation email
// links already use; falls back to the request's own host if unset (e.g.
// local dev).
// ---------------------------------------------------------------------------
app.get("/sitemap.xml", async (req, res) => {
  try {
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM products WHERE status != 'discontinued' ORDER BY id`
    );
    const base = process.env.BLOOMY_BASE_URL || `${req.protocol}://${req.get("host")}`;

    const staticPages = [
      "/",
      "/products.html",
      "/custom-bouquet.html",
      "/about.html",
      "/story.html",
      "/commitment.html",
      "/privacy.html",
      "/terms.html",
    ];
    // The landing page exists only while the owner has a campaign switched on.
    const campaign = await getActiveCampaign({ includeProducts: false }).catch(() => null);
    if (campaign) staticPages.push("/landing");
    // The blog: the index and every post in content/posts.json (a broken file is reported at startup).
    try {
      staticPages.push(...(await blog.sitemapPaths()));
    } catch (err) {
      console.error("Bloomy: blog posts left out of the sitemap", err);
    }
    const urls = [
      ...staticPages.map((p) => `${base}${p}`),
      ...rows.map((p) => `${base}/product.html?id=${p.id}`),
    ];

    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls.map((u) => `  <url><loc>${u}</loc></url>`).join("\n") +
      `\n</urlset>`;

    res.type("application/xml").send(xml);
  } catch (err) {
    console.error("Bloomy: sitemap generation failed", err);
    res.status(500).send("");
  }
});

// ---------------------------------------------------------------------------
// GET /healthz
// Plain infra check for an uptime monitor to poll — confirms the app is up,
// the database is reachable AND the schema is present (a query against
// `products`, the table the storefront can't work without), not just that
// Express is listening or that Postgres answers. It checks that the table
// exists and the app's DB user can read it; it does not check for rows or for
// the other tables. Intentionally outside /api — this is an infra concern,
// not part of the application's own API surface.
// ---------------------------------------------------------------------------
app.get("/healthz", async (req, res) => {
  try {
    await pool.query("SELECT 1 FROM products LIMIT 1");
    res.status(200).json({ status: "ok" });
  } catch (err) {
    console.error("Bloomy: healthz check failed", err);
    res.status(503).json({ status: "error" });
  }
});

// A changed or lost TOTP_ENCRYPTION_KEY still passes loadKey() above (it only checks the length) and then breaks
// every enrolled owner's app-code login. Try to decrypt one stored secret now and say so in the log, so a deploy
// check can catch it. It only reads, it never stops the server (the storefront does not need the key), and it
// stays silent when no secret is stored or the database is not ready (first bring-up, or down). It is not awaited
// (see the call below), so the line can appear after the first /healthz answers: read the whole log, not the first lines.
async function checkTotpKey(): Promise<void> {
  let secret: string;
  try {
    const { rows } = await pool.query<{ totp_secret: string }>("SELECT totp_secret FROM admin_users WHERE totp_secret IS NOT NULL LIMIT 1");
    if (rows.length === 0) return;
    secret = rows[0].totp_secret;
  } catch (err) {
    return;
  }
  try {
    totp.decryptSecret(secret);
  } catch (err) {
    console.error("Bloomy: ERROR: TOTP_ENCRYPTION_KEY cannot decrypt a stored two-factor secret (the key was changed or lost)");
  }
}
checkTotpKey();

app.use("/api/products", productsRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/events", eventsRouter);
app.use("/api/admin", adminAuthRouter);
app.use("/api/admin/products", adminProductsRouter);
app.use("/api/admin/orders", adminOrdersRouter);
app.use("/api/admin/stats", adminStatsRouter);
app.use("/api/admin/cutoffs", adminCutoffsRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/admin/flowers", adminFlowersRouter);
app.use("/api/admin/users", adminUsersRouter);
app.use("/api/admin/pos", adminPosRouter);
app.use("/api/admin/coupons", adminCouponsRouter);
app.use("/api/admin/settings", adminSettingsRouter);
app.use("/api/flowers", flowersRouter);
app.use("/api/categories", categoriesRouter);
app.use("/api/campaigns", campaignsRouter);
app.use("/api/admin/seo", adminSeoRouter);
app.use("/api/admin/campaigns", adminCampaignsRouter);
app.use("/api/tags", tagsRouter);
app.use("/api/admin/reviews", adminReviewsRouter);
// /api/products/:id/reviews and /api/reviews/latest — after the products router,
// which only answers /api/products/<one segment>, so this never competes with it.
app.use("/api", reviewsRouter);

// Centralized error handler — catches anything a route's own try/catch
// missed (e.g. a thrown error in middleware before the route handler runs).
// Must be defined last, after all other app.use()/routes.
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 3000;
// PORT from the environment is a numeric string: Node treats it as a port, which the types cannot see.
const server = app.listen(PORT as number, () => {
  console.log(`Bloomy server running on http://localhost:${PORT}`);
});

// ---------------------------------------------------------------------------
// Shutdown. `docker stop` (and a compose swap) sends SIGTERM, then SIGKILL after
// 10 s. Without a handler Node dies at once and cuts the requests in flight: an
// order can be saved while the customer never gets the answer. Here the server
// stops taking new connections, lets the open requests finish, closes the DB pool
// and exits 0. If they have not finished in SHUTDOWN_GRACE_MS it exits 1, a little
// before Docker's own 10 s, so the log says why. Keep it under the stop timeout.
// The order emails are sent after the response and are not waited for here.
// ---------------------------------------------------------------------------
const SHUTDOWN_GRACE_MS = 8000;
let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Bloomy: ${signal} received, finishing open requests`);
  setTimeout(() => {
    console.error(`Bloomy: open requests did not finish within ${SHUTDOWN_GRACE_MS} ms, exiting`);
    process.exit(1);
  }, SHUTDOWN_GRACE_MS).unref();
  server.close(async () => {
    try {
      await pool.end();
    } catch (err) {
      console.error("Bloomy: closing the database pool failed", err);
    }
    console.log("Bloomy: shut down cleanly");
    process.exit(0);
  });
  // A request that finishes now leaves its keep-alive connection idle, and close() would wait for Node's
  // 5 s keep-alive timeout; sweeping idle ones keeps the shutdown as short as the last request.
  setInterval(() => server.closeIdleConnections(), 200).unref();
  server.closeIdleConnections();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
