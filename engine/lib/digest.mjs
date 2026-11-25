// NORN-WATCH S1 (DIR-83, DEC-684; NORN-WATCH-SPEC.md sec. 3): the resume digest. LEVEL-triggered:
// every row comes from STATE on every call (DONE and not merged, a crash with no successor, an open Q, a directive nothing cites)
// and leaves only when the target state is reached - never because someone reviewed or read it. Read-only: writes no record.
// Sections: finished (not on main), queued (+ after / inputs, evaluated by S4), questions, ended (no clean successor), directives,
// ci (META-CIWATCH: the project's main CI is red - the run, its sha, its failing tests; leaves when a LATER main run is green),
// overlap (GAP-12: a running lane's changed files overlap a remote branch or open PR; leaves when the lane stops or the overlap goes),
// lanes (lifecycle.mjs: an idle or stopped lane the check-in must start / resume, park or archive; a worktree an archive left at risk),
// homes (RM-46 S1d: a synced dir's refused cross-home writes and copies that did not fold).
import { loadState, loadShared, heldLanes, holdWho, homeOf, laneName, SHARED_KINDS, KINDS } from './records.mjs';
import { deliverablesView, deliverableConfig, mergeBacklog, backlogMax } from './deliverables.mjs';
import { fwd } from './dlvmerge.mjs';
import { makeGit, isAncestor } from './dlvgit.mjs';
import { makeEval, condText } from './after.mjs';
import { readiness } from './runs.mjs';
import { projectCi } from './ciwatch.mjs';
import { unplacedNow } from './roadmap.mjs';
import { possibleAnswers } from './qreconcile.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { guardRows } from './guard.mjs';
import { runDrift } from './drift.mjs';
import { digestRow } from './slop/daily.mjs';
import { slopOn } from './policy.mjs';
import { adviceDigestRow } from './advice.mjs';
import { critiqueRows } from './critique.mjs';
import { dupPairs } from './dupdirs.mjs';
import { wholeHold, readHold, holdItem, noticeMin } from './holds.mjs';
import { overlapRows, overlapOn } from './overlap.mjs';
import { laneRules, lanePolicy, ciFixPlan, laneHooks, laneShippedIn } from './lifecycle.mjs';
import { readSync } from './claims.mjs';
import { readCollide } from './intents.mjs';
import { applyNeed, demotedWhy } from './collide.mjs';

const H = 3600e3;
export const WINDOW_H = 72;
const NOT_WORK = ['checkin', 'talk', 'interactive', 'fake', 'audit'];
const isWork = d => !NOT_WORK.includes(d.kind) && d.role !== 'helper' && !d.parent;
const endOf = r => r.history.find(h => ['end', 'lost', 'kill'].includes(h.ev)) || null;
const BAD_END = ['crash', 'no-result'];
const isMain = b => !b || b === 'HEAD' || b === 'main' || b === 'master';
const age = (now, ts) => +((now - Date.parse(ts)) / H).toFixed(1);

// "acknowledged, not acted": a review whose refs are only the run itself and / or the reviewing run. S5: a DEC / DIR that names the
// run - on_runs, refs, or its text (any event; the live DECs cite runs in question / choice / why, the sec. 5 rule) = acted, whatever
// its review says (cited = actedOn(items))
const actedOn = items => {
  const s = new Set();
  for (const i of items) {
    if (i.kind !== 'decision' && i.kind !== 'directive') continue;
    for (const d of [i.data, ...i.history.map(h => h.data)]) {
      for (const x of [...(d?.on_runs || []), ...(d?.refs || [])]) s.add(x);
      for (const m of JSON.stringify(d ?? null).matchAll(/\bRUN-(?:[a-z][a-z0-9]{0,15}-)?\d+(?!\d)/g)) s.add(m[0]);   // + a node run (META-GTP-FED)
    }
  }
  return s;
};
const reviewKind = (r, cited = new Set()) => {
  if (cited.has(r.id)) return 'acted';
  if (!r.review) return 'none';
  const h = [...r.history].reverse().find(x => x.ev === 'review');
  const own = new Set([r.id, h?.run].filter(Boolean));
  return (r.review.refs || []).every(x => own.has(x)) ? 'empty' : 'acted';
};

