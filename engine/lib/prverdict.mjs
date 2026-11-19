// RM-7 S2: what a deliverable's PR says of its merged state, read from its own history (the `pr` event merge-land records and the
// `pr-state` events the tick records: prstate.mjs). Pure and import-free, so after.mjs and deliverables.mjs can read it without
// pulling records.mjs into their import graph (records -> views -> after would close a cycle).

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
