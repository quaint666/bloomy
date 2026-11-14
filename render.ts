// Bloomy — page renderer for the customer-facing HTML pages.
//
// What it does, per request for a page:
//   1. reads public/<page>.html from disk
//   2. replaces <!--include:name--> with partials/name.html (partials may
//      include other partials, e.g. header -> nav-links)
//   3. replaces {{tokens}} (phone, email, address, fees, the footer's category
//      list...) with the live values from the database, formatted and
//      HTML-escaped
// so the shared header/footer live in ONE file each and the values are
// already in the HTML when it arrives (nothing is filled in by JS afterwards).
//
// Which requests it handles: "/" , "/landing" (the active campaign's page, from
// public/landing.html), "/blog" and "/blog/<slug>" (blog.js builds those from
// content/) and any "/<name>.html" except admin-*.html. Admin pages, CSS/JS/images
// and everything else stay with express.static. A file that does not exist falls
// through to the normal 404.
//
// The landing page exists only while the owner has a campaign switched on:
// otherwise /landing redirects to the product list. /landing.html redirects to
// /landing so there is one address.
//
// Files are read from disk on every request — same as express.static does for
// the pages today — so editing a partial shows on the next refresh.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { Request, RequestHandler } from "express";
import { getPublicSettings } from "./routes/settings";
import { getCategoryTree } from "./routes/categories";
import { getActiveCampaign } from "./routes/campaigns";
import * as blog from "./blog";
import * as seo from "./seo";
import pool = require("./db");
import type { CouponRow } from "./types";
import { escapeHtml } from "./shared/escape";
import { todayVNDateString } from "./shared/vn-time";

// The shapes the three loaders return, taken from the loaders themselves so there is one definition.
type PublicSettings = NonNullable<Awaited<ReturnType<typeof getPublicSettings>>>;
type CategoryTree = Awaited<ReturnType<typeof getCategoryTree>>;
type Campaign = NonNullable<Awaited<ReturnType<typeof getActiveCampaign>>>;
type SeoProduct = Parameters<typeof seo.effective>[0];
type Chip = { code: string; html: string };
// Token name -> value. Every value is a string by the time it is put into a page.
type Tokens = Record<string, string>;

const PUBLIC_DIR = path.join(__dirname, "public");
const PARTIALS_DIR = path.join(__dirname, "partials");

// The partials the pages rely on. Checked once at startup so a missing folder
// (e.g. a forgotten COPY line in the Dockerfile) stops the server with a clear
// message instead of serving pages with raw <!--include:...--> comments.
const REQUIRED_PARTIALS = ["header", "nav-links", "footer", "floating-contact", "checkout-form", "checkout-payment"];

const MAX_INCLUDE_DEPTH = 5;
const INCLUDE_RE = /<!--include:([a-z0-9-]+)-->/g;
const TOKEN_RE = /\{\{\s*([a-z0-9_]+)\s*\}\}/g;

// Tokens whose value is HTML that render.js built itself (every piece of text
// inside it is escaped there). All other tokens are escaped when inserted.
const RAW_TOKENS = new Set(["footer_categories", "campaign_coupon", "campaign_hero_image", "campaign_card", "blog_list", "post_body", "blog_more", "product_robots", "product_og_images"]);

// ---------------------------------------------------------------------------
// Formatting (the same output the old client-side code produced)
// ---------------------------------------------------------------------------

// 25000 -> "25.000đ". Done by hand rather than toLocaleString("vi-VN") so the
// output never depends on how much locale data the Node build ships with.
function formatVND(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "đ";
}

// "0900000000" -> "0900 000 000" (10 digits); any other length is shown as typed.
function formatPhone(digits: string): string {
  return /^[0-9]{10}$/.test(digits) ? `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}` : digits;
}

// ---------------------------------------------------------------------------
// Token values
// ---------------------------------------------------------------------------

