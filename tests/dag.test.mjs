// The work DAG: the --queue usage guard, run:RUN-n:merged, --priority, `norn ready`, the priority fill order and the resource gate. Temp dirs only; the fake executor stands in for claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startRun, fillQueue, queueRun, queueOf, readiness, readyWords, FILL_DEFAULTS, resourceRefusal, sampleResources } from '../engine/lib/runs.mjs';
const loadRuns = d => Object.values(loadState(d.state).items).filter(i => i.kind === 'run');
import { digest } from '../engine/lib/digest.mjs';
import { renderDigest } from '../engine/lib/views.mjs';
import { parseAfter, makeEval } from '../engine/lib/after.mjs';
import { loadState, record } from '../engine/lib/records.mjs';
import { fileURLToPath } from 'node:url';
import { mkTmp } from './helpers/tmp.mjs';
import { waitFor, runEnded, stateBusy } from './helpers/wait.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const meta = (args, env = {}) => {
  const r = spawnSync(process.execPath, [META, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, META_ROLE: '', META_PROJECT: '', META_STATE: '', META_NO_TICK: '1', ...env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};

function sandbox() {
  const t = mkTmp('meta-dag-');
  const d = { t, state: path.join(t, 'state', 'demo'), locks: path.join(t, 'state', 'locks'), notes: path.join(t, 'NOTES.md') };
  for (const k of ['state', 'locks']) fs.mkdirSync(d[k], { recursive: true });
  d.wt = n => { const w = path.join(t, 'wt' + n); fs.mkdirSync(w, { recursive: true }); return w; };
  d.brief = (body, name = 'brief.md') => { const f = path.join(t, name); fs.writeFileSync(f, body); return f; };
  d.item = id => loadState(d.state).items[id];
  // GAP-2: a queued run reads its budget FILE at fill (no copy is kept): each launch writes the budget it is given to a file of its own
  let nb = 0;
  d.opts = (o = {}) => {
    const budget = o.budget ?? { max_claude_workers: 4 }, budget_file = path.join(t, `budget-${++nb}.json`);
    fs.writeFileSync(budget_file, JSON.stringify(budget));
    return { state: d.state, locksDir: d.locks, executor: 'fake', lane: 'demo', worktree: d.wt(1), notes: d.notes, hbMs: 150, staleMs: 3000,
      policy: { auto_resume_max: 0 }, tick: null, brief: d.brief('mode: done\n'), ...o, budget, budget_file };
  };
  // ended AND its supervisor gone: the run's own end-of-run fill (under queue.lock) is done (FINDING L1; FILLWAKE F2 lets a
  // supervisor pass again when the test's fill left the re-fill flag, so the race is no longer rare here)
  // progress-based (DEC-84 B): fails when the run's supervisor is gone unsettled, never on a clock
  d.ended = id => runEnded(d.state, id);
  return d;
}

// piece 0 (controller 11-09, norn RUN-36): `norn run --queue` with a free slot started at once at RATE_OK=0 - the immediate path
// skipped the usage guard the fill applies. Refused = QUEUED (the fill starts it later); MERGE keeps its RATE_OK exemption.
test('--queue with a free slot obeys the weekly guard + RATE_OK: refused = queued; MERGE exempt from RATE_OK only', async () => {
  const d = sandbox();
  const status = path.join(d.t, 'STATUS.md');
  const setStatus = (weekly, ok) => fs.writeFileSync(status, `- estimated weekly now ~${weekly} % (calib 1 %)\nRATE_OK=${ok}\n`);
  const budget = { max_claude_workers: 2, weekly_stop_pct: 95, usage_rate_cap_pct_per_h: 0.43 };
  const o = (stage, n) => d.opts({ brief: d.brief('mode: done\n', `b${n}.md`), worktree: d.wt(n), lane: `l${n}`, stage, budget, statusFile: status, queue: true });
  setStatus(50, 0);
  const work = startRun(o('S1', 1));
  assert.equal(work.queued, true, 'RATE_OK=0: queued, not started');
  assert.match(work.why, /RATE_OK=0/);
  assert.equal(d.item(work.run).state, 'queued');
  const merge = startRun(o('MERGE', 2));
  assert.ok(!merge.queued, 'a MERGE stage starts at RATE_OK=0');
  await d.ended(merge.run);
  setStatus(96, 1);
  const past = startRun(o('MERGE', 3));
  assert.equal(past.queued, true, 'past the weekly guard: MERGE queues too');
  setStatus(50, 1);
  // the merge run's supervisor fills on its exit too (one filler at a time): level-triggered, either filler may start them
  await waitFor(() => { fillQueue(d.state); return [work.run, past.run].every(id => d.item(id).state === 'filled'); }, { producer: stateBusy(d.state), what: 'the fill starts both' });
  for (const id of [work.run, past.run]) await d.ended(d.item(id).fill.next);
});

// ---------- piece 1: run:RUN-n:merged ----------
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
function repoWithBranch(d) {
  const repo = path.join(d.t, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(d.t, 'nohooks')]]) git(repo, 'config', k, v);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); git(repo, 'add', 'a.txt'); git(repo, 'commit', '-q', '-m', 'a');
  const wt = path.join(d.t, 'feat');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat', wt);
  fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n'); git(wt, 'add', 'b.txt'); git(wt, 'commit', '-q', '-m', 'b');
  return { repo, wt, head: git(wt, 'rev-parse', 'HEAD') };
}

