// RM-46 S4 (multi-home SPEC 4.3): the sync loop - an ls-remote poll every poll_s (a moved head = one pass) and the optional ntfy doorbell
// (a ring from another home = a pass, its own ring ignored, a dropped stream reconnects with backoff, unset = poll only). Every edge is
// injected: ls-remote, the fetched heads, the pass, the ntfy stream and the timers. No network, no sleeps; synthetic homes and topics.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { syncLoop, watchDoorbell, movedHeads, parseHeads, ringOf, doorbellOf, ringHome, syncStep, LOOP } from '../engine/lib/sync.mjs';
import { ringDoorbell, doorbellStream } from '../engine/lib/notify.mjs';
import { ledgerConfig } from '../engine/lib/ledger.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const META = path.resolve('engine/bin/norn.mjs');
const SHA = c => c.repeat(40);
const ref = id => ['refs', 'heads', 'home', id].join('/');   // built, never a literal (the lint reads a slash-home-slash-name as a home path)
const CLAIMS = 'refs/heads/claims';
const FAKE_BELL = { server: 'http://127.0.0.1:1', topic: 'fake-bell-Zq81xT' };
// fake timers: setTimeout records { fn, ms }; fire() runs the oldest one
function timers() {
  const q = [];
  return { q, setTimeout: (fn, ms) => { const t = { fn, ms }; q.push(t); return t; }, clearTimeout: t => { const i = q.indexOf(t); if (i >= 0) q.splice(i, 1); },
    fire: async () => { const t = q.shift(); assert.ok(t, 'a timer is due'); await t.fn(); return t.ms; } };
}
// yields the event loop until cond() holds (bounded; no wall-clock wait)
async function until(cond) { for (let i = 0; i < 1000 && !cond(); i++) await new Promise(r => setImmediate(r)); assert.ok(cond(), 'condition reached'); }
const line = o => JSON.stringify(o);
const msg = (h, sha) => line({ id: 'x1', event: 'message', topic: FAKE_BELL.topic, message: JSON.stringify({ h, sha }) });
// one home "a" with a remote whose heads the test moves; the pass copies the remote heads into the fetched ones
function rig({ doorbell = null } = {}) {
  const remote = { [ref('a')]: SHA('a'), [ref('b')]: SHA('b'), [CLAIMS]: SHA('c') }, fetched = { ...remote }, passes = [], tm = timers();
  const loop = syncLoop({ home: () => 'a', lsRemote: async () => ({ ...remote }), known: async () => ({ ...fetched }),
    pass: async why => { passes.push(why); Object.assign(fetched, remote); return true; }, doorbell, timers: tm });
  return { remote, fetched, passes, tm, loop };
}

test('parseHeads / movedHeads: ls-remote lines to a map; this home\'s own branch never counts as moved', () => {
  const h = parseHeads(`${SHA('b')}\t${ref('b')}\n${SHA('c')}\t${CLAIMS}\nnot a line\n`);
  assert.deepEqual(h, { [ref('b')]: SHA('b'), [CLAIMS]: SHA('c') });
  assert.deepEqual(movedHeads({ [ref('a')]: SHA('1'), [ref('b')]: SHA('b') }, { [ref('a')]: SHA('2'), [ref('b')]: SHA('b') }, 'a'), []);
  assert.deepEqual(movedHeads({ [ref('b')]: SHA('b') }, { [ref('b')]: SHA('d'), [ref('c')]: SHA('e') }, 'a'), [ref('b'), ref('c')]);
  assert.deepEqual(movedHeads({ [ref('b')]: SHA('b') }, {}, 'a'), [ref('b')], 'a deleted branch is a move');
});

test('the poll: no change means no pass; a moved head means one pass; the next poll is due in poll_s', async () => {
  const r = rig();
  await r.loop.start();
  assert.deepEqual(r.passes, [], 'the fetched heads equal the remote: no fetch');
  assert.deepEqual(r.tm.q.map(t => t.ms), [LOOP.poll_s * 1000]);
  assert.equal(LOOP.poll_s, 30);
  r.remote[ref('a')] = SHA('9');   // this home's own push
  assert.equal(await r.tm.fire(), 30000);
  assert.deepEqual(r.passes, [], 'the own branch moving is no reason to fetch');
  r.remote[ref('b')] = SHA('d');
  await r.tm.fire();
  assert.equal(r.passes.length, 1);
  assert.match(r.passes[0], /moved/);
  await r.tm.fire();
  assert.equal(r.passes.length, 1, 'fetched now: the next poll does nothing');
  r.loop.stop();
  assert.deepEqual(r.tm.q, [], 'stop clears the timer');
});

