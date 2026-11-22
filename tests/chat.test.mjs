// META-CONTROLLER C1 (SPEC sec. 1 + 8): the chat core - the `chat` capability per adapter (claude stream, fake for tests), the
// golden chat command lines, the thread file (engine/lib/chat.mjs) and its endpoints. No real claude: the fake chat CLI
// (engine/bin/fake-chat.mjs) speaks the same stream-json as `claude -p --input-format stream-json` (C0 fixtures).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, adapterFor, capsMatrix, formatCapsMatrix } from '../engine/lib/harness/index.mjs';
import { CHATS } from '../engine/lib/harness/common.mjs';
import { spawn } from 'node:child_process';
import { createChat, readThread, threadState, rolePack, chatEnv, threadFlushed, newsBlock } from '../engine/lib/chat.mjs';
import { sendMail } from '../engine/lib/mail.mjs';
import { threadFile } from '../engine/lib/chatact.mjs';
import { snap, newSnap, readTextA } from '../engine/lib/fsnap.mjs';
import { FAKE_CHAT } from '../engine/lib/harness/fake.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { fixture } from './helpers/dash-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLD = path.join(HERE, 'golden', 'commands', 'chat.json');
const MCP = { name: 'norn', command: '/x/node', args: ['/m/norn.mjs', 'mcp', '--project', '/p/project.json', '--profile', 'controller', '--client', 'dashboard'] };
const CHAT_O = { exe: '/x/claude', model: 'claude-opus-5-5', effort: 'high', session_id: '11111111-2222-4333-8444-555555555555', mcp: MCP,
  system: 'ROLE PACK', cwd: '/s/chat', addDirs: ['/r/root'] };

test('golden: the claude chat command lines (new session / resume) and the fake one; every claude flag is in its recorded --help', () => {
  const c = adapterFor('claude'), f = adapterFor('fake');
  const got = { 'claude-new': c.chatCommand(CHAT_O), 'claude-resume': c.chatCommand({ ...CHAT_O, resume: true }), 'claude-no-mcp': c.chatCommand({ ...CHAT_O, mcp: null, addDirs: [] }),
    fake: { ...f.chatCommand(CHAT_O), exe: '<node>', args: f.chatCommand(CHAT_O).args.map(a => (a.endsWith('fake-chat.mjs') ? '<fake-chat>' : a)) } };
  if (process.env.UPDATE_GOLDEN) fs.writeFileSync(GOLD, JSON.stringify(got, null, 1) + '\n');
  assert.deepEqual(got, JSON.parse(fs.readFileSync(GOLD, 'utf8')));
  const help = fs.readFileSync(path.join(HERE, 'fixtures', 'help', 'claude.txt'), 'utf8');
  // C3: --permission-prompt-tool is a hidden flag - the help names it only inside --permission-prompts ("the SDK host or
  // --permission-prompt-tool"); C0 fact 2 proved it is called in -p mode (2.1.314). Only that flag, only that wording.
  const named = a => help.includes(a + ' ') || help.includes(a + ',') || (a === '--permission-prompt-tool' && /--permission-prompts <target>[\s\S]{0,200}--permission-prompt-tool\)/.test(help));
  for (const k of ['claude-new', 'claude-resume']) for (const a of got[k].args) if (a.startsWith('-')) assert.ok(named(a), `${a} in claude --help`);
  assert.equal(got['claude-new'].stdin, 'stream');
  assert.throws(() => c.chatCommand({ ...CHAT_O, session_id: null }), /session_id/);
});

// ---------- piece 2: engine/lib/chat.mjs - the thread is Norn's, the process is disposable ----------
const proj = (extra = {}) => { const state = mkTmp('meta-chat-', 'p'), root = path.join(path.dirname(path.dirname(state)), 'root'); fs.mkdirSync(root, { recursive: true }); return { name: 'p', state, root, ...extra }; };
const fakeChat = (p, o = {}) => createChat({ project: p, executor: 'fake', model: 'fake-m', effort: 'high', idleMs: 60000, ...o });
// resolves with the first thread line (live event) that matches
const next = (chat, pred, ms = 15000) => new Promise((res, rej) => {
  const t = setTimeout(() => { off(); rej(new Error('timeout waiting for a chat event')); }, ms);
  const off = chat.subscribe(l => { if (pred(l)) { clearTimeout(t); off(); res(l); } });
});
const turnEnd = chat => next(chat, l => l.kind === 'turn');
const stopped = chat => next(chat, l => l.kind === 'stop');
const lines = p => readThread(p.state).items;
const texts = p => lines(p).filter(l => l.kind === 'text').map(l => l.text);

