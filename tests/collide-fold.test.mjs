// lane-collide S2b: the fold remedy (SPEC 4A.4 fold, its six steps and the undo) on temp git repos and records (made-up lanes: web-nav is
// kept, web-runs is folded into it). After a fold the kept lane's notes folder holds the folded lane's brief and notes byte for byte
// (sha256 checked), the sources and the folded lane's branch and worktree are untouched, its queued runs move to the kept lane; a live
// run is never stopped (the fold is pending until it ends; --pause sends the pause order); a check-in is refused a lane with commits or a
// live run; undo brings the lane and its queued runs back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkTmp } from './helpers/tmp.mjs';
import { record, loadState, laneId, readEvents, readEventsAsync } from '../engine/lib/records.mjs';
import { casesOf, actionsOf, foldLines } from '../engine/lib/intents.mjs';
import { foldedSources, foldRefusal, pairKey } from '../engine/lib/collide.mjs';
import { foldPass } from '../engine/lib/lifecycle.mjs';
import { startRun } from '../engine/lib/runs.mjs';
import { settled } from './helpers/settled.mjs';
import { loadRoadmap } from '../engine/lib/roadmap.mjs';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, ...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const fwd = p => p.split(path.sep).join('/');
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const NORN = path.join(import.meta.dirname, '..', 'engine', 'bin', 'norn.mjs');

function fixture() {
  const t = mkTmp('meta-cfold-'), origin = path.join(t, 'origin.git'), home = path.join(t, 'home'), state = path.join(t, 'state', 'k');
  git(t, 'init', '-q', '--bare', '-b', 'main', origin);
  git(t, 'clone', '-q', origin, home);
  git(home, 'checkout', '-q', '-b', 'main');
  for (const f of ['web/app.mjs', 'web/nav.mjs', 'web/pages/runs.mjs']) put(path.join(home, f), `// ${f}\n`);
  git(home, 'add', '-A'); git(home, 'commit', '-qm', 'base'); git(home, 'push', '-q', 'origin', 'main');
  fs.mkdirSync(state, { recursive: true });
  const pf = path.join(t, 'project.json');
  fs.writeFileSync(pf, JSON.stringify({ schema: 1, name: 'k', title: 'k', root: fwd(home), ledger: '${root}/L.md', briefs_dir: '${root}', policy: { slop: { enabled: false }, collide: { auto: { land_wait_min: 0 } } } }));
  const f = { t, home, state, pf };
  f.lane = (lane, edits = {}) => {
    const wt = path.join(t, 'wt', lane);
    git(home, 'worktree', 'add', '-q', '-b', `norn/${lane}`, wt, 'origin/main');
    for (const [file, s] of Object.entries(edits)) { put(path.join(wt, file), s); git(wt, 'add', '-A'); git(wt, 'commit', '-qm', `${lane}: ${file}`); }
    return fwd(wt);
  };
  f.brief = (name, text) => { const p = path.join(t, 'briefs', `${name}.md`); put(p, text); return p; };
  f.notes = (lane, text) => { const p = path.join(t, 'notes', lane, 'NOTES.md'); put(p, text); return p; };
  /** lane web-nav (kept): one ended run with its worktree and notes */
  f.nav = () => {
    const wt = f.lane('web-nav', { 'web/nav.mjs': 'moved\n' }), notes = f.notes('web-nav', '# web-nav notes\n');
    const run = record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'web-nav', stage: 'NAV', worktree: wt, notes, brief: f.brief('nav', '# web-nav NAV\nScope: web/nav.mjs\n') } }).id;
    record(state, { kind: 'run', ev: 'end', id: run, by: 'launcher', data: { outcome: 'done', exit: 0 } });
    return { wt, notes, run };
  };
  /** lane web-runs (folded): an ended run (its notes, CRLF and no final newline, with a fence inside) and a queued one; edits = commits */
  f.runs = (edits = {}) => {
    const wt = f.lane('web-runs', edits), notes = f.notes('web-runs', '# web-runs notes\r\n~~~~\r\nkept ``` as is\r\n## Open\r\nno end newline');
    const brief = f.brief('runs', '# task web-runs RUNS - the runs page\nScope: web/pages/**\nTests: t\nDone: d\n');
    const ran = record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'web-runs', stage: 'R1', worktree: wt, notes, brief } }).id;
    record(state, { kind: 'run', ev: 'end', id: ran, by: 'launcher', data: { outcome: 'done', exit: 0 } });
    const spec = { executor: 'fake', lane: 'web-runs', stage: 'R2', worktree: wt, notes, brief, state, locksDir: path.join(t, 'state', 'locks') };
    const queued = record(state, { kind: 'run', ev: 'queue', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'web-runs', stage: 'R2', worktree: wt, notes, brief } }).id;
    put(path.join(state, 'runs', `${queued}.queue.json`), JSON.stringify(spec, null, 1));
    record(state, { kind: 'lane', ev: 'create', id: laneId('web-runs', state), by: 'checkin', data: { name: 'web-runs' } });
    return { wt, notes, brief, ran, queued };
  };
  f.case = (kind = 'item', extra = {}) => record(state, { kind: 'collision', ev: 'open', by: 'launcher', data: { key: `${kind}:web-nav>web-runs`, kind, grade: null, verdict: 'warn', door: 'run',
    a: { lane: 'web-nav' }, b: { lane: 'web-runs' }, files: [], files_n: 0, why: `synthetic ${kind}`, pair: pairKey('web-nav', 'web-runs'), ...extra } }).id;
  f.norn = (args, env = {}) => spawnSync(process.execPath, [NORN, 'collide', ...args, '--project', pf, '--state', state], { encoding: 'utf8', windowsHide: true,
    env: { ...ENV, META_ROOT: t, HOME: t, USERPROFILE: t, META_NO_TICK: '1', META_RUN_ID: '', META_ROLE: '', ...env } });
  f.acts = id => actionsOf(casesOf(state)[id]);
  f.items = () => loadState(state).items;
  f.lane$ = lane => f.items()[laneId(lane, state)];
  f.onLane = (lane, st) => Object.values(f.items()).filter(r => r.kind === 'run' && r.data.lane === lane && r.state === st);
  return f;
}
const ok = (r, re) => { assert.equal(r.status, 0, r.stderr + r.stdout); if (re) assert.match(r.stdout, re); };
const refused = (r, re) => { assert.equal(r.status, 3, r.stderr + r.stdout); assert.match(r.stderr, re); };

