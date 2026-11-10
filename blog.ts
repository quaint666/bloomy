// Bloomy — the blog.
//
// Content lives in content/ (BLOOMY_CONTENT_DIR overrides the folder, for tests):
//   posts.json            [{ slug, title, description, published: "YYYY-MM-DD", keyword }, ...]
//   posts/<slug>.html     the body of one post: plain HTML (<h2>, <p>, <a>...) written by the team
//   blog.html             the index page template        } not under public/, so never
//   blog-post.html        the post page template         } served as they are
// In a post, a line holding only  [[product:5]]  becomes a card for product 5 (photo, name,
// price), read from the database when the page is built — so it never goes stale. A
// discontinued or unknown product leaves nothing behind.
//
// posts.json is the one list: the index page and the sitemap both come from it.
// Post fragments are trusted HTML (the team's own files, in the repo); everything from
// posts.json and the database is escaped when it is put into a page.
//
// render.js calls checkContent() once at startup (a mistake in the content stops the
// server with a message, instead of a broken page later) and blogPage() per request.

import fs from "fs";
import path from "path";
import pool = require("./db");

interface Post { slug: string; title: string; description: string; published: string; keyword?: string }
type BlogMatch = { kind: "index" } | { kind: "post"; slug: string };
type Escape = (value: unknown) => string;
interface Helpers { escapeHtml: Escape; formatVND: (amount: number) => string }
interface BlogPage { template: string; tokens: Record<string, string> }
interface CardRow { id: number; name: string; image: string | null; price: number; has_sizes: boolean }

const CONTENT_DIR = process.env.BLOOMY_CONTENT_DIR || path.join(__dirname, "content");
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MARKER_RE = /\[\[product:(\d{1,9})\]\]/g;
const TEMPLATES = ["blog.html", "blog-post.html"];

class ContentError extends Error {}