test('parseAfter takes the ids of a home (run:RUN-b-12, q:Q-b2-3, dir:DIR-b-4) as records writes them (L-02)', () => {
  assert.deepEqual(parseAfter('run:RUN-b-12,q:Q-b2-3,dir:DIR-b-4'), [{ kind: 'run', id: 'RUN-b-12', state: 'done' }, { kind: 'q', id: 'Q-b2-3', state: 'answered' }, { kind: 'dir', id: 'DIR-b-4', state: 'done' }]);
  assert.throws(() => parseAfter('run:RUN-B-1'), /run needs a RUN-n id/);
});

test('after run:RUN-n:merged: waits while the DONE run\'s end head is not on main, starts once merged; not DONE = held for a ruling (META-AUTONOMY R1: never a silent withdraw)', async () => {
  const d = sandbox();
  assert.deepEqual(parseAfter('run:RUN-7:merged'), [{ kind: 'run', id: 'RUN-7', state: 'merged' }]);
  const g = repoWithBranch(d);
  const a = startRun(d.opts({ lane: 'feat', worktree: g.wt, brief: d.brief('mode: done\n', 'a.md') }));
  const ea = await d.ended(a.run);
  assert.equal(ea.end.head, g.head, 'the end evidence carries the head sha (NORN-WATCH S5)');
  const b = startRun(d.opts({ lane: 'next', worktree: d.wt(2), after: parseAfter(`run:${a.run}:merged`) }));
  assert.equal(b.queued, true);
  assert.deepEqual(fillQueue(d.state), [], 'DONE but not merged: waits');
  assert.equal(d.item(b.run).state, 'queued');
  git(g.repo, 'merge', '-q', '--ff-only', 'feat');
  const got = fillQueue(d.state);
  assert.deepEqual(got.map(x => x.queued), [b.run], 'merged into main: starts');
  await d.ended(got[0].next);
  const c = startRun(d.opts({ lane: 'stop', worktree: d.wt(3), brief: d.brief('mode: stopped\n', 'c.md') }));
  await d.ended(c.run);
  const e = startRun(d.opts({ lane: 'after-stop', worktree: d.wt(4), after: parseAfter(`run:${c.run}:merged`) }));
  assert.deepEqual(fillQueue(d.state), []);
  assert.equal(d.item(e.run).state, 'queued', 'ended not DONE: the merge can never come - held, not withdrawn');
  assert.match(d.item(e.run).hold.why, /ended stopped/);
});

test('run:RUN-n:merged follows a HANDOFF successor to the run that ended DONE and checks ITS head', () => {
  const d = sandbox();
  const rec = (ev, data, id) => record(d.state, { kind: 'run', ev, id, by: 'launcher', data }, { views: false });
  const r1 = rec('start', { kind: 'fake', lane: 'x', worktree: d.wt(1) }).id;
  rec('end', { exit: 0, outcome: 'handoff', head: 'aaaa111' }, r1);
  const r2 = rec('start', { kind: 'fake', lane: 'x', worktree: d.wt(1), resume_of: r1 }).id;
  rec('resume', { next: r2 }, r1);
  const asked = [];
  const fakeGit = (repo, args) => { asked.push(args.join(' ')); if (args[0] === 'merge-base' && args[2] === 'bbbb222') return ''; throw new Error('no'); };
  fakeGit.calls = 0;
  const ev = makeEval(d.state, { git: (repo, args, o) => { try { return fakeGit(repo, args); } catch (e) { if (o?.allowFail) return null; throw e; } } });
  const c = { kind: 'run', id: r1, state: 'merged' };
  assert.deepEqual(ev(c), { met: false, gone: null }, 'the successor still runs');
  rec('end', { exit: 0, outcome: 'done', head: 'bbbb222' }, r2);
  assert.deepEqual(makeEval(d.state, { git: (repo, args, o) => { try { return fakeGit(repo, args); } catch (e) { if (o?.allowFail) return null; throw e; } } })(c), { met: true, gone: null });
  assert.ok(asked.some(a => a.startsWith('merge-base --is-ancestor bbbb222')), 'the DONE successor\'s head, not the HANDOFF one');
});

