// RM-a-65 refactoring targets: `norn code targets` turns SloppaChoppa's size numbers into briefs a lane can run, from the code graph
// (docs/code-graph.md: symbols, call edges, cycles) and the code signals (docs/code-signals.md: the fix-first rank), no model. Three kinds:
// split a file over the file ratchet whose top-level symbols fall into groups with few call edges between them (greedy modularity,
// Clauset-Newman-Moore); break an import cycle at the edge the fewest symbols cross; extract from a function over the function ratchet
// at the block its size numbers point at (measure.mjs). Ranked by the fix-first rank of the files they edit. It proposes; it never edits.
// The candidates are judged lazily in rank order (a split asks the graph for every symbol's callers, ~1-2 s each), so `--top N` reads only
// what it prints; the reader's calls run on a small worker pool. `norn code targets` stores its answer for the Slop page (targets.json).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { graphAt, cycles, symbols, callers, references, LOAD_KINDS } from './codegraph.mjs';
import { readSignals } from './codesignals.mjs';
import { testsFor, IMPACT_FILE } from './testtimes.mjs';
import { readJsonS } from './fsnap.mjs';
import { atomicWrite } from './policy.mjs';
import { CAPS, FILE_CAP, MEASURE_RUN, functionsOf } from './slop/measure.mjs';
import { parseEslint, makeTool } from './slop/tools.mjs';
import { blobs } from './slop/check.mjs';
import { classOf } from './slop/loc.mjs';
import { isJs } from './slop/scan.mjs';

// the one place for the targets' thresholds (the ratchets themselves are measure.mjs's CAPS and FILE_CAP)
export const TARGET_LIMITS = Object.freeze({
  top: 10,               // targets printed by default
  page: 5,               // targets the Slop page lists
  workers: 8,            // reader calls at once (at most half the cores)
  min_group_lines: 60,   // a group moves out only from this many lines ...
  min_group_symbols: 2,  // ... and this many top-level symbols
  max_cut: 0.25,         // ... and when at most this share of its call edges cross to the rest of the file
  groups_max: 3,         // groups proposed per split
  per_file: 3,           // extract targets per file (the largest excess first; the rest counted)
  tests: 8,              // test files a Tests line names; past it, those named for a Scope file and the `norn tests for` line
});
export const TARGETS_FILE = 'targets.json';
const KIND_ORDER = { split: 0, cycle: 1, extract: 2 }, CALLED = new Set(['function', 'method', 'class', 'struct', 'enum', 'trait']);
const codeLines = t => (t || '').split('\n').filter(l => /\S/.test(l)).length;
const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const join = xs => xs.join(', ');
const r1 = n => Math.round(n * 10) / 10;

// ---------- the reader's calls: direct (injected, tests), else a worker pool over codegraph.mjs ----------
if (!isMainThread && workerData?.codetargets) {
  for (const [i, q] of workerData.qs) parentPort.postMessage([i, q.verb === 'callers' ? callers({ ...workerData.o, symbol: q.arg }) : references({ ...workerData.o, name: q.arg })]);
}
async function pooled(qs, o) {
  const n = Math.max(1, Math.min(TARGET_LIMITS.workers, Math.floor(os.availableParallelism() / 2), qs.length)), out = new Array(qs.length);
  await Promise.all(Array.from({ length: n }, (_, k) => new Promise((res, rej) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { codetargets: true, o, qs: qs.map((q, i) => [i, q]).filter(([i]) => i % n === k) } });
    w.on('message', ([i, r]) => { out[i] = r; }); w.on('error', rej); w.on('exit', res);
  })));
  return out;
}
/** the asked queries [{ verb: callers | references, arg, file }] -> their answers, in order */
const askAll = (read, o, qs) => (read.callers ? qs.map(q => (q.verb === 'callers' ? read.callers({ ...o, symbol: q.arg }) : read.references({ ...o, name: q.arg, file: q.file })))
  : pooled(qs.map(({ verb, arg }) => ({ verb, arg })), o));

