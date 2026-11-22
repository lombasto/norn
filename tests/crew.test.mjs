// DWARVES S1 (DWARVES.md 1.3, 1.5, 1.6): the crew store, who takes a worker run, the generated names (unique across the homes this
// machine sees, never a canon character), the one-time rename of a dwarf hired before the names, `norn crew`. Temp dirs only; the fake
// executor stands in for claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { crewState, pickDwarf, dwarfDisplay, dwarfOf, withCrew, lanePins, kindWord, drawName, nameOf, nameKey, slugOf, seenNames, homeSeed, DENY,
  GIVEN_HEAD, GIVEN_TAIL, CLAN_HEAD, CLAN_TAIL } from '../engine/lib/crew.mjs';
import { startRun, stopRun, queueOf, readiness, takesDwarf, RunRefused } from '../engine/lib/runs.mjs';
import { loadState, record, crewFile, copyItems } from '../engine/lib/records.mjs';
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

// a crew state from [ev, id, data] triples (pure: crewState over hand-made events); hireAll names each dwarf after its id
const crew = evs => crewState(evs.map(([ev, id, data = {}], i) => ({ v: 1, seq: i + 1, at: `2026-11-19T00:00:${String(i).padStart(2, '0')}Z`, id, kind: 'dwarf', ev, by: 'owner', data })));
const hireAll = ids => ids.map(id => ['hire', id, { name: id[0].toUpperCase() + id.slice(1) + ' Testbeard' }]);
const crewEvents = state => fs.readFileSync(crewFile(state), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const re = s => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

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
  d.dwarves = () => crewState(crewEvents(d.state)).dwarves;
  d.stop = id => stopRun({ state: d.state, locksDir: d.locks, run: id, by: 'owner', why: 'test over' });
  // queued first (a stop's fill would start them), then the running ones
  d.stopAll = () => { for (const s of ['queued', 'running']) for (const r of Object.values(loadState(d.state).items)) if (r.kind === 'run' && r.state === s) d.stop(r.id); };
  d.lane = name => record(d.state, { kind: 'lane', ev: 'create', by: 'owner', data: { name } });
  return d;
}

test('the generator: a given name + a surname, deterministic per seed, tens of thousands of distinct names', () => {
  assert.ok(GIVEN_HEAD.length * GIVEN_TAIL.length * CLAN_HEAD.length * CLAN_TAIL.length > 1e6, 'the clan form alone');
  assert.deepEqual(drawName({ home: 'b', n: 7 }), drawName({ home: 'b', n: 7 }), 'one seed, one name');
  assert.notDeepEqual(drawName({ home: 'a', n: 1 }), drawName({ home: 'b', n: 1 }), 'the home is in the seed');
  const taken = new Set(), forms = { clan: 0, sson: 0, mac: 0, of: 0 };
  for (let n = 1; n <= 3000; n++) {
    const { id, name } = drawName({ home: 'h', n, taken });
    assert.match(name, /^[A-Z][a-z]+ ([A-Z][a-z]+|Mac[A-Z][a-z]+|son of [A-Z][a-z]+)$/, name);
    assert.equal(id, slugOf(name)); assert.ok(!taken.has(id), `${name} drawn twice`);
    assert.doesNotMatch(name, /([a-z])\1\1/, 'no triple letter');
    taken.add(id); taken.add(nameKey(name));
    forms[/ son of /.test(name) ? 'of' : / Mac/.test(name) ? 'mac' : /sson$|son$/.test(name) && !CLAN_HEAD.some(h => name.endsWith(` ${h}son`)) ? 'sson' : 'clan']++;
  }
  for (const [k, v] of Object.entries(forms)) assert.ok(v > 50, `the ${k} form drawn ${v} times`);
  assert.equal(nameKey('Óin MacHaldur'), 'oin machaldur'); assert.equal(slugOf('Brakdun son of Haldur'), 'brakdun-son-of-haldur');
});

test('the deny list: no canon character is ever drawn; a draw that would be one is drawn again', () => {
  for (const k of ['thorin', 'gimli', 'oakenshield', 'bronzebeard', 'wildhammer', 'gurnisson', 'grudgebearer', 'battlehammer', 'ironfist', 'andvari', 'sindri']) assert.ok(DENY.has(k), k);
  let hit = null;
  for (let n = 1; n <= 20000; n++) {
    const d = drawName({ home: 'deny', n });
    const parts = [d.name, ...d.name.split(/ (?:son of )?|Mac/)].map(nameKey).filter(Boolean);
    assert.ok(!parts.some(p => DENY.has(p)), `${d.name} is canon`);
    if (!hit && nameOf(`deny/${n}/0`).parts.some(p => DENY.has(p))) hit = { n, first: nameOf(`deny/${n}/0`).name, got: d.name };
  }
  assert.ok(hit, 'some seed draws a canon part first');
  assert.notEqual(hit.got, hit.first, `${hit.first} was drawn again`);
  const first = drawName({ home: 'x', n: 1 }), given = first.name.split(' ')[0];
  assert.notEqual(drawName({ home: 'x', n: 1, deny: new Set([nameKey(given)]) }).name.split(' ')[0], given, 'a denied given name');
});

