// META-OPS-R1 #7 cost per lane: tokens by type per run (ended = the CLI final usage, running = live transcript tail), the
// price-weighted roll-up per lane / stage / executor / day, the check-in baseline, and the ended-run memo. Temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fromUsage, transcriptUsage, usageOfRun, costRollup, runsTotal, weekStart, WEIGHTS } from '../engine/lib/cost.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const tmp = () => mkTmp('meta-cost-');
const u = (cr, cc, inp, out, split) => ({ cache_read_input_tokens: cr, cache_creation_input_tokens: cc, input_tokens: inp, output_tokens: out,
  ...(split ? { cache_creation: { ephemeral_5m_input_tokens: split[0], ephemeral_1h_input_tokens: split[1] } } : {}) });
const line = (id, req, usage, ts = '2026-11-08T10:00:00.000Z') => JSON.stringify({ type: 'assistant', timestamp: ts, requestId: req,
  message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [], usage } }) + '\n';

test('fromUsage: four token types + the cache-read-equivalent weight (Anthropic price ratios; unsplit cache writes = 1 h)', () => {
  assert.deepEqual(WEIGHTS, { cache_read: 1, cache_create_5m: 12.5, cache_create_1h: 20, input: 10, output: 50 });
  assert.deepEqual(fromUsage(u(100, 10, 2, 3, [4, 6])), { cache_read: 100, cache_create: 10, input: 2, output: 3, weighted: 100 + 4 * 12.5 + 6 * 20 + 20 + 150 });
  assert.equal(fromUsage(u(100, 10, 2, 3)).weighted, 100 + 200 + 20 + 150);
  assert.deepEqual(fromUsage({}), { cache_read: 0, cache_create: 0, input: 0, output: 0, weighted: 0 });
});

