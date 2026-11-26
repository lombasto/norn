// SPEC dash-owner-1123 s.1.1: `norn tests index` - the Tests tab's static index of a node:test suite, code only (no model). It writes
// <state>/tests/, each file stamped { at, sha }:
//   cases.json   per test() / it() / t.test() case { id: <file>::<title path>, file, name (the title path), line, lines (the call's span,
//                by a bracket scan that skips strings, comments, templates and regex literals), desc, runner } + per file { lines, cases }.
//                RM-a-55: pytest and cargo cases (testimpact.mjs graphIndex) join the same list, each with its runner.
//                desc = a `//` line right above the call, else the title's text after its first ': ', else the title. A title that is not
//                a string literal (a loop's `test(name, ...)`) has no static id: it is left out.
//   impact.json  { suite, sources: { source file: [test files] }, tests: { test file: { runner, basis, dir, ... } }, uncovered, graph? } -
//                node:test: the inverse of testcache depsOf over every test file, so a test covers a file iff changing the file changes the
//                test's cache key; tests/ (helpers, fixtures) and fixtures are no sources. A non-code file (a workflow, a doc) a test's
//                `// reads:` header matches lists that test too (DEC-a-648: `norn tests for .github/workflows/pr.yml`); a reads edge is
//                kept off code files and out of `uncovered` - it is a read, not coverage (impactOf). pytest / cargo: the code graph's import reach
//                (testimpact.mjs), nearest test first; graph = the graph's { commit, tree }, or { na: why } when it cannot be had.
//                NORN-IMPACT-READS: a non-code file a fresh stored pass recorded reading (testcache recordedReads, DEC-a-658) lists that test
//                too, as a read edge like a header's; recorded = { file: { test: { basis: 'recorded', key, at } } } says which edges these are.
//                Every test row's basis is 'inferred' (static: imports, not a coverage run).
//   times.json   { files: [{ file, ms }] } - the median of each file's last 5 `ran` rows in the machine's cache log (testpolicy: fastest-first).
import fs from 'node:fs';
import path from 'node:path';
import { depsOf, readsFiles } from './testcache.mjs';
import { IMPACT_FILE, TIMES_FILE, classify } from './testtimes.mjs';
import { RUNNERS } from './testimpact.mjs';

export const CASES_FILE = 'cases.json', TIMES_RUNS = 5;
// a case call: test / it (+ .only .skip .todo), a subtest on the context (t.test: `re.test(s)` is a regex, not a case), describe / suite
const CALL = /(?<![\w$.])(?:(test|it|describe|suite)(?:\.(?:only|skip|todo))?|(?:t|tt|ctx|context|st|sub)\.test)\s*\(/y;
const REGEX_AFTER = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const REGEX_WORD = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;

/** the string literal starting at s[i] (a quote) -> { value, end (index after it) } | null (a template with ${...} = null: no static title) */
function literal(s, i) {
  const q = s[i];
  if (q !== "'" && q !== '"' && q !== '`') return null;
  let v = '';
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { const n = s[++j]; v += n === 'n' ? '\n' : n === 't' ? '\t' : n; continue; }
    if (c === q) return { value: v, end: j + 1 };
    if (q === '`' && c === '$' && s[j + 1] === '{') return null;
    if (q !== '`' && c === '\n') return null;
    v += c;
  }
  return null;
}
const descOf = (title, above) => { const m = /^\s*\/\/\s?(.*)$/.exec(above ?? ''); if (m && m[1].trim()) return m[1].trim(); const k = title.indexOf(': '); return k >= 0 ? title.slice(k + 2) : title; };

