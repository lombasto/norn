// The live hand-off state (lanes.mjs handoffOf): one server-side field every page reads. Unit cases over a real records fold (fresh
// run, hand-off pending at each step, resumed, ended, refused, a slop resume), then one dashboard fixture walked through a hand-off:
// the Lanes, Runs, Map, Overview and Home pages, the live feed head and the plain log each show the chip / line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { record, loadState } from '../engine/lib/records.mjs';
import { handoffOf, handoffWords } from '../engine/lib/lanes.mjs';
import { sceneSig } from '../engine/dash/norn/live.mjs';
import { renderTab, loadTab, renderFeedHead } from '../engine/dash/ui.mjs';
import { hoChip } from '../engine/dash/widgets.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { fixture } from './helpers/dash-fixture.mjs';

const start = (S, data = {}) => record(S, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'relay', ...data } }).id;
const end = (S, id, outcome = 'handoff') => record(S, { kind: 'run', ev: 'end', id, by: 'launcher', data: { exit: 0, outcome } });
const resume = (S, id, data) => record(S, { kind: 'run', ev: 'resume', id, by: 'launcher', data });
const items = S => loadState(S).items;

test('handoffOf: a fresh run and a run whose session goes on are no hand-off', () => {
  const S = mkTmp('meta-ho-'), a = start(S);
  assert.equal(handoffOf(items(S)[a], items(S), { wrote: () => false }), null, 'fresh run');
  end(S, a, 'done');
  assert.equal(handoffOf(items(S)[a], items(S)), null, 'ended DONE');
  assert.equal(handoffOf(null, {}), null);
});

test('handoffOf: pending while the session closes, the supervisor decides, the next run waits and starts; resumed once it talks', () => {
  const S = mkTmp('meta-ho-'), a = start(S);
  let I = items(S);
  // the worker wrote HANDOFF; its executor is still alive (RUN-65 of solve-shack: a background suite kept it running)
  const closing = handoffOf(I[a], I, { wrote: id => id === a });
  assert.deepEqual({ ...closing, text: undefined }, { phase: 'pending', step: 'closing', session: 2, run: a, from: a, text: undefined, short: 'hand-off: session 2 next' });
  assert.match(closing.text, /^hand-off in progress - session 2 next/);
  // it exited HANDOFF, no resume verdict yet: pending for at most waitMs
  end(S, a); I = items(S);
  assert.equal(handoffOf(I[a], I).step, 'ending');
  assert.equal(handoffOf(I[a], I, { now: Date.parse(I[a].updated) + 3 * 60000 }), null, 'a supervisor that never decided: plain HANDOFF after 2 min');
  // the resume is queued (a cap slot), then starts
  const q = record(S, { kind: 'run', ev: 'queue', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'relay', resume_of: a, resumes: 1 } }).id;
  resume(S, a, { next: q, count: 1, max: 2 }); I = items(S);
  assert.deepEqual([handoffOf(I[a], I).step, handoffOf(I[q], I).step, handoffOf(I[q], I).session], ['queued', 'queued', 2]);
  // a run that starts straight away (the usual path): the new run is the tip of the chain from either end
  const S2 = mkTmp('meta-ho-'), x = start(S2); end(S2, x); const y = start(S2, { resume_of: x, resumes: 1 }); resume(S2, x, { next: y, count: 1, max: 2 });
  const J = items(S2), silent = { talked: () => false }, talking = { talked: id => id === y };
  for (const id of [x, y]) assert.deepEqual({ ...handoffOf(J[id], J, silent), text: undefined }, { phase: 'pending', step: 'starting', session: 2, run: y, from: x, text: undefined, short: 'hand-off: session 2 starting' }, id);
  assert.equal(handoffOf(J[x], J, silent).text, 'hand-off in progress - session 2 starting');
  const on = handoffOf(J[y], J, talking);
  assert.deepEqual([on.phase, on.session, on.text, on.short], ['resumed', 2, 'resumed after hand-off (session 2)', 'resumed (session 2)']);
  assert.equal(handoffOf(J[x], J, talking).phase, 'resumed', 'the old run says where its work went on');
  // session 2 hands off in turn: session 3 next
  assert.equal(handoffOf(J[x], J, { ...talking, wrote: id => id === y }).text, 'hand-off in progress - session 3 next (the last session is closing)');
  // the chain ended: its tip's own state says how
  end(S2, y, 'done');
  assert.equal(handoffOf(items(S2)[x], items(S2), talking), null, 'ended');
});

