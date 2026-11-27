// DLV-MERGED-TRUTH: a deliverable's MERGED comes from its PR (gh, latched by the tick), else git, else its change found on main
// ('merged (equivalent)'); a deleted branch never turns merged work back into DONE; what cannot be decided asks the owner once.
// Fixture git repos in temp dirs; gh is a fake (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { record } from '../engine/lib/records.mjs';
import { deliverablesView, latchMerged, loadDeliverables } from '../engine/lib/deliverables.mjs';
import { dlvMerged, judge, repoScanner } from '../engine/lib/dlvmerge.mjs';
import { contentOnMain, makeGit, scanRepo } from '../engine/lib/dlvgit.mjs';
import { makeEval } from '../engine/lib/after.mjs';
import { digest } from '../engine/lib/digest.mjs';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';

const tmp = p => mkTmp('meta-dlvmt-' + p + '-');
const GENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
const g = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: GENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
test.after(cleanTmp);
const NOW = Date.parse('2026-11-19T12:00:00Z');
const at = h => new Date(NOW + h * 3600e3);
const project = (repo, state) => ({ name: 't', root: repo, state, lane_defaults: {}, deliverables: { target: 'main' } });
const write = (repo, file, lines) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), lines.join('\n') + '\n'); };
const commitAll = (repo, msg) => { g(repo, 'add', '-A'); g(repo, 'commit', '-q', '-m', msg); return g(repo, 'rev-parse', 'HEAD'); };

// main: app.js (a .. e); the lane branch feat/x adds two lines to app.js and a new file. Pushed as origin/feat/x.
function repoWithBranch() {
  const repo = tmp('repo');
  g(repo, 'init', '-q', '-b', 'main'); g(repo, 'config', 'commit.gpgsign', 'false');
  write(repo, 'app.js', ['a', 'b', 'c', 'd', 'e']); const base = commitAll(repo, 'init');
  g(repo, 'checkout', '-q', '-b', 'feat/x');
  write(repo, 'app.js', ['a', 'b', 'const x = 1;', 'c', 'd', 'e']); commitAll(repo, 'feat(x): one');
  write(repo, 'app.js', ['a', 'b', 'const x = 1;', 'c', 'd', 'export { x };', 'e']); write(repo, 'x.md', ['# x']); const tip = commitAll(repo, 'feat(x): two');
  g(repo, 'update-ref', 'refs/remotes/origin/feat/x', tip);
  g(repo, 'checkout', '-q', 'main');
  return { repo, base, tip };
}
const mkDlv = (state, data) => record(state, { kind: 'deliverable', ev: 'create', by: 'controller', data }, { now: () => at(-10), views: false }).id;
const row = (state, repo) => deliverablesView({ stateDir: state, project: project(repo, state), now: NOW }).rows[0];
const deleteBranch = repo => { g(repo, 'branch', '-q', '-D', 'feat/x'); g(repo, 'update-ref', '-d', 'refs/remotes/origin/feat/x'); };
const fakeGh = (answer, calls = []) => args => { calls.push(args); return { code: 0, out: JSON.stringify(answer), err: '' }; };

