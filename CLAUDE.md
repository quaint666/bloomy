# Bloomy
Flower shop (UEH course project): Node 26, Express 5, TypeScript 7 (backend only), PostgreSQL 17, plain HTML/CSS/classic JS. UI text is Vietnamese; code and chat are English.

## Local setup
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
node tests/<name>_test.mjs    # from the repo root
```

## Rules and gotchas
- Every `tests/*_test.mjs` must end with `0 failed` (15 suites, 1,384 checks, all green on 2026-10-10 and on Node 26.13.0 on 2026-11-05); run them locally before a push.
- `TOTP_ENCRYPTION_KEY` is required (the server exits 1 without it) and `twofa_test` needs the same value as the running server; never use the production key.
- The order endpoints share a 20-per-15-minutes limiter: run the whole set at most twice per 15 minutes.
- Suites write real rows and restore them: local DB only, never production, never against a server with `EMAIL_MODE=send`.
- `schema.sql` is the only schema source (pgschema): after editing it rebuild the image (the `docker build` step above), `apply`, then `plan` until it says "No changes detected."; never hand-ALTER.
- Strict CSP: no inline scripts or styles, no hotlinked images; customer text goes through `textContent` or `window.Bloomy.escapeHtml`.
- One source per value (settings table, a module, a constant); never repeat a hardcoded value.
- Classic `<script defer>` files share one global scope: never declare the same top-level `const/let/class` in two scripts on one page.
- The browser never computes money: `POST /api/orders/quote` prices everything; prices are tax-inclusive.
- Campaign pictures are chosen from files in `public/images/`; the app never writes to disk.
- Server code is TypeScript: edit the `.ts`, never the emitted `.js` (gitignored); run `npm run build` before `node server.js` or the suites; `npm run typecheck` only checks types. A new root-level `.ts` file needs its compiled `.js` added to the `COPY` line in the Dockerfile's final stage (`types.ts` is exempt).
- jsdom cannot see CSS or layout: say plainly that how it looks is unverified; never claim a visual result.
- One branch per task, small commits; the user reviews the diff and merges.

## Docs (open when the task touches them)
- `docs/00-HANDOFF.md`: architecture and API table (§5), locked decisions (§6), tests (§10).