test('unique across homes: a hire never takes a name the other homes\' run copies show, nor an own one', () => {
  const d = sandbox(), first = drawName({ home: 'b', n: 1 });
  const copy = path.join(d.state, 'homes', 'a', 'copy');
  fs.mkdirSync(copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'runs.jsonl'), JSON.stringify({ v: 1, seq: 1, ts: '2026-11-20T00:00:00Z', id: 'RUN-1', kind: 'run', ev: 'start', by: 'launcher',
    data: { kind: 'worker', lane: 'x', dwarf: first.id, dwarf_name: first.name } }) + '\n');
  assert.ok(seenNames(d.state).has(nameKey(first.name)) && seenNames(d.state).has(first.id));
  const ids = withCrew(d.state, c => [c.hire(), c.hire()], { home: 'b' }), names = ids.map(id => d.dwarves()[id].name);
  assert.ok(!names.includes(first.name), `home a's ${first.name} is taken`);
  const givens = [first, ...names.map(name => ({ name }))].map(x => x.name.split(' ')[0]);
  assert.equal(new Set(givens).size, 3, `no first name twice: ${givens}`);
  assert.notEqual(names[0], names[1]);
  assert.deepEqual(crewEvents(d.state).map(e => [e.ev, e.id, e.data.name]), ids.map((id, i) => ['hire', id, names[i]]));
  fs.writeFileSync(path.join(d.state, 'home.json'), JSON.stringify({ id: 'b', bare_home: 'a' }));
  assert.equal(homeSeed(d.state), 'b', 'a synced machine seeds with its home id');
});

