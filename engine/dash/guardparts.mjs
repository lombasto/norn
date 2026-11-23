// META-UX-BUILD S2: the Guard page in parts (the sub-view pattern, subviews.mjs). The first answer (`?part=summary`) carries no list:
// the counts, the top row (SloppaChoppa's line), the type labels and a sig of the view (parts of the same sig are reused). Each
// sub-view is one part, its list capped (`&limit=`) with its full count. No `part` = the full view (the chips on other tabs).
// Pure, no I/O: the server cuts the parts from guardOf; the browser reads GUARD_SUBS.
// META-UX-BUILD S5 (REPORT s.2-3): Slop - To fix is ONE list in batches: rows grouped by check + kind of fix (the kind each check
// declares, guardview.mjs), the kinds in the order ready, to draft, your call, only counts; a batch shows its first BATCH_ROWS rows and
// opens (`&batch=<key>`) to every row, capped at the limit.
import { capList, SUB_CAP } from './subviews.mjs';

export const BATCH_ROWS = 3;
/** the order of the kinds of fix = advisory.mjs FIX_KINDS (this file is served to the page, which cannot load lib/; a test holds them equal) */
export const KIND_ORDER = ['ready', 'drafts', 'call', 'count'];

/** [id, label]: To fix (every open finding) · Per type (the counts per type) · Rules (the rule ledger + the rule rows + the Linters) · By age (the open findings by first-seen day) */
export const GUARD_SUBS = [['fix', 'To fix'], ['types', 'Per type'], ['rules', 'Rules'], ['age', 'By age']];   // UX review 6: open findings by first-seen day (not the open count over time)
const WARN = s => s === 'high' || s === 'medium';
// FNV-1a over what a part shows: a row that comes, goes or turns old, the scan landing, the ledger
const sig = g => fnv(JSON.stringify([g.pending, g.slop, g.ledger, g.precision, (g.rows || []).map(r => `${r.id}:${r.new ? 1 : 0}:${r.severity}${r.sent ? ':' + r.sent : ''}${r.declined ? ':d' : ''}`)]));
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
const ruleRows = g => (g.rows || []).filter(r => r.type === 'rules');

const SEV = { high: 0, medium: 1, low: 2, count: 3 };
/** rows (ranked) -> batches [{ key, title, kind, ways, action, n, new, warn, severity (the worst), rows }], kinds in order, then warn, new, size */
export function batchesOf(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = r.batch ?? `${r.type}|${r.kind ?? 'drafts'}`;
    if (!m.has(k)) m.set(k, { key: k, title: r.title ?? r.surface ?? k, kind: r.kind ?? 'drafts', ...(r.ways ? { ways: r.ways } : {}), action: r.action ?? null, n: 0, new: 0, warn: 0, severity: r.severity, rows: [] });
    const b = m.get(k);
    b.n++; b.rows.push(r);
    if (r.new) b.new++;
    if (WARN(r.severity)) b.warn++;
    if (SEV[r.severity] < SEV[b.severity]) b.severity = r.severity;
  }
  return [...m.values()].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (b.warn > 0) - (a.warn > 0) || (b.new > 0) - (a.new > 0)
    || SEV[a.severity] - SEV[b.severity] || b.n - a.n || a.key.localeCompare(b.key));
}
const kindsOf = rows => Object.fromEntries(KIND_ORDER.map(k => [k, rows.filter(r => (r.kind ?? 'drafts') === k).length]));

/** META-UX-BUILD S5: the full view the header and the chips on every tab read - without the lint's hints and the tightening candidates
 * (H- / T- rows: low, never warn, no chip; on a big project most of the rows) and without patch text; the counts stay whole */
export const chipView = g => ({ ...g, rows: (g.rows || []).filter(r => !/^[HT]-/.test(r.id)).map(r => (typeof r.patch === 'string' ? { ...r, patch: true } : r)) });

