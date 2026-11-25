// lane-collide S3 (SPEC 4A.6, sec. 7 S3): the outcome loop. The tick closes a case when both sides have merged or ended and writes its
// outcome (the landing's conflict path, the resolve runs and their tokens, the port commits, the shared files, the duplicate run time,
// the scope guard's refusals, real); `norn collide replay` lists the history's pairs that collided with no reaction (the 2026-11-20
// baseline: three lanes ported onto a dashboard redesign); `norn collide report` counts the cases; two undone automatic actions in the
// last ten put that class back to a card, with one digest line. Temp git repos and records only; every lane and file name is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkTmp } from './helpers/tmp.mjs';
import { record, recordsFile } from '../engine/lib/records.mjs';
import { loadRoadmap } from '../engine/lib/roadmap.mjs';
import { landDir } from '../engine/lib/landing.mjs';
import { collidePass, outcomePass } from '../engine/lib/tick.mjs';
import { casesOf, caseView, readCollide, gatherIntents } from '../engine/lib/intents.mjs';
import { closeCause, realOf, demotedClasses, collideReport } from '../engine/lib/collide.mjs';
import { digest } from '../engine/lib/digest.mjs';

const NORN = path.join(import.meta.dirname, '..', 'engine', 'bin', 'norn.mjs');
const OLD = '2026-01-05T10:00:00Z';
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_TERMINAL_PROMPT: '0' };
// every commit carries its date: the outcome reads main as it was when the case opened (first parent, by date)
const git = (cwd, at, ...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { cwd, env: { ...ENV, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const fwd = p => p.split(path.sep).join('/');
const BASE = f => `// ${f}\n${[2, 3, 4, 5, 6, 7, 8].map(n => `line ${n}`).join('\n')}\n`;
const usage = n => ({ cache_read_input_tokens: n, cache_creation_input_tokens: 0, input_tokens: 0, output_tokens: 0 });

function repo(files, at = OLD) {
  const t = mkTmp('meta-cout-'), origin = path.join(t, 'origin.git'), home = path.join(t, 'home'), state = path.join(t, 'state', 'k');
  git(t, at, 'init', '-q', '--bare', '-b', 'main', origin);
  git(t, at, 'clone', '-q', origin, home);
  git(home, at, 'checkout', '-q', '-b', 'main');
  for (const f of files) put(path.join(home, f), BASE(f));
  git(home, at, 'add', '-A'); git(home, at, 'commit', '-qm', 'base'); git(home, at, 'push', '-q', 'origin', 'main');
  fs.mkdirSync(state, { recursive: true });
  const r = { t, home, state, p: { name: 'k', root: fwd(home), state, policy: {} } };
  r.lane = (lane, from = 'origin/main') => { const wt = path.join(t, 'wt', lane); git(home, at, 'worktree', 'add', '-q', '-b', `norn/${lane}`, wt, from); return wt; };
  r.edit = (wt, at2, file, fn, msg) => { const f = path.join(wt, file); put(f, fn(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : BASE(file))); git(wt, at2, 'add', '-A'); git(wt, at2, 'commit', '-qm', msg); return git(wt, at2, 'rev-parse', 'HEAD'); };
  r.run = (lane, stage, o = {}) => record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane, stage, ...o } }).id;
  r.end = (id, outcome = 'done', u = null) => record(state, { kind: 'run', ev: 'end', id, by: 'launcher', data: { outcome, exit: outcome === 'done' ? 0 : 1, ...(u ? { usage: u } : {}) } });
  r.dlv = (lane, tip, run) => record(state, { kind: 'deliverable', ev: 'create', by: 'launcher', data: { repo: fwd(home), branch: `norn/${lane}`, tip, lane, run, delivers: lane, source: 'run', done_utc: new Date().toISOString() } }).id;
  r.merged = (id, tip, at2, mc) => record(state, { kind: 'deliverable', ev: 'merged', id, by: 'launcher', data: { how: 'git', tip, merged_at: at2, ...(mc ? { merge_commit: mc } : {}) } });
  r.pr = (id, number) => record(state, { kind: 'deliverable', ev: 'pr', id, by: 'launcher', data: { url: `https://example.invalid/pull/${number}`, number, repo: 'o/r', head: 'x', base: 'main' } });
  return r;
}
const soon = s => new Date(Date.now() + s * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

test('a closed case carries every field of 4A.6: the hold, the conflict path, the resolve run and its tokens, the port commit, the shared file', () => {
  const r = repo(['ui/board.mjs', 'map/paint.mjs']), a = r.lane('board'), b = r.lane('paint');
  const A = r.run('board', 'S1', { worktree: fwd(a) });
  // the case opens before either side commits: main at the opening is the base commit
  const col = record(r.state, { kind: 'collision', ev: 'open', by: 'launcher', data: { key: 'territory/covers:board>paint', kind: 'territory', grade: 'covers', verdict: 'warn', door: 'run',
    a: { lane: 'board', run: A, state: 'running' }, b: { lane: 'paint', state: 'queued' }, files: ['ui/board.mjs'], files_n: 1, why: 'paint covers board', pair: 'board+paint',
    recommended: { remedy: 'wait', args: {}, why: 'landing board removes the collision' } } }).id;
  record(r.state, { kind: 'collision', ev: 'action', id: col, by: 'launcher', data: { action: 'hold', auto: true, args: { run: 'queued' } } });
  const tipA = r.edit(a, soon(60), 'ui/board.mjs', s => s.replace('// ui/board.mjs', '// board header'), 'board: header');
  r.end(A); const dA = r.dlv('board', tipA, A);
  git(r.home, soon(70), 'push', '-q', 'origin', `${tipA}:refs/heads/main`); git(r.home, soon(70), 'fetch', '-q', 'origin'); r.merged(dA, tipA, soon(70));
  const B = r.run('paint', 'S1', { worktree: fwd(b) });
  r.edit(b, soon(80), 'ui/board.mjs', s => `${s}paint footer\n`, 'paint: footer');
  r.edit(b, soon(81), 'map/paint.mjs', s => `${s}more\n`, 'paint: map');
  git(b, soon(90), 'merge', '-q', '--no-edit', '-m', 'merge: main into norn/paint (port paint onto the board header)', 'origin/main');
  const tipB = git(b, soon(90), 'rev-parse', 'HEAD');
  r.end(B); const dB = r.dlv('paint', tipB, B);
  // the mechanical landing met a conflict at an earlier tip and queued a MERGE run (its tokens are the resolve cost)
  const M = r.run('paint', 'MERGE'); r.end(M, 'done', usage(5000));
  put(path.join(landDir(r.state), `${dB}.json`), JSON.stringify({ tip: tipB, status: 'landed', conflicts: [{ tip: 'f'.repeat(40), at: soon(85), queued: M }] }));
  git(r.home, soon(95), 'push', '-q', 'origin', `${tipB}:refs/heads/main`); git(r.home, soon(95), 'fetch', '-q', 'origin'); r.merged(dB, tipB, soon(95));
  const closed = outcomePass(r.state, r.p, { now: Date.now() + 100e3 });
  assert.deepEqual(closed, [col]);
  const c = casesOf(r.state)[col], v = caseView(c);
  assert.equal(c.state, 'closed');
  for (const k of ['key', 'kind', 'grade', 'verdict', 'door', 'a', 'b', 'item', 'files', 'files_n', 'resource', 'recommended', 'actions', 'undone', 'outcome']) assert.ok(k in v, `the case carries ${k}`);
  for (const k of ['at', 'action', 'by', 'auto', 'args', 'before', 'dec', 'as_recommended']) assert.ok(k in v.actions[0], `an action carries ${k}`);
  for (const k of ['home', 'lane', 'run', 'state', 'branch', 'tip']) assert.ok(k in v.a && k in v.b, `a side carries ${k}`);
  const o = v.outcome;
  assert.deepEqual(Object.keys(o).sort(), ['cause', 'closed_at', 'duplicate_min', 'duplicate_tokens', 'held_min', 'merge', 'port_commits', 'real', 'resolve_min', 'resolve_runs', 'resolve_tokens',
    'scope_refusals', 'shared_files_at_merge'].sort());
  assert.equal(o.cause, 'merged');
  assert.equal(o.merge, 'conflict', 'the later side took the conflict path');
  assert.equal(o.resolve_runs, 1); assert.equal(o.resolve_tokens, 5000);
  assert.equal(o.port_commits, 1, 'one "merge: main into" commit on the later branch touched the shared file');
  assert.deepEqual(o.shared_files_at_merge, ['ui/board.mjs']);
  assert.equal(o.duplicate_min, 0); assert.equal(o.duplicate_tokens, 0); assert.equal(o.scope_refusals, 0);
  assert.ok(Number.isFinite(o.held_min) && o.held_min >= 0);
  assert.equal(o.real, 'yes', 'an automatic hold on two sides that shared a changed file was real');
  assert.deepEqual(outcomePass(r.state, r.p, { now: Date.now() + 200e3 }), [], 'written once');
});

test('a case stays open while one side still has a live run or unmerged work; a side that ended unmerged is duplicate run time', () => {
  const r = repo(['ui/board.mjs']), a = r.lane('board');
  const A = r.run('board', 'S1', { worktree: fwd(a) }), B = r.run('paint', 'S1');
  const col = record(r.state, { kind: 'collision', ev: 'open', by: 'launcher', data: { key: 'item:board>paint', kind: 'item', verdict: 'warn', door: 'run',
    a: { lane: 'board', run: A, state: 'running' }, b: { lane: 'paint', run: B, state: 'running' }, files: [], files_n: 0, why: 'one item', pair: 'board+paint' } }).id;
  assert.deepEqual(outcomePass(r.state, r.p), [], 'both sides live');
  r.end(B, 'stopped', usage(700));
  const tipA = r.edit(a, soon(60), 'ui/board.mjs', s => `${s}x\n`, 'board: x');
  assert.deepEqual(outcomePass(r.state, r.p), [], 'board still runs');
  r.end(A); const dA = r.dlv('board', tipA, A);
  assert.deepEqual(outcomePass(r.state, r.p), [], 'board has unmerged work');
  git(r.home, soon(70), 'push', '-q', 'origin', `${tipA}:refs/heads/main`); git(r.home, soon(70), 'fetch', '-q', 'origin'); r.merged(dA, tipA, soon(70));
  assert.deepEqual(outcomePass(r.state, r.p, { now: Date.now() + 80e3 }), [col]);
  const o = casesOf(r.state)[col].outcome;
  assert.equal(o.cause, 'ended', 'one side merged, the other ended');
  assert.equal(o.duplicate_tokens, 700, 'the stopped lane\'s run after the opening');
  assert.equal(o.merge, 'none'); assert.equal(o.real, 'unruled', 'nobody reacted');
});

test('closeCause and realOf: allowed, stale, folded; an allow is not real, a remedy is, an automatic action only on a shared file or a base merged first', () => {
  const c = (kind, acts = []) => ({ data: { kind }, history: [{ ev: 'open', ts: '2026-11-20T10:00:00Z', data: {} }, ...acts.map(([action, auto = false]) => ({ ev: 'action', ts: '2026-11-20T11:00:00Z', by: 'checkin', data: { action, auto } }))] });
  const both = { a: { settled: true, how: 'merged' }, b: { settled: true, how: 'merged' } };
  assert.equal(closeCause(c('territory'), { a: { settled: true, how: 'merged' }, b: { settled: false } }, Date.parse('2026-11-21T10:00:00Z')), null);
  assert.equal(closeCause(c('territory'), both, 0), 'merged');
  assert.equal(closeCause(c('territory', [['allow']]), both, 0), 'allowed');
  assert.equal(closeCause(c('territory', [['fold']]), both, 0), 'folded');
  assert.equal(closeCause(c('territory'), { a: { settled: true, how: 'archived' }, b: { settled: true, how: 'merged' } }, 0), 'archived');
  assert.equal(closeCause(c('stale', [['caveat', true]]), both, Date.parse('2026-11-20T20:00:00Z')), null, 'a stale correction stays open for its day of undo');
  assert.equal(closeCause(c('stale', [['caveat', true]]), both, Date.parse('2026-11-21T12:00:00Z')), 'stale');
  assert.equal(realOf(c('territory'), {}), 'unruled');
  assert.equal(realOf(c('territory', [['allow']]), {}), 'no');
  assert.equal(realOf(c('territory', [['narrow']]), {}), 'yes');
  assert.equal(realOf(c('territory', [['hold', true]]), { shared_files_at_merge: [] }), 'no');
  assert.equal(realOf(c('order', [['after', true]]), { shared_files_at_merge: [], base_first: true }), 'yes');
});

test('demotion: two undone automatic actions among the last ten of one class put that class back to a card, with one digest line', () => {
  const acts = n => Array.from({ length: 10 }, (_, i) => ({ kind: 'stale', action: 'caveat', auto: true, undone: i < n, at: `2026-11-20T1${i}:00:00Z` }));
  assert.deepEqual(demotedClasses(acts(1)), []);
  assert.deepEqual(demotedClasses(acts(2)), [{ cls: 'stale:caveat', undone: 2, of: 10 }]);
  assert.deepEqual(demotedClasses([...acts(2), ...acts(0).map(a => ({ ...a, at: a.at.replace('11-20', '11-21') }))]), [], 'only the last ten count');
  assert.deepEqual(demotedClasses(acts(2), { collide: { demote: { undone: 3, of: 10 } } }), []);
  // on the tick: ten caveat corrections, two of them undone, then a new caveat that names an ended run
  const r = repo(['a.txt']);
  for (let i = 0; i < 10; i++) {
    const id = record(r.state, { kind: 'collision', ev: 'open', by: 'tick', data: { key: `stale/caveat:RM-${90 + i}>RUN-${90 + i}`, kind: 'stale', grade: 'caveat', verdict: 'warn', door: 'tick', a: { lane: 'x' }, b: { lane: 'x' }, files: [], files_n: 0, why: 'old' } }).id;
    record(r.state, { kind: 'collision', ev: 'action', id, by: 'tick', data: { action: 'caveat', auto: true, args: { item: `RM-${90 + i}`, before: 'b', after: 'a' } } });
    if (i < 2) record(r.state, { kind: 'collision', ev: 'undo', id, by: 'checkin', data: { action: 1, why: 'the run was still going' } });
  }
  const th = record(r.state, { kind: 'item', ev: 'create', by: 'controller', data: { title: 'World', kind: 'theme' } }, { views: false });
  const R = r.run('bake', 'S2'); r.end(R, 'stopped');
  const it = record(r.state, { kind: 'item', ev: 'create', by: 'controller', data: { title: 'Bake', kind: 'item', parent: th.id } }, { views: false }).id;
  record(r.state, { kind: 'item', ev: 'edit', id: it, by: 'controller', data: { caveat: `${R} running the bake` } }, { views: false });
  collidePass(r.state, r.p);
  assert.equal(loadRoadmap(r.state).items[it].caveat.text, `${R} running the bake`, 'the demoted class acts no more');
  const cj = readCollide(r.state);
  assert.ok(cj.rows.some(x => x.kind === 'stale' && x.grade === 'caveat' && x.pick), 'the case is a card with SloppaChoppa\'s pick');
  assert.equal(cj.demoted.length, 1);
  const lines = digest(r.state, r.p).sections.collisions.filter(x => x.kind === 'demoted');
  assert.equal(lines.length, 1); assert.match(lines[0].why, /stale \(caveat\): 2 of the last 10 automatic actions were undone/);
  collidePass(r.state, r.p);
  assert.equal(digest(r.state, r.p).sections.collisions.filter(x => x.kind === 'demoted').length, 1, 'a second pass says it no second time');
  assert.equal(readCollide(r.state).demoted[0].since, cj.demoted[0].since, 'the day it was first seen is kept');
});

// the 2026-11-20 baseline (SPEC 1.1 incident 2, synthetic): three lanes whose work began before a dashboard redesign landed each needed a
// "merge: main into ... (port ...)" commit on the files the redesign changed; a fourth lane touched other files and is no pair
function baseline() {
  const D = ['dash/ui.mjs', 'dash/lanes.mjs', 'dash/lanes.css', 'dash/widgets.mjs'], L = ['lib/slots.mjs', 'lib/outputs.mjs', 'lib/branches.mjs', 'lib/other.mjs'];
  const r = repo([...D, ...L, 'docs/guide.md'], '2026-11-19T12:00:00Z');
  const work = [['fair-slots', 83, '2026-11-19T18:49:00Z', ['lib/slots.mjs', 'dash/ui.mjs']], ['lane-outputs', 84, '2026-11-20T02:00:00Z', ['lib/outputs.mjs', 'dash/lanes.mjs']],
    ['quiet', 85, '2026-11-20T03:00:00Z', ['lib/other.mjs', 'docs/guide.md']], ['branches-view', 86, '2026-11-20T10:05:00Z', ['lib/branches.mjs', 'dash/lanes.css']]];
  const wts = {};
  for (const [lane, , at, files] of work) { wts[lane] = r.lane(lane); for (const f of files) r.edit(wts[lane], at, f, s => `${s}${lane}\n`, `${lane}: ${f}`); }
  const nav = r.lane('ui-nav');
  for (const f of D) r.edit(nav, '2026-11-20T04:34:00Z', f, s => s.replace(`// ${f}`, `// redesigned ${f}`), `ui-nav: ${f}`);
  const land = (lane, wt, at, pr) => {
    git(r.home, at, 'fetch', '-q', 'origin'); git(r.home, at, 'checkout', '-q', 'main'); git(r.home, at, 'reset', '-q', '--hard', 'origin/main');
    git(r.home, at, 'merge', '-q', '--no-ff', '-m', `merge: norn/${lane}`, `norn/${lane}`); git(r.home, at, 'push', '-q', 'origin', 'main');
    const tip = git(wt, at, 'rev-parse', 'HEAD'), id = r.dlv(lane, tip, null); r.pr(id, pr); r.merged(id, tip, at, git(r.home, at, 'rev-parse', 'HEAD'));
  };
  land('ui-nav', nav, '2026-11-20T11:13:00Z', 79);
  land('quiet', wts.quiet, '2026-11-20T12:00:00Z', 85);
  for (const [lane, pr, , ,] of work.filter(w => w[0] !== 'quiet')) {
    git(wts[lane], '2026-11-20T16:00:00Z', 'fetch', '-q', 'origin');
    git(wts[lane], '2026-11-20T16:00:00Z', 'merge', '-q', '--no-edit', '-m', `merge: main into norn/${lane} (port ${lane} onto the Lanes board redesign)`, 'origin/main');
    land(lane, wts[lane], `2026-11-20T${17 + work.findIndex(w => w[0] === lane)}:00:00Z`, pr);
  }
  return r;
}

test('replay on a fixture of 2026-11-20 lists the #83, #84 and #86 pairs as collided with no reaction', () => {
  const r = baseline(), p = path.join(r.t, 'project.json');
  fs.writeFileSync(p, JSON.stringify({ schema: 1, name: 'k', title: 'k', root: fwd(r.home), ledger: '${root}/L.md', briefs_dir: '${root}', policy: {} }));
  const res = spawnSync(process.execPath, [NORN, 'collide', 'replay', '--since', '2026-11-19', '--json', '--project', p, '--state', r.state], { encoding: 'utf8', windowsHide: true,
    env: { ...process.env, META_ROOT: path.dirname(r.state), META_NO_TICK: '1', META_RUN_ID: '', META_ROLE: '' } });
  assert.equal(res.status, 0, res.stderr);
  const pairs = JSON.parse(res.stdout).pairs;
  assert.deepEqual(pairs.map(x => [x.day, x.a.lane, x.b.lane, x.b.pr, x.reaction]).sort((x, y) => x[3] - y[3]),
    [['2026-11-20', 'ui-nav', 'fair-slots', 83, 'none'], ['2026-11-20', 'ui-nav', 'lane-outputs', 84, 'none'], ['2026-11-20', 'ui-nav', 'branches-view', 86, 'none']]);
  for (const x of pairs) { assert.equal(x.ports, 1, `${x.b.lane}: one port commit`); assert.equal(x.shared.length, 1); }
  const text = spawnSync(process.execPath, [NORN, 'collide', 'replay', '--since', '2026-11-19', '--project', p, '--state', r.state], { encoding: 'utf8', windowsHide: true,
    env: { ...process.env, META_ROOT: path.dirname(r.state), META_NO_TICK: '1', META_RUN_ID: '', META_ROLE: '' } }).stdout;
  assert.match(text, /2026-11-20 .*ui-nav \(#79\) > fair-slots \(#83\).*no reaction/);
  assert.doesNotMatch(text, /quiet/);
  // the report's last block is that baseline
  const rep = spawnSync(process.execPath, [NORN, 'collide', 'report', '--since', '2026-11-19', '--project', p, '--state', r.state], { encoding: 'utf8', windowsHide: true,
    env: { ...process.env, META_ROOT: path.dirname(r.state), META_NO_TICK: '1', META_RUN_ID: '', META_ROLE: '' } });
  assert.equal(rep.status, 0, rep.stderr);
  assert.match(rep.stdout, /baseline .*3 pairs collided with no reaction, 3 port commits/);
});

test('report: per kind and reaction - cases, automatic, as recommended, changed, undone, held minutes, merges, resolve tokens, duplicate time', () => {
  const at = '2026-11-20T10:00:00Z', act = (action, auto, x = {}) => ({ ev: 'action', ts: at, by: auto ? 'launcher' : 'checkin', data: { action, auto, ...x } });
  const cs = {
    'COL-1': { id: 'COL-1', state: 'closed', data: { kind: 'territory', grade: 'covers', recommended: { remedy: 'wait' } }, outcome: { held_min: 10, merge: 'clean', resolve_tokens: 0, duplicate_min: 0 },
      history: [{ ev: 'open', ts: at, data: {} }, act('hold', true)] },
    'COL-2': { id: 'COL-2', state: 'closed', data: { kind: 'territory', grade: 'covers', recommended: { remedy: 'narrow' } }, outcome: { held_min: 30, merge: 'conflict', resolve_tokens: 900, duplicate_min: 5 },
      history: [{ ev: 'open', ts: at, data: {} }, act('hold', true)] },
    'COL-3': { id: 'COL-3', state: 'open', data: { kind: 'item', recommended: { remedy: 'part' } }, history: [{ ev: 'open', ts: at, data: {} }, act('part', false), act('wait', false), { ev: 'undo', ts: at, by: 'checkin', data: { action: 2 } }] },
  };
  const rep = collideReport(cs, { since: Date.parse('2026-11-19T00:00:00Z'), now: Date.parse('2026-11-22T00:00:00Z') });
  const t = rep.rows.find(x => x.kind === 'territory' && x.reaction === 'hold');
  assert.deepEqual([t.cases, t.automatic, t.held_med, t.clean, t.conflict, t.resolve_tokens, t.duplicate_min], [2, 2, 20, 1, 1, 900, 5]);
  const i = rep.rows.find(x => x.kind === 'item' && x.reaction === 'part');
  assert.deepEqual([i.cases, i.confirmed, i.changed, i.undone], [1, 1, 0, 1]);
});

// 11-25 (task NORN-COLLIDE-MEASURE): the real state's 311 cases had no landing outcome - no landing there is mechanical (a PR or a
// check-in's git merge), and the churn came from live lanes the outcome pass called settled
test('a case whose two sides both merged through merge commits records clean or conflict from git: a resolved port is a conflict', () => {
  const r = repo(['ui/board.mjs', 'map/paint.mjs']), cases = {};
  const land = (lane, wt, at2) => { const tip = git(wt, at2, 'rev-parse', 'HEAD'); git(r.home, at2, 'fetch', '-q', 'origin');
    git(r.home, at2, 'checkout', '-q', '--detach', 'origin/main'); git(r.home, at2, 'merge', '-q', '--no-ff', '-m', `Merge ${lane}`, tip); const mc = git(r.home, at2, 'rev-parse', 'HEAD');
    git(r.home, at2, 'push', '-q', 'origin', `${mc}:refs/heads/main`); git(r.home, at2, 'fetch', '-q', 'origin'); return { tip, mc }; };
  for (const [n, file] of [['clean', 'map/paint.mjs'], ['conflict', 'ui/board.mjs']]) {
    const a = r.lane(`board-${n}`), b = r.lane(`paint-${n}`), A = r.run(`board-${n}`, 'S1', { worktree: fwd(a) }), B = r.run(`paint-${n}`, 'S1', { worktree: fwd(b) });
    const col = record(r.state, { kind: 'collision', ev: 'open', by: 'launcher', data: { key: `territory/covers:board-${n}>paint-${n}`, kind: 'territory', grade: 'covers', verdict: 'warn', door: 'run',
      a: { lane: `board-${n}`, run: A, state: 'running' }, b: { lane: `paint-${n}`, run: B, state: 'running' }, files: ['ui/board.mjs'], files_n: 1, why: 'covers', pair: `board-${n}+paint-${n}` } }).id;
    r.edit(a, soon(60), 'ui/board.mjs', s => s.replace('line 4', 'board line 4'), 'board: line 4'); r.end(A);
    const LA = land(`board-${n}`, a, soon(65)), dA = r.dlv(`board-${n}`, LA.tip, A); r.merged(dA, LA.tip, soon(65), LA.mc);
    r.edit(b, soon(70), file, s => s.replace('line 4', 'paint line 4'), 'paint: line 4');
    // the worker brings main in (git's own message): on the same line it conflicts and is resolved by hand
    const m = spawnSync('git', ['-c', 'core.autocrlf=false', 'merge', '--no-edit', 'origin/main'], { cwd: b, env: { ...ENV, GIT_AUTHOR_DATE: soon(75), GIT_COMMITTER_DATE: soon(75) }, encoding: 'utf8', windowsHide: true });
    if (m.status !== 0) { put(path.join(b, 'ui/board.mjs'), BASE('ui/board.mjs').replace('line 4', 'board and paint line 4')); git(b, soon(75), 'add', '-A');
      git(b, soon(75), 'commit', '-qm', "Merge remote-tracking branch 'origin/main' into norn/paint-conflict"); }
    r.end(B); const LB = land(`paint-${n}`, b, soon(80)), dB = r.dlv(`paint-${n}`, LB.tip, B); r.merged(dB, LB.tip, soon(80), LB.mc);
    cases[n] = col;
  }
  outcomePass(r.state, r.p, { now: Date.now() + 100e3 });
  const o = n => casesOf(r.state)[cases[n]].outcome;
  assert.equal(o('clean').cause, 'merged'); assert.equal(o('clean').merge, 'clean', 'both landing merges and the port replay cleanly');
  assert.equal(o('conflict').merge, 'conflict', 'the port met a conflict on the shared line (git merge-tree)');
  assert.equal(o('conflict').port_commits, 1, "git's own \"Merge remote-tracking branch 'origin/main' into\" is a port");
});

test('a merged lane with commits left ahead, another home\'s run and a live lane whose name was archived before are no settled or live side', () => {
  const r = repo(['ui/board.mjs']), a = r.lane('board');
  const A = r.run('board', 'S1', { worktree: fwd(a) }), tip = r.edit(a, soon(10), 'ui/board.mjs', s => `${s}x\n`, 'board: x'); r.end(A);
  git(r.home, soon(20), 'push', '-q', 'origin', `${tip}:refs/heads/main`); git(r.home, soon(20), 'fetch', '-q', 'origin');
  r.edit(a, soon(30), 'ui/board.mjs', s => `${s}y\n`, 'board: a leftover commit ahead of main');
  const lanes = () => gatherIntents({ state: r.state, repo: r.home, home: 'a', now: Date.now() + 60e3 }).intents.map(x => x.lane).sort();
  assert.deepEqual(lanes(), ['board'], 'paused work ahead of main');
  const d = r.dlv('board', tip, A); r.merged(d, tip, soon(40));
  assert.deepEqual(lanes(), [], 'its deliverable merged after the run ended: landed work, not a live side');
  // another home's run copied into this state is that home's to judge
  const f = recordsFile(r.state, 'run'), ev = JSON.parse(fs.readFileSync(f, 'utf8').trim().split('\n').at(0));
  fs.appendFileSync(f, JSON.stringify({ ...ev, seq: 999, id: 'RUN-b-7', data: { ...ev.data, lane: 'paint', worktree: null } }) + '\n');
  assert.deepEqual(lanes(), [], 'RUN-b-7 is not this home\'s');
  // a live run on a lane name that was archived before: the case stays open (no close, no reopen next tick)
  record(r.state, { kind: 'lane', ev: 'create', by: 'controller', data: { name: 'ci' } }); record(r.state, { kind: 'lane', ev: 'archive', id: 'L:ci', by: 'owner', data: {} });
  const C = r.run('ci', 'CI-1'), D = r.run('doc', 'S1');
  r.end(D);
  const col = record(r.state, { kind: 'collision', ev: 'open', by: 'launcher', data: { key: 'territory/scopes:ci>doc', kind: 'territory', grade: 'scopes', verdict: 'shadow', door: 'run',
    a: { lane: 'ci', run: C, state: 'running' }, b: { lane: 'doc', run: D, state: 'running' }, files: [], files_n: 0, why: 'scopes', pair: 'ci+doc' } }).id;
  assert.deepEqual(outcomePass(r.state, r.p, { now: Date.now() + 60e3 }), [], 'ci still runs');
  assert.deepEqual(outcomePass(r.state, r.p, { now: Date.now() + 60e3, lanes: new Set(['doc']) }), [], 'doc is still open work the judge sees');
  r.end(C);
  assert.deepEqual(outcomePass(r.state, r.p, { now: Date.now() + 60e3 }), [col]);
  assert.equal(casesOf(r.state)[col].outcome.cause, 'archived');
});
