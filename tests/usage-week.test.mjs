// META-GUARD R1 item 2: where the week's tokens went - per lane + stage: runs, tokens by type (never summed naively), ~share of the
// plan, outcomes (done / stopped / handoff / merged), tokens per merged branch; the top 5 spenders with why (turns x context).
// Synthetic runs + deliverable facts only (no git).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { usageWeek, formatUsageWeek } from '../engine/lib/usageweek.mjs';
import { main } from '../engine/bin/norn.mjs';

after(cleanTmp);
const NOW = Date.parse('2026-11-13T12:00:00Z');
function fixture() {
  const st = mkTmp('meta-uw-'), at = t => ({ now: () => new Date(t), run: null });
  const run = (lane, stage, day, outcome, cr, out, turns) => {
    const fin = path.join(st, 'f', `${lane}-${stage}-${day}.json`);
    fs.mkdirSync(path.dirname(fin), { recursive: true }); fs.writeFileSync(fin, JSON.stringify({ num_turns: turns }));
    const id = record(st, { kind: 'run', ev: 'start', by: 'launcher', data: { executor: 'claude', kind: 'worker', lane, stage, final: fin } }, at(`2026-11-${day}T08:00:00Z`)).id;
    record(st, { kind: 'run', ev: 'end', id, by: 'launcher', data: { outcome, exit: 0, usage: { cache_read_input_tokens: cr, cache_creation_input_tokens: 1000, input_tokens: 10, output_tokens: out } } }, at(`2026-11-${day}T09:00:00Z`));
    return id;
  };
  const ids = {
    w1: run('water', 'S1', 10, 'done', 20e6, 50000, 200), w2: run('water', 'S1', 11, 'handoff', 10e6, 20000, 100),
    m1: run('map', 'S2', 12, 'done', 4e6, 10000, 40), m2: run('map', 'S2', 12, 'stopped', 1e6, 5000, 20),
    d1: run('docs', 'S1', 13, 'done', 2e6, 4000, 25), old: run('water', 'S1', '01', 'done', 99e6, 1, 1),
  };
  const dlvs = [{ id: 'DLV-1', runs: [ids.w1, ids.w2], merged_at: '2026-11-12T10:00:00Z' }, { id: 'DLV-2', runs: [ids.m1], merged_at: null }];
  return { st, ids, part: { project: 'x', items: Object.values(loadState(st).items), dlvs } };
}

test('weekly table per lane + stage: runs, tokens by type, ~plan share, outcomes, merged, tokens per merged branch; top 5 with why', () => {
  const { ids, part } = fixture();
  const u = usageWeek([part], { now: NOW, cacheRPerPct: 1e6 });
  assert.equal(u.days, 7);
  const row = (lane, stage) => u.rows.find(r => r.lane === lane && r.stage === stage);
  const w = row('water', 'S1');
  assert.equal(w.runs, 2, 'the run before the window is out');
  assert.deepEqual(w.tokens, { input: 20, cache_create: 2000, cache_read: 30e6, output: 70000 });
  assert.deepEqual(w.outcomes, { done: 1, stopped: 0, handoff: 1, other: 0, merged: 1 });
  assert.equal(w.merged, 1);
  assert.deepEqual(w.per_merged, { cache_read: 30e6, output: 70000, pct: w.pct });
  assert.ok(w.pct > 0 && w.pct_approx === true);
  assert.equal(row('map', 'S2').merged, 0); assert.equal(row('map', 'S2').per_merged, null);
  assert.deepEqual(u.rows.map(r => r.lane), ['water', 'map', 'docs'], 'ranked by the plan share they used');
  const sum = u.rows.reduce((a, r) => a + r.pct, 0);
  assert.ok(Math.abs(sum - u.totals.pct) < 1e-9);
  assert.equal(u.top.length, 5);
  assert.equal(u.top[0].id, ids.w1);
  assert.match(u.top[0].why, /200 turns x ~100k context/);
  const txt = formatUsageWeek(u);
  assert.match(txt, /water\s+S1\s+2\s+.*30\.0M/);
  assert.match(txt, /~\d/, 'the plan share says ~');
  assert.match(txt, /Top 5 spenders/);
});

test('norn usage [--week] [--json]: the CLI prints the table (read-only)', () => {
  const { st } = fixture();
  const o = [], e = [];
  const code = main(['usage', '--json', '--state', st, '--now', new Date(NOW).toISOString()], { ...process.env, META_ROOT: path.dirname(st) }, s => o.push(s), s => e.push(s));
  assert.equal(code, 0, e.join('\n'));
  const j = JSON.parse(o.join('\n'));
  assert.ok(j.rows.length >= 3 && j.top.length === 5);
  assert.equal(main(['usage', '--bogus', '--state', st], process.env, () => {}, () => {}), 2);
});

test('dashboard: the Spend page shows the top 5, its drawer the lane and stage table; an Agents run node carries its usage-guard chip', async () => {
  const { renderTab } = await import('../engine/dash/ui.mjs');
  const { part } = fixture();
  const week = usageWeek([part], { now: NOW, cacheRPerPct: 1e6 });
  const zero = { cache_read: 0, cache_create: 0, input: 0, output: 0, weighted: 0, pct: null, runs: 0, tokens: 0 };
  const p = { project: 'x', window: 'rolling', days: 7, since: '2026-11-06T12:00:00Z', rows: [], totals: { claude: zero, codex: zero, provider: zero, unmeasured: 0 },
    checkins: { ticks: 0 }, calib: { cacheR_per_pct: 1e6, mix: 1, weights: { input: 10, output: 50, cache_create_1h: 20, cache_create_5m: 12.5 } }, cost: { runs: 0, ms: 1, bytesRead: 0 },
    secondary: null, headline: null, account: null, week };
  const html = renderTab('spend', { parts: [p] }, { project: 'x', now: NOW }), stage = renderTab('spend', { parts: [p], sub: 'stage' }, { project: 'x', now: NOW });
  assert.match(stage, /id="spend-stage"[\s\S]*Lane and stage[\s\S]*<b>water<\/b><\/td><td>S1<\/td>/);
  assert.match(html, /id="spend-top"[\s\S]*200 turns x ~100k context/);
  const ag = renderTab('runs', { tree: [{ id: 'RUN-7', kind: 'run', state: 'running', executor: 'claude', lane: 'water', project: 'x',
    guard: [{ id: 'GRD-1', cls: 'runaway', why: '43.5M cache reads = 6.1x', state: 'open', action: null }] }], queue: [] }, { project: 'x', now: NOW });
  assert.match(ag, /guard-chip" title="GRD-1: 43\.5M cache reads = 6\.1x"><span class="chip bad">runaway<\/span>/);
});
