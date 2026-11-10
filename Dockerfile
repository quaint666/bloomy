# Bloomy — production image, three stages.
#
# Stage 1 ("assets") only minifies the browser JS and CSS with esbuild; nothing from it ships except its
# output. Stage 2 ("compile") turns the server's TypeScript into JavaScript with tsc; again only its output
# ships. Stage 3 is the plain runtime image: no build tools, no dev dependencies, and bcrypt ships a musl
# prebuild, so nothing is compiled there. The HTML pages are not minified.
#
# All stages are pinned to the exact Node version already running in production.
# Bump it deliberately; don't switch to a floating tag.
FROM node:26.13.0-alpine3.24 AS assets

WORKDIR /build

# esbuild is a devDependency, pinned (with its hash) in package-lock.json. --ignore-scripts skips bcrypt's
# install step: this stage needs nothing but esbuild's own binary.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Same file names in and out (the pages, the CSP and the tests all point at them); no bundling, no source
# maps. The two checks fail the build if nothing came out, or fewer files than went in.
COPY public ./public
RUN find public -type f \( -name '*.js' -o -name '*.css' \) -print0 \
      | xargs -0 node_modules/.bin/esbuild --minify --charset=utf8 --legal-comments=none \
          --log-level=warning --outdir=/out --outbase=public \
 && [ "$(find /out -type f | wc -l)" -gt 0 ] \
 && [ "$(find /out -type f | wc -l)" -eq "$(find public -type f \( -name '*.js' -o -name '*.css' \) | wc -l)" ]

FROM node:26.13.0-alpine3.24 AS compile

WORKDIR /build

# typescript and the @types packages are devDependencies, pinned in package-lock.json. --ignore-scripts for the
# same reason as above. tsc type-checks first and fails the build on any type error; the check below fails it
# if no JavaScript came out. Output goes to /out (same layout as the source), never next to the sources.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY *.ts ./
COPY routes ./routes
RUN node_modules/.bin/tsc --outDir /out \
 && [ -f /out/server.js ] && [ -d /out/routes ]

FROM node:26.13.0-alpine3.24

# Set here (not only in compose) so a forgotten compose line can't silently
# drop the Secure flag on the session cookie again. Compose/CI can still
# override this at run time.
ENV NODE_ENV=production

WORKDIR /app

# Dependencies first: this layer is reused until package*.json changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App code, listed explicitly instead of `COPY . .` — so a secret (.env) or a
# stray file can never end up in the image, even if .dockerignore is wrong.
# A new top-level .ts file needs a line here; forgetting one fails loudly at
# startup (MODULE_NOT_FOUND), not silently. types.ts is left out on purpose: it
# holds only types, so nothing requires it at run time.
#
# Files stay root-owned, so the unprivileged app user can read but not modify
# its own code. The app never writes to disk; its only fs use is reading the
# page files, partials/ (render.ts) and content/ (the blog, blog.ts).
COPY --from=compile /out/server.js /out/db.js /out/email.js /out/pricing.js /out/render.js /out/blog.js /out/seo.js /out/totp.js /out/create-admin.js ./
COPY --from=compile /out/routes ./routes
COPY public ./public
# The minified JS and CSS from stage 1 replace the readable ones, same names, same places.
COPY --from=assets /out ./public
COPY partials ./partials
COPY content ./content

# The commit this image was built from, sent as the X-Bloomy-Build header (server.js). CI passes the same 12
# characters it tags the image with. Last on purpose: it changes on every build and must not bust the layers above.
ARG BUILD_SHA=dev
ENV BLOOMY_BUILD=$BUILD_SHA

USER node
EXPOSE 3000

# Exec form: node starts directly (no shell in between). Add `init: true` in
# compose (or `--init` on plain `docker run`) so SIGTERM actually stops it.
CMD ["node", "server.js"]
