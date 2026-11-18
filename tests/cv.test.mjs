// META-GTP-CV (GT-PARITY-PLAN 2.8): the worker track record per routing key (executor, model, effort, agent), derived only from
// the run records + deliverables + cost.mjs (no new records). Temp dirs / in-memory fold items only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { costRollup } from '../engine/lib/cost.mjs';
import { cv, cvWindow, renderCv, cvPack, dlvFacts, CV_HEADER } from '../engine/lib/cv.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const NOW = Date.parse('2026-11-08T12:00:00Z'), H = 3600000;
const at = h => new Date(NOW - h * H).toISOString();
const usage = (cr, out = 0) => ({ cache_read_input_tokens: cr, cache_creation_input_tokens: 0, input_tokens: 0, output_tokens: out });
// fold-shaped run: h = hours ago it started, min = wall minutes, end = end data | 'killed' | 'lost' | null (running)
function run(id, h, data, end, min = 10) {
  const created = at(h), r = { id, kind: 'run', state: 'running', created, updated: created, data, history: [{ ev: 'start', ts: created, data }] };
  if (!end) return r;
  const ts = new Date(Date.parse(created) + min * 60000).toISOString(), ev = typeof end === 'string' ? (end === 'killed' ? 'kill' : 'lost') : 'end';
  r.state = ev === 'end' ? 'exited' : end; r.updated = ts; r.history.push({ ev, ts, data: ev === 'end' ? end : {} });
  if (ev === 'end') r.end = end;
  return r;
}
const W = (agent, extra = {}) => ({ kind: 'worker', executor: 'claude', model: 'claude-opus-5-5', effort: 'medium', agent, lane: 'a', ...extra });
const done = (cr, usd, extra = {}) => ({ outcome: 'done', usage: usage(cr, 10), cost_usd: usd, ...extra });

function fixture() {
  return [
    run('RUN-1', 1, W('kestrel-implementer', { budget_min: 60 }), done(1000, 1.5), 30),
    run('RUN-2', 2, W('kestrel-implementer', { budget_min: 60 }), done(3000, 2.5), 90),
    run('RUN-3', 3, W('kestrel-implementer', { budget_min: 60 }), { outcome: 'stopped', why: 'x', usage: usage(500), cost_usd: 0.5 }, 60),
    run('RUN-4', 4, W('kestrel-implementer', { budget_min: 60 }), { outcome: 'handoff', usage: usage(500), cost_usd: 0.5 }, 120),
    run('RUN-5', 5, W('kestrel-implementer', { budget_min: 60 }), 'killed', 6),
    run('RUN-6', 6, W('kestrel-planner', { effort: 'high' }), { outcome: 'limit', usage: usage(100), cost_usd: 0.1 }),
    run('RUN-7', 7, W('kestrel-planner', { effort: 'high' }), { outcome: 'crash', usage: usage(100), cost_usd: 0.1 }),
    run('RUN-8', 8, { kind: 'codex', executor: 'codex-sol', model: 'gpt-6.1-sol', effort: 'medium', agent: 'kestrel-runner', lane: 'b' }, { outcome: 'done', tokens: 5000 }),
    run('RUN-9', 9, { kind: 'provider', executor: 'glm', model: 'glm-5', effort: 'low', lane: 'b' }, { outcome: 'done', usage: usage(2000) }),
    run('RUN-10', 10, { kind: 'checkin', executor: 'claude', model: 'claude-opus-5-5', effort: 'medium', lane: 'checkin' }, done(400, 0.4)),
    run('RUN-11', 20 * 24, W('kestrel-implementer', { budget_min: 60 }), done(9000, 9), 30),   // 20 days ago: only the 30 d window
    run('RUN-12', 0.5, W('kestrel-implementer', { budget_min: 60 }), null),                     // running
  ];
}
const part = (items, extra = {}) => ({ project: 'kestrel', items, dlvs: [], executors: { glm: { type: 'claude-compatible', price_usd_per_mtok: 2 } }, ...extra });
const O = { now: NOW, cacheRPerPct: 1000 };
const row = (w, agent, effort = 'medium') => w.rows.find(r => r.key.agent === agent && r.key.effort === effort);

test('cvWindow: one row per (executor, model, effort, agent); outcome % over ended runs; killed from the kill event; the window by start', () => {
  const w = cvWindow([part(fixture())], { ...O, days: 7 });
  const im = row(w, 'kestrel-implementer');
  assert.deepEqual(im.key, { executor: 'claude', model: 'claude-opus-5-5', effort: 'medium', agent: 'kestrel-implementer' });
  assert.equal(im.runs, 6, 'RUN-1..5 + the running RUN-12; RUN-11 is outside 7 d');
  assert.equal(im.ended, 5);
  assert.deepEqual(im.out, { done: 40, stopped: 20, handoff: 20, limit: 0, crash: 0, killed: 20, other: 0 });
  const pl = row(w, 'kestrel-planner', 'high');
  assert.deepEqual([pl.out.limit, pl.out.crash], [50, 50]);
  assert.equal(row(w, 'checkin').runs, 1, 'a check-in has no agent: its kind is the agent');
  assert.equal(w.rows[0].key.agent, 'kestrel-implementer', 'rows by runs, most first');
  const m = cvWindow([part(fixture())], { ...O, days: 30 });
  assert.equal(row(m, 'kestrel-implementer').runs, 7);
});

