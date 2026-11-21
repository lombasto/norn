// Crew (DWARVES.md 1.3, 1.5, 1.6): the machine-wide named workers ("dwarves") that take the worker runs, one run at a time. The store
// is <state_root>/crew/crew.jsonl: append-only dwarf events (hire, rename, pin, unpin, retire, recall; each with by + at), folded by
// records.mjs fold under the store's own lock. A node's state root is its own, so a federated node serves its runs from its own crew.
// Assignment happens at the start of a worker run (runs.mjs), under this lock, so two launches never take one dwarf. A dwarf's name is
// generated (drawName: a given name + a surname, seeded by the home and a counter), unique among every dwarf this machine knows (its
// own crew and the other homes' dwarves in the fetched run copies) and carried by its hire / rename event; its id stays the key of its
// runs. Node built-ins only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fold, readEvents, readEventsAsync, withLock, isoSec, homeOf, copyFile, crewFile } from './records.mjs';

export class CrewError extends Error {
  constructor(message, code = 2) { super(message); this.code = code; }
}

// ---------- the names (1.6): original, dwarvish in feel (Norse / Scots / Old English parts), never a character of a book or a game ----------
// a given name is a head + a tail ("Brak" + "dun"); a surname is mostly a clan compound (stone, iron, forge ... + -beard, -fist, -delve ...),
// else a patronymic ("Haldursson"), a Scots "Mac" form ("MacHaldur") or "son of Haldur". ~2,500 given names x ~2,400 clan surnames.
export const GIVEN_HEAD = ['Brak', 'Dun', 'Gor', 'Hal', 'Kar', 'Bram', 'Thrak', 'Dorn', 'Grim', 'Hrod', 'Ulf', 'Torg', 'Mag', 'Ruk', 'Skar', 'Brun',
  'Hag', 'Vond', 'Ord', 'Arn', 'Ast', 'Bjor', 'Eld', 'Gar', 'Har', 'Ing', 'Jor', 'Kol', 'Lod', 'Mor', 'Nor', 'Odd', 'Rag', 'Sig', 'Stig', 'Var',
  'Gund', 'Hjal', 'Kjar', 'Bor', 'Dag', 'Durn', 'Gunn', 'Hed', 'Rur', 'Aldr', 'Bodd', 'Crag', 'Fearg', 'Lach', 'Murd', 'Tav', 'Wulf', 'Leof',
  'Ead', 'Os', 'Cyn', 'Brod', 'Grum', 'Thurg', 'Vigg', 'Ketil', 'Ulm', 'Skeg', 'Hrafn'];
export const GIVEN_TAIL = ['ric', 'din', 'grim', 'dor', 'rik', 'ak', 'un', 'ur', 'gar', 'mund', 'nar', 'vald', 'stan', 'wulf', 'bek', 'dal', 'li',
  'ok', 'rak', 'bur', 'dur', 'gun', 'helm', 'kell', 'mir', 'vik', 'ald', 'brand', 'mod', 'red', 'wald', 'ir', 'eth', 'ek', 'orn', 'is', 'ar', 'olf'];
export const CLAN_HEAD = ['Stone', 'Iron', 'Copper', 'Coal', 'Granite', 'Flint', 'Slate', 'Anvil', 'Forge', 'Deep', 'Ember', 'Ash', 'Cinder', 'Tin',
  'Gold', 'Silver', 'Bronze', 'Steel', 'Bright', 'Grey', 'Black', 'Red', 'Broad', 'Rune', 'Gem', 'Ore', 'Shale', 'Basalt', 'Quartz', 'Oak', 'Frost',
  'Thunder', 'Storm', 'Hearth', 'Brew', 'Barrel', 'Axe', 'Pick', 'Chisel', 'Bellows', 'Lode', 'Vein', 'Cave', 'Moss', 'Root', 'Crag', 'Peak',
  'Gravel', 'Marble', 'Garnet', 'Amber', 'Jet', 'Lead', 'Pewter', 'Rock', 'Boulder', 'Cobble', 'Mead', 'Ale', 'Torch', 'Lantern', 'Rust', 'Brass', 'Nickel'];
export const CLAN_TAIL = ['son', 'beard', 'hand', 'fist', 'delve', 'hammer', 'forge', 'helm', 'shield', 'brow', 'back', 'foot', 'mantle', 'heart',
  'axe', 'mail', 'vein', 'cleft', 'mug', 'breaker', 'cutter', 'smith', 'wright', 'bender', 'mender', 'grip', 'arm', 'born', 'mane', 'brand',
  'tongs', 'shaper', 'hewer', 'digger', 'braid', 'keg', 'knuckle', 'delver'];
