// fair-slots items 1, 4, 8: the machine-wide Claude pool is shared fairly between projects (a slot one project frees goes to the
// project that has waited longest), per-project reserves and ceilings (share.mjs), and a direct start never passes a queued run of
// the same or a higher priority (queuedAhead). Temp dirs only; live runs are recorded starts with a fresh heartbeat file (no process).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startRun, queueRun, readiness, fillAll, hbPath, capacityView, RunRefused } from '../engine/lib/runs.mjs';
import { slotVerdict, sharesProblem, shareOf } from '../engine/lib/share.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { settled } from './helpers/settled.mjs';
import { GROK } from './helpers/command-matrix.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 90000) {   // two fake runs end to end; a loaded box (a full suite beside) takes its time
  const t0 = performance.now();
  for (;;) { const v = fn(); if (v) return v; if (performance.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(50); }
}
// one machine: t/state/<project> per project, one budget file, fake executor (on the Claude cap)
function machine(budget) {
  const t = mkTmp('meta-fair-'), locks = path.join(t, 'state', 'locks'), budget_file = path.join(t, 'budget.json');
  fs.mkdirSync(locks, { recursive: true });
  fs.writeFileSync(budget_file, JSON.stringify(budget));
  const brief = path.join(t, 'brief.md'); fs.writeFileSync(brief, 'mode: done\n');
  let n = 0;
  const project = name => {
    const state = path.join(t, 'state', name);
    fs.mkdirSync(state, { recursive: true });
    const p = { name, state };
    p.opts = (o = {}) => { const wt = path.join(t, `wt-${name}-${++n}`); fs.mkdirSync(wt, { recursive: true });
      return { state, locksDir: locks, executor: 'fake', lane: `${name}-${n}`, brief, worktree: wt, notes: path.join(t, `n${n}.md`), hbMs: 150, staleMs: 120000,   // the recorded live runs keep a fresh heartbeat through a slow walk
        policy: { auto_resume_max: 0 }, tick: null, budget, budget_file, ...o }; };
    p.queue = (o = {}) => queueRun(p.opts(o)).run;
    // a live Claude worker with no process: a start record + a fresh heartbeat file (liveRuns reads the hb mtime)
    p.live = () => { const id = record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: `${name}-live-${++n}`, worktree: 'w', brief } }).id;
      fs.mkdirSync(path.join(state, 'hb'), { recursive: true }); fs.writeFileSync(hbPath(state, id), JSON.stringify({ run: id })); return id; };
    p.end = id => { record(state, { kind: 'run', ev: 'end', id, by: 'launcher', data: { outcome: 'done', exit: 0 } }); fs.rmSync(hbPath(state, id), { force: true }); };
    p.row = id => readiness(state, { resources: () => ({ free_gb: 64, cpu_pct: 0 }) }).find(r => r.id === id);
    p.item = id => loadState(state).items[id];
    return p;
  };
  return { t, project };
}

