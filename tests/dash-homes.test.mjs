// RM-46 S3 (multi-home SPEC 4.7, sec. 8 S3): the combined views. Kestrel of the shared dash fixture is a synced project (home a, the bare
// home) with a synthetic copy from home b (dash-fixture homeCopy): Roadmap / Records / Inbox / Lanes / Runs show b's rows with an "on b"
// chip (runs and deliverables read-only), an answer on b's question is a pending event in a's own log, and the Ledger page carries the
// Homes and Claims blocks (a temp ledger repo with synthetic refs). Sandbox only: temp dirs, a fixture git repo, a private headless browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readEvents, recordsFile } from '../engine/lib/records.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { main } from '../engine/bin/norn.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

const GENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
const git = (dir, args, input) => execFileSync('git', args, { env: { ...GENV, GIT_DIR: dir }, input, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const NOW = Date.now(), iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
// a ledger bare repo as the fetch leaves it: b's fetched home ref (under refs/sync/home/) and refs/sync/claims (b's work claim on slop, stale on a's clock; a's merge leader)
function ledgerRepo(L, stateRoot) {
  execFileSync('git', ['init', '-q', '--bare', L], { env: GENV, windowsHide: true });
  const tree = files => git(L, ['mktree'], Object.entries(files).map(([n, v]) => typeof v === 'string' ? `040000 tree ${v}\t${n}` : `100644 blob ${git(L, ['hash-object', '-w', '--stdin'], JSON.stringify(v))}\t${n}`).join('\n') + '\n');
  const work = { v: 1, kind: 'work', project: 'kestrel', home: 'b', lane: 'slop', branch: 'norn/b/slop', items: ['RM-b-2'], scope: ['engine/lib/slop/**'], touched: [], run: 'RUN-b-1',
    nonce: 'n-1', n: 4, claimed_at: iso(NOW - 3 * 3600e3), renewed_at: iso(NOW - 3 * 3600e3), lease_s: 3600 };
  const leader = { v: 1, kind: 'leader', role: 'merge', project: 'kestrel', home: 'a', nonce: 'n-2', n: 9, claimed_at: iso(NOW - 600e3), renewed_at: iso(NOW - 60e3), lease_s: 3600 };
  const claims = tree({ work: tree({ kestrel: tree({ b: tree({ 'slop.json': work }) }) }), leader: tree({ kestrel: tree({ 'merge.json': leader }) }),
    homes: tree({ 'b.json': { v: 1, kind: 'home', id: 'b', branch: 'home/b', projects: ['kestrel'], joined_at: iso(NOW - 864e5) } }) });
  git(L, ['update-ref', 'refs/sync/claims', git(L, ['commit-tree', claims, '-m', 'claims'])]);
  git(L, ['update-ref', 'refs/sync/home/' + 'b', git(L, ['commit-tree', tree({ 'x.json': { v: 1 } }), '-m', 'home/b: publish'])]);
  fs.writeFileSync(path.join(L, 'sync-fetch.json'), JSON.stringify({ fetched_at: iso(NOW - 30e3), fetch_error: null, failed_at: null, gone: [] }));
  // the observer's clock: b's claim seen at n=4 for 3 h on a (lease 1 h + grace = stale)
  fs.mkdirSync(path.join(stateRoot, 'kestrel', 'sync'), { recursive: true });
  fs.writeFileSync(path.join(stateRoot, 'kestrel', 'sync', 'claims-seen.json'), JSON.stringify({ 'work/kestrel/b/slop.json': { n: 4, first_seen_ms: NOW - 3 * 3600e3 } }));
  return L;
}
// the synced fixture + its ledger repo (the fixture's machine.json ledger points at <root>/ledger.git; the dash reads it per request)
async function fx() { const f = await fixture({ synced: true }); ledgerRepo(f.ledgerDir, path.dirname(f.pa.state)); return f; }
const has = (html, re, what) => assert.ok(re.test(html), `${what} (${re})`);   // never the whole page in the failure

test('rows, chips and pending: Inbox, Lanes, Runs, Records, Roadmap and Deliverables carry b\'s rows with an "on b" chip; runs and DLVs are read-only', { timeout: 120000 }, async () => {
  const f = await fx();
  try {
    const inbox = (await f.get('/api/inbox?project=kestrel')).data, q = inbox.items.find(i => i.id === 'Q-b-1');
    assert.equal(q?.home, 'b', 'the foreign question is in the inbox with its home');
    assert.equal(inbox.items.find(i => i.id === 'Q-1')?.home ?? null, null, 'an own (bare) question has no home chip');
    has(renderTab('inbox', inbox, { now: Date.now() }), /id="q-Q-b-1"[\s\S]*?class="chip home"[^>]*>on b</, 'the inbox card shows "on b"');

    const lanes = (await f.get('/api/lanes?project=kestrel')).data.lanes, l = lanes.find(x => x.id === 'L:b/slop');
    assert.equal(l?.home, 'b', JSON.stringify(lanes.map(x => [x.id, x.home])));
    has(renderTab('lanes', { lanes }, { now: Date.now(), laneShow: ['needs', 'running', 'stopped', 'waiting', 'land', 'parked', 'today', 'old', 'archived'] }), /class="chip home"[^>]*>on b</, 'the lane row shows "on b"');

    const ag = (await f.get('/api/agents?project=kestrel&window=24h')).data, r = ag.tree.find(n => n.id === 'RUN-b-1');
    assert.ok(r, 'the foreign run is in the Runs tree: ' + JSON.stringify(ag.tree.map(n => n.id)));
    assert.deepEqual([r.home, r.readonly, r.state, r.lane], ['b', true, 'running', 'b/slop']);
    const runsHtml = renderTab('runs', ag, { now: Date.now() });
    has(runsHtml, /id="node-RUN-b-1"[\s\S]*?class="chip home"[^>]*>on b</, 'the run row shows "on b"');
    assert.doesNotMatch(runsHtml.match(/<div class="node lvl0" id="node-RUN-b-1"[^>]*>/)[0], /data-feed/, 'a foreign run opens no live feed (read-only)');

    const dl = (await f.get('/api/deliverables?project=kestrel')).data, d = dl.rows.find(x => x.id === 'DLV-b-1');
    assert.deepEqual([d?.home, d?.readonly, d?.lane], ['b', true, 'b/slop'], JSON.stringify(dl.rows));

    record_dir_b(f);
    const rec = (await f.get('/api/records?project=kestrel')).data, dir = rec.directives.find(x => x.id === 'DIR-b-1');
    assert.equal(dir?.home, 'b', JSON.stringify(rec.directives.map(x => x.id)));
    has(renderTab('records', rec, { now: Date.now() }), /class="chip home"[^>]*>on b</, 'the records row shows "on b"');

    const rm = (await f.get('/api/roadmap?project=kestrel')).data, it = rm.themes.flatMap(t => t.children).find(n => n.id === 'RM-b-2');
    assert.equal(it?.home, 'b', JSON.stringify(rm.themes.map(t => t.id)));
    assert.equal(it.status, 'building', `derive() reads b's copied run (live on b/slop): ${it.status} - ${it.why}`);
    has(renderTab('roadmap', rm, { now: Date.now(), project: 'kestrel' }), /class="chip home"[^>]*>on b</, 'the roadmap row shows "on b"');
  } finally { await f.done(); }
});
// a directive written on b (DIR-b-1), copied as the fetch does: Records lists it
function record_dir_b(f) {
  const B = path.join(f.root, 'home-b', 'kestrel'), t = iso(NOW - 1800e3);
  fs.appendFileSync(path.join(B, 'records.jsonl'), JSON.stringify({ seq: readEvents(path.join(B, 'records.jsonl')).at(-1).seq + 1, ts: t, kind: 'directive', ev: 'create', id: 'DIR-b-1', by: 'owner', run: null, data: { text: 'keep the slop door small', via: 'chat' } }) + '\n');
  fs.copyFileSync(path.join(B, 'records.jsonl'), path.join(f.pa.state, 'homes', 'b', 'records.jsonl'));
}

test('an answer on a foreign Q is a pending event in the own log ("answered on a, pending b"); a second answer is refused', { timeout: 120000 }, async () => {
  const f = await fx();
  try {
    const r = await f.post('/api/answer', { project: 'kestrel', id: 'Q-b-1', choice: 'a', text: '(a) one door' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const own = readEvents(recordsFile(f.pa.state, 'question')).filter(e => e.id === 'Q-b-1');
    assert.deepEqual(own.map(e => e.ev), ['answer'], 'the answer is in a\'s own log');
    assert.equal(readEvents(path.join(f.pa.state, 'homes', 'b', 'records.jsonl')).filter(e => e.ev === 'answer').length, 0, 'the copy is never edited');
    const inbox = (await f.get('/api/inbox?project=kestrel')).data, q = inbox.items.find(i => i.id === 'Q-b-1');
    assert.deepEqual(q?.pending?.map(p => [p.ev, p.home]), [['answer', 'a']], JSON.stringify(q));
    const html = renderTab('inbox', inbox, { now: Date.now() });
    has(html, /answered on a, pending b/, 'the card says where the answer waits');
    assert.doesNotMatch(html.match(/<article class="q openq" id="q-Q-b-1">[\s\S]*?<\/article>/)[0], /data-act="answer"/, 'no second Choose button on a pending question');
    const again = await f.post('/api/answer', { project: 'kestrel', id: 'Q-b-1', choice: 'b', text: '(b) two doors' });
    assert.equal(again.status, 409, 'a second answer is refused (SPEC 3.8)');
  } finally { await f.done(); }
});

test('the Ledger page: a Homes block (head, last fetch, lag, clock) and a Claims block (active, stale + take over, the leader)', { timeout: 120000 }, async () => {
  const f = await fx();
  try {
    const d = (await f.get('/api/ledger?project=kestrel')).data;
    assert.equal(d.homes?.home, 'a', JSON.stringify(d.homes));
    const b = d.homes.rows.find(x => x.home === 'b');
    assert.ok(b && /^[0-9a-f]{40}$/.test(b.head), JSON.stringify(d.homes));
    assert.ok(Number.isFinite(b.lag_s) && b.lag_s >= 0, 'lag in seconds');
    assert.ok('ahead_s' in b, 'the clock offset field');
    assert.ok(d.homes.fetched_at, 'the last fetch');
    const w = d.claims?.work?.find(c => c.key === 'work/kestrel/b/slop.json');
    assert.deepEqual([w?.home, w?.lane, w?.stale], ['b', 'slop', true], JSON.stringify(d.claims));
    assert.equal(d.claims.leader?.home, 'a');
    const html = renderTab('ledger', d, { now: Date.now(), project: 'kestrel' });
    has(html, /id="ledger-homes"[\s\S]*?on b/, 'the Homes block');
    has(html, /id="ledger-claims"[\s\S]*?data-act="claim-take"[^>]*data-lane="b\/slop"/, 'a stale claim has a Take over button');
    has(html, /merge leader[\s\S]*?\ba\b/, 'the leader');
    has(html, /id="ledger-lines"/, 'the ledger lines stay on the same page (blocks, no new tab)');
  } finally { await f.done(); }
});

test('norn runs --homes: b\'s run from its copy, "on b", lane in this home\'s form; without --homes only the own runs', { timeout: 120000 }, async () => {
  const f = await fixture({ synced: true });
  try {
    const run = argv => { const o = []; const code = main(['runs', '--state', f.pa.state, ...argv], process.env, s => o.push(s), s => o.push(s)); return { code, lines: o }; };
    const all = run(['--homes']), own = run([]);
    assert.equal(all.code, 0, all.lines.join('\n'));
    assert.ok(all.lines.some(l => /^RUN-b-1\s.*b\/slop.*\bon b$/.test(l)), all.lines.join('\n'));
    assert.ok(!own.lines.some(l => l.startsWith('RUN-b-1')), 'a foreign run only with --homes');
    const js = run(['--homes', '--json']);
    assert.equal(JSON.parse(js.lines.join('\n')).find(i => i.id === 'RUN-b-1')?.home, 'b');
  } finally { await f.done(); }
});

test('the browser: Roadmap, Inbox, Runs and Ledger show "on b" and do not scroll sideways at 390 px', { skip: skipWhy, timeout: 240000 }, async () => {
  const f = await fx(), pg = await openPage([390, 844]);
  try {
    await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    for (const tab of ['roadmap', 'inbox', 'runs', 'ledger', 'lanes']) {
      await pg.go(`${f.url}/?project=kestrel&tab=${tab}`);
      assert.ok(await pg.until(`document.body.dataset.ready === '${tab}' && [...document.querySelectorAll('.chip.home')].some(x => x.textContent === 'on b')`, 90000), `${tab} shows "on b"`);
      assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, `no sideways scroll on ${tab} at 390 px`);
    }
  } finally { await pg.close(); await f.done(); }
});
