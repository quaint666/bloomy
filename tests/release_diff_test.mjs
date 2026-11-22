// deploy/scripts/release_diff.sh: what a release changes for the deploy (schema.sql, and the environment variables the app
// requires at start). The staging deploy workflow (in the homelab repo) runs it on every Bloomy bump and reads two of its lines,
// so this suite pins them. It reads the REAL server.ts of this checkout (so it fails the day that file's REQUIRED_ENV block no longer
// matches what the script reads, which is how the script went stale when server.js became server.ts) and builds a throwaway git
// repository with revisions made from it.
//
// Run from the repo root:  node tests/release_diff_test.mjs        (needs git and bash; CI installs both for this suite)
//
// Proves: the script reads REQUIRED_ENV from server.ts (the array and the EMAIL_MODE=send additions), exits 0 and prints
// "required env added:   none" / "required env removed: none" (three spaces after "added:") for identical revisions; a name added
// to the array, a name added to the EMAIL_MODE=send block and a name removed are each reported by name; a revision that still has
// server.js is read too; schema.sql changes are reported; a revision with no readable block exits 1 with a message. Does NOT
// prove: the workflow itself (it lives in another repository) or that the names in REQUIRED_ENV are the ones the app needs.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "deploy", "scripts", "release_diff.sh");
let passed = 0, failed = 0;
function check(name, cond, extra = "") { if (cond) passed++; else { failed++; console.log(`FAIL ${name}${extra ? " :: " + extra : ""}`); } }

const probe = spawnSync("git", ["--version"], { encoding: "utf8" });
check("the git command is available", probe.status === 0, "install git (CI: apk add git)");
if (probe.status !== 0) { console.log(`${passed} passed, ${failed} failed`); process.exit(1); }

const real = fs.readFileSync(path.join(ROOT, "server.ts"), "utf8");
const schema = fs.readFileSync(path.join(ROOT, "schema.sql"), "utf8");
const edit = (text, from, to) => { if (text.split(from).length !== 2) throw new Error(`the real server.ts no longer has exactly one "${from}"`); return text.replace(from, to); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-diff-"));
const git = (...args) => { const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" }); if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
git("init", "-q");
const rev = (files) => {
  for (const f of fs.readdirSync(dir)) if (f !== ".git") fs.rmSync(path.join(dir, f), { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  git("add", "-A"); git("commit", "-q", "--allow-empty", "-m", "r"); return git("rev-parse", "--short=12", "HEAD");
};
const run = (a, b) => { const r = spawnSync("bash", [SCRIPT, a, b], { cwd: dir, encoding: "utf8" }); return { code: r.status, out: r.stdout, err: r.stderr }; };

try {
  const arrayEnd = '  "TOTP_ENCRYPTION_KEY",\n];';
  const pushLine = 'REQUIRED_ENV.push("RESEND_API_KEY", "EMAIL_FROM", "SHOP_NOTIFICATION_EMAIL");';
  const r0 = rev({ "server.ts": real, "schema.sql": schema });
  const rSame = rev({ "server.ts": real, "schema.sql": schema });
  const rAdded = rev({ "server.ts": edit(real, arrayEnd, '  "TOTP_ENCRYPTION_KEY", "NEW_VAR_ONE",\n];'), "schema.sql": schema });
  const rPushed = rev({ "server.ts": edit(real, pushLine, 'REQUIRED_ENV.push("RESEND_API_KEY", "EMAIL_FROM", "SHOP_NOTIFICATION_EMAIL", "NEW_PUSHED_VAR");'), "schema.sql": schema });
  const rRemoved = rev({ "server.ts": edit(real, '"ZALOPAY_KEY2", ', ""), "schema.sql": schema });
  const rSchema = rev({ "server.ts": real, "schema.sql": schema + "\n-- changed\n" });
  const rLegacy = rev({ "server.js": real, "schema.sql": schema });   // a revision from before the TypeScript move
  const rBroken = rev({ "server.ts": edit(real, "const REQUIRED_ENV = [", "const REQUIRED = ["), "schema.sql": schema });

  const same = run(r0, rSame);
  check("identical revisions: exit 0", same.code === 0, `${same.code} ${same.err}`);
  check("…\"required env added:   none\" (three spaces after the colon)", same.out.split("\n").includes("required env added:   none"), JSON.stringify(same.out));
  check("…\"required env removed: none\"", same.out.split("\n").includes("required env removed: none"), JSON.stringify(same.out));
  check("…\"schema.sql: unchanged\"", same.out.split("\n").includes("schema.sql: unchanged"));

  const added = run(r0, rAdded);
  check("a name added to the array is reported by name, and only that one", added.code === 0 && added.out.split("\n").includes("required env added:   NEW_VAR_ONE") && added.out.split("\n").includes("required env removed: none"), JSON.stringify(added.out));
  const pushed = run(r0, rPushed);
  check("a name added to the EMAIL_MODE=send block is reported too (the read does not stop at the array)", pushed.out.split("\n").includes("required env added:   NEW_PUSHED_VAR"), JSON.stringify(pushed.out));
  const removed = run(r0, rRemoved);
  check("a name removed is reported by name", removed.code === 0 && removed.out.split("\n").includes("required env removed: ZALOPAY_KEY2") && removed.out.split("\n").includes("required env added:   none"), JSON.stringify(removed.out));
  const both = run(rRemoved, rAdded);
  check("added and removed together, in order", both.out.split("\n").includes("required env added:   NEW_VAR_ONE ZALOPAY_KEY2") && both.out.split("\n").includes("required env removed: none"), JSON.stringify(both.out));
  const legacy = run(rLegacy, rAdded);
  check("an older revision that still has server.js is read too", legacy.code === 0 && legacy.out.split("\n").includes("required env added:   NEW_VAR_ONE"), JSON.stringify(legacy));
  const sch = run(r0, rSchema);
  check("a change to schema.sql is reported", sch.code === 0 && /^schema\.sql: CHANGED \(/m.test(sch.out), JSON.stringify(sch.out));

  const broken = run(r0, rBroken);
  check("a revision whose REQUIRED_ENV block cannot be read: exit 1, a message naming server.ts, no \"added\" line", broken.code === 1 && /could not read REQUIRED_ENV from server\.ts/.test(broken.err) && !/required env added/.test(broken.out), JSON.stringify(broken));
  check("a missing revision: exit 1", run(r0, "no-such-rev").code !== 0);
  check("wrong number of arguments: exit 2", spawnSync("bash", [SCRIPT, "only-one"], { cwd: dir }).status === 2);

  // the real file, read the way the script reads it: the block ends at a line that is exactly "}" and holds every name
  const block = real.split("\n"); const start = block.findIndex((l) => l.startsWith("const REQUIRED_ENV = ["));
  const end = block.findIndex((l, i) => i > start && l === "}");
  const names = block.slice(start, end + 1).join("\n").match(/"[A-Z][A-Z0-9_]+"/g) ?? [];
  check("the real server.ts: the block the script reads holds the array and the EMAIL_MODE=send names (11 or more)", end > start && names.length >= 11 && names.includes('"TOTP_ENCRYPTION_KEY"') && names.includes('"SHOP_NOTIFICATION_EMAIL"'), `${names.length} names, lines ${start + 1}-${end + 1}`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
