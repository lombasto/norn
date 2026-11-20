// /api/stream (META-VISUAL-B S1, META-QUEUE "Queued" 4: the #4 push channel): ONE Server-Sent-Events state stream per
// dashboard tab - record / run appends as they land, check-in / QUIET flags on change, a coalesced pulse while runs beat -
// replacing the 15 s full refetch. Silent when nothing changes; Last-Event-ID resumes without repeats.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { record } from '../engine/lib/records.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const DASH = { streamPollMs: 30, streamPulseMs: 200, streamLingerMs: 100 };

function sse(url, headers = {}) {
  const c = { events: [], status: null, lastId: null, closed: false, type: null };
  let buf = '';
  const req = http.get(url, { headers }, res => {
    c.status = res.statusCode; c.type = res.headers['content-type']; res.setEncoding('utf8');
    res.on('data', s => {
      buf += s;
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = { event: 'message', data: '' };
        for (const l of block.split('\n')) { const m = l.match(/^(\w+): ?(.*)$/); if (!m) continue; if (m[1] === 'data') ev.data += m[2]; else ev[m[1]] = m[2]; }
        if (ev.id !== undefined) c.lastId = ev.id;
        if (ev.data) { ev.json = JSON.parse(ev.data); c.events.push(ev); }
      }
    });
    res.on('end', () => { c.closed = true; });
  });
  req.on('error', () => { c.closed = true; });
  c.close = () => req.destroy();
  c.wait = async (pred, ms = 3000) => { const t = performance.now(); while (!pred(c)) { if (performance.now() - t > ms) throw new Error('timeout: ' + JSON.stringify(c.events.map(e => e.event))); await new Promise(r => setTimeout(r, 10)); } };
  return c;
}
const settle = ms => new Promise(r => setTimeout(r, ms));
const recs = c => c.events.filter(e => e.event === 'rec').flatMap(e => e.json.records.map(r => r.id ?? r.ev));

test('stream: hello with the flags, then each record append once (records + runs files), silent when idle', async () => {
  const f = await fixture({ dash: DASH });
  const c = sse(`${f.url}/api/stream?project=kestrel`);
  try {
    await c.wait(x => x.events.some(e => e.event === 'state'));
    assert.equal(c.status, 200); assert.match(c.type, /text\/event-stream/);
    const st = c.events.find(e => e.event === 'state').json;
    assert.deepEqual([st.project, st.paused, st.quiet, st.tick_locked], ['kestrel', false, false, false]);
    assert.equal(recs(c).length, 0, 'no backlog: the page fetches its tab itself');
    await settle(150);
    const idle = c.events.length;
    await settle(250);
    assert.equal(c.events.length, idle, 'nothing changed -> nothing sent');
    const d = record(f.pa.state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'hold', via: 'chat' } });
    const r = record(f.pa.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'gen' } });
    await c.wait(x => recs(x).includes(r.id) && recs(x).includes(d.id));
    const ev = c.events.find(e => e.event === 'rec' && e.json.file === 'runs');
    assert.equal(ev.json.project, 'kestrel'); assert.equal(ev.json.records[0].kind, 'run'); assert.equal(ev.json.records[0].ts, r.ts);
    await settle(150);
    assert.equal(recs(c).filter(x => x === d.id).length, 1, 'each append exactly once');
  } finally { c.close(); await f.done(); }
});

test('stream: PAUSED / QUIET / tick.lock flips arrive as one state event each; a partial line waits for its newline', async () => {
  const f = await fixture({ dash: DASH });
  const quiet = path.join(f.pa.root, '.superpowers', 'QUIET'); fs.mkdirSync(path.dirname(quiet), { recursive: true });
  const c = sse(`${f.url}/api/stream?project=kestrel`);
  try {
    await c.wait(x => x.events.some(e => e.event === 'state'));
    const states = () => c.events.filter(e => e.event === 'state').map(e => e.json);
    fs.writeFileSync(quiet, 'timed run\n');
    await c.wait(() => states().at(-1).quiet === true);
    fs.writeFileSync(path.join(f.pa.state, 'PAUSED'), 'x');
    await c.wait(() => states().at(-1).paused === true);
    fs.writeFileSync(path.join(f.pa.state, 'tick.lock'), 'busy');
    await c.wait(() => states().at(-1).tick_locked === true);
    await settle(120);
    assert.equal(states().length, 4, 'hello + three flips, no repeats');
    const file = path.join(f.pa.state, 'records.jsonl');
    const line = JSON.stringify({ seq: 9999, ts: new Date().toISOString(), kind: 'directive', ev: 'create', id: 'DIR-77', by: 'owner', data: { text: 'x' } });
    fs.appendFileSync(file, line.slice(0, 20));
    await settle(150);
    assert.ok(!recs(c).includes('DIR-77'), 'half a line is not a record yet');
    fs.appendFileSync(file, line.slice(20) + '\n');
    await c.wait(x => recs(x).includes('DIR-77'));
  } finally { c.close(); await f.done(); }
});

