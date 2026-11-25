# Code graph: the contract

The file-level import graph of a git repo at a commit, for JavaScript / TypeScript, Python and Rust: which file loads which, how
each import was resolved, and the imports that resolve to nothing in the repo; and its symbols: every definition with its exact
bounds, the references to a name (see "Symbols"), and the call sites with what each calls (see "Call edges"). It is extracted by `norn-code` (engine/code-rs,
tree-sitter, no model), stored per tree, and read through ONE reader module and its CLI. Lane code-graph (RM-a-53) writes it;
lanes impacted-tests, code-map-graph, triage-card and warn-on-edit (and later symbol-read, refactor-targets) read this doc and
`engine/lib/codegraph.mjs`, nothing else. The store's file format is private between norn-code and the reader.

## Paths

Every path in every answer (`FileRow` keys, `Edge.from` / `to`, `Unresolved.from`, rows, cycles, `Stamp.dirty`) is relative to the
**repo root** (the git work tree's top level, `git ls-tree --full-tree`), with `/` separators. That holds whatever folder `repo`
names: `graphAt({ repo: '<root>/sub/dir' })` answers with root-relative paths too. File arguments (CLI and functions) are
root-relative in the same way.

A monorepo project (a Norn project whose folder is a subfolder of its repo, e.g. `apps/web/`) maps them with `Graph.prefix`, the
folder's path from the root with a trailing `/` (`''` at the root; it is `git rev-parse --show-prefix` of `repo`):
- the project's own file `f` (relative to its folder) is the graph's file `g.prefix + f`;
- a graph file `F` is inside the project when `F.startsWith(g.prefix)`; its project path is `F.slice(g.prefix.length)`.

The graph always covers the whole repo, so an edge may cross the project's folder (an import of a sibling package): it is kept,
and the consumer decides whether it counts. `norn code history` (codeindex.mjs) does exactly this mapping for its `fan_in`.

## The one reader

```js
import { graphAt, dependencies, dependents, cycles, reach, fans, excluded, symbols, references, callers, graphStatus, ALL_KINDS, LOAD_KINDS, FAN_KINDS, CALL_HOWS, TRUST, LIMITS } from '<norn>/engine/lib/codegraph.mjs';
const g = graphAt({ state, repo, at: 'HEAD' });   // Graph | { ok: false, why }
if (!g.ok) return na(g.why);
dependents(g, 'engine/lib/a.mjs', { depth: 2 });
```

Nothing in the reader throws for a graph that cannot be had (norn-code not built or stale, not a git work tree, unknown rev, an
index run that failed, an unknown file): it returns `{ ok: false, why }`. Never a partial or a guessed answer. Every answer
carries the `stamp` of the commit it is for.

| function | returns |
|---|---|
| `graphAt({ state = null, repo, at = 'HEAD', worktree = false, noIndex = false })` | `Graph` or `{ ok: false, why }` |
| `dependencies(g, file, { depth = 1, kinds = ALL_KINDS })` | `{ stamp, file, rows: [{ file, depth, via: Edge }], truncated }`: what `file` imports, to `depth` hops |
| `dependents(g, file, { depth = 1, kinds = ALL_KINDS })` | the same shape, the edges reversed: what imports `file` |
| `reach(g, files, { reverse = true, kinds = ALL_KINDS, to = null })` | `{ stamp, rows: [{ file, depth, path: [start, ..., file] }], truncated }`: every file that reaches `files` (reverse, the default) or that they reach (`reverse: false`), no depth limit; `to`: globs, only rows matching one |
| `cycles(g, { within = null, kinds = LOAD_KINDS })` | `{ stamp, cycles: [[file, ...]] }`: Tarjan's strongly connected components over the edges whose both ends match a `within` glob (null: all files); a component of 2+ files, or a file importing itself, is a cycle; each cycle sorted, the list sorted by its first file |
| `fans(g, { kinds = FAN_KINDS })` | `Map(file -> { in, out })`: distinct importers and distinct imports per file (self-edges not counted); every file of `g.files` has a row |
| `excluded(g, file)` | the exclusion reason of `file` (e.g. `"path segment vendor"`), or `null` (a graph file, or a file the graph does not know) |
| `symbols({ state = null, repo, file, at = 'HEAD', worktree = false })` | `{ stamp, file, defs: Def[] }`: the definitions of `file`, in source order (see "Symbols"); no Graph needed |
| `references({ state = null, repo, name, at = 'HEAD', worktree = false })` | `{ stamp, name, defs: Def[], rows: Ref[], truncated }`: the definitions named `name` and every other occurrence of the identifier; a name no definition has is `{ ok: false }` |
| `callers({ state = null, repo, symbol, depth = 1, at = 'HEAD', worktree = false })` | `{ stamp, symbol: Def, rows: Caller[], truncated }`: every call site whose candidates hold the definition `symbol` (a Def id, or `<file>:<name>` when the file has one definition of that name), and with `depth` > 1 the callers of each calling definition in turn (see "Call edges") |
| `graphStatus({ state = null, repo })` | `{ built, binary, why?, store_schema, store, head, indexed }` or `{ ok: false, why }` (see "CLI") |

Walks (`dependencies`, `dependents`, `reach`) are breadth-first: each file appears once, at its least depth, with the first edge
(by target path) that reached it. The start files are not rows. An unknown start file gives `{ ok: false, why: "unknown file ..." }`.

`graphAt` arguments:
- `repo`: any folder of the git work tree (the root and `prefix` are found from it).
- `state`: the store's folder is `<state>/code/graph`. A Norn project passes its state folder. `null`: `<git common dir>/norn`,
  so `<git common dir>/norn/code/graph`, shared by every worktree of the repo (CI and slop checks with no state use this).
- `at`: any revision; it is resolved to a commit (`unknown rev X in <root>` otherwise). When the store does not hold that commit's
  tree, `graphAt` runs `norn-code index` on it first (waiting at most `LIMITS.index_ms`), so the answer is for the commit asked.
- `worktree: true`: uncommitted work (changed and untracked-not-ignored files) resolved over HEAD, in memory; `at` must be HEAD.
  The stamp has `worktree: true` and `dirty`.
- `noIndex: true`: never index. The asked commit's snapshot when stored; else the store's newest (its `HEAD`), with
  `stamp.exact: false` and `stamp.commit` naming that other commit; with neither, `{ ok: false }`.

## Shapes

```
Graph      { ok: true, stamp: Stamp, root, prefix, files: Map<file, FileRow>, edges: Edge[], unresolved: Unresolved[], indexed }
             root: the repo root, absolute, '/' separators; prefix: see "Paths";
             indexed: { parsed, reused, ms } of the norn-code run this call made, null when the store already held the snapshot
Stamp      { commit, tree, indexed_at, age_s, asked, exact, worktree, dirty? }
             commit / tree: full 40-hex shas of the commit answered for and its root tree; indexed_at: ISO time the snapshot was
             written (now, for a worktree answer); age_s: seconds since then; asked: the `at` given (e.g. 'HEAD'); exact: false only
             with noIndex when another commit's snapshot answered; worktree: boolean; dirty: [file] the uncommitted files (worktree only)
FileRow    { lang, excluded, why?, crate?, module?, orphan?, parse_error? }
             lang: 'javascript' | 'typescript' | 'python' | 'rust' | null (null: a manifest the graph reads, e.g. package.json,
             pyproject.toml, Cargo.toml, or any other file an edge reaches, e.g. a shader an include_str! names); excluded: null | 'vendored' | 'generated' | 'config';
             why: the exclusion rule, only when excluded ("path segment node_modules", "linguist-vendored", "linguist-generated",
             "generated header", "code.exclude <glob>"); crate / module: a Rust file's crate name and module path, a
             Python file's dotted module name (from the longest root that holds it); orphan: true for a
             Rust file no crate target reaches; parse_error: true when tree-sitter could not parse the file (its edges may be missing)
Edge       { from, to, line, col, kind, how, spec, alts?, to_kind?, cfg?, trust }
             line / col: 1-based, of the import in `from`; kind, how: the tables below; spec: the import's source text, at most 120
             characters; alts: [file] the other candidates when how is 'ambiguous' (to is the nearest one); to_kind: 'excluded'
             when `to` is an excluded file (the edge is kept), 'namespace' when `to` is a folder (a Python namespace package,
             not a row of `files`); cfg: the `#[cfg(...)]` text on a Rust `mod` (not evaluated);
             trust: TRUST of the edge's class (see "Trust")
Unresolved { from, line, kind, how, spec, package?, why? }
             how: 'external' (outside the repo: a stdlib or registry package; `package` is its top-level name, e.g. 'lodash', 'fs')
             | 'unresolved' (in-repo by its form but nothing found, or not a literal; `why`: 'missing' | 'dynamic' | 'parse-error')
```

Every file the graph knows is in `files`, excluded ones included (with `excluded` and `why`), so a consumer tells "excluded" from
"unknown" without a second rule. Files outside the three languages and their manifests (markdown, json data, images) are not in
`files`: for them a consumer reports n/a "not a graph language".

### Edge kinds

| kind | language | meaning |
|---|---|---|
| `import` | JS / TS, Python | ESM `import ... from 'x'` / `import 'x'`; a module-level Python `import` / `from ... import` |
| `reexport` | JS / TS | `export ... from 'x'` |
| `require` | JS | `require('literal')`, the callee the identifier `require` |
| `dynamic` | JS / TS | `import('literal')` |
| `type` | TS | `import type ...` |
| `import-local` | Python | an import inside a function or under `if TYPE_CHECKING:` |
| `package-init` | Python | the implicit edge to each ancestor `__init__.py` of an imported module (Python runs them on import) |
| `native` | Python | a Python import of a Rust extension module, to its crate's library root (the crate's lib.rs) |
| `mod` | Rust | `mod x;` (and `#[path]`) |
| `use` | Rust | a `use` path to the module file it names, inside a crate or to another workspace / path-dependency crate |
| `extern-crate` | Rust | `extern crate x;` of a repo crate |
| `cargo-dep` | Rust | Cargo.toml to Cargo.toml (a path or workspace dependency) |
| `embed` | Rust | `include_str!` / `include_bytes!` / `include!` of a repo file |

- `ALL_KINDS`: all 13, the walks' default.
- `LOAD_KINDS` = `import, reexport, require, mod, cargo-dep`: the edges that order loading; `cycles()`'s default. A Rust `use` and
  a Python `import-local` are no load order (modules of one crate name each other freely; a function-level import breaks a cycle).
- `FAN_KINDS` = every kind but `package-init`: `fans()`'s default.

### How an import was resolved (`how`, most to least certain)

| how | meaning |
|---|---|
| `exact` | one target by the language's own rule with no search: a relative ESM path with its extension, a Python relative import, a Rust `mod x;` or `#[path]` |
| `probed` | the language rule with a search and exactly one hit: extension / `index.*` probing, the Python roots, the longest module prefix of a Rust `use` path |
| `config` | taken from a manifest: package.json `imports` / `exports` / workspaces, tsconfig / jsconfig `paths`, Cargo dependencies, maturin `module-name` |
| `name` | a name match with no rule behind it (only a `#[pymodule]` function name to a Python import) |
| `ambiguous` | several targets by the rule: the edge points to the nearest, `alts` lists the rest |
| `external`, `unresolved` | not edges: rows of `unresolved` (above) |

## What it contains

### Which files (exclusion, one rule: engine/code-rs/src/exclude.rs)

The git-tracked blobs at the commit, minus (and each listed in `files` with `excluded` / `why`):
(a) a path with a segment `third_party`, `vendor` or `node_modules` -> 'vendored';
(b) a path `.gitattributes` marks `linguist-vendored` -> 'vendored', or `linguist-generated` -> 'generated';
(c) a file whose first 5 lines carry `@generated` or `DO NOT EDIT` -> 'generated';
(d) `code.exclude` globs -> 'config'. Not wired yet: the project config has no `code` key, so the reader passes none (a follow-up).

### Resolution per language

- **JavaScript / TypeScript** (`.js .mjs .cjs .jsx .ts .tsx .mts .cts`): relative with an extension `exact`; without one, probe
  `.ts .tsx .mts .cts .js .mjs .cjs .jsx`, then `/index.*` (`probed`; also a TS import of a `.js` path whose file is the `.ts` one); `#name` through the nearest
  package.json `imports` (`config`); a workspace package or the package itself by name / `exports`, and tsconfig / jsconfig
  `paths` (`config`); any other bare name `external`; a non-literal `import(x)` `unresolved` / 'dynamic'.
- **Python**: roots per pyproject.toml (`[tool.maturin] python-source`, `[tool.setuptools.packages.find] where`, else `src/` when it
  holds a package, else the pyproject folder), then the repo root; a test folder with `conftest.py` is a root for its own loose
  modules. `import a.b.c` by the PathFinder rule (`.py`, `__init__.py`, `.pyi`, namespace folders), the importing file's own
  project's roots first: one hit `probed`, several `ambiguous`; relative imports `exact`. `from a.b import c` is the submodule `c`
  when it exists, else `a.b`. Each import also gives `package-init` edges to the ancestor `__init__.py` files. A Rust extension
  module through maturin `module-name` (`native`, `config`) or a `#[pymodule]` name (`native`, `name`). Anything else `external`.
- **Rust**: crates from every Cargo.toml (workspace members, package and `[lib] name`, `package =` renames, the targets src/lib.rs,
  src/main.rs, src/bin/*.rs, tests/*.rs, examples/, benches/, build.rs, explicit `path =`). The mod tree from each target root
  (`exact`, inline `mod a { mod b; }` and `#[path]` included); `use` trees expanded (groups, globs), `crate` / `self` / `super`
  inside the crate, a path or workspace dependency's lib name to that crate's root (`config`), the longest module prefix to its
  file; Cargo path dependencies as `cargo-dep`. Limits: modules that macros generate are invisible, and `cfg` is not evaluated.

## Symbols

`symbols()` and `references()` (and `norn-code query symbols | refs`) answer from the blob facts and the tree's name index; they
index the asked commit first when the store lacks it, like `graphAt`, and take `at` / `worktree` the same way (no `noIndex`).

```
Def  { id, file, name, qual, kind, line, end_line, col, exported, hash, tokens }
       line..end_line: the definition node's exact bounds, 1-based, inclusive; col: 1-based column of its first character
       kind: 'function' | 'method' | 'class' | 'struct' | 'enum' | 'trait' | 'module' | 'const' | 'impl'
       qual / id: below; exported: below; hash: 16 hex, the normalised body hash (below); tokens: the body's leaf-token count
Ref  { file, line, col, name, def_ids?, how? }
       one occurrence of the identifier `name` (line / col 1-based); def_ids + how 'unique' only when exactly one definition
       in the tree has the name (inferred by name, not resolved); else both absent
```

- **Which definitions**: the grammar's `TAGS_QUERY` plus our patterns: JS / TS functions, classes, methods, class fields and
  module-level `const`s holding a function (kind 'function'), other module-level `const`s ('const'), TS interfaces ('trait'),
  enums, namespaces ('module'); Python functions, classes, methods (a function directly in a class body); Rust fn, struct / union
  ('struct'), enum, trait, trait fn signatures and impl fns ('method'), impl blocks ('impl'), mod, const / static ('const'). Not
  definitions: Rust `macro_rules!` and type aliases, JS `let` / `var` that hold no function, JS constructors.
- **qual**: JS / TS `file#Path` (`src/a.mjs#Shape.area`); Python `module.Path` (`fx.models.Model`, the file's `module`); Rust
  `module::Path` (`crate::cli::Args`, `crate::shapes::<Square as Area>::area`; an orphan file: the path alone). An inherent `impl T`
  has the qual of `T`.
- **id** = `file + "#" + qual + "#" + n`, n counting the same qual earlier in the file (so an impl after its struct is `#1`).
- **exported** (lane slop-langs reads it for K4, unused exports): Rust: a plain `pub` (`pub(crate)` and the rest: false). Python:
  the name is public (no leading `_`; dunders are public) and, when the module has `__all__`, listed in it; a nested definition only
  as a method of a public class. JS / TS: a top-level definition in an `export` statement, an `export { }` clause, `export default
  <identifier>` or a CommonJS `exports.x =` / `module.exports = { }`; a method of an exported class or interface (not `#private`);
  any other nested definition false.
- **hash** (lane slop-langs reads it for K9, copied helpers, with `line..end_line` as the span): FNV-1a 64 over the definition
  node's leaf tokens, comments and whitespace left out, the definition's own name read as `$`. Two definitions with the same body
  under different names (and different comments or layout) share it; nothing else is needed to find a copy.
- **References**: through the snapshot's name index (name -> the files whose blobs hold that identifier, kept for every name a
  first-party definition has), every identifier occurrence of `name` in those files, the definitions' own name nodes left out.
  Rows capped at `LIMITS.rows` (`truncated`).
- n/a: an unknown file (`unknown file F (not in the graph; ...)`), a name no definition has (`no definition in the tree is named N`).

## Call edges

`callers()` (and `norn-code query callers`) resolves every call site of the asked commit's tree at query time, from the blob facts
(call sites, import bindings, class bases) and the snapshot's files and import edges; like `symbols()` it indexes the asked commit
first when the store lacks it and takes `at` / `worktree` (no `noIndex`).

```
Caller { file, line, col, name, how, candidates, targets, more?, why?, caller: Def | null, depth, trust }
         line / col: the callee name's position (1-based) in `f()`, `x.f()`, `a::f()`, `new F()`; name: the callee as written
         how: one of CALL_HOWS (below); candidates: how many definitions the site may call (0 for external / unresolved)
         targets: their Def ids, sorted, at most 20 (CANDIDATES_MAX), the rest counted in `more`; why: the reason of an
         external / unresolved site; caller: the innermost definition holding the site (its Def without hash / tokens / exported),
         null at top level; depth: 1 for a direct caller, n for a caller of a depth n-1 caller; trust: TRUST['<lang>/call/<how>']
```

The call table (`how`, `CALL_HOWS`), tried in this order per form of call:

| how | rule |
|---|---|
| `local` | `f()`: a definition named f in an enclosing scope of the same file (innermost first; a class or impl body is no scope for the methods in it; a Rust inline module ends the climb). Methods are never local |
| `import` | `f()`: f is bound by an import (`import { f }`, `import d from` with the target's `export default` name, `const { f } = require()`, `from m import f`, `use m::f`, aliases included), followed to the target module's top-level definition, through re-exports (`export { } from`, `export * from`, `__init__` imports, `from m import *`, `pub use`, `use m::*`) up to 8 hops |
| `qualified` | `m.f()` where m is an imported module (or `pkg.mod` through `import pkg.mod`), `Class.f()` (a local or imported class: its method, then its bases'), `crate::m::f()`, `super::f()`, `m::f()`, `Type::f()` (inherent, then `<Type as Trait>::f`) |
| `self` | Python `self.f()` / `cls.f()`, JS `this.f()` in a class (a JS `self` / `cls` is an ordinary name): that class's method f, then its bases' by name (Python superclasses, JS `extends`); Rust `self.f()` / `Self::f()` in an impl or trait: the methods f of that type (inherent and trait impls) in the crate |
| `method-unique` | `x.f()` on a receiver of unknown type where exactly one repo method (same language) is named f |
| `ambiguous` | more than one candidate from any rule above, or `x.f()` where several repo methods are named f: all are listed, none is chosen |
| `external` | builtins (Python builtins, JS globals, the Rust prelude), the standard library and packages: an import that resolves outside the repo, a Rust path headed by `std` / `core` / `alloc` or a crate not in the workspace, and `x.f()` where no repo method is named f |
| `unresolved` | none of the above, with its `why`: a name bound nowhere in the file (a parameter, a local variable, a global), a path with no definition, an enum variant, a site inside a parse error (`parse-error`) |

- Inferred, not compiled: names and scopes only; no type inference (so `x.f()` is method-unique or ambiguous by name), no
  conditional or dynamic imports followed beyond the file graph.
- An ambiguous site is a row under every one of its candidates; `candidates` says how many share it.
- n/a: a symbol id no definition has (`no definition has the id`), `file:name` naming several definitions (`defines N named
  x; name one by id: ...`) or none, an unknown file.

## Trust

The precision of each `(language, level, how)` class, keyed `<lang>/file/<how>` and `<lang>/call/<how>` in `TRUST` and copied onto
every `Edge.trust` and `Caller.trust`. Stages S4a (file level) and S4b (calls) measure them against compiler-grade indexers; until
then every class reads `"unmeasured"`, never a made-up number. Lane refactor-targets reads `Caller.trust`.

| language | exact | probed | config | name | ambiguous |
|---|---|---|---|---|---|
| javascript | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured |
| typescript | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured |
| python | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured |
| rust | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured |

Call edges (`<lang>/call/<how>`): every language, every how of `CALL_HOWS`: unmeasured.

## Store and freshness

```
<state>/code/graph/
  blobs/v3/<aa>/<blob sha>.json   per-blob facts (a pure function of the blob and the store schema): imports, defs (with bases), names, calls, binds; shared by every commit and worktree
  trees/v3/<tree sha>.json        one resolved snapshot per root tree: files, edges, unresolved, the name index
  commits.json                    the newest 200 indexed commits: { commit, tree, indexed_at (unix s), ms, parsed, reused, counts }
  HEAD                            the newest indexed commit
```

- A snapshot is keyed by the root tree's sha: two commits with the same content share it, and an unchanged blob is never parsed
  again. Lane worktrees share the repo's objects, so a branch at main + 3 commits parses only the blobs those commits changed.
- `v3` is the store schema (`norn-code version` prints it; rustbin.mjs `CODE_STORE_SCHEMA`); a snapshot of another schema is
  never read.
- Writes are atomic (tmp then rename); a tree has a lock, and a second writer waits for it, then reads the snapshot.
- `--worktree` answers are resolved in memory and never stored as a tree.
- Freshness: an answer is always for the commit asked (indexed on demand) unless `noIndex` is given, and then `stamp.exact` says
  so. `norn code history` (run by the tick when HEAD moves) indexes HEAD first, because its `fan_in` is `fans()`.
- No garbage collection yet: the store keeps every tree it wrote (a follow-up).

## Thresholds

The reader's, in `LIMITS` (engine/lib/codegraph.mjs):

| name | value | meaning |
|---|---|---|
| `LIMITS.rows` | 500 | the most rows one answer holds; the rest is counted in `truncated` (a number, 0 when complete) and printed `+N more` |
| `LIMITS.index_ms` | 120000 | the longest wait for one `norn-code index` run |

norn-code's, in engine/code-rs/src/limits.rs:

| name | value | meaning |
|---|---|---|
| `STORE_SCHEMA` | 3 | the store's extractor schema |
| `SPEC_MAX` | 120 | an edge's `spec` keeps at most this many characters |
| `GENERATED_LINES` | 5 | the header lines exclusion rule (c) reads |
| `LOCK_WAIT_MS` | 30000 | a second writer of a tree waits this long for the first one's lock |
| `COMMITS_KEPT` | 200 | rows commits.json keeps |
| `CANDIDATES_MAX` (calls.rs) | 20 | a call site lists at most this many candidates; the rest is counted in `more` |
| `FOLLOW_MAX` (calls.rs) | 8 | a follow of re-exports / use paths stops after this many hops (unresolved) |

## CLI: `norn code graph <verb>`

```
norn code graph index                                          -> { stamp, files, edges, unresolved, parsed, reused, ms }   (counts)
norn code graph deps       <file> [--depth N] [--kinds K,..]   -> dependencies()
norn code graph dependents <file> [--depth N] [--kinds K,..]   -> dependents()
norn code graph cycles     [--within GLOB]... [--kinds K,..]   -> cycles()
norn code graph reach      <file>... [--forward] [--to GLOB]...  -> reach() (reverse by default: what depends on these)
norn code graph symbols    <file>                              -> symbols()     text: kind, qual, file:line..end_line, "exported"
norn code graph refs       <name>                              -> references()  text: the defs, then file:line:col [-> id (unique)]
norn code graph callers    <symbol id | file:name> [--depth N]  -> callers()   text: depth, file:line:col, how [of N: ids], in <caller qual>
norn code graph status                                         -> graphStatus()
common: [--project P | --state D] [--repo DIR] [--at REV] [--worktree] [--no-index] [--json]
exit:   0 answer; 2 usage; 3 n/a ({ ok: false, why } on stdout with --json, else "n/a: <why>" on stderr)
```

- `--json` prints the function's object exactly as above (one line). Without it: the stamp line first,
  `at <commit, 12 hex> (<age>), exact` (or `asked <rev>`, and `, worktree (N changed)`), then one row per line, `+N more` when truncated.
- The store: `--state D`, or the state of `--project P` / the project found from the current folder; with none, the repo's own
  `<git common dir>/norn`. `--repo DIR` (default: the project's folder, else the current folder) picks the repo. File arguments
  are repo-root-relative.
- `symbols` / `refs` / `callers` index the asked commit when needed: `--no-index` with them is a usage error (exit 2).
- `index` with `parsed` / `reused` / `ms` of the run it made (0 / null / the read time when already stored).
- `status`: `{ built, binary, why? (why norn-code is not usable), store_schema, store, head, indexed: [the newest 5 commits.json rows, indexed_at as ISO] }`.

## A consumer: `norn code card` (RM-a-57)

`norn code card <file>.. [--json] [--project P | --state D] [--repo DIR]` answers "what is this file before I read it?" in at most
`CARD_LIMITS.tokens` per file (engine/lib/codecard.mjs, no model), from this doc's reader (`graphAt` with `noIndex: true`, `dependents`,
`fans`), the code signals' reader (`readSignals`, docs/code-signals.md) and the tests index (`<state>/tests/impact.json`, `testsFor`).
File paths are relative to the project folder (the graph's file is `prefix + file`).

- **What**: the graph's `lang` (else "not a graph language") and the file's lines on disk; an excluded file says its rule.
- **Used by**: the count of files importing it (depth 1, `ALL_KINDS`) and the top `dependents` of them, most depended-on first (their own
  `fans().in`), then by path.
- **Changes with**: the signals' `partners` (`shared/landings`), at most `partners`; **fixes**: `n_90d`, `n_365d` and the last fix, or the
  signals' n/a with its reason; **tests**: the test files the impact map says cover it ("none cover it" when known and none).
- **Indexed**: the graph's commit and age (", newest stored" when `stamp.exact` is false), the signals' sha and age, the tests index's sha
  and age; every part is measured. A part whose index does not exist (no graph store, no signals, no impact map, or a file the index does
  not hold) reads `not indexed`, and `--json` carries the reason in `not_indexed`. No part starts an index run.
- Over the cap, the longest list loses its last entry first (counted in `+N more`), then the fix subject shortens.
- `--json`: `{ cap, not_indexed: { graph, signals, tests }, cards: [{ file, lang, lines, excluded?, dependents: { n, top } | { na },
  partners: [{ file, shared, landings }] | { na }, fixes: { n_90d, n_365d, last } | { na }, tests: [file] | { na }, stamps, basis, text, tokens }] }`.

Workers get it as the MCP tool `norn_code_card` (`{ files: [path] }`, worker profile) under the per-project switch `policy.code.card`:
`off` (the default) gives it to no run; `ab` gives it to every worker run with an even run number (group `card`) and not to the odd ones
(group `control`). A worker's MCP server records its run's group on its first `tools/list` in `<state>/code/card/<RUN>.json`.
`norn code card --report [--json]` compares the finished marked runs of both groups: tokens per run (cost.mjs `usageOfRun`), distinct files
read per run (the transcript's Read calls, readev.mjs), the done rate, with the group sizes and the runs it could not measure. Under
`min_group` runs in either group it prints `too few runs: card N, control M (15 each needed)` and exits 1. The owner decides from it.

Thresholds (`CARD_LIMITS` in engine/lib/codecard.mjs, the one place):

| key | value | meaning |
|---|---|---|
| `tokens` | 400 | a card's most tokens (estimated) |
| `chars_per_token` | 4 | the estimate: characters / this |
| `dependents` | 5 | importers named |
| `partners` | 5 | partners named |
| `tests` | 5 | test files named |
| `subject` | 72 | the last fix's subject keeps at most this many characters |
| `min_group` | 15 | the report compares only from this many finished runs per group |

## A consumer: `norn code targets` (RM-a-65)

`norn code targets [--top N] [--json] [--project P | --state D] [--repo DIR]` turns SloppaChoppa's size numbers into refactoring briefs a
lane can run (engine/lib/codetargets.mjs, no model), from this doc's reader (`graphAt`, `cycles`, `symbols`, `callers`, `references`),
the code signals' reader (`readSignals`, docs/code-signals.md) and the tests index (`testsFor`). It proposes; it never edits.

- **Split file**: a code file over the file ratchet (measure.mjs `FILE_CAP`). Its top-level symbols (a Rust impl joins its type) are
  linked by their call sites (an ambiguous site weighs 1 / its candidates) and const references inside the file, then grouped by greedy
  modularity. The largest group stays; a group moves when it has `min_group_lines` lines, `min_group_symbols` symbols and at most
  `max_cut` of its edges crossing. Each moving group names its symbols, a proposed new file and the files that would change their import.
- **Break cycle**: an import cycle (`cycles`). The edge to cut is the one with the fewest symbols that would have to move: the symbols of
  `to` that `from` uses plus what they call inside `to`. They move into `from` when nothing else uses them, else into a proposed new file.
  A cut whose movers use another file of the cycle (or `from` itself, when they go to a new file) is no cut: they would import it again.
  When no edge is left the cycle reads n/a with that reason.
- **Extract function**: a function over the function ratchet (`CAPS`). JS gets the measure numbers and its largest nested block; Python and
  Rust get only the line count from the Def bounds and the block reads n/a ("the measure run is JS only").
- **Rank**: the fix-first rank of the target's file (a cycle: the highest of its files). With no signals every rank reads n/a with the
  reason and the order is by kind (split, cycle, extract), then code lines, then path. Candidates are judged lazily in rank order, so a
  short `--top` reads only what it prints.
- Each target prints as a brief: a title, the symbols that move, `Scope:` (the files touched), `Tests:` (from the tests index, or n/a with
  the reason), `Done:`. Every answer is `inferred` and carries the graph's commit, the signals' sha and the tests index's sha.
- It stores its answer in `<state>/code/targets.json`; the Slop page's To fix view lists the top `page` targets with "copy as brief".
- `--json`: `{ at, basis, stamp: { graph, graph_exact, signals, tests }, limits, rank_na?, targets: [{ kind, file, rank, title, scope,
  tests, text, ... }], na: [{ kind, file, why }], judged, candidates }`.

Thresholds (`TARGET_LIMITS` in engine/lib/codetargets.mjs, the one place; the ratchets are measure.mjs's `CAPS` and `FILE_CAP`):

| key | value | meaning |
|---|---|---|
| `top` | 10 | targets printed by default |
| `page` | 5 | targets the Slop page lists |
| `workers` | 8 | reader calls at once (at most half the cores) |
| `min_group_lines` | 60 | a group moves out only from this many lines |
| `min_group_symbols` | 2 | ... and this many top-level symbols |
| `max_cut` | 0.25 | ... and when at most this share of its call edges cross to the rest of the file |
| `groups_max` | 3 | groups proposed per split |
| `per_file` | 3 | extract targets per file (the largest excess first; the rest counted) |
| `tests` | 8 | test files a Tests line names; past it, those named for a Scope file and the `norn tests for` line |