test('transcriptUsage: main + subagents, deduped on message id + request id, only appended bytes parsed', () => {
  const d = tmp();
  try {
    const f = path.join(d, 'sid.jsonl');
    fs.writeFileSync(f, line('m1', 'r1', u(1000, 100, 1, 10)) + line('m1', 'r1', u(1000, 100, 1, 10)) + '{"type":"user"}\n' + line('m2', 'r2', u(2000, 0, 1, 20)));
    fs.mkdirSync(path.join(d, 'sid', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(d, 'sid', 'subagents', 'agent-a1.jsonl'), line('s1', 'q1', u(300, 30, 0, 3)));
    const cache = new Map();
    const a = transcriptUsage(f, cache);
    assert.deepEqual({ ...a.tokens }, { cache_read: 3300, cache_create: 130, input: 2, output: 33, weighted: 3300 + 130 * 20 + 20 + 33 * 50 });
    assert.ok(a.bytesRead > 0);
    const b = transcriptUsage(f, cache);
    assert.equal(b.bytesRead, 0, 'nothing appended: nothing re-read');
    assert.equal(b.tokens.cache_read, 3300);
    fs.appendFileSync(f, line('m3', 'r3', u(500, 0, 0, 0)));
    const c = transcriptUsage(f, cache);
    assert.equal(c.tokens.cache_read, 3800);
    assert.ok(c.bytesRead > 0 && c.bytesRead < a.bytesRead, 'only the appended line');
    assert.equal(transcriptUsage(path.join(d, 'missing.jsonl'), cache), null);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// fold-shaped runs (records.mjs loadState): created / updated / data / end / history
const NOW = Date.parse('2026-11-08T12:00:00Z');
const at = h => new Date(NOW - h * 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
function run(id, h, data, end, state = end ? 'exited' : 'running', dur_s = 120) {
  const created = at(h), r = { id, kind: 'run', state, created, updated: created, data, history: [{ ev: 'start', ts: created }] };
  if (end) { const ts = new Date(Date.parse(created) + dur_s * 1000).toISOString(); r.end = end; r.updated = ts; r.history.push({ ev: 'end', ts }); }
  return r;
}

test('usageOfRun: Claude ended = final usage, running = live transcript; Codex totals only; provider own account; grok none', () => {
  const d = tmp();
  try {
    const pd = path.join(d, 'projects'), wt = path.join(pd, 'C--wt');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, 'live-sid.jsonl'), line('m1', 'r1', u(700, 70, 1, 7)));
    const o = { projectsDir: pd, codexDir: path.join(d, 'codex'), cache: new Map(), memo: new Map() };
    const ended = usageOfRun(run('RUN-1', 3, { kind: 'worker', executor: 'claude', lane: 'gen' }, { usage: u(1000, 100, 10, 50) }), o);
    assert.deepEqual(ended, { family: 'claude', src: 'end', tokens: { cache_read: 1000, cache_create: 100, input: 10, output: 50, weighted: 1000 + 2000 + 100 + 2500 }, total: 1160 });
    const live = usageOfRun(run('RUN-2', 1, { kind: 'worker', executor: 'claude', lane: 'gen', session_id: 'live-sid' }), o);
    assert.equal(live.src, 'live'); assert.equal(live.tokens.cache_read, 700); assert.equal(live.total, 778);
    const killed = usageOfRun(run('RUN-3', 2, { kind: 'worker', executor: 'claude', lane: 'gen', session_id: 'live-sid' }, null, 'killed'), o);
    assert.equal(killed.src, 'transcript', 'a killed run has no final json: its transcript still counts');
    assert.equal(killed.tokens.cache_read, 700);
    assert.deepEqual(usageOfRun(run('RUN-4', 2, { kind: 'codex', executor: 'codex-sol', lane: 'r' }, { tokens: 7000, usage: { tokens: 7000 } }), o),
      { family: 'codex', src: 'end', tokens: null, total: 7000 });
    const prov = usageOfRun(run('RUN-5', 2, { kind: 'provider', executor: 'glm', lane: 'r' }, { usage: u(10, 0, 5, 5) }), o);
    assert.equal(prov.family, 'provider'); assert.equal(prov.total, 20);
    assert.deepEqual(usageOfRun(run('RUN-6', 2, { kind: 'worker', executor: 'grok', lane: 'r' }, { outcome: 'done' }), o), { family: 'grok', src: null, tokens: null, total: null });
    assert.deepEqual(usageOfRun(run('RUN-7', 2, { kind: 'worker', executor: 'claude', lane: 'r', session_id: 'nope' }, { outcome: 'done' }), o),
      { family: 'claude', src: null, tokens: null, total: null });
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// lane-collide S3 (SPEC 4A.6 resolve_tokens, duplicate_tokens): the totals of a set of runs - tokens (subagents included) and minutes
test('runsTotal: tokens and minutes over a set of runs; a run with no measure is counted, not guessed', () => {
  const d = tmp();
  try {
    const o = { projectsDir: path.join(d, 'projects'), codexDir: path.join(d, 'codex'), cache: new Map() };
    const t = runsTotal([run('RUN-1', 3, { kind: 'worker', executor: 'claude', lane: 'gen' }, { usage: u(1000, 100, 10, 50) }, 'exited', 600),
      run('RUN-2', 3, { kind: 'codex', executor: 'codex-sol', lane: 'gen' }, { tokens: 7000 }, 'exited', 300),
      run('RUN-3', 3, { kind: 'worker', executor: 'claude', lane: 'gen', session_id: 'nope' }, { outcome: 'done' }, 'exited', 60)], o);
    assert.deepEqual(t, { runs: 3, tokens: 1160 + 7000, min: 16, unmeasured: 1 });
    assert.deepEqual(runsTotal([], o), { runs: 0, tokens: 0, min: 0, unmeasured: 0 });
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('costRollup: rows per day / lane / stage / executor; %-of-week = weighted share of the calibrated cacheR; check-in baseline', () => {
  const runs = [
    run('RUN-1', 3, { kind: 'worker', executor: 'claude', lane: 'gen', stage: 'S1' }, { usage: u(1000, 100, 10, 50) }),
    run('RUN-2', 2, { kind: 'worker', executor: 'claude', lane: 'gen', stage: 'S1' }, { usage: u(3000, 0, 0, 100) }),
    run('RUN-3', 2, { kind: 'codex', executor: 'codex-sol', lane: 'render', stage: 'BANK' }, { tokens: 7000, usage: { tokens: 7000 } }),
    run('RUN-4', 1, { kind: 'checkin', executor: 'claude', lane: 'checkin' }, { usage: u(2000, 50, 1, 10) }, 'exited', 100),
    run('RUN-5', 30, { kind: 'checkin', executor: 'claude', lane: 'checkin' }, { usage: u(4000, 150, 3, 30) }, 'exited', 200),
    run('RUN-6', 24 * 8, { kind: 'worker', executor: 'claude', lane: 'old' }, { usage: u(9e6, 0, 0, 0) }),   // before the window
    run('RUN-7', 2, { kind: 'provider', executor: 'glm', lane: 'gen', stage: 'S1' }, { usage: u(10, 0, 5, 5) }),
    { id: 'Q-1', kind: 'question', created: at(1), data: {} },
  ];
  const r = costRollup(runs, { now: NOW, days: 7, cacheRPerPct: 1000, project: 'kestrel' });
  assert.equal(r.since, new Date(NOW - 7 * 86400000).toISOString());
  assert.ok(!r.rows.some(x => x.lane === 'old'), 'runs started before the window are out');
  const gen = r.rows.find(x => x.lane === 'gen' && x.executor === 'claude');
  assert.deepEqual([gen.project, gen.day, gen.stage, gen.family, gen.runs, gen.running], ['kestrel', '2026-11-08', 'S1', 'claude', 2, 0]);
  assert.deepEqual([gen.cache_read, gen.cache_create, gen.input, gen.output], [4000, 100, 10, 150]);
  const codex = r.rows.find(x => x.executor === 'codex-sol');
  assert.deepEqual([codex.family, codex.tokens, codex.pct, codex.cache_read], ['codex', 7000, null, null], 'Codex: totals only, its own plan');
  const prov = r.rows.find(x => x.executor === 'glm');
  assert.equal(prov.pct, null); assert.equal(prov.family, 'provider');
  // the calibration: total %-of-week = sum(cacheR) / cacheR_per_pct; each row its price-weighted share of it
  const claude = r.rows.filter(x => x.family === 'claude');
  const cr = claude.reduce((a, x) => a + x.cache_read, 0), w = claude.reduce((a, x) => a + x.weighted, 0);
  assert.equal(r.totals.claude.cache_read, cr);
  assert.equal(r.totals.claude.pct, cr / 1000);
  assert.ok(Math.abs(claude.reduce((a, x) => a + x.pct, 0) - cr / 1000) < 1e-9, 'row % sum to the calibrated total');
  assert.ok(Math.abs(gen.pct - gen.weighted * (cr / w) / 1000) < 1e-9);
  assert.equal(r.calib.cacheR_per_pct, 1000); assert.ok(Math.abs(r.calib.mix - cr / w) < 1e-12);
  assert.equal(r.totals.codex.tokens, 7000); assert.equal(r.totals.provider.tokens, 20);
  // check-ins: their own block (the event-driven baseline): ticks / day over the window, per-tick means, the last 24 h
  const c = r.checkins;
  assert.equal(c.ticks, 2); assert.ok(Math.abs(c.ticks_per_day - 2 / 7) < 1e-12);
  assert.deepEqual([c.per_tick.cache_read, c.per_tick.cache_create, c.per_tick.input, c.per_tick.output], [3000, 100, 2, 20]);
  assert.equal(c.mean_s, 150);
  assert.deepEqual([c.last24h.ticks, c.last24h.cache_read, c.last24h.cache_create], [1, 2000, 50]);
  assert.ok(c.last24h.pct > 0 && Math.abs(c.per_tick.pct * 2 - claude.filter(x => x.lane === 'checkin').reduce((a, x) => a + x.pct, 0)) < 1e-9);
  assert.equal(r.cost.runs, 7); assert.ok(Number.isFinite(r.cost.ms));
  assert.equal(costRollup(runs, { now: NOW, days: 7, cacheRPerPct: null }).totals.claude.pct, null, 'no calibration: no %');
});

test('costRollup: with the budget reset the % of week is over the CURRENT weekly window (last reset -> now); rolling 7 d + 24 h are secondary', () => {
  const runs = [
    run('RUN-1', 2, { kind: 'worker', executor: 'claude', lane: 'gen' }, { usage: u(3000, 0, 0, 0) }),           // in the week, in 24 h
    run('RUN-2', 30, { kind: 'worker', executor: 'claude', lane: 'gen' }, { usage: u(1000, 0, 0, 0) }),          // in the week, not 24 h
    run('RUN-3', 24 * 4 + 1, { kind: 'worker', executor: 'claude', lane: 'old' }, { usage: u(5000, 0, 0, 0) }),  // 2026-11-04 11:00Z: before the reset
  ];
  // the reset is a recurring weekly instant: an older one steps forward by whole weeks to the last one <= now
  assert.equal(weekStart(Date.parse('2026-10-21T14:00:00Z'), NOW), Date.parse('2026-11-04T14:00:00Z'));
  assert.equal(weekStart(Date.parse('2026-11-11T14:00:00Z'), NOW), Date.parse('2026-11-04T14:00:00Z'), 'a future reset steps back');
  const r = costRollup(runs, { now: NOW, days: 7, cacheRPerPct: 1000, resetAt: '2026-11-04T14:00:00.000Z' });
  assert.equal(r.window, 'week');
  assert.equal(r.since, '2026-11-04T14:00:00.000Z'); assert.equal(r.next_reset, '2026-11-11T14:00:00.000Z');
  assert.ok(!r.rows.some(x => x.lane === 'old'), 'a run before the weekly reset is out of the headline and the lane rows');
  assert.equal(r.totals.claude.cache_read, 4000); assert.equal(r.totals.claude.pct, 4);
  assert.equal(r.rows.filter(x => x.lane === 'gen').reduce((a, x) => a + x.pct, 0), 4, 'per-lane % over the same weekly window');
  assert.deepEqual([r.secondary.rolling.days, r.secondary.rolling.runs, r.secondary.rolling.cache_read, r.secondary.rolling.pct], [7, 3, 9000, 9]);
  assert.deepEqual([r.secondary.last24h.runs, r.secondary.last24h.cache_read, r.secondary.last24h.pct], [1, 3000, 3]);
  const old = costRollup(runs, { now: NOW, days: 7, cacheRPerPct: 1000 });
  assert.equal(old.window, 'rolling'); assert.equal(old.totals.claude.pct, 9, 'no reset known: the rolling window, as before');
});
