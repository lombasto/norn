// META-CATCH S2 (owner 2026-11-17, case b: a LOOK item judged by numeric checks while its picture stood still for 5 days): picture
// proof for look items. A roadmap item with proof form `look` (norn road edit --proof look --views ..) needs (1) a Look: line (the
// before / after sheet) in a brief of round >= policy.look.min_round and in every brief of a policy.look.stages stage (norn run
// refuses, exit 6), (2) a DONE end naming an existing image newer than the run's start (norn done --look), (3) a look verdict
// (pass + image, by controller, check-in or owner) newer than the deliverable's head - (2) and (3) are the merge queue's entry
// check. Norn checks existence and order only, never the picture: who looks is a role. Rules as data: policy.look over the defaults.
import fs from 'node:fs';
import { POLICY_DEFAULTS } from './policy.mjs';
import { linksOf } from './roadmap.mjs';

const fwd = p => String(p ?? '').replace(/\\/g, '/');
const ms = s => Date.parse(s ?? '') || null;
const mtimeOf = (f, stat) => { try { return stat(f).mtimeMs; } catch { return null; } };
export const PROOF_FORMS = ['look'];
export const VERDICTS = ['pass', 'fail'];

/** policy.look over the defaults: { stages (first words of the gated stages, any case), min_round } */
export const lookPolicy = policy => ({ ...POLICY_DEFAULTS.look, ...(policy?.look || {}) });

/** a brief's Look: line value (first one; quotes / backticks off), or null when it has none or an empty one */
export function lookLine(text) {
  for (const l of String(text ?? '').split(/\r?\n/)) {
    const m = l.match(/^\s*(?:[-*]\s+)?Look:[ \t]*(.*?)\s*$/);
    if (m) return m[1].replace(/^[`'"]+|[`'"]+$/g, '').trim() || null;
  }
  return null;
}

/** the open look items a run belongs to: its --item, and every item that links its lane */
export function lookItemsFor(R, { item, lane } = {}) {
  return Object.values(R.items).filter(n => n.state === 'open' && n.proof === 'look' && (n.id === item || (lane && linksOf(n.links).lane.includes(lane))));
}

const stageWord = s => String(s ?? '').trim().split(/[\s\-_:]+/)[0].toUpperCase();
/** the Look: gate of norn run -> the refusal text, or null (no look item, not a gated round / stage, or the line is there) */
export function lookBriefRefusal({ items, text, brief, stage, round, policy }) {
  if (!items?.length) return null;
  const p = lookPolicy(policy), gated = p.stages.map(s => String(s).toUpperCase()).includes(stageWord(stage)), r = Number(round ?? 1);
  if (!gated && !(r >= p.min_round)) return null;
  if (lookLine(text)) return null;
  const why = gated ? `a ${stageWord(stage)} brief` : `round ${r}`;
  return `brief ${fwd(brief)} lacks the Look: line (${why} of ${items.map(n => `${n.id} is a look item (views ${(n.views || []).join(', ') || '-'})`).join('; ')}): `
    + 'add Look: <the before / after sheet path> - the picture at the item\'s views the round is judged by';
}

/** the look items whose links reach a deliverable row (its DLV, branch, lane or DONE run) */
export function rowLookItems(nodes, row) {
  return nodes.filter(n => n.state === 'open' && n.proof === 'look').filter(n => {
    const L = linksOf(n.links);
    return L.dlv.includes(row.id) || (row.branch && L.branch.includes(row.branch)) || (row.lane && L.lane.includes(row.lane)) || (row.run && L.run.includes(row.run));
  });
}

/** a DONE end's picture proof: its end names an existing image newer than the run's start -> { ok, image } | { ok: false, why } */
export function doneProof(run, { stat = fs.statSync } = {}) {
  if (!run) return { ok: false, why: 'no DONE run recorded for it' };
  const out = run.end?.outcome;
  if (out !== 'done') return { ok: false, why: `${run.id} ended ${out ?? run.state}, not done` };
  const img = run.end.look;
  if (!img) return { ok: false, why: `${run.id} ended done without a look image (norn done --look <image>)` };
  const m = mtimeOf(img, stat), start = ms((run.history || []).find(x => x.ev === 'start')?.ts) ?? ms(run.created);
  if (m === null) return { ok: false, why: `${run.id}: look image ${fwd(img)} does not exist` };
  if (start !== null && !(m > start)) return { ok: false, why: `${run.id}: look image ${fwd(img)} is older than the run's start (${new Date(start).toISOString()})` };
  return { ok: true, image: fwd(img) };
}

/**
 * The merge queue's entry check for one row of a look item -> null (it may enter) | the hold reason. item = the folded roadmap node
 * (its latest verdict), run = the row's DONE run (fold item), headMs = the commit time of the row's head (whole seconds, as git keeps it).
 */
export function lookHold(row, { item, run, headMs, stat = fs.statSync }) {
  const pre = `${item.id} look: `, p = doneProof(run, { stat });
  if (!p.ok) return `${pre}unproven done: ${p.why}`;
  const v = item.verdict;
  if (!v) return `${pre}no look verdict (norn road verdict ${item.id} pass|fail --image <sheet>)`;
  if (headMs === null || headMs === undefined) return `${pre}the head of ${row.id} has no commit time`;
  // the head time is whole seconds: a verdict counts as newer only from the next second on
  if (!(ms(v.ts) >= Math.floor(headMs / 1000) * 1000 + 1000)) return `${pre}the verdict (${v.ts}) is older than the head of ${row.id} (${new Date(headMs).toISOString()}): look again`;
  if (v.verdict !== 'pass') return `${pre}the latest verdict is ${v.verdict} (${v.by} ${v.ts})`;
  if (mtimeOf(v.image, stat) === null) return `${pre}the verdict image ${fwd(v.image)} does not exist`;
  return null;
}