function validDate(s: unknown): boolean {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Parses posts.json text, checks every post, returns them newest first.
function parsePosts(raw: string): Post[] {
  // Parsed JSON is checked field by field below; until then the Post type is only a claim.
  let list: Post[];
  try {
    list = JSON.parse(raw);
  } catch (err) {
    throw new ContentError(`posts.json is not valid JSON (${(err as Error).message})`);
  }
  if (!Array.isArray(list) || list.length === 0) throw new ContentError("posts.json must be a non-empty list");
  const seen = new Set();
  list.forEach((p, i) => {
    const where = `posts.json, post ${i + 1}`;
    if (!p || typeof p !== "object") throw new ContentError(`${where}: not an object`);
    for (const key of ["slug", "title", "description", "published"] as const) {
      if (typeof p[key] !== "string" || p[key].trim() === "") throw new ContentError(`${where}: "${key}" is missing`);
    }
    if (!SLUG_RE.test(p.slug)) throw new ContentError(`${where}: slug "${p.slug}" must be lower-case letters, digits and hyphens`);
    if (seen.has(p.slug)) throw new ContentError(`${where}: slug "${p.slug}" is used twice`);
    seen.add(p.slug);
    if (p.title.length > 120) throw new ContentError(`${where}: title is longer than 120 characters`);
    if (p.description.length > 300) throw new ContentError(`${where}: description is longer than 300 characters`);
    if (!validDate(p.published)) throw new ContentError(`${where}: "published" must be a real date written YYYY-MM-DD`);
  });
  return [...list].sort((a, b) => (a.published < b.published ? 1 : a.published > b.published ? -1 : 0));
}

function checkFragment(slug: string, html: string): void {
  if (/<script/i.test(html)) throw new ContentError(`posts/${slug}.html contains a <script> (not allowed)`);
  const leftover = html.replace(MARKER_RE, "");
  if (leftover.includes("[[") || leftover.includes("]]")) {
    throw new ContentError(`posts/${slug}.html has a "[[" or "]]" that is not a [[product:N]] marker`);
  }
}

async function loadPosts(): Promise<Post[]> {
  return parsePosts(await fs.promises.readFile(path.join(CONTENT_DIR, "posts.json"), "utf8"));
}

// Startup check (sync, once). Throws with a message that says what to fix.
function checkContent(): number {
  const read = (file: string): string => {
    try {
      return fs.readFileSync(path.join(CONTENT_DIR, file), "utf8");
    } catch (err) {
      throw new ContentError(`cannot read ${path.join(CONTENT_DIR, file)} (is the content/ folder copied into the image?)`);
    }
  };
  TEMPLATES.forEach(read);
  const posts = parsePosts(read("posts.json"));
  posts.forEach((p) => checkFragment(p.slug, read(path.join("posts", `${p.slug}.html`))));
  return posts.length;
}

// "/blog" -> index; "/blog/<slug>" -> a post; anything else -> null.
function matchBlog(reqPath: string): BlogMatch | null {
  if (reqPath === "/blog") return { kind: "index" };
  const m = /^\/blog\/([a-z0-9-]+)$/.exec(reqPath);
  return m ? { kind: "post", slug: m[1] } : null;
}

function readTemplate(name: string): Promise<string> {
  return fs.promises.readFile(path.join(CONTENT_DIR, name), "utf8");
}

const displayDate = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

function listHtml(posts: Post[], esc: Escape): string {
  return posts
    .map(
      (p) => `<li class="blog-list__item">
        <a class="blog-list__link" href="blog/${p.slug}">
          <h2 class="blog-list__title">${esc(p.title)}</h2>
          <p class="blog-list__desc">${esc(p.description)}</p>
          <span class="blog-list__meta">${displayDate(p.published)} · Đọc bài viết →</span>
        </a>
      </li>`
    )
    .join("\n      ");
}

// The post body with each [[product:N]] replaced by a live card (or by nothing).
async function postBody(slug: string, { escapeHtml: esc, formatVND }: Helpers): Promise<string> {
  const html = await fs.promises.readFile(path.join(CONTENT_DIR, "posts", `${slug}.html`), "utf8");
  checkFragment(slug, html);
  const ids = [...new Set([...html.matchAll(MARKER_RE)].map((m) => Number(m[1])))];
  const cards = new Map<number, string>();
  if (ids.length > 0) {
    try {
      const { rows } = await pool.query<CardRow>(
        `SELECT p.id, p.name, p.image, MIN(ps.price) AS price, COUNT(ps.id) > 1 AS has_sizes
         FROM products p JOIN product_sizes ps ON ps.product_id = p.id
         WHERE p.id = ANY($1) AND p.status <> 'discontinued'
         GROUP BY p.id`,
        [ids]
      );
      for (const r of rows) {
        cards.set(
          r.id,
          `<aside class="blog-product"><a class="blog-product__link" href="product.html?id=${Number(r.id)}">` +
            `<img class="blog-product__image" src="${esc(r.image)}" alt="" loading="lazy">` +
            `<span class="blog-product__body"><span class="blog-product__name">${esc(r.name)}</span>` +
            `<span class="blog-product__price">${r.has_sizes ? "Từ " : ""}${formatVND(r.price)}</span>` +
            `<span class="blog-product__cta">Xem sản phẩm →</span></span></a></aside>`
        );
      }
    } catch (err) {
      // The post is still worth reading without its cards.
      console.error("Bloomy: product cards for a blog post could not be read", err);
    }
  }
  return html.replace(MARKER_RE, (_: string, id: string) => cards.get(Number(id)) || "");
}

// What render.js needs to build a blog page: which template and the token values.
// Returns null for a post that does not exist (the caller falls through to a 404).
async function blogPage(match: BlogMatch, base: string, helpers: Helpers): Promise<BlogPage | null> {
  const esc = helpers.escapeHtml;
  const posts = await loadPosts();
  if (match.kind === "index") {
    return { template: "blog.html", tokens: { site_base: base, blog_list: listHtml(posts, esc) } };
  }
  const post = posts.find((p) => p.slug === match.slug);
  if (!post) return null;
  return {
    template: "blog-post.html",
    tokens: {
      site_base: base,
      post_title: post.title,
      post_description: post.description,
      post_date: post.published,
      post_date_display: displayDate(post.published),
      post_url: `${base}/blog/${post.slug}`,
      post_body: await postBody(post.slug, helpers),
      blog_more: listHtml(posts.filter((p) => p.slug !== post.slug), esc),
    },
  };
}

// For the sitemap: the index and every post.
async function sitemapPaths(): Promise<string[]> {
  const posts = await loadPosts();
  return ["/blog", ...posts.map((p) => `/blog/${p.slug}`)];
}

export { checkContent, matchBlog, readTemplate, blogPage, sitemapPaths };
