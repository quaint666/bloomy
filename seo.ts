// Bloomy — product SEO: what a product page says about itself to search engines and
// link previews (title, description, canonical address, preview image, robots), and
// the checks the admin SEO panel shows. ONE implementation: render.js builds the page's
// <head> from effective(), and routes/admin-seo.js builds the panel's preview and checks
// from the same functions, so the panel can never promise something the page does not say.
//
// Owner/manager-written fields on a product (all optional, NULL = not written):
//   seo_keyword      the one phrase this page should be found for
//   seo_title        the page title  (empty -> "<product name> — Bloomy")
//   seo_description  the description  (empty -> the product's short description, cut to fit)

import type { Request } from "express";
import type { ProductStatus } from "./types";
import type { SeoCheck as Check, SeoLevel as Level } from "./shared/api-types";

// The columns of a product row that these functions read (products in schema.sql).
interface SeoProduct {
  id: number; name: string; status: ProductStatus; image: string | null;
  short_description: string | null; description: string | null;
  seo_keyword?: string | null; seo_title?: string | null; seo_description?: string | null;
}

const SITE_NAME = "Bloomy";
const LIMITS = { keyword: 60, title: 70, description: 200 };
const TITLE_SHOWN = 60; // Google shows about this much of a title
const DESCRIPTION_SHOWN = 160; // ... and of a description
const DEFAULT_IMAGE = "images/og-image.jpg";

