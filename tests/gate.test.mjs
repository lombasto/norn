// META-CHECKIN-GATE (CHECKIN-V2 slice 1): the material-state fingerprint that wakes the LLM check-in only when something changed.
// Temp state dirs only; FAKE claude only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { record, loadState, readEvents, recordsFile } from '../engine/lib/records.mjs';
import { checkinGate, noteCheckin, notePaused, gateFile, actionsOf, bookkeepingIds, endOf, rateBand, wakeClass, GATE_DEFAULTS } from '../engine/lib/gate.mjs';
import { tick } from '../engine/lib/tick.mjs';
import { settingsFor, withDefaults, sectionOf } from '../engine/lib/policy.mjs';
import { settled } from './helpers/settled.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = p => mkTmp(p);
const T0 = Date.parse('2026-11-08T10:00:00Z');
const at = min => () => new Date(T0 + min * 60000);
const ck = (state, min, data = {}) => record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'checkin', executor: 'fake', lane: 'checkin', ...data } }, { now: at(min), run: null });
const worker = (state, min, data = {}, run = null) => record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'a', ...data } }, { now: at(min), run });
const end = (state, id, min, outcome = 'done') => record(state, { kind: 'run', ev: 'end', id, by: 'launcher', data: { outcome, exit: 0 } }, { now: at(min), run: null });
const LIVE = { band: 14, rate_ok: 1, rate_band: 2, quiet: false };
const B = { max_claude_workers: 2, max_codex: 2 };

// state with one finished check-in RUN-1 (10:00-10:05) noted as the baseline; `result` = its final output text
function base(result) {
  const state = path.join(tmp('meta-gate-'), 'state', 'demo');
  let final;
  if (result !== undefined) { final = path.join(state, 'ck-final.json'); fs.mkdirSync(state, { recursive: true }); fs.writeFileSync(final, JSON.stringify({ type: 'result', result })); }
  const c = ck(state, 0, final ? { final } : {});
  noteCheckin(state, { run: c.id, start: new Date(T0).toISOString(), live: LIVE, budget: B });
  end(state, c.id, 5);
  return { state, c };
}
const gateAt = (state, min, o = {}) => checkinGate({ state, budget: B, live: LIVE, now: new Date(T0 + min * 60000), ...o });

test('gate: equal fingerprint -> skip "no change since RUN-n"; first tick ever -> check-in', () => {
  const { state, c } = base();
  const g = gateAt(state, 20);
  assert.equal(g.run, false, g.why); assert.match(g.why, new RegExp(`^no change since ${c.id}$`));
  const fresh = path.join(tmp('meta-gate0-'), 'state', 'demo');
  assert.equal(checkinGate({ state: fresh, budget: B, live: LIVE, now: new Date(T0) }).run, true);
});

test('gate: the check-in\'s OWN actions are part of what it saw (no self-wake); events by others after its start wake', () => {
  const { state, c } = base();
  const w = worker(state, 2, {}, c.id);                                     // dispatched by the check-in
  record(state, { kind: 'decision', ev: 'create', by: 'checkin', data: { lane: 'a', question: 'q', choice: 'x', why: 'y' } }, { now: at(3), run: c.id });
  assert.equal(gateAt(state, 20).run, false, gateAt(state, 20).why);
  end(state, w.id, 30);                                                      // its worker ends -> unreviewed end
  const g = gateAt(state, 31);
  assert.equal(g.run, true); assert.match(g.why, new RegExp(`end:${w.id}`));
  // replay finding: a worker's supervisor inherits META_RUN_ID, so its END carries the check-in's id; after the check-in ended it is news
  const s2 = base();
  const w2 = worker(s2.state, 2, {}, s2.c.id);
  record(s2.state, { kind: 'run', ev: 'end', id: w2.id, by: 'launcher', data: { outcome: 'done', exit: 0 } }, { now: at(30), run: s2.c.id });
  assert.match(gateAt(s2.state, 31).why, new RegExp(`end:${w2.id}`));
});

