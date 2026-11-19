// The Branches view (owner ask 2026-11-19): branches.mjs - the one state function on a fixture per state, the git scan on a synthetic
// repo (an ancestor, a rebased branch whose patches are on main, an unmerged one, a detached worktree), the deliverable that tracks a
// branch of another name, the owner's row actions with their Undo, and the Lanes page's Branches / Worktrees sub-views.
// Synthetic repos and state dirs in temp dirs only; no live state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { record, loadState } from '../engine/lib/records.mjs';
import { branchState, branchesView, scanBranches, refreshBranches, readBranches, deleteBranch, restoreBranch, removeWorktree, restoreWorktree, adoptBranch,
  branchSlug, BRANCH_STATES, BranchActError, gitA } from '../engine/lib/branches.mjs';
import { loadDeliverables } from '../engine/lib/deliverables.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

test.after(cleanTmp);
const NOW = Date.parse('2026-11-19T12:00:00Z'), DAY = 864e5;

test('branchState: one fixture per state, in plain words', () => {
  const s = f => branchState({ merged: false, live: false, lane: null, lost: null, done: false, dlv: false, last: NOW - DAY, ...f }, { now: NOW, staleDays: 14 }).state;
  const lane = { name: 'x', state: 'active' };
  assert.equal(s({ live: true, lane }), 'in progress', 'a run is running or queued on it');
  assert.equal(s({ live: true, merged: true, lane }), 'in progress', 'a live run wins over merged');
  assert.equal(s({ lane }), 'in progress', 'an active lane, recent commit, nothing running: the lane is still at it');
  assert.equal(s({ lane, done: true }), 'awaiting merge', 'DONE, its work not on main');
  assert.equal(s({ dlv: true }), 'awaiting merge', 'a deliverable tracks it');
  assert.equal(s({ merged: true, lane }), 'merged', 'tip on main, lane still open');
  assert.equal(s({ merged: true }), 'stale', 'merged with no lane: prunable');
  assert.equal(s({ merged: true, lane: { name: 'x', state: 'archived' } }), 'stale', 'merged, lane archived: prunable');
  assert.equal(s({ merged: true, lane, last: NOW - 30 * DAY }), 'stale', 'merged and old');
  assert.equal(s({ lane, last: NOW - 30 * DAY }), 'stale', 'no commit in 14 days, nothing running');
  assert.equal(s({ lane: { name: 'x', state: 'archived' } }), 'stale', 'archived lane, work not on main');
  assert.equal(s({ lost: 'lane x has runs but no LANE record' }), 'lost');
  assert.equal(s({ lost: 'last run lost', done: true }), 'lost', 'lost wins over DONE');
  assert.equal(s({}), 'unknown', 'no lane, no deliverable: a hand branch');
  assert.equal(s({ last: NOW - 300 * DAY }), 'unknown', 'an old hand branch stays unknown (not part of a lane)');
  assert.match(branchState({ lane: null, last: NOW }, { now: NOW }).why, /not part of a lane/);
  assert.deepEqual(BRANCH_STATES, ['in progress', 'awaiting merge', 'unknown', 'lost', 'stale', 'merged']);
});

test('branchSlug: a deliverable tracked on feat/<a>-<b> is the work of norn/<a>/<b>', () => {
  assert.equal(branchSlug('feat/solve-shack-unattended-reconnect'), branchSlug('norn/solve-shack/unattended-reconnect'));
  assert.notEqual(branchSlug('feat/a-b'), branchSlug('norn/a-c'));
});

