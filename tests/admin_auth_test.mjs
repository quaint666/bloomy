// Every /api/admin route and who may call it. The routes are listed from the source (tests/lib/routes.mjs), so a new
// admin route is covered the moment it exists: it needs a role guard, the docs' "Who" column must say the same, and the
// running server must really refuse everyone below that role.
//   A. in the code    B. in the docs    C. against the running server    D. a session follows the account
//
// Run from the repo root with the server running on the same database (`npm test` does all of this itself):
//   export DB_HOST=127.0.0.1 DB_PORT=5433 DB_PASSWORD=dev
//   BASE=http://localhost:3000 node tests/admin_auth_test.mjs
//
// It creates three staff accounts named zz.test.authenum.* (employee, manager, owner) and removes them again. The
// calls that must be ALLOWED use a made-up id (999999999) and an empty body, so they are refused by validation or find
// nothing, and change nothing. It logs in three times (the login limiter is 5 per 15 minutes) and sends at most 8
// requests to the 2FA routes (their limiter, 10, runs before the role check).
//
// Proves: no admin route is open (apart from login and logout), each guard is the one the docs say, no role below the
// guard gets through (401 without a session, 403 below the role) and the guarded role is not turned away or crashed
// (never 401, 403 or 5xx); and a role change or a deactivation takes effect on the next request of a live session.
// Does NOT prove: what an allowed call does (the other suites do), or the 2FA second step (twofa_test).

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { readRoutes } from "./lib/routes.mjs";

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const ROOT = process.cwd();
const require = createRequire(path.join(ROOT, "package.json"));
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const pool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1", port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || "quaint", database: process.env.DB_NAME || "bloomy", password: process.env.DB_PASSWORD || "dev",
});

let passed = 0, failed = 0;
function check(name, cond, extra = "") { if (cond) passed++; else { failed++; console.log(`FAIL ${name}${extra ? " :: " + extra : ""}`); } }

const RANK = { employee: 1, manager: 2, owner: 3 };
const ROLES = ["employee", "manager", "owner"];
const GUARD_ROLE = { requireEmployee: "employee", requireAdmin: "manager", requireOwner: "owner", ownerOnly: "owner" }; // the names in routes/*.ts
const roleOf = (chain) => { for (const t of chain) { const m = t.match(/^requireRole\("(\w+)"\)$/); if (m) return m[1]; if (GUARD_ROLE[t]) return GUARD_ROLE[t]; } return null; };
const LIMITERS = ["loginLimiter", "passwordLimiter", "twoFactorLimiter"];
const OPEN = new Map([["POST /api/admin/login", "public"], ["POST /api/admin/logout", "session"]]); // no role guard, on purpose