test('a rebased-and-merged PR deliverable reads merged (PR #n) with its merge commit and time, and stays merged once its branch is deleted', () => {
  const { repo, tip } = repoWithBranch();
  const state = tmp('state');
  const id = mkDlv(state, { repo, branch: 'feat/x', tip, delivers: 'x', done_utc: at(-10).toISOString(), lane: 'x' });
  record(state, { kind: 'deliverable', ev: 'pr', id, by: 'launcher', data: { url: 'https://github.com/o/r/pull/34', number: 34, repo: 'o/r', head: 'feat/x', base: 'main' } }, { now: () => at(-9), views: false });
  // main moves; the owner rebases by hand and edits the code while resolving (new shas, new patch-ids, the lines changed), then merges
  write(repo, 'app.js', ['a', 'b', 'c', 'd2', 'e']); commitAll(repo, 'main moves');
  write(repo, 'app.js', ['a', 'b', 'const x = 2;', 'c', 'd2', 'export { x as y };', 'e']); write(repo, 'x.md', ['# x!']); const landed = commitAll(repo, 'feat(x): landed (rebased, resolved)');
  deleteBranch(repo);
  assert.equal(row(state, repo).state, 'unknown', 'git and the content check cannot see it: cannot tell, not done');
  const calls = [];
  const out = latchMerged(state, { project: project(repo, state), gh: fakeGh({ state: 'MERGED', mergedAt: at(-2).toISOString(), mergeCommit: { oid: landed } }, calls), now: () => at(0), nowMs: NOW });
  assert.deepEqual(calls[0], ['pr', 'view', 'https://github.com/o/r/pull/34', '--json', 'state,mergedAt,mergeCommit,reviewDecision,closedAt']);
  assert.ok(out.some(c => c.dlv === id && c.ev === 'merged'));
  const r = row(state, repo);
  assert.equal(r.state, 'merged'); assert.equal(r.merged_how, 'pr'); assert.equal(r.merge_pr, 34);
  assert.equal(r.merge_commit, landed); assert.equal(r.merged_at, at(-2).toISOString()); assert.equal(r.state_word, 'merged (PR #34)');
  assert.equal(r.at_target, true); assert.equal(r.unknown_why, null);
  // the next tick asks GitHub nothing more (latched) and writes nothing
  const again = []; assert.deepEqual(latchMerged(state, { project: project(repo, state), gh: fakeGh({}, again), nowMs: NOW }), []); assert.equal(again.length, 0);
  // the same rule for --after dlv: and the archive guard
  assert.equal(dlvMerged(loadDeliverables(state)[id]).merged, true);
  assert.equal(makeEval(state)({ kind: 'dlv', id, state: 'merged' }).met, true);
});

test('a PR merged BEFORE the deliverable\'s last DONE is not its evidence; an open PR is asked again only after the TTL', () => {
  const { repo, tip } = repoWithBranch();
  const state = tmp('state');
  const id = mkDlv(state, { repo, branch: 'feat/x', tip, delivers: 'x', done_utc: at(-10).toISOString() });
  record(state, { kind: 'deliverable', ev: 'pr', id, by: 'launcher', data: { url: 'https://github.com/o/r/pull/5', number: 5 } }, { now: () => at(-9), views: false });
  assert.deepEqual(latchMerged(state, { project: project(repo, state), gh: fakeGh({ state: 'MERGED', mergedAt: at(-20).toISOString(), mergeCommit: { oid: 'f'.repeat(40) } }), nowMs: NOW }), []);
  assert.equal(row(state, repo).state, 'done');
  const s2 = tmp('state');
  const id2 = mkDlv(s2, { repo, branch: 'feat/x', tip, delivers: 'x', done_utc: at(-10).toISOString() });
  record(s2, { kind: 'deliverable', ev: 'pr', id: id2, by: 'launcher', data: { url: 'https://github.com/o/r/pull/6', number: 6 } }, { now: () => at(-9), views: false });
  const calls = [];
  latchMerged(s2, { project: project(repo, s2), gh: fakeGh({ state: 'OPEN', mergedAt: null, mergeCommit: null }, calls), nowMs: NOW });
  latchMerged(s2, { project: project(repo, s2), gh: fakeGh({ state: 'OPEN' }, calls), nowMs: NOW + 60e3 });
  assert.equal(calls.length, 1, 'cached');
  latchMerged(s2, { project: project(repo, s2), gh: fakeGh({ state: 'OPEN' }, calls), nowMs: NOW + 11 * 60e3 });
  assert.equal(calls.length, 2, 'asked again after 10 min');
});