test('gate: run start by another (controller / resume) and a kill wake; a reviewed end the check-in saw does not', () => {
  const { state, c } = base();
  const w = worker(state, 10);
  assert.match(gateAt(state, 11).why, new RegExp(`run:${w.id}`));
  const s2 = base();
  const k = worker(s2.state, -30); end(s2.state, k.id, -10, 'stopped');   // stopped: no queued next stage (not a ready lane)
  record(s2.state, { kind: 'run', ev: 'review', id: k.id, by: 'checkin', data: { refs: [] } }, { now: at(2), run: s2.c.id });
  assert.equal(gateAt(s2.state, 20).run, false, gateAt(s2.state, 20).why);
  const x = worker(s2.state, -20, { lane: 'b' });
  assert.equal(gateAt(s2.state, 20).run, false, 'running before the check-in, still running: seen');
  record(s2.state, { kind: 'run', ev: 'kill', id: x.id, by: 'owner', data: { why: 'stop' } }, { now: at(25), run: null });
  assert.match(gateAt(s2.state, 26).why, new RegExp(`end:${x.id}:killed`));
});

test('gate: owner / dashboard records, open questions, parks, overrules each wake', () => {
  let s = base();
  record(s.state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'do it', via: 'chat' } }, { now: at(10), run: null });
  assert.match(gateAt(s.state, 11).why, /dir:DIR-1/);
  s = base();
  record(s.state, { kind: 'question', ev: 'create', by: 'controller', data: { lane: 'a', title: 't', body: 'b' } }, { now: at(10), run: null });
  assert.match(gateAt(s.state, 11).why, /q:Q-1:open/);
  s = base();
  record(s.state, { kind: 'lane', ev: 'create', by: 'checkin', data: { name: 'a' } }, { now: at(1), run: s.c.id });
  assert.equal(gateAt(s.state, 11).run, false);
  record(s.state, { kind: 'lane', ev: 'park', id: 'L:a', by: 'controller', data: { why: 'w' } }, { now: at(10), run: null });
  assert.match(gateAt(s.state, 11).why, /lane:L:a:parked/);
  s = base();
  record(s.state, { kind: 'decision', ev: 'create', by: 'checkin', data: { lane: 'a', question: 'q', choice: 'x', why: 'y' } }, { now: at(1), run: s.c.id });
  record(s.state, { kind: 'decision', ev: 'overrule', id: 'DEC-1', by: 'dashboard', data: { text: 'no' } }, { now: at(10), run: null });
  assert.match(gateAt(s.state, 11).why, /dec:DEC-1:overruled/);
});

test('gate: a lane the tick archives by rule is no news unless the archive names work at risk (DEC-a-680); other archivers wake', () => {
  const laneSeen = () => { const s = base(); record(s.state, { kind: 'lane', ev: 'create', by: 'checkin', data: { name: 'a' } }, { now: at(1), run: s.c.id }); return s; };
  const archive = (s, by, extra = {}) => record(s.state, { kind: 'lane', ev: 'archive', id: 'L:a', by, data: { why: 'merged 7 d ago - by the tick', rule: 'merged', worktree: 'removed', ...extra } }, { now: at(10), run: null });
  let s = laneSeen(); archive(s, 'tick');
  assert.equal(gateAt(s.state, 11).run, false, gateAt(s.state, 11).why);
  s = laneSeen(); archive(s, 'tick', { worktree: 'kept', at_risk: 'C:/wt/a: commits not on main' });
  let g = gateAt(s.state, 11);
  assert.equal(g.run, true); assert.deepEqual(g.changes, ['-lane:L:a:active']); assert.equal(g.cls, 'major');
  s = laneSeen(); archive(s, 'checkin');
  g = gateAt(s.state, 11);
  assert.equal(g.run, true); assert.deepEqual(g.changes, ['-lane:L:a:active']);
  s = laneSeen(); archive(s, 'tick');
  record(s.state, { kind: 'question', ev: 'create', by: 'controller', data: { lane: 'a', title: 't', body: 'b' } }, { now: at(10), run: null });
  g = gateAt(s.state, 11);
  assert.equal(g.run, true); assert.deepEqual(g.changes, ['+q:Q-1:open']);
});

