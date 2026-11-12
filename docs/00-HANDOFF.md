# Bloomy — HANDOFF

Written 2026-10-06, updated 2026-10-07 (3c, deploy) and **swept 2026-10-07 for the move to Claude Code**: stale sections were removed and every claim that could be checked was re-checked against the repo and the local database. The repo is now the single source of truth. **`CLAUDE.md`** holds how to run things and the rules that apply every session; this file holds the reasoning and reference behind them (architecture, API table, locked decisions, tests). Where this file and the code disagree, **the code wins**: verify before relying on any claim (*"exists" and "verified" are different claims*). Tags: **[verified]** = run or read in the repo on the date given, **[user-confirmed]** = H said it works, **[unverified]** = nobody checked, **[unknown]** = no record either way.

Contents: 0 things to know · 4 what was built · 5 architecture and code map (+ API table) · 6 decisions that are locked · 9 schema, seeds and runtime facts · 10 tests · 12 testing practice and findings · 13 appendix. Section numbers are kept from the earlier versions so references stay valid; sections 1-3, 7, 8 and 11 are not part of this copy (8, local setup, is `CLAUDE.md`).

---

## 0. Things to know before touching anything

1. **Project:** Bloomy, a Vietnamese flower e-commerce site, a university course project. Live: https://bloomy.quaintshomelabdomain.uk.
2. **Language:** English with H; the site UI and all customer-facing text are Vietnamese.
3. **Stack:** Node 26 / Express 5 / PostgreSQL 18 / Docker / Cloudflare in front. Plain HTML + CSS + classic JS (no framework; the build steps are the **esbuild minify stage** (browser files) and the **tsc compile stage** (server), both in the Dockerfile, section 5). Schema is declarative with **pgschema** 1.13.1 (`schema.sql` is the desired state; never hand-ALTER production). Customer pages are not served as static files: `render.js` reads each page, inserts the shared partials (`<!--include:header-->` …) and fills `{{tokens}}` from the database before sending it.
4. **Everything customer-typed is rendered with `textContent` / `escapeHtml`; the CSP is strict:** `script-src 'self' https://www.googletagmanager.com`, `style-src 'self'`, `img-src 'self' data: https://*.google-analytics.com https://*.googletagmanager.com`, `connect-src 'self'` + the three Google hosts. **No inline styles or scripts**, no hotlinked images.
5. **"No repeated hardcoded values"** is a hard rule from H. One place per value (settings table, one module, one constant). The GA Measurement ID lives only in `public/js/main.js`; header/footer live only in `partials/`; footer categories come from the DB.
6. **jsdom cannot see CSS or layout.** This hid three real bugs (a `hidden` panel that never hid, an absolutely-positioned hint class used outside its container, a doubled scroll offset). Defence in place: a global `[hidden] { display: none !important }` rule, static CSS checks in `ui_polish_test`, and the rule **"say plainly what looks/feels cannot be verified"**. Never claim a visual result.

---

## 4. What was built (by batch, with the decisions behind it)

**3b-1 — shared partials and the renderer.** Header, nav links, footer and the floating contact widget were copy-pasted into ~11 pages and filled by JS after load (blink, invisible to crawlers). Now `partials/*.html` hold them once, `render.js` includes them and fills tokens (`{{contact_phone_display}}`, `{{tel_url}}`, `{{zalo_url}}`, `{{maps_url}}`, `{{shop_address}}`, `{{vat_rate}}`, `{{min_fee}}`/`{{max_fee}}`, `{{footer_categories}}` …) from the database; `fillSettings()` was removed from `main.js`. Pages are sent with `Cache-Control: no-cache` + ETag. Header: 6 links; About page: two cards (story, commitment); footer "Danh mục" from the same `getCategoryTree()` as the listing API. Repo defaults for phone/email are placeholders (`0900000000`, `hello@bloomy.example`) so personal data is not in a published repo — **real values are entered in Cài đặt after each wipe**.

**3b-2 — checkout, campaigns, landing page.** Checkout form and payment view became partials; `main.js` fires `bloomy:cart-changed` after every `saveCart()`; `checkout.js` redraws on it, the summary has +/−/Xóa, the order button waits for a price, `orderPlaced` stops an empty-cart flip, `bloomy:payment-waiting` adds `body.is-paying` (hides hero/cards while the ZaloPay QR shows). **Campaign model** (replaced the earlier idea of `landing_enabled`/`landing_coupon` settings and a `products.landing` flag): tables `campaigns` and `campaign_products`, `settings.active_campaign_id` (FK, `ON DELETE SET NULL`); the coupon's code/value/dates are **read live** from `coupons`, never copied. Seeds: coupons `PHUNU20` (20 %, delivery dates 2026-10-15 → 25) and `THAYCO20` (20 %, 2026-11-15 → 22); campaign 1 "Gửi một chút thương ngày 20/10" (active in the seed, products BLM-0005/0001/0007/0008/0040/0048) and campaign 2 "Gửi lời thương đến thầy cô" (BLM-0006/0003/0011/0039/0046/0012). `/landing` is a renderer alias; `/landing.html` → 301 `/landing`; no active campaign → 302 `/products.html` (query kept). Product statuses redistributed in the seed (5 discontinued: ids 4, 14, 19, 38, 45; 10 sold out today: 2, 13, 20, 23, 29, 30, 34, 35, 42, 50; 36 available) so the status UI can be shown; all 12 campaign products are available.

**3b-3 — blog, SEO, analytics.** Blog content lives in `content/` (outside `public/`, never served raw): `posts.json`, `blog.html`, `blog-post.html`, `posts/<slug>.html`; `[[product:N]]` markers become live product cards; `checkContent()` refuses to start with broken content. Product SEO: `seo.js` is the single implementation of the effective title/description, the checks, the Google-style snippet and field validation (keyword ≤ 60, title ≤ 70, description ≤ 200), used by both the page and `admin-seo.html`; `product.html`'s head is filled server-side (`{{product_title}}`, `{{product_description}}`, `{{product_canonical}}`, `{{product_robots}}`, `{{product_og_images}}`); discontinued → `noindex, follow` (computed per request, nothing stored); unknown id → 404 + noindex; DB down → generic head with no robots claim. **Keyword check rule (changed at the user's request):** phrase in the product text = green; every word present but apart = green with the message "Có đủ các từ…"; missing words = orange naming them; matching is by whole words, not substrings. GA4: ID `G-SJ1XV11XC2` in `main.js` only; loads only on `bloomy.quaintshomelabdomain.uk` (so local browsing and tests never reach the real property); Google signals and ad personalisation off; the `?token=` query of the order-confirmation address is never given to Google (neither as page address nor referrer); `Referrer-Policy: no-referrer` is helmet's default and is pinned by a test; one paragraph in `privacy.html` (+ date 06/10/2026); **no cookie banner** (decided).

