// Billing modes (lib/billing.mjs): a plan keeps the weekly guard; API billing (pay per token) has no weekly limit - no guard, no
// rate cap, no calibration - and an optional daily $ cap over the last 24 h of Claude runs. Temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkTmp } from './helpers/tmp.mjs';
import { usageRefusal } from '../engine/lib/usageguard.mjs';
import { billingChanges, billingChoices, spendDay, billingLine, BILLING_NAMES } from '../engine/lib/billing.mjs';
import { liveBudget } from '../engine/lib/runs.mjs';
import { capsMissing } from '../engine/lib/policy.mjs';
import { forecastOf } from '../engine/lib/plan.mjs';
import { waitWords } from '../engine/lib/waitwords.mjs';
import { buildStatus } from '../engine/lib/status.mjs';

const NORN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const iso = ms => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
/** a state root with one project whose run log holds Claude runs ending at the given ages (hours ago) and costs */
function root(runs = [], { provider = [] } = {}) {
  const t = mkTmp('meta-billing-'), stateRoot = path.join(t, 'state'), state = path.join(stateRoot, 'demo');
  fs.mkdirSync(path.join(state, 'runs'), { recursive: true });
  const now = Date.now(), lines = [];
  runs.forEach(([h, usd], i) => {
    const id = `RUN-${i + 1}`;
    lines.push({ v: 1, seq: lines.length + 1, ts: iso(now - h * 3600e3 - 60e3), id, kind: 'run', ev: 'start', by: 'launcher', data: { lane: 'a', executor: 'claude', kind: provider.includes(id) ? 'provider' : 'worker' } });
    lines.push({ v: 1, seq: lines.length + 1, ts: iso(now - h * 3600e3), id, kind: 'run', ev: 'end', by: 'launcher', data: { exit: 0, outcome: 'done', cost_usd: usd } });
  });
  fs.writeFileSync(path.join(state, 'runs.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return { t, stateRoot, state };
}

test('a plan budget keeps the weekly guard: no STATUS estimate = weekly unknown (fail closed), as before', () => {
  const r = root();
  assert.equal(usageRefusal({ budget: { weekly_stop_pct: 95 }, statusFile: path.join(r.t, 'none.md') }, r.state), 'weekly unknown');
  assert.equal(usageRefusal({ budget: { billing: 'max-20x', weekly_stop_pct: 95 }, statusFile: path.join(r.t, 'none.md') }, r.state), 'weekly unknown');
});

test('API billing: no weekly guard and no rate cap, even with weekly_stop_pct set and no STATUS; the daily $ cap holds past it', () => {
  const r = root([[1, 12.5], [5, 20], [30, 500]], { provider: [] });
  const spec = cap => ({ budget: { billing: 'api', weekly_stop_pct: 95, usage_rate_cap_pct_per_h: 0.5, ...(cap === undefined ? {} : { api_usd_per_day: cap }) }, statusFile: path.join(r.t, 'none.md') });
  assert.equal(usageRefusal(spec(), r.state), null, 'no cap: nothing holds');
  assert.equal(usageRefusal(spec(0), r.state), null, '0 = no cap');
  assert.equal(usageRefusal(spec(40), r.state), null, '$32.50 in 24 h (the 30 h old run is out of the window) is under $40');
  assert.equal(usageRefusal(spec(30), r.state), 'api spend $32.50 in 24 h >= cap $30.00');
  assert.equal(waitWords('usage: api spend $32.50 in 24 h >= cap $30.00').text, 'held: API spend $32.50 in 24 h reached the $30.00 daily cap');
});

test('spend counts Claude runs of every project under the root, never an own-account executor', () => {
  const r = root([[1, 10], [2, 7]], { provider: ['RUN-2'] });
  const other = path.join(r.stateRoot, 'other');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'runs.jsonl'), [{ ts: iso(Date.now() - 600e3), id: 'RUN-1', kind: 'run', ev: 'start', data: { kind: 'worker' } },
    { ts: iso(Date.now() - 60e3), id: 'RUN-1', kind: 'run', ev: 'end', data: { cost_usd: 2.25 } }].map(l => JSON.stringify(l)).join('\n'));
  const s = spendDay(r.stateRoot, Date.now(), { projectsDir: path.join(r.t, 'none') });
  assert.deepEqual([s.usd, s.runs, s.ended_usd, s.live_usd, s.chat_usd], [12.25, 2, 12.25, 0, 0]);
  assert.match(billingLine({ billing: 'api' }, r.state, { projectsDir: path.join(r.t, 'none') }), /api spend last 24 h \$12\.25 \(2 runs\) \+ \$0\.00 running = \$12\.25; no daily cap/);
});

