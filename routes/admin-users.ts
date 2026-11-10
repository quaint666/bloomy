// Bloomy — Staff accounts ("Nhân sự"). Owner only.
// GET   /api/admin/users              — every account: username, role, active
// POST  /api/admin/users              — create { username, role, password }
// PATCH /api/admin/users/:id          — { role?, active? }
// POST  /api/admin/users/:id/password — owner sets a new password { password }
//
// Rules:
//  - The owner can't change their own role or deactivate themselves, or reset
//    their own password here (that's the "Đổi mật khẩu" page, which asks for the
//    current one). To hand over ownership, promote someone else first.
//  - The last active owner can never be demoted or deactivated. That's checked
//    inside the UPDATE, under a lock: without the lock, two owners demoting each
//    other at the same moment would each still see the other as an owner.
//  - Accounts are deactivated, never deleted. Deactivating (or resetting a
//    password) signs that person out of every browser straight away.
//  - Role changes need no sign-out: the role is read from the database on each
//    request (see requireRole).

import { Router } from "express";
import pool = require("../db");
import {
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
} from "./admin-auth";
import type { AdminUser } from "../types";

const router = Router();

const requireOwner = requireRole("owner");

// Any fixed number: all owner-affecting updates queue on the same advisory lock.
const OWNER_CHANGE_LOCK = 41001;

const invalidUsername = { error: "invalid_username", min: USERNAME_MIN, max: USERNAME_MAX };
const invalidPassword = { error: "invalid_password", min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_BYTES };

router.get("/", requireOwner, async (req, res, next) => {
  try {
    const { rows } = await pool.query<AdminUser>(
      `SELECT id, username, role, active FROM admin_users ORDER BY username`
    );
    // `me` lets the page disable the controls on the owner's own row.
    res.json({ me: req.admin!.id, users: rows });
  } catch (err) {
    next(err);
  }
});

router.post("/", requireOwner, async (req, res, next) => {
  try {
    const username = normalizeUsername(req.body.username);
    const { role, password } = req.body;
    if (!validateUsername(username)) return res.status(400).json(invalidUsername);
    if (!ROLES.includes(role)) return res.status(400).json({ error: "invalid_role" });
    if (!validatePassword(password)) return res.status(400).json(invalidPassword);

    const hash = await hashPassword(password);
    try {
      const { rows } = await pool.query<AdminUser>(
        `INSERT INTO admin_users (username, password, role) VALUES ($1, $2, $3)
         RETURNING id, username, role, active`,
        [username, hash, role]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return res.status(409).json({ error: "username_taken" });
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", requireOwner, async (req, res, next) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });
  if (id === req.admin!.id) return res.status(400).json({ error: "cannot_change_self" });

  const { role, active } = req.body;
  if (role === undefined && active === undefined) return res.status(400).json({ error: "nothing_to_update" });
  if (role !== undefined && !ROLES.includes(role)) return res.status(400).json({ error: "invalid_role" });
  if (active !== undefined && typeof active !== "boolean") return res.status(400).json({ error: "invalid_active" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [OWNER_CHANGE_LOCK]);
    // The WHERE lets the change through unless it would leave no active owner:
    // the target isn't an active owner, or stays one, or another active owner exists.
    const { rows } = await client.query<AdminUser>(
      `UPDATE admin_users u
       SET role = COALESCE($2::admin_role, u.role), active = COALESCE($3::boolean, u.active)
       WHERE u.id = $1
         AND (
           u.role <> 'owner' OR u.active = false
           OR (COALESCE($2::admin_role, u.role) = 'owner' AND COALESCE($3::boolean, u.active) = true)
           OR EXISTS (SELECT 1 FROM admin_users o WHERE o.role = 'owner' AND o.active AND o.id <> u.id)
         )
       RETURNING id, username, role, active`,
      [id, role ?? null, active ?? null]
    );
    await client.query("COMMIT");

    if (rows.length === 0) {
      const exists = await pool.query("SELECT 1 FROM admin_users WHERE id = $1", [id]);
      if (exists.rows.length === 0) return res.status(404).json({ error: "user_not_found" });
      return res.status(409).json({ error: "last_owner" });
    }
    if (active === false) await endSessionsFor(pool, id);
    res.json(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/password", requireOwner, async (req, res, next) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });
    if (id === req.admin!.id) return res.status(400).json({ error: "use_account_page" });
    if (!validatePassword(req.body.password)) return res.status(400).json(invalidPassword);

    const hash = await hashPassword(req.body.password);
    const { rowCount } = await pool.query("UPDATE admin_users SET password = $1 WHERE id = $2", [hash, id]);
    if (rowCount === 0) return res.status(404).json({ error: "user_not_found" });
    await endSessionsFor(pool, id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export = router;
