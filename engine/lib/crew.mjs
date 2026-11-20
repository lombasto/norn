// Crew (DWARVES.md 1.3, 1.5, 1.6): the machine-wide named workers ("dwarves") that take the worker runs, one run at a time. The store
// is <state_root>/crew/crew.jsonl: append-only dwarf events (hire, pin, unpin, retire, recall; each with by + at), folded by records.mjs
// fold under the store's own lock. A node's state root is its own, so a federated node serves its runs from its own crew. Assignment
// happens at the start of a worker run (runs.mjs), under this lock, so two launches never take one dwarf. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import { fold, readEvents, readEventsAsync, withLock, isoSec } from './records.mjs';

export class CrewError extends Error {
  constructor(message, code = 2) { super(message); this.code = code; }
}

// 1.6: 37 of Tolkien's dwarves in hiring order: the Company, Durin's line and kin, Moria, Nár, the smiths, Belegost, the petty-dwarves
export const POOL = [['thorin', 'Thorin'], ['balin', 'Balin'], ['dwalin', 'Dwalin'], ['fili', 'Fíli'], ['kili', 'Kíli'], ['dori', 'Dori'], ['nori', 'Nori'],
  ['ori', 'Ori'], ['oin', 'Óin'], ['gloin', 'Glóin'], ['bifur', 'Bifur'], ['bofur', 'Bofur'], ['bombur', 'Bombur'],
  ['durin', 'Durin'], ['thror', 'Thrór'], ['thrain', 'Thráin'], ['dain', 'Dáin'], ['nain', 'Náin'], ['fundin', 'Fundin'], ['farin', 'Farin'],
  ['borin', 'Borin'], ['frerin', 'Frerin'], ['gror', 'Grór'], ['groin', 'Gróin'], ['dis', 'Dís'], ['gimli', 'Gimli'],
  ['floi', 'Flói'], ['frar', 'Frár'], ['loni', 'Lóni'], ['nar', 'Nár'], ['telchar', 'Telchar'], ['narvi', 'Narvi'], ['gamil-zirak', 'Gamil Zirak'],
  ['azaghal', 'Azaghâl'], ['mim', 'Mîm'], ['khim', 'Khîm'], ['ibun', 'Ibun']];
const DISPLAY = new Map(POOL);
const ROMAN = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
const roman = n => ROMAN.reduce((s, [v, r]) => { while (n >= v) { s += r; n -= v; } return s; }, '');
const baseOf = id => String(id).replace(/-\d+$/, '');
/** a dwarf id -> its display name: 'oin' -> 'Óin', 'balin-2' -> 'Balin II' (the regnal numeral, 1.6); null for no id */
export function dwarfDisplay(id) {
  if (!id) return null;
  const m = String(id).match(/^(.+)-(\d+)$/), base = m && DISPLAY.has(m[1]) ? m[1] : id;
  return `${DISPLAY.get(base) ?? id}${m && base === m[1] ? ' ' + roman(Number(m[2])) : ''}`;
}
/** a run's dwarf as a page row field: { id, name } | null (a run with no dwarf: a check-in, a merge, a run from before the crew) */
export const dwarfOf = r => (r?.data?.dwarf ? { id: r.data.dwarf, name: dwarfDisplay(r.data.dwarf) } : null);
/** the kind word a page shows for a run with no dwarf (3.3): Norn's own steps by their kind, a run from before the crew as 'worker' */
export const kindWord = d => (d?.kind === 'checkin' ? 'check-in' : d?.kind === 'audit' ? 'audit' : d?.kind === 'interactive' ? 'session' : d?.role === 'helper' ? 'helper'
  : String(d?.stage ?? '').toUpperCase() === 'MERGE' ? 'merge' : 'worker');
/** the page fields of a run's doer: { dwarf: { id, name } | null, kind_word: null | the kind word when it has no dwarf } */
export const doerOf = r => { const dwarf = dwarfOf(r); return { dwarf, kind_word: dwarf ? null : kindWord(r?.data) }; };