function finished(runs, dlvRows, { now, git, main, cited }) {
  const rows = [];
  for (const d of dlvRows) {   // DLV-MERGED-TRUTH: the state comes from deliverablesView (dlvMerged), the one merge rule
    if (d.state !== 'done' && d.state !== 'unknown') continue;
    if (d.record_state === 'parked' && !d.park?.expired) continue;
    if (d.record_state === 'superseded') continue;   // META-GTP-MERGEQ piece 0: terminal
    rows.push({ id: d.id, kind: 'deliverable', lane: d.lane ?? null, branch: d.branch ?? null, run: d.run ?? null, days: d.days ?? null,
      what: d.delivers || '', why: d.state === 'unknown' ? `${d.state_word}${d.ruling ? ` - ruling ${d.ruling} in the Inbox` : ''}` : 'done, not merged' });
  }
  const covered = new Set(dlvRows.map(d => d.run).filter(Boolean));
  for (const r of runs) {
    const e = endOf(r);
    if (!e || e.ev !== 'end' || e.data?.outcome !== 'done' || now - Date.parse(e.ts) > WINDOW_H * H) continue;
    const rk = reviewKind(r, cited);
    if (rk === 'acted' || covered.has(r.id)) continue;
    const wt = r.data.worktree;
    // S5: the branch + head recorded at the end win; the worktree's CURRENT branch (wrong once it is reused) is the fallback
    const out = e.data?.branch ? null : wt ? git(wt, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }) : null;
    const branch = e.data?.branch || (out ? out.trim() : null);
    if (branch && isMain(branch)) continue;                                  // committed on main itself
    if (branch && dlvRows.some(d => d.branch === branch && d.state !== 'done')) continue;
    if (branch && isAncestor(wt, e.data?.head || branch, main, git)) continue;   // merged
    rows.push({ id: r.id, kind: 'run', lane: r.data.lane ?? null, stage: r.data.stage ?? null, branch, worktree: fwd(wt) || null,
      review: rk, ended: e.ts, hours: age(now, e.ts), why: branch ? 'DONE, branch not on main' : 'DONE, worktree gone or unreadable: branch unknown' });
  }
  return rows;
}

// META-GTP-FED piece 3: the runs of the nodes, imported read-only by the home fill into <state>/fed-cache.json (never into runs.jsonl):
// a node run DONE in the window and not on main is a sec. 1 row like a home run; its branch is checked in the worktree of the home run it
// was claimed from (the node's own paths are the node's)
function nodeFinished(stateDir, items, { now, git, main, cited }) {
  let cache;
  try { cache = JSON.parse(fs.readFileSync(path.join(stateDir, 'fed-cache.json'), 'utf8')); } catch { return []; }
  const rows = [];
  for (const [node, runs] of Object.entries(cache?.nodes || {})) for (const r of runs || []) {
    const e = endOf(r);
    if (!e || e.ev !== 'end' || e.data?.outcome !== 'done' || now - Date.parse(e.ts) > WINDOW_H * H || cited.has(r.id) || !isWork(r.data || {})) continue;
    const wt = items[r.data?.claim_of?.run]?.data?.worktree || null;
    const branch = e.data?.branch || null;
    if (branch && isMain(branch)) continue;
    if (branch && wt && isAncestor(wt, e.data?.head || branch, main, git)) continue;
    rows.push({ id: r.id, kind: 'run', node, lane: r.data?.lane ?? null, stage: r.data?.stage ?? null, branch, worktree: fwd(wt) || null, review: 'none',
      ended: e.ts, hours: age(now, e.ts), claim_of: r.data?.claim_of?.run ?? null, why: branch ? `DONE on node ${node}, branch not on main` : `DONE on node ${node}, branch unknown` });
  }
  return rows;
}

