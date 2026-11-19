// RM-46 S1d (multi-home SPEC 3.7, 3.8, 4.2, 4.6): the merged fold of the own log + the other homes' copies, record() on the merged
// view (pending, the double-pending refusal, the foreign-lane refusal, the HLC ts), the relay at the primary + relay.jsonl, cross-home
// mail. Synthetic homes a (bare) and b, project dirs on temp trees only; "the fetch" is a verbatim copy of the other home's shared
// files into <state>/homes/<h>/ (sync.test covers the git side). Clocks are injected; no test sleeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { record, fold, foldHomes, loadState, loadShared, readEvents, recordsFile, RecordError, SHARED_KINDS, KINDS } from '../engine/lib/records.mjs';
import { loadRoadmap } from '../engine/lib/roadmap.mjs';
import { loadMail, sendMail, checkMail, ackMail } from '../engine/lib/mail.mjs';
import { relayPass } from '../engine/lib/sync.mjs';
import { tryDigest } from '../engine/lib/digest.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const clock = iso => { let n = 0; const t0 = Date.parse(iso); return () => new Date(t0 + 1000 * n++); };
const qData = { title: 'Which basin?', lane: 'gen', body: 'b', options: [{ key: 'a', text: 'A', cost: '1h' }, { key: 'b', text: 'B', cost: '' }], recommend: { key: 'a', why: 'cited' } };
function homeDir(id) {
  const d = path.join(mkTmp(`foldhomes-${id}-`), 'state', 'demo');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'home.json'), JSON.stringify({ id, bare_home: 'a', cut_at: '2026-11-20T09:00:00Z' }) + '\n');
  return d;
}
// the fetch, simulated: every shared file (+ relay.jsonl) of `from` copied verbatim to <to>/homes/<h>/
const logs = () => [...new Set(SHARED_KINDS.map(k => KINDS[k].file + '.jsonl')), 'relay.jsonl'];
function copy(from, h, to) {
  for (const f of logs()) { const src = path.join(from, f); if (fs.existsSync(src)) { fs.mkdirSync(path.join(to, 'homes', h), { recursive: true }); fs.copyFileSync(src, path.join(to, 'homes', h, f)); } }
}
const view = st => ({ items: st.items, pending: st.pending, conflicts: st.conflicts });

test('golden: foldHomes over one stream equals fold() of that file', () => {
  const d = path.join(mkTmp('foldhomes-solo-'), 'state', 'demo'), now = clock('2026-11-20T10:00:00Z'), R = e => record(d, e, { now, views: false });
  const q1 = R({ kind: 'question', ev: 'create', by: 'controller', data: qData }).id, q2 = R({ kind: 'question', ev: 'create', by: 'checkin', data: qData }).id;
  R({ kind: 'question', ev: 'reply', id: q1, by: 'controller', data: { text: 'new list', options: [{ key: 'c', text: 'C', cost: '' }] } });
  R({ kind: 'question', ev: 'answer', id: q1, by: 'owner', data: { choice: 'c', text: 'c please', via: 'dashboard' } });
  R({ kind: 'question', ev: 'apply', id: q1, by: 'controller', data: { refs: ['DEC-1'] } });
  R({ kind: 'question', ev: 'supersede', id: q2, by: 'controller', data: { by: q1, why: 'folded' } });
  R({ kind: 'lane', ev: 'create', by: 'controller', data: { name: 'x' } });
  R({ kind: 'directive', ev: 'create', by: 'owner', data: { text: 'keep it small', via: 'chat' } });
  const evs = readEvents(recordsFile(d, 'question')), one = foldHomes([{ home: 'a', events: evs }], { bare_home: 'a', own: 'a' }), want = fold(evs);
  assert.deepEqual({ seq: one.seq, next: one.next, items: one.items }, want);
  assert.deepEqual([one.pending, one.conflicts, one.integrity], [{}, [], []]);
});

