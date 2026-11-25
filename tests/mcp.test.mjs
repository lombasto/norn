// H1 `norn mcp`: stdio MCP server (HARNESS-DESIGN sec. 4). Profiles pick the tools, the server stamps `via`, role refusal.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { record, loadState, readEvents, recordsFile } from '../engine/lib/records.mjs';
import { projectFile, budget0 } from './helpers/dash-fixture.mjs';
import { loadProject } from '../engine/lib/config.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const tmp = () => mkTmp('meta-mcp-');
const cleanEnv = (extra = {}) => {
  const env = { ...process.env, META_NO_TICK: '1', ...extra };
  for (const k of ['META_STATE', 'META_PROJECT', 'META_ROLE', 'META_RUN_ID', 'META_NOTES', 'META_SESSION_ID', 'META_RESUMES']) if (!(k in extra)) delete env[k];
  return env;
};

// Every server still alive after a test (an assertion threw before close()) is killed, or its open pipes keep the file from exiting.
const live = new Set();
afterEach(() => { for (const p of live) p.kill(); live.clear(); });

// One server process; call(method, params) resolves with the JSON-RPC response for that id.
// onRequest(msg) -> result | { error }: answers a request FROM the server (META-ADOPT A4: elicitation/create)
function server(args, extra = {}, { onRequest } = {}) {
  const p = spawn(process.execPath, [META, 'mcp', ...args], { env: cleanEnv(extra), stdio: ['pipe', 'pipe', 'pipe'] });
  live.add(p); p.on('exit', () => live.delete(p));
  let buf = '', id = 0, stderr = '';
  const waiting = new Map();
  p.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.method && m.id !== undefined) {
        const r = onRequest ? onRequest(m) : { error: { code: -32601, message: 'no handler' } };
        p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...(r && r.error ? { error: r.error } : { result: r }) }) + '\n');
        continue;
      }
      waiting.get(m.id)?.(m); waiting.delete(m.id);
    }
  });
  p.stderr.on('data', d => { stderr += d; });
  p.stdin.on('error', () => {});
  p.on('exit', c => { for (const [n, res] of waiting) res({ id: n, error: { code: 'exit', message: `server exited ${c}: ${stderr}` } }); waiting.clear(); });
  const call = (method, params = {}) => new Promise(res => {
    const n = ++id, t = setTimeout(() => { waiting.delete(n); res({ id: n, error: { code: 'timeout', message: stderr } }); }, 20000);
    waiting.set(n, m => { clearTimeout(t); res(m); });
    if (p.exitCode === null) p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
  const tool = async (name, a = {}) => (await call('tools/call', { name, arguments: a })).result;
  const init = (capabilities = {}) => call('initialize', { protocolVersion: '2025-11-25', capabilities, clientInfo: { name: 'test', version: '0' } })
    .then(r => { p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); return r; });
  const close = () => new Promise(res => { if (p.exitCode !== null) return res(); p.on('exit', res); p.stdin.end(); });
  return { p, call, tool, init, close, stderr: () => stderr };
}
const text = r => r.content.map(c => c.text).join('\n');

test('initialize negotiates the protocol version; ping answers; unknown method is -32601', async () => {
  const s = tmp(), m = server(['--state', s, '--profile', 'controller']);
  const a = await m.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(a.result.protocolVersion, '2025-06-18');
  assert.equal(a.result.serverInfo.name, 'norn');
  assert.ok(a.result.capabilities.tools && a.result.capabilities.prompts);
  const b = await m.call('initialize', { protocolVersion: '1999-01-01', capabilities: {} });
  assert.equal(b.result.protocolVersion, '2025-11-25');
  assert.deepEqual((await m.call('ping')).result, {});
  assert.equal((await m.call('nope/nope')).error.code, -32601);
  await m.close();
});

test('profiles decide the tools: controller <= 16 one-line tools, checkin has no owner tools, worker reads + its mail', async () => {
  const s = tmp();
  const names = async prof => { const m = server(['--state', s, '--profile', prof]); await m.init(); const r = (await m.call('tools/list')).result.tools; await m.close(); return r; };
  const ctl = await names('controller'), ck = await names('checkin'), wk = await names('worker');
  const n = t => t.map(x => x.name).sort();
  assert.ok(ctl.length <= 16, `${ctl.length} tools`);
  for (const t of ctl) { assert.equal(t.inputSchema.type, 'object'); assert.ok(!t.description.includes('\n') && t.description.length <= 160, t.name); }
  for (const x of ['norn_answer', 'norn_directive', 'norn_tick', 'norn_pause', 'norn_settings', 'norn_boot', 'norn_run']) assert.ok(n(ctl).includes(x), x);
  for (const x of ['norn_answer', 'norn_directive', 'norn_tick', 'norn_pause']) assert.ok(!n(ck).includes(x), x);
  assert.ok(n(ck).includes('norn_settings') && n(ck).includes('norn_run'));
  assert.ok(n(ctl).includes('norn_collide') && n(ck).includes('norn_collide') && !n(ctl).includes('norn_ledger'), 'lane-collide S2a');
  assert.deepEqual(n(wk), ['norn_mail', 'norn_run_show', 'norn_status']);   // META-GTP-MAIL: + its own mailbox
});