// the dwarf state machine for records.mjs fold (no prefix: a dwarf's id is its name)
export const CREW_KINDS = { dwarf: { events: {
  hire: { from: null, to: 'active' },
  pin: { from: ['active'], to: null },
  unpin: { from: ['active', 'retired'], to: null },
  retire: { from: ['active'], to: 'retired' },
  recall: { from: ['retired'], to: 'active' },
} } };
export const CREW_EVENTS = Object.keys(CREW_KINDS.dwarf.events);

export const crewDir = state => path.join(path.dirname(path.resolve(state)), 'crew');
export const crewFile = state => path.join(crewDir(state), 'crew.jsonl');
/** the project of a state dir as a pin names it (<project>/<lane>): the state dir's own name */
export const projectOf = state => path.basename(path.resolve(state));

/** the store's events; an unreadable store throws a CrewError in words (DWARVES 4: a launch refuses, it never runs nameless) */
export function readCrew(state) {
  const f = crewFile(state);
  try { return readEvents(f); } catch (e) {
    throw new CrewError(`crew store ${f.replace(/\\/g, '/')} unreadable (${e.message}): no worker run starts without a dwarf - repair or move the file`, 1);
  }
}

/** events -> { dwarves: { id: { id, name, state, hired, order, pins, retired?, why?, succeeds? } } } (pure) */
export function crewState(events) {
  const { items } = fold(events.map(e => ({ ...e, ts: e.at })), CREW_KINDS);
  const dwarves = {};
  for (const it of Object.values(items)) {
    let pins = [], retired = null, why = null;
    for (const h of it.history) {
      if (h.ev === 'pin' && !pins.includes(h.data.lane)) pins.push(h.data.lane);
      if (h.ev === 'unpin') pins = h.data.lane ? pins.filter(l => l !== h.data.lane) : [];
      if (h.ev === 'retire') { retired = { seq: h.seq, at: h.ts }; why = h.data.why ?? null; }
      if (h.ev === 'recall') { retired = null; why = null; }
    }
    dwarves[it.id] = { id: it.id, name: dwarfDisplay(it.id), state: it.state, hired: it.created, order: it.history[0].seq, pins,
      ...(retired ? { retired: retired.at, retired_seq: retired.seq, why } : {}), ...(it.data.succeeds ? { succeeds: it.data.succeeds } : {}) };
  }
  return { dwarves };
}

/**
 * The next name to hire (pure, 1.6): the first pool name never used; once the pool is used up, the earliest-retired dwarf whose name
 * no later dwarf has taken passes it on with a regnal numeral (balin -> balin-2, "Balin II"); with none retired, the earliest-hired.
 */
