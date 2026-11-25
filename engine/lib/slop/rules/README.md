# SloppaChoppa rules

A rule is a data file: an id, a level (`BLOCK`, `WARN`, `TREND`, `LIST`), a kind, that kind's parameters and a fixture with a
`hit` and a near-miss `miss` (each a base and a head tree). Every rule, a project's own too, carries `explain`: `what` (the finding in plain
words), `why` (why the rule exists) and `fix` (what to do). A rule without all three does not load. `norn slop check`, the run-end
resume prompt and the Slop page show it under the finding, with the waiver command for that finding. Only new findings count: a finding is fingerprinted at head and at the
merge base, and only a head finding the base did not have is reported. A new `BLOCK` finding holds the branch's merge until it is
fixed or waived (`norn rec add waiver`).

## Where rules live

| Path | What |
|---|---|
| `engine/lib/slop/rules/<ID>.json` | built-in rules (ids `K*`, `T*`, `R*`; `M*` the second voice's questions) |
| `<project folder>/rules/slop/P-<name>.json` | a project's own rule; its id is its file name |
| `<project folder>/rules/slop/overrides.json` | a sparse patch of built-in or project rules, keyed by id |
| `<project folder>/rules/slop/register.json` | the project's rule register (below): one row per rule sentence of its rule files |

`overrides.json` may set `enabled`, `level`, `shadow` and `params` (only the parameters listed for that kind in
`KIND_PARAMS`, `engine/lib/slop/check.mjs`). It never replaces a rule's text: patterns, ast-grep match data, lint rules and fixtures stay
those of the rule file.

```json
{ "K16": { "level": "WARN" }, "K11": { "enabled": false }, "LJ": { "params": { "levels": { "no-undef": "BLOCK" } } }, "K12": { "params": { "exclude": ["**/vendor/**", "gen/**"] } } }
```

## Kinds

| Kind | Parameters | In a project rule? |
|---|---|---|
| `pattern` | `patterns` (regexes: one list for every language, or lists by pack id `js` / `ts` / `py` / `rs`, a file whose pack has none is not read), `files`, `exclude`, `in` (`code` / `comment` / `string`: the other text blanked by the file's pack lexer; a file with no pack, a doc or data file, is all prose), `unless`, `cite`, `shadow_langs` (packs whose findings are shadow) | yes |
| `junk` | name `patterns`, `max_bytes`, `allow` | yes |
| `imports` | `roots` + `forbid` (layers, cycles); `bare`, `manifests`, `vendor` (the dependency lock) | yes |
| `lint` | `tool` (`eslint`, `ruff`, `clippy`: the language packs in `lang/`; `sarif`: any analyzer's SARIF 2.1.0 file, below), `config` (ESLint's repo config; ruff's is the nearest `[tool.ruff]` / `ruff.toml` of each file; all read from the merge base for both sides; an edit to it is `<id>/config-changed`), `rules` (ESLint core rules), `source: log` + `log` (path templates `{git}` / `{head}`: clippy and sarif are read from the file a project tool wrote, never run; none for the head is `<id>/no-evidence`; or `scan`: a pinned scanner Norn runs, below), `quote` (`false`: a finding never quotes its line), `levels` (per sub-rule; sarif: then per SARIF level `error` / `warning` / `note` / `none`; `*` for the rest), `shadow_rules` (`*`: every one `levels` does not name), `select` (ruff only: rules Norn adds to the project's own, as `--extend-select`; LP selects ERA001, K12's Python route), `files`, `exclude`; a finding's rule is `<id>/<tool rule>` | yes |
| `shim` | `files`, `exclude` | no |
| `suppress` | `files`, `exclude`, `reason` (words that are no reason): a suppression the file's language pack finds (`# noqa`, `# type: ignore`, `#[allow]`, `eslint-disable`) with no reason on its line | yes |
| `ast` | `tool: ast-grep`, `match` by language pack (`js`, `ts`, `py`, `rs`): a list of `{ rule, constraints?, message }` (ast-grep rule data; its `regex` is Rust regex), `shadow_langs` (packs whose findings are shadow, the rule id kept), `reason`, `files`, `exclude`, `allow` (`{ token, listed_in }` of a `key: match` rule: a token that matches `token` and is listed in that file passes; K21 names `^NORN_` and engine/lib/slop/env.md, a project sets its own); the old ESLint `selectors` form does not load | yes |
| `model` | `question` (plain words), `files`, `on` (`code` / `tests`: which branch it reads), `hits` (rule ids whose findings it is sent), `context` (quality files) | no |
| `register` | `files` (the rule files beside the register's repo sources): K26, a new sentence no register row covers | no |
| `companion` | `min_shared`, `min_share` (the rule's threshold, at or over the signals' own), `partners_exclude` (lock and generated files), `files`, `exclude`: a changed file whose usual partner in the code signals is not in the branch (K27) | no |
| `diff-check`, `command`, `dup`, `exports`, `refs` | engine-only: level, switch and listed parameters through `overrides.json` | no |

K27 (`companion`, WARN, `shadow`, `machine`) reads the project's code signals through their one reader (`readSignals(state)`,
[docs/code-signals.md](../../../../docs/code-signals.md)): for each file the branch changes, each partner with `shared >= min_shared`
and `share >= min_share` that is at head and not in the diff (a rename's old path counts as in it) is one finding, "A usually
changes with B (n of m landings); B is not in this branch (measured from git at <sha>)". With no state or no stored signals it is
"could not run" (shadow: recorded, never held); `--ci` does not run it (a runner has no signals).

R2 (`refs`) excludes changelogs (`**/CHANGELOG*.md`): a changelog line naming a path deleted later is history, not a broken reference.

A rule file never loads code: the engine writes the ESLint config from the rule's data and the merge base's `eslint.config.mjs`
(plain data, core rules only), with inline config comments off. ESLint is the locked tool set in `tools/lint`, installed by
`npm ci --ignore-scripts` into `<meta root>/state/tools/lint/<lock hash>`; a tool that cannot install or run is a BLOCK "could not run".
The `ast` rules run on the locked ast-grep set in `tools/ast` (`@ast-grep/cli`, installed the same way into
`<meta root>/state/tools/ast/<lock hash>`): ONE scan per side over every `ast` rule, the platform binary run directly. ast-grep could
not run when it exits other than 0 (8: a rule that does not parse), prints an `ERROR:` line on stderr or prints a line that is not
JSON: each `ast` rule is then one BLOCK "could not run".
ruff and clippy are the project's own tools, never pinned here: ruff runs as `uv run --no-sync --project <the config's folder in the
main checkout> ruff` (VIRTUAL_ENV unset, never `uv sync`) on the touched files in a temp folder; clippy is never started (a build).

## SARIF (`tool: sarif`)

Any analyzer that writes SARIF 2.1.0 plugs into the kind `lint` with no parser of its own (`engine/lib/slop/lang/sarif.mjs`). Choppa
never runs it: the project's own gate writes the file, and the rule's `log` templates name it (`{git}` the repo's common git
folder, `{head}` the commit, `*` in the file name; several files are read as one log). A project adds such a rule; the one built-in sarif
rule, LS, names a pinned scanner Norn runs instead (`scan`, below).

- **The head** reads the templates with `{head}` = the head's sha. No file is `<id>/no-evidence` (give it a `levels` entry: `WARN`).
- **The merge base** reads the same templates with `{head}` = the merge base's sha, so the gate that writes the file at each commit
  of main gives the base side. A result the base file has on the same line text is not new (the line may move). With no file for
  the merge base (a runner in CI never has one), every result on a touched file counts as new, and the check adds one finding
  `<id>/no-base` that says so.
- **A finding** per result of kind `fail` (absent = fail; `pass`, `open`, `review`, `informational`, `notApplicable` are none)
  whose first physical location names a file the branch touches (the uri, through `originalUriBaseIds`; equal, or the file is its
  tail): rule `<id>/<ruleId>` (`ruleId`, `rule.id` or the descriptor `ruleIndex` names), line `region.startLine` (0: the whole
  file), the message (`text`, or `messageStrings` / `globalMessageStrings` by `id`, `{n}` filled from `arguments`). Its level
  is `levels[<ruleId>]`, else `levels[<SARIF level>]`, else `levels["*"]`, else the rule's; the SARIF level is the result's, else
  `none` for a kind other than fail, else the invocation's `ruleConfigurationOverrides`, the descriptor's
  `defaultConfiguration.level`, `warning` (SARIF 3.27.10). A result with no file names nothing the branch touched.
- **Not SARIF 2.1.0** (not JSON, `version` other than `"2.1.0"`, `runs` or a run's `results` not an array - null means the tool's
  results are unknown -, a result with no message or no rule, a level or kind outside the spec's lists, a `startLine` under 1): the
  rule's fail-closed BLOCK "could not run", as any tool that fails.
- In-file `suppressions` are not honoured (as ESLint's inline comments are off): a result that must stay needs a waiver for `<id>/<ruleId>`.

A worked example, `<project folder>/rules/slop/P-scan.json`: the project's gate writes its scanner's SARIF to
`$(git rev-parse --git-common-dir)/norn/sarif/$(git rev-parse HEAD).sarif` at each head and each commit of main.

```json
{ "id": "P-scan", "level": "WARN", "kind": "lint", "tool": "sarif", "source": "log", "log": ["{git}/norn/sarif/{head}*.sarif"],
  "title": "a new result of the project scanner on a file the branch touches",
  "explain": { "what": "The project scanner reports something new on a file the branch touches (P-scan/<its rule>).",
               "why": "The scanner knows what it looks for; only what the branch adds counts.", "fix": "Fix what the message says, or waive P-scan/<rule>." },
  "files": ["**/*.py", "**/*.mjs"],
  "levels": { "error": "BLOCK", "warning": "WARN", "note": "WARN", "none": "TREND", "no-evidence": "WARN", "no-base": "WARN" },
  "fixture": {
    "hit":  { "base": { "src/a.py": "X = 1\n" }, "head": { "src/a.py": "X = 1\nTOKEN = \"t0k\"\n" },
              "recorded": { "base": { "version": "2.1.0", "runs": [{ "tool": { "driver": { "name": "scan" } }, "results": [] }] },
                            "head": { "version": "2.1.0", "runs": [{ "tool": { "driver": { "name": "scan" } }, "results": [
                              { "ruleId": "hardcoded-token", "level": "error", "message": { "text": "a token is written in the code" },
                                "locations": [{ "physicalLocation": { "artifactLocation": { "uri": "src/a.py" }, "region": { "startLine": 2 } } }] }] }] } } },
    "miss": { "base": { "src/a.py": "TOKEN = \"t0k\"\n", "src/b.py": "Y = 1\n" }, "head": { "src/a.py": "# moved down a line\nTOKEN = \"t0k\"\n", "src/b.py": "Y = 1\n" },
              "recorded": { "base": { "version": "2.1.0", "runs": [{ "tool": { "driver": { "name": "scan" } }, "results": [
                              { "ruleId": "hardcoded-token", "level": "error", "message": { "text": "a token is written in the code" },
                                "locations": [{ "physicalLocation": { "artifactLocation": { "uri": "src/a.py" }, "region": { "startLine": 1 } } }] }] }] },
                            "head": { "version": "2.1.0", "runs": [{ "tool": { "driver": { "name": "scan" } }, "results": [
                              { "ruleId": "hardcoded-token", "level": "error", "message": { "text": "a token is written in the code" },
                                "locations": [{ "physicalLocation": { "artifactLocation": { "uri": "src/a.py" }, "region": { "startLine": 2 } } }] },
                              { "ruleId": "hardcoded-token", "level": "error", "message": { "text": "a token is written in the code" },
                                "locations": [{ "physicalLocation": { "artifactLocation": { "uri": "src/b.py" }, "region": { "startLine": 1 } } }] }] }] } } } } }
```

The hit is one BLOCK finding P-scan/hardcoded-token on line 2. The near-miss reports nothing: the result on the touched file is old
(the base had it on the same line text, one line up), and the other file is not touched. `tests/slop-sarif.test.mjs` runs this rule
and its fixture.

### A pinned scanner (`scan`): LS, keys and tokens

A sarif rule may name a scanner Norn runs itself (`scan`, one of `SCANNERS` in `engine/lib/slop/tools.mjs`) instead of `source: log`;
exactly one of the two. LS (BLOCK) names `gitleaks` (MIT): `tools/gitleaks/manifest.json` pins the version and `lock.json` the release
archive of each OS with its sha256 (from the release's checksums file). On first use the archive is downloaded, its sha256 checked
before it is opened, and the binary extracted into `<meta root>/state/tools/gitleaks/<lock hash>/<platform>-<arch>/`; never a
worktree, never imported. No pin for the OS, no network, a wrong checksum or a scanner that exits non-zero is LS's "could not run".

- **Only the branch's added lines** are scanned (`git diff -U0` merge base..head; every other line of a touched file blanked, so lines
  keep their numbers). The merge base side is an empty log: every result is new, and there is no `no-base`.
- **The branch cannot switch it off**: the files are scanned from a folder of their own, so the branch's `.gitleaksignore` and
  `.gitleaks.toml` are not read; `GITLEAKS_*` is unset and `gitleaks:allow` comments are ignored. A false positive is a waiver of
  `LS/<gitleaks rule>`.
- **The key is never printed**: gitleaks runs with `--redact`, each result keeps only its rule, file and lines (no snippet, no
  fingerprints, a fixed message), and `quote: false` makes a finding's snippet `<rule> line <sha256 of the line>` instead of the line
  (the fingerprint still follows a moved line).
- **Fixtures**: a fixture file's text may be a list of parts, joined when the rule loads, so the repo never holds a key in one string
  (the host's push protection blocks even a fake one). LS's fixture and `tests/slop-secrets.test.mjs` build their keys that way.

## The second voice (`model`)

All `model` rules of a check share ONE model call at the run end: the prompt on stdin and nothing else, launched lean (the
adapter's launch-profile flags: no MCP servers, no user setup with its memory, hooks and plugins, no skills, no dynamic
system-prompt sections) in the voice's own empty temp folder, on the route `voiceRoute` picks, in the mode the route carries.
Who reads is chosen, never derived from whatever executor the project has:

- **The default** (`policy.slop.voice_reader` = `default`): the author's own harness family with no tools, at the first model of
  the policy table (the review class first, then the others) other than the author's - a Sonnet row reads an Opus branch and the
  reverse - else the same model. A read never goes to another vendor by default. An author family with no no-tools mode gets no
  read (each model rule is the WARN "could not run").
- **The setting** (Settings, "Second voice: reader", beside the daily cap): `default`, or an executor name, optionally a space
  and a model (`codex-sol gpt-6.1-sol`; no model = its row of the policy table, else its entry's model). A named reader whose
  family has no no-tools mode reads read-only in the empty folder.
- **The allow rule**: a named reader must be allowed to do `review` work (its allowed classes; a typed executor does chores and
  pass/fail only unless widened). The save is refused otherwise (400, as a class -> executor pairing is), and `voiceRoute` never
  routes one that is not.

A daily cap holds the quota: at most `policy.slop.voice_reads_per_day` calls (15 by
default; Settings, beside the SloppaChoppa switch) per project and UTC day, counted from the stored checks (`voice_reads` on a
check line); over it each model rule is the WARN "could not run: daily cap n reached". The input is ranked and capped
(`VOICE`, `engine/lib/slop/voice.mjs`): the hunks other rules hit, then code, then tests, then the rest listed by name, plus the
questions, the rule hits and the brief's Scope lines. A docs-only branch is not read; a test-only branch asks only the rules `on`
`tests`. Every finding must quote an added line of its file verbatim, or the engine drops it; its fingerprint is rule + file +
quote, so new-only and waivers work as for every rule. At most 10 findings. With no route (the doors, `norn slop check`) each
model rule is a WARN finding "could not run": the voice is advisory and holds nothing.

**The risk rank decides which diffs a short day's reads go to** (RM-a-68; `voiceGate`, `engine/lib/slop/voice.mjs`). At each run end
`left` = the cap minus today's reads, and `expected` = the run-end checks (stored checks with a run) a day over the last 7 full UTC
days (`VOICE_GATE.history_days`) times the share of the UTC day still left, rounded up, at least 1 (this diff included). When `left
>= expected` the diff is read. When `left < expected`, the diff is read only when its risk percentile (`norn code risk`,
`engine/lib/coderisk.mjs`: where it stands against the last 100 landings) is at least the bar `100 x (1 - left / expected)`; under
it each model rule is the WARN "could not run: skipped by the risk rank: riskier than p % of the last n landings (...), under the bar
b % (l reads left, ~e diffs expected today)", and no read is spent. A rank that is n/a (no code signals stored, fewer than 10
landings) reads in arrival order with the reason said: the cap alone decides, as before. `endCheck` returns the one-line rank
(`risk`) to the run end, a skipped diff's WARN quotes it, and the PR body (merge-land) prints it as "Risk rank: ...".

The rank (`norn code risk <base>..<head> [--json]`): the diff from the merge base to head, and the same numbers for each of the last
100 first-parent landings ending at that merge base - lines and files changed (git), the fixes 365 d of its files summed, their top
`fix_first`, and the companions it leaves out (the code signals through `readSignals`, docs/code-signals.md; an untyped history drops
the two fix numbers and says why). Per number the Borda count over the landings and the diff (ties half), summed; the percentile =
the landings with a lower sum plus half the equal ones. The line names the three numbers standing highest. `RISK_LIMITS`
(engine/lib/coderisk.mjs, the one place): `landings` 100 (the pool), `min_landings` 10 (under it the rank is n/a), `why` 3.

The `M*` rules ship `shadow: true`. A thumb on a model finding in the Guard records a rating (`<state>/slop/ratings.jsonl`, the
last one counts); Slop › Rules shows each rule's precision. At 90 % over 20 rated a rule may go to `BLOCK`, under 50 % (over 20
rated) to `TREND`: the owner or the controller records that in `overrides.json`; nothing changes a level by itself.

## Test smells (T4, T5)

T4 (a new or changed test with no assertion) and T5 (a test whose every assertion is on a mock it made) are `ast` rules, WARN and
`shadow`. A test is a node:test `test` / `it` / `t.test` call with an inline function, a pytest `def test*` (a method too), or a Rust
`fn` under `#[test]` / `#[tokio::test]` / `#[rstest]`. A test whose match is unchanged from the base is no new finding.

T4 reads "a call that can fail the test" as the brief says it (DEC-a-599): any call can throw, raise or panic, so a test whose one
check is "this does not throw" checks something. T4 fires only on a test with no assertion that calls nothing but print / log and
constructors.

| | an assertion | a call or read that can fail the test (T4 silent) | print / log / constructor (T4 still fires) |
|---|---|---|---|
| js | a callee naming `assert`, `expect`, `should`, `check`, `verify`, `ensure` or `must` (`assert.equal`, `t.assert.ok`, `assertRow`), `t.plan`, `*.fail`, `throw` | any other call | `console.*`, `new X()` |
| py | `assert`, `raise`, a call named as in js plus `fail`, `raises`, `warns`, `deprecated_call` (`self.assertEqual`, `pytest.raises`) | any other call, an import, an attribute read | `print`, `logging.*` / `logger.*` / `log.*`, a `Capitalised()` call |
| rs | an `assert*!` / `panic!` / `unreachable!` / `todo!` macro, `.unwrap()` / `.expect()` / `_err` forms, `?`, `#[should_panic]`, a call named as in js | any other call or macro, a call inside a print macro's arguments | `println!` / `eprintln!` / `print!` / `dbg!` / `format!` / `vec!`, `log` / `tracing` macros, `Type::new()` / `Type::default()` / `Type(..)` |

A helper is recognised by its name (it counts as an assertion); any other helper is a call, so T4 is silent on it, never loud.

T5 reads the test's one mock: node:test `mock.fn`, `unittest.mock` / `mocker` `Mock` / `MagicMock` / `AsyncMock` / `create_autospec`,
mockall's `Mock<T>::new()`, bound to a name (`const` / `=` / `let`). It fires when every assertion is on that mock (`<fn>.mock` in the
assertion, its `assert_called*` methods or an `assert` on `called`, `call_count`, `call_args`, ..., an `assert*!` naming it) and the
mock never reaches other code: it is silent when the mock is an argument of a call, put into an object or struct, assigned, its member
passed, or when the test makes a second mock (a mock handed to real code makes asserting what it saw a real interaction test). A
patch (`patch*`, `mock.method`) replaces a dependency of real code, so it is no mock the test made; a mock from a decorator, a fixture,
a hook or a shared variable is no finding either. A helper call that does not take the mock is silent too (a
function of the file, a name imported from a `help` / `support` / `fixture` / `common` / `util` / `conftest` module, a test argument,
a `fn` of the test's module or a `*test*` / `*util*` path).

## Machine rules

`machine: true` marks a rule that reads this machine's state rather than the diff's trees (K14: `norn gen --check` reads the
generated harness files on this machine). `norn slop check --ci` (the pull-request job) and the daily's check of a landing do not run such a
rule (it is not in the summary's `ran:` list); every other check runs it. The flag is the rule's data, never a project override.

## Finding shape

- `key: "match"` keys a pattern or `ast` rule on the matched token instead of the line: a token is new only when no file of the
  base tree has it (a new environment name, a retired term), so editing an old line is no finding.
- Fail-closed (SPEC 3.4): a rule whose detector throws (no npx, a cold tool cache, ESLint exit 2, an ast-grep exit other than 0 or an `ERROR:` line on its stderr) is ONE BLOCK finding of that
  rule, `<rule> * could not run: <why>` (fingerprint rule + could-not-run), so it holds, resumes and is waived as any finding; a file
  ESLint cannot parse is one BLOCK `does not parse: <parser message>` of the first held lint rule. A run-end check that throws holds
  the branch `check * could not check: <why>` (the digest lists it); the door runs its own check.
- `--diff base..head` starts at the merge base of the two (as every door); the summary names the commits, the files and the rules
  that ran and could not; an empty range says `nothing to check`; `a...b` is a usage error (exit 2).
- `shadow: true` runs the rule and records its findings; they never hold a merge.
- `value` / `base_value` carry a measured number at head and at base (a finding of `dup` carries the count of copies).

## The rule register

`register.json` (SPEC 4.5, `engine/lib/slop/register.mjs`) writes down how each rule sentence of a project's rule files is checked:

```json
{ "sources": { "repo": ["CLAUDE.md"], "project": ["rules/team-rules.txt"] },
  "prose": { "CLAUDE.md": ["This file is read by every worker."] },
  "rows": [{ "id": "D-no-shims", "source": "CLAUDE.md", "text": "Never keep old or deprecated behaviour alive through ...",
             "class": "mechanical", "home": "slop", "checks": ["K11A", "K16", "K11"], "how": "the shapes by K11A and K16, the words by K11" }] }
```

- `sources`: the rule files, `repo` from the repo's top (read at main's tip), `project` from the project folder. A sentence is a
  sentence of prose or of a list item; headings, code fences, HTML comments and tables are no rule text.
- A row's `text` quotes its source: it covers every sentence it holds, and a quote ending in `...` covers the sentence it starts.
  `prose` quotes the sentences that state no rule.
- `class`: `mechanical` (a deterministic check says yes or no), `proxy` (a signal that often goes with a breach; it never blocks
  alone), `voice` (only a reader can tell), `unchecked` (nothing checks it: said out loud). `home`: `slop`, `hook` (what an agent
  does in a run), `tests`, `ci`. `checks`: the rule ids whose findings are its breaches. A row without a class does not load.
- The daily report's "Rule register" section: `rules with no check: n` (rows of class `unchecked` + sentences with no row, each
  listed), the rotten rows (a quote no longer in its source), the rows with no home, the breaches per row in 7 days (the new
  findings of the week's stored checks, one per fingerprint) and the deferrals that came due: a K22 deferral in the tree whose
  cited record is done or dropped, each with its brief "do the deferred removal". The digest line ends `rules with no check: n`.
- K26 (WARN) on a diff: a new sentence in a `CLAUDE.md`, an `AGENTS.md` or a repo source that no row covers. Say how it is checked
  (a row), or mark it unchecked. With no register every new sentence is one; the register's rows enter the rule-set hash.

## Fixed by code (`fix`)

A rule's `fix` list names the findings code may fix (SPEC 3.5); nothing else is ever edited. K1: `{ "msg": "trailing whitespace" }`,
`{ "msg": "new blank line at EOF" }` (git's message; the line git names). A lint rule on ESLint: `{ "sub": "<core rule>" }` applies
ESLint's own `fix` object of the message; `"suggestion": "<messageId>"` applies that suggestion instead; `"in": "import"` only when the
edit lies inside an import declaration (LJ's `no-unused-vars`: an unused import specifier, never an unused local, whose initialiser
may have an effect). A file the worktree changed since HEAD is not edited.

- `norn slop fix [--lane L]` applies the fixes to the open BLOCK findings of the branch in the worktree, prints each one, commits nothing.
- The run end applies the same fixes, commits them on the lane branch as `style(slop): autofix N findings (LJ/no-unused-vars 3, K1 2)`
  (nothing is pushed) and checks the new head; only what is left goes into the resume. If the Done check is red on the fixed head
  and green on the unfixed one, the branch goes back to the unfixed head and the findings go to the resume (`reverted`).
- `<state>/slop/outcomes.jsonl` keeps one line per finding with its action: `autofix`, `reverted`, `resume`. A class (a finding's
  rule) with 2 reverts in its last 10 fixes is switched off (no more fixes by code) and the digest's slop line says so once.

## Proving a rule

Each rule's fixtures run in `tests/slop.test.mjs` (tool rules from their recorded output); `norn slop fixtures` runs the real tools on
them. Before a rule blocks, replay it over recent merged branches: a rule that fires on many of them is noise, not a gate.

## On a pull request

Every pull request runs the `slop` job of the PR check (`.github/workflows/pr.yml`): `norn slop check --ci --diff <merge base>..HEAD`, the same
rules a lane's run end uses, on the PR's diff against its merge base with the target branch. A new BLOCK finding fails it (exit 1)
and the job lists each finding (`BLOCK <rule> <file>:<line> ...`). `--ci` skips the rules flagged `machine` in their data (K14 reads
the generated harness files of the machine it runs on; a runner has none) and leaves them out of `ran:`.

### Make it a required status (owner, once)

The job only blocks a merge when the branch protection asks for it. In the repo's Settings > Rules > Rulesets, in the ruleset
that targets the default branch, turn on "Require status checks to pass" and add the check `slop` (source: GitHub Actions). This
is a repository setting: no file in the repo can make it required.

pr.yml has no path filter on purpose: a required status whose workflow a filter skips stays "expected" and blocks the PR.

### What else covers main

- `norn merge-land` opens no PR for a lane branch with open BLOCK findings at its pushed head, and writes the WARN findings of
  that head's stored check into the PR body.
- An admin merge or a direct push cannot be stopped from here. The daily report lists every first-parent landing on main since
  the last report that has no stored check, with its findings ("Landed unchecked"); its digest line carries
  `LANDED UNCHECKED n`.
- What the gate could not see: over the last 7 days of run-end checks (a stored check with `run`; door and `norn slop check` checks
  have no voice by design) the daily report and its digest line say `second voice: could not run k of n (<the commonest why>)` and
  `Rust unchecked: k of n run ends touched *.rs with no clippy log` (LR/no-evidence), each only when its k > 0.
