// lane-collide S1a: `norn collide plan` on temp git repos and records - the SPEC's incidents re-told with made-up lanes and items
// (brook = the river lead, web-nav = the restructure, ...), each with the collision and SloppaChoppa's pick it must name, and the
// near-misses that must name none. The command is read-only: the state dir is the same before and after.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkTmp } from './helpers/tmp.mjs';
import { record } from '../engine/lib/records.mjs';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, ...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const fwd = p => p.split(path.sep).join('/');
const NORN = path.join(import.meta.dirname, '..', 'engine', 'bin', 'norn.mjs');
const FILES = ['game/brook/flow.py', 'game/brook/shape.py', 'game/banks/edge.py', 'web/app.mjs', 'web/nav.mjs', 'web/pages/runs.mjs', 'web/pages/board.mjs',
  'web/css/runs.css', 'tests/web.test.mjs', 'docs/guide.md'];

function fixture() {
  const t = mkTmp('meta-collide-'), origin = path.join(t, 'origin.git'), home = path.join(t, 'home'), state = path.join(t, 'state', 'k');
  git(t, 'init', '-q', '--bare', '-b', 'main', origin);
  git(t, 'clone', '-q', origin, home);
  git(home, 'checkout', '-q', '-b', 'main');
  for (const f of FILES) put(path.join(home, f), `// ${f}\n`);
  git(home, 'add', '-A'); git(home, 'commit', '-qm', 'base'); git(home, 'push', '-q', 'origin', 'main');
  fs.mkdirSync(state, { recursive: true });
  const pf = path.join(t, 'project.json');
  fs.writeFileSync(pf, JSON.stringify({ schema: 1, name: 'k', title: 'k', root: fwd(home), ledger: '${root}/L.md', briefs_dir: '${root}', policy: { slop: { enabled: false } } }));
  const f = { t, home, state, pf };
  /** a lane worktree on norn/<lane> from `from` (origin/main or another lane's branch) with one commit per { file: text } */
  f.lane = (lane, edits = {}, from = 'origin/main') => {
    const wt = path.join(t, 'wt', lane);
    git(home, 'worktree', 'add', '-q', '-b', `norn/${lane}`, wt, from);
    for (const [file, s] of Object.entries(edits)) { put(path.join(wt, file), s); git(wt, 'add', '-A'); git(wt, 'commit', '-qm', `${lane}: ${file}`); }
    return fwd(wt);
  };
  f.brief = (name, text) => { const p = path.join(t, 'briefs', `${name}.md`); put(p, text); return p; };
  f.run = (lane, o = {}) => record(state, { kind: 'run', ev: o.queued ? 'queue' : 'start', by: 'launcher',
    data: { kind: 'worker', executor: 'fake', lane, stage: o.stage ?? 'S1', ...(o.worktree ? { worktree: o.worktree } : {}), ...(o.brief ? { brief: o.brief } : {}), ...(o.role ? { role: o.role } : {}) } }).id;
  f.end = (id, outcome = 'done') => record(state, { kind: 'run', ev: 'end', id, by: 'launcher', data: { outcome, exit: 0 } });
  f.dlv = (lane, run) => { const tip = git(home, 'rev-parse', `norn/${lane}`); return record(state, { kind: 'deliverable', ev: 'create', by: 'launcher', data: { repo: fwd(home), branch: `norn/${lane}`, tip, lane, run, delivers: lane, source: 'run' } }).id; };
  f.theme = () => (f.themeId ??= record(state, { kind: 'item', ev: 'create', by: 'owner', data: { kind: 'theme', title: 'Theme' } }).id);
  f.item = (title, o = {}) => record(state, { kind: 'item', ev: 'create', by: 'owner', data: { kind: 'item', title, parent: f.theme(), links: o.links || [], stages: o.stages || [] } }).id;
  f.caveat = (id, text) => record(state, { kind: 'item', ev: 'edit', id, by: 'owner', data: { caveat: text } });
  f.plan = (...args) => {
    const env = { ...ENV, META_ROOT: t, HOME: t, USERPROFILE: t, PATH: process.env.PATH, META_NO_TICK: '1' };
    const r = spawnSync(process.execPath, [NORN, 'collide', 'plan', '--project', pf, '--state', state, ...args], { encoding: 'utf8', env, windowsHide: true });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.stdout;
  };
  return f;
}
const snap = dir => fs.readdirSync(dir, { recursive: true }).sort().map(p => { const s = fs.statSync(path.join(dir, p)); return `${p}:${s.isFile() ? s.size : 'd'}`; }).join('\n');

