// META-ROADMAP S1 (DIR-11; meta-roadmap SPEC sec. 1-3): the roadmap as records. roadmap.jsonl (records.mjs KINDS.item) holds
// STRUCTURE only - themes and items, their order, horizon, note, links, planned stages, a caveat. Status is NEVER typed or stored:
// derive() computes it at read time from what an item links (runs, lanes, deliverables, git, questions), first matching rule row
// of SPEC sec. 2 wins. audit = the drift detectors D1-D5. The ROADMAP view is generated with the views' hand-edit guard.
// Project-agnostic: every project fact comes from project.json (deliverables target / receipts, root, views.roadmap).
import fs from 'node:fs';
import path from 'node:path';
import { readEvents, recordsFile, loadState, loadShared, homeOf, laneIdIn, laneNameIn, homeOfId, copyItems } from './records.mjs';
import { deliverablesView, deliverableConfig, lastInstall } from './deliverables.mjs';
import { scanRepo, makeGit } from './dlvgit.mjs';
import { loadEpics, epicMembers } from './epics.mjs';
import { writeGuarded, writeGuardedAsync } from './views.mjs';
import { stuckOf, stuckPolicy, mergesOf, stuckWords } from './stuck.mjs';

// the `road show` line of a look item, or null (here, not in look.mjs: look reads roadmap links, so roadmap may not import look - K10)
const lookWords = n => (n.proof ? `proof: ${n.proof}; views ${(n.views || []).join(', ') || '-'}; verdict: ${n.verdict ? `${n.verdict.verdict} by ${n.verdict.by} ${n.verdict.ts} ${n.verdict.image}` : 'none'}` : null);

export class RoadmapError extends Error {}

// ---------- the structure fold (pure) ----------
/** events -> { items: { RM-n: node }, kids: { parentId | '': [ids in order] } }; node = { id, kind, title, note, horizon, stages,
 *  links, parent, caveat {text, by, ts} | null, legacy | null, state open | dropped, dropped {why, ref, by, ts} | null, by, created, updated, history,
 *  proof look | null, views [name], verdict {verdict, image, by, ts} | null (META-CATCH S2: the latest look verdict) } */
export function foldRoadmap(events, { ordered = false } = {}) {   // ordered: the events are in fold order already (foldHomes)
  const items = {}, kids = { '': [] };
  const unplace = id => { const l = kids[items[id].parent || '']; const i = l ? l.indexOf(id) : -1; if (i >= 0) l.splice(i, 1); };
  const place = (id, after) => {
    const l = kids[items[id].parent || ''] ||= [];
    const j = after === undefined ? -1 : after === null ? -2 : l.indexOf(after);
    if (j === -2) l.unshift(id); else if (j < 0) l.push(id); else l.splice(j + 1, 0, id);
  };
  for (const e of ordered ? events : [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.kind !== 'item') continue;
    const d = e.data || {};
    if (e.ev === 'create') {
      items[e.id] = { id: e.id, kind: d.kind, title: d.title, note: d.note ?? '', horizon: d.horizon ?? null, stages: [...(d.stages || [])],
        links: [...(d.links || [])], parent: d.parent ?? null, caveat: null, legacy: d.legacy ?? null, state: 'open', dropped: null,
        proof: null, views: [], verdict: null, by: e.by, created: e.ts, updated: e.ts, history: [] };
      place(e.id, d.after);
    }
    const it = items[e.id];
    if (!it) continue;
    if (e.ev === 'edit') {
      for (const k of ['title', 'note', 'horizon', 'stages']) if (k in d) it[k] = d[k] ?? (k === 'stages' ? [] : k === 'note' ? '' : null);
      if ('caveat' in d) it.caveat = d.caveat ? { text: d.caveat, by: e.by, ts: e.ts } : null;
      if ('views' in d) it.views = [...(d.views || [])];
      if ('proof' in d) { it.proof = d.proof ?? null; if (!it.proof) it.views = []; }   // --proof none clears the views with it
    }
    if (e.ev === 'verdict') it.verdict = { verdict: d.verdict, image: d.image, by: e.by, ts: e.ts };
    if (e.ev === 'move') { unplace(e.id); if ('parent' in d) it.parent = d.parent ?? null; place(e.id, d.after); }
    if (e.ev === 'link') for (const x of d.links || []) { if (!it.links.includes(x)) it.links.push(x); }
    if (e.ev === 'unlink') it.links = it.links.filter(x => !(d.links || []).includes(x));
    if (e.ev === 'drop') { it.state = 'dropped'; it.dropped = { why: d.why, ref: d.ref, by: e.by, ts: e.ts }; }
    if (e.ev === 'reopen') { it.state = 'open'; it.dropped = null; }
    it.updated = e.ts;
    it.history.push({ seq: e.seq, ts: e.ts, ev: e.ev, by: e.by, data: d });
  }
  return { items, kids };
}
// RM-46 S1d: a synced dir folds the own roadmap + the copies (records.mjs foldHomes: one order on every home)
// a synced dir's fold also carries the pending item events (another home's, or this home's on another home's item: SPEC 3.7)
export const loadRoadmap = stateDir => (homeOf(stateDir) ? (v => ({ ...foldRoadmap(v.events, { ordered: true }), pending: v.pending }))(loadShared(stateDir, 'item')) : foldRoadmap(readEvents(recordsFile(stateDir, 'item'))));
/**
 * RM-46 S3: the fold as this home reads it. Another home's item names its lanes as that home types them (lane:x = its own x): here they
 * read lane:b/x, so derive() finds b's copied runs and DLVs; such a node carries home (its "on b" chip). A pending event on an item =
 * pending [{ ev, home, ts, primary }]. A solo dir: R as is.
 */
