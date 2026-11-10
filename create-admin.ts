// Bloomy — admin account creator/resetter. Reusable, not one-time-and-
// delete: needed again on every fresh database (local, and production after
// a wipe) to make the FIRST owner; after that, accounts are added from the
// admin's "Nhân sự" page. Also the emergency way back in if every owner
// password is lost. Lives at the repo root, alongside db.js — must never sit
// under public/, since anything there is served to the web.
//
// Run manually: `node create-admin.js`
//
// Prompts for a username and password (password input is masked on the
// terminal, never taken as a command-line argument — that would land in
// shell history). The username is lower-cased and must follow the same rule
// as the staff page; the password is checked by the same function and hashed
// by the same function as everywhere else (routes/admin-auth.js). A new
// account is also asked for its role: "owner" (everything), "manager" (everything
// day-to-day, not Settings or staff accounts; the default, so a mistyped Enter
// gives the middle role) or "employee" (POS only). If the username already
// exists, offers to reset its password instead of failing on the table's UNIQUE
// constraint; a reset leaves the role as it is (and leaves two-factor login on, if it is on).
//
// Run `node create-admin.js --reset-2fa` when an owner has lost the phone AND the recovery codes: it asks for
// the username and turns two-factor login off for that account (secret and recovery codes removed, every
// signed-in browser of that account signed out). The owner can switch it on again from the password page.
// This is the only way back in without a code, which is why it needs a shell on the server.

import readline from "readline";
import pool = require("./db");
import {
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
} from "./routes/admin-auth";

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// readline has no built-in "hidden input" mode — this intercepts the
// interface's own terminal write and swaps real characters for asterisks,
// the same trick most Node CLI password prompts use.
function askHidden(question: string): Promise<string> {
  return new Promise<string>((resolve) => {
    // _writeToOutput is not in readline's public types, so the type below names it.
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout }) as readline.Interface & { _writeToOutput: (str: string) => void };
    const originalWrite = rl._writeToOutput;
    rl._writeToOutput = function (str: string) {
      if (str.charCodeAt(0) === 13 || str.includes("\n")) {
        originalWrite.call(rl, str);
      } else {
        originalWrite.call(rl, "*");
      }
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

// Turn two-factor login off for one account: the secret and the recovery codes go in one transaction, then
// every session of that account ends.
async function resetTwoFactor(): Promise<void> {
  console.log("Bloomy — turn off two-factor login for an account\n");
  const username = normalizeUsername(await ask("Username: "));
  const { rows } = await pool.query<{ id: number; enabled: boolean }>("SELECT id, (totp_secret IS NOT NULL) AS enabled FROM admin_users WHERE username = $1", [username]);
  if (rows.length === 0) {
    console.error(`No account named "${username}". Nothing changed.`);
    process.exitCode = 1;
    return;
  }
  if (!rows[0].enabled) {
    console.log(`Two-factor login is not on for "${username}". Nothing changed.`);
    return;
  }
  const sure = await ask(`Turn off two-factor login for "${username}"? They will sign in with the password alone until they turn it on again. (y/N): `);
  if (sure.toLowerCase() !== "y") {
    console.log("Nothing changed.");
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE admin_users SET totp_secret = NULL, totp_last_step = NULL WHERE id = $1", [rows[0].id]);
    await client.query("DELETE FROM recovery_codes WHERE admin_user_id = $1", [rows[0].id]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await endSessionsFor(pool, rows[0].id);
  console.log(`Two-factor login turned off for "${username}"; their sessions were ended.`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--reset-2fa")) return resetTwoFactor();

  console.log("Bloomy — admin account setup\n");

  const username = normalizeUsername(await ask("Username: "));
  if (!validateUsername(username)) {
    console.error(
      `Username must be ${USERNAME_MIN}-${USERNAME_MAX} characters: lowercase letters, digits, dot or underscore. Nothing changed.`
    );
    process.exitCode = 1;
    return;
  }

  const password = await askHidden("Password: ");
  const confirm = await askHidden("Confirm password: ");
  if (password !== confirm) {
    console.error("Passwords didn't match. Nothing changed.");
    process.exitCode = 1;
    return;
  }
  if (!validatePassword(password)) {
    console.error(
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters and at most ${PASSWORD_MAX_BYTES} bytes. Nothing changed.`
    );
    process.exitCode = 1;
    return;
  }

  const hash = await hashPassword(password);
  const existing = await pool.query("SELECT id FROM admin_users WHERE username = $1", [username]);

  if (existing.rows.length > 0) {
    const overwrite = await ask(`"${username}" already exists. Reset its password? (y/N): `);
    if (overwrite.toLowerCase() !== "y") {
      console.log("Nothing changed.");
      return;
    }
    await pool.query("UPDATE admin_users SET password = $1 WHERE username = $2", [hash, username]);
    console.log(`Password updated for "${username}".`);
  } else {
    const role = (await ask(`Role (${ROLES.join("/")}) [manager]: `)).toLowerCase() || "manager";
    if (!(ROLES as string[]).includes(role)) { // `role` is what was typed, so it may be any text
      console.error(`Role must be one of: ${ROLES.join(", ")}. Nothing changed.`);
      process.exitCode = 1;
      return;
    }
    await pool.query("INSERT INTO admin_users (username, password, role) VALUES ($1, $2, $3)", [username, hash, role]);
    console.log(`Admin account "${username}" created with role "${role}".`);
  }
}

main()
  .catch((err) => {
    console.error("Bloomy: create-admin failed", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