// the canon a draw could reproduce (Tolkien, the Eddas' list of dwarves, Warcraft, Warhammer, the Realms, Dragonlance, Discworld, the Witcher),
// as nameKey keys: a draw whose full name, given name or surname is one of them is drawn again
export const DENY = new Set(['thorin', 'balin', 'dwalin', 'fili', 'kili', 'dori', 'nori', 'ori', 'oin', 'gloin', 'bifur', 'bofur', 'bombur', 'durin',
  'thror', 'thrain', 'dain', 'nain', 'fundin', 'farin', 'borin', 'frerin', 'gror', 'groin', 'dis', 'gimli', 'floi', 'frar', 'loni', 'nar', 'telchar',
  'narvi', 'azaghal', 'mim', 'khim', 'ibun', 'oakenshield', 'ironfoot', 'stonehelm', 'longbeard', 'firebeard', 'broadbeam', 'stiffbeard',
  'blacklock', 'stonefoot', 'beorn', 'andvari', 'austri', 'vestri', 'nordri', 'sudri', 'brokk', 'brokkr', 'eitri', 'sindri', 'alvis', 'regin',
  'fafnir', 'fjalar', 'galar', 'dvalin', 'yngvi', 'frosti', 'hornbori', 'haugspori', 'vindalf', 'thekk', 'magni', 'muradin', 'brann', 'bronzebeard',
  'wildhammer', 'falstad', 'kurdran', 'thaurissan', 'mekkatorque', 'moira', 'dagran', 'ironforge', 'gotrek', 'gurnisson', 'thorgrim',
  'grudgebearer', 'ungrim', 'ironfist', 'belegar', 'ironhammer', 'ironbrow', 'thorek', 'grombrindal', 'grungni', 'grimnir', 'valaya', 'makaisson',
  'malakai', 'snorri', 'nosebiter', 'bugman', 'kazador', 'burlok', 'damminson', 'bruenor', 'battlehammer', 'pwent', 'fireforge', 'ironfoundersson',
  'littlebottom', 'zoltan', 'chivay', 'yarpen', 'zigrin', 'diggums']);
/** a name as its comparison key: no accents, lower case, letters and single spaces ("MacHaldur" -> "machaldur") */
export const nameKey = s => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
/** a name as a dwarf id: its key with hyphens ("Brakdun son of Haldur" -> "brakdun-son-of-haldur") */
export const slugOf = s => nameKey(s).replace(/ /g, '-');
/** what one dwarf takes from the draws: its id, its name key and its given name ('@' + key: two dwarves a page shows side by side never share a first name) */
export const takenKeys = (id, name) => [id, nameKey(name), '@' + nameKey(String(name ?? '').split(' ')[0])].filter(Boolean);
const three = s => s.replace(/([a-z])\1\1/g, '$1$1');   // a joint of three letters keeps two: "Odd" + "dal" = "Oddal", "Brass" + "son" = "Brasson"
const givenOf = (h, t) => three(GIVEN_HEAD[h % GIVEN_HEAD.length] + GIVEN_TAIL[t % GIVEN_TAIL.length]);
/** the name of one seed (pure): { given, surname, name, parts } from the seed's sha256; parts: the keys the deny list is checked on */
export function nameOf(seed) {
  const b = crypto.createHash('sha256').update(String(seed)).digest(), u = i => b.readUInt32BE(i * 4);
  const given = givenOf(u(1), u(2)), other = givenOf(u(5), u(6)), form = u(0) % 100;
  const [surname, part] = form < 80 ? [three(CLAN_HEAD[u(3) % CLAN_HEAD.length] + CLAN_TAIL[u(4) % CLAN_TAIL.length])]
    : form < 88 ? [`${other}${other.endsWith('s') ? 'on' : 'sson'}`, other] : form < 95 ? [`Mac${other}`, other] : [`son of ${other}`, other];
  const name = `${given} ${surname}`;
  return { given, surname, name, parts: [name, given, surname, ...(part ? [part] : [])].map(nameKey) };
}
// a clan compound of one word twice ("Forgeforge", "Axeaxe")
const twice = s => CLAN_HEAD.some(h => s === h + h.toLowerCase());
/**
 * The name of a hire or a rename (pure): the first draw of the seeds <home>/<n>/0, /1, ... that the deny list lets through and whose name
 * key, given name and id no dwarf in `taken` (takenKeys: name keys, '@' given-name keys, ids) holds. -> { id, name }
 */