test('incident 1 (river): a second work lane on RM-n while lane brook holds it -> item, SloppaChoppa: fold into brook', () => {
  const f = fixture();
  const rm = f.item('Brook reads as a brook, not a canal', { links: ['lane:brook'] });
  const wt = f.lane('brook', { 'game/brook/flow.py': 'bends\n' });
  f.run('brook', { worktree: wt, brief: f.brief('brook', `# task brook S2 (${rm}) - meanders\nScope: game/brook/**\nTests: t\nDone: d\n`) });
  const b = f.brief('brook-shape', `# task brook-shape SHAPE (${rm}) - the shape pass\nScope: game/brook/**\nTests: t\nDone: d\n`);
  const before = snap(f.state);
  const o = f.plan('--lane', 'brook-shape', '--stage', 'SHAPE', '--brief', b);
  assert.match(o, new RegExp(`collide: item, warn - lane brook\\. ${rm}: lane brook holds it \\(RUN-\\d+ running\\)`));
  assert.match(o, /SloppaChoppa: fold +continue on lane brook: norn run --lane brook --stage SHAPE --brief /);
  assert.equal(snap(f.state), before, 'plan writes nothing');
  const j = JSON.parse(f.plan('--lane', 'brook-shape', '--brief', b, '--json'));
  assert.deepEqual(j.hits.map(h => [h.kind, h.other, h.pick.remedy]), [['item', 'brook', 'fold'], ['territory', 'brook', 'narrow']]);
  assert.deepEqual(j.me.items, [rm]);
  // the near-miss: a MERGE stage on the item (landing work is exempt from item; a merge brief declares no files)
  assert.match(f.plan('--lane', 'brook-shape', '--stage', 'MERGE', '--brief', f.brief('brook-shape-merge', `# merge brook-shape (${rm})\nTests: t\nDone: d\n`)), /^no collision/m);
});