test('foldedSources reads back every copied text exactly (CRLF, no final newline, fences inside); foldRefusal: two homes, a lead of parts, a check-in on a lane with work', () => {
  assert.match(foldRefusal({ role: 'checkin', kind: 'item', homes: ['a', 'b'] }) ?? '', /two homes/);
  assert.match(foldRefusal({ role: 'controller', kind: 'item', lane: 'web-runs', leads: ['web-x'] }) ?? '', /leads parts of its own \(web-x\)/);
  assert.match(foldRefusal({ role: 'checkin', kind: 'item', lane: 'web-runs', commits: 2 }) ?? '', /2 commits.*--want fold/);
  assert.match(foldRefusal({ role: 'checkin', kind: 'item', lane: 'web-runs', live: 'RUN-4' }) ?? '', /live run RUN-4/);
  assert.equal(foldRefusal({ role: 'checkin', kind: 'item', lane: 'web-runs', commits: 0 }), null, 'an empty fold needs only the check-in');
  assert.equal(foldRefusal({ role: 'checkin', kind: 'goal', lane: 'web-runs', commits: 0 }), null);
  assert.match(foldRefusal({ role: 'controller', kind: 'territory', lane: 'web-runs', commits: 0 }) ?? '', /not on the menu/);
  assert.equal(foldRefusal({ role: 'controller', kind: 'item', lane: 'web-runs', commits: 3 }), null);
});

