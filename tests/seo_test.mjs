// Product SEO as the server does it: the rules in seo.js (fallbacks, checks, input cleaning), what product.html
// says in its <head> for every kind of request, and the admin API behind the SEO panel.
//
// Run from the repo root with the server running on the same database:
//   export DB_HOST=127.0.0.1 DB_PORT=5433 DB_PASSWORD=dev
//   BASE=http://localhost:3000 node tests/seo_test.mjs
//
// It temporarily changes a few products (SEO fields, status, name, image) and creates three staff accounts named
// zz.test.* (owner, manager, employee), plus one extra server on port 39707 with an unreachable database. Everything
// is put back / deleted in a finally block. Local or test database only, never production.
//
// Proves: the page's title / description / canonical / share image / robots come from the product's own SEO fields
// or fall back sensibly; discontinued products are kept out of search results (and only while discontinued); odd ids
// get a 404 that is also kept out; hostile text cannot break out of the head and is never expanded as a {{token}};
// the panel's checks and preview are what the page really says; only managers and up can read or save.
// Does NOT prove: how Google or Zalo or Facebook will show any of it, or how the panel looks (seo_live_test.mjs drives it).

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import path from "node:path";
import jsdom from "jsdom";
const { JSDOM } = jsdom;

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const ROOT = process.cwd();
const require = createRequire(path.join(ROOT, "package.json"));
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const seo = require(path.join(ROOT, "seo.js"));
const pool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1", port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || "quaint", database: process.env.DB_NAME || "bloomy", password: process.env.DB_PASSWORD || "dev",
});