test('a deleted-branch merged deliverable stays merged: the tick latched what git saw while the branch was there', () => {
  const { repo, tip } = repoWithBranch();
  const state = tmp('state'), bare = tmp('state');
  for (const s of [state, bare]) mkDlv(s, { repo, branch: 'feat/x', tip, delivers: 'x', done_utc: at(-10).toISOString() });
  // a hand landing: the branch is rebased with edits and pushed (its ref moves), then fast-forwarded onto main
  write(repo, 'app.js', ['a', 'b', 'c', 'd2', 'e']); commitAll(repo, 'main moves');
  g(repo, 'checkout', '-q', '-b', 'tmp-land');
  write(repo, 'app.js', ['a', 'b', 'const x = 3;', 'c', 'd2', 'e']); const t2 = commitAll(repo, 'feat(x): rebased with edits');
  g(repo, 'checkout', '-q', 'main'); g(repo, 'merge', '-q', '--ff-only', 'tmp-land'); g(repo, 'branch', '-q', '-D', 'tmp-land');
  g(repo, 'branch', '-q', '-f', 'feat/x', t2); g(repo, 'update-ref', 'refs/remotes/origin/feat/x', t2);
  assert.equal(row(state, repo).state, 'merged');
  const out = latchMerged(state, { project: project(repo, state), nowMs: NOW });
  assert.deepEqual(out.map(c => [c.ev, c.why]), [['merged', 'merged']]);
  deleteBranch(repo);
  const r = row(state, repo);
  assert.equal(r.state, 'merged', 'the latch holds'); assert.equal(r.merged_how, 'git'); assert.equal(r.merge_latched, true); assert.equal(r.merge_commit, t2);
  assert.equal(row(bare, repo).state, 'unknown', 'without the latch only the DONE tip is left: Norn cannot tell (never plain done)');
});

test('a squash or conflict-resolved landing reads merged (equivalent)', () => {
  const { repo, base, tip } = repoWithBranch();
  const state = tmp('state');
  mkDlv(state, { repo, branch: 'feat/x', tip, delivers: 'x', done_utc: at(-10).toISOString() });
  // main also edits app.js; the squash of feat/x resolves the conflict keeping BOTH sides, in one commit with other work
  write(repo, 'app.js', ['a', 'b2', 'c', 'd', 'e']); commitAll(repo, 'main: b2');
  write(repo, 'app.js', ['a', 'b2', 'const x = 1;', 'c', 'd', 'export { x };', 'e']); write(repo, 'x.md', ['# x']); write(repo, 'other.txt', ['other']);
  commitAll(repo, 'feat(x): squashed, conflict resolved, + other work');
  const c = contentOnMain(repo, tip, 'main');
  assert.equal(c.on, true, c.why);
  const r = row(state, repo);
  assert.equal(r.state, 'merged'); assert.equal(r.merged_how, 'equivalent'); assert.equal(r.state_word, 'merged (equivalent)');
  // the branch deleted afterwards: the same answer (the DONE tip's change is still on main)
  deleteBranch(repo);
  assert.equal(row(state, repo).state_word, 'merged (equivalent)');
  // a line it added that main lacks = not merged
  write(repo, 'app.js', ['a', 'b2', 'c', 'd', 'export { x };', 'e']); commitAll(repo, 'main drops const x');
  assert.equal(contentOnMain(repo, tip, 'main').on, false);
  void base;
});

test('cannot tell -> ONE Inbox ruling; "merged" latches it, "open" makes it DONE again; the digest names the reason', () => {
  const { repo, tip } = repoWithBranch();
  const state = tmp('state');
  const id = mkDlv(state, { repo, branch: 'feat/x', tip, delivers: 'x', done_utc: at(-10).toISOString(), lane: 'x' });
  deleteBranch(repo);
  const r0 = row(state, repo);
  assert.equal(r0.state, 'unknown'); assert.match(r0.state_word, /^cannot tell if merged: the branch feat\/x is deleted/);
  const fin = digest(state, project(repo, state), { now: NOW }).sections.finished.find(x => x.id === id);
  assert.match(fin.why, /^cannot tell if merged: /);
  const p = project(repo, state);
  const out = latchMerged(state, { project: p, nowMs: NOW });
  assert.equal(out.filter(c => c.ev === 'question create').length, 1);
  assert.equal(latchMerged(state, { project: p, nowMs: NOW }).length, 0, 'one ruling, never one per tick');
  const q = row(state, repo).ruling;
  assert.match(q, /^Q-\d+$/);
  record(state, { kind: 'question', ev: 'answer', id: q, by: 'owner', data: { text: 'it landed by hand', via: 'dashboard', choice: 'merged' } }, { views: false });
  latchMerged(state, { project: p, nowMs: NOW });
  const r1 = row(state, repo);
  assert.equal(r1.state, 'merged'); assert.equal(r1.merged_how, 'ruling');
  assert.equal(digest(state, p, { now: NOW }).sections.finished.some(x => x.id === id), false, 'gone from "done, not merged"');
  // a second deliverable ruled still open reads DONE (not 'cannot tell'), and is not asked again
  const s2 = tmp('state');
  mkDlv(s2, { repo, branch: 'feat/x', tip, delivers: 'x', done_utc: at(-10).toISOString(), lane: 'x' });
  latchMerged(s2, { project: project(repo, s2), nowMs: NOW });
  const q2 = row(s2, repo).ruling;
  record(s2, { kind: 'question', ev: 'answer', id: q2, by: 'owner', data: { text: 'not yet', via: 'dashboard', choice: 'open' } }, { views: false });
  latchMerged(s2, { project: project(repo, s2), nowMs: NOW });
  assert.equal(row(s2, repo).state, 'done');
  assert.equal(latchMerged(s2, { project: project(repo, s2), nowMs: NOW }).length, 0);
});