test('the one-time rename: a dwarf hired before the names gets a drawn name, keeps its id and its runs; the runs show the new name', () => {
  const d = sandbox();
  fs.mkdirSync(path.dirname(crewFile(d.state)), { recursive: true });
  fs.writeFileSync(crewFile(d.state), ['thorin', 'balin'].map((id, i) => JSON.stringify({ v: 1, seq: i + 1, at: '2026-11-20T00:00:00Z', id, kind: 'dwarf', ev: 'hire', by: 'launcher', data: {} })).join('\n') + '\n');
  const run = record(d.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', lane: 'x', dwarf: 'thorin' } });
  assert.equal(dwarfOf(loadState(d.state).items[run.id]).name, 'thorin', 'not renamed yet: the id');
  withCrew(d.state, () => {}, { home: 'b' });
  const evs = crewEvents(d.state), renames = evs.filter(e => e.ev === 'rename');
  assert.deepEqual(renames.map(e => e.id), ['thorin', 'balin']);
  for (const e of renames) { assert.deepEqual(Object.keys(e.data), ['name'], 'the new name only, no alias of the old'); assert.ok(!/thorin|balin/i.test(e.data.name)); }
  const st = d.dwarves();
  assert.equal(st.thorin.name, renames[0].data.name); assert.equal(st.thorin.named, true); assert.equal(st.thorin.state, 'active');
  assert.deepEqual(dwarfOf(loadState(d.state).items[run.id]), { id: 'thorin', name: renames[0].data.name }, 'the old run shows the new name');
  withCrew(d.state, () => {}, { home: 'b' });
  assert.equal(crewEvents(d.state).length, evs.length, 'once: a named dwarf is not renamed again');
});

test('another home\'s runs: every run of its dwarf shows the name its newest run carries', () => {
  const d = sandbox(), copy = path.join(d.state, 'homes', 'a', 'copy');
  fs.writeFileSync(path.join(d.state, 'home.json'), JSON.stringify({ id: 'b', bare_home: 'a' }));
  fs.mkdirSync(copy, { recursive: true });
  const ev = (seq, id, at, data) => JSON.stringify({ v: 1, seq, ts: at, id, kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', lane: 'x', ...data } });
  fs.writeFileSync(path.join(copy, 'runs.jsonl'), [ev(1, 'RUN-1', '2026-11-19T00:00:00Z', { dwarf: 'dori' }), ev(2, 'RUN-2', '2026-11-21T00:00:00Z', { dwarf: 'dori', dwarf_name: 'Gorrik Ashdelve' }),
    ev(3, 'RUN-3', '2026-11-19T00:00:00Z', { dwarf: 'nori' })].join('\n') + '\n');
  const by = Object.fromEntries(copyItems(d.state, 'run').map(r => [r.id, dwarfDisplay(r.data)]));
  assert.deepEqual(by, { 'RUN-1': 'Gorrik Ashdelve', 'RUN-2': 'Gorrik Ashdelve', 'RUN-3': 'nori' });
});

test('who takes a run: an active free dwarf, else a hire; a busy pinned dwarf waits', () => {
  let st = crew([]);
  assert.deepEqual(pickDwarf(st, { project: 'p', lane: 'a' }), { hire: true });
  st = crew(hireAll(['brak']));
  assert.deepEqual(pickDwarf(st, { project: 'p', lane: 'a' }, { brak: 'RUN-1' }), { hire: true });
  assert.deepEqual(pickDwarf(st, { project: 'p', lane: 'a' }), { dwarf: 'brak' });
  st = crew([...hireAll(['brak']), ['rename', 'brak', { name: 'Vondrak Torchgrip' }]]);
  assert.equal(st.dwarves.brak.name, 'Vondrak Torchgrip', 'the last name given');
  assert.equal(crew([['hire', 'old']]).dwarves.old.named, false);
});

test('the pin is hard: the pinned dwarf takes its lane\'s run, waits when busy, and takes no other lane\'s run', () => {
  const st = crew([...hireAll(['brak', 'dun']), ['pin', 'dun', { lane: 'p/a' }]]);
  assert.deepEqual(pickDwarf(st, { project: 'p', lane: 'a' }, {}), { dwarf: 'dun' });
  assert.deepEqual(pickDwarf(st, { project: 'p', lane: 'a' }, { dun: 'RUN-7' }), { wait: 'dwarf: Dun Testbeard is busy on RUN-7' });
  assert.deepEqual(pickDwarf(st, { project: 'p', lane: 'b' }, { brak: 'RUN-8' }), { hire: true }, 'a pinned dwarf is never free for another lane');
  assert.equal(holdWords('dwarf: Dun Testbeard is busy on RUN-7', { runs: [] }), 'waits for Dun Testbeard, its pinned dwarf (busy on RUN-7)');
  assert.equal(holdWords('dwarf: Dun Testbeard is busy on RUN-b-7', { runs: [] }), 'waits for Dun Testbeard, its pinned dwarf (busy on RUN-b-7)', 'the id of a home run too');
});

test('no pin: the dwarf who last worked the lane, then the most runs in the project, then the longest idle', () => {
  const st = crew(hireAll(['brak', 'dun', 'gor']));
  const past = [
    { dwarf: 'brak', project: 'p', lane: 'x', at: '2026-11-19T01:00:00Z' },
    { dwarf: 'brak', project: 'p', lane: 'y', at: '2026-11-19T02:00:00Z' },
    { dwarf: 'dun', project: 'p', lane: 'a', at: '2026-11-19T03:00:00Z' },
    { dwarf: 'gor', project: 'q', lane: 'z', at: '2026-11-19T00:30:00Z' },
  ];
  assert.deepEqual(pickDwarf(st, { project: 'p', lane: 'a' }, {}, past), { dwarf: 'dun' }, 'last worked the lane');
  assert.deepEqual(pickDwarf(st, { project: 'p', lane: 'new' }, {}, past), { dwarf: 'brak' }, 'most runs in the project');
  assert.deepEqual(pickDwarf(st, { project: 'r', lane: 'new' }, {}, past), { dwarf: 'gor' }, 'longest idle');
  assert.deepEqual(pickDwarf(st, { project: 'p', lane: 'a' }, { dun: 'RUN-3' }, past), { dwarf: 'brak' }, 'the lane\'s last dwarf is busy: the next rule');
});

test('a worker run\'s start event carries its dwarf and the dwarf\'s name; check-in, audit, helper and MERGE runs take none', async () => {
  const d = sandbox();
  const a = startRun(d.opts({ lane: 'a' }));
  await runEnded(d.state, a.run);
  const [only] = Object.values(d.dwarves());
  assert.equal(d.item(a.run).data.dwarf, only.id);
  assert.equal(d.item(a.run).data.dwarf_name, only.name);
  assert.equal(only.id, slugOf(only.name));
  assert.ok(!('name' in d.item(a.run).data), 'no adjective-noun name any more');
  const b = startRun(d.opts({ lane: 'b' }));
  await runEnded(d.state, b.run);
  assert.equal(d.item(b.run).data.dwarf, only.id, 'the dwarf is free again: no second hire');
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
    const dw = [d.item(x.run).data.dwarf, d.item(y.run).data.dwarf];
    assert.notEqual(dw[0], dw[1], 'two launches, two dwarves');
    const hires = crewEvents(d.state).filter(e => e.ev === 'hire');
    assert.deepEqual(hires.map(e => e.id).sort(), [...dw].sort());
    assert.notEqual(hires[0].data.name, hires[1].data.name);
    for (const e of hires) { assert.equal(e.by, 'launcher'); assert.match(e.at, /^\d{4}-\d\d-\d\dT/); }
  } finally { d.stopAll(); }
});

test('a pinned lane: its queued row names the dwarf; a busy pin waits (queued, with the term), the walk says so', async () => {
  const d = sandbox();
  d.lane('a');
  const first = startRun(d.sleep({ lane: 'b' }));   // hires the first dwarf
  try {
    const { id, name } = Object.values(d.dwarves())[0];
    const pin = norn(['crew', 'pin', id, '--lane', 'demo/a', '--state', d.state, '--as', 'owner', '--why', 'knows lane a']);
    assert.equal(pin.code, 0, pin.err);
    assert.equal(pin.out, `DEC-1: pin ${name} to demo/a`);
    assert.deepEqual(lanePins(d.state), { a: { id, name } });
    const q = startRun(d.sleep({ lane: 'a', stage: 'S1', queue: true }));
    assert.equal(q.queued, true);
    assert.equal(q.why, `dwarf: ${name} is busy on ${first.run}`);
    const row = queueOf(Object.values(loadState(d.state).items).filter(i => i.kind === 'run'), lanePins(d.state)).find(r => r.id === q.run);
    assert.deepEqual(row.dwarf, { id, name });
    assert.ok(readiness(d.state).find(r => r.id === q.run).terms.includes(`dwarf: ${name} is busy on ${first.run}`));
    assert.throws(() => startRun(d.sleep({ lane: 'a', stage: 'S2' })), e => e instanceof RunRefused && e.code === 3 && re(`${name} is busy`).test(e.message));
    const other = startRun(d.opts({ lane: 'c' }));
    await runEnded(d.state, other.run);
    assert.notEqual(d.item(other.run).data.dwarf, id, 'a pinned dwarf takes no other lane\'s run');
  } finally { d.stopAll(); }
});

test('norn crew: list shows the full name; retire drops the pins in the same decision, recall brings the dwarf back; each act is a DEC', () => {
  const d = sandbox();
  d.lane('a');
  const [a, b] = withCrew(d.state, c => [c.hire('owner'), c.hire('owner')]), A = d.dwarves()[a].name, B = d.dwarves()[b].name;
  const as = ['--state', d.state, '--as', 'owner'];
  assert.equal(norn(['crew', 'pin', b, '--lane', 'demo/a', ...as]).code, 0);
  assert.equal(norn(['crew', 'pin', a, '--lane', 'demo/a', ...as]).code, 2, 'one dwarf per lane');
  assert.match(norn(['crew', 'pin', a, '--lane', 'demo/nope', ...as]).err, /has no lane nope/);
  assert.match(norn(['crew', 'retire', b, ...as]).err, /retire needs --why/);
  const r = norn(['crew', 'retire', b, '--why', 'too slow', ...as]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `DEC-2: retire ${B} and drop the pins demo/a`);
  const dec = loadState(d.state).items['DEC-2'];
  assert.deepEqual(dec.data.links, [`dwarf:${b}`]); assert.equal(dec.by, 'owner'); assert.equal(dec.data.why, 'too slow');
  assert.deepEqual(crewEvents(d.state).filter(e => e.data.dec === 'DEC-2').map(e => e.ev), ['unpin', 'retire']);
  const rows = JSON.parse(norn(['crew', 'list', '--json', '--state', d.state]).out);
  assert.deepEqual(rows.map(x => [x.id, x.name, x.state, x.pins]), [[a, A, 'active', []], [b, B, 'retired', []]]);
  const text = norn(['crew', 'list', '--state', d.state]).out.split('\n');
  assert.ok(text[0].startsWith(`${a}  ${A}  active`), text[0]);
  assert.equal(norn(['crew', 'retire', b, '--why', 'again', ...as]).code, 2, 'already retired');
  assert.equal(norn(['crew', 'recall', b, ...as]).out, `DEC-3: recall ${B}`);
  assert.equal(JSON.parse(norn(['crew', 'show', b, '--json', '--state', d.state]).out).state, 'active');
  assert.match(norn(['crew', 'retire', a, '--why', 'w', '--state', d.state, '--as', 'worker']).err, /may not act on the crew/);
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
