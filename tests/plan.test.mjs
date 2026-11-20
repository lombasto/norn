// META-PLAN R1 (norn DIR-13): engine/lib/plan.mjs - the Plan tab's model (Up next, Chains, Landing next, Forecast), pure over fixtures
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, estimator, forecastOf, dayClock } from '../engine/lib/plan.mjs';
import { waitWords } from '../engine/lib/waitwords.mjs';
import { queueOf } from '../engine/lib/runs.mjs';

const NOW = Date.parse('2026-11-12T22:00:00Z');
const T = min => new Date(NOW + min * 60000).toISOString();
const run = (n, state, data = {}, o = {}) => {
  const id = `RUN-${n}`, created = o.created ?? T(-60);
  const history = [{ ev: state === 'queued' || state === 'filled' || state === 'withdrawn' ? 'queue' : 'start', ts: created }];
  const r = { id, kind: 'run', state, created, updated: created, data: { executor: 'claude', ...data }, history };
  if (o.end) { r.end = o.end; history.push({ ev: 'end', ts: o.endTs ?? T(-1), data: o.end }); }
  if (o.next) { r.fill = { next: o.next }; history.push({ ev: 'fill', ts: T(-30), data: r.fill }); }
  if (state === 'withdrawn') { r.withdraw = { why: o.why }; history.push({ ev: 'withdraw', ts: o.wTs ?? T(-10), data: r.withdraw }); }
  return r;
};
const after = (id, state = 'done') => ({ kind: 'run', id, state });
const STATUS = rate => `# META STATUS\r\nCI main: success abc 5 min\r\n- trailing 2 h since x: cacheR 62.4M over 2.0 h = ${rate} %/h vs cap 1.5 -> within cap\r\n- estimated weekly now ~35.9 % (new week: base 0 %); reset 2026-11-18T14:00Z\r\nRATE_OK=1\r\n`;

test('Up next: every queued run in the fill order itself (queueOf, priority then FIFO) - no second sort', () => {
  const runs = [run(5, 'queued', { lane: 'adopt', stage: 'A2' }), run(3, 'queued', { lane: 'adopt', stage: 'A1', priority: 'P3' }),
    run(7, 'queued', { lane: 'road', stage: 'S3', priority: 'P0' }), run(4, 'running', { lane: 'x' })];
  const p = buildPlan({ runs, ready: [], now: NOW });
  assert.deepEqual(p.upnext.map(u => u.id), queueOf(runs).map(q => q.id));
  assert.deepEqual(p.upnext.map(u => u.id), ['RUN-7', 'RUN-5', 'RUN-3']);
  assert.equal(p.upnext[1].label, 'Adopt A2'); assert.equal(p.upnext[0].position, 1);
});

test('hold-ups in plain words from the real walk terms (after / usage / resources / cap / not_before / question / worktree)', () => {
  const runs = [run(1, 'running', { lane: 'adopt', stage: 'A1' })];
  // RM-21 S1: the words are waitwords.mjs (the one word module); the Plan names runs with its own labeler
  const w = t => waitWords(t, { now: NOW, clock: dayClock, label: id => (id === 'RUN-1' ? 'Adopt A1' : id) }).text;
  assert.equal(w('after run:RUN-1:merged unmet'), 'Waiting for Adopt A1 to merge.');
  assert.equal(w('after run:RUN-1:done unmet'), 'Waiting for Adopt A1 to finish.');
  assert.equal(w('usage: RATE_OK=0'), 'Held: usage over the hourly cap. Clears by itself.');
  assert.equal(w('usage: weekly 96 % >= guard 95 %'), "Held: the week's usage (96 %) reached the weekly stop (95 %). Clears at the reset.");
  assert.equal(w('resources: free RAM 2.0 GB < fill.min_free_gb 4'), 'Held: this machine is low on memory (2.0 GB free < 4 GB).');
  assert.equal(w('cap max_claude_workers: kept for RUN-1 (fill order per cap)'), 'Waiting for a free Claude slot; Adopt A1 is ahead in line.');
  assert.equal(w('cap: 2 claude workers running, budget max_claude_workers=2'), 'Waiting for a free Claude slot (2 / 2). Next in line.');
  assert.equal(w('not_before 2026-11-12T23:03:00.000Z'), 'Starts at today 23:03.');   // R2: one day-aware clock
  assert.equal(w('after q:Q-12:answered unmet'), 'Waiting for your answer to Q-12.');
  assert.equal(w('worktree held by RUN-1'), 'Waiting for its folder: Adopt A1 is writing there.');
  assert.equal(w('PAUSED all (C:/x/PAUSED)'), 'Paused (Pause everything): C:/x/PAUSED holds every start.');
  const p = buildPlan({ runs: [...runs, run(2, 'queued', { lane: 'adopt', stage: 'A2', after: [after('RUN-1', 'merged')] })],
    ready: [{ id: 'RUN-2', ready: false, terms: ['after run:RUN-1:merged unmet', 'usage: RATE_OK=0'] }], now: NOW });
  assert.deepEqual(p.upnext[0].holds, ['Waiting for Adopt A1 to merge.', 'Held: usage over the hourly cap. Clears by itself.']);
  assert.deepEqual(p.upnext[0].terms, ['after run:RUN-1:merged unmet', 'usage: RATE_OK=0'], 'the raw walk terms ride along (the dashboard joins its reason)');
  assert.equal(p.upnext[0].status, 'held');
  const r = buildPlan({ runs: [run(9, 'queued', { lane: 'z' })], ready: [{ id: 'RUN-9', ready: true, terms: [] }], now: NOW });
  assert.equal(r.upnext[0].status, 'ready'); assert.deepEqual(r.upnext[0].holds, ['ready to start']);
});

