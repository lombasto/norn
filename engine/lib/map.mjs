// Lane -> agent map (LANE-MAP-DESIGN 1): nodes + edges + a deterministic "blueprint" layout from the records fold (no new
// state, no transcript reads beyond the agents tree the caller already built). Columns left to right: lanes, runs (latest large,
// the previous RECENT_RUNS-1 small, the rest behind "more"), children (helpers, subagents), questions. Bands top to bottom: the
// check-in band ("controller"), then lanes running > parked > idle. Pure; the browser only draws it (inline SVG, ui.mjs).
import { runName } from './names.mjs';
import { critiqueOfNode } from './critique.mjs';
import { laneState } from './lanes.mjs';

export const RECENT_RUNS = 3;   // Q-B2 (controller 2026-11-08): last 3 runs per lane, the rest behind "more"
export const MORE_CAP = 30;     // an expanded lane shows its latest 30 runs (the check-in band has ~1000)
const COL = [16, 296, 620, 900], W = [200, 260, 240, 240], WIDTH = 1160;
const H = { lane: 50, big: 58, small: 40, child: 38, question: 44 }, GAP = 8, BAND_PAD = 12, BAND_GAP = 14;
const CHECKIN = 'checkin', ADHOC_MS = 24 * 3600000;
export const DLV_ROOM = 42;   // under the lane node: the "+n more" line, then the 20 px deliverable pill
const num = id => Number(String(id).slice(4));

const EDGE_WORD = { owns: 'owns (lane -> run)', resumes: 'resumes (HANDOFF -> next run)', delegates: 'delegates (run -> helper / subagent)',
  dispatched: 'dispatched (check-in started it)', reviewed: 'reviewed (check-in reviewed it)', asks: 'asks (open question parks the lane)' };
export const EDGE_KINDS = Object.keys(EDGE_WORD);

/** run -> [chip class, word] (status = text + colour, design sec. 7); a queued run waits (RM-21 S1: its reason is on its lane) */
export function runWord(r) {
  if (r.state === 'running') return ['running', 'running'];
  if (r.state === 'queued' || r.state === 'claimed') return ['waiting', 'waiting'];
  if (r.state === 'withdrawn') return ['idle', 'withdrawn'];
  if (r.state === 'lost') return ['lost', 'lost'];
  if (r.state === 'killed') return ['bad', 'killed'];
  const o = r.end?.outcome;
  return { done: ['done', 'DONE'], stopped: ['stopped', 'STOPPED'], handoff: ['handoff', 'HANDOFF'], crash: ['bad', 'crash'] }[o] ?? ['no-result', o ?? 'no result'];
}
const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/**
 * o: { all (archived / done lanes too), more (Set of lane names shown in full), tree (agentsTree roots: subagent children) }
 * -> { nodes [{ id, type, lane, label, sub, cls, word, x, y, w, h, faded?, feed?, more?, needs? }], edges [{ from, to, kind, word, dashed? }],
 *      bands [{ lane, y, h, deliverables }], width, height }
 * o.deliverables: deliverablesView rows (DELIVERABLES-SPEC 3); a lane band carries the rows of its lane, oldest first.
 * RM-21 S1: a lane node's cls and word are its state (lanes.mjs laneState), its `why` the one reason; o.walk (Map run id -> fill walk
 * row) and o.hbAge feed it as on the Lanes page.
 */