// ---------- the symbols of a file as units: its top-level definitions (a Rust impl with its type) ----------
function unitsOf(defs) {
  const tops = [], at = new Map();
  for (const d of [...defs].sort((a, b) => a.line - b.line || b.end_line - a.end_line)) {
    const top = tops.find(t => t.line <= d.line && d.end_line <= t.end_line && t !== d);
    if (top) { at.set(d.id, top.id); continue; }
    tops.push(d); at.set(d.id, d.id);
  }
  // an `impl T` / `impl Trait for T` block moves with T: one unit
  const quals = new Map(tops.filter(t => t.kind !== 'impl').map(t => [t.qual, t.id]));
  const lead = new Map();
  for (const t of tops.filter(x => x.kind === 'impl')) { const m = /^(.*?)(?:<(\S+) as .+>)?$/.exec(t.qual), base = m[2] ? m[1] + m[2] : m[1]; if (quals.has(base)) lead.set(t.id, quals.get(base)); }
  const unitOf = id => lead.get(at.get(id)) ?? at.get(id);
  const units = new Map();
  for (const t of tops) { const u = unitOf(t.id), x = units.get(u) || units.set(u, { id: u, names: [], lines: 0, line: t.line }).get(u); if (!lead.has(t.id)) x.names.unshift(t.name); x.lines += t.end_line - t.line + 1; x.line = Math.min(x.line, t.line); }
  return { units: [...units.values()].sort((a, b) => a.line - b.line), unitOf, unitAtLine: line => { const t = tops.find(x => x.line <= line && line <= x.end_line); return t ? unitOf(t.id) : null; } };
}
const nameOf = u => u.names[0] ?? '(impl)';

/** a file's call and name edges through the reader -> { units, unitOf, edges: Map('a|b' -> weight), users: Map(unit -> Set(other files)), calls: Map(unit -> Set(unit)) } | { ok: false, why } */
async function wiring(file, { read, o, deps }) {
  const s = read.symbols({ ...o, file });
  if (s.ok === false) return s;
  const U = unitsOf(s.defs), qs = s.defs.filter(d => CALLED.has(d.kind) || d.kind === 'const').map(d => ({ verb: d.kind === 'const' ? 'references' : 'callers', arg: d.kind === 'const' ? d.name : d.id, file, def: d }));
  const answers = await askAll(read, o, qs), edges = new Map(), users = new Map(), calls = new Map(), ext = [];   // ext: the uses from other files, by site (a cycle's cut checks what its movers import)
  const add = (a, b, w) => { if (!a || !b || a === b) return; const k = a < b ? `${a}|${b}` : `${b}|${a}`; edges.set(k, (edges.get(k) || 0) + w); (calls.get(a) || calls.set(a, new Set()).get(a)).add(b); };
  const use = (u, f) => (users.get(u) || users.set(u, new Set()).get(u)).add(f);
  for (let i = 0; i < qs.length; i++) {
    const a = answers[i], to = U.unitOf(qs[i].def.id);
    if (!a || a.ok === false) return { ok: false, why: `${qs[i].verb} of ${qs[i].def.name}: ${a?.why ?? 'no answer'}` };
    for (const r of a.rows) {
      if (r.file !== file) ext.push({ file: r.file, id: r.caller?.id ?? null, line: r.line });
      if (qs[i].verb === 'references') { if (r.file === file) add(U.unitAtLine(r.line), to, 1); else if (deps.has(r.file)) use(to, r.file); continue; }
      if (r.file === file) add(r.caller ? U.unitOf(r.caller.id) ?? U.unitAtLine(r.line) : U.unitAtLine(r.line), to, 1 / Math.max(1, r.candidates));
      else if (r.candidates === 1) use(to, r.file);
    }
  }
  return { ok: true, ...U, edges, users, calls, ext };
}