test('estimates: median of this lane-stage-executor history, budget_min as the fallback, no basis = no estimate', () => {
  const done = (n, min) => run(n, 'exited', { lane: 'adopt', stage: 'A1' }, { created: T(-200), endTs: T(-200 + min), end: { outcome: 'done', usage: { cache_read_input_tokens: 41e6 * min / 100 } } });
  const runs = [done(1, 30), done(2, 50), done(3, 70), run(4, 'exited', { lane: 'adopt', stage: 'A1' }, { end: { outcome: 'crash' } })];
  const e = estimator(runs, { per: 41e6 });
  const a = e({ lane: 'adopt', stage: 'A1', executor: 'claude' });
  assert.equal(a.min, 50); assert.equal(a.basis, 'history'); assert.equal(a.n, 3); assert.equal(a.word, '~50 min');
  assert.ok(Math.abs(a.cost - 0.5) < 1e-9, 'cost in weekly % = median cache reads / cacheR_per_pct');
  const b = e({ lane: 'other', stage: 'A1', executor: 'claude', budget_min: 90 });
  assert.equal(b.min, 90); assert.equal(b.basis, 'budget'); assert.equal(b.word, '~1.5 h');
  // R2: no cost history of its own = the executor + model median %/h (0.6 %/h here) x its time, marked rough
  assert.ok(Math.abs(b.cost - 0.9) < 1e-9); assert.equal(b.costBasis, 'rough');
  const c = e({ lane: 'other', executor: 'claude' });
  assert.equal(c.min, null); assert.equal(c.word, 'no estimate');
});

test('chains: a 4-step chain done -> running -> waiting -> waiting, one line, shapes, an estimated finish, its roadmap item', () => {
  const runs = [
    run(1, 'exited', { lane: 'adopt', stage: 'A1' }, { end: { outcome: 'done' } }),
    run(2, 'filled', { lane: 'adopt', stage: 'A2', after: [after('RUN-1')], budget_min: 60 }, { next: 'RUN-5' }),
    run(5, 'running', { lane: 'adopt', stage: 'A2', budget_min: 60 }, { created: T(-20) }),
    run(3, 'queued', { lane: 'adopt', stage: 'A3', after: [after('RUN-2')], budget_min: 30 }),
    run(4, 'queued', { lane: 'adopt', stage: 'A4', after: [after('RUN-3')], budget_min: 30 }),
    run(8, 'queued', { lane: 'solo' }),
  ];
  const ready = [{ id: 'RUN-3', ready: false, terms: ['after run:RUN-2:done unmet'] }, { id: 'RUN-4', ready: false, terms: ['after run:RUN-3:done unmet'] }, { id: 'RUN-8', ready: true, terms: [] }];
  const roadmap = [{ id: 'RM-4', title: 'Adoption', links: ['lane:adopt'] }];
  const p = buildPlan({ runs, ready, roadmap, now: NOW });
  assert.equal(p.chains.length, 1, 'a lone queued run is no chain');
  const c = p.chains[0];
  // R2: a step = one lane + stage and the newest run wins: A2 is RUN-5, the run RUN-2 was filled into
  assert.deepEqual(c.steps.map(s => [s.id, s.status, s.shape]), [['RUN-1', 'done', 'check'], ['RUN-5', 'running', 'play'], ['RUN-3', 'waiting', 'ring'], ['RUN-4', 'waiting', 'ring']]);
  assert.equal(c.broken, null);
  // RUN-5 started 20 min ago with ~60 min: done in ~40, then +30, +30 = now + 100 min
  assert.equal(c.finish.at, T(100)); assert.match(c.finish.word, /^~/);
  assert.deepEqual(c.rm, { id: 'RM-4', title: 'Adoption' });
  assert.equal(p.upnext.find(u => u.id === 'RUN-4').start.at, T(70), 'start estimate = the upstream ETA');
});

