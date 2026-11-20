// Records core (META-GENERAL-DESIGN section 3): append-only JSONL event logs, one validated writer, state = fold of events.
// records.jsonl holds question / decision / directive / lane; runs.jsonl holds run (D3). Node built-ins only.
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { readText, readTextA, readdirS, readdirA, readJsonS, snap, newSnap, prime, forget } from './fsnap.mjs';
import { writeViews, writeViewsAsync } from './views.mjs';
import { dlvMerged } from './dlvmerge.mjs';
import { isAncestor } from './dlvgit.mjs';
import { validLabels } from './fed.mjs';
import { ownerPickGuard, carriesOwnerPick, ownerWordsOf, choiceKeyOf } from './qreconcile.mjs';
import { ownerOnlyRefusal, OWNER_ONLY_EXIT } from './checkinguards.mjs';
import { checkinBelow } from './floor.mjs';

// worker (META-GTP-MAIL): a supervised run speaking for itself (META_RUN_ID) - only mail events allow it; tick (lifecycle.mjs): the
// tick archiving a lane by its rules - only the lane archive allows it
export const ROLES = ['owner', 'controller', 'checkin', 'launcher', 'dashboard', 'migration', 'status', 'worker', 'tick'];
export const OWNER = ['owner', 'dashboard']; // the dashboard's buttons act for the owner
const CK = ['controller', 'checkin'];
const MAILERS = ['worker', ...CK];

export class RecordError extends Error {
  constructor(message, code = 2) { super(message); this.code = code; }
}
const fail = msg => { throw new RecordError(msg, 2); };

// kind -> { prefix, file, initial, events: { ev: { from: [states] | null (create), to: state | null (flag), roles } } }
export const KINDS = {
  question: { prefix: 'Q-', file: 'records', events: {
    create: { from: null, to: 'open', roles: CK },
    answer: { from: ['open'], to: 'answered', roles: OWNER },
    apply: { from: ['answered'], to: 'applied', roles: CK },
    supersede: { from: ['open', 'answered'], to: 'superseded', roles: CK },
    withdraw: { from: ['open'], to: 'withdrawn', roles: CK },
    reopen: { from: ['answered', 'applied', 'superseded', 'withdrawn'], to: 'open', roles: OWNER },
    // INBOX-REPLIES: the thread on an open Q. say = the owner's typed message ({ text, via }): a message to the controller, never a
    // ruling - the Q stays open. reply = the controller's / check-in's answer in the thread ({ text, options?, recommend?, propose? }):
    // options revises the list (shown in the thread), propose { key?, text } = a ruling from the owner's words the owner confirms with
    // one tap (an answer naming the reply's seq in `ruling`). Only an answer closes the Q (qthread.mjs reads the thread).
    say: { from: ['open'], to: null, roles: OWNER },
    reply: { from: ['open'], to: null, roles: CK },
  } },
  decision: { prefix: 'DEC-', file: 'records', events: {
    create: { from: null, to: 'in-force', roles: [...CK, ...OWNER] },
    overrule: { from: ['in-force'], to: 'overruled', roles: OWNER },
    supersede: { from: ['in-force'], to: 'superseded', roles: CK },
    // META-Q-RECONCILE R1: "this DEC is not the answer to Q-n" ({ q, why? }) - the digest / Inbox stop pointing Q-n at it
    notanswer: { from: ['in-force', 'overruled', 'superseded'], to: null, roles: [...CK, ...OWNER] },
  } },
  directive: { prefix: 'DIR-', file: 'records', events: {
    create: { from: null, to: 'active', roles: OWNER },
    done: { from: ['active'], to: 'done', roles: CK },
    supersede: { from: ['active'], to: 'superseded', roles: [...CK, ...OWNER] },
    revoke: { from: ['active'], to: 'revoked', roles: OWNER },
  } },
  lane: { prefix: 'L:', file: 'records', events: {
    create: { from: null, to: 'active', roles: [...CK, ...OWNER] },   // META-OOTB F-1: the owner opens a lane (norn lane new, the dashboard's first task)
    park: { from: ['active'], to: 'parked', roles: CK },
    unpark: { from: ['parked'], to: 'active', roles: CK },
    done: { from: ['active', 'parked'], to: 'done', roles: CK },
    // lifecycle.mjs: the check-in archives an idle / stopped lane (CHECKIN.md 2j); the tick its orphan / landed / merged-and-old ones
    archive: { from: ['active', 'parked', 'done'], to: 'archived', roles: [...OWNER, ...CK, 'tick'] },
    unarchive: { from: ['archived'], to: 'active', roles: [...OWNER, 'controller'] },
    // META-CONTROLLER C4 (SPEC sec. 2): a hold (a lease) - { until ISO, holder?, why?, via? }; a later claim extends it, release ends it,
    // the clock ends it at `until`. While held, a check-in write on the lane is refused with exit 5 (HELD_EXIT). Never a check-in's.
    claim: { from: ['active', 'parked'], to: null, roles: ['controller', ...OWNER] },
    release: { from: ['active', 'parked', 'done', 'archived'], to: null, roles: ['controller', ...OWNER] },
  } },
  run: { prefix: 'RUN-', file: 'runs', events: {
    start: { from: null, to: 'running', roles: ['launcher'] },
    end: { from: ['running'], to: 'exited', roles: ['launcher'] },
    lost: { from: ['running'], to: 'lost', roles: ['launcher', 'status'] },
    // a run lost for a STALE heartbeat (a stall, never a certain death) whose heartbeat came back with its supervisor alive: running
    // again (sweepLost). Without it the run's own `end` (from running only) was refused - no result, no deliverable, no hand-off resume
    alive: { from: ['lost'], to: 'running', roles: ['launcher', 'status'] },
    kill: { from: ['running'], to: 'killed', roles: [...OWNER, 'controller'] },
    // the supervisor's auto-resume verdict after a HANDOFF exit: { next: RUN-n } or { refused: why } (design 5); META-CATCH S1: the
    // same verdict on a run lost for a certain death (runs.mjs relaunchLost)
    resume: { from: ['exited', 'lost'], to: null, roles: ['launcher'] },
    // META-CHECKIN-DIET R1: the launcher reviews a ROUTINE end itself ({ refs, routine, why[, queued, brief] }: checkins.mjs)
    review: { from: ['exited', 'lost', 'killed'], to: null, roles: ['checkin', 'controller', 'launcher'] },
    // META-GT12 queue: a run waiting for a cap slot (all start fields + not_before); filled by the launcher ({ next: RUN-m }) or withdrawn
    queue: { from: null, to: 'queued', roles: ['launcher'] },
    fill: { from: ['queued', 'claimed'], to: 'filled', roles: ['launcher'] },
    // META-GTP-FED piece 2: a node's claim on the ledger repo's claims branch, seen by the home fill ({ node }); an expired lease returns
    // the run to the queue ({ why }); the node's done claim fills it ({ next: the node run, node, outcome, head })
    claim: { from: ['queued'], to: 'claimed', roles: ['launcher'] },
    release: { from: ['claimed'], to: 'queued', roles: ['launcher'] },
    // META-AUTONOMY R1: the check-in withdraws a QUEUED run itself (a kill stays owner / controller); { why, next? } - next = its re-queue (norn requeue)
    withdraw: { from: ['queued'], to: 'withdrawn', roles: [...OWNER, ...CK, 'launcher'] },
    // META-AUTONOMY R1: a queued run's after: list swapped (norn requeue rewires a dependant onto the re-queued run): { after, why, from, to }
    rewire: { from: ['queued'], to: null, roles: [...OWNER, ...CK] },
    // META-AUTONOMY R1: no silent withdraw - the fill holds a run whose condition can no longer be met: { why } | { cleared: true }
    hold: { from: ['queued'], to: null, roles: ['launcher'] },
    // META-AUTONOMY R1: a ruling 'its work counts as merged on main' (git cannot see it): { why, sha? } - after.mjs honours it
    landed: { from: ['exited', 'filled', 'lost', 'killed', 'withdrawn'], to: null, roles: [...OWNER, ...CK] },
    // RM-37: the owner's safe pause of a running work run ({ mail: MAIL-n, why? }): the urgent order went out; its HANDOFF end is paused (pause.mjs)
    pause: { from: ['running'], to: null, roles: [...OWNER, 'controller'] },
    // META-CHECKIN-GUARDS R1: a guard refused a move of this (running) run ({ guard: busy | owner-only, why, lane, stage?, answers? })
    refuse: { from: ['running'], to: null, roles: ['launcher'] },
  } },
  // DELIVERABLES-SPEC 1: a lane's / DONE run's branch followed to main and the install. Its own file (deliverables.jsonl), so
  // loadState / `rec list` stay as they were. DONE / MERGED / INSTALLED are derived (dlvmerge.mjs dlvMerged); a MERGED answer is
  // latched by a `merged` event (DLV-MERGED-TRUTH), so a deleted branch or a rebased landing never turns it back into DONE.
  deliverable: { prefix: 'DLV-', file: 'deliverables', events: {
    create: { from: null, to: 'open', roles: ['launcher', ...CK] },
    done: { from: ['open', 'parked'], to: null, roles: ['launcher', ...CK] },          // a later DONE run on the same branch
    park: { from: ['open', 'parked'], to: 'parked', roles: [...CK, ...OWNER] },       // with the owner's reason; resurfaces after 7 d
    unpark: { from: ['parked'], to: 'open', roles: [...CK, ...OWNER] },
    // META-GTP-MERGEQ piece 0: the work landed another way (another DLV, or a port commit): terminal, never resurfaces
    supersede: { from: ['open', 'parked'], to: 'superseded', roles: [...CK, ...OWNER] },
    // RM-7: norn merge-land opened (or found open) the branch's PR to main: { url, number, repo, head, base, merge, run? }
    pr: { from: ['open', 'parked'], to: null, roles: ['launcher', ...CK] },
    // DLV-MERGED-TRUTH: its work is on main { how: pr | git | equivalent | ruling, tip?, pr?, url?, merge_commit?, merged_at?, why?, q? };
    // the tick latches it (a merged PR, git, the content check) or the owner rules it. A later `done` reopens the question.
    merged: { from: ['open', 'parked'], to: null, roles: ['launcher', ...CK, ...OWNER] },
    // DLV-MERGED-TRUTH: the owner's ruling "still open" on a deliverable Norn cannot tell is merged { why?, q? }: it reads DONE again
    still_open: { from: ['open', 'parked'], to: null, roles: [...CK, ...OWNER] },
  } },
  // META-GTP-DAG piece 2 (GT-PARITY-PLAN 2.3, a Gas Town convoy): a group of runs / deliverables with a priority. Its own file
  // (epics.jsonl), so loadState stays as is; members = create.members + add - remove (epics.mjs); DONE is derived, never an event.
  // The launcher adds a run started / queued with `norn run --epic EP-n`.
  epic: { prefix: 'EP-', file: 'epics', events: {
    create: { from: null, to: 'open', roles: [...CK, ...OWNER] },
    add: { from: ['open'], to: null, roles: [...CK, ...OWNER, 'launcher'] },
    remove: { from: ['open'], to: null, roles: [...CK, ...OWNER] },
    close: { from: ['open'], to: 'closed', roles: [...CK, ...OWNER] },
  } },
  // META-GTP-MAIL piece 1 (GT-PARITY-PLAN 2.7; Gas Town: mail = a bead with an assignee, internal/mail/router.go:214-225,1113-1179):
  // a message to RUN-n | lane:L | role:checkin | role:controller. Its own file (mail.jsonl), so loadState stays as is. deliver is
  // THE compare-and-set of delivery (queued -> delivered under the log's lock): a hook and an MCP reader racing for one mail =
  // one wins, the other is refused - the state machine, never a reader-side dedupe. nudge = the supervisor's one claim of an
  // urgent unacked mail (it resumes the run with the mail as its prompt). Owner asks stay Q records.
  mail: { prefix: 'MAIL-', file: 'mail', events: {
    create: { from: null, to: 'queued', roles: [...MAILERS, ...OWNER] },   // RM-37: the owner's pause order (pause.mjs)
    deliver: { from: ['queued'], to: 'delivered', roles: ['launcher', ...MAILERS] },
    nudge: { from: ['queued', 'delivered'], to: 'delivered', roles: ['launcher'] },
    ack: { from: ['queued', 'delivered'], to: 'acked', roles: MAILERS },
  } },
  // META-ROADMAP S1 (SPEC sec. 1): a roadmap node RM-n (a theme or an item) in its own file (roadmap.jsonl). STRUCTURE only: title,
  // kind, parent, order (after), horizon, note, links, planned stages, caveat. Status is derived at read time (roadmap.mjs), never
  // an event or a field. Workers write none.
  item: { prefix: 'RM-', file: 'roadmap', events: {
    create: { from: null, to: 'open', roles: [...CK, ...OWNER] },
    edit: { from: ['open'], to: null, roles: [...CK, ...OWNER] },
    move: { from: ['open'], to: null, roles: [...CK, ...OWNER] },
    link: { from: ['open'], to: null, roles: [...CK, ...OWNER, 'launcher'] },
    unlink: { from: ['open'], to: null, roles: [...CK, ...OWNER, 'launcher'] },
    drop: { from: ['open'], to: 'dropped', roles: [...CK, ...OWNER] },
    reopen: { from: ['dropped'], to: 'open', roles: [...OWNER, 'controller'] },
    verdict: { from: ['open'], to: null, roles: [...CK, ...OWNER] },   // META-CATCH S2: a look verdict (pass | fail + image) on a look item
  } },
  // META-ADOPT A1 (meta-adopt SPEC sec. 4): a draft setup ADP-n of a project (adopt.jsonl); bulk (facts, drafts) in files beside it
  // (state/adopt/ADP-n/), events carry path + sha256. One open per project. A check-in may create and draft, never decide or apply.
  // apply: open -> applied when no part is left undecided (data.complete), else it stays open.
  proposal: { prefix: 'ADP-', file: 'adopt', events: {
    create: { from: null, to: 'open', roles: [...OWNER, ...CK] },
    answer: { from: ['open'], to: null, roles: [...OWNER, 'controller'] },
    draft: { from: ['open'], to: null, roles: ['launcher', ...OWNER, ...CK] },
    decide: { from: ['open'], to: null, roles: [...OWNER, 'controller'] },
    apply: { from: ['open'], to: d => (d.complete ? 'applied' : null), roles: [...OWNER, 'controller'] },
    close: { from: ['open'], to: 'closed', roles: [...OWNER, 'controller'] },
  } },
  // META-STANDING-CONTEXT R1 (DIR-21): "still true" for one paragraph of an instruction file (norn instructions confirm <file>#<anchor>):
  // { file, anchor, line?, head?, why? } in its own file (instructions.jsonl); the paragraph's age restarts, the file is never edited.
  confirm: { prefix: 'ICF-', file: 'instructions', events: {
    create: { from: null, to: 'confirmed', roles: [...OWNER, ...CK] },
  } },
  // META-GUARD R1 (DIR-23): a usage alarm on a live run (guard.mjs: runaway / over-handoff / tool-spam) in its own file (guard.jsonl):
  // { run, cls, why, lane?, cache_read?, turns?, ctx?, ratio? }. The check-in rules it ({ action: let-run | mail | stop, why }); the
  // watch closes it when the run ends. Never a kill by itself.
  guard: { prefix: 'GRD-', file: 'guard', events: {
    create: { from: null, to: 'open', roles: ['launcher', 'status', ...CK, ...OWNER] },
    rule: { from: ['open'], to: 'ruled', roles: [...CK, ...OWNER] },
    close: { from: ['open', 'ruled'], to: 'closed', roles: ['launcher', ...CK, ...OWNER] },
  } },
  // META-SLOP-A (SPEC 3.4.2): a slop finding waived - { rule, scope (a fingerprint or a path glob), why, until? } in its own file
  // (waivers.jsonl). The owner or the controller; a check-in only on the owner's word: { q: an answered Q } (waiverGuard - RUN-61 / RUN-68
  // left Q-1 "waive" unapplied for an hour, mailing the controller). Past `until` it no longer counts (derived, no event).
  waiver: { prefix: 'WVR-', file: 'waivers', events: {
    create: { from: null, to: 'active', roles: [...OWNER, ...CK] },
    revoke: { from: ['active'], to: 'revoked', roles: [...OWNER, 'controller'] },
  } },
};
// META-ROADMAP S1: a roadmap link is a kind:id term (the --after grammar); existence is checked by roadmap.mjs checkLinks
const NID = p => `${p}-(?:[a-z][a-z0-9]{0,15}-)?\\d+`;
// RM-46 S1a: a lane is <name> (this home's) or <home>/<name> (another home's, or a home's own in an address)
const LANE_REF = '(?:[a-z][a-z0-9]{0,15}/)?[A-Za-z0-9][A-Za-z0-9_.-]*';
export const ITEM_LINK_RE = new RegExp(`^(?:dir:${NID('DIR')}|dec:${NID('DEC')}|q:${NID('Q')}|run:${NID('RUN')}|dlv:${NID('DLV')}|ep:${NID('EP')}`
  + `|lane:${LANE_REF}|branch:[A-Za-z0-9][A-Za-z0-9._/-]*|sha:[0-9a-f]{7,40}|doc:\\S.*)$`);
