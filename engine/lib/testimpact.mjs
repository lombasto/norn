// RM-a-55 impacted-tests: the pytest and cargo half of `norn tests index` (testindex.mjs writes the one index). Code only, no model.
// Discovery: pytest test files (test_*.py, *_test.py) and their cases (module-level test* functions, test* methods of Test* classes,
// node ids file::Class::test_x); cargo cases (`#[test]` / `#[<path>::test]` functions in any non-excluded .rs file of a crate, named by
// their module path as libtest names them). The impact map: a test covers a source file when the test's file (and, for pytest, the
// conftest.py files above it) reaches the source through the code graph's import edges (docs/code-graph.md, its reader only). Every
// test row says basis 'inferred' (from the graph); 'measured' is kept for a coverage report and not built here.
import { dependencies, ALL_KINDS } from './codegraph.mjs';

/** the thresholds of this module (docs/TESTING.md "Impacted tests"): light_per = the nearest covering tests a light pick takes per changed source */
export const IMPACT_LIMITS = { light_per: 1 };
export const RUNNERS = ['node:test', 'pytest', 'cargo'];   // the index's runners, in the order every list of them is printed
export const PYTEST_FILE = /(^|\/)(test_[^/]*|[^/]*_test)\.py$/;
const PY_ROOTS = ['pytest.ini', 'pyproject.toml', 'tox.ini', 'setup.cfg'];   // pytest's rootdir files: the folder its command runs in
const dirOf = f => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '');
const relTo = (dir, f) => (dir ? f.slice(dir.length + 1) : f);
const ancestors = f => { const out = []; let d = dirOf(f); for (;;) { out.push(d); if (!d) return out; d = dirOf(d); } };   // nearest first, '' last

// ---------- pytest ----------
const PY_DEF = /^([ \t]*)(?:async[ \t]+)?def[ \t]+(\w+)[ \t]*\(/, PY_CLASS = /^([ \t]*)class[ \t]+(\w+)/, PY_DOC = /^[ \t]*[rbuRBU]?("""|''')\s*(.*?)\s*(?:\1.*)?$/;
/** the pytest cases of one file's text -> [{ id (the pytest node id), file, name, line, lines, desc, runner }] in source order */
export function scanPytest(file, text) {
  const src = String(text ?? '').split(/\r?\n/), out = [], stack = [];   // stack: open class / def blocks { indent, name, kind, ok (a test class chain), row }
  let quote = null;
  const close = (row, end) => { if (row) row.lines = end - row.line + 1; };
  const lastCode = i => { let j = i; while (j > 0 && !src[j - 1].trim()) j--; return j; };   // the last non-blank line number before line i+1
  for (let i = 0; i < src.length; i++) {
    const s = src[i], t = s.trim();
    if (quote) { if ((s.split(quote).length - 1) % 2) quote = null; continue; }
    if (!t || t.startsWith('#')) continue;
    const ind = s.length - s.trimStart().length;
    while (stack.length && stack.at(-1).indent >= ind) close(stack.pop().row, lastCode(i));
    for (const q of ['"""', "'''"]) if ((s.split(q).length - 1) % 2) { quote = q; break; }
    const c = PY_CLASS.exec(s), d = !c && PY_DEF.exec(s);
    if (c) { stack.push({ indent: ind, name: c[2], kind: 'class', ok: /^Test/.test(c[2]) && stack.every(x => x.kind === 'class' && x.ok) }); continue; }
    if (!d) continue;
    const inTests = stack.every(x => x.kind === 'class' && x.ok), name = [...stack.map(x => x.name), d[2]].join('::');
    let row = null;
    if (/^test/.test(d[2]) && inTests) {
      let k = i - 1; while (k >= 0 && /^\s*@/.test(src[k])) k--;
      const doc = PY_DOC.exec(src.slice(i + 1).find(x => x.trim()) ?? ''), above = /^\s*#\s?(.*)$/.exec(src[k] ?? '');
      row = { id: `${file}::${name}`, file, name, line: i + 1, lines: 1, desc: doc?.[2] || above?.[1].trim() || name, runner: 'pytest' };
      out.push(row);
    }
    stack.push({ indent: ind, name: d[2], kind: 'def', row });
  }
  while (stack.length) close(stack.pop().row, lastCode(src.length));
  return out;
}