function ended(runs, { now }) {
  const rows = [];
  for (const r of runs) {
    const e = endOf(r);
    if (!e || now - Date.parse(e.ts) > WINDOW_H * H) continue;
    const bad = r.state === 'lost' || r.state === 'killed' || (r.state === 'exited' && BAD_END.includes(e.data?.outcome));
    if (!bad) continue;
    const stage = r.data.stage ?? null;
    const next = runs.find(x => x.id !== r.id && x.data.lane === r.data.lane && (x.data.stage ?? null) === stage && Date.parse(x.created) >= Date.parse(e.ts));
    if (next) continue;
    rows.push({ id: r.id, lane: r.data.lane ?? null, stage, state: r.state, outcome: e.data?.outcome ?? r.state, exit: e.data?.exit ?? null,
      dirty: e.data?.dirty ?? null, external_term: e.data?.external_term ?? null, ended: e.ts, hours: age(now, e.ts),
      worktree: fwd(r.data.worktree) || null, notes: r.data.notes ?? null });
  }
  return rows;
}

function questions(items, { now }) {
  const qs = items.filter(i => i.kind === 'question' && ['open', 'answered'].includes(i.state));
  const rank = q => (q.state === 'open' ? (q.data.owner_only ? 0 : 1) : 2);
  // META-Q-RECONCILE R1: an open Q a later DEC on its lane may already answer (owner words / OWNER PICK / its evidence paths)
  const pa = new Map(possibleAnswers(items).map(x => [x.q, x]));
  // item 8 (MAIL-9 c): the check-ins that started after the owner's answer and ended without applying it (RUN-61, RUN-68 on Q-1) - a miss
  const checkins = items.filter(i => i.kind === 'run' && i.data?.kind === 'checkin' && !['queued', 'claimed', 'running'].includes(i.state));
  const missed = q => { const at = q.history.findLast(h => h.ev === 'answer')?.ts; return at ? checkins.filter(r => r.created >= at).map(r => r.id) : []; };
  return qs.sort((a, b) => rank(a) - rank(b) || Date.parse(a.created) - Date.parse(b.created))
    .map(q => ({ id: q.id, state: q.state, owner_only: !!q.data.owner_only, lane: q.data.lane ?? null, title: q.data.title ?? '', hours: age(now, q.created),
      ...(pa.has(q.id) ? { answered_by: pa.get(q.id).dec, answered_why: pa.get(q.id).why } : {}), ...(q.state === 'answered' ? { missed: missed(q) } : {}) }));
}

function directives(items, { now }) {
  const cites = items.filter(i => i.kind === 'decision' || i.kind === 'run').map(i => JSON.stringify([i.data, i.history.map(h => h.data)]));
  return items.filter(i => i.kind === 'directive' && i.state === 'active' && now - Date.parse(i.created) <= WINDOW_H * H)
    .filter(i => { const re = new RegExp(`\\b${i.id}(?!\\d)`); return !cites.some(t => re.test(t)); })
    .map(i => ({ id: i.id, text: String(i.data.text || '').split('\n')[0].slice(0, 200), hours: age(now, i.created) }));
}

// S4: evalAfter (after.mjs makeEval) -> { met, gone }; a row shows the condition text, met and why it is gone (the fill holds it: needs a ruling)
// META-GTP-DAG piece 3: + ready / terms of the dry fill walk (runs.mjs readiness - the fill's own evaluator), rows in fill order
function queued(runs, { evalAfter, ready }) {
  const R = new Map(ready.map((r, i) => [r.id, { ...r, order: i }]));
  return runs.filter(r => r.state === 'queued').sort((a, b) => (R.get(a.id)?.order ?? 1e9) - (R.get(b.id)?.order ?? 1e9)).map(r => ({ id: r.id, lane: r.data.lane ?? null, stage: r.data.stage ?? null, not_before: r.data.not_before ?? null,
    after: (r.data.after || []).map(c => { const v = evalAfter(c); return { cond: condText(c), met: v.met, gone: v.gone }; }), inputs: r.data.inputs || [],
    ...(R.has(r.id) ? { ready: R.get(r.id).ready, terms: R.get(r.id).terms } : {}) }));
}

// META-CIWATCH: the cached gh read of ciwatch.mjs (one gh call at most; gh absent = no row); the cache lives in the digest's state dir.
function ciRed(project, { now, st }) {
  const r = projectCi(project, new Date(now))?.red;
  return r ? [{ id: `CI-${r.databaseId}`, repo: project.ci.repo, run: r.databaseId, sha: r.headSha ?? null, conclusion: r.conclusion, created: r.createdAt,
    hours: age(now, r.createdAt), failing: r.failing, fix: ciFixPlan(st, { run: r.databaseId }) }] : [];   // lifecycle.mjs: the ONE ci-fix lane
}