export function hereLinks(R, home) {
  if (!home) return R;
  const items = Object.fromEntries(Object.entries(R.items).map(([id, n]) => {
    const h = homeOfId(id, home.bare_home), pd = (R.pending?.[id] || []).map(e => ({ ev: e.ev, home: e.home, ts: e.ts, primary: h }));
    const own = h === home.id ? n : { ...n, home: h, links: (n.links || []).map(t => (/^lane:/.test(t) ? 'lane:' + laneNameIn(laneIdIn(t.slice(5), h), home.id) : t)) };
    return [id, pd.length ? { ...own, pending: pd } : own];
  }));
  return { ...R, items };
}
/** the ordered child ids of a node (null = the root: the themes) */
export const childrenOf = (R, id) => [...(R.kids[id || ''] || [])];

// ---------- the derived status (SPEC sec. 2) ----------
const DAY = 864e5;
export const PHASE = { shipped: 'past', dropped: 'past', building: 'present', waiting: 'present', built: 'present', merged: 'present',
  queued: 'future', planned: 'future', idea: 'future' };
export const LINK_KINDS = ['dir', 'dec', 'q', 'lane', 'run', 'dlv', 'ep', 'branch', 'sha', 'doc'];
export const parseLink = t => { const i = String(t).indexOf(':'); return { kind: t.slice(0, i), id: t.slice(i + 1) }; };
export function linksOf(links = []) {
  const L = Object.fromEntries(LINK_KINDS.map(k => [k, []]));
  for (const t of links) { const { kind, id } = parseLink(t); if (L[kind]) L[kind].push(id); }
  return L;
}
const QUEUED = ['queued', 'claimed'];
const endTs = r => { const h = [...(r.history || [])].reverse().find(x => ['end', 'lost', 'kill'].includes(x.ev)); return h ? Date.parse(h.ts) : null; };
export const runTs = r => endTs(r) ?? Date.parse(r.created);
const runWord = r => r.state === 'running' ? 'live' : QUEUED.includes(r.state) ? 'queued' : r.state === 'exited' ? (r.end?.outcome || 'ended') : r.state;
// one time-line stretch per started run (S2 view): its start event (else created) -> its end / lost / kill event (live: open), the run word
const spanOf = r => { const h = r.history || [], s = h.find(x => x.ev === 'start'), e = [...h].reverse().find(x => ['end', 'lost', 'kill'].includes(x.ev));
  return { run: r.id, from: s?.ts ?? r.created, to: r.state === 'running' ? null : e?.ts ?? null, state: runWord(r) }; };
