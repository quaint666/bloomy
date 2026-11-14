// Bloomy — shared date check for the routes.

// "YYYY-MM-DD" that is also a real calendar day. The pattern alone lets 2026-02-30 or 2026-13-01 through,
// and the database then refuses them with an error that used to surface as a 500. Year 0000 is a valid
// JavaScript date but not a PostgreSQL one, so it is refused too.
function isRealDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export { isRealDate };
