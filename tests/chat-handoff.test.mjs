// META-CONTROLLER C5 (SPEC sec. 4 "Context and cost", sec. 8 C5 row): the chat never dies of a full context, and shows what it costs.
// Thresholds from policy.context.controller (90 / 110 / 150k): amber past no_new_step_k; at handoff_k, between turns, Norn sends the fixed
// hand-off turn, writes chat/handoff-<n>.md (the model's hand-off + what Norn carries mechanically: live holds, cards waiting for a tap,
// the last turns verbatim) and starts a NEW segment whose first message carries it; at hard_max_k it is forced (no model turn).
// The cost line: tokens of the day's turns (per turn, never per-process totals summed), ~ weekly % (an estimate), turns.
// Settings rows (harness, model, effort, idle minutes, hold length, raw shell) are read live - no dashboard restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createChat, readThread, chatCost } from '../engine/lib/chat.mjs';
import { HANDOFF_PROMPT } from '../engine/lib/ctxlimit.mjs';
import { adapterFor } from '../engine/lib/harness/index.mjs';
import { promptTier, requestApproval, HOLD_MIN } from '../engine/lib/chatact.mjs';
import { record, loadState, holdOf } from '../engine/lib/records.mjs';
import { handle, context } from '../engine/lib/mcp.mjs';
import { main } from '../engine/bin/norn.mjs';
import { settingsFor, sectionOf, withDefaults, applySettings, POLICY_DEFAULTS } from '../engine/lib/policy.mjs';
import { homeEvents, renderThread, renderHome } from '../engine/dash/home.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { fixture } from './helpers/dash-fixture.mjs';

const MIN = 60000;
const CTX = { no_new_step_k: 90, handoff_k: 110, hard_max_k: 150 };
const proj = () => { const state = mkTmp('meta-c5-', 'p'), root = path.join(path.dirname(path.dirname(state)), 'root'); fs.mkdirSync(root, { recursive: true }); return { name: 'p', state, root }; };
const cfgOf = (o = {}) => ({ executor: 'fake', model: 'fake-m', effort: 'high', idleMs: 60000, rawShell: 'off', context: { ...CTX }, ...o });
const mkChat = (p, cfg) => createChat({ project: p, config: () => cfg });
const next = (chat, pred, ms = 15000) => new Promise((res, rej) => {
  const t = setTimeout(() => { off(); rej(new Error('timeout waiting for a chat event')); }, ms);
  const off = chat.subscribe(l => { if (pred(l)) { clearTimeout(t); off(); res(l); } });
});
const turnEnd = chat => next(chat, l => l.kind === 'turn');
const lines = p => readThread(p.state).items;
const kinds = p => lines(p).map(l => l.kind);
const say = async (chat, text) => { const t = turnEnd(chat); chat.send(text); await t; };
// the fake CLI keeps each session's messages (what the model was sent) under <chat dir>/fake-sessions
const sent = (p, sid) => JSON.parse(fs.readFileSync(path.join(p.state, 'chat', 'fake-sessions', `${sid}.json`), 'utf8')).messages;
const segs = p => lines(p).filter(l => l.kind === 'segment');

// ---------- fake usage crossing 90 / 110 / 150k ----------
test('C5 90k: past no_new_step_k the meter turns amber and nothing else happens (no hand-off, same segment)', async () => {
  const p = proj(), chat = mkChat(p, cfgOf());
  try {
    await say(chat, 'thread: fix the water');
    await say(chat, '!ctx 95000');
    assert.ok(!kinds(p).includes('handoff'), 'no hand-off below handoff_k');
    assert.equal(segs(p).length, 1);
    const st = chat.status();
    assert.equal(st.ctx, 95000); assert.deepEqual(st.context, CTX);
    const html = renderHome({ project: 'p', status: { ...st, executor: 'fake', handoff_k: 110, no_new_step_k: 90 }, events: [] }, { now: Date.now() });
    assert.match(html, /class="hctx amber"/, 'the meter is amber past 90k');
    const calm = renderHome({ project: 'p', status: { ctx: 50000, handoff_k: 110, no_new_step_k: 90 }, events: [] }, { now: Date.now() });
    assert.doesNotMatch(calm, /hctx amber/);
  } finally { await chat.close(); }
});

