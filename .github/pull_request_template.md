## What changed
<!-- One or two sentences, in plain words. -->

## How to check it
<!-- What should the reviewer open or run, and what should they see? -->

## Screenshots
<!-- Only if a page looks different: 1440 px and 390 px wide. jsdom cannot see layout, so say if it is unchecked. -->

## Checklist
- [ ] All suites end with `0 failed` (`node tests/<name>_test.mjs`, from the repo root)
- [ ] A new route has its row in the API table (`docs_routes_test` checks it)
- [ ] A change to `schema.sql` was applied and `plan` says "No changes detected."
- [ ] No passwords, keys or personal data are in this change
- [ ] If this changed a decision or a rule, I updated `docs/00-HANDOFF.md` or `CLAUDE.md`
