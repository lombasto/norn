// The code graph's ONE reader (SPEC code-graph 7.1; the contract is docs/code-graph.md). graphAt reads the file-level snapshot norn-code
// (engine/code-rs, rustbin.mjs part `code`) wrote for a commit's tree under <state>/code/graph/, indexing that commit first when the
// store does not hold it, so every answer is for the commit asked and carries a stamp saying which one. The other functions are pure
// over a Graph: dependencies / dependents (walks), cycles (Tarjan), reach (multi-source walk), fans (distinct fan-in / fan-out) and
// excluded. Nothing throws for a graph that cannot be had: { ok: false, why } instead, never a partial or guessed answer. Paths are
// relative to the REPO root (git ls-tree --full-tree); a project in a subfolder of a monorepo maps its own paths with Graph.prefix.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fwd } from './config.mjs';
import { readJsonS } from './fsnap.mjs';
import { globToRe } from './dlvgit.mjs';
import { binOf, buildOf, partProblem, CODE_STORE_SCHEMA as STORE_SCHEMA } from './rustbin.mjs';

/** every edge kind norn-code writes; LOAD_KINDS order loading (cycles' default); FAN_KINDS count for fan-in / fan-out */
export const ALL_KINDS = ['import', 'reexport', 'require', 'dynamic', 'type', 'import-local', 'package-init', 'native', 'mod', 'use', 'extern-crate', 'cargo-dep', 'embed'];
export const LOAD_KINDS = ['import', 'reexport', 'require', 'mod', 'cargo-dep'];
export const FAN_KINDS = ALL_KINDS.filter(k => k !== 'package-init');
export const LANGS = ['javascript', 'typescript', 'python', 'rust'];
export const HOWS = ['exact', 'probed', 'config', 'name', 'ambiguous'];
/** the how classes of a call site (docs/code-graph.md "Call edges"); `unresolved` carries its why */
export const CALL_HOWS = ['local', 'import', 'qualified', 'self', 'method-unique', 'ambiguous', 'external', 'unresolved'];
/** the file-level precision measured by `norn-code grade files` (S4a; docs/code-graph.md "Trust" has the intervals, commits and dates):
 *  JavaScript / TypeScript on Norn @ 67f997cb, Python and Rust on a private project (prism) @ 4c3b5e24 (Python `ambiguous` on Norn's fixture rows) */
const FILE_MEASURED = { 'javascript/file/exact': 1, 'javascript/file/probed': 1, 'javascript/file/config': 1, 'javascript/file/ambiguous': 1, 'typescript/file/probed': 1,
  'python/file/exact': 1, 'python/file/probed': 1, 'python/file/ambiguous': 1, 'rust/file/exact': 1, 'rust/file/probed': 1, 'rust/file/config': 1 };
/** the call-edge precision measured by `norn-code grade calls` (S4b; docs/code-graph.md "Trust" > "Call edges" has the intervals, commits and
 *  dates): JavaScript on Norn @ dcade05c, Python and Rust on a private project (prism) @ 7e39ea91; ambiguous / external / unresolved choose
 *  no target, so they have no precision (unmeasured; their misses are in the recall); TypeScript had no call site to grade */
const CALL_MEASURED = { 'javascript/call/local': 1, 'javascript/call/import': 1, 'javascript/call/qualified': 1, 'javascript/call/self': 1, 'javascript/call/method-unique': 'below bar',
  'python/call/local': 1, 'python/call/import': 1, 'python/call/qualified': 1, 'python/call/self': 1, 'python/call/method-unique': 1,
  'rust/call/local': 0.9787, 'rust/call/import': 0.98, 'rust/call/qualified': 1, 'rust/call/self': 1, 'rust/call/method-unique': 1 };
/** the precision of each (language, level, how) class, `<lang>/file/<how>` and `<lang>/call/<how>`: measured by stages S4a / S4b of RM-a-53
 *  (a number in 0..1; "below bar" when under SPEC 5's bar: consumers drop it), "unmeasured" when no graded row (never a made-up number) */
export const TRUST = Object.fromEntries(LANGS.flatMap(l => [...HOWS.map(h => [`${l}/file/${h}`, FILE_MEASURED[`${l}/file/${h}`] ?? 'unmeasured']), ...CALL_HOWS.map(h => [`${l}/call/${h}`, CALL_MEASURED[`${l}/call/${h}`] ?? 'unmeasured'])]));
/** the reader's thresholds, the one named place: rows = the most rows an answer holds (the rest is counted in `truncated`);
 *  index_ms = the wait for one norn-code index run (SPEC 6's hard cap of a cold index is 20 s) */
