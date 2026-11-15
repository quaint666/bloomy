#!/usr/bin/env bash
# What a Bloomy release changes for the deploy: did schema.sql change, and which environment variables the app
# requires at start were added or removed. Reads git only; changes nothing. From the repository root:
#   deploy/scripts/release_diff.sh <old-ref> <new-ref>      e.g. b6fac4975a2b 9e74db33d52d
# It reads the names from REQUIRED_ENV in server.js (both the array and the EMAIL_MODE=send additions). Names only, never values.
# It does not see optional variables or anything outside that list: read `git diff <old> <new> -- server.js` for those.
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: $0 <old-ref> <new-ref>" >&2; exit 2; }
old=$1
new=$2

required_env() {
  git show "$1:server.js" | sed -n '/^const REQUIRED_ENV = \[/,/^}$/p' | grep -oE '"[A-Z][A-Z0-9_]+"' | tr -d '"' | sort -u
}

old_names=$(required_env "$old")
new_names=$(required_env "$new")
[ -n "$old_names" ] && [ -n "$new_names" ] || { echo "release_diff: could not read REQUIRED_ENV from server.js at $old or $new" >&2; exit 1; }

if git diff --quiet "$old" "$new" -- schema.sql; then
  echo "schema.sql: unchanged"
else
  echo "schema.sql: CHANGED ($(git diff --shortstat "$old" "$new" -- schema.sql | sed 's/^ *//'))"
fi

added=$(comm -13 <(echo "$old_names") <(echo "$new_names") | paste -sd' ' -)
removed=$(comm -23 <(echo "$old_names") <(echo "$new_names") | paste -sd' ' -)
echo "required env added:   ${added:-none}"
echo "required env removed: ${removed:-none}"
