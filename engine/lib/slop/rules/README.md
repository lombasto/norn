# SloppaChoppa rules

A rule is a data file: an id, a level (`BLOCK`, `WARN`, `TREND`, `LIST`), a kind, that kind's parameters and a fixture with a
`hit` and a near-miss `miss` (each a base and a head tree). Only new findings count: a finding is fingerprinted at head and at the
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
quote, so new-only and waivers work as for every rule. At most 10 findings. With no route (the doors, `norn slop check`) the
model rules are skipped.

The `M*` rules ship `shadow: true`. A thumb on a model finding in the Guard records a rating (`<state>/slop/ratings.jsonl`, the
last one counts); Slop › Rules shows each rule's precision. At 90 % over 20 rated a rule may go to `BLOCK`, under 50 % (over 20
rated) to `TREND`: the owner or the controller records that in `overrides.json`; nothing changes a level by itself.

## Finding shape

- `key: "match"` keys a pattern or `ast` rule on the matched token instead of the line: a token is new only when no file of the
  base tree has it (a new environment name, a retired term), so editing an old line is no finding.
- `shadow: true` runs the rule and records its findings; they never hold a merge.
- `value` / `base_value` carry a measured number at head and at base (a finding of `dup` carries the count of copies).

## Proving a rule

Each rule's fixtures run in `tests/slop.test.mjs` (tool rules from their recorded output); `norn slop fixtures` runs the real tools on
them. Before a rule blocks, replay it over recent merged branches: a rule that fires on many of them is noise, not a gate.