export function mapGraph(st, { all = false, more = new Set(), tree = [], now = Date.now(), deliverables = [], walk = new Map(), hbAge = null } = {}) {
  const items = Object.values(st.items), runs = items.filter(i => i.kind === 'run').sort((a, b) => num(b.id) - num(a.id));
  const lanesOf = {}, helpersOf = {};
  for (const r of runs) {
    const d = r.data || {};
    if (d.role === 'helper') { (helpersOf[d.parent] ??= []).push(r); continue; }
    const lane = d.kind === 'checkin' ? CHECKIN : d.lane;
    if (lane) (lanesOf[lane] ??= []).push(r);
  }
  const subsOf = Object.fromEntries((tree || []).map(n => [n.id, (n.children || []).filter(c => c.kind === 'subagent')]));
  const hoBy = Object.fromEntries((tree || []).filter(n => n.handoff).map(n => [n.id, n.handoff]));   // the tree's live hand-off state (lanes.mjs handoffOf)
  const openQ = items.filter(i => i.kind === 'question' && i.state === 'open');
  const rank = l => (lanesOf[l.id.slice(2)]?.[0]?.state === 'running' ? 0 : l.state === 'parked' ? 1 : 2);
  // lanes with runs but no LANE record (launched ad hoc): shown while running or active in the last 24 h, all with `all`
  const recorded = new Set(items.filter(l => l.kind === 'lane').map(l => l.id));
  const adhoc = Object.entries(lanesOf).filter(([n, rs]) => n !== CHECKIN && !recorded.has('L:' + n)
    && (all || rs[0].state === 'running' || now - Date.parse(rs[0].updated) < ADHOC_MS)).map(([n]) => ({ id: 'L:' + n, kind: 'lane', state: 'active', adhoc: true }));
  const lanes = [...items, ...adhoc].filter(l => l.kind === 'lane' && l.id !== 'L:' + CHECKIN && (all || l.state === 'active' || l.state === 'parked'))
    .sort((a, b) => rank(a) - rank(b) || (num(lanesOf[b.id.slice(2)]?.[0]?.id ?? 'RUN-0') - num(lanesOf[a.id.slice(2)]?.[0]?.id ?? 'RUN-0')) || (a.id < b.id ? -1 : 1));

  const nodes = [], edges = [], bands = [], shown = new Set();
  const add = n => { nodes.push(n); shown.add(n.id); return n; };
  const edge = (from, to, kind, extra = {}) => edges.push({ from, to, kind, word: EDGE_WORD[kind], ...extra });
  let y = 8;
  const band = (name, laneItem) => {
    const list = lanesOf[name] || [], vis = list.slice(0, more.has(name) ? MORE_CAP : RECENT_RUNS), top = y;
    const st0 = laneItem?.state ?? 'active', lead = list[0];
    const status = name === CHECKIN ? null : laneState(laneItem, lead ?? null, { items: st.items, runs: list, now, hbAge, walk, deliverables: deliverables.filter(d => d.lane === name) });
    const [cls, word] = status ? [status.state, status.state] : lead?.state === 'running' ? ['running', 'running'] : ['idle', 'controller'];
    const laneId = 'L:' + name;
    add({ id: laneId, type: 'lane', lane: name, label: name === CHECKIN ? 'controller' : name, sub: `${name === CHECKIN ? 'check-ins · ' : ''}${laneItem?.adhoc ? 'no LANE record · ' : ''}${list.length} run${list.length === 1 ? '' : 's'}`,
      state: st0, cls, word, ...(status ? { why: status.why } : {}), x: COL[0], y: top + BAND_PAD, w: W[0], h: H.lane, more: list.length - vis.length, expanded: more.has(name), capped: more.has(name) && list.length > MORE_CAP,
      handoff: name === CHECKIN ? null : vis.map(r => hoBy[r.id]).find(Boolean) ?? null });   // every run of a hand-off chain carries its tip's state
    let ry = top + BAND_PAD;
    vis.forEach((r, i) => {
      const d = r.data || {}, [rc, rw] = runWord(r), big = i === 0;
      const crit = d.class === 'planning' ? critiqueOfNode(runs, r.id) : null;   // META-DOD 3: the plan's review (ui.mjs mapNode: its sub line)
      add({ id: r.id, type: name === CHECKIN ? 'checkin' : 'run', lane: name, label: runName(r) ?? r.id, sub: [r.id, d.executor, d.stage].filter(Boolean).join(' · '), critique: crit,
        state: r.state, cls: rc, word: rw, x: COL[1], y: ry, w: W[1], h: big ? H.big : H.small, faded: !big, feed: r.id, executor: d.executor ?? null, handoff: hoBy[r.id] ?? null });
      edge(laneId, r.id, 'owns');
      const kids = [...(helpersOf[r.id] || []).map(h => { const [hc, hw] = runWord(h); return { id: h.id, type: 'helper', lane: name, label: runName(h) ?? h.id,
        sub: [h.id, h.data.executor, 'helper'].filter(Boolean).join(' · '), cls: hc, word: hw, feed: h.id, executor: h.data.executor ?? null }; }),
      ...(subsOf[r.id] || []).map(s => ({ id: `${r.id}/${s.id}`, type: 'subagent', lane: name, label: s.agentType ?? 'subagent', sub: clip(s.description ?? s.id, 40),
        cls: s.state === 'running' ? 'running' : 'done', word: s.state ?? 'subagent' }))];
      kids.forEach((k, j) => { add({ ...k, x: COL[2], y: ry + j * (H.child + GAP), w: W[2], h: H.child }); edge(r.id, k.id, 'delegates'); });
      ry += Math.max(big ? H.big : H.small, kids.length * (H.child + GAP) - GAP) + GAP;
    });
    const qs = name === CHECKIN ? [] : openQ.filter(q => q.data?.lane === name || laneItem?.park?.q === q.id);
    qs.forEach((q, j) => { add({ id: q.id, type: 'question', lane: name, label: q.id, sub: clip(q.data?.title, 40), cls: 'needs', word: 'needs you', needs: true,
      x: COL[3], y: top + BAND_PAD + j * (H.question + GAP), w: W[3], h: H.question }); edge(laneId, q.id, 'asks'); });
    const dl = (deliverables || []).filter(r => r.lane === name && name !== CHECKIN).sort((a, b) => (b.days ?? 0) - (a.days ?? 0))
      .map(r => ({ id: r.id, project: r.project, state: r.state, record_state: r.record_state, at_target: r.at_target, branch: r.branch, days: r.days, behind: r.behind, native: r.native, due: r.due, park_why: r.park?.why ?? null }));
    // a lane with deliverables gets room for its state pill under the lane node (below the "+n more" line)
    const h = Math.max(H.lane, ry - GAP - (top + BAND_PAD), qs.length * (H.question + GAP) - GAP, dl.length ? H.lane + DLV_ROOM : 0) + 2 * BAND_PAD;
    bands.push({ lane: name, y: top, h, deliverables: dl });
    y = top + h + BAND_GAP;
  };
  band(CHECKIN, items.find(i => i.id === 'L:' + CHECKIN));
  for (const l of lanes) band(l.id.slice(2), l);

  // check-in -> run: the run start event's actor (D3 records `run` on every event) and the review events
  const ticks = new Set(nodes.filter(n => n.type === 'checkin').map(n => n.id));
  for (const n of nodes.filter(x => x.type === 'run')) {
    const r = st.items[n.id];
    if (ticks.has(r.run)) edge(r.run, r.id, 'dispatched');
    for (const h of r.history || []) if (h.ev === 'review' && ticks.has(h.run)) edge(h.run, r.id, 'reviewed');
    const prev = r.data?.resume_of;
    if (prev && shown.has(prev)) edge(r.id, prev, 'resumes', { dashed: true });
  }
  return { nodes, edges, bands, width: WIDTH, height: y };
}
