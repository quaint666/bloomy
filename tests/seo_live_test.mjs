// Product SEO in a browser DOM (jsdom, real pages and scripts, against the running server):
//   1. the product page keeps the title the server wrote (product.js no longer overwrites it) and its structured
//      data points at the canonical address, not at the address bar (which may carry ?utm_source=...)
//   2. the SEO panel: the list with its health words, search, picking a product, live preview and checks while
//      typing (nothing saved), the unsaved-changes question, saving, errors, the "noindex" note, text-only display.
//
// Run from the repo root with the server running on the same database:
//   export DB_HOST=127.0.0.1 DB_PORT=5433 DB_PASSWORD=dev
//   BASE=http://localhost:3000 node tests/seo_live_test.mjs
//
// It temporarily changes a few products and creates one staff account (zz.test.manager); everything is put back /
// deleted in a finally block. Local or test database only, never production.
//
// Proves: the behaviours above, in a DOM. Does NOT prove: how the panel looks, real keyboard or touch use, other browsers.

import { createRequire } from "node:module";
import path from "node:path";
import jsdom from "jsdom";
const { JSDOM, VirtualConsole, requestInterceptor } = jsdom;

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const require = createRequire(path.join(process.cwd(), "package.json"));
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const pool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1", port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || "quaint", database: process.env.DB_NAME || "bloomy", password: process.env.DB_PASSWORD || "dev",
});