test('gate: a live run past its wall budget (x wall_time_multiplier) is a stall and wakes once', () => {
  const s = base();
  const w = worker(s.state, -5, { budget_min: 20 });
  assert.equal(gateAt(s.state, 30).run, false, 'within 2x');
  const g = gateAt(s.state, 40);
  assert.equal(g.run, true); assert.match(g.why, new RegExp(`stall:${w.id}`));
  assert.equal(gateAt(s.state, 40, { policy: { iteration: { wall_time_multiplier: 3 } } }).run, false, 'policy multiplier');
});

test('gate: a cap RAISE wakes (a slot opened for queued work); a cap cut and finished lanes waiting on a merge do not', () => {
  // R2 replay 11-07..09 (48 h): a "ready lane" fact never gated an action alone - it flipped for 36..57 stale lanes on every cap /
  // busy change (RUN-1505, RUN-1528 idle); a slot that frees by an END is already an end fact. A cap raise is the one uncovered cause.
  const s = base();
  const a = worker(s.state, -30, { lane: 'a' }); worker(s.state, -30, { lane: 'b' }); worker(s.state, -30, { lane: 'd' });
  end(s.state, a.id, -10, 'handoff');
  record(s.state, { kind: 'run', ev: 'review', id: a.id, by: 'checkin', data: { refs: [] } }, { now: at(1), run: s.c.id });
  assert.equal(gateAt(s.state, 20).run, false, gateAt(s.state, 20).why);
  const g = gateAt(s.state, 20, { budget: { ...B, max_claude_workers: 3 } });
  assert.equal(g.run, true); assert.match(g.why, /\+cap:max_claude_workers:3/);
  assert.equal(gateAt(s.state, 20, { budget: { ...B, max_claude_workers: 1 } }).run, false, 'cap cut: nothing new to dispatch');
  const s2 = base();
  const a2 = worker(s2.state, -30, { lane: 'a' }); end(s2.state, a2.id, -10);
  record(s2.state, { kind: 'run', ev: 'review', id: a2.id, by: 'checkin', data: { refs: [] } }, { now: at(1), run: s2.c.id });
  assert.equal(gateAt(s2.state, 20, { budget: { ...B, max_claude_workers: 1 } }).run, false, 'a finished lane is no standing wake');
});

test('gate: burn band (5 % buckets), RATE_OK, QUIET and a PAUSED flip wake', () => {
  const s = base();
  assert.equal(gateAt(s.state, 20, { live: { ...LIVE } }).run, false);
  assert.match(gateAt(s.state, 20, { live: { ...LIVE, band: 15 } }).why, /band/);
  assert.match(gateAt(s.state, 20, { live: { ...LIVE, rate_ok: 0 } }).why, /rate_ok/);
  assert.match(gateAt(s.state, 20, { live: { ...LIVE, quiet: true } }).why, /quiet/);
  notePaused(s.state, new Date(T0 + 15 * 60000));
  assert.match(gateAt(s.state, 20).why, /pause/);
});

test('gate: the rate wakes only when it leaves the near-cap quarter (held dispatches may go), not on other quarter flips', () => {
  // R2 replay 48 h: rate-quarter flips woke 28 check-ins, 26 idle; the 2 that acted (RUN-1416, RUN-1499 dispatched) both fell
  // out of the top quarter (>= 3/4 of the cap), where check-ins hold dispatches "near the cap" (RUN-1138 0.74, RUN-1413 0.87)
  const s = base();
  for (const rb of [0, 1, 3, 4]) assert.equal(gateAt(s.state, 20, { live: { ...LIVE, rate_band: rb } }).run, false, `2 -> ${rb}`);
  const near = path.join(tmp('meta-gnear-'), 'state', 'demo');
  const c = ck(near, 0); noteCheckin(near, { run: c.id, start: new Date(T0).toISOString(), live: { ...LIVE, rate_band: 3 }, budget: B }); end(near, c.id, 5);
  assert.equal(gateAt(near, 20, { live: { ...LIVE, rate_band: 4 } }).run, false, '3 -> 4 stays near');
  for (const rb of [2, 0]) assert.match(gateAt(near, 20, { live: { ...LIVE, rate_band: rb } }).why, /rate_near/, `3 -> ${rb}`);
});

