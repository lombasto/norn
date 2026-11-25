# Code signals: the contract

Per indexed file of a project: the files that change together with it, its fix history and the fix-first rank. All of it is measured
from git (no model, no guess). Lane git-signals (RM-a-60) writes it; lanes suspects, companion-files, risk-rank, rank-selfcheck,
triage-card and warn-on-edit read this doc and the one reader below, nothing else.

## The one reader

```js
import { readSignals } from '<norn>/engine/lib/codesignals.mjs';
const s = readSignals(state);   // state = the project's state folder (<state>); null = none stored yet
```

`readSignals(state)` returns the stored object (below) or `null` when none has been written yet. A file that exists but cannot be read or
parsed throws: the reader never answers with a guess. From the shell, the same data: `norn code signals <file>.. --json` and
`norn code signals --top N --json` (see "CLI").

## Where it is stored, and how fresh

- File: `<state>/code/signals.json`, beside `<state>/code/index.json` (the `norn code history` index).
- Written by `norn code history`, in the same run as the index and from the same commit. The tick starts `norn code history`
  detached when HEAD is not the index's commit, so the signals follow the index.
- Stamp: `sha` (the indexed commit, 12 hex) and `at` (ISO time of the run). A consumer that needs HEAD's answer compares `sha` with
  `git rev-parse --short=12 HEAD`; a different sha means the signals describe that older commit.
- A monorepo project indexes its own folder: every path is relative to that folder, and only changes inside it count.

## Definitions

- **Landing**: one commit of main's first-parent history (`git log --first-parent` from HEAD). A merged branch is one landing.
- **A landing's files**: its diff against its first parent (for a merge: everything the branch brought).
- **The commits a landing brought in**: the landing itself plus every commit first reachable from it, i.e. `git rev-list
  <previous landing>..<landing>`.
- **Type**: a commit subject's conventional-commit type, `type(scope)!: text` with the type one of `limits.types`; git's own
  `Revert "..."` subject is a `revert`. Anything else has no type.
- **Fix landing for a file**: a landing in the window that brought in at least one commit whose type is in `limits.fix_types`
  (`fix`, `revert`) and that changed the file, the landing also changing the file. Counted once per landing, dated at the landing.
- **Batch landing**: a landing whose files number more than `limits.batch_files`. It says nothing about which files belong together and
  is skipped for partners (still counted for fixes).

## Windows and thresholds (`SIGNAL_LIMITS` in engine/lib/codesignals.mjs, the one place; copied into every stored file as `limits`)

| key | value | meaning |
|---|---|---|
| `window_days` | 365 | landings older than this (by the landing's committer time) count for nothing |
| `batch_files` | 30 | a landing changing more files than this is a batch: skipped for partners |
| `min_shared` | 3 | a partner shares at least this many landings with the file |
| `min_share` | 0.3 | and at least this share of the file's own landings |
| `max_partners` | 8 | at most this many partners, strongest first |
| `fix_types` | `fix`, `revert` | the types that make a fix |
| `fix_short_days` | 90 | the short fix count's window (the long one is `window_days`) |
| `last_fixes` | 5 | the newest fixes kept per file |
| `types` | feat fix docs style refactor perf test build ci chore revert | the conventional types recognised |
| `typed_min_share` | 0.25 | below this share of typed commits the fix history is n/a |
| `check_days` | 90 | the rank check re-ranks as of this many days ago and counts the fixes since |
| `check_top` | 20 | the rank check scores the top this many files of each ranking |
| `check_min_history_days` | 180 | a history younger than this (its oldest commit to now): the rank check is n/a |

## The stored object

```
{
  at:      ISO time of the run,
  sha:     the indexed commit (12 hex; the same as index.json's),
  basis:   'measured',                       // every number is counted from git, nothing inferred
  window:  { days, from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' },
  limits:  SIGNAL_LIMITS,
  landings:        landings in the window,
  batches_skipped: of those, batch landings,
  fixes:   { status: 'measured', typed, commits }
         | { status: 'n/a', typed, commits, reason },
  files:   { '<path>': FileSignals, ... },   // every file of index.json (HEAD's text files, vendor/ and node_modules/ dropped)
  check:   RankCheck                         // does the ranking predict anything (below)
}
```

`fixes.commits` = the non-merge commits brought in by the window's landings; `fixes.typed` = those with a type. When
`typed / commits < typed_min_share` (or there is no commit), `status` is `'n/a'` and `reason` says why in words, e.g.
`"0 of 7 commits in 365 days carry a conventional-commit type (under 25 %)"`. Then every file's `fixes` and `fix_first` are `null`.

FileSignals:

| field | type | meaning |
|---|---|---|
| `landings` | int | the file's non-batch landings in the window |
| `partners` | array | `{ file, shared, share, landings }`: `shared` = non-batch landings changing both; `share` = `shared / this file's landings` (2 decimals); `landings` = the partner's own non-batch landings. Kept when `shared >= min_shared` and `share >= min_share`; sorted by `shared`, then `share`, then path; at most `max_partners`. `[]` = none over the thresholds |
| `fixes` | object \| null | `{ n_90d, n_365d, last }`: fix landings in the last `fix_short_days` and `window_days` days; `last` = up to `last_fixes` of them, newest first, each `{ sha (the landing, 12 hex), day (UTC), subject (the fix commit's), type }`. `null` = n/a (see the top-level `fixes.reason`) |
| `fix_first` | int 0-100 \| null | the fix-first rank (below); `null` = n/a |
| `importance` | int 0-100 | index.json's importance, copied: the Borda rank of fan-in and churn |
| `churn_90d` | int | index.json's: lines added + deleted over 90 days |
| `fan_in` | int \| null | index.json's: JS files importing it; `null` = not JS (counts as 0 in the ranks) |

## The fix-first rank

The Borda count over three criteria across every indexed file: `churn_90d`, `fan_in` (null = 0) and `fixes.n_365d`. Each criterion gives a
file the number of files below it plus half the others equal to it (ties share the mean rank); the three are summed and scaled to 0-100
(`round(100 * sum / (3 * (files - 1)))`, a single file = 100). Rank aggregation, so no invented weights: the same method as `importance`,
which stays beside it.

## The rank check (RM-a-70)

Does the ranking predict anything? Out of sample, from git alone: the check day is `check_days` before the run; main's tip on that day is
its newest first-parent landing at or before it. Both rankings are computed AS THEY WERE then: `codeIndex` and the signals at that landing,
with that day as "now" (its tree, its fan-in, its churn and fixes up to that day only). Each ranking's top `check_top` files (fix first:
ties by importance, then path, as `--top`; importance: ties by `churn_90d`, then path, as Code > Files) are scored against the fix landings
(the definition above) from the check day to now. Beside it, the baseline: the share of ALL the files of that day's tree that got one. A
file deleted or renamed since counts as not fixed unless a fix landing touched its old path.