test('caps: an API budget does not need a weekly stop or a rate cap; a plan still does', () => {
  assert.deepEqual(capsMissing({ billing: 'api', max_claude_workers: 3, max_codex: 0 }), []);
  assert.deepEqual(capsMissing({ max_claude_workers: 3, max_codex: 0 }), ['weekly_stop_pct', 'usage_rate_cap_pct_per_h']);
  assert.deepEqual(capsMissing({ billing: 'pro', max_claude_workers: 1, max_codex: 0 }), ['weekly_stop_pct', 'usage_rate_cap_pct_per_h']);
});

test('modes: each plan sets its caps; api sets only the mode (+ the daily cap); a $ cap on a plan is refused', () => {
  assert.deepEqual(BILLING_NAMES, ['pro', 'max-5x', 'max-20x', 'ultra', 'api']);
  for (const n of ['pro', 'max-5x', 'max-20x', 'ultra']) {
    const ch = billingChanges(n);
    assert.equal(ch.billing, n);
    for (const k of ['max_claude_workers', 'weekly_stop_pct', 'usage_rate_cap_pct_per_h']) assert.equal(typeof ch[k], 'number', `${n} ${k}`);
  }
  assert.deepEqual(billingChanges('api'), { billing: 'api' });
  assert.deepEqual(billingChanges('api', { usdPerDay: '50' }), { billing: 'api', api_usd_per_day: 50 });
  assert.deepEqual(billingChanges('api', { usdPerDay: 'off' }), { billing: 'api', api_usd_per_day: 0 });
  assert.throws(() => billingChanges('pro', { usdPerDay: 5 }), /api billing mode only/);
  assert.throws(() => billingChanges('api', { usdPerDay: 'lots' }), /--usd-per-day/);
  assert.throws(() => billingChanges('team'), /unknown billing mode team/);
  assert.equal(billingChoices().find(b => b.default).name, 'max-5x');
});

test('a queued spec reads the budget in force (GAP-2): its budget file only; gone = none; unparseable = held, never guessed', () => {
  const r = root(), bf = path.join(r.t, 'budget.json');
  fs.writeFileSync(bf, JSON.stringify({ billing: 'api', api_usd_per_day: 40 }));
  assert.deepEqual(liveBudget({ budget_file: bf }), { billing: 'api', api_usd_per_day: 40 });
  assert.deepEqual(liveBudget({ budget_file: path.join(r.t, 'gone.json') }), {}, 'a removed file = no budget, as norn run reads it');
  fs.writeFileSync(bf, '{ broken');
  assert.throws(() => liveBudget({ budget_file: bf }), /budget .*budget\.json unreadable .*: held until it parses/);
});

test('STATUS + forecast: API billing says the spend and the cap, asks for no calibration, RATE_OK=1', () => {
  const r = root([[2, 3.5]]);
  const s = buildStatus({ state: r.state, project: 'demo', stateRoot: r.stateRoot, budget: { billing: 'api', api_usd_per_day: 10, usage_rate_cap_pct_per_h: 0.1, max_claude_workers: 1 },
    projectsDir: path.join(r.t, 'none'), usageJson: {}, cacheFile: path.join(r.t, 'uc.json') });
  assert.match(s.text, /- billing: API \(pay per token, no weekly limit\); api spend last 24 h \$3\.50 \(1 run\) \+ \$0\.00 running = \$3\.50 of the \$10\.00 daily cap/);
  assert.doesNotMatch(s.text, /usage not estimated|estimated weekly now/);
  assert.match(s.text, /^RATE_OK=1/m);
  const f = forecastOf({ status: s.text, budget: { billing: 'api' } });
  assert.deepEqual(f.api, { usd: 3.5, cap: 10 });
  assert.equal(f.line, 'API billing: $3.50 of the $10.00 daily cap in the last 24 h');
});

