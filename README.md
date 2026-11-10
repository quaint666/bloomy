# Bloomy

A flower shop web app: storefront, checkout, and a back office for staff. Node, Express 5, PostgreSQL, a TypeScript server, and a plain HTML/CSS/JS front end with no framework. The site's text is in Vietnamese. It was built for a university e-commerce course.

Live: https://bloomy.quaintshomelabdomain.uk

![Home page](docs/screenshots/home.webp)

![Product listing](docs/screenshots/products.webp)

## What it does

**Customers:** browse by category, tag and search; product pages with stock status; a custom bouquet builder; one-page checkout with delivery date and time window; occasion landing pages with coupons; reviews; a blog. Payment is cash on delivery or ZaloPay (sandbox only).

**Staff:** orders and refunds, a point-of-sale screen for counter sales, products, flower stock, coupons, campaigns, delivery cut-offs, review moderation, an SEO panel, settings, statistics. Accounts have three roles (owner, manager, employee); owners can turn on two-factor login (TOTP).

## How it is built

- **The server prices everything.** `POST /api/orders/quote` returns every amount; the browser never computes money. Prices are tax-inclusive.
- **TypeScript on the server only.** `tsc` compiles next to the sources; the browser files are plain JavaScript. Database enums and row shapes live in `types.ts`.
- **Declarative schema.** `schema.sql` is the only schema source and is applied with [pgschema](https://github.com/pgplex/pgschema); nothing is hand-altered.
- **Strict Content-Security-Policy.** No inline scripts or styles; customer text goes through `textContent` or an escape helper.
- **Pages are rendered on the server** from shared partials, with asset fingerprinting (`?v=<hash>`) and an esbuild minify stage in the Dockerfile.
- **Sessions in PostgreSQL** (`connect-pg-simple`), bcrypt passwords, rate-limited login.
- **15 test suites, 1,384 checks** against a real server and database, using jsdom for the pages.

Architecture, the API table and the locked design decisions are in [`docs/00-HANDOFF.md`](docs/00-HANDOFF.md).

## Run it locally

Needs Docker, Node 26 and `openssl`. The database runs in Docker; the app runs on the host.

```bash
docker network create bloomy-local
docker run -d --name bloomy-local-pg --network bloomy-local -p 127.0.0.1:5433:5432 -e POSTGRES_USER=quaint -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=bloomy postgres:17
for i in $(seq 1 60); do docker exec bloomy-local-pg pg_isready -h 127.0.0.1 -U quaint -d bloomy && break; sleep 1; done
docker build -f Dockerfile.schema -t bloomy-schema:local .
docker run --rm --network bloomy-local -e PGPASSWORD=dev bloomy-schema:local apply --auto-approve --file /schema.sql --host bloomy-local-pg --db bloomy --user quaint --schema public
docker run --rm --network bloomy-local -e PGHOST=bloomy-local-pg -e PGUSER=quaint -e PGDATABASE=bloomy -e PGPASSWORD=dev --entrypoint /seed.sh bloomy-schema:local
export DB_HOST=127.0.0.1 DB_PORT=5433 DB_USER=quaint DB_NAME=bloomy DB_PASSWORD=dev SESSION_SECRET=local-dev-only BLOOMY_BASE_URL=http://localhost:3000 ZALOPAY_APP_ID=1 ZALOPAY_KEY1=dummy ZALOPAY_KEY2=dummy ZALOPAY_ENDPOINT=https://sb-openapi.zalopay.vn EMAIL_MODE=log RESEND_API_KEY= NODE_ENV=development PORT=3000 BASE=http://localhost:3000
export TOTP_ENCRYPTION_KEY="$(openssl rand -base64 32)"
npm ci && (cd tests && npm ci)    # app deps, then jsdom for the suites
npm run build    # compile the .ts to .js next to it; again after every server edit
node server.js &    # check: curl -sf localhost:3000/healthz
```

Open http://localhost:3000. Create the first owner account in a real terminal with `node create-admin.js`, then sign in at `/admin-login.html`.

## Tests

With the server running and the same `TOTP_ENCRYPTION_KEY`:

```bash
node tests/render_test.mjs      # one suite; each ends with "0 failed"
```

Run them against a local database only: they write real rows and restore them. The order endpoints share a limiter of 20 requests per 15 minutes, so run the whole set at most twice in that window. jsdom cannot see CSS or layout, so how the pages look is not covered by the suites.

## Layout

```
server.ts, routes/        Express app and the API (one file per area)
pricing.ts, render.ts     quote engine; server-side page rendering
db.ts, types.ts, seo.ts, totp.ts, email.ts, blog.ts
public/                   pages, css, js, images (served as is)
partials/, content/       shared page parts; blog posts
schema.sql, seed-*.sql    the schema and the seed data
Dockerfile, Dockerfile.schema   app image; schema and seed tools
tests/                    the suites
docs/00-HANDOFF.md        architecture and decisions
```

## Notes

- Seeded contact details (`0900 000 000`, `hello@bloomy.example`) are placeholders; real values are set in the admin settings.
- ZaloPay is configured for its sandbox. No real payments are taken.
- All photos are AI-generated.

## License

[MIT](LICENSE)
