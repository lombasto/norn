// S1 records core: role table, transitions, ids, envelope, lock, fold (node --test, temp dirs only).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROLES, record, readEvents, fold, loadState, withLock, RecordError, recordsFile } from '../engine/lib/records.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => mkTmp('meta-rec-');
let tick = 0;
const now = () => new Date(Date.UTC(2026, 9, 31, 2, 0, tick++));
const rec = (dir, e) => record(dir, e, { now, views: false });

// The design's role table (META-GENERAL-DESIGN 3.4), written out independently of the implementation.
// O = owner-acting roles (owner + dashboard, the owner's buttons); migration (S2 importer) may replay every event.
const O = ['owner', 'dashboard'], C = ['controller'], K = ['checkin'], L = ['launcher'], S = ['status'];
const SPEC = {
  question: { create: [...C, ...K, ...L],   // lane-outputs: the launcher posts a run's owner asks (runasks.mjs)
    answer: O, apply: [...C, ...K], supersede: [...C, ...K], withdraw: [...C, ...K], reopen: O },
  decision: { create: [...C, ...K, ...O], overrule: O, supersede: [...C, ...K] },
  directive: { create: O, done: [...C, ...K], supersede: [...C, ...K, ...O], revoke: O },
  lane: { create: [...O, ...C, ...K], park: [...C, ...K], unpark: [...C, ...K], done: [...C, ...K], archive: [...O, ...C, ...K, 'tick'], unarchive: [...O, ...C] },   // META-OOTB F-1: the owner opens a lane (norn lane new, the dashboard's first task) - additive; lifecycle.mjs: the check-in archives an idle / stopped lane, the tick by its rules
  run: { start: L, end: L, lost: [...L, ...S], kill: [...O, ...C], review: [...K, ...C, ...L] },   // META-CHECKIN-DIET R1: the launcher reviews a routine end (checkins.mjs)
};

const qData = { title: 'Which basin?', lane: 'gen', body: 'b', options: [{ key: 'a', text: 'A', cost: '1h' }, { key: 'b', text: 'B', cost: '' }], recommend: { key: 'a', why: 'cited' }, class: 'ii', blocks: [], source: 'NOTES.md:1' };
const decData = { lane: 'gen', question: 'q', choice: 'c', why: 'w', cost: '', source: 's' };

// Build a fresh dir with the target item in the from-state the event needs; returns {dir, id, extra data}.
function fixture(kind, ev) {
  const dir = tmp();
  if (kind === 'question') {
    if (ev === 'create') return { dir, data: qData };
    const q = rec(dir, { kind, ev: 'create', by: 'checkin', data: qData }).id;
    if (ev === 'answer' || ev === 'withdraw') return { dir, id: q, data: ev === 'answer' ? { choice: 'a', text: 'a', via: 'chat' } : { why: 'moot' } };
    rec(dir, { kind, ev: 'answer', id: q, by: 'owner', data: { choice: 'a', text: 'a please', via: 'dashboard' } });
    if (ev === 'apply') return { dir, id: q, data: { refs: ['DEC-1'] } };
    if (ev === 'supersede') { const dir2 = rec(dir, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'newer', via: 'chat' } }).id; return { dir, id: q, data: { by: dir2, why: 'owner said' } }; }
    if (ev === 'reopen') return { dir, id: q, data: {} };
  }
  if (kind === 'decision') {
    if (ev === 'create') return { dir, data: decData };
    const d = rec(dir, { kind, ev: 'create', by: 'checkin', data: decData }).id;
    if (ev === 'overrule') return { dir, id: d, data: { text: 'no', rework_lane: 'gen' } };
    const d2 = rec(dir, { kind, ev: 'create', by: 'checkin', data: decData }).id;
    return { dir, id: d, data: { by: d2, why: 'newer' } };
  }
  if (kind === 'directive') {
    if (ev === 'create') return { dir, data: { text: 'do x', via: 'chat' } };
    const d = rec(dir, { kind, ev: 'create', by: 'owner', data: { text: 'do x', via: 'chat' } }).id;
    if (ev === 'supersede') { const d2 = rec(dir, { kind, ev: 'create', by: 'owner', data: { text: 'do y', via: 'chat' } }).id; return { dir, id: d, data: { by: d2, why: 'newer' } }; }
    return { dir, id: d, data: ev === 'done' ? { refs: ['RUN-1'] } : {} };
  }
  if (kind === 'lane') {
    if (ev === 'create') return { dir, data: { name: 'gen', worktree: 'w', notes: 'n', branch: 'b' } };
    const l = rec(dir, { kind, ev: 'create', by: 'controller', data: { name: 'gen' } }).id;
    if (ev === 'unpark') rec(dir, { kind, ev: 'park', id: l, by: 'controller', data: { why: 'w' } });
    if (ev === 'unarchive') rec(dir, { kind, ev: 'archive', id: l, by: 'controller', data: {} });
    return { dir, id: l, data: ev === 'park' ? { why: 'w' } : {} };
  }
  if (kind === 'run') {
    if (ev === 'start') return { dir, data: { kind: 'fake', lane: 'gen' } };
    const r = rec(dir, { kind, ev: 'start', by: 'launcher', data: { kind: 'fake' } }).id;
    if (ev === 'review') rec(dir, { kind, ev: 'end', id: r, by: 'launcher', data: { exit: 0, outcome: 'done' } });
    return { dir, id: r, data: ev === 'end' ? { exit: 0, outcome: 'done' } : ev === 'review' ? { refs: ['DEC-1'] } : {} };
  }
  throw new Error('no fixture ' + kind + ' ' + ev);
}