// ---------- a synthetic repo ----------
const GENV = { ...process.env, GIT_AUTHOR_NAME: 'ann', GIT_AUTHOR_EMAIL: 'a@t', GIT_COMMITTER_NAME: 'ann', GIT_COMMITTER_EMAIL: 'a@t', GIT_CONFIG_NOSYSTEM: '1' };
const g = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: GENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (repo, file, text, msg) => { fs.writeFileSync(path.join(repo, file), text); g(repo, 'add', file); g(repo, 'commit', '-q', '-m', msg); return g(repo, 'rev-parse', 'HEAD'); };
// main + norn/done-lane (ancestor of main), norn/rebased (its patch cherry-picked onto main: not an ancestor), norn/open (unmerged, a lane
// worktree), hand/backup (unmerged, no lane), feat/old-name (the deliverable's branch, gone), norn/new-name (where the work is), a detached worktree
function setup() {
  const root = mkTmp('brv-'), repo = path.join(root, 'repo'), state = path.join(root, 'state'), wt = path.join(root, 'wt');
  fs.mkdirSync(repo); fs.mkdirSync(state); fs.mkdirSync(wt);
  g(repo, 'init', '-q', '-b', 'main'); g(repo, 'config', 'commit.gpgsign', 'false');
  commit(repo, 'README.md', 'r\n', 'init');
  g(repo, 'checkout', '-q', '-b', 'norn/done-lane'); commit(repo, 'a.txt', 'a\n', 'feat: a'); g(repo, 'checkout', '-q', 'main'); g(repo, 'merge', '-q', '--no-ff', '-m', 'merge a', 'norn/done-lane');
  g(repo, 'checkout', '-q', '-b', 'norn/rebased'); const rb = commit(repo, 'b.txt', 'b\n', 'feat: b'); g(repo, 'checkout', '-q', 'main');
  commit(repo, 'c.txt', 'c\n', 'main moves'); g(repo, 'cherry-pick', rb);
  g(repo, 'checkout', '-q', '-b', 'norn/open'); commit(repo, 'd.txt', 'd\n', 'feat: d'); g(repo, 'checkout', '-q', 'main');
  g(repo, 'checkout', '-q', '-b', 'hand/backup'); commit(repo, 'e.txt', 'e\n', 'wip'); g(repo, 'checkout', '-q', 'main');
  g(repo, 'checkout', '-q', '-b', 'norn/new-name'); commit(repo, 'f.txt', 'f\n', 'feat: f'); g(repo, 'checkout', '-q', 'main');
  g(repo, 'checkout', '-q', '-b', 'norn/gone-rec'); commit(repo, 'h.txt', 'h\n', 'feat: h'); g(repo, 'checkout', '-q', 'main');
  const open = path.join(wt, 'open'), det = path.join(wt, 'mq', 'm1');
  g(repo, 'worktree', 'add', '-q', open, 'norn/open');
  g(repo, 'worktree', 'add', '-q', '--detach', det, 'main');
  const project = { name: 'p', root: repo, state, file: path.join(root, 'project.json'), deliverables: { repo } };
  // the records: lanes, runs, a deliverable on a branch of another name
  for (const n of ['done-lane', 'open', 'rebased']) record(state, { kind: 'lane', ev: 'create', by: 'controller', data: { name: n, ...(n === 'open' ? { worktree: open.replace(/\\/g, '/'), branch: 'norn/open' } : {}) } });
  record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'open', worktree: open.replace(/\\/g, '/') } });   // RUN-1 running (live set says)
  record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'gone-rec' } });   // RUN-2: a lane with no LANE record
  record(state, { kind: 'run', ev: 'end', id: 'RUN-2', by: 'launcher', data: { exit: 0, outcome: 'done' } });
  record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', stage: 'MERGE', executor: 'claude', worktree: det.replace(/\\/g, '/') } });   // RUN-3: the merge worktree's run
  record(state, { kind: 'run', ev: 'end', id: 'RUN-3', by: 'launcher', data: { exit: 0, outcome: 'done' } });
  record(state, { kind: 'deliverable', ev: 'create', by: 'launcher', data: { repo, branch: 'feat/new-name', tip: g(repo, 'rev-parse', 'norn/new-name'), lane: 'new-name', delivers: 'f', done_utc: '2026-11-19T06:00:00Z', source: 'run' } });
  return { root, repo, state, project, open, det };
}
const dlvsOf = f => Object.values(loadDeliverables(f.state));