let passed = 0, failed = 0;
function check(name, cond, extra = "") { if (cond) passed++; else { failed++; console.log(`FAIL ${name}${extra ? " :: " + extra : ""}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p, opts) => fetch(BASE + p, { redirect: "manual", ...opts });
const dom = (html) => new JSDOM(html).window.document;
const meta = (d, sel) => d.querySelector(sel)?.getAttribute("content");

// Stop early if this script's database is not the server's database.
{
  const row = (await pool.query("SELECT shop_address, contact_phone, contact_email, vat_rate FROM settings")).rows[0];
  const api = await (await get("/api/settings")).json();
  if (!row || row.shop_address !== api.shop_address || row.contact_phone !== api.contact_phone || row.contact_email !== api.contact_email || row.vat_rate !== api.vat_rate) {
    console.log("FAIL this script is connected to a different database than the server at " + BASE + " (settings differ). Export the same DB_HOST / DB_PORT / DB_PASSWORD as the server and run again.");
    process.exit(2);
  }
}

const saved = new Map(); // id -> the row as it was, put back at the end
async function remember(id) {
  if (!saved.has(id)) saved.set(id, (await pool.query("SELECT name, status, image, short_description, seo_keyword, seo_title, seo_description FROM products WHERE id=$1", [id])).rows[0]);
}
const pick = async (where) => (await pool.query(`SELECT id FROM products WHERE ${where} ORDER BY id LIMIT 1`)).rows[0]?.id;
const tempUsers = [];

try {
  // ============================================================ 1. the rules in seo.js
  {
    const base = "https://shop.example";
    const p = { id: 7, name: "Bó Hồng Đỏ", status: "available", image: "images/bo.webp", short_description: "Bó hồng đỏ dịu dàng.", description: "Mô tả dài.", seo_keyword: null, seo_title: null, seo_description: null };
    const e = seo.effective(p, base);
    check("fallback title is the name plus the site name", e.title === "Bó Hồng Đỏ — Bloomy");
    check("fallback description is the short description", e.description === "Bó hồng đỏ dịu dàng.");
    check("canonical, share image and default image are absolute", e.canonical === "https://shop.example/product.html?id=7" && e.image === "https://shop.example/images/bo.webp" && e.defaultImage === "https://shop.example/images/og-image.jpg");
    check("an available product has no robots line", e.robots === null);
    check("a discontinued product is noindex", seo.effective({ ...p, status: "discontinued" }, base).robots === "noindex, follow");
    check("a sold-out-today product is still indexed", seo.effective({ ...p, status: "sold_out_today" }, base).robots === null);
    check("written fields win over the fallbacks", seo.effective({ ...p, seo_title: "Tiêu đề riêng", seo_description: "Mô tả riêng." }, base).title === "Tiêu đề riêng" && seo.effective({ ...p, seo_title: "Tiêu đề riêng", seo_description: "Mô tả riêng." }, base).description === "Mô tả riêng.");
    const long = "Từ " + "rất dài ".repeat(40);
    const auto = seo.effective({ ...p, short_description: long }, base).description;
    check("a long fallback description is cut at a word, with …, within 155 characters", auto.endsWith("…") && [...auto].length <= 155 && !/\s…$/.test(auto), `${[...auto].length}`);
    check("no short description: falls back to the long one; neither: a plain sentence", seo.effective({ ...p, short_description: null }, base).description === "Mô tả dài." && seo.effective({ ...p, short_description: null, description: null }, base).description.includes("Bó Hồng Đỏ"));
    const savedBase = process.env.BLOOMY_BASE_URL;
    process.env.BLOOMY_BASE_URL = "https://shop.example//";
    const tidied = seo.baseUrl({ protocol: "http", get: () => "ignored.example" });
    if (savedBase === undefined) delete process.env.BLOOMY_BASE_URL; else process.env.BLOOMY_BASE_URL = savedBase;
    check("the site address from BLOOMY_BASE_URL has its trailing slashes removed", tidied === "https://shop.example", tidied);
    check("without it, the address comes from the request's own host", seo.baseUrl({ protocol: "https", get: () => "bloomy.example" }) === (process.env.BLOOMY_BASE_URL ? process.env.BLOOMY_BASE_URL.replace(/\/+$/, "") : "https://bloomy.example"));

    const full = { ...p, name: "Bó hoa hồng đỏ", short_description: "Bó hoa hồng đỏ cho ngày kỷ niệm.", seo_keyword: "hoa hồng đỏ",
      seo_title: "Bó hoa hồng đỏ giao đúng ngày | Bloomy", seo_description: "Bó hoa hồng đỏ Classic gói giấy kraft, chọn ngày và khung giờ giao phù hợp, giao đúng hẹn tại TP.HCM, kèm thiệp viết tay." };
    const level = (prod, id) => seo.checks(prod, base).find((c) => c.id === id)?.level;
    check("all green: keyword in title, description and text; good lengths", seo.checks(full, base).every((c) => c.level === "good") && seo.health(full, base) === "good", JSON.stringify(seo.checks(full, base).map((c) => [c.id, c.level, c.text.slice(0, 30)])));
    check("no keyword → one red check and a red health, and no keyword-in-… checks", level({ ...full, seo_keyword: null }, "keyword_set") === "bad" && seo.checks({ ...full, seo_keyword: null }, base).every((c) => !c.id.startsWith("keyword_") || c.id === "keyword_set") && seo.health({ ...full, seo_keyword: null }, base) === "bad");
    check("keyword missing from the title is red", level({ ...full, seo_title: "Bó hoa giao đúng ngày tại TP.HCM | Bloomy" }, "keyword_title") === "bad");
    check("keyword missing from the description / the product text is orange", level({ ...full, seo_description: "Chọn ngày và khung giờ giao phù hợp, giao đúng hẹn tại TP.HCM, kèm thiệp viết tay, gói giấy kraft đẹp." }, "keyword_description") === "warn" && level({ ...full, name: "Bó mẫu đơn", short_description: "Bó mẫu đơn.", description: "Mẫu đơn." }, "keyword_text") === "warn");
    check("matching ignores case and Unicode form (typed in capitals, or decomposed)", level({ ...full, seo_keyword: "HOA HỒNG ĐỎ" }, "keyword_title") === "good" && level({ ...full, seo_keyword: "hoa hồng đỏ".normalize("NFD") }, "keyword_title") === "good");
    const T = (n) => level({ ...full, seo_title: "t".repeat(n) }, "title_length");
    check("title length: 30–60 good, 20–29 and 61–70 orange, outside red", [T(30), T(60), T(25), T(65), T(10), T(80)].join() === "good,good,warn,warn,bad,bad", [T(30), T(60), T(25), T(65), T(10), T(80)].join());
    const D = (n) => level({ ...full, seo_description: "d".repeat(n) }, "description_length");
    check("description length: 120–160 good, 70–119 and 161–200 orange, outside red", [D(120), D(160), D(100), D(180), D(50), D(250)].join() === "good,good,warn,warn,bad,bad", [D(120), D(160), D(100), D(180), D(50), D(250)].join());
    check("the preview cuts the title at 60 and the description at 160, with …", [...seo.snippet({ ...full, seo_title: "Một tiêu đề " + "dài lắm ".repeat(12) }, base).title].length <= 60 && seo.snippet({ ...full, seo_title: "Một tiêu đề " + "dài lắm ".repeat(12) }, base).title.endsWith("…") && [...seo.snippet({ ...full, seo_description: "mô tả " + "rất dài ".repeat(40) }, base).description].length <= 160 && seo.snippet(full, base).url === "shop.example/product.html?id=7");

    // ---- the keyword in the product's own text: phrase, then words, then what is missing
    const kt = (kw, text) => seo.checks({ ...full, seo_keyword: kw, name: text.name ?? "Tên", short_description: text.short ?? "", description: text.long ?? "" }, base).find((x) => x.id === "keyword_text");
    const exact = kt("hoa hồng peach", { long: "Bó hoa hồng peach dịu dàng." });
    check("text check: the exact phrase is green and says where it looked", exact.level === "good" && exact.text.includes("nội dung hiển thị trên trang"), exact.text);
    const scattered = kt("hoa hồng peach", { name: "Bó Hồng Peach Dream", long: "Hồng peach ngọt ngào, bó hoa sinh nhật." });
    check("text check: every word present but apart is green, and says so (the case that started this)", scattered.level === "good" && scattered.text.includes("Có đủ các từ của từ khóa"), scattered.text);
    const some = kt("hoa cưới cầm tay", { long: "Bó hoa cưới trắng tinh khiết." });
    check("text check: missing words are orange and named", some.level === "warn" && some.text.includes("“cầm”") && some.text.includes("“tay”") && !some.text.includes("“hoa”") && !some.text.includes("“cưới”"), some.text);
    check("text check: the orange message says the SEO title and description do not count here", some.text.includes("tiêu đề và mô tả SEO không tính"));
    const none = kt("mẫu đơn", { long: "Bó hoa cưới." });
    check("text check: nothing in common lists every word", none.level === "warn" && none.text.includes("“mẫu”") && none.text.includes("“đơn”"));
    check("text check: words are whole words, not pieces (\"hoa\" is not in \"hoan hỷ\")", kt("hoa", { long: "Hoan hỷ và hân hoan." }).level === "warn" && kt("hoa", { long: "Hoa tươi." }).level === "good");
    const titleCheck = (kw, title) => seo.checks({ ...full, seo_keyword: kw, seo_title: title }, base).find((x) => x.id === "keyword_title").level;
    check("title/description checks are phrase checks on whole words too", titleCheck("hoa", "Hoan hỷ | Bloomy") === "bad" && titleCheck("hoa", "Hoa tươi | Bloomy") === "good" && titleCheck("hoa hồng", "Hồng hoa | Bloomy") === "bad" && titleCheck("bó hoa đẹp", "Bó hoa, đẹp | Bloomy") === "good");

    const c = (body) => seo.cleanFields(body);
    check("input: empty string and null clear a field; unsent fields are left alone", JSON.stringify(c({ seo_keyword: "", seo_title: null }).values) === JSON.stringify({ seo_keyword: null, seo_title: null }) && !("seo_description" in c({ seo_keyword: "x" }).values));
    check("input: spaces and newlines are tidied into single spaces", c({ seo_title: "  Bó   hoa\nđẹp  " }).values.seo_title === "Bó hoa đẹp");
    check("input: too long (keyword 61, title 71, description 201) is refused, naming the field", c({ seo_keyword: "k".repeat(61) }).field === "seo_keyword" && c({ seo_title: "t".repeat(71) }).field === "seo_title" && c({ seo_description: "d".repeat(201) }).field === "seo_description" && c({ seo_keyword: "k".repeat(60), seo_title: "t".repeat(70), seo_description: "d".repeat(200) }).field === undefined);
    check("input: lengths are counted in characters, not bytes (70 Vietnamese letters fit)", c({ seo_title: "ệ".repeat(70) }).field === undefined);
    check("input: a keyword needs a letter or digit (\"---\" is refused, \"a\" and \"2025\" are fine)", c({ seo_keyword: "---" }).field === "seo_keyword" && c({ seo_keyword: "—" }).field === "seo_keyword" && c({ seo_keyword: "a" }).field === undefined && c({ seo_keyword: "2025" }).field === undefined && c({ seo_keyword: "" }).field === undefined);
    check("input: a number, an object or a control character is refused", c({ seo_title: 123 }).field === "seo_title" && c({ seo_keyword: {} }).field === "seo_keyword" && c({ seo_description: "a\u0000b" }).field === "seo_description");
  }

  // ============================================================ 2. what product.html says in its head
  const seeded = await pick("seo_title IS NOT NULL AND status='available'");
  const plain = await pick("seo_title IS NULL AND seo_description IS NULL AND status='available'");
  const gone = await pick("status='discontinued'");
  const soldOut = await pick("status='sold_out_today'");
  check("the seed has the kinds of product this needs", !!(seeded && plain && gone && soldOut), JSON.stringify({ seeded, plain, gone, soldOut }));
  const pageOf = async (q) => { const r = await get(`/product.html${q}`); return { r, html: await r.text() }; };
  const head = (html) => { const d = dom(html); return { d, title: d.title, desc: meta(d, 'meta[name="description"]'), canonical: d.querySelector('link[rel="canonical"]')?.getAttribute("href"), robots: meta(d, 'meta[name="robots"]'),
    ogTitle: meta(d, 'meta[property="og:title"]'), ogDesc: meta(d, 'meta[property="og:description"]'), ogUrl: meta(d, 'meta[property="og:url"]'), ogImages: [...d.querySelectorAll('meta[property="og:image"]')].map((m) => m.getAttribute("content")) }; };

  {
    const row = (await pool.query("SELECT name, image, short_description, seo_title, seo_description FROM products WHERE id=$1", [seeded])).rows[0];
    const { r, html } = await pageOf(`?id=${seeded}`);
    const h = head(html);
    check("seeded product: 200, html, no-cache, nothing unfilled", r.status === 200 && /text\/html/.test(r.headers.get("content-type")) && r.headers.get("cache-control") === "no-cache" && !/\{\{/.test(html) && !html.includes("<!--include"));
    check("…title and description are the product's own SEO fields", h.title === row.seo_title && h.desc === row.seo_description);
    check("…og:title / og:description / og:url repeat them, canonical is the product's address", h.ogTitle === row.seo_title && h.ogDesc === row.seo_description && h.canonical.endsWith(`/product.html?id=${seeded}`) && h.ogUrl === h.canonical);
    check("…two share images: the product's photo first, the site's default second", h.ogImages.length === 2 && h.ogImages[0].endsWith("/" + row.image) && h.ogImages[0].startsWith("http") && h.ogImages[1].endsWith("/images/og-image.jpg"), JSON.stringify(h.ogImages));
    check("…no robots line (it may be indexed)", h.robots === undefined);
    check("…the page still has its product body and scripts", !!h.d.querySelector("#product-detail, .product-detail, main") && [...h.d.querySelectorAll("script[src]")].some((s) => /product\.js/.test(s.getAttribute("src"))));
  }
  {
    const row = (await pool.query("SELECT name, short_description FROM products WHERE id=$1", [plain])).rows[0];
    const h = head((await pageOf(`?id=${plain}`)).html);
    check("product without SEO fields: title is \"<name> — Bloomy\"", h.title === `${row.name} — Bloomy`, h.title);
    const expectDesc = [...row.short_description].length <= 155 ? row.short_description : null;
    check("…description is its short description (cut with … only if long)", expectDesc ? h.desc === expectDesc : (h.desc.endsWith("…") && [...h.desc].length <= 155), h.desc);
  }
  {
    const hg = head((await pageOf(`?id=${gone}`)).html);
    check("discontinued product: noindex, follow", hg.robots === "noindex, follow", String(hg.robots));
    const hs = head((await pageOf(`?id=${soldOut}`)).html);
    check("sold-out-today product: still indexed (no robots line)", hs.robots === undefined);
    await remember(soldOut);
    await pool.query("UPDATE products SET status='discontinued' WHERE id=$1", [soldOut]);
    check("…and it becomes noindex the moment it is discontinued", head((await pageOf(`?id=${soldOut}`)).html).robots === "noindex, follow");
    await pool.query("UPDATE products SET status='available' WHERE id=$1", [soldOut]);
    check("…and indexable again once it is available", head((await pageOf(`?id=${soldOut}`)).html).robots === undefined);
    const sm = await (await get("/sitemap.xml")).text();
    check("sitemap lists available products and leaves discontinued ones out", sm.includes(`product.html?id=${seeded}<`) && !sm.includes(`product.html?id=${gone}<`));
  }
  {
    const generic = (h) => h.title === "Sản phẩm — Bloomy" && h.canonical.endsWith("/product.html") && h.ogImages.length === 1 && h.ogImages[0].endsWith("/images/og-image.jpg");
    const none = await pageOf("");
    check("no id: 200, the generic head, kept out of search results", none.r.status === 200 && generic(head(none.html)) && head(none.html).robots === "noindex, follow");
    for (const [label, q] of [["an unknown id", "?id=99999"], ["zero", "?id=0"], ["letters", "?id=abc"], ["a decimal", "?id=1.5"], ["an exponent", "?id=1e3"], ["negative", "?id=-1"], ["too many digits", "?id=1234567890"], ["empty", "?id="], ["twice", `?id=${seeded}&id=${plain}`], ["a null byte", "?id=%00"], ["script text", "?id=%3Cscript%3E"]]) {
      const x = await pageOf(q);
      const h = head(x.html);
      check(`${label} (${q}): 404, the generic head, noindex`, x.r.status === 404 && generic(h) && h.robots === "noindex, follow", `${x.r.status} ${h.title} ${h.robots}`);
    }
    const bracket = await pageOf(`?id[]=${seeded}`);
    check("?id[]=N is not an id parameter at all: treated as no id (200, generic, noindex)", bracket.r.status === 200 && generic(head(bracket.html)) && head(bracket.html).robots === "noindex, follow", `${bracket.r.status}`);
    const lead = head((await pageOf(`?id=007`)).html);
    check("a leading-zero id is read as a number, and the canonical is the plain one", lead.canonical.endsWith("/product.html?id=7"), lead.canonical);
    const extra = head((await pageOf(`?id=${seeded}&utm_source=zalo`)).html);
    check("extra query parameters (utm_source...) do not change the canonical", extra.canonical.endsWith(`/product.html?id=${seeded}`) && !extra.canonical.includes("utm"));
  }

  // ---- hostile text can neither break the head nor be expanded as a {{token}}
  {
    await remember(plain);
    const evil = `</title><script>alert(1)</script>"><img src=x onerror=alert(2)> & 'q' {{contact_phone}} {{footer_categories}}`;
    await pool.query("UPDATE products SET name=$1, short_description=$1, seo_title=$1, seo_description=$1, image=$2 WHERE id=$3", [evil, `images/a"><script>alert(3)</script>.webp`, plain]);
    const { html } = await pageOf(`?id=${plain}`);
    const h = head(html);
    check("hostile SEO fields: no script element and no <img onerror> in the page", ![...h.d.querySelectorAll("script")].some((s) => /alert/.test(s.textContent)) && !h.d.querySelector("img[onerror]"));
    check("…title, description, og:title and og:description hold the text exactly (no attribute break-out)", h.title === evil && h.desc === evil && h.ogTitle === evil && h.ogDesc === evil);
    check("…and {{tokens}} typed in a product are shown as text, not expanded", h.title.includes("{{contact_phone}}") && !h.title.includes("0900"));
    check("…the share image is a single meta tag whose address has the odd characters percent-encoded", h.ogImages.length === 2 && h.ogImages[0].endsWith("/images/a%22%3E%3Cscript%3Ealert(3)%3C/script%3E.webp") && h.ogImages[1].endsWith("/images/og-image.jpg"), JSON.stringify(h.ogImages));
    // with no SEO fields of its own, the name is what the title is made of
    await pool.query("UPDATE products SET seo_title=NULL, seo_description=NULL WHERE id=$1", [plain]);
    const h2 = head((await pageOf(`?id=${plain}`)).html);
    check("hostile name in the fallback title and description is escaped too", h2.title === `${evil} — Bloomy` && !h2.d.querySelector("img[onerror]"));
    const orig = saved.get(plain);
    await pool.query("UPDATE products SET name=$1, image=$2, short_description=$3, seo_keyword=$4, seo_title=$5, seo_description=$6 WHERE id=$7", [orig.name, orig.image, orig.short_description, orig.seo_keyword, orig.seo_title, orig.seo_description, plain]);
  }

  // ---- database down: a second server
  {
    const port = 39707;
    const env = { ...process.env, PORT: String(port), DB_PORT: "1", SESSION_SECRET: process.env.SESSION_SECRET || "x", BLOOMY_BASE_URL: "http://localhost",
      ZALOPAY_ENDPOINT: process.env.ZALOPAY_ENDPOINT || "https://sb-openapi.zalopay.vn", ZALOPAY_APP_ID: process.env.ZALOPAY_APP_ID || "1", ZALOPAY_KEY1: process.env.ZALOPAY_KEY1 || "a", ZALOPAY_KEY2: process.env.ZALOPAY_KEY2 || "b", DB_PASSWORD: process.env.DB_PASSWORD || "dev", EMAIL_MODE: "log" };
    const child = spawn("node", ["server.js"], { cwd: ROOT, env, stdio: "ignore" });
    try {
      let up = false;
      for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(`http://127.0.0.1:${port}/css/style.css`)).ok; } catch {} }
      check("server with unreachable DB starts", up);
      const r = await fetch(`http://127.0.0.1:${port}/product.html?id=${seeded}`);
      const html = await r.text();
      const h = head(html);
      check("DB down: the product page still loads with the generic head and no claim about indexing", r.status === 200 && h.title === "Sản phẩm — Bloomy" && h.robots === undefined && !/\{\{/.test(html));
    } finally { child.kill(); }
  }

  // ============================================================ 3. the admin API behind the panel
  const hash = await bcrypt.hash("zz-test-password-1", 10);
  for (const [name, role] of [["zz.test.owner", "owner"], ["zz.test.manager", "manager"], ["zz.test.employee", "employee"]]) {
    tempUsers.push((await pool.query("INSERT INTO admin_users (username, password, role) VALUES ($1, $2, $3) RETURNING id", [name, hash, role])).rows[0].id);
  }
  async function login(username) {
    const r = await fetch(`${BASE}/api/admin/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: "zz-test-password-1" }) });
    return { status: r.status, cookie: (r.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ") };
  }
  const who = { owner: await login("zz.test.owner"), manager: await login("zz.test.manager"), employee: await login("zz.test.employee") };
  check("test owner, manager and employee can log in", Object.values(who).every((w) => w.status === 200));
  const call = async (cookie, method, p, body) => {
    const res = await fetch(`${BASE}/api/admin/seo${p}`, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch {}
    return { status: res.status, data };
  };
  const M = who.manager.cookie;

  for (const [label, method, p, body] of [["list", "GET", "", null], ["one", "GET", `/${plain}`, null], ["preview", "POST", `/${plain}/preview`, { seo_title: "x" }], ["save", "PATCH", `/${plain}`, { seo_title: "x" }]]) {
    check(`not logged in: ${label} → 401`, (await call(null, method, p, body)).status === 401);
    check(`employee: ${label} → 403`, (await call(who.employee.cookie, method, p, body)).status === 403);
  }
  check("owner can use it too", (await call(who.owner.cookie, "GET", `/${plain}`)).status === 200);

  const total = Number((await pool.query("SELECT COUNT(*) FROM products")).rows[0].count);
  const list = (await call(M, "GET", "")).data;
  check("list: every product, with id, name, status, keyword and a health", list.length === total && list.every((p) => Object.keys(p).sort().join() === "health,id,keyword,name,status" && ["good", "warn", "bad"].includes(p.health)));
  const noKeyword = await pick("seo_keyword IS NULL");
  check("list: a product with no keyword is red", list.find((p) => p.id === noKeyword).health === "bad" && list.find((p) => p.id === noKeyword).keyword === null);
  const seededRows = (await pool.query("SELECT id FROM products WHERE seo_keyword IS NOT NULL ORDER BY id")).rows.map((r) => r.id);
  check("the hand-written seed rows: none is red", seededRows.length >= 1 && seededRows.every((id) => list.find((p) => p.id === id).health !== "bad"), JSON.stringify(seededRows.map((id) => [id, list.find((p) => p.id === id).health])));
  check("product 5 (\"hoa hồng peach\") is green now that every word counts", list.find((p) => p.id === 5).health === "good");
  const withKeyword = await pick("seo_keyword IS NOT NULL");
  check("list: a product with a keyword shows it", list.find((p) => p.id === withKeyword).keyword === (await pool.query("SELECT seo_keyword FROM products WHERE id=$1", [withKeyword])).rows[0].seo_keyword);

  await remember(seeded);
  const one = (await call(M, "GET", `/${seeded}`)).data;
  const live = head((await pageOf(`?id=${seeded}`)).html);
  check("one product: the fields, what the page says, the preview, the checks and a health", one.product.id === seeded && Object.keys(one).sort().join() === "checks,effective,fields,health,preview,product");
  check("…what the panel says the page says IS what the page says (title, description, canonical)", one.effective.title === live.title && one.effective.description === live.desc && one.effective.url === live.canonical, JSON.stringify([one.effective.title, live.title]));
  check("…the checks use the saved keyword and the shown lengths", one.checks.some((c) => c.id === "title_length") && one.checks.some((c) => c.id === "description_length") && one.checks.find((c) => c.id === "keyword_set").level === (one.fields.seo_keyword ? "good" : "bad"));

  // save, and the page follows at once
  // well-formed text built from the product's real name, so the keyword really is in the product's own text
  const realName = (await pool.query("SELECT name FROM products WHERE id=$1", [plain])).rows[0].name;
  const kw = realName.split(" ").slice(0, 2).join(" ").toLowerCase();
  let goodTitle = `${kw} giao đúng ngày | Bloomy`;
  while ([...goodTitle].length < 30) goodTitle += " — hoa tươi";
  const goodDescription = `${kw} tươi, gói đẹp, giao đúng ngày và khung giờ bạn chọn tại TP.HCM, kèm thiệp viết tay để món quà thêm ý nghĩa. Đặt hoa ngay tại Bloomy.`;
  check("(the test's own sample text is in the green ranges)", [...goodTitle].length >= 30 && [...goodTitle].length <= 60 && [...goodDescription].length >= 120 && [...goodDescription].length <= 160, `${[...goodTitle].length}/${[...goodDescription].length}`);
  const patched = await call(M, "PATCH", `/${plain}`, { seo_keyword: `  ${kw.replace(" ", "   ")} `, seo_title: goodTitle, seo_description: goodDescription });
  check("save: 200, fields tidied (spaces collapsed)", patched.status === 200 && patched.data.fields.seo_keyword === kw, patched.data?.fields?.seo_keyword);
  const row = (await pool.query("SELECT seo_keyword, seo_title, seo_description FROM products WHERE id=$1", [plain])).rows[0];
  check("…stored in the database", row.seo_keyword === kw && row.seo_title === goodTitle);
  const after = head((await pageOf(`?id=${plain}`)).html);
  check("…and the product page says it on the next request", after.title === row.seo_title && after.desc === row.seo_description && after.ogTitle === row.seo_title);
  check("…the returned checks are all green for this well-formed text", patched.data.checks.every((c) => c.level === "good") && patched.data.health === "good", JSON.stringify(patched.data.checks.map((c) => [c.id, c.level])));
  const partial = await call(M, "PATCH", `/${plain}`, { seo_keyword: "" });
  check("save: \"\" clears just that field; the others stay", partial.data.fields.seo_keyword === null && partial.data.fields.seo_title === row.seo_title);
  const cleared = await call(M, "PATCH", `/${plain}`, { seo_title: null, seo_description: "" });
  check("save: null / \"\" clear the title and description, and the page falls back", cleared.data.fields.seo_title === null && head((await pageOf(`?id=${plain}`)).html).title.endsWith(" — Bloomy"));

  for (const [label, body, field] of [["too long a keyword", { seo_keyword: "k".repeat(61) }, "seo_keyword"], ["too long a title", { seo_title: "t".repeat(71) }, "seo_title"], ["too long a description", { seo_description: "d".repeat(201) }, "seo_description"], ["a number", { seo_title: 5 }, "seo_title"], ["a control character", { seo_keyword: "a\u0000b" }, "seo_keyword"]]) {
    const r = await call(M, "PATCH", `/${plain}`, body);
    check(`save: ${label} → 400 invalid_field naming ${field}`, r.status === 400 && r.data?.field === field, JSON.stringify(r));
  }
  check("save: nothing to change → 400", (await call(M, "PATCH", `/${plain}`, {})).data?.error === "nothing_to_update");
  check("save: an unknown product → 404", (await call(M, "PATCH", "/999999", { seo_title: "x" })).status === 404);
  check("a non-numeric id → 404 (read, preview and save)", (await call(M, "GET", "/abc")).status === 404 && (await call(M, "POST", "/abc/preview", {})).status === 404 && (await call(M, "PATCH", "/abc", { seo_title: "x" })).status === 404);
  check("id 0 → 404", (await call(M, "GET", "/0")).status === 404);

  // preview writes nothing
  const before = (await pool.query("SELECT seo_keyword, seo_title, seo_description FROM products WHERE id=$1", [plain])).rows[0];
  const pv = await call(M, "POST", `/${plain}/preview`, { seo_keyword: "bó hoa đặc biệt", seo_title: "Bó hoa đặc biệt | Bloomy" });
  const stillSame = (await pool.query("SELECT seo_keyword, seo_title, seo_description FROM products WHERE id=$1", [plain])).rows[0];
  check("preview: answers for the unsaved text (the title and keyword it was given)", pv.status === 200 && pv.data.effective.title === "Bó hoa đặc biệt | Bloomy" && pv.data.checks.find((c) => c.id === "keyword_title").level === "good");
  check("…and writes nothing", JSON.stringify(before) === JSON.stringify(stillSame));
  check("…a bad input is refused the same way", (await call(M, "POST", `/${plain}/preview`, { seo_title: "t".repeat(71) })).data?.field === "seo_title");
} finally {
  for (const [id, r] of saved) await pool.query("UPDATE products SET name=$1, status=$2, image=$3, short_description=$4, seo_keyword=$5, seo_title=$6, seo_description=$7 WHERE id=$8", [r.name, r.status, r.image, r.short_description, r.seo_keyword, r.seo_title, r.seo_description, id]);
  for (const id of tempUsers) {
    await pool.query("DELETE FROM session WHERE sess::text LIKE $1", [`%"adminId":${id}%`]);
    await pool.query("DELETE FROM admin_users WHERE id = $1", [id]);
  }
}
let restored = saved.size >= 3;
for (const [id, r] of saved) {
  const now = (await pool.query("SELECT name, status, image, short_description, seo_keyword, seo_title, seo_description FROM products WHERE id=$1", [id])).rows[0];
  if (JSON.stringify(now) !== JSON.stringify(r)) restored = false;
}
check("cleanup: every product I touched is back exactly as it was", restored);
check("cleanup: test staff accounts removed", Number((await pool.query("SELECT COUNT(*) FROM admin_users WHERE username LIKE 'zz.test.%'")).rows[0].count) === 0);
await pool.end();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
