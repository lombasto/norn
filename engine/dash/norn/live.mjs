// The live Map core (META-VISUAL-B S2), pure: no DOM, no three.js, so node tests drive it. Ported from VISUAL-A2
// norn/data.mjs + mapview.mjs (the time model, the frame rules, the scheduling) and turned from a snapshot replay into the
// LIVE map: events come from the dash's state stream (/api/stream `rec` + `pulse`), fire time = the record's ts.
//   time model (stateless, as in A2): an event fires at f = its ts (epoch s); the frame at time rt shows every event fired in
//   (rt - MAXA, rt]. The view runs LAG s behind the wall clock: records carry whole-second stamps and arrive after a <= 1 s
//   poll, so without the lag a 0.7 s pulse would be over before its record reached the page. Order and spacing stay exact.
//   frames: only while something moves (requestAnimationFrame), else ONE timer until the next pending fire, else nothing at
//   all (idle = 0 frames, DEC-683); hidden = nothing; QUIET = one static frame per change; reduced motion = no travel / motes,
//   a knot is marked for MARK s instead.

export const PULSE = 0.7, SPARK = 1.1, MOTE = 1.6, GLOW = 2.5, MAXA = 2.6, MARK = 2, LAG = 3, KEEP = 120;
const RANK = { running: 0, stopped: 1, parked: 1, waiting: 2, shipped: 3, idle: 4 };   // a lane's state (lanes.mjs laneState)

// ---------- /api/map -> graph -> weave (lanes in band order, running first; their run knots latest-first; the controller) ----------
export function graphOf(map) {
  const nodes = (map?.nodes || []).map(n => ({ ...n })), by = new Map(nodes.map(n => [n.id, n]));
  const edges = (map?.edges || []).filter(e => by.has(e.from) && by.has(e.to)).map(e => ({ ...e }));
  const lanes = nodes.filter(n => n.type === 'lane');
  for (const l of lanes) l.runs = nodes.filter(n => n.type !== 'lane' && n.lane === l.lane);
  for (const n of nodes) { n.out = edges.filter(e => e.from === n.id); n.in = edges.filter(e => e.to === n.id); }
  return { nodes, edges, by, lanes };
}
export function weave(g) {
  const lanes = g.lanes.filter(l => l.lane !== 'checkin').map(l => {
    const knots = l.runs.filter(r => r.type === 'run').sort((a, b) => a.y - b.y || a.x - b.x);
    const live = knots.some(k => k.cls === 'running'), questions = l.runs.filter(r => r.type === 'question').length;
    const cls = l.cls;   // RM-21 S1: the lane node carries its state (map.mjs over lanes.mjs laneState)
    return { node: l, name: l.lane, knots, live, questions, cls, more: l.more || 0 };
  });
  lanes.sort((a, b) => (RANK[a.cls] ?? 5) - (RANK[b.cls] ?? 5) || a.node.y - b.node.y);
  const ctl = g.lanes.find(l => l.lane === 'checkin'), checkins = ctl ? ctl.runs.filter(r => r.type === 'checkin').sort((a, b) => a.y - b.y) : [];
  return { lanes, ctl, checkins };
}
// what the scene is built from: a rebuild happens only when this changes (a refetch with the same picture costs nothing)
export const sceneSig = (map, extra = '') => JSON.stringify([extra, (map?.nodes || []).map(n => [n.id, n.type, n.lane, n.label, n.cls, n.faded ? 1 : 0, n.more || 0, n.handoff?.text ?? '']),
  (map?.edges || []).map(e => [e.from, e.to, e.kind])]);

// ---------- stream records -> events {f, id, type, to?} (raw; resolved against the scene at draw time, so a run whose knot
// appears with the next refetch still fires) ----------
export function eventsOfRecords(records) {
  const out = [];
  for (const r of records || []) {
    const f = Date.parse(r?.ts) / 1000; if (!Number.isFinite(f) || !r.id) continue;
    if (r.kind === 'run') {
      const d = r.data || {};
      if (r.ev === 'start' && d.role === 'helper' && d.parent) out.push({ f, id: d.parent, type: 'deleg' });   // a delegation: shuttle out of the parent
      if (r.run && r.run !== r.id && (r.ev === 'start' || r.ev === 'review')) out.push({ f, id: r.run, type: 'edge', to: r.id });   // check-in dispatch / review
      out.push({ f, id: r.id, type: r.ev === 'start' || r.ev === 'exit' || r.ev === 'resume' ? 'step' : 'tool' });
    } else if (r.run) out.push({ f, id: r.run, type: r.kind === 'question' && r.ev === 'create' ? 'error' : 'tool' });   // a run wrote a record
  }
  return out;
}
// the heartbeat dir changed: every running knot breathes once at that time
export const beatOf = ts => { const f = Date.parse(ts) / 1000; return Number.isFinite(f) ? [{ f, id: '*running', type: 'step' }] : []; };