test('scan + view: ancestor and rebased branches read merged, a deliverable on a renamed branch links, detached worktrees show with their run', async () => {
  const f = setup();
  const c = await refreshBranches(f.project, { gh: null });
  assert.equal(c.error, undefined);
  const refs = Object.fromEntries(c.refs.map(r => [r.name, r]));
  assert.equal(refs['norn/done-lane'].merged, true); assert.equal(refs['norn/done-lane'].how, 'on main');
  assert.equal(refs['norn/rebased'].merged, true, 'its patch is on main after the rebase / cherry-pick'); assert.equal(refs['norn/rebased'].how, 'patches on main');
  assert.equal(refs['norn/open'].merged, false); assert.equal(refs['norn/open'].ahead, 1);
  assert.ok(!refs.main, 'main itself is not a row');
  assert.equal(c.worktrees.length, 3, 'the main checkout, the lane worktree, the detached one');
  assert.ok(c.memo.not[refs['norn/open'].local.sha], 'the unmerged answer is cached per main sha');
  // a warm scan asks cherry for nothing that did not move
  const calls = [];
  const spy = (args, cwd) => { calls.push(args[0]); return gitA(args, cwd); };
  await scanBranches(f.repo, { git: spy, gh: null, memo: readBranches(f.state).memo });
  assert.equal(calls.filter(x => x === 'cherry').length, 0, 'every tip answered from the memo');

  const v = branchesView({ facts: readBranches(f.state), items: loadState(f.state).items, live: new Set(['RUN-1']), dlvs: dlvsOf(f), project: 'p', now: Date.now() });
  const row = Object.fromEntries(v.rows.map(r => [r.name, r]));
  assert.equal(row['norn/open'].state, 'in progress'); assert.equal(row['norn/open'].why, 'RUN-1 is running'); assert.equal(row['norn/open'].lane.name, 'open'); assert.equal(row['norn/open'].worktree.dirty, 0);
  assert.equal(row['norn/done-lane'].state, 'merged', 'merged, its lane still active');
  assert.equal(row['norn/rebased'].state, 'merged');
  assert.equal(row['hand/backup'].state, 'unknown'); assert.equal(row['hand/backup'].lane, null); assert.match(row['hand/backup'].why, /not part of a lane/);
  assert.equal(row['norn/gone-rec'].state, 'lost', 'its lane has runs but no LANE record'); assert.match(row['norn/gone-rec'].why, /no LANE record/);
  assert.equal(row['norn/new-name'].state, 'awaiting merge', 'tracked by a deliverable');
  assert.deepEqual([row['norn/new-name'].dlv.id, row['norn/new-name'].dlv.via, row['norn/new-name'].dlv.branch], ['DLV-1', 'name', 'feat/new-name'], 'the deliverable tracked on a branch of another name links');
  const det = v.rows.find(r => r.kind === 'worktree');
  assert.ok(det, 'the detached worktree is a row'); assert.equal(det.run.id, 'RUN-3'); assert.equal(det.state, 'stale', 'a merge worktree its ended run left');
  // the order: in progress, awaiting merge, unknown, lost, stale, merged
  const order = v.rows.map(r => BRANCH_STATES.indexOf(r.state));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  // the actions offered: only what cannot lose unmerged work
  assert.ok(!row['norn/open'].acts.includes('rmwt'), 'no worktree removal while a run uses it');
  assert.ok(row['norn/done-lane'].acts.includes('delete')); assert.ok(!row['hand/backup'].acts.includes('delete'));
  assert.ok(row['hand/backup'].acts.includes('adopt')); assert.ok(!row['norn/open'].acts.includes('adopt'));
  assert.ok(det.acts.includes('rmwt'), 'a clean detached worktree no run uses can go');
  // the lane's run ends: its row is no longer in progress; lost when the run is lost
  const v2 = branchesView({ facts: readBranches(f.state), items: loadState(f.state).items, live: new Set(), dlvs: dlvsOf(f), project: 'p', now: Date.now() });
  assert.equal(v2.rows.find(r => r.name === 'norn/open').state, 'lost', 'RUN-1 says running with no heartbeat: lost');
});

