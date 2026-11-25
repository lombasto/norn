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
`KIND_PARAMS`, `engine/lib/slop/check.mjs`). It never replaces a rule's text: patterns, selectors, lint rules and fixtures stay
those of the rule file.

```json
{ "K16": { "level": "WARN" }, "K11": { "enabled": false }, "LJ": { "params": { "levels": { "no-undef": "BLOCK" } } }, "K12": { "params": { "exclude": ["**/vendor/**", "gen/**"] } } }
```

## Kinds

| Kind | Parameters | In a project rule? |
|---|---|---|
| `pattern` | `patterns` (regexes), `files`, `exclude`, `in` (`code` / `comment` / `string`: the other text blanked), `unless`, `cite` | yes |
| `junk` | name `patterns`, `max_bytes`, `allow` | yes |
| `imports` | `roots` + `forbid` (layers, cycles); `bare`, `manifests`, `vendor` (the dependency lock) | yes |
| `lint` | `tool` (`eslint`, `ruff`, `clippy`: the language packs in `lang/`), `config` (ESLint's repo config; ruff's is the nearest `[tool.ruff]` / `ruff.toml` of each file; all read from the merge base for both sides; an edit to it is `<id>/config-changed`), `rules` (ESLint core rules), `source: log` + `log` (path templates `{git}` / `{head}`: clippy is read from the head's log, never run; none is `<id>/no-evidence`), `levels` (per sub-rule, `*` for the rest), `shadow_rules` (`*`: every one `levels` does not name), `files`, `exclude`; a finding's rule is `<id>/<tool rule>` | yes |
| `shim` | `files`, `exclude` | no |
| `suppress` | `files`, `exclude`, `reason` (words that are no reason): a suppression the file's language pack finds (`# noqa`, `# type: ignore`, `#[allow]`, `eslint-disable`) with no reason on its line | yes |
| `ast` | `selectors`: `{ selector, message, text? }`, ESLint `no-restricted-syntax` through the pinned ESLint; `reason` | yes |
| `model` | `question` (plain words), `files`, `on` (`code` / `tests`: which branch it reads), `hits` (rule ids whose findings it is sent), `context` (quality files) | no |
| `register` | `files` (the rule files beside the register's repo sources): K26, a new sentence no register row covers | no |
| `diff-check`, `command`, `dup`, `exports`, `refs` | engine-only: level, switch and listed parameters through `overrides.json` | no |

A rule file never loads code: the engine writes the ESLint config from the rule's data and the merge base's `eslint.config.mjs`
(plain data, core rules only), with inline config comments off. ESLint is the locked tool set in `tools/lint`, installed by
`npm ci --ignore-scripts` into `<meta root>/state/tools/lint/<lock hash>`; a tool that cannot install or run is a BLOCK "could not run".
ruff and clippy are the project's own tools, never pinned here: ruff runs as `uv run --no-sync --project <the config's folder in the
main checkout> ruff` (VIRTUAL_ENV unset, never `uv sync`) on the touched files in a temp folder; clippy is never started (a build).

## The second voice (`model`)

All `model` rules of a check share ONE model call at the run end: no tools, no standing context, the prompt on stdin, on the
project's routing (another model family than the author's when the policy table has one). The input is ranked and capped
(`VOICE`, `engine/lib/slop/voice.mjs`): the hunks other rules hit, then code, then tests, then the rest listed by name, plus the
questions, the rule hits and the brief's Scope lines. A docs-only branch is not read; a test-only branch asks only the rules `on`
`tests`. Every finding must quote an added line of its file verbatim, or the engine drops it; its fingerprint is rule + file +
quote, so new-only and waivers work as for every rule. At most 10 findings. With no route (the doors, `norn slop check`) each
model rule is a WARN finding "could not run": the voice is advisory and holds nothing.

The `M*` rules ship `shadow: true`. A thumb on a model finding in the Guard records a rating (`<state>/slop/ratings.jsonl`, the
last one counts); Slop › Rules shows each rule's precision. At 90 % over 20 rated a rule may go to `BLOCK`, under 50 % (over 20
rated) to `TREND`: the owner or the controller records that in `overrides.json`; nothing changes a level by itself.

## Machine rules

`machine: true` marks a rule that reads this machine's state rather than the diff's trees (K14: `norn gen --check` reads the
generated harness files on this machine). `norn slop check --ci` (the pull-request job) and the daily's check of a landing do not run such a
rule (it is not in the summary's `ran:` list); every other check runs it. The flag is the rule's data, never a project override.

## Finding shape

- `key: "match"` keys a pattern or `ast` rule on the matched token instead of the line: a token is new only when no file of the
  base tree has it (a new environment name, a retired term), so editing an old line is no finding.
- Fail-closed (SPEC 3.4): a rule whose detector throws (no npx, a cold tool cache, ESLint exit 2) is ONE BLOCK finding of that
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
