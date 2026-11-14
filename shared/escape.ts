// Bloomy — escaping text for HTML, written once for the server's page renderer and the browser. Everything a customer
// typed goes through this before it is put into innerHTML (or into a rendered page). The order email has its own
// escapeHtml in email.ts: it turns a missing value into "" where this one writes "null", so the two are not merged.

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
