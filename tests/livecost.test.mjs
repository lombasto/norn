// Gap #9: API spend showed only after a run ended. A running Claude run's $ so far = its transcript's tokens x list price (an
// estimate, livecost.mjs; `claude -p --output-format json` reports total_cost_usd only at exit), the dashboard chats count on their own
// line, and the daily cap counts both. Temp dirs only: a fake transcripts root, fake run logs, the shared dash fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp } from './helpers/tmp.mjs';
import { priceOf, usageUsd, liveRunCost, resetLiveCost } from '../engine/lib/livecost.mjs';
import { spendDay, billingLine, spendBreakdown } from '../engine/lib/billing.mjs';
import { usageRefusal } from '../engine/lib/usageguard.mjs';
import { forecastOf } from '../engine/lib/plan.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { record } from '../engine/lib/records.mjs';
import { renderTab, loadTab } from '../engine/dash/ui.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

const iso = ms => new Date(ms).toISOString();
const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const asst = (ts, id, model, usage, req = 'req_' + id) => JSON.stringify({ type: 'assistant', timestamp: iso(ts), requestId: req, message: { id, model, usage } });
// msg A on Opus 5.5 ($4 in / $20 out / $0.20 cache read / 1 h cache write 2x = $8): 1000 in + 2000 out + 100k read + 10k write = $0.144
const A = { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 100000, cache_creation_input_tokens: 10000 };
/** a transcripts root with one session: a line before the run started, msg A on two content blocks, a subagent on Sonnet 5.5 ($10 / M out) */
function transcripts(t, started) {
  const pd = path.join(t, 'claude-projects'), dir = path.join(pd, 'C--wt'), f = path.join(dir, SID + '.jsonl');
  fs.mkdirSync(path.join(dir, SID, 'subagents'), { recursive: true });
  fs.writeFileSync(f, [JSON.stringify({ type: 'user', timestamp: iso(started), message: { role: 'user', content: 'go' } }),
    asst(started - 3600e3, 'msg_old', 'claude-opus-5-5', { output_tokens: 1e6 }),   // a resumed session's earlier run: not this run's $
    asst(started + 1000, 'msg_A', 'claude-opus-5-5', { ...A, output_tokens: 5 }),     // the first content block: partial usage
    asst(started + 2000, 'msg_A', 'claude-opus-5-5', A),                              // the same message, its last block
    asst(started + 3000, 'msg_syn', '<synthetic>', { output_tokens: 1e6 })].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, SID, 'subagents', 'agent-x.jsonl'), asst(started + 4000, 'msg_S', 'claude-sonnet-5-5', { output_tokens: 1e6 }) + '\n');
  return { pd, f };
}
/** a state root with project demo: one ended run ($2) and one running Claude run on SID (+ an ended chat process) */
function root({ chat = true } = {}) {
  const t = mkTmp('meta-livecost-'), stateRoot = path.join(t, 'state'), state = path.join(stateRoot, 'demo'), now = Date.now(), started = now - 600e3;
  fs.mkdirSync(path.join(state, 'chat'), { recursive: true });
  const L = [
    { ts: iso(now - 7200e3), id: 'RUN-1', kind: 'run', ev: 'start', data: { kind: 'worker', executor: 'claude', lane: 'a', session_id: 'old' } },
    { ts: iso(now - 3600e3), id: 'RUN-1', kind: 'run', ev: 'end', data: { exit: 0, cost_usd: 2 } },
    { ts: iso(started), id: 'RUN-2', kind: 'run', ev: 'start', data: { kind: 'worker', executor: 'claude', lane: 'b', model: 'opus', session_id: SID } },
    { ts: iso(started), id: 'RUN-3', kind: 'run', ev: 'start', data: { kind: 'provider', executor: 'glm', lane: 'c', session_id: SID } },   // own account: never
  ];
  fs.writeFileSync(path.join(state, 'runs.jsonl'), L.map(l => JSON.stringify(l)).join('\n') + '\n');
  // chat: a process with turns at a running total of $0.30 then $0.50, a new process at $0.25 = $0.75
  if (chat) fs.writeFileSync(path.join(state, 'chat', 'thread.jsonl'), [{ kind: 'start' }, { kind: 'turn', cost_usd: 0.3 }, { kind: 'turn', cost_usd: 0.5 }, { kind: 'stop' }, { kind: 'start' }, { kind: 'turn', cost_usd: 0.25 }]
    .map(l => JSON.stringify({ ts: iso(now - 60e3), seg: 1, ...l })).join('\n') + '\n');
  return { t, stateRoot, state, now, started, ...transcripts(t, started) };
}