test('row actions: delete a merged branch (Undo restores it), refuse an unmerged one; remove a clean worktree (Undo adds it back); adopt', async () => {
  const f = setup();
  await refreshBranches(f.project, { gh: null });
  const tip = g(f.repo, 'rev-parse', 'norn/done-lane');
  assert.throws(() => deleteBranch(f.project, 'hand/backup'), BranchActError, 'an unmerged branch is never deleted');
  assert.throws(() => deleteBranch(f.project, '--force'), BranchActError);
  const u = deleteBranch(f.project, 'norn/done-lane');
  assert.equal(u.local, tip);
  assert.equal(execFileSync('git', ['-C', f.repo, 'branch', '--list', 'norn/done-lane'], { encoding: 'utf8' }).trim(), '');
  assert.ok(!readBranches(f.state).refs.some(r => r.name === 'norn/done-lane'), 'the cache drops the row at once');
  restoreBranch(f.project, u);
  assert.equal(g(f.repo, 'rev-parse', 'norn/done-lane'), tip, 'Undo: the branch is back at the same commit');
  // a worktree that got an uncommitted file after the scan (the cache still says clean) is kept: git refuses it, never --force;
  // a clean one goes, and Undo adds it back
  fs.writeFileSync(path.join(f.det, 'x.txt'), 'x');
  assert.throws(() => removeWorktree(f.project, f.det), BranchActError, 'dirty: kept');
  assert.equal(fs.existsSync(path.join(f.det, 'x.txt')), true);
  fs.rmSync(path.join(f.det, 'x.txt'));
  const w = removeWorktree(f.project, f.det);
  assert.equal(fs.existsSync(f.det), false);
  restoreWorktree(f.project, w);
  assert.equal(fs.existsSync(path.join(f.det, 'README.md')), true, 'Undo: the detached worktree is back');
  // adopt: a LANE record for a branch no lane owns
  const a = adoptBranch(f.project, 'hand/backup');
  assert.equal(a.lane, 'backup');
  const l = loadState(f.state).items['L:backup'];
  assert.equal(l.data.branch, 'hand/backup');
  const v = branchesView({ facts: readBranches(f.state), items: loadState(f.state).items, live: new Set(), dlvs: [], project: 'p', now: Date.now() });
  assert.equal(v.rows.find(r => r.name === 'hand/backup').lane.name, 'backup', 'the branch now belongs to the lane');
  assert.throws(() => adoptBranch(f.project, 'hand/backup'), BranchActError, 'adopted once');
});