test('role table: every kind x event x role is allowed or refused exactly as SPEC says (one table)', () => {
  for (const [kind, evs] of Object.entries(SPEC)) for (const [ev, allowed] of Object.entries(evs)) {
    for (const role of ROLES) {
      const f = fixture(kind, ev);
      const call = () => rec(f.dir, { kind, ev, id: f.id, by: role, data: f.data });
      if (allowed.includes(role) || role === 'migration') assert.doesNotThrow(call, `${role} may ${kind} ${ev}`);
      else assert.throws(call, e => e instanceof RecordError && e.code === 2 && /role/.test(e.message), `${role} may not ${kind} ${ev}`);
    }
  }
});

test('every role in the enum is one of the design roles (+ status pass)', () => {
  assert.deepEqual([...ROLES].sort(), ['checkin', 'controller', 'dashboard', 'launcher', 'migration', 'owner', 'status', 'tick', 'worker']);
});

// Illegal transitions (from-state wrong, or citation wrong) - each refused with exit code 2 and nothing appended.
const ILLEGAL = [
  ['apply an open question', d => { const q = rec(d, { kind: 'question', ev: 'create', by: 'checkin', data: qData }).id; return { kind: 'question', ev: 'apply', id: q, by: 'checkin', data: { refs: ['DEC-1'] } }; }],
  ['apply without refs', d => { const q = rec(d, { kind: 'question', ev: 'create', by: 'checkin', data: qData }).id; rec(d, { kind: 'question', ev: 'answer', id: q, by: 'owner', data: { text: 'x', via: 'chat' } }); return { kind: 'question', ev: 'apply', id: q, by: 'checkin', data: { refs: [] } }; }],
  ['answer an applied question', d => { const q = rec(d, { kind: 'question', ev: 'create', by: 'checkin', data: qData }).id; rec(d, { kind: 'question', ev: 'answer', id: q, by: 'owner', data: { text: 'x', via: 'chat' } }); rec(d, { kind: 'question', ev: 'apply', id: q, by: 'checkin', data: { refs: ['DEC-1'] } }); return { kind: 'question', ev: 'answer', id: q, by: 'owner', data: { text: 'y', via: 'chat' } }; }],
  ['answer with an unknown option key', d => { const q = rec(d, { kind: 'question', ev: 'create', by: 'checkin', data: qData }).id; return { kind: 'question', ev: 'answer', id: q, by: 'owner', data: { choice: 'z', text: 'z', via: 'chat' } }; }],
  ['answer via talk (only dashboard | chat)', d => { const q = rec(d, { kind: 'question', ev: 'create', by: 'checkin', data: qData }).id; return { kind: 'question', ev: 'answer', id: q, by: 'owner', data: { text: 'x', via: 'talk' } }; }],
  ['supersede a question citing an OLDER open question', d => { const a = rec(d, { kind: 'question', ev: 'create', by: 'checkin', data: qData }).id; const b = rec(d, { kind: 'question', ev: 'create', by: 'checkin', data: qData }).id; return { kind: 'question', ev: 'supersede', id: b, by: 'checkin', data: { by: a, why: 'x' } }; }],
  ['supersede a question citing a checkin decision', d => { const q = rec(d, { kind: 'question', ev: 'create', by: 'checkin', data: qData }).id; const dec = rec(d, { kind: 'decision', ev: 'create', by: 'checkin', data: decData }).id; return { kind: 'question', ev: 'supersede', id: q, by: 'checkin', data: { by: dec, why: 'x' } }; }],
  ['supersede a question citing a missing record', d => { const q = rec(d, { kind: 'question', ev: 'create', by: 'checkin', data: qData }).id; return { kind: 'question', ev: 'supersede', id: q, by: 'checkin', data: { by: 'DIR-9', why: 'x' } }; }],
  ['withdraw an answered question', d => { const q = rec(d, { kind: 'question', ev: 'create', by: 'checkin', data: qData }).id; rec(d, { kind: 'question', ev: 'answer', id: q, by: 'owner', data: { text: 'x', via: 'chat' } }); return { kind: 'question', ev: 'withdraw', id: q, by: 'checkin', data: {} }; }],
  ['reopen an open question', d => { const q = rec(d, { kind: 'question', ev: 'create', by: 'checkin', data: qData }).id; return { kind: 'question', ev: 'reopen', id: q, by: 'owner', data: {} }; }],
  ['question title over 120 chars', () => ({ kind: 'question', ev: 'create', by: 'checkin', data: { ...qData, title: 'x'.repeat(121) } })],
  ['question class outside i-v', () => ({ kind: 'question', ev: 'create', by: 'checkin', data: { ...qData, class: 'vi' } })],
  ['supersede a decision by an OLDER decision', d => { const a = rec(d, { kind: 'decision', ev: 'create', by: 'checkin', data: decData }).id; const b = rec(d, { kind: 'decision', ev: 'create', by: 'checkin', data: decData }).id; return { kind: 'decision', ev: 'supersede', id: b, by: 'checkin', data: { by: a, why: 'x' } }; }],
  ['supersede an OWNER decision by a checkin decision (rule iv)', d => { const a = rec(d, { kind: 'decision', ev: 'create', by: 'owner', data: decData }).id; const b = rec(d, { kind: 'decision', ev: 'create', by: 'checkin', data: decData }).id; return { kind: 'decision', ev: 'supersede', id: a, by: 'checkin', data: { by: b, why: 'x' } }; }],
  ['overrule an overruled decision', d => { const a = rec(d, { kind: 'decision', ev: 'create', by: 'checkin', data: decData }).id; rec(d, { kind: 'decision', ev: 'overrule', id: a, by: 'owner', data: { text: 'no' } }); return { kind: 'decision', ev: 'overrule', id: a, by: 'owner', data: { text: 'no' } }; }],
  ['checkin supersedes a directive citing an OLDER directive', d => { const a = rec(d, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'a', via: 'chat' } }).id; const b = rec(d, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'b', via: 'chat' } }).id; return { kind: 'directive', ev: 'supersede', id: b, by: 'checkin', data: { by: a, why: 'x' } }; }],
  ['checkin supersedes a directive citing a checkin decision', d => { const a = rec(d, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'a', via: 'chat' } }).id; const dec = rec(d, { kind: 'decision', ev: 'create', by: 'checkin', data: decData }).id; return { kind: 'directive', ev: 'supersede', id: a, by: 'checkin', data: { by: dec, why: 'x' } }; }],
  ['revoke a done directive', d => { const a = rec(d, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'a', via: 'chat' } }).id; rec(d, { kind: 'directive', ev: 'done', id: a, by: 'checkin', data: { refs: ['RUN-1'] } }); return { kind: 'directive', ev: 'revoke', id: a, by: 'owner', data: {} }; }],
  ['unpark an active lane', d => { const l = rec(d, { kind: 'lane', ev: 'create', by: 'controller', data: { name: 'gen' } }).id; return { kind: 'lane', ev: 'unpark', id: l, by: 'controller', data: {} }; }],
  ['create a lane twice', d => { rec(d, { kind: 'lane', ev: 'create', by: 'controller', data: { name: 'gen' } }); return { kind: 'lane', ev: 'create', by: 'controller', data: { name: 'gen' } }; }],
  ['end a run twice', d => { const r = rec(d, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'fake' } }).id; rec(d, { kind: 'run', ev: 'end', id: r, by: 'launcher', data: { exit: 0, outcome: 'done' } }); return { kind: 'run', ev: 'end', id: r, by: 'launcher', data: { exit: 0, outcome: 'done' } }; }],
  ['run end with an outcome outside the grammar', d => { const r = rec(d, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'fake' } }).id; return { kind: 'run', ev: 'end', id: r, by: 'launcher', data: { exit: 0, outcome: 'ok' } }; }],
  ['review a running run', d => { const r = rec(d, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'fake' } }).id; return { kind: 'run', ev: 'review', id: r, by: 'checkin', data: {} }; }],
  ['unknown event', d => { const q = rec(d, { kind: 'question', ev: 'create', by: 'checkin', data: qData }).id; return { kind: 'question', ev: 'close', id: q, by: 'checkin', data: {} }; }],
  ['unknown id', () => ({ kind: 'question', ev: 'withdraw', id: 'Q-99', by: 'checkin', data: {} })],
  ['id of another kind', d => { const q = rec(d, { kind: 'question', ev: 'create', by: 'checkin', data: qData }).id; return { kind: 'directive', ev: 'revoke', id: q, by: 'owner', data: {} }; }],
];
for (const [name, build] of ILLEGAL) test('illegal: ' + name, () => {
  const d = tmp();
  const e = build(d);
  const before = fs.existsSync(recordsFile(d, e.kind)) ? fs.readFileSync(recordsFile(d, e.kind), 'utf8') : '';
  assert.throws(() => rec(d, e), x => x instanceof RecordError && x.code === 2);
  const after = fs.existsSync(recordsFile(d, e.kind)) ? fs.readFileSync(recordsFile(d, e.kind), 'utf8') : '';
  assert.equal(after, before, 'nothing appended');
});

