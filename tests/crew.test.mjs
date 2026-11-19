// DWARVES S1 (DWARVES.md 1.3, 1.5, 1.6): the crew store, who takes a worker run, the regnal names, `norn crew`. Temp dirs only; the
// fake executor stands in for claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { POOL, crewState, nextName, pickDwarf, dwarfDisplay, crewFile, withCrew, lanePins, kindWord } from '../engine/lib/crew.mjs';
import { startRun, stopRun, queueOf, readiness, takesDwarf, RunRefused } from '../engine/lib/runs.mjs';
import { loadState, record } from '../engine/lib/records.mjs';
import { holdWords } from '../engine/lib/plan.mjs';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { runEnded } from './helpers/wait.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NORN = path.join(HERE, '..', 'engine', 'bin', 'norn.mjs');
const norn = (args, env = {}) => {
  const r = spawnSync(process.execPath, [NORN, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, META_ROLE: '', META_PROJECT: '', META_STATE: '', META_NO_TICK: '1', ...env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
test.after(() => cleanTmp());

// a crew state from [ev, id, data] triples (pure: crewState over hand-made events)
const crew = evs => crewState(evs.map(([ev, id, data = {}], i) => ({ v: 1, seq: i + 1, at: `2026-11-19T00:00:${String(i).padStart(2, '0')}Z`, id, kind: 'dwarf', ev, by: 'owner', data })));
const hireAll = ids => ids.map(id => ['hire', id]);

function sandbox() {
  const t = mkTmp('meta-crew-');
  const d = { t, state: path.join(t, 'state', 'demo'), locks: path.join(t, 'state', 'locks'), notes: path.join(t, 'NOTES.md') };
  for (const k of ['state', 'locks']) fs.mkdirSync(d[k], { recursive: true });
  let n = 0;
  d.wt = () => { const w = path.join(t, 'wt' + ++n); fs.mkdirSync(w, { recursive: true }); return w; };
  d.brief = body => { const f = path.join(t, `brief-${++n}.md`); fs.writeFileSync(f, body); return f; };
  d.opts = (o = {}) => {
    const budget_file = path.join(t, `budget-${++n}.json`);
    fs.writeFileSync(budget_file, JSON.stringify({ max_claude_workers: 8 }));
    return { state: d.state, locksDir: d.locks, executor: 'fake', lane: 'demo', worktree: d.wt(), notes: d.notes, hbMs: 150, staleMs: 3000,
      policy: { auto_resume_max: 0 }, tick: null, brief: d.brief('mode: done\n'), budget: { max_claude_workers: 8 }, budget_file, ...o };
  };
  d.sleep = (o = {}) => d.opts({ brief: d.brief('mode: sleep\n'), ...o });
  d.item = id => loadState(d.state).items[id];
  d.stop = id => stopRun({ state: d.state, locksDir: d.locks, run: id, by: 'owner', why: 'test over' });
  // queued first (a stop's fill would start them), then the running ones
  d.stopAll = () => { for (const s of ['queued', 'running']) for (const r of Object.values(loadState(d.state).items)) if (r.kind === 'run' && r.state === s) d.stop(r.id); };
  d.lane = name => record(d.state, { kind: 'lane', ev: 'create', by: 'owner', data: { name } });
  return d;
}

test('the pool: 37 names in the order of DWARVES.md 1.6, ASCII ids, display names with their accents and regnal numerals', () => {
  assert.equal(POOL.length, 37);
  assert.equal(new Set(POOL.map(([id]) => id)).size, 37);
  assert.deepEqual(POOL.slice(0, 4).map(([id]) => id), ['thorin', 'balin', 'dwalin', 'fili']);
  assert.deepEqual(POOL.at(-1), ['ibun', 'Ibun']);
  for (const [id] of POOL) assert.match(id, /^[a-z]+(-[a-z]+)?$/);
  assert.equal(dwarfDisplay('oin'), 'Óin'); assert.equal(dwarfDisplay('gamil-zirak'), 'Gamil Zirak');
  assert.equal(dwarfDisplay('balin-2'), 'Balin II'); assert.equal(dwarfDisplay('gamil-zirak-4'), 'Gamil Zirak IV'); assert.equal(dwarfDisplay(null), null);
});

test('hire order: the pool order, the Company first; with every dwarf busy the next name is hired', () => {
  let st = crew([]);
  assert.deepEqual(pickDwarf(st, { project: 'p', lane: 'a' }), { hire: 'thorin' });
  st = crew(hireAll(['thorin']));
  assert.deepEqual(pickDwarf(st, { project: 'p', lane: 'a' }, { thorin: 'RUN-1' }), { hire: 'balin' });
  st = crew(hireAll(POOL.slice(0, 13).map(([id]) => id)));
  assert.equal(nextName(st), 'durin', 'Durin\'s line after the Company');
});

test('the regnal rule: the pool used up, the earliest-retired name comes back with a numeral, once per retired dwarf', () => {
  const all = hireAll(POOL.map(([id]) => id));
  let st = crew([...all, ['retire', 'gimli', { why: 'w' }], ['retire', 'balin', { why: 'w' }]]);
  assert.equal(nextName(st), 'gimli-2', 'Gimli retired first');
  st = crew([...all, ['retire', 'gimli', { why: 'w' }], ['retire', 'balin', { why: 'w' }], ['hire', 'gimli-2', { succeeds: 'gimli' }]]);
  assert.equal(nextName(st), 'balin-2', 'Gimli has passed his name on: Balin is next');
  assert.equal(st.dwarves['gimli-2'].name, 'Gimli II');
  st = crew([...all, ['hire', 'thorin-2', { succeeds: 'thorin' }]]);
  assert.equal(nextName(st), 'balin-2', 'none retired: the earliest-hired name not yet passed on');
});

test('the pin is hard: the pinned dwarf takes its lane\'s run, waits when busy, and takes no other lane\'s run', () => {
  const st = crew([...hireAll(['thorin', 'balin']), ['pin', 'balin', { lane: 'p/a' }]]);
  assert.deepEqual(pickDwarf(st, { project: 'p', lane: 'a' }, {}), { dwarf: 'balin' });
  assert.deepEqual(pickDwarf(st, { project: 'p', lane: 'a' }, { balin: 'RUN-7' }), { wait: 'dwarf: Balin is busy on RUN-7' });
  assert.deepEqual(pickDwarf(st, { project: 'p', lane: 'b' }, { thorin: 'RUN-8' }), { hire: 'dwalin' }, 'a pinned dwarf is never free for another lane');
  assert.equal(holdWords('dwarf: Balin is busy on RUN-7', { runs: [] }), 'waits for Balin, its pinned dwarf (busy on RUN-7)');
});

test('no pin: the dwarf who last worked the lane, then the most runs in the project, then the longest idle', () => {
  const st = crew(hireAll(['thorin', 'balin', 'dwalin']));
  const past = [
    { dwarf: 'thorin', project: 'p', lane: 'x', at: '2026-11-19T01:00:00Z' },
    { dwarf: 'thorin', project: 'p', lane: 'y', at: '2026-11-19T02:00:00Z' },
    { dwarf: 'balin', project: 'p', lane: 'a', at: '2026-11-19T03:00:00Z' },
    { dwarf: 'dwalin', project: 'q', lane: 'z', at: '2026-11-19T00:30:00Z' },
  ];
  assert.deepEqual(pickDwarf(st, { project: 'p', lane: 'a' }, {}, past), { dwarf: 'balin' }, 'last worked the lane');
  assert.deepEqual(pickDwarf(st, { project: 'p', lane: 'new' }, {}, past), { dwarf: 'thorin' }, 'most runs in the project');
  assert.deepEqual(pickDwarf(st, { project: 'r', lane: 'new' }, {}, past), { dwarf: 'dwalin' }, 'longest idle');
  assert.deepEqual(pickDwarf(st, { project: 'p', lane: 'a' }, { balin: 'RUN-3' }, past), { dwarf: 'thorin' }, 'the lane\'s last dwarf is busy: the next rule');
});

test('a worker run\'s start event carries its dwarf; check-in, audit, helper and MERGE runs take none', async () => {
  const d = sandbox();
  const a = startRun(d.opts({ lane: 'a' }));
  await runEnded(d.state, a.run);
  assert.equal(d.item(a.run).data.dwarf, 'thorin');
  assert.ok(!('name' in d.item(a.run).data), 'no adjective-noun name any more');
  const b = startRun(d.opts({ lane: 'b' }));
  await runEnded(d.state, b.run);
  assert.equal(d.item(b.run).data.dwarf, 'thorin', 'Thorin is free again: no second hire');
  const m = startRun(d.opts({ lane: 'c', stage: 'MERGE' }));
  await runEnded(d.state, m.run);
  assert.equal(d.item(m.run).data.dwarf, undefined, 'a MERGE run takes no dwarf');
  for (const o of [{ kind: 'checkin' }, { kind: 'audit' }, { role: 'helper' }, { kind: 'interactive' }]) assert.equal(takesDwarf({ kind: 'worker', ...o }), false, JSON.stringify(o));
  assert.equal(takesDwarf({ kind: 'worker', stage: 'S1' }), true);
  assert.equal(kindWord({ kind: 'checkin' }), 'check-in'); assert.equal(kindWord({ kind: 'worker', stage: 'MERGE' }), 'merge');
});

test('one run per dwarf under two concurrent launches (two processes, one crew lock)', async () => {
  const d = sandbox();
  const script = path.join(d.t, 'launch.mjs'), runsUrl = new URL('../engine/lib/runs.mjs', import.meta.url).href;
  fs.writeFileSync(script, `import { startRun } from ${JSON.stringify(runsUrl)};\nconst o = JSON.parse(process.argv[2]);\nprocess.stdout.write(JSON.stringify(startRun(o)));\n`);
  const go = o => new Promise((ok, no) => {
    const c = spawn(process.execPath, [script, JSON.stringify(o)], { windowsHide: true });
    let out = '', err = '';
    c.stdout.on('data', b => { out += b; }); c.stderr.on('data', b => { err += b; });
    c.on('exit', code => (code === 0 ? ok(JSON.parse(out)) : no(new Error(err))));
  });
  const [x, y] = await Promise.all([go(d.sleep({ lane: 'a' })), go(d.sleep({ lane: 'b' }))]);
  try {
    const dw = [d.item(x.run).data.dwarf, d.item(y.run).data.dwarf].sort();
    assert.deepEqual(dw, ['balin', 'thorin'], 'two launches, two dwarves');
    const hires = fs.readFileSync(crewFile(d.state), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.ev === 'hire');
    assert.deepEqual(hires.map(e => e.id), ['thorin', 'balin']);
    for (const e of hires) { assert.equal(e.by, 'launcher'); assert.match(e.at, /^\d{4}-\d\d-\d\dT/); }
  } finally { d.stopAll(); }
});

test('a pinned lane: its queued row names the dwarf; a busy pin waits (queued, with the term), the walk says so', async () => {
  const d = sandbox();
  d.lane('a');
  const first = startRun(d.sleep({ lane: 'b' }));   // hires Thorin
  try {
    const pin = norn(['crew', 'pin', 'thorin', '--lane', 'demo/a', '--state', d.state, '--as', 'owner', '--why', 'Thorin knows lane a']);
    assert.equal(pin.code, 0, pin.err);
    assert.match(pin.out, /^DEC-1: pin Thorin to demo\/a$/);
    assert.deepEqual(lanePins(d.state), { a: { id: 'thorin', name: 'Thorin' } });
    const q = startRun(d.sleep({ lane: 'a', stage: 'S1', queue: true }));
    assert.equal(q.queued, true);
    assert.equal(q.why, `dwarf: Thorin is busy on ${first.run}`);
    const row = queueOf(Object.values(loadState(d.state).items).filter(i => i.kind === 'run'), lanePins(d.state)).find(r => r.id === q.run);
    assert.deepEqual(row.dwarf, { id: 'thorin', name: 'Thorin' });
    assert.ok(readiness(d.state).find(r => r.id === q.run).terms.includes(`dwarf: Thorin is busy on ${first.run}`));
    assert.throws(() => startRun(d.sleep({ lane: 'a', stage: 'S2' })), e => e instanceof RunRefused && e.code === 3 && /Thorin is busy/.test(e.message));
    const other = startRun(d.opts({ lane: 'c' }));
    await runEnded(d.state, other.run);
    assert.equal(d.item(other.run).data.dwarf, 'balin', 'a pinned dwarf takes no other lane\'s run');
  } finally { d.stopAll(); }
});

test('norn crew: retire drops the pins in the same decision, recall brings the dwarf back; each act is a DEC with the dwarf in its links', () => {
  const d = sandbox();
  d.lane('a');
  withCrew(d.state, c => { c.hire('thorin'); c.hire('balin'); });
  const as = ['--state', d.state, '--as', 'owner'];
  assert.equal(norn(['crew', 'pin', 'balin', '--lane', 'demo/a', ...as]).code, 0);
  assert.equal(norn(['crew', 'pin', 'thorin', '--lane', 'demo/a', ...as]).code, 2, 'one dwarf per lane');
  assert.match(norn(['crew', 'pin', 'thorin', '--lane', 'demo/nope', ...as]).err, /has no lane nope/);
  assert.match(norn(['crew', 'retire', 'balin', ...as]).err, /retire needs --why/);
  const r = norn(['crew', 'retire', 'balin', '--why', 'too slow', ...as]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^DEC-2: retire Balin and drop the pins demo\/a$/);
  const dec = loadState(d.state).items['DEC-2'];
  assert.deepEqual(dec.data.links, ['dwarf:balin']); assert.equal(dec.by, 'owner'); assert.equal(dec.data.why, 'too slow');
  const evs = fs.readFileSync(crewFile(d.state), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.data.dec === 'DEC-2');
  assert.deepEqual(evs.map(e => e.ev), ['unpin', 'retire']);
  const list = norn(['crew', 'list', '--json', '--state', d.state]);
  const rows = JSON.parse(list.out);
  assert.deepEqual(rows.map(x => [x.id, x.state, x.pins]), [['thorin', 'active', []], ['balin', 'retired', []]]);
  assert.equal(norn(['crew', 'retire', 'balin', '--why', 'again', ...as]).code, 2, 'already retired');
  assert.match(norn(['crew', 'recall', 'balin', ...as]).out, /^DEC-3: recall Balin$/);
  assert.equal(JSON.parse(norn(['crew', 'show', 'balin', '--json', '--state', d.state]).out).state, 'active');
  assert.match(norn(['crew', 'retire', 'thorin', '--why', 'w', '--state', d.state, '--as', 'worker']).err, /may not act on the crew/);
  assert.equal(norn(['crew', '--help']).code, 0);
});

test('an unreadable crew store refuses the launch in words: no run starts without a dwarf', () => {
  const d = sandbox();
  fs.mkdirSync(path.dirname(crewFile(d.state)), { recursive: true });
  fs.writeFileSync(crewFile(d.state), '{"v":1,"seq":1\n');
  assert.throws(() => startRun(d.opts({ lane: 'a' })), e => e instanceof RunRefused && e.code === 3 && /crew store .*crew\.jsonl unreadable/.test(e.message));
  assert.equal(Object.values(loadState(d.state).items).filter(i => i.kind === 'run').length, 0, 'nothing recorded');
  assert.equal(norn(['crew', 'list', '--state', d.state]).code, 1);
});