const firstWord = s => String(s).trim().split(/\s+/)[0].toUpperCase();
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : w.endsWith('h') ? 'es' : 's'}`;

/**
 * The world derive() reads, from plain parts (pure; world() fills it from the state dir, deliverables and git).
 * parts: { now (ms), items (loadState items: questions, decisions, directives, lanes, runs), dlv (deliverablesView rows),
 *   branches: { name: { exists, merged, installed, ref_date } } | fn(name) -> that | null, shas: { sha: onMain } | fn(sha) -> bool | null (unknown),
 *   docs: [paths] | fn(path) -> bool, hasInstall (the target is an install: deliverables receipts set), epics: { EP-n: { state, title, members } },
 *   idle: { days (default 7), now (default 3) } }
 */
// home = the state dir's home id (RM-46 S1a): a lane link x names L:<home>/x there
export function worldOf({ now = Date.now(), items = {}, dlv = [], branches = {}, shas = {}, docs = [], hasInstall = false, epics = {}, idle = {}, policy = {}, home = null } = {}) {
  const fnOf = (v, miss) => typeof v === 'function' ? v : Array.isArray(v) ? (k => v.includes(k)) : (k => (k in v ? v[k] : miss));
  // OOTB-R2 N-4: a fake-executor run is a rehearsal - never evidence for the derived status (as deliverables' NOT_DELIVERING)
  const runs = Object.values(items).filter(i => i.kind === 'run' && i.data?.kind !== 'checkin' && i.data?.executor !== 'fake');
  const group = key => { const m = {}; for (const d of dlv) if (d[key]) (m[d[key]] ||= []).push(d); return m; };
  return { now, home, lane: n => laneIdIn(n, home), items, runs, dlv, dlvById: Object.fromEntries(dlv.map(d => [d.id, d])), dlvByBranch: group('branch'), dlvByLane: group('lane'),
    branch: fnOf(branches, null), sha: fnOf(shas, null), doc: fnOf(docs, false), hasInstall, epics, idle: { days: 7, now: 3, ...idle }, stuck: stuckPolicy(policy) };   // META-CATCH S1: policy.stuck
}

/** the runs, DLVs and branches an item's links reach (a lane brings its runs + DLVs, an epic its member runs + DLVs) */
export function reach(node, W) {
  const L = linksOf(node.links);
  const members = L.ep.flatMap(id => W.epics[id]?.members || []);
  const runIds = new Set([...L.run, ...members.filter(m => /^RUN-/.test(m))]);
  const runs = W.runs.filter(r => (L.lane.includes(r.data?.lane) || runIds.has(r.id)) && !['withdrawn', 'filled'].includes(r.state));
  const dlvs = new Set([...L.dlv, ...members.filter(m => /^DLV-/.test(m))].map(id => W.dlvById[id]).filter(Boolean));
  for (const b of L.branch) for (const d of W.dlvByBranch[b] || []) dlvs.add(d);
  for (const l of L.lane) for (const d of W.dlvByLane[l] || []) dlvs.add(d);
  const br = new Map();
  for (const d of dlvs) {
    const sup = !!d.superseded || d.record_state === 'superseded', onMain = sup || d.state === 'merged' || d.state === 'installed';   // unknown = cannot tell: not on main
    const tgtInstall = W.hasInstall && d.target !== 'main';
    br.set(d.branch, { name: d.branch, dlv: d.id, state: sup ? 'superseded' : d.state, on_main: onMain, at_target: sup || (tgtInstall ? d.state === 'installed' : onMain),
      days: d.days ?? null, ts: Date.parse(d.done_utc || '') || null });
  }
  for (const b of L.branch) if (!br.has(b)) {
    const g = W.branch(b);
    const state = !g ? 'gone' : g.merged ? (g.installed ? 'installed' : 'merged') : g.exists ? 'unmerged' : 'gone';
    const onMain = state === 'merged' || state === 'installed';
    br.set(b, { name: b, dlv: null, state, on_main: onMain, at_target: W.hasInstall ? state === 'installed' : onMain, days: null, ts: g?.ref_date ?? null });
  }
  return { L, runs, branches: [...br.values()] };
}

/**
 * THE rule (SPEC sec. 2; first match wins) -> { row, status, phase, why, evidence, live, queued, stages, branches, progress, last, last_evidence }.
 * Row 10 covers every started run set that is not all DONE: the SPEC names the newest-ended-without-DONE case; a stage still planned
 * or an older stall is the same "started, not finished" (D4 idle flags the stall). Pure.
 */
export function derive(node, W) {
  const { L, runs, branches } = reach(node, W), now = W.now;
  const live = runs.filter(r => r.state === 'running'), queued = runs.filter(r => QUEUED.includes(r.state)), started = runs.filter(r => !QUEUED.includes(r.state));
  const last = started.reduce((m, r) => Math.max(m, runTs(r)), 0) || null;
  const sm = new Map();
  for (const r of [...started].sort((a, b) => runTs(a) - runTs(b))) {
    const key = r.data?.stage || '(run)', k = `${r.data?.lane || ''}/${key}`;
    const s = sm.get(k) || { key, lane: r.data?.lane ?? null, runs: 0 };
    s.runs++; s.state = runWord(r); s.run = r.id; s.ts = new Date(runTs(r)).toISOString(); sm.set(k, s);
  }
  const ran = [...sm.values()];
  const planned = (node.stages || []).filter(n => !ran.some(s => firstWord(s.key) === firstWord(n))).map(key => ({ key, lane: null, runs: 0, state: 'planned' }));
  const stages = [...ran, ...planned];
  const B = branches.filter(b => b.state !== 'gone');
  const qOpen = L.q.filter(id => W.items[id]?.state === 'open');
  const parked = L.lane.filter(l => W.items[W.lane(l)]?.state === 'parked');
  const shaOk = L.sha.filter(s => W.sha(s) === true);
  const ago = ts => Math.round((now - ts) / DAY);
  const ids = xs => xs.map(r => r.id).join(', ');
  let row, status, why;
  if (node.state === 'dropped' || node.dropped) { row = 1; status = 'dropped'; const d = node.dropped || {}; why = `dropped${d.by ? ' by ' + d.by : ''}: ${d.why ?? ''}${d.ref ? ` (${d.ref})` : ''}`; }
  else if (live.length) { row = 2; status = 'building'; why = `${plural(live.length, 'run')} live: ${ids(live)}`; }
  else if (qOpen.length || parked.length) {
    row = 3; status = 'waiting';
    why = [qOpen.length ? `open ${qOpen.join(', ')}` : null, ...parked.map(l => `${W.lane(l)} parked${W.items[W.lane(l)].park?.why ? ': ' + W.items[W.lane(l)].park.why : ''}`)].filter(Boolean).join('; ');
  }
  else if (B.length && B.every(b => b.at_target)) { row = 4; status = 'shipped'; why = `${plural(B.length, 'branch')} on main${W.hasInstall ? ' and installed' : ''}`; }
  else if (B.length && B.every(b => b.on_main)) { row = 5; status = 'merged'; why = `${plural(B.length, 'branch')} on main, not installed`; }
  else if (queued.length && !started.length) { row = 6; status = 'queued'; why = `queued: ${ids(queued)}`; }
  else if (queued.length) { row = 7; status = 'building'; why = `queued: ${ids(queued)}; ${plural(started.length, 'earlier run')}`; }
  else if (B.some(b => b.dlv && (b.state === 'done' || b.state === 'unknown'))) {
    const d = B.filter(b => b.dlv && (b.state === 'done' || b.state === 'unknown')); row = 8; status = 'built';
    why = `${d.map(b => b.dlv).join(', ')} DONE, not on main (${Math.max(...d.map(b => b.days || 0)).toFixed(0)} d)`;
  }
  else if (B.some(b => b.state === 'unmerged')) {
    const fresh = last && now - last < 3 * DAY; row = 9; status = fresh ? 'building' : 'built';
    why = `${B.filter(b => b.state === 'unmerged').map(b => b.name).join(', ')} not on main; ${last ? `last run ${ago(last)} d ago` : 'no run'}`;
  }
  else if (started.length && stages.some(s => s.state !== 'done')) {
    row = 10; status = 'building';
    const newest = [...started].sort((a, b) => runTs(b) - runTs(a))[0];
    why = runWord(newest) !== 'done' ? `${newest.id} ended ${runWord(newest)} ${ago(runTs(newest))} d ago`
      : `${stages.filter(s => s.state === 'done').length}/${stages.length} stages DONE; next: ${stages.find(s => s.state !== 'done').key}`;
  }
  else if (started.length) { row = 11; status = W.hasInstall ? 'built' : 'shipped'; why = `all ${plural(stages.length, 'stage')} DONE, no branch linked`; }
  else if (shaOk.length) { row = 12; status = 'shipped'; why = `${shaOk.join(', ')} on main`; }
  else if (node.horizon || (node.stages || []).length || L.doc.length) {
    row = 13; status = 'planned'; why = L.doc.length ? `spec: ${L.doc[0]}` : node.horizon ? `horizon ${node.horizon}, no run yet` : 'stages planned, no run yet';
  }
  else { row = 14; status = 'idea'; why = 'no spec, no run, no branch'; }
  const evidence = !!(row === 1 || live.length || queued.length || B.length || started.length || shaOk.length || qOpen.length || parked.length);
  const lastEvidence = Math.max(last || 0, ...B.map(b => b.ts || 0)) || null;
  const spans = started.map(spanOf).sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
  // META-CATCH S1: the stuck fold (runs / days / stopped in a row since the last merge; stuck.mjs); a past item never flags
  const stuck = stuckOf(runs, mergesOf(runs, branches), W.stuck || stuckPolicy(), now, { past: PHASE[status] === 'past' });
  return { row, status, phase: PHASE[status], why, evidence, live: live.map(r => r.id), queued: queued.map(r => r.id), stages, branches, spans, first: spans[0]?.from ?? null,
    progress: { done: stages.filter(s => s.state === 'done').length + B.filter(b => b.at_target).length, total: stages.length + B.length },
    last: last ? new Date(last).toISOString() : null, last_evidence: lastEvidence ? new Date(lastEvidence).toISOString() : null, stuck };
}

// ---------- drift: the detectors D1-D5 (SPEC sec. 2) ----------
// the legacy ladder words (a migrated row's typed status) -> the derived status they claim
export const LEGACY_WORDS = { "REQUESTED": 'idea', "SPEC'D": 'planned', "BUILDING": 'building', "BUILT NOT WIRED": 'built', "MERGED DEFAULT OFF": 'shipped',
  "SHIPPED": 'shipped', "DROPPED": 'dropped',
  // META-ADOPT A1: the generic words a hand-kept ROADMAP / TODO uses (the importer keeps them as legacy.word, a claim)
  "IN PROGRESS": 'building', "WIP": 'building', "PLANNED": 'planned', "DONE": 'shipped' };

/** D5: the links that point at nothing (a record, lane, run, DLV, epic, branch, sha or doc that does not exist) */
export function goneLinks(links, W) {
  return (links || []).filter(t => {
    const { kind, id } = parseLink(t);
    if (['dir', 'dec', 'q', 'run'].includes(kind)) return !W.items[id];
    if (kind === 'lane') return !W.items[W.lane(id)] && !W.runs.some(r => r.data?.lane === id);
    if (kind === 'dlv') return !W.dlvById[id];
    if (kind === 'ep') return !W.epics[id];
    if (kind === 'branch') { if (W.dlvByBranch[id]) return false; const g = W.branch(id); return !g || (!g.exists && !g.merged); }
    if (kind === 'sha') return W.sha(id) === null || W.sha(id) === undefined;
    if (kind === 'doc') return !W.doc(id);
    return true;
  });
}

/** D1 claimed, D2 drift, D4 idle (days) and D5 gone links of one item, given its derive() result -> { claimed, drift: [], idle, gone: [] } */
export function detect(node, d, W) {
  const word = node.legacy?.word ? String(node.legacy.word).trim().toUpperCase() : null;
  const claimed = d.evidence || !(word || node.caveat) ? null : `claimed: ${word ?? node.caveat.text}`;
  const drift = [];
  if (d.evidence && word && LEGACY_WORDS[word] && LEGACY_WORDS[word] !== d.status) drift.push(`legacy says ${word}; records say ${d.status} (${d.why})`);
  if (d.evidence && node.caveat && d.last_evidence && Date.parse(node.caveat.ts) < Date.parse(d.last_evidence))
    drift.push(`caveat "${node.caveat.text}" is older than the newest evidence (${d.last_evidence.slice(0, 10)})`);
  let idle = null;
  if (d.phase === 'present' && !d.live.length && !d.queued.length && d.last_evidence) {
    const days = (W.now - Date.parse(d.last_evidence)) / DAY, max = node.horizon === 'now' ? W.idle.now : W.idle.days;
    if (days > max) idle = Math.round(days);
  }
  return { claimed, drift, idle, gone: goneLinks(node.links, W) };
}

/** D3: live / recent (3 d) lanes, DONE-not-merged DLVs, active directives and open epics that no item (open or dropped) links */
export function unplacedOf(nodes, W) {
  const L = linksOf(nodes.flatMap(n => n.links || []));
  const members = L.ep.flatMap(id => W.epics[id]?.members || []);
  const runIds = new Set([...L.run, ...members.filter(m => /^RUN-/.test(m))]);
  const lanes = new Set(L.lane);
  for (const r of W.runs) if (runIds.has(r.id) && r.data?.lane) lanes.add(r.data.lane);
  const dlvs = new Set([...L.dlv, ...members.filter(m => /^DLV-/.test(m))]), brs = new Set(L.branch);
  const out = [], byLane = {};
  for (const r of W.runs) {
    if (r.data?.parent || !r.data?.lane || ['withdrawn', 'filled'].includes(r.state)) continue;   // a child run is its parent's work
    if (r.state === 'running' || QUEUED.includes(r.state) || W.now - runTs(r) < 3 * DAY) (byLane[r.data.lane] ||= []).push(r);
  }
  for (const [l, rs] of Object.entries(byLane)) if (!lanes.has(l))
    out.push({ kind: 'lane', id: W.lane(l), why: `${plural(rs.length, 'run')} in 3 d${rs.some(r => r.state === 'running') ? ', live now' : ''}` });
  for (const d of W.dlv) if ((d.state === 'done' || d.state === 'unknown') && !d.superseded && d.record_state !== 'superseded' && !dlvs.has(d.id) && !brs.has(d.branch) && !(d.lane && lanes.has(d.lane)))
    out.push({ kind: 'dlv', id: d.id, why: `${d.branch} DONE ${Number(d.days ?? 0).toFixed(0)} d, not on main` });
  for (const i of Object.values(W.items)) if (i.kind === 'directive' && i.state === 'active' && !L.dir.includes(i.id))
    out.push({ kind: 'dir', id: i.id, why: String(i.data?.text ?? '').replace(/\s+/g, ' ').slice(0, 90) });
  for (const [id, e] of Object.entries(W.epics)) if (e.state === 'open' && !L.ep.includes(id)) out.push({ kind: 'ep', id, why: String(e.title ?? '') });
  return out;
}

// ---------- the world from a state dir + project.json (IO) ----------
/** the install is the target only when the project names install receipts (SPEC sec. 2 "Target"); else main */
export const hasInstallTarget = project => { const c = deliverableConfig(project || {}); return c.target === 'install' && (c.receipts || []).length > 0; };

/** RM-46 S3 (SPEC 3.3): another home's deliverable (records.mjs copyItems) as a read-only deliverables row. Its git facts are that
 * home's: the record says only that a DONE run delivered it (state done, never merged / installed from here). */
export const dlvCopyRow = it => ({ id: it.id, home: it.home, readonly: true, record_state: it.state, state: 'done', target: 'main', at_target: it.state === 'superseded',
  ...(it.state === 'superseded' ? { superseded: true } : {}), repo: it.data.repo ?? null, branch: it.data.branch ?? null, lane: it.data.lane ?? null, run: it.data.run ?? null,
  delivers: it.data.delivers ?? '', done_utc: it.data.done_utc ?? it.created });
/** worldOf() filled from the state dir, the deliverables view and git (the engine's scanRepo; branch / sha facts asked lazily) */
export function world({ stateDir, project = {}, now = Date.now(), git = makeGit(), idle } = {}) {
  project = project || {};
  const st = loadState(stateDir), away = copyItems(stateDir, 'run');   // RM-46 S3: + the other homes' runs and DLVs (read-only copies)
  let rows = [];
  try { rows = deliverablesView({ stateDir, project, now, git, questions: Object.values(st.items).filter(i => i.kind === 'question') }).rows; } catch { rows = []; }
  const cfg = deliverableConfig(project), hasInstall = hasInstallTarget(project);
  let scan;
  const sc = () => {
    if (scan === undefined) {
      scan = null;
      if (cfg.repo) try { scan = scanRepo(cfg.repo, { main: cfg.main, remote: cfg.remote, cache: {}, git, installed: hasInstall ? lastInstall(cfg)?.commits || [] : [], history: cfg.history || [] }); } catch { scan = null; }
      if (scan && !scan.mainSha) scan = null;
    }
    return scan;
  };
  const branches = b => { const s = sc(); if (!s) return null; const i = s.info(b); return { exists: i.exists, merged: i.merged, installed: i.installed, ref_date: i.ref_date }; };
  const shaMemo = {};
  const shas = x => {
    if (x in shaMemo) return shaMemo[x];
    const s = sc();
    const full = s ? (git(cfg.repo, ['rev-parse', '--verify', '--quiet', x + '^{commit}'], { allowFail: true }) || '').trim() : '';
    return (shaMemo[x] = !full ? null : git(cfg.repo, ['merge-base', '--is-ancestor', full, s.mainSha], { allowFail: true }) !== null);
  };
  const docs = p => fs.existsSync(path.isAbsolute(p) ? p : path.join(project.root || path.dirname(path.resolve(stateDir)), p));
  rows = [...rows, ...copyItems(stateDir, 'deliverable').map(dlvCopyRow)];
  const W = worldOf({ now, items: { ...st.items, ...Object.fromEntries(away.map(r => [r.id, r])) }, dlv: rows, branches, shas, docs, hasInstall, epics: epicsOf(stateDir), idle, policy: project.policy, home: homeOf(stateDir)?.id });
  W.repo = cfg.repo || null;
  return W;
}

function epicsOf(stateDir) {
  try { return Object.fromEntries(Object.entries(loadEpics(stateDir)).map(([id, e]) => [id, { state: e.state, title: e.data.title, members: epicMembers(e) }])); } catch { return {}; }
}

/** META-ROADMAP S3: the audit's Unplaced list (D3) for the digest - no git (lanes, DLV rows, directives, epics); null = no roadmap yet */
export function unplacedNow(stateDir, { now = Date.now(), items, dlv = [] } = {}) {
  const nodes = Object.values(hereLinks(loadRoadmap(stateDir), homeOf(stateDir)).items);
  if (!nodes.length) return null;
  return unplacedOf(nodes, worldOf({ now, items: items ?? loadState(stateDir).items, dlv, epics: epicsOf(stateDir), home: homeOf(stateDir)?.id }));
}

/** refuse links to what does not exist (SPEC sec. 1: the checkRefs rule epics use); a branch / sha needs the project's repo */
export function checkLinks(stateDir, links, { project = {}, git, now } = {}) {
  if (!links?.length) return;
  const W = world({ stateDir, project, git, now });
  if (!W.repo && links.some(t => /^(branch|sha):/.test(t))) throw new RoadmapError(`a branch / sha link needs the project's repo to check it (pass --project): ${links.filter(t => /^(branch|sha):/.test(t)).join(', ')}`);
  const gone = goneLinks(links, W);
  if (gone.length) throw new RoadmapError(`link to something that does not exist: ${gone.join(', ')}`);
}