// One line, Unicode composed, no stray spaces.
const norm = (s: unknown): string => String(s ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
const len = (s: string): number => [...s].length; // characters as people count them

// Matching works on WORDS (letters and digits, any case, accents as typed), never on pieces of
// words: the keyword "hoa" is not found inside "hoan hỷ".
const words = (s: unknown): string[] => norm(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// The keyword's words appear one after the other, in order, as a phrase.
function hasPhrase(text: string, keyword: string): boolean {
  const t = words(text);
  const k = words(keyword);
  if (k.length === 0) return false;
  for (let i = 0; i + k.length <= t.length; i++) {
    if (k.every((w, j) => t[i + j] === w)) return true;
  }
  return false;
}

// The keyword's words that do not appear anywhere in the text.
function missingWords(text: string, keyword: string): string[] {
  const present = new Set(words(text));
  return [...new Set(words(keyword))].filter((w) => !present.has(w));
}

// The site's own address, for absolute URLs (canonical, og:url, og:image). server.js now refuses to start with a
// BLOOMY_BASE_URL that ends in a slash, so the trim below only matters to seo_test, which sets such a value directly.
function baseUrl(req: Pick<Request, "protocol" | "get">): string {
  return (process.env.BLOOMY_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
}

// Cuts at a word boundary and adds "…", so a preview shows what a search engine would.
function cut(text: string, max: number): string {
  if (len(text) <= max) return text;
  const chars = [...text].slice(0, max - 1).join("");
  const at = chars.lastIndexOf(" ");
  return `${(at > max * 0.6 ? chars.slice(0, at) : chars).replace(/[\s,;:.\-–—]+$/, "")}…`;
}

function autoDescription(product: SeoProduct): string {
  const source = norm(product.short_description) || norm(product.description);
  if (!source) return `Chi tiết ${norm(product.name)} tại ${SITE_NAME}: thành phần, giá và tình trạng sẵn có.`;
  return cut(source, 155);
}

function absoluteImage(path: string | null | undefined, base: string): string | null {
  if (!path) return null;
  try {
    return new URL(path, `${base}/`).href;
  } catch {
    return null;
  }
}

// What the page says. `product` needs: id, name, status, image, short_description, description, seo_*.
function effective(product: SeoProduct, base: string) {
  const title = norm(product.seo_title) || `${norm(product.name)} — ${SITE_NAME}`;
  const description = norm(product.seo_description) || autoDescription(product);
  return {
    title,
    description,
    canonical: `${base}/product.html?id=${Number(product.id)}`,
    image: absoluteImage(product.image, base),
    defaultImage: absoluteImage(DEFAULT_IMAGE, base),
    // A discontinued product stays out of search results. Decided per request: it is
    // eligible again the moment the product is available.
    robots: product.status === "discontinued" ? "noindex, follow" : null,
  };
}

// How it would look in a search result (cut the way a search engine cuts it).
function snippet(product: SeoProduct, base: string) {
  const e = effective(product, base);
  return { title: cut(e.title, TITLE_SHOWN), url: e.canonical.replace(/^https?:\/\//, ""), description: cut(e.description, DESCRIPTION_SHOWN) };
}

// ---- the panel's checks -------------------------------------------------------

function lengthCheck(id: string, label: string, n: number, ideal: [number, number], ok: [number, number]): Check {
  const [lo, hi] = ideal;
  const [softLo, softHi] = ok;
  const range = `${lo}–${hi}`;
  if (n >= lo && n <= hi) return { id, level: "good", text: `${label} dài ${n} ký tự (nên ${range}).` };
  if (n < lo) return { id, level: n >= softLo ? "warn" : "bad", text: `${label} ${n >= softLo ? "hơi" : "quá"} ngắn: ${n} ký tự (nên ${range}).` };
  return { id, level: n <= softHi ? "warn" : "bad", text: `${label} ${n <= softHi ? "hơi" : "quá"} dài: ${n} ký tự (nên ${range}), phần thừa sẽ bị cắt.` };
}

// good / warn / bad, each with the sentence to show. `product` carries the (saved or
// not yet saved) seo_* values.
function checks(product: SeoProduct, base: string): Check[] {
  const e = effective(product, base);
  const keyword = norm(product.seo_keyword);
  const list: Check[] = [];
  if (!keyword) {
    list.push({ id: "keyword_set", level: "bad", text: "Chưa có từ khóa chính." });
  } else {
    list.push({ id: "keyword_set", level: "good", text: `Từ khóa chính: “${keyword}”.` });
    list.push(hasPhrase(e.title, keyword)
      ? { id: "keyword_title", level: "good", text: "Từ khóa có trong tiêu đề." }
      : { id: "keyword_title", level: "bad", text: "Từ khóa chưa có trong tiêu đề." });
    list.push(hasPhrase(e.description, keyword)
      ? { id: "keyword_description", level: "good", text: "Từ khóa có trong mô tả." }
      : { id: "keyword_description", level: "warn", text: "Từ khóa chưa có trong mô tả." });
    // The words a visitor reads on the product page (name, short and long description). The SEO
    // title and description are NOT part of this: they have the two checks above. The exact phrase
    // is best; all the words present, even apart, is accepted and says so.
    const text = [product.name, product.short_description, product.description].map(norm).join(" ");
    const missing = missingWords(text, keyword);
    if (hasPhrase(text, keyword)) {
      list.push({ id: "keyword_text", level: "good", text: "Từ khóa có trong nội dung hiển thị trên trang (tên hoặc mô tả sản phẩm)." });
    } else if (missing.length === 0) {
      list.push({ id: "keyword_text", level: "good", text: "Có đủ các từ của từ khóa trong nội dung hiển thị trên trang (chưa liền thành một cụm)." });
    } else {
      list.push({
        id: "keyword_text",
        level: "warn",
        text: `Từ khóa chưa có trong nội dung hiển thị trên trang (tên, mô tả ngắn, mô tả dài; tiêu đề và mô tả SEO không tính). Còn thiếu: ${missing.map((w) => `“${w}”`).join(", ")}.`,
      });
    }
  }
  list.push(lengthCheck("title_length", "Tiêu đề", len(e.title), [30, 60], [20, 70]));
  list.push(lengthCheck("description_length", "Mô tả", len(e.description), [120, 160], [70, 200]));
  return list;
}

function health(product: SeoProduct, base: string): Level {
  const levels = checks(product, base).map((c) => c.level);
  return levels.includes("bad") ? "bad" : levels.includes("warn") ? "warn" : "good";
}

// ---- input from the panel ------------------------------------------------------

const FIELD_KEYS = ["seo_keyword", "seo_title", "seo_description"] as const;
type FieldKey = (typeof FIELD_KEYS)[number];
type SeoValues = Partial<Record<FieldKey, string | null>>;
const FIELD_LIMIT: Record<FieldKey, number> = { seo_keyword: LIMITS.keyword, seo_title: LIMITS.title, seo_description: LIMITS.description };

// Takes the request body; returns { values } (only the fields that were sent; "" becomes
// null) or { field } naming the first bad one.
function cleanFields(body: Record<string, unknown>): { values: SeoValues; field?: undefined } | { field: FieldKey; values?: undefined } {
  const values: SeoValues = {};
  for (const key of FIELD_KEYS) {
    const raw = body[key];
    if (raw === undefined) continue;
    if (raw === null) { values[key] = null; continue; }
    if (typeof raw !== "string") return { field: key };
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) return { field: key };
    const v = norm(raw);
    if (len(v) > FIELD_LIMIT[key]) return { field: key };
    if (key === "seo_keyword" && v !== "" && !/[\p{L}\p{N}]/u.test(v)) return { field: key }; // a keyword needs at least one letter or digit
    values[key] = v === "" ? null : v;
  }
  return { values };
}

export { SITE_NAME, LIMITS, FIELD_KEYS, baseUrl, effective, snippet, checks, health, cleanFields, norm, len };
