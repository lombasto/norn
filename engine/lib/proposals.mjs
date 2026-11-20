// RM-28 S1: a finished design proposal reaches the Inbox as a decision. A planner run that ended DONE leaves its notes, its plan file
// and one brief-S<n>.md per proposed stage in its notes folder; this module turns that folder into ONE proposal (its 10-line summary,
// the plan path, the stages) and each stage into an owner pick: queue (launch the brief now, --item = the planner's roadmap item),
// later (a child roadmap item, horizon next, linking the brief) or drop. Every pick is a decision record (data.proposal = the planner
// run, data.stage = the stage key); a stage is open until it has one, or until a run was launched from its brief (a check-in did it
// by hand). Pure over folded items + the snapshot-aware file readers (fsnap.mjs: the dash primes them with primeProposals, never a
// sync read on a GET); the CLI (`norn proposal`) acts, the dashboard Inbox shows the cards. Node built-ins.
import path from 'node:path';
import { readText, readTextA, readdirS, readdirA } from './fsnap.mjs';

export const PICKS = ['queue', 'later', 'drop'];
export const PICK_WORDS = { queue: 'Queue now', later: 'Later', drop: 'Drop' };
const BRIEF_RE = /^brief-(S\d+)\.md$/i;
const fwd = p => String(p ?? '').replace(/\\/g, '/');
const same = (a, b) => fwd(a).toLowerCase() === fwd(b).toLowerCase();
const stageNum = k => Number(String(k).slice(1));
const listOr = d => readdirS(d).filter(e => e.isFile()).map(e => e.name);

/** is this run a planner run that ended DONE? (the role agent planner, any *-planner variant) */
export const isPlannerDone = r => r?.kind === 'run' && /(^|-)planner$/.test(r.data?.agent ?? '') && r.state === 'exited' && r.end?.outcome === 'done';