/**
 * digest(stateDir, project, { now (ms), git (makeGit()), dlv (deliverablesView rows; default computed), evalAfter }) ->
 * { project, at, window_h, sections: { finished, queued, questions, ended, directives, ci, roadmap (only once the project has a roadmap) }, counts }
 */
export function digest(stateDir, project = {}, { now = Date.now(), git = makeGit(), dlv = null, evalAfter = null, ready = null } = {}) {
  const st = loadState(stateDir);
  const items = Object.values(st.items);
  const runs = items.filter(i => i.kind === 'run' && isWork(i.data));
  let dlvRows = dlv;
  if (!dlvRows) dlvRows = deliverablesView({ stateDir, project, now, git }).rows;   // a git failure is an unknown row there, never a throw
  const main = deliverableConfig(project).main;
  const sections = {
    finished: [...finished(runs, dlvRows, { now, git, main, cited: actedOn(items) }), ...nodeFinished(stateDir, st.items, { now, git, main, cited: actedOn(items) })],
    queued: queued(items.filter(i => i.kind === 'run'), { evalAfter: evalAfter || makeEval(stateDir, { git }), ready: (ready ||= readiness(stateDir, { now })) }),
    questions: questions(items, { now }),
    ended: ended(runs, { now }),
    directives: directives(items, { now }),
    ci: ciRed({ ...project, state: stateDir }, { now, st }),
  };
  // META-CONTROLLER C4 (SPEC sec. 2): the lanes the controller holds - a check-in skips them (its writes there exit 5); only while one is held
  const held = heldLanes(st.items, now);
  if (held.length) sections.held = held.map(h => ({ id: h.id, lane: h.lane, holder: h.holder, who: holdWho(h), until: h.until,
    min: Math.max(0, Math.ceil((Date.parse(h.until) - now) / 60000)), why: h.why }));
  // GAP-1 (holds.mjs): ALL queued work waits on one machine-level hold (usage guard / PAUSED) past policy.holds.notice_min - ONE row, first;
  // the walk says it holds NOW, hold.json (the tick's) says since when; it leaves when the walk no longer holds
  const hw = wholeHold(ready), hr = hw ? readHold(stateDir) : null;
  if (hw && hr?.term === hw.term) {
    let status = ''; try { status = fs.readFileSync(path.join(stateDir, 'STATUS.md'), 'utf8'); } catch { /* no reset words */ }
    const it = holdItem({ ...hr, ...hw }, { now, min: noticeMin(project?.policy), status });
    if (it) sections.hold = [{ id: 'HOLD', term: it.term, scope: it.scope, runs: it.runs, merges: it.merges, since: it.since, min: it.minutes, reason: it.reason, fix: it.fix, clears: it.clears }];
  }
  // MERGE-FIRST (4): over policy.merge.backlog_max finished-but-unlanded deliverables - ONE row; the check-in lands work before it starts lanes
  const bl = mergeBacklog(dlvRows || [], { now, max: backlogMax(project?.policy) });
  if (bl.over) sections.backlog = [{ id: 'MERGE-BACKLOG', n: bl.n, oldest_h: bl.oldest_h, max: bl.max, ids: bl.ids }];
  // the audit's Unplaced list stays in the digest until it is 0 (a check-in duty)
  const rm = unplacedNow(stateDir, { now, items: st.items, dlv: dlvRows });
  if (rm) sections.roadmap = rm.map(u => ({ id: u.id, kind: u.kind, why: u.why }));
  // META-GUARD R1: the open usage alarms (runaway / over the hand-off line / tool spam) - the check-in rules each; only while any is open
  const g = [...guardRows(stateDir), ...driftRows(runs, { now, git, main })];   // + item 3: the brief drift of an ended, unreviewed run
  if (g.length) sections.guard = g;
  // META-SLOP-A: ONE line - the last daily slop report + the branches slop holds now
  const sl = slopOn(project?.policy) ? digestRow(stateDir, now) : null;   // META-BETA-PREP: not while the one switch is off
  if (sl) sections.slop = [sl];
  // META-TEND P4: ONE line - the open model-advice cards (advice.json, the last count the Spend page / norn advise made)
  const adv = adviceDigestRow(stateDir);
  if (adv) sections.advice = [adv];
  // META-DOD 3: the plan reviews with findings (or no clean end) the check-in has not reviewed yet - the builds they hold wait for it
  const cr = critiqueRows(st.items);
  if (cr.length) sections.critique = cr;
  // gap #5: two active directives where the newer restates the older - the check-in folds them (supersede the older by the newer)
  const dd = dupPairs(st.items);
  if (dd.length) sections.dupdirs = dd;
  // GAP-12: a running lane whose changed files overlap a remote branch / open PR (overlap.mjs; the tick and a lane start refresh the
  // cache, the digest only reads it) - the check-in decides: carry on, rebase onto it, or ask the owner
  const ov = overlapOn(project?.policy) ? overlapRows(stateDir, st.items) : [];
  if (ov.length) sections.overlap = ov;
  // lane norn-lifecycle item 5: no lane sits - each idle / stopped lane is the check-in's to act on this pass (CHECKIN.md 2j); a worktree a
  // tick archive kept (dirty or not on main) stays a row while it exists. Only while any.
  const ln = [...laneRules(st, { now, ...lanePolicy(project?.policy), home: homeOf(stateDir)?.id ?? null, shipped: laneShippedIn(stateDir) }).filter(x => x.act === 'checkin').map(x => ({ id: x.id, lane: x.lane, rule: x.rule, run: x.run, why: x.why })),
    ...atRisk(stateDir, items), ...offMain(stateDir, items, now)];
  if (ln.length) sections.lanes = ln;
  // RM-46 S2b: the multi-home work claims - queued runs a claim holds ("held by <home>"), drift / fenced / taken-over events, stale
  // claims of other homes (the owner may take them over); only while any is there
  const cl = claimRows(stateDir, st.items);
  if (cl.length) sections.claims = cl;
  // RM-46 S1d (SPEC 3.7): this home's writes another home refused (or a create it may not make) and the copies that did not fold
  const hm = homeRows(stateDir);
  if (hm.length) sections.homes = hm;
  // lane-collide S1c (SPEC 4A.5): the open collisions of the last tick (collide.json, level-triggered: a row leaves when its cause is gone),
  // each with SloppaChoppa's pick; what Norn handled by itself in the last day, each with its undo; the other homes' `**` claims
  const co = collideRows(stateDir, project?.policy?.collide, now);
  if (co.length) sections.collisions = co;
  const counts = Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.length]));
  return { project: project?.name ?? null, at: new Date(now).toISOString(), window_h: WINDOW_H, sections, counts };
}