test('prices: longest prefix, aliases, a [1m] suffix, the default; a usage object at its model price', () => {
  assert.equal(priceOf('claude-opus-4-5-20251101').model, 'claude-opus-4-5');
  assert.equal(priceOf('claude-opus-4-1-20250805').input, 15);
  assert.equal(priceOf('opus').model, 'claude-opus-5-5');
  assert.equal(priceOf('claude-sonnet-5-5[1m]').model, 'claude-sonnet-5-5');
  assert.equal(priceOf('who-knows', 'sonnet').model, 'claude-sonnet-5-5', 'an unknown id falls back to the run model');
  assert.equal(priceOf('who-knows').model, 'claude-opus-5-5');
  assert.equal(Math.round(usageUsd(A, 'claude-opus-5-5') * 1e6), 144000);
  // a 5-minute cache write is 1.25x input, the rest of the write 2x
  assert.equal(Math.round(usageUsd({ cache_creation_input_tokens: 1e6, cache_creation: { ephemeral_5m_input_tokens: 4e5 } }, 'claude-opus-5-5') * 100), Math.round((0.4 * 5 + 0.6 * 8) * 100));
});

test('live cost from a fake transcript: one count per message, nothing before the run started, subagents in, read on from the offset', () => {
  resetLiveCost();
  const r = root(), run = { session_id: SID, started: r.started, model: 'opus' };
  const c = liveRunCost(run, { projectsDir: r.pd });
  assert.ok(c.estimate);
  assert.equal(c.files, 2);
  assert.equal(Math.round(c.usd * 1e4), Math.round((0.144 + 10) * 1e4));
  fs.appendFileSync(r.f, asst(r.started + 5000, 'msg_B', 'claude-opus-5-5', { output_tokens: 50000 }) + '\n' + '{"type":"assistant","partial');   // + $1; a half-written line waits
  assert.equal(Math.round(liveRunCost(run, { projectsDir: r.pd }).usd * 1e4), Math.round(11.144 * 1e4));
  assert.equal(liveRunCost({ session_id: 'nope', started: r.started }, { projectsDir: r.pd }), null, 'no transcript yet = nothing to count');
});

test('spend with a running run: ended + running (estimate) + chats; the running part goes once the run ends; STATUS line + forecast read the total', () => {
  resetLiveCost();
  const r = root();
  let s = spendDay(r.stateRoot, r.now, { projectsDir: r.pd });
  assert.equal(s.ended_usd, 2); assert.equal(s.runs, 1);
  assert.equal(s.live_usd, 10.14); assert.equal(s.live_runs, 1, 'the provider run on the same session is not counted');
  assert.equal(s.chat_usd, 0.75); assert.equal(s.chat_turns, 3);
  assert.equal(s.usd, 12.89);
  assert.deepEqual(s.live, [{ project: 'demo', id: 'RUN-2', lane: 'b', usd: 10.14 }]);
  const line = billingLine({ billing: 'api', api_usd_per_day: 50 }, r.state, { now: r.now, projectsDir: r.pd });
  assert.match(line, /api spend last 24 h \$2\.00 \(1 run\) \+ \$10\.14 running \(1 run, estimate\) \+ \$0\.75 chats = \$12\.89 of the \$50\.00 daily cap$/);
  assert.deepEqual(forecastOf({ status: `- ${line}\n`, budget: { billing: 'api' } }).api, { usd: 12.89, cap: 50 });
  const b = spendBreakdown(r.stateRoot, { now: r.now, projectsDir: r.pd })[0];
  assert.deepEqual(b.lanes.map(g => [g.lane, g.week, g.live]), [['b', 10.14, 1], ['a', 2, 0]]);
  assert.equal(b.chats.week, 0.75);
  fs.appendFileSync(path.join(r.state, 'runs.jsonl'), JSON.stringify({ ts: iso(r.now), id: 'RUN-2', kind: 'run', ev: 'end', data: { exit: 0, cost_usd: 9.5 } }) + '\n');
  s = spendDay(r.stateRoot, r.now + 1000, { projectsDir: r.pd });
  assert.equal(s.live_usd, 0); assert.equal(s.ended_usd, 11.5, 'the CLI figure replaces the estimate');
  assert.match(billingLine({ billing: 'api' }, r.state, { now: r.now + 1000, projectsDir: r.pd }), /\$11\.50 \(2 runs\) \+ \$0\.00 running \+ \$0\.75 chats = \$12\.25; no daily cap/);
});

test('the daily cap refuses on live spend: a long run past the cap holds new Claude work before it ends', () => {
  resetLiveCost();
  const r = root({ chat: false }), spec = cap => ({ budget: { billing: 'api', api_usd_per_day: cap }, projectsDir: r.pd });
  assert.equal(usageRefusal(spec(20), r.state), null, '$12.14 < $20');
  assert.equal(usageRefusal(spec(5), r.state), 'api spend $12.14 in 24 h >= cap $5.00', 'only $2 has ended: the running $10.14 trips it');
  assert.equal(usageRefusal({ budget: { billing: 'api', api_usd_per_day: 5 }, projectsDir: path.join(r.t, 'none') }, r.state), null, 'no transcript seen = the ended $2 only');
});

