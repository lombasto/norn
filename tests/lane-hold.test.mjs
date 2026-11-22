// META-CONTROLLER C4 (SPEC sec. 2 "Proposed: lane holds (a lease), plus first-writer-wins"; sec. 8 C4 row): shared control between
// the controller chat and the check-ins. A hold is a lane event (claim / release, with an expiry); a check-in write on a held lane is
// refused with exit 5 and the digest lists the lane HELD (skip); the chat's acts set / extend the hold; the chat learns what the
// check-ins did as a NEWS block in front of the owner's next message, mail to role:controller with it; one chat per project; a
// question is ruled once (the second writer is refused and told who ruled); `norn eval` replay scores a held-lane write as harmful.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { record, loadState, RecordError, holdOf, heldLanes, HELD_EXIT } from '../engine/lib/records.mjs';
import { digest } from '../engine/lib/digest.mjs';
import { renderDigest } from '../engine/lib/views.mjs';
import { handle, context } from '../engine/lib/mcp.mjs';
import { cliPlan, HOLD_MIN, threadFile } from '../engine/lib/chatact.mjs';
import { createChat, readThread, rolePack } from '../engine/lib/chat.mjs';
import { sendMail, loadMail } from '../engine/lib/mail.mjs';
import { main } from '../engine/bin/norn.mjs';
import { tickContext, scoreTick } from '../engine/lib/eval/checkin.mjs';
import { heldRefusal, RunRefused } from '../engine/lib/runs.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const T0 = Date.parse('2026-11-13T12:00:00Z'), at = ms => () => new Date(ms), MIN = 60000;
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const rec = (s, ev, now = T0) => record(s, ev, { now: at(now), views: false });
const refusedHeld = (fn, re = /L:water is held/) => assert.throws(fn, e => e instanceof RecordError && e.code === HELD_EXIT && re.test(e.message) && /mail .*role:controller/.test(e.message));
function laneState() {
  const s = mkTmp('meta-c4-', 'p');
  for (const name of ['water', 'relief']) rec(s, { kind: 'lane', ev: 'create', by: 'controller', data: { name } });
  return s;
}
const claim = (s, { now = T0, min = 30, by = 'controller', via = 'chat:chat', lane = 'water' } = {}) =>
  rec(s, { kind: 'lane', ev: 'claim', id: 'L:' + lane, by, data: { until: iso(now + min * MIN), why: 'the chat works on it', via } }, now);
const dec = (lane, by = 'checkin') => ({ kind: 'decision', ev: 'create', by, data: { lane, question: 'q', choice: 'c', why: 'w' } });

// ---------- a hold blocks a check-in write and expires ----------
test('C4 hold: a check-in write on a held lane is refused (exit 5, named, mail role:controller); other lanes, the holder and the owner write', () => {
  assert.equal(HELD_EXIT, 5);
  const s = laneState();
  claim(s);
  const h = holdOf(loadState(s).items['L:water'], T0 + MIN);
  assert.deepEqual({ lane: h.lane, holder: h.holder, until: h.until, by: h.by }, { lane: 'water', holder: 'chat', until: iso(T0 + 30 * MIN), by: 'controller' });
  assert.deepEqual(heldLanes(loadState(s).items, T0 + MIN).map(x => x.lane), ['water']);
  const now = T0 + 5 * MIN;
  refusedHeld(() => rec(s, dec('water'), now), /L:water is held by the controller chat until 12:30Z/);
  refusedHeld(() => rec(s, { kind: 'question', ev: 'create', by: 'checkin', data: { title: 't', lane: 'water', options: [{ key: 'a', text: 'a' }] } }, now));
  refusedHeld(() => rec(s, { kind: 'lane', ev: 'park', id: 'L:water', by: 'checkin', data: { why: 'x' } }, now));
  // a question on another lane that blocks the held one: the implied park is a check-in write on it too (all-or-nothing)
  refusedHeld(() => rec(s, { kind: 'question', ev: 'create', by: 'checkin', data: { title: 't', lane: 'relief', options: [{ key: 'a', text: 'a' }], blocks: ['water'] } }, now));
  assert.equal(Object.values(loadState(s).items).filter(i => i.kind === 'question').length, 0, 'nothing of the refused batch was written');
  assert.ok(rec(s, dec('relief'), now).id, 'an unheld lane is the check-in\'s, exactly as today');
  assert.ok(rec(s, dec('water', 'controller'), now).id, 'the holder side (controller) writes');
  assert.ok(rec(s, dec('water', 'owner'), now).id, 'your tap > the chat\'s hold');
  assert.ok(record(s, { kind: 'mail', ev: 'create', by: 'checkin', data: { from: 'role:checkin', to: 'role:controller', subject: 'water', body: 'b' } }, { now: at(now), views: false }).id,
    'the refused check-in mails role:controller');
  // expiry: past until the lane is the check-in's again; no event needed
  assert.equal(holdOf(loadState(s).items['L:water'], T0 + 31 * MIN), null);
  assert.ok(rec(s, dec('water'), T0 + 31 * MIN).id, 'an expired hold blocks nothing');
});