// a time-ordered, bounded event store (KEEP s of history is enough for any frame and a strip)
export function createEvents() {
  let evs = [];
  return {
    push(list, now = Date.now() / 1000) {
      if (!list.length) return false;
      evs = evs.concat(list).filter(e => e.f > now - KEEP).sort((a, b) => a.f - b.f);
      evs.forEach((e, i) => { e.i = i; });
      return true;
    },
    get list() { return evs; },
  };
}

// ---------- one frame: what pulses / travels / glows at rt (seconds) ----------
// resolve(id) -> ids the event lands on (a knot id, every running knot for a beat, [] when the knot is not in the scene)
export function framePlan(evs, rt, { quiet = false, reduced = false } = {}, resolve = id => [id]) {
  const P = { pulses: new Map(), sparks: [], motes: [], glow: new Map(), moving: false };
  if (quiet) return P;   // QUIET: the static frame (base state only)
  let lo = 0, hi = evs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (evs[m].f <= rt - MAXA) lo = m + 1; else hi = m; }
  for (let j = lo; j < evs.length && evs[j].f <= rt; j++) {
    const e = evs[j], age = rt - e.f, ids = resolve(e.id); if (!ids.length) continue;
    for (const id of ids) {
      P.glow.set(id, Math.max(P.glow.get(id) ?? -1e9, e.f));
      if (e.type === 'tool' || e.type === 'step' || e.type === 'error') {
        const hot = e.type === 'error' ? 3 : 2.2;
        if (age < PULSE) { const a = 1 - age / PULSE; P.pulses.set(id, { scale: reduced ? 1 : 1 + 0.55 * a, glow: hot * (reduced ? 1 : a) }); }
        else if (reduced && age < MARK) P.pulses.set(id, { scale: 1, glow: 1.4 });   // reduced motion: the knot is marked, it does not move
        if (!reduced && age < MOTE && e.type !== 'step') P.motes.push({ e, id, a: age / MOTE });
      }
    }
    if ((e.type === 'deleg' || e.type === 'edge') && !reduced && age < SPARK) P.sparks.push({ e, u: age / SPARK });
  }
  const glowing = [...P.glow.values()].some(f => rt - f < GLOW);
  P.moving = P.sparks.length + P.motes.length > 0 || glowing || P.pulses.size > 0;
  if (reduced) P.moving = P.pulses.size > 0 || glowing;   // the mark / glow fade still needs frames (no travel)
  return P;
}
// seconds until the next event fires after rt (null = nothing pending: no timer at all)
export function nextFire(evs, rt) {
  let lo = 0, hi = evs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (evs[m].f <= rt) lo = m + 1; else hi = m; }
  return lo < evs.length ? evs[lo].f - rt : null;
}

// 0 when an event is in flight at rt (it arrived late), else nextFire
export function wakeIn(evs, rt) { for (let j = evs.length - 1; j >= 0 && evs[j].f > rt - MAXA; j--) if (evs[j].f <= rt) return 0; return nextFire(evs, rt); }

// ---------- the frame loop: render on change only (injected clock / raf / timers / visibility, so tests count frames) ----------
export function createLoop({ draw, now = () => Date.now() / 1000 - LAG, raf = requestAnimationFrame, caf = cancelAnimationFrame,
  setT = setTimeout, clrT = clearTimeout, hidden = () => document.hidden, flags = {}, pending = () => null, wake = pending }) {
  let rafId = 0, timer = 0, dead = false, frames = 0;
  const stop = () => { if (rafId) caf(rafId); rafId = 0; if (timer) clrT(timer); timer = 0; };
  function frame() {
    rafId = 0; if (timer) clrT(timer); timer = 0;
    if (dead || hidden()) return;
    const rt = now(); frames++;
    const moving = draw(rt, !!flags.quiet);
    if (flags.quiet) return;   // the static frame: no follow-up
    if (moving) { rafId = raf(frame); return; }
    const n = pending(rt);
    if (n != null) timer = setT(frame, Math.max(16, n * 1000));
  }
  return {
    invalidate() { if (dead || hidden() || rafId) return; if (timer) { clrT(timer); timer = 0; } rafId = raf(frame); },
    // new events arrived: no frame now unless one is already in flight - a timer until the first one fires
    poke() {
      if (dead || hidden() || rafId || flags.quiet) return;
      const n = wake(now()); if (n == null) return;
      if (timer) clrT(timer); timer = 0;
      if (n <= 0) rafId = raf(frame); else timer = setT(frame, Math.max(16, n * 1000));
    },
    setQuiet(q) { flags.quiet = !!q; stop(); this.invalidate(); },
    hide() { stop(); },
    dispose() { dead = true; stop(); },
    get frames() { return frames; },
    get idle() { return !rafId && !timer; },
  };
}