test('handoffOf: a refused resume and a slop / Done-check resume are no hand-off in progress', () => {
  const S = mkTmp('meta-ho-'), a = start(S); end(S, a); resume(S, a, { refused: 'cap 2/2', count: 2, max: 2 });
  assert.equal(handoffOf(items(S)[a], items(S)), null);
  const T = mkTmp('meta-ho-'), b = start(T); end(T, b, 'done'); const c = start(T, { resume_of: b, slop_of: b });
  assert.equal(handoffOf(items(T)[c], items(T), { talked: () => false }), null);
  assert.equal(handoffWords(null), null);
});

test('hoChip: one chip shape, the words escaped, the tip named on an older run', () => {
  const h = { phase: 'pending', step: 'starting', session: 2, run: 'RUN-4', from: 'RUN-3', text: 'hand-off in progress - session 2 starting' };
  assert.match(hoChip(h, 'RUN-3'), /^<span class="ho pending" role="status"><span class="pulse" aria-hidden="true"><\/span><span>hand-off in progress - session 2 starting <span class="id">RUN-4<\/span>/);
  assert.doesNotMatch(hoChip(h, 'RUN-4'), /class="id"/);
  assert.match(hoChip({ ...h, phase: 'resumed', text: 'resumed after hand-off (session 2)' }), /class="ho resumed"/);
  assert.match(hoChip({ ...h, short: 'hand-off: session 2 starting' }, null, { short: true }), /title="hand-off in progress - session 2 starting"><span class="pulse" aria-hidden="true"><\/span><span>hand-off: session 2 starting</);
  assert.equal(hoChip(null), '');
});

