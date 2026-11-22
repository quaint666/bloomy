# Bloomy: how it works

Short and current. Detail, the API table and the locked decisions are in `00-HANDOFF.md`; where this page and the code disagree, the code wins.

## 1. What it is

One Node process (Express 5, TypeScript) in front of one PostgreSQL 18 database. Customer pages are HTML files that the server fills with values from the database; each page then loads one small script that calls the JSON API. UI text is Vietnamese. There is no front-end framework.

```
                 Cloudflare
                     │
browser ───────► Express (server.ts)
  ▲   ▲               │
  │   │ HTML          ├─ pageRenderer ─ render.ts: public/*.html + partials/ + {{tokens}} from the database
  │   └───────────────┤
  │ JSON              ├─ express.static: css, js, images, fonts, admin pages
  └───────────────────┤
                      └─ /api/* routers ─ pricing.ts / db.ts ─► PostgreSQL
```

## 2. A request, in the order `server.ts` mounts things

1. Security headers (helmet, strict CSP), sessions (stored in Postgres), JSON body, site rate limit.
2. `pageRenderer()`: `/`, `/landing`, `/blog`, `/blog/<slug>` and every `/<name>.html` except `admin-*.html`.
3. `express.static`: fonts, images, the bundled scripts and styles, and the admin pages.
4. `/sitemap.xml`, `/healthz`, then the `/api/...` routers, then one error handler.

The URL of a page is its file name, so there is no route table for pages. Admin pages are static files; the real protection is the role guard on every `/api/admin` route (`requireEmployee`, `requireAdmin` = manager, `requireOwner`).

## 3. Server and browser

| | Server | Browser |
|---|---|---|
| Prices, coupons, shipping, totals | All of it (`pricing.ts`, via `POST /api/orders/quote`) | Shows the answer |
| Order writing | `placeOrder()`, the one writer (web checkout and POS) | Sends the form |
| Page shell, SEO tags, campaign card | `render.ts` | Never builds them |
| Cart, lists, small behaviour | Serves the data | `web/*.ts` (one bundle per page) |

Money is never computed in the browser. Customer text goes through `textContent` or `escapeHtml`.

## 4. Where things live

| Folder or file | What |
|---|---|
| `server.ts`, `db.ts`, `render.ts`, `pricing.ts`, `blog.ts`, `seo.ts`, `email.ts`, `totp.ts` | Server modules at the root |
| `routes/` | One file per API area (customer and `admin-*`) |
| `web/` and `web/lib/` | Browser TypeScript, bundled by esbuild into `public/js/` |
| `shared/` | Types and the few values both sides use (`rules.ts`, `vn-time.ts`, `escape.ts`) |
| `public/`, `partials/`, `content/` | Pages, shared header and footer, blog |
| `schema.sql`, `seed-*.sql` | The schema (applied by pgschema) and the catalogue |
| `tests/` | 29 suites against a real server and database |

## 5. Data

PostgreSQL holds 23 tables: the catalogue and flowers, campaigns and coupons, orders and their lines, admin users and recovery codes, settings, cut-off overrides, funnel events and the session store. `schema.sql` is the only schema source; nothing is altered by hand. Seeds run in a fixed order, and a live shop gets new catalogue rows through `seed-products-2.sql`.

## 6. Build, test, ship

- `Dockerfile`: three stages (browser bundle and minify, server compile, runtime), base images pinned by tag and digest. `Dockerfile.schema` holds pgschema and the seeds.
- `npm test` builds a throwaway database, starts its own server and runs every suite.
- CI (`build.yml`) builds both images, checks the schema, runs the suites, and publishes to GHCR from `main` only. It never deploys; deploying is a manual step.

## 7. Limits to know about

One process, one VM. The rate limiters and the 2FA lockout live in memory, so a restart clears them and a second instance would not share them. Pages are read from disk on every request. There are no metrics and no structured logs. None of this has been load-tested.