export function drawName({ home, n, taken = new Set(), deny = DENY }) {
  for (let k = 0; k < 10000; k++) {
    const d = nameOf(`${home}/${n}/${k}`), id = slugOf(d.name);
    if (!d.parts.some(p => deny.has(p)) && !twice(d.surname) && !taken.has(nameKey(d.name)) && !taken.has('@' + nameKey(d.given)) && !taken.has(id)) return { id, name: d.name };
  }
  throw new CrewError(`no free dwarf name after 10000 draws (home ${home}, name ${n})`, 1);
}

/** a run's dwarf as a person reads it, from the run's data: its name (dwarf_name: the crew's current name, records.mjs loadState / copyItems), else its id; null for no dwarf */
export const dwarfDisplay = d => (d?.dwarf ? d.dwarf_name ?? d.dwarf : null);
/** a run's dwarf as a page row field: { id, name } | null (a run with no dwarf: a check-in, a merge, a run from before the crew) */
export const dwarfOf = r => (r?.data?.dwarf ? { id: r.data.dwarf, name: dwarfDisplay(r.data) } : null);
/** the kind word a page shows for a run with no dwarf (3.3): Norn's own steps by their kind, a run from before the crew as 'worker' */
export const kindWord = d => (d?.kind === 'checkin' ? 'check-in' : d?.kind === 'audit' ? 'audit' : d?.kind === 'interactive' ? 'session' : d?.role === 'helper' ? 'helper'
  : String(d?.stage ?? '').toUpperCase() === 'MERGE' ? 'merge' : 'worker');
/** the page fields of a run's doer: { dwarf: { id, name } | null, kind_word: null | the kind word when it has no dwarf } */
export const doerOf = r => { const dwarf = dwarfOf(r); return { dwarf, kind_word: dwarf ? null : kindWord(r?.data) }; };

// the dwarf state machine for records.mjs fold (no prefix, no counter: a dwarf's id is the slug of the name it was hired with)
export const CREW_KINDS = { dwarf: { events: {
  hire: { from: null, to: 'active' },
  rename: { from: ['active', 'retired'], to: null },
  pin: { from: ['active'], to: null },
  unpin: { from: ['active', 'retired'], to: null },
  retire: { from: ['active'], to: 'retired' },
  recall: { from: ['retired'], to: 'active' },
} } };
export const CREW_EVENTS = Object.keys(CREW_KINDS.dwarf.events);

export const crewDir = state => path.dirname(crewFile(state));
/** the project of a state dir as a pin names it (<project>/<lane>): the state dir's own name */
export const projectOf = state => path.basename(path.resolve(state));

/** the store's events; an unreadable store throws a CrewError in words (DWARVES 4: a launch refuses, it never runs nameless) */
export function readCrew(state) {
  const f = crewFile(state);
  try { return readEvents(f); } catch (e) {
    throw new CrewError(`crew store ${f.replace(/\\/g, '/')} unreadable (${e.message}): no worker run starts without a dwarf - repair or move the file`, 1);
  }
}

/** events -> { dwarves: { id: { id, name, named, state, hired, order, pins, retired?, why? } } } (pure; named: a hire / rename gave the name, else it is the id) */
export function crewState(events) {
  const { items } = fold(events.map(e => ({ ...e, ts: e.at })), CREW_KINDS);
  const dwarves = {};
  for (const it of Object.values(items)) {
    let pins = [], retired = null, why = null, name = null;
    for (const h of it.history) {
      if ((h.ev === 'hire' || h.ev === 'rename') && typeof h.data.name === 'string' && h.data.name.trim()) name = h.data.name;
      if (h.ev === 'pin' && !pins.includes(h.data.lane)) pins.push(h.data.lane);
      if (h.ev === 'unpin') pins = h.data.lane ? pins.filter(l => l !== h.data.lane) : [];
      if (h.ev === 'retire') { retired = { seq: h.seq, at: h.ts }; why = h.data.why ?? null; }
      if (h.ev === 'recall') { retired = null; why = null; }
    }
    dwarves[it.id] = { id: it.id, name: name ?? it.id, named: !!name, state: it.state, hired: it.created, order: it.history[0].seq, pins,
      ...(retired ? { retired: retired.at, retired_seq: retired.seq, why } : {}) };
  }
  return { dwarves };
}

/**
 * Who takes a worker run (pure, 1.3 rules 1-3). run: { project, lane }; busy: { dwarf id: RUN id of its running run };
 * past: [{ dwarf, project, lane, at }] (every run a dwarf took, machine-wide). -> { dwarf } | { hire: true } | { wait: words }
 */