/** the owner summary of a planner NOTES text: the lines under the first heading that says "summary", at most 10, blank lines dropped */
export function summaryOf(text) {
  const ls = String(text ?? '').split(/\r?\n/), at = ls.findIndex(l => /^#{1,6}\s.*summary/i.test(l));
  if (at < 0) return [];
  const out = [];
  for (const l of ls.slice(at + 1)) { if (/^#{1,6}\s/.test(l)) break; if (l.trim()) out.push(l.trim()); if (out.length === 10) break; }
  return out;
}
/** a brief's one-line title: its first heading, after "S<n>:" when it names the stage ("# lane / S3: what" -> "what") */
export function briefTitle(text) {
  const h = String(text ?? '').split(/\r?\n/).find(l => /^#\s/.test(l));
  if (!h) return '';
  const t = h.replace(/^#\s+/, '').trim(), m = t.match(/\bS\d+\s*:\s*(.+)$/);
  return (m ? m[1] : t).trim();
}

/** the open roadmap item a planner run belongs to: one linking run:<id>, else one linking lane:<its lane>; null = none */
export function itemOf(R, run) {
  const open = Object.values(R?.items ?? {}).filter(n => n.kind === 'item' && n.state === 'open');
  return (open.find(n => n.links.includes('run:' + run.id)) ?? open.find(n => n.links.includes('lane:' + run.data?.lane)))?.id ?? null;
}

/** the picks recorded on a proposal: Map stage -> the decision (the newest in force) */
function picksOf(all, id) {
  const m = new Map();
  for (const d of all.filter(i => i.kind === 'decision' && i.data?.proposal === id && i.state === 'in-force').sort((a, b) => String(a.created).localeCompare(String(b.created)))) m.set(d.data.stage, d);
  return m;
}

/** every planner DONE with its proposal -> [{ run, lane, executor, worktree, notes, dir, item, summary [lines], plans [paths], ended,
 *  stages [{ key, brief, title, state open | queue | later | drop | launched, dec?, ref? }], open (count) }], newest first.
 *  o.all = also the proposals with no open stage left. o.read / o.list = file readers (tests). */
export function proposalsOf(items, R, { read = readText, list = listOr, all = false } = {}) {
  const xs = Object.values(items), out = [];
  for (const r of xs.filter(isPlannerDone)) {
    if (!r.data.notes) continue;
    const dir = path.dirname(r.data.notes), files = list(dir), briefs = files.filter(f => BRIEF_RE.test(f)).sort((a, b) => stageNum(a.match(BRIEF_RE)[1]) - stageNum(b.match(BRIEF_RE)[1]));
    if (!briefs.length) continue;
    const notes = read(r.data.notes) ?? '', picks = picksOf(xs, r.id);
    const plans = files.filter(f => /\.md$/i.test(f) && !BRIEF_RE.test(f) && !/^NOTES/i.test(f)).sort((a, b) => Number(!notes.includes(b)) - Number(!notes.includes(a)) || a.localeCompare(b)).map(f => fwd(path.join(dir, f)));
    const stages = briefs.map(f => {
      const key = f.match(BRIEF_RE)[1].toUpperCase(), brief = path.join(dir, f), d = picks.get(key);
      const launched = !d && xs.find(i => i.kind === 'run' && i.id !== r.id && i.data?.brief && same(i.data.brief, brief) && !['withdrawn'].includes(i.state));
      return { key, brief: fwd(brief), title: briefTitle(read(brief)), state: d ? d.data.pick : launched ? 'launched' : 'open', ...(d ? { dec: d.id, ref: d.data.run ?? d.data.item ?? null } : launched ? { ref: launched.id } : {}) };
    });
    const open = stages.filter(s => s.state === 'open').length;
    if (!open && !all) continue;
    out.push({ run: r.id, lane: r.data.lane ?? null, executor: r.data.executor ?? null, worktree: r.data.worktree ?? null, notes: fwd(r.data.notes), dir: fwd(dir),
      item: itemOf(R, r), summary: summaryOf(notes), plans, ended: r.end?.at ?? r.updated ?? r.created, stages, open });
  }
  return out.sort((a, b) => String(b.ended).localeCompare(String(a.ended)));
}

/** the dash (META-DASH-ASYNC): every planner DONE's notes folder, NOTES file and briefs into the request snapshot on fs.promises */
export async function primeProposals(items) {
  await Promise.all(Object.values(items).filter(r => isPlannerDone(r) && r.data.notes).map(async r => {
    const dir = path.dirname(r.data.notes), es = await readdirA(dir);
    await Promise.all([r.data.notes, ...es.filter(e => e.isFile() && BRIEF_RE.test(e.name)).map(e => path.join(dir, e.name))].map(readTextA));
  }));
}

/** the one open stage `key` of proposal `run`, or why not (a RuleError message) */
export function openStage(props, run, key) {
  const p = props.find(x => x.run === run);
  if (!p) return { why: `${run} is not a planner run that ended DONE with stage briefs in its notes folder (norn proposal list)` };
  const s = p.stages.find(x => x.key === String(key).toUpperCase());
  if (!s) return { why: `${run} proposes no stage ${key} (stages: ${p.stages.map(x => x.key).join(', ')})` };
  if (s.state !== 'open') return { why: `${run} ${s.key} is decided already: ${s.state}${s.dec ? ` (${s.dec})` : ''}${s.ref ? ` -> ${s.ref}` : ''}` };
  return { p, s };
}

/** the `norn run` argv that queues stage s of proposal p (its lane, worktree and executor; notes NOTES-<S>.md beside the planner's) */
export const queueArgv = (p, s) => ['run', '--queue', '--executor', p.executor || 'claude', '--lane', p.lane, '--stage', s.key, '--brief', s.brief,
  '--notes', fwd(path.join(p.dir, `NOTES-${s.key}.md`)), ...(p.worktree ? ['--worktree', p.worktree] : []), ...(p.item ? ['--item', p.item] : [])];

/** the roadmap create event of a Later pick: a child item of the planner's item, horizon next, linking the brief (doc:) */
export const laterItem = (p, s, by) => ({ kind: 'item', ev: 'create', by, data: { kind: 'item', title: `${p.lane} ${s.key}: ${s.title || path.basename(s.brief)}`.slice(0, 200),
  parent: p.item, horizon: 'next', note: `Proposed by ${p.run} (planner, lane ${p.lane}); brief ${s.brief}`, links: ['doc:' + s.brief] } });

/** the decision record of a pick (ref = the queued run / the roadmap item it made) */
export function pickDecision(p, s, pick, by, ref = null) {
  const choice = pick === 'queue' ? `queue now: ${ref} launches ${path.basename(s.brief)}${p.item ? ` (--item ${p.item})` : ''}`
    : pick === 'later' ? `later: roadmap item ${ref} under ${p.item}, horizon next` : 'drop: the stage is not built';
  return { kind: 'decision', ev: 'create', by, data: { lane: p.lane, proposal: p.run, stage: s.key, pick, ...(pick === 'queue' && ref ? { run: ref } : {}), ...(pick === 'later' && ref ? { item: ref } : {}),
    question: `Proposal ${p.run} (${p.lane}) ${s.key}: ${s.title || path.basename(s.brief)}`, choice, why: `The owner's pick on the Inbox proposal card of planner run ${p.run}.` } };
}

/** one line per proposal for the CLI */
export function renderProposals(props) {
  if (!props.length) return 'no open proposal';
  return props.map(p => [`${p.run}  lane ${p.lane}${p.item ? `  ${p.item}` : ''}  ${p.open} open of ${p.stages.length}`, ...(p.plans.length ? [`  plan ${p.plans.join(', ')}`] : []),
    ...p.summary.map(l => '  | ' + l), ...p.stages.map(s => `  ${s.key.padEnd(4)} ${s.state.padEnd(8)} ${s.title}${s.dec ? `  (${s.dec}${s.ref ? ` -> ${s.ref}` : ''})` : s.ref ? `  (${s.ref})` : ''}`)].join('\n')).join('\n\n');
}
