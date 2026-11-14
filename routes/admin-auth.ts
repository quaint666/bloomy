// Bloomy — Admin authentication and roles.
// POST /api/admin/login         — username + password (+ a 2FA code when the account has 2FA), sets a session cookie
// POST /api/admin/logout        — destroys the session
// GET  /api/admin/me            — who is logged in: username, role, landing page
// POST /api/admin/me/password   — change your own password
// GET  /api/admin/me/2fa                  — owner: is 2FA on, how many recovery codes are left
// POST /api/admin/me/2fa/setup            — owner: start turning 2FA on (needs the password); returns the QR code
// POST /api/admin/me/2fa/enable           — owner: finish it by typing the first code; returns the recovery codes ONCE
// POST /api/admin/me/2fa/recovery-codes   — owner: replace the recovery codes (needs a current code)
// POST /api/admin/me/2fa/disable          — owner: turn 2FA off (needs a current code)
// requireRole(level)            — middleware for any admin route: the user must
//                                 be logged in, active, and at least `level`
// requireAdmin                  — requireRole("manager"). Every route that was
//                                 written before roles existed uses this name, so
//                                 "admin" here means "manager or above"; employees
//                                 (POS only) and anonymous visitors are kept out.
//
// Roles, lowest to highest:
//   employee  POS only
//   manager   everything day-to-day (orders, products, stock, stats, coupons,
//             refunds) — not Settings, not staff accounts
//   owner     everything, including Settings and the staff page
//
// The session holds only the user's id. The role and the active flag are read
// from the database on EVERY request, so demoting or deactivating someone takes
// effect on their very next click, not when their session expires.
//
// Two-factor login (TOTP; the maths and the encryption are in ../totp.js). Only the owner can turn it on;
// it is optional until then, required for that account after. Login stays ONE request that carries
// everything: username, password and (when the account has 2FA) the code. There is no half-logged-in state:
//   - right password, 2FA on, no code sent  -> 200 { needs_code: true }, nothing in the session. The page
//     then shows the code field and sends all three together.
//   - right password, 2FA on, a code sent   -> checked; only a good one sets the session.
// The session is created only in the request that passed every check, so there is no "password done, code
// pending" session for anything else to trip over.
//
// Wrong codes are only counted after the password was right (otherwise anyone who knew a username could lock
// the owner out): 3 wrong codes lock that ACCOUNT for 5 minutes, in memory (a restart clears it). A code works
// once (totp_last_step), and a recovery code works once (used_at). Because the code step is only reached
// with the right password, its answers are specific (invalid_code, two_factor_locked) rather than the one
// generic 401 below, which still covers every failure BEFORE that point (no username enumeration).
//
// Design locked in fundamentals-learning-handoff.md §4, ported as-is:
// session-based (not JWT), bcrypt (cost 10), rate-limited login only,
// identical generic 401 on every failure branch (no username enumeration),
// session.regenerate() on success (fixation defense), constant-time
// response floor on every credential-revealing exit point.
import { Router } from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import bcrypt from "bcrypt";
import rateLimit from "express-rate-limit";
import QRCode from "qrcode";
import type { PoolClient } from "pg";
import pool = require("../db");
import * as totp from "../totp";
import type { AdminRole, AdminUser, Queryable } from "../types";
import { ROLE_RANK } from "../shared/rules";
import type { AdminLoginBody, AdminMeBody, RecoveryCodesBody, TwoFactorSetupBody, TwoFactorState } from "../shared/api-types";

// The row the login query returns (admin_users in schema.sql).
interface LoginRow { id: number; username: string; password: string; role: AdminRole; active: boolean; totp_secret: string | null }
type SecondFactor = { result: "ok" } | { result: "invalid" } | { result: "locked"; retryAfter: number };

const router = Router();

const BCRYPT_COST = 10;

const ROLES = Object.keys(ROLE_RANK) as AdminRole[];

// Where each role lands after login (and when sent away from a page it may
// not open).
const LANDING: Record<AdminRole, string> = {
  owner: "admin-products.html",
  manager: "admin-products.html",
  employee: "admin-pos.html",
};