**qol-1 / campaign editor / qol-2.**
- *Admin:* one **"Menu"** button (panel with the current page marked; closes on a second click, an outside click and Escape); the POS pickup list is a toggle with a count badge, polled every 20 s, with a **10-second "new order" notice** (top right; never announces orders already waiting at page load; an open list is not redrawn under the cursor); `/` focuses the POS search; the **last admin page** is remembered and opens after the next login.
- *Campaign editor* (`admin-campaigns.html`, manager+): edit name/headline/subheadline, choose the coupon, choose the picture **from the files already in `public/images/`** (no upload — the app never writes to disk), add/remove/reorder up to 12 products, create/delete campaigns (not the active one). Switching a campaign **on** (owner, Cài đặt) needs ≥ 1 non-discontinued product — checked only when the choice *changes*, so saving a phone number never fails because the running campaign ran out of products.
- *Landing/homepage:* split hero (text left, picture right; picture first on narrow screens; no picture = plain band); the homepage card shows the same picture; a friendly message when every product of the campaign is discontinued.
- *Customer polish:* hover/press feedback, nav underline, cart-badge pop (only when the count goes **up**), "added" pop, cards rise in (from 40 % opacity, never 0 — an invisible element delays Largest Contentful Paint), skeleton placeholders (cleared on failure), add-to-cart **toast** with cart/checkout links, **share button** (native share sheet where the browser has one; else copy link / Facebook; no Zalo SDK — it needs a third-party script), back-to-top, recently-viewed strip (checked localStorage), blog reading bar, copyable coupon code, soft page cross-fade (`@view-transition`; **removed again in 3c**), one consistent focus ring. Admin pages stay plain (all motion is scoped to customer `<body>`).
- *Fixes found in review:* menu panel never hid (specificity + order) → global `[hidden]` rule; `.admin-form__hint` (absolutely positioned) misused → `.admin-note`; a second scroll offset removed (the site already has `[id] { scroll-margin-top }`); a folder named `x.webp` was offered as a picture (editor lists files only).

**3c / deploy session (2026-10-07).**
- **Owner 2FA** (`totp.js`, `routes/admin-auth.js`, `admin-account.html` + `js/admin-account.js`, `admin-login.html` + `js/admin-login.js`, `css/admin-twofa.css`): RFC 6238 TOTP (SHA-1, 6 digits, 30 s, ±1 step of clock drift). The secret is stored **encrypted with AES-256-GCM** under the env variable **`TOTP_ENCRYPTION_KEY`** (32 random bytes, base64: `openssl rand -base64 32`). `server.js` lists it in `REQUIRED_ENV` and calls `require("./totp").loadKey()` at start-up, so a missing or wrong-length key stops the app with exit 1 and a clear message instead of failing at the owner's first login. A key that has the right length but is the **wrong key** (changed or lost) is caught only by a start-up self-check in `server.js` (`checkTotpKey`): it tries to decrypt one stored secret and logs one `Bloomy: ERROR: TOTP_ENCRYPTION_KEY cannot decrypt…` line; it never stops the app, it is not awaited (the line can come after the first `/healthz`), and it is silent when no secret is stored or the database is not ready. **Login is one request** carrying username, password and, when asked for, the code: right password + 2FA on + no code → `200 {needs_code:true}` and **no session**; a wrong code counts only after the password was right; **3 wrong codes lock that account for 5 minutes (in memory — a restart clears it)**; a code works **once** (`admin_users.totp_last_step`); 10 recovery codes, stored hashed, single use (`recovery_codes.used_at`); the 2FA endpoints share `twoFactorLimiter` (10 per 15 minutes). No "remember this browser" (decided). Manager/employee accounts have no 2FA.
- **Way back in when phone and codes are both lost:** `node create-admin.js --reset-2fa` (shell only, on the server: `sudo docker exec -it bloomy_app node create-admin.js --reset-2fa`). **[user-confirmed]** it works. After a reset the owner logs in with the password alone and enrols again.
- **Minify:** the `Dockerfile` has two stages. Stage `assets` runs `npm ci --ignore-scripts` and `esbuild --minify --charset=utf8 --legal-comments=none --outdir=/out --outbase=public` over `public/**/*.js|css` (with file-count checks); the final stage does `COPY --from=assets /out ./public` and also copies `totp.js`. esbuild is a **devDependency pinned in `package-lock.json`**. Not minified: HTML, `partials/`, `content/`. A new root-level `.ts` file needs its compiled `.js` added to the `COPY` edit (this is how `totp.js` was added).
- **Asset fingerprinting (replaces "purge Cloudflare after every deploy" for customer pages).** Why it was needed: Cloudflare sends browsers `cache-control: public, max-age=14400` (Browser Cache TTL 4 h) for static files, and `cf-cache-status: REVALIDATED` showed the *edge* was fine — the stale copy sat in the **browser**, which a purge cannot reach. Fix in `render.js` (applied after `expandIncludes`, before `fillTokens`): every relative `href|src="css/<name>.css"` / `"js/<name>.js"` in a rendered page gets `?v=<first 8 hex of the file's sha1>`; the hash is cached per file by mtime+size; the query string is part of Cloudflare's cache key, so a changed file gets a new URL at the edge **and** in the browser. **Not covered:** admin pages (served raw by `express.static`, so they can still be stale for up to 4 h after a deploy — hard-reload or purge), images (7-day max-age), root-relative `/js/…` URLs, URLs that already carry a query; a file that does not exist is left as written. That the origin sends `max-age=0` for static files is **inferred** from the code, not read off the wire.
- **Mobile/CSS fixes:** toast layout at ≤ 600 px, the campaign chip at ≤ 600 px, the landing card's "added" label positioned absolutely under the card (`.landing-card` is `position: relative` with 40 px bottom padding). The page cross-fade (`@view-transition`) was **removed**.
- **Cloudflare Bot Fight Mode** injects an inline script into every page, which triggers **one CSP console message per page**. Accepted: its content changes per request, so it cannot be hashed or allowed. Do not "fix" it by loosening `script-src`.
- **GA4 verified end to end** on the live site (loader, hits answered 2xx, nothing sent from admin pages, the order token not in any Google URL). The first-party `funnel_events` table is the source that ad blockers cannot hide — **state that limitation in the report's analytics chapter** (GA undercounts visitors with blockers).

