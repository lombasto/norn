// RM-21 S1 (CAPACITY-UX 2, 4.3): one word module for why a queued run waits. One sample per term kind the fill walk (runs.mjs
// walkQueue) can write: built by running `readiness` on fixture queues where that is cheap, literal samples of the same builders
// elsewhere. A sample that falls through to the raw term (code 'unknown') fails. Temp dirs only; the fake executor stands in for claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { queueRun, readiness, queueSpecPath } from '../engine/lib/runs.mjs';
import { parseAfter } from '../engine/lib/after.mjs';
import { waitWords, firstReason, REASON_ORDER } from '../engine/lib/waitwords.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const NOW = Date.parse('2026-11-19T10:00:00Z');
function sandbox() {
  const t = mkTmp('meta-waitwords-'), state = path.join(t, 'state', 'demo'), locks = path.join(t, 'state', 'locks');
  for (const d of [state, locks]) fs.mkdirSync(d, { recursive: true });
  let n = 0;
  const opts = (o = {}) => {
    const k = ++n, wt = path.join(t, `wt${k}`), brief = path.join(t, `b${k}.md`), budget_file = o.budget_file ?? path.join(t, `budget-${k}.json`);
    fs.mkdirSync(wt, { recursive: true }); fs.writeFileSync(brief, 'mode: done\n');
    if (!o.budget_file) fs.writeFileSync(budget_file, JSON.stringify(o.budget ?? { max_claude_workers: 0 }));
    return { state, locksDir: locks, executor: 'fake', lane: `l${k}`, worktree: wt, notes: path.join(t, 'NOTES.md'), brief, policy: { auto_resume_max: 0 }, tick: null, ...o, budget_file };
  };
  return { t, state, opts };
}
const termsOf = (state, o = {}) => Object.fromEntries(readiness(state, { now: NOW, resources: () => ({ free_gb: 64, cpu_pct: 5 }), ...o }).map(r => [r.id, r.terms]));
const mapped = (t, ctx) => { const w = waitWords(t, ctx); assert.notEqual(w.code, 'unknown', `no words for the term: ${t}`); assert.notEqual(w.text, t); return w; };

test('readiness on fixture queues: cap full, slot kept for an older run, paused, not before, after, labels, budget unreadable - each has words', () => {
  const d = sandbox();
  const a = queueRun(d.opts()).run;                                            // cap 0: full
  const b = queueRun(d.opts()).run;                                            // the same cap: kept for a
  const pausedF = path.join(d.state, 'PAUSED'); fs.writeFileSync(pausedF, 'x\n');
  const c = queueRun(d.opts({ paused: [pausedF] })).run;
  const e = queueRun(d.opts({ notBefore: '2026-11-19T14:30:00.000Z' })).run;
  const f = queueRun(d.opts({ after: parseAfter(`run:${a}:merged`) })).run;
  const g = queueRun(d.opts({ labels: ['gpu'] })).run;
  const h = queueRun(d.opts()).run;
  fs.writeFileSync(JSON.parse(fs.readFileSync(queueSpecPath(d.state, h), 'utf8')).budget_file, '{ not json');
  const T = termsOf(d.state), ctx = { now: NOW, state: d.state };
  assert.match(T[a][0], /^cap: 0 claude workers running, budget max_claude_workers=0$/);
  assert.equal(mapped(T[a][0], ctx).text, 'Waiting for a free Claude slot (0 / 0). Next in line.');
  assert.equal(mapped(T[b][0], ctx).text, `Waiting for a free Claude slot; ${a} is ahead in line.`);
  assert.equal(mapped(T[c].find(x => x.startsWith('PAUSED')), ctx).text, 'Paused: this project (Pause everything).');
  assert.equal(mapped(T[c].find(x => x.startsWith('PAUSED')), { now: NOW, state: path.join(d.t, 'state', 'other') }).text, 'Paused: all of Norn (Pause everything).');
  assert.match(mapped(T[e][0], ctx).text, /^Starts at 2026-11-19 14:30Z\.$/, 'the default clock: the UTC minute');
  assert.equal(mapped(T[f][0], ctx).text, `Waiting for ${a} to merge.`);
  assert.equal(mapped(T[g].find(x => x.startsWith('labels ')), ctx).text, 'Offered to another machine (it needs gpu).');
  const bad = mapped(T[h][0], ctx);
  assert.equal(bad.code, 'budget'); assert.match(bad.text, /^Held: the budget file .* cannot be read/);
});

test('readiness: the machine-busy gate (CPU and RAM), with the numbers from the term', () => {
  const d = sandbox();
  const a = queueRun(d.opts({ budget: { max_claude_workers: 4 }, policy: { auto_resume_max: 0, fill: { max_cpu_pct: 90, min_free_gb: 4 } } })).run;
  const cpu = termsOf(d.state, { resources: () => ({ free_gb: 64, cpu_pct: 94.2 }) })[a][0];
  assert.equal(mapped(cpu).text, 'Held: this machine is busy (CPU 94 % > 90 %).');
  const ram = termsOf(d.state, { resources: () => ({ free_gb: 2, cpu_pct: 5 }) })[a][0];
  assert.equal(mapped(ram).text, 'Held: this machine is low on memory (2.0 GB free < 4 GB).');
});

