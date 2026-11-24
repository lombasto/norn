// META-CONTROLLER C3 (SPEC sec. 3 + 8 C3 row): the chat ACTS - the MCP `chat` profile (controller tools + norn_show, norn_cli,
// norn_approve), the tiers (0 read / 1 act / 2 your tap / 3 off), approval cards with a timeout (deny + notify), the verbatim guard,
// Undo where the verb has one, and the C2 finding (send() left an orphan owner line when start threw). No real claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handle, context, TOOLS, refusal } from '../engine/lib/mcp.mjs';
import { tierOf, promptTier, cliPlan, drain, approvalsDir, readVerdict, threadFile } from '../engine/lib/chatact.mjs';
import { createChat, readThread } from '../engine/lib/chat.mjs';
import { homeEvents, renderThread } from '../engine/dash/home.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { adapterFor } from '../engine/lib/harness/index.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const own = (state, ...texts) => {
  fs.mkdirSync(path.dirname(threadFile(state)), { recursive: true });
  for (const text of texts) fs.appendFileSync(threadFile(state), JSON.stringify({ ts: new Date().toISOString(), seg: 1, kind: 'owner', text }) + '\n');
};
const ctxOf = (state, o = {}) => context({ state, project: o.project ?? null, profile: 'chat', client: 'chat', env: {}, cli: o.cli ?? (() => 0),
  approvalMs: o.ms ?? 60000, pollMs: 10, notifyFn: o.notifyFn ?? (() => {}) });
let n = 0;
const call = async (ctx, name, a = {}) => (await handle({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: a } }, ctx)).result;
const txt = r => r.content.map(c => c.text).join('\n');
const names = (profile) => handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { profile }).result.tools.map(t => t.name);
const until = async (pred, ms = 5000) => { const t = Date.now(); for (;;) { const v = pred(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)); } };
const fakeCli = calls => (argv, env, out) => { calls.push({ argv, role: env.META_ROLE }); if (argv[0] === 'run') out('QUEUED RUN-7 lane x fake m e position 1 (cap)'); return 0; };

test('C3 role and tier table: profile chat = controller tools + norn_show, norn_cli, norn_approve; the tiers of SPEC sec. 3', async () => {
  const ctl = names('controller'), chat = names('chat');
  // lane-collide S2a: the chat applies a collide remedy through norn_cli (its tier is the case's cell), not norn_collide
  assert.deepEqual([...chat].sort(), [...ctl.filter(n => n !== 'norn_collide'), 'norn_show', 'norn_cli', 'norn_approve'].sort());
  assert.ok(ctl.length <= 16 && !ctl.includes('norn_cli'), 'the controller profile stays as it is');
  assert.match(refusal('chat', { META_RUN_ID: 'RUN-1' }), /refused/); assert.match(refusal('chat', { META_ROLE: 'checkin' }), /refused/); assert.equal(refusal('chat', {}), null);
  const cli = args => ['norn_cli', { args }];
  const TABLE = [
    [0, 'norn_boot', { role: 'controller' }], [0, 'norn_status', {}], [0, 'norn_inbox', {}], [0, 'norn_records', {}], [0, 'norn_run_show', { run: 'RUN-1' }],
    [0, 'norn_status', { view: 'ledger' }], [0, 'norn_show', { path: '/x.png' }], [0, 'norn_settings', { get: ['a'] }], [0, 'norn_settings', { set: { key: 'a', value: 1 }, dry_run: true }],
    [0, ...cli(['rec', 'list'])], [0, ...cli(['mergeq', '--json'])], [0, ...cli(['deliverables', '--due'])],
    [1, 'norn_run', { lane: 'x', brief: 'b' }], [1, 'norn_stop', { run: 'RUN-1', why: 'w' }], [1, 'norn_decision_add', {}], [1, 'norn_question_add', {}],
    [1, 'norn_record_event', {}], [1, 'norn_answer', {}], [1, 'norn_directive', {}], [1, 'norn_tick', {}], [1, 'norn_run_show', { run: 'RUN-1', ask: 'why?' }],
    [1, ...cli(['run', '--queue', '--lane', 'x'])], [1, ...cli(['requeue', 'RUN-1', '--after', 'none', '--why', 'w'])], [1, ...cli(['mail', 'send', '--to', 'role:checkin'])],
    [1, ...cli(['notify', '--title', 't'])], [1, ...cli(['lane', 'new', 'x'])], [1, ...cli(['rec', 'add', 'decision'])], [1, ...cli(['mergeq', '--update'])],
    [1, ...cli(['deliverables', 'resolve', 'DLV-1'])],
    [2, 'norn_pause', { mode: 'all' }], [0, 'norn_pause', { half: true }], [2, 'norn_settings', { set: { key: 'a', value: 1 } }], [2, ...cli(['mergeq', '--run'])], [2, ...cli(['mergeq', '--batching', 'off', '--why', 'w'])],
    [3, 'meta_shell', {}],
  ];
  for (const [tier, tool, a] of TABLE) assert.equal(tierOf(tool, a), tier, `${tool} ${JSON.stringify(a)}`);
  assert.deepEqual([promptTier('Bash'), promptTier('Write'), promptTier('Read'), promptTier('mcp__norn__norn_run'), promptTier('WebFetch')].map(x => [x.tier, x.decide]),
    [[3, 'deny'], [3, 'deny'], [0, 'allow'], [1, 'allow'], [2, 'ask']]);
  // tier 1 runs unattended, stamped via chat
  const s = mkTmp('meta-c3-'), r = await call(ctxOf(s), 'norn_decision_add', { lane: 'x', question: 'q', choice: 'c', why: 'w' });
  assert.ok(!r.isError, txt(r));
  const dec = Object.values(loadState(s).items).find(i => i.kind === 'decision');
  assert.deepEqual([dec.history[0].by, dec.data.via], ['controller', 'chat:chat']);
  assert.ok(!fs.existsSync(approvalsDir(s)), 'no card for a tier-1 act');
});

