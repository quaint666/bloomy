// The blog as the server sends it: the index, the three posts, the live product cards, the rules (404s, redirects,
// nothing served raw), the sitemap, what the owner's files can and cannot do (escaping, startup validation), and a
// database outage.
//
// Run from the repo root with the server running on the same database:
//   export DB_HOST=127.0.0.1 DB_PORT=5433 DB_PASSWORD=dev
//   BASE=http://localhost:3000 node tests/blog_test.mjs
//
// It briefly renames a product, changes a price and discontinues a product, and starts extra servers (ports
// 39704-39706) on temporary copies of content/. Everything is put back in a finally block. Local or test database only.
//
// Proves: the index and posts are built from content/posts.json and the fragments, the five agreed text fixes are
// in, every link on them leads somewhere, product cards are live and escaped, a bad content/ stops the server at
// startup with a message, and the blog survives a database outage.
// Does NOT prove: how any of it looks, or that the images exist (they are not in this checkout's test database).

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import jsdom from "jsdom";
const { JSDOM } = jsdom;

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const ROOT = process.cwd();
const require = createRequire(path.join(ROOT, "package.json"));
const { Pool } = require("pg");
const pool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1", port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || "quaint", database: process.env.DB_NAME || "bloomy", password: process.env.DB_PASSWORD || "dev",
});