// a git whose listed sub-commands fail as a timeout does (no exit status); the rest is real git
const failingGit = (...fail) => makeGit((repo, args, env, input) => {
  if (fail.includes(args[0])) throw Object.assign(new Error(`git ${args[0]} timed out`), { status: null });
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...GENV, ...env }, input, stdio: ['pipe', 'pipe', 'pipe'] });
});

test('C1: a failed git diff is "cannot tell", never "the branch changes nothing" (merged)', () => {
  const { repo, tip } = repoWithBranch();
  const c = contentOnMain(repo, tip, 'main', { git: failingGit('diff') });
  assert.equal(c.on, null, c.why); assert.match(c.why, /git diff failed/);
  const state = tmp('state');
  const id = mkDlv(state, { repo, branch: 'feat/x', tip, delivers: 'x', done_utc: at(-10).toISOString() });
  deleteBranch(repo);
  const m = dlvMerged(loadDeliverables(state)[id], { git: failingGit('diff') });
  assert.equal(m.merged, false); assert.match(m.unknown, /git diff failed/);
});

test('C9: a git failure is not cached as an answer: the next scan asks again and gets the truth', () => {
  const { repo, tip } = repoWithBranch();
  const short = tip.slice(0, 9);
  // tip is no ref (branch deleted, not merged): ancestry, counts, native paths and the rehearsal are asked per tip
  deleteBranch(repo);
  const ask = git => { const s = scanRepo(repo, { cache, git, native: ['*.md'], installed: [short] }); return { s, i: s.info('feat/x', tip), r: s.rehearse(tip) }; };
  const cache = {};
  const bad = ask(failingGit('merge-base', 'rev-parse', 'rev-list', 'diff', 'merge-tree'));
  assert.deepEqual([bad.i.behind, bad.i.ahead, bad.i.native, bad.r, bad.s.installed], [null, null, null, null, []], 'a failure answers nothing');
  assert.deepEqual([cache.anc, cache.full, cache.counts, cache.native, cache.rehearse].map(o => Object.keys(o).length), [0, 0, 0, 0, 0], 'and caches nothing');
  const good = ask(makeGit());
  assert.deepEqual([good.i.behind, good.i.ahead, good.i.native, good.r.clean, good.s.installed], [0, 2, true, true, [tip]]);
  assert.equal(good.s.onBase(tip, good.s.mainSha), false); assert.equal(good.s.onBase(tip, tip), true);
});

