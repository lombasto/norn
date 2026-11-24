// lane-collide S2a: the remedy verbs wait, narrow, part, ask (SPEC 4A.4) and who may apply them (4A.3, policy.collide.apply_by), on temp
// git repos and records (made-up lanes: web-nav changes the nav, web-runs comes later). Each verb changes what its row lists and its undo
// gives it back; narrow refuses a running run's brief and a Done line that names a dropped file; a check-in is refused a controller's
// cell; a worker run applies nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkTmp } from './helpers/tmp.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { startRun } from '../engine/lib/runs.mjs';
import { casesOf, actionsOf, rulingsOf, gatherIntents } from '../engine/lib/intents.mjs';
import { narrowScope, applyRefusal, menuOf, collisions, holdsOf, pairKey } from '../engine/lib/collide.mjs';
import { loadRoadmap } from '../engine/lib/roadmap.mjs';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, ...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const fwd = p => p.split(path.sep).join('/');
const NORN = path.join(import.meta.dirname, '..', 'engine', 'bin', 'norn.mjs');
const FILES = ['web/app.mjs', 'web/nav.mjs', 'web/pages/runs.mjs', 'web/pages/board.mjs', 'lib/core.mjs', 'docs/guide.md'];

function fixture(collide = {}) {
  const t = mkTmp('meta-cremedy-'), origin = path.join(t, 'origin.git'), home = path.join(t, 'home'), state = path.join(t, 'state', 'k'), locks = path.join(t, 'state', 'locks');
  git(t, 'init', '-q', '--bare', '-b', 'main', origin);
  git(t, 'clone', '-q', origin, home);
  git(home, 'checkout', '-q', '-b', 'main');
  for (const f of FILES) put(path.join(home, f), `// ${f}\n`);
  git(home, 'add', '-A'); git(home, 'commit', '-qm', 'base'); git(home, 'push', '-q', 'origin', 'main');
  for (const d of [state, locks]) fs.mkdirSync(d, { recursive: true });
  const pf = path.join(t, 'project.json');
  fs.writeFileSync(pf, JSON.stringify({ schema: 1, name: 'k', title: 'k', root: fwd(home), ledger: '${root}/L.md', briefs_dir: '${root}', policy: { slop: { enabled: false }, collide: { auto: { land_wait_min: 0 }, ...collide } } }));
  const f = { t, home, state, locks, pf };
  f.lane = (lane, edits = {}) => {
    const wt = path.join(t, 'wt', lane);
    git(home, 'worktree', 'add', '-q', '-b', `norn/${lane}`, wt, 'origin/main');
    for (const [file, s] of Object.entries(edits)) { put(path.join(wt, file), s); git(wt, 'add', '-A'); git(wt, 'commit', '-qm', `${lane}: ${file}`); }
    return fwd(wt);
  };
  f.brief = (name, text) => { const p = path.join(t, 'briefs', `${name}.md`); put(p, text); return p; };
  /** lane web-nav's ended DONE run and its open deliverable: it changed web/nav.mjs and web/app.mjs */
  f.nav = () => {
    const wt = f.lane('web-nav', { 'web/nav.mjs': 'moved\n', 'web/app.mjs': 'new nav\n' });
    const run = record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'web-nav', stage: 'NAV', worktree: wt, brief: f.brief('nav', '# web-nav NAV\nScope: web/nav.mjs web/app.mjs\nTests: t\nDone: d\n') } }).id;
    record(state, { kind: 'run', ev: 'end', id: run, by: 'launcher', data: { outcome: 'done', exit: 0 } });
    return record(state, { kind: 'deliverable', ev: 'create', by: 'launcher', data: { repo: fwd(home), branch: 'norn/web-nav', tip: git(home, 'rev-parse', 'norn/web-nav'), lane: 'web-nav', run, delivers: 'web-nav', source: 'run', done_utc: new Date().toISOString() } }).id;
  };
  /** lane web-runs' queued run from brief text */
  f.queued = (text, ev = 'queue') => { const brief = f.brief('runs', text), wt = f.lane('web-runs');
    return { brief, run: record(state, { kind: 'run', ev, by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'web-runs', stage: 'RUNS', worktree: wt, brief } }).id, wt }; };
  /** a case between web-nav (A, ahead) and web-runs (B) */
  f.case = (kind, grade = null, a = 'web-nav', b = 'web-runs', extra = {}) => record(state, { kind: 'collision', ev: 'open', by: 'launcher', data: { key: `${kind}:${a}+${b}`, kind, grade, verdict: 'warn', door: 'run',
    a: { lane: a }, b: { lane: b }, files: [], files_n: 0, why: `synthetic ${kind}`, pair: pairKey(a, b), ...extra } }).id;
  f.norn = (args, env = {}) => spawnSync(process.execPath, [NORN, 'collide', ...args, '--project', pf, '--state', state], { encoding: 'utf8', windowsHide: true,
    env: { ...ENV, META_ROOT: t, HOME: t, USERPROFILE: t, META_NO_TICK: '1', META_RUN_ID: '', META_ROLE: '', ...env } });
  f.acts = id => actionsOf(casesOf(state)[id]);
  f.judge = lane => { const g = gatherIntents({ state, repo: home }), me = g.intents.find(x => x.lane === lane) ?? { lane, state: 'new', since: Date.now(), items: [], scope: ['web/**'], exclusive: [], touched: [] };
    return collisions(me, g.intents, { policy: { auto: { land_wait_min: 0 }, ...collide }, tracked: g.tracked, rulings: rulingsOf(casesOf(state)) }); };
  return f;
}
const ok = (r, re) => { assert.equal(r.status, 0, r.stderr + r.stdout); if (re) assert.match(r.stdout, re); };
const refused = (r, re) => { assert.equal(r.status, 3, r.stderr + r.stdout); assert.match(r.stderr, re); };