test('cvWindow: wall minutes and wall / budget_min (median, p90); cacheR per DONE; $ per run beside plan % per run', () => {
  const w = cvWindow([part(fixture())], { ...O, days: 7 });
  const im = row(w, 'kestrel-implementer');
  assert.deepEqual(im.wall_min, { median: 60, p90: 120 }, 'ended walls 30, 90, 60, 120, 6');
  assert.deepEqual(im.wall_budget, { median: 1, p90: 2, n: 5 });
  assert.equal(im.cacheR_per_done, 2000, '(1000 + 3000) / 2 DONE');
  assert.equal(im.usd_runs, 4, 'killed RUN-5 has no recorded cost: unpriced');
  assert.equal(im.usd_per_run, 5 / 4);
  assert.ok(im.plan_pct > 0 && Math.abs(im.plan_pct_per_run - im.plan_pct / 4) < 1e-12, 'plan % per measured Claude run');
  const cx = w.rows.find(r => r.key.executor === 'codex-sol');
  assert.equal(cx.usd_per_run, null, 'codex: no published price in the executor data -> -');
  assert.equal(cx.plan_pct, null, 'codex: its own plan, no Claude %');
  assert.equal(cx.cacheR_per_done, null);
  const glm = w.rows.find(r => r.key.executor === 'glm');
  assert.equal(glm.key.agent, 'provider');
  assert.equal(glm.usd_per_run, 2000 * 2 / 1e6, 'typed executor: its price_usd_per_mtok x tokens');
});

test('kill criterion: runs and plan % equal costRollup over the same window (cost.mjs reused, never a second accounting path)', () => {
  for (const days of [7, 30]) {
    const items = fixture(), w = cvWindow([part(items)], { ...O, days });
    const r = costRollup(items, { now: NOW, days, cacheRPerPct: 1000 });
    const runs = r.rows.reduce((a, x) => a + x.runs, 0);
    assert.equal(w.totals.runs, runs);
    assert.equal(w.rows.reduce((a, x) => a + x.runs, 0), runs);
    assert.ok(Math.abs(w.totals.plan_pct - r.totals.claude.pct) < 1e-9, `${days} d: ${w.totals.plan_pct} vs ${r.totals.claude.pct}`);
    assert.deepEqual(w.check, { runs: true, plan_pct: true });
  }
});

test('merged within 72 h (DLV run -> merged_at) and reverted (a MERGE STOPPED "smoke red ... reverted" -> the lane\'s last DONE run)', () => {
  const items = [
    run('RUN-1', 100, W('kestrel-implementer'), done(1, 1)),
    run('RUN-2', 50, W('kestrel-implementer'), done(1, 1)),
    run('RUN-3', 40, W('kestrel-implementer', { lane: 'z' }), done(1, 1)),
    run('RUN-4', 30, { kind: 'worker', executor: 'claude', model: 'claude-opus-5-5', effort: 'medium', agent: 'kestrel-implementer', lane: 'z', stage: 'MERGE' },
      { outcome: 'stopped', why: 'smoke red after the merge, reverted', usage: usage(1), cost_usd: 1 }),
  ];
  const dlvs = [
    { id: 'DLV-1', runs: ['RUN-1'], merged_at: at(10) },        // 90 h after RUN-1 ended: merged, not within 72 h
    { id: 'DLV-2', runs: ['RUN-2'], merged_at: at(40) },        // 10 h
    { id: 'DLV-3', runs: ['RUN-3'], merged_at: null },          // not merged
  ];
  const w = cvWindow([part(items, { dlvs })], { ...O, days: 7 });
  const im = row(w, 'kestrel-implementer');
  assert.deepEqual(im.merged72, { n: 1, of: 3, pct: 100 / 3 });
  assert.equal(im.reverted, 1);
});

test('--by executor | model | agent | lane groups the same runs', () => {
  const p = [part(fixture())];
  const ex = cvWindow(p, { ...O, days: 7, by: 'executor' });
  assert.deepEqual(ex.rows.map(r => r.key), [{ executor: 'claude' }, { executor: 'codex-sol' }, { executor: 'glm' }]);
  assert.equal(ex.rows[0].runs, 9);
  assert.deepEqual(cvWindow(p, { ...O, days: 7, by: 'lane' }).rows.map(r => r.key.lane).sort(), ['a', 'b', 'checkin']);
  assert.equal(cvWindow(p, { ...O, days: 7, by: 'model' }).rows.length, 3);
  assert.equal(cvWindow(p, { ...O, days: 7, by: 'agent' }).rows.length, 5);
  assert.throws(() => cvWindow(p, { ...O, days: 7, by: 'persona' }), /--by/);
});