// ---------- the tree (themes -> items -> stages -> runs) ----------
const SIG_KINDS = ['question', 'run', 'deliverable', 'epic', 'item'];
const sigOf = stateDir => SIG_KINDS.map(k => { try { const s = fs.statSync(recordsFile(stateDir, k)); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; } }).join('|');

/** the tree from a structure fold + a world (pure) */
export function treeOf(R, W, { project = null, title = null } = {}) {
  const all = Object.values(R.items);
  const mk = id => {
    const n = R.items[id], d = derive(n, W);
    const { history, ...node } = n;   // rev = the last event seq: a dashboard edit sends it back (409 once it moved on; S3)
    return { ...node, rev: history.at(-1)?.seq ?? null, ...d, flags: detect(n, d, W), children: childrenOf(R, id).map(mk) };
  };
  const themes = childrenOf(R, null).map(mk);
  const flat = ns => ns.flatMap(n => [...(n.kind === 'item' ? [n] : []), ...flat(n.children)]);
  const phases = ns => ({ past: ns.filter(i => i.phase === 'past').length, present: ns.filter(i => i.phase === 'present').length, future: ns.filter(i => i.phase === 'future').length });
  for (const t of themes) t.counts = phases(flat(t.children));
  const items = flat(themes), unplaced = unplacedOf(all, W);
  return { project, title, generated: new Date(W.now).toISOString(), themes, unplaced,
    counts: { items: items.length, ...phases(items), live: items.filter(i => i.live.length).length, drift: items.filter(i => i.flags.drift.length).length,
      claimed: items.filter(i => i.flags.claimed).length, idle: items.filter(i => i.flags.idle !== null).length, gone: items.filter(i => i.flags.gone.length).length, unplaced: unplaced.length } };
}

