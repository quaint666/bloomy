// Bloomy — fetch for the admin pages: JSON in, JSON out.
import type { ApiErrorBody } from "../../shared/api-types";

// ok is true only for a 2xx answer with a JSON body, and then data is the body, typed as T. Anything else
// is ok: false, and data is the error body, or null when there is none (a rate-limit answer is plain text).
// T is the caller's word for the shape, not something checked here.
export type ApiResult<T> =
  | { ok: true; res: Response; data: T }
  | { ok: false; res: Response; data: ApiErrorBody | null };

// A 401 sends the person to the login page.
export async function adminApi<T>(method: string, url: string, body?: unknown): Promise<ApiResult<T>> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    window.location.href = "admin-login.html";
    return { ok: false, res, data: null };
  }
  const data = await res.json().catch(() => null);
  return res.ok && data !== null ? { ok: true, res, data } : { ok: false, res, data };
}