// META-PLAN R1: the plan rides on norn_status (view plan): every profile reads it, the controller stays at <= 16 tools
test('norn_status view plan: listed in every profile, read-only plan text + the model', async () => {
  const s = tmp();
  for (const prof of ['controller', 'checkin', 'worker']) {
    const m = server(['--state', s, '--profile', prof]); await m.init();
    const st = (await m.call('tools/list')).result.tools.find(t => t.name === 'norn_status');
    assert.deepEqual(st.inputSchema.properties.view.enum, ['status', 'plan', 'instructions', 'collide', 'ledger'], prof);
    await m.close();
  }
  const m = server(['--state', s, '--profile', 'controller']); await m.init();
  const r = await m.tool('norn_status', { view: 'plan' });
  await m.close();
  assert.ok(!r.isError, JSON.stringify(r));
  assert.match(r.content[0].text, /Up next\n  nothing is waiting to start/);
  assert.match(r.content[0].text, /Forecast\n  usage not measured yet/);
  assert.deepEqual(r.structuredContent.plan.upnext, []);
});

test('role refusal: a checkin or worker environment cannot start the controller profile; a worker cannot start checkin', () => {
  const s = tmp();
  const go = (prof, extra) => spawnSync(process.execPath, [META, 'mcp', '--state', s, '--profile', prof], { env: cleanEnv(extra), input: '', encoding: 'utf8' });
  const a = go('controller', { META_ROLE: 'checkin' });
  assert.equal(a.status, 2); assert.match(a.stderr, /refused.*controller/i);
  assert.equal(go('controller', { META_RUN_ID: 'RUN-9' }).status, 2);
  assert.equal(go('controller', { META_ROLE: 'controller', META_RUN_ID: 'RUN-9' }).status, 2);   // a worker inherits the controller's env
  assert.equal(go('checkin', { META_RUN_ID: 'RUN-9' }).status, 2);
  // L-03: the role is the RUN record's, not META_ROLE, which a worker inherits from the check-in that dispatched it
  const ck = record(s, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'checkin', executor: 'fake', lane: 'checkin' } }).id;
  const wk = record(s, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'a' } }).id;
  assert.equal(go('checkin', { META_ROLE: 'checkin', META_RUN_ID: ck }).status, 0);
  const w = go('checkin', { META_ROLE: 'checkin', META_RUN_ID: wk });
  assert.equal(w.status, 2, 'a worker with an inherited META_ROLE=checkin is refused'); assert.match(w.stderr, /refused.*checkin.*worker/i);
  assert.equal(go('checkin', { META_ROLE: 'checkin', META_RUN_ID: 'RUN-9' }).status, 2, 'a run with no record is no check-in');
  assert.equal(go('worker', { META_RUN_ID: 'RUN-9' }).status, 0);
  assert.equal(go('boss', {}).status, 2);
});

test('a tool outside the profile is refused with code 2; nothing is written', async () => {
  const s = tmp();
  record(s, { kind: 'question', ev: 'create', by: 'checkin', data: { title: 'T', lane: 'gen', options: [{ key: 'a', text: 'A' }] } });
  const m = server(['--state', s, '--profile', 'checkin']); await m.init();
  const r = await m.tool('norn_answer', { q: 'Q-1', text: 'a' });
  assert.equal(r.isError, true); assert.equal(r.structuredContent.code, 2); assert.match(text(r), /not in profile checkin/);
  await m.close();
  assert.equal(loadState(s).items['Q-1'].state, 'open');
});

test('controller writes: answer is the owner, via is stamped by the server (chat:<client>), a model-supplied via is invalid', async () => {
  const s = tmp();
  const m = server(['--state', s, '--profile', 'controller', '--client', 'codex']); await m.init();
  const q = await m.tool('norn_question_add', { lane: 'gen', title: 'Carve or fill?', body: 'b', options: [{ key: 'a', text: 'carve', cost: '1 round' }, { key: 'b', text: 'fill' }], recommend: { key: 'a', why: 'relief' } });
  assert.ok(!q.isError, text(q)); assert.equal(q.structuredContent.id, 'Q-1');
  const bad = await m.tool('norn_answer', { q: 'Q-1', text: 'a', via: 'dashboard' });
  assert.equal(bad.isError, true); assert.equal(bad.structuredContent.code, 2);
  const ans = await m.tool('norn_answer', { q: 'Q-1', text: 'carve it, owner words', choice: 'a' });
  assert.ok(!ans.isError, text(ans));
  const dir = await m.tool('norn_directive', { text: 'Keep it small.', scope: ['gen'] });
  assert.equal(dir.structuredContent.id, 'DIR-1');
  const dec = await m.tool('norn_decision_add', { lane: 'gen', question: 'Carve or fill?', choice: 'a', why: 'owner', answers: 'Q-1' });
  assert.equal(dec.structuredContent.id, 'DEC-1');
  const ap = await m.tool('norn_record_event', { id: 'Q-1', event: 'apply', fields: { refs: ['DEC-1'] } });
  assert.ok(!ap.isError, text(ap));
  const missing = await m.tool('norn_answer', { q: 'Q-9', text: 'x' });
  assert.equal(missing.isError, true); assert.equal(missing.structuredContent.code, 2); assert.match(text(missing), /Q-9 does not exist/);
  await m.close();
  const st = loadState(s), h = id => st.items[id].history;
  assert.equal(st.items['Q-1'].state, 'applied');
  assert.deepEqual(h('Q-1').map(e => [e.ev, e.by, e.data.via]), [['create', 'controller', 'chat:codex'], ['answer', 'owner', 'chat:codex'], ['apply', 'controller', 'chat:codex']]);
  assert.equal(h('DIR-1')[0].by, 'owner'); assert.equal(h('DIR-1')[0].data.via, 'chat:codex');
  assert.equal(h('DEC-1')[0].data.via, 'chat:codex');
});

