// DLV-MERGED-TRUTH: a deliverable's MERGED comes from its PR (gh, latched by the tick), else git, else its change found on main
// ('merged (equivalent)'); a deleted branch never turns merged work back into DONE; what cannot be decided asks the owner once.
// Fixture git repos in temp dirs; gh is a fake (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { record } from '../engine/lib/records.mjs';
import { deliverablesView, latchMerged, loadDeliverables, dlvMerged } from '../engine/lib/deliverables.mjs';
import { contentOnMain } from '../engine/lib/dlvgit.mjs';
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
  assert.deepEqual(calls[0], ['pr', 'view', 'https://github.com/o/r/pull/34', '--json', 'state,mergedAt,mergeCommit']);
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