test('Lanes page: 3 sub-views; Branches lists rows with state chips, filters and actions; not scanned yet says so', () => {
  const rows = [
    { project: 'p', name: 'norn/a', kind: 'branch', where: 'both', diverged: false, ahead: 2, behind: 1, last: NOW - DAY, author: 'ann', subject: 'feat: a', merged: false, how: null,
      worktree: { path: 'C:/x/wt/a', dirty: 3, missing: false, primary: false }, lane: { name: 'a', state: 'active' }, run: { id: 'RUN-4', state: 'running', outcome: null }, dlv: null, pr: { number: 7, state: 'open', url: 'https://github.com/o/r/pull/7' }, state: 'in progress', why: 'a run is running or queued on it', acts: [] },
    { project: 'p', name: 'hand/b', kind: 'branch', where: 'remote', diverged: false, ahead: 1, behind: 0, last: NOW - 3 * DAY, author: 'bob', subject: 'wip', merged: false, how: null,
      worktree: null, lane: null, run: null, dlv: null, pr: null, state: 'unknown', why: 'not part of a lane', acts: ['pr', 'adopt'], pr_new: 'https://github.com/o/r/compare/main...hand/b?expand=1' },
    { project: 'p', name: 'norn/c', kind: 'branch', where: 'local', diverged: false, ahead: 0, behind: 5, last: NOW - 20 * DAY, author: 'ann', subject: 'feat: c', merged: true, how: 'on main',
      worktree: null, lane: null, run: null, dlv: { id: 'DLV-9', via: 'name', branch: 'feat/c' }, pr: null, state: 'stale', why: 'its work is on main, no lane: prunable', acts: ['delete'] },
  ];
  const d = { sub: 'branches', rows, states: BRANCH_STATES, counts: { 'in progress': 1, unknown: 1, stale: 1 }, scans: [{ project: 'p', at: new Date(NOW - 5 * 60000).toISOString(), error: null }] };
  const html = renderTab('lanes', d, { project: 'p', now: NOW });
  for (const id of ['lanes-sub-lanes', 'lanes-sub-branches', 'lanes-sub-worktrees']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /aria-selected="true" class="strong">Branches/);
  assert.match(html, /scanned 5 min ago/);
  assert.match(html, /data-act="br-state" data-state="awaiting merge"/);
  assert.match(html, /data-act="br-where" data-where="remote"/);
  assert.match(html, /<option value="a">a<\/option>/, 'the lane filter lists the lanes in the rows');
  assert.match(html, /data-act="br-delete" data-project="p" data-branch="norn\/c"/);
  assert.match(html, /data-act="br-adopt" data-project="p" data-branch="hand\/b"/);
  assert.match(html, /href="https:\/\/github.com\/o\/r\/compare\/main...hand\/b\?expand=1"/);
  assert.match(html, /DLV-9<\/span> <span class="mute">tracked as feat\/c/);
  assert.match(html, /3 uncommitted/);
  // filters: only unknown, origin only
  const f2 = renderTab('lanes', d, { project: 'p', now: NOW, br: { states: new Set(['unknown']), where: 'remote', lane: '' } });
  assert.ok(f2.includes('hand/b') && !f2.includes('norn/a</b>') && !f2.includes('norn/c</b>'));
  // Worktrees: the rows with a worktree
  const w = renderTab('lanes', { ...d, sub: 'worktrees' }, { project: 'p', now: NOW });
  assert.ok(w.includes('norn/a</b>') && !w.includes('hand/b</b>'));
  // not scanned yet
  const e = renderTab('lanes', { sub: 'branches', rows: [], states: BRANCH_STATES, counts: {}, scans: [{ project: 'p', at: null, error: null }] }, { project: 'p', now: NOW });
  assert.match(e, /Not scanned yet/); assert.match(e, /data-act="br-scan"/);
  // the Lanes sub-view still shows the lane table
  const l = renderTab('lanes', { sub: 'lanes', lanes: [] }, { project: 'p', now: NOW });
  assert.match(l, /No LANE records/); assert.match(l, /lanes-sub-branches/);
});

// ---------- the dashboard: the route, the row action through the CLI child, the phone ----------
// a fixture repo for the dash project: main + a merged branch + an unmerged hand branch, scanned into its branches.json
async function dashRepo(f) {
  const repo = f.pa.root;
  g(repo, 'init', '-q', '-b', 'main'); g(repo, 'config', 'commit.gpgsign', 'false'); commit(repo, 'README.md', 'r\n', 'init');
  g(repo, 'checkout', '-q', '-b', 'norn/landed-with-a-rather-long-branch-name-for-the-phone'); commit(repo, 'a.txt', 'a\n', 'feat: a'); g(repo, 'checkout', '-q', 'main');
  g(repo, 'merge', '-q', '--no-ff', '-m', 'merge a', 'norn/landed-with-a-rather-long-branch-name-for-the-phone');
  g(repo, 'checkout', '-q', '-b', 'hand/wip'); commit(repo, 'w.txt', 'w\n', 'wip'); g(repo, 'checkout', '-q', 'main');
  await refreshBranches(f.pa, { gh: null });
}

