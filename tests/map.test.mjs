// Lane -> agent map (LANE-MAP-DESIGN 1, 4 slices 2-3): the server builds nodes + edges + a deterministic blueprint layout from
// the records fold (lanes = bands, runs / helpers / subagents = columns, check-ins = the top band, questions hang off lanes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fold } from '../engine/lib/records.mjs';
import { mapGraph, RECENT_RUNS, MORE_CAP } from '../engine/lib/map.mjs';

let seq = 0;
const T0 = Date.parse('2026-11-08T08:00:00Z');
const ev = (kind, e, id, data = {}, extra = {}) => ({ v: 1, seq: ++seq, ts: new Date(T0 + seq * 60000).toISOString().replace(/\.\d+Z$/, 'Z'), id, kind, ev: e, by: extra.by ?? 'launcher', run: extra.run ?? null, data });
function state() {
  seq = 0; const E = [];
  for (const n of ['gen', 'render', 'quiet', 'old']) E.push(ev('lane', 'create', 'L:' + n, { name: n }, { by: 'controller' }));
  E.push(ev('lane', 'archive', 'L:old', {}, { by: 'controller' }));
  let r = 0; const start = (data, extra) => { const id = `RUN-${++r}`; E.push(ev('run', 'start', id, { kind: 'worker', executor: 'claude', ...data }, extra)); return id; };
  const end = (id, outcome) => E.push(ev('run', 'end', id, { exit: 0, outcome }));
  const tick = start({ kind: 'checkin', lane: 'checkin' }); end(tick, 'done');
  // render: five runs, a HANDOFF -> resume chain, the latest running and dispatched by the tick, one helper under it
  const rs = [];
  for (let i = 0; i < 5; i++) { const id = start({ lane: 'render', ...(i ? { resume_of: rs[i - 1] } : {}) }, { run: i === 4 ? tick : (i ? rs[i - 1] : null) }); rs.push(id); if (i < 4) end(id, 'handoff'); }
  const helper = start({ kind: 'delegate', executor: 'grok', lane: 'render', role: 'helper', parent: rs[4], q: 'where is X' });
  end(helper, 'done');
  const g = start({ lane: 'gen' }); end(g, 'stopped');
  E.push(ev('run', 'review', g, { refs: [] }, { by: 'checkin', run: tick }));
  E.push(ev('question', 'create', 'Q-1', { title: 'choose a relief model', lane: 'gen', blocks: ['gen'] }, { by: 'controller' }));
  E.push(ev('lane', 'park', 'L:gen', { q: 'Q-1' }, { by: 'controller' }));
  E.push(ev('run', 'start', 'RUN-99', { kind: 'archived-lane-run', executor: 'claude', lane: 'old' }));
  return { st: fold(E), tick, rs, helper, g };
}
const byId = m => Object.fromEntries(m.nodes.map(n => [n.id, n]));

test('map: check-in band on top, then lane bands running > parked > idle; archived lanes only with all', () => {
  const { st, tick } = state();
  const m = mapGraph(st, { now: T0 + 3600000 });
  const lanes = m.nodes.filter(n => n.type === 'lane');
  assert.deepEqual(lanes.map(n => n.lane), ['checkin', 'render', 'gen', 'quiet']);
  assert.ok(lanes.every((n, i) => !i || n.y > lanes[i - 1].y), 'bands go down in that order');
  assert.ok(byId(m)[tick] && byId(m)[tick].type === 'checkin');
  assert.ok(mapGraph(st, { all: true }).nodes.some(n => n.lane === 'old'));
});

test(`map: the latest run big, the previous ${RECENT_RUNS - 1} small, the rest behind "more"; resume chain = dashed edges`, () => {
  const { st, rs } = state();
  const m = mapGraph(st, {}), N = byId(m);
  const shown = rs.filter(id => N[id]);
  assert.deepEqual(shown, rs.slice(-RECENT_RUNS));
  assert.ok(N[rs[4]].h > N[rs[3]].h && N[rs[3]].faded && !N[rs[4]].faded, 'latest large, older small and faded');
  assert.equal(N['L:render'].more, 5 - RECENT_RUNS);
  assert.ok(m.edges.some(e => e.kind === 'resumes' && e.from === rs[4] && e.to === rs[3] && e.dashed));
  assert.ok(m.edges.some(e => e.kind === 'owns' && e.from === 'L:render' && e.to === rs[4]));
  const all = byId(mapGraph(st, { more: new Set(['render']) }));
  assert.ok(rs.every(id => all[id]), '"more" shows the whole chain'); assert.equal(all['L:render'].more, 0);
});