test('checkin writes as checkin; inbox lists needs-you items with a cursor; records filter', async () => {
  const s = tmp();
  const m = server(['--state', s, '--profile', 'checkin']); await m.init();
  await m.tool('norn_question_add', { lane: 'gen', title: 'Q one', options: [{ key: 'a', text: 'A' }] });
  const i1 = await m.tool('norn_inbox', {});
  assert.deepEqual(i1.structuredContent.items.map(i => i.id), ['Q-1']);
  const cur = i1.structuredContent.cursor;
  assert.equal(cur.seq, 1);
  assert.deepEqual((await m.tool('norn_inbox', { since_seq: cur.seq })).structuredContent.items, []);
  await m.tool('norn_question_add', { lane: 'gen', title: 'Q two', options: [{ key: 'a', text: 'A' }] });
  assert.deepEqual((await m.tool('norn_inbox', { since_seq: cur.seq })).structuredContent.items.map(i => i.id), ['Q-2']);
  const recs = await m.tool('norn_records', { kind: 'question', id: 'Q-2' });
  assert.equal(recs.structuredContent.rows.length, 1); assert.equal(recs.structuredContent.rows[0].data.title, 'Q two');
  const bad = await m.tool('norn_records', { limit: 500 });
  assert.equal(bad.isError, true); assert.equal(bad.structuredContent.code, 2);
  await m.close();
  assert.equal(loadState(s).items['Q-1'].history[0].by, 'checkin');
});

test('norn_records sorts by the number of an id, not all its digits (Q-b2-1 is 1, not 21); norn_run_show reads the last end (L-02, B-16)', async () => {
  const s = tmp(), at = { v: 1, ts: '2026-10-01T00:00:00Z', run: null };
  const raw = (kind, evs) => fs.writeFileSync(recordsFile(s, kind), evs.map((e, i) => JSON.stringify({ ...at, seq: i + 1, ...e }) + '\n').join(''));
  fs.mkdirSync(s, { recursive: true });
  raw('question', ['Q-30', 'Q-b2-1', 'Q-5'].map(id => ({ id, kind: 'question', ev: 'create', by: 'owner', data: { title: id, lane: 'gen', options: [{ key: 'a', text: 'A' }] } })));
  raw('run', [{ id: 'RUN-1', kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'gen' } },
    { id: 'RUN-1', kind: 'run', ev: 'lost', by: 'launcher', data: { why: 'stale heartbeat' } },
    { id: 'RUN-1', kind: 'run', ev: 'end', by: 'launcher', data: { exit: null, outcome: 'no-result' } },
    { id: 'RUN-1', kind: 'run', ev: 'end', by: 'launcher', data: { exit: 0, outcome: 'done' } }]);
  const m = server(['--state', s, '--profile', 'checkin']); await m.init();
  assert.deepEqual((await m.tool('norn_records', { kind: 'question' })).structuredContent.rows.map(r => r.id), ['Q-b2-1', 'Q-5', 'Q-30']);
  assert.equal((await m.tool('norn_run_show', { run: 'RUN-1' })).structuredContent.outcome, 'done', 'the fold keeps the last end: so does run_show');
  await m.close();
});

test('norn_run starts a fake run (via stamped on the run), norn_run_show reports it, norn_stop needs a run', async () => {
  const s = path.join(tmp(), 'state'), wt = tmp(), brief = path.join(wt, 'brief.md');
  fs.writeFileSync(brief, 'mode: done\n');
  const m = server(['--state', s, '--profile', 'controller', '--client', 'codex']); await m.init();
  const r = await m.tool('norn_run', { lane: 'demo', brief, executor: 'fake', worktree: wt, notes: path.join(wt, 'NOTES.md') });
  assert.ok(!r.isError, text(r));
  assert.equal(r.structuredContent.run, 'RUN-1'); assert.equal(r.structuredContent.executor, 'fake');
  let show;
  for (let i = 0; i < 100; i++) { show = (await m.tool('norn_run_show', { run: 'RUN-1', notes_tail: 5 })).structuredContent; if (show.state !== 'running') break; await new Promise(res => setTimeout(res, 100)); }
  assert.equal(show.state, 'exited'); assert.equal(show.outcome, 'done'); assert.match(show.notes_tail, /work: done/);
  const bad = await m.tool('norn_run', { lane: 'demo', brief: path.join(wt, 'missing.md'), executor: 'fake', worktree: wt });
  assert.equal(bad.isError, true); assert.equal(bad.structuredContent.code, 2); assert.match(text(bad), /--brief .*missing\.md: no such file \(write the brief first\)/);
  const stop = await m.tool('norn_stop', { run: 'RUN-1', why: 'x' });
  assert.equal(stop.isError, true);
  await m.close();
  assert.equal(loadState(s).items['RUN-1'].history[0].data.via, 'chat:codex');
});