test('order: a skewed clock on b still folds to one view on both homes, and the answer sorts after its question (HLC ts)', () => {
  const a = homeDir('a'), b = homeDir('b');
  const q = record(a, { kind: 'question', ev: 'create', by: 'controller', data: qData }, { now: clock('2026-11-20T10:00:05Z'), views: false }).id;
  const rm = record(b, { kind: 'item', ev: 'create', by: 'owner', data: { title: 'twin', kind: 'theme' } }, { now: clock('2026-11-20T09:00:00Z'), views: false }).id;
  assert.equal(q, 'Q-a-1'); assert.equal(rm, 'RM-b-1');
  copy(a, 'a', b);
  // b's clock is an hour slow: the answer still gets a ts after the question it answers
  const ans = record(b, { kind: 'question', ev: 'answer', id: q, by: 'owner', data: { choice: 'a', text: 'a please', via: 'dashboard' } }, { now: clock('2026-11-20T09:00:00Z'), views: false });
  assert.equal(ans.ts, '2026-11-20T10:00:06Z');
  copy(b, 'b', a);
  const va = loadState(a), vb = loadState(b);
  assert.deepEqual(view(va), view(vb), 'the same view on both homes');
  assert.equal(va.items[q].state, 'open', 'a foreign transition is pending until the primary relays it');
  assert.deepEqual(va.pending[q].map(e => [e.home, e.ev]), [['b', 'answer']]);
  assert.ok(loadRoadmap(a).items[rm], 'a sees b\'s roadmap item');
  // the stream order of the inputs does not matter
  const s = [{ home: 'a', events: readEvents(recordsFile(a)) }, { home: 'b', events: readEvents(recordsFile(b)) }];
  assert.deepEqual(view(foldHomes(s, { bare_home: 'a', own: 'a' })), view(foldHomes([s[1], s[0]], { bare_home: 'a', own: 'b' })));
  // the relay at a commits it; both views agree again
  const r = relayPass(a, { now: clock('2026-11-20T10:01:00Z') });
  assert.deepEqual([r.relayed.length, r.refused.length], [1, 0]);
  copy(a, 'a', b);
  const va2 = loadState(a), vb2 = loadState(b);
  assert.deepEqual(view(va2), view(vb2));
  assert.equal(va2.items[q].state, 'answered');
  assert.deepEqual(va2.items[q].history.map(h => h.ev), ['create', 'answer']);
  assert.deepEqual(va2.pending, {});
});