---

## 5. Architecture and code map

**Request flow for a customer page.** `server.js` mounts helmet (CSP), sessions (`connect-pg-simple`, 1 h cookie, `secure` only when `NODE_ENV=production`), `trust proxy 2`, the API routers, `sitemap.xml`, then **`app.use(pageRenderer())`** (handles `/`, `/landing`, `/blog`, `/blog/<slug>` and every `/<name>.html` except `admin-*.html`), then `express.static` (fonts immutable 1 y, images 1 week, everything else revalidated). Admin pages are plain static files (their header is built by `public/js/admin-nav.js`).

**Server modules**
- `render.js` — the page renderer: reads `public/<page>.html`, replaces `<!--include:name-->` with `partials/name.html` (nesting up to 5 deep), replaces `{{token}}` (escaped unless the token is in `RAW_TOKENS`, whose HTML render.js built itself). Checks `partials/` at startup. Product pages get server-written SEO tokens; `/landing` and the homepage campaign card come from `getActiveCampaign()`; blog pages from `blog.js`. Files are read from disk on every request. It also fingerprints `css/` and `js/` URLs (`versionAssets`, section 4).
- `blog.js` — builds `/blog` and `/blog/<slug>` from `content/` (`posts.json` is the source of the index **and** the sitemap), `[[product:N]]` → live product cards, `checkContent()` at startup. `BLOOMY_CONTENT_DIR` overrides the folder (tests only).
- `seo.js` — `effective()`, `checks()`, `snippet()`, `health()`, `cleanFields()` (one implementation for the panel and the page).
- `pricing.js` — **the only place money, coupons, shipping and custom-bouquet rules are computed** (`quote()`).
- `routes/orders.js` — `placeOrder()` (the ONE order writer; web checkout and POS both use it), ZaloPay start/IPN/verify/retry, `returnOrderStock()`, `markOrderPaid()`.
- `routes/admin-auth.js` — login (with the optional 2FA code)/logout/me/password, the owner-only 2FA endpoints (`/api/admin/me/2fa…`), `requireRole(level)`, `requireAdmin` (= manager+), `LANDING` per role.
- `totp.js` — TOTP/HOTP on `node:crypto`, AES-256-GCM secret encryption, recovery-code helpers; `loadKey()` reads and checks `TOTP_ENCRYPTION_KEY`.
- `routes/campaigns.js` — `GET /api/campaigns/active` and `getActiveCampaign({ includeProducts })`.
- `routes/admin-campaigns.js` — campaign editor API (picture list = real files in `public/images`, `BLOOMY_IMAGES_DIR` overrides for tests; validation; transaction for the product list).
- `routes/admin-seo.js` — SEO panel API (list with health, one, patch, live preview).
- other routes: products, categories, tags, flowers (builder data), reviews, settings, admin-* (users, settings, coupons, pos, orders, products, flowers, stats, cutoffs, reviews), `csv.js`, `events.js` (funnel).
- `email.js` — customer + shop emails (`EMAIL_MODE=log` prints instead of sending).
- `create-admin.js` — bootstrap/emergency CLI (also how the first owner is made after a wipe); `--reset-2fa` clears an owner's 2FA.

**Folders:** `partials/` (header, nav-links, footer, floating-contact, checkout-form, checkout-payment) · `content/` (blog) · `public/` (pages, `css/`, `js/`, `images/`, `fonts/`) · `routes/` · `tests/` (not in the image).

**Frontend scripts.** `public/js/main.js` = cart, `quote`, project notice, GA loader, toast, `copyText`, recently-viewed storage, back-to-top, nav search, `data-copy` handler; exports `window.Bloomy.*` (`cart`, `escapeHtml`, `quote`, `toast`, `copyText`, `recent`, `track`, …). Per-page scripts: `home.js`, `listing.js`, `product.js` (+ `product-extras.js`), `cart.js`, `checkout.js`, `landing.js`, `custom-bouquet.js`, `blog.js` (reading bar), admin pages `admin-*.js`.

**Dockerfile** (three stages: assets, compile, runtime; section 4) copies the compiled output of: `server.js db.js email.js pricing.js render.js blog.js seo.js totp.js create-admin.js`, `routes/`, `public/` (the minified copy from stage 1), `partials/`, `content/`. **A new root-level `.ts` file or folder needs a COPY edit (`types.ts` excepted: types only)** (CI's start-up check catches a forgotten one). New files under `routes/`, `public/`, `partials/`, `content/` need nothing. Verified here: with no environment the app exits 1 with "missing required environment variables" (CI's fail-fast step), and with a missing `content/` it stops with a clear `ContentError`.

**Seeds, in load order:** `seed-categories.sql`, `seed-flowers.sql`, `seed-products.sql`, **`seed-gallery.sql`**, `seed-reviews.sql`, `seed-reference.sql`. `seed-reference.sql` must come **after** products (campaigns pick products by SKU; it raises an exception if it does not insert exactly 12 `campaign_products` rows). `gen_products.py` generates `seed-products.sql` (statuses live there). Seeds are for empty databases only: `seed.sh` (in the schema image, next to the six files) loads them in this order in **one transaction, all or nothing**, and refuses, changing nothing, when `products` or `settings` already hold rows.

### API table (generated from the code on 2026-10-06; the five 2FA rows and the login row were added by hand on 2026-10-07 from `routes/admin-auth.js`)