// ---------- the dashboard: Running $ column, Lanes $ to date, Usage API spend card ----------
async function apiFixture() {
  const f = await fixture(), S = f.pa.state, now = Date.now();
  const pd = path.join(f.root, 'claude-projects'), dir = path.join(pd, 'C--gen');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SID + '.jsonl'), asst(now + 60e3, 'msg_A', 'claude-opus-5-5', A) + '\n');   // after the start record's own time
  const id = record(S, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'gen', model: 'claude-opus-5-5', session_id: SID } }).id;
  fs.writeFileSync(path.join(S, 'hb', `${id}.hb`), '{}');
  fs.mkdirSync(path.join(S, 'chat'), { recursive: true });
  fs.writeFileSync(path.join(S, 'chat', 'thread.jsonl'), [{ kind: 'start' }, { kind: 'turn', cost_usd: 0.4 }].map(l => JSON.stringify({ ts: iso(now - 60e3), seg: 1, ...l })).join('\n') + '\n');
  const g = (await f.get('/api/settings?project=kestrel')).data;
  const r = await f.post('/api/settings', { project: 'kestrel', version: g.version, changes: { billing: 'api', api_usd_per_day: 20 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { f, id, now };
}

test('the dash in API mode: the strip carries the 24 h spend (running runs as an estimate), Usage shows it, Lanes each lane\'s $ to date, Usage the $ per lane today / 7 days + chats', async () => {
  resetLiveCost();
  const { f, id, now } = await apiFixture();
  try {
    const ui = async r => (await f.get(r)).data;
    const ov = (await f.get('/api/strip?project=kestrel')).data, b = ov.usage.billing;
    assert.equal(b.live_usd, 0.14); assert.equal(b.live_runs, 1); assert.equal(b.chat_usd, 0.4);
    assert.deepEqual(b.live.map(x => [x.id, x.usd]), [[id, 0.14]]);
    let html = renderTab('usage', await loadTab('usage', 'kestrel', ui), { now, project: 'kestrel', strip: ov });
    assert.match(html, /id="burn-api-parts"[^>]*>\$0\.00 from 0 Claude runs ended in the last 24 h \(every project\) · \$0\.14 running \(1 run, estimate\) · \$0\.40 dashboard chats/);
    html = renderTab('lanes', await loadTab('lanes', 'kestrel', ui), { now, project: 'kestrel' });
    assert.match(html, />\$ to date<\/th>/);
    assert.match(html, /id="lane-gen"[\s\S]*?class="mono lane-usd">~\$0\.14</);
    assert.match(html, /id="lane-render"[\s\S]*?class="mono lane-usd"><span class="mute">-</, 'a lane with no Claude spend');
    html = renderTab('usage', await loadTab('usage', 'kestrel', ui), { now, project: 'kestrel' });
    assert.match(html, /id="usage-spend"><h2>API spend <b>\$0\.54<\/b> today/);
    assert.match(html, /<b>gen<\/b>[^<]*<span[^>]*>live<\/span><\/td><td class="mono">~\$0\.14<\/td><td class="mono">~\$0\.14<\/td>/);
    assert.match(html, /id="usage-spend-chats"><td><b>dashboard chats<\/b><\/td><td class="mono">\$0\.40<\/td>/);
  } finally { await f.done(); }
});

test('the dash in plan mode keeps the burn (the run document\'s facts, tokens / 30 min) and no $ figures', async () => {
  const f = await fixture();
  try {
    const ui = async r => (await f.get(r)).data, now = Date.now();
    let html = renderTab('runs', await loadTab('runs', 'kestrel', ui), { now, project: 'kestrel' });
    assert.doesNotMatch(html, /\$ so far/);
    // stage RUNS: the %/h column left with /api/overview; the burn is the picked run's own, in its facts
    const burning = { id: 'RUN-9', kind: 'worker', state: 'running', started: new Date(now - 6e5).toISOString(), project: 'kestrel', burn30: 2.5e6, children: [] };
    html = renderTab('runs', { tree: [burning], ended: [] }, { now, project: 'kestrel', run: 'RUN-9' });
    assert.match(html, /<span class="mute">burn<\/span><span>2\.5M \/ 30 min<\/span>/); assert.doesNotMatch(html, /\$ so far/);
    html = renderTab('lanes', await loadTab('lanes', 'kestrel', ui), { now, project: 'kestrel' });
    assert.doesNotMatch(html, /\$ to date|lane-usd/);
    html = renderTab('usage', await loadTab('usage', 'kestrel', ui), { now, project: 'kestrel' });
    assert.doesNotMatch(html, /id="usage-spend"/);
  } finally { await f.done(); }
});

test('phone width unchanged: Lanes and Usage in API mode at 390 px have no sideways scroll', { skip: skipWhy, timeout: 420000 }, async () => {
  resetLiveCost();
  const { f } = await apiFixture(); let pg;
  try {
    pg = await openPage([390, 844]);
    await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    for (const [tab, sel] of [['lanes', '.lane-usd'], ['usage', '#usage-burn'], ['usage', '#usage-spend']]) {
      await pg.go(`${f.url}/?project=kestrel&tab=${tab}`, 60000);
      assert.ok(await pg.until(`!!document.querySelector('${sel}')`, 60000), `${tab}: ${sel} painted`);
      assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, `${tab}: no sideways scroll on a phone`);
    }
  } finally { await pg?.close(); await f.done(); }
});
