// META-CATCH S1 piece 2: the stuck-item alarm. One roadmap item can take round after round with no merge and nothing in Norn
// fires; this module folds, per item, the rounds its links reach (roadmap.mjs reach): runs since the last merge, days since the
// first of them, `stopped` ends in a row, the last merge. Policy `stuck` (policy.mjs; 0 switches a threshold off) names when that
// is a flag. A flag = a `stuck:RM-n` gate fact (a MAJOR check-in wake carrying the last three stop reasons), ONE owner notice,
// and `norn run` refuses a further round on the item until an approach review is recorded (a decision with approach_review =
// RM-n, newer than the flag, by the owner or by a run of another executor / model than the stuck rounds). A merge resets it.
// The fold is pure (derive calls it); stuck.json keeps the tick's flags for the run refusal and the one-notice rule.
import fs from 'node:fs';
import path from 'node:path';
import { POLICY_DEFAULTS } from './policy.mjs';
import { isMergeRun } from './checkins.mjs';
import { loadState, authorOf } from './records.mjs';

const DAY = 864e5;
const OWNER = ['owner', 'dashboard'];
export const stuckPolicy = policy => ({ ...POLICY_DEFAULTS.stuck, ...(policy?.stuck || {}) });
const ms = s => Date.parse(s ?? '') || null;
const startOf = r => ms((r.history || []).find(x => x.ev === 'start')?.ts) ?? ms(r.created);
const endOf = r => (r.state === 'exited' ? ms([...(r.history || [])].reverse().find(x => x.ev === 'end')?.ts) : null);
const iso = t => new Date(t).toISOString();

/**
 * runs: the item's reached runs (fold items); merges: [ms] (a merged / installed deliverable's round end, a MERGE run ended done).
 * -> { fires [{ ts, threshold, value }] (every crossing, all episodes - the replay), episode { runs, first, row, reasons, fired } }.
 * A round = a started work run (not a merge run, not a helper, not an approach review). done breaks the stopped row; handoff / lost / killed neither
 * count nor break. Each threshold fires once per episode (an episode ends at a merge).
 */
export function stuckTimeline(runs, merges, pol, now = Date.now()) {
  // an approach-review run is never a round of the flag it reviews (#161: its stop counted its model as stuck and voided its verdict)
  const rounds = runs.filter(r => !isMergeRun(r.data) && r.data?.role !== 'helper' && String(r.data?.stage ?? '').toUpperCase() !== REVIEW_STAGE
    && !['queued', 'claimed', 'withdrawn', 'filled'].includes(r.state));
  const evs = [...merges.filter(Boolean).map(t => ({ t, k: 0 })), ...rounds.flatMap(r => [{ t: startOf(r), k: 1, r }, ...(endOf(r) ? [{ t: endOf(r), k: 2, r }] : [])])]
    .filter(e => e.t).sort((a, b) => a.t - b.t || a.k - b.k);
  const fires = [];
  let ep = null, lastMerge = null;
  const fresh = () => ({ runs: 0, first: null, row: 0, reasons: [], rounds: [], fired: {} });
  const fire = (t, threshold, value) => { if (ep.fired[threshold]) return; ep.fired[threshold] = t; fires.push({ ts: iso(t), threshold, value }); };
  const days = t => { const d = Number(pol.days_without_merge); if (d > 0 && ep?.first && ep.first + d * DAY <= t) fire(ep.first + d * DAY, 'days_without_merge', d); };
  for (const e of evs) {
    days(e.t);
    if (e.k === 0) { ep = null; lastMerge = e.t; continue; }
    ep ||= fresh();
    if (e.k === 1) {
      ep.runs++; ep.first ??= e.t;
      if (Number(pol.runs_without_merge) > 0 && ep.runs === Number(pol.runs_without_merge)) fire(e.t, 'runs_without_merge', ep.runs);
      continue;
    }
    const out = e.r.end?.outcome;
    if (out === 'done') ep.row = 0;
    if (out !== 'stopped') continue;
    ep.row++; ep.reasons.push({ run: e.r.id, ts: iso(e.t), why: e.r.end?.why || '' }); ep.rounds.push({ executor: e.r.data?.executor ?? null, model: e.r.data?.model ?? null });
    if (Number(pol.stopped_rounds) > 0 && ep.row === Number(pol.stopped_rounds)) fire(e.t, 'stopped_rounds', ep.row);
  }
  days(now);
  return { fires, episode: ep, lastMerge };
}