// ---------- greedy modularity (Clauset, Newman, Moore 2004): merge the pair of groups with the largest gain until none gains ----------
/** ids, [[a, b, weight]] -> groups of ids (arrays, in the ids' order); an id with no edge is a group of its own */
export function groupsOf(ids, links) {
  const idx = new Map(ids.map((id, i) => [id, i])), m = links.reduce((s, [, , w]) => s + w, 0);
  const groups = ids.map((id, i) => ({ k: i, members: [id], a: 0, e: new Map() }));
  if (!m) return groups.map(g => g.members);
  for (const [x, y, w] of links) {
    const i = idx.get(x), j = idx.get(y);
    if (i === undefined || j === undefined || i === j) continue;
    groups[i].a += w / (2 * m); groups[j].a += w / (2 * m);
    groups[i].e.set(j, (groups[i].e.get(j) || 0) + w / (2 * m)); groups[j].e.set(i, (groups[j].e.get(i) || 0) + w / (2 * m));
  }
  const live = new Map(groups.map(g => [g.k, g]));
  for (;;) {
    let best = null;
    for (const g of live.values()) for (const [j, eij] of g.e) {
      if (j <= g.k) continue;
      const dq = 2 * (eij - g.a * live.get(j).a);
      if (dq > 1e-12 && (!best || dq > best.dq + 1e-12)) best = { dq, i: g.k, j };
    }
    if (!best) break;
    const gi = live.get(best.i), gj = live.get(best.j);
    gi.members.push(...gj.members); gi.a += gj.a; gi.e.delete(gj.k);
    for (const [k, w] of gj.e) { if (k === gi.k) continue; gi.e.set(k, (gi.e.get(k) || 0) + w); const o = live.get(k); o.e.delete(gj.k); o.e.set(gi.k, (o.e.get(gi.k) || 0) + w); }
    live.delete(gj.k);
  }
  return [...live.values()].map(g => g.members.sort((a, b) => idx.get(a) - idx.get(b))).sort((a, b) => idx.get(a[0]) - idx.get(b[0]));
}

// ---------- the three kinds ----------
// a proposed file beside `file`, named for a symbol it gets: at most 4 words; Python and Rust in snake_case (a module name holds no hyphen), JS kebab
export const newFile = (file, sym) => {
  const ext = path.posix.extname(file), stem = file.slice(0, -ext.length), words = String(sym).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 4);
  return `${stem}${/^\.(py|rs)$/.test(ext) ? '_' + words.join('_') : '-' + words.join('-')}${ext}`;
};
/** split-file: the groups that move out (largest group stays) | { na } */
async function splitOf(c, ctx) {
  const w = await wiring(c.file, ctx);
  if (!w.ok) return { na: w.why };
  const ids = w.units.map(u => u.id), unit = new Map(w.units.map(u => [u.id, u])), links = [...w.edges].map(([k, x]) => [...k.split('|'), x]);
  const groups = groupsOf(ids, links).map(ms => ({ ms, lines: ms.reduce((s, id) => s + unit.get(id).lines, 0) }));
  const gOf = new Map(groups.flatMap((g, i) => g.ms.map(id => [id, i]))), inner = groups.map(() => 0), cut = groups.map(() => 0);
  for (const [a, b, x] of links) { const ga = gOf.get(a), gb = gOf.get(b); if (ga === gb) inner[ga] += x; else { cut[ga] += x; cut[gb] += x; } }
  const total = links.reduce((s, l) => s + l[2], 0), stay = groups.reduce((b, g, i) => (g.lines > groups[b].lines ? i : b), 0);
  const moving = groups.map((g, i) => ({ ...g, i })).filter(g => g.i !== stay && g.lines >= TARGET_LIMITS.min_group_lines && g.ms.length >= TARGET_LIMITS.min_group_symbols && cut[g.i] / Math.max(cut[g.i] + inner[g.i], 1e-9) <= TARGET_LIMITS.max_cut)
    .sort((a, b) => b.lines - a.lines || a.i - b.i).slice(0, TARGET_LIMITS.groups_max);
  if (!moving.length) return { na: `no group of at least ${TARGET_LIMITS.min_group_lines} lines with at most ${Math.round(TARGET_LIMITS.max_cut * 100)} % of its call edges crossing (${groups.length} groups over ${ids.length} symbols)` };
  const moved = new Set(moving.flatMap(g => g.ms)), out = moving.map(g => {
    const big = g.ms.reduce((b, id) => (unit.get(id).lines > unit.get(b).lines ? id : b), g.ms[0]);
    return { symbols: g.ms.map(id => nameOf(unit.get(id))), lines: g.lines, to: ctx.rel(newFile(c.file, nameOf(unit.get(big)))), importers: [...new Set(g.ms.flatMap(id => [...(w.users.get(id) || [])]))].map(ctx.rel).sort(byPath), cut: r1(cut[g.i]) };
  });
  const rest = w.units.filter(u => !moved.has(u.id)), cross = links.filter(([a, b]) => gOf.get(a) !== gOf.get(b)).reduce((s, l) => s + l[2], 0);
  return { kind: 'split', file: ctx.rel(c.file), lines: c.lines, groups: out, stays: { symbols: rest.map(nameOf), lines: rest.reduce((s, u) => s + u.lines, 0) }, cut: { edges: r1(cross), total: r1(total) }, units: ids.length };
}

