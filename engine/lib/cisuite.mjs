// META-GTP-CI 1: the CI suite judge (GT-PARITY-PLAN 2.11). tests/KNOWN-REDS.txt lists the reds CI tolerates, one per line:
// `<file> :: <test name or name prefix>`; the run fails only on a red that no line names. Pure but censusCount (reads a dir): the runner is engine/bin/ci-suite.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { globToRe } from './dlvgit.mjs';

const fwd = s => s.split('\\').join('/');

// task-NORN-TEST-READS (DEC-a-648): a test file declares the non-JS repo files it reads (a workflow, a doc, a data file) in its leading
// comment block, `// reads: .github/workflows/*.yml, docs/x.md` (repo-relative globs, globToRe: ** = any directories, * = one segment,
// ? = one character). A pass made on main's pr.yml was reused for a changed pr.yml: no key and no pick saw the read. The ONE parser and
// matcher of it: testcache keyOf (the key), pickTests + testpolicy pickRun (the picks), testindex impactOf (`norn tests for`).
const READS = /^\s*\/\/\s*reads:(.*)$/;
/** the globs of a test file's `// reads:` lines: the comment lines (and blanks, a #! line) before its first code line only */
export function readsOf(text) {
  const out = [];
  for (const l of String(text ?? '').split(/\r?\n/)) {
    if (!/^\s*(\/\/|#!|$)/.test(l)) break;
    const m = READS.exec(l);
    if (m) out.push(...m[1].split(',').map(g => fwd(g.trim())).filter(Boolean));
  }
  return out;
}
/** does a repo-relative file match one of the globs (readsOf) */
export const readsMatch = (globs, file) => globs.some(g => globToRe(g).test(fwd(file)));

/** Parse KNOWN-REDS text -> [{ file, name }]; `#` comments and blank lines are skipped; a line without ` :: ` throws. */
export function parseKnown(text) {
  const out = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const l = raw.trim();
    if (!l || l.startsWith('#')) return;
    const at = l.indexOf('::');
    if (at < 0) throw new Error(`KNOWN-REDS line ${i + 1}: expected "<file> :: <test name>", got: ${l}`);
    out.push({ file: fwd(l.slice(0, at).trim()), name: l.slice(at + 2).trim() });
  });
  return out;
}

const names = (k, f) => k.file === f.file && (f.name === k.name || f.name.startsWith(k.name));
/**
 * fails: [{ file (repo-relative, forward slashes), name }] = the failing leaf tests of a run; known: parseKnown output.
 * Returns { listed, fresh, fixed, ok }: fresh = reds no line names (ok iff none); fixed = lines whose red did not occur.
 */
export function judge(fails, known) {
  const listed = [], fresh = [];
  for (const f of fails) (known.some(k => names(k, f)) ? listed : fresh).push(f);
  const fixed = known.filter(k => !fails.some(f => names(k, f)));
  return { listed, fresh, fixed, ok: fresh.length === 0 };
}

// The identity a calling Norn run (supervisor) or agent CLI puts in its children's env. The suite must be hermetic: 11-13 a worker's
// own META_RUN_ID / META_ROLE / META_STATE turned 4 CLI test files red and hung the suite (RUN-471 / RUN-477 / RUN-481 / RUN-505).
// Test knobs (META_UPDATE_GOLDEN, META_WALL_STEP_MS, META_TEST_*, ...) are not identity and pass through.
// MAIL-33: META_JOB (the worker's reap job: runs.mjs spawns inside it) and META_PARENT_RUN (a helper's depth-1 mark) are identity too.
// wt-reds: META_RESULT / META_RESULT_DIR (the worker's own result file): a fake executor a test spawns would write into it (or throw).
export const CALLER_ENV = ['META_RUN_ID', 'META_RUN_STATE', 'META_ROLE', 'META_STATE', 'META_PROJECT', 'META_SESSION_ID', 'META_RESUMES',
  'META_NOTES', 'META_JOB', 'META_PARENT_RUN', 'META_RESULT', 'META_RESULT_DIR', 'CLAUDECODE'];