/** the item's stuck fold at now: { runs, days, stopped_row, first, last_merge, reasons (last 3 stops), rounds, flag { ts, why } | null } */
export function stuckOf(runs, merges, pol, now, { past = false } = {}) {
  const { episode: ep, lastMerge } = stuckTimeline(runs, merges, pol, now);
  const fired = Object.entries(ep?.fired || {}).sort((a, b) => a[1] - b[1]);
  const words = { stopped_rounds: `${ep?.row} stopped in a row`, runs_without_merge: `${ep?.runs} runs without a merge`, days_without_merge: `${pol.days_without_merge} days without a merge` };
  return { runs: ep?.runs ?? 0, days: ep?.first ? Math.floor((now - ep.first) / DAY) : 0, stopped_row: ep?.row ?? 0, first: ep?.first ? iso(ep.first) : null,
    last_merge: lastMerge ? iso(lastMerge) : null, reasons: (ep?.reasons || []).slice(-3), rounds: ep?.rounds || [],
    flag: !past && fired.length ? { ts: iso(fired[0][1]), why: fired.map(([k]) => words[k]) } : null };
}

/** the merges an item's reach shows: a branch's latched merges, every round's (land-reuse, DEC-b-56: a reused deliverable keeps them
 * after a newer DONE); a merged / installed branch with none latched yet (git found it) at its round's end; a MERGE run ended done */
export const mergesOf = (runs, branches) => [...branches.flatMap(b => b.merges.length ? b.merges : ['merged', 'installed'].includes(b.state) ? [b.ts] : []),
  ...runs.filter(r => isMergeRun(r.data) && r.state === 'exited' && r.end?.outcome === 'done').map(endOf)].filter(Boolean);

export const stuckWords = s => `${s.runs} runs, ${s.days} days, ${s.stopped_row} stopped in a row`;
const reasonLines = s => s.reasons.map(x => `  ${x.run} (${x.ts.slice(0, 16)}Z): ${x.why || '(no why)'}`);

// ---------- the tick: stuck.json, the one notice per flag, the gate fact ----------
export const stuckFile = state => path.join(state, 'stuck.json');
export const readStuck = state => { try { return JSON.parse(fs.readFileSync(stuckFile(state), 'utf8')); } catch { return {}; } };

/** tree items -> the flags now (stuck.json rewritten; a cleared flag leaves) + one notice per NEW flag [{ title, body }] */
export function stuckSweep(state, items, { project = null } = {}) {
  const prev = readStuck(state), next = {}, notices = [];
  for (const n of items) {
    const s = n.stuck;
    if (!s?.flag) continue;
    const lanes = (n.links || []).filter(t => t.startsWith('lane:')).map(t => t.slice(5));
    next[n.id] = { ts: s.flag.ts, why: s.flag.why, title: n.title, lanes, reasons: s.reasons, rounds: s.rounds, words: stuckWords(s),
      noticed: prev[n.id]?.ts === s.flag.ts ? prev[n.id].noticed : null };
    if (!next[n.id].noticed) {
      next[n.id].noticed = new Date().toISOString();
      notices.push({ title: `Norn${project ? ' ' + project : ''}: ${n.id} stuck - ${s.flag.why.join(', ')}`,
        body: `${n.id} ${n.title}: ${stuckWords(s)}. Further rounds are refused until an approach review (norn stuck brief ${n.id}). Last stops:\n${reasonLines(s).join('\n')}` });
    }
  }
  if (JSON.stringify(prev) !== JSON.stringify(next)) fs.writeFileSync(stuckFile(state), JSON.stringify(next, null, 1) + '\n');
  return { flags: next, notices };
}

/** the approach review of a flag: a decision with approach_review = id, newer than the flag, by the owner or another executor / model */
export function reviewOf(st, id, flag) {
  const pairs = new Set((flag.rounds || []).map(x => `${x.executor}/${x.model}`));
  return Object.values(st.items).find(d => {
    if (d.kind !== 'decision' || d.data?.approach_review !== id || !(Date.parse(d.created) > Date.parse(flag.ts))) return false;
    if (OWNER.includes(authorOf(d))) return true;
    const r = d.run && st.items[d.run];
    return !!r && !pairs.has(`${r.data?.executor ?? null}/${r.data?.model ?? null}`);
  }) || null;
}

