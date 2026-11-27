// RM-b-21 S1b (CAPACITY-UX 4.3): one word module for why a queued run waits. One sample per term kind the fill walk (runs.mjs
// walkQueue) can write: built by running `readiness` on fixture queues where that is cheap, literal samples of the same builders
// elsewhere. A sample that falls through to the raw term (code 'unknown') fails, and so does a code with no sample. Temp dirs only;
// the fake executor stands in for claude.
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
const seen = new Set();
const mapped = (t, ctx) => { const w = waitWords(t, ctx); assert.notEqual(w.code, 'unknown', `no words for the term: ${t}`); assert.notEqual(w.text, t, `the raw term: ${t}`); seen.add(w.code); return w; };

test('readiness on fixture queues: cap full, slot kept for an older run, paused, not before, after, budget unreadable - each has words', () => {
  const d = sandbox();
  const a = queueRun(d.opts()).run;                                            // cap 0: full
  const b = queueRun(d.opts()).run;                                            // the same cap: kept for a
  const pausedF = path.join(d.state, 'PAUSED'); fs.writeFileSync(pausedF, 'x\n');
  const c = queueRun(d.opts({ paused: [pausedF] })).run;
  const e = queueRun(d.opts({ notBefore: '2026-11-19T14:30:00.000Z' })).run;
  const f = queueRun(d.opts({ after: parseAfter(`run:${a}:merged`) })).run;
  const h = queueRun(d.opts()).run;
  fs.writeFileSync(JSON.parse(fs.readFileSync(queueSpecPath(d.state, h), 'utf8')).budget_file, '{ not json');
  const T = termsOf(d.state), ctx = { now: NOW };
  assert.match(T[a][0], /^cap: 0 claude workers running, budget max_claude_workers=0/);
  assert.equal(mapped(T[a][0], ctx).text, 'waits for a worker slot');
  assert.match(mapped(T[a][0], ctx).reason, /^0 claude workers run of 0 \(max_claude_workers\)$/);
  const kept = mapped(T[b][0], ctx);
  assert.equal(kept.code, 'kept'); assert.equal(kept.text, 'waits for a worker slot'); assert.match(kept.reason, new RegExp(`goes to ${a} first`));
  const p = mapped(T[c].find(x => x.startsWith('PAUSED')), ctx);
  assert.equal(p.text, 'held: paused'); assert.match(p.reason, /Pause everything/);
  assert.equal(mapped(T[e][0], ctx).text, 'not before 2026-11-19 14:30Z', 'the default clock: the UTC minute');
  assert.equal(mapped(T[f][0], ctx).text, `waits for ${a} to merge`);
  const bad = mapped(T[h][0], ctx);
  assert.equal(bad.code, 'budget'); assert.match(bad.text, /^held: the budget file .* cannot be read$/);
});

test('readiness: the machine-busy gate (CPU and RAM), with the numbers in the reason', () => {
  const d = sandbox();
  const a = queueRun(d.opts({ budget: { max_claude_workers: 4 }, policy: { auto_resume_max: 0, fill: { max_cpu_pct: 90, min_free_gb: 4 } } })).run;
  const cpu = mapped(termsOf(d.state, { resources: () => ({ free_gb: 64, cpu_pct: 94.2 }) })[a][0]);
  assert.equal(cpu.text, 'held: CPU / memory gate'); assert.equal(cpu.reason, 'this machine is busy (CPU 94 % > 90 %)');
  const ram = mapped(termsOf(d.state, { resources: () => ({ free_gb: 2, cpu_pct: 5 }) })[a][0]);
  assert.equal(ram.reason, 'this machine is low on memory (2.0 GB free < 4 GB)');
});