test('gate: every wake is classed minor / major (GT-5 seam: a minor wake may later run a reduced tick); probes add facts', () => {
  assert.equal(wakeClass({ forced: true }), 'minor');
  assert.equal(wakeClass({ followUp: true }), 'major');
  assert.equal(wakeClass({ changes: ['+run:RUN-9', '+band:15', '-band:14', '+owner:3', '-owner:2'] }), 'minor');
  for (const c of ['+end:RUN-9:exited', '+stall:RUN-9', '+q:Q-1:open', '+dir:DIR-1', '+dec:DEC-1:overruled', '+lane:L:a:parked',
    '+quiet:true', '+pause:flipped', '+rate_ok:1', '-rate_near:1', '+cap:max_claude_workers:3']) assert.equal(wakeClass({ changes: ['+run:RUN-9', c] }), 'major', c);
  const s = base();
  const g = gateAt(s.state, 20, { probes: [({ at: t }) => (t > T0 + 10 * 60000 ? ['mstall:RUN-7'] : [])] });   // e.g. log mtime unmoved 10 min
  assert.equal(g.run, true); assert.match(g.why, /\+mstall:RUN-7/); assert.equal(g.cls, 'major', 'an unknown (new) fact is major');
  assert.equal(gateAt(s.state, 61).cls, 'minor');
  const w = worker(s.state, 10);
  assert.equal(gateAt(s.state, 11).cls, 'minor', `start ${w.id} by another`);
});

test('gate: a check-in that defers work to the next tick / check-in is woken once (its follow-up request)', () => {
  // replay finding: RUN-1418 "spawn VANTAGE-R3 needs a new brief = next tick" -> RUN-1422 dispatched it with nothing else new
  assert.equal(gateAt(base('reviewed RUN-9; nothing to rule').state, 20).run, false);
  for (const t of ['spawn VANTAGE-R3 needs a new brief = next tick, held one slot', 'will dispatch on Opus high at the Next Check-in']) {
    const g = gateAt(base(t).state, 20);
    assert.equal(g.run, true, t); assert.match(g.why, /^follow-up asked by RUN-1: /);
  }
  assert.equal(rateBand(1.31, 1.5), 3); assert.equal(rateBand(0.99, 1.5), 2); assert.equal(rateBand(2, 1.5), 4); assert.equal(rateBand(1, 0), null);
});

test('gate: forced after checkin_max_quiet_min (default 60); checkin_gate off = always check in', () => {
  const s = base();
  assert.equal(GATE_DEFAULTS.checkin_max_quiet_min, 60); assert.equal(GATE_DEFAULTS.checkin_gate, true);
  assert.equal(gateAt(s.state, 59).run, false);
  const g = gateAt(s.state, 61);
  assert.equal(g.run, true); assert.match(g.why, /forced: last check-in RUN-1 61 min ago/);
  assert.equal(gateAt(s.state, 40, { budget: { ...B, checkin_max_quiet_min: 30 } }).run, true);
  assert.equal(gateAt(s.state, 20, { budget: { ...B, checkin_gate: false } }).run, true);
});

