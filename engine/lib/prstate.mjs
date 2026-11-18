// RM-7 S2: the deliverable follows its PR to merged. norn merge-land records the PR of a lane branch (a deliverable `pr` event); from
// then on GitHub, not git, says when the work landed: `gh pr view <url> --json state,mergedAt` read by the tick (syncPrStates), and a
// change of state recorded as a `pr-state` event { url, number, state open|merged|closed, merged_at }. A deliverable whose PR is open
// (or closed unmerged: S3) is never merged, however its branch looks; a pushed branch is never taken for a merged one. Leaf module:
// records only (deliverables.mjs, after.mjs, mergeland.mjs and tick.mjs import it).
import { spawnSync } from 'node:child_process';
import { fold, readEvents, recordsFile, record } from './records.mjs';

/** gh run synchronously: (args) -> { code, out, err } (tests inject a fake: no network) */
export const makeGh = () => args => {
  const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true });
  return { code: r.error ? -1 : r.status, out: r.stdout || '', err: r.error ? r.error.message : r.stderr || '' };
};

const GH_STATE = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' };

/**
 * The PR of a deliverable item: its newest `pr` event, with the newest `pr-state` of that URL since -> { url, number, state, merged_at,
 * at } | null. state = open until GitHub was read otherwise (merge-land just saw it open, or opened it).
 */
export function prOf(it) {
  const h = it?.history || [];
  const i = h.findLastIndex(e => e.ev === 'pr' && e.data?.url);
  if (i < 0) return null;
  const p = h[i].data, s = h.slice(i + 1).findLast(e => e.ev === 'pr-state' && e.data?.url === p.url);
  return { url: p.url, number: p.number ?? null, state: s?.data.state || 'open', merged_at: s?.data.merged_at ?? null, at: (s || h[i]).ts };
}

/**
 * What the PR says of the deliverable's merged state: 'merged' (GitHub merged it, and no later DONE round came after) | 'held' (open
 * or closed unmerged: not merged, whatever git shows) | null (no PR, or a DONE round after the merge: git decides that round).
 */
export function prVerdict(it) {
  const pr = prOf(it);
  if (!pr) return null;
  if (pr.state !== 'merged') return 'held';
  const done = (it.history || []).findLast(e => e.ev === 'done');
  return done && Date.parse(done.ts) > Date.parse(pr.at) ? null : 'merged';
}

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
