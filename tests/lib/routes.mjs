// Reads the routes the server has from the SOURCE: server.ts says which router file is mounted where
// (`app.use("/api/x", xRouter)`), each routes/*.ts says its own paths and the middleware in front of the handler
// (`router.get("/:id", requireAdmin, async (req, res) => ...)`), and `app.get(...)` in server.ts adds /healthz and
// /sitemap.xml. Shared by docs_routes_test.mjs and admin_auth_test.mjs, so the reading is written once.
//
// A route written in a way this cannot follow (a path that is not a plain string, a router that is not mounted the
// usual way) is returned in `problems`, and the tests fail on it: better a red check than a route that is silently
// not compared.
import fs from "node:fs";
import path from "node:path";

export function readRoutes(root) {
  const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
  const server = read("server.ts");
  const routerFile = new Map(); // import name -> routes/<file>
  for (const [, name, file] of server.matchAll(/import (\w+) = require\("\.\/routes\/([\w-]+)"\)/g)) routerFile.set(name, file);
  for (const [, name, file] of server.matchAll(/import \{ router as (\w+) \} from "\.\/routes\/([\w-]+)"/g)) routerFile.set(name, file);

  const routes = []; // { key: "GET /api/x", method, path, file, chain: ["requireAdmin", ...] }
  const problems = [];
  for (const [, prefix, name] of server.matchAll(/app\.use\("(\/[^"]*)",\s*(\w+)\)/g)) {
    const file = routerFile.get(name);
    if (!file) { problems.push(`server.ts mounts ${name} at ${prefix}, but it is not imported from ./routes/`); continue; }
    const src = read(`routes/${file}.ts`);
    const calls = [...src.matchAll(/router\.(get|post|put|patch|delete|head)\(\s*([^,)]+)([^\n]*)/g)];
    if (calls.length === 0) problems.push(`routes/${file}.ts has no router.get/post/... call this test can read`);
    for (const [, method, arg, rest] of calls) {
      const lit = arg.trim().match(/^"([^"]*)"$/);
      if (!lit) { problems.push(`routes/${file}.ts: router.${method}(${arg.trim()}) is not a plain string path`); continue; }
      const sub = lit[1] === "/" ? "" : lit[1];
      const full = (prefix + sub).replace(/\/$/, "") || "/";
      // the middleware between the path and the handler: everything up to `async (`, `(req`, `(_req` or `async function`
      const head = rest.replace(/^\s*,/, "").split(/\basync\b|\(\s*_?req\b|\bfunction\b|\(\s*\)\s*=>/)[0] ?? "";
      const chain = [...head.matchAll(/\b(requireRole\(\s*"\w+"\s*\)|\w+)\s*(?:,|$)/g)].map((m) => m[1].replace(/\s+/g, ""));
      routes.push({ key: `${method.toUpperCase()} ${full}`, method: method.toUpperCase(), path: full, file, chain });
    }
  }
  for (const [, method, p] of server.matchAll(/app\.(get|post|head)\("(\/[^"]*)"/g)) routes.push({ key: `${method.toUpperCase()} ${p}`, method: method.toUpperCase(), path: p, file: "server", chain: [] });
  return { routes, problems };
}
