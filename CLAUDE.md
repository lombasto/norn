# Working on Norn

Norn runs on itself: this repo is the Norn project `norn`. A lane's worker reads this file, and so does anyone editing Norn by hand.

## No compatibility shims

When you rename or replace something, change every caller, link, test and doc to the new form and delete the old one. Never keep old or deprecated behaviour alive through:
- an alias or redirect map (an old tab id, command name, flag or env var that still "works")
- a fallback to an old format ("specs without X fall back to the stored copy", "no result file: read the old marker")
- a label that no longer matches its id (a page shown as "Runs" whose id is still `agents`)
- a deprecated option that is still accepted, or code kept "for old links"

These are tech debt. SloppaChoppa reports them as slop. If removing one really breaks something outside the repo, such as a file another machine reads, stop and ask the owner. Don't keep a shim quietly.

## Tests

The testing rules (tiers, the run budget, load reds, quarantine, waiting on a test) are in docs/TESTING.md, the one full copy. Here only what is specific to this repo:

- Tests: light (policy.tests). Run only the test files that directly cover what you changed, and no page (browser) tests: CI runs the rest on the PR and nightly.
- Run one file, or a few: `norn tests run tests/<file>.test.mjs`. It runs each on an empty META_ROOT (away from this machine's live state) through the machine's test cache: a file another run already passed on the same content is reused, one running now is waited for.
- The changed-file command is `norn tests run --changed`; `norn tests for <file>` names the test files that cover a file. In a run, Norn's scope hook refuses a direct `node --test` and sends it to `norn tests run`, and stops testing past `policy.tests.run_budget_min`.
- Never run `node --test tests/`. It starts hundreds of processes at once. The full suite (`node engine/bin/ci-suite.mjs` without `--changed`) runs only in GitHub CI; the hook refuses it in a run, even when a hand-off asks for it.
- Every temp folder comes from `mkTmp` (tests/helpers/tmp.mjs); dashboard tests use tests/helpers/dash-fixture.mjs.

## Git

- Never use `git stash`. Its list is shared by every worktree of this repo, so one worker's pop can take another worker's changes. To set work aside, commit it on your branch, or copy the files into a folder under `%TEMP%`.
- Commit on your lane branch in small conventional commits (`fix(queue): ...`). The merge step (`norn merge-land`) pushes nothing to `main`: it opens a pull request from the lane branch; the owner approves and merges it. Never merge or push `main` yourself.

## Editing

- JavaScript's `String.replace` treats `$$` and `$&` in the replacement specially, so a scripted edit can silently lose `$` signs. Use the Edit tool, or `split(a).join(b)`.
- Bash heredocs and inline `node -e` mangle backslashes in regexes. Write the script to a file, or use the Edit tool.
- Follow the code around you: dense one-line JavaScript, comments that say why, a header comment per module.

## Dashboard

- A page with views has 3 or 4 of them (`subviewPage`), switched on its title line. Don't add a fifth; fold the content into an existing one.
- At 390 px wide (phone), no page may scroll sideways. Tests check this.
- Every page has one name, used for its label, its id and its URL.
