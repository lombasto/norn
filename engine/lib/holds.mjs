// GAP-1: a blocked Norn says so. The usage guard once held every queued run and merge for ~20 h ("usage: weekly unknown") and said
// it only as one STATUS digest line. Now: when EVERY queued run of a project (or every queued run on the Claude account) waits on the
// same machine-level term of the fill walk (runs.mjs walkQueue: a usage term of usageguard.mjs / billing.mjs, or a pause that holds
// starts: `PAUSED <mode> (<file>)`, pausemode.mjs - Hold the queue / Pause everything; Pause check-ins holds nothing) for
// policy.holds.notice_min (default 60) minutes, the project gets ONE needs-you item (dashboard Inbox), ONE digest row (the check-in
// reports it) and ONE owner notice per episode (tick -> norn notify, class alert). Level-triggered like the digest: <state>/hold.json
// keeps only the episode (term, since, notified); the tick deletes it once the walk no longer holds, and the item and the row leave.
import fs from 'node:fs';
import path from 'node:path';
import { billingOf } from './billing.mjs';
import { isMergeStage } from './usageguard.mjs';
import { queueSpecPath, liveBudget } from './runs.mjs';
import { PAUSE_MODES } from './pausemode.mjs';

export const NOTICE_MIN = 60;
/** the minutes a whole hold lasts before it is surfaced: project policy.holds.notice_min (a Settings row), else NOTICE_MIN */
export const noticeMin = pol => { const n = Number(pol?.holds?.notice_min); return Number.isFinite(n) && n >= 0 ? n : NOTICE_MIN; };
// machine-level = nothing a check-in or a run can clear: the usage guard (weekly / rate / API $ cap) and the PAUSED files
const isMachine = t => /^(usage: |PAUSED)/.test(t);
const file = state => path.join(state, 'hold.json');
const rows0 = rows => (rows || []).filter(r => !r.withdraw);
// a walk row on the Claude account: runs.mjs marks it (row.account); an older row without the mark counts as one
const onAccount = r => r.account !== false;

/**
 * wholeHold(rows: the fill walk's rows, runs.readiness) -> null | { term, scope: 'all' | 'claude', runs: [ids], merges: n }.
 * PAUSED holds when every queued row carries it; a usage term when every queued run on the Claude account carries the same one
 * (a Codex run free to go does not clear a hold of all the Claude work, but a free Claude run - a MERGE at RATE_OK=0 - does).
 */
export function wholeHold(rows) {
  const q = rows0(rows);
  if (!q.length) return null;
  const by = new Map();
  for (const r of q) for (const t of new Set((r.terms || []).filter(isMachine))) by.set(t, [...(by.get(t) || []), r]);
  for (const [term, held] of by) {
    const scope = term.startsWith('PAUSED') ? q : q.filter(onAccount);
    if (!scope.length || held.length !== scope.length) continue;
    return { term, scope: held.length === q.length ? 'all' : 'claude', runs: held.map(r => r.id), merges: held.filter(r => isMergeStage(r.stage)).length };
  }
  return null;
}

export function readHold(state) { try { return JSON.parse(fs.readFileSync(file(state), 'utf8')); } catch { return null; } }
export async function readHoldAsync(state) { try { return JSON.parse(await fs.promises.readFile(file(state), 'utf8')); } catch { return null; } }
const write = (state, rec) => { const f = file(state), tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(rec) + '\n'); fs.renameSync(tmp, f); };

/** the tick's step after the fill: (re)write hold.json from the walk (same term = same episode, its since kept); null = no hold, file gone.
 * billing (for the words) = the budget billing key the guard saw: the live budget file of the first held run's queue spec (GAP-2: no copy). */
export function trackHold(state, rows, { now = Date.now() } = {}) {
  const h = wholeHold(rows), prev = readHold(state);
  if (!h) { if (prev) { try { fs.unlinkSync(file(state)); } catch { /* gone */ } } return null; }
  const same = prev?.term === h.term;
  let billing = null;
  try { billing = liveBudget(JSON.parse(fs.readFileSync(queueSpecPath(state, h.runs[0]), 'utf8'))).billing ?? null; } catch { /* no spec / budget unreadable: no billing words */ }
  const rec = { ...h, since: same ? prev.since : new Date(now).toISOString(), billing, notified: same ? prev.notified ?? null : null };
  if (JSON.stringify(rec) !== JSON.stringify(prev)) write(state, rec);
  return rec;
}