test('norn run --priority Pn: the queued run carries it; a priority outside P0-P4 is refused', () => {
  const d = sandbox();
  const run = (lane, n, ...more) => meta(['run', '--executor', 'fake', '--lane', lane, '--brief', d.brief('mode: done\n'), '--worktree', d.wt(n), '--locks', d.locks, ...more, '--state', d.state]);
  const dir = record(d.state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'go', via: 'chat' } }, { views: false }).id;
  const q = run('w', 1, '--priority', 'P0', '--after', `dir:${dir}`);
  assert.equal(q.code, 0, q.err);
  assert.equal(d.item(q.out.match(/QUEUED (RUN-\d+)/)[1]).data.priority, 'P0');
  assert.equal(run('w3', 3, '--priority', 'high').code, 2, 'bad priority');
});

// ---------- norn ready is the fill's own walk, dry, so what it calls ready is what the fill starts (each unmet term named) ----------
test('readiness: one walk names every unmet term; the fill starts exactly the rows it calls ready (cap accounting included)', async () => {
  const d = sandbox();
  const q = record(d.state, { kind: 'question', ev: 'create', by: 'checkin', data: { title: 'pick', lane: 'demo', options: [{ key: 'a', text: 'A' }], blocks: [] } }, { views: false }).id;
  const later = new Date(Date.now() + 3600e3).toISOString();
  const budget = { max_claude_workers: 1 };
  const a = queueRun(d.opts({ lane: 'a', worktree: d.wt(1), budget, after: parseAfter(`q:${q}`) })).run;
  const b = queueRun(d.opts({ lane: 'b', worktree: d.wt(2), budget, notBefore: later })).run;
  const c = queueRun(d.opts({ lane: 'c', worktree: d.wt(3), budget })).run;
  const e = queueRun(d.opts({ lane: 'e', worktree: d.wt(4), budget })).run;
  const rows = readiness(d.state);
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.deepEqual(rows.map(r => r.id), [a, b, c, e], 'fill order');
  assert.deepEqual(by[a].terms, [`after q:${q}:answered unmet`]);
  assert.deepEqual(by[b].terms, [`not_before ${later}`]);
  assert.equal(by[c].ready, true);
  assert.equal(by[c].terms.length, 0);
  assert.equal(by[e].ready, false, 'c would take the only claude slot');
  assert.match(by[e].terms.join(), /^cap: 1 claude workers running, budget max_claude_workers=1/);
  assert.equal(readyWords(by[a]), `blocked: after q:${q}:answered unmet`);
  assert.equal(readyWords(by[c]), 'ready');
  const j = meta(['ready', '--json', '--state', d.state, '--locks', d.locks]);
  assert.equal(j.code, 0, j.err);
  assert.deepEqual(JSON.parse(j.out).map(r => [r.id, r.ready, r.terms]), rows.map(r => [r.id, r.ready, r.terms]), 'norn ready --json = the walk');
  const txt = meta(['ready', '--state', d.state]).out.split('\n');
  assert.match(txt.find(l => l.startsWith(a)), new RegExp(`lane a .*blocked: after q:${q}:answered unmet`));
  assert.match(txt.find(l => l.startsWith(c)), /lane c .*ready$/);
  const got = fillQueue(d.state);
  assert.deepEqual(got.map(x => x.queued), rows.filter(r => r.ready).map(r => r.id), 'the fill starts exactly the ready rows');
  const view = fs.readFileSync(path.join(d.state, 'META-QUEUE.md'), 'utf8');
  assert.match(view, new RegExp(`${a} .*; blocked: after q:${q}:answered unmet`), 'the queue view shows the same words');
  const dg = digest(d.state, {}, { dlv: [] });
  const qa = dg.sections.queued.find(x => x.id === a);
  assert.equal(qa.ready, false);
  assert.deepEqual(qa.terms, by[a].terms);
  assert.match(renderDigest(dg), new RegExp(`- ${a} a .*; blocked: after q:${q}:answered unmet`), 'digest sec. 2 shows the same words');
  // c's end-of-run fill starts e (the slot is free again): every run this test caused settles here, not after the file
  await waitFor(() => !stateBusy(d.state)(), { what: 'every run the fills started settled' });
});

