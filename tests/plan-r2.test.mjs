// META-PLAN R2 (norn DIR-13): the Plan on real data - one line per real chain, plain names, honest times. The fixture copies the SHAPE
// of the live norn runs.jsonl on 11-13 ~00:35Z (re-queued withdrawals, fill successors, a resumed fragment, MERGE runs), not its data.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, estimator, dayClock, makeLabeler, formatPlan } from '../engine/lib/plan.mjs';

const NOW = Date.parse('2026-11-12T22:00:00Z');   // a Thursday
const T = min => new Date(NOW + min * 60000).toISOString();
const run = (n, state, data = {}, o = {}) => {
  const id = `RUN-${n}`, created = o.created ?? T(-60);
  const history = [{ ev: ['queued', 'filled', 'withdrawn'].includes(state) ? 'queue' : 'start', ts: created }];
  const r = { id, kind: 'run', state, created, updated: created, data: { executor: 'claude', model: 'claude-opus-5-5', ...data }, history };
  if (o.end) { r.end = o.end; history.push({ ev: 'end', ts: o.endTs ?? T(-1), data: o.end }); }
  if (o.next) { r.fill = { next: o.next }; history.push({ ev: 'fill', ts: o.fillTs ?? T(-30), data: r.fill }); }
  if (o.resume) { r.resume = { next: o.resume }; history.push({ ev: 'resume', ts: o.endTs ?? T(-1), data: r.resume }); }
  if (state === 'withdrawn') { r.withdraw = { why: o.why }; history.push({ ev: 'withdraw', ts: o.wTs ?? T(-10), data: r.withdraw }); }
  return r;
};
const after = (id, state = 'merged') => ({ kind: 'run', id, state });
const done = (n, data, start, end, o = {}) => run(n, 'exited', data, { created: T(start), endTs: T(end), end: { outcome: 'done', ...(o.usage ? { usage: o.usage } : {}) }, ...o });
const unmet = (id, ...ts) => ({ id, ready: false, terms: ts.map(([r, s]) => `after run:${r}:${s} unmet`) });