// Used when the settings cannot be read (database down): the page still loads,
// text tokens are empty and link tokens point at "#" so no link goes to a
// wrong place.
const FALLBACK_VALUES: Tokens = {
  shop_address: "", contact_phone: "", contact_phone_display: "", contact_email: "",
  vat_rate: "", min_fee: "", max_fee: "",
  maps_url: "#", tel_url: "#", zalo_url: "#",
  footer_categories: "",
  // Campaign tokens: only the homepage and the landing page use them; empty when no campaign is on.
  campaign_name: "", campaign_headline: "", campaign_subheadline: "", campaign_coupon: "", campaign_coupon_code: "",
  campaign_hero_image: "", campaign_card: "",
};

// The footer's "Danh mục" items: top-level categories that have something to
// buy (same rule as the listing's pills), each linking to its listing page.
function categoryItems(tree: CategoryTree): string {
  return tree
    .map((c) => `<li><a href="products.html?category=${Number(c.id)}">${escapeHtml(c.name)}</a></li>`)
    .join("\n        ");
}

// ---- the active campaign's wording and its coupon chip ----

const dayMonth = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`; // "2026-10-15" -> "15/10"

// What the chip promises, read from the coupon row as it is NOW. null when there is
// nothing honest to promise: no coupon, switched off, or its window already ended.
function couponChip(coupon: CouponRow | null): Chip | null {
  if (!coupon || !coupon.active) return null;
  if (coupon.ends_on && coupon.ends_on < todayVNDateString()) return null;
  const discount = coupon.type === "percent" ? `Giảm ${coupon.value}%` : `Giảm ${formatVND(coupon.value)}`;
  const parts = [coupon.min_subtotal > 0 ? `${discount} cho đơn từ ${formatVND(coupon.min_subtotal)}` : discount];
  if (coupon.starts_on && coupon.ends_on) parts.push(`đơn giao từ ${dayMonth(coupon.starts_on)} đến ${dayMonth(coupon.ends_on)}`);
  else if (coupon.starts_on) parts.push(`đơn giao từ ${dayMonth(coupon.starts_on)}`);
  else if (coupon.ends_on) parts.push(`đơn giao đến ${dayMonth(coupon.ends_on)}`);
  return {
    code: coupon.code,
    html: `<span class="campaign-chip"><span class="campaign-chip__code">${escapeHtml(coupon.code)}</span><span class="campaign-chip__text">${escapeHtml(parts.join(" · "))}</span><button type="button" class="campaign-chip__copy" data-copy="${escapeHtml(coupon.code)}" aria-label="Sao chép mã ${escapeHtml(coupon.code)}">Sao chép</button></span>`,
  };
}

// The homepage card: name, headline, subheadline, the chip, and the way in; the campaign's picture
// beside them when it has one (decorative: the headline says it all, so alt is empty).
function campaignCard(c: Campaign, chip: Chip | null): string {
  const media = c.hero_image
    ? `\n        <div class="campaign-card__media"><img class="campaign-card__image" src="${escapeHtml(c.hero_image)}" alt="" loading="lazy" decoding="async"></div>`
    : "";
  return `<section class="campaign-card-section" aria-label="Ưu đãi theo dịp">
    <div class="container">
      <div class="campaign-card">
        <div class="campaign-card__text">
          <p class="campaign-card__name">${escapeHtml(c.name)}</p>
          <h2 class="campaign-card__headline">${escapeHtml(c.headline)}</h2>${c.subheadline ? `\n          <p class="campaign-card__sub">${escapeHtml(c.subheadline)}</p>` : ""}${chip ? `\n          ${chip.html}` : ""}
          <a class="btn btn-primary" href="landing">Xem ưu đãi</a>
        </div>${media}
      </div>
    </div>
  </section>`;
}

function campaignValues(c: Campaign | null): Tokens {
  if (!c) return {};
  const chip = couponChip(c.coupon);
  return {
    campaign_name: c.name,
    campaign_headline: c.headline,
    campaign_subheadline: c.subheadline || "",
    campaign_coupon: chip ? chip.html : "",
    campaign_coupon_code: chip ? chip.code : "",
    // Beside the text, not behind it. It is the first thing painted on the page, so it is not lazy.
    campaign_hero_image: c.hero_image
      ? `<div class="landing-hero__media"><img class="landing-hero__image" src="${escapeHtml(c.hero_image)}" alt="" fetchpriority="high" decoding="async"></div>`
      : "",
    campaign_card: campaignCard(c, chip),
  };
}

// `settings` / `tree` / `campaign` are null when they could not be read (or, for
// the campaign, when none is on): only that part falls back, the rest still shows.
function tokenValues(s: PublicSettings | null, tree: CategoryTree | null, campaign: Campaign | null): Tokens {
  const footer_categories = tree ? categoryItems(tree) : "";
  const extra = { footer_categories, ...campaignValues(campaign) };
  if (!s) return { ...FALLBACK_VALUES, ...extra };
  return {
    shop_address: s.shop_address,
    contact_phone: s.contact_phone,
    contact_phone_display: formatPhone(s.contact_phone),
    contact_email: s.contact_email,
    vat_rate: String(s.vat_rate),
    min_fee: formatVND(s.min_fee),
    max_fee: formatVND(s.max_fee),
    maps_url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.shop_address)}`,
    tel_url: `tel:${s.contact_phone}`,
    zalo_url: `https://zalo.me/${s.contact_phone}`,
    campaign_name: "", campaign_headline: "", campaign_subheadline: "", campaign_coupon: "", campaign_coupon_code: "",
    campaign_hero_image: "", campaign_card: "",
    ...extra,
  };
}

