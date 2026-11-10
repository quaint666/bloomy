// Comment-only change: produces a second build for the deploy rehearsal.
// Bloomy — shared Postgres connection pool.
// Every route file imports this instead of creating its own pool —
// one pool for the whole app, reused across all requests/routes.

import { Pool, types } from "pg";
import { config } from "dotenv";
config({ path: __dirname + "/.env" });

// pg's default parser for `date` columns (OID 1082) builds a JS Date at
// LOCAL SYSTEM midnight, not UTC midnight — correct only when the running
// process's own clock happens to be set to UTC. Every date column in this
// app (delivery_date, override_date, requested_date) is a pure calendar
// date with no time component, so passing it through a timezone-sensitive
// Date object is never actually correct, only sometimes harmless — it
// self-cancels when a value round-trips through a browser in the SAME
// timezone as the server (as admin-orders.html's table does), but breaks
// on any server-only read (as the CSV export did — found as a real
// one-day mismatch between the admin table and the CSV on a local dev
// machine set to Asia/Ho_Chi_Minh, not UTC). Returning the raw
// "YYYY-MM-DD" string sidesteps the whole question. Every place that used
// to call .toISOString().slice(0, 10) on one of these columns now just
// uses the value directly — it's already a plain string.
types.setTypeParser(1082, (val: string) => val);

// Each falls back to the value that used to be hardcoded, so nothing needs
// setting for local development; the deploy sets these in the container's environment.
const pool = new Pool({
  user: process.env.DB_USER || "quaint",
  host: process.env.DB_HOST || "localhost",
  database: process.env.DB_NAME || "bloomy",
  password: process.env.DB_PASSWORD,
  port: Number(process.env.DB_PORT) || 5432,
});

export = pool;