// tonight's shape: A1 -> A2 (re-queued, fill successor) -> A3 + A4 -> A5 -> the ship review (re-queued 2x), S3 + PLAN running upstreams,
// a MERGE pair, and one dead chain (CI fix stopped, its follow-up withdrawn with nothing re-queued)
function tonight() {
  const runs = [
    done(5, { lane: 'mq', stage: 'MERGE' }, -300, -280), done(6, { lane: 'meta-auth', stage: 'MERGE' }, -200, -170),   // MERGE median 25 min
    run(10, 'filled', { lane: 'meta-adopt', stage: 'A1' }, { next: 'RUN-20' }), done(20, { lane: 'meta-adopt', stage: 'A1', from_queue: 'RUN-10' }, -240, -150),
    run(11, 'withdrawn', { lane: 'meta-adopt', stage: 'A2', after: [after('RUN-9')] }, { why: 'after: run:RUN-9:merged: RUN-9 stopped', wTs: T(-200) }),
    run(14, 'withdrawn', { lane: 'meta-adopt', stage: 'A3', after: [after('RUN-11')] }, { why: 'after: run:RUN-11:merged: RUN-11 withdrawn', wTs: T(-200) }),
    run(12, 'filled', { lane: 'meta-adopt', stage: 'A2', after: [after('RUN-10')] }, { next: 'RUN-30' }), done(30, { lane: 'meta-adopt', stage: 'A2', from_queue: 'RUN-12' }, -60, -5),
    run(13, 'queued', { lane: 'meta-adopt-mcp', stage: 'A4', after: [after('RUN-12')], budget_min: 60 }),
    run(31, 'running', { lane: 'meta-roadmap', stage: 'S3', budget_min: 120 }, { created: T(-40) }),
    run(32, 'queued', { lane: 'meta-adopt', stage: 'A3', after: [after('RUN-12'), after('RUN-31')], budget_min: 60 }),
    run(33, 'queued', { lane: 'meta-adopt', stage: 'A5', after: [after('RUN-32'), after('RUN-13')], budget_min: 60 }),
    run(34, 'withdrawn', { lane: 'meta-ootb', stage: 'OOTB-REVIEW', round: 2, model: 'claude-fable-5-2', after: [after('RUN-14')] }, { why: 'after: run:RUN-14:merged: RUN-14 withdrawn', wTs: T(-100) }),
    run(35, 'running', { lane: 'meta-plan', stage: 'PLAN', budget_min: 60 }, { created: T(-10) }),
    run(36, 'queued', { lane: 'meta-ootb', stage: 'OOTB-REVIEW', round: 2, model: 'claude-fable-5-2', after: [after('RUN-33'), after('RUN-35')], budget_min: 240 }),
    // the R1 ship review: a 40 min run that handed off, its resume a 4 min fragment
    run(50, 'exited', { lane: 'meta-ootb', stage: 'OOTB-REVIEW', model: 'claude-fable-5-2' }, { created: T(-600), endTs: T(-560), end: { outcome: 'handoff' }, resume: 'RUN-51' }),
    done(51, { lane: 'meta-ootb', stage: 'OOTB-REVIEW', model: 'claude-fable-5-2', resume_of: 'RUN-50' }, -555, -551),
    run(37, 'running', { lane: 'meta-ootb-fix', stage: 'MERGE', budget_min: 30 }, { created: T(-10) }),
    run(38, 'queued', { lane: 'meta-adopt', stage: 'MERGE', after: [after('RUN-37', 'ended')], budget_min: 30 }),
    run(40, 'exited', { lane: 'meta-gtp-ci', stage: 'CIRED-41c2f98' }, { created: T(-120), endTs: T(-90), end: { outcome: 'stopped' } }),
    run(41, 'withdrawn', { lane: 'meta-gtp-ci', stage: 'ENGINE-GIT', after: [after('RUN-40', 'done')] }, { why: 'after: run:RUN-40:done: RUN-40 ended stopped', wTs: T(-80) }),
  ];
  const ready = [unmet('RUN-13', ['RUN-12', 'merged']), unmet('RUN-32', ['RUN-12', 'merged'], ['RUN-31', 'merged']), unmet('RUN-33', ['RUN-32', 'merged'], ['RUN-13', 'merged']),
    unmet('RUN-36', ['RUN-33', 'merged'], ['RUN-35', 'merged']), unmet('RUN-38', ['RUN-37', 'ended'])];
  const roadmap = [{ id: 'RM-17', title: 'Out-of-the-box review: first run, README hook', links: ['lane:meta-ootb'] }, { id: 'RM-5', title: 'CI: three OS legs green', links: ['lane:meta-gtp-ci'] }];
  return { project: 'norn', runs, ready, roadmap, now: NOW };
}

test('R2 chains: one line per real chain - re-queues and fill successors collapse into ONE step per lane + stage (newest wins), no finished upstream tail', () => {
  const p = buildPlan(tonight());
  const lines = p.chains.map(c => c.steps.map(s => s.label).join(' > '));
  assert.equal(p.chains.length, 3, lines.join('\n'));
  const live = p.chains[0];
  assert.deepEqual(live.steps.map(s => [s.label, s.status]), [['Adopt A2', 'done'], ['Roadmap S3', 'running'], ['Plan', 'running'], ['Adopt A4 (MCP)', 'waiting'],
    ['Adopt A3', 'waiting'], ['Adopt A5', 'waiting'], ['Out-of-the-box review R2', 'waiting']]);
  assert.equal(live.broken, null, 'a withdrawn step re-queued (same lane + stage) is no break');
  for (const c of p.chains) {
    const keys = c.steps.map(s => `${s.lane}|${s.stage}`);
    assert.equal(new Set(keys).size, keys.length, `the same step twice: ${keys}`);
  }
  assert.ok(!lines.some(l => /A1/.test(l)), 'a finished upstream of a finished upstream is not pulled in');
  assert.deepEqual(p.chains[1].steps.map(s => s.label), ['Ootb fix merge', 'Adopt merge']);
  const dead = p.chains[2];
  assert.deepEqual(dead.steps.map(s => [s.label, s.status]), [['CI fix', 'stopped'], ['CI engine git', 'withdrawn']]);
  assert.equal(dead.broken, 'chain broken: CI fix stopped, CI engine git withdrawn');
});

