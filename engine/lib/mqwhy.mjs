// land-push (owner 2026-11-21, P0): why the merge queue passed a DONE lane branch by, in words - ui-shell, dwarf-names and ui-runs-lanes
// sat DONE on home b with "not pushed" only in the mergeq command output and nothing on their Lanes rows. One store per state dir,
// <state>/mq/why.json { branch: { tip, kind, why, by, at } }, written by the step that skipped the branch: the merge leader's queue pass
// (mergeq.mjs: the update, the landing, the batch pick) and a follower's PR step (mergeland.mjs followerPrs: its refusals). Read by
// dlvwhy.mjs whyNotMerged - the deliverable's why_not - which the Lanes row says through laneout.mjs laneNext. An entry counts only at
// the tip it was written for: a moved branch reads nothing until the next pass judges it again.
import fs from 'node:fs';
import path from 'node:path';

const mqWhyFile = state => path.join(state, 'mq', 'why.json');
export const loadMqWhy = state => { try { return JSON.parse(fs.readFileSync(mqWhyFile(state), 'utf8')); } catch { return {}; } };

/** note what one pass found: edits { branch: { tip, kind, why } | null (judged, nothing holds it) }; branches not named keep their entry.
 *  kind: unpushed | slop | conflict | red | gate | busy | door | held | target | failed (the words are `why`) */
export function noteMqWhy(state, edits, { by = 'mergeq', now = Date.now() } = {}) {
  const keys = Object.keys(edits || {});
  if (!state || !keys.length) return;
  const cur = loadMqWhy(state), at = new Date(now).toISOString();
  for (const b of keys) { if (edits[b]) cur[b] = { tip: edits[b].tip ?? null, kind: edits[b].kind, why: edits[b].why, by, at }; else delete cur[b]; }
  const f = mqWhyFile(state), t = `${f}.${process.pid}.tmp`;
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(t, JSON.stringify(cur, null, 1)); fs.renameSync(t, f); } catch { /* the next pass writes it */ }
}
/** the skip of a deliverables row (branch + tip) | null */
export const mqWhyOf = (map, row) => { const e = row?.branch ? map?.[row.branch] : null; return e && (!e.tip || !row.tip || e.tip === row.tip) ? e : null; };

// merge-slot (owner 11-21: "things getting done but not merged"): why a QUEUED landing run (MERGE / resolve) has not started, in the
// fill's own words - <state>/mq/fill.json { RUN-n: { why, at } }, rewritten whole by every fill pass (runs.mjs fillQueue) from its dry walk
// (a run that started or left the queue drops out). whyNotMerged adds it to "merge queued as RUN-n", so the Lanes "to land" row says why.
const fillWhyFile = state => path.join(state, 'mq', 'fill.json');
export const loadFillWhy = state => { try { return JSON.parse(fs.readFileSync(fillWhyFile(state), 'utf8')); } catch { return {}; } };
/** rows: the fill walk's rows (runs.mjs readiness); isLanding: stage -> bool */
export function noteFillWhy(state, rows, isLanding, { now = Date.now() } = {}) {
  const at = new Date(now).toISOString(), cur = Object.fromEntries(rows.filter(r => isLanding(r.stage) && !r.ready && r.terms.length).map(r => [r.id, { why: r.terms.join('; '), at }]));
  const f = fillWhyFile(state), t = `${f}.${process.pid}.tmp`;
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(t, JSON.stringify(cur, null, 1)); fs.renameSync(t, f); } catch { /* the next pass writes it */ }
}