test('readiness: a gone trigger reads "needs a ruling: ..." in the dry walk and the fill holds it (META-AUTONOMY R1)', () => {
  const d = sandbox();
  const q = record(d.state, { kind: 'question', ev: 'create', by: 'checkin', data: { title: 'pick', lane: 'demo', options: [{ key: 'a', text: 'A' }], blocks: [] } }, { views: false }).id;
  const a = queueRun(d.opts({ lane: 'a', worktree: d.wt(1), after: parseAfter(`q:${q}`) })).run;
  const b = queueRun(d.opts({ lane: 'b', worktree: d.wt(2), after: parseAfter(`q:${q}`) })).run;
  record(d.state, { kind: 'question', ev: 'withdraw', id: q, by: 'checkin', data: {} }, { views: false });
  const rows = readiness(d.state);
  assert.deepEqual(rows.map(r => [r.id, r.ready, r.hold]), [[a, false, `after: q:${q}:answered: ${q} withdrawn`], [b, false, `after: q:${q}:answered: ${q} withdrawn`]]);
  assert.equal(d.item(a).state, 'queued', 'the dry walk writes nothing');
  fillQueue(d.state);
  assert.equal(d.item(a).state, 'queued');
  assert.equal(d.item(a).hold.why, `after: q:${q}:answered: ${q} withdrawn`);
});

// ---------- piece 4: fill order = priority (P0 first; none = P2, the beads default), then FIFO ----------
test('fill order: priority then FIFO; with no priority the order is exactly the old FIFO', async () => {
  const d = sandbox();
  const budget = { max_claude_workers: 1 };
  const q = (lane, n, priority) => queueRun(d.opts({ lane, worktree: d.wt(n), budget, priority })).run;
  const plain = [q('f1', 1), q('f2', 2), q('f3', 3)];
  assert.deepEqual(queueOf(loadRuns(d)).map(x => [x.id, x.position]), plain.map((id, i) => [id, i + 1]), 'no priority: FIFO, positions as before');
  assert.deepEqual(readiness(d.state).map(r => r.id), plain);
  const p3 = q('p3', 4, 'P3'), p2 = q('p2', 5, 'P2'), p1 = q('p1', 6, 'P1'), p0 = q('p0', 7, 'P0');
  const order = [p0, p1, ...plain, p2, p3];
  assert.deepEqual(queueOf(loadRuns(d)).map(x => x.id), order, 'P0, P1, then none = P2 FIFO with the explicit P2, then P3');
  assert.deepEqual(queueOf(loadRuns(d)).map(x => x.position), order.map((_, i) => i + 1));
  const rows = readiness(d.state);
  assert.deepEqual(rows.map(r => r.id), order);
  assert.deepEqual(rows.filter(r => r.ready).map(r => r.id), [p0], 'one claude slot: the P0 run');
  assert.match(rows.find(r => r.id === p1).terms.join(), /^cap: 1 claude workers running/, "P1 finds the slot P0 would take");
  assert.deepEqual(rows.find(r => r.id === plain[0]).terms, [`cap max_claude_workers: kept for ${p1} (fill order per cap)`]);
  const got = fillQueue(d.state);
  assert.deepEqual(got.map(x => x.queued), [p0], 'the fill starts what norn ready said');
  // each run's end-of-run fill starts the next queued one (P0 -> P1 -> f1 .. f3 -> P2 -> P3): the whole chain settles here - left
  // running, its last supervisor (RUN-14) outlived the file (CI 44335427788 windows LEAK RED)
  await waitFor(() => !stateBusy(d.state)(), { what: 'the chain of fills settled' });
});