test('tick: second tick after the check-in exits skips (code 0, tick.log line, counter); a directive wakes the next', async () => {
  const t = tmp('meta-gtick-');
  const root = path.join(t, 'root'), state = path.join(t, 'state', 'demo');
  fs.mkdirSync(root, { recursive: true });
  const p = { name: 'demo', root, state, ledger: path.join(t, 'progress.md'), briefs_dir: t, checkin: { cwd: root } };
  const budget = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'status', 'BUDGET.json'), 'utf8').replace(/^﻿/, ''));
  const o = { project: p, machine: { claude: { exe: 'x', projects_dir: path.join(t, 'none') } }, budget: { ...budget, calib_time_utc: new Date().toISOString() },
    budgetFile: path.join(t, 'budget.json'), reason: 'test', dry: true, hbMs: 100, staleMs: 3000, fakeMs: 200 };
  let r = tick(o);
  assert.equal(r.code, 0, r.msg); assert.match(r.msg, /check-in RUN-1/);
  const done = id => { for (let i = 0; i < 1200; i++) { if (loadState(state).items[id]?.state === 'exited' && settled(loadState(state).items[id])) return; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } throw new Error('timeout'); };
  done('RUN-1');
  r = tick(o);
  assert.equal(r.code, 0); assert.match(r.msg, /skip: no change since RUN-1$/);
  assert.match(fs.readFileSync(path.join(state, 'tick.log'), 'utf8'), /skip: no change since RUN-1\n$/);
  const g = JSON.parse(fs.readFileSync(gateFile(state), 'utf8'));
  assert.equal(g.run, 'RUN-1'); assert.equal(g.skips, 1); assert.equal(Object.values(g.skips_by_day)[0], 1);
  // records carry whole-second ts: a directive in the same second as RUN-1's start reads as seen by it (1 in 3 runs alone);
  // a real owner directive arrives after the check-in's start second
  while (new Date().toISOString().slice(0, 19) <= g.start.slice(0, 19)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  record(state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'go', via: 'chat' } }, { run: null });
  r = tick(o);
  assert.match(r.msg, /check-in RUN-2/); assert.match(r.msg, /dir:DIR-1/);
  done('RUN-2');
  r = tick({ ...o, budget: { ...o.budget, checkin_gate: false } });
  assert.match(r.msg, /check-in RUN-3/, 'gate off = today\'s behaviour');
  done('RUN-3');
});

test('gate (NORN-WATCH S1): a deliverable newly done wakes the check-in once (dlv:<id>:done); one that stays done does not re-wake', () => {
  const { state } = base();
  record(state, { kind: 'deliverable', ev: 'create', by: 'launcher', data: { repo: 'C:/r', branch: 'feat/x', lane: 'a' } }, { now: at(10), run: null });
  const g = gateAt(state, 20);
  assert.equal(g.run, true, g.why);
  assert.ok(g.changes.includes('+dlv:DLV-1:done'), g.changes.join(' '));
  const c2 = ck(state, 25);
  noteCheckin(state, { run: c2.id, start: new Date(T0 + 25 * 60000).toISOString(), live: LIVE, budget: B });
  end(state, c2.id, 30);
  const g2 = gateAt(state, 40);
  assert.equal(g2.run, false, g2.why);
});

// CHECKIN-V2 piece 1 (Gas Town GUPP, constants.go:94-101: hooked work with no progress for 30 min): a live run whose log,
// transcript and NOTES mtimes all stay unchanged for checkin.stall_idle_min (default 30) is idle:RUN-n, a MAJOR wake, once
test('gate: a live run whose log, transcript and NOTES all stay unmoved for stall_idle_min (30) is idle:RUN-n, a major wake', async () => {
  const { idleProbe, STALL_IDLE_MIN } = await import('../engine/lib/gate.mjs');
  const { gateProbes } = await import('../engine/lib/tick.mjs');
  assert.equal(STALL_IDLE_MIN, 30);
  const s = base(), dir = path.dirname(s.state), pd = path.join(dir, 'projects');
  const sid = 'aaaaaaaa-0000-4000-8000-000000000001';
  const files = { log: path.join(dir, 'w.log'), notes: path.join(dir, 'NOTES.md'), tr: path.join(pd, 'C--wt', sid + '.jsonl') };
  fs.mkdirSync(path.dirname(files.tr), { recursive: true });
  const touch = (f, min) => { fs.writeFileSync(f, 'x'); fs.utimesSync(f, new Date(T0 + min * 60000), new Date(T0 + min * 60000)); };
  for (const f of Object.values(files)) touch(f, -4);
  const w = worker(s.state, -5, { log: files.log, notes: files.notes, session_id: sid, budget_min: 600 });
  const probes = [idleProbe({ projectsDir: pd })];
  assert.equal(gateAt(s.state, 25, { probes }).run, false, '29 min since the last mtime: not idle yet');
  const g = gateAt(s.state, 27, { probes });
  assert.equal(g.run, true); assert.match(g.why, new RegExp(`\\+idle:${w.id}\\b`)); assert.equal(g.cls, 'major');
  touch(files.tr, 20);   // the transcript moved: progress
  assert.equal(gateAt(s.state, 27, { probes: [idleProbe({ projectsDir: pd })] }).run, false, 'any one file moving = progress');
  assert.equal(gateAt(s.state, 51, { probes: [idleProbe({ projectsDir: pd })] }).run, true);
  assert.equal(gateAt(s.state, 51, { probes: [idleProbe({ projectsDir: pd, minutes: 60 })] }).run, false, 'checkin.stall_idle_min');
  // the tick wires it from the project's checkin.stall_idle_min and the machine's claude projects dir
  const p = { name: 'demo', state: s.state, checkin: { stall_idle_min: 60 } };
  const at = T0 + 51 * 60000, running = [{ id: w.id, created: new Date(T0 - 5 * 60000).toISOString(), data: { log: files.log, notes: files.notes, session_id: sid } }];
  const facts = ps => ps.flatMap(pr => pr({ at, running, runs: running, items: [] }));
  assert.deepEqual(facts(gateProbes(p, { claude: { projects_dir: pd } })), []);
  assert.deepEqual(facts(gateProbes({ ...p, checkin: {} }, { claude: { projects_dir: pd } })), [`idle:${w.id}`]);
});