let passed = 0, failed = 0;
function check(name, cond, extra = "") { if (cond) passed++; else { failed++; console.log(`FAIL ${name}${extra ? " :: " + extra : ""}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000, step = 40) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(step); } return false; }
const noCss = requestInterceptor(async (request) => (/\.css(\?|$)/.test(request.url) ? new Response("", { headers: { "Content-Type": "text/css" } }) : undefined));

// Stop early if this script's database is not the server's database.
{
  const row = (await pool.query("SELECT shop_address, contact_phone, contact_email, vat_rate FROM settings")).rows[0];
  const api = await (await fetch(`${BASE}/api/settings`)).json();
  if (!row || row.shop_address !== api.shop_address || row.contact_phone !== api.contact_phone || row.contact_email !== api.contact_email || row.vat_rate !== api.vat_rate) {
    console.log("FAIL this script is connected to a different database than the server at " + BASE + " (settings differ). Export the same DB_HOST / DB_PORT / DB_PASSWORD as the server and run again.");
    process.exit(2);
  }
}

const saved = new Map();
const COLS = "name, status, image, short_description, seo_keyword, seo_title, seo_description";
async function remember(id) { if (!saved.has(id)) saved.set(id, (await pool.query(`SELECT ${COLS} FROM products WHERE id=$1`, [id])).rows[0]); }
const pick = async (where) => (await pool.query(`SELECT id FROM products WHERE ${where} ORDER BY id LIMIT 1`)).rows[0]?.id;
let managerId = null;

try {
  const seeded = await pick("seo_title IS NOT NULL AND status='available'");
  const plain = await pick("seo_title IS NULL AND status='available'");
  const gone = await pick("status='discontinued'");

  // ============================================================ 1. the product page
  {
    await remember(plain);
    await pool.query("UPDATE products SET seo_title=$1 WHERE id=$2", ["Tiêu đề SEO riêng của trang thử nghiệm | Bloomy", plain]);
    const openProduct = async (q) => {
      const html = await (await fetch(`${BASE}/product.html${q}`)).text();
      const dom = new JSDOM(html, { url: `${BASE}/product.html${q}`, runScripts: "dangerously", resources: { interceptors: [noCss] }, pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
        beforeParse(w) { w.fetch = (u, o) => fetch(new URL(u, `${BASE}/product.html${q}`), o); } });
      const d = dom.window.document;
      await until(() => d.querySelector('script[type="application/ld+json"]'));
      return { dom, d };
    };
    const { dom, d } = await openProduct(`?id=${plain}&utm_source=zalo`);
    check("the product page loaded and rendered (its structured data is there)", !!d.querySelector('script[type="application/ld+json"]'));
    check("the title the server wrote is still the title after the page's scripts ran", d.title === "Tiêu đề SEO riêng của trang thử nghiệm | Bloomy", d.title);
    const ld = JSON.parse(d.querySelector('script[type="application/ld+json"]').textContent);
    const canonical = d.querySelector('link[rel="canonical"]').getAttribute("href");
    check("structured data: the offer's url is the canonical address, without ?utm_source", ld.offers.url === canonical && !ld.offers.url.includes("utm"), `${ld.offers.url} vs ${canonical}`);
    dom.window.close();

    await pool.query("UPDATE products SET seo_title=NULL WHERE id=$1", [plain]);
    const name = (await pool.query("SELECT name FROM products WHERE id=$1", [plain])).rows[0].name;
    const b = await openProduct(`?id=${plain}`);
    check("without its own SEO title the page keeps \"<name> — Bloomy\" after the scripts ran", b.d.title === `${name} — Bloomy`, b.d.title);
    b.dom.window.close();
  }

  // ============================================================ 2. the SEO panel
  const hash = await bcrypt.hash("zz-test-password-1", 10);
  managerId = (await pool.query("INSERT INTO admin_users (username, password, role) VALUES ('zz.test.manager', $1, 'manager') RETURNING id", [hash])).rows[0].id;
  const loginRes = await fetch(`${BASE}/api/admin/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "zz.test.manager", password: "zz-test-password-1" }) });
  const cookie = (loginRes.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  check("test manager can log in", loginRes.status === 200);

  async function openPanel(confirmAnswer = true) {
    const asked = [];
    const html = await (await fetch(`${BASE}/admin-seo.html`)).text();
    const dom = new JSDOM(html, { url: `${BASE}/admin-seo.html`, runScripts: "dangerously", resources: { interceptors: [noCss] }, pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
      beforeParse(w) {
        w.confirm = (m) => { asked.push(m); return confirmAnswer; };
        w.fetch = (u, o = {}) => fetch(new URL(u, `${BASE}/admin-seo.html`), { ...o, headers: { ...(o.headers || {}), Cookie: cookie } });
      } });
    const w = dom.window, d = w.document;
    const total = Number((await pool.query("SELECT COUNT(*) FROM products")).rows[0].count);
    await until(() => d.querySelectorAll(".admin-seo__row").length === total);
    const $ = (id) => d.getElementById(id);
    const type = (id, v) => { $(id).value = v; $(id).dispatchEvent(new w.Event("input", { bubbles: true })); };
    const row = (id) => d.querySelector(`.admin-seo__row[data-id="${id}"]`);
    return { w, d, dom, $, type, row, asked, total, close: () => w.close() };
  }

  {
    const p = await openPanel();
    check("panel: a row per product, each with its health in words (not only colour)", p.d.querySelectorAll(".admin-seo__row").length === p.total && [...p.d.querySelectorAll(".admin-seo__health-text")].every((n) => ["Tốt", "Cần cải thiện", "Chưa ổn"].includes(n.textContent)));
    check("panel: the nav shows the SEO link for a manager, and the editor starts hidden", !![...p.d.querySelectorAll("#admin-nav-links a")].find((a) => a.getAttribute("href") === "admin-seo.html") && p.$("seo-panel").hidden);

    // search
    const seedKeyword = (await pool.query("SELECT seo_keyword FROM products WHERE id=$1", [seeded])).rows[0].seo_keyword;
    p.$("seo-search").value = seedKeyword.slice(0, 6);
    p.$("seo-search").dispatchEvent(new p.w.Event("input", { bubbles: true }));
    const found = [...p.d.querySelectorAll(".admin-seo__row")];
    check("search: filters by name or keyword", found.length >= 1 && found.length < p.total && !!p.row(seeded), `${found.length}`);
    p.$("seo-search").value = "zzzzzz-no-such";
    p.$("seo-search").dispatchEvent(new p.w.Event("input", { bubbles: true }));
    check("search: no match leaves an empty list", p.d.querySelectorAll(".admin-seo__row").length === 0);
    p.$("seo-search").value = "";
    p.$("seo-search").dispatchEvent(new p.w.Event("input", { bubbles: true }));
    check("search: cleared, every product is back", p.d.querySelectorAll(".admin-seo__row").length === p.total);

    // pick a product
    p.row(seeded).click();
    const db = (await pool.query("SELECT name, seo_keyword, seo_title, seo_description FROM products WHERE id=$1", [seeded])).rows[0];
    check("picking a product fills the editor from the database", await until(() => !p.$("seo-panel").hidden && p.$("seo-keyword").value === db.seo_keyword) && p.$("seo-title").value === db.seo_title && p.$("seo-description").value === db.seo_description && p.$("seo-product-name").textContent === db.name);
    const api = await (await fetch(`${BASE}/api/admin/seo/${seeded}`, { headers: { Cookie: cookie } })).json();
    check("…the preview is the server's own preview of what the page says", p.$("seo-prev-title").textContent === api.preview.title && p.$("seo-prev-desc").textContent === api.preview.description && p.$("seo-prev-url").textContent === api.preview.url);
    check("…the checks are listed with a word for each level", p.d.querySelectorAll(".admin-seo__check").length === api.checks.length && [...p.d.querySelectorAll(".admin-seo__check-level")].every((n) => ["Tốt", "Cần cải thiện", "Chưa ổn"].includes(n.textContent)));
    check("…the character counts are shown", p.$("seo-title-count").textContent === `(${[...db.seo_title].length} ký tự)`);
    check("…an available product shows no noindex note", p.$("seo-robots-note").hidden);

    // typing: live preview and checks, nothing saved
    const longTitle = [..."Tiêu đề dài hơn sáu mươi ký tự để xem Google cắt bớt phần cuối"].slice(0, 66).join("");
    check("(the test's long title is in the orange 61–70 range)", [...longTitle].length > 60 && [...longTitle].length <= 70, String([...longTitle].length));
    check("the three fields stop typing at the server's limits (60 / 70 / 200)", [p.$("seo-keyword").maxLength, p.$("seo-title").maxLength, p.$("seo-description").maxLength].join() === "60,70,200");
    p.type("seo-title", longTitle);
    check("typing: the count updates at once", p.$("seo-title-count").textContent === `(${[...longTitle].length} ký tự)`);
    check("typing: shortly after, the preview is cut with … and an orange length check appears", await until(() => p.$("seo-prev-title").textContent.endsWith("…")) && [...p.d.querySelectorAll(".admin-seo__check--warn")].some((li) => li.textContent.includes("Tiêu đề hơi dài")), p.$("seo-prev-title").textContent);
    check("typing: nothing was saved", (await pool.query("SELECT seo_title FROM products WHERE id=$1", [seeded])).rows[0].seo_title === db.seo_title);
    p.type("seo-keyword", "");
    check("typing: clearing the keyword turns the first check red and drops the keyword-in-… checks", await until(() => [...p.d.querySelectorAll(".admin-seo__check")].some((li) => li.textContent.includes("Chưa có từ khóa chính")) && ![...p.d.querySelectorAll(".admin-seo__check")].some((li) => li.textContent.includes("có trong tiêu đề"))));

    // unsaved changes: the question
    p.close();
  }

  {
    const p = await openPanel(false);
    p.row(seeded).click();
    await until(() => !p.$("seo-panel").hidden);
    p.type("seo-keyword", "một từ khóa chưa lưu");
    p.row(plain).click();
    await sleep(200);
    check("switching products with unsaved typing asks first", p.asked.length === 1 && /thay đổi chưa lưu/.test(p.asked[0]), JSON.stringify(p.asked));
    check("…and \"no\" keeps you where you are, with what you typed", p.$("seo-keyword").value === "một từ khóa chưa lưu" && p.row(seeded).classList.contains("is-selected"));
    p.close();
    const q = await openPanel(true);
    q.row(seeded).click();
    await until(() => !q.$("seo-panel").hidden);
    q.type("seo-keyword", "một từ khóa chưa lưu");
    q.row(plain).click();
    check("…\"yes\" moves on to the other product", await until(() => q.$("seo-product-name").textContent !== "" && q.row(plain).classList.contains("is-selected")) && q.asked.length === 1);
    q.close();
  }

  // saving
  {
    await remember(plain);
    const p = await openPanel();
    p.row(plain).click();
    await until(() => !p.$("seo-panel").hidden && p.row(plain).classList.contains("is-selected"));
    const realName = (await pool.query("SELECT name FROM products WHERE id=$1", [plain])).rows[0].name;
    const kw = realName.split(" ").slice(0, 2).join(" ").toLowerCase();
    p.type("seo-keyword", `  ${kw}  `);
    p.type("seo-title", `${kw} giao đúng ngày | Bloomy`);
    p.type("seo-description", `${kw} tươi, gói đẹp, giao đúng ngày và khung giờ bạn chọn tại TP.HCM, kèm thiệp viết tay để món quà thêm ý nghĩa. Đặt hoa ngay tại Bloomy.`);
    check("typing a full set: every check turns green", await until(() => p.d.querySelectorAll(".admin-seo__check").length > 0 && [...p.d.querySelectorAll(".admin-seo__check")].every((li) => li.classList.contains("admin-seo__check--good"))), [...p.d.querySelectorAll(".admin-seo__check")].map((li) => li.className.split("--")[1] + ":" + li.textContent).join(" | "));
    p.d.getElementById("seo-form").requestSubmit();
    check("save: the notice says it is saved", await until(() => !p.$("seo-notice").hidden && /Đã lưu/.test(p.$("seo-notice").textContent)));
    const row = (await pool.query("SELECT seo_keyword, seo_title FROM products WHERE id=$1", [plain])).rows[0];
    check("save: the database has the tidied text", row.seo_keyword === kw && row.seo_title === `${kw} giao đúng ngày | Bloomy`);
    check("save: the row's dot turns green, its subtitle shows the keyword", await until(() => p.row(plain).querySelector(".admin-seo__dot--good") !== null && p.row(plain).textContent.includes(kw)));
    const page = await (await fetch(`${BASE}/product.html?id=${plain}`)).text();
    check("save: the product page says it on the next request", new JSDOM(page).window.document.title === `${kw} giao đúng ngày | Bloomy`);
    // refusal shown to the person
    p.type("seo-title", "t".repeat(71));
    p.d.getElementById("seo-form").requestSubmit();
    check("save: a title over the limit shows an error in words, and saves nothing", await until(() => !p.$("admin-seo-error").hidden && /Tiêu đề SEO/.test(p.$("admin-seo-error").textContent)) && (await pool.query("SELECT seo_title FROM products WHERE id=$1", [plain])).rows[0].seo_title === `${kw} giao đúng ngày | Bloomy`);
    p.close();
  }

  // discontinued note, and everything is shown as text
  {
    await remember(gone);
    const evil = `<img src=x onerror=alert(1)> & "q" <b>đậm</b>`;
    await pool.query("UPDATE products SET name=$1, seo_keyword=$1 WHERE id=$2", [evil, gone]);
    const p = await openPanel();
    check("a hostile product name and keyword are shown as plain text in the list", p.row(gone).querySelector(".admin-seo__row-name").textContent === evil && !p.d.querySelector("img[onerror]") && !p.row(gone).querySelector("b"));
    p.row(gone).click();
    await until(() => !p.$("seo-panel").hidden && p.row(gone).classList.contains("is-selected"));
    check("…and in the editor's heading and keyword box", p.$("seo-product-name").textContent === evil && p.$("seo-keyword").value === evil && !p.d.querySelector("#seo-panel img"));
    check("a discontinued product shows the noindex note", !p.$("seo-robots-note").hidden);
    p.close();
  }
} finally {
  for (const [id, r] of saved) await pool.query("UPDATE products SET name=$1, status=$2, image=$3, short_description=$4, seo_keyword=$5, seo_title=$6, seo_description=$7 WHERE id=$8", [r.name, r.status, r.image, r.short_description, r.seo_keyword, r.seo_title, r.seo_description, id]);
  if (managerId) {
    await pool.query("DELETE FROM session WHERE sess::text LIKE $1", [`%"adminId":${managerId}%`]);
    await pool.query("DELETE FROM admin_users WHERE id = $1", [managerId]);
  }
}
let restored = saved.size >= 2;
for (const [id, r] of saved) if (JSON.stringify((await pool.query(`SELECT ${COLS} FROM products WHERE id=$1`, [id])).rows[0]) !== JSON.stringify(r)) restored = false;
check("cleanup: every product I touched is back exactly as it was", restored);
check("cleanup: the test staff account is gone", Number((await pool.query("SELECT COUNT(*) FROM admin_users WHERE username LIKE 'zz.test.%'")).rows[0].count) === 0);
await pool.end();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