// ---------- cargo ----------
const TEST_ATTR = /^\s*(?:\w+\s*::\s*)*test\b\s*(?:\(|$)/;
/** the `#[test]` cases of one Rust file -> [{ id, file, name (libtest's path: module::inline mods::fn), line, lines, desc, runner, crate }].
 *  module: the file's module path from the code graph ('crate::a::b'; 'crate' for a target root) */
export function scanRust(file, text, { module = 'crate', crate = null } = {}) {
  const s = String(text ?? ''), out = [], mods = [], base = String(module).split('::').filter(x => x && x !== 'crate');
  let i = 0, line = 1, braces = 0, test = null, fn = null, mod = null, above = '';
  const skip = j => { for (; i < j && i < s.length; i++) if (s[i] === '\n') line++; };
  while (i < s.length) {
    const c = s[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && s[i + 1] === '/') { const e = s.indexOf('\n', i); const t = s.slice(i + 2, e < 0 ? s.length : e).replace(/^[/!]?\s?/, '').trim(); if (t) above = t; skip(e < 0 ? s.length : e); continue; }
    if (c === '/' && s[i + 1] === '*') { let d = 1, j = i + 2; for (; j < s.length && d; j++) { if (s[j] === '/' && s[j + 1] === '*') { d++; j++; } else if (s[j] === '*' && s[j + 1] === '/') { d--; j++; } } skip(j); continue; }
    const raw = /^b?r(#*)"/.exec(s.slice(i, i + 40));
    if (raw) { const e = s.indexOf(`"${raw[1]}`, i + raw[0].length); skip(e < 0 ? s.length : e + 1 + raw[1].length); continue; }
    if (c === '"' || (c === 'b' && s[i + 1] === '"')) { let j = i + (c === 'b' ? 2 : 1); while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1; skip(j + 1); continue; }
    if (c === "'") { if (s[i + 1] === '\\') { const e = s.indexOf("'", i + 2); skip(e < 0 ? s.length : e + 1); } else if (s[i + 2] === "'") skip(i + 3); else i++; continue; }   // a char literal, else a lifetime
    if (c === '#' && (s[i + 1] === '[' || (s[i + 1] === '!' && s[i + 2] === '['))) {
      const o = s.indexOf('[', i); let d = 0, j = o;
      for (; j < s.length; j++) { if (s[j] === '[') d++; else if (s[j] === ']' && !--d) break; }
      if (TEST_ATTR.test(s.slice(o + 1, j))) test ??= { line, desc: above };
      skip(j + 1); continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i; while (j < s.length && /\w/.test(s[j])) j++;
      const w = s.slice(i, j), named = /^\s+[A-Za-z_]/.test(s.slice(j, j + 80)); skip(j);   // `fn(u32)` (a type) names nothing
      if (fn === true) fn = { name: w, test };   // the name after `fn`
      else if (mod === true) mod = { name: w };
      else if (w === 'fn' && named) fn = true;
      else if (w === 'mod' && named) mod = true;
      continue;
    }
    if (c === '{') {
      if (mod && mod !== true) { mods.push({ name: mod.name, depth: braces }); mod = null; }
      if (fn && fn !== true) { fn.depth = braces; if (fn.test) fn.row = { start: fn.test.line, desc: fn.test.desc }; fn.open = true; mods.push({ fn, depth: braces }); fn = null; test = null; }
      braces++; i++; above = ''; continue;
    }
    if (c === '}') {
      braces--; const top = mods.at(-1);
      if (top && top.depth === braces) {
        mods.pop();
        if (top.fn?.row) { const path = [...base, ...mods.filter(m => m.name).map(m => m.name), top.fn.name].join('::');
          out.push({ id: `${file}::${path}`, file, name: path, line: top.fn.row.start, lines: line - top.fn.row.start + 1, desc: top.fn.row.desc || top.fn.name, runner: 'cargo', ...(crate ? { crate } : {}) }); }
      }
      i++; above = ''; continue;
    }
    if (c === ';') { if (mod) mod = null; if (fn) { fn = null; test = null; } }   // `mod x;` / a fn with no body
    i++; above = '';
  }
  return out.sort((a, b) => a.line - b.line);
}
/** the cargo command of one Rust test file: its target when the file is a target root, else a filter by its module path */
function cargoCmd(file, crate, module, crateDir) {
  const r = crateDir ? relTo(crateDir, file) : file, m = String(module).split('::').filter(x => x && x !== 'crate').join('::');
  const t = /^tests\/([^/]+)\.rs$/.exec(r) ?? /^tests\/([^/]+)\/main\.rs$/.exec(r), b = /^src\/bin\/([^/]+)\.rs$/.exec(r) ?? /^src\/bin\/([^/]+)\/main\.rs$/.exec(r);
  return `cargo test -p ${crate}${m ? ` ${m}::` : t ? ` --test ${t[1]}` : b ? ` --bin ${b[1]}` : r === 'src/lib.rs' ? ' --lib' : r === 'src/main.rs' ? ' --bins' : ''}`;
}

// ---------- the impact map over the code graph ----------
/**
 * the pytest + cargo part of the index from a code graph (codegraph.mjs graphAt's Graph). read(f): a repo-root-relative file's text | null;
 * tracked: the repo-root-relative tracked files (for pytest's root files and conftest.py). Paths in the answer are project-relative
 * (g.prefix stripped; files outside the project are left out). -> { cases, files: { test: { lines, cases } }, tests: { test: { runner, basis,
 * dir, cmd?, crate? } }, sources: { source: [tests, nearest first] }, uncovered: [graph files no test reaches], graph: { commit, tree }, partial }
 */
export function graphIndex(g, { read, tracked = [], kinds = ALL_KINDS }) {
  const pre = g.prefix ?? '', inP = f => f.startsWith(pre), own = f => f.slice(pre.length), have = new Set(tracked);
  const cases = [], files = {}, tests = {}, starts = new Map();
  const manifest = (f, names) => ancestors(f).filter(d => d.startsWith(pre.replace(/\/$/, '')) || !pre).find(d => names.some(n => have.has(d ? `${d}/${n}` : n)));
  for (const [f, row] of g.files) {
    if (!inP(f) || row.excluded || (row.lang !== 'python' && row.lang !== 'rust')) continue;
    if (row.lang === 'python' && !PYTEST_FILE.test(f)) continue;
    const text = read(f);
    if (text === null || (row.lang === 'rust' && !text.includes('#['))) continue;
    const cs = row.lang === 'python' ? scanPytest(own(f), text) : scanRust(own(f), text, { module: row.module, crate: row.crate });
    if (!cs.length) continue;
    cases.push(...cs); files[own(f)] = { lines: text.split('\n').length, cases: cs.length };
    if (row.lang === 'python') {
      const dir = manifest(f, PY_ROOTS) ?? pre.replace(/\/$/, '');
      tests[own(f)] = { runner: 'pytest', basis: 'inferred', dir: own(dir) || '.', id: relTo(dir, f) };
      starts.set(f, [f, ...ancestors(f).map(d => (d ? `${d}/conftest.py` : 'conftest.py')).filter(c => inP(c) && g.files.has(c))]);
    } else {
      const crateDir = manifest(f, ['Cargo.toml']) ?? '', ws = ancestors(`${crateDir}/x`).find(d => /^\s*\[workspace\]/m.test(read(d ? `${d}/Cargo.toml` : 'Cargo.toml') ?? '')) ?? crateDir;
      tests[own(f)] = { runner: 'cargo', basis: 'inferred', dir: own(ws) || '.', crate: row.crate, cmd: cargoCmd(f, row.crate, row.module, crateDir) };
      starts.set(f, [f]);
    }
  }
  const partial = new Set(), hits = new Map();   // source -> [[test, depth]]
  const hop = ks => { const memo = new Map(); return f => { if (!memo.has(f)) { const d = dependencies(g, f, { depth: 1, kinds: ks }); memo.set(f, d.ok === false ? [] : d.rows.map(r => r.file)); if (d.truncated) partial.add(own(f)); } return memo.get(f); }; };
  // a Rust `mod x;` declares a child and imports nothing into its parent: the walk takes `mod` edges only down the test file's own
  // module tree (tests/x.rs -> mod common), never out of a crate root it reaches (lib.rs -> every module of the crate)
  // a package __init__.py reached only by its implicit `package-init` edge (importing pkg.a runs pkg/__init__) is a leaf: it is covered,
  // but what it re-exports is not, else every test of a module pulled in its whole package (S2 replay: median full set 829 -> 509, no hit lost)
  const nextMod = hop(kinds.filter(k => k === 'mod')), next = hop(kinds.filter(k => k !== 'mod' && k !== 'package-init')), nextInit = hop(kinds.filter(k => k === 'package-init'));
  const bfs = (seen, front, step, leafStep = () => []) => {
    const open = new Set(front), add = (f, x) => { if (!seen.has(x)) seen.set(x, seen.get(f) + 1); };
    while (front.length) { const n = []; for (const f of front) { for (const x of leafStep(f)) add(f, x); for (const x of step(f)) { add(f, x); if (!open.has(x)) { open.add(x); n.push(x); } } } front = n; }
  };
  for (const [t, st] of [...starts].sort(([a], [b]) => a.localeCompare(b))) {
    const seen = new Map(st.map(s => [s, s === t ? 0 : 1]));   // a conftest.py is one hop from its test
    bfs(seen, [t], nextMod); bfs(seen, [...seen.keys()], next, nextInit);
    for (const [f, d] of seen) if (f !== t && inP(f) && !tests[own(f)]) (hits.get(own(f)) ?? hits.set(own(f), []).get(own(f))).push([own(t), d]);
  }
  const sources = Object.fromEntries([...hits].sort(([a], [b]) => a.localeCompare(b)).map(([f, ts]) => [f, ts.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(x => x[0])]));
  const uncovered = [...g.files].filter(([f, r]) => inP(f) && r.lang && !r.excluded && !tests[own(f)] && !sources[own(f)] && (r.lang === 'python' || r.lang === 'rust')).map(([f]) => own(f)).sort();
  return { cases: cases.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line), files, tests, sources, uncovered, graph: { commit: g.stamp.commit, tree: g.stamp.tree }, partial: [...partial].sort() };
}

// ---------- the answers: runner commands, the light pick ----------
/** the runner command per group of test files (impact.tests rows; a file with no row is a node:test file) -> [{ runner, dir, cmd, tests }] */
export function testGroups(impact, files) {
  const by = new Map();
  for (const t of [...new Set(files)].sort()) {
    const r = impact?.tests?.[t] ?? { runner: 'node:test', dir: '.' }, k = r.runner === 'cargo' ? `cargo ${r.dir} ${r.cmd}` : `${r.runner} ${r.dir}`;
    const g = by.get(k) ?? by.set(k, { runner: r.runner, dir: r.dir ?? '.', ids: [], tests: [], cmd: r.cmd }).get(k);
    g.tests.push(t); g.ids.push(r.id ?? t);
  }
  return [...by.values()].map(g => ({ runner: g.runner, dir: g.dir, tests: g.tests,
    cmd: g.runner === 'pytest' ? `python -m pytest ${g.ids.join(' ')}` : g.runner === 'cargo' ? g.cmd : `norn tests run ${g.ids.join(' ')}` }));
}
export const groupLine = g => `${g.runner}${g.dir && g.dir !== '.' ? ` (in ${g.dir})` : ''}: ${g.cmd}`;
const GRAPH_LANG = /\.(py|rs)$/;
/** the pytest / cargo tests a change picks from impact.json: every changed test file, then per changed source the nearest `per` covering
 *  tests (Infinity: all). -> { tests, none: [changed .py / .rs sources no such test reaches], groups } */
export function pickGraph(impact, changed, { per = IMPACT_LIMITS.light_per } = {}) {
  const rows = impact?.tests ?? {}, graphTest = t => rows[t] && rows[t].runner !== 'node:test', run = new Set(), none = [];
  for (const f of new Set(changed)) {
    if (graphTest(f)) { run.add(f); continue; }
    const ts = (impact?.sources?.[f] ?? []).filter(graphTest).slice(0, per);
    if (!ts.length && GRAPH_LANG.test(f)) none.push(f);
    for (const t of ts) run.add(t);
  }
  const tests = [...run].sort();
  return { tests, none, groups: testGroups(impact, tests) };
}
