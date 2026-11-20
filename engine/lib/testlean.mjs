// META-TEND TESTS (owner DIR-19 + DIR-47): lean tests, MEASURED - per-test time, line coverage per test file, mutant kill sets.
// Never-failing (kills no mutant) and duplicate (kill set inside another test's) tests are computed here, never judged by a model.
// Inputs: the file `ci-suite --measure [--coverage]` writes (measure), a mutation matrix (mutationMatrix over a StrykerJS JSON
// report + the per-mutant failing tests the trial's command runner logs) and git. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { advisory } from './advisory.mjs';

const fwd = s => s.split('\\').join('/');
const rel = (p, cwd) => fwd(path.isAbsolute(p) ? path.relative(cwd, p) : p);
export const TESTS_SOURCE = 'owner DIR-19 + DIR-47 (lean tests, measured); META-TEND TESTS';

/** one test file's measure-reporter lines -> { file, ms, tests: [{ name, nesting, line, ms, ok, group }], cov: { src: [lines] }, totals: { src: n } }.
 *  group = the names of the describe() suites and parent tests around a test, outermost first ([] at the top level): node:test reports a
 *  child before its parent, so an item at nesting n is the parent of every item still waiting at nesting n + 1 */
export function measureFile(file, ms, text, cwd) {
  const seq = [], cov = {}, totals = {}, wait = {};
  for (const l of String(text).split('\n')) {
    if (!l.trim()) continue;
    const x = JSON.parse(l);
    if (x.t === 'test' || x.t === 'suite') {
      const it = { x, kids: wait[x.nesting + 1] ?? [] };
      for (const k of it.kids) k.parent = it;
      delete wait[x.nesting + 1]; (wait[x.nesting] ??= []).push(it); seq.push(it);
    } else if (x.t === 'cov') { const p = rel(x.path, cwd); cov[p] = x.lines; totals[p] = x.total; }
  }
  const groupOf = it => { const g = []; for (let p = it.parent; p; p = p.parent) g.unshift(p.x.name); return g; };
  const tests = seq.filter(it => it.x.t === 'test').map(it => ({ name: it.x.name, nesting: it.x.nesting, line: it.x.line ?? null, ms: it.x.ms, ok: it.x.ok, group: groupOf(it), ...(it.kids.length ? { parent: true } : {}) }));
  return { file: fwd(file), ms, tests, cov, totals };
}

/** covered lines of the suite, without the test files in `without`: Map src -> Set(line) */
export function coverageUnion(measure, without = []) {
  const skip = new Set(without.map(fwd)), u = new Map();
  for (const f of measure.files) {
    if (skip.has(f.file)) continue;
    for (const [src, lines] of Object.entries(f.cov || {})) { const s = u.get(src) ?? new Set(); for (const l of lines) s.add(l); u.set(src, s); }
  }
  return u;
}
const totalsOf = measure => Object.assign({}, ...measure.files.map(f => f.totals || {}));
/** { covered, total, pct } line coverage of a measure (null when it ran without --coverage) */
export function coveragePct(measure) {
  if (!measure.coverage) return null;
  const u = coverageUnion(measure), tot = totalsOf(measure);
  const covered = [...u.values()].reduce((n, s) => n + s.size, 0), total = Object.values(tot).reduce((n, x) => n + x, 0);
  return { covered, total, pct: total ? Math.round(1000 * covered / total) / 10 : 0 };
}

/** the leaf tests of the test files `files` as the mutation trial names them ('<basename> :: <name>'); node:test reports subtests before
 *  their parent, so a test right after one a level deeper is a parent */
export function leafNames(measure, files = null) {
  const want = files && new Set(files.map(fwd));
  return measure.files.filter(f => !want || want.has(f.file)).flatMap(f => f.tests.filter((t, i) => !(i > 0 && f.tests[i - 1].nesting === t.nesting + 1))
    .map(t => `${path.basename(f.file)} :: ${t.name}`));
}

/** a summary row of a measure: the numbers the history and the view keep */
export function summarize(measure, { sha = null } = {}) {
  const tests = measure.files.reduce((n, f) => n + f.tests.length, 0);
  return { at: measure.at, sha, files: measure.files.length, tests, suite_ms: measure.suite_ms,
    file_ms: measure.files.reduce((n, f) => n + f.ms, 0), coverage: coveragePct(measure) };
}

