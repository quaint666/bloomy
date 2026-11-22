// The staff screen's API (routes/admin-users.ts, owner only): creating staff, changing a role or switching one off, resetting a
// password, and the rule that there is always one active owner. Run from the repo root with the server running on the same
// database:  node tests/admin_users_test.mjs   (npm test sets it up). IT WRITES admin users (zz.test.users.*) and removes them.
//
// Proves: the username/role/password rules; a duplicate name is 409 (also in another case); a change to oneself is refused; the
// last active owner can be neither demoted nor switched off, also when two owners are demoted at the same moment (one wins,
// one owner is left); switching a user off or resetting a password ends that user's sessions at once; an inactive user cannot
// sign in; a manager or employee cannot reach these routes. Does NOT prove: the page, or two-factor sign-in (twofa_test does).

import { createRequire } from "node:module";
import path from "node:path";
import { makeAdmin, PASSWORD } from "./lib/admin-session.mjs";

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
const login = (username, password = PASSWORD) => fetch(`${BASE}/api/admin/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
const row = async (id) => (await pool.query("SELECT username, role, active FROM admin_users WHERE id = $1", [id])).rows[0];
const sessionsOf = async (id) => Number((await pool.query("SELECT COUNT(*) FROM session WHERE sess ->> 'adminId' = $1", [String(id)])).rows[0].count);

// The real owners of the database must be switched off for the "last owner" checks (the seed has none; a live one would):
// the suite works with the owners that exist, and counts on being able to put them back.
const realOwners = (await pool.query("SELECT id FROM admin_users WHERE role = 'owner' AND active AND username NOT LIKE 'zz.test.%'")).rows.map((r) => r.id);
await pool.query("UPDATE admin_users SET active = false WHERE id = ANY($1)", [realOwners]);

const owner = await makeAdmin(pool, BASE, "users", "owner");
const manager = await makeAdmin(pool, BASE, "users", "manager");
const employee = await makeAdmin(pool, BASE, "users", "employee");
const made = [];
try {
  const list = await owner.api("GET", "/api/admin/users");
  check("the list names me and the users", list.status === 200 && list.data?.me === owner.id && list.data?.users?.some((u) => u.id === owner.id));
  check("a manager is refused (403)", (await manager.api("GET", "/api/admin/users")).status === 403);
  check("an employee is refused (403)", (await employee.api("POST", "/api/admin/users", { username: "zz.test.users.x", role: "employee", password: PASSWORD })).status === 403);

  // ---- create
  const create = (body) => owner.api("POST", "/api/admin/users", body);
  check("a username with a space or a capital-less symbol is refused (400)", (await create({ username: "bad name", role: "employee", password: PASSWORD })).status === 400);
  check("an unknown role → 400 invalid_role", (await create({ username: "zz.test.users.a", role: "god", password: PASSWORD })).data?.error === "invalid_role");
  check("a short password → 400", (await create({ username: "zz.test.users.a", role: "employee", password: "short" })).status === 400);
  const ok = await create({ username: "  ZZ.Test.Users.Staff  ", role: "employee", password: PASSWORD });
  check("a good user → 201, the name trimmed and in lower case", ok.status === 201 && ok.data?.username === "zz.test.users.staff" && ok.data?.role === "employee" && ok.data?.active === true, JSON.stringify(ok.data));
  if (ok.data?.id) made.push(ok.data.id);
  check("…the password is not in the answer", !JSON.stringify(ok.data).includes("password"));
  check("the same name again → 409 username_taken, also in another case", (await create({ username: "ZZ.TEST.USERS.STAFF", role: "manager", password: PASSWORD })).status === 409);
  const staffId = ok.data.id;
  const staffLogin = await login("zz.test.users.staff");
  check("the new user can sign in", staffLogin.status === 200);

  // ---- change
  check("changing myself → 400 cannot_change_self", (await owner.api("PATCH", `/api/admin/users/${owner.id}`, { role: "manager" })).data?.error === "cannot_change_self");
  check("nothing to change → 400", (await owner.api("PATCH", `/api/admin/users/${staffId}`, {})).data?.error === "nothing_to_update");
  check("a bad role → 400", (await owner.api("PATCH", `/api/admin/users/${staffId}`, { role: "god" })).status === 400);
  check("active that is not a boolean → 400", (await owner.api("PATCH", `/api/admin/users/${staffId}`, { active: "no" })).status === 400);
  check("a user that does not exist → 404", (await owner.api("PATCH", "/api/admin/users/99999999", { active: false })).status === 404);
  const promoted = await owner.api("PATCH", `/api/admin/users/${staffId}`, { role: "manager" });
  check("a role change → 200", promoted.status === 200 && promoted.data?.role === "manager" && (await row(staffId)).role === "manager");

  // ---- switching off ends sessions
  const beforeSessions = await sessionsOf(staffId);
  const off = await owner.api("PATCH", `/api/admin/users/${staffId}`, { active: false });
  check("switching a user off → 200 and every session of theirs is gone", off.status === 200 && beforeSessions >= 1 && (await sessionsOf(staffId)) === 0, `${beforeSessions} -> ${await sessionsOf(staffId)}`);
  check("an inactive user cannot sign in", (await login("zz.test.users.staff")).status === 401);
  await owner.api("PATCH", `/api/admin/users/${staffId}`, { active: true });
  check("…and can again once switched on", (await login("zz.test.users.staff")).status === 200);

  // ---- password reset
  check("a short password for a reset → 400", (await owner.api("POST", `/api/admin/users/${staffId}/password`, { password: "short" })).status === 400);
  check("a reset of myself → 400 use_account_page", (await owner.api("POST", `/api/admin/users/${owner.id}/password`, { password: "AnotherPass1!" })).data?.error === "use_account_page");
  const sessionsBefore = await sessionsOf(staffId);
  const reset = await owner.api("POST", `/api/admin/users/${staffId}/password`, { password: "AnotherPass1!" });
  check("a reset → 200, their sessions end, the old password stops working and the new one works", reset.status === 200 && sessionsBefore >= 1 && (await sessionsOf(staffId)) === 0 && (await login("zz.test.users.staff", PASSWORD)).status === 401 && (await login("zz.test.users.staff", "AnotherPass1!")).status === 200);
  check("a reset for a user that does not exist → 404", (await owner.api("POST", "/api/admin/users/99999999/password", { password: "AnotherPass1!" })).status === 404);

  // ---- the last owner
  const second = await create({ username: "zz.test.users.owner2", role: "owner", password: PASSWORD });
  if (second.data?.id) made.push(second.data.id);
  check("a second owner can be made", second.status === 201 && second.data?.role === "owner");
  const demote = await owner.api("PATCH", `/api/admin/users/${second.data.id}`, { role: "manager" });
  check("demoting an owner while another active owner exists → 200", demote.status === 200 && demote.data?.role === "manager");
  // An owner acting is itself an active owner, so the rule can only be broken by a race: two owners demoting each other at once.
  // Without the lock both would see "the other one is still an owner" and both would succeed, leaving none.
  const b = await makeAdmin(pool, BASE, "usersb", "owner");
  made.push(b.id);
  const owners = () => pool.query("SELECT COUNT(*)::int AS n FROM admin_users WHERE role = 'owner' AND active AND username LIKE 'zz.test.users%'").then((r) => r.rows[0].n);
  const rounds = [];
  for (let i = 0; i < 6; i++) {
    await pool.query("UPDATE admin_users SET role = 'owner', active = true WHERE id = ANY($1)", [[owner.id, b.id]]);
    const [x, y] = await Promise.all([owner.api("PATCH", `/api/admin/users/${b.id}`, { role: "manager" }), b.api("PATCH", `/api/admin/users/${owner.id}`, { role: "manager" })]);
    rounds.push({ codes: [x.status, y.status].sort().join(), left: await owners(), lastOwner: [x.data?.error, y.data?.error].includes("last_owner") });
  }
  check("two owners demoting each other at the same moment, 6 times: always one 200 and one 409 last_owner, and one owner left", rounds.every((r) => r.codes === "200,409" && r.left === 1 && r.lastOwner), JSON.stringify(rounds));
  await pool.query("UPDATE admin_users SET role = 'owner', active = true WHERE id = ANY($1)", [[owner.id, b.id]]);
  const both = await Promise.all([owner.api("PATCH", `/api/admin/users/${b.id}`, { active: false }), b.api("PATCH", `/api/admin/users/${owner.id}`, { active: false })]);
  check("…and switching each other off at the same moment leaves one active owner too", [both[0].status, both[1].status].sort().join() === "200,409" && (await owners()) === 1, JSON.stringify(both.map((x) => x.status)));
} finally {
  await pool.query("DELETE FROM admin_users WHERE username LIKE 'zz.test.users%'");
  await pool.query("UPDATE admin_users SET active = true WHERE id = ANY($1)", [realOwners]);
}
check("cleanup: no test users left, the real owners are active again", Number((await pool.query("SELECT COUNT(*) FROM admin_users WHERE username LIKE 'zz.test.users%'")).rows[0].count) === 0);
await pool.end();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