test('fold (an empty lane, the check-in): FOLDED-<B>.md holds the brief and notes byte for byte, the sources, branch and worktree are untouched, the queued run moves, the links follow, the lane is archived, the kept lane\'s prompt names it; undo brings it back', () => {
  const f = fixture(), nav = f.nav(), runs = f.runs();
  const th = record(f.state, { kind: 'item', ev: 'create', by: 'owner', data: { kind: 'theme', title: 'Web' } }).id;
  const it = record(f.state, { kind: 'item', ev: 'create', by: 'owner', data: { kind: 'item', title: 'the runs page', parent: th, links: ['lane:web-runs'] } }).id;
  const q = record(f.state, { kind: 'question', ev: 'create', by: 'checkin', data: { title: 'which order on the runs page?', lane: 'web-runs', body: 'b' } }).id;
  const before = { brief: sha(runs.brief), notes: sha(runs.notes), tip: git(f.home, 'rev-parse', 'norn/web-runs') };
  const col = f.case('item');
  ok(f.norn(['fold', col, '--into', 'web-nav', '--as', 'checkin', '--why', 'one lane for the runs page']), /fold - lane web-runs is folded into lane web-nav/);
  const file = path.join(path.dirname(nav.notes), 'FOLDED-web-runs.md'), text = fs.readFileSync(file, 'utf8');
  const src = foldedSources(text);
  assert.deepEqual(src.map(s => [s.kind, s.path]), [['brief', fwd(runs.brief)], ['notes', fwd(runs.notes)]]);
  for (const s of src) assert.equal(crypto.createHash('sha256').update(s.text).digest('hex'), sha(s.path), `${s.path} is copied byte for byte`);
  assert.deepEqual([sha(runs.brief), sha(runs.notes)], [before.brief, before.notes], 'the sources are untouched');
  assert.match(text, /the runs page/, 'the objective');
  assert.match(text, new RegExp(q), 'its open questions');
  assert.match(text, new RegExp(it), 'its roadmap links');
  assert.equal(git(f.home, 'rev-parse', 'norn/web-runs'), before.tip, 'the branch stays');
  assert.ok(fs.existsSync(runs.wt), 'the worktree stays');
  assert.equal(f.items()[runs.queued].state, 'withdrawn');
  assert.match(f.items()[runs.queued].withdraw.why, new RegExp(`folded into web-nav \\(${col}\\)`));
  const moved = f.onLane('web-nav', 'queued');
  assert.deepEqual(moved.map(r => [r.data.stage, fwd(r.data.brief), fwd(r.data.worktree)]), [['R2', fwd(runs.brief), nav.wt]], 'queued again on the kept lane, same brief and stage');
  assert.equal(f.items()[runs.queued].withdraw.next, moved[0].id);
  assert.ok(fs.existsSync(path.join(f.state, 'runs', `${runs.queued}.queue.json`)), 'the old queue spec stays');
  assert.deepEqual(loadRoadmap(f.state).items[it].links.sort(), ['lane:web-nav', 'lane:web-runs']);
  assert.equal(f.lane$('web-runs').state, 'archived', 'no commits of its own: archived');
  const lines = foldLines(f.state, 'web-nav');
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`Lane web-runs was folded into this lane \\(${col}\\)\\. Read FOLDED-web-runs\\.md first\\.`));
  assert.deepEqual(foldLines(f.state, 'web-runs'), []);
  refused(f.norn(['undo', col, '--as', 'checkin', '--why', 'x']), /unarchive.*controller's or the owner's/);
  assert.equal(f.lane$('web-runs').state, 'archived', 'a refused undo changes nothing');
  ok(f.norn(['undo', col, '--as', 'controller', '--why', 'two lanes after all']), /lane web-runs is back/);
  assert.equal(f.lane$('web-runs').state, 'active');
  assert.equal(f.items()[moved[0].id].state, 'withdrawn', 'the re-queued run that had not started is withdrawn');
  assert.deepEqual(f.onLane('web-runs', 'queued').map(r => [r.data.stage, fwd(r.data.brief)]), [['R2', fwd(runs.brief)]], 'its own run is queued again');
  assert.deepEqual(loadRoadmap(f.state).items[it].links, ['lane:web-runs']);
  assert.deepEqual(foldLines(f.state, 'web-nav'), [], 'the prompt line goes');
  assert.ok(fs.existsSync(file), 'the fold file stays: it is a copy');
});