// the builders the fill cannot reach cheaply here (a usage STATUS, a lock held by a live run, a merge slot, a login episode, another
// home's claim, a collision, the shares ...): samples in the exact form of the code that writes them (runs.mjs walkQueue / capFull /
// leaderRefusal / mergeStageRefusal / claimTerm, share.mjs slotVerdict, collide.mjs holdTerm, crew.mjs, limitgate.mjs, authguard.mjs,
// usageguard.mjs, billing.mjs, pausemode.mjs)
const LITERAL = {
  'withdraw: queue spec missing': ['withdrawn', /^withdrawn: queue spec missing$/],
  'withdraw: MERGE: merge leader is h2 - this home only opens PRs': ['withdrawn', /^withdrawn: MERGE: merge leader is h2/],
  'needs a ruling: after: run:RUN-12:merged - RUN-12 was withdrawn': ['ruling', /^needs a ruling \(the check-in repairs it\): after: run:RUN-12/],
  'after run:RUN-b-3:merged unmet': ['after', /^waits for RUN-b-3 to merge$/],   // a home's run id (RM-46)
  'after dlv:DLV-14:merged unmet': ['after', /^waits for finished work DLV-14 to reach main$/],
  'after q:Q-3:applied unmet': ['after', /^waits for your answer \(Q-3\) to be applied$/],
  'after dir:DIR-9:done unmet': ['after', /^waits for instruction DIR-9 to be done$/],
  'not_before 2026-11-19T14:30:00.000Z': ['not-before', /^not before 2026-11-19 14:30Z$/],
  'budget C:/m/local/budget.json unreadable (Unexpected token n in JSON at position 2): held until it parses': ['budget', /^held: the budget file C:\/m\/local\/budget\.json cannot be read$/],
  'MERGE: no merge leader confirmed yet (the tick claims it) - this home only opens PRs': ['leader', /^waits: this home is not the merge leader \(no merge leader confirmed yet/],
  'MERGE: merge leader claim not confirmed for 95 s (fenced) - this home only opens PRs': ['leader', /\(merge leader claim not confirmed for 95 s \(fenced\)\)$/],
  'PAUSED queue (C:/s/demo/PAUSED)': ['paused', /^held: paused$/],
  'usage: weekly unknown': ['usage', /^held: weekly usage not measured yet/],
  'usage: RATE_OK unknown': ['usage', /^held: hourly usage not measured yet$/],
  'usage: RATE_OK=0': ['usage', /^held: usage over the hourly cap$/],
  'usage: weekly 95.2 % >= guard 95 %': ['usage', /^held: weekly usage at the stop \(95\.2 % of 95 %\)$/],
  'usage: api spend $212.00 in 24 h >= cap $200.00': ['usage', /^held: API spend \$212\.00 in 24 h reached the \$200\.00 daily cap$/],
  'limit: claude out of quota until 2026-11-19T14:00:00.000Z (RUN-7: You have hit your limit) - route the work to an open executor instead (codex-sol)': ['quota', /^held: claude is out of quota until 2026-11-19 14:00Z$/],
  'auth: claude login down since 2026-11-19T09:00:00.000Z (Please run /login); next probe 2026-11-19T10:05:00.000Z': ['login', /^held: the claude login is down since .*; run claude .*login \(next probe 2026-11-19 10:05Z\)$/],
  'auth: claude login down since 2026-11-19T09:00:00.000Z (401); probe due': ['login', /probe due/],
  'auth: claude login down since 2026-11-19T09:00:00.000Z (401); probe failed (2), next 2026-11-19T10:20:00.000Z': ['login', /probe failed \(2\)/],
  'auth: claude vendor outage since 2026-11-19T09:00:00.000Z (529 overloaded); next probe 2026-11-19T10:05:00.000Z': ['login', /vendor outage .* no login needed/],
  'auth: claude probe passed 2026-11-19T09:50:00.000Z; one canary launch since 2026-11-19T09:51:00.000Z, the rest wait for it': ['login', /one test launch goes first/],
  'auth: claude probe passed 2026-11-19T09:50:00.000Z; a canary launch is starting': ['login', /one test launch goes first/],
  'cap max_codex, max_sol: kept for RUN-2, RUN-3 (fill order per cap)': ['kept', /^waits for a worker slot$/],
  'worktree held by RUN-4': ['folder', /^waits for its folder \(RUN-4 is writing there\)$/],
  'lane worktree C:/wt/x held by RUN-5': ['folder', /^waits for its lane's folder \(RUN-5 is writing there\)$/],
  'merge slots full: 1 merge(s) running in C:/r (RUN-6; policy.merge.parallel 1)': ['merge', /^waits for a merge slot \(1 merge running\)$/],
  'MERGE x: lane x has live run RUN-8 in C:/wt/x - the brief would rebase under it; write a staged brief: norn merge-brief --sha <READY sha> (DEC-5)': ['lane-writing', /^held: its lane is still writing/],
  'dwarf: Dun Testbeard is busy on RUN-7': ['dwarf', /^waits for Dun Testbeard, its pinned dwarf \(busy on RUN-7\)$/],
  'crew store C:/m/crew.jsonl unreadable (bad line 3): no worker run starts without a dwarf - repair or move the file': ['dwarf', /^held: the crew store is unreadable$/],
  'claim: scope overlaps h2/lane-a: engine/lib/x.mjs (held by h2)': ['claim', /^waits for the home h2: it has claimed this work \(scope overlaps h2\/lane-a/],
  'collide: territory (hard) (src/**) - waits for lane other': ['collide', /^waits for lane other: their work collides \(territory\)$/],
  'collide: exclusive - waits for lane other (a wait, ruled DEC-3)': ['collide', /^waits for lane other: their work collides \(exclusive\)$/],
  'collide: territory (soft) land-first: waits up to 30 min for DLV-5 of lane other (src/**)': ['collide', /^waits up to 30 min for lane other to land DLV-5 first/],
  'after (auto): dlv:DLV-5:merged - RUN-9 plans stage S2 after S1; lane other\'s S1 has not merged (queued)': ['order', /^waits for DLV-5 to merge first \(an automatic lane order: RUN-9 plans stage S2/],
  'after (auto): run:RUN-4:merged - the brief names engine/x.mjs (running)': ['order', /^waits for RUN-4 to merge first/],
  'ceiling: demo runs 2 Claude worker(s), max_claude_workers_project 2': ['ceiling', /^waits: demo already runs its most Claude workers \(2 of 2\)$/],
  'reserved: the free Claude slot is kept for other (reserve_claude_workers, 1 owed)': ['reserved', /^waits: the free Claude slot is kept for another project's reserve \(other, 1 owed\)$/],
  'share: the next Claude slot goes to other (waiting since 2026-11-19T09:00Z)': ['share', /^waits: the next Claude slot goes to other, which has waited longer$/],
  'cap: 5 claude workers running, budget max_claude_workers=5': ['cap', /^waits for a worker slot$/],
  'cap: 3 claude workers running, budget max_claude_workers=2 + merge_workers=1 (1 merging)': ['cap', /^waits for a worker slot$/],
  'cap: 3 claude workers running, budget max_claude_workers=3 (+ 1 merging, merge_workers=1)': ['cap', /^waits for a worker slot$/],
  'cap: 2 claude workers running, budget max_claude_workers=3: 1 slot(s) kept for the queued merges (fill.merge_reserve)': ['cap', /^waits for a worker slot \(1 kept for the queued merges\)$/],
  'cap: 1 codex workers running, budget max_codex=1': ['cap', /^waits for a worker slot$/],
  'resources: CPU busy 94 % > fill.max_cpu_pct 90': ['busy', /^held: CPU \/ memory gate$/],
  'refused: duplicate: lane x already has queued run RUN-9': ['refused', /^not started: duplicate/],
};

test('literal samples: every term kind has its code and words, never the raw term; every code has a sample', () => {
  for (const [t, [code, re]] of Object.entries(LITERAL)) { const w = mapped(t, { now: NOW }); assert.equal(w.code, code, t); assert.match(w.text, re, t); }
  assert.deepEqual(REASON_ORDER.filter(c => c !== 'unknown' && !seen.has(c)), [], 'a code with no sample term');
  assert.equal(waitWords('something new the walk writes').code, 'unknown', 'an unmapped term is caught by the samples above');
  const lim = waitWords(Object.keys(LITERAL).find(t => t.startsWith('limit:')));
  assert.match(lim.fix, /route the work/); assert.equal(lim.clears, 'by itself at the reset');
  assert.equal(waitWords('usage: RATE_OK=0').setting, 'usage_rate_cap_pct_per_h');
  assert.equal(waitWords('reserved: the free Claude slot is kept for other (reserve_claude_workers, 1 owed)').setting, 'reserve_claude_workers');
});

test('a term of a known kind in a form no pattern reads gets the kind\'s plain sentence, the raw term as its reason', () => {
  const res = 'resources: free RAM 1 GB', cap = 'cap: a slot form the walk does not write yet';
  assert.deepEqual([waitWords(res).code, waitWords(res).text, waitWords(res).reason], ['busy', 'held: CPU / memory gate', res]);
  assert.deepEqual([waitWords(cap).code, waitWords(cap).text, waitWords(cap).reason], ['cap', 'waits for a worker slot', cap]);
  assert.equal(waitWords(res).setting, null, 'no pattern read it: no setting to point at');
  assert.equal(waitWords('resources: free RAM 2.0 GB < fill.min_free_gb 4').setting, 'policy.fill.min_free_gb', 'the exact form keeps its setting');
  assert.equal(waitWords('cap: 5 claude workers running, budget max_claude_workers=5').setting, 'max_claude_workers', 'the exact form keeps its setting');
});

test('no share / reserved / ceiling / claim / collide term returns its raw string', () => {
  const raw = Object.keys(LITERAL).filter(t => /^(share|reserved|ceiling|claim|collide):/.test(t));
  assert.equal(raw.length, 7);
  for (const t of raw) { const w = waitWords(t); assert.notEqual(w.text, t); assert.ok(!/^(share|reserved|ceiling|claim|collide):/.test(w.text), `${t} -> ${w.text}`); assert.notEqual(w.reason, t); }
});

test('firstReason: the order of CAPACITY-UX 4.3, "+ n more" counts the rest, a ready row starts next', () => {
  const row = { ready: false, terms: ['cap: 5 claude workers running, budget max_claude_workers=5', 'after dlv:DLV-14:merged unmet', 'PAUSED queue (C:/s/demo/PAUSED)'] };
  const r = firstReason(row);
  assert.equal(r.code, 'paused'); assert.equal(r.term, 'PAUSED queue (C:/s/demo/PAUSED)'); assert.equal(r.more, 2);
  const ruling = 'needs a ruling: after: run:RUN-12:merged - RUN-12 was withdrawn', share = 'share: the next Claude slot goes to other (waiting since 2026-11-19T09:00Z)';
  const cap = 'cap: 5 claude workers running, budget max_claude_workers=5', res = 'resources: CPU busy 94 % > fill.max_cpu_pct 90';
  assert.equal(firstReason({ ready: false, terms: [res, cap, share, ruling] }).code, 'ruling');
  assert.equal(firstReason({ ready: false, terms: [res, cap, share] }).code, 'share');
  assert.equal(firstReason({ ready: false, terms: [res, cap] }).code, 'cap');
  assert.equal(firstReason({ ready: false, terms: [res] }).code, 'busy');
  const at = c => REASON_ORDER.indexOf(c);
  assert.ok(at('ruling') < at('share') && at('share') < at('cap') && at('cap') < at('busy'));
  assert.ok(at('kept') < at('ceiling') && at('ceiling') < at('reserved') && at('reserved') < at('share'), 'the share codes sit between kept and cap');
  assert.equal(firstReason({ ready: true, terms: [] }).code, 'ready');
  assert.equal(firstReason(null), null);
});