test('worker profile: norn_run_show works, writes are refused', async () => {
  const s = tmp();
  record(s, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'fake', lane: 'demo' } });
  const m = server(['--state', s, '--profile', 'worker'], { META_RUN_ID: 'RUN-1' }); await m.init();
  assert.equal((await m.tool('norn_run_show', { run: 'RUN-1' })).structuredContent.state, 'running');
  assert.equal((await m.tool('norn_run', { lane: 'x', brief: 'b' })).structuredContent.code, 2);
  await m.close();
});

test('prompts: controller + checkin packs; norn_boot returns the pack and a state digest; pause writes the PAUSED flag', async () => {
  const s = tmp();
  record(s, { kind: 'question', ev: 'create', by: 'checkin', data: { title: 'T', lane: 'gen' } });
  const m = server(['--state', s, '--profile', 'controller']); await m.init();
  const pl = (await m.call('prompts/list')).result.prompts.map(p => p.name).sort();
  assert.deepEqual(pl, ['checkin', 'controller']);
  const g = (await m.call('prompts/get', { name: 'controller' })).result;
  assert.equal(g.messages[0].role, 'user'); assert.match(g.messages[0].content.text, /NORN CONTROLLER/);
  assert.equal((await m.call('prompts/get', { name: 'nope' })).error.code, -32602);
  const boot = await m.tool('norn_boot', { role: 'controller' });
  assert.match(text(boot), /NORN CONTROLLER/); assert.equal(boot.structuredContent.digest.needs_you, 1);
  assert.deepEqual(boot.structuredContent.digest.running, []);
  assert.equal(boot.structuredContent.digest.digest.questions.length, 1, 'NORN-WATCH S1: the resume digest beside needs_you');
  assert.match(text(boot), /Ended without a clean successor/);
  await m.tool('norn_pause', { mode: 'all' });
  assert.ok(fs.existsSync(path.join(s, 'PAUSED')));
  await m.tool('norn_pause', { resume: 'all' });
  assert.ok(!fs.existsSync(path.join(s, 'PAUSED')));
  await m.close();
  const c = server(['--state', s, '--profile', 'checkin']); await c.init();
  assert.deepEqual((await c.call('prompts/list')).result.prompts.map(p => p.name), ['checkin']);
  assert.equal((await c.tool('norn_boot', { role: 'controller' })).structuredContent.code, 2);
  await c.close();
});

test('settings get / dry-run / set through policy validation; ledger tail; checkin may only get', async () => {
  const root = tmp();
  const pf = projectFile(root, 'kestrel');
  const p = loadProject(pf, { home: root, meta: root });
  fs.writeFileSync(path.join(p.root, 'progress.md'), 'l1\nl2\nl3\n');
  fs.mkdirSync(path.join(root, 'local'), { recursive: true });
  fs.writeFileSync(path.join(root, 'local', 'budget.json'), JSON.stringify(budget0, null, 2) + '\n');
  const env = { META_ROOT: root };
  const m = server(['--project', pf, '--profile', 'controller'], env); await m.init();
  const g = await m.tool('norn_settings', { get: ['max_claude_workers'] });
  assert.ok(!g.isError, text(g)); assert.equal(g.structuredContent.values.max_claude_workers, 2);
  const dry = await m.tool('norn_settings', { set: { key: 'max_claude_workers', value: 3 }, dry_run: true });
  assert.ok(!dry.isError, text(dry)); assert.deepEqual(dry.structuredContent.diff, [{ key: 'max_claude_workers', from: 2, to: 3 }]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'local', 'budget.json'))).max_claude_workers, 2);
  const set = await m.tool('norn_settings', { set: { key: 'max_claude_workers', value: 3 } });
  assert.ok(!set.isError, text(set));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'local', 'budget.json'))).max_claude_workers, 3);
  const pol0 = JSON.parse(fs.readFileSync(pf, 'utf8')).policy;   // META-PROFILE-BUG R1: only the changed key, never the defaults
  assert.ok(!(await m.tool('norn_settings', { set: { key: 'policy.cadence.checkin_interval_min', value: 20 } })).isError);
  assert.deepEqual(JSON.parse(fs.readFileSync(pf, 'utf8')).policy, { ...pol0, cadence: { checkin_interval_min: 20 } });
  const bad = await m.tool('norn_settings', { set: { key: 'no_such_setting', value: 1 } });
  assert.equal(bad.isError, true); assert.equal(bad.structuredContent.code, 2);
  assert.deepEqual((await m.tool('norn_status', { view: 'ledger', tail: 2 })).structuredContent.lines, ['l2', 'l3']);   // lane-collide S2a: norn_ledger is a view
  await m.close();
  const c = server(['--project', pf, '--profile', 'checkin'], env); await c.init();
  assert.ok(!(await c.tool('norn_settings', { get: ['max_claude_workers'] })).isError);
  assert.equal((await c.tool('norn_settings', { set: { key: 'max_claude_workers', value: 1 } })).structuredContent.code, 2);
  await c.close();
});