test('C5 110k: between turns Norn sends the fixed hand-off turn, writes handoff-1.md, and the next message starts a NEW segment carrying it', async () => {
  const p = proj(), chat = mkChat(p, cfgOf());
  try {
    await say(chat, 'thread: fix the water');
    await say(chat, 'promise: shots by noon');
    const seg2 = next(chat, l => l.kind === 'segment' && l.n === 2);
    await say(chat, '!ctx 115000');
    const s2 = await seg2;
    const sid1 = segs(p)[0].session_id;
    assert.ok(sent(p, sid1).at(-1).startsWith(HANDOFF_PROMPT.split('\n')[0].slice(0, 20)), 'the hand-off turn went to the OLD session');
    assert.match(sent(p, sid1).at(-1), /## Open threads/);
    const ls = lines(p), ho = ls.filter(l => l.kind === 'handoff');
    assert.deepEqual(ho.map(h => h.phase), ['turn', 'done']);
    assert.equal(ho[0].ctx, 115000); assert.equal(ho[0].n, 1);
    const done = ho[1];
    assert.deepEqual([done.n, done.from_seg, done.ctx, done.forced], [1, 1, 115000, false]);
    assert.equal(done.carried.threads, 1, 'one open thread in the model\'s hand-off');
    assert.equal(ls.filter(l => l.kind === 'stop').at(-1).why, 'handoff', 'the old process ended by stdin (exit 0)');
    assert.equal(ls.filter(l => l.kind === 'stop').at(-1).code, 0);
    assert.deepEqual([s2.why, s2.handoff], ['handoff', 1]);
    assert.notEqual(s2.session_id, sid1, 'a fresh vendor session');
    assert.ok(!ls.some(l => l.kind === 'text' && /## Open threads/.test(l.text)), 'the hand-off text goes to the file, not the thread');
    const file = path.join(p.state, 'chat', 'handoff-1.md');
    assert.equal(path.resolve(done.file), path.resolve(file));
    const md = fs.readFileSync(file, 'utf8');
    assert.match(md, /## Open threads\n- fix the water/);
    assert.match(md, /## The last turns, verbatim/);
    assert.match(md, /thread: fix the water/); assert.match(md, /promise: shots by noon/);
    assert.equal(chat.status().running, false, 'lazy: the new segment starts on the next message');
    // the next owner message: a new process, --session-id (not resume), its first message = the carry-over + the owner's words
    await say(chat, 'what now?');
    const st = lines(p).filter(l => l.kind === 'start').at(-1);
    assert.equal(st.resume, false); assert.equal(st.seg, 2);
    const first = sent(p, s2.session_id)[0];
    assert.match(first, /^NORN CARRY-OVER/);
    assert.match(first, /## Open threads\n- fix the water/);
    assert.match(first, /thread: fix the water/, 'the last turns verbatim');
    assert.match(first, /The owner's message:\nwhat now\?$/);
    assert.equal(lines(p).filter(l => l.kind === 'owner').at(-1).text, 'what now?', 'the owner line stays the owner\'s words');
    await say(chat, 'and then?');
    assert.equal(sent(p, s2.session_id).length, 2, 'carried once: the second message goes as itself');
    assert.equal(sent(p, s2.session_id)[1], 'and then?');
  } finally { await chat.close(); }
});

test('C5 150k: past hard_max_k the hand-off is forced - no model turn, Norn writes the file from the thread and the records', async () => {
  const p = proj(), chat = mkChat(p, cfgOf());
  try {
    await say(chat, 'thread: fix the water');
    const seg2 = next(chat, l => l.kind === 'segment' && l.n === 2);
    await say(chat, '!ctx 155000');
    await seg2;
    const sid1 = segs(p)[0].session_id;
    assert.ok(!sent(p, sid1).some(m => m.startsWith('NORN HAND-OFF')), 'no hand-off turn at the hard max');
    const done = lines(p).find(l => l.kind === 'handoff' && l.phase === 'done');
    assert.deepEqual([done.forced, done.ctx], [true, 155000]);
    const md = fs.readFileSync(done.file, 'utf8');
    assert.match(md, /FORCED/); assert.match(md, /thread: fix the water/);
  } finally { await chat.close(); }
});

test('C5 a hand-off turn that fails (the process dies) falls back to the forced hand-off; the thread goes on', async () => {
  const p = proj(), chat = mkChat(p, cfgOf());
  try {
    await say(chat, '!no-handoff');   // the fake exits 3 on the hand-off turn
    const seg2 = next(chat, l => l.kind === 'segment' && l.n === 2);
    await say(chat, '!ctx 120000');
    await seg2;
    const done = lines(p).find(l => l.kind === 'handoff' && l.phase === 'done');
    assert.equal(done.forced, true);
    await say(chat, 'still there?');
    assert.match(lines(p).filter(l => l.kind === 'text').at(-1).text, /still there\?/);
  } finally { await chat.close(); }
});

test('C5 the thresholds are read live from the config (policy.context.controller): a lower handoff_k hands off earlier', async () => {
  const p = proj(), cfg = cfgOf(), chat = mkChat(p, cfg);
  try {
    await say(chat, 'one');
    cfg.context = { no_new_step_k: 1, handoff_k: 2, hard_max_k: 150 };
    const seg2 = next(chat, l => l.kind === 'segment' && l.n === 2);
    await say(chat, 'two');   // fake ctx 2000 + 10
    await seg2;
    assert.equal(lines(p).find(l => l.kind === 'handoff' && l.phase === 'done').forced, false);
  } finally { await chat.close(); }
});

// ---------- holds and open threads survive a hand-off ----------
test('C5 holds, waiting cards and open threads survive: listed in the file and in the new segment\'s first message; the hold record stays live', async () => {
  const p = proj();
  record(p.state, { kind: 'lane', ev: 'create', by: 'controller', data: { name: 'water' } }, { views: false });
  const until = new Date(Date.now() + 30 * MIN).toISOString().replace(/\.\d{3}Z$/, 'Z');
  record(p.state, { kind: 'lane', ev: 'claim', id: 'L:water', by: 'controller', data: { until, holder: 'chat', why: 'the chat works on it', via: 'chat:chat' } }, { views: false });
  const waiting = requestApproval(p.state, { title: 'Pause p', ms: 60000, pollMs: 20 });   // a tier-2 card waiting for the tap
  const chat = mkChat(p, cfgOf());
  try {
    await say(chat, 'thread: fix the water');
    await say(chat, 'thread: review RUN-7');
    const seg2 = next(chat, l => l.kind === 'segment' && l.n === 2);
    await say(chat, '!ctx 112000');
    await seg2;
    const done = lines(p).find(l => l.kind === 'handoff' && l.phase === 'done');
    assert.deepEqual(done.carried, { threads: 2, holds: 1, cards: 1 });
    const md = fs.readFileSync(done.file, 'utf8');
    assert.match(md, /## Lanes held by this chat\n- L:water held by the controller chat until \d\d:\d\dZ: the chat works on it/);
    assert.match(md, /## Cards waiting for the owner's tap\n- AP-[0-9a-f]{8}: Pause p/);
    assert.match(md, /- fix the water\n- review RUN-7/);
    assert.equal(holdOf(loadState(p.state).items['L:water']).holder, 'chat', 'the hold is a record: it outlives the session');
    await say(chat, 'go on');
    const first = sent(p, done.n && lines(p).filter(l => l.kind === 'segment')[1].session_id)[0];
    assert.match(first, /L:water held by the controller chat/); assert.match(first, /AP-[0-9a-f]{8}: Pause p/); assert.match(first, /- review RUN-7/);
  } finally {
    await chat.close();
    for (const f of fs.readdirSync(path.join(p.state, 'chat', 'approvals'))) if (!f.includes('verdict')) fs.writeFileSync(path.join(p.state, 'chat', 'approvals', f.replace('.json', '.verdict.json')), '{"verdict":"deny"}');
    await waiting;
  }
});

test('C5 messages sent while the hand-off runs wait in Norn and reach the NEW segment (never the old, full session)', async () => {
  const p = proj(), chat = mkChat(p, cfgOf());
  try {
    await say(chat, 'thread: one');
    const handing = next(chat, l => l.kind === 'handoff' && l.phase === 'turn');
    const after = next(chat, l => l.kind === 'turn' && l.seg === 2);
    chat.send('!ctx 115000');
    await handing;
    const r = chat.send('queued words');
    assert.equal(r.queued, true);
    await after;
    const ss = segs(p);
    assert.ok(!sent(p, ss[0].session_id).includes('queued words'));
    const first = sent(p, ss[1].session_id)[0];
    assert.match(first, /^NORN CARRY-OVER/); assert.match(first, /The owner's message:\nqueued words$/);
    assert.equal(lines(p).filter(l => l.kind === 'owner').at(-1).text, 'queued words');
  } finally { await chat.close(); }
});

// ---------- settings obeyed live ----------
test('C5 settings live: a model / effort change restarts the idle process on the next message (same session, resumed); idle minutes apply at once', async () => {
  const p = proj(), cfg = cfgOf({ model: 'm1' }), chat = mkChat(p, cfg);
  try {
    await say(chat, 'a');
    assert.equal(lines(p).find(l => l.kind === 'session').model, 'm1');
    cfg.model = 'm2';
    await say(chat, 'b');
    const ls = lines(p);
    assert.equal(ls.filter(l => l.kind === 'stop').at(-1).why, 'settings');
    assert.deepEqual(ls.filter(l => l.kind === 'start').map(l => l.resume), [false, true]);
    assert.equal(ls.filter(l => l.kind === 'session').at(-1).model, 'm2');
    assert.equal(segs(p).length, 1, 'a model change is no new segment: the session resumes');
    assert.equal(ls.filter(l => l.kind === 'text').at(-1).text, 'heard b (turn 2; first: a)');
    assert.equal(chat.status().model, 'm2');
    cfg.idleMs = 120;
    const st = next(chat, l => l.kind === 'stop');
    await say(chat, 'c');
    assert.equal((await st).why, 'idle', 'the new idle minutes apply to the running process');
  } finally { await chat.close(); }
});

test('C5 raw shell: off = the shell / edit tools refused by flag and by the prompt; ask = a card; on = allowed (the golden off line is unchanged)', () => {
  const c = adapterFor('claude'), O = { exe: '/x/claude', model: 'm', effort: 'high', session_id: '11111111-2222-4333-8444-555555555555', cwd: '/s', mcp: { name: 'norn', command: 'n', args: [] } };
  const nope = o => o.args[o.args.indexOf('--disallowedTools') + 1] ?? '';
  assert.match(nope(c.chatCommand(O)), /Bash/); assert.match(nope(c.chatCommand({ ...O, rawShell: 'off' })), /Bash/);
  for (const m of ['ask', 'on']) assert.doesNotMatch(nope(c.chatCommand({ ...O, rawShell: m })), /Bash|Edit|Write|PowerShell/, m);
  assert.deepEqual(promptTier('Bash'), { tier: 3, decide: 'deny' });
  assert.deepEqual(promptTier('Bash', 'off'), { tier: 3, decide: 'deny' });
  assert.deepEqual(promptTier('Edit', 'ask'), { tier: 2, decide: 'ask' });
  assert.deepEqual(promptTier('Bash', 'on'), { tier: 1, decide: 'allow' });
  assert.deepEqual(promptTier('Read', 'off'), { tier: 0, decide: 'allow' });
});

const budgetRoot = b => { const r = mkTmp('meta-c5-root-', 'r'); fs.mkdirSync(path.join(r, 'local'), { recursive: true }); fs.writeFileSync(path.join(r, 'local', 'budget.json'), JSON.stringify(b)); return r; };
let rid = 0;
const call = async (ctx, name, a = {}) => (await handle({ jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: a } }, ctx)).result;
const txt = r => r.content.map(c => c.text).join('\n');

test('C5 settings live in the MCP server: hold length and raw shell are read from the machine budget on every call', async () => {
  const s = mkTmp('meta-c5-', 'p'), root = budgetRoot({ chat_hold_min: 45, chat_raw_shell: 'on' });
  record(s, { kind: 'lane', ev: 'create', by: 'controller', data: { name: 'water' } }, { views: false });
  const ctx = context({ state: s, project: null, profile: 'chat', client: 'chat', env: { META_ROOT: root }, cli: (argv, env, out, err) => main(argv, env, out, err), approvalMs: 60000, pollMs: 10, notifyFn: () => {} });
  const r = await call(ctx, 'norn_decision_add', { lane: 'water', question: 'q', choice: 'c', why: 'w' });
  assert.ok(!r.isError, txt(r));
  const h = holdOf(loadState(s).items['L:water']);
  assert.ok(Math.abs(Date.parse(h.until) - Date.now() - 45 * MIN) < 5000, `hold length 45 min (got ${h.until})`);
  let a = JSON.parse(txt(await call(ctx, 'norn_approve', { tool_name: 'Bash', input: { command: 'ls' } })));
  assert.equal(a.behavior, 'allow', 'raw shell on');
  fs.writeFileSync(path.join(root, 'local', 'budget.json'), JSON.stringify({ chat_raw_shell: 'off' }));
  a = JSON.parse(txt(await call(ctx, 'norn_approve', { tool_name: 'Bash', input: { command: 'ls' } })));
  assert.equal(a.behavior, 'deny', 'switched off live: no restart of the server');
  assert.equal(HOLD_MIN, 30, 'the default stays 30 min');
});

test('C5 Settings rows: harness, model, effort, idle minutes, hold length, raw shell - in the chat section, validated, defaults as before', () => {
  const rows = settingsFor(), by = Object.fromEntries(rows.map(r => [r.key, r]));
  for (const k of ['chat_executor', 'chat_model', 'chat_effort', 'chat_idle_min', 'chat_hold_min', 'chat_raw_shell']) {
    assert.ok(by[k], k); assert.deepEqual(sectionOf(by[k]).slice(0, 1), ['chat'], k);
  }
  const d = withDefaults({});
  assert.deepEqual([d.chat_idle_min, d.chat_hold_min, d.chat_raw_shell], [15, 30, 'off']);
  assert.ok(['', undefined].includes(d.chat_model), 'blank model = the check-in model (unchanged behaviour)');
  assert.deepEqual(by.chat_raw_shell.options, ['off', 'ask', 'on']);
  assert.throws(() => applySettings({}, { chat_idle_min: 0 }), /chat_idle_min/);
  assert.throws(() => applySettings({}, { chat_raw_shell: 'yes' }), /chat_raw_shell/);
  assert.equal(applySettings({}, { chat_model: 'claude-sonnet-5-5' }).chat_model, 'claude-sonnet-5-5');
  assert.deepEqual(POLICY_DEFAULTS.context.controller, CTX);
});

test('C5 settings live through the dashboard: a Settings save changes the next chat start (model, effort) without a dashboard restart', async () => {
  const calls = [], f = await fixture({ dash: { chatSpawnFn: toFake(calls), chatIdleMs: 60000 } });
  try {
    let r = await f.post('/api/chat/send', { project: 'kestrel', text: 'hi' });
    assert.equal(r.status, 200);
    const arg = (c, k) => c.args[c.args.indexOf(k) + 1];
    assert.equal(arg(calls[0], '--model'), 'claude-opus-5-5');
    await waitFor(() => readThread(f.pa.state).items.some(l => l.kind === 'turn'));
    const v = (await f.get('/api/settings?project=kestrel')).data.version;
    r = await f.post('/api/settings', { project: 'kestrel', version: v, changes: { chat_model: 'claude-sonnet-5-5', chat_effort: 'low', chat_raw_shell: 'ask' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    r = await f.post('/api/chat/send', { project: 'kestrel', text: 'again' });
    assert.equal(r.status, 200);
    await waitFor(() => calls.length === 2);
    assert.deepEqual([arg(calls[1], '--model'), arg(calls[1], '--effort')], ['claude-sonnet-5-5', 'low']);
    assert.ok(calls[1].args.includes('--resume'), 'the same session, resumed');
    assert.doesNotMatch(arg(calls[1], '--disallowedTools'), /Bash/, 'raw shell ask: the shell goes to the card');
    const home = (await f.get('/api/home?project=kestrel')).data;
    assert.equal(home.status.model, 'claude-sonnet-5-5'); assert.equal(home.status.raw_shell, 'ask');
  } finally { await f.done(); }
});

// ---------- the cost line ----------
test('C5 cost: per-turn tokens (never the repeated per-message usage), per-process cumulative cost as deltas, ~ weekly % from the calibration', () => {
  const day = '2026-11-13';
  const u = (r, w = 0) => ({ input: 10, cache_read: r, cache_write: w, output: 5 });
  const L = [
    { ts: '2026-11-12T23:00:00Z', kind: 'start' }, { ts: '2026-11-12T23:01:00Z', kind: 'turn', cost_usd: 0.5, usage: u(1e6) },   // yesterday
    { ts: `${day}T08:00:00Z`, kind: 'start' },
    { ts: `${day}T08:00:01Z`, kind: 'usage', ctx: 50000 }, { ts: `${day}T08:00:01Z`, kind: 'usage', ctx: 50000 },   // one call, two lines
    { ts: `${day}T08:00:02Z`, kind: 'turn', cost_usd: 0.01, usage: u(40000, 10000) },
    { ts: `${day}T08:05:00Z`, kind: 'turn', cost_usd: 0.03, usage: u(60000) },   // cumulative: this turn cost 0.02
    { ts: `${day}T09:00:00Z`, kind: 'stop', why: 'idle' }, { ts: `${day}T10:00:00Z`, kind: 'start' },
    { ts: `${day}T10:00:02Z`, kind: 'turn', cost_usd: 0.02, usage: u(20000) }];   // a new process: its own total
  const c = chatCost(L, { day, perPct: 1e6 });
  assert.equal(c.turns, 3);
  assert.equal(c.tokens, (10 + 40000 + 10000 + 5) + (10 + 60000 + 5) + (10 + 20000 + 5));
  assert.equal(Math.round(c.usd * 1000) / 1000, 0.05);
  assert.equal(c.weekly_pct, (40000 + 60000 + 20000) / 1e6);
  assert.equal(c.estimate, true);
  assert.equal(chatCost(L, { day }).weekly_pct, null, 'no calibration: no %');
  const html = renderHome({ project: 'p', status: { cost: { ...c, weekly_pct: 0.12 } }, events: [] }, { now: Date.parse(`${day}T12:00:00Z`) });
  assert.match(html, /chat today[^<]*130\.0k tokens[^<]*~0\.12 % of the week[^<]*3 turns/);
  const none = renderHome({ project: 'p', status: { cost: { turns: 0, tokens: 0, usd: 0, weekly_pct: null } }, events: [] }, {});
  assert.match(none, /chat today: no turns/);
});

test('C5 the fake chat reports per-turn usage on the turn line and a per-process cumulative cost (as claude does)', async () => {
  const p = proj(), chat = mkChat(p, cfgOf());
  try {
    await say(chat, 'one'); await say(chat, 'two');
    const turns = lines(p).filter(l => l.kind === 'turn');
    assert.deepEqual(turns.map(t => t.cost_usd), [0.001, 0.002]);
    assert.deepEqual(turns[1].usage, { input: 10, cache_read: 2000, cache_write: 0, output: 5 });
    assert.equal(lines(p).filter(l => l.kind === 'usage').length, 4, 'two lines per model call (thinking + text), one usage each');
    const c = chatCost(lines(p), { day: new Date().toISOString().slice(0, 10) });
    assert.equal(c.turns, 2); assert.equal(Math.round(c.usd * 1000) / 1000, 0.002);
    assert.equal(c.tokens, (10 + 1000 + 5) + (10 + 2000 + 5));
  } finally { await chat.close(); }
});

// ---------- the divider ----------
test('C5 the divider: one thin line per hand-off - carried threads / holds, context before -> after, a link to the file', () => {
  const T = '2026-11-13T10:00:';
  const thread = [
    { ts: T + '00Z', seg: 1, kind: 'segment', n: 1, why: 'first' }, { ts: T + '01Z', seg: 1, kind: 'owner', text: 'hi' },
    { ts: T + '02Z', seg: 1, kind: 'handoff', phase: 'turn', n: 1, ctx: 108000 },
    { ts: T + '03Z', seg: 1, kind: 'stop', why: 'handoff', code: 0 },
    { ts: T + '04Z', seg: 1, kind: 'handoff', phase: 'done', n: 1, from_seg: 1, ctx: 108000, forced: false, file: '/s/chat/handoff-1.md', carried: { threads: 6, holds: 1, cards: 0 } },
    { ts: T + '05Z', seg: 2, kind: 'segment', n: 2, why: 'handoff', handoff: 1 },
    { ts: T + '06Z', seg: 2, kind: 'owner', text: 'go' }, { ts: T + '07Z', seg: 2, kind: 'usage', ctx: 9000 }];
  const evs = homeEvents({ thread });
  const d = evs.filter(e => e.kind === 'handoff');
  assert.equal(d.length, 1, 'one divider; the hand-off turn line and the stop / segment lines of a hand-off are not extra items');
  assert.deepEqual([d[0].threads, d[0].holds, d[0].ctx_from, d[0].ctx_to, d[0].forced], [6, 1, 108000, 9000, false]);
  assert.ok(!evs.some(e => e.kind === 'segment' && e.n === 2), 'the divider replaces the segment line');
  assert.ok(!evs.some(e => e.kind === 'stop' && e.why === 'handoff'));
  const html = renderThread(evs, { project: 'p' });
  assert.match(html, /class="ev ev-handoff ev-line"/);
  assert.match(html, /new session · carried over 6 open threads, 1 hold · context 108k → 9k/);
  assert.match(html, /href="\/api\/file\?project=p&amp;path=%2Fs%2Fchat%2Fhandoff-1\.md"/);
  const forced = homeEvents({ thread: thread.slice(0, 5).map(l => (l.phase === 'done' ? { ...l, forced: true, carried: { threads: 0, holds: 0, cards: 2 } } : l)) });
  assert.match(renderThread(forced, { project: 'p' }), /new session \(forced at 108k\) · carried over 0 open threads, 2 cards waiting · context 108k → …/);
});

// ---------- helpers for the dashboard test ----------
function toFake(calls) {
  return (exe, args, opt) => { calls.push({ exe, args }); return spawnFake(args, opt); };
}
import { spawn } from 'node:child_process';
import { FAKE_CHAT } from '../engine/lib/harness/fake.mjs';
function spawnFake(args, opt) {
  const sid = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1], model = args[args.indexOf('--model') + 1];
  return spawn(process.execPath, [FAKE_CHAT, args.includes('--resume') ? '--resume' : '--session-id', sid, '--model', model], { ...opt, env: process.env });
}
async function waitFor(fn, ms = 10000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 25)); }
}
