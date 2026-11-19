// INBOX-REPLIES: a typed reply on an Inbox question is a message to the controller (say), not a ruling - the Q stays open and becomes
// a thread (the controller's reply, option revisions, a proposed ruling the owner confirms with one tap); an explicit pick closes it;
// the thread survives a dashboard restart. (6) a Q built from a plan section records every alternative it names, verbatim, + its source.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { record, loadState, RecordError } from '../engine/lib/records.mjs';
import { threadOf, unanswered, rulingOf, pickOf, threadStatus } from '../engine/lib/qthread.mjs';
import { sourceQuestion } from '../engine/lib/qsource.mjs';
import { facts, wakeClass } from '../engine/lib/gate.mjs';
import { readEvents, recordsFile } from '../engine/lib/records.mjs';
import { main } from '../engine/bin/norn.mjs';
import { createDashboard } from '../engine/dash/server.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

let tick = 0;
const now = () => new Date(Date.UTC(2026, 10, 19, 9, 0, tick++));
const rec = (dir, e) => record(dir, e, { now, views: false });
const Q = { title: 'Which store?', lane: 'gen', options: [{ key: 'a', text: 'SQLite' }, { key: 'b', text: 'flat files' }], recommend: { key: 'a', why: 'cited', from: 'checkin' }, blocks: [] };

const PLAN = `# Plan

## 3.2 Storage

We need a store for the run index.

Alternatives:
- (a) SQLite in the state folder (plan default)
- (b) one JSONL file per kind
- (c) an embedded LMDB
  with a nested note about the build
- (d) keep it in memory and rebuild on start

Prose after the list.

## 3.3 Next
- not an option
`;

test('a typed message keeps the Q open; a reply revises the options and proposes a ruling; the tap closes it', () => {
  const d = mkTmp('inbox-rep-');
  const q = rec(d, { kind: 'question', ev: 'create', by: 'checkin', data: Q }).id;
  rec(d, { kind: 'question', ev: 'say', id: q, by: 'dashboard', data: { text: 'what does this mean?', via: 'dashboard' } });
  let it = loadState(d).items[q];
  assert.equal(it.state, 'open', 'a message is no ruling');
  assert.equal(unanswered(it).length, 1);
  assert.match(threadStatus(it)[0], /owner wrote \(1, dashboard\): "what does this mean\?" -> reply in the thread: META rec reply Q-1/);
  assert.throws(() => rec(d, { kind: 'question', ev: 'say', id: q, by: 'checkin', data: { text: 'x', via: 'dashboard' } }), RecordError, 'say is the owner\'s');
  // the controller replies: the options revised (a third, real one) and a ruling proposed from the owner's words
  const r = rec(d, { kind: 'question', ev: 'reply', id: q, by: 'checkin', data: { text: 'a = one db file; b = a file per kind; c is new.',
    options: [{ key: 'a', text: 'SQLite (one db file)' }, { key: 'b', text: 'flat files' }, { key: 'c', text: 'LMDB' }], propose: { key: 'b', text: 'flat files, you said you want to read them' } } });
  it = loadState(d).items[q];
  assert.equal(it.state, 'open'); assert.equal(unanswered(it).length, 0);
  assert.deepEqual(it.data.options.map(o => o.key), ['a', 'b', 'c'], 'the revision replaces the list');
  assert.equal(it.data.recommend.key, 'a', 'a kept recommendation stays');
  assert.deepEqual(rulingOf(it), { seq: r.seq, key: 'b', text: 'flat files, you said you want to read them' });
  assert.equal(threadOf(it).filter(x => x.options).length, 1, 'the revision shows in the thread');
  assert.throws(() => rec(d, { kind: 'question', ev: 'answer', id: q, by: 'dashboard', data: { text: 'yes', via: 'dashboard', ruling: r.seq, choice: 'a' } }), /proposes b/);
  assert.throws(() => rec(d, { kind: 'question', ev: 'reply', id: q, by: 'checkin', data: { text: 'x', propose: { key: 'z', text: 'zz' } } }), /propose.key must be one of a \| b \| c/);
  rec(d, { kind: 'question', ev: 'answer', id: q, by: 'dashboard', data: { text: 'Rule: (b) flat files - yes', via: 'dashboard', ruling: r.seq, choice: 'b' } });
  it = loadState(d).items[q];
  assert.equal(it.state, 'answered'); assert.equal(it.answer.choice, 'b');
  assert.deepEqual(threadOf(it).map(x => x.ev), ['say', 'reply', 'answer']);
  assert.throws(() => rec(d, { kind: 'question', ev: 'say', id: q, by: 'dashboard', data: { text: 'more', via: 'dashboard' } }), RecordError, 'a closed Q takes no message');
});