export const HORIZONS = ['now', 'next', 'later'];
// the current parent of an item record (create.parent, then the last move that set one)
export const itemParent = it => { const m = [...it.history].reverse().find(h => h.ev === 'move' && 'parent' in h.data); return m ? m.data.parent : it.data.parent ?? null; };
export const itemLinks = it => {
  let l = [...(it.data.links || [])];
  for (const h of it.history.slice(1)) {
    if (h.ev === 'link') for (const x of h.data.links || []) { if (!l.includes(x)) l.push(x); }
    if (h.ev === 'unlink') l = l.filter(x => !(h.data.links || []).includes(x));
  }
  return l;
};
// META-CATCH S2: an item's proof form and views from its edits (proof none clears the views, as roadmap.mjs folds it)
const itemLook = it => {
  let proof = null, views = [];
  for (const h of it.history) if (h.ev === 'edit') { if ('views' in h.data) views = h.data.views || []; if ('proof' in h.data) { proof = h.data.proof ?? null; if (!proof) views = []; } }
  return { proof, views };
};
const itemProof = it => itemLook(it).proof, itemViews = it => itemLook(it).views;
export const MAIL_BODY_MAX = 2048;   // bytes (UTF-8); a longer message goes in a body_file
// RM-46 S1a: RUN-n / RUN-<home>-n, lane:<lane> (lane:<home>/<name>), role:<r> / role:<r>@<home>
export const RUN_ID_RE = new RegExp(`^${NID('RUN')}$`);
export const MAIL_TO_RE = new RegExp(`^(${NID('RUN')}|lane:${LANE_REF}|role:(checkin|controller)(?:@[a-z][a-z0-9]{0,15})?)$`);
export const MAIL_VIA = ['hook', 'mcp', 'cli', 'chat'];   // chat: META-CONTROLLER C4, the NEWS block of the controller chat
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'P4'];   // Gas Town's 0-4 (bd create); P2 = the default
export const EPIC_MEMBER_RE = new RegExp(`^(?:${NID('RUN')}|${NID('DLV')})$`);
const normRepo = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const CREATE_EV = { run: 'start' };
const createEv = kind => CREATE_EV[kind] || 'create';

/** a --kind value: a kind name, or its record prefix (DIR = directive, as in DIR-7); unknown values come back as given */
export const kindNamed = k => Object.keys(KINDS).find(n => KINDS[n].prefix.replace(/[-:]$/, '') === k) ?? k;
export const kindOfId = id => {
  if (typeof id !== 'string') return null;
  if (id.startsWith('L:')) return 'lane';
  // META-GTP-FED piece 3: a node state dir names its records <PREFIX><node id>-n (RUN-wsl-3)
  for (const [k, d] of Object.entries(KINDS)) if (k !== 'lane' && new RegExp('^' + d.prefix + '(?:[a-z][a-z0-9]{0,15}-)?\\d+$').test(id)) return k;
  return null;
};
export const idNum = id => Number(String(id).match(/-(\d+)$/)?.[1]);   // F8: the trailing number (a home id may hold digits: Q-b2-12)
const idHome = id => String(id).match(/^[A-Z]+-([a-z][a-z0-9]{0,15})-\d+$/)?.[1] ?? null;

export const recordsFile = (stateDir, kind = 'question') => path.join(stateDir, (KINDS[kind]?.file || 'records') + '.jsonl');

const idFile = (stateDir, file, re) => {
  let j;
  try { j = JSON.parse(readText(path.join(stateDir, file))); } catch { return null; }   // snapshot-aware (recordAsync primes it)
  return typeof j?.id === 'string' && re.test(j.id) ? j : null;
};
// RM-46 S1a: <state>/home.json { id, bare_home } = a synced project's state dir (the cut writes it): new ids <P><id>-n, lanes
// L:<id>/<name>, branches norn/<id>/... No home.json = a solo dir: everything as before (a setting, not a fallback).
export function homeOf(stateDir) {
  const j = idFile(stateDir, 'home.json', /^[a-z][a-z0-9]{0,7}$/);
  return j ? { id: j.id, bare_home: typeof j.bare_home === 'string' ? j.bare_home : null } : null;
}
// The prefix of a state dir's new ids: its home id, else (META-GTP-FED piece 3) the id of <state>/node.json { id }, a fed node's
// own state dir (norn node run writes it), else none
export const idPrefix = stateDir => homeOf(stateDir)?.id ?? idFile(stateDir, 'node.json', /^[a-z][a-z0-9]{0,15}$/)?.id ?? null;
// A lane as typed (x = this home's lane, b/x = home b's) -> its id / mail address; In = the home id given (saves the read in a loop)
const laneRef = (name, h) => (h && !String(name).includes('/') ? `${h}/${name}` : String(name));
export const laneIdIn = (name, h) => 'L:' + laneRef(name, h);
export const laneId = (name, stateDir) => laneIdIn(name, homeOf(stateDir)?.id);
export const laneAddrIn = (name, h) => 'lane:' + laneRef(name, h);
/** a lane id -> the name as typed in this state dir (this home's lanes bare, another home's b/x) */
export const laneNameIn = (id, h) => { const n = String(id).replace(/^L:/, ''); return h && n.startsWith(h + '/') ? n.slice(h.length + 1) : n; };
export const laneName = (id, stateDir) => laneNameIn(id, homeOf(stateDir)?.id);
// a role's mail address: role:checkin, or role:checkin@a in a home
export const roleAddrIn = (role, h) => `role:${role}${h ? '@' + h : ''}`;
export const roleAddr = (role, stateDir) => roleAddrIn(role, homeOf(stateDir)?.id);
// The next number of a kind: a home counts its own prefix (the bare home also its bare ids), so RM-47 and RM-a-47 never both
// exist; a solo dir or a fed node: 1 + the max over every id of the kind, as before
function nextNum(st, kind, home) {
  if (!home) return (st.next[kind] || 0) + 1;
  let n = 0;
  for (const i of Object.values(st.items)) if (i.kind === kind) { const h = idHome(i.id); if (h === home.id || (h === null && home.bare_home === home.id)) n = Math.max(n, idNum(i.id) || 0); }
  return n + 1;
}

