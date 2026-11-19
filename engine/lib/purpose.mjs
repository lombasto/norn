// RM-34: why a lane exists - its driver, derived from the records (no hand-kept field): the objective in one line and where it is
// written. Pure over a loadState() fold + a foldRoadmap() fold; the brief's first heading comes from the caller's briefTitle(path)
// (the dash primes the files first: no sync read in a GET). Order of the sources (the first one that exists names the objective):
//   rm    the roadmap items that link the lane (lane:<name>) or one of its runs (run:RUN-n, the launcher's --item link), and the RM-n
//         ids in the heading of a brief the lane ran (a brief names its item: "task lane-purpose S1 (RM-34) - ...")
//   dir   the live directives scoped to the lane (an owner `lane new --task` writes one) or named in a brief heading; superseded ones
//         give way to their restatement
//   q/dec only when no item or directive drives the lane: its open questions and the decisions taken on it
//   brief the newest brief a non-merge run of the lane ran (else the lane's own <briefs_dir>/<lane>.md): where the task is written
//   doc   the doc:<path> links of the driving roadmap items
// No source at all = the finding 'no recorded driver' (lane norn-lifecycle's idle / orphan rules read it; this module only names it).
import path from 'node:path';
import { isMergeRun } from './checkins.mjs';

export const NO_DRIVER = 'no recorded driver';
const num = id => Number(String(id).match(/(\d+)$/)?.[1] ?? 0);
const firstLine = s => String(s ?? '').split(/\r?\n/).map(x => x.trim()).find(Boolean) ?? '';
// a directive's text often opens with its heading ("## 7. Queue watchdog: ...") - the words without the markdown
const plain = s => firstLine(s).replace(/^#+\s*/, '').replace(/^\d+\.\s+/, '').replace(/\*\*/g, '').trim();
/** a brief's first heading -> the objective: "task <lane> <stage> (RM-n) - the words" -> "the words"; a bare heading stays */
export const briefObjective = h => { const t = plain(h); const m = t.match(/^task\s.*?\s-\s(.+)$/); return m ? m[1].trim() : t; };
const idsIn = (s, pre) => [...new Set(String(s ?? '').match(new RegExp(`\\b${pre}-\\d+\\b`, 'g')) || [])];
const q = s => encodeURIComponent(s);
// a landing run (MERGE, a re-staged MERGE2, a deliverable's conflict `resolve`) runs a brief about the merge, not the lane's objective
const landing = d => isMergeRun(d) || /^(merge\d*|resolve)$/i.test(String(d?.stage ?? ''));
const taskBriefs = (name, items) => [...new Set(Object.values(items).filter(r => r.kind === 'run' && r.data?.lane === name && r.data.brief && !landing(r.data))
  .sort((a, b) => num(b.id) - num(a.id)).map(r => r.data.brief))];
/** the brief files laneDriver may read for lane `name`, newest first (the dash primes them before the call) */
export const laneBriefFiles = (name, items = {}, briefsDir = null) => { const f = taskBriefs(name, items); return f.length ? f : briefsDir ? [path.join(briefsDir, `${name}.md`)] : []; };
const base = f => String(f).split(/[\\/]/).pop();   // a run's brief path is Windows-style (backslashes) on any platform

/**
 * laneDriver(name, { items, roadmap, briefTitle, briefsDir, project }) -> { objective (one line) | null, sources: [{ kind, id, title, href }],
 * finding: NO_DRIVER | null }. items = loadState(...).items; roadmap = foldRoadmap(...) ({ items }); briefTitle(path) -> the brief's first
 * heading | null (missing); briefsDir = the project's briefs_dir (the lane's own brief); project = the dashboard's ?project= (hrefs).
 * href: rm -> the Roadmap item, dir / dec -> Records, q -> Inbox, brief / doc -> the Docs viewer (key brief:<file> / doc:<path>).
 */
const laneRuns = (name, items) => Object.values(items).filter(r => r.kind === 'run' && r.data?.lane === name).sort((a, b) => num(b.id) - num(a.id));
// rm: lane links, then run links (newest run first), then the ids a brief heading names; a dropped item drives nothing
function rmOf(name, runs, heads, roadmap) {
  const rmItems = Object.values(roadmap.items || {}).filter(it => it.state !== 'dropped');
  const linked = t => rmItems.filter(it => (it.links || []).includes(t)).map(it => it.id);
  return [...new Set([...linked(`lane:${name}`), ...runs.flatMap(r => linked(`run:${r.id}`)), ...heads.flatMap(b => idsIn(b.head, 'RM')).filter(id => rmItems.some(it => it.id === id))])]
    .map(id => roadmap.items[id]);
}

export function laneDriver(name, { items = {}, roadmap = { items: {} }, briefTitle = () => null, briefsDir = null, project = '' } = {}) {
  const at = `?project=${q(project)}&tab=`, all = Object.values(items);
  const runs = laneRuns(name, items);
  // the briefs the lane ran, newest first (a merge brief is about landing, not the objective); else the lane's own brief
  const heads = laneBriefFiles(name, items, briefsDir).map(f => ({ file: f, head: briefTitle(f) })).filter(b => b.head);
  const headIds = pre => [...new Set(heads.flatMap(b => idsIn(b.head, pre)))];
  const rm = rmOf(name, runs, heads, roadmap);
  // dir: scoped to the lane or named in a brief heading, not superseded (its restatement is scoped too)
  const dirs = all.filter(d => d.kind === 'directive' && !d.superseded_by && d.state !== 'revoked'
    && ((d.data?.scope || []).includes(name) || headIds('DIR').includes(d.id))).sort((a, b) => num(a.id) - num(b.id));
  const qs = rm.length || dirs.length ? [] : all.filter(x => (x.kind === 'question' && x.state === 'open' || x.kind === 'decision') && x.data?.lane === name)
    .sort((a, b) => num(a.id) - num(b.id));
  const sources = [
    ...rm.map(it => ({ kind: 'rm', id: it.id, title: plain(it.title), href: `${at}roadmap#rm-${it.id}` })),
    ...dirs.map(d => ({ kind: 'dir', id: d.id, title: plain(d.data.text), href: `${at}records` })),
    ...qs.map(x => x.kind === 'question' ? { kind: 'q', id: x.id, title: plain(x.data.title ?? x.data.body), href: `${at}inbox` }
      : { kind: 'dec', id: x.id, title: plain(x.data.question ?? x.data.choice), href: `${at}records` }),
    ...heads.slice(0, 1).map(b => { const key = `brief:${base(b.file)}`; return { kind: 'brief', id: base(b.file), title: briefObjective(b.head), href: `${at}docs&doc=${q(key)}`, doc: key }; }),
    ...[...new Set(rm.flatMap(it => (it.links || []).filter(l => l.startsWith('doc:')).map(l => l.slice(4))))]
      .map(p => ({ kind: 'doc', id: p, title: base(p), href: `${at}docs&doc=${q('doc:' + p)}`, doc: `doc:${p}` })),
  ];
  return { objective: sources[0]?.title || null, sources, finding: sources.length ? null : NO_DRIVER };
}

// MAIL-29 (owner: "nothing in the lanes tab shows what type of lane it is"): the lane's TYPE and where its OUTPUT goes, derived.
// The type is the CURRENT stage's (a lane planned, then built, reads build once S1 starts); a landing run (MERGE) is shown beside the
// type as what the lane is doing now, never as its type. The signals, first one that answers wins (it is the chip's tooltip):
//   1. the current run: a check-in; agent planner or a plan / guide / design stage = design; a red-main stage or a ci-fix lane = CI fix
//   2. the words of the current run's brief heading (a brief naming bugs = bug fix; refactor, docs, audit)
//   3. the words of the roadmap items driving the lane, then of their theme
//   4. the conventional-commit types of the lane's branch tips (the caller passes them: git never runs in a GET)
//   5. a build stage (S<n>, build) or the implementer agent = build
export const LANE_TYPES = ['design', 'build', 'bug fix', 'CI fix', 'refactor', 'docs', 'audit', 'check-in'];
const TYPE_WORDS = [['bug fix', /\b(bugs?|broken|regressions?|crash(es)?)\b/i], ['refactor', /\b(refactor\w*|tech debt|legacy)\b/i],
  ['docs', /\b(docs|documentation|readme)\b/i], ['audit', /\b(audit|investigat\w*)\b/i]];
const CC_TYPE = { feat: 'build', perf: 'build', fix: 'bug fix', refactor: 'refactor', docs: 'docs', ci: 'CI fix' };
const wordType = s => { for (const [t, re] of TYPE_WORDS) { const m = String(s ?? '').match(re); if (m) return { type: t, word: m[0] }; } return null; };
/** the conventional-commit type of a subject ("fix(queue): ..." -> fix) | null */
export const ccType = s => String(s ?? '').match(/^(\w+)(\([^)]*\))?!?:/)?.[1]?.toLowerCase() ?? null;
const themeOf = (it, roadmap) => { let n = it; for (let i = 0; n?.parent && i < 9; i++) n = roadmap.items?.[n.parent]; return n && n !== it && n.kind === 'theme' ? n : null; };