test('stream: heartbeats coalesce into at most one pulse per pulse window; Last-Event-ID resumes without repeats', async () => {
  const f = await fixture({ dash: DASH });
  let c = sse(`${f.url}/api/stream?project=kestrel`);
  try {
    await c.wait(x => x.events.some(e => e.event === 'state'));
    const hb = path.join(f.pa.state, 'hb');
    for (let i = 0; i < 6; i++) { fs.writeFileSync(path.join(hb, `x${i}.tmp`), '{}'); fs.renameSync(path.join(hb, `x${i}.tmp`), path.join(hb, 'RUN-2.hb')); await settle(25); }
    await c.wait(x => x.events.some(e => e.event === 'pulse'));
    await settle(260);
    // the property itself, independent of how long the 6 beats took under load: pulses at least one 200 ms window apart (server ts)
    const at = c.events.filter(e => e.event === 'pulse').map(e => Date.parse(e.json.ts));
    assert.ok(at.length >= 1, 'the beats pulse');
    for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= DASH.streamPulseMs, `pulses ${at[i] - at[i - 1]} ms apart, window ${DASH.streamPulseMs} ms`);
    const a = record(f.pa.state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'one', via: 'chat' } });
    await c.wait(x => recs(x).includes(a.id));
    const last = c.lastId; assert.ok(last, 'record events carry an id');
    c.close(); await settle(30);
    const b = record(f.pa.state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'two', via: 'chat' } });
    c = sse(`${f.url}/api/stream?project=kestrel`, { 'last-event-id': last });
    await c.wait(x => recs(x).includes(b.id));
    assert.ok(!recs(c).includes(a.id), 'the resumed stream starts after the last seen record');
  } finally { c.close(); await f.done(); }
});

