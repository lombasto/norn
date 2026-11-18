// META-CHAT-CONTROLS R1 (owner DIR-58): the Home chat - a filter that holds across live updates and an empty view that says so;
// a model / effort picker and Claude-Code-like slash commands in the chat box; the raw-shell line in plain words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { record } from '../engine/lib/records.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

// CI 44335427788 (ubuntu, HANG RED): openPage threw (no DevTools port in 30 s) before the try, so the server made before it
// stayed open and held the file to the 600 s cap. openPage runs inside the try; the finally closes what was made.
test('R1 the browser: a Home filter stays pressed and applied across a live re-render', { skip: skipWhy, timeout: 120000 }, async () => {
  const f = await fixture(); let pg;
  try {
    pg = await openPage();
    assert.equal(await pg.go(`${f.url}/?project=kestrel&tab=home`), 'home');
    await pg.until('!!document.querySelector("[data-act=home-filter][data-filter=talk]")');
    await pg.ev('document.querySelector("[data-act=home-filter][data-filter=talk]").click()');
    const pressed = 'document.querySelector("[data-act=home-filter][aria-pressed=true]")?.dataset.filter';
    assert.equal(await pg.ev(pressed), 'talk', 'pressed after the click');
    await pg.ev('window.__mark = 1; document.querySelector("#main").dataset.mark = "old"');
    record(f.pa.state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'a live change', via: "cli" } });
    assert.ok(await pg.until('!document.querySelector("#main .home")?.closest("#main") || document.querySelector("#main").dataset.mark !== "old" || !document.querySelector("#main [data-act=home-filter]")?.isConnected || [...document.querySelectorAll(".home-r .hrow")].some(r => r.textContent.includes("a live change"))'), 'the page re-rendered live');
    assert.equal(await pg.ev(pressed), 'talk', 'still pressed after the live re-render');
  } finally { await pg?.close(); await f.done(); }
});

// ---------- the chat engine: the picker (a pick line) and the slash commands (engine/lib/chat.mjs) ----------
import fs from 'node:fs';
import path from 'node:path';
import { createChat, readThread, chatPick, chatCommands, NORN_COMMANDS } from '../engine/lib/chat.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const CHOICES = { models: ['fake-m', 'fake-s'], efforts: ['low', 'medium', 'high'], alias: { s: 'fake-s' } };
const proj = () => { const state = mkTmp('meta-chatc-', 'p'), root = path.join(path.dirname(path.dirname(state)), 'root'); fs.mkdirSync(root, { recursive: true }); return { name: 'p', state, root }; };
const fakeChat = (p, o = {}) => createChat({ project: p, executor: 'fake', model: 'fake-m', effort: 'high', idleMs: 60000, choices: CHOICES, ...o });
const next = (chat, pred, ms = 15000) => new Promise((res, rej) => {
  const t = setTimeout(() => { off(); rej(new Error('timeout waiting for a chat event')); }, ms);
  const off = chat.subscribe(l => { if (pred(l)) { clearTimeout(t); off(); res(l); } });
});
const turnEnd = chat => next(chat, l => l.kind === 'turn');
const lines = p => readThread(p.state).items;
const said = p => lines(p).filter(l => l.kind === 'norn').map(l => l.text);

