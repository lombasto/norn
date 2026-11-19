// META-GTP-DAG piece 2 (GT-PARITY-PLAN sec. 2.3; Gas Town convoy, docs/concepts/convoy.md:23-25 - cited, not ported): an epic EP-n
// groups runs and deliverables under one title + priority (P0-P4) and an optional integration branch. Records in epics.jsonl
// (records.mjs KINDS.epic). Members = create.members + add - remove; DONE is derived from the members through the ONE after:
// evaluator (after.mjs makeEval): a member run is done when it (or its HANDOFF / limit / fill successor) ended DONE, a member
// DLV when it is merged. An empty epic is not done.
import { record, readEvents, fold, recordsFile } from './records.mjs';
import { makeEval, checkRefs, AfterError } from './after.mjs';

export class EpicError extends Error {}

export const loadEpics = state => fold(readEvents(recordsFile(state, 'epic'))).items;

/** the current member ids of an epic item, in the order they joined (pure) */
export function epicMembers(it) {
  let m = [...(it.data.members || [])];
  for (const h of it.history.slice(1)) {
    if (h.ev === 'add') for (const x of h.data.members || []) { if (!m.includes(x)) m.push(x); }
    if (h.ev === 'remove') m = m.filter(x => !(h.data.members || []).includes(x));
  }
  return m;
}

const memberCond = id => (id.startsWith('DLV-') ? { kind: 'dlv', id, state: 'merged' } : { kind: 'run', id, state: 'done' });

/** { id, title, priority, integration_branch, state, members: [{id, done, gone}], done } - ev: a makeEval evaluator (shared) */
export function epicStatus(state, it, { ev = makeEval(state) } = {}) {
  const members = epicMembers(it).map(id => { const r = ev(memberCond(id)); return { id, done: r.met, gone: r.gone }; });
  return { id: it.id, title: it.data.title, priority: it.data.priority, integration_branch: it.data.integration_branch ?? null, state: it.state,
    members, done: members.length > 0 && members.every(m => m.done) };
}

/** every member id must exist in the state dir now (a typo would never finish); throws EpicError */
export function checkMembers(state, ids = []) {
  try { checkRefs(state, ids.map(memberCond)); } catch (e) { if (e instanceof AfterError) throw new EpicError(e.message.replace(/^--after \S+: /, 'member ')); throw e; }
}

/** the open epic a new run joins (norn run --epic); throws EpicError */
export function openEpic(state, id) {
  const it = loadEpics(state)[id];
  if (!it) throw new EpicError(`--epic ${id}: does not exist in ${state}`);
  if (it.state !== 'open') throw new EpicError(`--epic ${id}: is ${it.state}`);
  return it;
}

/** record the launcher's `add` of a new run to its epic */
export const joinEpic = (state, id, run) => record(state, { kind: 'epic', ev: 'add', id, by: 'launcher', data: { members: [run] } }, { views: false });