test('fold: a lane with commits is the controller\'s and is parked, not archived; the prompt line names its commits and ends once a run on the kept lane ended DONE', () => {
  const f = fixture(), nav = f.nav();
  f.runs({ 'web/pages/runs.mjs': 'new runs\n' });
  const col = f.case('item');
  refused(f.norn(['fold', col, '--into', 'web-nav', '--as', 'checkin', '--why', 'x']), /1 commit.*norn collide ask/);
  assert.equal(f.onLane('web-runs', 'queued').length, 1, 'a refused fold changes nothing');
  ok(f.norn(['fold', col, '--into', 'web-nav', '--as', 'controller', '--why', 'one lane']), /\(DEC-\d+\)/);
  assert.equal(f.lane$('web-runs').state, 'parked');
  assert.match(f.lane$('web-runs').park.why, new RegExp(`folded into web-nav \\(${col}\\)`));
  assert.match(foldLines(f.state, 'web-nav')[0], /Branch norn\/web-runs has 1 commit that is not on main: merge it into your branch first \(`git merge`, a merge commit\)/);
  const r = record(f.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'web-nav', stage: 'NAV2', worktree: nav.wt } }).id;
  assert.equal(foldLines(f.state, 'web-nav').length, 1, 'a running run on the kept lane keeps the line');
  record(f.state, { kind: 'run', ev: 'end', id: r, by: 'launcher', data: { outcome: 'done', exit: 0 } });
  assert.deepEqual(foldLines(f.state, 'web-nav'), [], 'a run there ended DONE: the line is gone');
});

test('fold behind a live run: pending, the run is not stopped; --pause sends the pause order; the tick folds when the run ends; refused across homes, into an archived lane, for a lead of parts', () => {
  const f = fixture(), nav = f.nav(), runs = f.runs();
  const live = record(f.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'web-runs', stage: 'R1b', worktree: runs.wt, notes: runs.notes, brief: runs.brief } }).id;
  const col = f.case('item');
  refused(f.norn(['fold', col, '--into', 'web-nav', '--as', 'checkin', '--why', 'x']), new RegExp(`live run ${live}`));
  ok(f.norn(['fold', col, '--into', 'web-nav', '--as', 'controller', '--pause', '--why', 'one lane']), new RegExp(`pending: ${live} runs on lane web-runs.*pause order sent`));
  assert.equal(f.items()[live].state, 'running', 'a live run is never killed');
  assert.ok(f.items()[live].pause, 'the pause order is recorded');
  assert.equal(f.items()[runs.queued].state, 'queued', 'nothing moves while it runs');
  assert.ok(!fs.existsSync(path.join(path.dirname(nav.notes), 'FOLDED-web-runs.md')));
  assert.deepEqual(foldPass(f.state, { project: { root: f.home } }), [], 'still running: still pending');
  record(f.state, { kind: 'run', ev: 'end', id: live, by: 'launcher', data: { outcome: 'handoff', exit: 0 } });
  assert.deepEqual(foldPass(f.state, { project: { root: f.home } }).map(x => x.col), [col]);
  assert.equal(f.items()[runs.queued].state, 'withdrawn');
  assert.ok(fs.existsSync(path.join(path.dirname(nav.notes), 'FOLDED-web-runs.md')));
  assert.equal(f.lane$('web-runs').state, 'archived');
  assert.deepEqual(foldPass(f.state, { project: { root: f.home } }), [], 'once');
  ok(f.norn(['undo', col, '--as', 'controller', '--why', 'back']), /lane web-runs is back/);
  assert.deepEqual(foldPass(f.state, { project: { root: f.home } }), [], 'an undone fold is not applied again');
  assert.equal(f.lane$('web-runs').state, 'active');
  const two = f.case('item', { a: { lane: 'web-nav', home: 'a' }, b: { lane: 'web-runs', home: 'b' }, key: 'item:x' });
  refused(f.norn(['fold', two, '--into', 'web-nav', '--as', 'controller', '--why', 'x']), /two homes/);
  record(f.state, { kind: 'lane', ev: 'create', id: laneId('web-nav', f.state), by: 'checkin', data: { name: 'web-nav' } });
  record(f.state, { kind: 'lane', ev: 'archive', id: laneId('web-nav', f.state), by: 'checkin', data: { why: 'old' } });
  const three = f.case('item', { key: 'item:y' });
  refused(f.norn(['fold', three, '--into', 'web-nav', '--as', 'controller', '--why', 'x']), /lane web-nav is archived/);
});

