#!/bin/sh
# Bloomy — adds the second catalogue (54 products for Peekbox's six occasions, the six occasion tags and their links
# to the first 50 products) to a database that ALREADY has a shop in it. The opposite of seed.sh: that one refuses a
# database with data, this one needs the first catalogue and never overwrites anything.
#
# It ships in the schema image (Dockerfile.schema) next to seed.sh. Same connection variables (PGHOST, PGUSER,
# PGDATABASE, PGPASSWORD). On the compose stack:
#   docker compose --profile tools run --rm -e PGHOST=db -e PGUSER=quaint -e PGDATABASE=bloomy --entrypoint /seed-more.sh schema
#
# It runs ONE file, seed-products-2.sql, in one transaction. That file is idempotent: no fixed ids, everything is looked
# up by SKU or by (kind, name), and every INSERT ends in ON CONFLICT DO NOTHING. So a second run changes nothing, and a
# product the shop has since edited in admin is never touched. Run `plan` first if the schema image is newer than the
# database: the occasion tags need the 'occasion' tag kind that schema.sql adds.
set -eu

if ! n=$(psql -tAq -c "SELECT count(*) FROM products WHERE sku = 'BLM-0001'"); then
  echo "Bloomy seed-more: cannot read the database. Is the schema applied, and are PGHOST, PGUSER, PGDATABASE and PGPASSWORD set? Nothing changed." >&2
  exit 1
fi
if [ "$n" != "1" ]; then
  echo "Bloomy seed-more: the first catalogue (BLM-0001...) is not in this database. On an empty database use /seed.sh instead. Nothing changed." >&2
  exit 1
fi
if ! psql -tAq -c "SELECT 'occasion'::tag_kind" > /dev/null 2>&1; then
  echo "Bloomy seed-more: the database has no 'occasion' tag kind yet. Apply the schema first (pgschema plan, then apply). Nothing changed." >&2
  exit 1
fi

before=$(psql -tAq -c "SELECT count(*) FROM products")
if ! psql -q -v ON_ERROR_STOP=1 --single-transaction -f /seeds/seed-products-2.sql > /dev/null; then
  echo "Bloomy seed-more: the seed file failed. The transaction was rolled back; nothing changed." >&2
  exit 1
fi
after=$(psql -tAq -c "SELECT count(*) FROM products")
echo "Bloomy seed-more: products $before -> $after ($((after - before)) added; 0 means it was already there)"