/** break-cycle: the edge inside the cycle the fewest symbols cross, and where they move | { na } */
async function cycleOf(c, ctx) {
  const wires = new Map();
  for (const f of c.cycle) { const w = await wiring(f, ctx); if (!w.ok) return { na: `${ctx.rel(f)}: ${w.why}` }; wires.set(f, w); }
  const inCycle = new Set(c.cycle), kinds = new Set(LOAD_KINDS), seen = new Set();
  const edges = ctx.g.edges.filter(e => kinds.has(e.kind) && e.from !== e.to && inCycle.has(e.from) && inCycle.has(e.to) && !seen.has(`${e.from}|${e.to}`) && seen.add(`${e.from}|${e.to}`));
  const rows = edges.map(e => {
    const w = wires.get(e.to), S = w.units.filter(u => w.users.get(u.id)?.has(e.from)).map(u => u.id);
    const T = new Set(S); for (let grew = true; grew;) { grew = false; for (const id of [...T]) for (const n of w.calls.get(id) || []) if (!T.has(n)) { T.add(n); grew = true; } }
    // the cycle files the movers use: wherever they go they import those again, so a cut that drags one (bar `from`, when they move into it) is no cut
    const drags = c.cycle.filter(f => f !== e.to && wires.get(f).ext.some(x => x.file === e.to && T.has((x.id && w.unitOf(x.id)) ?? w.unitAtLine(x.line))));
    const usedInTo = [...T].some(id => [...w.calls].some(([from, tos]) => !T.has(from) && tos.has(id)));
    const others = [...new Set([...T].flatMap(id => [...(w.users.get(id) || [])]))].filter(f => f !== e.from && f !== e.to).sort(byPath);
    const into = !usedInTo && !others.length, keeps = drags.some(f => f !== e.from || !into);
    return { e, w, S, T, usedInTo, others, into, n: e.kind === 'reexport' || keeps ? Infinity : T.size, keeps };   // what crosses once cut: the symbols used and what they call in their file
  }).sort((a, b) => a.n - b.n || a.S.length - b.S.length || byPath(a.e.from + a.e.to, b.e.from + b.e.to));
  const best = rows[0];
  if (!best || best.n === Infinity) return { na: rows.some(x => x.keeps) ? 'no single import cut breaks the cycle: the symbols that would move use another file of it' : 'every edge of the cycle is a re-export: the symbols crossing are not counted' };
  const { e, w, S, T, others, into } = best, unit = new Map(w.units.map(u => [u.id, u])), names = ids => [...ids].map(id => nameOf(unit.get(id)));
  const to = into ? e.from : newFile(e.to, names(S)[0] ?? 'shared');
  return { kind: 'cycle', file: ctx.rel(e.to), cycle: c.cycle.map(ctx.rel), edge: { from: ctx.rel(e.from), to: ctx.rel(e.to), line: e.line, kind: e.kind }, symbols: names(S),
    move: { to: ctx.rel(to), symbols: names(T), new_file: !into }, users: others.map(ctx.rel), edges: edges.length };
}

