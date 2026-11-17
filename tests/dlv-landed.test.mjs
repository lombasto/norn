// META-DLV-LANDED R1: a deliverable whose WORK is on main is merged everywhere it is derived (deliverablesView -> `norn deliverables`,
// the merge queue -> Plan "Landing next", digest, dashboard), by the one rule of after.mjs workOnMain (ancestry / patch-id / squash /
// a branch that adds nothing to main). The live case (DLV-45, 11-13): merged as 7b3d67d, then the merge queue's update step merged main
// into the branch (8a919e3), so the branch tip was no ancestor of main and the DLV read "ready to merge" for hours.
// Synthetic repos in temp dirs only; no live state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { record } from '../engine/lib/records.mjs';
import { deliverablesView } from '../engine/lib/deliverables.mjs';
import { mergeQueue } from '../engine/lib/mergeq.mjs';
import { makeEval } from '../engine/lib/after.mjs';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';

test.after(cleanTmp);
const GENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
const g = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: GENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (repo, file, text, msg) => {
  fs.writeFileSync(path.join(repo, file), text);
  g(repo, 'add', file); g(repo, 'commit', '-q', '-m', msg);
  return g(repo, 'rev-parse', 'HEAD');
};
const NOW = Date.parse('2026-11-13T12:00:00Z');

