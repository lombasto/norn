// RM-7 S2: the deliverable follows its PR to merged. norn merge-land records the PR of a lane branch (a deliverable `pr` event); from
// then on GitHub, not git, says when the work landed: `gh pr view <url> --json state,mergedAt` read by the tick (syncPrStates), and a
// change of state recorded as a `pr-state` event { url, number, state open|merged|closed, merged_at }. A deliverable whose PR is open
// (or closed unmerged: S3) is never merged, however its branch looks; a pushed branch is never taken for a merged one. This module reads
// GitHub and records (mergeland.mjs and tick.mjs import it); the pure read of an item's PR (prOf, prVerdict) is prverdict.mjs.
import { spawnSync } from 'node:child_process';
import { fold, readEvents, recordsFile, record } from './records.mjs';
import { prOf } from './prverdict.mjs';

/** gh run synchronously: (args) -> { code, out, err } (tests inject a fake: no network) */
export const makeGh = () => args => {
  const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true });
  return { code: r.error ? -1 : r.status, out: r.stdout || '', err: r.error ? r.error.message : r.stderr || '' };
};

const GH_STATE = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' };

/** one PR read: gh pr view -> { state, merged_at } | { error } */
export function readPr(url, gh = makeGh()) {
  const r = gh(['pr', 'view', url, '--json', 'state,mergedAt']);
  if (r.code !== 0) return { error: `gh pr view ${url} failed: ${r.err.trim() || 'exit ' + r.code}` };
  let j;
  try { j = JSON.parse(r.out); } catch { return { error: `gh pr view ${url} printed no JSON: ${r.out.trim().slice(0, 200)}` }; }
  const state = GH_STATE[j?.state];
  return state ? { state, merged_at: j.mergedAt || null } : { error: `gh pr view ${url}: unknown state ${JSON.stringify(j?.state)}` };
}

/**
 * The tick's read: every open / parked deliverable whose PR is open is read once (gh pr view); a changed state is recorded (`pr-state`).
 * A failed read changes nothing (the PR stays open). Returns [{ id, url, state, merged_at } | { id, url, error }] (written unless dry).
 */
export function syncPrStates(stateDir, { gh = makeGh(), dry = false, now } = {}) {
  const items = Object.values(fold(readEvents(recordsFile(stateDir, 'deliverable'))).items);
  const out = [];
  for (const it of items) {
    if (it.kind !== 'deliverable' || !['open', 'parked'].includes(it.state)) continue;
    const pr = prOf(it);
    if (!pr || pr.state !== 'open') continue;
    const r = readPr(pr.url, gh);
    if (r.error) { out.push({ id: it.id, url: pr.url, error: r.error }); continue; }
    if (r.state === 'open') continue;
    if (!dry) record(stateDir, { kind: 'deliverable', ev: 'pr-state', id: it.id, by: 'launcher', data: { url: pr.url, number: pr.number, state: r.state, merged_at: r.merged_at } }, { views: false, ...(now ? { now } : {}) });
    out.push({ id: it.id, url: pr.url, state: r.state, merged_at: r.merged_at });
  }
  return out;
}
