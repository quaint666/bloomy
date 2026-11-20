// The API table in docs/00-HANDOFF.md against the routes the server really has. It reads files only (no server, no
// database), so it also runs on a checkout with nothing built.
//
// Run from the repo root:   node tests/docs_routes_test.mjs
//
// The real routes are read from the source: server.ts says which router file is mounted where (`app.use("/api/x", xRouter)`)
// and each routes/*.ts says its own paths (`router.get("/:id", ...)`); `app.get(...)` in server.ts adds /healthz and
// /sitemap.xml. A route written in a way this reader cannot follow (a path that is not a plain string, a router that is
// not mounted the usual way) FAILS the test on purpose: better a red check than a route that is silently not compared.
//
// Proves: every route is in the table, every row of the table is a route, each row names the router file it is in (as
// the .ts it is written in), and no doc mentions a routes/ file that does not exist.
// Does NOT prove: that the "auth" column is right (who may call it), or that the code behaves as the doc says.

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

let passed = 0, failed = 0;
function check(name, cond, extra = "") { if (cond) passed++; else { failed++; console.log(`FAIL ${name}${extra ? " :: " + extra : ""}`); } }

// ---- the routes the code has
const server = read("server.ts");
const routerFile = new Map(); // import name -> routes/<file>
for (const [, name, file] of server.matchAll(/import (\w+) = require\("\.\/routes\/([\w-]+)"\)/g)) routerFile.set(name, file);
for (const [, name, file] of server.matchAll(/import \{ router as (\w+) \} from "\.\/routes\/([\w-]+)"/g)) routerFile.set(name, file);

const real = new Map(); // "METHOD /path" -> file
const problems = [];
for (const [, prefix, name] of server.matchAll(/app\.use\("(\/[^"]*)",\s*(\w+)\)/g)) {
  const file = routerFile.get(name);
  if (!file) { problems.push(`server.ts mounts ${name} at ${prefix}, but it is not imported from ./routes/`); continue; }
  const src = read(`routes/${file}.ts`);
  const calls = [...src.matchAll(/router\.(get|post|put|patch|delete|head)\(\s*([^,)]+)/g)];
  if (calls.length === 0) problems.push(`routes/${file}.ts has no router.get/post/... call this test can read`);
  for (const [, method, arg] of calls) {
    const lit = arg.trim().match(/^"([^"]*)"$/);
    if (!lit) { problems.push(`routes/${file}.ts: router.${method}(${arg.trim()}) is not a plain string path`); continue; }
    const sub = lit[1] === "/" ? "" : lit[1];
    real.set(`${method.toUpperCase()} ${(prefix + sub).replace(/\/$/, "") || "/"}`, file);
  }
}
for (const [, method, p] of server.matchAll(/app\.(get|post|head)\("(\/[^"]*)"/g)) real.set(`${method.toUpperCase()} ${p}`, "server");
check("the reader followed every mount and every route in the code", problems.length === 0, problems.join("; "));
check("setup: the reader found a plausible number of routes", real.size >= 70, String(real.size));

// ---- the rows of the table
const doc = read("docs/00-HANDOFF.md");
const rows = new Map(); // "METHOD /path" -> { auth, file }
for (const line of doc.split("\n")) {
  const m = line.match(/^\| (GET|POST|PATCH|PUT|DELETE|HEAD) \| `([^`]+)`[^|]*\| ([^|]+) \| ([^|]+) \|/);
  if (m) rows.set(`${m[1]} ${m[2].split(" ")[0]}`, { auth: m[3].trim(), file: m[4].trim() });
}
check("setup: the table has rows", rows.size >= 70, String(rows.size));

const undocumented = [...real.keys()].filter((k) => !rows.has(k));
check("every route of the server is a row of the table", undocumented.length === 0, undocumented.join(", "));
const gone = [...rows.keys()].filter((k) => !real.has(k));
check("every row of the table is a route of the server", gone.length === 0, gone.join(", "));
const wrongFile = [...rows].filter(([k, v]) => real.has(k) && v.file !== (real.get(k) === "server" ? "server.ts" : `routes/${real.get(k)}.ts`)).map(([k, v]) => `${k}: says ${v.file}, is in ${real.get(k)}`);
check("each row names the file the route is in, as the .ts it is written in", wrongFile.length === 0, wrongFile.slice(0, 3).join("; ") + (wrongFile.length > 3 ? ` ... (${wrongFile.length} rows)` : ""));

// ---- file names in the prose
const mentioned = new Set();
for (const f of ["docs/00-HANDOFF.md", "README.md", "CLAUDE.md"]) for (const [, name, ext] of read(f).matchAll(/\broutes\/([\w-]+)\.(js|ts)\b/g)) mentioned.add(`${f}: routes/${name}.${ext}`);
const stale = [...mentioned].filter((s) => { const [, name, ext] = s.match(/routes\/([\w-]+)\.(js|ts)$/); return ext === "js" || !fs.existsSync(path.join(ROOT, "routes", `${name}.ts`)); });
check("no doc names a routes/ file that is not there (the sources are .ts; .js is only build output)", stale.length === 0, stale.slice(0, 6).join("; ") + (stale.length > 6 ? ` ... (${stale.length})` : ""));

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