// ---------- share.mjs (pure) ----------
test('slotVerdict: ceiling, own reserve, the others\' reserves (lent while idle), then the project that waited longest', () => {
  const budget = { max_claude_workers: 3, project_workers: { a: { reserve_claude_workers: 1 }, b: { reserve_claude_workers: 1, max_claude_workers_project: 2 } } };
  const v = o => slotVerdict({ budget, waiting: {}, mine: 100, ...o });
  assert.equal(v({ project: 'a', live: { a: 2 } }), null, 'b has no queued work: its reserved slot is lent to a');
  assert.match(v({ project: 'a', live: { a: 2 }, waiting: { b: { n: 1, since: 50 } } }), /^reserved: .*b \(reserve_claude_workers, 1 owed\)/, 'b waits: its reserve is kept for it');
  assert.equal(v({ project: 'b', live: { a: 2 } }), null, 'b under its reserve: the slot is its own');
  assert.match(v({ project: 'b', live: { b: 2 } }), /^ceiling: b runs 2/, 'b at its ceiling');
  assert.equal(v({ project: 'a', live: { a: 1 }, waiting: { b: { n: 1, since: 50 } } }), null, '2 free, 1 owed to b: a may take the other');
  // no reserves: the fair share
  const plain = { max_claude_workers: 1 };
  assert.match(slotVerdict({ budget: plain, project: 'norn', live: {}, waiting: { shack: { n: 8, since: 50 } }, mine: 100 }), /^share: the next Claude slot goes to shack/);
  assert.equal(slotVerdict({ budget: plain, project: 'norn', live: {}, waiting: { shack: { n: 8, since: 150 } }, mine: 100 }), null, 'norn waited longer');
  assert.equal(slotVerdict({ budget: { max_claude_workers: 2 }, project: 'norn', live: {}, waiting: { shack: { n: 1, since: 50 } }, mine: 100 }), null, 'two free: one each');
  assert.equal(slotVerdict({ budget: {}, project: 'norn', live: {}, waiting: { shack: { n: 1, since: 50 } }, mine: 100 }), null, 'no cap: no share rule');
});
test('sharesProblem / shareOf: reserves fit the machine cap; defaults reserve 0, ceiling = the cap', () => {
  assert.deepEqual(shareOf({ max_claude_workers: 3 }, 'x'), { reserve: 0, ceiling: 3 });
  assert.equal(sharesProblem({ max_claude_workers: 3, project_workers: { a: { reserve_claude_workers: 1 }, b: { reserve_claude_workers: 2 } } }), null);
  assert.match(sharesProblem({ max_claude_workers: 3, project_workers: { a: { reserve_claude_workers: 2 }, b: { reserve_claude_workers: 2 } } }), /add up to 4 \(a 2 \+ b 2\), 1 more than max_claude_workers 3/);
  assert.match(sharesProblem({ max_claude_workers: 3, project_workers: { a: { reserve_claude_workers: 2, max_claude_workers_project: 1 } } }), /a: reserve 2 is above its ceiling 1/);
});

// ---------- item 1: a slot freed by one project goes to the project that waited longest ----------
test('two projects, cap 1: norn keeps ending and queuing runs, solve-shack still gets the freed slot (fillAll from norn starts it)', async () => {
  const m = machine({ max_claude_workers: 1 });
  const norn = m.project('norn'), shack = m.project('shack');
  const n1 = norn.live();
  const s1 = shack.queue();   // waits for the one slot
  await sleep(1100);   // record ts are whole seconds: norn's next start / queue come strictly later
  const n2 = norn.queue();
  assert.match(shack.row(s1).terms.join(), /^cap: 1 claude workers running/);
  norn.end(n1);   // norn's run exits and frees the slot
  const nr = norn.row(n2);
  assert.equal(nr.ready, false);
  assert.match(nr.terms.join(), /^share: the next Claude slot goes to shack/);
  assert.equal(shack.row(s1).ready, true);
  const got = fillAll(norn.state);   // the exiting norn run's supervisor fills every project
  assert.deepEqual(got.map(f => [f.project, f.queued]), [['shack', s1]]);
  assert.equal(norn.item(n2).state, 'queued', 'norn waits its turn');
  const next = got[0].next;
  // shack's run exits: its supervisor fills every project, and only norn waits now - norn gets the slot
  const back = await waitFor(() => norn.item(n2).state === 'filled' && norn.item(n2));
  await waitFor(() => settled(shack.item(next)) && settled(norn.item(back.history.at(-1).data.next)));
});