test('legal supersede citations: newer Q, answered Q, owner DEC, any DIR; owner supersedes a DIR without a citation', () => {
  const d = tmp();
  const q1 = rec(d, { kind: 'question', ev: 'create', by: 'checkin', data: qData }).id;
  const q2 = rec(d, { kind: 'question', ev: 'create', by: 'checkin', data: qData }).id;
  rec(d, { kind: 'question', ev: 'supersede', id: q1, by: 'checkin', data: { by: q2, why: 'newer' } });
  const q3 = rec(d, { kind: 'question', ev: 'create', by: 'checkin', data: qData }).id;
  const dec = rec(d, { kind: 'decision', ev: 'create', by: 'owner', data: decData }).id;
  rec(d, { kind: 'question', ev: 'supersede', id: q3, by: 'controller', data: { by: dec, why: 'owner ruled' } });
  const q4 = rec(d, { kind: 'question', ev: 'create', by: 'checkin', data: qData }).id;
  rec(d, { kind: 'question', ev: 'answer', id: q2, by: 'owner', data: { choice: 'b', text: 'b', via: 'dashboard' } });
  rec(d, { kind: 'question', ev: 'supersede', id: q4, by: 'checkin', data: { by: q2, why: 'answered there' } });
  const dir1 = rec(d, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'x', via: 'talk' } }).id;
  rec(d, { kind: 'directive', ev: 'supersede', id: dir1, by: 'owner', data: { why: 'changed my mind' } });
  const dec2 = rec(d, { kind: 'decision', ev: 'create', by: 'owner', data: decData }).id;
  rec(d, { kind: 'decision', ev: 'supersede', id: dec, by: 'checkin', data: { by: dec2, why: 'newer owner DEC' } });
  const st = fold(readEvents(recordsFile(d, 'question')));
  assert.deepEqual([q1, q2, q3, q4, dir1, dec].map(i => st.items[i].state), ['superseded', 'answered', 'superseded', 'superseded', 'superseded', 'superseded']);
  assert.equal(st.items[q1].superseded_by, q2);
});

