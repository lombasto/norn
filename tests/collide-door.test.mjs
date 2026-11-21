// lane-collide S1b: the collision door in startRun and the fill walk, on temp git repos and records (made-up lanes: web-nav restructures,
// web-runs works inside it, base / top are a stacked pair). A run behind an `Exclusive:` holder is queued, named in the walk and starts by
// itself once the holder's work is on main; a stacked run waits for `after (auto)`; two queued runs never wait on each other; `allow`
// releases a hold and its case records it; a warned run starts with the `collide:` lines and the worker's prompt line.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkTmp } from './helpers/tmp.mjs';
import { settled } from './helpers/settled.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { startRun, fillQueue, readiness, readCollideHolds } from '../engine/lib/runs.mjs';
import { casesOf, actionsOf } from '../engine/lib/intents.mjs';
import { mergeQueue } from '../engine/lib/mergeq.mjs';
import { loadProject } from '../engine/lib/config.mjs';
import { parseAfter } from '../engine/lib/after.mjs';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, ...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const fwd = p => p.split(path.sep).join('/');
const NORN = path.join(import.meta.dirname, '..', 'engine', 'bin', 'norn.mjs');
const FILES = ['web/app.mjs', 'web/nav.mjs', 'web/pages/runs.mjs', 'web/pages/board.mjs', 'lib/core.mjs', 'lib/util.mjs', 'docs/guide.md'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 30000) { const t0 = performance.now(); for (;;) { const v = fn(); if (v) return v; if (performance.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(50); } }

function fixture() {
  const t = mkTmp('meta-cdoor-'), origin = path.join(t, 'origin.git'), home = path.join(t, 'home'), state = path.join(t, 'state', 'k'), locks = path.join(t, 'state', 'locks');
  git(t, 'init', '-q', '--bare', '-b', 'main', origin);
  git(t, 'clone', '-q', origin, home);
  git(home, 'checkout', '-q', '-b', 'main');
  for (const f of FILES) put(path.join(home, f), `// ${f}\n`);
  git(home, 'add', '-A'); git(home, 'commit', '-qm', 'base'); git(home, 'push', '-q', 'origin', 'main');
  for (const d of [state, locks]) fs.mkdirSync(d, { recursive: true });
  const pf = path.join(t, 'project.json');
  // land_wait_min 0: these tests are about the door's hold / after / warn, not S1c's land-first wait (collide-tick.test.mjs covers it)
  fs.writeFileSync(pf, JSON.stringify({ schema: 1, name: 'k', title: 'k', root: fwd(home), ledger: '${root}/L.md', briefs_dir: '${root}', policy: { slop: { enabled: false }, collide: { auto: { land_wait_min: 0 } } } }));
  const f = { t, home, state, locks, pf };
  f.lane = (lane, edits = {}, from = 'origin/main') => {
    const wt = path.join(t, 'wt', lane);
    git(home, 'worktree', 'add', '-q', '-b', `norn/${lane}`, wt, from);
    for (const [file, s] of Object.entries(edits)) { put(path.join(wt, file), s); git(wt, 'add', '-A'); git(wt, 'commit', '-qm', `${lane}: ${file}`); }
    return fwd(wt);
  };
  f.brief = (name, text) => { const p = path.join(t, 'briefs', `${name}.md`); put(p, text); return p; };
  /** an ended DONE run of lane L with its open deliverable: the unlanded work every later start is behind */
  f.unlanded = (lane, wt, brief) => {
    const run = record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane, stage: 'S1', worktree: wt, brief } }).id;
    record(state, { kind: 'run', ev: 'end', id: run, by: 'launcher', data: { outcome: 'done', exit: 0 } });
    const tip = git(home, 'rev-parse', `norn/${lane}`);
    return record(state, { kind: 'deliverable', ev: 'create', by: 'launcher', data: { repo: fwd(home), branch: `norn/${lane}`, tip, lane, run, delivers: lane, source: 'run', done_utc: new Date().toISOString() } }).id;
  };
  /** the lane's work lands: its branch is pushed to main and the home fetches it (origin/main moves) */
  f.land = lane => { git(home, 'push', '-q', 'origin', `norn/${lane}:main`); git(home, 'fetch', '-q', 'origin'); };
  f.opts = (o = {}) => ({ state, locksDir: locks, executor: 'fake', notes: path.join(t, `${o.lane}-NOTES.md`), hbMs: 150, staleMs: 60000, ctx_from: pf,
    policy: { auto_resume_max: 0 }, budget: { max_claude_workers: 4 }, tick: null, ...o });
  f.item = id => loadState(state).items[id];
  f.ended = id => waitFor(() => { const it = f.item(id); return settled(it) && it; });
  f.row = id => readiness(state).find(r => r.id === id);
  f.norn = (...args) => spawnSync(process.execPath, [NORN, ...args, '--project', pf, '--state', state], { encoding: 'utf8', windowsHide: true,
    env: { ...ENV, META_ROOT: t, HOME: t, USERPROFILE: t, META_NO_TICK: '1', META_RUN_ID: '', META_ROLE: '' } });
  return f;
}