/**
 * laneType(name, { items, roadmap, briefTitle, commits }) -> { type (one of LANE_TYPES) | null, signal (the words that decided it),
 * now: the stage of a landing run in flight (MERGE) | null }. commits = the conventional-commit subjects of the lane's branch tips.
 */
export function laneType(name, { items = {}, roadmap = { items: {} }, briefTitle = () => null, commits = [] } = {}) {
  const runs = laneRuns(name, items), last = runs[0]?.data, cur = runs.find(r => !landing(r.data)), d = cur?.data ?? {};
  const now = last && landing(last) && ['queued', 'running'].includes(runs[0].state) ? last.stage : null, is = (type, signal) => ({ type, signal, now });
  if (name === 'checkin' || last?.kind === 'checkin') return is('check-in', `${runs[0]?.id ?? name}: a check-in`);
  if (d.agent === 'planner') return is('design', `${cur.id}: agent planner`);
  if (/^(plan|guide|design)$/i.test(d.stage ?? '')) return is('design', `${cur.id}: stage ${d.stage}`);
  if (/^red-main$/i.test(d.stage ?? '') || /^ci-fix\d*$/.test(name)) return is('CI fix', cur ? `${cur.id}: stage ${d.stage}` : `lane ${name}`);
  const head = d.brief ? briefTitle(d.brief) : null, bw = wordType(head);
  if (bw) return is(bw.type, `brief ${base(d.brief)}: "${bw.word}"`);
  const rm = rmOf(name, runs, head ? [{ head }] : [], roadmap);
  for (const it of rm) { const w = wordType(it.title); if (w) return is(w.type, `${it.id}: "${w.word}"`); }
  for (const it of rm) { const t = themeOf(it, roadmap), w = t && wordType(t.title); if (w) return is(w.type, `${it.id}'s theme ${t.id}: "${w.word}"`); }
  const cc = {}; for (const s of commits) { const t = CC_TYPE[ccType(s)]; if (t) cc[t] = (cc[t] || 0) + 1; }
  const top = Object.entries(cc).sort((a, b) => b[1] - a[1])[0];
  if (top) return is(top[0], `commits: ${Object.entries(cc).map(([t, k]) => `${t} ${k}`).join(', ')}`);
  if (cur && (d.agent === 'implementer' || /^(S\d+|build)$/i.test(d.stage ?? ''))) return is('build', `${cur.id}: ${d.agent === 'implementer' ? 'agent implementer' : `stage ${d.stage}`}`);
  return is(null, cur ? `${cur.id}: no stage, brief, item or commit names a type` : 'no run yet');
}