/** extract-function: every function of the file over a cap -> [target] | { na } */
function extractOf(c, ctx) {
  if (isJs(c.file)) {
    let fns;
    try { const raw = ctx.tool(MEASURE_RUN, 'head', { texts: new Map([[c.file, c.text]]) }); fns = functionsOf(raw === null ? [] : parseEslint(raw).filter(x => x.file === c.file), c.text); }
    catch (e) { return { na: `the measure run failed: ${String(e.message).split('\n')[0]}` }; }
    return fns.map(f => ({ f, over: Object.fromEntries(Object.keys(CAPS).filter(m => f[m] > CAPS[m]).map(m => [m, f[m]])) })).filter(x => Object.keys(x.over).length)
      .map(({ f, over }) => ({ kind: 'extract', file: ctx.rel(c.file), name: f.name, line: f.line, end: f.end, metrics: over, excess: Object.entries(over).reduce((s, [m, v]) => s + v - CAPS[m], 0),
        block: f.extract && f.extract[1] > f.extract[0] ? f.extract : null, ...(f.extract && f.extract[1] > f.extract[0] ? {} : { block_na: 'no nested block of more than one line' }) }));
  }
  const s = ctx.read.symbols({ ...ctx.o, file: c.file });
  if (s.ok === false) return { na: s.why };
  return s.defs.filter(d => (d.kind === 'function' || d.kind === 'method') && d.end_line - d.line + 1 > CAPS.lines)
    .map(d => ({ kind: 'extract', file: ctx.rel(c.file), name: d.name, line: d.line, end: d.end_line, metrics: { lines: d.end_line - d.line + 1 }, excess: d.end_line - d.line + 1 - CAPS.lines,
      block: null, block_na: 'the measure run is JS only: no complexity, depth or block numbers for Python / Rust yet' }));
}

// ---------- the brief of a target ----------
// past TARGET_LIMITS.tests: the test files named for a Scope file (its stem starts the test's name), then the reader line for the rest
function testsWords(tests, scope) {
  if (tests.length <= TARGET_LIMITS.tests) return join(tests);
  const stems = scope.map(f => path.posix.basename(f).replace(/\.[^.]+$/, '')), base = x => path.posix.basename(x);
  const named = tests.filter(x => stems.some(s => base(x).startsWith(`${s}.`) || base(x).startsWith(`${s}-`))).slice(0, TARGET_LIMITS.tests);
  return `${named.length ? `${join(named)} ` : ''}+${tests.length - named.length} more (\`norn tests for ${scope.join(' ')}\` lists all ${tests.length})`;
}
const rankWords = t => (t.rank === null ? `fix first n/a (${t.rank_na})` : `fix first ${t.rank}`);
function briefOf(t, ctx) {
  const tests = ctx.im ? testsFor(ctx.im, t.scope).tests : null;
  const testsLine = !ctx.im ? `n/a (${ctx.testsNa})` : tests.length ? testsWords(tests, t.scope) : 'none known (the tests index covers no file of the Scope: write the covering test first)';
  const head = `## ${t.title} (${rankWords(t)})`, tail = [`Proposed by \`norn code targets\` from the code graph at ${ctx.stamp.graph} (call edges inferred, trust unmeasured): nothing is edited.`, `Scope: ${join(t.scope)}`, `Tests: ${testsLine}`, `Done: ${t.done}`];
  return { tests: tests ?? [], text: [head, ...t.body, ...tail].join('\n') };
}
function dress(t, ctx) {
  const cap = Object.entries(CAPS).map(([m, v]) => `${m} ${v}`).join(', ');
  if (t.kind === 'split') {
    Object.assign(t, { title: `Split ${t.file}: move ${t.groups.length === 1 ? 'one group' : `${t.groups.length} groups`} out`, scope: [t.file, ...t.groups.map(g => g.to), ...[...new Set(t.groups.flatMap(g => g.importers))].sort(byPath)],
      body: [`${t.file} has ${t.lines} code lines (the file ratchet: ${FILE_CAP.lines}). Its ${t.units} top-level symbols fall into groups with few call edges between them: ${t.cut.edges} of ${t.cut.total} cross.`,
        ...t.groups.map(g => `- move to ${g.to} (a new file; the name is a proposal): ${join(g.symbols)} (${g.lines} lines; ${g.cut} call edges to the rest)${g.importers.length ? `; imported today by ${join(g.importers)}` : ''}`),
        `- stays in ${t.file}: ${join(t.stays.symbols)} (${t.stays.lines} lines)`],
      done: `${t.groups.map(g => `${join(g.symbols)} live in ${g.to}`).join('; ')}; ${t.file} keeps the rest; every file named imports them from their new file; the Tests pass` });
  } else if (t.kind === 'cycle') {
    Object.assign(t, { title: `Break the import cycle ${t.cycle.join(' -> ')}`, scope: [...new Set([t.edge.from, t.edge.to, t.move.to, ...t.users])],
      body: [`${t.cycle.length} files import each other (${t.edges} import edges inside the cycle). The cheapest edge to cut: ${t.edge.from}:${t.edge.line} imports ${t.edge.to}, for ${t.symbols.length ? join(t.symbols) : 'no symbol the graph sees (a side-effect import, or a dead one: check it, then drop it)'}.`,
        `- move ${join(t.move.symbols) || '(nothing)'} from ${t.edge.to} to ${t.move.to}${t.move.new_file ? ' (a new file both import; the name is a proposal)' : ` (only ${t.edge.from} uses ${t.move.symbols.length === 1 ? 'it' : 'them'})`}${t.users.length ? `; also imported by ${join(t.users)}` : ''}`],
      done: `${t.edge.from} no longer imports ${t.edge.to}; \`norn code graph cycles\` lists no cycle through ${t.cycle.join(', ')}; the Tests pass` });
  } else {
    const nums = Object.entries(t.metrics).map(([m, v]) => `${m} ${v} (cap ${CAPS[m]})`).join(', ');
    Object.assign(t, { title: `Extract from ${t.name} (${t.file}:${t.line})`, scope: [t.file], symbols: [t.name],
      body: [`${t.name} (${t.file}:${t.line}-${t.end}) is over the function ratchet: ${nums}.`,
        ...(t.more ? [`- ${t.more} more function(s) of ${t.file} are over the ratchet too, with a smaller excess: they rank once these land`] : []),
        t.block ? `- extract lines ${t.block[0]}-${t.block[1]} (its largest nested block) into a named function of its own` : `- block boundaries: n/a (${t.block_na}); split it at its own steps`],
      done: `${t.name} is under every function cap (${cap})${t.block ? `; lines ${t.block[0]}-${t.block[1]} live in a function of their own` : ''}; the Tests pass` });
  }
  const b = briefOf(t, ctx);
  t.tests = b.tests; t.text = b.text; delete t.body;
  return t;
}