// Username: lowercase letters, digits, dot, underscore. schema.sql has the same
// rule as a CHECK on admin_users.username — change both together.
const USERNAME_MIN = 3;
const USERNAME_MAX = 30;
const USERNAME_PATTERN = new RegExp(`^[a-z0-9._]{${USERNAME_MIN},${USERNAME_MAX}}$`);

// Password: bcrypt silently ignores everything past 72 BYTES, so a longer
// password is refused rather than quietly truncated.
const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_BYTES = 72;

function normalizeUsername(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

function validateUsername(username: string): boolean {
  return USERNAME_PATTERN.test(username);
}

function validatePassword(password: unknown): boolean {
  return (
    typeof password === "string" &&
    password.length >= PASSWORD_MIN_LENGTH &&
    Buffer.byteLength(password, "utf8") <= PASSWORD_MAX_BYTES
  );
}

// The one place a password hash is made (the CLI and the staff page both use it).
function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

// Signs a user out of every browser (optionally keeping one session alive —
// the one that just changed its own password).
async function endSessionsFor(db: Queryable, adminId: number, exceptSid: string | null = null): Promise<void> {
  await db.query(
    `DELETE FROM session WHERE sess ->> 'adminId' = $1 AND ($2::text IS NULL OR sid <> $2)`,
    [String(adminId), exceptSid]
  );
}

// 5 FAILED logins per IP per 15 minutes. Successful logins don't count, so
// someone who legitimately signs in again and again (testing roles in several
// windows, a demo) isn't locked out; guessing passwords still is. Once an IP
// is over the limit, even the right password is refused until the window ends.
// (The "needs_code" answer is a 200, so it does not count; a wrong code does.)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
});

// Changing your own password asks for the current one, so it is guarded
// against guessing the same way login is (a stolen session shouldn't be able
// to grind through current-password guesses). The 2FA pages ask for the
// password or a code too, so they share the same kind of guard.
const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
});
const twoFactorLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
});

// Resolves once at least `floorMs` has elapsed since `startTime` — pads
// every credential-revealing response to the same duration so bad-input,
// unknown-username, wrong-password, and success cases are indistinguishable
// by timing alone.
function padToFloor(startTime: number, floorMs = 1000): Promise<void> {
  const elapsed = Date.now() - startTime;
  const remaining = floorMs - elapsed;
  if (remaining <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => setTimeout(resolve, remaining));
}

// ---------------------------------------------------------------------------
// The second factor: checking a typed code
// ---------------------------------------------------------------------------

// 3 wrong codes -> 5 minutes. One entry per account (the key is the admin id).
const CODE_MAX_TRIES = 3;
const CODE_LOCK_MS = 5 * 60 * 1000;
const codeLock = totp.createAttemptLock(CODE_MAX_TRIES, CODE_LOCK_MS);

// What was typed -> which kind of code it is. Six digits is an app code; anything else is tried as a
// recovery code (those are 10 letters/digits, never 6 digits).
const looksLikeAppCode = (typed: string): boolean => /^\d{6}$/.test(typed.replace(/\s+/g, ""));

// An app code: right for the current moment AND newer than the last one accepted. The comparison is inside
// the UPDATE, so two requests carrying the same code cannot both pass (only one changes a row).
async function acceptAppCode(db: Queryable, adminId: number, secret: string, typed: string): Promise<boolean> {
  const step = totp.verify(secret, typed);
  if (step === null) return false;
  const { rowCount } = await db.query(
    `UPDATE admin_users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)`,
    [adminId, step]
  );
  return rowCount === 1;
}

// A recovery code: one of the unused hashes matches, and marking it used changes a row (so it works once
// even if two requests race). Every unused hash is compared, whichever one matches, so the time taken does
// not say which.
async function acceptRecoveryCode(db: Queryable, adminId: number, typed: string): Promise<boolean> {
  const normalized = totp.normalizeRecoveryCode(typed);
  if (normalized.length !== 10) return false;
  const { rows } = await db.query<{ id: number; code_hash: string }>(`SELECT id, code_hash FROM recovery_codes WHERE admin_user_id = $1 AND used_at IS NULL`, [adminId]);
  let matchId: number | null = null;
  for (const row of rows) {
    if (await bcrypt.compare(normalized, row.code_hash)) matchId = row.id;
  }
  if (matchId === null) return false;
  const { rowCount } = await db.query(`UPDATE recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL`, [matchId]);
  return rowCount === 1;
}