const warnedTokens = new Set<string>();

function fillTokens(html: string, values: Tokens): string {
  return html.replace(TOKEN_RE, (_: string, name: string) => {
    if (Object.prototype.hasOwnProperty.call(values, name)) return RAW_TOKENS.has(name) ? values[name] : escapeHtml(values[name]);
    // A typo in a page shows up as an empty spot; say so once in the log.
    if (!warnedTokens.has(name)) {
      warnedTokens.add(name);
      console.warn(`Bloomy: unknown page token {{${name}}} (rendered as empty)`);
    }
    return "";
  });
}

// ---------------------------------------------------------------------------
// Partials
// ---------------------------------------------------------------------------

async function expandIncludes(html: string, stack: string[] = []): Promise<string> {
  const names = [...new Set([...html.matchAll(INCLUDE_RE)].map((m) => m[1]))];
  if (names.length === 0) return html;
  if (stack.length >= MAX_INCLUDE_DEPTH) throw new Error(`partials nested too deep: ${stack.join(" -> ")}`);
  const parts: Record<string, string> = {};
  for (const name of names) {
    if (stack.includes(name)) throw new Error(`partials include each other: ${[...stack, name].join(" -> ")}`);
    let raw: string;
    try {
      raw = await fs.promises.readFile(path.join(PARTIALS_DIR, `${name}.html`), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`unknown partial "${name}"`);
      throw err;
    }
    parts[name] = await expandIncludes(raw, [...stack, name]);
  }
  // A function replacer, so "$" characters inside a partial are never special.
  return html.replace(INCLUDE_RE, (_: string, name: string) => parts[name]);
}

// Startup check (sync, runs once): every required partial exists and every
// include inside them resolves. Throws with a message that says what to fix.
function checkPartials(): void {
  const visit = (name: string, stack: string[]): void => {
    if (stack.includes(name)) throw new Error(`partials include each other: ${[...stack, name].join(" -> ")}`);
    const file = path.join(PARTIALS_DIR, `${name}.html`);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      throw new Error(`Bloomy: partial not found: ${file} (is the partials/ folder copied into the image?)`);
    }
    for (const m of raw.matchAll(INCLUDE_RE)) visit(m[1], [...stack, name]);
  };
  REQUIRED_PARTIALS.forEach((name) => visit(name, []));
}

// ---------------------------------------------------------------------------
// Asset fingerprints
// ---------------------------------------------------------------------------

