// Runs the test suites against a throwaway database and a fresh server, then removes both.
//
//   npm test                      all suites          (from the repo root, after `npm run build`)
//   npm test -- listing tags      only the suites whose file name contains one of the words
//   npm test -- --keep            keep the database afterwards (its name is printed), to look at it
//
// What it does: creates `bloomy_test_<id>` on the Postgres that DB_HOST / DB_PORT / DB_USER / DB_PASSWORD name,
// loads schema.sql and the seed files into it (in the order seed.sh lists them: that is the one place the order is
// written), starts `node server.js` on a free port against it, runs the suites one after another with BASE and the
// DB_* variables pointing there, and always stops the server and drops the database, also on a failure or Ctrl-C.
//
// Why: the rate limiters live in the server's memory (20 order requests per 15 minutes, 5 logins, ...), so the suites
// used up a long-running server's budget (the "run the set at most twice per 15 minutes" rule), and a suite that died
// halfway left its test rows in whatever database the server used. A fresh server and a fresh database per run have
// neither problem, and your own `bloomy` database is never touched.
//
// What it does NOT do: run suites in parallel (they share the one database and the one server's limiters), or replace
// the CI loop (CI already has a fresh database and server per run). It needs Postgres to accept CREATE DATABASE from
// DB_USER, and refuses a DB_HOST that is not this machine unless BLOOMY_TEST_ALLOW_HOST=1.

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const ROOT = process.cwd();
const require = createRequire(path.join(ROOT, "package.json"));
const { Client } = require("pg");

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const words = args.filter((a) => !a.startsWith("--"));

const fail = (msg) => { console.error(`run_all: ${msg}`); process.exit(2); };

// ---- what must be there
for (const f of ["server.js", "schema.sql", "seed.sh"]) if (!fs.existsSync(path.join(ROOT, f))) fail(`${f} not found: run it from the repo root, after \`npm run build\``);
if (!fs.existsSync(path.join(ROOT, "tests", "node_modules", "jsdom"))) fail("tests/node_modules is missing: run `cd tests && npm ci` first");

const db = {
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || "quaint",
  password: process.env.DB_PASSWORD || "dev",
};
if (!["127.0.0.1", "localhost", "::1"].includes(db.host) && process.env.BLOOMY_TEST_ALLOW_HOST !== "1") {
  fail(`DB_HOST is ${db.host}, not this machine. The suites write rows: set BLOOMY_TEST_ALLOW_HOST=1 only for a test database server.`);
}

// the seed files, in the order seed.sh loads them
const seedLine = fs.readFileSync(path.join(ROOT, "seed.sh"), "utf8").match(/^for f in ([^;]+); do$/m);
if (!seedLine) fail("could not read the seed file order from seed.sh (the `for f in ...; do` line)");
const seeds = seedLine[1].trim().split(/\s+/);

// the suites to run
let suites = fs.readdirSync(path.join(ROOT, "tests")).filter((f) => f.endsWith("_test.mjs")).sort();
if (words.length) suites = suites.filter((f) => words.some((w) => f.includes(w)));
if (suites.length === 0) fail(`no suite matches: ${words.join(" ")}`);

// ---- the throwaway database
const dbName = `bloomy_test_${process.pid}_${Date.now().toString(36)}`;
const admin = new Client({ ...db, database: process.env.DB_ADMIN_DB || "postgres" });
let server = null;
let running = null; // the suite that is running now
let cleaned = false;

// Children run in their own process group, so killing one also kills the servers a suite started itself.
function killGroup(child, sig) { if (child && child.exitCode === null && child.pid) { try { process.kill(-child.pid, sig); } catch { /* already gone */ } } }

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  killGroup(running, "SIGKILL");
  if (server && server.exitCode === null) {
    killGroup(server, "SIGTERM");
    await new Promise((r) => { const t = setTimeout(() => { killGroup(server, "SIGKILL"); r(); }, 8000); server.once("exit", () => { clearTimeout(t); r(); }); });
  }
  if (keep) { console.log(`\nkept database ${dbName} (drop it with: DROP DATABASE "${dbName}" WITH (FORCE))`); }
  else { try { await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); } catch (e) { console.error(`run_all: could not drop ${dbName}: ${e.message}`); } }
  try { await admin.end(); } catch { /* already closed */ }
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { console.error(`\nrun_all: ${sig}, cleaning up`); cleanup().then(() => process.exit(130)); });

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

