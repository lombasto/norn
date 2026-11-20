// OVERVIEW-TRUTH (2): why a DONE deliverable is not merged, in words with a link - one rule, read by deliverablesView, so the CLI,
// the Overview, the Inbox and the drawer say the same thing. Owner report 2026-11-19: done rows read only "done / clean" with no
// reason they sat unmerged. Pure over a loadState() fold; the MERGE run's STOPPED line comes from its MERGE-NOTES (readNotes).
import { isLandingStage } from './runs.mjs';
import { idNum } from './records.mjs';

const LIVE = ['running', 'queued', 'claimed'];
// the STOPPED line a merge worker wrote to its notes (MERGE-NOTES.md), else the outcome's why
export const stoppedLine = text => String(text ?? '').split(/\r?\n/).map(l => l.trim()).filter(l => /\bSTOPPED\b/.test(l)).pop()?.replace(/^[#>*\-\s]+/, '').replace(/^STOPPED\s*[:\-]?\s*/, '') || null;

/**
 * row (a deliverablesView row) -> { kind, text, warn, run?, url?, position? } | null (null: not DONE, landed, parked or superseded).
 *   pr       PR #n open, awaiting approval (a PR merge-land opened; the tick latches it merged)
 *   merging  merging now as RUN-n (a landing run of the lane is running)
 *   queued   merge queued as RUN-n (#k) (k = its place in the fill order)
 *   stopped  merge stopped by RUN-n: <the STOPPED line of its MERGE-NOTES> (the newest landing run since the DONE ended STOPPED)
 *   build    waits for build RUN-n on the same lane (a build run of the lane is live: the DONE is not its last word yet)
 *   outside  not a Norn lane: branch made outside Norn - land it by hand, or adopt it (no LANE record, no run of Norn's made it)
 *   none     no merge queued (warn)
 * o: { items (loadState items), queue (runs.mjs queueOf rows: position), readNotes (file) -> text | null }
 */
export function whyNotMerged(row, { items = {}, queue = [], readNotes = () => null } = {}) {
  if (!row || row.state !== 'done' || row.superseded || row.record_state === 'parked') return null;
  if (row.pr?.url) return { kind: 'pr', text: `PR #${row.pr.number ?? '?'} open, awaiting approval`, warn: false, url: row.pr.url };
  const all = Object.values(items), lane = row.lane;
  const runs = lane ? all.filter(r => r.kind === 'run' && r.data?.lane === lane && r.data?.kind !== 'checkin').sort((a, b) => idNum(b.id) - idNum(a.id)) : [];
  const done = Date.parse(row.done_utc ?? '') || 0;
  const landing = runs.filter(r => isLandingStage(r.data.stage));
  const run = landing.find(r => r.state === 'running');
  if (run) return { kind: 'merging', text: `merging now as ${run.id}`, warn: false, run: run.id };
  const q = landing.find(r => r.state === 'queued' || r.state === 'claimed');
  if (q) { const pos = queue.find(x => x.id === q.id)?.position ?? null; return { kind: 'queued', text: `merge queued as ${q.id}${pos ? ` (#${pos})` : ''}`, warn: false, run: q.id, position: pos }; }
  const last = landing.find(r => r.state === 'exited' && Date.parse(r.created) >= done);
  if (last?.end?.outcome === 'stopped') {
    const line = stoppedLine(last.data.notes ? readNotes(last.data.notes) : null) || last.end.why || 'no STOPPED line in its notes';
    return { kind: 'stopped', text: `merge stopped by ${last.id}: ${line}`, warn: true, run: last.id };
  }
  const build = runs.find(r => !isLandingStage(r.data.stage) && LIVE.includes(r.state));
  if (build) return { kind: 'build', text: `waits for build ${build.id} on the same lane`, warn: false, run: build.id };
  if (!lane || (!all.some(i => i.kind === 'lane' && i.id.slice(2) === lane) && !runs.length)) return { kind: 'outside', text: 'not a Norn lane: branch made outside Norn - land it by hand, or adopt it', warn: true };
  return { kind: 'none', text: 'no merge queued', warn: true };
}