test('map: helper child + delegates edge, tick -> run dispatched / reviewed edges, the open question hangs off its lane (needs you)', () => {
  const { st, tick, rs, helper, g } = state();
  const m = mapGraph(st, {}), N = byId(m);
  assert.equal(N[helper].type, 'helper'); assert.ok(N[helper].x > N[rs[4]].x, 'children sit right of their run');
  assert.ok(m.edges.some(e => e.kind === 'delegates' && e.from === rs[4] && e.to === helper));
  assert.ok(m.edges.some(e => e.kind === 'dispatched' && e.from === tick && e.to === rs[4]));
  assert.ok(m.edges.some(e => e.kind === 'reviewed' && e.from === tick && e.to === g));
  assert.equal(N['Q-1'].type, 'question'); assert.equal(N['Q-1'].needs, true);
  assert.ok(m.edges.some(e => e.kind === 'asks' && e.from === 'L:gen' && e.to === 'Q-1'));
  assert.equal(N['L:gen'].state, 'parked');
  for (const e of m.edges) assert.ok(e.word && N[e.from] && N[e.to], 'every edge has a word and both ends');
  for (const n of m.nodes) assert.ok([n.x, n.y, n.w, n.h].every(Number.isFinite) && n.word, n.id);
  assert.deepEqual(mapGraph(st, {}), m, 'deterministic layout');
  assert.ok(m.width > 0 && m.height >= Math.max(...m.nodes.map(n => n.y + n.h)));
});

test('map: a lane with runs but no LANE record shows while running or active in the last 24 h (marked "no LANE record"); older only with all', () => {
  const { st } = state();
  const E = [{ v: 1, seq: 900, ts: '2026-11-08T09:00:00Z', id: 'RUN-50', kind: 'run', ev: 'start', by: 'launcher', run: null, data: { kind: 'codex', executor: 'codex-sol', lane: 'adhoc' } },
    { v: 1, seq: 901, ts: '2026-11-01T09:00:00Z', id: 'RUN-40', kind: 'run', ev: 'start', by: 'launcher', run: null, data: { kind: 'worker', executor: 'claude', lane: 'ancient' } },
    { v: 1, seq: 902, ts: '2026-11-01T10:00:00Z', id: 'RUN-40', kind: 'run', ev: 'end', by: 'launcher', run: null, data: { exit: 0, outcome: 'done' } }];
  const s2 = { ...st, items: { ...st.items, ...fold(E).items } }, now = Date.parse('2026-11-08T12:00:00Z');
  const lanes = mapGraph(s2, { now }).nodes.filter(n => n.type === 'lane');
  const adhoc = lanes.find(n => n.lane === 'adhoc');
  assert.ok(adhoc, 'running lane without a record'); assert.match(adhoc.sub, /no LANE record/); assert.equal(adhoc.word, 'running');
  assert.equal(lanes.findIndex(n => n.lane === 'adhoc'), 1, 'running bands first, after the check-ins');
  assert.ok(!lanes.some(n => n.lane === 'ancient'));
  assert.ok(mapGraph(s2, { now, all: true }).nodes.some(n => n.lane === 'ancient'));
});

test('map: subagents of a run (from the agents tree) are children; run nodes carry the feed target', () => {
  const { st, rs } = state();
  const tree = [{ id: rs[4], children: [{ id: 'a178', kind: 'subagent', agentType: 'Explore', description: 'find X', state: 'running' }] }];
  const m = mapGraph(st, { tree }), N = byId(m);
  assert.equal(N[`${rs[4]}/a178`].type, 'subagent');
  assert.ok(m.edges.some(e => e.kind === 'delegates' && e.to === `${rs[4]}/a178`));
  assert.equal(N[rs[4]].feed, rs[4]); assert.equal(N['L:render'].feed, undefined);
});

