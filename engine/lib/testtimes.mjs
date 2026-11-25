// The Tests tab's file helpers: which suite a folder holds, the answer of `norn tests for` over impact.json (source file -> the test
// files that cover it) and the code viewer's path guard, and classify (source vs test). testpolicy.mjs reads times.json and impact.json for its picks. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';

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

// ---------- test impact: which test files cover a source file ----------
/** the answer of `norn tests for <files>`: per asked file the test files covering it (a test file asked for is itself) ->
 *  { rows: [{ file, tests, known }], tests: [the union] } */
export function testsFor(impact, files) {
  const src = impact?.sources ?? {}, testFiles = new Set(Object.values(src).flat());
  const rows = files.map(fwd).map(f => (testFiles.has(f) ? { file: f, tests: [f], known: true } : { file: f, tests: src[f] ?? [], known: f in src }));
  return { rows, tests: [...new Set(rows.flatMap(r => r.tests))].sort() };
}

// ---------- source vs test: the Tests tab's history and a resolve brief's Tests line ----------
const CODE_EXT = /\.(mjs|cjs|js|jsx|ts|tsx|py|rs|go|cs|java|kt|c|cc|cpp|h|hpp|swift|rb)$/i;
const SKIP = /(^|\/)(node_modules|vendor|third_party|dist|build|target|\.venv)\//i;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(py|go|rs)$/i;
/** 'test' | 'code' | null (not source) */
export function classify(p) {
  const f = fwd(p);
  if (!CODE_EXT.test(f) || SKIP.test(f)) return null;
  return TEST_PATH.test(f) ? 'test' : 'code';
}

// ---------- the code viewer's path guard ----------
/** a test's file for the viewer: only a file inside the project repo (repo-relative path; no absolute path, no '..' out, no link out,
 *  nothing under .git) -> its real absolute path | null */
export function repoFile(repo, rel) {
  const r = String(rel ?? '').replace(/\\/g, '/'); // a backslash is a separator on every host (POSIX would read `tests\a` as one name)
  if (!r || r.includes('\0') || path.isAbsolute(r) || /^[a-z]:/i.test(r) || /^[\\/]/.test(r)) return null;
  let root, real;
  try { root = fs.realpathSync.native(path.resolve(repo)); real = fs.realpathSync.native(path.resolve(root, r)); } catch { return null; }
  const back = path.relative(root, real);
  if (!back || back.startsWith('..') || path.isAbsolute(back) || back.split(/[\\/]/).includes('.git')) return null;
  return fs.statSync(real).isFile() ? real : null;
}