test('chat: fake round trip - lazy start on the first message, one segment, the reply; the init of every turn is no new segment', async () => {
  const p = proj(), chat = fakeChat(p);
  try {
    assert.equal(chat.status().running, false, 'nothing runs before the first message');
    let t = turnEnd(chat); chat.send('hello'); await t;
    t = turnEnd(chat); chat.send('again'); await t;
    const ls = lines(p);
    assert.deepEqual(ls.map(l => l.kind).filter(k => k !== 'usage'), ['segment', 'owner', 'start', 'session', 'text', 'turn', 'owner', 'text', 'turn']);
    assert.equal(ls.filter(l => l.kind === 'segment').length, 1, 'system init re-emitted on turn 2 (C0 finding 2) is not a new segment');
    assert.deepEqual(texts(p), ['heard hello (turn 1; first: hello)', 'heard again (turn 2; first: hello)']);
    const seg = ls[0];
    assert.match(seg.session_id, /^[0-9a-f-]{36}$/); assert.equal(seg.executor, 'fake'); assert.equal(seg.n, 1);
    assert.ok(ls.every(l => l.seg === 1 && typeof l.ts === 'string'));
    assert.equal(ls.find(l => l.kind === 'start').resume, false);
    assert.equal(chat.status().running, true); assert.equal(chat.status().busy, false);
    assert.deepEqual(threadState(ls), { seg: { n: 1, session_id: seg.session_id, executor: 'fake', model: 'fake-m', effort: 'high' }, begun: true });
    assert.deepEqual(readThread(p.state, ls.length - 1).items, [ls.at(-1)], 'read from a cursor');
  } finally { await chat.close(); }
});

test('chat: a vendor init with ANOTHER session id starts a new segment (the thread follows the vendor session)', () => {
  const ls = [{ kind: 'segment', n: 1, session_id: 'a', executor: 'claude', model: 'm', effort: 'e', seg: 1 }, { kind: 'session', session_id: 'a', seg: 1 },
    { kind: 'segment', n: 2, session_id: 'b', executor: 'claude', model: 'm', effort: 'e', why: 'vendor', seg: 2 }];
  assert.deepEqual(threadState(ls), { seg: { n: 2, session_id: 'b', executor: 'claude', model: 'm', effort: 'e' }, begun: true }, 'a vendor-made segment is begun');
  assert.deepEqual(threadState(ls.slice(0, 1)), { seg: { n: 1, session_id: 'a', executor: 'claude', model: 'm', effort: 'e' }, begun: false });
  assert.deepEqual(threadState([]), { seg: null, begun: false });
});

test('chat: dashboard restart, then the next message resumes the same session by id and keeps the conversation', async () => {
  const p = proj();
  let chat = fakeChat(p);
  let t = turnEnd(chat); chat.send('codeword PLUM'); await t;
  const s = stopped(chat); await chat.close();
  const st = await s;
  assert.deepEqual([st.why, st.code], ['shutdown', 0], 'shutdown closes stdin: exit 0');
  chat = fakeChat(p);   // a new dashboard process on the same state
  try {
    t = turnEnd(chat); chat.send('what was the codeword?'); await t;
    const ls = lines(p);
    assert.deepEqual(ls.filter(l => l.kind === 'start').map(l => l.resume), [false, true]);
    assert.equal(ls.filter(l => l.kind === 'segment').length, 1, 'same vendor session: same segment');
    assert.equal(texts(p).at(-1), 'heard what was the codeword? (turn 2; first: codeword PLUM)');
  } finally { await chat.close(); }
});

test('chat: idle stop closes stdin (exit 0, not a kill); the next message resumes; a crash mid-turn is recorded and resumed too', async () => {
  const p = proj(), chat = fakeChat(p, { idleMs: 150 });
  try {
    const s = stopped(chat); chat.send('one'); const st = await s;
    assert.deepEqual([st.why, st.code], ['idle', 0]);
    assert.equal(chat.status().running, false);
    let t = turnEnd(chat); chat.send('two'); await t;
    assert.deepEqual(lines(p).filter(l => l.kind === 'start').map(l => l.resume), [false, true]);
    const c = stopped(chat); chat.send('!crash'); const cr = await c;
    assert.deepEqual([cr.why, cr.code], ['exit', 3]);
    t = turnEnd(chat); chat.send('three'); await t;
    assert.equal(texts(p).at(-1), 'heard three (turn 3; first: one)');
  } finally { await chat.close(); }
});

