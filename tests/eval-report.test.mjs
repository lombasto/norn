// META-TEND P4 (owner Q2): the replay test report - agreement per class of ruling, every disagreement, the side-by-side rows.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { replayReport, actionText } from '../engine/lib/eval/report.mjs';
import { scoreTick } from '../engine/lib/eval/checkin.mjs';
import { evalCmd } from '../engine/lib/eval/cli.mjs';

after(cleanTmp);
const A = 'claude:claude-sonnet-5-5:medium', B = 'claude:claude-opus-5-5:low';
const D = { type: 'dispatch', lane: 'river', stage: 'S1', executor: 'claude', effort: 'medium' }, Q = { type: 'decision', lane: 'beam', choice: 'park' };
const res = (tick, arm, base, cand, extra = {}) => ({ tick, ts: `2026-11-12T0${tick.slice(-1)}:00:00Z`, arm, stratum: base[0]?.type ?? 'idle', base, cand,
  score: scoreTick(base, cand), usage: { input: 1, cache_write: 1000, cache_read: 10, output: 100 }, cost_usd: 0.1, ...extra });
const ROWS = [
  res('RUN-1', A, [D, Q], [D, { ...Q, choice: 'merge' }]),           // both matched; the decision's choice differs (choiceReview)
  res('RUN-1', B, [D, Q], [Q]),                                       // dispatch missing
  res('RUN-2', A, [], []),                                           // idle agrees (parseActions keeps "nothing" apart)
  res('RUN-2', B, [], [D]),                                           // idle, an extra dispatch
  { tick: 'RUN-3', ts: '2026-11-12T03:00:00Z', arm: A, stratum: 'idle', base: [], cand: [], error: 'exit 1: boom', usage: null, cost_usd: 0 },
];

test('replayReport: agreement per class of ruling per arm, disagreements with recorded vs candidate, choices, tokens', () => {
  const r = replayReport(ROWS, { project: 'kestrel' });
  assert.deepEqual(r.arms, [A, B]);
  const c = (arm, cls) => r.classes.find(x => x.arm === arm && x.cls === cls);
  assert.deepEqual([c(A, 'dispatch').agree, c(A, 'dispatch').recorded, c(A, 'decision').agree, c(A, 'idle').agree, c(A, 'idle').recorded], [1, 1, 1, 1, 1]);
  assert.deepEqual([c(B, 'dispatch').agree, c(B, 'dispatch').recorded, c(B, 'decision').rate, c(B, 'idle').agree], [0, 1, 1, 0]);
  const ta = r.arms_total.find(t => t.arm === A);
  assert.deepEqual([ta.ticks, ta.agree, ta.errors, ta.tokens], [3, 2, 1, 2222]);
  assert.equal(r.disagreements.length, 2);
  const d = r.disagreements.find(x => x.tick === 'RUN-1');
  assert.deepEqual([d.arm, d.cls, d.worst], [B, 'dispatch', 'recoverable']);
  assert.deepEqual(d.recorded, ['dispatch river S1 claude medium', 'decision beam: park']);
  assert.deepEqual(d.cand, ['decision beam: park']);
  assert.match(d.why[0], /^missing dispatch:river: lane idles/);
  assert.deepEqual(r.choices, [{ arm: A, tick: 'RUN-1', key: 'decision:beam', recorded: 'park', cand: 'merge' }]);
  const t2 = r.ticks.find(t => t.tick === 'RUN-2');
  assert.deepEqual([t2.recorded, t2.arms[A].verdict, t2.arms[A].cand, t2.arms[B].verdict], [[], 'agree', ['nothing'], 'recoverable']);
  assert.equal(r.ticks.find(t => t.tick === 'RUN-3').arms[A].verdict, 'error');
  assert.equal(actionText({ type: 'record', op: 'withdraw', id: 'Q-5' }), 'record withdraw Q-5');
});

test('norn eval report: reads <out>/results.jsonl (a re-run tick counts once, its last row), --write = the JSON the Spend page reads', async () => {
  const out = mkTmp('evr-'), st = mkTmp('evr-st-'), lines = [];
  fs.writeFileSync(path.join(out, 'results.jsonl'), [...ROWS, res('RUN-1', B, [D, Q], [D, Q])].map(r => JSON.stringify(r)).join('\n') + '\n');
  const w = path.join(st, 'eval', 'checkin-replay.json');
  assert.equal(await evalCmd(['report', '--out', out, '--write', w, '--project', 'kestrel'], { out: s => lines.push(s), err: s => lines.push(s) }), 0);
  const j = JSON.parse(fs.readFileSync(w, 'utf8'));
  assert.equal(j.project, 'kestrel');
  assert.equal(j.arms_total.find(t => t.arm === B).ticks, 2);
  assert.equal(j.arms_total.find(t => t.arm === B).agree, 1, 'RUN-1 B re-run agrees: the last row counts');
  assert.ok(lines.some(l => l.startsWith(`${A}: 2 of 3 ticks agree`)));
  assert.ok(lines.some(l => l.startsWith(`CHOICE ${A} RUN-1 decision:beam`)));
  const e = [];
  assert.equal(await evalCmd(['report', '--out', mkTmp('evr-none-')], { out: () => {}, err: s => e.push(s) }), 2);
  assert.match(e[0], /no .*results\.jsonl/);
});