test('exclusive: a run behind an Exclusive: holder is queued, the holder lands first in the merge queue, the run starts once it is merged', async () => {
  const f = fixture();
  const nav = f.lane('web-nav', { 'web/nav.mjs': 'moved\n', 'web/app.mjs': 'new nav\n' });
  const dlv = f.unlanded('web-nav', nav, f.brief('nav', '# web-nav NAV - the restructure\nScope: web/**\nExclusive: web/**\nTests: t\nDone: d\n'));
  const other = f.lane('lib-core', { 'lib/core.mjs': 'core\n' });
  const odlv = f.unlanded('lib-core', other, f.brief('core', '# lib-core S1\nScope: lib/**\nTests: t\nDone: d\n'));
  const wt = f.lane('web-runs');
  const r = startRun(f.opts({ lane: 'web-runs', stage: 'RUNS', worktree: wt, brief: f.brief('runs', '# web-runs RUNS\nScope: web/pages/**\nTests: t\nDone: d\nmode: done\n') }));
  assert.equal(r.queued, true, 'held, not started');
  assert.match(r.why, /^collide: territory \(exclusive\) \(COL-1\) - waits for lane web-nav$/);
  assert.match(r.collide.join('\n'), /collide: territory \(exclusive\), hold \(COL-1\) - lane web-nav\. Exclusive: web\/\*\* of lane web-nav/);
  const c = casesOf(f.state)['COL-1'];
  assert.equal(c.data.door, 'run');
  assert.deepEqual(actionsOf(c).map(a => [a.action, a.args.run]), [['hold', r.run]]);
  assert.deepEqual(readCollideHolds(f.state)[r.run].holders, ['web-nav']);
  // the fill re-judges it: still held (the walk names the holder), nothing started, no second case or action
  assert.deepEqual(fillQueue(f.state), []);
  assert.ok(f.row(r.run).terms.includes('collide: territory (exclusive) (COL-1) - waits for lane web-nav'), JSON.stringify(f.row(r.run).terms));
  assert.equal(Object.keys(casesOf(f.state)).length, 1);
  assert.equal(actionsOf(casesOf(f.state)['COL-1']).length, 1);
  // meanwhile the holder's deliverable is first in the merge queue (the older lib-core one would go first without the wait)
  const mq = mergeQueue({ stateDir: f.state, project: loadProject(f.pf) }).rows;
  assert.deepEqual(mq.map(x => [x.id, x.waiters]), [[dlv, 1], [odlv, 0]]);
  // the holder's work lands: the next fill starts the run by itself, the case records the release
  f.land('web-nav');
  const got = fillQueue(f.state);
  assert.deepEqual(got.map(x => x.queued), [r.run]);
  assert.deepEqual(actionsOf(casesOf(f.state)['COL-1']).map(a => a.action), ['hold', 'released']);
  assert.equal(readCollideHolds(f.state)[r.run], undefined);
  await f.ended(got[0].next);
});

