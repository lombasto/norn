// ui-spend-slop: the Slop page's past - which findings closed, per type. The seen store (advisory.mjs seen.json) keeps id -> first_seen
// only (no type, no close), so this keeps <state>/advisory/closed.json:
//   { since (when the store began), open: { id: [type, first_seen] }, closed: [[id, type, first_seen, closed_at]] (the last KEEP) }
// Stepped on a full Guard view (server.mjs guardOf, never while the instruction scan is pending or a part failed): an id gone from the
// view closes, only for the types the view covers (SloppaChoppa off = code ids stay as they were). The lint's hints and the tightening
// candidates (H- / T- ids) stay out: their ids move with a line, so an edit above them would close and reopen them.
// Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';

const DAY = 86400000, KEEP = 5000;
export const histFile = state => path.join(state, 'advisory', 'closed.json');
const tracked = r => typeof r?.id === 'string' && !/^[HT]-/.test(r.id);

/** the pure step: h (null = no store yet) + the view's rows + the types it covers -> { h, dirty } (dirty = write it back) */
export function stepHist(h0, rows, { types, now = Date.now() }) {
  const iso = new Date(now).toISOString(), cover = new Set(types), here = new Set();
  const h = { since: h0?.since ?? iso, open: { ...(h0?.open || {}) }, closed: [...(h0?.closed || [])] };
  let dirty = !h0;
  for (const r of rows) {
    if (!tracked(r) || !cover.has(r.type)) continue;
    here.add(r.id);
    if (!h.open[r.id]) { h.open[r.id] = [r.type, r.first_seen ?? iso]; dirty = true; }
  }
  for (const [id, [type, first]] of Object.entries(h.open)) if (cover.has(type) && !here.has(id)) { delete h.open[id]; h.closed.push([id, type, first, iso]); dirty = true; }
  if (h.closed.length > KEEP) h.closed = h.closed.slice(-KEEP);
  return { h, dirty };
}

/** h -> { since, types: { <type>: { closed, opened7, closed7, net7 } } } (a type with nothing open or closed is absent); null -> null */
export function histTypes(h, now = Date.now()) {
  if (!h) return null;
  const cut = now - 7 * DAY, recent = t => Date.parse(t) >= cut, out = {}, of = t => (out[t] ??= { closed: 0, opened7: 0, closed7: 0, net7: 0 });
  for (const [type, first] of Object.values(h.open)) { of(type); if (recent(first)) out[type].opened7++; }
  for (const [, type, first, at] of h.closed) { const x = of(type); x.closed++; if (recent(first)) x.opened7++; if (recent(at)) x.closed7++; }
  for (const x of Object.values(out)) x.net7 = x.opened7 - x.closed7;
  return { since: h.since, types: out };
}

// a missing store starts one; a corrupt one throws: read as none it would be written over, the closed history lost
const valid = (h, f) => { if (h && typeof h === 'object' && h.open && typeof h.open === 'object' && Array.isArray(h.closed)) return h; throw new Error(`${f}: not a closed-findings store (open + closed)`); };
/** read the store, step it with the view (step = false: read only), write it back when it changed -> histTypes (null: no store yet) */
export async function slopHist(state, rows, { types, now = Date.now(), step = true } = {}) {
  if (!state) return null;
  const f = histFile(state);
  const t = await fs.promises.readFile(f, 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  const h0 = t === null ? null : valid(JSON.parse(t), f);
  if (!step) return histTypes(h0, now);
  const { h, dirty } = stepHist(h0, rows, { types, now });
  if (dirty) {
    try {
      await fs.promises.mkdir(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(h)); await fs.promises.rename(tmp, f);
    } catch { /* read-only state: this answer counts from memory, nothing is kept */ }
  }
  return histTypes(h, now);
}