// For an account that has 2FA on: is `code` good? -> { result: "ok" } | { result: "invalid" } |
// { result: "locked", retryAfter: seconds }. A try is counted before it is checked (see createAttemptLock).
// A stored secret that cannot be decrypted (wrong TOTP_ENCRYPTION_KEY) throws: that is a server problem and
// is answered as one, never as "wrong code".
async function checkSecondFactor(adminId: number, code: unknown): Promise<SecondFactor> {
  const gate = codeLock.begin(adminId);
  if (!gate.ok) return { result: "locked", retryAfter: gate.secondsLeft };
  const typed = typeof code === "string" ? code.trim() : "";
  const { rows } = await pool.query<{ totp_secret: string | null }>(`SELECT totp_secret FROM admin_users WHERE id = $1`, [adminId]);
  if (!rows[0] || !rows[0].totp_secret) {
    codeLock.succeed(adminId); // nothing to check against: not the person's fault, do not burn a try
    return { result: "invalid" };
  }
  let good: boolean;
  if (looksLikeAppCode(typed)) good = await acceptAppCode(pool, adminId, totp.decryptSecret(rows[0].totp_secret), typed);
  else good = await acceptRecoveryCode(pool, adminId, typed);
  if (good) {
    codeLock.succeed(adminId);
    return { result: "ok" };
  }
  const after = codeLock.fail(adminId);
  return after.locked ? { result: "locked", retryAfter: after.secondsLeft } : { result: "invalid" };
}

// ---------------------------------------------------------------------------
// Login / logout
// ---------------------------------------------------------------------------

router.post("/login", loginLimiter, async (req, res, next) => {
  const startTime = Date.now();
  try {
    // typeof check, not just truthy — a raw JSON call can send non-string
    // types (numbers, arrays) that an HTML form never would.
    if (typeof req.body.username !== "string" || typeof req.body.password !== "string") {
      await padToFloor(startTime);
      return res.status(401).json({ error: "Invalid username or password" });
    }
    const username = normalizeUsername(req.body.username);
    const password = req.body.password;
    // The code is optional. Absent (or empty) = "I have not been asked yet"; present but not text counts as a wrong code.
    const code = req.body.code === undefined || req.body.code === null ? "" : typeof req.body.code === "string" ? req.body.code : "x";

    const result = await pool.query<LoginRow>(
      "SELECT id, username, password, role, active, totp_secret FROM admin_users WHERE username = $1",
      [username]
    );

    if (result.rows.length === 0) {
      await padToFloor(startTime);
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const admin = result.rows[0];
    const passwordMatches = await bcrypt.compare(password, admin.password);

    // A deactivated account gets the same answer as a wrong password, even
    // with the right password — the page never says the account exists.
    if (!passwordMatches || !admin.active) {
      await padToFloor(startTime);
      return res.status(401).json({ error: "Invalid username or password" });
    }

    // The password is right. If the account has 2FA, the code decides the rest.
    if (admin.totp_secret) {
      if (code.trim() === "") {
        await padToFloor(startTime);
        const asksForCode: AdminLoginBody = { needs_code: true };
        return res.json(asksForCode);
      }
      const second = await checkSecondFactor(admin.id, code);
      if (second.result === "locked") {
        await padToFloor(startTime);
        return res.status(429).json({ error: "two_factor_locked", retry_after: second.retryAfter });
      }
      if (second.result !== "ok") {
        await padToFloor(startTime);
        return res.status(401).json({ error: "invalid_code" });
      }
    }

    // Regenerate the session on login — a fresh session id, not reusing
    // whatever pre-login session (if any) the browser already had.
    req.session.regenerate(async (err) => {
      if (err) return next(err);
      req.session.adminId = admin.id;
      // save() is callback-based, not awaitable — the response must wait
      // inside this callback, or it can be sent before the session write
      // to Postgres is actually guaranteed complete.
      req.session.save(async (err) => {
        if (err) return next(err);
        await padToFloor(startTime);
        const body: AdminLoginBody = { success: true, role: admin.role, landing: LANDING[admin.role] };
        res.json(body);
      });
    });
  } catch (err) {
    next(err);
  }
});

router.post("/logout", (req, res, next) => {
  if (!req.session.adminId) {
    return res.status(200).json({ message: "No active session" });
  }
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie("connect.sid");
    res.status(200).json({ message: "Logged out successfully" });
  });
});

