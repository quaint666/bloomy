// The product listing's pages: GET /api/products?page=N on the server, and the "‹ 1 2 3 ›" bar on products.html (real page
// and script in jsdom, against the running server).
//   A. the API        B. the page
//
// Run from the repo root with the server running (it needs no database login of its own, and writes nothing):
//   BASE=http://localhost:3000 node tests/listing_test.mjs
//
// What this proves: the pages are cut correctly (no product lost or repeated, in the order of the sort, with the filters),
// the old callers still get a bare array, and the page reads, writes and resets its page number as it should.
// What it does NOT prove: how the bar looks, that the scroll lands in the right place (jsdom has no layout; only that it
// is asked for), or anything about a phone.

import { createRequire } from "node:module";
import path from "node:path";
import jsdom from "jsdom";
const { JSDOM, VirtualConsole, requestInterceptor } = jsdom;

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const ROOT = process.cwd();
const require = createRequire(path.join(ROOT, "package.json"));
const { LISTING_PAGE_SIZE } = require(path.join(ROOT, "shared", "rules.js"));

let passed = 0, failed = 0;
process.on("unhandledRejection", (e) => { failed++; console.log(`FAIL a page script failed on its own :: ${String(e).slice(0, 160)}`); });
function check(name, cond, extra = "") { if (cond) passed++; else { failed++; console.log(`FAIL ${name}${extra ? " :: " + extra : ""}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000, step = 40) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(step); } return false; }
const noCss = requestInterceptor(async (request) => (/\.css(\?|$)/.test(request.url) ? new Response("", { headers: { "Content-Type": "text/css" } }) : undefined));
const api = async (q) => (await fetch(`${BASE}/api/products${q}`)).json();

// ============================================================ A. the API
const all = await api("");                       // no ?page: the bare array, as before
const total = all.length;
const pages = Math.max(1, Math.ceil(total / LISTING_PAGE_SIZE));
check("setup: the shop has more than one page of products (else nothing here is tested)", pages > 1, `${total} products`);
check("no ?page: still a bare array", Array.isArray(all));
check("?limit=5 (the nav search): still a bare array of 5", (await api("?limit=5")).length === 5 && Array.isArray(await api("?limit=5")));
check("?featured=1 (the homepage): still a bare array", Array.isArray(await api("?featured=1")));
check("?sizes=1 (the POS): still a bare array with sizes", (await api("?sizes=1"))[0]?.sizes?.length > 0);

const first = await api("?page=1");
check("?page=1: { items, total, page, pages } and a full page", Array.isArray(first.items) && first.items.length === Math.min(LISTING_PAGE_SIZE, total) && first.total === total && first.page === 1 && first.pages === pages, JSON.stringify({ n: first.items?.length, total: first.total, pages: first.pages }));

const joined = [];
for (let p = 1; p <= pages; p++) joined.push(...(await api(`?page=${p}`)).items);
check("the pages together are the whole list, in the same order, none repeated", JSON.stringify(joined.map((x) => x.id)) === JSON.stringify(all.map((x) => x.id)));
check("the last page holds what is left", (await api(`?page=${pages}`)).items.length === total - LISTING_PAGE_SIZE * (pages - 1));

const past = await api("?page=9999");
check("a page past the end comes back as the last page", past.page === pages && past.items.length === total - LISTING_PAGE_SIZE * (pages - 1));
check("page=0, page=-4 and page=abc come back as page 1", [(await api("?page=0")).page, (await api("?page=-4")).page, (await api("?page=abc")).page].every((n) => n === 1));

// Categories are picked by size, not by id, so adding products to the seed cannot break this: one that fits on a single
// page and, if the shop has one, one that needs two.
const cats = await (await fetch(`${BASE}/api/categories`)).json();
const shortCat = cats.filter((c) => c.count > 0 && c.count <= LISTING_PAGE_SIZE).sort((a, b) => b.count - a.count)[0];
const longCat = cats.find((c) => c.count > LISTING_PAGE_SIZE);
check("setup: a category that fits on one page", !!shortCat);
const cat = await api(`?category=${shortCat.id}`);
const catPaged = await api(`?page=1&category=${shortCat.id}`);
check("a filter is applied before the pages are cut: total and items match the filtered array", catPaged.total === cat.length && catPaged.items.length === Math.min(LISTING_PAGE_SIZE, cat.length));
if (longCat) {
  const longAll = await api(`?category=${longCat.id}`);
  const second = await api(`?page=2&category=${longCat.id}`);
  check("a filter that needs two pages: page 2 holds the rest of that category, not of the whole shop", second.total === longAll.length && second.pages === Math.ceil(longAll.length / LISTING_PAGE_SIZE) && second.items.length === longAll.length - LISTING_PAGE_SIZE);
}
const none = await api("?page=1&search=zzzzzzzz");
check("no match: no items, total 0, one page (page 1)", none.items.length === 0 && none.total === 0 && none.pages === 1 && none.page === 1);

const cheap = [];
for (let p = 1; p <= pages; p++) cheap.push(...(await api(`?page=${p}&sort=price_asc`)).items.map((x) => x.price));
check("sort=price_asc runs across the pages, not within each", cheap.length === total && cheap.every((v, i) => i === 0 || cheap[i - 1] <= v));

// ============================================================ B. the page
async function openListing(query, { down = false } = {}) {
  const url = `${BASE}/products.html${query}`;
  const html = await (await fetch(url)).text();
  const calls = [], scrolls = [];
  const dom = new JSDOM(html, { url, runScripts: "dangerously", resources: { interceptors: [noCss] }, pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
    beforeParse(w) {
      w.Element.prototype.scrollIntoView = function (opts) { scrolls.push({ el: this, opts }); };
      w.fetch = (u, o = {}) => {
        const target = new URL(u, url);
        calls.push(target.pathname + target.search);
        if (down && target.pathname === "/api/products") return Promise.reject(new TypeError("network down (test)"));
        return fetch(target, o);
      };
    } });
  const d = dom.window.document;
  const cards = () => d.querySelectorAll("#product-grid .product-card").length;
  const nums = () => [...d.querySelectorAll("#pagination .pagination__btn")].filter((b) => /^\d+$/.test(b.textContent));
  const current = () => d.querySelector('#pagination [aria-current="page"]')?.textContent;
  const search = () => dom.window.location.search;
  return { dom, d, calls, scrolls, cards, nums, current, search, $: (id) => d.getElementById(id), close: () => dom.window.close() };
}

{ // first page
  const p = await openListing("");
  check("page 1: the grid fills with a page of cards", await until(() => p.cards() > 0) && p.cards() === Math.min(LISTING_PAGE_SIZE, total), String(p.cards()));
  check("the count says how many products match in all, not how many are on the page", p.$("result-count").textContent === String(total), p.$("result-count").textContent);
  check("the bar is shown with one button per page, page 1 marked as current", p.$("pagination").hidden === false && p.nums().length === pages && p.current() === "1");
  check("'previous' is disabled on page 1, 'next' is not", p.d.querySelector('[aria-label="Trang trước"]').disabled === true && p.d.querySelector('[aria-label="Trang sau"]').disabled === false);
  check("the URL stays clean on page 1 (no ?page=1)", !p.search().includes("page="));

  p.nums()[1].click(); // "2"
  check("clicking 2 asks the server for page 2 and shows it", await until(() => p.current() === "2") && p.calls.some((c) => /^\/api\/products\?.*page=2/.test(c)) && p.cards() === Math.min(LISTING_PAGE_SIZE, total - LISTING_PAGE_SIZE));
  check("the URL now carries ?page=2, so the page can be shared or reloaded", p.search().includes("page=2"));
  check("the page scrolls back up to the grid", p.scrolls.some((s) => s.el.classList.contains("listing-grid-section")));

  p.d.querySelector('[aria-label="Trang sau"]').click();
  check("'next' goes to page 3", pages < 3 || (await until(() => p.current() === "3")));

  const sort = p.$("sort-select");
  sort.value = "price_asc";
  sort.dispatchEvent(new p.dom.window.Event("change"));
  check("changing the sort goes back to page 1 and drops ?page", await until(() => p.current() === "1") && !p.search().includes("page=") && p.search().includes("sort=price_asc"));

  p.nums()[1].click();
  await until(() => p.current() === "2");
  p.d.querySelector(`.pill[data-category="${shortCat.id}"]`)?.click();
  check("picking a category goes back to page 1 as well", await until(() => !p.search().includes("page=") && p.search().includes(`category=${shortCat.id}`)));
  p.close();
}

{ // a link to a later page, and a page that does not exist
  const p = await openListing(`?page=${pages}`);
  check("?page=<last> opens on that page, with 'next' disabled", await until(() => p.current() === String(pages)) && p.cards() === total - LISTING_PAGE_SIZE * (pages - 1) && p.d.querySelector('[aria-label="Trang sau"]').disabled === true);
  p.close();
  const q = await openListing("?page=9999");
  check("?page=9999 shows the last page and the URL is corrected to it", await until(() => q.current() === String(pages)) && q.search().includes(`page=${pages}`));
  q.close();
}

{ // a filter that fits on one page
  const p = await openListing(`?category=${shortCat.id}`);
  check("a short result: no bar, and the count is the filtered total", await until(() => p.cards() > 0) && p.$("pagination").hidden === true && p.$("result-count").textContent === String(cat.length) && p.cards() === cat.length);
  p.close();
}

{ // the API down
  const p = await openListing("", { down: true });
  check("API down: no bar, the message says so", await until(() => p.d.body.classList.contains("is-ready")) && p.$("pagination").hidden === true && /Không thể tải sản phẩm/.test(p.$("listing-empty").textContent) && p.$("listing-empty").hidden === false);
  p.close();
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
