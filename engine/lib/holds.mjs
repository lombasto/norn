// GAP-1: a blocked Norn says so. The usage guard once held every queued run and merge for ~20 h ("usage: weekly unknown") and said
// it only as one STATUS digest line. Now: when EVERY queued run of a project (or every queued run on the Claude account) waits on the
// same machine-level term of the fill walk (runs.mjs walkQueue: a usage term of usageguard.mjs / billing.mjs, or a PAUSED file) for
// policy.holds.notice_min (default 60) minutes, the project gets ONE needs-you item (dashboard Inbox), ONE digest row (the check-in
// reports it) and ONE owner notice per episode (tick -> norn notify, class alert). Level-triggered like the digest: <state>/hold.json
// keeps only the episode (term, since, notified); the tick deletes it once the walk no longer holds, and the item and the row leave.
import fs from 'node:fs';
import path from 'node:path';
import { waitWords } from './waitwords.mjs';
import { isMergeStage } from './usageguard.mjs';
import { queueSpecPath, liveBudget } from './runs.mjs';

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
const minsOf = (rec, now) => Math.max(0, Math.floor((now - Date.parse(rec.since)) / 60000));
const what = rec => `${rec.runs.length} queued ${rec.scope === 'claude' ? 'Claude ' : ''}run${rec.runs.length === 1 ? '' : 's'}${rec.merges ? ` (${rec.merges} merge${rec.merges === 1 ? '' : 's'})` : ''}`;

/** the needs-you item of a hold.json record once it is min minutes old, else null (the dashboard Inbox; the digest row); state = the
 * project's state dir (the PAUSED words: this project or all of Norn) */
export function holdItem(rec, { now = Date.now(), min = NOTICE_MIN, status = '', project = null, state = null } = {}) {
  if (!rec?.term || !rec.since || !rec.runs?.length) return null;
  const minutes = minsOf(rec, now);
  if (minutes < min) return null;
  const { text, code: _c, acts: _a, ...w } = waitWords(rec.term, { billing: rec.billing, status, state });   // the words: waitwords.mjs, one module
  return { type: 'hold', id: 'hold', project, term: rec.term, scope: rec.scope, runs: rec.runs, merges: rec.merges ?? 0, since: rec.since, minutes, created: rec.since,
    title: `All ${what(rec)} held since ${hhmm(rec.since)}. ${text}`, reason: text, ...w };
}

/** the owner notice of the episode, ONCE (hold.json notified): null before min minutes or when sent; the caller sends it (norn tick) */
export function holdNoticeDue(state, { now = Date.now(), min = NOTICE_MIN, status = '', project = null } = {}) {
  const rec = readHold(state), it = holdItem(rec, { now, min, status, project, state });
  if (!it || rec.notified) return null;
  write(state, { ...rec, notified: new Date(now).toISOString() });
  return { title: `Norn${project ? ' ' + project : ''}: all queued work held ${Math.round(it.minutes / 6) / 10} h - ${it.reason}`,
    body: `${it.title} Fix: ${it.fix}.${it.clears ? ` Or it clears ${it.clears}.` : ''} Held: ${it.runs.join(', ')}.` };
}
