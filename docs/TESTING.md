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
- **A test that reads a repo file it does not import declares it.** The cache key holds only the file and the modules it reaches,
  so a test that asserts on a workflow, a doc or a data file it reads with fs would be reused on a stale pass when that file
  changes (and no pick would run it). Declare such files in the test file's leading comment, before its first code line:
  `// reads: .github/workflows/*.yml, docs/TESTING.md` (repo-relative globs split on commas: `**` any directories, `*` within
  one segment, `?` one character; several lines add up). The matched files join the key, `--changed` and the PR pick run the
  test when one changes, and `norn tests for <file>` names it.
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
| The test files that cover a source file (node, pytest, cargo; from `norn tests index`), with the runner command per group | `norn tests for engine/lib/testcmd.mjs` |
| One node test file (or a few), kept off the live state, through the machine's test cache | `norn tests run tests/<file>.test.mjs` |
| The tests that directly cover the files your branch changed (policy.tests.mode picks them; node runs, pytest / cargo are named with their command) | `norn tests run --changed` |
| One pytest file | `python -m pytest tests/test_<module>.py -q -p no:cacheprovider` |
| The measured battery: never-failing, duplicate and slowest tests | `norn tests lean` |
| What trimming command logs would save on a project's recorded runs, and the output-trim gate (below, "Output replay") | `norn tests output-replay --project P` |

Project-specific details (the interpreter, META_ROOT, the temp-folder helpers) live in the project's CLAUDE.md or RULES.md, which
point back here.

## Impacted tests: pytest and cargo (RM-a-55)

`norn tests index` writes one index (`<state>/tests/cases.json`, `impact.json`) for every runner a repo has; each case and each test
row names its `runner` (`node:test`, `pytest`, `cargo`). engine/lib/testimpact.mjs finds the pytest and cargo part:

- **Discovery.** pytest: the files `test_*.py` / `*_test.py`, their module-level `test*` functions and the `test*` methods of `Test*`
  classes (nested too), id = the pytest node id (`file::Class::test_x`). cargo: every `#[test]` / `#[<path>::test]` function in a
  non-excluded .rs file, named by its module path as libtest names it (`water::tests::first`).
