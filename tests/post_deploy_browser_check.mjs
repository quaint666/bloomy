// Post-deploy browser check for the live site. Read-only: it only loads pages (GET), nothing is ordered or changed.
//
//   node tests/post_deploy_browser_check.mjs [baseUrl]        (from the repo root)
//   CHROMIUM=/usr/bin/chromium node tests/post_deploy_browser_check.mjs     (use an installed browser instead of Playwright's)
//
// This file lives in tests/ but is NOT one of the suites (its name does not end in _test.mjs): the suites must never
// be pointed at production, and this one is meant to be. Run it only on purpose, after a deploy.
//
// For every page it reports:
//   - the requests the page sent to Google (the gtag loader and the hits) and the HTTP status of each. It waits up to
//     8 seconds for a hit to be answered, because the page_view hit goes out some time after the loader runs
//   - console lines about the Content Security Policy, sorted three ways:
//       enforced      what the browser really blocked: a PROBLEM
//       accepted      "Executing inline script" while the only inline scripts on the page are Cloudflare's bot-detection
//                     loader (Bot Fight Mode, accepted: its content changes on every request, so no hash can allow it)
//       report-only   a policy that only reports (not ours; nothing is blocked): counted, never a problem
//   - any other inline script on the page (not JSON-LD, not Cloudflare's): a PROBLEM
//   - whether the order-confirmation token reached Google (a fake token is used, so no real order is touched), and
//     whether that check actually had a hit to inspect
// Exit code 1 if anything is a PROBLEM.
//
// Proves: no enforced CSP complaint in a real browser, the GA loader and hits leave the browser and Google answers
//         2xx, the admin page sends nothing to Google, the token is not in any Google URL (when a hit was seen).
// Does NOT prove: that the visit shows in GA Realtime/reports (Google processes it separately), or how pages look.
// Side effect: a handful of real page views are added to the real GA property. The browser presents itself as
// ordinary Chrome (not "HeadlessChrome") so they count and can be seen in Realtime.

import { chromium } from "playwright";