test('norn billing: shows the modes; sets api + a daily cap in the budget (a queued run reads it at fill); a plan sets its caps', () => {
  const r = root(), local = path.join(r.t, 'local');
  fs.mkdirSync(local);
  fs.writeFileSync(path.join(local, 'budget.json'), JSON.stringify({ max_claude_workers: 3, max_codex: 0, weekly_stop_pct: 95, usage_rate_cap_pct_per_h: 0.57 }));
  const q = path.join(r.state, 'runs', 'RUN-3.queue.json');
  const spec = { budget_file: path.join(local, 'budget.json') };
  fs.writeFileSync(q, JSON.stringify(spec));
  const norn = (...a) => spawnSync(process.execPath, [NORN, 'billing', ...a], { encoding: 'utf8', windowsHide: true, env: { ...process.env, META_ROOT: r.t, META_NO_TICK: '1' } });
  let x = norn();
  assert.equal(x.status, 0, x.stderr);
  assert.match(x.stdout, /billing: not set/);
  assert.match(x.stdout, /api +API billing/);
  x = norn('api', '--usd-per-day', '25');
  assert.equal(x.status, 0, x.stderr);
  const b = JSON.parse(fs.readFileSync(path.join(local, 'budget.json'), 'utf8'));
  assert.equal(b.billing, 'api'); assert.equal(b.api_usd_per_day, 25); assert.equal(b.max_claude_workers, 3, 'api keeps the worker cap');
  assert.deepEqual(JSON.parse(fs.readFileSync(q, 'utf8')), spec, 'the queued spec is not rewritten');
  assert.equal(liveBudget(spec).billing, 'api', 'its fill reads the new mode');
  x = norn('pro');
  assert.equal(x.status, 0, x.stderr);
  const p = JSON.parse(fs.readFileSync(path.join(local, 'budget.json'), 'utf8'));
  assert.equal(p.billing, 'pro'); assert.equal(p.max_claude_workers, 1); assert.equal(p.weekly_stop_pct, 80);
  x = norn('pro', '--usd-per-day', '5');
  assert.equal(x.status, 2);
  assert.match(x.stderr, /api billing mode only/);
});

test('the dash: Settings offers Billing; saving api reaches the queued runs (read at fill); the Burn card shows the spend, not the weekly guard', async () => {
  const { fixture } = await import('./helpers/dash-fixture.mjs');
  const { renderTab, loadTab } = await import('../engine/dash/ui.mjs');
  const f = await fixture();
  try {
    const ui = async r => (await f.get(r)).data, now = Date.now();
    const q = path.join(f.pa.state, 'runs', 'RUN-90.queue.json');
    fs.mkdirSync(path.dirname(q), { recursive: true });
    const spec = { budget_file: f.budgetFile };
    fs.writeFileSync(q, JSON.stringify(spec));
    const g = (await f.get('/api/settings?project=kestrel')).data;
    assert.equal(g.billing_now, null);
    assert.deepEqual(g.billing.map(b => b.name), BILLING_NAMES);
    let html = renderTab('settings', await loadTab('settings', 'kestrel', ui), { now, project: 'kestrel' });
    assert.match(html, /id="set-billing"/);
    assert.match(html, /Not set: Norn treats the account as a plan/);
    const r = await f.post('/api/settings', { project: 'kestrel', version: g.version, changes: { billing: 'api', api_usd_per_day: 20 } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(JSON.parse(fs.readFileSync(q, 'utf8')), spec, 'the queued spec is not rewritten');
    assert.equal(liveBudget(spec).billing, 'api', 'its fill reads the saved mode');
    html = renderTab('settings', await loadTab('settings', 'kestrel', ui), { now, project: 'kestrel' });
    assert.match(html, /In force: <b>API billing \(pay per token\)<\/b>/);
    const ov = (await f.get('/api/strip?project=kestrel')).data;
    assert.equal(ov.usage.billing.type, 'api'); assert.equal(ov.usage.billing.cap, 20); assert.equal(ov.usage.guard, 'ok');
    html = renderTab('spend', await loadTab('spend', 'kestrel', ui, { sub: 'tokens' }), { now, project: 'kestrel', strip: ov });
    assert.match(html, /id="spend-24h"><b class="mono">\$[\d.]+<\/b><span class="small mute">last 24 h · every project · cap \$20\.00/, 'the 24 h tile: dollars against the cap');
    assert.match(html, /id="spend-guard"><b class="mono">ok<\/b>/);
    assert.match(html, /id="burn-api"/);
    assert.match(html, /of the \$20\.00 daily cap/);
    assert.doesNotMatch(html, /guard unknown/);
  } finally { await f.done(); }
});