test('stream: "all" watches every project; unknown project 404; the page no longer polls on a 15 s timer', async () => {
  const f = await fixture({ dash: DASH });
  const c = sse(`${f.url}/api/stream?project=all`);
  try {
    await c.wait(x => x.events.filter(e => e.event === 'state').length === 2);
    const q = record(f.pb.state, { kind: 'question', ev: 'create', by: 'controller', data: { title: 'other', lane: 'x' } });
    await c.wait(x => recs(x).includes(q.id));
    assert.equal(c.events.find(e => e.event === 'rec').json.project, 'other');
    assert.equal((await fetch(`${f.url}/api/stream?project=nope`)).status, 404);
    const html = await (await fetch(f.url + '/')).text();
    assert.ok(!/setInterval\(\s*render/.test(html), 'no full refetch timer');
    assert.match(html, /new EventSource\(`\/api\/stream/);
  } finally { c.close(); await f.done(); }
});

test('stream: a change the tabs show that is not a record (ledger, STATUS.md) arrives as one coalesced derived event', async () => {
  const f = await fixture({ dash: DASH });
  const c = sse(`${f.url}/api/stream?project=kestrel`);
  try {
    await c.wait(x => x.events.some(e => e.event === 'hello'));
    await settle(250);
    assert.equal(c.events.filter(e => e.event === 'derived').length, 0, 'nothing changed -> no derived event');
    fs.appendFileSync(f.pa.ledger, 'p31\n'); fs.appendFileSync(path.join(f.pa.state, 'STATUS.md'), 'RATE_OK=1\n');
    await c.wait(x => x.events.some(e => e.event === 'derived'));
    await settle(250);
    assert.equal(c.events.filter(e => e.event === 'derived').length, 1, 'two file changes in one window -> one event');
    fs.writeFileSync(path.join(f.pa.state, 'branches.json'), '{}');   // a branch scan landing (Scan now / the tick) repaints the Branches view
    await c.wait(x => x.events.filter(e => e.event === 'derived').length === 2);
  } finally { c.close(); await f.done(); }
});

test('stream (META-ROADMAP S2): a roadmap append arrives as a rec event (file roadmap) and /api/roadmap shows it on the refetch, within ~1 s', async () => {
  const f = await fixture({ dash: DASH });
  const c = sse(`${f.url}/api/stream?project=kestrel`);
  try {
    await c.wait(x => x.events.some(e => e.event === 'hello'));
    const t = record(f.pa.state, { kind: 'item', ev: 'create', by: 'controller', data: { title: 'Core', kind: 'theme' } }, { views: false });
    assert.equal((await f.get('/api/roadmap?project=kestrel')).data.counts.items, 0);
    const t0 = performance.now();
    const i = record(f.pa.state, { kind: 'item', ev: 'create', by: 'dashboard', data: { title: 'Seen live', kind: 'item', parent: t.id } }, { views: false });
    await c.wait(x => recs(x).includes(i.id));
    const ev = c.events.find(e => e.event === 'rec' && e.json.records.some(r => r.id === i.id));
    assert.equal(ev.json.file, 'roadmap');
    const d = (await f.get('/api/roadmap?project=kestrel')).data;
    assert.deepEqual(d.themes[0].children.map(x => x.title), ['Seen live']);
    assert.ok(performance.now() - t0 < 1500, `append -> event -> refetched tree in ${Math.round(performance.now() - t0)} ms`);
  } finally { c.close(); await f.done(); }
});

test('stream (DEC-341): an urgent() sig change goes out at once, outside the pulse window an earlier derived took; one event per change', async () => {
  const { createStreams } = await import('../engine/dash/stream.mjs');
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'norn-urgent-'));
  const s = createStreams({ pollMs: 20, pulseMs: 60000, lingerMs: 50 });
  const out = [];
  const res = { destroyed: false, writeHead() {}, on() {}, end() {}, write(t) { const m = /event: (\w+)/.exec(t); if (m) out.push(m[1]); return true; } };
  let sig = 'a', urgent = 'u0';
  try {
    assert.equal(await s.join('k', [{ project: 'p', files: {}, flags: () => ({}), hbDir: path.join(dir, 'hb'), sig: () => sig, urgent: () => urgent }], res), true);
    const n = () => out.filter(e => e === 'derived').length;
    const until = async (pred, ms) => { const t = performance.now(); while (!pred()) { if (performance.now() - t > ms) return false; await settle(10); } return true; };
    sig = 'b';   // an early cache landing takes the (60 s) window
    assert.ok(await until(() => n() === 1, 2000), 'the first change goes out (the window was free)');
    sig = 'c';   // an ordinary change inside the window waits for it
    await settle(150);
    assert.equal(n(), 1, 'an ordinary change inside the window waits');
    const t0 = performance.now();
    urgent = 'u1';   // the end of a rebuild the page shows as refreshing
    assert.ok(await until(() => n() === 2, 1000), `the urgent change goes out within ~pollMs, not after the window (${out.join(',')})`);
    assert.ok(performance.now() - t0 < 1000);
    await settle(150);
    assert.equal(n(), 2, 'one event per urgent change; the pending ordinary change rode on it');
  } finally { s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// CI 43999056272 (Windows): the Last-Event-ID resume above lost a record. A poll snapshots its clients, then awaits the records
// file's size / lines; a tab resuming DURING those awaits read the hub's not-yet-advanced cursor (no catch-up) and was not in the
// poll's snapshot (no live send): the record appended before the resume reached it by neither path. A join's catch-up now runs
// between polls, never inside one. Deterministic: the poll is held inside its stat while the tab resumes.
test('stream: a resume that lands while a poll is reading the records file gets the record exactly once (no lost append)', async () => {
  const { createStreams } = await import('../engine/dash/stream.mjs');
  const dir = mkTmp('norn-resume-'), f = path.join(dir, 'records.jsonl'), hb = path.join(dir, 'hb');
  fs.mkdirSync(hb); fs.writeFileSync(f, JSON.stringify({ id: 'DIR-1' }) + '\n');
  const s = createStreams({ pollMs: 10, pulseMs: 60000, lingerMs: 50 });
  const sink = () => { const out = []; return { out, res: { destroyed: false, writeHead() {}, on() {}, end() {}, write(t) {
    const e = /event: (\w+)/.exec(t)?.[1], d = /data: (.*)/.exec(t)?.[1], id = /id: (.*)/.exec(t)?.[1]; if (e) out.push({ e, d: d && JSON.parse(d), id }); return true; } } }; };
  const src = [{ project: 'p', files: { records: f }, flags: () => ({}), hbDir: hb }];
  const stat = fs.promises.stat;
  let gate = null, held = null;
  fs.promises.stat = async (p, ...a) => { if (gate && path.resolve(String(p)) === path.resolve(f)) { const g = gate; gate = null; held(); await g; } return stat(p, ...a); };
  try {
    const a = sink();
    assert.equal(await s.join('k', src, a.res), true);
    const cursor = a.out.find(x => x.e === 'hello').id;
    let release; const g = new Promise(r => { release = r; }), inPoll = new Promise(r => { held = r; });
    gate = g;
    fs.appendFileSync(f, JSON.stringify({ id: 'DIR-2' }) + '\n');
    await inPoll;   // a poll is now inside its stat of the records file, its client list already taken
    const b = sink(), { decodeCursor } = await import('../engine/dash/feed.mjs');
    const joined = s.join('k', src, b.res, decodeCursor(cursor));
    await settle(30);
    release();
    await joined;
    const got = () => b.out.filter(x => x.e === 'rec').flatMap(x => x.d.records.map(r => r.id));
    const t0 = performance.now();
    while (!got().includes('DIR-2') && performance.now() - t0 < 2000) await settle(10);
    await settle(60);
    assert.deepEqual(got(), ['DIR-2'], 'the resumed tab gets the record appended before it resumed, once');
    assert.deepEqual(a.out.filter(x => x.e === 'rec').flatMap(x => x.d.records.map(r => r.id)), ['DIR-2'], 'the first tab too, once');
  } finally { fs.promises.stat = stat; s.close(); }
});
