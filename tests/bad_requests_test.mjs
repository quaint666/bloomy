// A request the client got wrong must be answered 4xx, never 500: a body that is not JSON, a body that is not there, a body of the
// wrong shape, a body that is too large. Before this suite 72 combinations of admin route and bad body answered 500 (a TypeError
// reading a field off an undefined body, and body-parser's own parse error reaching the 500 handler).
//
// Run from the repo root with the server running on the same database:  node tests/bad_requests_test.mjs   (npm test sets it up)
// It signs in as a throwaway owner, and sends every `/api/admin` route (read from the source, tests/lib/routes.mjs) up to six
// bad bodies with an id that does not exist, so nothing is changed. The public POST routes get one or two each (they have
// limiters, which the other suites share).
//
// Proves: no route answers 5xx to a bad body; a body that is not valid JSON is 400 `invalid_json` (also with no session: the parse
// error comes before the sign-in check, which is fine, it says nothing about the site); a too-large body is 413 `payload_too_large`;
// a real fault is still a 500. Does NOT prove: that each route's own message for a missing field is a good one (the other suites do).

import { createRequire } from "node:module";
import path from "node:path";
import { makeAdmin } from "./lib/admin-session.mjs";
import { readRoutes } from "./lib/routes.mjs";

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const require = createRequire(path.join(process.cwd(), "package.json"));
const { Pool } = require("pg");
const pool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1", port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || "quaint", database: process.env.DB_NAME || "bloomy", password: process.env.DB_PASSWORD || "dev",
});
let passed = 0, failed = 0;
function check(name, cond, extra = "") { if (cond) passed++; else { failed++; console.log(`FAIL ${name}${extra ? " :: " + extra : ""}`); } }
{
  const row = (await pool.query("SELECT shop_address, contact_phone FROM settings")).rows[0];
  const api = await (await fetch(BASE + "/api/settings")).json();
  if (!row || row.shop_address !== api.shop_address || row.contact_phone !== api.contact_phone) { console.log("FAIL this script is connected to a different database than the server at " + BASE); process.exit(2); }
}

const JSON_H = { "Content-Type": "application/json" };
const BODIES = [
  ["no body", {}],
  ["{}", { headers: JSON_H, body: "{}" }],
  ["junk JSON", { headers: JSON_H, body: "{bad" }],
  ["null", { headers: JSON_H, body: "null" }],
  ["an array", { headers: JSON_H, body: "[1]" }],
  ["plain text", { headers: { "Content-Type": "text/plain" }, body: "x" }],
];

const owner = await makeAdmin(pool, BASE, "badbodies", "owner");
try {
  const { routes } = readRoutes(process.cwd());
  const skip = /\/login$|\/logout$|\/2fa|\/password$|\/me\b/;   // their own limiters (and the owner's own session): the sign-in suites cover them
  const admin = routes.filter((r) => r.path.startsWith("/api/admin") && !skip.test(r.path));
  check("setup: the reader found the admin routes to send to", admin.length >= 40, String(admin.length));
  const bad5xx = [], notInvalidJson = [];
  for (const r of admin) {
    const url = BASE + r.path.replace(/:\w+/g, "99999999");
    for (const [label, init] of BODIES) {
      if (r.method === "GET" && label !== "no body") continue;
      const res = await fetch(url, { method: r.method, ...init, headers: { cookie: owner.cookie ?? "", ...(init.headers || {}) } });
      if (res.status >= 500) bad5xx.push(`${r.method} ${r.path} [${label}] ${res.status}`);
      if (label === "junk JSON" && r.method !== "GET" && res.status !== 400) notInvalidJson.push(`${r.method} ${r.path} ${res.status}`);
    }
  }
  check("no admin route answers 5xx to a bad body", bad5xx.length === 0, `${bad5xx.length}: ${bad5xx.slice(0, 5).join("; ")}`);
  check("junk JSON to any admin write route is a 400", notInvalidJson.length === 0, notInvalidJson.slice(0, 5).join("; "));
} finally {
  await owner.cleanup();
}

// the public routes, a few each
const post = (p, init) => fetch(BASE + p, { method: "POST", ...init });
for (const p of ["/api/orders/quote", "/api/events"]) {
  const junk = await post(p, { headers: JSON_H, body: "{bad" });
  check(`POST ${p} with junk JSON → 400 invalid_json`, junk.status === 400 && (await junk.json()).error === "invalid_json");
  const none = await post(p, {});
  check(`POST ${p} with no body → 400 (not 500)`, none.status === 400, String(none.status));
}
const order = await post("/api/orders", { headers: JSON_H, body: "{bad" });
check("POST /api/orders with junk JSON → 400 invalid_json", order.status === 400 && (await order.json()).error === "invalid_json");
const big = await post("/api/events", { headers: JSON_H, body: JSON.stringify({ session_id: "x".repeat(300000), event: "visit" }) });
const bigBody = await big.json();
check("a body over the size limit → 413 payload_too_large", big.status === 413 && bigBody.error === "payload_too_large", `${big.status} ${JSON.stringify(bigBody)}`);
const nosession = await fetch(`${BASE}/api/admin/orders/1/fulfillment`, { method: "PATCH", headers: JSON_H, body: "{bad" });
check("junk JSON with no session: 400 invalid_json (the parse error comes first; no data is given away)", nosession.status === 400 && (await nosession.json()).error === "invalid_json");
check("a bad body is not a fault: the same server still answers a good request", (await fetch(`${BASE}/healthz`)).ok);

await pool.end();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
