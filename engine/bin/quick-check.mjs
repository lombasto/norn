#!/usr/bin/env node
// MERGE-FIRST (3), owner ruling 2026-11-19 (MAIL-50): a clean merge lands on a quick check, never the full suite (that runs in CI
// and once on main after the backlog lands). Run in the merge worktree on the merged HEAD: the files changed since --base get
//   - a syntax check: `node --check` per changed .mjs / .cjs / .js; with --python, `<python> -m py_compile` of the changed .py
//   - their own tests, one file at a time: `node --test` per changed tests/**/*.test.mjs; with --python, `<python> -m pytest -q`
//     on the changed test_*.py / *_test.py under --dir (a monorepo project's folder; paths made relative to it)
// usage: node engine/bin/quick-check.mjs --base <sha> [--python <exe>] [--dir <folder>]
// exit 0 = every check green (or nothing to check), 1 = a red (named on stdout), 2 = usage / git failed.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const argv = process.argv.slice(2), opt = {};
for (let i = 0; i < argv.length; i++) {
  if (!['--base', '--python', '--dir'].includes(argv[i]) || i + 1 >= argv.length) { console.log(`usage: node engine/bin/quick-check.mjs --base <sha> [--python <exe>] [--dir <folder>] (got ${argv[i]})`); process.exit(2); }
  opt[argv[i].slice(2)] = argv[++i];
}
if (!opt.base) { console.log('quick-check: --base <sha> is required'); process.exit(2); }
// a parent `node --test`'s NODE_TEST_CONTEXT would make a child `node --test` report to it and exit 0 on a red: dropped
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
const run = (exe, args, cwd = '.') => { const r = spawnSync(exe, args, { cwd, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); return { code: r.error ? -1 : r.status, out: `${r.stdout || ''}${r.stderr || ''}${r.error ? r.error.message : ''}` }; };
const d = run('git', ['diff', '--name-only', '--diff-filter=ACMR', opt.base, 'HEAD']);
if (d.code !== 0) { console.log(`quick-check: git diff ${opt.base} HEAD failed: ${d.out.trim()}`); process.exit(2); }
const changed = d.out.split(/\r?\n/).filter(Boolean);
const dir = opt.dir ? opt.dir.replace(/\\/g, '/').replace(/\/+$/, '') : '';
const checks = [];
for (const f of changed.filter(f => /\.(mjs|cjs|js)$/.test(f))) checks.push({ what: `syntax ${f}`, exe: process.execPath, args: ['--check', f] });
for (const f of changed.filter(f => /(^|\/)tests\/(.+\/)?[^/]+\.test\.mjs$/.test(f))) checks.push({ what: `test ${f}`, exe: process.execPath, args: ['--test', f] });
if (opt.python) {
  const py = changed.filter(f => f.endsWith('.py'));
  if (py.length) checks.push({ what: `syntax ${py.length} .py file(s)`, exe: opt.python, args: ['-m', 'py_compile', ...py] });
  const tests = py.filter(f => /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(f) && (!dir || f.startsWith(dir + '/'))).map(f => (dir ? f.slice(dir.length + 1) : f));
  if (tests.length) checks.push({ what: `pytest ${tests.join(' ')}`, exe: opt.python, args: ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', ...tests], cwd: dir || '.' });
}
console.log(`quick-check: ${changed.length} changed file(s) since ${opt.base.slice(0, 7)}, ${checks.length} check(s)`);
for (const c of checks) {
  const r = run(c.exe, c.args, c.cwd ? path.resolve(c.cwd) : '.');
  console.log(`${r.code === 0 ? 'GREEN' : 'RED'} ${c.what}`);
  if (r.code !== 0) { console.log(r.out.trim().split(/\r?\n/).slice(-40).join('\n')); process.exit(1); }
}
process.exit(0);