// ---------- read ----------
export function readEvents(file) {   // META-DASH-ASYNC R1: snapshot-aware (lib/fsnap.mjs): a lookup inside a primed dash request
  const raw = readText(file);
  return raw === null ? [] : parseEvents(file, raw);
}
/** the jsonl text of one records file -> its events (pure; the sync and the async reader share it) */
export function parseEvents(file, raw) {
  if (raw === '') return [];
  if (!raw.endsWith('\n')) throw new RecordError(`${file}: torn last line (no newline) - integrity error`, 1);
  return raw.slice(0, -1).split('\n').map((l, i) => {
    try { return JSON.parse(l); } catch { throw new RecordError(`${file}: line ${i + 1} is not JSON - integrity error`, 1); }
  });
}
/** META-DASH-ASYNC R1: readEvents on fs.promises (the dash server's request paths never block the event loop on a records read) */
export async function readEventsAsync(file) {
  const raw = await readTextA(file);   // lands in the request snapshot: a readEvents of the same file is a lookup
  return raw === null ? [] : parseEvents(file, raw);
}

// ---------- fold (pure) ----------
// kinds: the state machines to fold by (crew.mjs folds its own store's dwarf events with this fold)
export function fold(events, kinds = KINDS) {
  const acc = { seq: 0, next: {}, items: {} };
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) { acc.seq = Math.max(acc.seq, e.seq); applyEv(acc, e, kinds); }
  return acc;
}
// one event onto { next, items } (fold's step; foldHomes applies the same step, so one stream folds exactly as fold() does)
function applyEv({ items, next }, e, kinds = KINDS) {
  const def = kinds[e.kind]?.events[e.ev];
  if (!def) return;
  const h = { seq: e.seq, ts: e.ts, ev: e.ev, by: e.by, run: e.run ?? null, ...(e.via ? { via: e.via } : {}), ...(e.from_home ? { from_home: e.from_home } : {}), data: e.data ?? {} };
  if (def.from === null) {
    items[e.id] = { id: e.id, kind: e.kind, state: def.to, by: e.by, run: e.run ?? null, created: e.ts, updated: e.ts, data: e.data ?? {}, history: [h] };
    if (e.kind !== 'lane' && kinds[e.kind].prefix) next[e.kind] = Math.max(next[e.kind] || 0, idNum(e.id));   // a dwarf's id is its name: no counter
    return;
  }
  const it = items[e.id];
  if (!it) return;
  const to = typeof def.to === 'function' ? def.to(e.data ?? {}) : def.to;
  if (to) it.state = to;
  it.updated = e.ts;
  it[e.ev] = e.data ?? {};
  // INBOX-REPLIES: a reply that revises the options replaces the list (the create event keeps the first one; the thread shows each)
  if (e.kind === 'question' && e.ev === 'reply' && Array.isArray(e.data?.options)) {
    const keys = e.data.options.map(o => o.key), r = e.data.recommend ?? (keys.includes(it.data.recommend?.key) ? it.data.recommend : undefined);
    it.data = { ...Object.fromEntries(Object.entries(it.data).filter(([k]) => k !== 'recommend')), options: e.data.options, ...(r ? { recommend: r } : {}) };
  } else if (e.kind === 'question' && e.ev === 'reply' && e.data?.recommend) it.data = { ...it.data, recommend: e.data.recommend };
  if (e.ev === 'supersede' && e.data?.by) it.superseded_by = e.data.by;
  if (e.ev === 'rewire' && Array.isArray(e.data?.after)) it.data = { ...it.data, after: e.data.after };   // META-AUTONOMY R1
  it.history.push(h);
}

// ---------- the merged fold of the homes (RM-46 S1d, multi-home SPEC 3.7) ----------
// SPEC 3.3 as data: the kinds every home sees (its log is published on home/<id>); the others stay on their machine
export const SHARED_KINDS = ['question', 'decision', 'directive', 'lane', 'item', 'mail', 'waiver'];
const HOME_RE = /^[a-z][a-z0-9]{0,7}$/;
const homePart = s => String(s).match(/^([a-z][a-z0-9]{0,15})\//)?.[1] ?? null;
/** the home an id names: <P><h>-n, L:<h>/x; a bare legacy id belongs to bare_home */
export const homeOfId = (id, bare) => (String(id).startsWith('L:') ? homePart(String(id).slice(2)) : idHome(id)) ?? bare;
const homeOfAddr = (to, bare) => /^lane:/.test(to) ? homePart(to.slice(5)) ?? bare : /^role:/.test(to) ? String(to).match(/@([a-z][a-z0-9]{0,15})$/)?.[1] ?? bare : homeOfId(to, bare);
/** SPEC 3.4: the home whose log commits a record's transitions - a mail's addressee, else the home its id names */
export const primaryOf = (it, bare) => (it.kind === 'mail' ? homeOfAddr(it.data?.to ?? '', bare) : homeOfId(it.id, bare));
export const foldKey = (e, h) => [Date.parse(e.ts) || 0, h, e.seq];
export const keyBefore = (a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || a[2] - b[2];
/**
 * foldHomes(streams [{ home, events, relay? (the refusals in that home's relay.jsonl for this log) }], { bare_home, own }) -> { seq (own),
 * next (own prefix only), items (committed), pending { id: [ev + home] }, conflicts, integrity, events (committed, in fold order),
 * relayed ['home:seq'], newest { home: ms } }. Merge order (Date.parse(ts), home, seq), never reordered within a stream: every home
 * that folds the same streams gets the same view. A create counts only from the home its id names; a transition only from the
 * record's primary (else it is pending until the primary relays it, or refuses it: a conflict).
 */
export function foldHomes(streams, { bare_home = null, own = streams[0]?.home ?? null } = {}) {
  const S = streams.map(s => ({ home: s.home, evs: [...s.events].sort((a, b) => a.seq - b.seq), i: 0 }));
  const acc = { seq: 0, next: {}, items: {} }, pending = {}, conflicts = [], integrity = [], events = [], relayed = new Set(), newest = {};
  for (;;) {
    let s = null;
    for (const x of S) if (x.i < x.evs.length && (!s || keyBefore(foldKey(x.evs[x.i], x.home), foldKey(s.evs[s.i], s.home)) < 0)) s = x;
    if (!s) break;
    const e = s.evs[s.i++], h = s.home;
    if (h === own) acc.seq = Math.max(acc.seq, e.seq);
    newest[h] = Math.max(newest[h] ?? 0, Date.parse(e.ts) || 0);
    const def = KINDS[e.kind]?.events[e.ev];
    if (!def) continue;
    if (def.from === null) {
      const w = homeOfId(e.id, bare_home);
      if (w !== h) { conflicts.push({ kind: 'foreign create', home: h, seq: e.seq, id: e.id, ev: e.ev, ts: e.ts, why: `${e.id} belongs to home ${w}: home ${h} may not create it` }); continue; }
    } else {
      const it = acc.items[e.id];
      if (!it) continue;   // as fold(): a transition on no record
      if (primaryOf(it, bare_home) !== h) { (pending[e.id] ||= []).push({ ...e, home: h }); continue; }
      if (!def.from.includes(it.state)) { integrity.push({ home: h, seq: e.seq, id: e.id, why: `${e.id} is ${it.state}; ${e.ev} needs ${def.from.join(' | ')} (skipped)` }); continue; }
      if (e.from_home) relayed.add(`${e.from_home.home}:${e.from_home.seq}`);
    }
    applyEv(acc, e);
    events.push(e);
  }
  for (const [id, evs] of Object.entries(pending)) {
    const p = primaryOf(acc.items[id], bare_home), refused = new Map((streams.find(x => x.home === p)?.relay || []).map(r => [`${r.home}:${r.seq}`, r]));
    const keep = evs.filter(e => {
      const k = `${e.home}:${e.seq}`, r = refused.get(k);
      if (relayed.has(k)) return false;
      if (r) conflicts.push({ kind: 'refused', home: e.home, seq: e.seq, id, ev: e.ev, ts: r.ts, primary: p, why: `your ${e.ev} on ${id} was not applied on home ${p}: ${r.why}` });
      return !r;
    });
    if (keep.length) pending[id] = keep; else delete pending[id];
  }
  const next = {};
  for (const it of Object.values(acc.items)) if (it.kind !== 'lane' && homeOfId(it.id, bare_home) === own) next[it.kind] = Math.max(next[it.kind] || 0, idNum(it.id));
  return { seq: acc.seq, next, items: acc.items, pending, conflicts, integrity, events, relayed: [...relayed], newest };
}
// relay.jsonl rows { home, seq, file, id, ev, why, ts } of one log; a line that does not parse is skipped (the file is a home's own)
const relayRows = (f, file) => (readText(f) ?? '').split('\n').flatMap(l => { try { const r = JSON.parse(l); return r?.file === file ? [r] : []; } catch { return []; } });
/** one shared log's streams in a synced dir: the own file first, then each <state>/homes/<h>/ copy (ASCII order); a copy that does
 * not parse is skipped with an integrity row, and so is what the fetch noted (<state>/sync/copy-integrity.json: a copy that was not an append) */
export function homeStreams(stateDir, home, file) {
  const streams = [{ home: home.id, events: readEvents(path.join(stateDir, file + '.jsonl')), relay: relayRows(path.join(stateDir, 'relay.jsonl'), file) }], integrity = [];
  for (const h of readdirS(path.join(stateDir, 'homes')).filter(d => d.isDirectory() && HOME_RE.test(d.name) && d.name !== home.id).map(d => d.name).sort()) {
    const dir = path.join(stateDir, 'homes', h);
    try { streams.push({ home: h, events: readEvents(path.join(dir, file + '.jsonl')), relay: relayRows(path.join(dir, 'relay.jsonl'), file) }); }
    catch (e) { integrity.push({ home: h, file, why: `the copy from home ${h} is skipped: ${e.message}` }); }
  }
  const noted = readJsonS(path.join(stateDir, 'sync', 'copy-integrity.json'));
  for (const r of Array.isArray(noted) ? noted : []) if (r?.file === file + '.jsonl') integrity.push({ home: r.home, file, why: r.why });
  return { streams, integrity };
}
/** a shared kind's log folded: in a synced dir (home.json) the fold of the own log + the copies, else fold() of the file */
export function loadShared(stateDir, kind) {
  const home = homeOf(stateDir);
  if (!home) return fold(readEvents(recordsFile(stateDir, kind)));
  const { streams, integrity } = homeStreams(stateDir, home, KINDS[kind].file), v = foldHomes(streams, { bare_home: home.bare_home, own: home.id });
  return { ...v, integrity: [...integrity, ...v.integrity] };
}

// RM-46 S3 (SPEC 3.3): the read-only copies of the other homes' local kinds that publish one (run, deliverable) - homes/<h>/copy/<file>.jsonl,
// each folded alone (its home is its only writer). An item carries `home` and its lane as this home types it (b/x); a copy that does not parse is skipped.
const otherHomes = (stateDir, home) => readdirS(path.join(stateDir, 'homes')).filter(d => d.isDirectory() && HOME_RE.test(d.name) && d.name !== home.id).map(d => d.name).sort();
export const copyFile = (stateDir, h, kind) => path.join(stateDir, 'homes', h, 'copy', KINDS[kind].file + '.jsonl');
/** [item + home] of `kind` from every other home's copy; a solo dir has none */
export function copyItems(stateDir, kind) {
  const home = homeOf(stateDir), out = [];
  if (!home) return out;
  for (const h of otherHomes(stateDir, home)) {
    let f; try { f = fold(readEvents(copyFile(stateDir, h, kind))); } catch { continue; }
    for (const it of Object.values(f.items)) if (it.kind === kind) out.push({ ...it, home: h, data: { ...it.data, ...(typeof it.data?.lane === 'string' ? { lane: laneNameIn(laneIdIn(it.data.lane, h), home.id) } : {}) } });
  }
  return out;
}
/** copyItems on fs.promises: the copies primed into the request snapshot first (the dash server's GETs) */
export async function copyItemsAsync(stateDir, kind) {
  if (await readTextA(path.join(stateDir, 'home.json')) === null) return [];
  const hs = (await readdirA(path.join(stateDir, 'homes'))).filter(d => d.isDirectory() && HOME_RE.test(d.name)).map(d => d.name);
  await prime({ files: hs.map(h => copyFile(stateDir, h, kind)) });
  return copyItems(stateDir, kind);
}

// a synced dir's view carries its pending events, conflicts and integrity rows (SPEC 3.7)
const joinFolds = (a, b) => ({ seq: a.seq, runs_seq: b.seq, next: { ...a.next, ...b.next }, items: { ...a.items, ...b.items },
  ...(a.pending ? { pending: a.pending, conflicts: a.conflicts, integrity: a.integrity, newest: a.newest } : {}) });
// META-DASH-ASYNC R1: inside a primed dash request the snapshot's fold (lib/fsnap.mjs) - a lib that folds again (limitgate, ...) reads nothing
export const loadState = stateDir => snap.getStore()?.folds.get(stateDir) ?? joinFolds(loadShared(stateDir, 'question'), fold(readEvents(recordsFile(stateDir, 'run'))));
/** META-DASH-ASYNC R1: loadState on fs.promises (the two records files read concurrently on the threadpool; the same fold) */
export async function loadStateAsync(stateDir) {
  if (await readTextA(path.join(stateDir, 'home.json')) !== null && homeOf(stateDir)) {   // a synced dir: the copies primed, then the merged fold
    const hs = (await readdirA(path.join(stateDir, 'homes'))).filter(d => d.isDirectory()).map(d => path.join(stateDir, 'homes', d.name));
    await prime({ files: [recordsFile(stateDir, 'question'), recordsFile(stateDir, 'run'), path.join(stateDir, 'relay.jsonl'), path.join(stateDir, 'sync', 'copy-integrity.json'),
      ...hs.flatMap(d => [path.join(d, 'records.jsonl'), path.join(d, 'relay.jsonl')])] });
    return loadState(stateDir);
  }
  const [qa, ru] = await Promise.all([readEventsAsync(recordsFile(stateDir, 'question')), readEventsAsync(recordsFile(stateDir, 'run'))]);
  return joinFolds(fold(qa), fold(ru));
}

// ---------- lock (exclusive create, retry 25 ms, stale after 10 s) ----------
const sleepMs = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function withLock(lockFile, fn, { retryMs = 25, staleMs = 10000, timeoutMs = 60000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    try {
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      let ts = null;
      try { ts = Date.parse(JSON.parse(fs.readFileSync(lockFile, 'utf8')).ts); } catch { /* being written / removed */ }
      if (ts !== null && Date.now() - ts > staleMs) { try { fs.unlinkSync(lockFile); } catch { /* someone else broke it */ } continue; }
      if (Date.now() - t0 > timeoutMs) throw new RecordError(`lock busy: ${lockFile} (held > ${timeoutMs} ms)`, 1);
      sleepMs(retryMs);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(lockFile); } catch { /* already gone */ } }
}
/** withLock on fs.promises (the dash server's writes): the same lock file, retry, stale break and timeout; the wait is a timer */
export async function withLockAsync(lockFile, fn, { retryMs = 25, staleMs = 10000, timeoutMs = 60000 } = {}) {
  const t0 = Date.now(), fp = fs.promises;
  for (;;) {
    try { await fp.writeFile(lockFile, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), { flag: 'wx' }); break; }
    catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      let ts = null;
      try { ts = Date.parse(JSON.parse(await fp.readFile(lockFile, 'utf8')).ts); } catch { /* being written / removed */ }
      if (ts !== null && Date.now() - ts > staleMs) { try { await fp.unlink(lockFile); } catch { /* someone else broke it */ } continue; }
      if (Date.now() - t0 > timeoutMs) throw new RecordError(`lock busy: ${lockFile} (held > ${timeoutMs} ms)`, 1);
      await new Promise(r => setTimeout(r, retryMs));
    }
  }
  try { return await fn(); } finally { try { await fp.unlink(lockFile); } catch { /* already gone */ } }
}