test('double answer (C2): b answers twice = refused on b; a answered first, so a\'s relay refuses b\'s answer -> a conflict on b; a\'s answer stands', () => {
  const a = homeDir('a'), b = homeDir('b'), A = clock('2026-11-20T10:00:00Z'), B = clock('2026-11-20T10:00:30Z');
  const q = record(a, { kind: 'question', ev: 'create', by: 'controller', data: qData }, { now: A, views: false }).id;
  copy(a, 'a', b);
  record(a, { kind: 'question', ev: 'answer', id: q, by: 'owner', data: { choice: 'a', text: 'a on a', via: 'dashboard' } }, { now: A, views: false });
  const ans = { kind: 'question', ev: 'answer', id: q, by: 'owner', data: { choice: 'b', text: 'b on b', via: 'dashboard' } };
  record(b, ans, { now: B, views: false });
  assert.throws(() => record(b, ans, { now: B, views: false }), e => e instanceof RecordError && /pending/.test(e.message), 'nobody answers twice');
  copy(b, 'b', a);
  const r = relayPass(a, { now: A });
  assert.deepEqual([r.relayed.length, r.refused.length], [0, 1]);
  assert.equal(relayPass(a, { now: A }).refused.length, 0, 'a refusal is written once');
  const rows = fs.readFileSync(path.join(a, 'relay.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(rows.map(x => [x.home, x.id, x.ev, x.file]), [['b', q, 'answer', 'records']]);
  copy(a, 'a', b);
  const vb = loadState(b), va = loadState(a);
  assert.deepEqual(view(va), view(vb));
  assert.equal(vb.items[q].answer.text, 'a on a', 'the primary\'s answer stands');
  assert.deepEqual(vb.pending, {});
  assert.equal(vb.conflicts.length, 1);
  assert.match(vb.conflicts[0].why, /answered/);
  assert.equal(vb.conflicts[0].home, 'b');
  const dg = tryDigest(b, { name: 'demo' }, { dlv: [], evalAfter: () => ({ met: true, gone: false }), ready: [] });
  assert.ok(dg?.sections.homes?.some(x => x.kind === 'conflict' && x.id === q), JSON.stringify(dg?.sections.homes));
});

test('a foreign create is rejected; a copy that does not parse is an integrity row, never a crash', () => {
  const a = homeDir('a'), b = homeDir('b');
  record(a, { kind: 'question', ev: 'create', by: 'controller', data: qData }, { now: clock('2026-11-20T10:00:00Z'), views: false });
  const forged = { v: 1, seq: 1, ts: '2026-11-20T10:00:01Z', id: 'Q-a-7', kind: 'question', ev: 'create', by: 'controller', run: null, data: qData };
  fs.writeFileSync(recordsFile(b), JSON.stringify(forged) + '\n');
  copy(b, 'b', a);
  const va = loadState(a);
  assert.equal(va.items['Q-a-7'], undefined);
  assert.deepEqual(va.conflicts.map(c => [c.kind, c.home, c.id]), [['foreign create', 'b', 'Q-a-7']]);
  fs.writeFileSync(path.join(a, 'homes', 'b', 'records.jsonl'), 'not json\n');
  const v2 = loadState(a);
  assert.ok(v2.items['Q-a-1']);
  assert.deepEqual(v2.integrity.map(x => x.home), ['b']);
});

test('record() on the merged view: a check-in / controller write on another home\'s lane is refused; a create takes the own prefix', () => {
  const a = homeDir('a'), b = homeDir('b');
  record(a, { kind: 'lane', ev: 'create', by: 'controller', data: { name: 'x' } }, { now: clock('2026-11-20T10:00:00Z'), views: false });
  copy(a, 'a', b);
  assert.ok(loadState(b).items['L:a/x']);
  assert.throws(() => record(b, { kind: 'lane', ev: 'park', id: 'L:a/x', by: 'checkin', data: { why: 'idle' } }, { now: clock('2026-11-20T10:00:00Z'), views: false }),
    e => e instanceof RecordError && /L:a\/x belongs to home a/.test(e.message));
  assert.equal(record(b, { kind: 'question', ev: 'create', by: 'controller', data: qData }, { now: clock('2026-11-20T10:00:00Z'), views: false }).id, 'Q-b-1');
});

test('a relay is idempotent: a second pass relays nothing, and the event is committed once', () => {
  const a = homeDir('a'), b = homeDir('b');
  const q = record(a, { kind: 'question', ev: 'create', by: 'controller', data: qData }, { now: clock('2026-11-20T10:00:00Z'), views: false }).id;
  copy(a, 'a', b);
  record(b, { kind: 'question', ev: 'answer', id: q, by: 'owner', data: { choice: 'a', text: 'yes', via: 'dashboard' } }, { now: clock('2026-11-20T10:00:00Z'), views: false });
  copy(b, 'b', a);
  assert.equal(relayPass(a, { now: clock('2026-11-20T10:02:00Z') }).relayed.length, 1);
  assert.deepEqual(relayPass(a, { now: clock('2026-11-20T10:02:00Z') }), { relayed: [], refused: [] });
  const mine = readEvents(recordsFile(a)).filter(e => e.ev === 'answer');
  assert.deepEqual(mine.map(e => [e.by, e.from_home?.home, e.from_home?.seq]), [['owner', 'b', 1]]);
});

test('mail across homes: MAIL-a-n to RUN-b-n is delivered by b and the ack commits at once (b is the primary)', () => {
  const a = homeDir('a'), b = homeDir('b');
  const run = record(b, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'fake', lane: 'x' } }, { now: clock('2026-11-20T10:00:00Z'), views: false }).id;
  assert.equal(run, 'RUN-b-1');
  const m = sendMail(a, { by: 'controller', to: run, subject: 'hello', body: 'from a' });
  assert.equal(m.id, 'MAIL-a-1');
  copy(a, 'a', b);
  const got = checkMail(b, { by: 'worker', run, via: 'hook' });
  assert.deepEqual(got.map(x => x.id), ['MAIL-a-1']);
  ackMail(b, { by: 'worker', run, id: 'MAIL-a-1' });
  assert.equal(loadMail(b)['MAIL-a-1'].state, 'acked');
  assert.deepEqual(loadShared(b, 'mail').pending, {});
  copy(b, 'b', a);
  assert.equal(loadMail(a)['MAIL-a-1'].state, 'acked', 'a sees b\'s delivery and ack');
  assert.deepEqual(relayPass(a, {}), { relayed: [], refused: [] }, 'nothing to relay: b committed its own transitions');
});