test('R1 /model and /effort: a pick line, the next turn runs with it (same session, resumed), status shows pick + Settings default; default clears it', async () => {
  const p = proj(), chat = fakeChat(p);
  try {
    let t = turnEnd(chat); chat.send('hello'); await t;
    const r = chat.send('/model s');
    assert.equal(r.command, 'model'); assert.equal(r.sent, false, 'a Norn command is never sent to the model');
    chat.send('/effort low');
    assert.deepEqual(chatPick(lines(p)), { model: 'fake-s', effort: 'low' });
    const st = chat.status();
    assert.equal(st.model, 'fake-s'); assert.equal(st.effort, 'low'); assert.deepEqual(st.defaults, { model: 'fake-m', effort: 'high' }); assert.deepEqual(st.pick, { model: 'fake-s', effort: 'low' });
    t = turnEnd(chat); chat.send('again'); await t;
    const starts = lines(p).filter(l => l.kind === 'start');
    assert.equal(starts.length, 2, 'the idle process started with the old model is replaced'); assert.equal(starts[1].model, 'fake-s'); assert.equal(starts[1].effort, 'low'); assert.equal(starts[1].resume, true, 'same session');
    assert.equal(lines(p).filter(l => l.kind === 'segment').length, 1, 'the CLI resumes a session under another model: no new segment');
    assert.ok(lines(p).filter(l => l.kind === 'text').at(-1).text.includes('turn 2'), 'the conversation goes on');
    chat.send('/model default'); chat.send('/effort default');
    assert.equal(chatPick(lines(p)), null); assert.equal(chat.status().model, 'fake-m');
    chat.send('/model nope');
    assert.match(said(p).at(-1), /nope is not a model of this chat.*fake-m.*fake-s/);
    chat.send('/model');
    assert.match(said(p).at(-1), /model in use: fake-m \(the Settings default\)/);
    assert.ok(lines(p).filter(l => l.kind === 'owner').every(l => l.text.startsWith('/') ? l.cmd : true), 'a typed command is an owner line marked cmd');
  } finally { await chat.close(); }
});

test('a message folded into a running turn (one result for two sends) does not stall the chat: a Settings change still restarts it and the next message is answered', async () => {
  let shell = 'off';
  const p = proj(), chat = fakeChat(p, { config: () => ({ rawShell: shell }), settleMs: 300 });
  try {
    let t = turnEnd(chat); chat.send('!slow 400'); chat.send('!fold');
    assert.equal(chat.status().busy, true); assert.ok(Number.isFinite(chat.status().since), 'the state line has its clock');
    await t;
    shell = 'on';   // the owner turns on raw shell while Norn still counts the folded message as owed
    const r = chat.send('go on');
    assert.equal(r.queued, true, 'held in Norn until the restart'); assert.equal(chat.status().queued, 1);
    const end = await next(chat, l => l.kind === 'turn');
    assert.ok(end.ok);
    assert.match(lines(p).filter(l => l.kind === 'text').at(-1).text, /^heard go on/);
    assert.equal(lines(p).filter(l => l.kind === 'stop' && l.why === 'settings').length, 1, 'restarted once for the new setting');
  } finally { await chat.close(); }
});

test('R1 /clear = a new segment (fresh session, the records stay); /compact = the Norn hand-off; /cost and /help answer from Norn without a model turn', async () => {
  const p = proj(), chat = fakeChat(p);
  try {
    let t = turnEnd(chat); chat.send('hello'); await t;
    const done = next(chat, l => l.kind === 'handoff' && l.phase === 'done');
    chat.send('/compact');
    await done;
    assert.equal(lines(p).filter(l => l.kind === 'segment').at(-1).why, 'handoff', '/compact hands off to a new segment');
    t = turnEnd(chat); chat.send('after'); await t;
    const segs = () => lines(p).filter(l => l.kind === 'segment');
    const n = segs().length, c = next(chat, l => l.kind === 'segment');
    chat.send('/clear');
    await c;
    assert.equal(segs().length, n + 1); assert.equal(segs().at(-1).why, 'clear'); assert.notEqual(segs().at(-1).session_id, segs().at(-2).session_id);
    t = turnEnd(chat); chat.send('fresh'); await t;
    assert.match(lines(p).filter(l => l.kind === 'text').at(-1).text, /heard fresh \(turn 1; first: fresh\)/, 'a cleared chat starts a fresh conversation');
    const turns = lines(p).filter(l => l.kind === 'turn').length;
    chat.send('/cost'); chat.send('/usage'); chat.send('/help');
    assert.equal(lines(p).filter(l => l.kind === 'turn').length, turns, 'no model turn for /cost /usage /help');
    assert.match(said(p).at(-3), /chat today: \d+(\.\d)?k tokens · \d+ turns/); assert.equal(said(p).at(-2), said(p).at(-3));
    for (const k of Object.keys(NORN_COMMANDS)) assert.ok(said(p).at(-1).includes('/' + k), `/help names /${k}`);
  } finally { await chat.close(); }
});

