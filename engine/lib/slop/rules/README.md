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

`overrides.json` may set `enabled`, `level`, `shadow` and `params` (only the parameters listed for that kind in
`KIND_PARAMS`, `engine/lib/slop/check.mjs`). It never replaces a rule's text: patterns, selectors, lint rules and fixtures stay
those of the rule file.

```json
{ "K17": { "level": "WARN" }, "K24": { "enabled": false }, "K12": { "params": { "exclude": ["**/vendor/**", "gen/**"] } } }
```

## Kinds

| Kind | Parameters | In a project rule? |
|---|---|---|
| `pattern` | `patterns` (regexes), `files`, `exclude`, `in` (`code` / `comment` / `string`: the other text blanked), `unless`, `cite` | yes |
| `junk` | name `patterns`, `max_bytes`, `allow` | yes |
| `imports` | `roots` + `forbid` (layers, cycles); `bare`, `manifests`, `vendor` (the dependency lock) | yes |
| `eslint` | `rules`: ESLint core rules from an allow list (`LINT_RULES`, `engine/lib/slop/tools.mjs`) | yes |
| `ast` | `selectors`: `{ selector, message, text? }`, ESLint `no-restricted-syntax` through the pinned ESLint; `reason` | yes |
| `model` | `question` (plain words), `files`, `on` (`code` / `tests`: which branch it reads), `hits` (rule ids whose findings it is sent), `context` (quality files) | no |
| `diff-check`, `swallow`, `command`, `dup`, `exports`, `refs` | engine-only: level, switch and listed parameters through `overrides.json` | no |

A rule file never loads code: the engine writes the ESLint config from the rule's data, with inline config comments off, and
accepts core rules only.

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
