// Record weight (UI redesign 2026-11-20, the Records page): how much each directive and decision matters NOW - where it is cited
// (other records, runs, run notes, ledger lines), the runs / lanes / records that cite it, its edits and supersedes, its conflicts
// (a possible duplicate directive, an owner overrule), its age and how long it stood in force, and its recorded violations (only
// what a guard or Norn's scope hook wrote down, citing it - nothing is guessed). Pure over the folded items and the texts the caller
// read (the dash reads the ledger, the notes and the refusals on fs.promises). Node built-ins only.
import { dupPairs } from './dupdirs.mjs';

const ID = /\b(?:DIR|DEC)-\d+\b/g;
const DAY = 864e5;
const IN_FORCE = ['active', 'in-force'];
const idsIn = t => [...new Set(String(t ?? '').match(ID) || [])];
// the text of a record: its data and its history events' data (ids, prose, reasons), never its own id field
const textOf = i => JSON.stringify([i.data ?? null, (i.history || []).map(h => h.data ?? null), i.end ?? null, i.park ?? null]);

/**
 * recordWeights(items, { ledger: [line], notes: [{ run, lane, path, text }], refusals: [{ run, why, at, tool, target }], now })
 * items = the folded records ({ id: item } or a list, every kind). -> { <DIR|DEC id>: { cited: { records, runs, notes, ledger, total },
 * by: { runs: [id], lanes: [name], records: [id], notes: [path] }, edits, supersedes: [id], superseded_by, conflicts: [{ id, why }],
 * age_days, stood_days, violations: [{ source, run?, why, at? }] } }
 */
export function recordWeights(items, { ledger = [], notes = [], refusals = [], now = Date.now() } = {}) {
  const all = Object.values(items || {}), out = {};
  const targets = all.filter(i => i.kind === 'directive' || i.kind === 'decision');
  for (const t of targets) out[t.id] = { cited: { records: 0, runs: 0, notes: 0, ledger: 0, total: 0 }, by: { runs: new Set(), lanes: new Set(), records: new Set(), notes: new Set() },
    edits: (t.history || []).filter(h => h.ev !== 'create').length, supersedes: [], superseded_by: t.superseded_by ?? null, conflicts: [], violations: [],
    age_days: ageOf(t.created, now), stood_days: ageOf(t.created, endOf(t) ?? now) };
  const hit = (id, f) => { const w = out[id]; if (w) f(w); };
  for (const i of all) {
    const lane = i.kind === 'lane' ? String(i.id).replace(/^L:/, '') : i.data?.lane ?? null;
    for (const id of idsIn(textOf(i))) if (id !== i.id) hit(id, w => {
      if (i.kind === 'run') { w.cited.runs++; w.by.runs.add(i.id); } else { w.cited.records++; w.by.records.add(i.id); }
      if (lane) w.by.lanes.add(lane);
      // a guard record that cites the id is a violation a check wrote down (META-GUARD); the rest are citations only
      if (i.kind === 'guard') w.violations.push({ source: 'guard', run: i.data?.run ?? null, why: i.data?.why ?? '', at: i.created ?? null });
    });
    if (i.superseded_by) hit(i.superseded_by, w => w.supersedes.push(i.id));
  }
  for (const n of notes) for (const id of idsIn(n.text)) hit(id, w => { w.cited.notes++; w.by.notes.add(n.path); if (n.run) w.by.runs.add(n.run); if (n.lane) w.by.lanes.add(n.lane); });
  for (const l of ledger) for (const id of idsIn(l)) hit(id, w => { w.cited.ledger++; });
  for (const r of refusals) for (const id of idsIn(r.why)) hit(id, w => { w.violations.push({ source: 'scope hook', run: r.run ?? null, why: r.why, at: r.at ?? null }); if (r.run) w.by.runs.add(r.run); });
  for (const p of dupPairs(items)) { hit(p.older, w => w.conflicts.push({ id: p.newer, why: `possible duplicate: ${p.why}` })); hit(p.newer, w => w.conflicts.push({ id: p.older, why: `possible duplicate: ${p.why}` })); }
  for (const t of targets) for (const h of (t.history || []).filter(x => x.ev === 'overrule')) out[t.id].conflicts.push({ id: h.by ?? 'owner', why: `overruled${h.data?.why ? `: ${h.data.why}` : ''}` });
  for (const w of Object.values(out)) {
    w.cited.total = w.cited.records + w.cited.runs + w.cited.notes + w.cited.ledger;
    w.by = Object.fromEntries(Object.entries(w.by).map(([k, s]) => [k, [...s].sort((a, b) => String(a).localeCompare(String(b), 'en', { numeric: true }))]));
  }
  return out;
}
const ageOf = (iso, until) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? Math.max(0, Math.floor((until - t) / DAY)) : null; };
// when the record left force: its last history event that set a state outside force (a supersede, revoke, overrule, done); null = still in force
function endOf(i) {
  if (IN_FORCE.includes(i.state)) return null;
  const h = [...(i.history || [])].reverse().find(x => x.ev !== 'create' && x.ev !== 'notanswer');
  const t = Date.parse(h?.ts ?? i.updated ?? '');
  return Number.isFinite(t) ? t : null;
}