test('pickOf: only a bare option key is a pick', () => {
  const o = [{ key: 'a' }, { key: 'b' }];
  for (const t of ['b', '(b)', 'option B', ' b. ']) assert.equal(pickOf(t, o), 'b', t);
  for (const t of ['b please, but why?', 'what does this mean?', 'z', '']) assert.equal(pickOf(t, o), null, t);
});

test('the gate: an owner message waiting on a reply is a MAJOR wake; the reply clears it', () => {
  const d = mkTmp('inbox-gate-');
  const q = rec(d, { kind: 'question', ev: 'create', by: 'checkin', data: Q }).id;
  const F = () => facts(readEvents(recordsFile(d, 'question')), [], { at: Date.now() });
  assert.ok(![...F()].some(x => x.startsWith('thread:')));
  const s = rec(d, { kind: 'question', ev: 'say', id: q, by: 'dashboard', data: { text: 'why a?', via: 'dashboard' } });
  assert.ok(F().has(`thread:${q}:${s.seq}`));
  assert.equal(wakeClass({ changes: [`+thread:${q}:${s.seq}`, '+owner:1'] }), 'major');
  rec(d, { kind: 'question', ev: 'reply', id: q, by: 'checkin', data: { text: 'because it is one file' } });
  assert.ok(![...F()].some(x => x.startsWith('thread:')));
});