export function nextName(state) {
  const used = new Set(Object.keys(state.dwarves)), fresh = POOL.find(([id]) => !used.has(id));
  if (fresh) return fresh[0];
  const base = baseOf(heirFrom(state).id);
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
// the dwarf whose name the next regnal hire takes (the pool used up): the earliest-retired not yet passed on, else the earliest-hired
function heirFrom(state) {
  const all = Object.values(state.dwarves), passed = new Set(all.map(d => d.succeeds).filter(Boolean)), free = all.filter(d => !passed.has(d.id));
  return free.filter(d => d.state === 'retired').sort((a, b) => a.retired_seq - b.retired_seq)[0] ?? free.sort((a, b) => a.order - b.order)[0];
}

/**
 * Who takes a worker run (pure, 1.3 rules 1-3). run: { project, lane }; busy: { dwarf id: RUN id of its running run };
 * past: [{ dwarf, project, lane, at }] (every run a dwarf took, machine-wide). -> { dwarf } | { hire: id } | { wait: words }
 */
export function pickDwarf(state, run, busy = {}, past = []) {
  const key = `${run.project}/${run.lane}`, active = Object.values(state.dwarves).filter(d => d.state === 'active');
  const pinned = active.find(d => d.pins.includes(key));
  if (pinned) return busy[pinned.id] ? { wait: `dwarf: ${pinned.name} is busy on ${busy[pinned.id]}` } : { dwarf: pinned.id };
  const free = active.filter(d => !d.pins.length && !busy[d.id]);
  if (!free.length) return { hire: nextName(state) };
  const ids = new Set(free.map(d => d.id)), mine = past.filter(p => ids.has(p.dwarf));
  const last = mine.filter(p => p.project === run.project && p.lane === run.lane).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
  if (last) return { dwarf: last.dwarf };
  const n = {}, lastAt = {};
  for (const p of mine) { if (p.project === run.project) n[p.dwarf] = (n[p.dwarf] || 0) + 1; if (String(p.at) > String(lastAt[p.dwarf] ?? '')) lastAt[p.dwarf] = p.at; }
  const idle = d => String(lastAt[d.id] ?? d.hired);
  const [best] = free.sort((a, b) => (n[b.id] || 0) - (n[a.id] || 0) || idle(a).localeCompare(idle(b)) || a.order - b.order);
  return { dwarf: best.id };
}

// ---------- the store's writes: one lock, the checked events appended (the caller's work may run inside the lock: withCrew) ----------
const LANE_RE = /^[^/\s]+\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
function checkEvent(st, { ev, id, data }) {
  const def = CREW_KINDS.dwarf.events[ev];
  if (!def) throw new CrewError(`unknown crew event ${JSON.stringify(ev)} (${CREW_EVENTS.join(' | ')})`);
  const d = st.dwarves[id];
  if (def.from === null) { if (d) throw new CrewError(`${id} is already hired`); return; }
  if (!d) throw new CrewError(`no dwarf ${JSON.stringify(id)} in the crew (norn crew list)`);
  if (!def.from.includes(d.state)) throw new CrewError(`${d.name} is ${d.state}; ${ev} needs ${def.from.join(' | ')}`);
  if (ev === 'pin') {
    if (!LANE_RE.test(data.lane || '')) throw new CrewError(`--lane wants <project>/<lane> (got ${JSON.stringify(data.lane ?? '')})`);
    const other = Object.values(st.dwarves).find(x => x.state === 'active' && x.pins.includes(data.lane));
    if (other) throw new CrewError(`${data.lane} is already pinned to ${other.name}${other.id === id ? '' : ` - unpin ${other.id} first`}`);
  }
  if (ev === 'retire' && !String(data.why || '').trim()) throw new CrewError('retire needs --why');
}
/**
 * Run fn({ state, hire(id, by), check(ev, id, data), act(ev, id, by, data) }) under the crew lock (check: act's refusal, nothing written); its writes are appended as it makes them, so the
 * caller's own write (the run's start event) lands while the lock still holds. An unreadable store throws before fn runs.
 */
export function withCrew(state, fn, { now = () => new Date() } = {}) {
  const dir = crewDir(state), file = crewFile(state);
  fs.mkdirSync(dir, { recursive: true });
  return withLock(path.join(dir, 'crew.lock'), () => {
    const events = readCrew(state);
    let st = crewState(events), seq = events.reduce((m, e) => Math.max(m, e.seq), 0);
    const append = (ev, id, by, data = {}) => {
      checkEvent(st, { ev, id, data });
      const env = { v: 1, seq: ++seq, at: isoSec(now()), id, kind: 'dwarf', ev, by, data };
      const fd = fs.openSync(file, 'a');
      try { fs.writeSync(fd, JSON.stringify(env) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      events.push(env); st = crewState(events);
      return env;
    };
    const ctx = {
      get state() { return st; },
      hire(id, by = 'launcher') {
        const from = DISPLAY.has(id) ? null : heirFrom(st);
        append('hire', id, by, from && baseOf(from.id) === baseOf(id) ? { succeeds: from.id } : {});
        return id;
      },
      check: (ev, id, data = {}) => checkEvent(st, { ev, id, data }),
      act: append,
    };
    return fn(ctx);
  });
}

/** the pins of one project: { lane: { id, name } } (the queue rows of a pinned lane say who takes them); an unreadable store = none */
export function lanePins(state) {
  try { return pinsOf(crewState(readCrew(state)), state); } catch { return {}; }
}
/** lanePins on fs.promises (the dash server's request paths never block the event loop on a read) */
export async function lanePinsAsync(state) {
  try { return pinsOf(crewState(await readEventsAsync(crewFile(state))), state); } catch { return {}; }
}
function pinsOf(st, state) {
  const out = {}, pre = projectOf(state) + '/';
  for (const d of Object.values(st.dwarves)) if (d.state === 'active') for (const l of d.pins) if (l.startsWith(pre)) out[l.slice(pre.length)] = { id: d.id, name: d.name };
  return out;
}