test('chains: a withdrawn chain is broken for 24 h - "chain broken: X stopped, Y..Z withdrawn" - then drops out', () => {
  const runs = (wTs) => [
    run(1, 'exited', { lane: 'adopt', stage: 'A1' }, { end: { outcome: 'stopped' } }),
    run(2, 'withdrawn', { lane: 'adopt', stage: 'A2', after: [after('RUN-1')] }, { why: 'after: run:RUN-1:done: RUN-1 ended stopped', wTs }),
    run(3, 'withdrawn', { lane: 'adopt', stage: 'A3', after: [after('RUN-2')] }, { why: 'after: run:RUN-2:done: RUN-2 withdrawn', wTs }),
  ];
  const c = buildPlan({ runs: runs(T(-60)), ready: [], now: NOW }).chains[0];
  assert.equal(c.broken, 'chain broken: Adopt A1 stopped, Adopt A2..Adopt A3 withdrawn');
  assert.equal(c.shape, '!');
  assert.deepEqual(c.steps.map(s => s.shape), ['stop', 'stop', 'stop']);
  assert.equal(c.finish.word, 'no estimate: the chain is broken');
  assert.equal(buildPlan({ runs: runs(T(-25 * 60)), ready: [], now: NOW }).chains.length, 0, 'older than 24 h: gone');
});

test('landing next: merging now, then the merge queue in its order, plain-words state; CI red on main blocks', () => {
  const runs = [run(1, 'running', { lane: 'road', stage: 'MERGE' }), run(2, 'queued', { lane: 'adopt', stage: 'MERGE' })];
  const ready = [{ id: 'RUN-2', ready: false, terms: ['merge slots full: 2 merge(s) running in /r (RUN-1, RUN-9; policy.merge.parallel 2)'] }];
  const merges = { rows: [{ id: 'DLV-7', lane: 'cv', branch: 'feat/cv', word: 'clean', delivers: 'cv view' }, { id: 'DLV-3', lane: 'adopt', branch: 'feat/adopt', word: 'conflict: a.mjs' }] };
  const p = buildPlan({ runs, ready, merges, now: NOW, status: STATUS('0.62') });
  assert.deepEqual(p.landing.map(l => [l.id, l.word]), [['RUN-1', 'merging now'], ['DLV-7', 'ready to merge'], ['DLV-3', 'Waiting for a merge slot (2 merges running).']]);
  const red = buildPlan({ runs: [], ready: [], merges, now: NOW, status: STATUS('0.62').replace('CI main: success', 'CI main: failure') });
  assert.deepEqual(red.landing.map(l => l.word), ['blocked: CI red on main', 'blocked: CI red on main']);
});

test('forecast arithmetic: rate vs cap, weekly vs the stop, "lasts to the reset" or the stop time, queued cost vs headroom', () => {
  const f = forecastOf({ status: STATUS('0.62'), budget: { weekly_stop_pct: 95 }, now: NOW, queuedCost: { pct: 2, n: 2, of: 3 } });
  assert.equal(f.rate, 0.62); assert.equal(f.cap, 1.5); assert.equal(f.weekly, 35.9); assert.equal(f.stop, 95);
  assert.ok(Math.abs(f.headroom - 59.1) < 1e-9);
  assert.equal(f.reset, '2026-11-18T14:00:00.000Z');
  // 59.1 % left / 0.62 %/h = 95.3 h; the reset is 136 h away -> the stop comes first
  assert.equal(f.line, 'at this rate the weekly stop is reached Mon 21:19');   // R2: within the week = the weekday
  assert.equal(f.costLine, 'queued work ~2 % of the 59.1 % left (2 of 3 runs estimated)');
  const slow = forecastOf({ status: STATUS('0.3'), budget: { weekly_stop_pct: 95 }, now: NOW });
  assert.equal(slow.line, 'at this rate it lasts to the reset (Wed 14:00)');   // 197 h > 136 h
  const over = forecastOf({ status: STATUS('0.3').replace('~35.9', '~96.0'), budget: { weekly_stop_pct: 95 }, now: NOW });
  assert.equal(over.line, 'weekly stop reached: new Claude work waits for the reset (Wed 14:00)');
  assert.equal(forecastOf({ status: '', budget: {}, now: NOW }).line, 'usage not measured yet');
});