/**
 * The tree of a state dir. memo (an object kept by the caller) caches it on the records files' mtime + size: nothing changed and
 * younger than maxAgeMs (git-derived facts refresh at that age, as the dashboard's derived event) = the same tree, 0 work.
 */
export function buildTree({ stateDir, project = {}, now, git, memo = null, maxAgeMs = 60000, idle } = {}) {
  const sig = memo ? sigOf(stateDir) : null;
  if (memo && memo.sig === sig && Date.now() - memo.at < maxAgeMs) { memo.hits = (memo.hits || 0) + 1; return memo.tree; }
  project = project || {};
  const W = world({ stateDir, project, now: now ?? Date.now(), git, idle });
  const tree = treeOf(hereLinks(loadRoadmap(stateDir), homeOf(stateDir)), W, { project: project.name ?? path.basename(path.resolve(stateDir)), title: project.title || project.name || path.basename(path.resolve(stateDir)) });
  if (memo) Object.assign(memo, { sig, at: Date.now(), tree });
  return tree;
}

// ---------- rendering ----------
const flagWords = n => [n.flags.claimed, ...n.flags.drift.map(x => 'drift: ' + x), n.flags.idle !== null ? `idle ${n.flags.idle} d` : null,
  n.flags.gone.length ? 'link gone: ' + n.flags.gone.join(', ') : null, n.caveat ? `caveat (${n.caveat.by}, ${n.caveat.ts.slice(0, 10)}): ${n.caveat.text}` : null].filter(Boolean);
