# Testing in Norn

This is the one full copy of Norn's testing rules (owner ruling Q-32). Every other place points here: CLAUDE.md, each project's
RULES.md Testing section, the lane brief's `Tests:` line, the agent prompts and the hook's deny text. Change a rule here, not there.

The machine is shared. Several workers, merges and the dashboard run on it at once, so a test run costs every other run time.
The rules come from Kaner, Falk and Nguyen, *Testing Computer Software* (2nd ed.); "L" is a lesson number in the design notes
(state/norn/notes/test-governance/BOOK-LESSONS.md).

## The nine rules

| # | Rule | What it means for you | Source |
|---|---|---|---|
| T1 | **Tiers, not "run everything".** A test runs in the cheapest tier that can catch its bug. | In a run, only the tests of the files you changed (tier W). The full suite runs in CI or nightly, never in a lane. | L1, L4, L6; p. 143 |
| T2 | **A red ejects the lane, not the queue.** | A red in a merge batch bounces that one lane. A MERGE run tests its changed and conflicted files, not the world. | L2; p. 157 |
| T3 | **Correctness tests don't assert wall-clock time.** | Assert the work done (counts, calls, bytes). A real speed check goes to the nightly heavy tier against a measured baseline × tolerance, never a literal (ruling Q-34). | L17, L19, L38; p. 136 |
| T4 | **Load is a test condition, not an accident.** | A red under load that passes alone is a *load red*: report it, don't loop it. | L16, L18 |
| T5 | **Sometimes-reproducible failures are tracked, then ruled on.** | Load reds are counted per test. At 2 in 7 days the owner gets one question for that test (ruling Q-29). | L28, L31-L33 |
| T6 | **The tester reports, the owner decides.** | Every test alarm carries a recommended action and its alternatives. | L35, L40 |
| T7 | **Keep the battery lean.** | Prune duplicates and tests that cover nothing new, on measured evidence (coverage, mutant kill sets). | L7, L9, L11, L14 |
| T8 | **Feedback fast, report failures only.** | Tier W answers in minutes. | L25, L27 |
| T9 | **Untested is "unknown", not "pass".** | A skipped or quarantined test is a gap in the report, never a green. | L39 |

The book's "nothing to lose except computer time" (p. 142) does not hold on a shared machine; that is why T1 overrides it.

## Tiers

| Tier | What runs | Where | When |
|---|---|---|---|
| **W: worker** | The test files of the files you changed (and any test you added), one file at a time | your run, local | while building |
| **L: landing** | The quick check: syntax plus the changed test files. A MERGE run: the changed and conflicted files' tests plus smoke (ruling Q-26) | the tick (code) or the MERGE run | each deliverable |
| **P: PR check** | slop, smoke, `node engine/bin/ci-suite.mjs --changed` (.github/workflows/pr.yml) | GitHub runner | each PR |
| **B: batch / main** | The full suite (.github/workflows/ci.yml) | GitHub runner, never local for norn | on main and nightly |
| **H: heavy** | Timing and speed checks, 390 px browser walks, load tests (.github/workflows/nightly.yml) | alone on the runner | nightly |

## The run budget (ruling Q-28)

- **A full suite is denied.** The PreToolUse scope hook refuses a full-suite command in every worker, MERGE, resumed and check-in
  run, even when a hand-off asks for "one full suite". Policy: `tests.budget.full_suite` (deny). The full suite is
  `node engine/bin/ci-suite.mjs` without `--changed`, `node --test tests/`, bare `pytest` or `pytest tests`, `npm test`.
- **Test time is budgeted.** Past 25 % of the run's wall time in tests, the run is warned. Past 50 %, after an urgent mail, it is
  stopped as a hand-off. (The share check is TEST-GOVERNANCE stage S3; until it lands, keep to the share by hand.)

## Load reds and reruns

- A browser, timing or load-sensitive test that fails: rerun that one file **once, alone**.
  - It passes alone: it is a load red. Report it as such (test id, machine load if known) and move on.
  - It fails alone: it is a real red. Fix it or report it.
- Never loop a test, never a third run of the same red in one run, never a longer timeout to get it green.

## Flaky tests and quarantine (ruling Q-29)

- After 2 load reds of one test in 7 days, the owner gets ONE Inbox question for that test: quarantine it for 14 days, open a fix
  lane, rerun it when the machine is idle, or ignore. (The ledger and the question are stage S5.)
- The quarantine list is tests/KNOWN-REDS.txt, one line per tolerated red, with its owner and why. A quarantine line also names
  its ruling and its expiry; past the expiry it no longer tolerates the red. The list only shrinks: a fixed red is removed in the
  fixing commit.

## Waiting on a test

Wait on the command's exit, with a timeout. Never poll its log with `tail -f`, an `until grep` loop or `Get-Content -Wait`: such a
watcher never exits and outlives your run. If you need one, bound it (`timeout N`, `grep -m1`, a counted loop).

## Commands

| Need | Command |
|---|---|
| The test files that cover a source file (node; from the last measure's coverage) | `norn tests for engine/lib/testcmd.mjs` |
| One node test file, kept off the live state | `META_ROOT="$TEMP/emptyroot-<name>" node --test tests/<file>.test.mjs` |
| The tests of the files your branch changed (node) | `node engine/bin/ci-suite.mjs --changed origin/main` |
| One pytest file | `python -m pytest tests/test_<module>.py -q -p no:cacheprovider` |
| The measured battery: never-failing, duplicate and slowest tests | `norn tests lean` |

Project-specific details (the interpreter, META_ROOT, the temp-folder helpers) live in the project's CLAUDE.md or RULES.md, which
point back here.