test('resource gate: the fill and norn ready hold a run while RAM / CPU are short (one sample per pass); no policy.fill = no gate', async () => {
  const d = sandbox();
  let calls = 0, cur = { free_gb: 2, cpu_pct: 10 };
  const resources = () => { calls++; return cur; };
  const fill = {};   // the CLI resolves project policy.fill over FILL_DEFAULTS into every run spec
  const a = queueRun(d.opts({ lane: 'a', worktree: d.wt(1), policy: { auto_resume_max: 0, fill } })).run;
  const b = queueRun(d.opts({ lane: 'b', worktree: d.wt(2), policy: { auto_resume_max: 0, fill } })).run;
  let rows = readiness(d.state, { resources });
  assert.deepEqual(rows.map(r => r.terms), [['resources: free RAM 2.0 GB < fill.min_free_gb 4'], ['resources: free RAM 2.0 GB < fill.min_free_gb 4']]);
  assert.equal(calls, 1, 'sampled once per walk');
  assert.deepEqual(fillQueue(d.state, { resources }), [], 'the fill holds them');
  cur = { free_gb: 8, cpu_pct: 97 };
  assert.deepEqual(readiness(d.state, { resources })[0].terms, ['resources: CPU busy 97 % > fill.max_cpu_pct 90']);
  assert.deepEqual(fillQueue(d.state, { resources }), []);
  cur = { free_gb: 8, cpu_pct: 20 };
  rows = readiness(d.state, { resources });
  assert.deepEqual(rows.map(r => r.ready), [true, true]);
  const got = fillQueue(d.state, { resources });
  assert.deepEqual(got.map(x => x.queued), [a, b], 'room again: the fill starts what norn ready said');
  for (const g of got) await d.ended(g.next);
  calls = 0;
  const c = queueRun(d.opts({ lane: 'c', worktree: d.wt(3) })).run;
  assert.equal(readiness(d.state, { resources: () => { calls++; return { free_gb: 0.5, cpu_pct: 100 }; } }).find(r => r.id === c).ready, true);
  assert.equal(calls, 0, 'a spec with no policy.fill (a library caller) is not gated and never samples');
  await waitFor(() => { fillQueue(d.state); return d.item(c).state === 'filled'; }, { producer: stateBusy(d.state), what: `the fill starts ${c}` });
  await d.ended(d.item(c).fill.next);
});

test('resource gate: norn run --queue with a free slot queues when resources are short (as the usage guard); the CLI writes policy.fill', async () => {
  const d = sandbox();
  const o = d.opts({ lane: 'q', worktree: d.wt(1), policy: { auto_resume_max: 0, fill: { min_free_gb: 4 } }, queue: true, resources: () => ({ free_gb: 1, cpu_pct: 5 }) });
  const r = startRun(o);
  assert.equal(r.queued, true);
  assert.equal(r.why, 'resources: free RAM 1.0 GB < fill.min_free_gb 4');
  const dir = record(d.state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'go', via: 'chat' } }, { views: false }).id;
  const q = meta(['run', '--executor', 'fake', '--lane', 'cli', '--brief', d.brief('mode: done\n'), '--worktree', d.wt(2), '--locks', d.locks, '--after', `dir:${dir}`, '--state', d.state]);
  const id = q.out.match(/QUEUED (RUN-\d+)/)[1];
  const spec = JSON.parse(fs.readFileSync(path.join(d.state, 'runs', `${id}.queue.json`), 'utf8'));
  assert.deepEqual(spec.policy.fill, { min_free_gb: 4, max_cpu_pct: 90, merge_reserve: 1 }, 'no project policy.fill: the defaults');
  // the CLI's own fill (met now = starts now) samples the real box: with RAM to spare it starts the queued run. Every run this test
  // caused settles here - left to the exit reap, its supervisor outlived the file on Linux (CI 43540726632 LEAK RED, RUN-3).
  await waitFor(() => !stateBusy(d.state)(), { what: 'every run the CLI fill started settled' });
});

test('META_FILL_SAMPLE pins the sample (a suite on a busy machine stays deterministic; an operator can simulate pressure)', () => {
  const old = process.env.META_FILL_SAMPLE;
  try {
    process.env.META_FILL_SAMPLE = '{"free_gb":1.5,"cpu_pct":12}';
    assert.deepEqual(sampleResources(), { free_gb: 1.5, cpu_pct: 12 });
    process.env.META_FILL_SAMPLE = 'nonsense';
    assert.throws(() => sampleResources(), /META_FILL_SAMPLE/);
  } finally { if (old === undefined) delete process.env.META_FILL_SAMPLE; else process.env.META_FILL_SAMPLE = old; }
});
