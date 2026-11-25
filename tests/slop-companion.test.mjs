// RM-a-62 companion files (K27): a changed file whose usual partner (the code signals, docs/code-signals.md) is not in the branch is a
// shadow WARN with both counts and the indexed commit; no signals is "could not run"; CI (machine false) does not run it. Temp repos only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadRules, slopCheck } from '../engine/lib/slop/check.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const K27 = loadRules().find(r => r.id === 'K27');
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const put = (dir, files) => { for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); } };
/** main = base, feat/x = base with `head` written over it */
function repoOf(base, head) {
  const dir = mkTmp('slop-companion-');
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'core.autocrlf', 'false');
  put(dir, base); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feat/x'); put(dir, head); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--allow-empty', '-m', 'head');
  return dir;
}
/** a state folder holding the stored signals object (the contract's <state>/code/signals.json) */
function stateOf(files) {
  const state = mkTmp('slop-companion-state-');
  fs.mkdirSync(path.join(state, 'code'), { recursive: true });
  fs.writeFileSync(path.join(state, 'code', 'signals.json'), JSON.stringify({ at: '2026-01-02T00:00:00.000Z', sha: 'abcdef012345', basis: 'measured', files }));
  return state;
}
const sig = (landings, partners) => ({ landings, partners: partners.map(([file, shared, l = landings]) => ({ file, shared, share: Math.round(100 * shared / landings) / 100, landings: l })) });
const BASE = { 'src/a.mjs': 'a\n', 'src/b.mjs': 'b\n', 'src/c.mjs': 'c\n', 'package-lock.json': '{}\n', 'docs/a.md': 'a\n' };
const check = (repo, state, o = {}) => slopCheck({ repo, base: 'main', rules: [K27], state, ...o });

test('K27: a changed file whose usual partner is not in the branch is a shadow WARN with both counts and the indexed commit, never a block', () => {
  assert.equal(K27.level, 'WARN'); assert.equal(K27.shadow, true); assert.equal(K27.machine, true);
  const repo = repoOf(BASE, { 'src/a.mjs': 'a2\n' }), state = stateOf({ 'src/a.mjs': sig(10, [['src/b.mjs', 8], ['src/c.mjs', 3]]) });
  const r = check(repo, state), f = r.findings;
  assert.deepEqual(r.ran, ['K27']);
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.equal(f[0].file, 'src/a.mjs'); assert.equal(f[0].level, 'WARN'); assert.equal(f[0].shadow, true); assert.equal(f[0].new, true);
  assert.equal(f[0].msg, 'src/a.mjs usually changes with src/b.mjs (8 of 10 landings); src/b.mjs is not in this branch (measured from git at abcdef012345)');
  assert.deepEqual(r.blocks, []);
});

test('K27: no finding when the partner is in the branch, under the threshold, a lock or generated file, gone at head, or the file is deleted', () => {
  const s = { 'src/a.mjs': sig(10, [['src/b.mjs', 8]]), 'src/c.mjs': sig(10, [['package-lock.json', 9], ['src/a.mjs', 3]]), 'docs/a.md': sig(6, [['src/gone.mjs', 6]]), 'src/b.mjs': sig(10, [['src/c.mjs', 9]]) };
  const state = stateOf(s);
  assert.deepEqual(check(repoOf(BASE, { 'src/a.mjs': 'a2\n', 'src/b.mjs': 'b2\n' }), state).findings.filter(x => x.file === 'src/a.mjs'), [], 'partner in the branch');
  assert.deepEqual(check(repoOf(BASE, { 'src/c.mjs': 'c2\n' }), state).findings, [], 'lock partner excluded; 3 of 10 under the threshold');
  assert.deepEqual(check(repoOf(BASE, { 'docs/a.md': 'a2\n' }), state).findings, [], 'a partner not at head');
  const del = repoOf(BASE, {}); fs.rmSync(path.join(del, 'src/b.mjs')); git(del, 'commit', '-q', '-am', 'rm');
  assert.deepEqual(check(del, state).findings, [], 'a deleted file has no partner to miss');
});

test('K27: a renamed partner counts as in the branch; a file the signals do not know has no finding', () => {
  const repo = repoOf(BASE, { 'src/a.mjs': 'a2\n', 'src/new.mjs': 'n\n' });
  fs.renameSync(path.join(repo, 'src/b.mjs'), path.join(repo, 'src/b2.mjs')); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'mv');
  assert.deepEqual(check(repo, stateOf({ 'src/a.mjs': sig(10, [['src/b.mjs', 8]]) })).findings, []);
});

test('K27: with no state or no stored signals the rule could not run (shadow: recorded, not held); CI (machine false) does not run it', () => {
  const repo = repoOf(BASE, { 'src/a.mjs': 'a2\n' });
  for (const state of [null, mkTmp('slop-companion-empty-')]) {
    const r = check(repo, state);
    assert.equal(r.findings.length, 1); assert.equal(r.findings[0].unrun, true); assert.equal(r.findings[0].shadow, true);
    assert.match(r.findings[0].msg, /^could not run: .*signals/);
    assert.deepEqual(r.blocks, []);
  }
  const ci = check(repo, null, { machine: false });
  assert.deepEqual([ci.ran, ci.findings], [[], []]);
});
