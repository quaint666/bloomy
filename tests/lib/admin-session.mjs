// Shared by the suites that call the admin API as a real signed-in user: a throwaway admin of a given role, written into
// admin_users, logged in through POST /api/admin/login (a successful login does not count against the login limiter), and
// removed again by `cleanup()`. Test users are named zz.test.<suite>.<role> so a leftover is easy to see.
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(path.join(process.cwd(), "package.json"));
const bcrypt = require("bcrypt");
export const PASSWORD = "Passw0rd!x1";

export async function makeAdmin(pool, BASE, suite, role) {
  const name = `zz.test.${suite}.${role}`;
  await pool.query("DELETE FROM admin_users WHERE username = $1", [name]);
  const hash = await bcrypt.hash(PASSWORD, 10);
  const id = (await pool.query("INSERT INTO admin_users (username, password, role) VALUES ($1, $2, $3) RETURNING id", [name, hash, role])).rows[0].id;
  const login = await fetch(`${BASE}/api/admin/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: name, password: PASSWORD }) });
  if (login.status !== 200) throw new Error(`login as ${name} failed: ${login.status}`);
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const api = async (method, p, body, headers = {}) => {
    const res = await fetch(BASE + p, { method, headers: { cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON (a CSV, an empty answer) */ }
    return { status: res.status, data, res };
  };
  return { id, name, api, cleanup: () => pool.query("DELETE FROM admin_users WHERE id = $1", [id]) };
}