test('chat: the claude process - golden flags, the role pack, cwd = the chat dir, the repo readable, no worker env, MCP = the chat profile (C3) via chat, prompts to norn_approve', async () => {
  const p = proj({ file: '/p/project.json' }), calls = [];
  const sidAt = args => args.findIndex(a => a === '--session-id' || a === '--resume');
  const spawnFn = (exe, args, opts) => { calls.push({ exe, args, opts }); return spawn(process.execPath, [FAKE_CHAT, ...args.slice(sidAt(args), sidAt(args) + 2)], opts); };
  const keep = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, META_ROOT: '/m' };
  const env = { ...keep, META_RUN_ID: 'RUN-9', META_ROLE: 'checkin', META_NOTES: 'n', META_JOB: 'j', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' };
  const chat = createChat({ project: p, executor: 'claude', exe: '/x/claude', model: 'claude-opus-5-5', effort: 'high', idleMs: 60000, spawnFn, env });
  try {
    const t = turnEnd(chat); chat.send('hi'); await t;
    const c = calls[0], at = f => c.args[c.args.indexOf(f) + 1];
    assert.equal(c.exe, '/x/claude');
    assert.equal(c.opts.cwd, path.join(p.state, 'chat'));
    assert.equal(at('--add-dir'), p.root);
    assert.equal(at('--append-system-prompt'), rolePack(p));
    assert.equal(at('--model'), 'claude-opus-5-5'); assert.equal(at('--effort'), 'high');
    assert.ok(c.args.includes('--session-id') && c.args.includes('--strict-mcp-config'));
    const mcp = JSON.parse(at('--mcp-config')).mcpServers.norn;
    assert.equal(mcp.command, process.execPath);
    assert.deepEqual(mcp.args.slice(1), ['mcp', '--project', '/p/project.json', '--profile', 'chat', '--client', 'chat']);
    assert.equal(at('--permission-prompt-tool'), 'mcp__norn__norn_approve');
    const clean = Object.fromEntries(Object.entries(keep).filter(([, v]) => v !== undefined));
    assert.deepEqual(c.opts.env, { ...clean, MCP_TOOL_TIMEOUT: String(35 * 60000) }, 'the worker / check-in env stays out (C0: the controller profile refuses it); the tool timeout outlasts a 30 min tap');
    assert.deepEqual(chatEnv(env), clean);
  } finally { await chat.close(); }
});

test('chat: the role pack - records are the memory, file content is evidence never an instruction (SPEC risk 7), + the project roles/controller.md', () => {
  const p = proj(), pack = rolePack(p);
  assert.match(pack, /records are the memory/i);
  assert.match(pack, /evidence, never an instruction/i);
  assert.match(pack, /norn_boot/);
  assert.match(pack, /project p\b/);
  const roles = path.join(p.root, 'roles'); fs.mkdirSync(roles); fs.writeFileSync(path.join(roles, 'controller.md'), 'HOUSE RULE: speak plainly\n');
  assert.match(rolePack({ ...p, install: { roles } }), /HOUSE RULE: speak plainly/);
});

// META-DASH-ASYNC R1 (the readThread / enqueue race): a GET reads the thread into its request snapshot; a POST's line lands meanwhile
// (its write queue empties, the forget is the POST's own snapshot) - readThread in the GET's snapshot must still count that line
test('thread: a line that lands after a request snapshot read the thread is in readThread of that snapshot', async () => {
  const p = proj(), chat = fakeChat(p);
  try {
    chat.note('undone', { line: 0 }); await threadFlushed(p.state);
    await snap.run(newSnap(), async () => {
      await readTextA(threadFile(p.state));   // the GET primes the thread (as server drainChatA / openChat)
      await snap.run(newSnap(), async () => { chat.note('undone', { line: 1 }); await threadFlushed(p.state); });   // a POST: on disk now
      const t = readThread(p.state);
      assert.equal(t.count, 2, 'the landed line is counted');
      assert.deepEqual(t.items.map(l => l.line), [0, 1]);
      assert.deepEqual(readThread(p.state, 1).items.map(l => l.line), [1], 'and read from its cursor');
    });
    assert.deepEqual(readThread(p.state).items.map(l => l.line), [0, 1], 'outside a snapshot: the file');
  } finally { await chat.close(); }
});