// Every css/x.css and js/x.js a page names gets "?v=<8 characters of the file's hash>":
// href="css/style.css" -> href="css/style.css?v=3fa9c01b". The address changes exactly
// when the file does, so Cloudflare and every browser fetch the new file at once; there
// is nothing to purge. (Cloudflare tells browsers to keep a CSS/JS file for 4 hours, so
// without this a visitor could see the old one for that long after a deploy.)
// Only the pages that go through this renderer are covered: the admin pages are served
// as they are by express.static and keep plain addresses.
const ASSET_RE = /\b(href|src)="((?:css|js)\/[A-Za-z0-9_.-]+\.(?:css|js))"/g;
const assetHashes = new Map<string, { mtimeMs: number; size: number; hash: string }>(); // "css/style.css" -> { mtimeMs, size, hash }

// The file is read again only when its size or modified time changed, so a page request
// costs a stat() per asset, not a read. null when the file does not exist.
function assetHash(rel: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(path.join(PUBLIC_DIR, rel));
  } catch (err) {
    return null;
  }
  const known = assetHashes.get(rel);
  if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) return known.hash;
  const hash = crypto.createHash("sha1").update(fs.readFileSync(path.join(PUBLIC_DIR, rel))).digest("hex").slice(0, 8);
  assetHashes.set(rel, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
  return hash;
}

// Runs on the page's own markup, before the {{tokens}} are filled in, so nothing typed
// into the database or a blog post can be mistaken for an asset address.
function versionAssets(html: string): string {
  return html.replace(ASSET_RE, (whole: string, attr: string, rel: string) => {
    const hash = assetHash(rel);
    return hash ? `${attr}="${rel}?v=${hash}"` : whole;
  });
}

// ---------------------------------------------------------------------------
// The middleware
// ---------------------------------------------------------------------------

// "/" -> index.html, "/about.html" -> about.html, anything else (admin pages,
// other folders, odd characters) -> null so express.static handles it.
const PAGE_ALIASES: Record<string, string> = { "/landing": "landing.html" };

function pageFileFor(reqPath: string): string | null {
  if (reqPath === "/") return "index.html";
  if (PAGE_ALIASES[reqPath]) return PAGE_ALIASES[reqPath];
  const m = /^\/([a-z0-9][a-z0-9-]*\.html)$/i.exec(reqPath);
  if (!m || /^admin-/i.test(m[1])) return null;
  return m[1];
}

async function loadSettings(): Promise<PublicSettings | null> {
  try {
    return (await getPublicSettings()) || null;
  } catch (err) {
    console.error("Bloomy: settings unavailable, rendering page without them", err);
    return null;
  }
}

async function loadCampaign(): Promise<Campaign | null> {
  try {
    return await getActiveCampaign({ includeProducts: false });
  } catch (err) {
    console.error("Bloomy: campaign unavailable, rendering the page without it", err);
    return null;
  }
}

async function loadCategories(): Promise<CategoryTree | null> {
  try {
    return await getCategoryTree();
  } catch (err) {
    console.error("Bloomy: categories unavailable, rendering the footer without them", err);
    return null;
  }
}

// The site's own address, for absolute URLs (canonical, og:url): the same rule the sitemap uses.
const { baseUrl } = seo;

// ---- the product page's <head> ----

const GENERIC_PRODUCT = {
  title: "Sản phẩm — Bloomy",
  description: "Chi tiết sản phẩm hoa tươi tại Bloomy — thành phần bó hoa, giá và trạng thái sẵn có được hiển thị rõ ràng trước khi đặt hàng.",
};

const metaTag = (attrs: string): string => `<meta ${attrs}>`;