// ---------- validation ----------
const str = (v, name, { max, req = true } = {}) => {
  if (v === undefined || v === null || v === '') { if (req) fail(`${name} is required`); return; }
  if (typeof v !== 'string') fail(`${name} must be a string`);
  if (max && v.length > max) fail(`${name} is ${v.length} chars (max ${max})`);
};
const list = (v, name, { req = false } = {}) => {
  if (v === undefined) { if (req) fail(`${name} is required`); return; }
  if (!Array.isArray(v)) fail(`${name} must be a list`);
  if (req && !v.length) fail(`${name} needs at least one entry`);
};
const oneOf = (v, name, allowed, req = true) => {
  if (v === undefined && !req) return;
  if (!allowed.includes(v)) fail(`${name} must be one of ${allowed.join(' | ')} (got ${JSON.stringify(v)})`);
};
// `via` of an owner act: dashboard | talk | chat | cli (the owner's own terminal: norn lane new --task, META-OOTB F-1), or chat:<client> stamped by the meta MCP server from its launch args (H1).
export const VIA_CLIENT_RE = /^chat:[a-z0-9][a-z0-9._-]{0,30}$/;
const via = (v, allowed) => { if (!(typeof v === 'string' && VIA_CLIENT_RE.test(v))) oneOf(v, 'via', allowed); };
// A migrated record keeps its legacy author (S2): the importer writes as role migration, data.legacy_by names who ruled.
export const authorOf = it => (it.by === 'migration' && it.data?.legacy_by) || it.by;
const isOwnerRecord = it => it && (it.kind === 'directive' || (it.kind === 'question' && ['answered', 'applied'].includes(it.state))
  || (it.kind === 'decision' && OWNER.includes(authorOf(it))));