const BASE = (process.argv[2] || "https://bloomy.quaintshomelabdomain.uk").replace(/\/$/, "");
const FAKE_TOKEN = "zz-fake-token-0123456789";
// [path, should it report to Google?]  (admin pages never load main.js, so they should send nothing)
const PAGES = [
  ["/", true],
  ["/landing", true],
  ["/products.html", true],
  ["/product.html?id=9", true],
  ["/cart.html", true],
  ["/checkout.html", true],
  ["/blog", true],
  ["/about.html", true],
  [`/order-confirmation.html?token=${FAKE_TOKEN}`, true],
  ["/admin-login.html", false],
];
const GOOGLE_HOST = /(^|\.)(google-analytics\.com|googletagmanager\.com|analytics\.google\.com)$/;
const ok2xx = (s) => typeof s === "number" && s >= 200 && s < 300;
// What Cloudflare's injected loader starts with (seen on every page, see the hashes in the post-deploy notes).
const CLOUDFLARE_INLINE = "(function(){function c(){var b=a.contentDocument";
const REPORT_ONLY = /report-only|\[Report Only\]/i;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const ua = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`;
const context = await browser.newContext({ userAgent: ua });

let problems = 0;
for (const [path, expectGoogle] of PAGES) {
  const page = await context.newPage();
  const csp = [];
  const google = []; // { url, status }
  page.on("console", (m) => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) csp.push(t); });
  page.on("request", (r) => { try { if (GOOGLE_HOST.test(new URL(r.url()).hostname)) google.push({ url: r.url(), status: "pending" }); } catch {} });
  const find = (url) => google.find((g) => g.url === url && g.status === "pending");
  page.on("response", (r) => { const g = find(r.url()); if (g) g.status = r.status(); });
  page.on("requestfailed", (r) => { const g = find(r.url()); if (g) g.status = `failed (${r.failure()?.errorText})`; });

  let status = "no response";
  try {
    const resp = await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 30000 });
    status = resp ? resp.status() : "no response";
    const isHit = (g) => /\/g\/collect/.test(g.url);
    if (expectGoogle) {
      const until = Date.now() + 8000;
      while (Date.now() < until && !google.some((g) => isHit(g) && g.status !== "pending")) await page.waitForTimeout(250);
      await page.waitForTimeout(500); // let a second hit, if there is one, finish too
    } else {
      await page.waitForTimeout(2000); // a page that should stay silent gets a little time to prove it
    }
  } catch (err) {
    status = `error: ${err.message.split("\n")[0]}`;
  }
  // Inline scripts left in the page (JSON-LD is data, not code).
  const inline = await page.evaluate(() => [...document.querySelectorAll("script:not([src])")].filter((s) => !/ld\+json/.test(s.type)).map((s) => s.textContent.trim().slice(0, 60))).catch(() => []);
  await page.close();

  const loader = google.filter((g) => /\/gtag\/js/.test(g.url));
  const hits = google.filter((g) => /\/g\/collect/.test(g.url));
  const leaked = google.some((g) => { let d = g.url; try { d = decodeURIComponent(g.url); } catch {} return g.url.includes(FAKE_TOKEN) || d.includes(FAKE_TOKEN); });

  const foreignInline = inline.filter((s) => !s.startsWith(CLOUDFLARE_INLINE));
  const reportOnly = csp.filter((l) => REPORT_ONLY.test(l));
  const enforced = csp.filter((l) => !REPORT_ONLY.test(l));
  // Inline-script complaints are accepted only when every inline script on the page is Cloudflare's.
  // (Chrome words this line two ways, depending on its version.)
  const accepted = foreignInline.length === 0 ? enforced.filter((l) => /^(Executing inline script|Refused to execute inline script)/.test(l)) : [];
  const problemLines = enforced.filter((l) => !accepted.includes(l));

  const why = [];
  if (!ok2xx(status)) why.push(`page status ${status}`);
  if (problemLines.length) why.push(`${problemLines.length} enforced CSP console line(s)`);
  if (foreignInline.length) why.push(`unexpected inline script: ${JSON.stringify(foreignInline)}`);
  if (leaked) why.push("TOKEN REACHED GOOGLE");
  if (expectGoogle) {
    if (!loader.length || !loader.every((g) => ok2xx(g.status))) why.push(`GA loader: ${loader.map((g) => g.status).join(",") || "not requested"}`);
    if (!hits.length || !hits.some((g) => ok2xx(g.status))) why.push(`GA hit: ${hits.map((g) => g.status).join(",") || "none sent"}`);
  } else if (google.length) {
    why.push(`${google.length} request(s) to Google, expected none`);
  }
  if (why.length) problems++;

  console.log(`== ${path.replace(FAKE_TOKEN, "<fake token>")}  (HTTP ${status})`);
  console.log(`   GA loader: ${loader.map((g) => g.status).join(",") || "-"}   hits: ${hits.map((g) => g.status).join(",") || "-"}`);
  console.log(`   CSP: ${problemLines.length} enforced · ${accepted.length} accepted (Cloudflare inline script) · ${reportOnly.length} report-only (ignored)`);
  for (const line of problemLines) console.log(`   CSP: ${line.slice(0, 170)}`);
  if (path.startsWith("/order-confirmation")) console.log(`   token check: ${hits.length ? `${hits.length} hit(s) inspected, ${leaked ? "TOKEN FOUND" : "token not present"}` : "NOT EXERCISED (no hit was recorded)"}`);
  console.log(`   ${why.length ? "PROBLEM: " + why.join("; ") : "ok"}`);
}

await browser.close();
console.log(`\n${PAGES.length - problems} of ${PAGES.length} pages ok, ${problems} with a problem`);
process.exit(problems ? 1 : 0);