// META-TEST-TRIM: git's auto maintenance (gc / maintenance --auto after a commit, fetch or push) is one more process per git write
// in the suite's temp repos and nothing under test; on Windows it cost ~1/4 of a git-heavy test (mergeq main-red 70 s -> 54 s).
const SUITE_GIT = [['maintenance.auto', 'false'], ['gc.auto', '0']];
/** env -> the suite's env: without NODE_TEST_CONTEXT (a ci-suite started from a test runs its files) and without CALLER_ENV; git
 *  auto maintenance off (appended to any GIT_CONFIG_COUNT entries the caller set). */
export const suiteEnv = env => {
  const e = Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'NODE_TEST_CONTEXT' && !CALLER_ENV.includes(k.toUpperCase())));
  let n = Number(e.GIT_CONFIG_COUNT) || 0;
  for (const [k, v] of SUITE_GIT) { e['GIT_CONFIG_KEY_' + n] = k; e['GIT_CONFIG_VALUE_' + n] = v; n++; }
  e.GIT_CONFIG_COUNT = String(n);
  return e;
};


// META-PR-FAST (RM-29): the test files a pull request touches, for the fast PR job (`ci-suite --changed BASE`); the full suite runs
// after the merge (push to main) and nightly. A test file is picked when (1) it changed, (2) it imports a changed file directly
// (`from '../engine/lib/x.mjs'`, or a changed tests/helpers module), (3) its name starts with the stem of a changed module
// (engine/lib/mergeq.mjs -> mergeq.test.mjs, mergeq-batch.test.mjs) or (4) it names a changed fixture's folder (`fixtures/<dir>`).
// One import level only, and no basename search: through tests/helpers/tmp.mjs nearly every file reaches runs.mjs, and ~90 files
// name norn.mjs or server.mjs - a closure or a name search picks the whole suite (measured on PRs #11-#17: 79-157 files).
// Even one level picks 60-120 files when a PR touches a hub (server.mjs, records.mjs, policy.mjs), so the importers are capped
// (max): (1), (3), (4) and (5) - a test whose `// reads:` header matches a changed file: it asserts on that file's content - always
// run; the importers run most-changed-imports first, and the rest is named as left to the full suite.
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
// META-CI-WORKCLASS R4 + test-diet S1: a browser (page) test file is one that imports norn shot's launcher or the CDP helper; ci-suite
// warms a browser for it, and policy.tests.browser = ci skips its browser tests in a lane run (tests/helpers/cdp.mjs skipWhy)
export const isBrowserTest = text => /shot\.mjs|helpers\/cdp\.mjs/.test(String(text ?? ''));
const norm = p => { const out = []; for (const s of p.split('/')) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); } return out.join('/'); };
/** the repo-relative files a module imports by a relative specifier (file: its repo-relative path; text: its source) */
export const importsOf = (file, text) => {
  const dir = file.split('/').slice(0, -1).join('/');
  return [...new Set([...text.matchAll(IMPORT)].map(m => norm(`${dir}/${m[1]}`)))];
};
const base = f => f.split('/').at(-1);
const stemOf = f => /\.m?js$/.test(f) && !f.startsWith('tests/') ? base(f).replace(/\.m?js$/, '') : null;
const fixtureOf = f => { const p = f.split('/'); return p[0] === 'tests' && p[1] === 'fixtures' && p.length > 3 ? `fixtures/${p[2]}` : null; };
/** changed: repo-relative paths; tests: the suite's test files (repo-relative); read(f) -> text | null; max: the importers' cap (Infinity
 *  = none). -> { run: the test files to run, sorted; left: the importers past the cap, sorted } */