test('norn_run_show ask (META-GTP-ASK): checkin / controller ask an ENDED run (norn ask, a cold fake helper here); a worker is refused', async () => {
  const s = path.join(tmp(), 'state'), wt = tmp(), brief = path.join(wt, 'brief.md');
  fs.writeFileSync(brief, 'mode: done\n');
  const m = server(['--state', s, '--profile', 'checkin']); await m.init();
  assert.ok(!(await m.tool('norn_run', { lane: 'demo', brief, executor: 'fake', worktree: wt, notes: path.join(wt, 'NOTES.md') })).isError);
  for (let i = 0; i < 100 && loadState(s).items['RUN-1'].state === 'running'; i++) await new Promise(res => setTimeout(res, 100));
  const r = await m.tool('norn_run_show', { run: 'RUN-1', ask: 'why the X table?', executor: 'fake', max_s: 15 });
  assert.ok(!r.isError, text(r));
  assert.equal(r.structuredContent.code, 0); assert.match(r.structuredContent.ask_run, /^RUN-\d+$/); assert.equal(r.structuredContent.mode, 'cold');
  assert.match(text(r), /work: done/);
  await m.close();
  const w = server(['--state', s, '--profile', 'worker'], { META_RUN_ID: 'RUN-1' }); await w.init();
  const no = await w.tool('norn_run_show', { run: 'RUN-1', ask: 'x' });
  assert.equal(no.isError, true); assert.equal(no.structuredContent.code, 2);
  await w.close();
});