function requireRole(minRole: AdminRole): RequestHandler {
  return async function (req, res, next) {
    try {
      if (!req.session.adminId) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const { rows } = await pool.query<AdminUser>(
        "SELECT id, username, role, active FROM admin_users WHERE id = $1",
        [req.session.adminId]
      );
      const admin = rows[0];
      // The account was deleted (CLI/database) or deactivated: end this session.
      if (!admin || !admin.active) {
        return req.session.destroy(() => {
          res.clearCookie("connect.sid");
          res.status(401).json({ error: "Not authenticated" });
        });
      }
      if (ROLE_RANK[admin.role] < ROLE_RANK[minRole]) {
        return res.status(403).json({ error: "forbidden" });
      }
      req.admin = admin; // { id, username, role, active } for the handler
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Every route written before roles existed uses this name; see the header.
const requireAdmin = requireRole("manager");

router.get("/me", requireRole("employee"), (req, res) => {
  const body: AdminMeBody = {
    username: req.admin!.username,
    role: req.admin!.role,
    landing: LANDING[req.admin!.role],
  };
  res.json(body);
});

// Own password: needs the current one. Other browsers signed in as this user
// are signed out; this one stays.
router.post("/me/password", passwordLimiter, requireRole("employee"), async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body;
    if (typeof current_password !== "string" || typeof new_password !== "string") {
      return res.status(400).json({ error: "invalid_payload" });
    }
    if (!validatePassword(new_password)) {
      return res
        .status(400)
        .json({ error: "invalid_password", min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_BYTES });
    }
    const { rows } = await pool.query<{ password: string }>("SELECT password FROM admin_users WHERE id = $1", [req.admin!.id]);
    // 400, not 401: a 401 makes every admin page send the user to the login screen.
    if (!(await bcrypt.compare(current_password, rows[0].password))) {
      return res.status(400).json({ error: "wrong_current_password" });
    }
    const hash = await hashPassword(new_password);
    await pool.query("UPDATE admin_users SET password = $1 WHERE id = $2", [hash, req.admin!.id]);
    await endSessionsFor(pool, req.admin!.id, req.sessionID);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Turning 2FA on and off (owner only)
// ---------------------------------------------------------------------------
// Errors here are 400/409/429, never 401: a 401 makes every admin page send the user to the login screen.

const ownerOnly = requireRole("owner");

const saveSession = (req: Request): Promise<void> => new Promise<void>((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));

// Ten new recovery codes replace whatever was there, in the same transaction as the change that needs them
// (`before` runs first inside it). Returns the codes in plain text: this is the only moment they exist so.
async function replaceRecoveryCodes(adminId: number, before?: (client: PoolClient) => Promise<void>): Promise<string[]> {
  const codes = totp.generateRecoveryCodes();
  const hashes = await Promise.all(codes.map((c) => hashPassword(totp.normalizeRecoveryCode(c))));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (before) await before(client);
    await client.query("DELETE FROM recovery_codes WHERE admin_user_id = $1", [adminId]);
    for (const hash of hashes) await client.query("INSERT INTO recovery_codes (admin_user_id, code_hash) VALUES ($1, $2)", [adminId, hash]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return codes;
}

router.get("/me/2fa", ownerOnly, async (req, res, next) => {
  try {
    const { rows } = await pool.query<TwoFactorState>(
      `SELECT (totp_secret IS NOT NULL) AS enabled,
              (SELECT COUNT(*)::int FROM recovery_codes WHERE admin_user_id = $1 AND used_at IS NULL) AS recovery_remaining
         FROM admin_users WHERE id = $1`,
      [req.admin!.id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Step 1: a new secret, kept (encrypted) in THIS session only until the first code proves the phone has it.
// The password is asked again here: otherwise someone holding a stolen session could enrol their own phone
// and lock the owner out.
router.post("/me/2fa/setup", twoFactorLimiter, ownerOnly, async (req, res, next) => {
  try {
    if (typeof req.body.password !== "string") return res.status(400).json({ error: "invalid_payload" });
    const { rows } = await pool.query<{ password: string; totp_secret: string | null }>("SELECT password, totp_secret FROM admin_users WHERE id = $1", [req.admin!.id]);
    if (!(await bcrypt.compare(req.body.password, rows[0].password))) {
      return res.status(400).json({ error: "wrong_current_password" });
    }
    if (rows[0].totp_secret) return res.status(409).json({ error: "already_enabled" });
    const secret = totp.generateSecret();
    req.session.pendingTotp = totp.encryptSecret(secret);
    await saveSession(req);
    const qr = await QRCode.toDataURL(totp.otpauthUri(secret, req.admin!.username), { margin: 1, width: 240 });
    const body: TwoFactorSetupBody = { secret, qr };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// Step 2: the first code. Only now is the secret written to the account, together with the recovery codes.
// Other browsers signed in as this owner are signed out (they got in without 2FA).
router.post("/me/2fa/enable", twoFactorLimiter, ownerOnly, async (req, res, next) => {
  try {
    const pending = req.session.pendingTotp;
    if (!pending) return res.status(400).json({ error: "no_pending_setup" });
    const typed = typeof req.body.code === "string" ? req.body.code : "";
    const step = totp.verify(totp.decryptSecret(pending), typed);
    if (step === null) return res.status(400).json({ error: "invalid_code" });
    const codes = await replaceRecoveryCodes(req.admin!.id, async (client) => {
      const r = await client.query(
        "UPDATE admin_users SET totp_secret = $2, totp_last_step = $3 WHERE id = $1 AND totp_secret IS NULL",
        [req.admin!.id, pending, step]
      );
      // Turned on meanwhile (another tab): undo this transaction and say so.
      if (r.rowCount !== 1) throw Object.assign(new Error("already enabled"), { alreadyEnabled: true });
    }).catch((err: unknown) => {
      if ((err as { alreadyEnabled?: boolean }).alreadyEnabled) return null;
      throw err;
    });
    if (!codes) return res.status(409).json({ error: "already_enabled" });
    delete req.session.pendingTotp;
    await saveSession(req);
    await endSessionsFor(pool, req.admin!.id, req.sessionID);
    const body: RecoveryCodesBody = { success: true, recovery_codes: codes };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// Both of the following ask for a CURRENT code (an app code or an unused recovery code), counted by the same
// 3-strikes lock as login: a stolen session cannot grind through codes here either.
async function withSecondFactor(req: Request, res: Response, next: NextFunction, then: () => Promise<void>) {
  try {
    const { rows } = await pool.query<{ totp_secret: string | null }>("SELECT totp_secret FROM admin_users WHERE id = $1", [req.admin!.id]);
    if (!rows[0].totp_secret) return res.status(409).json({ error: "not_enabled" });
    const second = await checkSecondFactor(req.admin!.id, req.body.code);
    if (second.result === "locked") return res.status(429).json({ error: "two_factor_locked", retry_after: second.retryAfter });
    if (second.result !== "ok") return res.status(400).json({ error: "invalid_code" });
    await then();
  } catch (err) {
    next(err);
  }
}

router.post("/me/2fa/recovery-codes", twoFactorLimiter, ownerOnly, (req, res, next) =>
  withSecondFactor(req, res, next, async () => {
    const body: RecoveryCodesBody = { success: true, recovery_codes: await replaceRecoveryCodes(req.admin!.id) };
    res.json(body);
  })
);

router.post("/me/2fa/disable", twoFactorLimiter, ownerOnly, (req, res, next) =>
  withSecondFactor(req, res, next, async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE admin_users SET totp_secret = NULL, totp_last_step = NULL WHERE id = $1", [req.admin!.id]);
      await client.query("DELETE FROM recovery_codes WHERE admin_user_id = $1", [req.admin!.id]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    res.json({ success: true });
  })
);

export {
  router,
  requireAdmin,
  requireRole,
  ROLES,
  normalizeUsername,
  validateUsername,
  validatePassword,
  hashPassword,
  endSessionsFor,
  USERNAME_MIN,
  USERNAME_MAX,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_BYTES,
};