/**
 * laneOutput(type, { deliverables, notes, repo }) -> { kind: 'code' | 'documents', text, href } | null: where the lane's work goes.
 * code: a PR to <repo> and today's state (no PR yet / PR #n open / merged) from the lane's newest deliverables row (the dash's cache,
 * never git in a GET); documents (a design or audit lane with no deliverable): its notes folder, which is not in git. A check-in or a
 * lane of no type and no deliverable: null.
 */
export function laneOutput(type, { deliverables = [], notes = null, repo = null } = {}) {
  const row = [...deliverables].sort((a, b) => num(b.id) - num(a.id))[0];
  if (!row && (type === 'design' || type === 'audit')) return { kind: 'documents', text: `documents → ${notes ?? 'the lane notes'} (not in git; backed up only if the ledger is on)`, href: null };
  if (!row && (!type || type === 'check-in')) return null;
  const to = row?.pr?.url?.match(/github\.com\/([^/]+\/[^/]+)\/pull\//)?.[1] ?? (row?.repo ? base(row.repo) : repo);
  const merged = row && ['merged', 'installed'].includes(row.state);
  const st = merged ? 'merged' : row?.pr ? `PR #${row.pr.number ?? '?'} open` : 'no PR yet';
  return { kind: 'code', text: `code → PR to ${to ?? 'the repo'} · ${st}`, href: row?.pr?.url ?? null };
}