// ---------- the ranked list ----------
/**
 * refactorTargets({ state, repo, top, graph?, read?, signals?, impact?, tool?, text? }) -> Promise<{ at, basis: 'inferred', stamp, limits,
 * rank_na?, targets: [Target], na: [{ kind, file, why }], judged }>. graph / read ({ symbols, callers, references }) / signals / impact /
 * tool (the measure run) / text (file -> its text at the graph's commit) are the readers' answers when the caller has them (tests).
 */
export async function refactorTargets({ state, repo, top = TARGET_LIMITS.top, graph, read, signals, impact, tool, text } = {}) {
  const g = graph ?? graphAt({ state, repo });
  if (!g.ok) return { ok: false, why: g.why };
  let s = signals, sWhy = null;
  if (s === undefined) try { s = readSignals(state); } catch (e) { s = null; sWhy = `unreadable signals: ${e.message}`; }
  const im = impact !== undefined ? impact : state ? readJsonS(path.join(state, 'tests', IMPACT_FILE)) : null;
  const rank_na = !s ? sWhy ?? 'no code signals stored (`norn code history` writes them)' : s.fixes?.status !== 'measured' ? s.fixes?.reason ?? 'the fix history is n/a' : null;
  const inside = f => f.startsWith(g.prefix), rel = f => f.slice(g.prefix.length);
  const files = [...g.files].filter(([f, x]) => x.lang && !x.excluded && inside(f) && classOf(rel(f)) === 'code').map(([f, x]) => ({ file: f, lang: x.lang }));
  const texts = text ? files.map(x => text(x.file)) : blobs(g.root, files.map(x => `${g.stamp.commit}:${x.file}`));
  files.forEach((x, i) => { x.text = texts[i] ?? ''; x.lines = codeLines(x.text); });
  const rankOf = f => (rank_na ? null : s.files?.[rel(f)]?.fix_first ?? null);
  const why = f => rank_na ?? (s.files?.[rel(f)] ? 'n/a in the signals' : 'not in the signals index');
  const byFile = new Map(files.map(x => [x.file, x]));
  const cands = [
    ...files.filter(x => x.lines > FILE_CAP.lines).map(x => ({ kind: 'split', file: x.file, lines: x.lines, rank: rankOf(x.file), na: why(x.file) })),
    ...cycles(g).cycles.filter(cy => cy.every(f => byFile.has(f))).map(cy => { const rs = cy.map(rankOf).filter(r => r !== null); return { kind: 'cycle', file: cy[0], cycle: cy, lines: cy.reduce((n, f) => n + byFile.get(f).lines, 0), rank: rs.length ? Math.max(...rs) : null, na: why(cy[0]) }; }),
    ...files.filter(x => isJs(x.file) || x.lines > CAPS.lines).map(x => ({ kind: 'extract', file: x.file, lines: x.lines, text: x.text, rank: rankOf(x.file), na: why(x.file) })),
  ].sort((a, b) => (b.rank ?? -1) - (a.rank ?? -1) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.lines - a.lines || byPath(a.file, b.file));
  const stamp = { graph: g.stamp.commit.slice(0, 12), graph_exact: g.stamp.exact, signals: s?.sha ?? null, tests: im?.sha ?? null };
  const ctx = { g, rel, read: read ?? { symbols }, o: { state, repo: repo ?? g.root, at: g.stamp.commit }, deps: null, tool: tool ?? makeTool(), im, testsNa: `no ${IMPACT_FILE} (\`norn tests index\` writes it)`, stamp };
  const out = [], na = [];
  let judged = 0;
  for (const c of cands) {
    if (out.length >= top) break;
    judged++;
    ctx.deps = new Set(g.edges.filter(e => e.to === c.file || c.cycle?.includes(e.to)).map(e => e.from));
    const r = c.kind === 'split' ? await splitOf(c, ctx) : c.kind === 'cycle' ? await cycleOf(c, ctx) : extractOf(c, ctx);
    if (r.na) { na.push({ kind: c.kind, file: rel(c.file), why: r.na }); continue; }
    const ts = Array.isArray(r) ? r.sort((a, b) => b.excess - a.excess || a.line - b.line) : [r], more = ts.length - TARGET_LIMITS.per_file;
    if (more > 0) ts[TARGET_LIMITS.per_file - 1].more = more;
    for (const t of ts.slice(0, TARGET_LIMITS.per_file)) out.push(dress({ ...t, rank: c.rank, ...(c.rank === null ? { rank_na: c.na } : {}) }, ctx));
  }
  return { at: new Date().toISOString(), basis: 'inferred', stamp, limits: TARGET_LIMITS, ...(rank_na ? { rank_na } : {}), targets: out.slice(0, top), na, judged, candidates: cands.length };
}

