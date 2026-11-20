// /api/feed (LANE-MAP-DESIGN 3, 4 slice 2): Server-Sent Events per run - one refcounted tailer per run, a 4-feed cap,
// Last-Event-ID = the cursor (a reconnect resumes without repeats), `head` on change, `end` when the run exits.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { record } from '../engine/lib/records.mjs';
import { fixture } from './helpers/dash-fixture.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASH = { feedPollMs: 40, feedLingerMs: 150 };

// a tiny EventSource: parses the stream; lastId = the id the browser would send back as Last-Event-ID
function sse(url, headers = {}) {
  const c = { events: [], status: null, lastId: null, closed: false };
  let buf = '';
  const req = http.get(url, { headers }, res => {
    c.status = res.statusCode; res.setEncoding('utf8');
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
  c.wait = async (pred, ms = 3000) => { const t = performance.now(); while (!pred(c)) { if (performance.now() - t > ms) throw new Error('timeout: ' + JSON.stringify(c.events.map(e => [e.event, e.json?.summary ?? e.json?.state]))); await new Promise(r => setTimeout(r, 15)); } return c; };
  return c;
}
const evs = c => c.events.filter(e => e.event === 'ev').map(e => e.json.summary);
const settle = ms => new Promise(r => setTimeout(r, ms));

async function withRun(fn, data = {}) {
  const f = await fixture({ dash: DASH });
  try {
    const log = path.join(f.pa.state, 'logs', 'gen-fake.log');
    fs.writeFileSync(log, 'booting\n');
    const r = record(f.pa.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'gen', log, budget_min: 60, ...data } });
    await fn({ f, log, id: r.id, url: `${f.url}/api/feed?project=kestrel&run=${r.id}` });
  } finally { await f.done(); }
}

test('feed: a fake run appends lines -> the client sees them live; head carries state / elapsed / budget', async () => withRun(async ({ f, log, id, url }) => {
  const c = sse(url);
  await c.wait(x => evs(x).includes('booting') && x.events.some(e => e.event === 'head'));
  assert.equal(c.status, 200);
  const head = c.events.find(e => e.event === 'head').json;
  assert.equal(head.run, id); assert.equal(head.state, 'running'); assert.equal(head.lane, 'gen'); assert.equal(head.budget_min, 60);
  assert.ok(Number.isFinite(head.elapsed_min)); assert.equal(head.dwarf, null); assert.equal(head.kind_word, 'worker');   // recorded by hand: no dwarf, the kind word
  fs.appendFileSync(log, 'step two\nstep three\n');
  await c.wait(x => evs(x).includes('step three'));
  assert.deepEqual(evs(c), ['booting', 'step two', 'step three']);
  c.close();
}));

test('feed: reconnect with Last-Event-ID resumes without repeats', async () => withRun(async ({ log, url }) => {
  fs.appendFileSync(log, 'one\ntwo\n');
  const a = sse(url);
  await a.wait(x => evs(x).includes('two'));
  const last = a.lastId; a.close();
  assert.ok(last, 'events carry an id');
  fs.appendFileSync(log, 'three\n');
  const b = sse(url, { 'last-event-id': last });
  await b.wait(x => evs(x).includes('three'));
  await settle(120);
  assert.deepEqual(evs(b), ['three']);
  b.close();
}));

test('feed: run end -> a final head + `end`, the stream closes; an ended run streams its tail then ends at once', async () => withRun(async ({ f, log, id, url }) => {
  const c = sse(url);
  await c.wait(x => evs(x).includes('booting'));
  fs.appendFileSync(log, '## DONE\n');
  record(f.pa.state, { kind: 'run', ev: 'end', id, by: 'launcher', data: { exit: 0, outcome: 'done' } });
  await c.wait(x => x.closed && x.events.some(e => e.event === 'end'));
  assert.ok(c.events.some(e => e.event === 'ev' && e.json.summary === '## DONE'), 'the last lines arrive before end');
  assert.equal(c.events.filter(e => e.event === 'head').at(-1).json.state, 'exited');
  const d = sse(url);
  await d.wait(x => x.closed);
  assert.deepEqual(d.events.map(e => e.event), ['ev', 'ev', 'head', 'end']);
}));

test('feed: one shared tailer per run (refcounted), stopped after the linger; a 5th live feed gets 429; unknown run 404', async () => withRun(async ({ f, url }) => {
  const a = sse(url), b = sse(url);
  await a.wait(x => evs(x).includes('booting')); await b.wait(x => evs(x).includes('booting'));
  assert.equal(f.app.feeds.tailers(), 1, 'two clients, one tailer');
  const c = sse(url), d = sse(url);
  await c.wait(x => x.status === 200); await d.wait(x => x.status === 200);
  const e = sse(url);
  await e.wait(x => x.closed);
  assert.equal(e.status, 429);
  for (const x of [a, b, c, d]) x.close();
  await settle(60);
  assert.equal(f.app.feeds.tailers(), 1, 'the tailer lingers after the last client leaves');
  await settle(400);
  assert.equal(f.app.feeds.tailers(), 0, 'then it stops');
  const n = sse(`${f.url}/api/feed?project=kestrel&run=RUN-99`);
  await n.wait(x => x.closed);
  assert.equal(n.status, 404);
}));

test('feed head: context from the latest usage event, last commit of the run worktree, the result (norn done) of THIS run', async () => {
  const f = await fixture({ dash: DASH });
  try {
    // the lane's notes file ends with an old "## HANDOFF" line: a log, never the chip
    const notes = path.join(f.root, 'NOTES.md'); fs.writeFileSync(notes, '# notes\nwork\n## HANDOFF\n');
    const old = new Date(Date.now() - 3600e3); fs.utimesSync(notes, old, old);
    // a claude run whose transcript is the feed fixture: usage -> head.ctx
    const sid = '22222222-3333-4444-8555-666666666666', dir = path.join(f.root, 'claude-projects', 'C--fx-wt');
    fs.copyFileSync(path.join(REPO, 'tests', 'fixtures', 'feed', 'claude.jsonl'), path.join(dir, sid + '.jsonl'));
    const r = record(f.pa.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'gen', session_id: sid, worktree: REPO, notes } });
    const c = sse(`${f.url}/api/feed?project=kestrel&run=${r.id}`);
    await c.wait(x => x.events.some(e => e.event === 'head' && e.json.commit));
    const h = c.events.filter(e => e.event === 'head').at(-1).json;
    assert.equal(h.ctx, 3 + 200 + 21500); assert.equal(h.executor, 'claude');
    assert.equal(h.marker, null, 'no result yet: no chip, whatever the NOTES say');
    assert.match(h.commit.sha, /^[0-9a-f]{7,}$/); assert.equal(typeof h.commit.subject, 'string');
    assert.ok(c.events.some(e => e.event === 'ev' && e.json.kind === 'tool' && e.json.name === 'Bash'));
    fs.mkdirSync(path.join(f.pa.state, 'results', r.id), { recursive: true });   // this run writes its result (norn done) -> the chip shows
    fs.writeFileSync(path.join(f.pa.state, 'results', r.id, 'result.json'), JSON.stringify({ v: 1, run: r.id, outcome: 'handoff', handoff: 'HANDOFF.md', at: new Date().toISOString() }));
    await c.wait(x => x.events.filter(e => e.event === 'head').at(-1).json.marker === 'HANDOFF');
    c.close();
  } finally { await f.done(); }
});