// a repo with main + one branch per case, a state dir with one DLV per branch (tip = the DONE tip); `land` shapes main + branches
function setup(cases) {
  const repo = mkTmp('meta-dlvl-repo-'), state = mkTmp('meta-dlvl-state-');
  g(repo, 'init', '-q', '-b', 'main'); g(repo, 'config', 'commit.gpgsign', 'false');
  commit(repo, 'README.md', 'r\n', 'init');
  commit(repo, 'shared.txt', 'base\n', 'shared');
  const ids = {};
  for (const [name, { file, text, n = 1 }] of Object.entries(cases)) {
    g(repo, 'checkout', '-q', '-b', `feat/${name}`, 'main');
    let tip;
    for (let i = 0; i < n; i++) tip = commit(repo, i ? `${file}.${i}` : file, `${text}${i}\n`, `feat(${name}): part ${i}`);
    g(repo, 'checkout', '-q', 'main');
    ids[name] = record(state, { kind: 'deliverable', ev: 'create', by: 'launcher',
      data: { repo, branch: `feat/${name}`, tip, lane: name, run: null, delivers: name, done_utc: '2026-11-13T06:00:00Z', source: 'run' } },
    { now: () => new Date(NOW - 6 * 3600e3), views: false }).id;
  }
  commit(repo, 'main-moved.txt', 'm\n', 'main moves on');   // every merge below is a real merge / rebase / squash
  const project = { name: 't', root: repo, state, lane_defaults: {}, deliverables: { target: 'main' } };
  return { repo, state, ids, project };
}
const pushBranches = repo => {
  for (const b of g(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n')) g(repo, 'update-ref', `refs/remotes/origin/${b}`, g(repo, 'rev-parse', b));
};

test('DLV-45 shape: merged by a merge commit, then the merge queue merged main INTO the branch - the DLV is merged, out of the queue, dlv:merged met', () => {
  const s = setup({ ootb: { file: 'ootb.txt', text: 'o' }, open: { file: 'open.txt', text: 'x' } });
  g(s.repo, 'merge', '-q', '--no-ff', '-m', 'merge: feat/ootb', 'feat/ootb');
  commit(s.repo, 'later.txt', 'l\n', 'main moves on after the merge');
  // the merge queue's update step: main into the (already merged) branch -> a new tip that is no ancestor of main
  g(s.repo, 'checkout', '-q', 'feat/ootb'); g(s.repo, 'merge', '-q', '--no-ff', '-m', 'merge: main into feat/ootb (mergeq update)', 'main'); g(s.repo, 'checkout', '-q', 'main');
  pushBranches(s.repo);
  const rows = Object.fromEntries(deliverablesView({ stateDir: s.state, project: s.project, now: NOW }).rows.map(r => [r.id, r]));
  assert.equal(rows[s.ids.ootb].state, 'merged', 'its work is on main');
  assert.equal(rows[s.ids.ootb].at_target, true);
  assert.equal(rows[s.ids.open].state, 'done', 'an unmerged branch stays done');
  const q = mergeQueue({ stateDir: s.state, project: s.project, now: NOW }).rows.map(r => r.id);
  assert.deepEqual(q, [s.ids.open], 'Landing next lists only the unmerged one');
  const ev = makeEval(s.state);
  assert.equal(ev({ kind: 'dlv', id: s.ids.ootb, state: 'merged' }).met, true);
  assert.equal(ev({ kind: 'dlv', id: s.ids.open, state: 'merged' }).met, false);
  // the same view a second time (cache warm) says the same
  assert.equal(deliverablesView({ stateDir: s.state, project: s.project, now: NOW }).rows.find(r => r.id === s.ids.ootb).state, 'merged');
});

test('rule 5: the merge queue syncs main INTO the branch, then main merges the PRE-sync tip - merged; a sync that adds its own edit stays done', () => {
  const s = setup({ ootb: { file: 'ootb.txt', text: 'o', n: 2 }, evil: { file: 'evil.txt', text: 'e', n: 2 } })   // two commits each: no single patch-id is the branch;
  // the real DLV-123 shape: sync 1 (main into the branch), main moves on, sync 2 (main again), THEN main merges sync 1, not sync 2.
  // Sync 2's merge-bases (sync 1, the old main) are a criss-cross whose trees differ from its own - rules 2-4 cannot see it.
  const sync = (b, msg, edit) => {
    g(s.repo, 'checkout', '-q', b); g(s.repo, 'merge', '-q', '--no-ff', '--no-commit', 'main');
    if (edit) { fs.writeFileSync(path.join(s.repo, edit), 'changed in the merge\n'); g(s.repo, 'add', edit); }
    g(s.repo, 'commit', '-q', '-m', msg); g(s.repo, 'checkout', '-q', 'main');
    return g(s.repo, 'rev-parse', b);
  };
  const s1 = { ootb: sync('feat/ootb', 'merge: main into feat/ootb (sync 1)'), evil: sync('feat/evil', 'merge: main into feat/evil (sync 1)') };
  commit(s.repo, 'second.txt', 's\n', 'main moves on');
  commit(s.repo, 'third.txt', 't\n', 'main moves on again (two commits: no single patch-id matches the sync)');
  sync('feat/ootb', 'merge: main into feat/ootb (sync 2)');
  sync('feat/evil', 'merge: main into feat/evil (sync 2, with an edit of its own)', 'evil.txt');   // work that is on no main
  g(s.repo, 'merge', '-q', '--no-ff', '-m', 'merge: feat/ootb at sync 1', s1.ootb);
  g(s.repo, 'merge', '-q', '--no-ff', '-m', 'merge: feat/evil at sync 1', s1.evil);
  pushBranches(s.repo);
  const rows = Object.fromEntries(deliverablesView({ stateDir: s.state, project: s.project, now: NOW }).rows.map(r => [r.id, r]));
  assert.equal(rows[s.ids.ootb].state, 'merged', 'only clean syncs of main beyond main: landed');
  assert.equal(rows[s.ids.evil].state, 'done', 'the edit inside the merge is unlanded work');
});

test('rebase (new shas) and squash: the branch ref keeps the old tip, the DLV is merged; a conflicting DLV stays done with a conflict', () => {
  const s = setup({ reb: { file: 'reb.txt', text: 'r', n: 2 }, sq: { file: 'sq.txt', text: 's', n: 2 }, clash: { file: 'shared.txt', text: 'branch' } });
  // rebase: the MERGE cherry-picks the branch's commits onto main (new shas); the branch ref is not moved
  for (const c of g(s.repo, 'rev-list', '--reverse', 'main..feat/reb').split('\n')) g(s.repo, 'cherry-pick', '--allow-empty', c);
  // squash: one commit with the whole branch diff
  g(s.repo, 'merge', '-q', '--squash', 'feat/sq'); g(s.repo, 'commit', '-q', '-m', 'squash sq');
  commit(s.repo, 'shared.txt', 'main\n', 'main edits the shared line');   // feat/clash now conflicts
  pushBranches(s.repo);
  const rows = Object.fromEntries(deliverablesView({ stateDir: s.state, project: s.project, now: NOW }).rows.map(r => [r.id, r]));
  assert.equal(rows[s.ids.reb].state, 'merged', 'rebase');
  assert.equal(rows[s.ids.sq].state, 'merged', 'squash');
  assert.equal(rows[s.ids.clash].state, 'done');
  assert.equal(rows[s.ids.clash].rehearsal?.clean, false);
  const q = mergeQueue({ stateDir: s.state, project: s.project, now: NOW }).rows;
  assert.deepEqual(q.map(r => r.id), [s.ids.clash]);
  assert.match(q[0].word, /^conflict/, 'Plan words it "needs a conflict fix first"');
});