// ---------- META-ADOPT A4 (SPEC meta-adopt sec. 5 MCP): the machine-scoped setup profile ----------
const SETUP_TOOLS = ['norn_adopt_apply', 'norn_adopt_decide', 'norn_adopt_scan', 'norn_adopt_show', 'norn_adopt_start', 'norn_setup_status'];
const GIT_DIR = path.dirname(spawnSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0]);
/** a temp machine (META_ROOT, HOME, a fake claude on PATH; `norn setup` run when setup) + a node repo with a CI test line and a ROADMAP */
function machine({ setup = true } = {}) {
  const t = tmp(), d = { root: path.join(t, 'meta'), home: path.join(t, 'home'), bin: path.join(t, 'bin'), repo: path.join(t, 'tide') };
  for (const x of [d.root, d.home, d.bin, d.repo]) fs.mkdirSync(x, { recursive: true });
  fs.writeFileSync(path.join(d.bin, process.platform === 'win32' ? 'claude.exe' : 'claude'), '');
  const env = { PATH: d.bin + path.delimiter + GIT_DIR, HOME: d.home, USERPROFILE: d.home, CLAUDE_CONFIG_DIR: path.join(d.home, 'cfg'), META_ROOT: d.root,
    LOCALAPPDATA: path.join(d.home, 'AppData', 'Local'), APPDATA: path.join(d.home, 'AppData', 'Roaming') };
  if (setup) { const r = spawnSync(process.execPath, [META, 'setup', '--non-interactive', '--no-scheduler'], { env: cleanEnv(env), encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr + r.stdout); }
  const files = { 'package.json': JSON.stringify({ name: 'tide', scripts: { test: 'node --test' } }), 'AGENTS.md': '# agents\n',
    '.github/workflows/ci.yml': 'name: ci\non: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n',
    'ROADMAP.md': '# Roadmap\n\n## Now\n- [ ] Export to CSV\n- [ ] Retry queue\n' };
  for (const [f, x] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d.repo, f)), { recursive: true }); fs.writeFileSync(path.join(d.repo, f), x); }
  const g = (...a) => assert.equal(spawnSync('git', ['-C', d.repo, '-c', 'user.name=t', '-c', 'user.email=t@t.test', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' }).status, 0);
  g('init', '-q', '-b', 'main'); g('add', '-A'); g('commit', '-q', '-m', 'init');
  const projects = () => JSON.parse(fs.readFileSync(path.join(d.root, 'local', 'machine.json'), 'utf8')).projects;
  const config = () => projects()[0].config.replace('${norn}', d.root);
  return { ...d, env, projects, config };
}

test('setup profile (META-ADOPT A4): machine-scoped (no --project), six tools + the adopt prompt; refused from a worker or check-in env', async () => {
  const mc = machine({ setup: false });
  const m = server(['--profile', 'setup'], mc.env);
  const init = await m.init();
  assert.match(init.result.instructions, /norn_setup_status/);
  const tools = (await m.call('tools/list')).result.tools;
  assert.deepEqual(tools.map(t => t.name).sort(), SETUP_TOOLS);
  for (const t of tools) assert.ok(!t.description.includes('\n') && t.description.length <= 160, t.name);
  assert.deepEqual((await m.call('prompts/list')).result.prompts.map(p => p.name), ['adopt']);
  const pr = (await m.call('prompts/get', { name: 'adopt' })).result.messages[0].content.text;
  assert.match(pr, /never decide/i); assert.match(pr, /profile/i); assert.match(pr, /norn_adopt_scan/);
  const st = await m.tool('norn_setup_status');
  assert.ok(!st.isError, text(st)); assert.equal(st.structuredContent.machine, false); assert.match(text(st), /norn setup/);
  await m.close();
  const go = extra => spawnSync(process.execPath, [META, 'mcp', '--profile', 'setup'], { env: cleanEnv({ ...mc.env, ...extra }), input: '', encoding: 'utf8' });
  const w = go({ META_RUN_ID: 'RUN-9' });
  assert.equal(w.status, 2); assert.match(w.stderr, /refused.*setup/i);
  assert.equal(go({ META_ROLE: 'checkin' }).status, 2);
  assert.equal(go({}).status, 0);
  const both = spawnSync(process.execPath, [META, 'mcp', '--profile', 'setup', '--state', tmp()], { env: cleanEnv(mc.env), input: '', encoding: 'utf8' });
  assert.equal(both.status, 2); assert.match(both.stderr, /machine-scoped/);
});

test('setup walk over MCP: status -> scan (writes nothing) -> start (registers, facts-only) -> show -> decide / apply need owner_words', async () => {
  const mc = machine();
  const m = server(['--profile', 'setup', '--client', 'test'], mc.env); await m.init();
  assert.match(text(await m.tool('norn_setup_status')), /no project yet.*norn_adopt_scan/i);
  const sc = await m.tool('norn_adopt_scan', { root: mc.repo });
  assert.ok(!sc.isError, text(sc)); assert.match(text(sc), /npm test/); assert.equal(sc.structuredContent.facts.commands[0].cmd, 'npm test');
  assert.equal(mc.projects().length, 0, 'the scan writes nothing');
  const ask = await m.tool('norn_adopt_start', { root: mc.repo });   // no read choice yet: register, then ask (the cost line)
  assert.ok(!ask.isError, text(ask)); assert.match(text(ask), /read/i); assert.equal(ask.structuredContent.choose, true);
  assert.match(text(ask), /wrote .*project\.json/); assert.equal(mc.projects().length, 1);
  const name = mc.projects()[0].name;
  const s1 = await m.tool('norn_adopt_start', { root: mc.repo, read: false, answers: { never: 'push to main' } });
  assert.ok(!s1.isError, text(s1)); assert.equal(s1.structuredContent.project, name); assert.match(s1.structuredContent.id, /^ADP-\d+$/);
  assert.equal(mc.projects().length, 1, 'a registered root is reused');
  const all = await m.tool('norn_adopt_show', { project: name });
  assert.match(text(all), /roadmap\s+to review/); assert.ok(all.structuredContent.parts.some(p => p.id === 'profile' && p.pick));
  const rm = await m.tool('norn_adopt_show', { project: name, part: 'roadmap' });
  assert.match(text(rm), /r1 .*Export to CSV.*ROADMAP\.md:4/); assert.doesNotMatch(text(rm), /Caps profile/);
  const no = await m.tool('norn_adopt_decide', { project: name, part: 'roadmap', verdict: 'approve' });
  assert.equal(no.isError, true); assert.match(text(no), /owner_words/);
  const pf = JSON.parse(fs.readFileSync(mc.config(), 'utf8'));
  const state = () => loadProject(mc.config(), { meta: mc.root }).state;
  const decides = () => readEvents(recordsFile(state(), 'proposal')).filter(e => e.id === s1.structuredContent.id && e.ev === 'decide');
  assert.equal(decides().length, 0);
  for (const [part, verdict, extra] of [['roadmap', 'approve', { off: ['r2'] }], ['profile', 'approve', { pick: 'try-it' }], ['commands', 'approve', {}], ['rules', 'skip', {}], ['instructions', 'skip', {}], ['first', 'skip', {}]]) {
    const r = await m.tool('norn_adopt_decide', { project: name, part, verdict, ...extra, owner_words: `yes, ${verdict} the ${part}` });
    assert.ok(!r.isError, part + ': ' + text(r));
  }
  const dec = decides();
  assert.ok(dec.every(h => h.by === 'owner')); assert.equal(dec[0].data.owner_words, 'yes, approve the roadmap'); assert.equal(dec[0].data.via, 'chat:test');
  assert.equal((await m.tool('norn_adopt_apply', { project: name })).isError, true);
  const ap = await m.tool('norn_adopt_apply', { project: name, owner_words: 'apply it' });
  assert.ok(!ap.isError, text(ap)); assert.match(text(ap), /roadmap: 1 item/); assert.match(text(ap), /applied/);
  assert.equal(JSON.parse(fs.readFileSync(mc.config(), 'utf8')).merge.gate.cmd, 'npm test'); assert.equal(pf.merge, undefined);
  const fin = await m.tool('norn_setup_status');
  assert.equal(fin.structuredContent.projects[0].adopt.state, 'applied');
  await m.close();
  assert.equal(spawnSync('git', ['-C', mc.repo, 'status', '--porcelain'], { encoding: 'utf8' }).stdout, '', 'the repo is never written');
});

test('setup elicitation (spec 2025-06-18): the server asks the HUMAN for the profile pick and for Apply; decline writes nothing', async () => {
  const mc = machine(), asked = [];
  let answer = { action: 'cancel' };   // a headless client (claude -p, live 11-12) declares elicitation and cancels every dialog
  const m = server(['--profile', 'setup'], mc.env, { onRequest: q => { asked.push(q); return q.method === 'elicitation/create' ? answer : { error: { code: -32601, message: 'no' } }; } });
  await m.init({ elicitation: {} });
  const s1 = await m.tool('norn_adopt_start', { root: mc.repo, read: false });
  assert.ok(!s1.isError, text(s1));
  const name = s1.structuredContent.project;
  const c = await m.tool('norn_adopt_decide', { project: name, part: 'profile', verdict: 'approve', pick: 'try-it', owner_words: 'I pick try-it' });
  assert.ok(!c.isError, text(c)); assert.equal(c.structuredContent.decided, false);
  assert.match(text(c), /nothing was decided/); assert.match(text(c), /norn adopt approve profile --pick <id> --project/, 'no dead end: the terminal or the dashboard');
  answer = { action: 'accept', content: { profile: 'solo' } };
  const p = await m.tool('norn_adopt_decide', { project: name, part: 'profile', verdict: 'approve', pick: 'heavy' });   // the model's pick is not the human's
  assert.ok(!p.isError, text(p));
  assert.equal(asked.length, 2); assert.deepEqual(asked[1].params.requestedSchema.properties.profile.enum, ['try-it', 'solo', 'heavy']);
  assert.match(text(p), /solo/);
  for (const part of ['commands', 'rules', 'instructions', 'roadmap', 'first'])
    assert.ok(!(await m.tool('norn_adopt_decide', { project: name, part, verdict: 'skip', owner_words: 'skip it' })).isError, part);
  answer = { action: 'decline' };
  const d = await m.tool('norn_adopt_apply', { project: name, owner_words: 'the model says apply' });
  assert.ok(!d.isError, text(d)); assert.match(text(d), /declined.*nothing/i); assert.equal(asked.at(-1).params.requestedSchema.properties.apply.type, 'boolean');
  assert.equal((await m.tool('norn_adopt_show', { project: name })).structuredContent.state, 'open');
  answer = { action: 'accept', content: { apply: true } };
  const a = await m.tool('norn_adopt_apply', { project: name });
  assert.ok(!a.isError, text(a)); assert.match(text(a), /caps profile solo/);
  assert.equal((await m.tool('norn_adopt_show', { project: name })).structuredContent.state, 'applied');
  await m.close();
});

// lane-collide S2a (SPEC 4A.4 MCP): norn_collide calls the CLI's verbs with the server's role; the plan is norn_status view collide
test('norn_collide: list and show the cases, a remedy goes through the CLI with the profile’s role and its refusal; view collide is the plan', async () => {
  const s = tmp();
  const col = record(s, { kind: 'collision', ev: 'open', by: 'launcher', data: { key: 'item:a+b', kind: 'item', grade: null, verdict: 'warn', door: 'run', a: { lane: 'a' }, b: { lane: 'b' }, files: [], files_n: 0, why: 'synthetic item', pair: 'a+b' } }).id;
  const m = server(['--state', s, '--profile', 'checkin']); await m.init();
  const l = await m.tool('norn_collide', { action: 'list' });
  assert.ok(!l.isError, text(l)); assert.match(text(l), new RegExp(`^${col} open item warn a > b`, 'm'));
  assert.equal((await m.tool('norn_collide', { action: 'show', case: col })).structuredContent.case.id, col);
  const no = await m.tool('norn_collide', { action: 'allow', case: col, why: 'x' });
  assert.equal(no.isError, true); assert.match(text(no), /controller's/); assert.equal(no.structuredContent.code, 3);
  const ask = await m.tool('norn_collide', { action: 'ask', case: col, want: 'allow', why: 'one item' });
  assert.ok(!ask.isError, text(ask)); assert.match(text(ask), /asked the controller for allow/);
  const p = await m.tool('norn_status', { view: 'collide' });
  assert.ok(!p.isError, text(p)); assert.ok(Array.isArray(p.structuredContent.collide.intents));
  await m.close();
  const w = server(['--state', s, '--profile', 'worker']); await w.init();
  assert.equal((await w.tool('norn_status', { view: 'ledger' })).isError, true, 'the ledger is not a worker’s');
  await w.close();
});

// RM-a-57: norn_code_card is one worker tool, offered only to the card group of policy.code.card ab (even run numbers); off by default.
// Its schema's standing-context cost is pinned (NOTES carries the number).
test('norn_code_card: off by default; ab lists it for even worker runs only and marks each run\'s group', async () => {
  const { handle, context } = await import('../engine/lib/mcp.mjs');
  const s = tmp(), call = (ctx, method, params) => handle({ jsonrpc: '2.0', id: 1, method, params }, ctx).result;
  const ctxOf = (policy, run) => context({ state: s, project: policy ? { name: 'kestrel', root: s, policy } : null, profile: 'worker', client: 'test', env: { META_RUN_ID: run }, cli: () => 0 });
  const names = ctx => call(ctx, 'tools/list').tools.map(t => t.name);
  assert.ok(!names(ctxOf(null, 'RUN-a-2')).includes('norn_code_card'), 'off by default');
  assert.ok(!names(ctxOf({ code: { card: 'off' } }, 'RUN-a-2')).includes('norn_code_card'));
  const card = ctxOf({ code: { card: 'ab' } }, 'RUN-a-2'), control = ctxOf({ code: { card: 'ab' } }, 'RUN-a-3');
  const on = call(card, 'tools/list').tools, off = names(control);
  assert.deepEqual(on.map(t => t.name).sort(), ['norn_code_card', 'norn_mail', 'norn_run_show', 'norn_status']);
  assert.deepEqual(off.sort(), ['norn_mail', 'norn_run_show', 'norn_status']);
  const t = on.find(x => x.name === 'norn_code_card'), cost = Math.ceil(JSON.stringify(t).length / 4);
  assert.ok(cost <= 100, `the schema costs ~${cost} tokens`);
  for (const [run, group] of [['RUN-a-2', 'card'], ['RUN-a-3', 'control']]) assert.equal(JSON.parse(fs.readFileSync(path.join(s, 'code', 'card', `${run}.json`), 'utf8')).group, group);
  assert.equal(call(control, 'tools/call', { name: 'norn_code_card', arguments: { files: ['a.mjs'] } }).isError, true, 'the control group cannot call it');
  const r = call(card, 'tools/call', { name: 'norn_code_card', arguments: { files: ['a.mjs', 'b.mjs'] } });
  assert.ok(!r.isError, JSON.stringify(r));
  assert.deepEqual(r.structuredContent.cards.map(c => c.file), ['a.mjs', 'b.mjs']);
  assert.match(r.content[0].text, /^a\.mjs · .*\n {2}used by: not indexed/);
});

// RM-a-64: norn_code_symbol is one worker tool under policy.code.symbol (off by default, on = every worker run); it reads the server's
// folder (the worker's worktree). Its schema's standing-context cost is pinned (NOTES carries the number).
test('norn_code_symbol: off by default; on lists it for worker runs and reads one symbol from the worktree', async () => {
  const { handle, context } = await import('../engine/lib/mcp.mjs');
  const { ensurePart } = await import('../engine/lib/rustbin.mjs');
  const s = tmp(), repo = path.join(s, 'repo'), call = (ctx, method, params) => handle({ jsonrpc: '2.0', id: 1, method, params }, ctx).result;
  const ctxOf = policy => context({ state: path.join(s, 'state'), project: policy ? { name: 'kestrel', root: s, policy } : null, profile: 'worker', client: 'test', env: { META_RUN_ID: 'RUN-a-3' }, cli: () => 0 });
  const names = ctx => call(ctx, 'tools/list').tools.map(t => t.name);
  assert.ok(!names(ctxOf(null)).includes('norn_code_symbol'), 'off by default');
  assert.ok(!names(ctxOf({ code: { symbol: 'off' } })).includes('norn_code_symbol'));
  const on = ctxOf({ code: { symbol: 'on' } }), t = call(on, 'tools/list').tools.find(x => x.name === 'norn_code_symbol');
  assert.ok(t, 'on lists it'); const cost = Math.ceil(JSON.stringify(t).length / 4);
  assert.ok(cost <= 100, `the schema costs ~${cost} tokens`);
  assert.equal(call(ctxOf(null), 'tools/call', { name: 'norn_code_symbol', arguments: { symbols: ['a.mjs::f'] } }).isError, true, 'off cannot call it');
  const b = ensurePart('code', { err: () => {} }); assert.ok(b.ok, b.why);
  fs.mkdirSync(repo, { recursive: true }); fs.writeFileSync(path.join(repo, 'a.mjs'), 'export function f(x) {\n  return x;\n}\n');
  const git = (...a) => assert.equal(spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { cwd: repo, windowsHide: true }).status, 0);
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'fixture');
  const here = process.cwd(); process.chdir(repo);
  try {
    const r = call(on, 'tools/call', { name: 'norn_code_symbol', arguments: { symbols: ['a.mjs::f'] } });
    assert.ok(!r.isError, JSON.stringify(r));
    assert.equal(r.structuredContent.results[0].status, 'current');
    assert.match(r.content[0].text, /^a\.mjs::f {2}function .* lines 1\.\.3 .*current\nexport function f\(x\) \{/);
    assert.equal(call(on, 'tools/call', { name: 'norn_code_symbol', arguments: { symbols: ['a.mjs'] } }).isError, true, 'file::name or an error');
  } finally { process.chdir(here); }
});
