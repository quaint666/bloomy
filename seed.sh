#!/bin/sh
# Bloomy — loads the demo catalogue and reference data into an EMPTY database, all or nothing.
#
# It ships in the schema image (Dockerfile.schema) next to schema.sql and is run by hand after a database has been
# wiped and the schema applied. Connection settings come from the standard psql variables: PGHOST, PGUSER, PGDATABASE,
# PGPASSWORD. On the compose stack (PGPASSWORD is already set on the schema service):
#   docker compose --profile tools run --rm -e PGHOST=db -e PGUSER=quaint -e PGDATABASE=bloomy --entrypoint /seed.sh schema
#
# It refuses, and changes nothing, when products or settings already hold rows: the seeds are demo data and must never
# be loaded over a live shop. The six files run in ONE transaction, so a failure leaves nothing behind. The load order
# matters (products need categories and flowers; the campaigns pick their products by SKU) and is written here only.
set -eu

if ! n=$(psql -tAq -c "SELECT (SELECT count(*) FROM products) + (SELECT count(*) FROM settings)"); then
  echo "Bloomy seed: cannot read the database. Is the schema applied, and are PGHOST, PGUSER, PGDATABASE and PGPASSWORD set? Nothing changed." >&2
  exit 1
fi
if [ "$n" != "0" ]; then
  echo "Bloomy seed: this database already has data (products or settings). Nothing changed." >&2
  exit 1
fi

cd /seeds
set --
for f in seed-categories.sql seed-flowers.sql seed-products.sql seed-gallery.sql seed-reviews.sql seed-reference.sql; do
  set -- "$@" -f "$f"
done
if ! psql -q -v ON_ERROR_STOP=1 --single-transaction "$@" > /dev/null; then
  echo "Bloomy seed: a seed file failed. The transaction was rolled back; nothing changed." >&2
  exit 1
fi

psql -tAq -c "SELECT 'products=' || (SELECT count(*) FROM products) || ' campaigns=' || (SELECT count(*) FROM campaigns) || ' campaign_products=' || (SELECT count(*) FROM campaign_products) || ' coupons=' || (SELECT count(*) FROM coupons)"