export function pickDwarf(state, run, busy = {}, past = []) {
  const key = `${run.project}/${run.lane}`, active = Object.values(state.dwarves).filter(d => d.state === 'active');
  const pinned = active.find(d => d.pins.includes(key));
  if (pinned) return busy[pinned.id] ? { wait: `dwarf: ${pinned.name} is busy on ${busy[pinned.id]}` } : { dwarf: pinned.id };
  const free = active.filter(d => !d.pins.length && !busy[d.id]);
  if (!free.length) return { hire: true };
  const ids = new Set(free.map(d => d.id)), mine = past.filter(p => ids.has(p.dwarf));
  const last = mine.filter(p => p.project === run.project && p.lane === run.lane).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
  if (last) return { dwarf: last.dwarf };
  const n = {}, lastAt = {};
  for (const p of mine) { if (p.project === run.project) n[p.dwarf] = (n[p.dwarf] || 0) + 1; if (String(p.at) > String(lastAt[p.dwarf] ?? '')) lastAt[p.dwarf] = p.at; }
  const idle = d => String(lastAt[d.id] ?? d.hired);
  const [best] = free.sort((a, b) => (n[b.id] || 0) - (n[a.id] || 0) || idle(a).localeCompare(idle(b)) || a.order - b.order);
  return { dwarf: best.id };
}

// ---------- the names a draw must avoid and the home its seed carries (machine-wide: every state dir under the crew's state root) ----------
const dirsOf = d => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort(); } catch { return []; } };
/** the other homes' dwarves this machine has seen: the takenKeys of every dwarf in the fetched run copies (<project>/homes/<h>/copy) */
export function seenNames(state) {
  const root = path.dirname(path.resolve(state)), out = new Set();
  for (const p of dirsOf(root)) for (const h of dirsOf(path.join(root, p, 'homes'))) {
    let evs; try { evs = readEvents(copyFile(path.join(root, p), h, 'run')); } catch { continue; }
    for (const e of evs) if (e.data?.dwarf) for (const k of takenKeys(e.data.dwarf, e.data.dwarf_name ?? e.data.dwarf)) out.add(k);
  }
  return out;
}
/** the home a name's seed carries: this machine's home id (the home.json of a synced project: the cut's copy of machine.json ledger.home_id), else the hostname */
export function homeSeed(state) {
  const root = path.dirname(path.resolve(state));
  for (const p of dirsOf(root)) { const h = homeOf(path.join(root, p)); if (h) return h.id; }
  return os.hostname();
}

// ---------- the store's writes: one lock, the checked events appended (the caller's work may run inside the lock: withCrew) ----------
const LANE_RE = /^[^/\s]+\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
function checkEvent(st, { ev, id, data }) {
  const def = CREW_KINDS.dwarf.events[ev];
  if (!def) throw new CrewError(`unknown crew event ${JSON.stringify(ev)} (${CREW_EVENTS.join(' | ')})`);
  const d = st.dwarves[id];
  if (ev === 'hire' || ev === 'rename') {
    if (!nameKey(data.name)) throw new CrewError(`${ev} needs a name`);
    const twin = Object.values(st.dwarves).find(x => x.id !== id && nameKey(x.name) === nameKey(data.name));
    if (twin) throw new CrewError(`the name ${data.name} is ${twin.id}'s`);
  }
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
 * Run fn({ state, hire(by), check(ev, id, data), act(ev, id, by, data) }) under the crew lock (check: act's refusal, nothing written); its
 * writes are appended as it makes them, so the caller's own write (the run's start event) lands while the lock still holds. An unreadable
 * store throws before fn runs. hire draws a fresh name (drawName) and returns the new dwarf's id. o.home / o.seen: the seed's home and the
 * other homes' names (default homeSeed / seenNames).
 * A dwarf hired before the names (no name on its hire) gets its drawn name here first, once: a rename event, the id kept, no trace of the old name.
 */
export function withCrew(state, fn, { now = () => new Date(), home, seen } = {}) {
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
    // the n of the seed counts the names given so far; taken: every own dwarf's name and id + the other homes' (read once, on the first draw)
    let others = null;
    const draw = () => {
      others ??= seen ?? seenNames(state);
      const taken = new Set([...others, ...Object.values(st.dwarves).flatMap(d => takenKeys(d.id, d.name))]);
      return drawName({ home: home ?? homeSeed(state), n: events.filter(e => e.ev === 'hire' || e.ev === 'rename').length + 1, taken });
    };
    for (const d of Object.values(st.dwarves).filter(x => !x.named).sort((a, b) => a.order - b.order)) append('rename', d.id, 'launcher', { name: draw().name });
    const ctx = {
      get state() { return st; },
      hire(by = 'launcher') { const { id, name } = draw(); append('hire', id, by, { name }); return id; },
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