function validateData(kind, ev, d, target, st, by, home = null) {
  if (kind === 'waiver') {
    if (ev === 'create') {
      str(d.rule, 'rule'); if (!/^[A-Z]+\d+$/.test(d.rule)) fail('rule must be a slop rule id (K2, T1, ...)');
      str(d.scope, 'scope', { max: 300 }); str(d.why, 'why', { max: 600 }); str(d.until, 'until', { req: false }); str(d.q, 'q', { req: false });
      if (d.until !== undefined && !Number.isFinite(Date.parse(d.until))) fail(`until must be an ISO time (got ${JSON.stringify(d.until)})`);
    }
    return;
  }
  if (kind === 'guard') {
    if (ev === 'create') { str(d.run, 'run'); if (!/^RUN-/.test(d.run)) fail('run must be RUN-n'); oneOf(d.cls, 'cls', ['runaway', 'over-handoff', 'tool-spam']); str(d.why, 'why'); }
    if (ev === 'rule') { oneOf(d.action, 'action', ['let-run', 'mail', 'stop']); str(d.why, 'why'); }
    return;
  }
  if (kind === 'confirm') { str(d.file, 'file'); str(d.anchor, 'anchor'); if (!/^p[0-9a-f]{8}$/.test(d.anchor)) fail('anchor must be p<8 hex> (meta instructions suggest / the tab name it)'); str(d.why, 'why', { req: false }); }
  if (kind === 'question') {
    // an option: { key, text, cost?, added_by? } - added_by = the writer that added it to a question built from a source (origin)
    const opts = (v, name) => {
      list(v, name);
      for (const o of v || []) { if (!o || typeof o.key !== 'string' || !o.key) fail('option key is required'); str(o.text, 'option text'); str(o.added_by, 'option added_by', { req: false, max: 60 }); }
      if (new Set((v || []).map(o => o.key)).size !== (v || []).length) fail(`${name}: each option key once`);
    };
    const rec = (r, keys) => {
      if (r === undefined) return;
      if (typeof r?.key !== 'string' || !keys.includes(r.key)) fail('recommend.key must be one of the option keys');
      str(r.from, 'recommend.from', { req: false, max: 60 });   // whose recommendation: source (the plan's default) | the writer
    };
    if (ev === 'create') {
      str(d.title, 'title', { max: 120 }); str(d.lane, 'lane'); str(d.body, 'body', { req: false });
      opts(d.options, 'options'); rec(d.recommend, (d.options || []).map(o => o.key));
      oneOf(d.class, 'class', ['i', 'ii', 'iii', 'iv', 'v'], false); list(d.blocks, 'blocks');
      if (d.owner_only !== undefined && typeof d.owner_only !== 'boolean') fail('owner_only must be true or false');   // NORN-WATCH S3
      if (d.origin !== undefined) {   // INBOX-REPLIES: the plan / notes / brief section the options were copied from
        if (!d.origin || typeof d.origin !== 'object') fail('origin must be { file, section, line? }');
        str(d.origin.file, 'origin.file', { max: 400 }); str(d.origin.section, 'origin.section', { max: 200 });
        if (d.origin.line !== undefined && !(Number.isInteger(d.origin.line) && d.origin.line > 0)) fail('origin.line must be a line number');
      }
    }
    if (ev === 'say') { str(d.text, 'text', { max: 4000 }); via(d.via, ['dashboard', 'chat']); }
    if (ev === 'reply') {
      str(d.text, 'text', { max: 4000 });
      if (d.options !== undefined) { opts(d.options, 'options'); if (!d.options.length) fail('options: a revision keeps at least one option'); }
      const keys = (d.options ?? target.data.options ?? []).map(o => o.key);
      rec(d.recommend, keys);
      if (d.propose !== undefined) {
        str(d.propose?.text, 'propose.text', { max: 600 });
        if (d.propose.key !== undefined && !keys.includes(d.propose.key)) fail(`propose.key must be one of ${keys.join(' | ') || '(no options)'}`);
      }
    }
    if (ev === 'answer') {
      str(d.text, 'text'); via(d.via, ['dashboard', 'chat']); str(d.mapped_from, 'mapped_from', { req: false });
      if (d.ruling !== undefined) {   // INBOX-REPLIES: the owner's one tap on a proposed ruling (the reply's seq)
        const r = target.history.find(h => h.seq === d.ruling && h.ev === 'reply' && h.data.propose);
        if (!r) fail(`ruling ${d.ruling} is not a proposed ruling in ${target.id}'s thread`);
        if ((r.data.propose.key ?? undefined) !== (d.choice || undefined)) fail(`ruling ${d.ruling} proposes ${r.data.propose.key ?? 'no option'}: the answer carries the same choice`);
      }
      if (d.from !== undefined) {   // META-Q-RECONCILE R1: the owner's words taken from a decision on the Q's lane
        const dec = st.items[d.from];
        if (!dec || dec.kind !== 'decision') fail(`from ${d.from} is not a decision`);
        if (dec.data.lane !== target.data.lane) fail(`${d.from} is on lane ${dec.data.lane}, ${target.id} on lane ${target.data.lane}: not its answer`);
      }
      const keys = (target.data.options || []).map(o => o.key);
      if (d.choice !== undefined && d.choice !== '' && keys.length && !keys.includes(d.choice)) fail(`choice must be one of ${keys.join(' | ')}`);
    }
    if (ev === 'apply') list(d.refs, 'refs', { req: true });
    if (ev === 'supersede') {
      str(d.by, 'by'); str(d.why, 'why');
      const c = st.items[d.by];
      if (!c) fail(`supersede cites ${d.by}, which does not exist`);
      const newerQ = c.kind === 'question' && idNum(c.id) > idNum(target.id);
      if (!isOwnerRecord(c) && !newerQ) fail(`a question is superseded only by an owner record (DIR / answered Q / owner DEC) or a newer Q; ${d.by} is neither`);
    }
  }
  if (kind === 'decision') {
    if (ev === 'create') {
      str(d.lane, 'lane'); str(d.question, 'question'); str(d.choice, 'choice'); str(d.why, 'why');
      if (d.answers !== undefined && kindOfId(d.answers) !== 'question') fail('answers must be a Q-n id');
      list(d.on_runs, 'on_runs');
      str(d.owner_words, 'owner_words', { req: false, max: 4000 });   // META-Q-RECONCILE R1
      if (d.not_an_answer !== undefined && d.not_an_answer !== true) fail('not_an_answer must be true');
      if (d.not_an_answer && d.answers) fail('--answers and --not-an-answer exclude each other');
      if (d.approach_review !== undefined && !/^RM-\S+$/.test(d.approach_review)) fail('approach_review must name a roadmap item (RM-n)');   // META-CATCH S1 (stuck.mjs)
    }
    if (ev === 'notanswer') {
      if (kindOfId(d.q) !== 'question' || st.items[d.q]?.kind !== 'question') fail(`q must name an existing Q-n (got ${JSON.stringify(d.q)})`);
      str(d.why, 'why', { req: false, max: 600 });
    }
    if (ev === 'overrule') str(d.text, 'text');
    if (ev === 'supersede') {
      str(d.by, 'by'); str(d.why, 'why');
      const c = st.items[d.by];
      if (!c) fail(`supersede cites ${d.by}, which does not exist`);
      if (OWNER.includes(authorOf(target))) { if (!isOwnerRecord(c)) fail(`${target.id} is an owner decision: only an owner record may supersede it (rule iv)`); }
      else if (!(c.kind === 'decision' && idNum(c.id) > idNum(target.id))) fail(`a decision is superseded only by a newer DEC; ${d.by} is not`);
    }
  }
  if (kind === 'directive') {
    if (ev === 'create') {
      str(d.text, 'text'); via(d.via, ['dashboard', 'talk', 'chat', 'cli']); list(d.scope, 'scope'); str(d.expires_utc, 'expires_utc', { req: false });
      list(d.distinct_from, 'distinct_from');   // gap #5: the active DIRs this one was created next to on purpose (--new): no duplicate row
    }
    if (ev === 'done') list(d.refs, 'refs', { req: true });
    if (ev === 'supersede') {
      str(d.why, 'why');
      if (OWNER.includes(by) && d.by === undefined) return;
      str(d.by, 'by');
      const c = st.items[d.by];
      if (!c) fail(`supersede cites ${d.by}, which does not exist`);
      const ok = (c.kind === 'directive' && idNum(c.id) > idNum(target.id)) || (c.kind === 'question' && ['answered', 'applied'].includes(c.state));
      if (!OWNER.includes(by) && !ok) fail(`a directive is superseded only citing a newer owner DIR or an owner answer; ${d.by} is neither`);
    }
  }
  if (kind === 'lane') {
    if (ev === 'create' && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(d.name || '')) fail('lane name is required ([A-Za-z0-9_.-])');
    if (ev === 'park') str(d.why, 'why');
    if (ev === 'claim') {
      str(d.until, 'until');
      if (!Number.isFinite(Date.parse(d.until))) fail(`until must be an ISO time (got ${JSON.stringify(d.until)})`);
      str(d.holder, 'holder', { req: false }); str(d.why, 'why', { req: false, max: 300 });
    }
    if (ev === 'release') str(d.why, 'why', { req: false, max: 300 });
  }
  if (kind === 'deliverable') {
    if (ev === 'create') {
      str(d.repo, 'repo'); str(d.branch, 'branch', { max: 200 }); str(d.delivers, 'delivers', { max: 300, req: false });
      oneOf(d.target, 'target', ['main', 'install'], false);
      for (const k of ['lane', 'run', 'tip', 'done_utc', 'main', 'source']) str(d[k], k, { req: false });
      const dup = Object.values(st.items).find(i => i.kind === 'deliverable' && normRepo(i.data.repo) === normRepo(d.repo) && i.data.branch === d.branch);
      if (dup) fail(`${d.repo} ${d.branch} already has ${dup.id}`);
    }
    if (ev === 'done') for (const k of ['run', 'tip', 'done_utc']) str(d[k], k, { req: false });
    if (ev === 'merged') { oneOf(d.how, 'how', ['pr', 'git', 'equivalent', 'ruling']); for (const k of ['tip', 'url', 'merge_commit', 'merged_at', 'why', 'q']) str(d[k], k, { req: false, max: 600 }); }
    if (ev === 'still_open') for (const k of ['why', 'q']) str(d[k], k, { req: false, max: 600 });
    if (ev === 'park') { str(d.why, 'why', { max: 600 }); str(d.q, 'q', { req: false }); }
    if (ev === 'supersede') {
      str(d.why, 'why', { max: 600 }); str(d.by, 'by');
      if (new RegExp(`^${NID('DLV')}$`).test(d.by)) {
        if (d.by === target.id) fail(`${target.id} cannot supersede itself`);
        if (!st.items[d.by]) fail(`supersede cites ${d.by}, which does not exist`);
      } else if (!/^[0-9a-f]{7,40}$/.test(d.by)) fail(`supersede --by must be a DLV-n or a commit sha (7-40 hex), got ${JSON.stringify(d.by)}`);
    }
  }
  if (kind === 'epic') {
    const members = m => { list(m, 'members'); for (const x of m || []) if (!EPIC_MEMBER_RE.test(x)) fail(`members: ${JSON.stringify(x)} is not a RUN-n / DLV-n id`); };
    if (ev === 'create') { str(d.title, 'title', { max: 200 }); oneOf(d.priority, 'priority', PRIORITIES); members(d.members); str(d.integration_branch, 'integration_branch', { max: 200, req: false }); }
    if (ev === 'add' || ev === 'remove') { members(d.members); if (!d.members?.length) fail('members: at least one id'); }
    if (ev === 'close') str(d.why, 'why', { req: false });
  }
  if (kind === 'mail') {
    if (ev === 'create') {
      str(d.subject, 'subject', { max: 120 }); str(d.from, 'from'); str(d.to, 'to');
      if (!MAIL_TO_RE.test(d.to)) fail(`to must be RUN-n | lane:<name> | role:checkin | role:controller, each with an optional home (RUN-b-n, lane:b/x, role:checkin@b) (got ${JSON.stringify(d.to)})`);
      if ((d.body === undefined) === (d.body_file === undefined)) fail('give exactly one of body (<= 2 KB) or body_file');
      if (d.body !== undefined) {
        str(d.body, 'body');
        const n = Buffer.byteLength(d.body, 'utf8');
        if (n > MAIL_BODY_MAX) fail(`body is ${n} bytes: at most 2 KB (${MAIL_BODY_MAX}) - put a longer message in a body_file`);
      } else str(d.body_file, 'body_file', { max: 400 });
      if (d.urgent !== undefined && typeof d.urgent !== 'boolean') fail('urgent must be true or false');
      if (by !== 'worker' && by !== 'migration' && d.from !== roleAddrIn(by, home?.id)) fail(`from must be ${roleAddrIn(by, home?.id)} (a ${by} sends as itself)`);
    }
    if (ev === 'deliver') { str(d.run, 'run', { req: false }); oneOf(d.via, 'via', MAIL_VIA); }   // no run = the controller's session (role:controller)
    if (ev === 'nudge') { if (target.nudge) fail(`${target.id} is already nudged (${target.nudge.run})`); str(d.run, 'run'); }
  }
  if (kind === 'item') validateItem(ev, d, target, st, by);
  if (kind === 'proposal') validateProposal(ev, d, target, st);
  if (kind === 'run') {
    if (ev === 'start' || ev === 'queue') { oneOf(d.priority, 'priority', PRIORITIES, false); if (d.epic !== undefined && !new RegExp(`^${NID('EP')}$`).test(d.epic)) fail('epic must be an EP-n id'); }
    if (ev === 'start' || ev === 'queue') oneOf(d.kind, 'kind', ['worker', 'codex', 'cli', 'checkin', 'talk', 'interactive', 'fake', 'provider', 'audit']);
    if ((ev === 'start' || ev === 'queue') && d.after !== undefined && !(Array.isArray(d.after) && d.after.every(c => c && ['kind', 'id', 'state'].every(k => typeof c[k] === 'string'))))
      fail('after must be a list of {kind, id, state}');
    if ((ev === 'start' || ev === 'queue') && d.inputs !== undefined) list(d.inputs, 'inputs');
    if ((ev === 'start' || ev === 'queue') && d.labels !== undefined && !validLabels(d.labels)) fail('labels must be a list of [a-z0-9._-] labels');   // META-GTP-FED
    // META-GTP-FLOW piece 2: the flow step a run is (norn flow start / resume): { name, step, vars: { k: string } }
    if ((ev === 'start' || ev === 'queue') && d.flow !== undefined && !(d.flow && typeof d.flow.name === 'string' && typeof d.flow.step === 'string'
      && d.flow.vars && typeof d.flow.vars === 'object' && Object.values(d.flow.vars).every(v => typeof v === 'string'))) fail('flow must be { name, step, vars: { k: string } }');
    if (ev === 'end') { oneOf(d.outcome, 'outcome', ['done', 'stopped', 'handoff', 'no-result', 'crash', 'limit', 'auth', 'nudged', ...(target?.data?.kind === 'interactive' ? ['ended'] : []),...(by === 'migration' ? ['legacy'] : [])]); if (d.exit !== null && !Number.isInteger(d.exit)) fail('exit must be an integer or null'); }
    if (ev === 'review') list(d.refs, 'refs');
    if (ev === 'resume' && !d.next === !d.refused) fail('resume needs exactly one of next / refused');
    if (ev === 'fill') str(d.next, 'next');
    if (ev === 'claim') str(d.node, 'node');
    if (ev === 'release') str(d.why, 'why');
    if (ev === 'withdraw' && by === 'checkin') str(d.why, 'why');   // META-AUTONOMY R1: a check-in withdraw names its ruling
    if (ev === 'rewire') { str(d.why, 'why'); if (!(Array.isArray(d.after) && d.after.every(c => c && ['kind', 'id', 'state'].every(k => typeof c[k] === 'string')))) fail('after must be a list of {kind, id, state}'); }
    if (ev === 'hold' && !d.cleared) str(d.why, 'why');
    if (ev === 'landed') { str(d.why, 'why'); str(d.sha, 'sha', { req: false }); }
    if (ev === 'resume' && target.resume) fail(`${target.id} already has a resume verdict`);
  }
}