// item 9 (lanepaths.mjs tickPaths): a lane whose finished work is red on its path to main - at risk, or off main past OFF_MAIN_H with no
// merge step - is a row (rule off-main) until it reaches a PR
const offMain = (stateDir, items, now) => { const h = laneHooks(stateDir);
  return items.filter(l => l.kind === 'lane' && ['active', 'done'].includes(l.state)).flatMap(l => { const x = h.path(laneName(l.id, stateDir), now);
    return x?.red ? [{ id: l.id, lane: x.lane, rule: 'off-main', run: x.run, why: `${x.text} - stage its merge (or say why not)` }] : []; }); };
// an archived lane whose archive kept its worktree (lifecycle.mjs dropWorktree: uncommitted changes / commits not on main), while it exists
const atRisk = (stateDir, items) => items.filter(l => l.kind === 'lane' && l.state === 'archived').flatMap(l => {
  const a = l.history.findLast(h => h.ev === 'archive')?.data?.at_risk, wt = a ? a.slice(0, a.lastIndexOf(': ')) : null;
  return wt && fs.existsSync(wt) ? [{ id: l.id, lane: laneName(l.id, stateDir), rule: 'at-risk', run: null, why: `work at risk: ${a} - commit / merge it or remove the worktree by hand` }] : [];
});
// RM-46 S2b: <state>/sync/claim-holds.json (runs.mjs claimDoor) for runs still queued + <state>/sync/claims-digest.json (tick.mjs claimsPass)
function claimRows(stateDir, items) {
  const holds = Object.entries(readSync(stateDir, 'holds')).filter(([id]) => items[id]?.state === 'queued')
    .map(([id, h]) => ({ id, kind: 'held', lane: items[id].data.lane ?? null, home: h.home, why: h.home ? `held by ${h.home}: ${h.why}` : `held: ${h.why}` }));
  const r = readSync(stateDir, 'rows');
  return [...holds, ...(r.events || []).map(e => ({ id: e.id, kind: e.kind, at: e.at, why: e.why })), ...(r.stale || [])];
}

