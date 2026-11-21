// LANE-TRUTH (owner 2026-11-20, P0): one answer to "is this work on main" (dlvmerge.mjs landedOf / laneShipped) for every reader - the
// Lanes row and board, the next line, the PR track, the Inbox, norn_inbox, the archive gate, the tick and another home's copies. One test
// per evidence case of the brief (rm29, rm26, solve-shack model-tab-residual-trail, the Inbox done-not-merged list, the needs-you count)
// plus the git fixtures: a cherry-equal branch, a branch deleted after its merged PR, a branch renamed norn/x -> norn/b/x.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { record, loadState } from '../engine/lib/records.mjs';
import { laneShipped, landedOf, dlvMerged } from '../engine/lib/dlvmerge.mjs';
import { laneHooks, laneRules, tickLanes, laneAsksOwner } from '../engine/lib/lifecycle.mjs';
import { lanesView, boardOf, prStep } from '../engine/lib/lanes.mjs';
import { laneNext, laneNow } from '../engine/lib/laneout.mjs';
import { deliverablesView, latchMerged, mergeBacklog, loadDeliverables } from '../engine/lib/deliverables.mjs';
import { dlvCopyRow } from '../engine/lib/roadmap.mjs';
import { needsYou } from '../engine/lib/mcp.mjs';
import { deliverablesCard } from '../engine/dash/ui.mjs';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';

test.after(cleanTmp);
const NOW = Date.parse('2026-11-20T18:00:00Z'), H = 3600e3, at = h => () => new Date(NOW + h * H);
const rec = (state, ev, h) => record(state, ev, { views: false, now: at(h) });
const lane = (state, name, h = -30) => rec(state, { kind: 'lane', ev: 'create', id: `L:${name}`, by: 'owner', data: { name } }, h);
const park = (state, name, why, h = -2) => rec(state, { kind: 'lane', ev: 'park', id: `L:${name}`, by: 'checkin', data: { why } }, h);
const run = (state, name, h, outcome, extra = {}) => { const id = rec(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: name, ...extra } }, h).id;
  rec(state, { kind: 'run', ev: 'end', id, by: 'launcher', data: { exit: 0, outcome, ...(outcome === 'stopped' ? { why: 'reds' } : {}) } }, h + 0.5); return id; };
const dlv = (state, name, o = {}, h = -20) => rec(state, { kind: 'deliverable', ev: 'create', by: 'launcher', data: { repo: o.repo ?? 'C:/r', branch: o.branch ?? `norn/${name}`, lane: name, tip: o.tip ?? 'abc1234', run: o.run, delivers: name } }, h).id;
const prEv = (state, id, n, h = -10) => rec(state, { kind: 'deliverable', ev: 'pr', id, by: 'launcher', data: { url: `https://github.com/o/r/pull/${n}`, number: n } }, h);
const mergedEv = (state, id, n, h = -5) => rec(state, { kind: 'deliverable', ev: 'merged', id, by: 'checkin', data: { how: 'pr', pr: n, url: `https://github.com/o/r/pull/${n}`, merged_at: new Date(NOW + h * H).toISOString() } }, h);
const noGit = () => null;
const view = (state, o = {}) => Object.fromEntries(lanesView(loadState(state), { all: true, now: NOW, ...laneHooks(state), ...o }).map(l => [l.name, l]));

test('rm29: a parked lane whose PR merged reads shipped once - not parked, not needs you, no Open Inbox; the tick archives it', () => {
  const state = mkTmp('lt-rm29-');
  lane(state, 'rm29'); const r = run(state, 'rm29', -25, 'done');
  const d = dlv(state, 'rm29', { run: r }); prEv(state, d, 29); mergedEv(state, d, 29, -6);
  park(state, 'rm29', 'DEC-b-31 ruled RUN-b-418; r2 brief ready - start it when merge backlog row 0c clears');
  const v = view(state, { prs: { rm29: { number: 29, url: 'u' } } }).rm29;
  assert.equal(v.text, `shipped: ${d} PR #29`); assert.equal(v.shipped, `${d} PR #29`);
  assert.equal(v.group, 'done'); assert.equal(v.land, null); assert.equal(v.pr, null); assert.doesNotMatch(v.text, /parked/);
  assert.equal(v.rule.rule, 'shipped'); assert.equal(v.rule.text, 'archives at the next tick', 'the rule never repeats parked / stopped');
  assert.equal(boardOf({ ...v, needs: 1 }, NOW), 'old', 'never Needs you / Parked, whatever asks about it');
  const h = laneHooks(state);
  assert.equal(laneAsksOwner(h, 'rm29', { parked: true }), false, 'no parked row in the Inbox');
  assert.equal(needsYou(loadState(state).items['L:rm29'], h, state), null, 'norn_inbox says the same'); assert.equal(needsYou(loadState(state).items['L:rm29']), 'parked lane', 'without the hooks: as before');
  assert.equal(laneNow({ lane: 'rm29', items: loadState(state).items, rows: [{ id: d, lane: 'rm29', state: 'merged', prs: [{ number: 29, state: 'merged', merged_at: '2026-11-19T17:18:16Z' }] }], shipped: v.shipped }).next.words, 'shipped: PR #29 merged 2026-11-19');
  const out = tickLanes(state, { now: NOW, git: noGit });
  assert.deepEqual(out.map(x => [x.id, x.rule]), [['L:rm29', 'shipped']]); assert.equal(loadState(state).items['L:rm29'].state, 'archived');
});