test('gate: "MAJOR NEEDED" in the last check-in\'s final wakes a full (major) tick next, forced or not', () => {
  const s = base('- meta 10:05Z: band 15; MAJOR NEEDED: RUN-9 ended STOPPED, needs a ruling');
  const g = gateAt(s.state, 20);
  assert.equal(g.run, true); assert.equal(g.cls, 'major'); assert.match(g.why, /escalated by RUN-1: MAJOR NEEDED: RUN-9 ended STOPPED/);
  assert.equal(gateAt(s.state, 70).cls, 'major', 'past max quiet: still the full tick');
  assert.equal(gateAt(base('- meta 10:05Z: nothing to do').state, 20).run, false);
});

test('tick: a minor wake runs the reduced prompt on checkin_minor_model / _effort (tick_class minor); \'\' = the full tick', async () => {
  const t = tmp('meta-gminor-');
  const root = path.join(t, 'root'), state = path.join(t, 'state', 'demo');
  fs.mkdirSync(root, { recursive: true });
  const p = { name: 'demo', root, state, ledger: path.join(t, 'progress.md'), briefs_dir: t, checkin: { cwd: root } };
  const budget = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'status', 'BUDGET.json'), 'utf8').replace(/^﻿/, ''));
  const o = { project: p, machine: { claude: { exe: 'x', projects_dir: path.join(t, 'none') } }, budget: { ...budget, calib_time_utc: new Date().toISOString() },
    budgetFile: path.join(t, 'budget.json'), reason: 'test', dry: true, hbMs: 100, staleMs: 3000, fakeMs: 100 };
  const done = id => { for (let i = 0; i < 1200; i++) { if (loadState(state).items[id]?.state === 'exited' && settled(loadState(state).items[id])) return; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } throw new Error('timeout'); };
  let r = tick(o);
  assert.match(r.msg, /check-in RUN-1 fake claude-opus-5-5 medium/, 'first ever = full');
  assert.match(fs.readFileSync(path.join(state, 'CHECKIN.rendered.md'), 'utf8'), /^# META CHECK-IN/);
  done('RUN-1');
  // the baseline check-in started an hour ago (a real forced tick): a forced verdict never hangs on 'now > start' within the same
  // second, which a backward wall-clock step (the WSL runner's ~16 s) breaks (CI 42663820965, 42627334510)
  const hourOld = () => fs.writeFileSync(gateFile(state), JSON.stringify({ ...JSON.parse(fs.readFileSync(gateFile(state), 'utf8')), start: new Date(Date.now() - 3600e3).toISOString() }));
  const forced = { ...o, budget: { ...o.budget, checkin_max_quiet_min: 0 } };   // forced, no change = a minor wake
  hourOld();
  r = tick(forced);
  assert.match(r.msg, /check-in RUN-2 fake claude-sonnet-5-5 medium .*gate: minor forced/);
  assert.equal(loadState(state).items['RUN-2'].data.tick_class, 'minor');
  const mp = fs.readFileSync(path.join(state, 'CHECKIN-MINOR.rendered.md'), 'utf8');
  assert.match(mp, /^# META MINOR CHECK-IN/); assert.match(mp, /MAJOR NEEDED/); assert.match(mp, /forced: last check-in RUN-1/, 'names its wake');
  assert.doesNotMatch(mp, /\{\{\w+\}\}/);
  done('RUN-2');
  hourOld();
  r = tick({ ...forced, budget: { ...forced.budget, checkin_minor_model: '', checkin_minor_effort: 'low' } });
  assert.match(r.msg, /check-in RUN-3 fake claude-opus-5-5 medium .*gate: minor forced/, "'' = today's full tick");
  assert.equal(loadState(state).items['RUN-3'].data.tick_class, 'major');
  done('RUN-3');
});