test('norn plan: the text and --json from a state dir (read-only), usage errors exit 2', async () => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs'), path = await import('node:path'), { mkTmp } = await import('./helpers/tmp.mjs');
  const { record } = await import('../engine/lib/records.mjs');
  const { queueSpecPath } = await import('../engine/lib/runs.mjs');
  const META = path.join(import.meta.dirname, '..', 'engine', 'bin', 'norn.mjs');
  const t = mkTmp('meta-plan-'), state = path.join(t, 'state', 'demo');
  fs.mkdirSync(state, { recursive: true });
  const env = { ...process.env, META_NO_TICK: '1', META_ROOT: t };
  for (const k of ['META_STATE', 'META_PROJECT']) delete env[k];
  const meta = (...a) => spawnSync(process.execPath, [META, ...a], { env, encoding: 'utf8' });
  const empty = meta('plan', '--state', state);
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /^Plan - demo   \(times in UTC\)\n\nUp next\n  nothing is waiting to start\n\nChains\n  no queued run waits for another\n\nLanding next\n  nothing is heading to main/);
  record(state, { kind: 'run', ev: 'queue', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'adopt', stage: 'A1', budget_min: 30, not_before: '2099-01-01T00:00:00Z' } });
  fs.mkdirSync(path.dirname(queueSpecPath(state, 'RUN-1')), { recursive: true });
  fs.writeFileSync(queueSpecPath(state, 'RUN-1'), JSON.stringify({ state, executor: 'fake', lane: 'adopt', stage: 'A1', worktree: t, budget_file: path.join(t, 'budget.json') }));
  const before = fs.readFileSync(path.join(state, 'runs.jsonl'), 'utf8');
  const txt = meta('plan', '--state', state);
  assert.equal(txt.status, 0, txt.stderr);
  assert.match(txt.stdout, /1\. Adopt A1 \(RUN-1\)  ~30 min  start ~Thu 01-01 00:00  - Starts at Thu 01-01 00:00./);
  const js = JSON.parse(meta('plan', '--json', '--state', state).stdout);
  assert.equal(js.upnext[0].id, 'RUN-1'); assert.equal(js.upnext[0].estimate.basis, 'budget');
  assert.equal(fs.readFileSync(path.join(state, 'runs.jsonl'), 'utf8'), before, 'read-only: no record written');
  const bad = meta('plan', '--nope');
  assert.equal(bad.status, 2); assert.match(bad.stderr, /usage: norn plan/);
});

test('ui: Plan sits in Work; Runs has no queue table (a queued run is a tree row); Plan renders sections, all-projects groups and plain-words empty states', async () => {
  const { NAV, TABS, renderTab } = await import('../engine/dash/ui.mjs');
  const { TABS: SERVER_TABS } = await import('../engine/dash/server.mjs');
  assert.ok(NAV.find(d => d[0] === 'work')[2].includes('plan'));
  assert.ok(TABS.some(t => t[0] === 'plan') && SERVER_TABS.includes('plan'));
  const queue = [{ id: 'RUN-4', position: 1, lane: 'qlane', state: 'queued', project: 'demo' }];
  const ag = renderTab('runs', { tree: [], queue }, { project: 'demo' });
  assert.ok(!/Queued|<table/.test(ag), 'no queue table on Runs: the queue detail is on Plan');
  assert.match(ag, /class="node lvl0" id="node-RUN-4"[^]*?qlane/, 'the queued run is a row of the tree (owner 2026-11-19)');
  const empty = renderTab('plan', { parts: [buildPlan({ project: 'demo', now: NOW })] }, { project: 'demo', now: NOW });
  for (const s of ['id="panel-plan"', 'Up next', 'Nothing is waiting to start.', 'Chains', 'No queued run waits for another run.', 'Landing next', 'Nothing is heading to main.',
    'Forecast', 'Usage not measured yet.']) assert.ok(empty.includes(s), s);
  assert.ok(!/undefined|NaN|null</.test(empty));
  const runs = [run(1, 'running', { lane: 'adopt', stage: 'A1', budget_min: 60 }, { created: T(-20) }), run(2, 'queued', { lane: 'adopt', stage: 'A2', after: [after('RUN-1', 'merged')] })];
  const p = buildPlan({ project: 'demo', runs, ready: [{ id: 'RUN-2', ready: false, terms: ['after run:RUN-1:merged unmet'] }], status: STATUS('0.62'), budget: { weekly_stop_pct: 95 }, now: NOW });
  const html = renderTab('plan', { parts: [p, { project: 'kestrel', pending: true }] }, { project: 'all', now: NOW });
  for (const s of ['Adopt A2', 'RUN-2', 'Waiting for Adopt A1 to merge.', 'class="pl-chain"', 'class="pl-step s-play"', 'class="pl-step s-ring"', 'at this rate the weekly stop is reached',
    '>demo<', '>kestrel<', 'Working out the plan']) assert.ok(html.includes(s), s);
});
