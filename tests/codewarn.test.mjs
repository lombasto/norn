// RM-a-67 warn-on-edit: codewarn.mjs's table (only the files over a threshold, each with its line, stamped with the indexed commit), its
// writer and the run record reader. Synthetic signals only; the hook that prints the lines is tests/norn-hook.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp } from './helpers/tmp.mjs';
import { execFileSync } from 'node:child_process';
import { WARN_LIMITS, warnLine, warnTable, writeWarnTable, warnFile, warnsOf, warnMarks } from '../engine/lib/codewarn.mjs';
import { codeCmd } from '../engine/lib/codecli.mjs';

const row = (o = {}) => ({ landings: 9, partners: [], fixes: { n_90d: 0, n_365d: 0, last: [] }, fix_first: 10, importance: 10, churn_90d: 0, fan_in: 0, ...o });
const sig = (files, o = {}) => ({ at: '2026-11-24T00:00:00.000Z', sha: '1a2b3c4d5e6f', basis: 'measured', limits: { fix_short_days: 90 }, fixes: { status: 'measured' }, files, ...o });
const tok = l => Math.ceil(l.length / WARN_LIMITS.chars_per_token);

test('the table holds only the files over a threshold, each line naming dependents, fixes and the top partner, stamped', () => {
  const s = sig({
    'lib/core.mjs': row({ fan_in: 41, fixes: { n_90d: 6, n_365d: 9, last: [] }, partners: [{ file: 'lib/peer.mjs', shared: 5, share: 0.56, landings: 7 }] }),
    'lib/fixed.py': row({ fan_in: null, fixes: { n_90d: WARN_LIMITS.fixes, n_365d: 4, last: [] } }),
    'lib/wide.rs': row({ fan_in: WARN_LIMITS.dependents }),
    'lib/calm.mjs': row({ fan_in: WARN_LIMITS.dependents - 1, fixes: { n_90d: WARN_LIMITS.fixes - 1, n_365d: 5, last: [] }, partners: [{ file: 'lib/core.mjs', shared: 3, share: 0.4, landings: 9 }] }),
  });
  const t = warnTable(s);
  assert.deepEqual(Object.keys(t.files), ['lib/core.mjs', 'lib/fixed.py', 'lib/wide.rs'], 'under every threshold: not in the table');
  assert.equal(t.files['lib/core.mjs'], 'lib/core.mjs: 41 files import this; 6 fixes in 90 days; changes with lib/peer.mjs (5 of 9 landings) (measured at 1a2b3c4d5e6f)');
  assert.equal(t.files['lib/fixed.py'], `lib/fixed.py: ${WARN_LIMITS.fixes} fixes in 90 days (measured at 1a2b3c4d5e6f)`, 'no fan-in: no dependents part');
  assert.equal(t.files['lib/wide.rs'], `lib/wide.rs: ${WARN_LIMITS.dependents} files import this (measured at 1a2b3c4d5e6f)`);
  assert.deepEqual([t.sha, t.basis, t.limits], ['1a2b3c4d5e6f', 'measured', WARN_LIMITS]);
  for (const l of Object.values(t.files)) assert.ok(tok(l) <= WARN_LIMITS.tokens, l);
});

test('an untyped history (fixes n/a) counts dependents only; a line over the cap drops the partner, then keeps the path tail', () => {
  assert.equal(warnLine('a.mjs', row({ fan_in: 3, fixes: null }), sig({})), null, 'fixes n/a and few dependents: nothing');
  const deep = `${'very/deep/folder/'.repeat(8)}x.mjs`, p = [{ file: `${'other/deep/'.repeat(8)}y.mjs`, shared: 4, share: 0.5, landings: 8 }];
  const l = warnLine(deep, row({ fan_in: 12, partners: p }), sig({}));
  assert.ok(tok(l) <= WARN_LIMITS.tokens, l);
  assert.doesNotMatch(l, /changes with/);
  assert.match(l, /x\.mjs: 12 files import this \(measured at 1a2b3c4d5e6f\)$/);
});

test('writeWarnTable stores the table beside the index; no signals removes it; warnsOf reads the hook\'s run record', () => {
  const st = mkTmp('meta-codewarn-');
  writeWarnTable(st, sig({ 'a.mjs': row({ fan_in: 20 }) }));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(warnFile(st), 'utf8')).files), ['a.mjs']);
  assert.equal(writeWarnTable(st, null), null);
  assert.equal(fs.existsSync(warnFile(st)), false);
  assert.equal(warnsOf(st, 'RUN-4'), null, 'never marked');
  fs.mkdirSync(path.join(st, 'code', 'warn'), { recursive: true });
  fs.writeFileSync(path.join(st, 'code', 'warn', 'RUN-4.txt'), 'ab warn\nshown a.mjs\nshown b/c.py\n');
  assert.deepEqual(warnsOf(st, 'RUN-4'), { mode: 'ab', group: 'warn', shown: 2, files: ['a.mjs', 'b/c.py'] });
});

test('warnMarks lists every marked run with its group', () => {
  const st = mkTmp('meta-codewarn-');
  assert.deepEqual(warnMarks(st), [], 'no marks yet');
  fs.mkdirSync(path.join(st, 'code', 'warn'), { recursive: true });
  fs.writeFileSync(path.join(st, 'code', 'warn', 'RUN-a-4.txt'), 'ab warn\nshown a.mjs\n'); fs.writeFileSync(path.join(st, 'code', 'warn', 'RUN-a-5.txt'), 'ab control\n');
  assert.deepEqual(warnMarks(st).sort((x, y) => (x.run < y.run ? -1 : 1)), [{ run: 'RUN-a-4', group: 'warn' }, { run: 'RUN-a-5', group: 'control' }]);
});

test('`norn code history` (the index refresh) writes the warn table: a file with fixes over the threshold has its line', () => {
  const d = mkTmp('meta-codewarn-'), repo = path.join(d, 'repo'), state = path.join(d, 'state', 'kestrel'), now = Date.parse('2026-11-20T12:00:00Z');
  const g = (args, at) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...(at ? { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : {}) } });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true }); g(['init', '-q', '-b', 'main']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']); g(['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(repo, 'src', 'b.mjs'), 'export const b = 1;\n');   // b: one landing, under every threshold
  for (let i = 0; i <= WARN_LIMITS.fixes; i++) {
    fs.writeFileSync(path.join(repo, 'src', 'a.mjs'), `export const v = ${i};\n`);
    g(['add', '-A']); g(['commit', '-q', '-m', i ? `fix(a): ${i}` : 'feat: a'], `2026-11-0${i + 1}T10:00:00Z`);
  }
  const err = [];
  assert.equal(codeCmd(['history', '--repo', repo, '--state', state], { out: () => {}, err: s => err.push(s), where: fl => ({ project: null, state: fl.state }), now }), 0, err.join('\n'));
  const t = JSON.parse(fs.readFileSync(warnFile(state), 'utf8'));
  assert.equal(t.sha, JSON.parse(fs.readFileSync(path.join(state, 'code', 'index.json'), 'utf8')).sha);
  assert.ok(t.files['src/a.mjs'].startsWith(`src/a.mjs: ${WARN_LIMITS.fixes} fixes in 90 days`), t.files['src/a.mjs']);
  assert.equal(t.files['src/b.mjs'], undefined);
});