| Method | Path | Who | File |
|---|---|---|---|
| GET | `/api/admin/campaigns` | manager+ | routes/admin-campaigns.js |
| POST | `/api/admin/campaigns` | manager+ | routes/admin-campaigns.js |
| DELETE | `/api/admin/campaigns/:id` | manager+ | routes/admin-campaigns.js |
| GET | `/api/admin/campaigns/:id` | manager+ | routes/admin-campaigns.js |
| PATCH | `/api/admin/campaigns/:id` | manager+ | routes/admin-campaigns.js |
| GET | `/api/admin/campaigns/options` | manager+ | routes/admin-campaigns.js |
| GET | `/api/admin/coupons` | manager+ | routes/admin-coupons.js |
| POST | `/api/admin/coupons` | manager+ | routes/admin-coupons.js |
| PATCH | `/api/admin/coupons/:id` | manager+ | routes/admin-coupons.js |
| GET | `/api/admin/cutoffs` | manager+ | routes/admin-cutoffs.js |
| POST | `/api/admin/cutoffs` | manager+ | routes/admin-cutoffs.js |
| DELETE | `/api/admin/cutoffs/:id` | manager+ | routes/admin-cutoffs.js |
| GET | `/api/admin/flowers` | manager+ | routes/admin-flowers.js |
| PATCH | `/api/admin/flowers/:id/stock` | manager+ | routes/admin-flowers.js |
| POST | `/api/admin/login` | public (rate-limited; optional `code`; may answer `needs_code`) | routes/admin-auth.js |
| POST | `/api/admin/logout` | session | routes/admin-auth.js |
| GET | `/api/admin/me` | employee+ | routes/admin-auth.js |
| POST | `/api/admin/me/password` | employee+ | routes/admin-auth.js |
| GET | `/api/admin/me/2fa` | owner | routes/admin-auth.js |
| POST | `/api/admin/me/2fa/setup` | owner (2FA limiter) | routes/admin-auth.js |
| POST | `/api/admin/me/2fa/enable` | owner (2FA limiter) | routes/admin-auth.js |
| POST | `/api/admin/me/2fa/recovery-codes` | owner (2FA limiter) | routes/admin-auth.js |
| POST | `/api/admin/me/2fa/disable` | owner (2FA limiter) | routes/admin-auth.js |
| GET | `/api/admin/orders` | manager+ | routes/admin-orders.js |
| PATCH | `/api/admin/orders/:id` | manager+ | routes/admin-orders.js |
| PATCH | `/api/admin/orders/:id/fulfillment` | manager+ | routes/admin-orders.js |
| PATCH | `/api/admin/orders/:id/mark-paid` | manager+ | routes/admin-orders.js |
| PATCH | `/api/admin/orders/:id/refund` | manager+ | routes/admin-orders.js |
| POST | `/api/admin/orders/:id/reverify` | manager+ | routes/admin-orders.js |
| GET | `/api/admin/orders/delivery-sheet` | manager+ | routes/admin-orders.js |
| GET | `/api/admin/orders/orders.csv` | manager+ | routes/admin-orders.js |
| POST | `/api/admin/pos/orders` | employee+ | routes/admin-pos.js |
| POST | `/api/admin/pos/orders/:id/cancel` | employee+ | routes/admin-pos.js |
| GET | `/api/admin/pos/pickups` | employee+ | routes/admin-pos.js |
| POST | `/api/admin/pos/pickups/:id/handover` | employee+ | routes/admin-pos.js |
| GET | `/api/admin/products` | manager+ | routes/admin-products.js |
| PATCH | `/api/admin/products/:id/featured` | manager+ | routes/admin-products.js |
| PATCH | `/api/admin/products/:id/status` | manager+ | routes/admin-products.js |
| GET | `/api/admin/products/products.csv` | manager+ | routes/admin-products.js |
| GET | `/api/admin/reviews` | manager+ | routes/admin-reviews.js |
| DELETE | `/api/admin/reviews/:id` | manager+ | routes/admin-reviews.js |
| PATCH | `/api/admin/reviews/:id` | manager+ | routes/admin-reviews.js |
| GET | `/api/admin/seo` | manager+ | routes/admin-seo.js |
| GET | `/api/admin/seo/:id` | manager+ | routes/admin-seo.js |
| PATCH | `/api/admin/seo/:id` | manager+ | routes/admin-seo.js |
| POST | `/api/admin/seo/:id/preview` | manager+ | routes/admin-seo.js |
| GET | `/api/admin/settings` | owner | routes/admin-settings.js |
| PATCH | `/api/admin/settings` | owner | routes/admin-settings.js |
| GET | `/api/admin/stats` | manager+ | routes/admin-stats.js |
| GET | `/api/admin/users` | owner | routes/admin-users.js |
| POST | `/api/admin/users` | owner | routes/admin-users.js |
| PATCH | `/api/admin/users/:id` | owner | routes/admin-users.js |
| POST | `/api/admin/users/:id/password` | owner | routes/admin-users.js |
| GET | `/api/campaigns/active` | public | routes/campaigns.js |
| GET | `/api/categories` | public | routes/categories.js |
| POST | `/api/events` | public | routes/events.js |
| GET | `/api/flowers` | public | routes/flowers.js |
| POST | `/api/orders` | public | routes/orders.js |
| GET | `/api/orders/:token` | public | routes/orders.js |
| POST | `/api/orders/:token/retry-zalopay-payment` | public | routes/orders.js |
| POST | `/api/orders/:token/verify-payment` | public | routes/orders.js |
| GET | `/api/orders/deadline` | public | routes/orders.js |
| POST | `/api/orders/ipn` | public | routes/orders.js |
| POST | `/api/orders/quote` | public | routes/orders.js |
| GET | `/api/orders/upcoming-cutoffs` | public | routes/orders.js |
| GET | `/api/products` | public | routes/products.js |
| GET | `/api/products/:id` | public | routes/products.js |
| GET | `/api/products/:id/reviews` | public | routes/reviews.js |
| POST | `/api/products/:id/reviews` | public | routes/reviews.js |
| GET | `/api/products/status` | public | routes/products.js |
| GET | `/api/reviews/latest` | public | routes/reviews.js |
| GET | `/api/settings` | public | routes/settings.js |
| GET | `/api/settings/wards` | public | routes/settings.js |
| GET | `/api/tags` | public | routes/tags.js |

### Pages (customer, server-rendered) and tokens
`index`, `products`, `product`, `cart`, `checkout`, `order-confirmation`, `custom-bouquet`, `about`, `story`, `commitment`, `terms`, `privacy`, `landing` (alias), `blog` (+ posts). Tokens in use: `zalo_url`, `vat_rate`, `contact_phone_display`, `contact_phone`, `contact_email`, `tel_url`, `maps_url`, `shop_address`, `site_base`, `min_fee`, `max_fee`, `footer_categories`, `campaign_*` (name, headline, subheadline, coupon, coupon_code, hero_image, card), `product_*` (title, description, canonical, robots, og_images), `post_*`/`blog_*`.

### Admin pages (13 + login)
`admin-pos` (employee+), `admin-products`, `admin-seo`, `admin-campaigns`, `admin-flowers`, `admin-orders`, `admin-coupons`, `admin-reviews`, `admin-stats`, `admin-cutoffs` (manager+), `admin-settings`, `admin-users` (owner), `admin-account` (everyone), `admin-login`. The link list and minimum roles are `ADMIN_PAGES` in `admin-nav.js`; **the server's `requireRole` is the real protection**.

---

## 6. Decisions that are LOCKED (do not reopen without the user asking)

