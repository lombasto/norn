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
/** the precision of each (language, level, how) class, `<lang>/file/<how>`: measured by stage S4 of RM-a-53, "unmeasured" before (never a made-up number) */
export const TRUST = Object.fromEntries(LANGS.flatMap(l => HOWS.map(h => [`${l}/file/${h}`, 'unmeasured'])));
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

/** norn-code index (args) -> its JSON line | { ok: false, why } */
function index(args) {
  const r = spawnSync(binOf('code'), ['index', ...args], { encoding: 'utf8', windowsHide: true, timeout: LIMITS.index_ms, maxBuffer: 1 << 30 });
  if (r.error || r.status !== 0) return no(`norn-code index failed (${r.error?.code || `exit ${r.status}`}): ${String(r.stderr || '').trim().split('\n').slice(-2).join(' ')}`);
  try { return JSON.parse(r.stdout); } catch { return no('norn-code index printed no JSON'); }
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