test('envelope: v, seq, ts, id, kind, ev, to (the state it moves to), by, run from META_RUN_ID; ids per kind sequential and never reused', () => {
  const d = tmp();
  process.env.META_RUN_ID = 'RUN-311';
  try {
    const e = rec(d, { kind: 'question', ev: 'create', by: 'checkin', data: qData });
    assert.deepEqual(Object.keys(e), ['v', 'seq', 'ts', 'id', 'kind', 'ev', 'to', 'by', 'run', 'data']); assert.equal(e.to, 'open');
    assert.equal(e.v, 1); assert.equal(e.seq, 1); assert.equal(e.id, 'Q-1'); assert.equal(e.run, 'RUN-311');
    assert.match(e.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  } finally { delete process.env.META_RUN_ID; }
  assert.equal(rec(d, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 't', via: 'chat' } }).run, null);
  rec(d, { kind: 'question', ev: 'withdraw', id: 'Q-1', by: 'checkin', data: {} });
  assert.equal(rec(d, { kind: 'question', ev: 'create', by: 'checkin', data: qData }).id, 'Q-2');
  assert.equal(rec(d, { kind: 'decision', ev: 'create', by: 'checkin', data: decData }).id, 'DEC-1');
  assert.equal(rec(d, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 't', via: 'chat' } }).id, 'DIR-2');
  assert.equal(rec(d, { kind: 'lane', ev: 'create', by: 'controller', data: { name: 'relief' } }).id, 'L:relief');
  assert.equal(rec(d, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'fake' } }).id, 'RUN-1');
  const lines = fs.readFileSync(recordsFile(d, 'question'), 'utf8').split('\n');
  assert.equal(lines.at(-1), ''); assert.deepEqual(lines.slice(0, -1).map(l => JSON.parse(l).seq), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(path.basename(recordsFile(d, 'run')), 'runs.jsonl');
  assert.equal(readEvents(recordsFile(d, 'run')).length, 1, 'runs live in their own log with their own seq');
});