test('C4 hold: release ends it; a later claim extends it; a check-in never claims; until must be a time', () => {
  const s = laneState();
  claim(s);
  rec(s, { kind: 'lane', ev: 'release', id: 'L:water', by: 'owner', data: { why: 'done for now' } }, T0 + MIN);
  assert.equal(holdOf(loadState(s).items['L:water'], T0 + 2 * MIN), null);
  assert.ok(rec(s, dec('water'), T0 + 2 * MIN).id);
  claim(s, { now: T0 + 10 * MIN });
  claim(s, { now: T0 + 30 * MIN });   // extended: until = 13:00
  refusedHeld(() => rec(s, dec('water'), T0 + 45 * MIN), /until 13:00Z/);
  assert.throws(() => rec(s, { kind: 'lane', ev: 'claim', id: 'L:relief', by: 'checkin', data: { until: iso(T0 + MIN) } }), /role checkin may not lane claim/);
  assert.throws(() => rec(s, { kind: 'lane', ev: 'claim', id: 'L:relief', by: 'controller', data: { until: 'soon' } }), /until/);
});

test('C4 hold: a check-in run act on a held lane - withdraw / requeue / norn run - is refused with exit 5; a fill of an earlier queue is not', () => {
  const s = laneState();
  const q = rec(s, { kind: 'run', ev: 'queue', by: 'launcher', data: { kind: 'fake', lane: 'water', executor: 'fake' } });
  claim(s, { now: Date.now() });
  refusedHeld(() => record(s, { kind: 'run', ev: 'withdraw', id: q.id, by: 'checkin', data: { why: 'DEC-1' } }, { views: false }));
  const lines = [], errs = [], env = { META_ROLE: 'checkin' };
  const code = main(['stop', q.id, '--why', 'DEC-1', '--state', s], env, x => lines.push(x), x => errs.push(x));
  assert.equal(code, 5, errs.join('\n'));
  assert.match(errs.join('\n'), /held by the controller chat/);
  const wt = mkTmp('meta-c4-wt-'), brief = path.join(wt, 'b.md'); fs.writeFileSync(brief, 'b');
  const out = [], err = [];
  const rc = main(['run', '--executor', 'fake', '--lane', 'water', '--brief', brief, '--worktree', wt, '--state', s, '--queue', '--no-tick'], env, x => out.push(x), x => err.push(x));
  assert.equal(rc, 5, out.join('\n') + err.join('\n'));
  assert.match(out.join('\n'), /REFUSED: L:water is held/);
  assert.equal(Object.values(loadState(s).items).filter(i => i.kind === 'run').length, 1, 'no run was queued');
  assert.equal(main(['requeue', q.id, '--after', 'none', '--why', 'DEC-1', '--state', s], env, () => {}, () => {}), 5);
});