test('R2 chains: "chain broken" only when a withdrawn step has no live successor; a finished chain shows for 24 h, then drops', () => {
  const base = [run(1, 'exited', { lane: 'adopt', stage: 'A1' }, { end: { outcome: 'stopped' } }),
    run(2, 'withdrawn', { lane: 'adopt', stage: 'A2', after: [after('RUN-1', 'done')] }, { why: 'after: run:RUN-1:done: RUN-1 ended stopped' })];
  assert.equal(buildPlan({ runs: base, now: NOW }).chains[0].broken, 'chain broken: Adopt A1 stopped, Adopt A2 withdrawn');
  const requeued = [...base, run(3, 'queued', { lane: 'adopt', stage: 'A2' })];
  assert.deepEqual(buildPlan({ runs: requeued, now: NOW }).chains, [], 'the re-queued A2 has no upstream: no chain, nothing broken');
  const fin = endTs => [done(4, { lane: 'road', stage: 'S1' }, -2000, -1900), done(5, { lane: 'road', stage: 'S2', after: [after('RUN-4', 'done')] }, -1800, endTs)];
  const c = buildPlan({ runs: fin(-23 * 60), now: NOW }).chains;
  assert.equal(c.length, 1); assert.equal(c[0].finished, true); assert.match(c[0].finish.word, /^finished /);
  assert.deepEqual(buildPlan({ runs: fin(-25 * 60), now: NOW }).chains, [], 'finished > 24 h ago: gone');
});

test('R2 estimates: a run\'s duration is its whole family (fill successors, resumes), fragments excluded; MERGE medians; upstream ETA + merge', () => {
  const t = tonight(), e = estimator(t.runs);
  const r = e({ lane: 'meta-ootb', stage: 'OOTB-REVIEW', executor: 'claude' });
  assert.equal(r.min, 44, 'RUN-50 (40 min, handoff) + its resume RUN-51 (4 min) = one 44 min sample, not a 4 min one');
  assert.equal(r.n, 1); assert.equal(r.word, '~45 min');
  assert.equal(e.mergeMin, 25, 'MERGE-stage median over every lane');
  const p = buildPlan(t), up = id => p.upnext.find(u => u.id === id);
  assert.equal(up('RUN-38').start.at, T(20), 'after the running ootb-fix MERGE (budget 30, started 10 min ago)');
  assert.equal(up('RUN-13').start.at, T(50), 'A2 is done: it lands with its lane\'s queued MERGE run (+20 start, +30)');
  assert.equal(up('RUN-32').start.at, T(105), 'S3 running: its ETA (+80) + the merge median (25)');
  assert.equal(up('RUN-33').start.at, T(190));
  assert.equal(up('RUN-36').start.at, T(275));
  assert.equal(p.chains[0].finish.at, T(344), 'the ship review (+275 +44) and its own merge (+25)');
  assert.equal(p.chains[1].finish.at, T(50), 'adopt MERGE ends +50; a MERGE sink adds no further merge');
  // no basis: say why in words
  const q = buildPlan({ runs: [run(1, 'running', { lane: 'a', stage: 'X' }), run(2, 'queued', { lane: 'a', stage: 'Y', after: [after('RUN-1', 'done')] })],
    ready: [unmet('RUN-2', ['RUN-1', 'done'])], now: NOW });
  assert.equal(q.chains[0].finish.at, null);
  assert.match(q.chains[0].finish.word, /^no estimate: A X has no time history or budget/);
});

test('R2 times: one day-aware format ("today 21:41", "Fri 02:13"), the zone named once; the CLI the same', () => {
  assert.equal(dayClock(Date.parse(T(30)), NOW), 'today 22:30');
  assert.equal(dayClock(Date.parse(T(4 * 60 + 13)), NOW), 'Fri 02:13');
  assert.equal(dayClock(Date.parse(T(-10 * 60)), NOW), 'today 12:00');
  assert.equal(dayClock(Date.parse(T(8 * 24 * 60)), NOW), 'Fri 11-20 22:00', 'a week or more away: the date too');
  const p = buildPlan(tonight());
  assert.equal(p.zone, 'UTC');
  const txt = formatPlan(p);
  assert.equal(txt.match(/UTC/g).length, 1, 'the zone named once');
  assert.ok(!/~\d\d:\d\d/.test(txt), 'no bare clock time without its day');
  assert.match(txt, /start ~today 23:45/); assert.match(txt, /start ~Fri 01:10/);
});