test('narrowScope: a glob over A\'s files splits a folder level at a time into the free folders and files (SPEC 4A.5 example)', () => {
  const tracked = ['engine/dash/server.mjs', 'engine/dash/ui.mjs', 'engine/dash/pages/lanes.mjs', 'engine/dash/pages/runs.mjs', 'engine/dash/css/runs.css', 'engine/dash/css/lanes.css', 'engine/lib/x.mjs'];
  const r = narrowScope(['engine/dash/**', 'engine/lib/**'], ['engine/dash/server.mjs', 'engine/dash/ui.mjs', 'engine/dash/css/lanes.css'], tracked);
  assert.deepEqual(r.scope, ['engine/dash/css/runs.css', 'engine/dash/pages/**', 'engine/lib/**']);
  assert.deepEqual(r.dropped, ['engine/dash/css/lanes.css', 'engine/dash/server.mjs', 'engine/dash/ui.mjs']);
  assert.deepEqual(narrowScope(['docs/**'], ['engine/dash/ui.mjs'], tracked), { scope: ['docs/**'], dropped: [] }, 'a glob that meets none stays');
});

test('applyRefusal: the 4A.3 cells per role; apply_by lowers a controller cell, never an owner cell; a worker role applies nothing', () => {
  assert.match(applyRefusal('checkin', 'allow', 'item', null), /controller's/);
  assert.equal(applyRefusal('controller', 'allow', 'item', null), null);
  assert.equal(applyRefusal('checkin', 'narrow', 'territory', 'covers'), null);
  assert.match(applyRefusal('checkin', 'narrow', 'territory', 'exclusive'), /controller's .*norn collide ask COL-n --want narrow/);
  assert.match(applyRefusal('owner', 'part', 'territory', 'covers'), /not on the menu/);
  assert.match(applyRefusal('controller', 'part', 'lead', null), /owner's/);
  const lowered = { apply_by: { exclusive: { narrow: 'checkin' }, lead: { part: 'checkin', allow: 'checkin' } } };
  assert.equal(applyRefusal('checkin', 'narrow', 'territory', 'exclusive', lowered), null);
  assert.match(applyRefusal('controller', 'part', 'lead', null, lowered), /owner's/, 'an owner cell is not lowered');
  assert.match(applyRefusal('worker', 'wait', 'item', null), /may not apply/);
  assert.deepEqual(menuOf('item', null), ['part', 'fold', 'wait', 'allow']);
});

test('wait: the pair ruling holds the later lane (a new start is queued) and refuses when A is not ahead; undo withdraws it', () => {
  const f = fixture();
  f.nav();
  const col = f.case('territory', 'covers');
  assert.deepEqual(holdsOf(f.judge('web-runs')), [], 'a covers hit only warns before the wait');
  ok(f.norn(['wait', col, '--as', 'checkin', '--why', 'land the nav first']), /web-runs waits for lane web-nav/);
  assert.deepEqual(rulingsOf(casesOf(f.state))[pairKey('web-nav', 'web-runs')], { verdict: 'hold', kinds: ['territory'], waiter: 'web-runs', holder: 'web-nav', col, by: 'checkin', at: f.acts(col)[0].at, why: 'land the nav first' });
  const wt = f.lane('web-runs');
  const r = startRun({ state: f.state, locksDir: f.locks, executor: 'fake', notes: path.join(f.t, 'N.md'), hbMs: 150, staleMs: 60000, ctx_from: f.pf, policy: { auto_resume_max: 0 }, budget: { max_claude_workers: 4 }, tick: null,
    lane: 'web-runs', stage: 'RUNS', worktree: wt, brief: f.brief('runs', '# web-runs RUNS\nScope: web/**\nTests: t\nDone: d\nmode: done\n') });
  assert.equal(r.queued, true, 'the next start on the lane is queued');
  assert.match(r.why, /collide: territory \(covers\).*waits for lane web-nav/);
  assert.equal(holdsOf(f.judge('web-runs')).length, 1, 'the queued run stays held at the fill');
  ok(f.norn(['undo', col, '--as', 'checkin', '--why', 'not needed']), /wait withdrawn/);
  assert.equal(rulingsOf(casesOf(f.state))[pairKey('web-nav', 'web-runs')], undefined);
  assert.deepEqual(holdsOf(f.judge('web-runs')), []);
  const back = f.case('territory', 'covers', 'web-runs', 'web-nav');
  refused(f.norn(['wait', back, '--as', 'checkin', '--why', 'x']), /not ahead of lane web-nav/);
});

test('narrow: the Scope line is rewritten with the Narrowed line, the old bytes come back on undo; refused for a running run, a Done line naming a dropped file, a check-in on exclusive', () => {
  const f = fixture();
  const dlv = f.nav();
  const text = '# web-runs RUNS\nScope: web/**\nTests: t\nDone: the runs page renders\nmode: done\n';
  const { brief } = f.queued(text);
  const col = f.case('territory', 'covers');
  ok(f.norn(['narrow', col, '--as', 'checkin', '--why', 'keep apart']), /Scope web\/pages\/\*\* \(left out: web\/app\.mjs web\/nav\.mjs\)/);
  assert.equal(fs.readFileSync(brief, 'utf8'), `# web-runs RUNS\nScope: web/pages/**\nTests: t\nDone: the runs page renders\nNarrowed (${col}): web/app.mjs web/nav.mjs are lane web-nav's until ${dlv} merges. If the task needs them, end stopped and name them; do not work around it.\nmode: done\n`);
  const a = f.acts(col)[0];
  assert.deepEqual([a.action, a.args.before, a.args.after, a.args.sha256.length], ['narrow', 'Scope: web/**', 'Scope: web/pages/**', 64]);
  assert.equal(casesOf(f.state)[col].data.kind, 'territory', 'the case itself is unchanged');
  ok(f.norn(['undo', col, '--as', 'checkin', '--why', 'back']), /old Scope line is back/);
  assert.equal(fs.readFileSync(brief, 'utf8'), text, 'byte for byte');
  // undo is refused once a run started from the narrowed brief
  ok(f.norn(['narrow', col, '--as', 'checkin', '--why', 'again']));
  record(f.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'web-runs', stage: 'RUNS', brief } });
  refused(f.norn(['undo', col, '--as', 'checkin', '--why', 'x']), /started from the narrowed brief/);
  refused(f.norn(['narrow', col, '--as', 'checkin', '--why', 'x']), /is running/);
});

test('narrow: refused when the Done line names a dropped file, and for a check-in on an exclusive case; the controller\'s narrow is a decision', () => {
  const f = fixture();
  f.nav();
  const { brief } = f.queued('# web-runs RUNS\nScope: web/**\nTests: t\nDone: web/nav.mjs links the runs page\n');
  refused(f.norn(['narrow', f.case('territory', 'covers'), '--as', 'checkin', '--why', 'x']), /Done: line names web\/nav\.mjs/);
  fs.writeFileSync(brief, '# web-runs RUNS\nScope: web/**\nTests: t\nDone: d\n');
  const ex = f.case('territory', 'exclusive');
  refused(f.norn(['narrow', ex, '--as', 'checkin', '--why', 'x']), /controller's/);
  assert.match(fs.readFileSync(brief, 'utf8'), /^Scope: web\/\*\*$/m, 'a refusal writes nothing');
  ok(f.norn(['narrow', ex, '--as', 'controller', '--why', 'keep apart']), /\(DEC-\d+\)/);
  const dec = f.acts(ex)[0].args.dec;
  assert.equal(loadState(f.state).items[dec].data.col, ex);
});

test('part: lane B becomes a part of the lead\'s item (the item hit goes, lane:B is linked); refused when the Scopes meet and on a lead case below the owner; undo unlinks', () => {
  const f = fixture();
  f.nav();
  const th = record(f.state, { kind: 'item', ev: 'create', by: 'owner', data: { kind: 'theme', title: 'Web' } }).id;
  const it = record(f.state, { kind: 'item', ev: 'create', by: 'owner', data: { kind: 'item', title: 'the nav', parent: th, links: ['lane:web-nav'] } }).id;
  const { brief } = f.queued(`# web-runs RUNS ${it}\nScope: web/pages/**\nTests: t\nDone: d\n`);
  assert.deepEqual(f.judge('web-runs').map(h => h.kind), ['item']);
  const col = f.case('item', null, 'web-nav', 'web-runs', { item: it });
  ok(f.norn(['part', col, '--as', 'checkin', '--why', 'separate files']), new RegExp(`part of lane web-nav's item ${it} \\(linked lane:web-runs\\)`));
  assert.ok(loadRoadmap(f.state).items[it].links.includes('lane:web-runs'));
  assert.deepEqual(f.judge('web-runs'), [], 'the item hit is gone');
  ok(f.norn(['undo', col, '--as', 'checkin', '--why', 'back']), /unlinked/);
  assert.ok(!loadRoadmap(f.state).items[it].links.includes('lane:web-runs'));
  assert.deepEqual(f.judge('web-runs').map(h => h.kind), ['item']);
  fs.writeFileSync(brief, `# web-runs RUNS ${it}\nScope: web/**\nTests: t\nDone: d\n`);
  refused(f.norn(['part', col, '--as', 'checkin', '--why', 'x']), /meets lane web-nav's changed files.*narrow it first, or wait/);
  fs.writeFileSync(brief, `# web-runs RUNS ${it}\nScope: web/pages/**\nTests: t\nDone: d\n`);
  const lead = f.case('lead', null, 'web-nav', 'web-runs', { item: it });
  refused(f.norn(['part', lead, '--as', 'controller', '--why', 'x']), /owner's/);
  ok(f.norn(['part', lead, '--as', 'owner', '--why', 'one lead']), /\(DEC-\d+\)/);
});

test('ask: an owner cell becomes one owner question with the menu, SloppaChoppa\'s pick recommended; undo withdraws it; a remedy the caller may apply is refused', () => {
  const f = fixture();
  f.nav();
  f.queued('# web-runs RUNS\nScope: web/pages/**\nTests: t\nDone: d\n');
  const col = f.case('lead', null, 'web-nav', 'web-runs', { recommended: { remedy: 'part', why: 'apart' } });
  ok(f.norn(['ask', col, '--want', 'part', '--as', 'checkin', '--why', 'one lead per hard item']), /asked the owner for part \(Q-\d+\)/);
  const q = f.acts(col)[0].args.q, item = loadState(f.state).items[q];
  assert.deepEqual([item.state, item.data.owner_only, item.data.options.map(o => o.key), item.data.recommend.key], ['open', true, ['part', 'fold', 'wait', 'allow'], 'part']);
  ok(f.norn(['ask', col, '--want', 'allow', '--as', 'checkin', '--why', 'again']));
  assert.equal(f.acts(col)[1].args.q, q, 'never a second question for the case');
  ok(f.norn(['undo', col, '--action', '1', '--as', 'checkin', '--why', 'not needed']));
  assert.equal(loadState(f.state).items[q].state, 'withdrawn');
  refused(f.norn(['ask', col, '--want', 'wait', '--as', 'checkin', '--why', 'x']), /may apply wait itself/);
  const it = f.case('item');
  ok(f.norn(['ask', it, '--want', 'allow', '--as', 'checkin', '--why', 'x']), /asked the controller for allow$/m);
  assert.equal(f.acts(it)[0].args.q, undefined, 'a controller ask is a mark, no question');
  const ids = who => f.norn(['list', '--for', who]).stdout.split(/\r?\n/).filter(l => /^COL-/.test(l)).map(l => l.split(' ')[0]);
  assert.deepEqual([ids('controller'), ids('owner'), ids('checkin')], [[it], [col], []], 'each case is marked by its last live ask');
});

test('a worker run applies no remedy: every verb is refused', () => {
  const f = fixture();
  f.nav();
  f.queued('# web-runs RUNS\nScope: web/**\nTests: t\nDone: d\n');
  const col = f.case('territory', 'covers');
  for (const v of [['wait'], ['narrow'], ['part'], ['ask', '--want', 'allow'], ['allow'], ['undo']]) {
    refused(f.norn([v[0], col, ...v.slice(1), '--as', 'checkin', '--why', 'x'], { META_RUN_ID: 'RUN-9', META_ROLE: '' }), /a worker run applies no remedy/);
  }
  assert.deepEqual(f.acts(col), []);
});

test('norn run --part-of: the run is a declared part of the lead\'s item - recorded on the run, no item collision', () => {
  const f = fixture();
  f.nav();
  const th = record(f.state, { kind: 'item', ev: 'create', by: 'owner', data: { kind: 'theme', title: 'Web' } }).id;
  const it = record(f.state, { kind: 'item', ev: 'create', by: 'owner', data: { kind: 'item', title: 'the nav', parent: th, links: ['lane:web-nav'] } }).id;
  const wt = f.lane('web-runs'), brief = f.brief('runs', `# web-runs RUNS ${it}\nScope: web/pages/**\nTests: t\nDone: d\nmode: done\n`);
  const run = (...x) => spawnSync(process.execPath, [NORN, 'run', '--executor', 'fake', '--lane', 'web-runs', '--brief', brief, '--worktree', wt, '--no-tick', '--project', f.pf, '--state', f.state, '--locks', f.locks, ...x],
    { encoding: 'utf8', windowsHide: true, env: { ...ENV, META_ROOT: f.t, HOME: f.t, USERPROFILE: f.t, META_NO_TICK: '1', META_RUN_ID: '', META_ROLE: '' } });
  const r = run('--part-of', 'web-nav');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.doesNotMatch(r.stdout + r.stderr, /collide: item/);
  const rec = Object.values(loadState(f.state).items).find(x => x.kind === 'run' && x.data.lane === 'web-runs');
  assert.equal(rec.data.part_of, 'web-nav');
  assert.deepEqual(gatherIntents({ state: f.state, repo: f.home }).intents.filter(x => x.lane === 'web-runs').map(x => x.part_of), rec.state === 'running' ? ['web-nav'] : []);
});