test('(6a) a Q built from a plan section records all 4 alternatives verbatim, its source, and marks an added option', () => {
  const d = mkTmp('inbox-src-'), plan = path.join(d, 'PLAN.md'), st = path.join(d, 'state');
  fs.writeFileSync(plan, PLAN);
  const s = sourceQuestion(`${plan}#3.2 Storage`);
  assert.deepEqual(s.options.map(o => o.key), ['a', 'b', 'c', 'd']);
  assert.equal(s.options[2].text, 'an embedded LMDB with a nested note about the build');
  assert.deepEqual({ key: s.recommend.key, from: s.recommend.from }, { key: 'a', from: 'source' });
  assert.equal(s.origin.section, '3.2 Storage'); assert.equal(s.origin.line, 3);
  const out = [], err = [];
  const code = main(['rec', 'add', 'question', '--lane', 'gen', '--title', 'Which store?', '--from-source', `${plan}#3.2`, '--option', 'e|a hosted Postgres|ops', '--state', st, '--as', 'checkin'], {}, x => out.push(x), x => err.push(x));
  assert.equal(code, 0, err.join('\n'));
  const q = Object.values(loadState(st).items).find(i => i.kind === 'question');
  assert.deepEqual(q.data.options.map(o => o.key), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(q.data.options.slice(0, 4).map(o => o.text), ['SQLite in the state folder (plan default)', 'one JSONL file per kind', 'an embedded LMDB with a nested note about the build', 'keep it in memory and rebuild on start']);
  assert.equal(q.data.options[4].added_by, 'checkin'); assert.equal(q.data.options[0].added_by, undefined);
  assert.equal(q.data.origin.file, plan.replace(/\\/g, '/')); assert.equal(q.data.origin.section, '3.2 Storage');
  assert.equal(q.data.recommend.from, 'source');
  assert.equal(main(['rec', 'add', 'question', '--lane', 'gen', '--title', 'T', '--from-source', `${plan}#3.2`, '--option', 'a|dup', '--state', st, '--as', 'checkin'], {}, () => {}, () => {}), 2, 'a key the source holds is refused');
  assert.equal(main(['rec', 'add', 'question', '--lane', 'gen', '--title', 'T', '--from-source', `${plan}#Nope`, '--state', st, '--as', 'checkin'], {}, () => {}, () => {}), 2);
});

test('the CLI: norn rec say keeps it open, norn rec reply --option --propose revises and proposes', () => {
  const st = mkTmp('inbox-cli-');
  const q = rec(st, { kind: 'question', ev: 'create', by: 'checkin', data: Q }).id;
  const cli = (args, as) => { const err = []; const c = main(['rec', ...args, '--state', st, '--as', as], {}, () => {}, x => err.push(x)); return { c, err: err.join('\n') }; };
  assert.equal(cli(['say', q, '--text', 'is b slower?', '--via', 'chat'], 'owner').c, 0);
  const r = cli(['reply', q, '--text', 'no; reworded', '--option', 'a|SQLite|0', '--option', 'b|flat files, as fast|0', '--propose', '|keep both for now'], 'checkin');
  assert.equal(r.c, 0, r.err);
  const it = loadState(st).items[q];
  assert.equal(it.state, 'open'); assert.equal(it.data.options[1].text, 'flat files, as fast');
  assert.deepEqual(rulingOf(it), { seq: it.history.at(-1).seq, key: null, text: 'keep both for now' });
});

test('dashboard: a typed clarification stays open and starts a reply; an explicit pick closes; a ruling tap closes; the thread survives a restart', async () => {
  const f = await fixture();
  try {
    const s0 = f.counts.ticks;
    const m = await f.post('/api/answer', { id: 'Q-1', text: 'what does this mean?' });
    assert.equal(m.status, 200); assert.equal(m.data.said, true); assert.equal(m.data.reply, 'started');
    assert.equal(f.counts.ticks, s0 + 1, 'a check-in starts at once to reply');
    let it = loadState(f.pa.state).items['Q-1'];
    assert.equal(it.state, 'open'); assert.equal(it.history.at(-1).ev, 'say'); assert.equal(it.history.at(-1).by, 'dashboard');
    let ib = (await f.get('/api/inbox?project=kestrel')).data, card = ib.items.find(i => i.id === 'Q-1' && i.type === 'question');
    assert.equal(card.waiting, 1); assert.equal(card.thread[0].text, 'what does this mean?');
    assert.match(renderTab('inbox', ib, { project: 'kestrel', now: Date.now() }), /id="qt-Q-1"[\s\S]*what does this mean\?[\s\S]*replying/);
    // the controller replies with a revision and a ruling to confirm; the card shows both and the one-tap button
    const r = record(f.pa.state, { kind: 'question', ev: 'reply', id: 'Q-1', by: 'checkin', data: { text: 'a waits for the data, b starts now.', options: [{ key: 'a', text: 'wait for the data' }, { key: 'b', text: 'go now' }, { key: 'c', text: 'go on a small subset' }], propose: { key: 'c', text: 'a small subset first' } } });
    ib = (await f.get('/api/inbox?project=kestrel')).data;
    const html = renderTab('inbox', ib, { project: 'kestrel', now: Date.now() });
    assert.match(html, /revised the options[\s\S]*go on a small subset/);
    assert.match(html, new RegExp(`data-act="rule"[^>]*data-ruling="${r.seq}"`));
    assert.match(html, /3 options/);
    // restart: a new dashboard on the same state shows the same thread
    await f.app.close();
    const app2 = createDashboard({ projects: [f.pa, f.pb], machine: { home: f.root }, budgetFile: f.budgetFile, platform: { tick: async () => ({ pid: 1 }), setInterval: async () => ({ ok: true }) } });
    await new Promise(res => app2.server.listen(0, '127.0.0.1', res));
    const url2 = `http://127.0.0.1:${app2.server.address().port}`;
    try {
      const ib2 = await (await fetch(url2 + '/api/inbox?project=kestrel')).json();
      const c2 = ib2.items.find(i => i.id === 'Q-1' && i.type === 'question');
      assert.deepEqual(c2.thread.map(x => x.ev), ['say', 'reply']); assert.equal(c2.proposal.seq, r.seq);
      const post2 = (b) => fetch(url2 + '/api/answer', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dash-token': app2.token }, body: JSON.stringify(b) });
      assert.equal((await post2({ project: 'kestrel', id: 'Q-1', ruling: r.seq + 99 })).status, 409, 'a stale ruling tap is refused');
      assert.equal((await post2({ project: 'kestrel', id: 'Q-1', ruling: r.seq })).status, 200);
      it = loadState(f.pa.state).items['Q-1'];
      assert.equal(it.state, 'answered'); assert.equal(it.answer.choice, 'c'); assert.equal(it.answer.ruling, r.seq);
      const ib3 = await (await fetch(url2 + '/api/inbox?project=kestrel')).json();
      assert.ok(!ib3.items.some(i => i.id === 'Q-1' && i.type === 'question'), 'the Inbox closes it');
      const res = ib3.items.find(i => i.id === 'Q-1' && i.type === 'resolved');
      assert.deepEqual(res.thread.map(x => x.ev), ['say', 'reply', 'answer'], 'Resolved keeps the thread');
      assert.match(renderTab('inbox', ib3, { project: 'kestrel', now: Date.now() }), /id="inbox-resolved"[\s\S]*id="qr-Q-1"[\s\S]*what does this mean\?/);
    } finally { await app2.close(); }
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('dashboard: a bare option key typed in the box is an explicit pick (closes the Q)', async () => {
  const f = await fixture();
  try {
    const s0 = f.counts.ticks;
    assert.equal((await f.post('/api/answer', { id: 'Q-1', text: '(b)' })).status, 200);
    const it = loadState(f.pa.state).items['Q-1'];
    assert.equal(it.state, 'answered'); assert.equal(it.answer.choice, 'b'); assert.ok(!it.history.some(h => h.ev === 'say'), 'a pick is no message to reply to');
    assert.equal(f.counts.ticks, s0 + 1, 'one tick: the answer applies at once (item 8, MAIL-9 d), no reply');
  } finally { await f.done(); }
});

test('(6b) the card names its source and opens it in the Docs reader', async () => {
  const f = await fixture();
  try {
    const plan = path.join(f.pa.root, 'PLAN-src.md');
    fs.writeFileSync(plan, PLAN);
    const s = sourceQuestion(`${plan}#3.2 Storage`);
    record(f.pa.state, { kind: 'question', ev: 'create', by: 'checkin', data: { title: 'Which store?', lane: 'gen', options: s.options, recommend: s.recommend, origin: s.origin, blocks: [] } });
    const ib = (await f.get('/api/inbox?project=kestrel')).data;
    const html = renderTab('inbox', ib, { project: 'kestrel', now: Date.now() });
    assert.match(html, /4 options · from <button class="lnk" data-ins="path:[^"]*PLAN-src\.md" data-line="3"[^>]*>PLAN-src\.md#3\.2 Storage<\/button>/);
    assert.match(html, /recommended · plan default/);
    const doc = await f.get(`/api/docs?project=kestrel&part=file&file=${encodeURIComponent('path:' + s.origin.file)}`);
    assert.equal(doc.status, 200); assert.match(doc.data.doc.text, /embedded LMDB/);
    assert.equal((await f.get(`/api/docs?project=kestrel&part=file&file=${encodeURIComponent('path:' + path.join(f.root, '..', 'elsewhere.md'))}`)).status, 403);
  } finally { await f.done(); }
});

test('phone (390 px): a card with a thread, a revision, a ruling to confirm and a source never scrolls sideways', async t => {
  const f = await fixture();
  try {
    const plan = path.join(f.pa.root, 'a-rather-long-plan-file-name-for-the-storage-section.md');
    fs.writeFileSync(plan, PLAN);
    const s = sourceQuestion(`${plan}#3.2 Storage`);
    const q = record(f.pa.state, { kind: 'question', ev: 'create', by: 'checkin', data: { title: 'Which store?', lane: 'gen', options: s.options, recommend: s.recommend, origin: s.origin, blocks: [] } }).id;
    const long = 'a long owner message that would push a narrow screen sideways if the thread did not wrap '.repeat(3) + 'https://example.invalid/' + 'x'.repeat(80);
    record(f.pa.state, { kind: 'question', ev: 'say', id: q, by: 'dashboard', data: { text: long, via: 'dashboard' } });
    record(f.pa.state, { kind: 'question', ev: 'reply', id: q, by: 'checkin', data: { text: 'reworded', options: s.options.map(o => ({ ...o, text: o.text + ' ' + 'y'.repeat(60) })), propose: { key: 'b', text: 'one JSONL file per kind ' + 'z'.repeat(70) } } });
    if (skipWhy) { t.diagnostic(`browser part skipped: ${skipWhy}`); return; }
    const pg = await openPage([390, 844]);
    try {
      await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await pg.go(`${f.url}/?project=kestrel&tab=inbox`);
      assert.ok(await pg.until(`document.querySelector('#qconfirm-${q} [data-act=rule]')`, 60000), 'the ruling button shows');
      assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on a phone');
    } finally { await pg.close(); }
  } finally { await f.done(); }
});
