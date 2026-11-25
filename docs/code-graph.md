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
import { graphAt, dependencies, dependents, cycles, reach, fans, excluded, symbols, defsByHash, references, callers, graphStatus, ALL_KINDS, LOAD_KINDS, FAN_KINDS, CALL_HOWS, TRUST, LIMITS } from '<norn>/engine/lib/codegraph.mjs';
const g = graphAt({ state, repo, at: 'HEAD' });   // Graph | { ok: false, why }
if (!g.ok) return na(g.why);
dependents(g, 'engine/lib/a.mjs', { depth: 2 });
```

Nothing in the reader throws for a graph that cannot be had (norn-code not built for its source, not a git work tree, unknown rev, an
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
| `symbols({ state = null, repo, files, at = 'HEAD', worktree = false })` | `{ stamp, files: { [file]: { defs: Def[] } | { ok: false, why } } }`: the same for many files in ONE norn-code run; a file that has no symbols to give (unknown, excluded, not a graph language) is its own `{ ok: false, why }` row, the others still answered; `file` and `files` together, or an empty `files`, is `{ ok: false }` |
| `defsByHash({ state = null, repo, hashes, at = 'HEAD', worktree = false })` | `{ stamp, defs: { [hash]: Def[] }, truncated }`: the definitions of the tree's first-party sources (a graph language, not excluded) whose `hash` is one asked, in ONE norn-code run; every asked hash is a key (`[]` when no definition has it); each list in file, then source order, capped at `LIMITS.rows` (`truncated`: the cut ones over all hashes) |
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
  inside the crate (in an inline `mod`, `self` / `super` start at that module: each Rust binding's facts carry its `mod`), a path or workspace dependency's lib name to that crate's root (`config`), the longest module prefix to its
  file; Cargo path dependencies as `cargo-dep`. Limits: modules that macros generate are invisible, and `cfg` is not evaluated.

## Symbols

`symbols()`, `defsByHash()` and `references()` (and `norn-code query symbols | hash | refs`) answer from the blob facts and the tree's name index; they
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
  under different names (and different comments or layout) share it; nothing else is needed to find a copy. `defsByHash()` finds
  every definition sharing a hash in one run: it reads the blob facts of each first-party source of the tree (no index of its own,
  so no store schema change; measured S5, below), where a `symbols()` per file paid a process start and a snapshot read each.
- **Batch reads** (S5, for lane slop-langs' K9 pool): `symbols({ files })` sends the paths on norn-code's stdin
  (`norn-code query symbols --stdin`, `query hash --stdin` for the hashes, one per line: a list too long for a command line).
  Measured on a 20-core Windows machine, warm store, one call each (`symbols()` per file before, the new calls after):

  | repo (first-party py / rs / ts files under the K9 root) | before: one `symbols()` per file | `symbols({ files })` | `defsByHash()` (20 hashes) |
  |---|---|---|---|
  | Norn @ 9f56fa45 (15 files) | 5.1 s (341 ms a call) | 0.27-0.61 s | 0.46-1.55 s |
  | a private project (1,981 files) | ~750 s (379 ms a call, 100 timed) | 1.1-2.0 s | 0.71-1.07 s |
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
| `method-unique` | `x.f()` on a receiver of unknown type where exactly one repo method (same language) is named f. JS / TS: only while the receiver's local binding does not say otherwise; when it is a literal, a `new` or a TS type whose class lacks f, the result of a call that is not f's owner (its class, or the function whose object holds it), or a package / builtin value, the site is `ambiguous` with that one candidate and a `why` (S6) |
| `ambiguous` | more than one candidate from any rule above, or `x.f()` where several repo methods are named f: all are listed, none is chosen; or a JS `method-unique` candidate the receiver's binding contradicts (one candidate, with its `why`) |
| `external` | builtins (Python builtins, JS globals, the Rust prelude), the standard library and packages: an import that resolves outside the repo, a Rust path headed by `std` / `core` / `alloc` or a crate not in the workspace, and `x.f()` where no repo method is named f |
| `unresolved` | none of the above, with its `why`: a name bound nowhere in the file (a parameter, a local variable, a global; a Rust `f()` whose f is a `let`, a parameter or a pattern binding of an enclosing block before the call, which shadows any def or import of f), a path with no definition, an enum variant, a site inside a parse error (`parse-error`) |

- Inferred, not compiled: names and scopes only; no type inference (so `x.f()` is method-unique or ambiguous by name), no
  conditional or dynamic imports followed beyond the file graph.
- An ambiguous site is a row under every one of its candidates; `candidates` says how many share it.
- n/a: a symbol id no definition has (`no definition has the id`), `file:name` naming several definitions (`defines N named
  x; name one by id: ...`) or none, an unknown file.

## Trust

The precision of each `(language, level, how)` class, keyed `<lang>/file/<how>` and `<lang>/call/<how>` in `TRUST` and copied onto
every `Edge.trust` and `Caller.trust`. Stages S4a (file level) and S4b (calls) measure them against each language's toolchain. A
value is the measured precision (a number in 0..1), `"below bar"` when the class measured under its bar (consumers drop it; whether
to adopt a precise tool instead is owner question Q3, never automatic), or `"unmeasured"` when no row of the class was graded (never a
made-up number). Lane refactor-targets reads `Caller.trust`.

### File edges (S4a): `norn-code grade files`

`norn-code grade files [--seed N] [--per-lang N] --graders <norn>/tools/grade --repo D --state S [--at REV]` grades the commit's
edges and unresolved imports (the files on disk must be that commit's) and writes `<state>/code/grade/<commit>.json`; a number
without that file is not a result. Per language, a seeded draw of `GRADE_PER_LANG` rows stratified by `how` (equal shares; a small
stratum whole, its leftover spread over the others; a smaller population graded whole). The graders (tools/grade, pinned like
tools/lint, installed into Norn's tool cache, never imported by the engine):
- JavaScript / TypeScript: Node's resolver from the importing file (`import.meta.resolve` for ESM, `createRequire().resolve` for
  `require`); a TS importer, a `type` import and the TS-only specifiers Node cannot load (extensionless, folder) through
  `ts.resolveModuleName` of the pinned typescript 6.0.3 (tsconfig / jsconfig options, else Bundler); workspace packages as npm would
  link them.
- Python: `importlib.machinery.PathFinder.find_spec`, step by step over the roots norn-code declares for the file, on uv's pinned
  Python (tools/grade/manifest.json); a stdlib name is outside the repo. A `native` edge (a Rust extension) has no PathFinder truth:
  n/a, counted.
- Rust: `rustc --emit=dep-info` per crate target of `cargo metadata --no-deps` (as a library and as its `--test` harness, every
  feature's cfg on; no build, no build script, no fetch): `mod` / `embed` targets must be in the crate's dep-info; a `use` /
  `extern crate` target in the dep-info of the crate its path names (`crate` / `self` / `super`: the same crate; a path dependency:
  that crate's library; membership, not the module within it); `cargo-dep` the dependency's `path`. Host cfg only: a cfg-gated
  `mod` the host does not compile is n/a.

An edge is right when its target is among the grader's files. A row the grader loads an in-repo file for is a recall unit, hit when
our edge names that file (an `external` / `unresolved` row there is a miss). Precision per class, recall per class and per language
(the strata weighted back to the population), each with its Wilson 95 % interval. Dynamic imports are counted, not graded. Bars
(SPEC 5): precision >= 99 % per class, recall >= 98 % per language, on the point estimate.

Measured 2026-11-25 (seed 1, 400 rows per language). Norn @ 67f997cb (grade file `67f997cb...json` in Norn's state; its tree holds
the fixtures, so TypeScript and Python there are fixture rows); prism (a private project) @ 4c3b5e24 (a `git archive` copy, grade file 7e39ea91...json):

| class | sample | graded | precision [95 %] | recall [95 %] | trust |
|---|---|---|---|---|---|
| javascript/exact | Norn | 196 of 2,733 | 100 % [98.1, 100] | 100 % | 1 |
| javascript/probed | Norn | 2 of 2 | 100 % [34.2, 100] | 100 % | 1 |
| javascript/config | Norn | 5 of 5 | 100 % [56.6, 100] | 100 % | 1 |
| javascript/ambiguous | Norn | 1 of 1 | 100 % [20.7, 100] | 100 % | 1 |
| javascript/external | Norn | 195 of 1,948 | - | 0 missed | - |
| javascript (language) | Norn | 204 edges, 109 dynamic | 100 % [98.2, 100] | 100 % [98.2, 100] | |
| typescript/probed | Norn (fixture) | 2 of 2 | 100 % [34.2, 100] | 100 % | 1 |
| python/exact | prism | 94 of 1,116 | 100 % [96.1, 100] | 100 % | 1 |
| python/probed | prism | 94 of 9,908 | 100 % [96.1, 100] | 100 % | 1 |
| python/ambiguous | Norn (fixture) | 1 of 1 | 100 % [20.7, 100] | 100 % | 1 |
| python/config, python/name | prism | 0 (12 + 93 sampled `native`: n/a) | - | - | unmeasured |
| python/external | prism | 94 of 7,574 | - | 0 missed | - |
| python (language) | prism | 188 edges | 100 % [98.0, 100] | 100 % [98.0, 100] | |
| rust/exact | prism | 97 of 1,407 | 100 % [96.2, 100] | 100 % | 1 |
| rust/probed | prism | 97 of 2,498 | 100 % [96.2, 100] | 100 % | 1 |
| rust/config | prism | 95 of 950 (1 n/a) | 100 % [96.1, 100] | 100 % | 1 |
| rust/external | prism | 97 of 2,649 | - | 2 missed | - |
| rust (language) | prism | 289 edges, 3 dynamic | 100 % [98.7, 100] | 98.9 % [96.9, 99.6] | |
| rust (Norn's crates, census) | Norn | 50 of 50 edges | 100 % [92.9, 100] | 100 % | |

The 2 Rust misses: a file under a crate's `tests/support/` naming the crate's own library (`use coreengine::...`) reads `external`.
No class is below the bar. The fixtures grade 100 % in every class (tests/code-graph-grade.test.mjs).

### Call edges (S4b): `norn-code grade calls`

`norn-code grade calls [--seed N] [--per-lang N] --graders <norn>/tools/grade --repo D --state S` grades the commit's definition
bounds and call edges and writes `<state>/code/grade/<commit>.calls.json` (the file level keeps `<commit>.json`). The graders (tools/grade,
pinned with hashes, installed into Norn's tool cache, never imported by the engine):
- JavaScript / TypeScript: scip-typescript 0.6.2 (npm lock) over a copy of the tree's JS / TS files with the workspace packages
  linked and a written tsconfig (`allowJs`, Bundler): its own `--infer-tsconfig` drops JS once one .ts exists and skips .mjs.
- Python: jedi 0.20.1 (tools/grade/jedi.lock.txt, hashes) on uv's pinned Python, `goto` per sampled call site and per file of the
  sampled definitions.
- Rust: rust-analyzer's `scip` command (release 2026-11-23, the zip's sha256 per platform in tools/grade/rust-analyzer.lock.json) per
  cargo workspace, its target dir in a temp folder removed after.

SCIP is decoded in norn-code with the `scip` crate 0.10.0. Method:
- Definitions: per language a seeded draw of `GRADE_PER_LANG` stratified by kind. One is right when the grader's definition of that
  name inside our bounds spans our `line..end_line`. The grader's start is taken past leading attributes, decorators and comments,
  since rust-analyzer's range holds `#[..]` and doc comments and the tree-sitter node does not; such rows count as
  `exact_past_attributes`. Recall: a seeded draw of the grader's own function / method / class / struct / enum / trait / interface
  definitions, found when one of ours of that name holds the line. Python's recall pool is the files of the sampled definitions (jedi
  runs per file, so it is a cluster sample).