// ---------- why a test is slow: the markers in its own body (measured from the source, not guessed) ----------
const CAUSES = [
  ['spawns the CLI', /\b(meta|norn|run|cli)\s*\(\s*\[|engine\/bin\/norn\.mjs|spawnSync\s*\(\s*process\.execPath/],
  ['spawns a process', /\b(spawn|spawnSync|execFileSync|execFile|execSync|fork)\s*\(/],
  ['git', /['"]git['"]|\bgit\s*\(|gitInit|initRepo/],
  ['waits / polls', /\b(setTimeout|sleep|waitFor|until|settled|wait)\s*\(/],
  ['starts a server', /\b(createServer|listen|startDash|serve)\s*\(/],
  ['browser', /\b(shot|browser|chrome|edge)\b/i],
];
/** the body of test `name` in `src` (from its test( call to the next top-level test( call) */
export function testBody(src, name) {
  const lines = String(src).split('\n'), key = name.slice(0, 60);
  const at = lines.findIndex(l => /\b(test|it)\s*\(/.test(l) && l.includes(key));
  if (at < 0) return null;
  let end = lines.findIndex((l, i) => i > at && /^(test|it|describe)\s*\(|^for\s*\(/.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(at, end).join('\n');
}
/** the cause markers in a test's body -> ['spawns the CLI', 'git', ...] (empty = in-process work) */
export function testCause(src, name) {
  const b = testBody(src, name);
  if (b == null) return ['not found in the source (a generated name)'];
  return CAUSES.filter(([, re]) => re.test(b)).map(([k]) => k);
}
/** the n slowest tests of a measure with their cause; readFile(file) -> the test file's source */
export function slowest(measure, n = 20, readFile = f => fs.readFileSync(f, 'utf8')) {
  const all = measure.files.flatMap(f => f.tests.filter(t => t.nesting === 0).map(t => ({ file: f.file, name: t.name, ms: t.ms, ok: t.ok })));
  const src = {};
  return all.sort((a, b) => b.ms - a.ms).slice(0, n).map(t => {
    try { src[t.file] ??= readFile(t.file); } catch { src[t.file] = ''; }
    const c = testCause(src[t.file], t.name);
    return { ...t, cause: c.length ? c : ['in-process work'] };
  });
}

// ---------- tests vs code over git history ----------
const CODE_EXT = /\.(mjs|cjs|js|jsx|ts|tsx|py|rs|go|cs|java|kt|c|cc|cpp|h|hpp|swift|rb)$/i;
const SKIP = /(^|\/)(node_modules|vendor|third_party|dist|build|target|\.venv)\//i;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(py|go|rs)$/i;
/** 'test' | 'code' | null (not source) */
export function classify(p) {
  const f = fwd(p);
  if (!CODE_EXT.test(f) || SKIP.test(f)) return null;
  return TEST_PATH.test(f) ? 'test' : 'code';
}
// one test case per match: node:test / mocha / jest test( it(, pytest def test_, Rust #[test], Go func TestX(
export const TEST_CASE = String.raw`^\s*((test|it)(\.(only|skip|todo))?\s*\(|(async\s+)?def\s+test_|#\[(\w+::)?test\]|func\s+Test\w*\()`;
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
const grepCounts = (repo, sha, pattern) => {
  let out = '';
  try { out = git(repo, ['grep', '-I', '-c', '-E', pattern, sha]); } catch (e) { if (e.status !== 1) throw e; }   // 1 = no match
  return out.split('\n').filter(Boolean).map(l => { const m = l.slice(sha.length + 1).match(/^(.*):(\d+)$/); return m ? [m[1], Number(m[2])] : null; }).filter(Boolean);
};
/** the numbers of one commit: { tests (cases), test_lines, code_lines, test_files } */
export function countAt(repo, sha) {
  const r = { tests: 0, test_lines: 0, code_lines: 0, test_files: 0 };
  for (const [p, n] of grepCounts(repo, sha, '')) { const k = classify(p); if (k === 'test') { r.test_lines += n; r.test_files++; } else if (k === 'code') r.code_lines += n; }
  for (const [p, n] of grepCounts(repo, sha, TEST_CASE)) if (classify(p) === 'test') r.tests += n;
  return r;
}
/** tests vs code over the first-parent history of ref: one point per day, the last `points` days that have commits -> [{ day, sha, ... }] */
export function gitHistory(repo, { ref = 'HEAD', points = 24 } = {}) {
  const days = new Map();
  for (const l of git(repo, ['log', '--first-parent', '--format=%H %cI', ref]).split('\n').filter(Boolean)) {
    const [sha, iso] = l.split(' '), day = iso.slice(0, 10);
    if (!days.has(day)) days.set(day, sha);   // newest first: the day's last commit
  }
  const all = [...days.entries()].reverse(), step = Math.max(1, Math.ceil(all.length / points));
  const pick = all.filter((_, i) => (all.length - 1 - i) % step === 0).slice(-points);
  return pick.map(([day, sha]) => ({ day, sha: sha.slice(0, 12), ...countAt(repo, sha) }));
}

// ---------- copy-paste (jscpd-style, built-ins only): token windows that also occur elsewhere ----------
const TOKEN = /[A-Za-z_$][\w$]*|\d+(\.\d+)?|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|\S/g;
/** tokens of JS source without comments; literals stay as written (jscpd's default "strict" mode compares them) */
export function tokens(src) {
  const s = String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
  return s.match(TOKEN) ?? [];
}
/**
 * the share of `src`'s tokens inside a window of `min` tokens (jscpd's default min-tokens 50) that occurs twice - in src itself
 * or in one of `others` (texts). -> { pct, tokens, dup_tokens, clones: [{ line, with }] (the first line of each cloned run) }
 */
export function copyPaste(src, others = [], { min = 50 } = {}) {
  const t = tokens(src), seen = new Map();
  const key = (a, i) => a.slice(i, i + min).join('\u0001');
  others.forEach((o, k) => { const a = tokens(o.text); for (let i = 0; i + min <= a.length; i++) if (!seen.has(key(a, i))) seen.set(key(a, i), o.name ?? `other ${k}`); });
  const own = new Map(), dup = new Uint8Array(t.length), hits = [];
  for (let i = 0; i + min <= t.length; i++) {
    const k = key(t, i), w = seen.get(k) ?? (own.has(k) && i - own.get(k) >= min ? 'itself' : null);
    if (!own.has(k)) own.set(k, i);
    if (w) { if (!dup[i]) hits.push({ i, with: w }); for (let j = i; j < i + min; j++) dup[j] = 1; }
  }
  const n = dup.reduce((a, b) => a + b, 0);
  // token index -> line: count newlines before each hit's first token
  const pos = [], re = new RegExp(TOKEN.source, 'g'), body = String(src).replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
  let m; while ((m = re.exec(body))) pos.push(m.index);
  const lineOf = i => body.slice(0, pos[i] ?? 0).split('\n').length;
  const clones = hits.filter((h, k) => k === 0 || h.i > hits[k - 1].i + 1).map(h => ({ line: lineOf(h.i), with: h.with }));
  return { pct: t.length ? Math.round(1000 * n / t.length) / 10 : 0, tokens: t.length, dup_tokens: n, clones };
}

// ---------- mutation: who kills what ----------
/**
 * report: a StrykerJS JSON report (mutation-testing-report-schema: files.<path>.mutants[{ id, mutatorName, replacement, status,
 * location }]); kills: the trial's lines [{ mutant, fails: ['<test file> :: <test name>'], ms }] (one line per mutant run, 'dry' = the
 * unmutated run). -> { files: [{ file, mutants, killed, survived, timeout, other, score, ms }], tests: { test: [mutant ids] },
 *   ran: [test names of the dry run], mutants: { id: { file, line, mutator, replacement, status, by: [tests] } } }
 */
export function mutationMatrix(report, kills, ranTests = []) {
  const by = new Map(), ms = new Map();
  for (const k of kills) { if (k.mutant === 'dry') continue; by.set(String(k.mutant), k.fails); ms.set(String(k.mutant), k.ms); }
  const files = [], mutants = {}, tests = Object.fromEntries(ranTests.map(t => [t, []]));
  for (const [file, f] of Object.entries(report.files ?? {})) {
    const row = { file: fwd(file), mutants: 0, killed: 0, survived: 0, timeout: 0, other: 0, ms: 0 };
    for (const m of f.mutants ?? []) {
      const id = String(m.id), fails = by.get(id) ?? [];
      row.mutants++; row.ms += ms.get(id) ?? 0;
      const st = m.status === 'Killed' ? 'killed' : m.status === 'Survived' || m.status === 'NoCoverage' ? 'survived' : m.status === 'Timeout' ? 'timeout' : 'other';
      row[st]++;
      mutants[id] = { file: row.file, line: m.location?.start?.line ?? null, mutator: m.mutatorName, replacement: m.replacement ?? null, status: st, by: fails };
      for (const t of fails) (tests[t] ??= []).push(id);
    }
    const valid = row.killed + row.survived + row.timeout;
    row.score = valid ? Math.round(1000 * (row.killed + row.timeout) / valid) / 10 : null;
    files.push(row);
  }
  return { files, tests, mutants };
}
/** merge one trial's matrix into the stored one (mutant ids get the trial label: ids restart per trial); a re-run label replaces itself */
export function addTrial(stored, label, m, meta = {}) {
  const keep = stored ? { files: stored.files.filter(f => f.trial !== label), trials: stored.trials.filter(t => t.label !== label),
    mutants: Object.fromEntries(Object.entries(stored.mutants).filter(([id]) => !id.startsWith(label + ':'))) } : { files: [], trials: [], mutants: {} };
  const mutants = { ...keep.mutants, ...Object.fromEntries(Object.entries(m.mutants).map(([id, x]) => [`${label}:${id}`, x])) };
  const tests = {};
  for (const src of [stored?.tests ?? {}, Object.fromEntries(Object.entries(m.tests).map(([t, ids]) => [t, ids.map(id => `${label}:${id}`)]))])
    for (const [t, ids] of Object.entries(src)) tests[t] = [...new Set([...(tests[t] ?? []), ...ids.filter(id => mutants[id])])];
  return { files: [...keep.files, ...m.files.map(f => ({ ...f, trial: label }))], tests, mutants, trials: [...keep.trials, { label, ...meta }] };
}
/** tests that ran against the mutants and killed none of them: they cannot fail on these files */
export const neverFailing = matrix => Object.entries(matrix.tests).filter(([, ids]) => !ids.length).map(([t]) => t).sort();
/**
 * duplicate candidates: test A whose (non-empty) kill set lies inside test B's. Equal sets: the slower of the two (ms: test -> ms) is
 * the candidate, the faster one stays. -> [{ test, within, kills, same }] (same = equal sets)
 */
export function duplicates(matrix, ms = {}) {
  const sets = Object.entries(matrix.tests).filter(([, ids]) => ids.length).map(([t, ids]) => [t, new Set(ids)]);
  const out = [];
  for (const [a, A] of sets) {
    const host = sets.filter(([b, B]) => b !== a && B.size >= A.size && [...A].every(x => B.has(x)))
      .filter(([b, B]) => B.size > A.size || (ms[a] ?? 0) > (ms[b] ?? 0) || ((ms[a] ?? 0) === (ms[b] ?? 0) && a > b))
      .sort((x, y) => x[1].size - y[1].size || x[0].localeCompare(y[0]))[0];
    if (host) out.push({ test: a, within: host[0], kills: A.size, same: host[1].size === A.size });
  }
  return out.sort((x, y) => x.test.localeCompare(y.test));
}

// ---------- the merge-time check (advisory only, never a merge block) ----------
export const LIMITS = { copy_pct: 25, suite_up_pct: 10, mutation_cpu_s: 120 };
/**
 * base: the last merge's measure (with coverage); head: a measure of the test files this merge adds or changes (with coverage);
 * added: test files new in this merge; texts: { file: source } of the changed test files and corpus: [{ name, text }] of the others.
 * -> advisory records: tests-no-new-coverage, tests-copy-paste, tests-suite-slower
 */
export function mergeCheck({ base, head, added = [], texts = {}, corpus = [], limits = LIMITS }) {
  const out = [], changed = head.files.map(f => f.file);
  if (base.coverage && head.coverage) {
    const others = coverageUnion(base, changed);
    for (const f of head.files.filter(x => added.includes(x.file))) {
      const fresh = Object.entries(f.cov).reduce((n, [src, lines]) => n + lines.filter(l => !others.get(src)?.has(l)).length, 0);
      if (fresh === 0) out.push(advisory({ phase: 'TESTS', check: 'no-new-coverage', key: 'tests-no-new-coverage', severity: 'medium', surface: 'test file', path: f.file,
        why: `${f.tests.length} new test(s) cover no engine line the rest of the suite does not already cover`, source: TESTS_SOURCE,
        fix: { tier: 'card', action: 'keep only if it checks a failure the others miss (mutation), else drop it', kind: 'call', ways: ['Keep it', 'Drop it'] } }));
    }
  }
  for (const [file, text] of Object.entries(texts)) {
    const c = copyPaste(text, corpus.filter(o => o.name !== file));
    if (c.pct > limits.copy_pct) out.push(advisory({ phase: 'TESTS', check: 'copy-paste', key: 'tests-copy-paste', severity: 'low', surface: 'test file', path: file,
      why: `${c.pct}% of its tokens are in a 50-token run that is repeated (limit ${limits.copy_pct}%)`, source: TESTS_SOURCE + '; jscpd min-tokens 50',
      items: c.clones.slice(0, 10).map(x => ({ line: x.line, text: `same as ${x.with}` })), fix: { tier: 'card', action: 'fold the copies into one helper or a table of cases', kind: 'drafts' } }));
  }
  const old = base.files.filter(f => changed.includes(f.file)).reduce((n, f) => n + f.ms, 0), now = head.files.reduce((n, f) => n + f.ms, 0);
  const total = base.files.reduce((n, f) => n + f.ms, 0), est = total - old + now;
  if (total && est > total * (1 + limits.suite_up_pct / 100)) out.push(advisory({ phase: 'TESTS', check: 'suite-time', key: 'tests-suite-slower', severity: 'medium', surface: 'suite time',
    why: `the changed test files take the suite from ~${Math.round(total / 1000)} s to ~${Math.round(est / 1000)} s of file time (+${Math.round(100 * (est - total) / total)}%, limit ${limits.suite_up_pct}%)`,
    source: TESTS_SOURCE, items: head.files.map(f => ({ path: f.file, text: `${Math.round(f.ms / 100) / 10} s` })), fix: { tier: 'card', action: 'see the slowest list on the Tests tab', kind: 'count' } }));
  return out;
}

// ---------- the lean-tests gate (a fresh verifier runs it on each wave) ----------
/**
 * base: the measure before the wave (with coverage); after: a measure of the test files the wave changed (with coverage); matrix?:
 * the mutation matrix of the base; removed: the test names the wave cut ('<file basename> :: <name>'); changed: the test files the
 * wave touched (default: the files of `after`; a file the wave deleted is in changed, not in after).
 * ok = no covered line is lost from the suite AND (with a matrix) no mutant loses its last killer.
 * -> { ok, lost_lines: [{ src, line }], lost_mutants: [ids], before: { tests, cov }, after: { tests, cov }, score? }
 */
export function leanGate({ base, after, matrix = null, removed = [], changed = after.files.map(f => f.file) }) {
  const others = coverageUnion(base, changed), was = coverageUnion(base), now = coverageUnion(after);
  const lost = [];
  for (const [src, lines] of was) for (const l of lines) if (!others.get(src)?.has(l) && !now.get(src)?.has(l)) lost.push({ src, line: l });
  const cut = new Set(removed), lostM = [];
  if (matrix) for (const [id, m] of Object.entries(matrix.mutants)) if (m.by.length && m.by.every(t => cut.has(t))) lostM.push(id);
  const count = m => m.files.reduce((n, f) => n + f.tests.length, 0);
  const afterAll = { ...base, files: [...base.files.filter(f => !changed.includes(f.file)), ...after.files] };
  const score = matrix ? (() => {
    const v = Object.values(matrix.mutants).filter(m => m.status !== 'other'), k = v.filter(m => m.status !== 'survived');
    return { before: Math.round(1000 * k.length / v.length) / 10, after: Math.round(1000 * (k.length - lostM.length) / v.length) / 10 };
  })() : null;
  return { ok: !lost.length && !lostM.length, lost_lines: lost.sort((a, b) => a.src.localeCompare(b.src) || a.line - b.line), lost_mutants: lostM,
    before: { tests: count(base), cov: coveragePct(base) }, after: { tests: count(afterAll), cov: coveragePct(afterAll) }, ...(score ? { score } : {}) };
}
