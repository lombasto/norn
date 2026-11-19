// TESTS-RUNTIME (owner ask 2026-11-19): the per-test timing table of the Tests tab, for a node:test suite and a pytest suite alike.
// One timer only: the times are the ones `norn tests measure` records (ci-suite --measure for node:test; pytest's --junitxml for pytest),
// folded here into <state>/tests/times.json (one row per leaf test: id, file, group, line, ms, ok and a one-line description read from
// the source - its docstring, the comment right above it, or its name; never written by a model) and <state>/tests/impact.json (source
// file -> the test files that cover it, from the measure's coverage). Pure functions + the pytest runner; node built-ins only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const fwd = s => String(s).split('\\').join('/');
export const TIMES_FILE = 'times.json', IMPACT_FILE = 'impact.json';

// ---------- which suite a folder holds ----------
/** 'node:test' (tests/*.test.mjs) | 'pytest' (tests/**\/test_*.py or *_test.py, two levels deep) | null (neither) */
export function suiteKind(dir) {
  const ls = d => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
  const top = ls(path.join(dir, 'tests'));
  if (top.some(e => e.isFile() && e.name.endsWith('.test.mjs'))) return 'node:test';
  const py = n => /^test_.*\.py$|_test\.py$/.test(n);
  if (top.some(e => e.isFile() && py(e.name)) || top.some(e => e.isDirectory() && ls(path.join(dir, 'tests', e.name)).some(x => x.isFile() && py(x.name)))) return 'pytest';
  return null;
}

// ---------- the pytest measurer ----------
const PY = /^(python(\d+(\.\d+)?)?|py)(\.exe)?$/i;
/** the first word of a command line (quoted or not) */
const firstWord = cmd => { const s = String(cmd ?? '').trim(), m = s.match(/^"([^"]+)"|^'([^']+)'|^(\S+)/); return m ? { word: m[1] ?? m[2] ?? m[3], rest: s.slice(m[0].length).trim() } : null; };
/** the project's own interpreter: the gate command's python (project.json merge.gate.cmd; a merge worktree has no .venv), else the repo's
 *  .venv -> { python, args (the gate's pytest arguments, when it runs `python -m pytest ...`), from } | { error } */