// CHECKIN-V2 piece 3 (Gas Town await-signal backoff min(base * mult^idle, max), molecule_await_signal.go:46-69): a FORCED quiet
// tick whose actionsOf() is empty doubles the next quiet window (base = today's checkin_max_quiet_min, 60; cap checkin_quiet_max_min,
// 240, never below the base: a window is never shorter than before); a fact change resets it
test('gate: quiet backoff - an idle forced tick doubles the next window (60 -> 120 -> .. cap checkin_quiet_max_min); acting or a change resets', () => {
  assert.equal(GATE_DEFAULTS.checkin_quiet_max_min, 240);
  const B6 = { ...B, checkin_quiet_max_min: 360 };
  const forcedBase = (quiet_n, act) => {
    const s = base();
    noteCheckin(s.state, { run: s.c.id, start: new Date(T0).toISOString(), live: LIVE, budget: B, forced: true, quiet_n });
    if (act) record(s.state, { kind: 'decision', ev: 'create', by: 'checkin', data: { lane: 'a', question: 'q', choice: 'x', why: 'y' } }, { now: at(2), run: s.c.id });
    return s;
  };
  // a woken (not forced) baseline: the base window, even under a 360 cap
  let g = gateAt(base().state, 61, { budget: B6 });
  assert.equal(g.run, true); assert.equal(g.forced, true); assert.equal(g.quiet_n, 0); assert.match(g.why, /max quiet 60\)/);
  // a forced baseline that acted on nothing: 120
  let s = forcedBase(0);
  assert.equal(gateAt(s.state, 100, { budget: B6 }).run, false, 'window doubled to 120');
  g = gateAt(s.state, 121, { budget: B6 });
  assert.equal(g.run, true); assert.equal(g.quiet_n, 1); assert.match(g.why, /max quiet 120\)/);
  // capped at checkin_max_quiet_min
  s = forcedBase(3);
  assert.equal(gateAt(s.state, 359, { budget: B6 }).run, false);
  assert.match(gateAt(s.state, 361, { budget: B6 }).why, /max quiet 360\)/);
  assert.equal(gateAt(s.state, 361, { budget: B6 }).quiet_n, 3, 'the exponent stops at the cap');
  // a forced baseline that acted: back to the base window
  s = forcedBase(2, true);
  g = gateAt(s.state, 61, { budget: B6 });
  assert.equal(g.run, true); assert.equal(g.quiet_n, 0);
  // the default cap 240: 60 -> 120 -> 240; a cap at or below the base (or a project window of 360) leaves no room
  assert.equal(gateAt(forcedBase(0).state, 100).run, false); assert.match(gateAt(forcedBase(2).state, 241).why, /max quiet 240\)/);
  assert.equal(gateAt(forcedBase(0).state, 61, { budget: { ...B, checkin_quiet_max_min: 60 } }).run, true);
  assert.equal(gateAt(forcedBase(0).state, 359, { budget: { ...B, checkin_max_quiet_min: 360 } }).run, false, 'NORN-WATCH S2: 360 stays 360');
  assert.match(gateAt(forcedBase(0).state, 361, { budget: { ...B, checkin_max_quiet_min: 360 } }).why, /max quiet 360\)/);
});