test('a failed ls-remote or pass is logged, the loop keeps polling and retries the pass', async () => {
  const logs = [], tm = timers(); let fail = true, n = 0;
  const loop = syncLoop({ home: () => 'a', lsRemote: async () => { if (fail) throw new Error('offline'); return { [ref('b')]: SHA('d') }; }, known: async () => ({}),
    pass: async () => { n++; return n > 1; }, timers: tm, log: s => logs.push(s) });
  await loop.start();
  assert.match(logs.join('\n'), /offline/);
  assert.equal(tm.q.length, 1, 'still scheduled');
  fail = false; await tm.fire();
  assert.equal(n, 1);
  await tm.fire();
  assert.equal(n, 2, 'the fetched heads did not move: the pass runs again');
  loop.stop();
});

test('sync off (no home id): the loop polls nothing and stays scheduled', async () => {
  const tm = timers(); let calls = 0;
  const loop = syncLoop({ home: () => null, lsRemote: async () => { calls++; return {}; }, known: async () => ({}), pass: async () => true, timers: tm });
  await loop.start();
  assert.equal(calls, 0);
  assert.equal(tm.q.length, 1);
  loop.stop();
});

test('ringOf: only a ntfy message event with { h, sha } is a ring', () => {
  assert.deepEqual(ringOf(msg('b', SHA('d'))), { h: 'b', sha: SHA('d') });
  assert.equal(ringOf(line({ event: 'open' })), null);
  assert.equal(ringOf(line({ event: 'keepalive' })), null);
  assert.equal(ringOf(line({ event: 'message', message: 'hello' })), null);
  assert.equal(ringOf(line({ event: 'message', message: JSON.stringify({ h: 'B!', sha: SHA('d') }) })), null);
  assert.equal(ringOf('{ broken'), null);
});

test('the doorbell: a ring from another home starts a pass, the own ring is ignored', async () => {
  const lines = [line({ event: 'open' }), msg('a', SHA('1')), line({ event: 'keepalive' }), msg('b', SHA('2'))];
  let release; const held = new Promise(r => { release = r; });
  const open = async function* () { for (const l of lines) yield l; await held; };
  const r = rig({ doorbell: { open } });
  await r.loop.start();
  await until(() => r.passes.length === 1);
  assert.match(r.passes[0], /^ring b /);
  await new Promise(res => setImmediate(res));
  assert.equal(r.passes.length, 1, 'the own ring (h = a) started nothing');
  r.loop.stop(); release();
});

test('a dropped stream reconnects with backoff 5 s doubling to 5 min; an open event resets it', async () => {
  const tm = timers(), opened = [], rings = [];
  const script = [[], [], [line({ event: 'open' })], []];   // connection i yields script[i], then drops
  const open = async function* () { const i = opened.length; opened.push(i); if (i === 0) throw new Error('refused'); for (const l of script[i] || []) yield l; };
  const bell = watchDoorbell({ open, home: () => 'a', onRing: x => rings.push(x), timers: tm, log: () => {} });
  await until(() => tm.q.length === 1);
  assert.deepEqual(tm.q.map(t => t.ms), [5000], 'refused: retry in 5 s');
  await tm.fire(); await until(() => tm.q.length === 1);
  assert.deepEqual(tm.q.map(t => t.ms), [10000], 'dropped again: 10 s');
  await tm.fire(); await until(() => tm.q.length === 1);
  assert.deepEqual(tm.q.map(t => t.ms), [5000], 'an open event reset the backoff');
  assert.equal(opened.length, 3);
  bell.stop();
  assert.deepEqual(tm.q, []);
  const tm2 = timers(), waits = [];
  const b2 = watchDoorbell({ open: async function* () { yield* []; }, home: () => 'a', onRing: () => {}, timers: tm2, log: () => {} });
  for (let i = 0; i < 9; i++) { await until(() => tm2.q.length === 1); waits.push(tm2.q[0].ms); await tm2.fire(); }
  assert.deepEqual(waits, [5, 10, 20, 40, 80, 160, 300, 300, 300].map(s => s * 1000));
  b2.stop();
});

test('a ring during a pass is coalesced into one more pass, not dropped', async () => {
  const tm = timers(), passes = []; let go; const gate = new Promise(r => { go = r; });
  const lines = [msg('b', SHA('1')), msg('b', SHA('2')), msg('c', SHA('3'))];
  const open = async function* () { for (const l of lines) yield l; await new Promise(() => {}); };
  const loop = syncLoop({ home: () => 'a', lsRemote: async () => ({}), known: async () => ({}), pass: async why => { passes.push(why); if (passes.length === 1) await gate; return true; },
    doorbell: { open }, timers: tm });
  await loop.start();
  await until(() => passes.length === 1);
  go();
  await until(() => passes.length === 2);
  await new Promise(r => setImmediate(r));
  assert.equal(passes.length, 2, 'three rings, one pass running: one more pass');
  loop.stop();
});