// ============================================================ A. in the code
const { routes, problems } = readRoutes(ROOT);
check("the reader followed every mount and route in the code", problems.length === 0, problems.join("; "));
const admin = routes.filter((r) => r.path === "/api/admin" || r.path.startsWith("/api/admin/"));
check("setup: the admin routes were found", admin.length >= 45, String(admin.length));
const unguarded = admin.filter((r) => !OPEN.has(r.key) && roleOf(r.chain) === null);
check("every admin route has a role guard (apart from login and logout)", unguarded.length === 0, unguarded.map((r) => `${r.key} [${r.chain.join(" ")}]`).join("; "));
const unknown = admin.flatMap((r) => r.chain.filter((t) => !GUARD_ROLE[t] && !/^requireRole\(/.test(t) && !LIMITERS.includes(t)).map((t) => `${r.key}: ${t}`));
check("no admin route has middleware this test does not know (it might be a guard it cannot judge)", unknown.length === 0, unknown.join("; "));
check("login is rate-limited, and the 2FA and password routes have their limiter", admin.find((r) => r.key === "POST /api/admin/login")?.chain.includes("loginLimiter") && admin.filter((r) => /\/me\/2fa\/(setup|enable|recovery-codes|disable)$/.test(r.path)).every((r) => r.chain.includes("twoFactorLimiter")) && admin.find((r) => r.key === "POST /api/admin/me/password")?.chain.includes("passwordLimiter"));

// ============================================================ B. in the docs
const doc = fs.readFileSync(path.join(ROOT, "docs", "00-HANDOFF.md"), "utf8");
const who = new Map();
for (const line of doc.split("\n")) { const m = line.match(/^\| (GET|POST|PATCH|PUT|DELETE|HEAD) \| `([^`]+)`[^|]*\| ([^|]+) \| ([^|]+) \|/); if (m) who.set(`${m[1]} ${m[2].split(" ")[0]}`, m[3].trim()); }
const wrongWho = [];
for (const r of admin) {
  const expected = OPEN.get(r.key) ?? ({ employee: "employee+", manager: "manager+", owner: "owner" })[roleOf(r.chain)];
  const said = who.get(r.key) ?? "(no row)";
  if (!said.startsWith(expected)) wrongWho.push(`${r.key}: docs say "${said}", code says ${expected}`);
}
check("the docs' \"Who\" column says what the code's guard says, for every admin route", wrongWho.length === 0, wrongWho.slice(0, 4).join("; ") + (wrongWho.length > 4 ? ` ... (${wrongWho.length})` : ""));

// ============================================================ C. against the running server
{ // stop early if this script's database is not the server's
  const row = (await pool.query("SELECT shop_address FROM settings")).rows[0];
  const api = await (await fetch(`${BASE}/api/settings`)).json();
  if (!row || row.shop_address !== api.shop_address) { console.log("FAIL this script is connected to a different database than the server at " + BASE); process.exit(2); }
}
const PASSWORD = "zz-test-password-1";
const users = {};
async function removeUsers() { await pool.query("DELETE FROM admin_users WHERE username LIKE 'zz.test.authenum.%'"); }
await removeUsers();
try {
  const hash = await bcrypt.hash(PASSWORD, 10);
  for (const role of ROLES) users[role] = { name: `zz.test.authenum.${role}`, id: (await pool.query("INSERT INTO admin_users (username, password, role) VALUES ($1, $2, $3) RETURNING id", [`zz.test.authenum.${role}`, hash, role])).rows[0].id };
  for (const role of ROLES) {
    const res = await fetch(`${BASE}/api/admin/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: users[role].name, password: PASSWORD }) });
    users[role].cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    check(`setup: the ${role} account can log in`, res.status === 200 && users[role].cookie.includes("connect.sid"), String(res.status));
  }

  const call = async (r, cookie) => {
    const res = await fetch(`${BASE}${r.path.replace(/:\w+/g, "999999999")}`, { method: r.method, redirect: "manual", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: r.method === "GET" || r.method === "HEAD" ? undefined : "{}" });
    return { status: res.status, type: res.headers.get("content-type") || "", text: await res.text() };
  };
  const guarded = admin.filter((r) => !OPEN.has(r.key));
  const failures = { noSession: [], tooLow: [], allowed: [], leak: [] };
  for (const r of guarded) {
    const min = roleOf(r.chain) ?? "employee"; // an unguarded route is held to the strictest rule: a session is needed at least
    const limited = r.chain.some((t) => LIMITERS.includes(t)); // the limiter runs BEFORE the guard and counts every call
    const none = await call(r, null);
    if (none.status !== 401) failures.noSession.push(`${r.key} -> ${none.status}`);
    if (!/json/.test(none.type) || /"(password|username|totp)/.test(none.text)) failures.leak.push(`${r.key}: ${none.type} ${none.text.slice(0, 60)}`);
    const lower = ROLES.filter((x) => RANK[x] < RANK[min]);
    for (const role of limited ? lower.slice(0, 1) : lower) {
      const res = await call(r, users[role].cookie);
      if (res.status !== 403) failures.tooLow.push(`${r.key} as ${role} -> ${res.status}`);
    }
    if (!(limited && /\/2fa\//.test(r.path))) { // the 2FA routes are left alone for the allowed call (their limiter, twofa_test)
      const res = await call(r, users[min].cookie);
      if ([401, 403].includes(res.status) || res.status >= 500) failures.allowed.push(`${r.key} as ${min} -> ${res.status}`);
    }
  }
  check(`without a session every one of the ${guarded.length} guarded routes answers 401`, failures.noSession.length === 0, failures.noSession.slice(0, 5).join("; "));
  check("the 401 is JSON and carries no account data", failures.leak.length === 0, failures.leak.slice(0, 3).join("; "));
  check("a role below the guard gets 403 on every route", failures.tooLow.length === 0, failures.tooLow.slice(0, 5).join("; "));
  check("the guarded role is let in: never 401, 403 or a crash (made-up id, empty body, nothing changes)", failures.allowed.length === 0, failures.allowed.slice(0, 5).join("; "));
  check("the counts add up: owner-only, manager+ and employee+ routes all exist", ROLES.every((x) => guarded.some((r) => roleOf(r.chain) === x)));

  // ============================================================ D. a session follows the account
  const stats = { method: "GET", path: "/api/admin/stats" };
  check("setup: the manager reads /api/admin/stats", (await call(stats, users.manager.cookie)).status === 200);
  await pool.query("UPDATE admin_users SET role = 'employee' WHERE id = $1", [users.manager.id]);
  check("a manager demoted to employee is refused on the very next request of the same session (403)", (await call(stats, users.manager.cookie)).status === 403);
  await pool.query("UPDATE admin_users SET role = 'manager' WHERE id = $1", [users.manager.id]);
  check("promoted back, the same session works again", (await call(stats, users.manager.cookie)).status === 200);
  await pool.query("UPDATE admin_users SET active = false WHERE id = $1", [users.manager.id]);
  check("a deactivated account's live session is refused (401)", (await call(stats, users.manager.cookie)).status === 401);
  check("and it stays refused after the account is switched back on (the session was ended)", await (async () => { await pool.query("UPDATE admin_users SET active = true WHERE id = $1", [users.manager.id]); return (await call(stats, users.manager.cookie)).status === 401; })());
} finally {
  await removeUsers();
}
check("cleanup: no test staff accounts left", Number((await pool.query("SELECT COUNT(*) FROM admin_users WHERE username LIKE 'zz.test.authenum.%'")).rows[0].count) === 0);
await pool.end();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