test('cv: both windows (7 d / 30 d) unless one is asked; CV.md text; the check-in pack <= 600 bytes, 5 keys by runs in 7 d', () => {
  const p = [part(fixture())];
  const c = cv(p, O);
  assert.deepEqual(c.windows.map(w => w.days), [7, 30]);
  assert.deepEqual(cv(p, { ...O, days: 30 }).windows.map(w => w.days), [30]);
  const md = renderCv(c);
  assert.ok(md.startsWith(CV_HEADER));
  assert.match(md, /## 7 d/); assert.match(md, /## 30 d/);
  assert.match(md, /claude \/ claude-opus-5-5 \/ medium \/ kestrel-implementer/);
  const pack = cvPack(c);
  assert.ok(Buffer.byteLength(pack) <= 600, `${Buffer.byteLength(pack)} bytes`);
  const lines = pack.trim().split('\n');
  assert.equal(lines.length, 7, 'title + header + 5 keys');
  assert.match(lines[2], /kestrel-implementer/);
});

// ---------- piece 2: `norn cv` + views/CV.md (temp state dirs; META_ROOT = a temp dir, so no machine.json / budget is read) ----------
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../engine/bin/norn.mjs';
import { CV_FILE } from '../engine/lib/cv.mjs';

function tempState() {
  const d = mkTmp('meta-cv-'), st = path.join(d, 'state');
  fs.mkdirSync(st, { recursive: true });
  const ts = h => new Date(Date.now() - h * H).toISOString();
  const ev = (seq, id, e, h, data) => JSON.stringify({ v: 1, seq, ts: ts(h), id, kind: 'run', ev: e, by: 'launcher', run: null, data }) + '\n';
  const d1 = { kind: 'worker', executor: 'claude', model: 'claude-opus-5-5', effort: 'high', agent: 'kestrel-implementer', lane: 'x', budget_min: 60 };
  fs.writeFileSync(path.join(st, 'runs.jsonl'), ev(1, 'RUN-1', 'start', 2, d1) + ev(2, 'RUN-1', 'end', 1, { outcome: 'done', usage: usage(100), cost_usd: 0.25 })
    + ev(3, 'RUN-2', 'start', 40 * 24, d1) + ev(4, 'RUN-2', 'end', 40 * 24 - 1, { outcome: 'stopped', usage: usage(100), cost_usd: 1 }));
  return { d, st };
}
const cli = (args, env) => { const o = [], e = []; const code = main(args, env, s => o.push(s), s => e.push(s)); return { code, out: o.join('\n'), err: e.join('\n') }; };

test('norn cv [--by] [--since Nd] [--json]: both windows by default; one with --since; --by groups; a bad --by / --since = usage (exit 2)', () => {
  const { d, st } = tempState();
  try {
    const env = { META_ROOT: d };
    const a = cli(['cv', '--state', st], env);
    assert.equal(a.code, 0, a.err);
    assert.match(a.out, /## 7 d/); assert.match(a.out, /## 30 d/);
    assert.match(a.out, /claude \/ claude-opus-5-5 \/ high \/ kestrel-implementer \| 1 \| 100 /);
    const j = JSON.parse(cli(['cv', '--state', st, '--since', '60d', '--json'], env).out);
    assert.deepEqual(j.windows.map(w => w.days), [60]);
    assert.equal(j.windows[0].rows[0].runs, 2);
    assert.equal(j.windows[0].rows[0].usd_per_run, 0.625);
    assert.deepEqual(JSON.parse(cli(['cv', '--state', st, '--by', 'lane', '--json'], env).out).windows[0].rows.map(r => r.key), [{ lane: 'x' }]);
    assert.equal(cli(['cv', '--state', st, '--by', 'persona'], env).code, 2);
    assert.equal(cli(['cv', '--state', st, '--since', 'week'], env).code, 2);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ---------- piece 3: the check-in pack's CV table (<= 600 bytes; no git on the tick path) ----------
import { checkinCv } from '../engine/lib/cv.mjs';
import { renderCheckin, tick } from '../engine/lib/tick.mjs';
import { loadState } from '../engine/lib/records.mjs';
import { settled } from './helpers/settled.mjs';

test('checkinCv: the 7 d pack of a project state (top 5 keys by runs, <= 600 bytes); no run in 7 d -> empty; renderCheckin appends it', () => {
  const { d, st } = tempState();
  try {
    const pack = checkinCv({ name: 'demo', state: st }, { budget: { cacheR_per_pct: 1000 } });
    assert.ok(Buffer.byteLength(pack) <= 600);
    assert.match(pack, /^CV 7 d/);
    assert.match(pack, /claude \/ opus-5-5 \/ high \/ kestrel-implementer \| 1 \| 100\/0\/0 /);
    assert.equal(checkinCv({ name: 'demo', state: st }, { now: Date.now() + 60 * DAYMS }), '', 'no run in the window');
    const p = { name: 'demo', root: d, state: st };
    assert.ok(fs.readFileSync(renderCheckin(p, { budgetFile: path.join(d, 'b.json'), cv: pack }), 'utf8').endsWith('\n' + pack));
    assert.doesNotMatch(fs.readFileSync(renderCheckin(p, { budgetFile: path.join(d, 'b.json') }), 'utf8'), /^CV 7 d/m);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

const DAYMS = 86400000;