/** the text answer: the stamp line, then each target's brief, then the candidates judged n/a */
export function targetLines(r) {
  const head = `refactor targets at ${r.stamp.graph}${r.stamp.graph_exact === false ? ' (newest stored)' : ''} · fix first ${r.rank_na ? `n/a (${r.rank_na})` : `from signals ${r.stamp.signals}`} · tests index ${r.stamp.tests ?? 'n/a'} · ${r.targets.length} shown, ${r.judged} of ${r.candidates} candidates judged`;
  return [head, ...r.targets.flatMap(t => ['', t.text]), ...(r.na.length ? ['', ...r.na.map(x => `n/a ${x.kind} ${x.file}: ${x.why}`)] : [])];
}
const fileOf = state => path.join(state, 'code', TARGETS_FILE);
/** the stored answer (the Slop page reads it) | null when `norn code targets` has not run */
export const readTargets = state => readJsonS(fileOf(state)) ?? null;
/** the Slop page's slice of the stored answer: the top TARGET_LIMITS.page targets, each its kind, title, rank, Scope and brief text | null */
export const pageTargets = state => { const r = readTargets(state); return r?.targets ? { at: r.at, stamp: r.stamp, rank_na: r.rank_na ?? null, list: r.targets.slice(0, TARGET_LIMITS.page).map(t => ({ kind: t.kind, title: t.title, rank: t.rank, scope: t.scope, text: t.text })) } : null; };
export const writeTargets = (state, r) => { fs.mkdirSync(path.dirname(fileOf(state)), { recursive: true }); atomicWrite(fileOf(state), JSON.stringify(r)); };