// lane-collide S2a: the card's "Do:" line - the pick itself when a check-in may apply it (policy.collide.apply_by), else the ask that hands it on
const doOf = (r, policy) => { const p = r.pick?.remedy; if (!r.col || !p) return null;
  return applyNeed(p, r.kind, r.grade, policy) === 'checkin' ? `META collide ${p} ${r.col} --as checkin --why W` : `META collide ask ${r.col} --want ${p} --as checkin --why W`; };
// S3: a demoted class is said once - one line, for a day from the pass that first saw it
function collideRows(stateDir, policy, now = Date.now()) {
  const c = readCollide(stateDir);
  return [...(c.rows || []).map(r => ({ id: r.col, kind: r.kind, grade: r.grade, verdict: r.verdict, lane: r.lane, run: r.run, other: r.other, why: r.why, files: r.files, files_n: r.files_n, pick: r.pick, do: doOf(r, policy) })),
    ...(c.handled || []).map(h => ({ id: h.col, kind: 'handled', of: h.kind, grade: h.grade, action: h.action, at: h.at, lane: h.lane, why: h.why, undo: h.undo ? `META collide undo ${h.col} --why W` : null })),
    ...(c.wide || []).map(w => ({ id: w.key, kind: 'wide-claim', home: w.home, lane: w.lane, why: w.why })),
    ...(c.demoted || []).filter(d => now - Date.parse(d.since) < 864e5).map(d => ({ id: `demoted:${d.cls}`, kind: 'demoted', cls: d.cls, why: demotedWhy(d) }))];
}

// a synced dir: the conflicts whose writer is this home + every integrity row, over each shared log (records, roadmap, mail, waivers)
function homeRows(stateDir) {
  const h = homeOf(stateDir);
  if (!h) return [];
  return SHARED_KINDS.filter((k, i, a) => a.findIndex(x => KINDS[x].file === KINDS[k].file) === i).flatMap(k => {
    const v = loadShared(stateDir, k);
    return [...v.conflicts.filter(c => c.home === h.id).map(c => ({ id: c.id, kind: 'conflict', home: c.primary ?? c.home, ev: c.ev, why: c.why })),
      ...v.integrity.map(x => ({ id: x.id ?? `${x.home}:${KINDS[k].file}`, kind: 'integrity', home: x.home, why: x.why }))];
  });
}

/** the digest, or { error } when it cannot be built: a status / boot surface shows the error and never fails because of it */
export function tryDigest(stateDir, project = {}, opts = {}) {
  try { return digest(stateDir, project || {}, opts); } catch (e) { return { error: e.message }; }
}
/** { section: [ids] } - the compact form for norn_boot's state digest */
export const digestIds = d => Object.fromEntries(Object.entries(d.sections).map(([k, v]) => [k, v.map(r => r.id)]));

// META-GUARD R1 item 3: the brief drift of each run that ended (exited) in the window and has no review yet - a hint row for the
// check-in (digest row 8), only when an item is not mentioned or a file lies outside the brief's areas. Read-only (git diff).
function driftRows(runs, { now, git, main }) {
  const rows = [];
  for (const r of runs) {
    const e = endOf(r);
    if (r.state !== 'exited' || !e || now - Date.parse(e.ts) > WINDOW_H * H || r.history.some(h => h.ev === 'review')) continue;
    const d = runDrift(r, { git, main });
    if (d?.hint) rows.push({ id: r.id, run: r.id, kind: 'drift', cls: 'drift', lane: r.data.lane ?? null, why: d.hint });
  }
  return rows;
}