// the builders the fill cannot reach cheaply here (a usage STATUS, a lock held by a live run, a merge slot, a login episode ...):
// samples in the exact form of the code that writes them (runs.mjs walkQueue, limitgate.mjs, authguard.mjs, usageguard.mjs, billing.mjs)
const LITERAL = {
  'needs a ruling: after: run:RUN-12:merged - RUN-12 was withdrawn': ['ruling', /^Needs a ruling: after: run:RUN-12/],
  'withdraw: queue spec missing': ['withdrawn', /^Withdrawn: queue spec missing\.$/],
  'auth: claude login down since 2026-11-19T09:00:00.000Z (Please run /login); next probe 2026-11-19T10:05:00.000Z': ['login', /^Held: the claude login is down since .*; run claude .*login \(next probe 2026-11-19 10:05Z\)\.$/],
  'auth: claude login down since 2026-11-19T09:00:00.000Z (401); probe due': ['login', /probe due/],
  'auth: claude login down since 2026-11-19T09:00:00.000Z (401); probe failed (2), next 2026-11-19T10:20:00.000Z': ['login', /probe failed \(2\)/],
  'auth: claude vendor outage since 2026-11-19T09:00:00.000Z (529 overloaded); next probe 2026-11-19T10:05:00.000Z': ['login', /vendor outage .* no login needed/],
  'auth: claude probe passed 2026-11-19T09:50:00.000Z; one canary launch since 2026-11-19T09:51:00.000Z, the rest wait for it': ['login', /one test launch goes first/],
  'auth: claude probe passed 2026-11-19T09:50:00.000Z; a canary launch is starting': ['login', /one test launch goes first/],
  'limit: claude out of quota until 2026-11-19T14:00:00.000Z (RUN-7: You have hit your limit) - route the work to an open executor instead (codex-sol)': ['quota', /^Held: claude is out of quota until /],
  'usage: weekly unknown': ['usage', /weekly usage is not measured yet/],
  'usage: RATE_OK unknown': ['usage', /hourly usage rate is not measured yet/],
  'usage: RATE_OK=0': ['usage', /^Held: usage over the hourly cap/],
  'usage: weekly 95.2 % >= guard 95 %': ['usage', /^Held: the week's usage \(95\.2 %\) reached the weekly stop \(95 %\)/],
  'usage: api spend $212.00 in 24 h >= cap $200.00': ['usage', /^Held: API spend \(\$212\.00 in 24 h\) reached the \$200\.00 daily cap\.$/],
  'after run:RUN-b-3:merged unmet': ['after', /^Waiting for RUN-b-3 to merge\.$/],   // a home's run id (RM-46)
  'after dlv:DLV-14:merged unmet': ['after', /^Waiting for DLV-14 to merge\.$/],
  'after q:Q-3:applied unmet': ['after', /^Waiting for your answer to Q-3 to be applied\.$/],
  'after dir:DIR-9:done unmet': ['after', /^Waiting for instruction DIR-9 to be done\.$/],
  'worktree held by RUN-4': ['folder', /^Waiting for its folder: RUN-4 is writing there\.$/],
  'lane worktree C:/wt/x held by RUN-5': ['folder', /^Waiting for its lane's folder: RUN-5 is writing there\.$/],
  'merge slots full: 1 merge(s) running in C:/r (RUN-6; policy.merge.parallel 1)': ['merge', /^Waiting for a merge slot \(1 merge running\)\.$/],
  'MERGE x: lane x has live run RUN-8 in C:/wt/x - the brief would rebase under it; write a staged brief: norn merge-brief --sha <READY sha> (DEC-5)': ['folder', /its lane is still writing \(RUN-8\)/],
  'cap max_codex, max_sol: kept for RUN-2, RUN-3 (fill order per cap)': ['kept', /^Waiting for a free Codex slot; RUN-2, RUN-3 are ahead in line\.$/],
  'cap: 5 claude workers running, budget max_claude_workers=5': ['cap', /^Waiting for a free Claude slot \(5 \/ 5\)\. Next in line\.$/],
  'refused: duplicate: lane x already has queued run RUN-9': ['refused', /^Not started: duplicate/],
};

test('literal samples: every term kind has its code and words, never the raw term', () => {
  for (const [t, [code, re]] of Object.entries(LITERAL)) { const w = mapped(t, { now: NOW }); assert.equal(w.code, code, t); assert.match(w.text, re, t); }
  assert.deepEqual(waitWords('something new the walk writes').code, 'unknown', 'an unmapped term is caught by the samples above');
  const lim = waitWords(Object.keys(LITERAL).find(t => t.startsWith('limit:')));
  assert.deepEqual(lim.acts, ['quota-back']); assert.match(lim.fix, /route the work/);
  assert.equal(waitWords('usage: RATE_OK=0').setting, 'usage_rate_cap_pct_per_h');
});

test('firstReason: the order of CAPACITY-UX 4.3, "+ n more" counts the rest, a ready row starts next', () => {
  const row = { ready: false, terms: ['cap: 5 claude workers running, budget max_claude_workers=5', 'after dlv:DLV-14:merged unmet', 'PAUSED queue (C:/s/demo/PAUSED)'] };
  const r = firstReason(row, { state: 'C:/s/demo' });
  assert.equal(r.code, 'paused'); assert.equal(r.text, 'Paused: this project (Hold the queue).'); assert.equal(r.more, 2);
  assert.equal(firstReason({ ready: false, terms: ['cap: 5 claude workers running, budget max_claude_workers=5', 'resources: CPU busy 94 % > fill.max_cpu_pct 90'] }).code, 'cap');
  assert.equal(firstReason({ ready: true, terms: [] }).code, 'ready');
  assert.equal(firstReason(null), null);
  assert.ok(REASON_ORDER.indexOf('ruling') < REASON_ORDER.indexOf('paused') && REASON_ORDER.indexOf('kept') < REASON_ORDER.indexOf('cap') && REASON_ORDER.indexOf('cap') < REASON_ORDER.indexOf('busy'));
});