test('ringDoorbell posts { h, sha } at ntfy priority min to the doorbell topic; doorbellStream reads <server>/<topic>/json', async () => {
  const sent = [];
  const transport = { post: async (url, o) => { sent.push({ url, ...o }); return { status: 200, text: '' }; },
    stream: (url, o) => { sent.push({ url, stream: true, signal: !!o.signal }); return (async function* () { yield 'x'; })(); } };
  await ringDoorbell(FAKE_BELL, { h: 'b', sha: SHA('d') }, { transport });
  assert.equal(sent[0].url, 'http://127.0.0.1:1/');
  const body = JSON.parse(sent[0].body);
  assert.deepEqual(body, { topic: FAKE_BELL.topic, message: JSON.stringify({ h: 'b', sha: SHA('d') }), priority: 1 });
  const got = []; for await (const l of doorbellStream(FAKE_BELL, { signal: new AbortController().signal, transport })) got.push(l);
  assert.deepEqual(got, ['x']);
  assert.equal(sent[1].url, `http://127.0.0.1:1/${FAKE_BELL.topic}/json`);
  await assert.rejects(ringDoorbell(FAKE_BELL, { h: 'b', sha: SHA('d') }, { transport: { post: async () => ({ status: 500, text: '' }) } }), /500/);
  await assert.rejects(ringDoorbell({ server: 'http://example.invalid' }, { h: 'b', sha: SHA('d') }, { transport }), /topic/);
});

// a synced home on a temp tree (no git needed: ringHome reads the manifest the publish wrote)
function home({ bell = FAKE_BELL } = {}) {
  const t = mkTmp('syncloop-home-'), meta = path.join(t, 'meta'), mf = path.join(meta, 'local', 'machine.json');
  const ledger = { dir: path.join(t, 'ledger.git'), state_root: path.join(meta, 'state'), reviews: path.join(t, 'reviews'), remote: 'file:///synthetic/ledger.git', ...(bell ? { doorbell: bell } : {}) };
  fs.mkdirSync(path.dirname(mf), { recursive: true }); fs.writeFileSync(mf, JSON.stringify({ ledger }));
  fs.mkdirSync(path.join(meta, 'state', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(meta, 'state', 'demo', 'home.json'), JSON.stringify({ id: 'b', bare_home: 'a' }));
  fs.mkdirSync(ledger.dir, { recursive: true });
  return { t, meta, mf, cfg: ledgerConfig({ ledger }, { metaRoot: meta, machineFile: mf }) };
}

test('doorbellOf / ringHome: the pushed head of this home rings; no doorbell or nothing pushed = off', async () => {
  const h = home(), sent = [];
  const transport = { post: async (url, o) => { sent.push(JSON.parse(o.body)); return { status: 200, text: '' }; } };
  assert.deepEqual(doorbellOf(h.cfg), FAKE_BELL);
  assert.deepEqual(await ringHome(h.cfg, { transport }), { nothing: true }, 'never pushed: nothing to ring');
  fs.writeFileSync(path.join(h.cfg.dir, 'home-manifest.json'), JSON.stringify({ head: SHA('e'), pushed: SHA('e'), files: {} }));
  assert.deepEqual(await ringHome(h.cfg, { transport }), { rung: SHA('e') });
  assert.deepEqual(JSON.parse(sent[0].message), { h: 'b', sha: SHA('e') });
  const off = home({ bell: null });
  assert.equal(doorbellOf(off.cfg), null);
  assert.deepEqual(await ringHome(off.cfg, { transport }), { off: true });
  assert.match((await ringHome(h.cfg, { transport: { post: async () => { throw new Error('down'); } } })).error, /down/, 'never throws');
});

test('syncStep rings after a push only when a doorbell is set (the ring runs outside the caller: a run end exits at once)', () => {
  const h = home(), rang = [];
  const r = syncStep(h.cfg, 'test', { publish: () => ({ sha: SHA('f'), pushed: true }), ring: cfg => rang.push(cfg.machine_file) });
  assert.match(r, /sync: home/);
  assert.deepEqual(rang, [h.mf]);
  syncStep(h.cfg, 'test', { publish: () => ({ offline: 'no network' }), ring: cfg => rang.push(cfg) });
  assert.equal(rang.length, 1, 'not pushed: no ring');
  const off = home({ bell: null });
  syncStep(off.cfg, 'test', { publish: () => ({ pushed: true }), ring: cfg => rang.push(cfg) });
  assert.equal(rang.length, 1, 'no doorbell: no ring');
});

test('norn sync watch | ring: sync off is an error; a bad flag is usage', () => {
  const t = mkTmp('syncloop-cli-'), env = { ...process.env, META_ROOT: path.join(t, 'meta') };
  fs.mkdirSync(path.join(t, 'meta', 'local'), { recursive: true });
  for (const sub of ['watch', 'ring']) {
    const r = spawnSync(process.execPath, [META, 'sync', sub], { env, encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 1, sub); assert.match(r.stderr, /sync is off/);
  }
  const u = spawnSync(process.execPath, [META, 'sync', 'watch', '--bogus'], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(u.status, 2); assert.match(u.stderr, /usage: norn sync/);
});
