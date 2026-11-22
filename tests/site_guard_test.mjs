// Two guards that sit in front of every route in server.ts: the cross-site Origin check on state-changing requests, and the
// per-address cap on requests to the whole site.
//
// Run from the repo root (after `npm run build`) with the usual DB_* variables:  node tests/site_guard_test.mjs
// It starts its OWN server (port 39711) with SITE_REQUESTS_PER_15_MIN=40 and BLOOMY_BASE_URL=https://bloomy.test, so it
// cannot use up the limiters of the server the other suites share, and it writes nothing (every request it makes is refused
// or read-only; the one POST is an empty funnel event, which is refused with a 400).
//
// Proves: a POST/PATCH/DELETE whose Origin is another site (or "null", or junk) is refused with 403 before any route runs;
// the site's own address, the address the request came in on, and no Origin at all (ZaloPay's server, curl, the other suites)
// are let through; a read is never refused for its Origin; the 41st counted request of a window is answered 429 and a
// request that was refused for its Origin is not counted; pictures/styles/scripts and /healthz are never counted or refused;
// a bad SITE_REQUESTS_PER_15_MIN stops the server at start.
// Does NOT prove: the figure used in production (3000), or how a real browser words its Origin header.

import { spawn } from "node:child_process";

const PORT = 39711, ROOT = process.cwd(), LIMIT = 40;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, cond, extra = "") { if (cond) passed++; else { failed++; console.log(`FAIL ${name}${extra ? " :: " + extra : ""}`); } }
const serverEnv = (extra = {}) => ({ ...process.env, PORT: String(PORT), BLOOMY_BASE_URL: "https://bloomy.test", SITE_REQUESTS_PER_15_MIN: String(LIMIT), ...extra });

const child = spawn("node", ["server.js"], { cwd: ROOT, env: serverEnv(), stdio: "ignore" });
try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await sleep(300); try { up = (await fetch(`${BASE}/healthz`)).ok; } catch { /* not yet */ } }
  check("the server starts", up);

  // ---- 1. the Origin check (a POST to the funnel route: an empty body is a 400 from the route itself, so 400 = "let through")
  let counted = 0; // requests that reach the limiter (a 403 from the Origin check does not)
  const send = async (method, origin, headers = {}) => {
    const r = await fetch(`${BASE}/api/events`, { method, headers: { "Content-Type": "application/json", ...(origin === undefined ? {} : { Origin: origin }), ...headers }, body: method === "GET" ? undefined : "{}" });
    if (r.status !== 403) counted++;
    return r.status;
  };
  check("a POST from another site → 403", (await send("POST", "https://evil.example")) === 403);
  check("…also PATCH and DELETE", (await send("PATCH", "https://evil.example")) === 403 && (await send("DELETE", "https://evil.example")) === 403);
  check("an Origin of \"null\" (a sandboxed page, a local file) → 403", (await send("POST", "null")) === 403);
  check("an Origin that is not an address → 403", (await send("POST", "not a url")) === 403);
  check("an address that only starts like ours (bloomy.test.evil.example) → 403", (await send("POST", "https://bloomy.test.evil.example")) === 403);
  check("the site's own address (BLOOMY_BASE_URL) is let through to the route (400: the empty body)", (await send("POST", "https://bloomy.test")) === 400);
  check("the address the request came in on is let through too", (await send("POST", `http://127.0.0.1:${PORT}`)) === 400);
  check("no Origin at all (ZaloPay's server, curl, the other suites) is let through", (await send("POST", undefined)) === 400);
  check("a read is never refused for its Origin", (await send("GET", "https://evil.example")) !== 403);
  check("…and a refused request was not counted, a let-through one was", counted === 4, `counted ${counted}`);

  // ---- 2. the cap: the next (LIMIT - counted) requests pass, the one after is a 429
  let status = 0, n = counted;
  while (n < LIMIT + 5 && status !== 429) { status = (await fetch(`${BASE}/api/settings`)).status; n++; }
  check(`the ${LIMIT + 1}st counted request of the window → 429`, status === 429 && n === LIMIT + 1, `status ${status} at request ${n}`);
  check("…a page is refused too", (await fetch(`${BASE}/products.html`)).status === 429);
  check("…but the health check is not", (await fetch(`${BASE}/healthz`)).status === 200);
  check("…nor a stylesheet", (await fetch(`${BASE}/css/style.css`)).status === 200);
  check("…nor a script or a picture", (await fetch(`${BASE}/js/main.js`)).status === 200 && (await fetch(`${BASE}/images/custom-bouquet.webp`)).status !== 429);
  check("…and a cross-site POST is still refused as such (403, not 429)", (await send("POST", "https://evil.example")) === 403);
} finally { child.kill(); }

// ---- 3. a wrong setting stops the server
for (const bad of ["abc", "5", "0", "1.5"]) {
  const c = spawn("node", ["server.js"], { cwd: ROOT, env: serverEnv({ SITE_REQUESTS_PER_15_MIN: bad }), stdio: "ignore" });
  const code = await new Promise((resolve) => { const t = setTimeout(() => { c.kill(); resolve("still running"); }, 6000); c.on("exit", (x) => { clearTimeout(t); resolve(x); }); });
  check(`SITE_REQUESTS_PER_15_MIN=${bad} → the server exits 1 at start`, code === 1, String(code));
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