test('C4 norn lane claim / release (the CLI verbs, recorded); a check-in may not claim (exit 2)', () => {
  const s = laneState(), out = [], err = [];
  assert.equal(main(['lane', 'claim', 'water', '--min', '20', '--why', 'owner at the keyboard', '--state', s, '--as', 'owner'], {}, x => out.push(x), x => err.push(x)), 0, err.join('\n'));
  assert.match(out.join('\n'), /L:water held by the owner until \d\d:\d\dZ/);
  const h = holdOf(loadState(s).items['L:water']);
  assert.equal(h.holder, 'owner'); assert.ok(Math.abs(Date.parse(h.until) - Date.now() - 20 * MIN) < 5000);
  assert.equal(main(['rec', 'add', 'decision', '--lane', 'water', '--question', 'q', '--choice', 'c', '--why', 'w', '--state', s], { META_ROLE: 'checkin' }, () => {}, () => {}), 5);
  assert.equal(main(['lane', 'release', 'water', '--state', s, '--as', 'owner'], {}, x => out.push(x), x => err.push(x)), 0, err.join('\n'));
  assert.equal(holdOf(loadState(s).items['L:water']), null);
  assert.equal(main(['lane', 'claim', 'water', '--state', s], { META_ROLE: 'checkin' }, () => {}, () => {}), 2);
});

test('C4 digest: a held lane is listed HELD (skip) with its holder and expiry; no hold = no section (the digest as before)', () => {
  const s = laneState(), now = Date.now();
  const opts = { now, git: () => '', dlv: [], evalAfter: () => ({ met: null, gone: false }), ready: [] };
  assert.equal(digest(s, {}, opts).sections.held, undefined);
  claim(s, { now });
  const d = digest(s, {}, opts);
  assert.deepEqual(d.sections.held.map(r => [r.id, r.holder]), [['L:water', 'chat']]);
  assert.match(renderDigest(d), /HELD \(skip\)[\s\S]*- L:water HELD \(skip\) by the controller chat until \d\d:\d\dZ \(30 min\): the chat works on it/);
});

// ---------- first writer wins on a question ----------
test('C4 first writer wins on a Q: an answer recorded twice - the second is refused and told who answered; apply twice the same', () => {
  const s = laneState();
  const q = rec(s, { kind: 'question', ev: 'create', by: 'controller', data: { title: 'pick', lane: 'relief', options: [{ key: 'a', text: 'a' }, { key: 'b', text: 'b' }] } });
  rec(s, { kind: 'question', ev: 'answer', id: q.id, by: 'owner', data: { text: 'a please', choice: 'a', via: 'chat:chat' } }, T0 + MIN);
  assert.throws(() => rec(s, { kind: 'question', ev: 'answer', id: q.id, by: 'dashboard', data: { text: 'b', choice: 'b', via: 'dashboard' } }, T0 + 2 * MIN),
    e => e.code === 2 && new RegExp(`${q.id} is answered; answer needs open - first writer wins: answered by owner via chat:chat at 2026-11-13T12:01:00Z`).test(e.message), 'the Inbox button after the chat recorded it');
  const d = rec(s, dec('relief', 'checkin'));
  record(s, { kind: 'question', ev: 'apply', id: q.id, by: 'checkin', data: { refs: [d.id] } }, { now: at(T0 + 3 * MIN), run: 'RUN-410', views: false });
  assert.throws(() => rec(s, { kind: 'question', ev: 'apply', id: q.id, by: 'controller', data: { refs: [d.id] } }),
    e => new RegExp(`first writer wins: applied by checkin RUN-410 \\(refs ${d.id}\\)`).test(e.message));
});

