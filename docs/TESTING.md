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
| **W: worker** | The light set (policy.tests): the test files that directly cover what you changed, through `norn tests run`; no browser tests | your run, local | while building |
| **L: landing** | The quick check: syntax plus the changed test files. A MERGE run: the changed and conflicted files' tests plus smoke (ruling Q-26) | the tick (code) or the MERGE run | each deliverable |
| **P: PR check** | slop, smoke, `node engine/bin/ci-suite.mjs --changed` (.github/workflows/pr.yml) | GitHub runner | each PR |
| **B: batch / main** | The full suite (.github/workflows/ci.yml) | GitHub runner, never local for norn | on main and nightly |
| **H: heavy** | Timing and speed checks, 390 px browser walks, load tests (.github/workflows/nightly.yml) | alone on the runner | nightly |

The owner makes the PR check's `slop` job a required status (Settings > Rules > Rulesets: "Require status checks to pass", check
`slop`); only that repository setting lets it hold a merge. engine/lib/slop/rules/README.md ("On a pull request") has the details.

## The run budget: policy.tests (ruling Q-28, test-diet S1)

One policy, `policy.tests`, sets what a claude run (worker, MERGE, check-in, resumed) may test. It shows in Settings (agents /
rounds); the scope hook enforces it at each test command and the run-end Done check follows it. Briefs say "Tests: light
(policy.tests)" instead of naming page tests. The Tests tab's **Run time** view shows each run's test time against its wall time.

| Setting | Default | What it does |
|---|---|---|
| `mode` | `light` | `light`: only the test files that directly cover what you changed (your changed test files, then per changed module its own test, else one named after it, else one that imports it). `changed`: every test file touching the change (ci-suite's pick). `off`: no tests in a run; CI runs them. |
| `run_budget_min` | 3 | The test wall time a run may spend, from its own transcript. Past it the hook refuses the next test command: stop testing and finish. The Done check stays inside it too: what it could not start is left to CI (unknown, not a pass, not red). 0 = no budget. |
| `browser` | `ci` | Browser (page) tests never run in a run: `norn tests run` skips them, a direct `node --test` of such a file is refused. CI runs them. `allow` lets a run start them. |
| `full_suite` | `deny` | The hook refuses a full suite in every run, even when a hand-off asks for "one full suite". The full suite is `node engine/bin/ci-suite.mjs` without `--changed`, `node --test tests/`, bare `pytest` or `pytest tests`, `npm test`. |

- **Node tests in a run go through `norn tests run`.** It runs each file on an empty META_ROOT through the machine's test-result
  cache: a file another run already passed on the same content (the file, everything it imports, the node version) in the last
  day is reused, and one running now in another run is waited for, never started twice. A direct `node --test` or
  `ci-suite --changed` is refused with the `norn tests run` command to use.
- This replaces TEST-GOVERNANCE S3's share budget (25 % warn / 50 % stop of the run's wall time, budgets.jsonl).

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
| One node test file (or a few), kept off the live state, through the machine's test cache | `norn tests run tests/<file>.test.mjs` |
| The tests that directly cover the files your branch changed (node; policy.tests.mode picks them) | `norn tests run --changed` |
| One pytest file | `python -m pytest tests/test_<module>.py -q -p no:cacheprovider` |
| The measured battery: never-failing, duplicate and slowest tests | `norn tests lean` |

Project-specific details (the interpreter, META_ROOT, the temp-folder helpers) live in the project's CLAUDE.md or RULES.md, which
point back here.