// The values for product.html's head, from ?id=N, plus the status code to answer with.
//   no id                       -> the generic page, kept out of search results
//   an id that is not a plain number, or that no product has -> 404 (same page), kept out of search results
//   the database cannot be read -> the generic page, nothing claimed about indexing
//   a product                   -> its own title/description/address/photo; "noindex" while discontinued
async function loadProductMeta(req: Request): Promise<{ status: number; tokens: Tokens }> {
  const base = baseUrl(req);
  const defaultImage = new URL("images/og-image.jpg", `${base}/`).href;
  const generic = (status: number, noindex: boolean) => ({
    status,
    tokens: {
      product_title: GENERIC_PRODUCT.title,
      product_description: GENERIC_PRODUCT.description,
      product_canonical: `${base}/product.html`,
      product_robots: noindex ? metaTag('name="robots" content="noindex, follow"') : "",
      product_og_images: metaTag(`property="og:image" content="${escapeHtml(defaultImage)}"`),
    },
  });
  const id = req.query.id;
  if (id === undefined) return generic(200, true);
  if (typeof id !== "string" || !/^\d{1,9}$/.test(id)) return generic(404, true);
  let product: SeoProduct | undefined;
  try {
    const { rows } = await pool.query<SeoProduct>(
      `SELECT id, name, status, image, short_description, description, seo_title, seo_description FROM products WHERE id = $1`,
      [Number(id)]
    );
    product = rows[0];
  } catch (err) {
    console.error("Bloomy: product meta unavailable, serving the generic head", err);
    return generic(200, false);
  }
  if (!product) return generic(404, true);
  const e = seo.effective(product, base);
  const images = [e.image, e.defaultImage].filter(Boolean).map((url) => metaTag(`property="og:image" content="${escapeHtml(url)}"`));
  return {
    status: 200,
    tokens: {
      product_title: e.title,
      product_description: e.description,
      product_canonical: e.canonical,
      product_robots: e.robots ? metaTag(`name="robots" content="${escapeHtml(e.robots)}"`) : "",
      product_og_images: images.join("\n  "),
    },
  };
}

function pageRenderer(): RequestHandler {
  checkPartials(); // throws at startup if something is missing
  blog.checkContent(); // ... and if the blog's content is broken
  return async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    // One address for the landing page; the query string (utm_source...) is kept.
    const search = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
    if (req.path === "/landing.html") return res.redirect(301, `/landing${search}`);
    if (req.path === "/blog/") return res.redirect(301, `/blog${search}`);
    const blogMatch = blog.matchBlog(req.path);
    const file = blogMatch ? null : pageFileFor(req.path);
    if (!file && !blogMatch) return next();
    try {
      let html: string;
      let extra: Tokens = {};
      let status = 200;
      if (blogMatch) {
        const page = await blog.blogPage(blogMatch, baseUrl(req), { escapeHtml, formatVND });
        if (!page) return next(); // no such post: the normal 404
        html = await blog.readTemplate(page.template);
        extra = page.tokens;
      } else {
        try {
          html = await fs.promises.readFile(path.join(PUBLIC_DIR, file!), "utf8");
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "EISDIR") return next();
          throw err;
        }
        if (file === "product.html") {
          const meta = await loadProductMeta(req);
          status = meta.status;
          extra = meta.tokens;
        }
      }
      html = versionAssets(await expandIncludes(html));
      // The campaign is read only for pages that use it (the homepage card, the landing page).
      const needsCampaign = file === "landing.html" || /\{\{\s*campaign_/.test(html);
      const [settings, tree, campaign] = await Promise.all([loadSettings(), loadCategories(), needsCampaign ? loadCampaign() : null]);
      // No campaign on (or unreadable): the landing page does not exist, send people to the products.
      if (file === "landing.html" && !campaign) return res.redirect(302, `/products.html${search}`);
      html = fillTokens(html, { ...tokenValues(settings, tree, campaign), ...extra });
      // The page now holds live settings, so the browser must re-check each
      // time; Express adds an ETag, so an unchanged page is a cheap 304.
      res.set("Cache-Control", "no-cache");
      res.status(status);
      res.type("html");
      res.send(html);
    } catch (err) {
      next(err);
    }
  };
}

export { pageRenderer };