// ---------- the chat's acts set / extend the hold; norn_cli lane claim / release ----------
const own = (state, ...texts) => {
  fs.mkdirSync(path.dirname(threadFile(state)), { recursive: true });
  for (const text of texts) fs.appendFileSync(threadFile(state), JSON.stringify({ ts: new Date().toISOString(), seg: 1, kind: 'owner', text }) + '\n');
};
const ctxOf = (state, o = {}) => context({ state, project: null, profile: o.profile ?? 'chat', client: o.client ?? 'chat', env: {}, cli: o.cli ?? ((argv, env, out, err) => main(argv, env, out, err)),
  approvalMs: 60000, pollMs: 10, notifyFn: () => {} });
let n = 0;
const call = async (ctx, name, a = {}) => (await handle({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: a } }, ctx)).result;
const txt = r => r.content.map(c => c.text).join('\n');
const claims = (s, lane = 'water') => loadState(s).items['L:' + lane].history.filter(h => h.ev === 'claim');

test('C4 the chat acting on a lane sets the hold itself (30 min, holder chat, via chat:chat) and extends it; a read takes none', async () => {
  assert.equal(HOLD_MIN, 30);
  const s = laneState(), ctx = ctxOf(s);
  await call(ctx, 'norn_records', { lane: 'water' });
  assert.equal(claims(s).length, 0, 'tier 0 (read) holds nothing');
  const r = await call(ctx, 'norn_decision_add', { lane: 'water', question: 'q', choice: 'c', why: 'w' });
  assert.ok(!r.isError, txt(r));
  const h = holdOf(loadState(s).items['L:water']);
  assert.deepEqual([h.holder, h.via, h.by], ['chat', 'chat:chat', 'controller']);
  assert.ok(Math.abs(Date.parse(h.until) - Date.now() - 30 * MIN) < 5000);
  refusedHeld(() => record(s, dec('water'), { views: false }));
  await call(ctx, 'norn_decision_add', { lane: 'water', question: 'q2', choice: 'c', why: 'w' });
  assert.equal(claims(s).length, 1, 'a fresh hold is not re-recorded on every act (extended once it is 5 min old)');
  const q = await call(ctx, 'norn_question_add', { lane: 'relief', title: 't', options: [{ key: 'a', text: 'a' }] });
  assert.ok(!q.isError, txt(q));
  assert.equal(holdOf(loadState(s).items['L:relief']).holder, 'chat', 'a question on a lane holds it too');
  const free = await call(ctx, 'norn_decision_add', { lane: 'nolane', question: 'q', choice: 'c', why: 'w' });
  assert.ok(!free.isError, 'a lane with no LANE record: the act stands, no hold (nothing to hold)');
});

test('C4 norn_cli lane claim / release are tier 1 on the chat\'s list; release drops the hold; the outside controller window holds as controller', async () => {
  assert.deepEqual([cliPlan(['lane', 'claim', 'water']).tier, cliPlan(['lane', 'release', 'water']).tier], [1, 1]);
  const s = laneState(), ctx = ctxOf(s);
  let r = await call(ctx, 'norn_cli', { args: ['lane', 'claim', 'water', '--min', '45', '--why', 'owner asked'] });
  assert.ok(!r.isError, txt(r));
  let h = holdOf(loadState(s).items['L:water']);
  assert.deepEqual([h.holder, h.via], ['chat', 'chat:chat']);
  assert.ok(Math.abs(Date.parse(h.until) - Date.now() - 45 * MIN) < 5000);
  r = await call(ctx, 'norn_cli', { args: ['lane', 'release', 'water'] });
  assert.ok(!r.isError, txt(r));
  assert.equal(holdOf(loadState(s).items['L:water']), null, 'a release is not re-held by the act itself');
  const outside = ctxOf(s, { profile: 'controller', client: 'claude-code' });
  r = await call(outside, 'norn_decision_add', { lane: 'water', question: 'q', choice: 'c', why: 'w' });
  assert.ok(!r.isError, txt(r));
  h = holdOf(loadState(s).items['L:water']);
  assert.deepEqual([h.holder, h.via], ['controller', 'chat:claude-code']);
  refusedHeld(() => record(s, dec('water'), { views: false }), /L:water is held by the controller \(chat:claude-code\)/);
});