// META-ROADMAP S1 (SPEC sec. 1): roadmap structure rules. Status / phase are derived, never typed; a link is a kind:id term; a theme
// sits at the root, an item under an open theme or item (never under itself); `after` names a sibling (null = first).
function validateItem(ev, d, target, st, by) {
  for (const k of ['status', 'phase', 'progress']) if (k in d) fail(`${k} is derived from the item's links, never typed (SPEC sec. 2)`);
  const links = v => { list(v, 'links'); for (const x of v || []) if (typeof x !== 'string' || !ITEM_LINK_RE.test(x)) fail(`link ${JSON.stringify(x)}: want dir: | dec: | q: | lane: | run: | dlv: | ep: | branch: | sha: | doc: <id>`); };
  const node = (id, name) => {
    const it = st.items[id];
    if (!it || it.kind !== 'item') fail(`${name} ${id} does not exist`);
    if (it.state !== 'open') fail(`${name} ${id} is ${it.state}`);
    return it;
  };
  const place = (kind, parent, after, self) => {
    if (kind === 'theme') { if (parent !== null && parent !== undefined) fail('a theme sits at the root: no parent'); }
    else {
      if (!parent) fail('an item needs a parent (a theme or an item)');
      node(parent, 'parent');
      for (let p = parent, n = 0; p && n < 1000; p = itemParent(st.items[p] || { history: [], data: {} }), n++) if (p === self) fail(`${self} cannot move under itself`);
    }
    if (after !== undefined && after !== null) {
      node(after, 'after');
      if (after === self || (itemParent(st.items[after]) ?? null) !== (parent ?? null)) fail(`after ${after} is not a sibling under ${parent ?? 'the root'}`);
    }
  };
  if (ev === 'create') {
    str(d.title, 'title', { max: 200 }); oneOf(d.kind, 'kind', ['theme', 'item']);
    if (d.horizon !== undefined && d.horizon !== null) oneOf(d.horizon, 'horizon', HORIZONS);
    str(d.note, 'note', { max: 4000, req: false }); links(d.links); list(d.stages, 'stages');
    for (const x of d.stages || []) str(x, 'stage', { max: 120 });
    if (d.legacy !== undefined && by !== 'migration') fail('legacy is written only by the migration');
    place(d.kind, d.parent, d.after, null);
  }
  if (ev === 'edit') {
    if (!['title', 'note', 'horizon', 'stages', 'caveat', 'proof', 'views'].some(k => k in d)) fail('edit needs one of title, note, horizon, stages, caveat, proof, views');
    if ('title' in d) str(d.title, 'title', { max: 200 });
    if ('note' in d) str(d.note, 'note', { max: 4000, req: false });
    if ('horizon' in d && d.horizon !== null) oneOf(d.horizon, 'horizon', HORIZONS);
    if ('stages' in d) { list(d.stages, 'stages'); for (const x of d.stages || []) str(x, 'stage', { max: 120 }); }
    if ('caveat' in d && d.caveat !== null) str(d.caveat, 'caveat', { max: 300 });
    // META-CATCH S2: the proof form (look | null) and the views a look item is judged at; a look item names at least one view
    if ('proof' in d && d.proof !== null) oneOf(d.proof, 'proof', ['look']);
    if ('views' in d) { list(d.views, 'views'); for (const x of d.views || []) str(x, 'view', { max: 80 }); }
    const proof = 'proof' in d ? d.proof : itemProof(target), views = 'views' in d ? d.views : itemViews(target);
    if (proof === 'look' && !(views || []).length) fail('a look item names its views (--views "a,b")');
  }
  if (ev === 'verdict') {
    oneOf(d.verdict, 'verdict', ['pass', 'fail']); str(d.image, 'image', { max: 600 });
    if (itemProof(target) !== 'look') fail(`${target.id} is not a look item (norn road edit ${target.id} --proof look --views ..)`);
  }
  if (ev === 'move') {
    if (!('parent' in d) && !('after' in d)) fail('move needs a parent and / or after');
    if (d.ref !== undefined && !/^(DEC|DIR)-/.test(d.ref)) fail('ref must be a DEC-n or DIR-n (the ruling the reorder follows)');
    place(target.data.kind, 'parent' in d ? d.parent : itemParent(target), d.after, target.id);
  }
  if (ev === 'link' || ev === 'unlink') {
    links(d.links); if (!d.links?.length) fail('links: at least one');
    if (ev === 'unlink') { const cur = itemLinks(target); for (const x of d.links) if (!cur.includes(x)) fail(`${x} is not linked to ${target.id}`); }
  }
  if (ev === 'drop') { str(d.why, 'why', { max: 600 }); if (typeof d.ref !== 'string' || !/^(DEC|DIR)-/.test(d.ref)) fail('drop needs ref: the DEC-n or DIR-n that rules it'); }
  if (ev === 'reopen') str(d.why, 'why', { max: 600 });
}

// META-ADOPT A1 (SPEC sec. 4): the proposal events. decide names a part of the latest draft and the part sha that was seen.
const SHA_RE = /^[0-9a-f]{64}$/;
function validateProposal(ev, d, target, st) {
  const sha = (v, name) => { if (typeof v !== 'string' || !SHA_RE.test(v)) fail(`${name} must be a sha256 (64 hex)`); };
  if (ev === 'create') {
    const open = Object.values(st.items).find(i => i.kind === 'proposal' && i.state === 'open');
    if (open) fail(`${open.id} is open: one open proposal per project (draft it again, or close it)`);
    str(d.facts, 'facts'); sha(d.sha, 'sha'); oneOf(d.path, 'path', ['new', 'adopt']); str(d.why, 'why', { max: 600 });
  }
  if (ev === 'answer' && (!d.answers || typeof d.answers !== 'object' || Array.isArray(d.answers))) fail('answers must be an object');
  if (ev === 'draft') {
    str(d.file, 'file'); sha(d.sha, 'sha'); str(d.source, 'source'); list(d.parts, 'parts', { req: true });
    for (const p of d.parts) { str(p?.id, 'part id'); str(p.type, 'part type'); sha(p.sha, `part ${p.id} sha`); if (!Number.isInteger(p.lines)) fail(`part ${p.id} lines must be a count`); }
  }
  if (ev === 'decide') {
    const draft = [...target.history].reverse().find(h => h.ev === 'draft');
    if (!draft) fail(`${target.id} has no draft yet`);
    str(d.part, 'part');
    if (!draft.data.parts.some(p => p.id === d.part)) fail(`${target.id} has no part ${d.part} (${draft.data.parts.map(p => p.id).join(' | ')})`);
    oneOf(d.verdict, 'verdict', ['approve', 'skip']); list(d.off, 'off'); sha(d.sha, 'sha');
  }
  if (ev === 'apply') { list(d.parts, 'parts'); if (d.complete !== undefined && typeof d.complete !== 'boolean') fail('complete must be true or false'); }
  if (ev === 'close') str(d.why, 'why', { max: 600 });
}

// ---------- META-CONTROLLER C4: lane holds + first writer wins (SPEC sec. 2) ----------
export const HELD_EXIT = 5;
const holderOf = (by, via) => (via === 'chat:chat' ? 'chat' : by === 'controller' ? 'controller' : 'owner');
/** The live hold of a LANE record at `now` (ms): { id, lane, holder, until, why, by, via, ts, run } | null (none, released or expired). */
export function holdOf(lane, now = Date.now()) {
  if (!lane || lane.kind !== 'lane') return null;
  const h = [...lane.history].reverse().find(x => x.ev === 'claim' || x.ev === 'release');
  if (h?.ev !== 'claim' || !(Date.parse(h.data.until) > now)) return null;
  return { id: lane.id, lane: lane.data.name ?? lane.id.slice(2), holder: h.data.holder ?? holderOf(h.by, h.data.via), until: h.data.until, why: h.data.why ?? null, by: h.by,
    via: h.data.via ?? null, ts: h.ts, run: h.run ?? null };
}
/** every live hold among the items, by lane name */
export const heldLanes = (items, now = Date.now()) => Object.values(items).map(i => holdOf(i, now)).filter(Boolean).sort((a, b) => a.lane.localeCompare(b.lane));
export const holdWho = h => (h.holder === 'chat' ? 'the controller chat' : h.holder === 'controller' ? `the controller${h.via ? ` (${h.via})` : ''}` : h.holder === 'owner' ? 'the owner' : h.holder);
export const hhmm = t => new Date(Date.parse(t)).toISOString().slice(11, 16) + 'Z';
export const holdMessage = h => `${h.id} is held by ${holdWho(h)} until ${hhmm(h.until)}${h.why ? ` (${h.why})` : ''} - a check-in skips a held lane `
  + '(exit 5) and leaves it to the holder; to reach the holder: norn mail send --to role:controller';
// the lane an event writes on: the LANE itself, the record's lane field, or the target record's
function laneOfEvent(e, st, home) {
  if (e.kind === 'lane') return e.id ? laneNameIn(e.id, home) : e.data?.name ?? null;
  if (e.kind === 'mail' || e.kind === 'item') return null;
  return e.data?.lane ?? (e.id ? st.items[e.id]?.data?.lane : null) ?? null;
}
// first writer wins (SPEC sec. 2 item 4): a refused transition names the act that moved the record there - who, run, via, refs, when
const RULED = new Set(['question', 'decision', 'directive']);
function firstWriter(kind, target) {
  if (!RULED.has(kind)) return '';
  const h = [...target.history].reverse().find(x => KINDS[kind].events[x.ev]?.to === target.state);
  if (!h) return '';
  const d = h.data || {}, refs = d.refs?.length ? `refs ${d.refs.join(',')}` : d.from ? `from ${d.from}` : typeof d.by === 'string' ? `by ${d.by}` : '';
  return ` - first writer wins: ${target.state} by ${h.by}${d.relayed_by ? ` (relayed by ${d.relayed_by})` : ''}${h.run ? ' ' + h.run : ''}`
    + `${d.via ? ` via ${d.via}` : ''}${refs ? ` (${refs})` : ''} at ${h.ts}`;
}

// Check one event against the state; returns the full envelope (without seq / ts).
function check(st, { kind, ev, id, by, data = {} }, { pfx = null, home = null } = {}) {
  const k = KINDS[kind];
  if (!k) fail(`unknown kind ${JSON.stringify(kind)} (question | decision | directive | lane | run | mail)`);
  const def = k.events[ev];
  if (!def) fail(`unknown event ${kind} ${JSON.stringify(ev)} (${Object.keys(k.events).join(' | ')})`);
  if (!ROLES.includes(by)) fail(`unknown role ${JSON.stringify(by)} (${ROLES.join(' | ')})`);
  if (by !== 'migration' && !def.roles.includes(by)) fail(`role ${by} may not ${kind} ${ev} (allowed: ${def.roles.join(', ')})`);
  if (data === null || typeof data !== 'object' || Array.isArray(data)) fail('data must be an object');
  let target = null;
  if (def.from === null) {
    if (kind === 'lane') {
      validateData(kind, ev, data, null, st, by, home);
      id = laneIdIn(data.name, home?.id);
      if (st.items[id]) fail(`${id} already exists`);
    } else id = k.prefix + (pfx ? pfx + '-' : '') + nextNum(st, kind, home);
  } else {
    if (kindOfId(id) !== kind) fail(`${JSON.stringify(id)} is not a ${kind} id`);
    target = st.items[id];
    if (!target) fail(`${id} does not exist`);
    if (!def.from.includes(target.state)) fail(`${id} is ${target.state}; ${ev} needs ${def.from.join(' | ')}${firstWriter(kind, target)}`);
    if (kind === 'run' && ev === 'review' && target.review) fail(`${id} is already reviewed`);
  }
  if (kind !== 'lane' || def.from !== null) validateData(kind, ev, data, target, st, by, home);
  return { id, kind, ev, by, data };
}