test('tick: the gate\'s forced / quiet_n reach the next baseline (gate.json)', async () => {
  const t = tmp('meta-gquiet-');
  const root = path.join(t, 'root'), state = path.join(t, 'state', 'demo');
  fs.mkdirSync(root, { recursive: true });
  const p = { name: 'demo', root, state, ledger: path.join(t, 'progress.md'), briefs_dir: t, checkin: { cwd: root } };
  const budget = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'status', 'BUDGET.json'), 'utf8').replace(/^﻿/, ''));
  const o = { project: p, machine: { claude: { exe: 'x', projects_dir: path.join(t, 'none') } }, budget: { ...budget, calib_time_utc: new Date().toISOString(), checkin_max_quiet_min: 0 },
    budgetFile: path.join(t, 'budget.json'), reason: 'test', dry: true, hbMs: 100, staleMs: 3000, fakeMs: 100 };
  const done = id => { for (let i = 0; i < 1200; i++) { if (loadState(state).items[id]?.state === 'exited' && settled(loadState(state).items[id])) return; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } throw new Error('timeout'); };
  const G = () => JSON.parse(fs.readFileSync(gateFile(state), 'utf8'));
  // the baseline check-in started an hour ago (a real forced tick): a forced verdict never hangs on 'now > start' within the same
  // second, which a backward wall-clock step (the WSL runner's ~16 s) breaks
  const hourOld = (more = {}) => fs.writeFileSync(gateFile(state), JSON.stringify({ ...G(), start: new Date(Date.now() - 3600e3).toISOString(), ...more }));
  tick(o); done('RUN-1');
  assert.equal(G().forced, false); assert.equal(G().quiet_n, 0);
  hourOld();
  assert.match(tick(o).msg, /check-in RUN-2 .*forced/); done('RUN-2');
  assert.equal(G().forced, true); assert.equal(G().quiet_n, 0);
  hourOld({ quiet_n: 2 });   // as if two idle forced ticks came before
  assert.match(tick(o).msg, /check-in RUN-3 .*forced/); done('RUN-3');
  assert.equal(G().forced, true); assert.equal(G().quiet_n, 2, 'carried (a cap of 0 leaves no room to double)');
});

// a helper's end belongs to its parent (the parent reads its answer), so a check-in that only reviews one acted on nothing and the
// forced backoff still doubles; a review of a WORK run stays an action
test('actionsOf: reviewing a helper run (role helper, under its parent) is not an action; reviewing a work run is', () => {
  const state = path.join(tmp('meta-grep2-'), 'state', 'demo');
  const c1 = ck(state, 0); end(state, c1.id, 5);
  const w = worker(state, -30);
  const h = record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'cli', executor: 'grok', lane: 'a', role: 'helper', parent: w.id } }, { now: at(6), run: w.id });
  end(state, h.id, 8);
  const c2 = ck(state, 15);
  record(state, { kind: 'run', ev: 'review', id: h.id, by: 'checkin', data: { refs: [w.id] } }, { now: at(16), run: c2.id });
  end(state, c2.id, 17);
  end(state, w.id, 20);
  const c3 = ck(state, 30);
  record(state, { kind: 'run', ev: 'review', id: w.id, by: 'checkin', data: { refs: [] } }, { now: at(31), run: c3.id });
  end(state, c3.id, 32);
  const runEvs = readEvents(recordsFile(state, 'run')), evs = [...readEvents(recordsFile(state, 'question')), ...runEvs], book = bookkeepingIds(runEvs);
  assert.deepEqual(actionsOf(evs, c2.id, endOf(runEvs, c2.id), book), [], 'helper review = bookkeeping');
  assert.deepEqual(actionsOf(evs, c3.id, endOf(runEvs, c3.id), book), ['run.review']);
});