// ---------- news for the chat, mail to the chat, one chat per project ----------
const fakeChat = (s, o = {}) => createChat({ project: { name: 'p', state: s }, executor: 'fake', model: 'fake-m', effort: 'high', idleMs: 60000, ...o });
const turnEnd = chat => new Promise((res, rej) => {
  const t = setTimeout(() => { off(); rej(new Error('timeout')); }, 15000);
  const off = chat.subscribe(l => { if (l.kind === 'turn') { clearTimeout(t); off(); res(l); } });
});
const texts = s => readThread(s).items.filter(l => l.kind === 'text').map(l => l.text);

test('C4 news: what the check-ins did since the chat\'s last turn + mail to role:controller go in front of the next message, never as owner words', async () => {
  const s = laneState(), chat = fakeChat(s);
  try {
    let t = turnEnd(chat); chat.send('hello'); await t;
    assert.equal(texts(s)[0], 'heard hello (turn 1; first: hello)', 'nothing happened: no NEWS block');
    const d = record(s, dec('relief'), { run: 'RUN-410', views: false });
    record(s, { kind: 'decision', ev: 'create', by: 'owner', data: { lane: 'relief', question: 'own', choice: 'x', why: 'y' } }, { views: false });
    sendMail(s, { by: 'checkin', run: 'RUN-410', to: 'role:controller', subject: 'skipped water', body: 'water is held by you; relief S2 is ready' });
    t = turnEnd(chat); chat.send('what is new?'); await t;
    const reply = texts(s)[1];
    assert.match(reply, /^heard NEWS since your last turn/);
    assert.match(reply, new RegExp(`${d.id} decision by check-in RUN-410: lane relief: q -> c`));
    assert.match(reply, /MAIL-1 from role:checkin: skipped water\n {2}water is held by you; relief S2 is ready/);
    assert.doesNotMatch(reply, /own -> x/, 'the owner\'s own acts are not news');
    assert.match(reply, /The owner's message:\nwhat is new\?/);
    assert.deepEqual(readThread(s).items.filter(l => l.kind === 'owner').map(l => l.text), ['hello', 'what is new?'], 'the owner line is the owner\'s text only');
    const m = loadMail(s)['MAIL-1'];
    assert.deepEqual([m.state, m.deliver.via], ['delivered', 'chat'], 'the mail is delivered to the chat once');
    t = turnEnd(chat); chat.send('and now?'); await t;
    assert.equal(texts(s)[2], 'heard and now? (turn 3; first: hello)', 'no news twice');
  } finally { await chat.close(); }
});

test('C4 one chat per project: a second chat on the same project is refused (409, named); after close it may start; a dead holder is taken over', async () => {
  const s = mkTmp('meta-c4-', 'p'), a = fakeChat(s);
  assert.throws(() => fakeChat(s), e => e.status === 409 && /another Norn chat serves project p \(pid \d+\)/.test(e.message));
  await a.close();
  const b = fakeChat(s);
  await b.close();
  fs.writeFileSync(path.join(s, 'chat', 'chat.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, ts: new Date().toISOString() }));
  const c = fakeChat(s);
  await c.close();
});

test('C4 role packs: the chat and the check-in both learn the hold (exit 5, skip, mail role:controller)', () => {
  const chat = rolePack({ name: 'p' });
  assert.match(chat, /hold/i); assert.match(chat, /norn lane release/); assert.match(chat, /NEWS since your last turn/);
  const ck = fs.readFileSync(new URL('../engine/prompts/CHECKIN.md', import.meta.url), 'utf8');
  assert.match(ck, /HELD \(skip\)/); assert.match(ck, /exit 5/); assert.match(ck, /role:controller/);
  const minor = fs.readFileSync(new URL('../engine/prompts/CHECKIN-MINOR.md', import.meta.url), 'utf8');
  assert.match(minor, /HELD \(skip\)/);
});

// ---------- norn eval replay: check-ins skip held lanes ----------
test('C4 norn eval replay: a lane held at the tick is in the context; a candidate write on it is harmful, skipping it agrees', () => {
  const ev = (seq, kind, e, id, data, ts, by = 'controller') => ({ v: 1, seq, ts, id, kind, ev: e, by, run: null, data });
  const recEvs = [ev(1, 'lane', 'create', 'L:water', { name: 'water' }, '2026-11-13T11:00:00Z'),
    ev(2, 'lane', 'claim', 'L:water', { until: '2026-11-13T12:30:00Z', via: 'chat:chat' }, '2026-11-13T12:00:00Z'),
    ev(3, 'lane', 'create', 'L:relief', { name: 'relief' }, '2026-11-13T11:00:00Z')];
  const ctx = tickContext([], { at: '2026-11-13T12:10:00Z', recEvs });
  assert.deepEqual(ctx.held, ['water']);
  assert.deepEqual(tickContext([], { at: '2026-11-13T12:31:00Z', recEvs }).held, [], 'expired');
  assert.deepEqual(tickContext([], { at: '2026-11-13T11:59:00Z', recEvs }).held, [], 'not yet claimed');
  const rel = [...recEvs, ev(4, 'lane', 'release', 'L:water', {}, '2026-11-13T12:05:00Z')];
  assert.deepEqual(tickContext([], { at: '2026-11-13T12:10:00Z', recEvs: rel }).held, [], 'released');
  const disp = { type: 'dispatch', lane: 'water', stage: 'S1', executor: 'codex-sol', effort: 'medium' };
  let sc = scoreTick([], [disp], ctx);
  assert.equal(sc.worst, 'harmful'); assert.match(sc.items[0].why, /held lane/);
  sc = scoreTick([], [{ type: 'decision', lane: 'water', question: 'q', choice: 'c' }], ctx);
  assert.equal(sc.worst, 'harmful');
  sc = scoreTick([], [{ type: 'record', op: 'park', id: 'L:water' }], ctx);
  assert.equal(sc.worst, 'harmful');
  assert.equal(scoreTick([], [], ctx).agree, true, 'skipping the held lane agrees');
  assert.equal(scoreTick([], [{ ...disp, lane: 'relief' }], ctx).worst, 'recoverable', 'an unheld lane scores as before');
});

// slop C3: lanes are a shared kind - on a synced home the hold another home placed on its lane reaches the check-in's run door
// (the fold of the own log + the copies, records.loadShared; the fixture as in foldhomes.test)
test('C4 hold across homes: a check-in on home b starting a run on home a\'s held lane a/water is refused (exit 5)', () => {
  const home = id => { const d = mkTmp(`meta-c4-${id}-`, 'p'); fs.writeFileSync(path.join(d, 'home.json'), JSON.stringify({ id, bare_home: 'a', cut_at: '2026-11-13T09:00:00Z' }) + '\n'); return d; };
  const a = home('a'), b = home('b');
  rec(a, { kind: 'lane', ev: 'create', by: 'controller', data: { name: 'water' } });
  claim(a, { lane: 'a/water' });
  fs.mkdirSync(path.join(b, 'homes', 'a'), { recursive: true });
  fs.copyFileSync(path.join(a, 'records.jsonl'), path.join(b, 'homes', 'a', 'records.jsonl'));   // the fetch
  assert.throws(() => heldRefusal(b, 'a/water', 'checkin', T0 + 5 * MIN), e => e instanceof RunRefused && e.code === HELD_EXIT && /L:a\/water is held/.test(e.message));
  assert.doesNotThrow(() => heldRefusal(b, 'a/water', 'checkin', T0 + 31 * MIN), 'the hold expired');
});