test('C3 the verbatim guard: a paraphrased directive is refused; the owner\'s own words are recorded (directive, lane --task) with Undo = revoke', async () => {
  const s = mkTmp('meta-c3-'), calls = [], ctx = ctxOf(s, { cli: fakeCli(calls) });
  own(s, 'Hi. From now on, no merges to main on Fridays.');
  fs.appendFileSync(threadFile(s), JSON.stringify({ kind: 'text', text: 'always merge on Fridays' }) + '\n');
  const para = await call(ctx, 'norn_directive', { text: 'Do not merge to main on Fridays' });
  assert.ok(para.isError); assert.match(txt(para), /verbatim|own words/);
  assert.ok((await call(ctx, 'norn_directive', { text: 'always merge on Fridays' })).isError, 'the controller\'s own words are not the owner\'s');
  assert.ok((await call(ctx, 'norn_cli', { args: ['lane', 'new', 'water', '--task', 'make the water nicer'] })).isError);
  assert.equal(calls.length, 0, 'nothing ran');
  assert.equal(Object.values(loadState(s).items).filter(i => i.kind === 'directive').length, 0);
  const ok = await call(ctx, 'norn_directive', { text: 'no merges to main on fridays' });
  assert.ok(!ok.isError, txt(ok));
  const dir = Object.values(loadState(s).items).find(i => i.kind === 'directive');
  assert.deepEqual([dir.history[0].by, dir.data.via, dir.data.text], ['owner', 'chat:chat', 'no merges to main on fridays']);
  const done = drain(s).find(e => e.kind === 'done');
  assert.deepEqual(done.undo, { verb: 'revoke', id: dir.id });
});

test('C3 an owner answer given in the chat closes its question in the same call (norn_answer = norn rec answer, verbatim)', async () => {
  const s = mkTmp('meta-c3-'), ctx = ctxOf(s);
  const q = record(s, { kind: 'question', ev: 'create', by: 'controller', data: { title: 'which relief?', lane: 'gen', options: [{ key: 'a', text: 'wait' }, { key: 'b', text: 'go' }] } }).id;
  own(s, `${q}: b - go, it's cheap`);
  assert.ok((await call(ctx, 'norn_answer', { q, text: 'go with b', choice: 'b' })).isError, 'a paraphrase is refused');
  assert.equal(loadState(s).items[q].state, 'open');
  const r = await call(ctx, 'norn_answer', { q, text: "b - go, it's cheap", choice: 'b' });
  assert.ok(!r.isError, txt(r));
  const it = loadState(s).items[q], ans = it.history.at(-1);
  assert.deepEqual([it.state, ans.ev, ans.by, ans.data.via, ans.data.choice], ['answered', 'answer', 'owner', 'chat:chat', 'b']);
});