test('incident 2/3 (NAV): an Exclusive: of a running lane meets my Scope -> territory (exclusive), hold; a queued lane on the other files is free', () => {
  const f = fixture();
  const wt = f.lane('web-nav', { 'web/app.mjs': '// split\n' });
  f.run('web-nav', { worktree: wt, brief: f.brief('web-nav', '# task web-nav NAV\nScope: web/**\nExclusive: web/app.mjs web/pages/**\nTests: t\nDone: d\n') });
  const o = f.plan('--lane', 'web-cap', '--brief', f.brief('web-cap', '# task web-cap S1\nScope: web/pages/board.mjs\nTests: t\nDone: d\n'));
  assert.match(o, /collide: territory \(exclusive\), hold - lane web-nav\. Exclusive: web\/app\.mjs web\/pages\/\*\* of lane web-nav meets this run's Scope web\/pages\/board\.mjs/);
  assert.match(o, /SloppaChoppa: wait +start when lane web-nav's work has landed: norn run \.\.\. --queue --after run:RUN-\d+:merged/);
  assert.match(f.plan('--lane', 'game-x', '--brief', f.brief('game-x', '# task game-x S1\nScope: game/banks/**\nTests: t\nDone: d\n')), /^no collision/m);
});

test('incident 4 (ui-runs behind ui-nav): two readable Scopes on one area -> territory (scopes), SloppaChoppa: narrow', () => {
  const f = fixture();
  f.run('web-nav', { worktree: f.lane('web-nav'), brief: f.brief('web-nav', '# task web-nav NAV\nScope: web/**\nTests: t\nDone: d\n') });
  const o = f.plan('--lane', 'web-runs', '--brief', f.brief('web-runs', '# task web-runs RUNS\nScope: web/pages/runs.mjs web/css/runs.css tests/web.test.mjs\nTests: tests/web.test.mjs\nDone: the runs page\n'));
  assert.match(o, /collide: territory \(scopes\), warn - lane web-nav\. Scope web\/pages\/runs\.mjs web\/css\/runs\.css tests\/web\.test\.mjs and lane web-nav's Scope web\/\*\* share 2 tracked files \(one lies inside the other\)/);
  assert.match(o, /SloppaChoppa: narrow leave out of this Scope the files lane web-nav holds: web\/\*\*/);
});

test('order (stacked): a lane branched from an unmerged lane -> hold with the derived condition dlv:DLV-n:merged', () => {
  const f = fixture();
  const wt = f.lane('cap', { 'web/app.mjs': '// cap\n' }), id = f.run('cap', { worktree: wt });
  f.end(id); const dlv = f.dlv('cap', id);
  const top = f.lane('cap-two', { 'web/nav.mjs': '// two\n' }, 'norn/cap');
  f.end(f.run('cap-two', { worktree: top, brief: f.brief('cap-two-1', '# task cap-two S1\nScope: web/nav.mjs\nTests: t\nDone: d\n') }), 'handoff');
  const o = f.plan('--lane', 'cap-two', '--brief', f.brief('cap-two', '# task cap-two S2\nScope: web/nav.mjs\nTests: t\nDone: d\n'));
  assert.match(o, /collide: order \(stacked\), hold - lane cap\. branch norn\/cap-two contains 1 commit of lane cap's unmerged branch norn\/cap/);
  assert.match(o, new RegExp(`waits for dlv:${dlv}:merged`));
  assert.match(o, new RegExp(`SloppaChoppa: wait +start when lane cap's work has landed: norn run \\.\\.\\. --queue --after dlv:${dlv}:merged`));
});

test('stale: a caveat names an ended run as running -> the plan lists it with the automatic correction; a hand-off to a live successor is not stale', () => {
  const f = fixture();
  const gone = f.run('banks', { stage: 'S2' }); f.end(gone, 'stopped');
  const rm = f.item('Banks hold', { links: ['lane:banks'] }); f.caveat(rm, `${gone} running the edge pass; do not start another`);
  const handed = f.run('dunes', { stage: 'S1' }); f.end(handed, 'handoff'); f.run('dunes', { stage: 'S1' });
  const rm2 = f.item('Dunes drift', { links: ['lane:dunes'] }); f.caveat(rm2, `${handed} running the drift pass`);
  const o = f.plan();
  assert.match(o, new RegExp(`collide: stale \\(caveat\\), warn\\. ${rm}'s caveat names ${gone} as running; ${gone} ended .* \\(stopped\\)`));
  assert.match(o, new RegExp(`SloppaChoppa: correct +automatic: Norn adds the run's end to ${rm}'s caveat`));
  assert.doesNotMatch(o, new RegExp(`${rm2}'s caveat`), 'it continues as a live run');
});

test('plan without a brief: each pair of open lanes once, from the later side; the open items no lane holds are free', () => {
  const f = fixture();
  const rm = f.item('Brook reads as a brook', { links: ['lane:brook', 'lane:brook-two'] }), free = f.item('Fauna wiring');
  f.run('brook', { worktree: f.lane('brook', { 'game/brook/flow.py': 'x\n' }) });
  f.run('brook-two', { queued: true, brief: f.brief('brook-two', '# task brook-two S1\nScope: game/brook/shape.py\nTests: t\nDone: d\n') });
  const o = f.plan();
  assert.match(o, /^collide plan k: 2 open lanes \(1 running, 1 queued\)/m);
  assert.match(o, new RegExp(`brook-two: collide: item, warn - lane brook\\. ${rm}: lane brook holds it`));
  assert.equal(o.match(/collide: item/g).length, 1, 'the pair once');
  assert.match(o, new RegExp(`Free: ${free} Fauna wiring`));
  assert.doesNotMatch(o, new RegExp(`Free:.*${rm}`));
});

test('near-misses name no collision: tests/** only, the prose Scope of a NAV brief, Scope: none (a review), a helper', () => {
  const f = fixture();
  f.run('web-nav', { worktree: f.lane('web-nav', { 'web/app.mjs': '// nav\n', 'tests/web.test.mjs': '// t\n' }),
    brief: f.brief('web-nav', '# task web-nav NAV\nScope: web/**, tests/**\nTests: t\nDone: d\n') });
  const none = re => (b, ...x) => assert.match(f.plan('--lane', 'other', '--brief', f.brief(`o-${Math.random().toString(36).slice(2)}`, b), ...x), re);
  none(/^no collision/m)('# task other S1\nScope: game/banks/** tests/**\nTests: t\nDone: d\n');
  const prose = f.plan('--lane', 'web-lanes', '--brief', f.brief('web-lanes', '# task web-lanes LANES\nScope: the files PLAN.md gives LANES (web/** at most), tests/**\nTests: t\nDone: d\n'));
  assert.match(prose, /^no collision/m);
  assert.match(prose, /note: no machine-readable Scope \(prose in the Scope line .*\): territory is judged from changed files only/);
  none(/^no collision/m)('# task other REVIEW\nScope: none (a review; no code)\nTests: t\nDone: d\n');
  const helper = spawnSync(process.execPath, [NORN, 'collide', 'plan', '--project', f.pf, '--state', f.state, '--lane', 'other', '--role', 'helper', '--brief', f.brief('h', '# h\nScope: web/**\nTests: t\nDone: d\n')],
    { encoding: 'utf8', env: { ...ENV, META_ROOT: f.t, HOME: f.t, USERPROFILE: f.t, PATH: process.env.PATH, META_NO_TICK: '1' }, windowsHide: true });
  assert.match(helper.stdout, /^no collision/m, helper.stderr);
});