const flagsOpen = state => { const f = readStuck(state); if (!Object.keys(f).length) return []; const st = loadState(state);
  return Object.entries(f).filter(([id, x]) => !reviewOf(st, id, x)).map(([id, x]) => ({ id, ...x })); };

/** the gate probe: an open flag (no approach review yet) = `stuck:RM-n`, a MAJOR wake */
export const stuckProbe = state => () => flagsOpen(state).map(x => 'stuck:' + x.id);

/** the wake text's extra lines: per open flag, the last three stop reasons side by side */
export const stuckWake = (state, why) => flagsOpen(state).filter(x => String(why).includes('stuck:' + x.id))
  .map(x => `\n${x.id} stuck (${x.why.join(', ')}; ${x.words}); last stops:\n${reasonLines(x).join('\n')}`).join('');

/** norn run: the refusal of a further round on a stuck item (lane linked to it, or --item); null = go. The review run itself
 * (stage APPROACH-REVIEW on another executor / model than the stuck rounds) is the way out, so it goes. */
export const REVIEW_STAGE = 'APPROACH-REVIEW';
export function stuckRefusal(state, { lane, item, stage, executor, model } = {}) {
  const other = x => !(x.rounds || []).some(r => r.executor === (executor ?? null) && r.model === (model ?? null));
  const hit = flagsOpen(state).find(x => (x.id === item || (lane && x.lanes.includes(lane))) && !(String(stage || '').toUpperCase() === REVIEW_STAGE && other(x)));
  return hit ? `stuck: approach review owed on ${hit.id} (${hit.why.join(', ')}; ${hit.words}). The brief: norn stuck brief ${hit.id}; record the review: `
    + `norn rec add decision ... --approach-review ${hit.id} (by the owner, or a run of another executor / model than the stuck rounds)` : null;
}

/** the generated approach-review brief: the item's first diagnosis (its first round's end) + the stop reasons + the two questions */
export function reviewBrief(id, node, runs) {
  const s = node.stuck, first = [...runs].filter(r => r.state === 'exited').sort((a, b) => startOf(a) - startOf(b))[0];
  const diag = first ? `${first.id} (${first.data?.stage || 'run'}, ${first.end?.outcome}): ${first.end?.summary || first.end?.why || '(no summary)'}${first.data?.notes ? `\nIts notes: ${first.data.notes}` : ''}` : '(no ended run)';
  return [`# ${id} approach review (generated by norn stuck brief)`, '',
    `${id} ${node.title} is stuck: ${(s.flag?.why || []).join(', ') || 'no flag now'}; ${stuckWords(s)}; last merge ${s.last_merge || 'never'}.`, '',
    '## The first diagnosis', diag, '', '## The last stop reasons', ...reasonLines(s), '',
    '## Answer', '1. Is the approach wrong? Say what the rounds kept trying and why it did not converge.',
    '2. Which diagnosed cause is still open? Name each cause of the first diagnosis and whether a later round removed, kept or never touched it.',
    '3. If many hand-offs fell on one problem, say whether one large-context run should hold it.', '',
    `Record the answer: norn rec add decision --lane <lane> --question "${id} approach review" --choice "<keep | change: ...>" --why "<...>" --approach-review ${id}`,
    'You must be the owner, or a run of another executor or model than the stuck rounds.', '',
    'Scope: none (a review; no code). Tests: none. Done: the decision recorded.'].join('\n');
}

/** norn stuck --replay: every crossing of the item's history, from its own local state */
export function replayLines(nodes, W, pol, reachOf) {
  const out = [];
  for (const n of nodes) {
    const { runs, branches } = reachOf(n, W);
    const { fires } = stuckTimeline(runs, mergesOf(runs, branches), pol, W.now);
    if (!fires.length) { out.push(`${n.id}: no threshold crossed (${runs.length} runs)`); continue; }
    for (const f of fires) out.push(`${n.id}: ${f.ts.slice(0, 16)}Z ${f.threshold} = ${f.value}`);
  }
  return out;
}