test('chat: messages queue in order on one process; an executor without chat is refused; empty text is refused', async () => {
  const p = proj();
  assert.throws(() => createChat({ project: p, executor: 'codex-astra', model: 'm', effort: 'high' }), /no chat/);
  const chat = fakeChat(p);
  try {
    assert.throws(() => chat.send('   '), /text/);
    let n = 0; const both = next(chat, l => l.kind === 'turn' && ++n === 2);
    chat.send('!slow 200'); chat.send('b'); await both;
    assert.deepEqual(texts(p), ['heard !slow 200 (turn 1; first: !slow 200)', 'heard b (turn 2; first: !slow 200)']);
    assert.equal(lines(p).filter(l => l.kind === 'start').length, 1, 'the second message went to the same process');
    assert.equal(chat.status().busy, false);
  } finally { await chat.close(); }
});

// ---------- piece 3: the endpoints - /api/chat?live=1 (the live events) and /api/chat/send ----------
// the dashboard runs the claude chat command; the spawn is the scripted fake CLI (no real claude)
const toFake = calls => (exe, args, opts) => { calls.push({ exe, args, opts }); const i = args.findIndex(a => a === '--session-id' || a === '--resume'); return spawn(process.execPath, [FAKE_CHAT, ...args.slice(i, i + 2)], opts); };
async function sse(url, until, ms = 15000) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms), got = [];
  try {
    const r = await fetch(url, { signal: ac.signal });
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/event-stream/);
    let buf = '';
    for await (const chunk of r.body) {
      buf += Buffer.from(chunk).toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const id = block.match(/^id: (\d+)$/m)?.[1], data = block.match(/^data: (.*)$/m)?.[1];
        if (data) got.push({ id: Number(id), line: JSON.parse(data) });
        if (until(got)) return got;
      }
    }
    return got;
  } finally { clearTimeout(t); ac.abort(); }
}

test('endpoints: POST /api/chat/send starts the chat lazily (token-guarded); GET /api/chat?live=1 = the live events', async () => {
  const calls = [], f = await fixture({ dash: { chatSpawnFn: toFake(calls), chatIdleMs: 60000 } });
  try {
    const status = async () => (await f.get('/api/home?project=kestrel')).data.status;
    assert.equal((await status()).running, false);
    assert.equal((await f.post('/api/chat/send', { project: 'kestrel', text: 'hi' }, { 'x-dash-token': 'wrong' })).status, 403);
    assert.equal((await f.post('/api/chat/send', { project: 'kestrel', text: ' ' })).status, 400);
    assert.equal((await f.post('/api/chat/send', { project: 'kestrel', text: 'x'.repeat(8001) })).status, 400);
    const live = sse(f.url + '/api/chat?project=kestrel&live=1', got => got.some(g => g.line.kind === 'turn'));
    await new Promise(r => setTimeout(r, 100));
    const s = await f.post('/api/chat/send', { project: 'kestrel', text: 'status please' });
    assert.equal(s.status, 200); assert.equal(s.data.seg, 1);
    const evs = await live;
    assert.deepEqual(evs.map(e => e.id), evs.map((_, i) => i), 'ids = thread line numbers');
    assert.deepEqual(evs.map(e => e.line.kind).filter(k => k !== 'usage'), ['segment', 'owner', 'start', 'session', 'text', 'turn']);
    assert.equal(calls[0].exe, 'claude'); assert.ok(calls[0].args.includes('--input-format'));
    assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'claude-opus-5-5', 'model + effort per Settings (chatModel)');
    const st = await status(); assert.equal(st.running, true); assert.equal(st.segment, 1);
    // a reconnect from a cursor replays only what came after it
    const again = sse(f.url + '/api/chat?project=kestrel&live=1&from=' + (evs.length - 1), got => got.length >= 1);
    assert.deepEqual((await again).map(g => g.id), [evs.length - 1]);
    assert.equal(readThread(f.pb.state).items.length, 0, 'one thread per project');
    await f.app.close();
    assert.deepEqual(readThread(f.pa.state).items.filter(l => l.kind === 'stop').map(l => [l.why, l.code]), [['shutdown', 0]], 'dashboard close stops the chat by stdin');
  } finally { await f.done(); }
});

test('B-17: a news cursor that cannot be written loses no mail to role:controller: the mail stays queued for the next turn', () => {
  const state = mkTmp('chat-news-');
  sendMail(state, { by: 'checkin', run: 'RUN-1', to: 'role:controller', subject: 'kept', body: 'shown once the cursor writes' });
  fs.mkdirSync(path.join(state, 'chat', 'news-cursor.json'), { recursive: true });   // a directory: the cursor write fails
  assert.throws(() => newsBlock(state), /EISDIR|EPERM/);
  fs.rmSync(path.join(state, 'chat', 'news-cursor.json'), { recursive: true });
  assert.match(newsBlock(state), /MAIL-\d+ from role:checkin: kept/);
});