const isoSec = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

// DELIVERABLES-SPEC 5: a lane is not archived while one of its deliverables is DONE but not merged, unless it is parked with a
// reason. Git is asked only here (a lane with an open deliverable), by the one merge rule (dlvmerge.mjs dlvMerged).
function archiveGuard(stateDir, lane, ev = {}) {
  // item 9 (MAIL-20): finished work not on main (lanepaths.mjs tickPaths: lane-paths.json) - only the owner's explicit override drops it
  const pth = (() => { try { return JSON.parse(readText(path.join(stateDir, 'lane-paths.json'))); } catch { return null; } })()?.paths?.[lane];
  if (pth && pth.state !== 'merged' && !(['owner', 'dashboard'].includes(ev.by) && String(ev.data?.override ?? '').trim())) {
    const dir = fold(readEvents(recordsFile(stateDir, 'run'))).items[pth.run]?.data?.worktree;
    if (!(pth.tip && dir && fs.existsSync(dir) && isAncestor(dir, pth.tip, 'main')))
      fail(`${laneId(lane, stateDir)} cannot be archived: its work is not on main (${pth.branch} ${String(pth.tip).slice(0, 7)}, ${pth.state}${pth.why ? ': ' + pth.why : ''}) - merge it first, or archive it as the owner with an override (data.override: the why)`);
  }
  const open = Object.values(fold(readEvents(recordsFile(stateDir, 'deliverable'))).items).filter(i => i.kind === 'deliverable' && i.state === 'open' && i.data.lane === lane);
  for (const d of open) {
    const m = dlvMerged(d);
    if (m.merged) continue;
    fail(`${laneId(lane, stateDir)} cannot be archived: ${d.id} (${d.data.branch}) is ${m.unknown ? `done, cannot tell if merged (${m.unknown})` : 'done but not merged'} - merge it, or park it with the owner's reason (norn deliverables park ${d.id} --why "...")`);
  }
}
// item 8 (lane norn-lifecycle): a check-in writes a waiver only as the owner's ruling it applies - data.q names a question the owner
// answered (answered / applied); its own judgement never waives
function waiverGuard(stateDir, d) {
  if (!d.q) fail('a check-in waives only on the owner answer: pass --q Q-n (the answered question that says to waive)');
  const q = loadState(stateDir).items[d.q];
  if (!q || q.kind !== 'question') fail(`${d.q} is not a question`);
  if (!['answered', 'applied'].includes(q.state)) fail(`${d.q} is ${q.state}, not answered: a check-in waives only what the owner ruled`);
}
// META-GTP-MAIL piece 1: the cross-file rules of mail (the runs + epics logs are read here, under the mail log's lock).
// A run's mailbox = its id, the runs it continues (resume / queue fill / re-queue / fallback chain), lane:<its lane>, and
// role:checkin for a check-in run; in home h (RM-46 S1a) lane:h/<lane> and role:checkin@h.
const CHAIN = ['resume_of', 'from_queue', 'requeue_of', 'fallback_of'];
export function mailboxOf(runs, id, home = null) {
  const box = new Set();
  const me = runs[id];
  if (!me) return box;
  for (let r = me, n = 0; r && !box.has(r.id) && n < 1000; n++) { box.add(r.id); r = CHAIN.map(k => runs[r.data[k]]).find(Boolean); }
  if (me.data.lane) box.add(laneAddrIn(me.data.lane, home));
  if (me.data.kind === 'checkin') box.add(roleAddrIn('checkin', home));
  return box;
}
// the epics run `id` belongs to: members (create + add - remove, as epics.mjs epicMembers) or the run's own epic field
function epicsOf(stateDir, runs, id) {
  const out = new Set(runs[id]?.data.epic ? [runs[id].data.epic] : []);
  for (const e of Object.values(fold(readEvents(recordsFile(stateDir, 'epic'))).items)) {
    let m = [...(e.data.members || [])];
    for (const h of e.history.slice(1)) {
      if (h.ev === 'add') m.push(...(h.data.members || []));
      if (h.ev === 'remove') m = m.filter(x => !(h.data.members || []).includes(x));
    }
    if (m.includes(id)) out.add(e.id);
  }
  return out;
}
// a run of this state dir: solo RUN-n; a home its own RUN-<home>-n (the bare home also RUN-n). Another home's run is not in this
// state (RM-46 S1a: its existence is not checked here)
const ownRun = (id, home) => RUN_ID_RE.test(id || '') && (home ? [home.id, home.bare_home === home.id ? null : home.id].includes(idHome(id)) : /^RUN-\d+$/.test(id));
function mailGuard(stateDir, e, run, st) {
  if (e.by === 'migration') return;
  const d = e.data || {}, home = homeOf(stateDir), checkin = roleAddrIn('checkin', home?.id), controller = roleAddrIn('controller', home?.id);
  const runs = fold(readEvents(recordsFile(stateDir, 'run'))).items;
  const needRun = () => {
    if (!run) fail(`a run ${e.ev === 'create' ? 'sends' : 'reads'} mail as itself: META_RUN_ID is not set`);
    if (!runs[run]) fail(`${run} (META_RUN_ID) does not exist`);
    return runs[run];
  };
  if (e.ev === 'create') {
    if (ownRun(d.to, home) && !runs[d.to]) fail(`to ${d.to} does not exist`);
    if (e.by !== 'worker') return;
    const me = needRun();
    if (d.from !== run) fail(`from must be ${run} (a run sends as itself)`);
    const peers = () => { const mine = epicsOf(stateDir, runs, run); return mine.size > 0 && [...epicsOf(stateDir, runs, d.to)].some(x => mine.has(x)); };
    const ok = d.to !== run && (d.to === checkin || d.to === controller || d.to === me.data.parent || (ownRun(d.to, home) && peers()));
    if (!ok) fail(`${run} may not mail ${d.to}: a run mails its parent, ${checkin}, ${controller} or runs of its own epic`);
  }
  if ((e.ev === 'deliver' || e.ev === 'ack') && e.by === 'worker') {
    needRun();
    if (e.ev === 'deliver' && d.run !== run) fail(`a run takes delivery for itself: run must be ${run} (got ${d.run})`);
    const m = st.items[e.id];
    if (m?.kind === 'mail' && !mailboxOf(runs, run, home?.id).has(m.data.to)) fail(`${e.id} is not addressed to ${run} (to ${m.data.to})`);
  }
}
// RM-26: a decision a check-in run writes carries the model / effort that run started with (its runs.jsonl start) and whether they
// were below the check-in floor (floor.mjs checkinBelow) when it was made: made_under { model, effort, below_floor }. Only this stamps
// it (a caller's own made_under is dropped); no run, or a run start with no model, = no stamp.
function madeUnder(stateDir, d, by, run) {
  const { made_under: _, ...rest } = d;
  const r = by === 'checkin' && run ? fold(readEvents(recordsFile(stateDir, 'run'))).items[run] : null;
  if (!r?.data?.model) return rest;
  const model = r.data.model, effort = r.data.effort ?? null;
  return { ...rest, made_under: { model, effort, below_floor: checkinBelow({ model, effort }).length > 0 } };
}
// NORN-WATCH S4: a deliverable a queued run takes as an input (queue field `inputs`) cannot be parked under it
function inputGuard(stateDir, id) {
  const q = Object.values(fold(readEvents(recordsFile(stateDir, 'run'))).items).find(r => r.state === 'queued' && (r.data.inputs || []).includes(id));
  if (q) fail(`${id} cannot be parked: queued run ${q.id}${q.data.lane ? ` (lane ${q.data.lane})` : ''} lists it in its inputs - withdraw that run first (norn stop ${q.id})`);
}

/**
 * Validate and append one event (plus the lane park / unpark events a question implies) under the log's lock,
 * then regenerate the views. Returns the appended primary envelope (an array of events = one batch -> the array of primaries). Throws RecordError(code 2) on invalid input.
 * opts: { now: () => Date, run, views: false | { questions, decisions, directives } paths (default state/views/), onViews(result) }
 */
/**
 * OOTB-R2 N-16: does the run named by env.META_RUN_ID belong to stateDir? Its state is META_RUN_STATE (the supervisor sets it), else
 * META_STATE (a check-in's tick env); neither = no claim either way (true: today's stamping). An agent that runs `meta` against
 * another project must not stamp that project's records with its own run id / role.
 */
