# Bloomy
Flower shop (UEH course project): Node 26, Express 5, TypeScript 7 (the server, and the browser scripts in `web/`), PostgreSQL 18, plain HTML/CSS and classic `<script defer>` files (each one bundled from a `web/*.ts` into `public/js/`). UI text is Vietnamese; code and chat are English.

## Local setup
```bash
docker network create bloomy-local
docker run -d --name bloomy-local-pg --network bloomy-local -p 127.0.0.1:5433:5432 -e POSTGRES_USER=quaint -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=bloomy postgres:18
for i in $(seq 1 60); do docker exec bloomy-local-pg pg_isready -h 127.0.0.1 -U quaint -d bloomy && break; sleep 1; done
docker build -f Dockerfile.schema -t bloomy-schema:local .
docker run --rm --network bloomy-local -e PGPASSWORD=dev bloomy-schema:local apply --auto-approve --file /schema.sql --host bloomy-local-pg --db bloomy --user quaint --schema public
docker run --rm --network bloomy-local -e PGHOST=bloomy-local-pg -e PGUSER=quaint -e PGDATABASE=bloomy -e PGPASSWORD=dev --entrypoint /seed.sh bloomy-schema:local
export DB_HOST=127.0.0.1 DB_PORT=5433 DB_USER=quaint DB_NAME=bloomy DB_PASSWORD=dev SESSION_SECRET=local-dev-only BLOOMY_BASE_URL=http://localhost:3000 ZALOPAY_APP_ID=1 ZALOPAY_KEY1=dummy ZALOPAY_KEY2=dummy ZALOPAY_ENDPOINT=https://sb-openapi.zalopay.vn EMAIL_MODE=log RESEND_API_KEY= NODE_ENV=development PORT=3000 BASE=http://localhost:3000
export TOTP_ENCRYPTION_KEY="$(openssl rand -base64 32)"
npm ci && (cd tests && npm ci)    # app deps, then jsdom for the suites
npm run build    # compile the server .ts to .js next to it and bundle web/*.ts into public/js; again after every server or web edit
node server.js &    # check: curl -sf localhost:3000/healthz
node tests/<name>_test.mjs    # from the repo root
```

## Rules and gotchas
- Every `tests/*_test.mjs` must end with `0 failed` (15 suites, 1,384 checks, all green on 2026-10-10, on Node 26.13.1 on 2026-11-13 and on PostgreSQL 18.6 on 2026-11-11); run them locally before a push.
- `TOTP_ENCRYPTION_KEY` is required (the server exits 1 without it) and `twofa_test` needs the same value as the running server; never use the production key.
- The order endpoints share a 20-per-15-minutes limiter: run the whole set at most twice per 15 minutes.
- Suites write real rows and restore them: local DB only, never production, never against a server with `EMAIL_MODE=send`.
- `schema.sql` is the only schema source (pgschema): after editing it rebuild the image (the `docker build` step above), `apply`, then `plan` until it says "No changes detected."; never hand-ALTER.
- Strict CSP: no inline scripts or styles, no hotlinked images; customer text goes through `textContent` or `window.Bloomy.escapeHtml`.
- One source per value (settings table, a module, a constant); never repeat a hardcoded value.
- Each page script is its own bundle with its own scope, so top-level names cannot clash; a value two scripts need goes in `web/lib/` (or `shared/`), or on `window` on purpose.
- The browser never computes money: `POST /api/orders/quote` prices everything; prices are tax-inclusive.
- Campaign pictures are chosen from files in `public/images/`; the app never writes to disk.
- Server code is TypeScript: edit the `.ts`, never the emitted `.js` (gitignored); run `npm run build` before `node server.js` or the suites; `npm run typecheck` only checks types. A new root-level `.ts` file needs its compiled `.js` added to the `COPY` line in the Dockerfile's final stage (`types.ts` is exempt).
- Browser TypeScript is in `web/`: edit `web/*.ts`, never the bundle in `public/js/` (build output, gitignored; `.gitignore` lists each one). Types the server and the browser both read live in `shared/`, written for the JSON on the wire (`Wire<>` turns a `Date` into a string) and imported with `import type`. `shared/` also holds the few runtime values both sides use (`rules.ts`: `MAX_QUANTITY`, `ROLE_RANK`, the order-status transitions, the window text and end times, the default cutoff hour; `vn-time.ts`; `escape.ts`): the server compiles them and the final Dockerfile stage copies `/out/shared`; esbuild bundles them into each page script that imports them. Change a value there, not in a copy. `npm run typecheck` covers `web/` too. Each bundle is wrapped in its own scope, so a function a suite calls by name on the page's `window` (like `afterLoginTarget`) is assigned to `window` explicitly in its page script, with a `declare global` for the type (`afterLoginTarget`, `updateCartBadge`, `showPaymentWaiting`, `pollPickups`, `readingProgress`; `pollTimer` is a live getter, because a suite reaches it with `eval`). Helpers shared by the pages are in `web/lib/`; `main.ts` is the one shared script and exposes `window.Bloomy`, typed as `BloomyApi`.
- jsdom cannot see CSS or layout: say plainly that how it looks is unverified; never claim a visual result.
- One branch per task, small commits; the user reviews the diff and merges.

## Docs (open when the task touches them)
- `docs/00-HANDOFF.md`: architecture and API table (§5), locked decisions (§6), tests (§10).