- Calls: a draw stratified by `how`. The grader's target (file, line, name) is mapped onto our innermost definition of that name
  holding the line (a JS `constructor` onto its class). Precision is per chosen how (`local`, `import`, `qualified`, `self`,
  `method-unique`) over the sites the grader resolves inside the repo. A site whose grader target lies outside the repo is counted
  `outside`, not graded. Recall units are the sites whose grader target maps onto one of our definitions; an `ambiguous`, `external`
  or `unresolved` site there is a miss. `ambiguous`, `external` and `unresolved` choose no target, so they have no precision
  (`TRUST` keeps them "unmeasured"); `contains` counts the ambiguous sites whose candidates hold the target.
- n/a, with its reason, never a guess: the grader has no occurrence at the site (JS: an untyped receiver), jedi found nothing, an
  impl block (no grader definition), the grader gives no bounds (a JS `const`), a file the grader did not index.

Bars (SPEC 5, `DEF_*` / `CALL_*`): definitions 99 % precision per kind and 99 % recall per language. Calls: precision per
`(language, how)` class at 90 % (Rust 85 %), recall per language at 70 % (Rust 60 %), all on the point estimate.

Measured 2026-11-25 (seed 1, 400 per language). Norn @ dcade05c (grade file `dcade05c...calls.json` in Norn's state; Python and
TypeScript there are the fixtures). prism (a private project) @ 7e39ea91 (the `git archive` copy of S4a; no JavaScript / TypeScript
in it). `TRUST` takes JavaScript from Norn, Python and Rust from prism. Regraded after S6 (the receiver-binding vet, Rust local
variables, the grader's n/a on a symbol of several definitions): Norn @ cbb4d12d and prism @ 7e39ea91 again; the rows marked S6 are
from it.

| class | sample | graded | precision [95 %] | recall | trust |
|---|---|---|---|---|---|
| javascript/def/class | Norn | 31 of 31 | 100 % [89.0, 100] | | |
| javascript/def/function | Norn | 105 of 8,532 (48 n/a) | 100 % [96.5, 100] | | |
| javascript/def/method | Norn | 5 of 64 (59 n/a: no bounds) | 100 % [56.5, 100] | | |
| javascript/def/const | Norn | 0 (152 n/a: no bounds) | - | | |
| javascript defs (language) | Norn | 141 | 100 % [97.4, 100] | 100 % [99.1, 100] of 400 | |
| typescript defs (class, enum, function, method, trait) | Norn (fixture) | 6 of 10 | 100 % [61.0, 100] | 100 % [67.6, 100] of 8 | |
| python/def/class | prism | 100 of 3,661 | 100 % [96.3, 100] | | |
| python/def/function | prism | 100 of 21,689 | 100 % [96.3, 100] | | |
| python/def/method | prism | 100 of 12,673 | 100 % [96.3, 100] | | |
| python/def/const | prism | 0 (100 n/a: jedi has no definition inside the bounds) | - | | |
| python defs (language) | prism | 300 | 100 % [98.7, 100] | 100 % [99.1, 100] of 400 | |
| rust/def/const | prism | 49 of 4,121 | 100 % [92.7, 100] | | |
| rust/def/enum | prism | 50 of 249 | 100 % [92.9, 100] | | |
| rust/def/function | prism | 50 of 11,336 | 100 % [92.9, 100] | | |
| rust/def/method | prism | 50 of 6,496 | 100 % [92.9, 100] | | |
| rust/def/module | prism | 14 of 1,065 (36 n/a) | 100 % [78.5, 100] | | |
| rust/def/struct | prism | 51 of 1,965 | 100 % [93.0, 100] | | |
| rust/def/trait | prism | 44 of 45 | 100 % [92.0, 100] | | |
| rust/def/impl | prism | 0 (51 n/a: no grader definition) | - | | |
| rust defs (language) | prism | 308 | 100 % [98.8, 100] | 99.3 % [97.8, 99.7] of 400 | |
| rust defs (language) | Norn | 356 | 100 % [98.9, 100] | 100 % [98.9, 100] of 330 | |
| javascript/call/local | Norn | 66 of 22,855 | 100 % [94.5, 100] | 66 of 66 | 1 |
| javascript/call/import | Norn | 66 of 14,804 | 100 % [94.5, 100] | 66 of 66 | 1 |
| javascript/call/qualified | Norn | 1 of 2 | 100 % [20.6, 100] | 1 of 1 | 1 |
| javascript/call/self | Norn | 2 of 2 | 100 % [34.2, 100] | 2 of 2 | 1 |
| javascript/call/method-unique | Norn (S6) | 2 of 421 (37 outside, 27 n/a) | 0 % [0, 65.8] | - | below bar |
| javascript/call/ambiguous | Norn | 66 sampled of 639 | - | 0 of 41 (contains 40) | unmeasured |
| javascript calls (language) | Norn | 145 | 99.6 % [96.7, 100] | 96.3 % [92.4, 98.2] | |
| typescript/call/* | Norn (fixture) | no call site | - | - | unmeasured |
| python/call/local | prism | 50 of 36,083 | 100 % [92.9, 100] | 50 of 50 | 1 |
| python/call/import | prism | 50 of 29,069 | 100 % [92.9, 100] | 50 of 50 | 1 |
| python/call/qualified | prism | 50 of 3,557 | 100 % [92.9, 100] | 50 of 50 | 1 |
| python/call/self | prism | 50 of 5,044 | 100 % [92.9, 100] | 50 of 50 | 1 |
| python/call/method-unique | prism | 21 of 20,965 (15 outside, 14 n/a) | 100 % [84.5, 100] | 21 of 21 | 1 |
| python/call/ambiguous | prism | 50 sampled of 34,124 | - | 0 of 27 (contains 27) | unmeasured |
| python calls (language) | prism | 221 | 100 % [98.3, 100] | 81.8 % [76.5, 86.1] | |
| python calls (language) | Norn (fixture) | 31 | 100 % [89.0, 100] | 100 % [89.0, 100] | |
| rust/call/local | prism (S6) | 49 of 20,666 (1 n/a) | 100 % [92.7, 100] | - | 1 |
| rust/call/import | prism (S7) | 50 of 6,565 | 100 % [92.9, 100] | 50 of 50 | 1 |
| rust/call/qualified | prism (S7) | 49 of 6,616 | 100 % [92.7, 100] | 49 of 49 | 1 |
| rust/call/self | prism | 49 of 3,070 | 100 % [92.7, 100] | 49 of 49 | 1 |
| rust/call/method-unique | prism | 19 of 28,940 (29 outside, 2 n/a) | 100 % [83.2, 100] | 19 of 19 | 1 |
| rust/call/ambiguous | prism | 50 sampled of 44,074 | - | 0 of 12 (contains 12) | unmeasured |
| rust/call/unresolved | prism (S7) | 50 sampled of 11,504 | - | 0 of 5 | unmeasured |
| rust calls (language) | prism (S7) | 216 | 100 % [98.3, 100] | 80.1 % [74.5, 84.8] | |
| rust calls (language) | Norn | 223 | 100 % [98.3, 100] | 98.2 % [95.5, 99.3] | |

Below the bar: `javascript/call/method-unique`. At dcade05c each graded `x.close()` / `x.at()` / `x.start()` site resolved by name
to the one repo method of that name while the receiver was bound to another value. S6 vets the receiver's local binding (above): the
class shrinks from 1,005 to 421 sites, but of 66 drawn only 2 have an in-repo grader target and both are wrong (`f.app.close()`: a
property chain, whose value no local binding tells); 37 of the 66 resolve outside the repo. It stays "below bar" in `TRUST`. Rust on
prism after S6: the `local` miss of S4b was the grader's (rust-analyzer gives two same-named fns nested in sibling fns one SCIP
symbol, so its target named the first for every call of either; such a site is now n/a "several definitions"); the closure that
shadowed an import (seabed.rs:1427 class) is `unresolved` (a local variable). S7: the last `import` miss (deposit.rs:929, `use super::*` inside an
inline `mod tests` read against the file's parent module, so a fn of the file lost to a same-named module) is gone: a Rust binding
records its inline `mod`, and `self` / `super` (in a `use` or a call path) start there. The grader indexes a copy of the Cargo packages (2.7 s on prism), never the checkout. No definition is wrong; on prism the grader's start
sits on an attribute or doc comment above ours for 24 to 49 of each Rust kind's 50 (`exact_past_attributes`). The fixtures grade
with no wrong definition and no wrong chosen call edge (tests/code-graph-grade.test.mjs).

## Store and freshness

```
<state>/code/graph/
  blobs/v5/<aa>/<blob sha>.json   per-blob facts (a pure function of the blob and the store schema): imports, defs (with bases), names, calls, binds; shared by every commit and worktree
  trees/v5/<tree sha>.json        one resolved snapshot per root tree: files, edges, unresolved, the name index
  commits.json                    the newest 200 indexed commits: { commit, tree, indexed_at (unix s), ms, parsed, reused, counts }
  HEAD                            the newest indexed commit
```

- A snapshot is keyed by the root tree's sha: two commits with the same content share it, and an unchanged blob is never parsed
  again. Lane worktrees share the repo's objects, so a branch at main + 3 commits parses only the blobs those commits changed.
- `v5` is the store schema (`norn-code version` prints it; rustbin.mjs `CODE_STORE_SCHEMA`); a snapshot of another schema is
  never read.
- Writes are atomic (tmp then rename); a tree has a lock, and a second writer waits for it, then reads the snapshot.
- `--worktree` answers are resolved in memory and never stored as a tree.
- Freshness: an answer is always for the commit asked (indexed on demand) unless `noIndex` is given, and then `stamp.exact` says
  so. `norn code history` (run by the tick when HEAD moves) indexes HEAD first, because its `fan_in` is `fans()`.
- No garbage collection yet: the store keeps every tree it wrote (a follow-up).

### The norn-code binary (rustbin.mjs)

```
<git common dir of the engine's clone>/norn/rust/
  bin/norn-code-<source sha12>[.exe]   the binary of one source content of engine/code-rs (every file but target/, Cargo.lock included)
  target/code/                         cargo's one target dir for the part (--target-dir): its incremental cache, shared by every checkout
  code.lock                            the part's build lock (below); hook.lock is norn-hook's
```

- What reads which binary: every reader (codegraph.mjs, the supervisor, `norn done`, setup, smoke, the hooks of a claude run)
  reads `bin/<bin>-<source sha12>` through `binOf`. A checkout's own engine/code-rs/target/release (or engine/hook-rs/...), which a
  plain `cargo build` in the crate writes, is read by nothing since #235; nor is `target/code/release/norn-code` itself, which is
  only the file a build copies from.
- The clean before each build: cargo names a package's build state in the shared target dir without the crate's path, so a build
  of one checkout's sources can be called fresh after another checkout's build of the same package, and that checkout's binary
  copied out under this source's hash (measured with a two-source crate on cargo 1.90, 1.96 and 1.100: B built after A is "fresh"
  and runs as A). So a part with no binary for its sources runs cargo's own `cargo clean -p <bin> --release --locked --target-dir
  <target> --manifest-path <this source's Cargo.toml>` (rustbin.mjs `cleanOf`; the package is named as its bin), then the build:
  this crate always compiles, its dependencies stay built. `--locked` because a clean without it may rewrite the source's Cargo.lock
  (measured: it added cargo's header to a lock without one), which changes the source and so its binary's name. Norn assumes no layout of cargo's target dir (cargo 1.100 keeps a package's state
  under `release/build/<package>/<hash>/` and has no `release/.fingerprint`, which 1.90 and 1.96 have); the clean is cargo's to do,
  and it gave each source its own binary on all three. A failed clean is the ONE reason, like a failed build (`... did not build
  (cargo clean exit N: ...); clean command: ...; build command: ...`). tests/rustbin.test.mjs proves it with real cargo. Measured
  on a 20-core Windows machine (2026-11-25, cargo 1.100): clean + build of norn-hook 3.8 s (a cold build 3.6 s: it has no
  dependencies); of norn-code 88-97 s (the clean 0.8 s, then the crate and its LTO link) against a cold build of 109 s.
- The build lock: builds of different sources of one part share the one output file `target/<part>/release/<bin>`, and cargo's
  own lock covers its build only. Between its release and the copy-out, another checkout's build could replace that file, and the
  wrong binary would be stored under this source's hash. `ensurePart` and `ensurePartAsync` hold `<store>/<part>.lock` (records.mjs
  `withLock` / `withLockAsync`) from before the clean until the content-named file is in place:
  - a part whose file exists takes no lock; a second build of the SAME sources waits, then finds the file and builds nothing;
  - a lock older than `BUILD_MS` + 2 min (rustbin.mjs `LOCK`: a holder's cargo dies at `BUILD_MS`) is a dead holder's and is
    broken; a waiter gives up after twice that, with ONE reason naming the lock file;
  - the async form waits on a timer, so a supervisor that waits keeps its heartbeat; the sync form (setup, smoke) blocks.
- Path length on Windows, measured (2026-11-25, this Cargo.lock, a cold build of engine/code-rs into `<x>/.git/norn/rust/target/code`
  with every file it created logged, short-lived ones included): the longest path below the clone folder is 178 characters
  (`.git\norn\rust\target\code\release\build\tree-sitter-javascript\<16 hex>\out\tree_sitter_javascript-<16 hex>.tree_sitter_javascript.<16 hex>-cgu.0.rcgu.o`,
  a rustc object that is gone once the build ends); the longest file a finished target dir keeps is 134. Windows' MAX_PATH is 259
  characters plus the terminator, so a clone whose folder is at most 81 characters long (259 - 178) builds with no file past it.
  rustc itself writes longer paths, but the MSVC linker does not: a cold clone under a 124-character folder failed with LNK1104 on
  a 262-character file (138 below the clone). A crate or Cargo.lock change can move these numbers; keep a clone's folder short.

- One store for the main checkout and every lane worktree of the clone: a worktree whose engine/code-rs equals main's reads the
  same file and builds nothing. A change to code-rs (a pull, or a lane's own edit) names a new file; the old one stays for the
  runs still using it.
- A process pins the hash of its own engine's sources the first time it asks (`binOf`), so a supervisor whose checkout is pulled
  under it keeps reading the binary of the engine it loaded, whose store schema matches its reader.
- Built when missing by `norn setup`, by every run start (when the run's end check reads the graph) and before the run end's slop
  check, through `ensurePart` / `ensureParts`. A part that cannot be had (no cargo, no C compiler, a failed build) is ONE reason
  naming the part, the cause and the build command: the run does not start, the branch is held "could not check".
- Measured on a 20-core Windows machine: a cold build 224 s and 166 MB of target/, an incremental one 114 s (lto, one codegen
  unit), a no-op 0.4 s; the binary is 7.3 MB.

## Thresholds

The reader's, in `LIMITS` (engine/lib/codegraph.mjs):

| name | value | meaning |
|---|---|---|
| `LIMITS.rows` | 500 | the most rows one answer holds; the rest is counted in `truncated` (a number, 0 when complete) and printed `+N more` |
| `LIMITS.index_ms` | 120000 | the longest wait for one `norn-code index` run |

norn-code's, in engine/code-rs/src/limits.rs:

| name | value | meaning |
|---|---|---|
| `STORE_SCHEMA` | 5 | the store's extractor schema |
| `SPEC_MAX` | 120 | an edge's `spec` keeps at most this many characters |
| `GENERATED_LINES` | 5 | the header lines exclusion rule (c) reads |
| `LOCK_WAIT_MS` | 30000 | a second writer of a tree waits this long for the first one's lock |
| `COMMITS_KEPT` | 200 | rows commits.json keeps |
| `CANDIDATES_MAX` (calls.rs) | 20 | a call site lists at most this many candidates; the rest is counted in `more` |
| `FOLLOW_MAX` (calls.rs) | 8 | a follow of re-exports / use paths stops after this many hops (unresolved) |
| `GRADE_PER_LANG` | 400 | `grade files` / `grade calls`: rows drawn per language |
| `GRADE_SEED` | 1 | `grade files`: the seed when none is given (the grade file records the one used) |
| `FILE_PRECISION_BAR` / `FILE_RECALL_BAR` | 0.99 / 0.98 | the file-edge bars: precision per class, recall per language |
| `DEF_PRECISION_BAR` / `DEF_RECALL_BAR` | 0.99 / 0.99 | `grade calls`: definition bounds, precision per (language, kind), recall per language |
| `CALL_PRECISION_BAR` / `CALL_RECALL_BAR` | 0.90 / 0.70 | `grade calls`: call edges of JavaScript / TypeScript / Python, precision per (language, how), recall per language |
| `CALL_PRECISION_BAR_RUST` / `CALL_RECALL_BAR_RUST` | 0.85 / 0.60 | the same for Rust |
| `WILSON_Z` | 1.96 | the Wilson interval's z (95 %) |

## CLI: `norn code graph <verb>`

```
norn code graph index                                          -> { stamp, files, edges, unresolved, parsed, reused, ms }   (counts)
norn code graph deps       <file> [--depth N] [--kinds K,..]   -> dependencies()
norn code graph dependents <file> [--depth N] [--kinds K,..]   -> dependents()
norn code graph cycles     [--within GLOB]... [--kinds K,..]   -> cycles()
norn code graph reach      <file>... [--forward] [--to GLOB]...  -> reach() (reverse by default: what depends on these)
norn code graph symbols    <file>                              -> symbols()     text: kind, qual, file:line..end_line, "exported"
norn code graph symbols    <file> <file>...                    -> symbols({ files })  text: per file its path, then its defs indented (or "<file>  n/a: <why>")
norn code graph hash       <body hash>...                      -> defsByHash()  text: per hash the hash, then its defs indented ("none")
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
- `symbols` / `hash` / `refs` / `callers` index the asked commit when needed: `--no-index` with them is a usage error (exit 2).
- `symbols` with 2+ files exits 0 when some file is n/a: that file's row says why.
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