// a knot label's candidate offsets (CSS px from the knot), tried in turn before it is culled: right, left, then rows above /
// below on both sides (22 px apart: one label line + its padding), then centred above / below
export const knotCands = (d = 10) => [[d, 0, 'left'], [-d, 0, 'right'], [d, -22, 'left'], [-d, -22, 'right'], [d, 22, 'left'], [-d, 22, 'right'],
  [d, -44, 'left'], [-d, -44, 'right'], [d, 44, 'left'], [-d, 44, 'right'], [0, -66, 'center'], [0, 66, 'center']];

// ---------- labels: whole px, priority order, each tries its candidate offsets before it is culled ----------
// items: [{ x, y (anchor, px), w, h, prio, always?, cands: [[dx, dy, align]] }] (align: left | right | center)
// -> [{ x, y, hidden }] in input order. Placed boxes never overlap (an `always` label is placed even over others).
export function placeLabels(items, W, H, pad = 2) {
  const out = items.map(() => ({ x: 0, y: 0, hidden: true })), boxes = [];
  const order = items.map((l, i) => i).sort((a, b) => items[a].prio - items[b].prio || a - b);
  const hits = b => boxes.some(o => o[0] < b[2] && b[0] < o[2] && o[1] < b[3] && b[1] < o[3]);
  for (const i of order) {
    const l = items[i]; if (l.x == null) continue;
    for (const [dx = 0, dy = 0, align = 'left'] of l.cands?.length ? l.cands : [[0, 0, 'left']]) {
      const x = Math.round(l.x + dx - (align === 'center' ? l.w / 2 : align === 'right' ? l.w : 0)), y = Math.round(l.y + dy - l.h / 2);
      const box = [x - pad, y - pad, x + l.w + pad, y + l.h + pad];
      if (x < 0 || y < 0 || x + l.w > W || y + l.h > H) continue;
      if (!l.always && hits(box)) continue;
      boxes.push(box); out[i] = { x, y, hidden: false }; break;
    }
  }
  return out;
}

// ---------- camera fit: an orthographic view (dir, up) that holds every frame point, centred; texel = world units / texel ----------
const sub = (a, b) => a.map((v, i) => v - b[i]), dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };
export function viewBasis(dir, up) { const f = unit(dir), r = unit(cross(f, up)), u = cross(r, f); return { f, r, u }; }
// points [[x,y,z]], W x H texels -> { texel, target }; axis 'x' fits the width only and anchors the top (a tall weave scrolls)
export function fitView(points, dir, up, W, H, { margin = 1.06, axis = 'both' } = {}) {
  const { f, r, u } = viewBasis(dir, up);
  const a = points.map(p => dot(p, r)), b = points.map(p => dot(p, u)), c = points.map(p => dot(p, f));
  const a0 = Math.min(...a), a1 = Math.max(...a), b0 = Math.min(...b), b1 = Math.max(...b), cm = c.reduce((s, v) => s + v, 0) / c.length;
  const texel = Math.max((a1 - a0) / W, axis === 'x' ? 0 : (b1 - b0) / H) * margin;
  const bm = axis === 'x' ? b1 + ((a1 - a0) * (margin - 1)) / 2 - (H * texel) / 2 : (b0 + b1) / 2, am = (a0 + a1) / 2;
  const target = [0, 1, 2].map(i => r[i] * am + u[i] * bm + f[i] * cm);
  return { texel, target };
}
// a point's place in the view (texels from the centre): for tests and the label pass
export function inView(p, { texel, target }, dir, up, W, H) {
  const { r, u } = viewBasis(dir, up), d = sub(p, target);
  const x = dot(d, r) / texel, y = dot(d, u) / texel;
  return Math.abs(x) <= W / 2 && Math.abs(y) <= H / 2;
}
