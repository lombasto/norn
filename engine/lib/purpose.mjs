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
export function laneDriver(name, { items = {}, roadmap = { items: {} }, briefTitle = () => null, briefsDir = null, project = '' } = {}) {
  const at = `?project=${q(project)}&tab=`, all = Object.values(items);
  const runs = all.filter(r => r.kind === 'run' && r.data?.lane === name).sort((a, b) => num(b.id) - num(a.id));
  // the briefs the lane ran, newest first (a merge brief is about landing, not the objective); else the lane's own brief
  const heads = laneBriefFiles(name, items, briefsDir).map(f => ({ file: f, head: briefTitle(f) })).filter(b => b.head);
  const headIds = pre => [...new Set(heads.flatMap(b => idsIn(b.head, pre)))];
  // rm: lane links, then run links (newest run first), then the ids a brief heading names; a dropped item drives nothing
  const rmItems = Object.values(roadmap.items || {}).filter(it => it.state !== 'dropped');
  const linked = t => rmItems.filter(it => (it.links || []).includes(t)).map(it => it.id);
  const rm = [...new Set([...linked(`lane:${name}`), ...runs.flatMap(r => linked(`run:${r.id}`)), ...headIds('RM').filter(id => rmItems.some(it => it.id === id))])]
    .map(id => roadmap.items[id]);
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