test('C3 norn_cli: a non-listed subcommand is refused (nothing runs); a listed one runs with role + project injected, never a shell', async () => {
  const s = mkTmp('meta-c3-'), calls = [], ctx = ctxOf(s, { cli: fakeCli(calls) });
  for (const args of [['setup'], ['stop', 'RUN-1'], ['run', '--lane', 'x', '--brief', 'b'], ['rec', 'answer', 'Q-1', '--text', 'x'], ['rec', 'add', 'directive', '--text', 'x'],
    ['rec', 'reopen', 'Q-1'], ['mail', 'check'], ['mail', 'send', '--as', 'owner', '--to', 'role:checkin'], ['rec', 'list', '--state', '/elsewhere'], ['lane', 'new', 'x', '--project=/p'],
    ['deliverables', 'wipe'], 'rec list', []]) {
    const r = await call(ctx, 'norn_cli', { args });
    assert.ok(r.isError, JSON.stringify(args)); assert.match(txt(r), /not on the chat's list|set by Norn|use norn_|argument list|schema|must be/, JSON.stringify(args));
  }
  assert.equal(calls.length, 0);
  assert.throws(() => cliPlan(['bash', '-c', 'rm -rf /']), /not on the chat's list/);
  const r = await call(ctx, 'norn_cli', { args: ['mail', 'send', '--to', 'role:checkin', '--subject', 's', '--body', 'b'] });
  assert.ok(!r.isError, txt(r));
  assert.deepEqual(calls[0], { argv: ['mail', 'send', '--to', 'role:checkin', '--subject', 's', '--body', 'b', '--state', s], role: 'controller' });
  own(s, 'new lane water: make the water nicer');
  await call(ctx, 'norn_cli', { args: ['lane', 'new', 'water', '--task', 'make the water nicer'] });
  assert.deepEqual(calls[1].argv, ['lane', 'new', 'water', '--task', 'make the water nicer', '--as', 'controller', '--state', s]);
  const q = await call(ctx, 'norn_cli', { args: ['run', '--queue', '--executor', 'fake', '--lane', 'x', '--brief', 'b'] });
  assert.ok(calls[2].argv.includes('--via') && calls[2].argv[calls[2].argv.indexOf('--via') + 1] === 'chat:chat');
  assert.match(txt(q), /QUEUED RUN-7/);
  assert.deepEqual(drain(s).find(e => e.kind === 'done' && e.undo?.verb === 'stop').undo, { verb: 'stop', run: 'RUN-7' }, 'a queued run: Undo = stop (withdraw)');
});

test('C3 approval card round trip on a fixture thread: tier 2 waits for the tap; Approve once runs it, Deny refuses it; the thread shows card + verdict', async () => {
  const s = mkTmp('meta-c3-', 'p'), ctx = ctxOf(s), chat = createChat({ project: { name: 'p', state: s }, executor: 'fake', model: 'm', effort: 'e' });
  own(s, 'pause the project please');
  const p1 = call(ctx, 'norn_pause', { mode: 'all' });
  const card = await until(() => { chat.drain(); return readThread(s).items.find(l => l.kind === 'approval'); });
  assert.equal(fs.existsSync(path.join(s, 'PAUSED')), false, 'nothing happens before the tap');
  assert.match(card.title, /pause/i); assert.equal(card.timeout_min, 1);
  let ev = homeEvents({ thread: readThread(s).items }).find(e => e.kind === 'approval');
  assert.deepEqual([ev.id, ev.state, ev.cat], [card.id, 'pending', 'needs']);
  const html = renderThread([ev], { project: 'p' });
  assert.match(html, new RegExp(`data-act="approve" data-id="${card.id}" data-verdict="approve"`)); assert.match(html, /data-verdict="deny"/); assert.doesNotMatch(html, /disabled/);
  chat.decide(card.id, 'approve');
  const r1 = await p1;
  assert.ok(!r1.isError, txt(r1)); assert.equal(fs.existsSync(path.join(s, 'PAUSED')), true);
  assert.throws(() => chat.decide(card.id, 'deny'), e => e.status === 409);
  chat.drain();
  ev = homeEvents({ thread: readThread(s).items }).find(e => e.kind === 'approval');
  assert.deepEqual([ev.state, ev.cat], ['approved', 'chat']); assert.doesNotMatch(renderThread([ev], { project: 'p' }), /data-act="approve"/);
  // Deny: refused, nothing written
  const p2 = call(ctx, 'norn_pause', { resume: 'all' });
  const c2 = await until(() => { chat.drain(); return readThread(s).items.filter(l => l.kind === 'approval')[1]; });
  chat.decide(c2.id, 'deny');
  const r2 = await p2;
  assert.ok(r2.isError); assert.match(txt(r2), /denied by the owner/); assert.equal(fs.existsSync(path.join(s, 'PAUSED')), true);
  assert.equal(homeEvents({ thread: readThread(s).items }).filter(e => e.kind === 'approval')[1].state, 'denied');
});

test('C3 timeout = deny + notify: no tap in time denies, pings the owner once, and a late tap is refused', async () => {
  const s = mkTmp('meta-c3-'), pings = [], ctx = ctxOf(s, { ms: 80, notifyFn: x => pings.push(x) });
  const r = await call(ctx, 'norn_pause', { mode: 'all' });
  assert.ok(r.isError); assert.match(txt(r), /no tap|timeout/i);
  assert.equal(fs.existsSync(path.join(s, 'PAUSED')), false);
  assert.equal(pings.length, 1); assert.match(pings[0].title, /denied/);
  const evs = drain(s), id = evs.find(e => e.kind === 'approval').id;
  assert.deepEqual(evs.filter(e => e.kind === 'verdict').map(e => [e.id, e.verdict, e.why]), [[id, 'deny', 'timeout']]);
  assert.equal(readVerdict(s, id).why, 'timeout');
  const chat = createChat({ project: { name: 'p', state: s }, executor: 'fake', model: 'm', effort: 'e' });
  assert.throws(() => chat.decide(id, 'approve'), e => e.status === 409);
});

test('C3 norn_approve (--permission-prompt-tool): Norn tools and read-only files pass, raw shell is off, anything else is a card only the owner answers', async () => {
  const s = mkTmp('meta-c3-', 'p'), ctx = ctxOf(s), chat = createChat({ project: { name: 'p', state: s }, executor: 'fake', model: 'm', effort: 'e' });
  const decision = r => JSON.parse(txt(r));
  const first = await call(ctx, 'norn_approve', { tool_name: 'mcp__norn__norn_status', input: { view: 'plan' } });
  // live (claude 2.1.314): "Permission prompt tool returned an invalid result. Expected a single text block param" - content only
  assert.deepEqual(Object.keys(first), ['content']); assert.deepEqual(first.content.map(c => c.type), ['text']);
  assert.deepEqual(decision(first), { behavior: 'allow', updatedInput: { view: 'plan' } });
  assert.deepEqual(decision(await call(ctx, 'norn_approve', { tool_name: 'Read', input: { file_path: '/a' } })).behavior, 'allow');
  const sh = decision(await call(ctx, 'norn_approve', { tool_name: 'Bash', input: { command: 'rm -rf /' } }));
  assert.equal(sh.behavior, 'deny'); assert.match(sh.message, /off/);
  const p = call(ctx, 'norn_approve', { tool_name: 'WebFetch', input: { url: 'https://x.test', verdict: 'approve' }, tool_use_id: 'toolu_1' });
  const card = await until(() => { chat.drain(); return readThread(s).items.find(l => l.kind === 'approval'); });
  assert.match(card.title, /WebFetch/);
  chat.decide(card.id, 'approve');
  assert.deepEqual(decision(await p), { behavior: 'allow', updatedInput: { url: 'https://x.test', verdict: 'approve' } });
});

test('C3 send(): a start that throws leaves no orphan owner line (C2 finding)', () => {
  const s = mkTmp('meta-c3-', 'p');
  const chat = createChat({ project: { name: 'p', state: s }, executor: 'fake', model: 'm', effort: 'e', spawnFn: () => { throw new Error('spawn EPERM'); } });
  assert.throws(() => chat.send('hello'), /EPERM/);
  assert.equal(readThread(s).items.filter(l => l.kind === 'owner').length, 0);
});

test('C3 golden: the claude chat command names norn_approve as its permission prompt tool and the MCP profile is chat', () => {
  const c = adapterFor('claude'), cmd = c.chatCommand({ exe: 'claude', model: 'm', effort: 'e', session_id: 's', mcp: { name: 'norn', command: 'node', args: ['meta', 'mcp', '--profile', 'chat'] }, cwd: '/c' });
  assert.equal(cmd.args[cmd.args.indexOf('--permission-prompt-tool') + 1], 'mcp__norn__norn_approve');
  assert.ok(Number(cmd.env.MCP_TOOL_TIMEOUT) > 30 * 60000, 'a tool call may wait out the 30 min tap');
  assert.equal(c.chatCommand({ exe: 'claude', model: 'm', effort: 'e', session_id: 's', cwd: '/c' }).args.includes('--permission-prompt-tool'), false, 'no MCP, no prompt tool');
});

test('C3 endpoints: POST /api/chat/approve and /api/chat/undo - token-guarded buttons, no model in between; a second tap / undo is 409', async () => {
  const f = await fixture();
  try {
    const s = f.pa.state, P = f.pa.name, ctx = ctxOf(s);
    own(s, 'keep the night quiet');
    const pending = call(ctx, 'norn_pause', { mode: 'all' });
    const id = await until(() => fs.existsSync(approvalsDir(s)) && fs.readdirSync(approvalsDir(s)).find(x => /^AP-[0-9a-f]{8}\.json$/.test(x))?.slice(0, 11));
    assert.equal((await f.post('/api/chat/approve', { project: P, id, verdict: 'approve' }, { 'x-dash-token': 'wrong' })).status, 403);
    assert.equal((await f.post('/api/chat/approve', { project: P, id: 'AP-00000000', verdict: 'approve' })).status, 404);
    assert.equal((await f.post('/api/chat/approve', { project: P, id, verdict: 'maybe' })).status, 400);
    assert.equal((await f.post('/api/chat/approve', { project: P, id, verdict: 'approve' })).status, 200);
    assert.ok(!(await pending).isError);
    assert.equal((await f.post('/api/chat/approve', { project: P, id, verdict: 'deny' })).status, 409);
    // Undo of a saved directive = revoke, written by the button
    assert.ok(!(await call(ctx, 'norn_directive', { text: 'keep the night quiet' })).isError);
    const home = (await f.get(`/api/home?project=${P}`)).data;
    const done = home.events.find(e => e.kind === 'done' && e.undo?.verb === 'revoke');
    assert.ok(done && Number.isInteger(done.line), JSON.stringify(home.events.map(e => e.kind)));
    assert.ok(home.events.some(e => e.kind === 'approval' && e.state === 'approved'));
    assert.equal((await f.post('/api/chat/undo', { project: P, line: done.line }, { 'x-dash-token': 'wrong' })).status, 403);
    assert.equal((await f.post('/api/chat/undo', { project: P, line: 0 })).status, 400, 'not a done card');
    { const u = await f.post('/api/chat/undo', { project: P, line: done.line }); assert.equal(u.status, 200, JSON.stringify(u.data)); }
    assert.equal(loadState(s).items[done.undo.id].state, 'revoked');
    assert.equal((await f.post('/api/chat/undo', { project: P, line: done.line })).status, 409);
    const after = (await f.get(`/api/home?project=${P}`)).data.events.find(e => e.line === done.line);
    assert.equal(after.undone, true);
  } finally { await f.done(); }
});

// lane-collide S2a (SPEC 4A.4 MCP): collide in the chat's list - reading verbs tier 0; a remedy in the check-in's column, undo and ask tier 1
// (applied as the controller); a remedy in the controller's or the owner's column tier 2, applied as the owner after the tap
test('chat: norn collide by tier - the cell of the case decides; the tap is the owner’s, so the argv says --as owner', () => {
  const s = mkTmp('meta-chat-col-');
  const open = (kind, grade) => record(s, { kind: 'collision', ev: 'open', by: 'launcher', data: { key: `${kind}:a+b`, kind, grade, verdict: 'warn', door: 'run', a: { lane: 'a' }, b: { lane: 'b' }, files: [], files_n: 0, why: 'synthetic', pair: 'a+b' } }).id;
  const cov = open('territory', 'covers'), ex = open('territory', 'exclusive'), lead = open('lead', null);
  const o = { state: s }, plan = args => cliPlan(['collide', ...args, '--why', 'w'], o);
  assert.deepEqual(['plan', 'list', 'show'].map(v => cliPlan(['collide', v], o).tier), [0, 0, 0]);
  assert.deepEqual([plan(['narrow', cov]), plan(['wait', ex]), plan(['undo', ex]), plan(['ask', lead, '--want', 'part'])].map(p => [p.tier, p.argv.at(-1)]), [[1, 'controller'], [1, 'controller'], [1, 'controller'], [1, 'controller']]);
  assert.deepEqual([plan(['narrow', ex]), plan(['part', lead]), plan(['allow', 'a', 'b'])].map(p => [p.tier, p.argv.at(-1)]), [[2, 'owner'], [2, 'owner'], [2, 'owner']]);
  assert.equal(cliPlan(['collide', 'narrow', ex, '--why', 'w'], { state: s, policy: { apply_by: { exclusive: { narrow: 'checkin' } } } }).tier, 1, 'apply_by lowers the cell');
  assert.equal(tierOf('norn_cli', { args: ['collide', 'narrow', cov, '--why', 'w'] }, o), 1);
  assert.throws(() => cliPlan(['collide', 'fold', cov], o), /not on the chat's list/);
});