### 6.1 Money, shipping, coupons
- Prices are **tax-inclusive**. VAT rate in `settings.vat_rate` (10), shown as "Đã bao gồm VAT X%" and **copied onto every order**; only admin sees the VAT amount. The browser never computes money — `POST /api/orders/quote` prices everything. Stats revenue = subtotal − discount.
- Delivery fee by **ward ring** (101 wards from GHTK's list): `ring1/2/3_fee` = 25.000 / 35.000 / 45.000đ in settings. Pickup is free. GHTK is named; the **tracking code is typed by hand** in the admin order detail; an internal **admin note** is never shown to customers.
- **Coupons:** seeded `BLOOMY50` (fixed 50.000đ, minimum 800.000đ), `PHUNU20`, `THAYCO20` (percent 20, no minimum, date windows above). Code `^[A-Z0-9_-]{3,20}$`; code/type/value/minimum **locked after creation**; only `active` and the date window change; the window is checked against the **delivery date**; one coupon per order; applies to goods, not shipping; percent rounds down; never deleted.

### 6.2 Orders and stock
- `fulfillment_type` delivery (COD / ZaloPay) or pickup (cash / ZaloPay); `channel` web or pos. Bank transfer was dropped. Names and phones mandatory; email optional.
- **Stock is taken at placement** in one transaction (`UPDATE flowers SET stock = stock - n WHERE id = x AND stock >= n`, plus `CHECK (stock >= 0)`); returned only when an order still "new" is cancelled (once, from its own `order_item_flowers` snapshot). Shortage is shown **by flower name, never as a count**.
- Payment: pending / paid / failed / refunded. Fulfillment: new → delivering → delivered, or cancelled. "Delivering" needs a paid ZaloPay order; "delivered" auto-marks COD/cash as paid. Refund = paid → refunded (manager+).
- Availability: default cutoff + per-date overrides ("Giờ chốt đơn"), windows morning/afternoon/evening, `sold_out_today`, `discontinued`; web checks logged to `availability_checks`.
- Single-size products store **no size** on the order and show none anywhere.

### 6.3 Roles, admin, security
- Roles: **owner** (everything incl. Cài đặt + Nhân sự), **manager** (day-to-day incl. refunds, coupons, reviews, SEO, campaign content; not Settings or staff), **employee** (POS only). Role and `active` are read from the DB on **every** request; the session stores only the user id.
- Nhân sự (owner): create, change role, (de)activate (**never delete**), reset passwords; the last active owner can never be demoted (advisory lock, verified with a real race). `create-admin.js` stays as bootstrap.
- Limiters (per IP): login **5 failed per 15 min** (successes don't count), password change 10/15 min, placing an order + payment verify + ZaloPay retry share 20/15 min, deadline/upcoming-cutoffs 60/15 min, quote 300/15 min, funnel events 200/15 min, reviews 10/hour. `GET /api/orders/:token` has none. Sessions last 1 hour. Private windows share ONE cookie jar (use different browsers/hostnames to test roles side by side).
- **2FA (built, 3c): owner only**, TOTP (SHA-1, 6 digits, 30 s, Aegis-compatible), optional until enrolled then required, 10 hashed recovery codes, a login that never creates a session before the code is right, **no "remember this browser"** (decided: not wanted). Full behaviour and the recovery path: section 4. The key `TOTP_ENCRYPTION_KEY` must never go in chat or git and **must be backed up**: without it the stored secrets cannot be read and every enrolled owner needs `--reset-2fa`.

### 6.4 POS ("Bán tại quầy", employee+)
Staff-side pickup order for **today**, no time window, `orders.created_by`. **Cash:** created already paid + delivered. **ZaloPay:** pending/new with a QR; the page polls `GET /api/orders/:token`; `markOrderPaid` also marks a POS order delivered. Abandoned QR: employee-level cancel (only unpaid POS orders still "new"). No custom bouquets at POS. Receipt prints only the receipt. Web pickup orders waiting at the counter are listed behind the **toggle** with "Đã nhận" (unpaid ZaloPay refused); the toggle shows the count; a **10-second notice** announces a new one (list polled every 20 s while the tab is visible).

### 6.5 Custom bouquet
Price = Σ(flower price × stems) + style fee (no labour margin — accepted); **3–100 stems**, note ≤ 300 chars, no duplicate flowers; styles bo/gio/hop with fees 30.000/80.000/100.000đ in settings. Builder reads `GET /api/flowers` (`in_stock` yes/no, never counts). One cart line `{custom:{flowers,style,note},key,quantity}`; order write uses `order_items` (product_id NULL) + `order_item_flowers`. Linked from the homepage section, the banner above the products filter and the header's "Hoa tự chọn" link (the header has 6 links now). Picture: `public/images/custom-bouquet.webp` (path in `index.html` and `main.js` only).

### 6.6 Catalog, reviews
Categories: parents + "Hoa theo mùa" children; the API omits categories with no buyable product. Tags: kinds `flower` and `color`; **OR within a kind, AND across kinds**; listing state in the URL (`?category=&tag=&q=&sort=`). Product page tabs (Mô tả / Thành phần / Chăm sóc / Giao hàng & đổi trả / Đánh giá), gallery thumbnails only when `product_images` rows exist (`seed-gallery.sql`). **Care text:** the 6-bullet version ("khoảng 5 ngày") in `product.html` — settled. Reviews: public form (name ≤ 60, 1–5 stars, comment 10–500, honeypot), stored **not approved**; manager approves on `admin-reviews.html`; **no `aggregateRating` structured data** (sample reviews are illustrative). Homepage "Khách hàng nói gì" = 3 newest approved reviews.

### 6.7 Frontend conventions
- Classic `<script defer>` files share one global scope: **never declare the same top-level `const/let/class` in two scripts that load on the same page**. Function declarations may repeat. (The names `main.js` declares at top level are listed in section 10; `admin-pos.js` adds `knownPickupIds`, `pickupNoticeTimer`, `PICKUP_NOTICE_MS`. Run the scan in section 10 before adding a name.)
- `defer-footer` body class + `is-ready` in each page script. All server/customer text via `textContent`; `innerHTML` templates pass names through `window.Bloomy.escapeHtml`. Admin `<dialog>` pages use `showModal()`.
- **`hidden` must work:** `style.css` has a global `[hidden] { display: none !important }`. Use the attribute freely; a test pins the rule.
- **`.admin-form__hint` is absolutely positioned** and only valid inside `.admin-form__field`; use `.admin-note` for a note in the flow of a page (a test enforces this).
- **All motion is scoped to customer pages** with `body:not([data-min-role]):not(.admin-login-page)`; shared components (toast, back-to-top, skeleton, copy button) sit *before* the `==== Motion` marker in `style.css`; the site-wide reduced-motion rule zeroes every animation, and smooth scrolling / page transitions are opted into only under `prefers-reduced-motion: no-preference`.
- Static caching: customer-page CSS/JS URLs carry `?v=<hash>` (section 4), so **no Cloudflare purge is needed for them**; admin pages and images are not fingerprinted (a purge or hard reload may still be needed). Cloudflare's Browser Cache TTL makes browsers keep static files for 4 h — that, not the edge, was the stale layer.
- CSP: Cloudflare Bot Fight Mode adds one inline script and one console message per page; accepted, never hashed (section 4).
- The student-project notice is defined once in `main.js`; contact phone/email/Zalo come from settings (server-filled).

### 6.8 Later decisions (all agreed by the user)
- **Header = 6 links:** Trang chủ, Sản phẩm, Hoa tự chọn, Về Bloomy, Blog, Liên hệ. Story and commitment live as two cards on the About page (and in the footer).
- **Repo seeds/defaults use placeholders** (`0900000000`, `hello@bloomy.example`); real values are typed into Cài đặt after a wipe. (Git *history* still contains the old personal values — see 7.3.)
- **Campaigns are data, not settings:** one landing page per campaign; at most one on (`settings.active_campaign_id`, owner-chosen). Pictures are **chosen from files in `public/images/`, never uploaded** (option A). Hero = split layout. Managers can create/edit/delete (not the active one); the owner switches on; an empty campaign can't be switched on.
- **Gallery rows are in `seed-gallery.sql`**, loaded after `seed-products.sql` by `seed.sh`, **[verified 2026-10-10]**.
- **GA4:** no cookie banner; signals/ads off; hostname-gated; token stripped. **The optional flourishes were accepted ("all of them"); the page cross-fade (`@view-transition`) was later removed in 3c (section 4).**
- **Share:** native share sheet where available, else copy link + Facebook; **no Zalo SDK**.
- **POS notice:** a plain notification for 10 seconds (no sound/flash).
- **Keyword check:** phrase or all words = green (SEO leniency chosen by the user).

---

## 9. SCHEMA, SEEDS AND RUNTIME FACTS

Technical facts kept from the original deploy record. The CI pipeline, the plan gate and the hosting they refer to are not part of this repo.

- Schema: a fresh database ends with an empty `plan` after `apply` (what CI checks). An in-place upgrade of an old database is additive only (new tables and columns, changed defaults, no `DROP`), but it creates no campaigns, no coupons and no status changes: seeds are not re-run on a live database. **Enum values are only ever added, never removed or reordered:** `plan` cannot see a removal or a reorder, so neither the plan review nor the deploy gate would catch it.
- Seeds, in this order, for empty databases only: expected counts afterwards are products 51, campaigns 2, campaign_products 12, coupons 3 **[verified 2026-10-07 on the local database]**. They reach the server inside the schema image: after a wipe and a schema `apply`, run `/seed.sh` from that image (the command is in the header of `seed.sh`). A second run refuses with "this database already has data… Nothing changed.".
- `TOTP_ENCRYPTION_KEY` (32 random bytes, base64) is required: the app exits 1 without it. Keep a backup of the key; never put it in chat or git. `BLOOMY_CONTENT_DIR` and `BLOOMY_IMAGES_DIR` are for tests only. `ZALOPAY_ENDPOINT` is required too (the sandbox address, deliberately). `BLOOMY_BASE_URL` and `ZALOPAY_ENDPOINT` are checked at start (exit 1, the variable's name and the reason only): each must be a bare https origin, no path, no trailing slash, no query or user name (http is accepted only for localhost, for development and the CI smoke test). `BLOOMY_BASE_URL` must be the real https address: it feeds canonical URLs, Open Graph tags and the sitemap, and a trailing slash would make the ZaloPay callback `//api/orders/ipn`, a 404.
- **What the app does at start, at stop and on every response [verified in `server.js` and `routes/` 2026-10-10]:** every response carries `X-Bloomy-Build`, the image tag (`BLOOMY_BUILD`, set from the CI build argument; `dev` outside CI). At start it logs `Bloomy: ZaloPay endpoint host: <host>` and, when a stored 2FA secret cannot be decrypted with the key, `Bloomy: ERROR: TOTP_ENCRYPTION_KEY cannot decrypt…` (section 4, owner 2FA). A missing variable or a bad URL exits 1 and prints names and reasons only, never values. On SIGTERM (`docker stop`, a compose swap) it stops taking connections, lets open requests finish, closes the database pool and exits 0 (`Bloomy: shut down cleanly`); if requests are still open after 8 s it exits 1. ZaloPay calls time out after 6 s. With no `settings` row the settings and flowers endpoints answer 503 `settings_missing` (`POST /api/orders/quote` still answers 500: known, unfixed); an impossible delivery date answers 400, not 500.
- **Deploy pipeline facts (pgschema 1.13.1) [verified locally unless tagged]:** `plan --output-json` has `groups[].steps[]{sql,type,operation,path,directive?}`; one group is one transaction; no changes is `"groups": null`; `apply --plan` refuses a stale plan (fingerprint mismatch, exit 1); a role that cannot see the tables yields a WRONG plan, so plan as the owner. Invisible to `plan`: removing or reordering an enum value, column order, equivalent CHECK rewrites, so enum values are only ever added. Almost all DDL takes ACCESS EXCLUSIVE briefly and queues readers and writers of that table behind a waiting DDL for up to the lock timeout per attempt; other tables are unaffected. `--lock-timeout` is not applied to `CREATE INDEX CONCURRENTLY`; a new index plans as that statement plus a `pgschema:wait` group (verified 2026-10-10). A trailing slash in `BLOOMY_BASE_URL` gives a callback that returns 404. `docker stop` exits 0 now (it was 143).
- Where a failed deploy stops decides what is left: before the swap the old container keeps serving; after it the site stays down until the rollback finishes. After a schema change a rollback is the image only; you fix forward.

### Pipeline decisions (2026-10-10)

- **The schema apply is confirmed by a human and never rolled back: fix forward.** The previous app must therefore run on the new schema; the gate checks that.
- **The gate is a default-deny allow-list over the plan JSON**, not "grep for DROP": the exit code carries no signal, multi-group plans leave partial state, and an enum removal is invisible to `plan`.
- **The embedded PostgreSQL is baked into the schema image.** No second database and no internet at deploy time; CI plans on a network with no route out to prove it.
- **Seeds ride in the schema image, not the app image.** The app image is code only; database content travels with the database tools.
- **ZaloPay is sandbox for good**, so `ZALOPAY_ENDPOINT` is explicit and required.
- **Lock timeout 2 s** (`--lock-timeout`); an outage of up to about 10 s at the swap is accepted; no deploy window.
- **The https rule is host-based** (https, except http for localhost), not tied to `NODE_ENV`: the image forces `NODE_ENV=production` and CI uses `http://localhost:3000`.
- **The TOTP startup check logs and never exits**: a wrong 2FA key must not take the storefront down. ZaloPay calls time out at 6 s; a SIGTERM handler finishes open requests (8 s ceiling).
- **Never built, undecided:** an `[allow-drop]` marker in CI; an upgrade test (one write suite versus all 15).

---
## 10. TESTS AND ACCEPTANCE CRITERIA

All suites live in `tests/` (jsdom is the only dependency: `cd tests && npm install`), are run **from the repo root** with the server already running, and talk to the **same database** as the server. `analytics_test` needs no database; every other suite needs the three exports `DB_HOST DB_PORT DB_PASSWORD` (every suite except `analytics_test` and `ui_polish_test` also refuses to run — exit 2 — if its database differs from the server's: the settings rows must match; `ui_polish_test` needs the same database but does not check). **Local or test databases only, never production.** Since 3c the server needs `TOTP_ENCRYPTION_KEY`: export it in the same shell (suites that start their own server pass the environment through), and `twofa_test` needs the **same value as the server's**. Suites that write data restore it in a `finally` block, and several remove leftover `zz.test.*` staff accounts at the start; a killed run can leave rows behind (clean: `delete from admin_users where username like 'zz.test.%'`).

| Suite | Checks | What it covers | Own server (port) |
|---|---|---|---|
| `render_test.mjs` | 445 | renderer, partials, tokens, every customer page incl. blog; unusual settings; start-up checks | 39701, 39702 |
| `order_flow_test.mjs` | 38 | place/quote/cancel orders end to end | — |
| `checkout_live_test.mjs` | 40 | live checkout page (events, +/−, price wait) | — |
| `campaign_test.mjs` | 57 | campaign API, coupon liveness, owner dropdown | — |
| `landing_test.mjs` | 50 | landing page content/escaping/redirects/sitemap, split hero, homepage card | 39703 |
| `landing_live_test.mjs` | 29 | landing page in jsdom: cards, coupon, one-page order | — |
| `blog_test.mjs` | 85 | blog index/posts, product cards, broken-content refusal | 39704–39706 |
| `seo_test.mjs` | 107 | `seo.js` rules, panel API, escaping with hostile strings, keyword matching | 39707 |
| `seo_live_test.mjs` | 35 | `admin-seo.html` in jsdom | — |
| `analytics_test.mjs` | 49 | CSP exactness, Referrer-Policy, which pages load `main.js`, loader per hostname, token cleaning, privacy page | — |
| `ui_polish_test.mjs` | 75 | CSS rules (scoping, `[hidden]`, hint class, filter bar), badge/add pops, admin Menu per role, POS toggle | — |
| `campaign_editor_test.mjs` | 107 | editor API (roles, picture whitelist, validation, order), activation guard, the editor page | 39708 |
| `qol2_test.mjs` | 110 | share, toast, back-to-top, recently viewed, skeletons, copy coupon, reading bar, POS notice/shortcut, last admin page, CSS | — |
| `totp_test.mjs` | 41 | TOTP/HOTP against the RFC 6238 and RFC 4226 published vectors, encryption round trip, key checks, recovery codes | — |
| `twofa_test.mjs` | 116 | 2FA end to end against the running server and its database: enrol, login with and without code, lockout, one-time codes, recovery codes, disable, limiter | — |
| **Total (2026-10-10, 15 suites, one full run)** | **1384** | all suites passed with 0 failed; run by Claude on a database built from `schema.sql` and the seeds | |
| **Total (2026-11-05, Node 26.13.0, 15 suites, one full run)** | **1384** | all suites passed with 0 failed on Node 26.13.0; run by Claude with the local checks script (CI dry run passed too) | |

**Test edits made in the 3c session (so they are not mistaken for regressions):** five suites match `.css` requests with `/\.css(\?|$)/` (URLs now carry `?v=`); `landing_test`, `render_test` and `analytics_test` strip `?v=` before comparing script sources; `qol2_test`'s page-transition check now asserts the cross-fade is **gone** (`@view-transition` and `view-transition-name` absent); `render_test` §3b checks the fingerprints (hash = first 8 hex of the file's sha1, changes when the file changes, left alone for a missing file, not applied to root-relative or already-queried URLs). **Gotcha (found 2026-10-07):** `render_test` §6 copies a temp app tree to prove the server refuses to start without `partials/`; that file list must include **`totp.js`** (`server.js` now requires it) or the check "message names the missing partial" fails with "Cannot find module './totp'" — the repo copy has it and the check passes **[verified 2026-10-07]**.

The eight older suites from earlier conversations (`reg`, `pos_test`, `pub_test`, `custom_test`, `custom_ui_test`, `admin_ui_test`, `cat_test`, `ui3a_test`) and their harness files are **not in the repo and were never recreated** — roles/users API, POS and custom-bouquet logic therefore have **no currently-passing suite** in `tests/` (they were exercised by the user by hand). Writing new ones is optional.

**Definition of done for any batch:** (1) problem-first agreement (or a small obvious edit); (2) build; (3) all suites pass on a freshly rebuilt database; (4) mutation controls for new suites (section 12); (5) `node --check` on every JS file and the identifier-clash scan (below) clean; (6) a branch for H to review, with an honest list of what is unverified; (7) never claim a visual result.

**Identifier-clash scan** (run after touching any script; **[verified 2026-10-07: 27 pages, 0 clashes; the name list below matches `main.js` exactly; the scan was a short throwaway script and is not kept in the repo]**): for every page, list the `public/js/*.js` it loads and report any top-level `const|let|class` name declared in more than one of them. `main.js`'s own names: `BACK_TO_TOP_AFTER_PX CART_KEY COUPON_KEY CUSTOM_BOUQUET_IMAGE GA_HOSTS GA_MEASUREMENT_ID MAX_QUANTITY NAV_SEARCH_DEBOUNCE_MS PROJECT_NOTICE RECENT_KEY RECENT_MAX SENT_EVENTS_KEY SESSION_ID_KEY SIZE_LABELS SOURCE_KEY lastBadgeCount settingsPromise toastTimer`.

---

## 12. TESTING PRACTICE AND FINDINGS

(The notes for rebuilding the old chat sandbox were removed: suites now run against the real local Docker stack, see `CLAUDE.md`.)

**Mutation controls (how every suite was proven to bite):** copy each file to be mutated to a scratch folder as `mut_<full path with / replaced by _>.bak`; apply a one-line change with an `assert text.count(old) == 1`-style guard that **aborts the run if the change did not apply**; run the suite; check the expected `FAIL` lines; restore from the backup; **rebuild the database after every run** (a destructive mutation can delete seeded rows and poison the next run); finally `cmp` every file with its backup. **Never name backups by basename** — two files named `admin-campaigns.js` (the route and the page script) once overwrote each other's backup and the "restore" put client code over the server route; the symptom was later runs printing nothing at all.

**Quirks and findings worth keeping**
- **jsdom:** no layout engine and **no real CSS cascade** (tests stub `.css` requests), no `showModal`/`close` (polyfill on `HTMLDialogElement.prototype`), navigation is "not implemented", `window.isSecureContext` is undefined (the code treats `undefined` as "ok"), `requestAnimationFrame` exists only with `pretendToBeVisual: true`, `getComputedStyle` is unreliable for the cascade. Pages are loaded with `runScripts: "dangerously"`, a CSS-stubbing resource interceptor and a `beforeParse` hook that installs `fetch` (adds the session cookie) and, when needed, **captures `setTimeout`/`clearTimeout`** so a 5 s / 10 s timer can be inspected and fired instantly. **Wait for the page's scripts before clicking** (`until(() => w.Bloomy)`): a click before `main.js` ran silently does nothing — this caused four false failures.
- **A check that only reads the `hidden` property cannot see a CSS rule that overrides it.** Use static CSS assertions for visibility rules and say that real rendering is unverified.
- **A "wait for X" check can pass on an earlier draw.** When a click triggers a reload, wait for the reload (count the requests) before marking or measuring the DOM.
- A page script's rejected promise after the test ends crashes Node: tests install `process.on("unhandledRejection")` and count it as a failure; wait for in-flight page requests before killing a test's own server.
- pgschema: `plan` and `apply` start an embedded PostgreSQL to check `schema.sql` against; `Dockerfile.schema` now fetches it once, at image build (Maven Central, checksum-verified), so a deploy-time `plan` needs no internet. When the `FROM pgplex/pgschema` tag is bumped, change the embedded version and checksum with it. `plan --output-json` has one entry per transaction; its exit code is 0 with or without changes (no-changes case re-checked 2026-10-10: `"groups": null`), so a gate must read the JSON. A new CHECK on a table with violating rows fails at VALIDATE and leaves the database half-applied; new NOT NULL columns need DEFAULTs. A column rename plans as DROP + ADD.
- ZaloPay and Google are unreachable: tests cover `zalopay_error` and signed IPNs (HMAC-SHA256 with `ZALOPAY_KEY2`, sandbox value `b`); GA is covered by headers + loader behaviour only.
- Any local server needs `TOTP_ENCRYPTION_KEY` (32 bytes, base64); for `twofa_test` export the same value to the suite.
- Rate limits: a whole-suite run uses much of the order limiter (20 per 15 min) — two full runs per 15 minutes at most.
- Findings worth remembering: equal-specificity CSS rules are decided by source order (the menu bug); `.btn` etc. set `display`, so `hidden` needs the global rule; `[id] { scroll-margin-top }` already exists (don't add `scroll-padding`); `scrollTo({behavior:"smooth"})` ignores the CSS reduced-motion rule (decide in JS); an element at `opacity: 0` is not counted as painted (LCP) — start animations at ≥ 0.4; a folder named `x.webp` passes an extension check — list files only; the GA ID/hostname gate keeps local runs out of the real property.

---

## 13. APPENDIX

### 13.1 Constants (single sources)
Custom bouquet limits/styles/name: `pricing.js`. Review limits: `routes/reviews.js` (+ DB CHECKs). Featured cap 4: `routes/admin-products.js` (`FEATURED_LIMIT`). Coupon code pattern: `routes/admin-coupons.js` (+ CHECK). Username/password rules and 2FA limits (5-minute lockout after 3 wrong codes, 10 recovery codes): `routes/admin-auth.js` / `totp.js`. Tag group labels: `routes/tags.js`. Role ranks + landing pages: `routes/admin-auth.js`. Admin nav list: `public/js/admin-nav.js` (`ADMIN_PAGES`). Settings fields/validators: `routes/admin-settings.js`. SEO field limits (60/70/200) and rules: `seo.js`. Campaign limits (name 80, headline 120, subheadline 200, 12 products): `routes/admin-campaigns.js` (`LIMITS`) + DB CHECKs. GA ID + allowed hostname: `public/js/main.js` (`GA_MEASUREMENT_ID`, `GA_HOSTS`); Google CSP hosts: `server.js` (`GA_SCRIPT`, `GA_IMG`, `GA_CONNECT`). Recently viewed key/size: `main.js`. Toast/back-to-top constants: `main.js`. POS poll 20 s / notice 10 s: `public/js/admin-pos.js`. Seeded settings: address `27 Nguyễn Huệ, phường Sài Gòn, TP.HCM`, VAT 10, fees 25.000/35.000/45.000, style fees 30.000/80.000/100.000, **phone `0900000000`, email `hello@bloomy.example` (placeholders)**. Site URL `https://bloomy.quaintshomelabdomain.uk`; GA4 `G-SJ1XV11XC2`.

### 13.2 Useful SQL
```sql
-- who can log in
select username, role, active from admin_users order by id;
-- which campaign is on
select s.active_campaign_id, c.name from settings s left join campaigns c on c.id = s.active_campaign_id;
-- put the seed's product statuses back (existing DBs)
UPDATE products SET status='available' WHERE status<>'available';
UPDATE products SET status='discontinued' WHERE id IN (4,14,19,38,45);
UPDATE products SET status='sold_out_today' WHERE id IN (2,13,20,23,29,30,34,35,42,50);
-- leftover test accounts
delete from admin_users where username like 'zz.test.%';
-- everything waiting for review approval
select r.id, p.name, r.name, r.stars, left(r.comment, 60) from reviews r join products p on p.id = r.product_id where not r.approved;
```
Local test logins (local DB only; throwaway values, not real credentials): `tester`/`pw12345678` (owner), `bossman`/`ownerpass123` (owner), `mgrone`/`managerpass2` (manager), `empone`/`employeepass1` (employee). Never create these in production.
