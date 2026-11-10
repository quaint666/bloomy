// Two-factor login for the owner (TOTP), checked end to end against the running server and its database:
//   A. login without 2FA is unchanged        B. who may use the 2FA endpoints        C. setup (QR code, nothing saved yet)
//   D. enable (first code, recovery codes, other sessions signed out)                E. login with 2FA: needs_code, wrong and
//   repeated codes, drift, spaces, recovery codes                                    F. managers are unaffected
//   G. 3 wrong codes lock the account (even for the right code, from any address)    H. wrong PASSWORDS never lock the account
//   I. a burst of guesses at once                                                    J. the same code / recovery code twice at once
//   K. replace the recovery codes, turn 2FA off and on again, the lock on those pages   L. the login page and the password page in a DOM
//   M. the stylesheet and CSP rules          N. create-admin.js --reset-2fa          O. the startup check of TOTP_ENCRYPTION_KEY
//
// Run from the repo root with the server running on the same database and the same key:
//   export DB_HOST=127.0.0.1 DB_PORT=5433 DB_PASSWORD=dev TOTP_ENCRYPTION_KEY=<the server's key>
//   BASE=http://localhost:3000 node tests/twofa_test.mjs
//
// It creates accounts named zz.test.2fa.* (and their sessions) and deletes them afterwards. Takes about two minutes: every login
// is held for a second on purpose (a constant answer time), and some checks wait for the next 30-second code window.
// Every request carries its own X-Forwarded-For address (the server trusts two proxies, as behind Cloudflare and nginx), so the
// per-address login limiter does not run dry in the middle of the suite and the checks below measure the per-ACCOUNT lock instead.
// EMAIL_MODE=log only, never production.
//
// Does NOT prove: that a real authenticator app scans the QR code (the QR address is checked in tests/totp_test.mjs, and by hand
// with Aegis), that the 5-minute lock ends (a unit check in tests/totp_test.mjs moves time; here it would mean waiting 5 minutes),
// that a restart clears the locks, how the pages look, or what a real browser does with the clipboard.

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import jsdom from "jsdom";
const { JSDOM, VirtualConsole, requestInterceptor } = jsdom;

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const ROOT = process.cwd();
const require = createRequire(path.join(ROOT, "package.json"));
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const totp = require("./totp.js");

if (!process.env.TOTP_ENCRYPTION_KEY) {
  console.log("FAIL TOTP_ENCRYPTION_KEY is not set: export the same key the server runs with (it is needed to read the stored secrets).");
  process.exit(2);
}
const pool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1", port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || "quaint", database: process.env.DB_NAME || "bloomy", password: process.env.DB_PASSWORD || "dev",
});