test('a run started on the kept lane after a fold has the fold line in its prompt; once it ended DONE the next one does not', async () => {
  const f = fixture(), nav = f.nav(); f.runs();
  const col = f.case('item');
  ok(f.norn(['fold', col, '--into', 'web-nav', '--as', 'checkin', '--why', 'one lane']));
  for (const q of f.onLane('web-nav', 'queued')) record(f.state, { kind: 'run', ev: 'withdraw', id: q.id, by: 'owner', data: { why: 'not this test' } });   // the moved run would go first
  const opts = o => ({ state: f.state, locksDir: path.join(f.t, 'state', 'locks'), executor: 'fake', lane: 'web-nav', worktree: nav.wt, notes: nav.notes, hbMs: 150, staleMs: 60000,
    policy: { auto_resume_max: 0 }, budget: { max_claude_workers: 4 }, tick: null, brief: f.brief('nav2', '# web-nav NAV2\nScope: web/nav.mjs\nTests: t\nDone: d\nmode: done\n'), ...o });
  const spec = id => JSON.parse(fs.readFileSync(path.join(f.state, 'runs', `${id}.spec.json`), 'utf8'));
  const r = startRun(opts({ stage: 'NAV2' }));
  assert.ok(r.run && !r.queued, 'started');
  assert.match(spec(r.run).promptText, new RegExp(`\\n\\nLane web-runs was folded into this lane \\(${col}\\)\\. Read FOLDED-web-runs\\.md first\\.`));
  const t0 = performance.now();
  while (!settled(f.items()[r.run])) { if (performance.now() - t0 > 30000) throw new Error('timeout waiting'); await new Promise(res => setImmediate(res)); }
  assert.deepEqual(foldLines(f.state, 'web-nav'), [], 'a run on the kept lane ended DONE: the line ends');
  const r2 = startRun(opts({ stage: 'NAV3' }));
  assert.doesNotMatch(spec(r2.run).promptText ?? '', /FOLDED-web-runs/);
  const t1 = performance.now();
  while (!settled(f.items()[r2.run])) { if (performance.now() - t1 > 30000) throw new Error('timeout waiting'); await new Promise(res => setImmediate(res)); }
});

test('a records read that meets another process append in flight (a torn last line, its lock held) reads again once the writer is done; torn with no writer: an integrity error', async () => {
  const t = mkTmp('meta-torn-'), file = path.join(t, 'runs.jsonl'), lock = path.join(t, 'runs.lock'), line = JSON.stringify({ kind: 'run', ev: 'start', id: 'RUN-1' });
  put(file, line.slice(0, 9)); put(lock, JSON.stringify({ pid: 0, ts: new Date().toISOString() }));   // the writer: half its line on disk, its lock held
  setTimeout(() => { fs.appendFileSync(file, line.slice(9) + '\n'); fs.unlinkSync(lock); }, 60);
  assert.deepEqual(await readEventsAsync(file), [JSON.parse(line)], 'the whole line once the lock is free');
  put(file, line.slice(0, 9));
  assert.throws(() => readEvents(file), /torn last line/, 'no writer: still torn under the lock');
});
