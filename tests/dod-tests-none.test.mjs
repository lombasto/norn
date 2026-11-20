// NORN-DOD-TESTS-NONE: a design / planning run's brief says `Tests: none - ...`; the Done check is green when the branch changed
// nothing (no commits, clean tree) and records why, and red naming the count when it changed files (a writing run cannot dodge
// its tests by writing "none"). A Tests line that names nothing runnable and does not say none stays "nothing runnable".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { doneCheck } from '../engine/lib/dod.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const dod = tests => ({ ready: { scope: ['src/**'], tests, done: '## DONE', missing: [] }, timeout_min: 1 });

/** a repo on main + a lane worktree feat/x with no commit of its own */
function laneRepo(root) {
  const repo = path.join(root, 'repo'), wt = path.join(root, 'wt');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'README.md'), 'r\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'r');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
  return { repo, wt };
}
const check = (wt, tests) => doneCheck({ worktree: wt, dod: dod(tests), logDir: path.join(wt, '..'), run: 'RUN-t' });

test('Tests: none + a branch with no change: green, the result records why', async () => {
  const { wt } = laneRepo(mkTmp('dod-none-green-'));
  const d = await check(wt, 'none - a design run; nothing is committed');
  assert.equal(d.ok, true, d.why);
  assert.equal(d.tests_none, 'none declared, nothing changed');
  assert.deepEqual(d.tests, []);
});

test('Tests: none + a committed change: red, naming the count of changed files', async () => {
  const { wt } = laneRepo(mkTmp('dod-none-commit-'));
  fs.mkdirSync(path.join(wt, 'src')); fs.writeFileSync(path.join(wt, 'src/a.mjs'), '1\n'); fs.writeFileSync(path.join(wt, 'src/b.mjs'), '2\n');
  git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'a');
  const d = await check(wt, 'None.');
  assert.equal(d.ok, false);
  assert.match(d.why, /the branch changed 2 files but the brief declares no tests/);
  assert.equal(d.tests_none, undefined);
});

test('Tests: none + an uncommitted edit of a tracked file: red, the edit counts as a change', async () => {
  const { wt } = laneRepo(mkTmp('dod-none-dirty-'));
  fs.writeFileSync(path.join(wt, 'README.md'), 'changed\n');
  const d = await check(wt, 'none');
  assert.equal(d.ok, false);
  assert.match(d.why, /the branch changed 1 file but the brief declares no tests/);
});

test('a Tests line that names nothing runnable and does not say none stays as before', async () => {
  const { wt } = laneRepo(mkTmp('dod-none-other-'));
  const d = await check(wt, 'the design review by hand');
  assert.equal(d.ok, false);
  assert.match(d.why, /Tests: nothing runnable/);
  assert.equal(d.tests_none, undefined);
  assert.equal((await check(wt, 'nonexistent stuff')).ok, false, '"none" must be a word of its own');
});
