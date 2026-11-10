// Bloomy — shared helpers for the admin CSV exports (orders, products).

import type { Response } from "express";

// Formula-injection guard: a leading =, +, -, or @ is read as a formula by
// Excel/Sheets on open — prefixing with a plain single quote forces the
// cell to be read as text instead. Applied to every field, not just
// customer-typed ones, since it's cheap and future-proof against a column
// added later that does carry customer text.
function csvSafe(value: unknown): string {
  if (value === null || value === undefined) return "";
  let v = String(value);
  if (/^[=+\-@]/.test(v)) v = `'${v}`;
  return `"${v.replace(/"/g, '""')}"`;
}

// Sends finished CSV lines (header first) as a download named
// bloomy-<name>-<date>.csv. The leading BOM makes Excel read it as UTF-8, so
// Vietnamese text isn't garbled.
function sendCsv(res: Response, name: string, lines: string[]): void {
  const csv = "\uFEFF" + lines.join("\r\n");
  const filename = `bloomy-${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
}

export { csvSafe, sendCsv };