/** the guard view (guardOf) without its lists */
export function guardSummary(g) {
  const rows = g.rows || [];
  return { project: g.project, pending: g.pending, slop: g.slop, voice: g.voice, errors: g.errors || [], total: g.total ?? rows.length, new: g.new ?? 0,
    warn: rows.filter(r => WARN(r.severity)).length, kinds: kindsOf(rows), fixable: rows.filter(TICK).length, offer: rows.filter(OFFER).length, sent: g.sent || [], fixcards: g.fixcards || [], batches: batchesOf(rows).filter(b => b.kind !== 'count').length, ledger: g.ledger ?? null, top: rows.slice(0, 1),
    labels: Object.fromEntries((g.types || []).map(t => [t.type, t.label])),
    counts: { fix: rows.length, types: (g.types || []).filter(t => t.open).length, rules: ruleRows(g).length, age: null }, sig: sig(g), meter: g.meter ?? null };
}

// META-UX-BUILD S6 (REPORT s.3 "End to end" 1-2, s.7): the Fix all sheet. One item per batch that is fixed or decided (count rows are
// not offered): ready + to draft are ticked; your call is never ticked - its two ways are two buttons and a pick adds it; the rows of a
// ready / to-draft batch on the owner's own files are their own item (`<batch>|own`), offered and never ticked (stale paragraphs are
// your call already, TIGHTEN_FIX). The send names the item keys + the picked ways; fixPick turns them into the finding ids of the SAME
// view (the sig the sheet was drawn from), so the record carries ids, not a guess.
// a row already sent to the fixer (r.sent = the Fix all decision, server.mjs fixSent) or declined by it with a reason (r.declined,
// fixer.mjs markDeclines: until the finding or its file changes) is not offered again
const OFFER = r => !r.sent && !r.declined && (r.kind ?? 'drafts') !== 'count';
const TICK = r => (r.kind === 'ready' || r.kind === 'drafts') && !r.owner_file && !r.sent && !r.declined;
const OWN = '|own';
const where = rows => rows.filter(r => r.path).slice(0, 3).map(r => `${String(r.path).replace(/\\/g, '/').split('/').slice(-2).join('/')}${r.line ? ':' + r.line : ''}`);
function sheetItems(g) {
  const out = [];
  for (const b of batchesOf((g.rows || []).filter(OFFER))) {
    const item = (key, rows, tick) => ({ key, title: b.title, kind: b.kind, ...(b.ways ? { ways: b.ways } : {}), action: b.action, severity: b.severity, n: rows.length,
      new: rows.filter(r => r.new).length, paths: where(rows), tick, ...(key.endsWith(OWN) ? { own: true } : {}), rows });
    if (b.kind === 'call') { out.push(item(b.key, b.rows, false)); continue; }
    const mine = b.rows.filter(r => !r.owner_file), own = b.rows.filter(r => r.owner_file);
    if (mine.length) out.push(item(b.key, mine, true));
    if (own.length) out.push(item(b.key + OWN, own, false));
  }
  return out;
}
/** the sheet: { items [{ key, title, kind, ways?, action, severity, n, new, paths, tick, own? }], kinds (= the summary's), ticked, sig } */
export function fixSheet(g) {
  const items = sheetItems(g).map(({ rows, ...i }) => i);
  return { items, kinds: kindsOf((g.rows || []).filter(r => !r.sent && !r.declined)), sent: g.sent || [], ticked: items.filter(i => i.tick).reduce((n, i) => n + i.n, 0), sig: sig(g) };
}
const bad = m => Object.assign(new Error(m), { status: 400 });
/** { keys (ticked items), picks { <call batch key>: way } } -> { ids (sorted), picks [{ key, way, ids }], batches, set (a hash of ids + ways) } */
export function fixPick(g, { keys = [], picks = {} } = {}) {
  if (!Array.isArray(keys) || !picks || typeof picks !== 'object') throw bad('keys must be a list and picks an object');
  const at = new Map(sheetItems(g).map(i => [i.key, i])), ids = new Set(), out = [];
  for (const k of new Set(keys.map(String))) {
    const i = at.get(k);
    if (!i) throw bad(`no batch ${k} to fix on this sheet (reload it)`);
    if (i.kind === 'call') throw bad(`${k} is your call: pick one of its two ways`);
    for (const r of i.rows) ids.add(r.id);
  }
  for (const [k, way] of Object.entries(picks).sort(([a], [b]) => a.localeCompare(b))) {
    const i = at.get(k);
    if (!i || i.kind !== 'call') throw bad(`no your-call batch ${k} on this sheet (reload it)`);
    if (!i.ways.includes(way)) throw bad(`${JSON.stringify(way)} is not a way of ${k} (${i.ways.join(' | ')})`);
    const x = i.rows.map(r => r.id).sort();
    x.forEach(id => ids.add(id)); out.push({ key: k, way, ids: x });
  }
  if (!ids.size) throw bad('nothing ticked or picked: tick a batch or pick a way');
  const all = [...ids].sort();
  return { ids: all, picks: out, batches: new Set(keys).size + out.length, set: fnv(JSON.stringify([all, out.map(p => [p.key, p.way])])) };
}
/** ui-context-docs: ONE finding from the Docs reader's line popover ({ id, way? }) -> fixPick's shape, from the same offered rows (sent,
 *  declined and count rows are not offered); a your-call finding needs one of its ways */