test('a question that blocks lanes parks them; its apply unparks them (explicit lane events)', () => {
  const d = tmp();
  rec(d, { kind: 'lane', ev: 'create', by: 'controller', data: { name: 'gen' } });
  const q = rec(d, { kind: 'question', ev: 'create', by: 'checkin', data: { ...qData, blocks: ['gen', 'nolane'] } }).id;
  let st = loadState(d);
  assert.equal(st.items['L:gen'].state, 'parked'); assert.equal(st.items['L:gen'].park.q, q);
  rec(d, { kind: 'question', ev: 'answer', id: q, by: 'owner', data: { choice: 'a', text: 'a', via: 'chat' } });
  rec(d, { kind: 'question', ev: 'apply', id: q, by: 'checkin', data: { refs: ['DEC-4'] } });
  st = loadState(d);
  assert.equal(st.items['L:gen'].state, 'active');
  assert.deepEqual(st.items['L:gen'].history.map(h => h.ev), ['create', 'park', 'unpark']);
});

test('fold is a pure, deterministic function of the events in seq order', () => {
  const d = tmp();
  rec(d, { kind: 'lane', ev: 'create', by: 'controller', data: { name: 'gen' } });
  const q = rec(d, { kind: 'question', ev: 'create', by: 'checkin', data: { ...qData, blocks: ['gen'] } }).id;
  rec(d, { kind: 'question', ev: 'answer', id: q, by: 'owner', data: { choice: 'a', text: 'a', via: 'chat' } });
  rec(d, { kind: 'decision', ev: 'create', by: 'checkin', data: { ...decData, answers: q } });
  rec(d, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'go', via: 'chat' } });
  const evs = readEvents(recordsFile(d, 'question'));
  const frozen = JSON.stringify(evs);
  const a = JSON.stringify(fold(evs));
  assert.equal(JSON.stringify(evs), frozen, 'fold does not mutate its input');
  assert.equal(JSON.stringify(fold(evs)), a, 'same input, same output');
  const shuffled = [...evs].reverse();
  assert.equal(JSON.stringify(fold(shuffled)), a, 'fold orders by seq, not by array position');
  assert.equal(JSON.stringify(fold(JSON.parse(frozen))), a, 'round-trips through JSON');
  assert.equal(fold(evs).seq, evs.length);
});