// DLV-b-107 (DEC-a-682): a lane restarted on its old branch name; the remote copy still pointed at an old commit already on main while
// the DONE tip sat on the local branch off main. A branch ref is the deliverable's tip only when it holds the DONE tip.
test('a stale remote copy on main never reads a deliverable merged: the ref that holds the DONE tip is its tip', () => {
  const repo = tmp('repo');
  g(repo, 'init', '-q', '-b', 'main'); g(repo, 'config', 'commit.gpgsign', 'false');
  write(repo, 'app.js', ['a']); const A = commitAll(repo, 'A');
  g(repo, 'checkout', '-q', '-b', 'feat/s'); write(repo, 'app.js', ['a', 'b']); const B = commitAll(repo, 'B');
  g(repo, 'update-ref', 'refs/remotes/origin/feat/s', A); g(repo, 'checkout', '-q', 'main');
  const state = tmp('state'), id = mkDlv(state, { repo, branch: 'feat/s', tip: B, delivers: 's', done_utc: at(-10).toISOString() });
  record(state, { kind: 'deliverable', ev: 'done', id, by: 'launcher', data: { tip: B } }, { now: () => at(-9), views: false });
  const cfg = { repo, main: 'main', remote: 'origin', native: null, history: [] }, git = makeGit();
  const ask = () => judge(loadDeliverables(state)[id], repoScanner({ cfg, cache: {}, git, install: null }).get(repo), { cfg, git });
  let j = ask();
  assert.equal(j.merge, null, 'the stale origin/feat/s on main is not this work');
  assert.deepEqual([j.g.tip, j.g.ahead, j.g.exists], [B, 1, true]);
  // pushed, then one more commit: the remote holds the DONE tip and is read first
  g(repo, 'checkout', '-q', 'feat/s'); write(repo, 'app.js', ['a', 'b', 'c']); const C = commitAll(repo, 'C'); g(repo, 'checkout', '-q', 'main');
  g(repo, 'update-ref', 'refs/remotes/origin/feat/s', C);
  j = ask(); assert.equal(j.merge, null); assert.deepEqual([j.g.tip, j.g.ahead], [C, 2]);
  // B merged to main (the remote stale at A again, the local branch at B): merged
  g(repo, 'update-ref', 'refs/remotes/origin/feat/s', A); g(repo, 'branch', '-q', '-f', 'feat/s', B); g(repo, 'merge', '-q', '--ff-only', B);
  j = ask(); assert.equal(j.merge?.how, 'git'); assert.equal(j.g.tip, B);
});

// DLV-b-107 (DEC-a-682): a reused branch name whose remote copy is old work that landed by squash. The copy diverged from the DONE tip
// (not an ancestor of it) and was committed BEFORE the DONE: a stale copy, never this deliverable's tip (its patches are on main).
// A diverged ref committed after the DONE is a rewrite of the work (the hand-landing test above) and counts.
test('a diverged remote copy older than the DONE never reads a deliverable merged: its tip is the DONE tip', () => {
  const repo = tmp('repo');
  g(repo, 'init', '-q', '-b', 'main'); g(repo, 'config', 'commit.gpgsign', 'false');
  write(repo, 'app.js', ['a']); const A = commitAll(repo, 'A');
  g(repo, 'checkout', '-q', '-b', 'feat/o'); write(repo, 'app.js', ['a', 'old']);
  const old = at(-48).toISOString(), oenv = { ...GENV, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old };
  execFileSync('git', ['-C', repo, 'commit', '-q', '-am', 'X: the old round'], { env: oenv, stdio: 'ignore' }); const X = g(repo, 'rev-parse', 'HEAD');
  g(repo, 'update-ref', 'refs/remotes/origin/feat/o', X); g(repo, 'checkout', '-q', 'main'); g(repo, 'branch', '-q', '-D', 'feat/o');
  g(repo, 'merge', '-q', '--squash', X); commitAll(repo, 'X squashed');
  g(repo, 'checkout', '-q', '-b', 'new-round'); write(repo, 'app.js', ['a', 'old', 'new']); const B = commitAll(repo, 'B: the new round'); g(repo, 'checkout', '-q', 'main');
  assert.equal(g(repo, 'merge-base', X, B), A, 'X diverged from the DONE tip');
  const state = tmp('state'), id = mkDlv(state, { repo, branch: 'feat/o', tip: B, delivers: 'o', done_utc: at(-10).toISOString() });
  record(state, { kind: 'deliverable', ev: 'done', id, by: 'launcher', data: { tip: B } }, { now: () => at(-9), views: false });
  const cfg = { repo, main: 'main', remote: 'origin', native: null, history: [] }, git = makeGit();
  const j = judge(loadDeliverables(state)[id], repoScanner({ cfg, cache: {}, git, install: null }).get(repo), { cfg, git });
  assert.equal(j.merge, null, 'the old squashed round on origin/feat/o is not this work');
  assert.deepEqual([j.g.tip, j.g.ahead, j.g.exists], [B, 1, true]);
});