// ---------- item 8: reserves ----------
test('reserve 1 each, cap 3: the busy project never takes the other\'s reserved slot while it has queued work; a lent slot returns first', async () => {
  const m = machine({ max_claude_workers: 3, project_workers: { norn: { reserve_claude_workers: 1 }, shack: { reserve_claude_workers: 1 } } });
  const norn = m.project('norn'), shack = m.project('shack');
  const a = norn.live(), b = norn.live();
  const n3 = norn.queue();
  assert.equal(norn.row(n3).ready, true, 'shack has no queued work: its reserved slot is lent to norn');
  const c = norn.live();   // norn borrowed it: 3 of 3
  const s1 = shack.queue();
  assert.match(shack.row(s1).terms.join(), /^cap: 3 claude workers running/, 'never a preemption: shack waits for a free slot');
  norn.end(a);   // a norn run ends: the lent slot goes back to shack first
  assert.match(norn.row(n3).terms.join(), /^reserved: the free Claude slot is kept for shack/);
  assert.equal(shack.row(s1).ready, true);
  const cv = capacityView(norn.state, { max_claude_workers: 3, project_workers: { norn: { reserve_claude_workers: 1 }, shack: { reserve_claude_workers: 1 } } });
  assert.deepEqual(cv.rows.map(r => [r.project, r.reserved, r.using, r.queued, r.ceiling]), [['norn', 1, 2, 1, 3], ['shack', 1, 0, 1, 3]]);
  // a direct start obeys the queue first (same priority: exit 4), then shack's reserve (a P0 passes the queue, not the reserve)
  assert.throws(() => startRun(norn.opts()), e => e instanceof RunRefused && e.code === 4 && /go first: norn RUN-\d+ P2 #1, shack/.test(e.message));
  assert.throws(() => startRun(norn.opts({ priority: 'P0' })), e => e instanceof RunRefused && e.code === 4 && /^reserved: /.test(e.message));
  for (const id of [b, c]) norn.end(id);
});

// ---------- item 4: a direct start does not pass a queued run of the same or a higher priority ----------
test('a direct start never passes an older queued run of the same or a higher priority held for resources; it joins the queue in fill order', () => {
  const m = machine({ max_claude_workers: 3 });
  const norn = m.project('norn');
  const busy = () => ({ free_gb: 64, cpu_pct: 95 });
  const fill = { max_cpu_pct: 90 };
  const old = norn.queue({ priority: 'P1', policy: { auto_resume_max: 0, fill } });
  assert.match(readiness(norn.state, { resources: busy })[0].terms.join(), /^resources: CPU busy 95 %/);
  const r = startRun(norn.opts({ priority: 'P1', queue: true, resources: busy }));   // RUN-251's case: a slot is free
  assert.equal(r.queued, true);
  assert.match(r.why, new RegExp(`^1 queued run\\(s\\) of the same or a higher priority go first: norn ${old} P1 #1`));
  assert.equal(r.position, 2, 'behind the older P1 run');
  assert.throws(() => startRun(norn.opts({ priority: 'P2', resources: busy })), e => e instanceof RunRefused && e.code === 4 && /go first/.test(e.message), 'without --queue: refused like a full cap');
  const hi = startRun(norn.opts({ priority: 'P0', queue: true, resources: busy, policy: { auto_resume_max: 0, fill } }));
  assert.equal(hi.queued, true);
  assert.match(hi.why, /^resources: CPU busy/, 'a P0 run passes the P1 runs, but the same resource gate holds it');
});

// slop C15: a typed executor's caps come from its entry (infoOf), not the built-in table - its queued runs count as ahead too
test('a typed executor: a direct start never passes an older queued run on the same max_<name> cap held for resources', () => {
  const m = machine({ max_claude_workers: 3, max_grok: 2 });
  const norn = m.project('norn');
  const busy = () => ({ free_gb: 64, cpu_pct: 95 }), fill = { max_cpu_pct: 90 };
  const grok = { executor: 'grok', provider: { ...GROK, runner: 'fake' }, exe: process.execPath, model: 'fake', effort: 'high', priority: 'P1', policy: { auto_resume_max: 0, fill } };
  const old = norn.queue(grok);
  assert.match(readiness(norn.state, { resources: busy })[0].terms.join(), /^resources: CPU busy 95 %/);
  const r = startRun(norn.opts({ ...grok, queue: true, resources: busy }));
  assert.equal(r.queued, true);
  assert.match(r.why, new RegExp(`^1 queued run\(s\) of the same or a higher priority go first: norn ${old} P1 #1`));
});
