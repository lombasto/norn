// NORN-DOD-NOCOMMIT (#155, #161): the Done check judges a run on what IT did. A `Tests: none` run with no lane branch and nothing dirty
// passes the branch step (nothing to diff is its intended outcome); a run's changed set is measured from the HEAD it started on (since),
// so a review run in another lane's worktree is not charged with that lane's earlier commits. Synthetic repos only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { doneCheck } from '../engine/lib/dod.mjs';
import { parseReady } from '../engine/lib/ready.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const NONE = 'Scope: none (a review; no code)\nTests: none - a design run; nothing is committed\nDone: the decision recorded\n';
const dodOf = text => ({ ready: parseReady(text), tests: { mode: 'light' } });
const commit = (wt, file, msg) => { fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true }); fs.writeFileSync(path.join(wt, file), msg + '\n'); git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', msg); };

/** a repo on main; lane: a worktree feat/x with one commit outside the review's Scope */
function repo(root, lane = false) {
  const r = path.join(root, 'repo');
  fs.mkdirSync(r, { recursive: true });
  git(r, 'init', '-q', '-b', 'main'); git(r, 'config', 'user.email', 't@t'); git(r, 'config', 'user.name', 't');
  commit(r, 'README.md', 'r');
  if (!lane) return r;
  const wt = path.join(root, 'wt');
  git(r, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
  commit(wt, 'src/a.mjs', 'lane work');
  return wt;
}

test('#155: a Tests-none run with no lane branch and nothing dirty passes the branch step; a dirty one stays red', async () => {
  const t = mkTmp('dod-nocommit-none-'), r = repo(t), logs = path.join(t, 'logs');
  const d = await doneCheck({ worktree: r, dod: dodOf(NONE), logDir: logs, run: 'RUN-1' });
  assert.equal(d.ok, true, d.why);
  assert.deepEqual(d.problems, []);
  assert.match(d.tests_none, /nothing changed/);
  fs.writeFileSync(path.join(r, 'stray.md'), 'x\n');
  const red = await doneCheck({ worktree: r, dod: dodOf(NONE), logDir: logs, run: 'RUN-2' });
  assert.equal(red.ok, false);
  assert.match(red.why, /uncommitted/);
});

test('#161: a review run is not charged with its worktree\'s earlier commits (changed set from its start HEAD); its own commit is', async () => {
  const t = mkTmp('dod-nocommit-since-'), wt = repo(t, true), logs = path.join(t, 'logs'), since = git(wt, 'rev-parse', 'HEAD');
  const before = await doneCheck({ worktree: wt, dod: dodOf(NONE), logDir: logs, run: 'RUN-3' });
  assert.equal(before.ok, false, 'without a start HEAD the lane commit is charged');
  const d = await doneCheck({ worktree: wt, dod: dodOf(NONE), logDir: logs, run: 'RUN-4', since });
  assert.equal(d.ok, true, d.why);
  assert.deepEqual(d.changed, []);
  assert.equal(d.since, since);
  commit(wt, 'src/b.mjs', 'review wrote code');
  const own = await doneCheck({ worktree: wt, dod: dodOf(NONE), logDir: logs, run: 'RUN-5', since });
  assert.equal(own.ok, false);
  assert.deepEqual(own.changed, ['src/b.mjs']);
});

test('since: a start HEAD that is not on the lane line (behind the merge base, or reset away) falls back to the merge base', async () => {
  const t = mkTmp('dod-nocommit-fallback-'), wt = repo(t, true), logs = path.join(t, 'logs');
  const main = git(wt, 'rev-parse', 'main');
  commit(path.join(t, 'repo'), 'later.md', 'main moves');
  git(wt, 'merge', '-q', 'main', '-m', 'merge main');
  const old = await doneCheck({ worktree: wt, dod: dodOf(NONE), logDir: logs, run: 'RUN-6', since: main });
  assert.deepEqual(old.changed, ['src/a.mjs'], 'a start HEAD behind the merge base is not used: main\'s own change is never charged');
  const gone = await doneCheck({ worktree: wt, dod: dodOf(NONE), logDir: logs, run: 'RUN-7', since: 'f'.repeat(40) });
  assert.deepEqual(gone.changed, ['src/a.mjs']);
});