// MAIL-28 (1): a supervisor started before the `alive` event existed replayed lost -> alive with its old table, dropped the alive,
// read lost and refused its own end (norn RUN-80, RUN-89, RUN-104). A writer stamps the state an event moves to; a reader that does
// not know the event still applies that state.
test('a newer writer never makes an older reader drop a state change: each event line names its `to`, and fold applies the `to` of an event it does not know', () => {
  const d = tmp();
  const id = rec(d, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'x' } }).id;
  rec(d, { kind: 'run', ev: 'lost', id, by: 'status', data: { why: 'heartbeat 300 s old', cause: 'stale' } });
  rec(d, { kind: 'run', ev: 'alive', id, by: 'status', data: { why: 'beating again' } });
  const evs = readEvents(recordsFile(d, 'run'));
  assert.deepEqual(evs.map(e => e.to), ['running', 'lost', 'running'], 'the writer stamps each event with the state it moves to');
  // an older reader: the same lines with an event its table does not know (here a renamed alive)
  const older = evs.map(e => (e.ev === 'alive' ? { ...e, ev: 'revive-from-the-future' } : e));
  const it = fold(older).items[id];
  assert.equal(it.state, 'running', 'the unknown event still moves the state');
  assert.deepEqual(it.history.map(h => h.ev), ['start', 'lost', 'revive-from-the-future']);
  // an unknown event with no `to` (a note) changes no state, an unknown event on no item makes none
  const note = { ...evs[0], seq: 9, ev: 'note-from-the-future', to: undefined, data: {} };
  assert.equal(fold([...older, note]).items[id].state, 'running');
  assert.equal(fold([{ ...note, id: 'RUN-99' }]).items['RUN-99'], undefined);
});

test('readEvents refuses a torn (unterminated) last line and a non-JSON line', () => {
  const d = tmp(); const f = path.join(d, 'records.jsonl');
  fs.writeFileSync(f, '{"v":1,"seq":1}\n{"v":1,"se');
  assert.throws(() => readEvents(f), /torn/);
  fs.writeFileSync(f, '{"v":1,"seq":1}\nnot json\n');
  assert.throws(() => readEvents(f), /line 2/);
});

test('lock: exclusive, breaks a stale lock (> 10 s), released after a throw', () => {
  const d = tmp(); const lk = path.join(d, 'records.lock');
  fs.writeFileSync(lk, JSON.stringify({ pid: 1, ts: new Date(Date.now() - 11000).toISOString() }));
  assert.equal(withLock(lk, () => { assert.ok(fs.existsSync(lk)); return 7; }), 7);
  assert.equal(fs.existsSync(lk), false);
  assert.throws(() => withLock(lk, () => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(lk), false);
  fs.writeFileSync(lk, JSON.stringify({ pid: 1, ts: new Date().toISOString() }));
  assert.throws(() => withLock(lk, () => 1, { timeoutMs: 200 }), /lock/);
});

test('8 processes x 50 appends -> 400 lines, unique consecutive seq, unique ids, no torn lines', async () => {
  const d = tmp();
  const worker = path.join(HERE, 'helpers', 'append-worker.mjs');
  const codes = await Promise.all(Array.from({ length: 8 }, (_, w) => new Promise((res, rej) => {
    const p = spawn(process.execPath, [worker, d, String(w), '50'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', b => { err += b; });
    p.on('error', rej); p.on('exit', c => res(c === 0 ? 0 : err || c));
  })));
  assert.deepEqual(codes, Array(8).fill(0));
  const raw = fs.readFileSync(recordsFile(d, 'question'), 'utf8');
  assert.ok(raw.endsWith('\n'));
  const evs = readEvents(recordsFile(d, 'question'));
  assert.equal(evs.length, 400);
  assert.deepEqual(evs.map(e => e.seq), Array.from({ length: 400 }, (_, i) => i + 1));
  assert.equal(new Set(evs.map(e => e.id)).size, 400);
  assert.deepEqual(new Set(evs.map(e => e.id)), new Set(Array.from({ length: 400 }, (_, i) => 'Q-' + (i + 1))));
  for (let w = 0; w < 8; w++) assert.equal(evs.filter(e => e.data.title.startsWith(`w${w}-`)).length, 50);
  assert.equal(fs.existsSync(path.join(d, 'records.lock')), false);
});