let passed = 0, failed = 0;
process.on("unhandledRejection", (e) => { failed++; console.log(`FAIL a page script failed on its own :: ${String(e).slice(0, 160)}`); });
function check(name, cond, extra = "") { if (cond) passed++; else { failed++; console.log(`FAIL ${name}${extra ? " :: " + extra : ""}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, step = 40) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(step); } return false; }
const noCss = requestInterceptor(async (request) => (request.url.endsWith(".css") ? new Response("", { headers: { "Content-Type": "text/css" } }) : undefined));

// ---- helpers
// Each request gets its own made-up visitor address (the server counts tries per address, and trust proxy is 2).
// The third part is picked at random per run, so running the suite twice within the 15 minutes the limiters remember
// does not make the second run start with addresses the first one already used up.
const ipBlock = Math.floor(Math.random() * 256);
let ipSeq = 0;
const nextIp = () => `198.51.${ipBlock}.${(++ipSeq % 250) + 1}, 10.0.0.1`; // client, then the proxy in front of us
async function api(method, p, { body, cookie, ip } = {}) {
  const res = await fetch(BASE + p, { method, headers: { "Content-Type": "application/json", "X-Forwarded-For": ip || nextIp(), ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined || method === "GET" ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* plain text (the address limiter) */ }
  return { status: res.status, json, text, cookie: (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ") };
}
const PASSWORD = "zz-test-password-1";
const login = (username, code, password = PASSWORD) => api("POST", "/api/admin/login", { body: code === undefined ? { username, password } : { username, password, code } });
const GENERIC = { error: "Invalid username or password" };

const NAMES = { owner: "zz.test.2fa.owner", manager: "zz.test.2fa.manager", lock: "zz.test.2fa.lock", nolock: "zz.test.2fa.nolock", burst: "zz.test.2fa.burst", race: "zz.test.2fa.race", pages: "zz.test.2fa.pages", plain: "zz.test.2fa.plain", cli: "zz.test.2fa.cli", mgmt: "zz.test.2fa.mgmt" };
await pool.query("DELETE FROM session WHERE (sess ->> 'adminId')::int IN (SELECT id FROM admin_users WHERE username LIKE 'zz.test.2fa.%')");
await pool.query("DELETE FROM admin_users WHERE username LIKE 'zz.test.2fa.%'");
const hash = await bcrypt.hash(PASSWORD, 10);
const ids = {};
for (const [k, name] of Object.entries(NAMES)) ids[k] = (await pool.query("INSERT INTO admin_users (username, password, role) VALUES ($1, $2, $3) RETURNING id", [name, hash, k === "manager" ? "manager" : "owner"])).rows[0].id;

// Turn 2FA on for an account straight in the database (what enrolment ends up with), returning its secret and, optionally, recovery codes.
async function enableInDb(key, { recovery = 0 } = {}) {
  const secret = totp.generateSecret();
  await pool.query("UPDATE admin_users SET totp_secret = $2, totp_last_step = NULL WHERE id = $1", [ids[key], totp.encryptSecret(secret)]);
  const codes = totp.generateRecoveryCodes(recovery);
  for (const c of codes) await pool.query("INSERT INTO recovery_codes (admin_user_id, code_hash) VALUES ($1, $2)", [ids[key], await bcrypt.hash(totp.normalizeRecoveryCode(c), 10)]);
  return { secret, codes };
}
// Every test that uses a code starts here, so it waits out the last seconds of a 30-second step first: a code made just
// before the step changes and "the same code" made just after are two different codes, and the second is rightly accepted.
const resetStep = async (key) => { await steadyWindow(); await pool.query("UPDATE admin_users SET totp_last_step = NULL WHERE id = $1", [ids[key]]); };
const dbRow = async (key) => (await pool.query("SELECT totp_secret, totp_last_step::text AS last_step FROM admin_users WHERE id = $1", [ids[key]])).rows[0];
const recoveryRows = async (key) => (await pool.query("SELECT id, code_hash, used_at FROM recovery_codes WHERE admin_user_id = $1 ORDER BY id", [ids[key]])).rows;
// What the phone shows `offset` 30-second steps from now.
const code = (secret, offset = 0) => totp.codeAt(secret, Date.now() + offset * 30000);
// A code that is NOT valid now (not for the current step or either neighbour).
const wrongCode = (secret) => { const ok = new Set([-1, 0, 1].map((o) => code(secret, o))); for (let n = 100000; ; n++) if (!ok.has(String(n))) return String(n); };
// Checks that depend on which step a code belongs to must not straddle a step boundary: wait for the start of the next step if close.
async function steadyWindow() { const into = Date.now() % 30000; if (into > 24000) await sleep(30000 - into + 200); }

try {
  // the server and this script must be on the same database
  {
    const r = await login(NAMES.plain);
    check("this script and the server use the same database (a test account made here can log in there)", r.status === 200 && r.json?.success === true, `${r.status} ${r.text.slice(0, 100)}`);
  }

  // ============================================================ A. login without 2FA is unchanged
  {
    const r = await login(NAMES.plain);
    check("no 2FA: login answers 200 with success, the role and where that role starts, and sets a session cookie", r.status === 200 && r.json.success === true && r.json.role === "owner" && r.json.landing === "admin-products.html" && /connect\.sid=/.test(r.cookie), JSON.stringify(r.json));
    check("…never asks for a code", r.json.needs_code === undefined);
    const me = await api("GET", "/api/admin/me", { cookie: r.cookie });
    check("…and the session works", me.status === 200 && me.json.username === NAMES.plain);
    const withCode = await login(NAMES.plain, "123456");
    check("no 2FA: a code sent anyway is ignored (the login does not care)", withCode.status === 200 && withCode.json.success === true);
  }

  // ============================================================ B. who may use the 2FA endpoints
  const manager = (await login(NAMES.manager)).cookie;
  const owner1 = (await login(NAMES.owner)).cookie;
  {
    const routes = [["GET", "/api/admin/me/2fa"], ["POST", "/api/admin/me/2fa/setup"], ["POST", "/api/admin/me/2fa/enable"], ["POST", "/api/admin/me/2fa/recovery-codes"], ["POST", "/api/admin/me/2fa/disable"]];
    const anon = [], mgr = [];
    for (const [m, p] of routes) { anon.push((await api(m, p, { body: {} })).status); mgr.push((await api(m, p, { body: {}, cookie: manager })).status); }
    check("not signed in: every 2FA endpoint answers 401", anon.every((s) => s === 401), anon.join());
    check("a manager: every 2FA endpoint answers 403 (owner only)", mgr.every((s) => s === 403), mgr.join());
    const st = await api("GET", "/api/admin/me/2fa", { cookie: owner1 });
    check("the owner, before turning it on: { enabled: false, recovery_remaining: 0 }", st.status === 200 && st.json.enabled === false && st.json.recovery_remaining === 0, JSON.stringify(st.json));
  }

  // ============================================================ C. setup: a QR code, and nothing is saved yet
  let secretA;
  {
    const missing = await api("POST", "/api/admin/me/2fa/setup", { body: {}, cookie: owner1 });
    check("setup without a password: 400 invalid_payload", missing.status === 400 && missing.json.error === "invalid_payload");
    const wrong = await api("POST", "/api/admin/me/2fa/setup", { body: { password: "not the password" }, cookie: owner1 });
    check("setup with the wrong password: 400 wrong_current_password (a 401 would throw the person out to the login page)", wrong.status === 400 && wrong.json.error === "wrong_current_password");
    const ok = await api("POST", "/api/admin/me/2fa/setup", { body: { password: PASSWORD }, cookie: owner1 });
    secretA = ok.json?.secret;
    check("setup: 200 with a 32-character base32 key and a PNG as a data: address (the page's CSP allows data: images)", ok.status === 200 && /^[A-Z2-7]{32}$/.test(secretA) && /^data:image\/png;base64,/.test(ok.json.qr), JSON.stringify(ok.json).slice(0, 120));
    check("…and nothing is saved on the account yet", (await dbRow("owner")).totp_secret === null);
    const sessions = (await pool.query("SELECT sess::text AS s FROM session")).rows.map((r) => r.s).join("\n");
    check("…the pending key is in the session only encrypted (the plain key is nowhere in the session table)", !sessions.includes(secretA) && /pendingTotp/.test(sessions));
  }

  // ============================================================ D. enable: the first code, recovery codes, other sessions out
  let recoveryA;
  {
    const owner2 = (await login(NAMES.owner)).cookie; // a second browser, signed in before 2FA existed
    const fresh = await api("POST", "/api/admin/me/2fa/enable", { body: { code: code(secretA) }, cookie: owner2 });
    check("enable in a session that never ran setup: 400 no_pending_setup", fresh.status === 400 && fresh.json.error === "no_pending_setup");
    const bad = await api("POST", "/api/admin/me/2fa/enable", { body: { code: wrongCode(secretA) }, cookie: owner1 });
    check("enable with a wrong code: 400 invalid_code, still nothing saved", bad.status === 400 && bad.json.error === "invalid_code" && (await dbRow("owner")).totp_secret === null);
    const good = await api("POST", "/api/admin/me/2fa/enable", { body: { code: code(secretA) }, cookie: owner1 });
    recoveryA = good.json?.recovery_codes;
    check("enable with the right code: 200 and ten recovery codes in the XXXXX-XXXXX form", good.status === 200 && good.json.success === true && Array.isArray(recoveryA) && recoveryA.length === 10 && recoveryA.every((c) => /^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/.test(c)), JSON.stringify(good.json).slice(0, 150));
    const row = await dbRow("owner");
    let decrypted = null; try { decrypted = totp.decryptSecret(row.totp_secret); } catch (e) { decrypted = `ERR ${e.message}`; }
    check("the stored secret is encrypted: not the plain key, not base64 of it, and it decrypts (with this key) to the key that was shown", row.totp_secret && !row.totp_secret.includes(secretA) && !Buffer.from(row.totp_secret, "base64").toString("latin1").includes(secretA) && decrypted === secretA, String(decrypted));
    check("…and the step of the enabling code is remembered (a code is single-use)", Math.abs(Number(row.last_step) - Math.floor(Date.now() / 30000)) <= 1, String(row.last_step));
    const rows = await recoveryRows("owner");
    check("ten recovery rows, unused, stored as bcrypt hashes (no plain code anywhere in them)", rows.length === 10 && rows.every((r) => r.used_at === null && /^\$2[aby]\$/.test(r.code_hash) && !recoveryA.some((c) => r.code_hash.includes(c.replace("-", "")))));
    const st = await api("GET", "/api/admin/me/2fa", { cookie: owner1 });
    check("the page's state now reads { enabled: true, recovery_remaining: 10 }", st.json.enabled === true && st.json.recovery_remaining === 10, JSON.stringify(st.json));
    check("the browser that enabled it stays signed in; the other browser (signed in without 2FA) is signed out", (await api("GET", "/api/admin/me", { cookie: owner1 })).status === 200 && (await api("GET", "/api/admin/me", { cookie: owner2 })).status === 401);
    const again = await api("POST", "/api/admin/me/2fa/setup", { body: { password: PASSWORD }, cookie: owner1 });
    check("setup when it is already on: 409 already_enabled", again.status === 409 && again.json.error === "already_enabled");
  }

  // ============================================================ E. login with 2FA
  {
    const u = NAMES.owner;
    const unknown = await login("zz.test.2fa.nobody");
    const wrongPw = await login(u, undefined, "not the password");
    check("a wrong password is still the one generic 401 (the code step does not reveal that the account has 2FA)", wrongPw.status === 401 && JSON.stringify(wrongPw.json) === JSON.stringify(GENERIC) && JSON.stringify(unknown.json) === JSON.stringify(GENERIC));
    const wrongPwWithCode = await login(u, code(secretA, 0), "not the password");
    check("…also when a valid code comes with it", wrongPwWithCode.status === 401 && JSON.stringify(wrongPwWithCode.json) === JSON.stringify(GENERIC));

    const ask = await login(u);
    check("right password, no code: 200 { needs_code: true } and NO session (no cookie, nothing to use)", ask.status === 200 && ask.json.needs_code === true && ask.json.success === undefined && ask.cookie === "", JSON.stringify(ask));
    const askEmpty = await login(u, "   ");
    check("…an empty or blank code is the same as none", askEmpty.json?.needs_code === true && askEmpty.cookie === "");

    const wrong = await login(u, wrongCode(secretA));
    check("a wrong code: 401 invalid_code, no session", wrong.status === 401 && wrong.json.error === "invalid_code" && wrong.cookie === "", JSON.stringify(wrong));
    const lastStep = Number((await dbRow("owner")).last_step);
    const replayEnable = await login(u, totp.hotp(totp.base32Decode(secretA), lastStep));
    check("the code that turned 2FA on cannot be used to log in (single-use, even though it is still inside its time window)", replayEnable.status === 401 && replayEnable.json.error === "invalid_code", JSON.stringify(replayEnable));

    await resetStep("owner");
    const good = await login(u, code(secretA));
    check("a right code: 200 success with the role and landing page, and a session cookie", good.status === 200 && good.json.success === true && good.json.role === "owner" && /connect\.sid=/.test(good.cookie), JSON.stringify(good));
    check("…the session is a real one", (await api("GET", "/api/admin/me", { cookie: good.cookie })).status === 200);
    const replay = await login(u, code(secretA));
    check("the same code a second time: refused (a code works once)", replay.status === 401 && replay.json.error === "invalid_code", JSON.stringify(replay));

    await steadyWindow();
    await resetStep("owner");
    check("a code from the previous 30 seconds is accepted (clock drift)", (await login(u, code(secretA, -1))).status === 200);
    await resetStep("owner");
    check("a code from the next 30 seconds is accepted (clock drift)", (await login(u, code(secretA, 1))).status === 200);
    await resetStep("owner");
    const old2 = await login(u, code(secretA, -2));
    check("a code from 60 seconds ago is refused", old2.status === 401 && old2.json.error === "invalid_code");
    await resetStep("owner");
    check("…a successful login in between gives the tries back, so the next wrong code is only try 1", (await login(u, code(secretA))).status === 200);
    await resetStep("owner");
    const ahead2 = await login(u, code(secretA, 2));
    check("a code from 60 seconds ahead is refused", ahead2.status === 401 && ahead2.json.error === "invalid_code");

    await resetStep("owner");
    const c = code(secretA);
    check("a code typed with a space (\"123 456\") works", (await login(u, `${c.slice(0, 3)} ${c.slice(3)}`)).status === 200);
    await resetStep("owner");
    const num = await login(u, 123456);
    check("a code sent as a number (not text) is just a wrong code", num.status === 401 && num.json.error === "invalid_code");

    // recovery codes
    const [r0, r1] = recoveryA;
    const asTyped = await login(u, r0.replace("-", "").toLowerCase());
    check("a recovery code works, typed in lower case without the dash", asTyped.status === 200 && asTyped.json.success === true, JSON.stringify(asTyped));
    const used = await recoveryRows("owner");
    check("…exactly one recovery row is now marked used", used.filter((r) => r.used_at !== null).length === 1 && used.length === 10);
    check("…and the page's count follows (9 left)", (await api("GET", "/api/admin/me/2fa", { cookie: asTyped.cookie })).json.recovery_remaining === 9);
    const usedAgain = await login(u, r0);
    check("the same recovery code again: refused (one use)", usedAgain.status === 401 && usedAgain.json.error === "invalid_code");
    check("another recovery code, typed as printed, works", (await login(u, r1)).status === 200);
    const foreign = totp.generateRecoveryCodes(1)[0];
    const notMine = await login(u, foreign);
    check("a well-formed code that was never issued is just wrong", notMine.status === 401 && notMine.json.error === "invalid_code");
    const shortJunk = await login(u, "12345");
    check("anything that is neither 6 digits nor a recovery code is just wrong (no error, no crash)", shortJunk.status === 401 && shortJunk.json.error === "invalid_code");
    await resetStep("owner");
    check("…and a right code afterwards still works (the wrong ones were only tries 1 and 2)", (await login(u, code(secretA))).status === 200);
  }

  // ============================================================ F. managers are unaffected
  {
    const r = await login(NAMES.manager);
    check("a manager logs in with the password alone (no 2FA for managers)", r.status === 200 && r.json.role === "manager" && r.json.needs_code === undefined);
  }

  // ============================================================ G. 3 wrong codes lock the account
  {
    const { secret } = await enableInDb("lock");
    const u = NAMES.lock;
    const a = await login(u, wrongCode(secret)), b = await login(u, wrongCode(secret)), c3 = await login(u, wrongCode(secret));
    check("three wrong codes: 401, 401, and the third answers that the account is locked (429 two_factor_locked)", a.status === 401 && b.status === 401 && c3.status === 429 && c3.json.error === "two_factor_locked", `${a.status} ${b.status} ${c3.status}`);
    check("…with the time left: about 5 minutes", c3.json.retry_after >= 295 && c3.json.retry_after <= 300, String(c3.json.retry_after));
    const rightWhileLocked = await login(u, code(secret));
    check("while locked, even the RIGHT code is refused (429), from a different address too", rightWhileLocked.status === 429 && rightWhileLocked.json.error === "two_factor_locked" && rightWhileLocked.cookie === "", JSON.stringify(rightWhileLocked));
    check("…and the refused right code was not used up", (await dbRow("lock")).last_step === null);
    const ask = await login(u);
    check("while locked, a login with no code still just asks for the code (it reveals nothing)", ask.status === 200 && ask.json.needs_code === true);
    await resetStep("owner");
    check("another account is not affected by that lock", (await login(NAMES.owner, code(secretA))).status === 200);
  }

  // ============================================================ H. wrong PASSWORDS never lock the account
  {
    const { secret } = await enableInDb("nolock");
    for (let i = 0; i < 4; i++) await login(NAMES.nolock, wrongCode(secret), "wrong password " + i);
    const r = await login(NAMES.nolock, code(secret));
    check("four wrong passwords (with codes) do not touch the code tries: the right password and code still log in", r.status === 200 && r.json.success === true, JSON.stringify(r));
  }

  // ============================================================ I. a burst of guesses at once
  {
    const { secret } = await enableInDb("burst");
    const wrongs = Array.from({ length: 8 }, () => wrongCode(secret));
    const all = await Promise.all(wrongs.map((w) => login(NAMES.burst, w)));
    const invalid = all.filter((r) => r.status === 401 && r.json?.error === "invalid_code").length;
    const locked = all.filter((r) => r.status === 429 && r.json?.error === "two_factor_locked").length;
    // (That no more than THREE of them are really checked is proven in tests/totp_test.mjs, where the order is exact; here the
    // requests race each other, so this only shows that a burst ends in the lock and not in eight free guesses.)
    check("eight wrong codes sent at the same moment: none is accepted, at most three come back as plain wrong codes, the rest as locked", invalid <= 3 && locked >= 5 && invalid + locked === 8, `invalid ${invalid}, locked ${locked}`);
    check("…and the right code is refused right after", (await login(NAMES.burst, code(secret))).status === 429);
  }

  // ============================================================ J. the same code twice at once
  {
    const { secret, codes } = await enableInDb("race", { recovery: 3 });
    const c = code(secret);
    const pair = await Promise.all([login(NAMES.race, c), login(NAMES.race, c)]);
    check("the same app code sent twice at the same moment: exactly one login succeeds", pair.filter((r) => r.status === 200).length === 1 && pair.filter((r) => r.status === 401).length === 1, pair.map((r) => r.status).join());
    const rc = await Promise.all([login(NAMES.race, codes[0]), login(NAMES.race, codes[0])]);
    check("the same recovery code sent twice at the same moment: exactly one login succeeds", rc.filter((r) => r.status === 200).length === 1 && rc.filter((r) => r.status === 401).length === 1, rc.map((r) => r.status).join());
    check("…and it is marked used once", (await recoveryRows("race")).filter((r) => r.used_at !== null).length === 1);
  }

  // ============================================================ K. replace recovery codes, turn off and on, the lock on these pages
  {
    const u = NAMES.owner;
    await resetStep("owner");
    const s = (await login(u, code(secretA))).cookie;
    const none = await api("POST", "/api/admin/me/2fa/recovery-codes", { body: {}, cookie: s });
    const bad = await api("POST", "/api/admin/me/2fa/recovery-codes", { body: { code: wrongCode(secretA) }, cookie: s });
    check("new recovery codes without a code, or with a wrong one: 400 invalid_code (not 401)", none.status === 400 && none.json.error === "invalid_code" && bad.status === 400 && bad.json.error === "invalid_code");
    await resetStep("owner");
    const before = (await recoveryRows("owner")).map((r) => r.code_hash).join();
    const regen = await api("POST", "/api/admin/me/2fa/recovery-codes", { body: { code: code(secretA) }, cookie: s });
    const newCodes = regen.json?.recovery_codes;
    const rows = await recoveryRows("owner");
    check("with a right code: ten new codes, ten fresh unused rows, the old rows gone", regen.status === 200 && newCodes?.length === 10 && rows.length === 10 && rows.every((r) => r.used_at === null) && rows.map((r) => r.code_hash).join() !== before && !newCodes.some((c) => recoveryA.includes(c)));
    const oldOne = await login(u, recoveryA[5]);
    check("an old recovery code no longer works", oldOne.status === 401 && oldOne.json.error === "invalid_code");
    check("a new one does", (await login(u, newCodes[0])).status === 200);

    // turn off
    const offBad = await api("POST", "/api/admin/me/2fa/disable", { body: { code: wrongCode(secretA) }, cookie: s });
    check("turn off with a wrong code: 400 invalid_code, still on", offBad.status === 400 && offBad.json.error === "invalid_code" && (await dbRow("owner")).totp_secret !== null);
    await resetStep("owner");
    const off = await api("POST", "/api/admin/me/2fa/disable", { body: { code: code(secretA) }, cookie: s });
    const row = await dbRow("owner");
    check("turn off with a right code: 200; secret and step cleared, recovery codes deleted", off.status === 200 && row.totp_secret === null && row.last_step === null && (await recoveryRows("owner")).length === 0);
    const plain = await login(u);
    check("…and the login needs only the password again", plain.status === 200 && plain.json.success === true);
    const offAgain = await api("POST", "/api/admin/me/2fa/disable", { body: { code: "123456" }, cookie: plain.cookie });
    const regenOff = await api("POST", "/api/admin/me/2fa/recovery-codes", { body: { code: "123456" }, cookie: plain.cookie });
    check("turn off / new codes while it is off: 409 not_enabled", offAgain.status === 409 && offAgain.json.error === "not_enabled" && regenOff.status === 409);

    // on again, with a NEW key; then off using a recovery code
    const setup2 = await api("POST", "/api/admin/me/2fa/setup", { body: { password: PASSWORD }, cookie: plain.cookie });
    const secret2 = setup2.json.secret;
    const on2 = await api("POST", "/api/admin/me/2fa/enable", { body: { code: code(secret2) }, cookie: plain.cookie });
    check("turning it on again works, with a new key", on2.status === 200 && secret2 !== secretA && totp.decryptSecret((await dbRow("owner")).totp_secret) === secret2);
    const offByRecovery = await api("POST", "/api/admin/me/2fa/disable", { body: { code: on2.json.recovery_codes[3] }, cookie: plain.cookie });
    check("…and it can be turned off with a recovery code (the lost-phone case)", offByRecovery.status === 200 && (await dbRow("owner")).totp_secret === null);
  }
  {
    // a stolen session cannot grind through codes on these pages either
    const { secret } = await enableInDb("mgmt");
    const s = (await login(NAMES.mgmt, code(secret))).cookie;
    const tries = [];
    for (let i = 0; i < 3; i++) tries.push(await api("POST", "/api/admin/me/2fa/disable", { body: { code: wrongCode(secret) }, cookie: s }));
    check("three wrong codes at 'turn off': 400, 400, then 429 locked", tries[0].status === 400 && tries[1].status === 400 && tries[2].status === 429 && tries[2].json.error === "two_factor_locked", tries.map((t) => t.status).join());
    await resetStep("mgmt");
    const right = await api("POST", "/api/admin/me/2fa/disable", { body: { code: code(secret) }, cookie: s });
    check("…then even the right code is refused, and 2FA stays on", right.status === 429 && (await dbRow("mgmt")).totp_secret !== null);
    const loginLocked = await login(NAMES.mgmt, code(secret));
    check("…the lock is the same one login uses (per account)", loginLocked.status === 429);
  }

  // ============================================================ L. the pages, in a DOM
  const openPage = async (urlPath, { cookie, clipboard } = {}) => {
    const url = `${BASE}${urlPath}`;
    const ip = nextIp();
    const html = await (await fetch(url, { headers: { "X-Forwarded-For": ip } })).text();
    const posts = [], answers = [], consoleErrors = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("error", (...args) => consoleErrors.push(args.join(" ")));
    const dom = new JSDOM(html, { url, runScripts: "dangerously", resources: { interceptors: [noCss] }, pretendToBeVisual: true, virtualConsole,
      beforeParse(w) {
        if (clipboard) Object.defineProperty(w.navigator, "clipboard", { value: clipboard, configurable: true });
        w.fetch = async (u, o = {}) => {
          const target = new URL(u, url);
          const res = await fetch(target, { ...o, headers: { ...(o.headers || {}), "X-Forwarded-For": ip, ...(cookie ? { Cookie: cookie } : {}) } });
          if ((o.method || "GET") === "POST") { posts.push({ path: target.pathname, body: o.body ? JSON.parse(o.body) : null }); answers.push(res.status); }
          return res;
        };
      } });
    const d = dom.window.document;
    return { w: dom.window, d, posts, answers, consoleErrors, $: (id) => d.getElementById(id), close: () => dom.window.close() };
  };
  const type = (p, id, value) => { p.$(id).value = value; };
  const submit = (p, formId) => p.$(formId).dispatchEvent(new p.w.Event("submit", { bubbles: true, cancelable: true }));

  // ---- the login page
  {
    const { secret, codes } = await enableInDb("pages", { recovery: 2 });
    const p = await openPage("/admin-login.html");
    await until(() => typeof p.w.afterLoginTarget === "function");
    check("login page: the code field, its label, hint and the way back start hidden", ["code", "admin-login-code-label", "admin-login-code-hint", "admin-login-back"].every((id) => p.$(id).hidden === true));
    type(p, "username", NAMES.pages); type(p, "password", PASSWORD);
    submit(p, "admin-login-form");
    check("login page: the account has 2FA → the code step appears", await until(() => p.$("code").hidden === false));
    check("…the first request carried only the username and the password", p.posts.length === 1 && JSON.stringify(Object.keys(p.posts[0].body)) === JSON.stringify(["username", "password"]), JSON.stringify(p.posts));
    check("…the username and password can no longer be edited, the code field is focused, no error is showing", p.$("username").readOnly && p.$("password").readOnly && p.d.activeElement === p.$("code") && p.$("admin-login-error").hidden === true);
    check("…the code field offers the phone's one-time-code autofill and the hint names the app", p.$("code").getAttribute("autocomplete") === "one-time-code" && /Aegis/.test(p.$("admin-login-code-hint").textContent));

    type(p, "code", wrongCode(secret));
    submit(p, "admin-login-form");
    check("login page: a wrong code → the error says so, the code step stays", await until(() => p.$("admin-login-error").hidden === false) && /Mã không đúng/.test(p.$("admin-login-error").textContent) && p.$("code").hidden === false);
    check("…that second request carried all three fields", p.posts.length === 2 && p.posts[1].body.username === NAMES.pages && p.posts[1].body.password === PASSWORD && typeof p.posts[1].body.code === "string");

    p.$("admin-login-back").click();
    check("login page: 'Đổi tài khoản' goes back to the first step (fields editable again, code field hidden and empty)", p.$("code").hidden === true && p.$("username").readOnly === false && p.$("password").readOnly === false && p.$("code").value === "" && p.$("admin-login-error").hidden === true);
    submit(p, "admin-login-form");
    await until(() => p.$("code").hidden === false);
    type(p, "code", code(secret));
    const before = p.posts.length;
    submit(p, "admin-login-form");
    await until(() => p.posts.length > before && p.answers.length === p.posts.length);
    check("login page: the right code → the server accepts it (200) and the page goes on (it does not show an error)", p.answers.at(-1) === 200 && p.$("admin-login-error").hidden === true);
    p.close();

    // a recovery code goes in the same field
    const q = await openPage("/admin-login.html");
    await until(() => typeof q.w.afterLoginTarget === "function");
    type(q, "username", NAMES.pages); type(q, "password", PASSWORD);
    submit(q, "admin-login-form");
    await until(() => q.$("code").hidden === false);
    type(q, "code", codes[0]);
    const b2 = q.posts.length;
    submit(q, "admin-login-form");
    await until(() => q.posts.length > b2 && q.answers.length === q.posts.length);
    check("login page: a recovery code typed in the same field logs in", q.answers.at(-1) === 200);
    q.close();

    // an account without 2FA never sees the code step
    const n = await openPage("/admin-login.html");
    await until(() => typeof n.w.afterLoginTarget === "function");
    type(n, "username", NAMES.manager); type(n, "password", PASSWORD);
    submit(n, "admin-login-form");
    await until(() => n.answers.length === 1);
    check("login page: an account without 2FA logs in on the first try, and the code step never shows", n.answers[0] === 200 && n.$("code").hidden === true);
    n.close();

    // the lock message
    const k = await openPage("/admin-login.html");
    await until(() => typeof k.w.afterLoginTarget === "function");
    type(k, "username", NAMES.lock); type(k, "password", PASSWORD);
    submit(k, "admin-login-form");
    await until(() => k.$("code").hidden === false);
    type(k, "code", "000000");
    submit(k, "admin-login-form");
    check("login page: a locked account → the message says to wait a few minutes", await until(() => /\d+ phút/.test(k.$("admin-login-error").textContent)), k.$("admin-login-error").textContent);
    k.close();
  }

  // ---- the password page
  {
    const mgrPage = await openPage("/admin-account.html", { cookie: manager });
    await until(() => mgrPage.d.querySelector(".admin-nav__menu"));
    await sleep(400);
    check("password page, as a manager: the 2FA section stays hidden, and the page does not log an error about it (a 403 is the normal answer)", mgrPage.$("twofa").hidden === true && mgrPage.consoleErrors.length === 0, mgrPage.consoleErrors.join(" | ").slice(0, 150));
    mgrPage.close();

    const ownerCookie = (await login(NAMES.plain)).cookie; // owner without 2FA
    const copied = [];
    const p = await openPage("/admin-account.html", { cookie: ownerCookie, clipboard: { writeText: async (t) => { copied.push(t); } } });
    check("password page, as the owner with 2FA off: the section shows 'Chưa bật' and only the password form", await until(() => p.$("twofa").hidden === false) && /Chưa bật/.test(p.$("twofa-status").textContent) && p.$("twofa-start-form").hidden === false && p.$("twofa-enable-form").hidden === true && p.$("twofa-on").hidden === true && p.$("twofa-codes").hidden === true);
    type(p, "twofa-start-password", "wrong password");
    submit(p, "twofa-start-form");
    check("…a wrong password → 'Mật khẩu hiện tại không đúng', still on step 1", await until(() => p.$("twofa-msg").hidden === false) && /không đúng/.test(p.$("twofa-msg").textContent) && p.$("twofa-start-form").hidden === false);
    type(p, "twofa-start-password", PASSWORD);
    submit(p, "twofa-start-form");
    check("…the right password → the QR code and the key appear, step 1 goes away", await until(() => p.$("twofa-enable-form").hidden === false) && p.$("twofa-start-form").hidden === true && /^data:image\/png;base64,/.test(p.$("twofa-qr").getAttribute("src")) && /^[A-Z2-7]{32}$/.test(p.$("twofa-secret").textContent) && p.$("twofa-start-password").value === "");
    const keyOnScreen = p.$("twofa-secret").textContent;
    type(p, "twofa-enable-code", wrongCode(keyOnScreen));
    submit(p, "twofa-enable-form");
    check("…a wrong first code → an error, the QR stays", await until(() => /Mã không đúng/.test(p.$("twofa-msg").textContent)) && p.$("twofa-enable-form").hidden === false);
    type(p, "twofa-enable-code", code(keyOnScreen));
    submit(p, "twofa-enable-form");
    check("…the right first code (computed from the key on screen, as a phone would) → ten recovery codes shown, all forms put away", await until(() => p.$("twofa-codes").hidden === false) && p.d.querySelectorAll("#twofa-codes-list li").length === 10 && p.$("twofa-enable-form").hidden === true && p.$("twofa-on").hidden === true && p.$("twofa-start-form").hidden === true);
    check("…the QR and the key are removed from the page", !p.$("twofa-qr").hasAttribute("src") && p.$("twofa-secret").textContent === "");
    const shown = [...p.d.querySelectorAll("#twofa-codes-list li")].map((li) => li.textContent);
    check("…and the codes on screen are the ones the server stored (the first one logs in)", /^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/.test(shown[0]) && (await login(NAMES.plain, shown[0])).status === 200);
    p.$("twofa-codes-copy").click();
    check("…Sao chép puts all ten on the clipboard, one per line", await until(() => copied.length === 1) && copied[0] === shown.join("\n"));
    p.$("twofa-codes-done").click();
    check("'Tôi đã lưu các mã' → the codes are cleared from the page and the 2FA-on view shows (with the count: 9 left after the test login)", await until(() => p.$("twofa-on").hidden === false) && p.$("twofa-codes").hidden === true && p.d.querySelectorAll("#twofa-codes-list li").length === 0 && /Đang bật/.test(p.$("twofa-status").textContent) && /9 mã/.test(p.$("twofa-status").textContent), p.$("twofa-status").textContent);

    type(p, "twofa-regen-code", wrongCode(keyOnScreen));
    submit(p, "twofa-regen-form");
    check("2FA on: new recovery codes with a wrong code → an error", await until(() => /Mã không đúng/.test(p.$("twofa-msg").textContent)));
    await pool.query("UPDATE admin_users SET totp_last_step = NULL WHERE username = $1", [NAMES.plain]);
    type(p, "twofa-disable-code", code(keyOnScreen));
    submit(p, "twofa-disable-form");
    check("…turn off with a right code → back to 'Chưa bật' and the password form", await until(() => /Chưa bật/.test(p.$("twofa-status").textContent) && p.$("twofa-start-form").hidden === false) && p.$("twofa-on").hidden === true);
    check("…the database agrees", (await pool.query("SELECT totp_secret FROM admin_users WHERE username = $1", [NAMES.plain])).rows[0].totp_secret === null);
    p.close();
  }

  // ============================================================ M. the stylesheet and the page rules (nothing to run: the files are read)
  {
    const read = (f) => fs.readFileSync(path.join(ROOT, "public", f), "utf8");
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
    const css = strip(read("css/admin-twofa.css"));
    check("stylesheet: [hidden] is restated inside the 2FA section (the account form is display:flex and would beat the attribute)", /\.admin-twofa\s+\[hidden\]\s*\{\s*display:\s*none/.test(css));
    check("stylesheet: the QR code has a fixed size and a white background (a dark page must not make it unreadable)", /\.admin-twofa__qr\s*\{[^}]*width:\s*240px[^}]*background-color:\s*#fff/.test(css));
    for (const f of ["admin-login.html", "admin-account.html"]) {
      const html = read(f);
      check(`${f}: loads admin-twofa.css after admin.css`, html.indexOf("css/admin-twofa.css") > html.indexOf("css/admin.css") && html.includes('href="css/admin-twofa.css"'));
      check(`${f}: no inline style attributes and no inline scripts (the site's CSP forbids both)`, !/\sstyle\s*=/.test(html) && ![...html.matchAll(/<script\b([^>]*)>/g)].some((m) => !/\bsrc=/.test(m[1])));
    }
    check("the account page keeps its existing password form and the nav script", /id="admin-account-form"/.test(read("admin-account.html")) && /js\/admin-nav\.js/.test(read("admin-account.html")));
  }

  // ============================================================ N. create-admin.js --reset-2fa
  {
    const { secret } = await enableInDb("cli", { recovery: 3 });
    const s = (await login(NAMES.cli, code(secret))).cookie;
    const run = (answers) => new Promise((resolve) => {
      const child = spawn("node", ["create-admin.js", "--reset-2fa"], { cwd: ROOT, env: process.env });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { out += d; });
      child.stdin.on("error", () => {}); // the program may already have finished
      child.on("close", (status) => resolve({ status, out }));
      (async () => { for (const a of answers) { await sleep(700); child.stdin.write(a + "\n"); } child.stdin.end(); })();
    });
    const nobody = await run(["zz.test.2fa.nobody"]);
    check("create-admin --reset-2fa: an unknown username → says so, exit code 1, nothing changed", nobody.status === 1 && /No account named/.test(nobody.out));
    const no = await run([NAMES.cli, "n"]);
    check("…answering n → 'Nothing changed' and 2FA is still on", /Nothing changed/.test(no.out) && (await dbRow("cli")).totp_secret !== null && (await recoveryRows("cli")).length === 3);
    const yes = await run([NAMES.cli, "y"]);
    const row = await dbRow("cli");
    check("…answering y → secret and step cleared, recovery codes deleted, exit code 0", yes.status === 0 && row.totp_secret === null && row.last_step === null && (await recoveryRows("cli")).length === 0, yes.out.slice(-200));
    check("…the account's existing session is ended", (await api("GET", "/api/admin/me", { cookie: s })).status === 401);
    check("…and the account logs in with the password alone", (await login(NAMES.cli)).json?.success === true);
    const off = await run([NAMES.cli]);
    check("…running it again on an account without 2FA changes nothing", /not on for/.test(off.out) && off.status === 0);
  }

  // ============================================================ O. the startup check of TOTP_ENCRYPTION_KEY
  // A key that is the right length but not the one the stored secrets were encrypted with starts fine and then breaks every
  // enrolled owner's app-code login. The server tries to decrypt one stored secret at start and logs one ERROR line (it keeps serving).
  {
    const LINE = "Bloomy: ERROR: TOTP_ENCRYPTION_KEY cannot decrypt a stored two-factor secret (the key was changed or lost)";
    const otherKey = Buffer.alloc(32, 9).toString("base64"); // 32 bytes, so loadKey() accepts it; not the key the secrets were made with
    // Start a second server on its own port, give its startup check time to run, stop it, and return what it logged.
    const boot = async (port, env) => {
      const child = spawn("node", ["server.js"], { cwd: ROOT, env: {
        ...process.env, PORT: String(port), SESSION_SECRET: process.env.SESSION_SECRET || "a", BLOOMY_BASE_URL: `http://localhost:${port}`,
        ZALOPAY_ENDPOINT: process.env.ZALOPAY_ENDPOINT || "https://sb-openapi.zalopay.vn", ZALOPAY_APP_ID: process.env.ZALOPAY_APP_ID || "1", ZALOPAY_KEY1: process.env.ZALOPAY_KEY1 || "a", ZALOPAY_KEY2: process.env.ZALOPAY_KEY2 || "a",
        EMAIL_MODE: "log", NODE_ENV: "development", ...env } });
      let out = "", exited = false;
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { out += d; });
      const closed = new Promise((resolve) => child.on("close", () => { exited = true; resolve(); }));
      const answered = await until(async () => { try { await fetch(`http://127.0.0.1:${port}/healthz`); return true; } catch { return false; } }, 10000);
      await sleep(1500); // the check runs right after the start; leave time for a slow database
      const stillRunning = !exited;
      child.kill("SIGTERM");
      await closed;
      return { out, answered, stillRunning };
    };
    const otherEnrolled = Number((await pool.query("SELECT COUNT(*) FROM admin_users WHERE totp_secret IS NOT NULL AND username NOT LIKE 'zz.test.2fa.%'")).rows[0].count);

    await enableInDb("cli");
    const wrong = await boot(3071, { TOTP_ENCRYPTION_KEY: otherKey });
    check("startup with a different key and a stored secret: logs the ERROR line", wrong.out.includes(LINE), wrong.out.slice(0, 160));
    check("…and keeps serving (the storefront does not need the key)", wrong.answered && wrong.stillRunning);
    if (otherEnrolled === 0) {
      const same = await boot(3072, {});
      check("startup with the right key: no ERROR line", same.answered && !same.out.includes("cannot decrypt"), same.out.slice(0, 160));
    } else {
      check(`(startup with the right key not checked: ${otherEnrolled} other enrolled account(s) in this database may use another key)`, true);
    }
    await pool.query("UPDATE admin_users SET totp_secret = NULL WHERE username LIKE 'zz.test.2fa.%'"); // every test account, or the check finds another one's secret
    const none = await boot(3073, { TOTP_ENCRYPTION_KEY: otherKey });
    if (otherEnrolled === 0) check("startup with a different key but no stored secret: nothing to check, no ERROR line", none.answered && !none.out.includes("cannot decrypt"), none.out.slice(0, 160));
    await enableInDb("cli");
    const dbDown = await boot(3074, { TOTP_ENCRYPTION_KEY: otherKey, DB_PORT: "1" });
    check("startup with the database unreachable: no ERROR line (not a key problem) and the server still starts", dbDown.answered && dbDown.stillRunning && !dbDown.out.includes("cannot decrypt"), dbDown.out.slice(0, 160));
    await pool.query("UPDATE admin_users SET totp_secret = NULL WHERE id = $1", [ids.cli]);
  }
} finally {
  await pool.query("DELETE FROM session WHERE (sess ->> 'adminId')::int IN (SELECT id FROM admin_users WHERE username LIKE 'zz.test.2fa.%')");
  await pool.query("DELETE FROM admin_users WHERE username LIKE 'zz.test.2fa.%'");
}
check("cleanup: no test accounts or recovery codes left", Number((await pool.query("SELECT COUNT(*) FROM admin_users WHERE username LIKE 'zz.test.2fa.%'")).rows[0].count) === 0 && Number((await pool.query("SELECT COUNT(*) FROM recovery_codes WHERE admin_user_id NOT IN (SELECT id FROM admin_users)")).rows[0].count) === 0);
await pool.end();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