test('rm26: a superseded deliverable whose PR merged long ago is never "to land" or "PR #28 awaiting your approval"', () => {
  const state = mkTmp('lt-rm26-');
  lane(state, 'rm26'); const r = run(state, 'rm26', -25, 'done');
  const d = dlv(state, 'rm26', { run: r }); prEv(state, d, 28);
  rec(state, { kind: 'deliverable', ev: 'supersede', id: d, by: 'checkin', data: { by: '3a55f8fc8', why: 'its branch merged on main as PR #28 (3a55f8fc8)' } }, -4);
  assert.equal(landedOf(loadDeliverables(state)[d]).how, 'superseded');
  const v = view(state).rm26;
  assert.match(v.text, new RegExp(`^shipped: ${d} landed \\(superseded by 3a55f8fc8\\)$`)); assert.equal(v.group, 'done');
  const row = { id: d, lane: 'rm26', state: 'done', record_state: 'superseded', superseded: { by: '3a55f8fc8' }, pr: { url: 'u', number: 28 }, branch: 'norn/b/rm26', done_utc: new Date(NOW - 25 * H).toISOString() };
  assert.equal(prStep([row]).step, 'merged', 'the PR track: merged, not PR');
  assert.equal(boardOf({ ...v, dlv: prStep([row]), needs: 0 }, NOW), 'old', 'not To land');
  assert.equal(mergeBacklog([row]).n, 0, 'not in the merge backlog');
  assert.equal(laneNext({ outcome: 'done', prs: [{ number: 28, state: 'open' }], shipped: v.shipped }).key, 'shipped', 'an uncached PR of landed work never reads awaiting approval');
  // the listing: the PR of a superseded deliverable reads merged (no GitHub answer cached for it)
  const repo = mkTmp('lt-rm26-repo-'); g(repo, 'init', '-q', '-b', 'main'); write(repo, 'a', 'a'); commitAll(repo, 'init');
  const rows = deliverablesView({ stateDir: state, project: { name: 't', root: repo, deliverables: { target: 'main' } }, now: NOW }).rows;
  assert.equal(rows[0].prs[0].state, 'merged');
});

test('solve-shack model-tab-residual-trail: parked "archive refused" with DLV-24 merged -> archives; one state, no stopped / parked / on track', () => {
  const state = mkTmp('lt-ss-');
  const L = 'model-tab-residual-trail';
  lane(state, L); const b = run(state, L, -28, 'done'); run(state, L, -26, 'stopped', { stage: 'MERGE' });
  const d = dlv(state, L, { run: b, tip: 'dbe4f3fa69fe77c9cc4eb44ed67fd20d525ffe01' }); prEv(state, d, 17, -24);
  park(state, L, 'work landed on main (DEC-36, RUN-229 landed); archive refused: engine reads DLV-24 unmerged though git cherry shows it on main', -20);
  assert.throws(() => rec(state, { kind: 'lane', ev: 'archive', id: `L:${L}`, by: 'checkin', data: { why: 'landed' } }, -19), /cannot be archived/, 'before the latch: the gate holds');
  mergedEv(state, d, 17, -15);
  const h = laneHooks(state), v = view(state)[L];
  assert.equal(v.text, `shipped: ${d} PR #17`); assert.equal(v.group, 'done'); assert.equal(v.handoff, null);
  assert.equal(laneAsksOwner(h, L), false, 'its unreviewed stopped MERGE run is no need: the work shipped');
  assert.equal(laneRules(loadState(state), { now: NOW, shipped: h.shipped, home: h.home }).find(x => x.lane === L).rule, 'shipped');
  rec(state, { kind: 'lane', ev: 'archive', id: `L:${L}`, by: 'checkin', data: { why: 'its work is on main' } }, -1);   // the gate reads the same truth
  assert.equal(loadState(state).items[`L:${L}`].state, 'archived');
});

test('the Inbox deliverables list: another home\'s merged DLV is merged and at its target, never DONE-not-merged', () => {
  const copy = (evs, state = 'open') => ({ id: 'DLV-a-7', home: 'a', state, created: '2026-11-19T10:00:00Z', data: { branch: 'norn/a/x', lane: 'x', delivers: 'x' },
    history: [{ ev: 'create', ts: '2026-11-19T10:00:00Z' }, ...evs] });
  const m = dlvCopyRow(copy([{ ev: 'merged', ts: 't', data: { how: 'pr', pr: 7 } }]));
  assert.equal(m.state, 'merged'); assert.equal(m.at_target, true); assert.equal(m.merge_pr, 7);
  const open = dlvCopyRow(copy([])); assert.equal(open.state, 'done'); assert.equal(open.at_target, false);
  const redone = dlvCopyRow(copy([{ ev: 'merged', ts: 't', data: { how: 'pr', pr: 7 } }, { ev: 'done', ts: 't2', data: {} }]));
  assert.equal(redone.state, 'done', 'a DONE after the merge = new work, not merged');
  const html = deliverablesCard({ rows: [{ ...m, project: 'norn' }], backlog: mergeBacklog([m]) });
  assert.match(html, /Done, not installed <b>0<\/b>/); assert.doesNotMatch(html, /DLV-a-7/);
});

