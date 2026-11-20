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

- Run one file, or a few: `META_ROOT="$TEMP/emptyroot-<name>" node --test tests/<file>.test.mjs`. Create the empty folder first. `META_ROOT` keeps the tests away from this machine's live state.
- Never run `node --test tests/`. It starts hundreds of processes at once.
- Run the full suite with `node engine/bin/ci-suite.mjs`. It is slow; run it once before a merge, not in a loop.
- Every temp folder comes from `mkTmp` (tests/helpers/tmp.mjs); dashboard tests use tests/helpers/dash-fixture.mjs.
- Under heavy load (several workers testing at once), browser and timing tests can time out. Rerun the file on its own before you call a failure real.
- Wait for a long command by waiting on its exit, not by watching its log with `tail -f | grep`. `tail -f` never exits, so the watcher outlives you. If you need a watcher, make it end by itself (`timeout N`, `grep -m1`).

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