test('stacked: a run on a branch stacked on an unmerged one shows after (auto) and starts when its base merges', async () => {
  const f = fixture();
  const base = f.lane('base', { 'lib/core.mjs': 'base work\n' });
  const dlv = f.unlanded('base', base, f.brief('base', '# base S1\nScope: lib/core.mjs\nTests: t\nDone: d\n'));
  const top = f.lane('top', { 'lib/util.mjs': 'top work\n' }, 'norn/base');
  const r = startRun(f.opts({ lane: 'top', stage: 'S2', worktree: top, brief: f.brief('top', '# top S2\nScope: lib/util.mjs\nTests: t\nDone: d\nmode: done\n') }));
  assert.equal(r.queued, true);
  assert.match(r.why, new RegExp(`^after \\(auto\\): dlv:${dlv}:merged - branch norn/top contains 1 commit of lane base's unmerged branch norn/base$`));
  assert.deepEqual(actionsOf(casesOf(f.state)['COL-1']).map(a => [a.action, a.args.after]), [['after', `dlv:${dlv}:merged`]]);
  assert.deepEqual(fillQueue(f.state), []);
  assert.ok(f.row(r.run).terms.some(x => x.startsWith(`after (auto): dlv:${dlv}:merged`)), JSON.stringify(f.row(r.run).terms));
  f.land('base');
  const got = fillQueue(f.state);
  assert.deepEqual(got.map(x => x.queued), [r.run]);
  await f.ended(got[0].next);
});

test('first come: of two queued runs whose Exclusive: lines meet, only the later one is held - they never wait on each other', () => {
  const f = fixture();
  const q = record(f.state, { kind: 'question', ev: 'create', by: 'checkin', data: { title: 'later', lane: 'x', options: [{ key: 'a', text: 'A' }], blocks: [] } }).id;
  const after = parseAfter(`q:${q}`);
  const a = startRun(f.opts({ lane: 'web-a', stage: 'A', worktree: f.lane('web-a'), after, brief: f.brief('a', '# web-a A\nScope: web/**\nExclusive: web/nav.mjs\nTests: t\nDone: d\n') }));
  const b = startRun(f.opts({ lane: 'web-b', stage: 'B', worktree: f.lane('web-b'), after, brief: f.brief('b', '# web-b B\nScope: web/**\nExclusive: web/app.mjs\nTests: t\nDone: d\n') }));
  assert.deepEqual(fillQueue(f.state), []);
  const terms = id => f.row(id).terms.filter(x => x.startsWith('collide:'));
  assert.deepEqual(terms(a.run), [], 'the first queued run is held by nothing later');
  assert.deepEqual(terms(b.run), ['collide: territory (exclusive) (COL-1) - waits for lane web-a']);
  assert.deepEqual(Object.keys(readCollideHolds(f.state)), [b.run]);
});