/** the cases of one test file's text -> [{ id, file, name, line, lines, desc }] in source order */
export function scanCases(file, text) {
  const s = String(text ?? ''), src = s.split('\n'), out = [], parens = [];   // parens: per open '(' its call (or null)
  const tpl = [];   // per open template expression: the brace depth it returns to the template at
  let line = 1, braces = 0, prev = '', word = '', i = 0;
  const skipTo = (j) => { for (; i < j; i++) if (s[i] === '\n') line++; };
  const inTemplate = () => {   // s[i] is inside a template literal's text: run to its end or to a ${
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === '\n') line++;
      else if (c === '\\') i++;
      else if (c === '`') { i++; return; }
      else if (c === '$' && s[i + 1] === '{') { i += 2; tpl.push(braces); braces++; return; }
    }
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && s[i + 1] === '/') { const e = s.indexOf('\n', i); skipTo(e < 0 ? s.length : e); continue; }
    if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); skipTo(e < 0 ? s.length : e + 2); continue; }
    if (c === "'" || c === '"') { let j = i + 1; while (j < s.length && s[j] !== c && s[j] !== '\n') j += s[j] === '\\' ? 2 : 1; skipTo(j + 1); prev = c; word = ''; continue; }
    if (c === '`') { i++; inTemplate(); prev = '`'; word = ''; continue; }
    if (c === '/' && (!prev || REGEX_AFTER.has(prev) || REGEX_WORD.test(word))) {
      let j = i + 1, cls = false;
      for (; j < s.length && s[j] !== '\n'; j++) { if (s[j] === '\\') { j++; continue; } if (s[j] === '[') cls = true; else if (s[j] === ']') cls = false; else if (s[j] === '/' && !cls) break; }
      skipTo(j + 1); prev = ')'; word = ''; continue;
    }
    if (/[\w$]/.test(c)) {
      CALL.lastIndex = i;
      const m = CALL.exec(s);
      if (m) {
        const at = i + m[0].length - 1; let k = at + 1; while (/\s/.test(s[k] ?? '')) k++;
        const lit = literal(s, k), open = parens.filter(Boolean), blocked = open.some(o => o.path === null);   // inside a call with no static title: none either
        parens.push({ kind: m[1] === 'describe' || m[1] === 'suite' ? 'suite' : 'case', title: lit?.value ?? null, line, path: lit && !blocked ? [...open.map(o => o.title), lit.value] : null, above: src[line - 2] });
        skipTo(at + 1); prev = '('; word = ''; continue;
      }
      let j = i; while (j < s.length && /[\w$]/.test(s[j])) j++;
      word = s.slice(i, j); prev = s[j - 1]; i = j; continue;
    }
    if (c === '(') parens.push(null);
    else if (c === ')') { const call = parens.pop(); if (call && call.kind === 'case' && call.path) { const name = call.path.join('::'); out.push({ id: `${file}::${name}`, file, name, line: call.line, lines: line - call.line + 1, desc: descOf(call.title, call.above), runner: 'node:test' }); } }
    else if (c === '{') braces++;
    else if (c === '}') { braces--; if (tpl.length && braces === tpl.at(-1)) { tpl.pop(); i++; inTemplate(); prev = '`'; word = ''; continue; } }
    prev = c; word = ''; i++;
  }
  return out.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

const isSource = f => !f.startsWith('tests/') && !/(^|\/)fixtures\//.test(f);
/** impact.json's body: per source file the test files whose static deps reach it, and per non-code file (classify: null - a workflow, a
 *  doc) the tests whose `// reads:` header declares it; uncovered = the code files (code) no test's deps reach. A reads edge is no
 *  coverage of code: it never lands on a code file, and uncovered is taken from the deps alone (lint / layout declare `**`) */