test('R1 pass-through: a command the session lists (its init slash_commands) goes to the CLI verbatim; one it does not is refused in plain words, never sent', async () => {
  const p = proj(), chat = fakeChat(p);
  try {
    chat.send('/norn-ping');
    assert.match(said(p).at(-1), /not known yet.*starts/, 'before the first session Norn cannot know the commands: says so, sends nothing');
    assert.equal(lines(p).filter(l => l.kind === 'turn').length, 0);
    let t = turnEnd(chat); chat.send('hello'); await t;
    assert.ok(chatCommands(lines(p)).includes('norn-ping'), 'the session init lists its commands');
    t = turnEnd(chat); const r = chat.send('/norn-ping now'); await t;
    assert.equal(r.sent, true);
    assert.match(lines(p).filter(l => l.kind === 'text').at(-1).text, /^heard \/norn-ping now \(/, 'verbatim: no news block in front of a command');
    const turns = lines(p).filter(l => l.kind === 'turn').length;
    chat.send('/nosuch');
    assert.match(said(p).at(-1), /\/nosuch is not a command of this chat.*Not sent/);
    assert.equal(lines(p).filter(l => l.kind === 'turn').length, turns);
    chat.send('/ not a command, a path');
    assert.equal(lines(p).filter(l => l.kind === 'owner').at(-1).cmd, undefined, 'a slash followed by a space is text');
  } finally { await chat.close(); }
});

// ---------- the server: POST /api/chat/pick (this chat), POST /api/chat/default (= the Settings rows), the Home status ----------
test('R1 server: a pick shows on /api/home as in use (with the Settings default beside it); make default writes the chat_model / chat_effort rows and clears the pick', async () => {
  const f = await fixture();
  try {
    let h = (await f.get('/api/home?project=kestrel')).data.status;
    const def = h.model;
    assert.equal(h.pick, null); assert.deepEqual(h.defaults, { model: def, effort: h.effort });
    let r = await f.post('/api/chat/pick', { project: 'kestrel', model: 'claude-sonnet-5-5', effort: 'low' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    h = (await f.get('/api/home?project=kestrel')).data.status;
    assert.equal(h.model, 'claude-sonnet-5-5'); assert.equal(h.effort, 'low'); assert.deepEqual(h.pick, { model: 'claude-sonnet-5-5', effort: 'low' }); assert.equal(h.defaults.model, def);
    assert.equal((await f.post('/api/chat/pick', { project: 'kestrel', model: 'gpt-x' })).status, 400, 'a model the chat cannot run is a 400');
    r = await f.post('/api/chat/default', { project: 'kestrel' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    h = (await f.get('/api/home?project=kestrel')).data.status;
    assert.equal(h.pick, null, 'the default is the Settings row now: one source of truth');
    assert.equal(h.model, 'claude-sonnet-5-5'); assert.equal(h.effort, 'low'); assert.deepEqual(h.defaults, { model: 'claude-sonnet-5-5', effort: 'low' });
    const b = JSON.parse(fs.readFileSync(f.budgetFile, 'utf8'));
    assert.equal(b.chat_model, 'claude-sonnet-5-5', 'the Settings row is written'); assert.equal(b.chat_effort, 'low');
    r = await f.post('/api/chat/send', { project: 'kestrel', text: '/model' });
    assert.equal(r.status, 200); assert.equal(r.data.sent, false); assert.match(r.data.text, /model in use: claude-sonnet-5-5 \(the Settings default\).*opus/);
  } finally { await f.done(); }
});

// ---------- the Home renderers (engine/dash/home.mjs) ----------
import { homeEvents, renderThread, renderHome, slashMenu, shellLine } from '../engine/dash/home.mjs';
const TS = '2026-11-14T10:00:00.000Z';
const RUNEV = [{ key: 'r1', ts: TS, cat: 'run', kind: 'run-start', run: 'RUN-1', lane: 'x' }];
test('R1 an empty filter says so: "you + controller" explains this chat (separate from a VS Code / terminal session, type below); other filters name what is missing', () => {
  const talk = renderThread(RUNEV, { filter: 'talk', project: 'norn' });
  assert.match(talk, /<li class="thread-empty[^"]*"[^>]*>/);
  assert.match(talk, /Norn's own controller chat for norn/); assert.match(talk, /separate from any Claude Code session.*VS Code.*terminal/); assert.match(talk, /type below to start/i);
  assert.match(renderThread(RUNEV, { filter: 'merge' }), /thread-empty[^>]*>No merges in the thread yet/);
  assert.doesNotMatch(renderThread(RUNEV, { filter: 'run' }), /thread-empty/, 'a filter with items shows them, no empty state');
  assert.doesNotMatch(renderThread(RUNEV, { filter: 'all' }), /thread-empty/);
});
test("R1 Norn's command answers and typed commands render in the thread; the pick line is no event", () => {
  const ev = homeEvents({ thread: [{ ts: TS, seg: 1, kind: 'owner', text: '/help', cmd: 'help' }, { ts: TS, seg: 1, kind: 'norn', text: 'Norn chat commands:\n/model - x', cmd: 'help' }, { ts: TS, seg: 1, kind: 'pick', model: 'a', effort: null }] });
  assert.deepEqual(ev.map(e => e.kind), ['you', 'norn']);
  const html = renderThread(ev, {});
  assert.match(html, /class="ev ev-norn"/); assert.match(html, /norn · 10:00/); assert.match(html, /Norn chat commands:/);
});
const STATUS = { executor: 'claude', model: 'claude-sonnet-5-5', effort: 'low', pick: { model: 'claude-sonnet-5-5', effort: 'low' }, defaults: { model: 'claude-opus-5-5', effort: 'medium' },
  choices: { models: ['claude-opus-5-5', 'claude-sonnet-5-5'], efforts: ['low', 'medium', 'high', 'xhigh'] }, raw_shell: 'off', commands: ['clear', 'norn-ping'],
  norn_commands: { model: 'the chat model', help: 'this list' } };
test('R1 the picker on the chat bar: what is in use vs the Settings default, model + effort selects, apply, make default; the shell line in plain words opens its Settings row', () => {
  const html = renderHome({ project: 'norn', events: [], status: STATUS, side: {} }, { project: 'norn' });
  assert.match(html, /<details class="hpick"/);
  assert.match(html, /<summary[^>]*>[\s\S]*Claude Code · sonnet[\s\S]*low/);
  assert.match(html, /<select id="pick-model"[\s\S]*<option value="claude-sonnet-5-5" selected>/); assert.match(html, /<select id="pick-effort"[\s\S]*<option value="low" selected>/);
  assert.match(html, /data-act="chat-pick"/); assert.match(html, /data-act="chat-default"(?![^>]*disabled)/, 'a pick can become the default');
  assert.match(html, /picked for this chat[\s\S]*Settings default: opus · medium/);
  assert.doesNotMatch(html, /acts through Norn verbs/, 'the old jargon line is gone');
  assert.match(html, /data-act="open-setting" data-setting="chat_raw_shell"[^>]*>[^<]*no shell, no file edits/);
  assert.match(html, /hpick[\s\S]*cannot run shell commands or edit files[\s\S]*paired phone/, 'the picker area says it in full');
  const def = renderHome({ project: 'norn', events: [], status: { ...STATUS, pick: null, model: 'claude-opus-5-5', effort: 'medium' }, side: {} }, {});
  assert.match(def, /data-act="chat-default"[^>]*disabled/); assert.match(def, /the Settings default/);
  assert.match(shellLine('ask').long, /only after you approve each one/); assert.match(shellLine('on').long, /with no tap/);
});
test('R1 the "/" menu: Norn\'s commands first (with what they do), then the session\'s own; filtered by what is typed; none past a space', () => {
  const all = slashMenu('/', STATUS);
  assert.match(all, /data-slash="\/model"[\s\S]*the chat model[\s\S]*data-slash="\/help"[\s\S]*data-slash="\/clear"[\s\S]*data-slash="\/norn-ping"/);
  assert.match(slashMenu('/no', STATUS), /norn-ping/); assert.doesNotMatch(slashMenu('/no', STATUS), /\/model/);
  assert.equal(slashMenu('/model x', STATUS), ''); assert.equal(slashMenu('hello', STATUS), '');
  assert.match(slashMenu('/', { ...STATUS, commands: null }), /listed once the chat has started/);
});

// ---------- the browser: the filter across a reload, the "/" menu, the picker, the shell line's tap ----------
test('R1 the browser: the filter survives a reload (URL); the empty "you + controller" view; "/" opens the menu; the picker applies a model; the shell line opens its Settings row', { skip: skipWhy, timeout: 180000 }, async () => {
  const f = await fixture(); let pg;
  try {
    pg = await openPage();
    assert.equal(await pg.go(`${f.url}/?project=kestrel&tab=home`), 'home');
    await pg.until('!!document.querySelector("[data-act=home-filter][data-filter=talk]")');
    await pg.ev('document.querySelector("[data-act=home-filter][data-filter=talk]").click()');
    assert.match(await pg.ev('location.search'), /filter=talk/, 'the filter is in the URL');
    assert.match(await pg.until('document.querySelector("#thread .thread-empty")?.textContent'), /separate from any Claude Code session/, 'the empty chat view says what it is');
    assert.equal(await pg.go(await pg.ev('location.href')), 'home');
    assert.equal(await pg.until('document.querySelector("[data-act=home-filter][aria-pressed=true]")?.dataset.filter'), 'talk', 'a reload keeps the filter');
    // the "/" menu
    await pg.ev('(() => { const t = document.querySelector("#chat-text"); t.focus(); t.value = "/"; t.dispatchEvent(new Event("input", { bubbles: true })); })()');
    const menu = await pg.until('!document.querySelector("#slash-menu").hidden && document.querySelector("#slash-menu").textContent');
    assert.match(menu, /\/model[\s\S]*\/effort[\s\S]*\/clear[\s\S]*\/help/);
    await pg.ev('document.querySelector("#slash-menu [data-slash=\'/effort\']").click()');
    assert.equal(await pg.ev('document.querySelector("#chat-text").value'), '/effort ');
    // the picker: open, choose sonnet, apply -> the chip says sonnet
    await pg.ev('document.querySelector("details.hpick").open = true');
    await pg.ev('(() => { const s = document.querySelector("#pick-model"); s.value = "claude-sonnet-5-5"; s.dispatchEvent(new Event("change", { bubbles: true })); })()');
    await pg.ev('document.querySelector("[data-act=chat-pick]").click()');
    assert.match(await pg.until('(t => t.includes("sonnet") && t)(document.querySelector(".hpick summary").textContent)'), /sonnet/, 'the chip shows the picked model');
    assert.equal(await pg.ev('document.querySelector("details.hpick").open'), true, 'the picker stays open across the repaint');
    assert.equal(await pg.ev('document.querySelector("[data-act=chat-default]").disabled'), false);
    // the shell line opens the Settings row
    await pg.ev('document.querySelector("button.hnote[data-act=open-setting]").click()');
    assert.equal(await pg.until('document.body.dataset.ready === "settings" && document.body.dataset.ready'), 'settings');
    assert.equal(await pg.until('(e => e && e.offsetParent !== null)(document.querySelector("#set-chat_raw_shell"))'), true, 'the chat_raw_shell row is shown');
  } finally { await pg?.close(); await f.done(); }
});

import { adapterFor } from '../engine/lib/harness/index.mjs';
test("R1 a passed-through local command's reply (the CLI's synthetic assistant line, all-zero usage) is no context reading", () => {
  const evs = adapterFor('claude').chatEvents(JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: '## Context Usage' }],
    usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } } }));
  assert.deepEqual(evs.map(e => e.kind), ['text'], 'text yes, a 0-token usage no (it would reset the context meter to 0k)');
  const init = adapterFor('claude').chatEvents(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', slash_commands: ['context', 'norn-ping'] }));
  assert.deepEqual(init[0].commands, ['context', 'norn-ping']);
});

// META-CI-WORKCLASS R2 (DEC-332): a page that never sets body.dataset.ready fails pg.go / pg.until WITH ITS STATE (the step it reached,
// its dataset, console errors, unhandled rejections, the fetches still pending and their age), never a bare undefined.
import http from 'node:http';
test('R2 a stalled page: go() and until() fail naming the step, the pending fetch, the console error and the unhandled rejection', { skip: skipWhy, timeout: 60000 }, async () => {
  const html = `<!doctype html><body><script type="module">document.body.dataset.step = 'boot'; console.error('toy-boom');
    Promise.reject(new Error('toy-rejected')); document.body.dataset.step = 'fetch'; await fetch('/api/never'); document.body.dataset.ready = 'home';</script></body>`;
  const srv = http.createServer((q, r) => { if (q.url === '/api/never') return; r.writeHead(200, { 'content-type': 'text/html' }); r.end(html); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  let pg;
  try {
    pg = await openPage();
    await assert.rejects(pg.go(`http://127.0.0.1:${srv.address().port}/`, 1500), e => {
      assert.match(e.message, /body\.dataset\.ready.*1500 ms/); assert.match(e.message, /readyState[^\n]*complete/); assert.match(e.message, /"step":"fetch"/);
      assert.match(e.message, /pending[^\n]*\/api\/never[^\n]*\d+ ms/); assert.match(e.message, /toy-boom/); assert.match(e.message, /toy-rejected/);
      return true;
    });
    await assert.rejects(pg.until('document.body.dataset.ready', 500), /until\(document\.body\.dataset\.ready\) still falsy after 500 ms[\s\S]*"step":"fetch"/);
  } finally { await pg?.close(); srv.closeAllConnections(); await new Promise(r => srv.close(r)); }
});

// META-CI-WORKCLASS R3 (DEC-333): a go() timeout also tells WHOSE stall it was - the test process's own event loop (its max gap,
// its CPU time, the box's CPU) and when this process's server received and answered each request. Toy: the loop is blocked ~1.2 s.
import { watchServer } from './helpers/loopwatch.mjs';
test('R3 a stalled test process: a go() timeout names the event-loop gap, the CPU used and the server-side request timings', { skip: skipWhy, timeout: 60000 }, async () => {
  const html = `<!doctype html><body><script type="module" src="/toy-a.mjs"></script></body>`;
  const srv = http.createServer((q, r) => { if (q.url === '/api/never') return;
    if (q.url === '/toy-a.mjs') { r.writeHead(200, { 'content-type': 'text/javascript' }); return r.end(`await fetch('/api/never');`); }
    r.writeHead(200, { 'content-type': 'text/html' }); r.end(html); });
  watchServer(srv);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  let pg;
  try {
    pg = await openPage();
    const going = pg.go(`http://127.0.0.1:${srv.address().port}/`, 3000);
    setTimeout(() => { const t = Date.now(); while (Date.now() - t < 1200) { /* the blocked loop */ } }, 50);
    await assert.rejects(going, e => {
      const gap = Number(e.message.match(/loop: max gap (\d+) ms/)?.[1]);
      assert.ok(gap >= 1000, `the gap is measured: ${e.message}`);
      assert.match(e.message, /cpu: process \d+ ms user \+ \d+ ms system in \d+ ms wall[^\n]*box \d+ % busy/);
      assert.match(e.message, /served:[^\n]*\/toy-a\.mjs \+\d+ ms -> \d+ ms/); assert.match(e.message, /served:[^\n]*\/api\/never \+\d+ ms -> unanswered/);
      assert.match(e.message, /busiest stack: [^\n]*chat-controls\.test\.mjs:\d+[^\n]* \d+ ms/, `the profile names the blocking frame: ${e.message}`);
      return true;
    });
  } finally { await pg?.close(); srv.closeAllConnections(); await new Promise(r => srv.close(r)); }
});

// META-CI-WORKCLASS R4 (DEC-336): name the blocking CALL. (a) any CDP wait (not only pg.go) logs the loop report when slow;
// (b) a sampling profile (node --cpu-prof) names a sync call that blocks the loop by its JS caller; (c) every stdout / stderr write is timed.
import { mark, slowStep, timeWrites, loopReport } from './helpers/loopwatch.mjs';
import { stalls } from './helpers/profgap.mjs';
import { spawnSync } from 'node:child_process';
const blockFor = ms => { const t = Date.now(); while (Date.now() - t < ms) { /* the blocked loop */ } };
test('R4 a slow step (any CDP wait) logs the loop report; a quick one logs nothing', async () => {
  const logged = [];
  const quick = mark(); assert.equal(await slowStep(quick, 'quick', { log: s => logged.push(s) }), null);
  const m = mark(); blockFor(700); await new Promise(r => setTimeout(r, 250));
  const r = await slowStep(m, 'toy wait', { log: s => logged.push(s) });
  assert.match(r, /^slow toy wait: \d+ ms\nloop: max gap (\d+) ms/); assert.ok(Number(r.match(/max gap (\d+)/)[1]) >= 500, r);
  assert.deepEqual(logged, [r]);
});
test('R4 a write to stdout / stderr that takes > 100 ms is logged with its stream and size and named in the loop report', async () => {
  const logged = [], fake = { write(chunk) { blockFor(150); return true; } };
  const m = mark(); timeWrites(fake, 'toy', s => logged.push(s)); fake.write('abc'); fake.write(Buffer.alloc(0));
  await new Promise(r => setImmediate(r));
  assert.deepEqual(logged.length, 2); assert.match(logged[0], /^slow write: toy 3 bytes took \d+ ms/);
  assert.match(await loopReport(m), /\nwrites: toy 3 bytes \d+ ms at \+\d+ ms, toy 0 bytes/);
});
test('R4 a node --cpu-prof profile names the JS caller of a sync wait that blocked the loop (stall > 500 ms)', () => {
  const d = mkTmp('meta-prof-'), f = path.join(d, 'toy.mjs');
  fs.writeFileSync(f, 'function blockedHere() { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800); }\nblockedHere();\n');
  const r = spawnSync(process.execPath, ['--cpu-prof', `--cpu-prof-dir=${path.join(d, 'prof')}`, f], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const p = fs.readdirSync(path.join(d, 'prof')).find(n => n.endsWith('.cpuprofile'));
  const s = stalls(JSON.parse(fs.readFileSync(path.join(d, 'prof', p), 'utf8')));
  assert.ok(s.length && s[0].ms >= 600, JSON.stringify(s)); assert.match(s[0].stack, /blockedHere [^\n]*toy\.mjs:1/);
  const cli = spawnSync(process.execPath, [path.join(import.meta.dirname, 'helpers', 'profgap.mjs'), d], { encoding: 'utf8' });
  assert.match(cli.stdout, /stall \d+ ms at \+\d+ ms: blockedHere/);
});