let passed = 0, failed = 0;
function check(name, cond, extra = "") { if (cond) passed++; else { failed++; console.log(`FAIL ${name}${extra ? " :: " + extra : ""}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p, opts) => fetch(BASE + p, { redirect: "manual", ...opts });
const dom = (html) => new JSDOM(html).window.document;
const money = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "đ";
const ddmmyyyy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

// Stop early if this script's database is not the server's database.
{
  const row = (await pool.query("SELECT shop_address, contact_phone, contact_email, vat_rate FROM settings")).rows[0];
  const api = await (await get("/api/settings")).json();
  if (!row || row.shop_address !== api.shop_address || row.contact_phone !== api.contact_phone || row.contact_email !== api.contact_email || row.vat_rate !== api.vat_rate) {
    console.log("FAIL this script is connected to a different database than the server at " + BASE + " (settings differ). Export the same DB_HOST / DB_PORT / DB_PASSWORD as the server and run again.");
    process.exit(2);
  }
}

// What the files say (read here, independently of the server).
const CONTENT = path.join(ROOT, "content");
const posts = JSON.parse(fs.readFileSync(path.join(CONTENT, "posts.json"), "utf8")).sort((a, b) => (a.published < b.published ? 1 : -1));
const fragment = (slug) => fs.readFileSync(path.join(CONTENT, "posts", `${slug}.html`), "utf8");
const markers = (slug) => [...fragment(slug).matchAll(/\[\[product:(\d+)\]\]/g)].map((m) => Number(m[1]));
const bySlug = (slug) => posts.find((p) => p.slug === slug);
const P1 = "cach-chon-hoa-sinh-nhat-cho-me-nguoi-yeu-ban-be", P2 = "cach-giu-hoa-tuoi-lau-tai-nha", P3 = "y-nghia-cac-loai-hoa-va-mau-sac-khi-tang";

const original = { products: new Map(), prices: new Map() };
const buyable = async (id) => (await pool.query("SELECT 1 FROM products WHERE id=$1 AND status <> 'discontinued'", [id])).rowCount === 1;
const card = async (id) => (await pool.query("SELECT p.name, MIN(ps.price) AS price, COUNT(ps.id) > 1 AS has_sizes FROM products p JOIN product_sizes ps ON ps.product_id=p.id WHERE p.id=$1 GROUP BY p.id", [id])).rows[0];

function serverEnv(port, extra = {}) {
  return { ...process.env, PORT: String(port), SESSION_SECRET: process.env.SESSION_SECRET || "x", BLOOMY_BASE_URL: "http://localhost",
    ZALOPAY_ENDPOINT: process.env.ZALOPAY_ENDPOINT || "https://sb-openapi.zalopay.vn", ZALOPAY_APP_ID: process.env.ZALOPAY_APP_ID || "1", ZALOPAY_KEY1: process.env.ZALOPAY_KEY1 || "a", ZALOPAY_KEY2: process.env.ZALOPAY_KEY2 || "b",
    DB_PASSWORD: process.env.DB_PASSWORD || "dev", EMAIL_MODE: "log", ...extra };
}
async function withServer(port, extra, fn) {
  const child = spawn("node", ["server.js"], { cwd: ROOT, env: serverEnv(port, extra), stdio: "ignore" });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(`http://127.0.0.1:${port}/css/style.css`)).ok; } catch {} }
    check(`extra server on ${port} starts`, up);
    if (up) await fn(`http://127.0.0.1:${port}`);
  } finally { child.kill(); }
}
function tempContent(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bloomy-content-"));
  fs.cpSync(CONTENT, dir, { recursive: true });
  mutate?.(dir);
  return dir;
}

try {
  // ------------------------------------------------------------ 1. the index
  {
    const r = await get("/blog");
    const html = await r.text();
    const d = dom(html);
    check("/blog: 200, html, no-cache", r.status === 200 && /text\/html/.test(r.headers.get("content-type")) && r.headers.get("cache-control") === "no-cache", `${r.status}`);
    check("…nothing left unfilled", !html.includes("<!--include") && !/\{\{/.test(html));
    check("…<base href=\"/\"> comes before any link or file path", d.querySelector("head base")?.getAttribute("href") === "/" && html.indexOf("<base") < html.indexOf("<link"));
    check("…title, one h1, canonical", d.title === "Blog — Bloomy" && d.querySelectorAll("h1").length === 1 && /\/blog$/.test(d.querySelector('link[rel="canonical"]').getAttribute("href")));
    const items = [...d.querySelectorAll(".blog-list__item")];
    check("…one entry per post in posts.json, newest first", JSON.stringify(items.map((li) => li.querySelector("a").getAttribute("href"))) === JSON.stringify(posts.map((p) => `blog/${p.slug}`)), JSON.stringify(items.map((li) => li.querySelector("a").getAttribute("href"))));
    check("…each shows its title, description and date", items.every((li, i) => li.querySelector(".blog-list__title").textContent === posts[i].title && li.querySelector(".blog-list__desc").textContent === posts[i].description && li.querySelector(".blog-list__meta").textContent.startsWith(ddmmyyyy(posts[i].published))));
    const nav = [...d.querySelectorAll(".site-nav__links a")].map((a) => a.textContent.trim());
    check("…the header has the Blog link, and the footer is there", nav.includes("Blog") && nav.indexOf("Blog") === nav.indexOf("Về Bloomy") + 1 && !!d.querySelector("footer.site-footer"));
  }

  // ------------------------------------------------------------ 2. every post
  for (const p of posts) {
    const r = await get(`/blog/${p.slug}`);
    const html = await r.text();
    const d = dom(html);
    check(`${p.slug}: 200`, r.status === 200, String(r.status));
    check(`${p.slug}: nothing left unfilled (no token, no [[marker]])`, !html.includes("<!--include") && !/\{\{/.test(html) && !html.includes("[[") && !html.includes("]]"));
    check(`${p.slug}: <title>, one visible h1, meta description are the post's own`, d.title === `${p.title} — Bloomy` && d.querySelectorAll("h1").length === 1 && d.querySelector("h1").textContent === p.title && d.querySelector('meta[name="description"]').getAttribute("content") === p.description);
    check(`${p.slug}: canonical and og:url point at the post, og:type is article`, /\/blog\/[a-z0-9-]+$/.test(d.querySelector('link[rel="canonical"]').getAttribute("href")) && d.querySelector('link[rel="canonical"]').getAttribute("href").endsWith(`/blog/${p.slug}`) && d.querySelector('meta[property="og:url"]').getAttribute("content") === d.querySelector('link[rel="canonical"]').getAttribute("href") && d.querySelector('meta[property="og:type"]').getAttribute("content") === "article");
    check(`${p.slug}: dated`, d.querySelector("time").getAttribute("datetime") === p.published && d.querySelector("time").textContent === ddmmyyyy(p.published));
    check(`${p.slug}: sections and a closing link to the shop`, d.querySelectorAll(".blog-article__body h2").length >= 3 && !!d.querySelector('.blog-article__body a[href^="products.html"]'));
    check(`${p.slug}: no "#" links inside the post (they would point at the home page under <base>)`, ![...d.querySelectorAll(".blog-article__body a")].some((a) => (a.getAttribute("href") || "").startsWith("#")));
    // product cards: one per marker whose product can be bought, filled from the database
    const wanted = [];
    for (const id of markers(p.slug)) if (await buyable(id)) wanted.push(id);
    const cards = [...d.querySelectorAll(".blog-product")];
    check(`${p.slug}: one product card per marker`, cards.length === wanted.length && cards.length === markers(p.slug).length, `${cards.length} vs ${wanted.length}`);
    for (const id of wanted) {
      const c = await card(id);
      const el = cards.find((x) => x.querySelector("a").getAttribute("href") === `product.html?id=${id}`);
      check(`${p.slug}: card for product ${id} shows its name and price from the database`, !!el && el.querySelector(".blog-product__name").textContent === c.name && el.querySelector(".blog-product__price").textContent === `${c.has_sizes ? "Từ " : ""}${money(c.price)}`, el?.textContent.replace(/\s+/g, " "));
    }
    const more = [...d.querySelectorAll(".blog-more .blog-list__link")].map((a) => a.getAttribute("href"));
    check(`${p.slug}: "Bài viết khác" lists the other posts, not itself`, JSON.stringify(more.sort()) === JSON.stringify(posts.filter((x) => x.slug !== p.slug).map((x) => `blog/${x.slug}`).sort()), JSON.stringify(more));
    // every <a> leads somewhere (external ones are left alone)
    const dead = [];
    for (const a of d.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href");
      if (/^(https?:|mailto:|tel:)/.test(href)) continue;
      const res = await get(new URL(href, BASE + "/").pathname + new URL(href, BASE + "/").search);
      if (res.status >= 400) dead.push(`${href} -> ${res.status}`);
    }
    check(`${p.slug}: every internal link works (header, footer, body)`, dead.length === 0, dead.join("; "));
  }

  // ------------------------------------------------------------ 3. the five agreed text fixes, and no clash with the shop's own wording
  {
    const t1 = dom(await (await get(`/blog/${P1}`)).text()).body.textContent;
    const t2 = dom(await (await get(`/blog/${P2}`)).text()).body.textContent;
    const care = [...dom(await (await get("/product.html?id=9")).text()).querySelectorAll("#panel-care li")].map((l) => l.textContent).join(" ");
    const commitment = dom(await (await get("/commitment.html")).text()).body.textContent;
    check("post 1: the card message goes in the checkout's \"Lời nhắn kèm hoa\" field, and the vague \"nhắn tay\" is gone", t1.includes("Lời nhắn kèm hoa") && t1.includes("thiệp viết tay") && !t1.includes("vài dòng nhắn tay"));
    check("post 2: says about 5 days, like the commitment page and the care tab", t2.includes("khoảng 5 ngày") && commitment.includes("5 ngày") && care.includes("khoảng 5 ngày"));
    check("post 2: no longer says there is no fixed period", !t2.includes("Không có công thức duy nhất"));
    check("post 2: the same care numbers as the care tab (1–2 cm, water every 1–2 days, lily stamens)", t2.includes("1–2 cm") && care.includes("1–2 cm") && t2.includes("mỗi 1–2 ngày") && care.includes("1–2 ngày") && t2.includes("hoa ly") && t2.includes("nhị") && care.includes("nhị"));
    check("the posts link products 5, 3 and 9", JSON.stringify([markers(P1), markers(P2), markers(P3)]) === JSON.stringify([[5], [3], [9]]), JSON.stringify([markers(P1), markers(P2), markers(P3)]));
    check("each post's description is 120–155 characters and contains its focus keyword", posts.every((p) => p.description.length >= 120 && p.description.length <= 155 && p.description.toLowerCase().includes(p.keyword.toLowerCase())), JSON.stringify(posts.map((p) => p.description.length)));
    check("each post's title is 29–60 characters and contains its focus keyword", posts.every((p) => p.title.length >= 29 && p.title.length <= 60 && p.title.toLowerCase().includes(p.keyword.toLowerCase())), JSON.stringify(posts.map((p) => p.title.length)));
  }

  // ------------------------------------------------------------ 4. cards are live and escaped
  {
    const id = markers(P1)[0];
    const prod = (await pool.query("SELECT name, status FROM products WHERE id=$1", [id])).rows[0];
    original.products.set(id, prod);
    const sizes = (await pool.query("SELECT id, price FROM product_sizes WHERE product_id=$1", [id])).rows;
    for (const s of sizes) original.prices.set(s.id, s.price);
    const evil = `Hoa <b>đậm</b> & "q" 'x'`;
    await pool.query("UPDATE products SET name=$1 WHERE id=$2", [evil, id]);
    await pool.query("UPDATE product_sizes SET price = price + 1000 WHERE product_id=$1", [id]);
    const d = dom(await (await get(`/blog/${P1}`)).text());
    const c = d.querySelector(".blog-product");
    const now = await card(id);
    check("renaming the product changes the card at once, shown as plain text", c.querySelector(".blog-product__name").textContent === evil && !c.querySelector("b"));
    check("changing a price changes the card at once", c.querySelector(".blog-product__price").textContent === `${now.has_sizes ? "Từ " : ""}${money(now.price)}`);
    await pool.query("UPDATE products SET status='discontinued' WHERE id=$1", [id]);
    const gone = await (await get(`/blog/${P1}`)).text();
    check("a discontinued product leaves no card and no leftover marker", !gone.includes("blog-product") && !gone.includes("[[") && gone.includes("Người yêu: chọn hoa theo tính cách"));
    await pool.query("UPDATE products SET name=$1, status=$2 WHERE id=$3", [prod.name, prod.status, id]);
    for (const [sid, price] of original.prices) await pool.query("UPDATE product_sizes SET price=$1 WHERE id=$2", [price, sid]);
    check("…and it returns when the product is available again", (await (await get(`/blog/${P1}`)).text()).includes("blog-product"));
  }

  // ------------------------------------------------------------ 5. rules: what is and is not served
  {
    const r404 = async (p, label) => { const r = await get(p); check(`${label} → 404`, r.status === 404, `${p} gave ${r.status}`); };
    await r404("/blog/no-such-post", "unknown post");
    await r404("/blog/Cach-Giu-Hoa-Tuoi-Lau-Tai-Nha", "upper-case slug");
    await r404("/blog/cach-giu-hoa-tuoi-lau-tai-nha/extra", "extra path segment");
    await r404("/blog.html", "/blog.html (the template is not a public page)");
    await r404("/blog-post.html", "/blog-post.html");
    await r404("/content/posts.json", "/content/posts.json");
    await r404("/content/blog.html", "/content/blog.html");
    await r404("/content/posts/" + P1 + ".html", "a post fragment, raw");
    await r404("/posts.json", "/posts.json");
    await r404("/blog/..%2fserver.js", "path tricks");
    const slash = await get("/blog/?utm_source=zalo");
    check("/blog/ → 301 to /blog, query kept", slash.status === 301 && slash.headers.get("location") === "/blog?utm_source=zalo", `${slash.status} ${slash.headers.get("location")}`);
    const post = await get(`/blog/${P2}`, { method: "POST" });
    check("POST to a post is not rendered", post.status !== 200, String(post.status));
    const map = await (await get("/sitemap.xml")).text();
    check("sitemap lists /blog and every post", /<loc>[^<]*\/blog<\/loc>/.test(map) && posts.every((p) => map.includes(`/blog/${p.slug}</loc>`)));
    check("…and nothing else about the blog (no template, no raw fragment)", !/blog-post|blog\.html|content\//.test(map));
  }

  // ------------------------------------------------------------ 6. hostile content: escaped; fragments are trusted, markers are not
  {
    original.products.set(6, (await pool.query("SELECT name, status FROM products WHERE id=6")).rows[0]);
    await pool.query("UPDATE products SET status='discontinued' WHERE id=6");
    const evil = `</title><script>alert(1)</script>"><img src=x onerror=alert(2)> & 'q'`;
    const dir = tempContent((d) => {
      fs.writeFileSync(path.join(d, "posts.json"), JSON.stringify([{ slug: "thu-nghiem", title: evil, description: evil, published: "2026-10-09", keyword: "x" }]));
      fs.rmSync(path.join(d, "posts"), { recursive: true });
      fs.mkdirSync(path.join(d, "posts"));
      fs.writeFileSync(path.join(d, "posts", "thu-nghiem.html"), `<p class="blog-lead">Mở đầu <strong>đậm</strong>.</p>\n[[product:5]]\n[[product:999999]]\n[[product:6]]\n<p>Hết.</p>`);
    });
    await withServer(39704, { BLOOMY_CONTENT_DIR: dir }, async (base) => {
      const d = dom(await (await fetch(`${base}/blog/thu-nghiem`)).text());
      check("hostile title/description: no script, no <img onerror>", ![...d.querySelectorAll("script")].some((s) => /alert/.test(s.textContent)) && !d.querySelector("img[onerror]"));
      check("…<title>, h1, the meta description attribute and og:title hold it exactly", d.title === `${evil} — Bloomy` && d.querySelector("h1").textContent === evil && d.querySelector('meta[name="description"]').getAttribute("content") === evil && d.querySelector('meta[property="og:title"]').getAttribute("content") === evil);
      check("…the fragment's own HTML is used as written (trusted)", d.querySelector(".blog-lead strong")?.textContent === "đậm");
      check("…a card for the available product; an unknown id and a discontinued product leave nothing", d.querySelectorAll(".blog-product").length === 1 && !d.body.innerHTML.includes("[["));
      const index = dom(await (await fetch(`${base}/blog`)).text());
      check("…the index shows it as plain text too", index.querySelector(".blog-list__title").textContent === evil && !index.querySelector("img[onerror]"));
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ------------------------------------------------------------ 7. a broken content/ stops the server at startup, with a message
  {
    const base = (mutate) => tempContent(mutate);
    const good = JSON.parse(fs.readFileSync(path.join(CONTENT, "posts.json"), "utf8"));
    const edit = (fn) => (d) => { const l = JSON.parse(fs.readFileSync(path.join(d, "posts.json"), "utf8")); fn(l, d); fs.writeFileSync(path.join(d, "posts.json"), JSON.stringify(l)); };
    const cases = [
      ["posts.json is not JSON", (d) => fs.writeFileSync(path.join(d, "posts.json"), "{ not json"), /not valid JSON/],
      ["a slug used twice", edit((l) => { l[1].slug = l[0].slug; }), /used twice/],
      ["an upper-case slug", edit((l) => { l[0].slug = "Hoa-Dep"; }), /lower-case/],
      ["a date that does not exist", edit((l) => { l[0].published = "2026-02-31"; }), /real date/],
      ["a missing title", edit((l) => { delete l[0].title; }), /"title" is missing/],
      ["a post whose fragment file is missing", (d) => fs.rmSync(path.join(d, "posts", `${good[0].slug}.html`)), /cannot read/],
      ["a misspelt product marker", (d) => fs.appendFileSync(path.join(d, "posts", `${good[0].slug}.html`), "\n[[produt:5]]\n"), /not a \[\[product:N\]\] marker/],
      ["a <script> in a fragment", (d) => fs.appendFileSync(path.join(d, "posts", `${good[0].slug}.html`), "\n<script>alert(1)</script>\n"), /<script>/],
      ["a missing template", (d) => fs.rmSync(path.join(d, "blog-post.html")), /cannot read/],
      ["no content folder at all", (d) => { fs.rmSync(d, { recursive: true }); }, /cannot read/],
    ];
    for (const [label, mutate, expected] of cases) {
      const dir = base(mutate);
      let err = "";
      const child = spawn("node", ["server.js"], { cwd: ROOT, env: serverEnv(39705, { BLOOMY_CONTENT_DIR: dir }), stdio: ["ignore", "ignore", "pipe"] });
      child.stderr.on("data", (b) => (err += b));
      const code = await new Promise((resolve) => { const t = setTimeout(() => { child.kill(); resolve("still running"); }, 9000); child.on("exit", (c) => { clearTimeout(t); resolve(c); }); });
      check(`startup refused: ${label}`, code !== "still running" && code !== 0 && expected.test(err), `exit=${code} ${err.split("\n").find((l) => /ContentError|Error/.test(l)) || err.slice(0, 160)}`);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ------------------------------------------------------------ 8. database down: the posts still read
  await withServer(39706, { DB_PORT: "1" }, async (base) => {
    const r = await fetch(`${base}/blog/${P1}`);
    const html = await r.text();
    check("DB down: the post still loads, without its card, with nothing unfilled", r.status === 200 && !html.includes("blog-product") && !/\{\{/.test(html) && !html.includes("[[") && dom(html).querySelector("h1").textContent === bySlug(P1).title);
    const i = await fetch(`${base}/blog`);
    check("DB down: the index still loads", i.status === 200 && dom(await i.text()).querySelectorAll(".blog-list__item").length === posts.length);
  });
} finally {
  for (const [id, p] of original.products) await pool.query("UPDATE products SET name=COALESCE($1, name), status=$2 WHERE id=$3", [p.name ?? null, p.status, id]);
  for (const [sid, price] of original.prices) await pool.query("UPDATE product_sizes SET price=$1 WHERE id=$2", [price, sid]);
}
let restored = true;
for (const [id, p] of original.products) {
  const now = (await pool.query("SELECT name, status FROM products WHERE id=$1", [id])).rows[0];
  if (now.name !== p.name || now.status !== p.status) restored = false;
}
for (const [sid, price] of original.prices) if ((await pool.query("SELECT price FROM product_sizes WHERE id=$1", [sid])).rows[0].price !== price) restored = false;
check("cleanup: the renamed / discontinued products and the changed prices are back as they were", restored && original.products.size >= 2);
await pool.end();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
