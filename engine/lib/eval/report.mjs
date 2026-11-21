// META-TEND P4 (owner Q2): the replay test's report - recorded check-in rulings vs a cheaper model's, from `norn eval checkin`
// results.jsonl rows (one per tick x arm). Agreement per CLASS OF RULING (the action types a check-in records: dispatch, decision,
// question, kill, record; idle = a tick that did nothing): a recorded ruling agrees when the candidate made the same one (scoreTick
// matched it: not missing, not mismatched); an idle tick agrees when the candidate also did nothing. Plus every disagreement, the
// same-lane rulings with a different choice (scoreTick's choiceReview: matched, but a human should read them), tokens per arm, and
// the side-by-side rows (recorded vs each arm) the Spend page draws. Pure: rows in, a report out.
import { keyed } from './checkin.mjs';

export const RULING_CLASSES = ['dispatch', 'decision', 'question', 'kill', 'record', 'idle'];
const typeOf = k => String(k).split(':')[0];

/** One action in a few words. */
export function actionText(a) {
  if (!a) return '';
  if (a.type === 'dispatch') return `dispatch ${a.lane ?? '-'} ${a.stage ?? ''} ${a.executor ?? ''} ${a.effort ?? ''}`.replace(/\s+/g, ' ').trim();
  if (a.type === 'decision') return `decision ${a.lane ?? '-'}: ${String(a.choice ?? '').slice(0, 160)}`;
  if (a.type === 'question') return `question ${a.lane ?? '-'}: ${String(a.title ?? '').slice(0, 160)}${a.class ? ` (class ${a.class})` : ''}`;
  if (a.type === 'kill') return `kill ${a.run ?? '-'}`;
  if (a.type === 'record') return `record ${a.op ?? ''} ${a.id ?? ''}`.trim();
  return a.type === 'nothing' ? 'nothing' : String(a.type);
}

/**
 * rows: results.jsonl rows ({ tick, ts, arm, stratum, base, cand, error, score: { agree, worst, items, choiceReview }, usage, cost_usd }),
 * o: { project } -> { arms, classes: [{ arm, cls, recorded, agree, rate }], arms_total: [{ arm, ticks, agree, ... tokens, cost_usd }],
 *   disagreements: [{ arm, tick, ts, cls, worst, recorded, cand, why }], choices: [...], ticks: [{ tick, ts, stratum, recorded, arms: { arm: {...} } }] }
 */
export function replayReport(rows, o = {}) {
  const arms = [...new Set(rows.map(r => r.arm))], classes = new Map(), total = new Map(), ticks = new Map(), disagreements = [], choices = [];
  const cell = (arm, cls) => { const k = arm + '|' + cls; if (!classes.has(k)) classes.set(k, { arm, cls, recorded: 0, agree: 0, harmless: 0, refused: 0, recoverable: 0, harmful: 0 }); return classes.get(k); };
  for (const r of rows) {
    const t = total.get(r.arm) || { arm: r.arm, ticks: 0, agree: 0, harmless: 0, refused: 0, recoverable: 0, harmful: 0, errors: 0, tokens: 0, cost_usd: 0 };
    total.set(r.arm, t);
    t.ticks++; t.cost_usd += r.cost_usd || 0;
    const u = r.usage || {}; t.tokens += (u.input || 0) + (u.cache_write || 0) + (u.cache_read || 0) + (u.output || 0);
    const base = r.base || [], tk = ticks.get(r.tick) || { tick: r.tick, ts: r.ts, stratum: r.stratum, recorded: base.map(actionText), arms: {} };
    ticks.set(r.tick, tk);
    if (r.error) { t.errors++; tk.arms[r.arm] = { verdict: 'error', cand: [], why: [String(r.error).slice(0, 200)] }; continue; }
    const items = r.score?.items || [], bad = new Set(items.filter(i => i.side === 'missing' || i.side === 'mismatch').map(i => i.key));
    if (!base.length) { const c = cell(r.arm, 'idle'); c.recorded++; if (r.score.agree) c.agree++; }
    for (const k of keyed(base).keys()) { const c = cell(r.arm, typeOf(k)); c.recorded++; if (!bad.has(k)) c.agree++; }
    // META-CHECKIN-GUARDS R1: each disagreement counted on its class of ruling (a same-tick roadmap duty miss is not a ruling: not counted)
    for (const i of items) { const t = typeOf(i.key); if (RULING_CLASSES.includes(t)) cell(r.arm, t)[i.class]++; }
    if (r.score.agree) t.agree++; else t[r.score.worst]++;
    const cand = (r.cand || []).filter(a => a.type !== 'nothing');
    tk.arms[r.arm] = { verdict: r.score.agree ? 'agree' : r.score.worst, cand: cand.length ? cand.map(actionText) : ['nothing'], why: items.map(i => `${i.side} ${i.key}: ${i.why}`) };
    if (!r.score.agree) disagreements.push({ arm: r.arm, tick: r.tick, ts: r.ts, cls: base.length ? r.stratum : 'idle', worst: r.score.worst, recorded: base.map(actionText), cand: tk.arms[r.arm].cand, why: tk.arms[r.arm].why });
    for (const c of r.score.choiceReview || []) choices.push({ arm: r.arm, tick: r.tick, key: c.key, recorded: c.base, cand: c.cand });
  }
  const cls = [...classes.values()].map(c => ({ ...c, rate: c.recorded ? c.agree / c.recorded : null }))
    .sort((a, b) => arms.indexOf(a.arm) - arms.indexOf(b.arm) || RULING_CLASSES.indexOf(a.cls) - RULING_CLASSES.indexOf(b.cls));
  return { project: o.project ?? null, at: o.at ?? null, arms, classes: cls, arms_total: arms.map(a => total.get(a)), disagreements, choices,
    ticks: [...ticks.values()].sort((a, b) => String(a.ts).localeCompare(String(b.ts))) };
}

/** Where the Spend page reads a project's replay report (`norn eval report --write`): a report beside the state, never a record. */
export const replayReportFile = state => `${state}/eval/checkin-replay.json`;
