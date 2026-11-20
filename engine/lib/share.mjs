// Shares (fair-slots items 1 + 8): how the machine-wide Claude worker pool (max_claude_workers, one cap for every project on the
// machine) is split between the registered projects. Pure: no file reads. The fill (runs.mjs walkQueue) asks slotVerdict before a
// queued run takes a Claude slot; Settings > Capacity writes the per-project keys through the Settings write path (policy.mjs).
// Machine budget (local/budget.json) key project_workers: { "<project>": { reserve_claude_workers, max_claude_workers_project } }.
// reserve = slots kept free for the project while it has queued work (lent to the others while it has none); ceiling = the most it
// may hold at once. Defaults: reserve 0, ceiling = the machine cap - with no keys set the fill is the plain fair fill.
export const SHARE_KEY = 'project_workers';
export const RESERVE = 'reserve_claude_workers', CEILING = 'max_claude_workers_project';
const capOf = budget => (Number.isInteger(budget?.max_claude_workers) ? budget.max_claude_workers : null);
/** { reserve, ceiling } of a project (ceiling null = no ceiling: the machine cap is unset) */
export function shareOf(budget, project) {
  const s = budget?.[SHARE_KEY]?.[project] ?? {}, cap = capOf(budget);
  const reserve = Number.isInteger(s[RESERVE]) && s[RESERVE] > 0 ? s[RESERVE] : 0;
  const ceiling = Number.isInteger(s[CEILING]) && s[CEILING] >= 0 ? (cap === null ? s[CEILING] : Math.min(s[CEILING], cap)) : cap;
  return { reserve, ceiling };
}
/** the words when the shares do not fit the machine cap (Settings refuses the save), else null */
export function sharesProblem(budget) {
  const all = Object.entries(budget?.[SHARE_KEY] ?? {}), cap = capOf(budget);
  for (const [p, s] of all) {
    const r = s?.[RESERVE] ?? 0, c = s?.[CEILING];
    if (c !== undefined && c !== null && Number.isInteger(r) && Number.isInteger(c) && r > c) return `${p}: reserve ${r} is above its ceiling ${c}`;
  }
  if (cap === null) return null;
  const sum = all.reduce((n, [, s]) => n + (Number.isInteger(s?.[RESERVE]) ? s[RESERVE] : 0), 0);
  if (sum <= cap) return null;
  const list = all.filter(([, s]) => s?.[RESERVE] > 0).map(([p, s]) => `${p} ${s[RESERVE]}`).join(' + ');
  return `the reserves add up to ${sum} (${list}), ${sum - cap} more than max_claude_workers ${cap}: lower a reserve or raise the cap`;
}
/**
 * May `project` take one free Claude slot now? null = yes, else the words (a fill term). The caller has checked that the machine cap
 * has room. live: { project: running Claude workers } (every project, the caller's pending starts included); waiting: { project:
 * { n: queued runs that wait only for capacity, since: ms the project has waited (its oldest such run, or its last start if later) } }
 * for the OTHER projects; mine: the same `since` for this project. Order: the project's ceiling, then its own reserve (a slot of its
 * reserve is its own), then the other projects' reserves (kept free while they wait), then the fair share: the project that has waited
 * longest goes first (ties: the name), so a project that keeps ending and queuing runs cannot keep the slot it just freed.
 */
export function slotVerdict({ budget, project, live, waiting, mine }) {
  const cap = capOf(budget);
  if (cap === null) return null;
  const n = p => live[p] ?? 0, me = shareOf(budget, project);
  if (me.ceiling !== null && n(project) >= me.ceiling) return `ceiling: ${project} runs ${n(project)} Claude worker(s), ${CEILING} ${me.ceiling}`;
  if (n(project) < me.reserve) return null;
  const free = cap - Object.values(live).reduce((a, b) => a + b, 0);
  if (free <= 0) return null;   // the cap check says full (not this rule's words)
  const others = Object.entries(waiting).filter(([p, w]) => p !== project && w.n > 0 && (shareOf(budget, p).ceiling ?? Infinity) > n(p));
  const held = others.map(([p, w]) => [p, Math.max(0, Math.min(shareOf(budget, p).reserve - n(p), w.n))]).filter(([, h]) => h > 0);
  const kept = held.reduce((a, [, h]) => a + h, 0);
  if (free <= kept) return `reserved: the free Claude slot is kept for ${held.map(([p, h]) => `${p} (${RESERVE}, ${h} owed)`).join(', ')}`;
  const owed = new Map(held);
  const ahead = others.filter(([p, w]) => w.n > (owed.get(p) ?? 0) && (w.since < mine || (w.since === mine && p < project))).sort(([a, x], [b, y]) => x.since - y.since || (a < b ? -1 : 1));
  if (free - kept <= ahead.length) return `share: the next Claude slot goes to ${ahead[0][0]} (waiting since ${new Date(ahead[0][1].since).toISOString().slice(0, 16)}Z)`;
  return null;
}