- **Impact.** A test covers a source file when the test's file reaches it through the code graph's import edges
  (docs/code-graph.md, its reader only); a pytest file also through the `conftest.py` files above it. A Rust `mod` edge is taken only
  down the test file's own module tree: a crate root it reaches (`lib.rs`) does not pull in every module of the crate. A Python
  package `__init__.py` reached only by its implicit `package-init` edge (a test imports `pkg.a`, so the package's `__init__.py` runs) is covered
  but is a leaf: what it re-exports is not pulled in. One a test imports itself (`from pkg import B`) is walked as usual. Each source
  lists its tests nearest first. Every test row says `basis: 'inferred'` (static imports); `measured` is kept for a coverage report,
  not built. impact.json carries the graph's commit (`graph`), or `graph: { na: why }` when the graph cannot be had.
- **Commands per group.** pytest: one `python -m pytest <node ids>` per pytest root (the folder of the nearest pytest.ini /
  pyproject.toml / tox.ini / setup.cfg). cargo: `cargo test -p <crate>` with `--test <x>` for an integration test, `--bin <x>`,
  `--lib`, or the file's module path as the filter (a filter is a substring: it can run more than the file), in the workspace folder.
- **Picks.** `norn tests run --changed` and the Done check's light set take per changed source the nearest `IMPACT_LIMITS.light_per`
  (1) covering tests, plus every changed test file; mode `changed` takes all of them. `norn tests run` runs node:test files only:
  the pytest / cargo groups are printed with their command, and the Done check runs them as commands in their folder.
- Thresholds (testimpact.mjs `IMPACT_LIMITS`): `light_per` = 1.
- Known limits: a test that drives code through a subprocess or reads files at run time has no import edge, so it is not inferred;
  the `native` edge to a Rust extension and `__init__.py` files a test imports make the full sets large.
- Measured (a replay of the last 30 merged branches of a mono-repo, 24 of them changing sources and tests, 795 edited test files of
  1579): the full set holds 746 of the edited tests (94 %), the light set 120 (15 %); full set size p50 / p90 / max 509 / 1172 / 1269
  (before the `package-init` leaf rule: 829 / 1238 / 1432, the same 746 hits). `light_per` 2 or 3 for pytest raised the light hits to
  19 % / 22 % but the light set's median from 6 to 11 / 13, so it stays 1.

## Output replay (output-trim S1)

`norn tests output-replay [--project P | --state D] [--since YYYY-MM-DD] [--json]` measures what trimming command logs before the
agent reads them WOULD have saved on a project's recorded runs, and says whether that crosses the gate that releases building the
trim (stages S2-S5 of the output-trim plan). It only measures: it reads the run logs and transcripts, changes no hook and calls no
model. Code: `engine/lib/outreplay.mjs`. It writes `<state>/trim/replay.json` (the printed numbers, as JSON).

### What it reads

- **Claude runs.** Each run's final JSON, `<state>/logs/<lane>-<YYYYMMDD>-<HHMMSS>-<id>.json`, gives the `session_id`, the usage and
  `total_cost_usd`. The tool output is in the session transcript, `<claude projects>/<slug>/<session_id>.jsonl` (the projects folder:
  `CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`). Every Bash / PowerShell call and its result is read.
- **Codex runs.** A `.log` with no `.json` beside it whose banner reads `OpenAI Codex v...` is a `codex exec` log; its `exec` blocks
  and their results are paired in order, and the shell wrapper Codex logs (`powershell.exe -Command '...'`, `bash -lc '...'`) is
  removed before the family is matched. A Codex log has no per-call token use and no cost, so Codex calls appear in the family table
  only, never in the saving or the gate.
- Check-in runs (`checkin-*`) are not worker runs and are left out. A run whose final JSON is unreadable, names no `session_id` or
  whose transcript is missing is listed as `n/a` with the reason, and its usage is not counted.

### What it prints

1. Per harness and command family (pytest, cargo, maturin, install, git, other): results, how many the agent already cut itself
   (piped to `tail` / `grep` / ..., `-q`, or sent to a log file), characters, and p50 / p90 / max characters per result.
2. The saving per option, as cache-read tokens saved, their share of the runs' cache reads, dollars and their share of spend:
   - `strict`: the filters' listed noise lines dropped (every line that names a failure, error or warning is kept: `KEEP`);
   - `collapse`: strict plus repeated git CRLF warnings kept once;
   - `crlf_all`: the CRLF collapse on every shell result;
   - `ceiling`: test / build / install output cut to its KEEP lines plus 400 characters (no real filter does better);
   - `ceiling_git`: the same over every named family, git diff / show / log included (not acceptable: that is content);
   - `excluded_strict`, `excluded_ceiling`: the strict and ceiling cuts on the calls the wrap would skip (not reachable);
   - `all_shell`: all shell output, for scale.
3. The saving range (strict to ceiling), the re-run signal, and the gate verdict.

Only calls the wrap would take count in strict / collapse / crlf_all / ceiling / ceiling_git (DEC-a-582): a call of a filtered family
(git: fetch / pull / push / clone only) whose output the agent left whole. Piped, redirected, quiet, heredoc and background calls are
counted by reason (`skipped`) and their cuts reported in the `excluded_*` rows.

### How a saving is counted

Tokens are characters / 4: an **estimate**, good to about +-25 %, with no tokenizer. A cut token saves one 1 h cache write when it
enters the context, and one cache read for each later API call of its session (the transcript's distinct assistant messages after the
call). Dollars are that weighted share of the run's recorded `total_cost_usd`, using the price weights in `cost.mjs` `WEIGHTS`. It is an
upper bound: it assumes the session never compacted.

### Thresholds (`REPLAY` in outreplay.mjs, the one place)

| Key | Value | Meaning |
|---|---|---|
| `chars_per_token` | 4 | the token estimate |
| `gate_share` | 0.01 | gate: the `ceiling` saving is >= 1 % of the runs' cache reads |
| `rerun_window` | 3 | re-run signal: the same command (before its first pipe), cut, run again with another cut within 3 shell calls |
| `ceiling_extra` | 400 | characters the ceiling keeps on top of the KEEP lines |
| `since_days` | 31 | the default window |
| `w_write`, `w_read` | `WEIGHTS.cache_create_1h`, `WEIGHTS.cache_read` | the weights of a cache write and a cache read |

### The gate

Build past S1 only when a project's `ceiling` (wrap-eligible test / build / install calls) reaches `gate_share` of its cache reads.
The re-run signal is reported but does not release the gate (DEC-a-582): the wrap skips the cut calls it measures. With no Claude run
with recorded cache reads in the window, the gate reads `n/a` with the reason. Re-measure: a check-in runs this once a month per
project, or when a new project or harness joins.