test('allow: `norn collide allow` releases the hold, the next fill starts the run and the case records allow + released', async () => {
  const f = fixture();
  const nav = f.lane('web-nav', { 'web/nav.mjs': 'moved\n' });
  f.unlanded('web-nav', nav, f.brief('nav', '# web-nav NAV\nScope: web/**\nExclusive: web/**\nTests: t\nDone: d\n'));
  const r = startRun(f.opts({ lane: 'web-runs', stage: 'RUNS', worktree: f.lane('web-runs'), brief: f.brief('runs', '# web-runs RUNS\nScope: web/pages/**\nTests: t\nDone: d\nmode: done\n') }));
  assert.equal(r.queued, true);
  const no = f.norn('collide', 'allow', 'COL-1', '--as', 'checkin', '--why', 'they touch other files');
  assert.equal(no.status, 3, no.stdout + no.stderr);
  assert.match(no.stderr, /an allow past territory \(exclusive\) is the controller's/);
  const ok = f.norn('collide', 'allow', 'COL-1', '--as', 'controller', '--why', 'the restructure leaves web/pages alone');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const got = fillQueue(f.state);
  assert.deepEqual(got.map(x => x.queued), [r.run]);
  const acts = actionsOf(casesOf(f.state)['COL-1']);
  assert.deepEqual(acts.map(a => [a.action, a.by]), [['hold', 'launcher'], ['allow', 'controller'], ['released', 'launcher']]);
  assert.deepEqual(acts[1].args, { pair: 'web-nav+web-runs', kinds: ['territory'] });
  await f.ended(got[0].next);
});

test('warn: a Scope that covers another lane\'s changed files starts with the collide: line, the hits on its record and the worker\'s prompt line', async () => {
  const f = fixture();
  const ux = f.lane('web-ux', { 'web/app.mjs': 'ux\n' });
  f.unlanded('web-ux', ux, f.brief('ux', '# web-ux S1\nScope: web/app.mjs\nTests: t\nDone: d\n'));
  const r = startRun(f.opts({ lane: 'web-all', stage: 'S1', worktree: f.lane('web-all'), brief: f.brief('all', '# web-all S1\nScope: web/**\nTests: t\nDone: d\nmode: done\n') }));
  assert.ok(r.run && !r.queued, 'started');
  assert.match(r.collide[0], /^collide: territory \(covers\), warn \(COL-1\) - lane web-ux\. Scope web\/\*\* covers 1 file lane web-ux changes/);
  assert.deepEqual(f.item(r.run).data.collide, [{ kind: 'territory', grade: 'covers', other: 'web-ux', verdict: 'warn', col: 'COL-1' }]);
  const spec = JSON.parse(fs.readFileSync(path.join(f.state, 'runs', `${r.run}.spec.json`), 'utf8'));
  assert.match(spec.promptText, /\n\nOther open work in your Scope: lane web-ux changes web\/app\.mjs \(not merged\)\. Do not move or rewrite those files wholesale\./);
  assert.deepEqual(actionsOf(casesOf(f.state)['COL-1']).map(a => a.action), ['told']);
  await f.ended(r.run);
});

test('exempt: no project file, a helper or a check-in never meets the door', async () => {
  const f = fixture();
  const nav = f.lane('web-nav', { 'web/nav.mjs': 'moved\n' });
  f.unlanded('web-nav', nav, f.brief('nav', '# web-nav NAV\nScope: web/**\nExclusive: web/**\nTests: t\nDone: d\n'));
  const r = startRun(f.opts({ lane: 'web-runs', stage: 'RUNS', ctx_from: undefined, worktree: f.lane('web-runs'), brief: f.brief('runs', '# web-runs RUNS\nScope: web/pages/**\nmode: done\n') }));
  assert.ok(r.run && !r.queued);
  assert.deepEqual(casesOf(f.state), {});
  await f.ended(r.run);
});

test('the tick queues the MERGE stage of a lane that held runs wait for at P0, every other lane at P1', async () => {
  const { waitedMergeCli } = await import('../engine/lib/tick.mjs');
  const f = fixture();
  const q = record(f.state, { kind: 'run', ev: 'queue', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'web-runs', worktree: '/w' } }).id;
  fs.writeFileSync(path.join(f.state, 'collide-holds.json'), JSON.stringify({ [q]: { cols: ['COL-1'], holders: ['web-nav'], since: new Date().toISOString(), why: 'x' } }));
  const cli = waitedMergeCli(f.state, args => args);
  const run = lane => ['run', '--queue', '--lane', lane, '--stage', 'MERGE', '--priority', 'P1'];
  assert.deepEqual(cli(run('web-nav')), ['run', '--queue', '--lane', 'web-nav', '--stage', 'MERGE', '--priority', 'P0']);
  assert.deepEqual(cli(run('lib-core')), run('lib-core'));
  assert.deepEqual(cli(['merge-brief', '--lane', 'web-nav']), ['merge-brief', '--lane', 'web-nav'], 'only the queued stage');
  record(f.state, { kind: 'run', ev: 'withdraw', id: q, by: 'controller', data: { why: 'not needed' } });
  assert.deepEqual(cli(run('web-nav')), run('web-nav'), 'the wait is over: P1 again');
});