const head = tr => `${tr.title}: ${tr.counts.items} items - past ${tr.counts.past} / present ${tr.counts.present} / future ${tr.counts.future}; live ${tr.counts.live}; `
  + `drift ${tr.counts.drift}; claimed ${tr.counts.claimed}; idle ${tr.counts.idle}; link gone ${tr.counts.gone}; unplaced ${tr.counts.unplaced}`;

/** one item (and its children) as text lines */
export function renderItem(n, depth = 0) {
  const pad = '  '.repeat(depth), out = [];
  out.push(`${pad}${n.id}  ${n.status.padEnd(8)}  ${n.progress.done}/${n.progress.total}  ${n.title}${n.horizon ? ` [${n.horizon}]` : ''}${n.home ? `  (on ${n.home})` : ''}`);
  for (const e of n.pending || []) out.push(`${pad}      pending: ${e.ev} on ${e.home}, not yet committed on ${e.primary}`);   // RM-46 S3
  out.push(`${pad}      ${n.why}`);
  if (n.proof) out.push(`${pad}      ${lookWords(n)}`);   // META-CATCH S2
  if (n.stuck?.runs) out.push(`${pad}      ${stuckWords(n.stuck)}${n.stuck.flag ? ` - STUCK since ${n.stuck.flag.ts.slice(0, 16)}Z: ${n.stuck.flag.why.join(', ')}` : ''}`);
  for (const s of n.stages) out.push(`${pad}      - ${s.key}${s.lane ? ` (${s.lane})` : ''}: ${s.state}${s.run ? ` ${s.run}` : ''}`);
  for (const f of flagWords(n)) out.push(`${pad}      ! ${f}`);
  for (const c of n.children) out.push(...renderItem(c, depth + 1));
  return out;
}
/** the plain text tree `norn road show` prints */
export function renderTree(tr) {
  const out = [head(tr)];
  for (const t of tr.themes) {
    out.push('', `${t.id} ${t.title}  (past ${t.counts.past} / present ${t.counts.present} / future ${t.counts.future})${t.state === 'dropped' ? '  DROPPED' : ''}`);
    for (const c of t.children) out.push(...renderItem(c, 1));
  }
  out.push('', `Unplaced (${tr.unplaced.length})`, ...tr.unplaced.map(u => `  ${u.id}  ${u.why}`));
  return out.join('\n');
}
/** every item node of a tree, depth first in order */
export const itemsOf = tr => { const o = []; const walk = n => { if (n.kind === 'item') o.push(n); n.children.forEach(walk); }; tr.themes.forEach(walk); return o; };
export const findNode = (tr, id) => { let hit = null; const walk = n => { if (n.id === id) hit = n; n.children.forEach(walk); }; tr.themes.forEach(walk); return hit; };
/** D1-D5 for `norn road audit` -> { counts, claimed, drift, unplaced, idle, gone } */
export function auditOf(tr) {
  const xs = itemsOf(tr);
  return { counts: tr.counts, claimed: xs.filter(n => n.flags.claimed).map(n => ({ id: n.id, title: n.title, claim: n.flags.claimed })),
    drift: xs.flatMap(n => n.flags.drift.map(d => ({ id: n.id, title: n.title, drift: d }))), unplaced: tr.unplaced,
    idle: xs.filter(n => n.flags.idle !== null).map(n => ({ id: n.id, title: n.title, days: n.flags.idle })),
    gone: xs.filter(n => n.flags.gone.length).map(n => ({ id: n.id, title: n.title, links: n.flags.gone })) };
}
export function renderAudit(tr) {
  const a = auditOf(tr), out = [head(tr)];
  const sec = (name, rows, line) => out.push(`${name} (${rows.length})`, ...rows.map(r => '  ' + line(r)));
  sec('D1 claimed', a.claimed, r => `${r.id}  ${r.title}: ${r.claim}`);
  sec('D2 drift', a.drift, r => `${r.id}  ${r.title}: ${r.drift}`);
  sec('D3 unplaced', a.unplaced, r => `${r.id}  ${r.why}`);
  sec('D4 idle', a.idle, r => `${r.id}  ${r.title}: idle ${r.days} d`);
  sec('D5 link gone', a.gone, r => `${r.id}  ${r.title}: ${r.links.join(', ')}`);
  return out.join('\n');
}