export const LIMITS = { rows: 500, index_ms: 120000 };

const TS = /\.(?:ts|tsx|mts|cts)$/i, LANG = { py: 'python', rs: 'rust' };
const EXCLUDED = w => (/^(?:path segment|linguist-vendored)/.test(w) ? 'vendored' : /^(?:linguist-generated|generated header)/.test(w) ? 'generated' : 'config');
const no = why => ({ ok: false, why });
const git = (dir, args) => { const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000 }); return r.status === 0 ? r.stdout.trim() : null; };
const treeFile = (store, tree) => path.join(store, 'trees', `v${STORE_SCHEMA}`, `${tree}.json`);
/** the state folder norn-code writes <state>/code/graph under: the one given, else <git common dir>/norn (null: not a git work tree) */
const stateOf = ({ state, repo }) => { if (state) return state; const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']); return common && path.join(common, 'norn'); };
const headOf = store => { try { return fs.readFileSync(path.join(store, 'HEAD'), 'utf8').trim(); } catch { return null; } };

/** norn-code <args> [stdin lines] -> its JSON line | { ok: false, why } (its own why when it printed one: an unknown file, a name no def has) */
function code(args, lines = null) {
  const r = spawnSync(binOf('code'), args, { encoding: 'utf8', windowsHide: true, timeout: LIMITS.index_ms, maxBuffer: 1 << 30, ...(lines ? { input: lines.join('\n') } : {}) });
  let j = null; try { j = JSON.parse(r.stdout); } catch { /* no JSON: said below */ }
  if (j && (r.status === 0 || j.ok === false)) return j;
  return no(`norn-code ${args[0]} failed (${r.error?.code || `exit ${r.status}`}): ${String(r.stderr || '').trim().split('\n').slice(-2).join(' ') || 'printed no JSON'}`);
}
const index = args => code(['index', ...args]);
/** the repo root, its prefix, the store and the asked commit -> { root, prefix, st, store, commit, tree, stamp(c, t, ms, extra) } | { ok: false, why } */
function locate({ state, repo, at, worktree, noIndex }) {
  if (!repo) return no('no repo folder given');
  const root = git(repo, ['rev-parse', '--show-toplevel']);
  if (root === null) return no(`not a git work tree: ${repo}`);
  const prefix = git(repo, ['rev-parse', '--show-prefix']) ?? '', st = stateOf({ state, repo: root }), store = path.join(st, 'code', 'graph');
  if (worktree && at !== 'HEAD') return no('--worktree resolves uncommitted work over HEAD: no other rev');
  const commit = git(root, ['rev-parse', '--verify', '--quiet', `${at}^{commit}`]), tree = commit && git(root, ['rev-parse', `${commit}^{tree}`]);
  if (!commit) return no(`unknown rev ${at} in ${root}`);
  const bad = noIndex && !worktree ? null : partProblem('code');
  if (bad) return no(`${bad}: run norn setup (${buildOf('code')})`);
  const stamp = (c, t, ms, extra = {}) => ({ commit: c, tree: t, indexed_at: new Date(ms).toISOString(), age_s: Math.max(0, Math.round((Date.now() - ms) / 1000)), asked: at, exact: c === commit, worktree, ...extra });
  return { ok: true, root, prefix, st, store, commit, tree, stamp };
}
/** a snapshot -> Graph (the rows typed per docs/code-graph.md; trust joined from TRUST) */
function graphOf(snap, stamp, root, prefix, indexed) {
  const files = new Map(Object.entries(snap.files).map(([f, x]) => {
    const lang = x.lang === 'js' ? (TS.test(f) ? 'typescript' : 'javascript') : LANG[x.lang] ?? null;
    return [f, { lang, excluded: x.excluded ? EXCLUDED(x.excluded) : null, ...(x.excluded ? { why: x.excluded } : {}), ...(x.crate ? { crate: x.crate } : {}), ...(x.module ? { module: x.module } : {}),
      ...(x.orphan ? { orphan: true } : {}), ...(x.parse_error ? { parse_error: true } : {}) }];
  }));
  const edges = snap.edges.map(e => ({ ...e, trust: TRUST[`${files.get(e.from)?.lang}/file/${e.how}`] ?? 'unmeasured' }));
  return { ok: true, stamp, root, prefix, files, edges, unresolved: snap.unresolved, indexed };
}

/**
 * the file-level graph of `repo` (any folder of a git work tree) at `at` -> Graph | { ok: false, why }. state: the store's folder
 * (<state>/code/graph); none = <git common dir>/norn, shared by every worktree of the repo. worktree: uncommitted work resolved over
 * HEAD (stamp.dirty: the changed files). noIndex: never index; the asked commit's snapshot, else the store's newest (stamp.exact false).
 * Graph.indexed: what the norn-code run this call made did ({ parsed, reused, ms }), null when the store already held the snapshot.
 */
export function graphAt({ state = null, repo, at = 'HEAD', worktree = false, noIndex = false } = {}) {
  const w = locate({ state, repo, at, worktree, noIndex });
  if (!w.ok) return w;
  const { root, prefix, st, store, commit, tree, stamp } = w;
  const ran = r => ({ parsed: r.parsed, reused: r.reused ?? null, ms: r.ms });
  if (worktree) {
    const r = index(['--repo', root, '--state', st, '--worktree']);
    return r.ok ? graphOf(r.snapshot, stamp(commit, tree, Date.now(), { dirty: r.changed }), root, prefix, ran(r)) : r;
  }
  let f = treeFile(store, tree), indexed = null;
  if (!fs.existsSync(f)) {
    if (noIndex) {   // the store's newest snapshot, said to be another commit's
      const head = headOf(store);
      const row = head && (readJsonS(path.join(store, 'commits.json')) || []).find(e => e.commit === head);
      if (!row || !fs.existsSync(treeFile(store, row.tree))) return no(`commit ${commit.slice(0, 12)} is not indexed and the store holds no other (--no-index): run norn code graph index`);
      f = treeFile(store, row.tree);
      const snap = readJsonS(f);
      return snap ? graphOf(snap, stamp(row.commit, row.tree, fs.statSync(f).mtimeMs), root, prefix, null) : no(`unreadable snapshot ${f}`);
    }
    const r = index(['--repo', root, '--state', st, ...(at === 'HEAD' ? [] : ['--at', commit])]);
    if (!r.ok) return r;
    indexed = ran(r);
  }
  const snap = readJsonS(f);
  if (!snap || snap.schema !== STORE_SCHEMA) return no(`unreadable snapshot ${f}`);
  return graphOf(snap, stamp(commit, tree, fs.statSync(f).mtimeMs), root, prefix, indexed);
}

/** norn-code query <verb> <flag> [target] over the asked commit (indexed first when the store lacks it); lines: its stdin (a batch's
 *  files or hashes) -> { stamp, ...its answer } | { ok: false, why } */
function query(q, { state = null, repo, at = 'HEAD', worktree = false }, extra = [], lines = null) {
  const w = locate({ state, repo, at, worktree, noIndex: false });
  if (!w.ok) return w;
  const r = code(['query', ...q, ...extra, '--repo', w.root, '--state', w.st, ...(worktree ? ['--worktree'] : at === 'HEAD' ? [] : ['--at', w.commit])], lines);
  if (!r.ok) return r;
  const { ok, commit, tree, worktree: _w, changed, ...answer } = r;
  return { stamp: w.stamp(commit, tree, worktree ? Date.now() : fs.statSync(treeFile(w.store, tree)).mtimeMs, worktree ? { dirty: changed } : {}), ...answer };
}
/** the definitions of `file` (repo-root-relative) at `at`, in source order -> { stamp, file, defs: Def[] } | { ok: false, why }; with
 *  `files` instead, many files in ONE norn-code run -> { stamp, files: { [file]: { defs: Def[] } | { ok: false, why } } } (one file's n/a
 *  is its own row, the others still answered) */
export function symbols({ state = null, repo, file, files, at = 'HEAD', worktree = false } = {}) {
  const o = { state, repo, at, worktree };
  if (file && files) return no('give file or files, not both');
  if (files) return files.length ? query(['symbols', '--stdin'], o, [], files) : no('no files given');
  return file ? query(['symbols', '--file', file], o) : no('no file given');
}
/** the definitions of the tree's first-party sources whose normalised body hash (Def.hash) is one of `hashes`, in one norn-code run ->
 *  { stamp, defs: { [hash]: Def[] }, truncated } | { ok: false, why }: every asked hash a key ([] when no definition has it), each list
 *  in file then source order and capped at LIMITS.rows (the cut ones counted in `truncated`, over all hashes) */
export function defsByHash({ state = null, repo, hashes, at = 'HEAD', worktree = false } = {}) {
  if (!hashes?.length) return no('no hashes given');
  const r = query(['hash', '--stdin'], { state, repo, at, worktree }, [], hashes);
  if (r.ok === false) return r;
  const defs = Object.fromEntries(Object.entries(r.defs).map(([h, ds]) => [h, ds.slice(0, LIMITS.rows)]));
  return { stamp: r.stamp, defs, truncated: Object.values(r.defs).reduce((n, ds) => n + Math.max(0, ds.length - LIMITS.rows), 0) };
}
/** the definitions named `name` and every other occurrence of the identifier, found through the tree's name index ->
 *  { stamp, name, defs: Def[], rows: Ref[], truncated } | { ok: false, why } (a name no definition has is n/a) */
export function references({ state = null, repo, name, at = 'HEAD', worktree = false } = {}) {
  if (!name) return no('no name given');
  const r = query(['refs', '--name', name], { state, repo, at, worktree });
  return r.ok === false ? r : { stamp: r.stamp, name: r.name, defs: r.defs, ...capped(r.refs) };
}

const langOf = f => (TS.test(f) ? 'typescript' : LANG[path.extname(f).slice(1)] || 'javascript');
/** the call sites whose candidates hold `symbol` (a Def id, or `<file>:<name>` when the file has one def of that name), and with depth > 1
 *  the callers of each calling def in turn -> { stamp, symbol: Def, rows: Caller[], truncated } | { ok: false, why }. An ambiguous site is
 *  listed under every candidate, with its count and list; no candidate is ever picked for it */
export function callers({ state = null, repo, symbol, depth = 1, at = 'HEAD', worktree = false } = {}) {
  if (!symbol) return no('no symbol given');
  const r = query(['callers', '--symbol', symbol], { state, repo, at, worktree }, depth > 1 ? ['--depth', String(depth)] : []);
  if (r.ok === false) return r;
  const rows = r.callers.map(c => ({ ...c, trust: TRUST[`${langOf(c.file)}/call/${c.how}`] }));
  return { stamp: r.stamp, symbol: r.symbol, ...capped(rows) };
}

const kindsOf = kinds => new Set(kinds);
/** from -> [edges] over the kinds; reverse: to -> [edges] */
function adjacency(g, kinds, reverse) {
  const ks = kindsOf(kinds), m = new Map();
  for (const e of g.edges) if (ks.has(e.kind) && e.from !== e.to) { const k = reverse ? e.to : e.from; (m.get(k) || m.set(k, []).get(k)).push(e); }
  return m;
}
const capped = rows => ({ rows: rows.slice(0, LIMITS.rows), truncated: Math.max(0, rows.length - LIMITS.rows) });
/** a breadth-first walk from the start files -> [{ file, depth, via, path }] in walk order (each file once, at its least depth) */
function walk(g, starts, { depth = Infinity, kinds, reverse }) {
  const adj = adjacency(g, kinds, reverse), seen = new Map(starts.map(s => [s, null])), out = [];
  let front = starts.map(s => ({ file: s, path: [s] }));
  for (let d = 1; d <= depth && front.length; d++) {
    const next = [];
    for (const { file, path: p } of front) for (const e of [...(adj.get(file) || [])].sort((a, b) => ((reverse ? a.from : a.to) < (reverse ? b.from : b.to) ? -1 : 1))) {
      const to = reverse ? e.from : e.to;
      if (seen.has(to)) continue;
      const row = { file: to, depth: d, via: e, path: [...p, to] }; seen.set(to, row); out.push(row); next.push(row);
    }
    front = next;
  }
  return out;
}
const unknown = (g, file) => (g.files.has(file) ? null : no(`unknown file ${file} (not in the graph at ${g.stamp.commit.slice(0, 12)}; paths are relative to the repo root)`));
const deps = (g, file, { depth = 1, kinds = ALL_KINDS } = {}, reverse) => unknown(g, file)
  ?? { stamp: g.stamp, file, ...capped(walk(g, [file], { depth, kinds, reverse }).map(({ file: f, depth: d, via }) => ({ file: f, depth: d, via }))) };
/** what `file` imports, to `depth` hops -> { stamp, file, rows: [{ file, depth, via: Edge }], truncated } | { ok: false, why } */
export const dependencies = (g, file, o) => deps(g, file, o, false);
/** what imports `file` (the edges reversed): the same shape */
export const dependents = (g, file, o) => deps(g, file, o, true);
/** everything that reaches the files (reverse, the default: what depends on them) or that they reach (reverse false); `to`: only rows
 *  matching these globs -> { stamp, rows: [{ file, depth, path: [start, ..., file] }], truncated } */
export function reach(g, files, { reverse = true, kinds = ALL_KINDS, to = null } = {}) {
  for (const f of files) { const u = unknown(g, f); if (u) return u; }
  const rows = walk(g, files, { kinds, reverse }).filter(r => !to || to.some(x => globToRe(x).test(r.file))).map(({ file, depth, path: p }) => ({ file, depth, path: p }));
  return { stamp: g.stamp, ...capped(rows) };
}

/** Tarjan's strongly connected components over the files matching `within` (globs; null = every file): a component of 2+ files, or a
 *  file importing itself, is a cycle -> { stamp, cycles: [[file, ...]] } (each cycle sorted, the list by its first file) */
export function cycles(g, { within = null, kinds = LOAD_KINDS } = {}) {
  const res = within && within.map(globToRe), inside = f => !res || res.some(r => r.test(f)), ks = kindsOf(kinds), adj = new Map(), self = new Set();
  for (const e of g.edges) {
    if (!ks.has(e.kind) || !inside(e.from) || !inside(e.to)) continue;
    if (e.from === e.to) self.add(e.from);
    (adj.get(e.from) || adj.set(e.from, new Set()).get(e.from)).add(e.to);
  }
  let n = 0; const idx = new Map(), low = new Map(), on = new Set(), stack = [], out = [];
  const visit = v => {   // recursive: an import chain deeper than the stack is no real tree
    idx.set(v, n); low.set(v, n); n++; stack.push(v); on.add(v);
    for (const to of adj.get(v) || []) {
      if (!idx.has(to)) { visit(to); low.set(v, Math.min(low.get(v), low.get(to))); }
      else if (on.has(to)) low.set(v, Math.min(low.get(v), idx.get(to)));
    }
    if (low.get(v) === idx.get(v)) {
      const c = []; let w;
      do { w = stack.pop(); on.delete(w); c.push(w); } while (w !== v);
      if (c.length > 1 || self.has(v)) out.push(c.sort());
    }
  };
  for (const v of [...adj.keys()].sort()) if (!idx.has(v)) visit(v);
  return { stamp: g.stamp, cycles: out.sort((a, b) => (a[0] < b[0] ? -1 : 1)) };
}

/** per file of the graph its distinct importers (in) and distinct imports (out) over the kinds -> Map(file -> { in, out }) */
export function fans(g, { kinds = FAN_KINDS } = {}) {
  const ks = kindsOf(kinds), out = new Map([...g.files.keys()].map(f => [f, { in: 0, out: 0 }])), seen = new Set();
  for (const e of g.edges) {
    const k = `${e.from}\0${e.to}`;
    if (!ks.has(e.kind) || e.from === e.to || seen.has(k)) continue;
    seen.add(k); (out.get(e.from) || out.set(e.from, { in: 0, out: 0 }).get(e.from)).out++; (out.get(e.to) || out.set(e.to, { in: 0, out: 0 }).get(e.to)).in++;
  }
  return out;
}
/** why the graph leaves `file` out (its exclusion rule, e.g. "path segment vendor"), or null (a graph file, or one it does not know) */
export const excluded = (g, file) => g.files.get(file)?.why ?? null;

/** the store and the binary -> { built, binary, why?, store_schema, store, head, indexed: [the newest 5 commits.json rows] } | { ok: false, why } */
export function graphStatus({ state = null, repo } = {}) {
  const st = stateOf({ state, repo }), store = st && path.join(st, 'code', 'graph');
  if (!store) return no(`not a git work tree: ${repo}`);
  const bad = partProblem('code'), head = headOf(store);
  return { built: !bad, binary: fwd(binOf('code')), ...(bad ? { why: bad } : {}), store_schema: STORE_SCHEMA, store: fwd(store), head,
    indexed: (readJsonS(path.join(store, 'commits.json')) || []).slice(0, 5).map(e => ({ ...e, indexed_at: new Date(e.indexed_at * 1000).toISOString() })) };
}
