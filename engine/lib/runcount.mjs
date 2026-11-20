// OVERVIEW-TRUTH (6): how runs are counted, one rule for every page (Runs, Usage, any stats). Owner report 2026-11-19: "119 finished,
// 65 withdrawn, 27 handoffs" read as churn, yet the 65 withdrawn cost $0 (none ever started) and 101 'filled' records were queue entries
// that became runs. So: queue bookkeeping (withdrawn before start, filled) is counted apart from real runs; a hand-off chain (resume_of)
// is ONE piece of work with N sessions; 'unfinished' = stopped + lost + crash + no-result, with what they cost. Pure over fold run items.

export const BOOKKEEPING = ['withdrawn', 'filled'];          // queue entries, never a session of their own
export const UNFINISHED = ['stopped', 'lost', 'crash', 'no-result'];
const usd = r => (typeof r.end?.cost_usd === 'number' ? r.end.cost_usd : 0);
/** a run's outcome word: its end outcome, or lost / killed / running / queued from its state; an exit with no outcome = no-result */
export const outcomeOf = r => r.state === 'exited' ? r.end?.outcome ?? 'no-result' : r.state === 'claimed' ? 'queued' : r.state;
// why a queue entry was withdrawn, in a few classes (the record's why; none = 'no reason recorded', which code now refuses)
export function withdrawClass(r) {
  const why = String(r.withdraw?.why ?? r.history?.findLast?.(h => h.ev === 'withdraw')?.data?.why ?? '').trim();
  if (!why) return 'no reason recorded';
  if (/landed by hand|lands .* mechanically|landed as/i.test(why)) return 'landed another way';
  if (r.withdraw?.next || /re-?queue/i.test(why)) return 're-queued';
  if (/priorit|bump|hold|held|P[0-4]\b/i.test(why)) return 'priority / hold';
  return 'other';
}

/**
 * runs (fold run items) -> { runs (real sessions), usd, work: { pieces, sessions, chained (pieces of more than one session) },
 *   outcomes { word: n }, unfinished: { n, usd, by: { stopped|lost|crash|no-result: { n, usd } } },
 *   bookkeeping: { withdrawn, filled, why: { class: n } } }
 */
export function runCounts(runs) {
  const all = runs.filter(r => r.kind === 'run'), real = all.filter(r => !BOOKKEEPING.includes(r.state)), byId = new Map(real.map(r => [r.id, r]));
  const root = r => { let x = r; for (const seen = new Set(); x.data?.resume_of && byId.has(x.data.resume_of) && !seen.has(x.id);) { seen.add(x.id); x = byId.get(x.data.resume_of); } return x.id; };
  const pieces = new Map();
  for (const r of real) { const k = root(r); pieces.set(k, (pieces.get(k) ?? 0) + 1); }
  const outcomes = {}, by = Object.fromEntries(UNFINISHED.map(k => [k, { n: 0, usd: 0 }]));
  for (const r of real) { const o = outcomeOf(r); outcomes[o] = (outcomes[o] ?? 0) + 1; if (by[o]) { by[o].n++; by[o].usd += usd(r); } }
  const why = {};
  for (const r of all.filter(r => r.state === 'withdrawn')) { const c = withdrawClass(r); why[c] = (why[c] ?? 0) + 1; }
  const un = Object.values(by);
  return { runs: real.length, usd: real.reduce((a, r) => a + usd(r), 0),
    work: { pieces: pieces.size, sessions: real.length, chained: [...pieces.values()].filter(n => n > 1).length },
    outcomes, unfinished: { n: un.reduce((a, x) => a + x.n, 0), usd: un.reduce((a, x) => a + x.usd, 0), by },
    bookkeeping: { withdrawn: all.filter(r => r.state === 'withdrawn').length, filled: all.filter(r => r.state === 'filled').length, why } };
}

const $ = v => `$${(Number(v) || 0).toFixed(2)}`;
/** the one line every page shows: "N runs as K pieces of work (H continued by hand-off) · unfinished U ($x: ...) · queue bookkeeping apart: ..." */
export function countsLine(c) {
  const parts = UNFINISHED.filter(k => c.unfinished.by[k].n).map(k => `${c.unfinished.by[k].n} ${k}`);
  const bk = c.bookkeeping, why = Object.entries(bk.why).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(', ');
  return [`${c.runs} run${c.runs === 1 ? '' : 's'} as ${c.work.pieces} piece${c.work.pieces === 1 ? '' : 's'} of work${c.work.chained ? ` (${c.work.chained} continued by hand-off)` : ''}`,
    `unfinished ${c.unfinished.n} (${$(c.unfinished.usd)}${parts.length ? `: ${parts.join(', ')}` : ''})`,
    `queue bookkeeping, not runs: ${bk.withdrawn} withdrawn before start${why ? ` (${why})` : ''}, ${bk.filled} filled`].join(' · ');
}