const hhmm = iso => `${String(iso).slice(0, 16).replace('T', ' ')}Z`;
/** the term in plain words for the owner: { reason, fix, clears (null = only the fix clears it), setting / command / file / resume } */
export function holdWords(term, { billing = null, status = '' } = {}) {
  const bm = billingOf({ billing }), t = String(term);
  const reset = status.match(/reset (\d{4}-\d\d-\d\dT\d\d:\d\dZ)/)?.[1] ?? null;
  let m;
  if (t === 'usage: weekly unknown') return bm && bm.type !== 'api'
    ? { reason: `the weekly usage is not measured yet, and the usage guard holds Claude work it cannot measure (billing: ${bm.label})`, clears: null, command: 'norn calib --pct N',
      fix: `run norn calib --pct N, N = the weekly % claude.ai shows (Settings > Usage), so Norn can measure the week; on API billing set Billing (Settings) to api instead`, setting: 'billing' }
    : { reason: 'the weekly usage is not measured yet, and the usage guard holds Claude work it cannot measure (Billing is not set)', clears: null, command: 'norn calib --pct N', setting: 'billing',
      fix: 'set Billing (Settings): on API billing choose api (no weekly limit, nothing to measure); on a plan (pro, max-5x, max-20x, ultra) choose it, then run norn calib --pct N with the weekly % claude.ai shows' };
  if (t === 'usage: RATE_OK unknown') return { reason: 'the hourly usage rate is not measured yet (STATUS.md has no RATE_OK line)', clears: null, command: 'norn status',
    fix: 'run norn status (the tick writes STATUS.md every pass; the tick log says why it did not); on API billing set Billing (Settings) to api', setting: 'billing' };
  if (t === 'usage: RATE_OK=0') return { reason: 'Claude usage over the last 2 h is above the hourly rate cap', setting: 'usage_rate_cap_pct_per_h',
    clears: 'by itself as the trailing 2 h rate falls under the cap', fix: 'wait, or raise the usage rate cap (Settings)' };
  if ((m = t.match(/^usage: weekly ([\d.]+) % >= guard ([\d.]+) %$/))) return { reason: `the week's usage (${m[1]} %) reached the weekly stop (${m[2]} %)`, setting: 'weekly_stop_pct',
    clears: reset ? `by itself at the weekly reset (${hhmm(reset)})` : 'by itself at the weekly reset', fix: 'wait for the reset, or raise the weekly stop (Settings)' };
  if ((m = t.match(/^usage: api spend \$([\d.]+) in 24 h >= cap \$([\d.]+)$/))) return { reason: `API spend ($${m[1]} in the last 24 h) reached the $${m[2]} daily cap`, setting: 'api_usd_per_day',
    clears: 'by itself as the last 24 h of spend falls under the cap', fix: 'wait, or raise or clear the API daily cap (Settings)' };
  if ((m = t.match(/^PAUSED (\w+) \((.+)\)$/))) return { reason: `Norn is paused (${PAUSE_MODES[m[1]]?.label ?? m[1]}): the file ${m[2]} holds every start`, clears: null, file: m[2], resume: true,
    fix: `resume all (the header's pause menu, or norn resume --all) - it deletes the project's own PAUSED file; a machine-level ${m[2]} is deleted by hand` };
  if ((m = t.match(/^dwarf: (.+) is busy on (RUN-\d+)$/))) return { reason: `the lane is pinned to ${m[1]}, who is busy on ${m[2]}`, clears: `by itself when ${m[2]} ends`,   // DWARVES 1.3 rule 1
    fix: 'wait, or unpin the dwarf: norn crew unpin <id>', command: 'norn crew unpin <id>' };
  if (t.startsWith('crew store ')) return { reason: t, clears: null, fix: 'repair or move the crew store file: no worker run starts without a dwarf' };
  return { reason: t, clears: null, fix: 'see norn plan (the Waiting lanes on the dashboard)' };
}

const minsOf = (rec, now) => Math.max(0, Math.floor((now - Date.parse(rec.since)) / 60000));
const what = rec => `${rec.runs.length} queued ${rec.scope === 'claude' ? 'Claude ' : ''}run${rec.runs.length === 1 ? '' : 's'}${rec.merges ? ` (${rec.merges} merge${rec.merges === 1 ? '' : 's'})` : ''}`;

/** the needs-you item of a hold.json record once it is min minutes old, else null (the dashboard Inbox; the digest row) */
export function holdItem(rec, { now = Date.now(), min = NOTICE_MIN, status = '', project = null } = {}) {
  if (!rec?.term || !rec.since || !rec.runs?.length) return null;
  const minutes = minsOf(rec, now);
  if (minutes < min) return null;
  const w = holdWords(rec.term, { billing: rec.billing, status });
  return { type: 'hold', id: 'hold', project, term: rec.term, scope: rec.scope, runs: rec.runs, merges: rec.merges ?? 0, since: rec.since, minutes, created: rec.since,
    title: `All ${what(rec)} held since ${hhmm(rec.since)}: ${w.reason}`, ...w };
}

/** the owner notice of the episode, ONCE (hold.json notified): null before min minutes or when sent; the caller sends it (norn tick) */
export function holdNoticeDue(state, { now = Date.now(), min = NOTICE_MIN, status = '', project = null } = {}) {
  const rec = readHold(state), it = holdItem(rec, { now, min, status, project });
  if (!it || rec.notified) return null;
  write(state, { ...rec, notified: new Date(now).toISOString() });
  return { title: `Norn${project ? ' ' + project : ''}: all queued work held ${Math.round(it.minutes / 6) / 10} h - ${it.reason}`,
    body: `${it.title}. Fix: ${it.fix}.${it.clears ? ` Or it clears ${it.clears}.` : ''} Held: ${it.runs.join(', ')}.` };
}