test('GET /api/branches + POST /api/branches/act: the rows with states; delete a merged branch, Undo restores it; an unmerged one is refused', { timeout: 900000 }, async () => {
  const f = await fixture();
  try {
    await dashRepo(f);
    const r = await f.get('/api/branches?project=kestrel');
    assert.equal(r.status, 200);
    const row = Object.fromEntries(r.data.rows.map(x => [x.name, x]));
    assert.equal(row['hand/wip'].state, 'unknown'); assert.equal(row['hand/wip'].project, 'kestrel');
    assert.equal(row['norn/landed-with-a-rather-long-branch-name-for-the-phone'].state, 'stale');
    assert.deepEqual(r.data.states, BRANCH_STATES);
    assert.ok(r.data.scans[0].at, 'the scan time');
    const all = await f.get('/api/branches?project=all');
    assert.ok(all.data.rows.length >= 2, 'the all-projects view lists every project\'s rows');
    const no = await f.post('/api/branches/act', { project: 'kestrel', act: 'delete', branch: 'hand/wip' });
    assert.equal(no.status, 409, 'an unmerged branch is refused'); assert.match(no.data.error ?? JSON.stringify(no.data), /cannot be deleted/);
    const name = 'norn/landed-with-a-rather-long-branch-name-for-the-phone', tip = g(f.pa.root, 'rev-parse', name);
    const d = await f.post('/api/branches/act', { project: 'kestrel', act: 'delete', branch: name });
    assert.equal(d.status, 200, JSON.stringify(d.data)); assert.equal(d.data.undo.local, tip);
    assert.equal(execFileSync('git', ['-C', f.pa.root, 'branch', '--list', name], { encoding: 'utf8' }).trim(), '');
    const u = await f.post('/api/branches/act', { project: 'kestrel', act: 'undo', undo: d.data.undo });
    assert.equal(u.status, 200, JSON.stringify(u.data));
    assert.equal(g(f.pa.root, 'rev-parse', name), tip, 'Undo: back at the same commit');
    assert.equal((await f.post('/api/branches/act', { project: 'kestrel', act: 'prune' })).status, 400, 'only the four verbs');
  } finally { await f.done(); }
});

test('the browser: Branches at 390 px has no sideways scroll; a state chip and the lane filter hide rows; Worktrees lists the worktrees', { skip: skipWhy, timeout: 900000 }, async () => {
  const f = await fixture(), pg = await openPage([390, 844]);
  try {
    await dashRepo(f);
    await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await pg.go(`${f.url}/?project=kestrel&tab=lanes&sub=branches`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'lanes' && !!document.querySelector('table.brtab [data-state=unknown]')`, 90000), 'Branches shows the rows');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on Branches at 390 px');
    await pg.ev(`document.querySelector('[data-act=br-state][data-state=unknown]').click()`);
    assert.ok(await pg.until(`!document.querySelector('table.brtab [data-state=unknown]') && !!document.querySelector('table.brtab [data-state=stale]')`, 30000), 'unknown off hides the hand branch only');
    await pg.ev(`(s => { s.value = '-'; s.dispatchEvent(new Event('change', { bubbles: true })); })(document.querySelector('select[data-br=lane]'))`);
    assert.ok(await pg.until(`!!document.querySelector('table.brtab [data-state=stale]')`, 30000), 'not part of a lane keeps the lane-less rows');
    await pg.ev(`document.querySelector('[data-act=sub][data-sub=worktrees]').click()`);
    assert.ok(await pg.until(`document.querySelector('#lanes-sub')?.dataset.sub === 'worktrees'`, 60000), 'the Worktrees sub-view');
    assert.match(await pg.ev('location.search'), /sub=worktrees/);
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on Worktrees at 390 px');
  } finally { await pg.close(); await f.done(); }
});