export function launchedHere(stateDir, env = process.env) {
  const own = env.META_RUN_STATE || env.META_STATE;
  if (!own) return true;
  const n = p => { const r = path.resolve(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
  return n(own) === n(stateDir);
}
// META-Q-RECONCILE R1: an answer { from: DEC-m } takes the owner's words from the decision (data.owner_words or its quoted
// "owner verbatim: ..."), via = the decision's (else chat), choice = the option key its choice starts with. The words are the
// owner's, so the event is the owner's; a controller / check-in relaying them is named in relayed_by (RECORDS.md 3.4).
function answerFrom(st, ev) {
  const d = { ...(ev.data || {}) }, dec = st.items[d.from], q = st.items[ev.id];
  if (!dec || dec.kind !== 'decision') fail(`from ${d.from} is not a decision`);
  const words = ownerWordsOf(dec);
  if (!words) fail(`${dec.id} carries no owner words (owner_words, or "owner verbatim: \\"...\\""): it cannot answer ${ev.id} - mark it not an answer instead`);
  const out = { ...d, text: d.text ?? words, via: d.via ?? (typeof dec.data.via === 'string' ? dec.data.via : 'chat') };
  const key = d.choice ?? (q?.kind === 'question' ? choiceKeyOf(q, dec) : undefined);
  if (key !== undefined) out.choice = key;
  if (!CK.includes(ev.by)) return { ...ev, data: out };   // the owner's own act, or a role that may not relay (refused by the role table)
  return { ...ev, by: 'owner', data: { ...out, relayed_by: ev.by } };
}

// META-CONTROLLER C6 (SPEC sec. 5): every remote write is stamped. The dashboard runs a remote device's request inside
// writeOrigin.run({ via: 'remote:<device>' }) and clears it when the request ends; the envelope then carries via. Unset = no key (as before).
export const writeOrigin = new AsyncLocalStorage();
export function record(stateDir, evIn, opts = {}) {
  const c = recordCtx(stateDir, evIn, opts);
  fs.mkdirSync(stateDir, { recursive: true });
  c.setIds(stateDir);
  try {
    return withLock(c.lock, () => {
      const r = c.plan();
      const fd = fs.openSync(c.file, 'a');
      try { fs.writeSync(fd, r.text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (r.views) { const v = writeViews(stateDir, r.st, opts.views || {}); if (opts.onViews) opts.onViews(v); }
      return r.out;
    });
  } catch (e) { if (e instanceof RecordError && e.refusal) noteRefusal(stateDir, e.message, e.refusal); throw e; }
}
/** META-DASH-ASYNC R1 (option a): record() for the dash server's POST paths - the same lock file, checks and envelope, but the lock,
 * the reads (primed into a fresh snapshot under the lock), the append + fsync and the views on fs.promises: a slow syscall delays
 * only this write, never the event loop. The CLI keeps record(). */
export async function recordAsync(stateDir, evIn, opts = {}) {
  const c = recordCtx(stateDir, evIn, opts), fp = fs.promises;
  await fp.mkdir(stateDir, { recursive: true });
  try {
    return await withLockAsync(c.lock, () => snap.run(newSnap(), async () => {
      await prime({ files: [c.file, recordsFile(stateDir, 'lane'), path.join(stateDir, 'home.json'), path.join(stateDir, 'node.json')] });
      c.setIds(stateDir);
      const r = c.plan();
      const fh = await fp.open(c.file, 'a');
      try { await fh.write(r.text); await fh.sync(); } finally { await fh.close(); }
      if (r.views) { const v = await writeViewsAsync(stateDir, r.st, opts.views || {}, { role: 'dashboard' }); if (opts.onViews) opts.onViews(v); }
      return r.out;
    }));
  } catch (e) { if (e instanceof RecordError && e.refusal) noteRefusal(stateDir, e.message, e.refusal); throw e; }
  finally { if (snap.getStore()) { snap.getStore().folds.delete(stateDir); forget(c.file); } }   // the caller's snapshot reads the write
}
function recordCtx(stateDir, evIn, opts) {
  const many = Array.isArray(evIn), evs = many ? evIn : [evIn];   // an array = one all-or-nothing batch of one kind (S3 --each)
  if (!evs.length) fail('no events');
  const kind = evs[0].kind;
  if (evs.some(e => e.kind !== kind)) fail('a batch holds one record kind');
  if (!KINDS[kind]) fail(`unknown kind ${JSON.stringify(kind)} (question | decision | directive | lane | run | mail)`);
  if (snap.getStore()) { snap.getStore().folds.delete(stateDir); forget(recordsFile(stateDir, kind)); }   // META-DASH-ASYNC R1: a write inside a request: its snapshot reads again
  const file = recordsFile(stateDir, kind);
  const lock = file.replace(/\.jsonl$/, '.lock');
  const now = opts.now || (() => new Date());
  const run = opts.run !== undefined ? opts.run : (process.env.META_RUN_ID && launchedHere(stateDir, process.env) ? process.env.META_RUN_ID : null);
  let ids = {};
  const via = writeOrigin.getStore()?.via ?? null;   // C6: a remote device's write (the dashboard sets it per request)
  return { file, lock, setIds: s => { ids = { pfx: idPrefix(s), home: homeOf(s) }; }, plan };
  /** the checked batch (no write): its jsonl text, the folded state after it, whether the views follow, the caller's result */
  function plan() {
    // RM-46 S1d (SPEC 3.8): a shared kind in a synced dir is checked against the merged view (own log + the copies); only the own
    // file is written. A transition on another home's record is written here and stays pending until its primary relays it.
    const home = ids.home, hs = home && SHARED_KINDS.includes(kind) ? homeStreams(stateDir, home, KINDS[kind].file) : null;
    const base = hs ? hs.streams[0].events : readEvents(file);
    const batch = [], pend = new Set();
    const refold = () => (hs ? foldHomes([{ ...hs.streams[0], events: [...base, ...batch] }, ...hs.streams.slice(1)], { bare_home: home.bare_home, own: home.id }) : fold([...base, ...batch]));
    let st = refold();
    // the relay (sync.mjs relayPass) of an event this log already committed: nothing to write
    if (opts.from_home && st.relayed?.includes(`${opts.from_home.home}:${opts.from_home.seq}`)) return { text: '', st, views: false, out: null };
    // SPEC 3.7 HLC: a shared event sorts after every event of the other homes this view holds (+1 s), and never before the own newest
    const stamp = () => {
      let t = Math.floor(now().getTime() / 1000) * 1000;
      if (hs) for (const [h, ms] of Object.entries(st.newest)) t = Math.max(t, h === home.id ? ms : ms + 1000);
      return isoSec(new Date(t));
    };
    // META-CONTROLLER C4: the lanes (and their holds) live in records.jsonl; a run / deliverable write reads them from there
    let lanes = null;
    const laneItems = () => (KINDS[kind].file === 'records' ? st.items : (lanes ??= loadShared(stateDir, 'lane').items));
    const push = e => {
      if (e.by === 'checkin') {
        // the clock is read only for a lane that was ever claimed (a caller's clock may count its calls: the golden views)
        const ln = laneOfEvent(e, st, ids.home?.id), l = ln ? laneItems()[laneIdIn(ln, ids.home?.id)] : null, h = l?.history.some(x => x.ev === 'claim') ? holdOf(l, now().getTime()) : null;
        if (h) throw new RecordError(holdMessage(h), HELD_EXIT);
      }
      // SPEC 3.8: each home's check-ins (and controller) act only on its own lanes
      const ln = home && CK.includes(e.by) ? laneOfEvent(e, st, home.id) : null, lh = ln ? homePart(ln) : null;
      if (lh && lh !== home.id) fail(`L:${ln} belongs to home ${lh}: a ${e.by} acts only on the lanes of its own home (${home.id})`);
      const c = check(st, e, ids);
      const p = hs && c.ev !== createEv(c.kind) ? primaryOf(st.items[c.id], home.bare_home) : home?.id;
      if (hs && p !== home.id) {
        const twin = (st.pending[c.id] || []).find(x => x.ev === c.ev);
        if (twin) fail(`${c.id} already has a pending ${c.ev} from home ${twin.home} (seq ${twin.seq}), waiting for home ${p} to commit it - nobody ${c.ev}s twice`);
      }
      const env = { v: 1, seq: st.seq + 1, ts: hs ? stamp() : isoSec(now()), id: c.id, kind: c.kind, ev: c.ev, by: c.by, run, ...(via ? { via } : {}),
        ...(opts.from_home ? { from_home: opts.from_home } : {}), data: c.data };
      if (hs && p !== home.id) pend.add(env);
      batch.push(env);
      st = refold();
      return env;
    };
    const primaries = [];
    // META-ROADMAP S1: an item batch (norn road apply) names its own earlier creates as $n (n = index in the batch)
    const ref$ = v => (typeof v === 'string' && /^\$\d+$/.test(v) ? (primaries[Number(v.slice(1))]?.id ?? fail(`${v}: no earlier event ${v.slice(1)} in this batch`)) : v);
    for (let ev of evs) {
    if (kind === 'item') {
      const d = { ...(ev.data || {}) };
      for (const k of ['parent', 'after']) if (k in d) d[k] = ref$(d[k]);
      ev = { ...ev, id: ref$(ev.id), data: d };
    }
    if (kind === 'lane' && ev.ev === 'archive' && ev.by !== 'migration') archiveGuard(stateDir, laneName(ev.id || '', stateDir), ev);
    if (kind === 'waiver' && ev.ev === 'create' && ev.by === 'checkin') waiverGuard(stateDir, ev.data || {});
    if (kind === 'deliverable' && ev.ev === 'park' && ev.by !== 'migration') inputGuard(stateDir, ev.id);
    if (kind === 'mail') mailGuard(stateDir, ev, run, st);
    // META-Q-RECONCILE R1: an owner pick in a decision closes the Q it answers in the same step, or the write is refused
    const caller = ev.by;
    if (kind === 'decision' && ev.ev === 'create' && caller !== 'migration') {
      const d = ev.data || {}, g = ownerPickGuard(st.items, d);
      // NORN-WATCH S3 + META-CHECKIN-GUARDS R1 guard B (checkinguards.ownerOnlyRefusal, the grader's too): an open owner_only Q is
      // ruled by the owner only (DIR-47 covers every other Q) - exit 7, noted on the writer's run (the Runs page shows it)
      const oo = d.answers ? ownerOnlyRefusal(st.items[d.answers], caller) : null;
      if (oo) throw Object.assign(new RecordError(oo, OWNER_ONLY_EXIT), { refusal: { guard: 'owner-only', lane: d.lane ?? null, answers: d.answers } });
      if (g) throw new RecordError(`${g.id} is open on lane ${d.lane} - pass --answers ${g.id} or --not-an-answer`, 3);
      if (d.answers && st.items[d.answers]?.state === 'open' && carriesOwnerPick(d) && !d.owner_words)
        fail(`${d.answers} is open: --answers with an owner pick needs --owner-words "<the owner's words, verbatim>" (they answer it in the same step)`);
      ev = { ...ev, data: madeUnder(stateDir, d, caller, run) };
    }
    if (kind === 'question' && ev.ev === 'answer' && ev.data?.from !== undefined && caller !== 'migration') ev = answerFrom(st, ev);
    const primary = push(ev);
    primaries.push(primary);
    if (pend.has(primary)) continue;   // pending: what the event implies (the apply, the lane park) is the primary's relay to write
    const closeQ = (qid, from) => {   // the answer (from the DEC) + the apply when the caller may apply
      const a = push(answerFrom(st, { kind: 'question', ev: 'answer', id: qid, by: caller, data: { from } }));
      if (KINDS.question.events.apply.roles.includes(caller)) {
        push({ kind: 'question', ev: 'apply', id: qid, by: caller, data: { refs: [from] } });
        unparkFor(qid, caller);
      }
      return a;
    };
    const unparkFor = (qid, by) => {
      for (const l of Object.values(st.items)) {
        if (l.kind === 'lane' && l.state === 'parked' && l.park?.q === qid && (by === 'migration' || KINDS.lane.events.unpark.roles.includes(by)))
          push({ kind: 'lane', ev: 'unpark', id: l.id, by, data: { q: qid } });
      }
    };
    if (kind === 'decision' && ev.ev === 'create' && caller !== 'migration' && primary.data.answers && primary.data.owner_words && st.items[primary.data.answers]?.state === 'open')
      closeQ(primary.data.answers, primary.id);
    if (kind === 'question' && ev.ev === 'answer' && primary.data.from && KINDS.question.events.apply.roles.includes(caller)) {
      push({ kind: 'question', ev: 'apply', id: primary.id, by: caller, data: { refs: [primary.data.from] } });
      unparkFor(primary.id, caller);
    }
    // Lane parking follows the blocking question (3.4: "Parked is set by the Q that blocks it and cleared by its apply").
    if (kind === 'question' && ev.ev === 'create') {
      for (const name of primary.data.blocks || []) {
        const l = st.items[laneIdIn(name, ids.home?.id)];
        if (l && l.state === 'active') push({ kind: 'lane', ev: 'park', id: l.id, by: ev.by, data: { why: `blocked by ${primary.id}: ${primary.data.title}`, q: primary.id } });
      }
    }
    if (kind === 'question' && ['apply', 'supersede', 'withdraw'].includes(ev.ev)) {
      for (const l of Object.values(st.items)) {
        if (l.kind === 'lane' && l.state === 'parked' && l.park?.q === primary.id && (ev.by === 'migration' || KINDS.lane.events.unpark.roles.includes(ev.by)))
          push({ kind: 'lane', ev: 'unpark', id: l.id, by: ev.by, data: { q: primary.id } });
      }
    }
    }
    return { text: batch.map(e => JSON.stringify(e) + '\n').join(''), st, views: opts.views !== false && KINDS[kind].file === 'records',
      out: many ? primaries : primaries[0] };
  }
}
/**
 * META-CHECKIN-GUARDS R1: a guard's refusal noted on the refused writer's own RUNNING run (env META_RUN_ID, when it belongs to this
 * state: launchedHere) as a run `refuse` event - nothing else happened, the next tick and the Runs page see it. No run = no note.
 */
export function noteRefusal(stateDir, why, { guard, ...extra }, env = process.env) {
  const id = env.META_RUN_ID;
  if (!id || !launchedHere(stateDir, env)) return null;
  if (fold(readEvents(recordsFile(stateDir, 'run'))).items[id]?.state !== 'running') return null;
  return record(stateDir, { kind: 'run', ev: 'refuse', id, by: 'launcher', data: { guard, why, ...extra } }, { run: id });
}