export function pickTests(changed, tests, read, max = Infinity) {
  const ch = new Set(changed.map(fwd)), stems = [...ch].map(stemOf).filter(Boolean), fx = [...ch].map(fixtureOf).filter(Boolean);
  const close = [], importers = [];
  for (const t of tests.map(fwd)) {
    const name = base(t);
    if (ch.has(t) || stems.some(s => name === `${s}.test.mjs` || name.startsWith(`${s}-`))) { close.push(t); continue; }
    const text = read(t);
    if (text == null) continue;
    if (fx.some(k => text.includes(k))) { close.push(t); continue; }
    const rd = readsOf(text);
    if (rd.length && [...ch].some(f => readsMatch(rd, f))) { close.push(t); continue; }
    const n = importsOf(t, text).filter(f => ch.has(f)).length;
    if (n) importers.push({ t, n });
  }
  importers.sort((a, b) => b.n - a.n || a.t.localeCompare(b.t));
  const cut = importers.slice(0, max).map(x => x.t);
  return { run: [...close, ...cut].sort(), left: importers.slice(max).map(x => x.t).sort() };
}

// RM-26 S0 (lean-suite SPEC 8): this module is also ci-suite's second node:test reporter (`--test-reporter=<cisuite.mjs>`, beside
// ci-reporter.mjs's reds): one `{ top, ms }` line per finished top-level case (nesting 0, pass or fail).
export default async function* timesReporter(source) {
  for await (const e of source) if ((e.type === 'test:pass' || e.type === 'test:fail') && e.data.nesting === 0) yield JSON.stringify({ top: e.data.name, ms: e.data.details?.duration_ms ?? 0 }) + '\n';
}
// the per-file time row of `ci-suite --json`. lines: the file's timesReporter lines. cases_ms = their sum; outside_ms = the rest of
// the file's wall (process start, imports, hooks, teardown).
/** (file, wall ms, reporter lines) -> { file, wall_ms, cases_ms, outside_ms, cases } */
export function timeRow(file, wallMs, lines) {
  const tops = lines.filter(x => x.top != null), cases = Math.round(tops.reduce((s, x) => s + (Number(x.ms) || 0), 0)), wall = Math.round(wallMs);
  return { file, wall_ms: wall, cases_ms: cases, outside_ms: wall - cases, cases: tops.length };
}
// `ci-suite --census`: a `--require` preload (census-preload.cjs, written into each file's census dir) appends one line per node process
// (main thread) to that dir's node.txt, its path written into the preload (no env switch); git writes one trace2 event file per process into the GIT_TRACE2_EVENT directory
// (git-config(1) trace2.eventTarget: a directory target). A CommonJS --require, not an --import: any --import makes node load the
// entry through the ESM loader, so `node chk.txt` (slop-fix.test.mjs's Done check) failed with ERR_UNKNOWN_FILE_EXTENSION under the
// census (CI 45728652472). The env a file's `node --test` gets for it: the caller's NODE_OPTIONS kept, a census preload of an outer
// suite (a ci-suite test running ci-suite --census) replaced, so each process lands in the innermost census only.
/** the census dir -> the preload's source (a failed append is a process left uncounted: it must never break the process under test) */
export const censusPreload = dir => "const fs = require('node:fs'), { isMainThread } = require('node:worker_threads');\n" +
  `if (isMainThread) try { fs.appendFileSync(${JSON.stringify(path.join(dir, 'node.txt'))}, \`\${process.pid}\\n\`); } catch {}\n`;
/** (the caller's NODE_OPTIONS value, the preload's path, the file's census dir) -> the env entries a census run sets */
export const censusEnv = (nodeOptions, preload, dir) => ({ GIT_TRACE2_EVENT: path.join(dir, 'trace2'),
  NODE_OPTIONS: [String(nodeOptions ?? '').replace(/\s*--require="[^"]*census-preload\.cjs"/g, '').trim(), `--require="${preload}"`].filter(Boolean).join(' ') });
/** the census dir -> { git_procs, node_procs } */
export const censusCount = dir => {
  // no trace2 dir / no node.txt: that file started no git / no node process (the preload creates node.txt on its first append)
  const t2 = path.join(dir, 'trace2'), nf = path.join(dir, 'node.txt');
  return { git_procs: fs.existsSync(t2) ? fs.readdirSync(t2).length : 0, node_procs: fs.existsSync(nf) ? fs.readFileSync(nf, 'utf8').split('\n').filter(Boolean).length : 0 };
};