let exitCode = 1;
try {
  try { await admin.connect(); } catch (e) { fail(`cannot reach Postgres at ${db.host}:${db.port} as ${db.user}: ${e.message}`); }
  await admin.query(`CREATE DATABASE "${dbName}"`);
  const t0 = Date.now();
  const loader = new Client({ ...db, database: dbName });
  await loader.connect();
  for (const f of ["schema.sql", ...seeds]) {
    try { await loader.query(fs.readFileSync(path.join(ROOT, f), "utf8")); }
    catch (e) { throw new Error(`loading ${f} failed: ${e.message}`); }
  }
  await loader.end();
  console.log(`database ${dbName}: schema and ${seeds.length} seed files loaded (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

  // ---- the fresh server
  const port = await freePort();
  const env = {
    ...process.env,
    DB_HOST: db.host, DB_PORT: String(db.port), DB_USER: db.user, DB_PASSWORD: db.password, DB_NAME: dbName,
    PORT: String(port), BASE: `http://127.0.0.1:${port}`, BLOOMY_BASE_URL: `http://localhost:${port}`,
    SESSION_SECRET: crypto.randomBytes(16).toString("hex"),
    TOTP_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"), // random per run: the server and twofa_test share it
    ZALOPAY_APP_ID: "1", ZALOPAY_KEY1: "dummy", ZALOPAY_KEY2: "dummy", ZALOPAY_ENDPOINT: "https://sb-openapi.zalopay.vn",
    EMAIL_MODE: "log", RESEND_API_KEY: "", NODE_ENV: "development", // never "send": the suites place real orders
  };
  let serverLog = "";
  server = spawn(process.execPath, ["server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  server.stdout.on("data", (d) => { serverLog = (serverLog + d).slice(-4000); });
  server.stderr.on("data", (d) => { serverLog = (serverLog + d).slice(-4000); });
  let up = false;
  for (let i = 0; i < 60 && !up && server.exitCode === null; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { up = (await fetch(`${env.BASE}/healthz`)).ok; } catch { /* not yet */ }
  }
  if (!up) { console.error(serverLog); throw new Error("the server did not come up"); }
  console.log(`server on ${env.BASE}\n`);

  // ---- the suites, one after another
  let checks = 0, failedChecks = 0, failedSuites = 0;
  for (const file of suites) {
    const started = Date.now();
    const out = await new Promise((resolve) => {
      let text = "";
      const child = spawn(process.execPath, [path.join("tests", file)], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
      running = child;
      const timer = setTimeout(() => { text += "\nrun_all: suite timed out after 5 minutes"; killGroup(child, "SIGKILL"); }, 300000);
      child.stdout.on("data", (d) => { text += d; });
      child.stderr.on("data", (d) => { text += d; });
      child.on("exit", (code) => { clearTimeout(timer); resolve({ code, text }); });
    });
    const last = out.text.trim().split("\n").at(-1) ?? "";
    const m = last.match(/^(\d+) passed, (\d+) failed$/);
    const secs = ((Date.now() - started) / 1000).toFixed(1).padStart(5);
    if (m && out.code === 0 && m[2] === "0") {
      checks += Number(m[1]);
      console.log(`ok    ${file.padEnd(26)} ${last.padEnd(22)} ${secs} s`);
    } else {
      failedSuites++;
      if (m) { checks += Number(m[1]); failedChecks += Number(m[2]); }
      console.log(`FAIL  ${file.padEnd(26)} ${(m ? last : `exit ${out.code}, no result line`).padEnd(22)} ${secs} s`);
      for (const line of out.text.split("\n").filter((l) => /FAIL/.test(l)).slice(0, 8)) console.log(`        ${line.slice(0, 200)}`);
      if (!m) console.log(out.text.trim().split("\n").slice(-6).map((l) => `        ${l.slice(0, 200)}`).join("\n"));
    }
  }
  console.log(`\n${suites.length} suites, ${checks} checks passed, ${failedChecks} failed${failedSuites ? `, ${failedSuites} suite(s) failing` : ""}`);
  exitCode = failedSuites ? 1 : 0;
} catch (e) {
  console.error(`run_all: ${e.message}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);