export function pythonOf(gateCmd, repo) {
  const w = firstWord(gateCmd);
  if (w && PY.test(path.basename(w.word))) {
    const m = w.rest.match(/^-m\s+pytest\b\s*(.*)$/);
    return { python: w.word, args: m ? splitArgs(m[1]) : null, from: 'project.json merge.gate.cmd' };
  }
  for (const v of ['.venv/Scripts/python.exe', '.venv/bin/python']) if (fs.existsSync(path.join(repo, v))) return { python: fwd(path.join(repo, v)), args: null, from: `${fwd(repo)}/.venv` };
  return { error: `no python for the pytest suite: project.json merge.gate.cmd is ${gateCmd ? `\`${gateCmd}\` (not a python command)` : 'not set'} and ${fwd(repo)} has no .venv` };
}
/** a command line's arguments (double / single quotes group) */
export const splitArgs = s => [...String(s ?? '').matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);

const unxml = s => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const attrs = s => Object.fromEntries([...String(s).matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)].map(m => [m[1], unxml(m[2])]));
/** pytest --junitxml (junit_family=xunit1: file and line on each case) -> { suite_ms, cases: [{ classname, name, file, line (1-based), ms, ok, skipped }] } */
export function parseJunit(xml) {
  const text = String(xml ?? ''), cases = [];
  let suite_ms = 0;
  for (const m of text.matchAll(/<testsuite\b([^>]*)>/g)) suite_ms += Math.round(1000 * Number(attrs(m[1]).time || 0));
  for (const m of text.matchAll(/<testcase\b((?:[^>"]|"[^"]*")*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const a = attrs(m[1]), body = m[3] ?? '';
    const line = a.line !== undefined && a.line !== '' ? Number(a.line) + 1 : null;   // pytest writes the 0-based line of the def
    cases.push({ classname: a.classname ?? '', name: a.name ?? '', file: a.file ? fwd(a.file) : null, line, ms: Math.round(1000 * Number(a.time || 0) * 10) / 10,
      ok: !/<(failure|error)\b/.test(body), skipped: /<skipped\b/.test(body) });
  }
  return { suite_ms, cases };
}
/** the module path of a test file ('tests/test_a.py' -> 'tests.test_a') */
const modOf = file => fwd(file).replace(/\.py$/, '').split('/').join('.');
/** junit cases -> a measure in the node:test measure's shape ({ files: [{ file, ms, tests: [{ name, nesting, line, ms, ok, group }], cov, totals }] }):
 *  group = the class(es) the test sits in, from the classname past the module; a skipped test is left out; file ms = the sum of its tests
 *  (pytest runs every file in one process: no per-file wall) */
export function pytestMeasure({ suite_ms, cases }, { at = new Date().toISOString(), cov = null } = {}) {
  const by = new Map();
  for (const c of cases) {
    if (c.skipped) continue;
    const file = c.file ?? `${c.classname.split('.').filter(s => !/^[A-Z]/.test(s)).join('/')}.py`, mod = modOf(file);
    const rest = c.classname.startsWith(mod) ? c.classname.slice(mod.length).replace(/^\./, '') : c.classname.split('.').filter(s => /^[A-Z]/.test(s)).join('.');
    const f = by.get(file) ?? { file, ms: 0, tests: [], cov: cov?.[file]?.cov ?? {}, totals: cov?.[file]?.totals ?? {} };
    f.tests.push({ name: c.name, nesting: 0, line: c.line, ms: c.ms, ok: c.ok, group: rest ? rest.split('.') : [] });
    f.ms = Math.round((f.ms + c.ms) * 10) / 10; by.set(file, f);
  }
  return { at, suite: 'pytest', coverage: !!cov, suite_ms, files: [...by.values()].sort((a, b) => a.file.localeCompare(b.file)) };
}
/** coverage.py's JSON report with contexts (pytest-cov --cov-context=test, [json] show_contexts) -> { testFile: { cov: { src: [lines] }, totals: { src: n } } };
 *  a context is '<test file>::<test>|run' (setup / teardown phases count too); sources are made relative to cwd, test files are left out */
export function pytestCov(report, cwd) {
  const out = {};
  for (const [p, f] of Object.entries(report?.files ?? {})) {
    const src = fwd(path.isAbsolute(p) ? path.relative(cwd, p) : p);
    if (/(^|\/)tests?\//.test(src) || src.startsWith('..')) continue;
    const total = (f.summary?.num_statements ?? 0);
    for (const [line, ctxs] of Object.entries(f.contexts ?? {})) for (const c of ctxs) {
      const tf = c.split('::')[0];
      if (!tf || !tf.endsWith('.py')) continue;
      const t = (out[fwd(tf)] ??= { cov: {}, totals: {} });
      (t.cov[src] ??= []).push(Number(line)); t.totals[src] = total;
    }
  }
  for (const t of Object.values(out)) for (const k of Object.keys(t.cov)) t.cov[k] = [...new Set(t.cov[k])].sort((a, b) => a - b);
  return out;
}
const hasCov = python => spawnSync(python, ['-c', 'import pytest_cov'], { stdio: 'ignore', windowsHide: true }).status === 0;
/** run the pytest suite in repo with its own python, --junitxml (and coverage per test through pytest-cov when it is installed and coverage is on)
 *  -> { measure, status, log, coverage: 'on' | 'off' | 'pytest-cov not installed' } | { error } */
export function runPytest(repo, gateCmd, { coverage = true, log } = {}) {
  const py = pythonOf(gateCmd, repo);
  if (py.error) return { error: py.error };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'norn-pytest-')), xml = path.join(tmp, 'junit.xml'), cj = path.join(tmp, 'cov.json'), rc = path.join(tmp, 'covrc');
  const cov = coverage && hasCov(py.python);
  if (cov) fs.writeFileSync(rc, '[run]\nbranch = False\n[json]\nshow_contexts = True\n');
  const args = ['-m', 'pytest', ...(py.args ?? ['tests', '-q', '-p', 'no:cacheprovider']), `--junitxml=${xml}`, '-o', 'junit_family=xunit1',
    ...(cov ? ['--cov=.', `--cov-config=${rc}`, '--cov-context=test', `--cov-report=json:${cj}`] : [])];
  const r = spawnSync(py.python, args, { cwd: repo, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  if (log) { fs.mkdirSync(path.dirname(log), { recursive: true }); fs.writeFileSync(log, `${py.python} ${args.join(' ')}\n(python from ${py.from})\n\n${r.stdout || ''}${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}`); }
  let measure = null;
  try {
    const j = parseJunit(fs.readFileSync(xml, 'utf8'));
    measure = pytestMeasure(j, { cov: cov && fs.existsSync(cj) ? pytestCov(JSON.parse(fs.readFileSync(cj, 'utf8')), repo) : null });
  } catch { /* no junit file: the suite did not start (the log says why) */ }
  fs.rmSync(tmp, { recursive: true, force: true });
  return { measure, status: r.status, python: py.python, coverage: !coverage ? 'off' : cov ? 'on' : 'pytest-cov not installed' };
}

// ---------- a test's one-line description: its docstring, the comment right above it, or its name ----------
const clip = s => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > 200 ? t.slice(0, 199) + '…' : t; };
const firstSentence = s => clip(String(s).trim().split(/\n\s*\n/)[0]);
/** the comment block right above line i (0-based; blank lines end it, decorators are skipped): '//' lines, a '/* *\/' block or '#' lines */
function commentAbove(lines, i, py) {
  let j = i - 1;
  while (py && j >= 0 && /^\s*@/.test(lines[j])) j--;
  const got = [];
  if (!py && j >= 0 && /\*\/\s*$/.test(lines[j])) {
    for (; j >= 0; j--) { got.unshift(lines[j]); if (/^\s*\/\*/.test(lines[j])) break; }
    return got.join('\n').replace(/^\s*\/\*+|\*+\/\s*$/g, '').split('\n').map(l => l.replace(/^\s*\*\s?/, '')).join(' ');
  }
  const re = py ? /^\s*#(?!!)\s?(.*)$/ : /^\s*\/\/\s?(.*)$/;
  for (; j >= 0; j--) { const m = lines[j].match(re); if (!m) break; got.unshift(m[1]); }
  return got.join(' ');
}
/** a python def's docstring (the first string statement of its body) */
function docstring(lines, i) {
  let j = i;
  while (j < lines.length && !/:\s*(#.*)?$/.test(lines[j])) j++;   // a def over several lines ends at its ':'
  for (j++; j < lines.length && !lines[j].trim(); j++);
  const m = (lines[j] ?? '').match(/^\s*[rRbBuU]?("""|''')(.*)$/);
  if (!m) { const one = (lines[j] ?? '').match(/^\s*[rRuU]?(["'])(.*)\1\s*$/); return one ? one[2] : ''; }
  const q = m[1], first = m[2];
  if (first.includes(q)) return first.slice(0, first.indexOf(q));
  const body = [first];
  for (j++; j < lines.length; j++) { const k = lines[j].indexOf(q); if (k >= 0) { body.push(lines[j].slice(0, k)); break; } body.push(lines[j]); }
  return body.join('\n');
}
/** a test name read as words: pytest's test_one_mebibyte_chunk -> 'one mebibyte chunk' (its parameters dropped); a node:test name as it is */
export const nameWords = (name, py) => (py ? String(name).replace(/\[.*\]$/, '').replace(/^test_?/, '').replace(/_+/g, ' ').trim() : String(name).trim());
/** -> { desc, from: 'docstring' | 'comment' | 'name' } or { desc: null, from: null } when the test has none (no docstring, no comment, a name of
 *  under 3 words). src = the test file's text, line = the test's 1-based line (its test( / def), py = a pytest file */
export function describeTest(src, line, name, py) {
  const lines = String(src ?? '').split(/\r?\n/), i = Number.isInteger(line) ? line - 1 : -1;
  if (i >= 0 && i < lines.length) {
    if (py) { const d = docstring(lines, i).trim(); if (d) return { desc: firstSentence(d), from: 'docstring' }; }
    const c = commentAbove(lines, i, py).trim();
    if (c) return { desc: clip(c), from: 'comment' };
  }
  const w = nameWords(name, py);
  return w.split(/\s+/).filter(Boolean).length >= 3 ? { desc: clip(w), from: 'name' } : { desc: null, from: null };
}

// ---------- the timing table ----------
/** a test's id: its file and the names around it, pytest-style ('tests/a.test.mjs::outer::one', 'tests/test_a.py::TestGroup::test_x') */
export const testId = (file, group, name) => [file, ...(group || []), name].join('::');
/** a measure (either suite) -> times.json: { at, sha, suite, run, via, exit, total_ms (the summed file time: each group's share is of it),
 *  wall_ms, coverage, files: [{ file, ms, tests }], tests: [{ id, file, group, name, line, ms, ok, desc, from }] } - leaf tests only (a test
 *  with subtests is a group, its time is theirs). readFile(file) -> the test file's text (null when missing) */
export function timesTable(measure, { readFile = () => null, sha = null, run = null, via = 'measure', exit = null, wall_ms = null } = {}) {
  const suite = measure.suite ?? 'node:test', py = suite === 'pytest', tests = [], files = [];
  for (const f of measure.files) {
    const src = readFile(f.file), leaves = f.tests.filter(t => !t.parent);
    for (const t of leaves) {
      const group = t.group ?? [], d = describeTest(src, t.line ?? null, t.name, py);
      tests.push({ id: testId(f.file, group, t.name), file: f.file, group, name: t.name, line: t.line ?? null, ms: t.ms, ok: t.ok, desc: d.desc, from: d.from });
    }
    files.push({ file: f.file, ms: f.ms, tests: leaves.length });
  }
  const total_ms = py && measure.suite_ms ? measure.suite_ms : files.reduce((n, f) => n + f.ms, 0);
  return { at: measure.at, sha, suite, run, via, exit, total_ms, wall_ms: wall_ms ?? (py ? measure.suite_ms : null), coverage: !!measure.coverage,
    files: files.sort((a, b) => b.ms - a.ms), tests: tests.sort((a, b) => b.ms - a.ms) };
}
const r1 = n => Math.round(n * 10) / 10;
const share = (ms, total) => (total > 0 ? Math.round(1000 * ms / total) / 10 : null);
/** the breakdown: per file, then per group (describe / suite / parent test, or pytest class; '' = the file's top level), each with its summed
 *  ms and its share of the suite's total, slowest first -> { total_ms, files: [{ file, ms, share, tests, groups: [{ group, ms, share, tests }] }] } */
export function breakdown(times) {
  const total = times?.total_ms ?? 0, byFile = new Map((times?.files ?? []).map(f => [f.file, { file: f.file, ms: f.ms, share: share(f.ms, total), tests: f.tests, groups: new Map() }]));
  for (const t of times?.tests ?? []) {
    const f = byFile.get(t.file); if (!f) continue;
    const k = (t.group || []).join(' › '), g = f.groups.get(k) ?? { group: k, ms: 0, tests: 0 };
    g.ms = r1(g.ms + t.ms); g.tests++; f.groups.set(k, g);
  }
  const files = [...byFile.values()].map(f => ({ ...f, groups: [...f.groups.values()].map(g => ({ ...g, share: share(g.ms, total) })).sort((a, b) => b.ms - a.ms) })).sort((a, b) => b.ms - a.ms);
  return { total_ms: total, files };
}
/** the tests slowest first, each with its share of the suite total -> [{ ...row, share }] */
export const slowestTests = (times, n = Infinity) => (times?.tests ?? []).slice().sort((a, b) => b.ms - a.ms).slice(0, n).map(t => ({ ...t, share: share(t.ms, times.total_ms) }));

// ---------- test impact: which test files cover a source file ----------
/** a measure with coverage -> impact.json { at, sha, suite, sources: { src: [test files] } } (null without coverage) */
export function impactMap(measure, { sha = null } = {}) {
  if (!measure.coverage) return null;
  const sources = {};
  for (const f of measure.files) for (const [src, lines] of Object.entries(f.cov || {})) if (lines.length) (sources[src] ??= []).push(f.file);
  for (const k of Object.keys(sources)) sources[k] = [...new Set(sources[k])].sort();
  return { at: measure.at, sha, suite: measure.suite ?? 'node:test', sources };
}
/** the answer of `norn tests for <files>`: per asked file the test files covering it (a test file asked for is itself) ->
 *  { rows: [{ file, tests, known }], tests: [the union] } */
export function testsFor(impact, files) {
  const src = impact?.sources ?? {}, testFiles = new Set(Object.values(src).flat());
  const rows = files.map(fwd).map(f => (testFiles.has(f) ? { file: f, tests: [f], known: true } : { file: f, tests: src[f] ?? [], known: f in src }));
  return { rows, tests: [...new Set(rows.flatMap(r => r.tests))].sort() };
}

// ---------- the code viewer's path guard ----------
/** a test's file for the viewer: only a file inside the project repo (repo-relative path; no absolute path, no '..' out, no link out,
 *  nothing under .git) -> its real absolute path | null */
export function repoFile(repo, rel) {
  const r = String(rel ?? '');
  if (!r || r.includes('\0') || path.isAbsolute(r) || /^[a-z]:/i.test(r) || /^[\\/]/.test(r)) return null;
  let root, real;
  try { root = fs.realpathSync.native(path.resolve(repo)); real = fs.realpathSync.native(path.resolve(root, r)); } catch { return null; }
  const back = path.relative(root, real);
  if (!back || back.startsWith('..') || path.isAbsolute(back) || back.split(/[\\/]/).includes('.git')) return null;
  return fs.statSync(real).isFile() ? real : null;
}