test('dashboard: every page that shows the run or its lane carries the hand-off chip, from pending to resumed', async () => {
  const f = await fixture();
  try {
    const S = f.pa.state, ui = async r => (await f.get(r)).data, now = Date.now(), ctx = { now, project: 'kestrel' };
    record(S, { kind: 'lane', ev: 'create', by: 'controller', data: { name: 'relay' } });
    fs.mkdirSync(path.join(S, 'logs'), { recursive: true });
    const log = path.join(S, 'logs', 'relay.log'); fs.writeFileSync(log, 'start RUN-x\n');
    const sid1 = 'aaaaaaaa-0000-4000-8000-000000000001', sid2 = 'aaaaaaaa-0000-4000-8000-000000000002';
    const a = start(S, { log, session_id: sid1 });
    fs.writeFileSync(path.join(S, 'hb', `${a}.hb`), '{}');
    // 1. the session wrote HANDOFF and is closing
    fs.mkdirSync(path.join(S, 'results', a), { recursive: true });
    fs.writeFileSync(path.join(S, 'results', a, 'HANDOFF.md'), 'next: the suite\n');
    fs.writeFileSync(path.join(S, 'results', a, 'result.json'), JSON.stringify({ v: 1, run: a, outcome: 'handoff', handoff: 'HANDOFF.md', at: new Date().toISOString() }));
    const lane = (await f.get('/api/lanes?project=kestrel')).data.lanes.find(l => l.name === 'relay');
    assert.equal(lane.handoff?.step, 'closing', JSON.stringify(lane));
    assert.match(renderTab('lanes', await loadTab('lanes', 'kestrel', ui), ctx), /<span class="ho pending" role="status"><span class="pulse"[^>]*><\/span><span>hand-off in progress - session 2 next/);
    assert.match(await (await fetch(`${f.url}/log?project=kestrel&run=${a}`)).text(), /^\[norn\] hand-off in progress - session 2 next .*\nstart RUN-x/);
    // 2. it ended; the supervisor started session 2, which has said nothing yet
    end(S, a); fs.rmSync(path.join(S, 'hb', `${a}.hb`));
    const b = start(S, { log, session_id: sid2, resume_of: a, resumes: 1 }); resume(S, a, { next: b, count: 1, max: 2 });
    fs.writeFileSync(path.join(S, 'hb', `${b}.hb`), '{}');
    const tree = (await f.get('/api/agents?project=kestrel')).data.tree;
    assert.deepEqual([a, b].map(id => tree.find(n => n.id === id)?.handoff?.text), Array(2).fill('hand-off in progress - session 2 starting'));
    const runs = renderTab('runs', await loadTab('runs', 'kestrel', ui), ctx);
    assert.match(runs, new RegExp(`id="node-${b}"[^]*?<div class="horow"><span class="ho pending"[^]*?session 2 starting`));
    assert.match(runs, new RegExp(`id="node-${a}"[^]*?session 2 starting <span class="id">${b}</span>`), 'the old run names the run its work went on in');
    const map = await loadTab('map', 'kestrel', ui);
    assert.equal(map.nodes.find(n => n.id === 'L:relay').handoff.step, 'starting');
    const svg = renderTab('map', map, ctx);
    assert.match(svg, new RegExp(`id="mn-${b}"[^]*?<title>[^<]*hand-off in progress - session 2 starting[^]*?<circle class="pulse ho-pending"[^>]*/><text class="ns ho-w"[^>]*>hand-off: session 2 starting<`));
    assert.notEqual(sceneSig(map), sceneSig({ ...map, nodes: map.nodes.map(n => ({ ...n, handoff: null })) }), 'the Norn map rebuilds its labels on a change');
    assert.match(renderTab('overview', await loadTab('overview', 'kestrel', ui), ctx), new RegExp(`id="run-${b}"[^]*?class="ho pending"`));
    const home = await loadTab('home', 'kestrel', ui);
    assert.equal(home.side.now.find(n => n.run === b)?.handoff?.step, 'starting');
    assert.match(renderTab('home', home, ctx), /class="hrow ho-row"><span class="ho pending"/);
    // 3. session 2 talks: resumed
    const dir = path.join(f.root, 'claude-projects', 'C--fx-wt');
    fs.writeFileSync(path.join(dir, `${sid2}.jsonl`), JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), requestId: 'r1',
      message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 5, output_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 } } }) + '\n');
    const l2 = (await f.get('/api/lanes?project=kestrel')).data.lanes.find(l => l.name === 'relay');
    assert.deepEqual([l2.handoff.phase, l2.handoff.text], ['resumed', 'resumed after hand-off (session 2)']);
    assert.match(renderTab('lanes', await loadTab('lanes', 'kestrel', ui), ctx), /class="ho resumed"[^]*?resumed after hand-off \(session 2\)/);
    // 4. the chain ends: no chip anywhere
    end(S, b, 'done'); fs.rmSync(path.join(S, 'hb', `${b}.hb`));
    assert.equal((await f.get('/api/lanes?project=kestrel')).data.lanes.find(l => l.name === 'relay').handoff, null);
    assert.doesNotMatch(renderTab('lanes', await loadTab('lanes', 'kestrel', ui), ctx), /class="ho /);
  } finally { await f.done(); }
});

test('live feed head: the hand-off chip under the head line', () => {
  const h = { run: 'RUN-3', name: 'cedar-lark', state: 'running', handoff: { phase: 'pending', step: 'closing', session: 2, run: 'RUN-3', from: 'RUN-3', text: 'hand-off in progress - session 2 next (the last session is closing)' } };
  assert.match(renderFeedHead(h), /<div class="fh-ho"><span class="ho pending" role="status"><span class="pulse"/);
  assert.doesNotMatch(renderFeedHead({ ...h, handoff: null }), /fh-ho/);
});