test('R2 names: the lane title (lane record / roadmap item) else the lane humanized without the project prefix; never a raw sha', () => {
  const t = tonight();
  const name = makeLabeler({ project: 'norn', runs: t.runs, roadmap: t.roadmap, lanes: [{ name: 'meta-plan', title: 'Plan tab' }] });
  assert.equal(name({ lane: 'meta-adopt-mcp', stage: 'A4' }), 'Adopt A4 (MCP)');
  assert.equal(name({ lane: 'meta-ootb', stage: 'OOTB-REVIEW', round: 2 }), 'Out-of-the-box review R2');
  assert.equal(name({ lane: 'meta-gtp-ci', stage: 'CIRED-41c2f98' }), 'CI fix');
  assert.equal(name({ lane: 'meta-plan', stage: 'PLAN' }), 'Plan tab');
  assert.equal(name({ lane: 'trees', stage: 'R4' }), 'Trees R4');
  assert.equal(name({ id: 'RUN-9' }), 'RUN-9', 'no lane: the run id');
  const p = buildPlan(t), labels = [...p.upnext.map(u => u.label), ...p.chains.flatMap(c => c.steps.map(s => s.label)), ...p.landing.map(l => l.label)];
  assert.ok(!labels.some(l => /[0-9a-f]{7}/.test(l)), labels.join(', '));
  assert.ok(p.upnext.every(u => /^RUN-\d+$/.test(u.id)), 'the RUN id stays beside it');
});

test('R2 forecast: queued work with no cost history = the executor + model median %/h x its estimated time, "~N % (rough)"', () => {
  const runs = [done(60, { lane: 'x', stage: 'Y' }, -200, -140, { usage: { cache_read_input_tokens: 1e8 } }), run(61, 'queued', { lane: 'z', budget_min: 30 })];
  const p = buildPlan({ runs, ready: [], status: '- 1 % over 1 h = 0.5 %/h vs cap 1.5\n- estimated weekly now ~40 %\nRATE_OK=1\n', budget: { weekly_stop_pct: 98, cacheR_per_pct: 5e7 }, now: NOW });
  assert.equal(p.upnext[0].estimate.cost, 1, '2 %/h (2 % over 60 min) x 30 min');
  assert.equal(p.upnext[0].estimate.costBasis, 'rough');
  assert.equal(p.forecast.costLine, 'queued work ~1 % (rough) of the 58 % left (1 of 1 runs estimated)');
});

test('R2 dashboard forecast: one source - the Plan tab reads the dashboard\'s own budget file (the weekly stop it shows elsewhere)', async () => {
  const { fixture } = await import('./helpers/dash-fixture.mjs');
  const f = await fixture({ dash: { planTtlMs: 0 } });
  try {
    let d;
    for (let i = 0; i < 200; i++) { d = (await f.get('/api/plan?project=kestrel')).data.parts[0]; if (!d.pending) break; await new Promise(r => setTimeout(r, 50)); }
    assert.ok(!d.pending && !d.error, JSON.stringify(d).slice(0, 300));
    assert.equal(d.forecast.stop, 95);
    assert.notEqual(d.forecast.line, 'no weekly stop set');
  } finally { await f.done(); }
});

test('R2 estimates: a run held by a live writer (its folder, or a MERGE while its lane writes) starts when that writer ends', () => {
  const runs = [run(1, 'running', { lane: 'road', stage: 'resolve', budget_min: 60 }, { created: T(-20) }), run(2, 'queued', { lane: 'road', stage: 'MERGE', budget_min: 30 })];
  const ready = [{ id: 'RUN-2', ready: false, terms: ['worktree held by RUN-1', 'MERGE road: lane road has live run RUN-1 in C:/x - write a staged brief'] }];
  const p = buildPlan({ runs, ready, now: NOW });
  assert.equal(p.upnext[0].start.at, T(40));
  const q = buildPlan({ runs, ready: [{ id: 'RUN-2', ready: false, terms: ['resources: free RAM 1 GB'] }], now: NOW });
  assert.equal(q.upnext[0].start.word, 'no estimate'); assert.equal(q.upnext[0].start.why, 'held: CPU / memory gate');
});
