// dash-latency (owner 2026-11-18: "why norn can be slow to respond sometimes"): the page's render is not a request waterfall, one
// render fetches a URL once, and a render a newer one overtook never paints. Sandbox only: the shared dash fixture and a private
// headless browser; the page's fetch is wrapped so the test sees when each request starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';
import { record } from '../engine/lib/records.mjs';

// every request the page sends from now on: { u, t0 } (page clock); a URL matching slow waits `ms` before it goes out
const wrap = (slow, ms) => `(() => { window.__req = []; const of = window.__of ??= window.fetch, re = new RegExp(${JSON.stringify(slow)});
  window.fetch = async (u, ...a) => { window.__req.push({ u: String(u), t0: performance.now() }); if (re.test(String(u))) await new Promise(r => setTimeout(r, ${ms})); return of(u, ...a); }; return true; })()`;
const tap = id => `(() => { document.body.dataset.ready = ''; document.querySelector('#tab-${id}').click(); return true; })()`;

// the server's own timing log: Server-Timing on every answer; a slow request and a loop stall (with the requests in its window) in
// GET /api/timing and <norn>/local/dash-timing.jsonl
test('timing log: Server-Timing on every answer, slow requests and loop stalls in /api/timing and the jsonl', async () => {
  const f = await fixture({ dash: { slowMs: 0, stallMs: 200 } });
  try {
    const x = await fetch(f.url + '/api/lanes?project=kestrel'); await x.text();
    assert.match(x.headers.get('server-timing') ?? '', /^app;dur=[\d.]+, prime;dur=[\d.]+$/);
    const y = await fetch(f.url + '/ui.mjs'); await y.text();
    assert.match(y.headers.get('server-timing') ?? '', /^app;dur=[\d.]+$/, 'no snapshot read: no prime');
    // a request that blocks the server's loop for 600 ms (a listener after the handler: the request is being served) -> a stall naming it
    f.app.server.once('request', () => { const t = performance.now(); while (performance.now() - t < 600) { /* the loop is blocked */ } });
    await fetch(f.url + '/api/records?project=kestrel').then(r => r.text()); await new Promise(r => setTimeout(r, 300));
    const d = (await f.get('/api/timing')).data;
    assert.ok(d.slow.some(s => s.url === 'GET /api/lanes?project=kestrel' && s.status === 200 && Number.isFinite(s.prime)), JSON.stringify(d.slow));
    const st = d.stalls.find(s => s.ms >= 400);
    assert.ok(st, JSON.stringify(d.stalls));
    assert.ok(st.requests.includes('GET /api/records?project=kestrel'), JSON.stringify(st));
    assert.deepEqual([d.file_lost, d.file_error], [0, null], 'every entry reached the jsonl');
    await f.app.close();
    const lines = fs.readFileSync(path.join(f.root, 'local', 'dash-timing.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.ok(lines.some(l => l.kind === 'slow') && lines.some(l => l.kind === 'stalls' && l.ms >= 400), JSON.stringify(lines));
  } finally { await f.done(); }
});

// a fresh fixture's first deliverables answer and instruction scan land as a stream `derived` event at a random moment - its render
// rightly refetches /api/overview; a running dashboard has both cached, so they are warm before the page opens
async function warm(f) {
  const t0 = Date.now();
  for (;;) {
    const [d, i] = await Promise.all([f.get('/api/deliverables?project=kestrel'), f.get('/api/instructions?project=kestrel')]);
    if (!d.data.pending && !i.data.pending && !i.data.refreshing) return;
    if (Date.now() - t0 > 60000) throw new Error(`the fixture's caches are still cold after 60 s: ${JSON.stringify([d.data.pending, i.data])}`);
    await new Promise(r => setTimeout(r, 100));
  }
}

test('the browser: a tab render fetches the header and the tab at once, and /api/overview once', { skip: skipWhy, timeout: 180000 }, async () => {
  const f = await fixture(), pg = await openPage();
  try {
    await warm(f);
    await pg.go(`${f.url}/?project=kestrel&tab=lanes`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'lanes'`, 90000), 'Lanes painted');
    // the header's /api/overview is held 800 ms: the Inbox's own request must not wait behind it
    await pg.ev(wrap('/api/overview\\?', 800)); await pg.ev(tap('inbox'));
    assert.ok(await pg.until(`document.body.dataset.ready === 'inbox'`, 30000), 'Inbox painted');
    const r = await pg.ev('window.__req'), ov = r.find(x => x.u.startsWith('/api/overview?')), ib = r.find(x => x.u.startsWith('/api/inbox?'));
    assert.ok(ov && ib, JSON.stringify(r));
    assert.ok(ib.t0 - ov.t0 < 400, `the Inbox request went out ${Math.round(ib.t0 - ov.t0)} ms after the header's: a waterfall`);
    // the Overview tab reads /api/overview too: one request serves the header and the tab
    await pg.ev(wrap('^$', 0)); await pg.ev(tap('overview'));
    assert.ok(await pg.until(`document.body.dataset.ready === 'overview'`, 30000), 'Overview painted');
    const o = (await pg.ev('window.__req')).filter(x => x.u.startsWith('/api/overview?'));
    assert.equal(o.length, 1, JSON.stringify(o));
  } finally { await pg.close(); await f.done(); }
});

// CI-RED-F9957DF: a stream event the server sent before it served a click's reads is already in that render - the scheduled render
// it pokes is skipped (it fetched /api/overview a second time); the reads are held 2.5 s, the record's event goes out within the 1 s poll
test('the browser: a stream event sent before a render read its data does not refetch /api/overview', { skip: skipWhy, timeout: 180000 }, async () => {
  const f = await fixture(), pg = await openPage();
  try {
    await warm(f);
    await pg.go(`${f.url}/?project=kestrel&tab=lanes`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'lanes'`, 90000), 'Lanes painted');
    await pg.ev(wrap('/api/', 2500)); await pg.ev(tap('overview'));
    record(f.pa.state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'appended while the tab loads', via: 'chat' } });
    assert.ok(await pg.until(`document.body.dataset.ready === 'overview'`, 30000), 'Overview painted');
    await new Promise(r => setTimeout(r, 1000));   // a scheduled render would have sent its requests by now
    const o = (await pg.ev('window.__req')).filter(x => x.u.startsWith('/api/overview?'));
    assert.equal(o.length, 1, JSON.stringify(o));
  } finally { await pg.close(); await f.done(); }
});

test('the browser: a slow render that a click overtook does not paint over the newer tab', { skip: skipWhy, timeout: 180000 }, async () => {
  const f = await fixture(), pg = await openPage();
  try {
    await pg.go(`${f.url}/?project=kestrel&tab=lanes`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'lanes'`, 90000), 'Lanes painted');
    await pg.ev(wrap('/api/records\\?', 1500)); await pg.ev(tap('history'));   // History waits 1.5 s on its records ...
    await new Promise(r => setTimeout(r, 200));
    await pg.ev(tap('inbox'));                                                   // ... and Inbox is tapped meanwhile
    assert.ok(await pg.until(`document.body.dataset.ready === 'inbox'`, 30000), 'Inbox painted');
    await new Promise(r => setTimeout(r, 2000));                                 // the records fetch has answered by now
    const st = await pg.ev(`JSON.stringify({ ready: document.body.dataset.ready, tab: document.body.dataset.tab, error: document.querySelector('#error')?.textContent || '',
      inbox: /choose a relief model/.test(document.querySelector('#main #panel-inbox')?.textContent ?? ''), history: !!document.querySelector('#main #panel-history') })`);
    assert.deepEqual(JSON.parse(st), { ready: 'inbox', tab: 'inbox', error: '', inbox: true, history: false });
  } finally { await pg.close(); await f.done(); }
});