```
RankCheck = { status: 'measured', basis: 'measured', as_of: 'YYYY-MM-DD' (the check day), days: check_days, sha: the landing ranked (12 hex),
              files: the files of its tree, fixed: of them, the ones with a fix landing since,
              fix_first:  { status: 'measured', hit, top: [{ file, rank (its fix_first then), fixed }] } | { status: 'n/a', reason },
              importance: { status: 'measured', hit, top: [{ file, rank (its importance then), fixed }] } }
          | { status: 'n/a', basis, as_of, days, reason, [sha, files, fixed] }
```

n/a, with the reason in words, when: the history is younger than `check_min_history_days` ("the history starts 2026-06-01: under 180
days"); the commits since the check day are under `typed_min_share` typed ("0 of 4 commits in the last 90 days carry ..."); the tree then
had no more than `check_top` files (the top would be every file); no file got a fix since (nothing to predict). `fix_first` alone is n/a
when the history up to the check day was untyped (its reason prefixed "90 days ago: ").

The one line (`checkLine(check, 'fix_first' | 'importance')` in engine/lib/codesignals.mjs; the dashboard and the daily report print it):
`12 of the top 20 fix-first files got a fix in the last 90 days; baseline 9 % of files`. A ranking whose top share is at or under the
baseline's says so: `...; baseline 10 % of files: at or under the baseline, the ranking predicted nothing`. n/a: `fix-first check: n/a
(<reason>)`; signals without a check: `fix-first check: not built yet (...)`. The baseline percent is rounded; the comparison is exact.

## CLI

- `norn code signals <file>.. [--json] [--project P | --state D]`: each file's fix-first rank and importance, its fix counts and last fix,
  its partners, and the stamp line (`measured from git at <sha>, ... · window ... · N landings, M batches skipped`). Paths are relative
  to the indexed folder (`\` and a leading `./` are accepted). Exit 1 when a named file is not in the index, 2 when nothing is stored.
  `--json`: `{ sha, at, basis, window, fixes, files: [{ file, ...FileSignals } | { file, missing: 'not in the index' }] }`.
- `norn code signals --top N [--json]`: the N files with the highest `fix_first` (ties: importance, then path); n/a prints the reason.
  `--json`: `{ sha, at, basis, window, fixes, files: [{ file, ...FileSignals }] }`.
- `norn code history` (re)writes the signals with the index.

## The dashboard

Code > Files has a "fix first" sort and the columns "fixes 365 d" and "fix first"; the file drawer lists "Changes together with" (the
partners) and "Last fixes". Without stored signals, or with signals of another commit than the index, they read "not built yet"; an
untyped history reads n/a with the reason. Above the table, the rank check line of both rankings (`id="code-check"`; the files part of
/api/code carries it as `checks: [{ rank, status, line }]`). The SloppaChoppa daily report has a "Rank check" section with the same two
lines and the signals' commit.
