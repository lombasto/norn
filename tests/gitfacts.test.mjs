// git-perf S1: engine/lib/gitfacts.mjs answers the hot paths' git questions without a process where it can: a worktree's HEAD and a
// ref's sha from the files (loose, packed-refs, detached, a linked worktree), sha facts memoized in <common>/norn-memo.json, and the
// queue walk's touched list reused inside its TTL for the same (tip, base). Synthetic repos in temp dirs only; no live state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { headOf, shaOf, mergeBase, saveMemos, worktreeFacts } from '../engine/lib/gitfacts.mjs';
import { pathKey } from '../engine/lib/config.mjs';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';

test.after(cleanTmp);
const GENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
const g = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: GENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (repo, file, text, msg) => { fs.writeFileSync(path.join(repo, file), text); g(repo, 'add', file); g(repo, 'commit', '-q', '-m', msg); return g(repo, 'rev-parse', 'HEAD'); };

// main (2 commits, "pushed" as origin/main) + a linked worktree on feat/x with one commit of its own
function setup() {
  const repo = mkTmp('meta-gf-repo-');
  g(repo, 'init', '-q', '-b', 'main'); g(repo, 'config', 'commit.gpgsign', 'false');
  commit(repo, 'a.txt', 'a\n', 'a');
  const m = commit(repo, 'b.txt', 'b\n', 'b');
  g(repo, 'update-ref', 'refs/remotes/origin/main', m);
  const wt = path.join(mkTmp('meta-gf-wt-'), 'x');
  g(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt, 'main');
  const x = commit(wt, 'x.txt', 'x\n', 'x');
  return { repo, wt, m, x };
}

test('headOf / shaOf read HEAD and refs from the files: loose, packed-refs, a linked worktree, detached - the same answers as git', () => {
  const s = setup();
  assert.deepEqual([headOf(s.repo).branch, headOf(s.repo).sha], ['main', s.m]);
  assert.deepEqual([headOf(s.wt).branch, headOf(s.wt).sha], ['feat/x', s.x], 'a linked worktree: its own HEAD, the common refs');
  assert.equal(pathKey(headOf(s.wt).common), pathKey(path.join(s.repo, '.git')), 'any spelling (8.3 short name)');
  assert.equal(shaOf(s.wt, 'refs/remotes/origin/main'), s.m);
  g(s.repo, 'pack-refs', '--all');
  assert.ok(!fs.existsSync(path.join(s.repo, '.git', 'refs', 'heads', 'feat', 'x')), 'packed: no loose ref left');
  assert.equal(headOf(s.wt).sha, s.x, 'from packed-refs');
  assert.equal(shaOf(s.repo, 'refs/remotes/origin/main'), s.m);
  assert.equal(shaOf(s.repo, 'refs/heads/none'), null);
  g(s.wt, 'checkout', '-q', '--detach', 'HEAD~1');
  assert.deepEqual([headOf(s.wt).branch, headOf(s.wt).sha], ['HEAD', s.m], 'detached: as `rev-parse --abbrev-ref HEAD`');
  assert.equal(headOf(mkTmp('meta-gf-none-')), null, 'no checkout');
});

test('mergeBase is memoized by sha in <common>/norn-memo.json; worktreeFacts reuses the touched list inside its TTL only', () => {
  const s = setup(), common = headOf(s.wt).common;
  assert.equal(mergeBase(s.wt, common, s.x, s.m), s.m);
  saveMemos();
  const file = path.join(common, 'norn-memo.json'), memo = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(memo[`mb ${[s.x, s.m].sort().join(' ')}`].v, s.m, 'the answer is in the file, keyed by the two shas');
  const f0 = worktreeFacts(s.wt, { ttlMs: 60000 });
  assert.deepEqual([f0.branch, f0.tip, f0.base, f0.touched, f0.commits], ['feat/x', s.x, s.m, ['x.txt'], 1]);
  fs.writeFileSync(path.join(s.wt, 'a.txt'), 'edited\n');   // an uncommitted tracked edit
  assert.deepEqual(worktreeFacts(s.wt, { ttlMs: 60000 }).touched, ['x.txt'], 'inside the TTL, same tip and base: reused');
  assert.deepEqual(worktreeFacts(s.wt, { ttlMs: 60000, now: Date.now() + 120000 }).touched, ['a.txt', 'x.txt'], 'past the TTL: read again');
  fs.writeFileSync(path.join(s.wt, 'b.txt'), 'edited\n');
  assert.deepEqual(worktreeFacts(s.wt).touched, ['a.txt', 'b.txt', 'x.txt'], 'no TTL (the claim door): always fresh');
  const y = commit(s.wt, 'y.txt', 'y\n', 'y');
  const f1 = worktreeFacts(s.wt, { ttlMs: 60000 });
  assert.deepEqual([f1.tip, f1.commits, f1.touched.includes('y.txt')], [y, 2, true], 'a new tip: read again, inside the TTL too');
});