test('needs you: a parked lane with shipped work or no branch left asks nothing; one with a branch and unlanded work does', () => {
  const state = mkTmp('lt-needs-');
  for (const n of ['shipped-one', 'no-branch', 'has-branch']) { lane(state, n); park(state, n, 'deferred'); }
  const d = dlv(state, 'shipped-one'); mergedEv(state, d, 30); dlv(state, 'has-branch');
  const ask = n => laneAsksOwner(laneHooks(state), n, { parked: true });
  assert.deepEqual(['shipped-one', 'no-branch', 'has-branch'].map(ask), [false, true, true], 'no branch scan yet: unknown keeps the row');
  fs.writeFileSync(path.join(state, 'branches.json'), JSON.stringify({ refs: [{ name: 'norn/has-branch', merged: false }] }));
  assert.deepEqual(['shipped-one', 'no-branch', 'has-branch'].map(ask), [false, false, true]);
  const items = Object.values(loadState(state).items), h = laneHooks(state);
  assert.equal(items.filter(i => needsYou(i, h, state)).length, 1, 'norn_inbox counts the one real item');
});

// ---------- the git fixtures ----------
const GENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
function g(repo, ...a) { return execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: GENV, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim(); }
function write(repo, f, text) { fs.writeFileSync(path.join(repo, f), text + '\n'); }
function commitAll(repo, msg) { g(repo, 'add', '-A'); g(repo, 'commit', '-q', '-m', msg); return g(repo, 'rev-parse', 'HEAD'); }
function repoWith(branch) {
  const repo = mkTmp('lt-repo-'); g(repo, 'init', '-q', '-b', 'main'); g(repo, 'config', 'commit.gpgsign', 'false');
  write(repo, 'a.txt', 'a'); commitAll(repo, 'init');
  g(repo, 'checkout', '-q', '-b', branch); write(repo, 'b.txt', 'b'); const tip = commitAll(repo, 'feat: b');
  g(repo, 'checkout', '-q', 'main'); write(repo, 'c.txt', 'c'); commitAll(repo, 'main moves on');
  return { repo, tip };
}
const project = repo => ({ name: 't', root: repo, deliverables: { target: 'main' } });

test('git: a cherry-equal branch is on main; the tick latches it and the lane ships', () => {
  const { repo, tip } = repoWith('norn/x'), state = mkTmp('lt-cherry-');
  g(repo, 'cherry-pick', tip);   // its patch on main under another sha: no ancestry, git cherry says '-'
  lane(state, 'x'); run(state, 'x', -25, 'stopped');
  const d = dlv(state, 'x', { repo, branch: 'norn/x', tip });
  assert.equal(dlvMerged(loadDeliverables(state)[d]).merged, true);
  assert.equal(laneShipped({ dlvs: [loadDeliverables(state)[d]] }), null, 'not latched yet: the records do not say so');
  latchMerged(state, { project: project(repo), nowMs: NOW });
  assert.equal(landedOf(loadDeliverables(state)[d]).how, 'git');
  assert.equal(view(state).x.text, `shipped: ${d} on main`);
});

test('git: the branch deleted after its merged PR - still shipped (the latch), merged in the listing', () => {
  const { repo, tip } = repoWith('norn/y'), state = mkTmp('lt-gone-');
  lane(state, 'y'); run(state, 'y', -25, 'done');
  const d = dlv(state, 'y', { repo, branch: 'norn/y', tip }); prEv(state, d, 40); mergedEv(state, d, 40);
  g(repo, 'branch', '-q', '-D', 'norn/y');
  assert.equal(deliverablesView({ stateDir: state, project: project(repo), now: NOW }).rows[0].state, 'merged');
  assert.equal(laneHooks(state).shipped('y'), `${d} PR #40`);
});

test('git: a record naming norn/z is read under the renamed norn/b/z (the multi-home cut)', () => {
  const { repo } = repoWith('norn/b/z'), state = mkTmp('lt-rename-');
  g(repo, 'merge', '-q', '--no-edit', 'norn/b/z');
  const d = rec(state, { kind: 'deliverable', ev: 'create', by: 'launcher', data: { repo, branch: 'norn/z', lane: 'z', delivers: 'z' } }, -20).id;   // no tip recorded
  const row = deliverablesView({ stateDir: state, project: project(repo), now: NOW }).rows.find(r => r.id === d);
  assert.equal(row.branch_exists, true, 'found under its new name'); assert.equal(row.state, 'merged');
  assert.equal(dlvMerged(loadDeliverables(state)[d]).merged, true, 'the archive gate / --after dlv: answer the same');
});