// ---------- norn road apply: a whole plan as ONE batch (one lock) ----------
const SHORT = { lanes: 'lane', dir: 'dir', dec: 'dec', q: 'q', runs: 'run', dlv: 'dlv', epics: 'ep', branches: 'branch', shas: 'sha', docs: 'doc' };
export const refTerm = ref => (/^DIR-/.test(ref || '') ? ['dir:' + ref] : /^DEC-/.test(ref || '') ? ['dec:' + ref] : []);
/**
 * plan = { themes: [{ title, note?, links?, items: [node] }] }, node = { title, note?, horizon?, stages?, links? (kind:id terms) or the
 * short lists lanes / dir / dec / q / runs / dlv / epics / branches / shas / docs, caveat?, dropped? { why, ref }, items? [node] }
 * -> { events (creates refer to each other as $n), links (to check), counts { theme, item } }. Never a status: the records refuse one.
 * META-ADOPT A1: a theme with an `id` (RM-n) is an existing theme (no create; its items go under it); a node's `legacy` (the
 * importer's claim) is written as is, with legacy_by = o.legacy_by - the records take legacy only from role migration.
 */
export function planEvents(plan, by, o = {}) {
  const events = [], links = [], counts = { theme: 0, item: 0 };
  const add = (x, kind, parent) => {
    if (!x || typeof x.title !== 'string') throw new RoadmapError(`plan: every ${kind} needs a title`);
    const ls = [...(x.links || []), ...Object.entries(SHORT).flatMap(([k, lk]) => (x[k] || []).map(id => `${lk}:${id}`))];
    links.push(...ls);
    if (kind === 'theme' && x.id) { for (const c of x.items || []) add(c, 'item', x.id); return; }
    const data = { title: x.title, kind, ...(parent ? { parent } : {}), ...(x.horizon ? { horizon: x.horizon } : {}), ...(x.note ? { note: x.note } : {}),
      links: ls, ...(x.stages?.length ? { stages: x.stages } : {}), ...(x.status !== undefined ? { status: x.status } : {}),
      ...(x.legacy ? { legacy: x.legacy, ...(o.legacy_by ? { legacy_by: o.legacy_by } : {}) } : {}) };
    const i = events.push({ kind: 'item', ev: 'create', by, data }) - 1;
    counts[kind]++;
    if (x.caveat) events.push({ kind: 'item', ev: 'edit', id: '$' + i, by, data: { caveat: x.caveat } });
    for (const c of x.items || []) add(c, 'item', '$' + i);
    if (x.dropped) { links.push(...refTerm(x.dropped.ref)); events.push({ kind: 'item', ev: 'drop', id: '$' + i, by, data: { why: x.dropped.why, ref: x.dropped.ref } }); }
  };
  for (const t of plan?.themes || []) add(t, 'theme', null);
  if (!events.length) throw new RoadmapError('plan: no themes');
  return { events, links: [...new Set(links)], counts };
}

