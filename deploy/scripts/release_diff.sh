#!/usr/bin/env bash
# What a Bloomy release changes for the deploy: did schema.sql change, and which environment variables the app
# requires at start were added or removed. Reads git only; changes nothing. From the repository root:
#   deploy/scripts/release_diff.sh <old-ref> <new-ref>      e.g. b6fac4975a2b 9e74db33d52d
# It reads the names from REQUIRED_ENV in server.ts (both the array and the EMAIL_MODE=send additions); a revision from before
# the TypeScript move has it in server.js, which is read instead. Names only, never values.
# It does not see optional variables or anything outside that list: read `git diff <old> <new> -- server.ts` for those.
# The block is read from the line `const REQUIRED_ENV = [` to the first line that is exactly `}` (the end of the
# `if (process.env.EMAIL_MODE === "send") { ... }` that follows the array), so keep that layout; tests/release_diff_test.mjs
# fails if the real server.ts stops matching.
# Output other tools rely on (the staging deploy workflow reads them): the two lines "required env added:   <names or none>"
# and "required env removed: <names or none>" (three spaces after "added:"); exit 0 when both revisions could be read.
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: $0 <old-ref> <new-ref>" >&2; exit 2; }
old=$1
new=$2

required_env() {
  { git show "$1:server.ts" 2>/dev/null || git show "$1:server.js"; } | sed -n '/^const REQUIRED_ENV = \[/,/^}$/p' | { grep -oE '"[A-Z][A-Z0-9_]+"' || true; } | tr -d '"' | sort -u
}

# (a revision that has no readable block must reach the message below, not stop silently inside the command substitution)
old_names=$(required_env "$old")
new_names=$(required_env "$new")
[ -n "$old_names" ] && [ -n "$new_names" ] || { echo "release_diff: could not read REQUIRED_ENV from server.ts (or server.js) at $old or $new" >&2; exit 1; }

if git diff --quiet "$old" "$new" -- schema.sql; then
  echo "schema.sql: unchanged"
else
  echo "schema.sql: CHANGED ($(git diff --shortstat "$old" "$new" -- schema.sql | sed 's/^ *//'))"
fi

added=$(comm -13 <(echo "$old_names") <(echo "$new_names") | paste -sd' ' -)
removed=$(comm -23 <(echo "$old_names") <(echo "$new_names") | paste -sd' ' -)
echo "required env added:   ${added:-none}"
echo "required env removed: ${removed:-none}"