export function impactOf(ix, tests, code = [], recorded = {}) {
  const deps = {}, reads = {}, rec = {}, add = (m, f, t) => { if (!(m[f] ??= []).includes(t)) m[f].push(t); };
  const nonCode = f => isSource(f) && classify(f) === null && ix.read(f) !== null;
  for (const t of [...tests].sort()) {
    for (const f of depsOf(t, ix)) if (isSource(f) && ix.read(f) !== null) add(deps, f, t);
    for (const f of readsFiles(t, ix)) if (nonCode(f)) add(reads, f, t);
  }
  // NORN-IMPACT-READS: a fresh stored pass's recorded reads (testcache recordedReads) are read edges too - on non-code files only, and
  // `recorded` keeps their basis (the result's key and age) for `norn tests for`; an edge a header or the deps already give stays theirs
  for (const t of [...tests].sort()) for (const f of recorded[t]?.files ?? []) {
    if (!nonCode(f) || reads[f]?.includes(t) || deps[f]?.includes(t)) continue;
    add(reads, f, t); (rec[f] ??= {})[t] = { basis: 'recorded', key: recorded[t].key, at: recorded[t].at };
  }
  const sources = { ...deps };
  for (const [f, ts] of Object.entries(reads)) sources[f] = [...new Set([...(sources[f] ?? []), ...ts])].sort();
  return { suite: 'node:test', sources: Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))), recorded: Object.fromEntries(Object.entries(rec).sort(([a], [b]) => a.localeCompare(b))),
    uncovered: code.filter(f => isSource(f) && !(f in deps)).sort() };
}
export const median = xs => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b), h = s.length >> 1; return !s.length ? null : s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
/** times.json's body from the cache log rows (oldest first): per test file of `tests` the median ms of its last TIMES_RUNS `ran` rows */
export function timesOf(log, tests) {
  const by = new Map(), want = new Set(tests);
  for (const r of log) if (r.how === 'ran' && want.has(r.file) && Number.isFinite(r.ms)) by.set(r.file, [...(by.get(r.file) ?? []), r.ms].slice(-TIMES_RUNS));
  return { files: [...by].map(([file, ms]) => ({ file, ms: Math.round(median(ms)) })).sort((a, b) => a.file.localeCompare(b.file)) };
}
/** the three files of a repo (ix: testcache repoIndex) -> { cases, impact, times }, each stamped { at, sha }. tests: its node test files,
 *  code: its tracked code files, log: the cache log rows, recorded: testcache recordedReads (the stored passes' read edges); graph: testimpact.mjs graphIndex's part (pytest + cargo), or { na: why }, or null */
export function buildIndex({ ix, tests, code = [], log = [], sha = null, now = Date.now(), graph = null, recorded = {} }) {
  const at = new Date(now).toISOString(), files = {}, cases = [], gp = graph && !graph.na ? graph : null;
  for (const t of [...tests].sort()) { const text = ix.read(t) ?? '', cs = scanCases(t, text); files[t] = { lines: text.split('\n').length, cases: cs.length }; cases.push(...cs); }
  const node = impactOf(ix, tests, code, recorded), sources = { ...node.sources };
  for (const [f, ts] of Object.entries(gp?.sources ?? {})) sources[f] = [...new Set([...(sources[f] ?? []), ...ts])];
  const runners = [...new Set([...(tests.length ? ['node:test'] : []), ...Object.values(gp?.tests ?? {}).map(r => r.runner)])].sort((a, b) => RUNNERS.indexOf(a) - RUNNERS.indexOf(b));
  const impact = { at, sha, suite: runners.join(' + ') || node.suite, sources: Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))), recorded: node.recorded,
    tests: { ...Object.fromEntries([...tests].sort().map(t => [t, { runner: 'node:test', basis: 'inferred', dir: '.' }])), ...(gp?.tests ?? {}) },
    uncovered: [...new Set([...node.uncovered.filter(f => !(f in sources)), ...(gp?.uncovered ?? [])])].sort(),
    ...(graph ? { graph: gp ? { ...gp.graph, ...(gp.partial.length ? { partial: gp.partial } : {}) } : { na: graph.na } } : {}) };
  return { cases: { at, sha, files: { ...files, ...(gp?.files ?? {}) }, cases: [...cases, ...(gp?.cases ?? [])] }, impact, times: { at, sha, ...timesOf(log, tests) } };
}
/** write the index into <state>/tests/ (each file atomically) */
export function writeIndex(dir, idx) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, v] of [[CASES_FILE, idx.cases], [IMPACT_FILE, idx.impact], [TIMES_FILE, idx.times]]) { const f = path.join(dir, name), t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); }
}