export function fixOne(g, { id, way = null } = {}) {
  const r = (g.rows || []).filter(OFFER).find(x => x.id === id);
  if (!r) throw bad(`${id} is not open to fix: sent already, declined, or a count. Reload.`);
  const b = batchesOf([r])[0], picks = b.kind === 'call' ? [{ key: b.key, way, ids: [id] }] : [];
  if (b.kind === 'call' && !(b.ways || []).includes(way)) throw bad(`${id} is your call: pick one of ${(b.ways || []).join(' | ')}`);
  return { ids: [id], picks, batches: 1, set: fnv(JSON.stringify([[id], picks.map(p => [p.key, p.way])])) };
}

/** one sub-view's part of the guard view; throws (400) on an unknown name. fix: the batches (capped at the limit), each with its first
 * BATCH_ROWS rows - the open one (batch = its key) with every row up to the limit. finding = one row's id (Slop &finding=): its batch
 * opens, with that row kept past the caps; found = it is open (else the page says so) */
export function guardPart(g, name, limit = SUB_CAP, batch = null, finding = null) {
  if (name === 'fix') {
    const all = batchesOf(g.rows || []), home = finding ? all.find(b => b.rows.some(r => r.id === finding)) : null;
    const want = batch ?? home?.key ?? null, open = all.some(b => b.key === want) ? want : null, c = capList(all, limit);
    const shown = home && !c.rows.includes(home) ? [...c.rows, home] : c.rows;
    const batches = shown.map(b => { const x = capList(b.rows, b.key === open ? limit : BATCH_ROWS), miss = b === home && !x.rows.some(r => r.id === finding);
      return { ...b, rows: miss ? [...x.rows, b.rows.find(r => r.id === finding)] : x.rows }; });
    return { fix: { batches, nb: c.n, n: (g.rows || []).length, ...(open ? { open } : {}), ...(finding ? { finding, found: !!home } : {}) } };
  }
  if (name === 'types') return { types: { rows: g.types || [], n: (g.types || []).length, hist: g.hist ?? null } };   // hist: lib/slophist.mjs histTypes
  if (name === 'rules') return { rules: { ledger: g.ledger ?? null, precision: g.precision ?? [], linters: g.linters ?? null, ...capList(ruleRows(g), limit) } };
  if (name === 'age') return { age: { trend: g.trend ?? null } };
  throw Object.assign(new Error(`unknown part ${name} (summary, or one of ${GUARD_SUBS.map(x => x[0]).join(', ')})`), { status: 400 });
}