export const ROADMAP_HEADER = '<!-- GENERATED by norn from roadmap.jsonl + the derived status - edit with "norn road" or the dashboard; hand edits are refused -->';
const cell = v => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
/** the generated ROADMAP view (markdown); no timestamp, so an unchanged roadmap rewrites to the same bytes */
export function renderRoadmapView(tr) {
  const out = [ROADMAP_HEADER, `# Roadmap - ${tr.title}`, '',
    'Status is derived from runs, lanes, deliverables, git and questions at write time; it is never typed. Edit with `norn road`.', '', head(tr)];
  // META-ROADMAP S4 (SPEC sec. 5 step 4): the sections a hand-kept file typed are generated - the present, the work built but not at
  // the project's target, and the horizon order (record order within now / next / later)
  const xs = itemsOf(tr).filter(n => n.state !== 'dropped'), line = n => `- ${n.id} ${cell(n.title)} - ${n.status}: ${cell(n.why)}`;
  const list = ns => (ns.length ? ns.map(line) : ['- (none)']);
  out.push('', '## Now (present)', '', ...list(xs.filter(n => n.phase === 'present')));
  out.push('', '## Built, not at the target', '', ...list(xs.filter(n => n.status === 'built' || n.status === 'merged')));
  out.push('', '## Order (horizon)', '', ...['now', 'next', 'later'].map(h => `- ${h}: ${xs.filter(n => n.horizon === h).map(n => `${n.id} ${cell(n.title)}`).join('; ') || '(none)'}`));
  const rows = (n, depth) => [`| ${n.status} | ${'↳ '.repeat(depth)}${n.id} ${cell(n.title)} | ${n.progress.done}/${n.progress.total} | ${cell(n.why)} | ${cell(flagWords(n).join('; '))} |`,
    ...n.children.flatMap(c => rows(c, depth + 1))];
  for (const t of tr.themes) {
    out.push('', `## ${t.id} ${t.title} (past ${t.counts.past} / present ${t.counts.present} / future ${t.counts.future})${t.state === 'dropped' ? ' - dropped' : ''}`);
    if (!t.children.length) { out.push('', '(no items)'); continue; }
    out.push('', '| Status | Item | Progress | Why | Flags |', '|---|---|---|---|---|', ...t.children.flatMap(c => rows(c, 0)));
  }
  out.push('', `## Unplaced (${tr.unplaced.length})`, '', ...(tr.unplaced.length ? tr.unplaced.map(u => `- ${u.id}: ${cell(u.why)}`) : ['- (none)']));
  return out.join('\n') + '\n';
}

/** the view path: project.json views.roadmap, else <state>/views/ROADMAP.md */
export const roadmapViewPath = (stateDir, project = {}) => path.resolve(project?.views?.roadmap || path.join(stateDir, 'views', 'ROADMAP.md'));
/** write the view under the hand-edit guard -> written | unchanged | refused */
export const writeRoadmapView = (stateDir, tree, file = roadmapViewPath(stateDir)) =>
  writeGuarded(path.join(stateDir, 'views', 'roadmap-hashes.json'), file, renderRoadmapView(tree));
/** META-DASH-ASYNC R1: the dash server's form (fs.promises); the CLI and adopt keep writeRoadmapView */
export const writeRoadmapViewAsync = (stateDir, tree, file = roadmapViewPath(stateDir)) =>
  writeGuardedAsync(path.join(stateDir, 'views', 'roadmap-hashes.json'), file, renderRoadmapView(tree), { role: 'dashboard' });
