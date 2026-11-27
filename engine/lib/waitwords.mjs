// RM-b-21 S1b (CAPACITY-UX 4.3, DEC-a-679): ONE word module for why a queued run waits. The fill walk (runs.mjs walkQueue) writes its
// terms as strings - `norn ready`, META-QUEUE.md and the digest print them as they are; every page turns them into words here: the Plan
// and the Lanes Waiting rows (plan.mjs buildPlan: text) and the Inbox hold card / digest row (holds.mjs holdItem: text, reason, fix ...).
// Pure. waitWords(term) -> { code, text, reason, fix, clears, setting } (+ command / file / resume / run where they apply); firstReason(row)
// picks the one reason a walk row shows, by REASON_ORDER. The patterns sit in one function per group (GROUPS, the first answer wins); a
// term of a known kind (its prefix) in a form no pattern reads gets the kind's plain sentence, one of no known kind comes back as code
// 'unknown' with the raw term: tests/waitwords.test.mjs keeps one sample per term kind the walk writes and fails on that.
import { billingOf } from './billing.mjs';
import { loginCommand } from './authguard.mjs';
import { PAUSE_MODES } from './pausemode.mjs';
import { NID, RUN_ID_RE } from './records.mjs';

const AFTER_WORD = { merged: 'merge', done: 'finish', ended: 'end', reviewed: 'be reviewed' };   // after.mjs AFTER_KINDS.run states
export const hhmm = iso => `${String(iso).slice(0, 16).replace('T', ' ')}Z`;
// reason: the longer sentence (the Inbox hold card's title); fix: what clears it by hand; clears: null = only the fix clears it
const W = (code, text, o = {}) => ({ code, text, reason: o.reason ?? text, fix: o.fix ?? null, clears: o.clears ?? null, setting: o.setting ?? null, ...o.extra });

/**
 * one fill-walk term -> { code, text, reason, fix, clears, setting, command?, file?, resume?, run? }.
 * ctx: { label (run id -> its name; default the id), now, billing (the budget billing key), status (STATUS.md text: the weekly reset),
 *   clock ((ms, now) -> words; default the UTC minute; the Plan passes its day-aware dayClock - plan.mjs imports this module, not back) }
 */
export function waitWords(term, { label = id => id, now = Date.now(), billing = null, status = '', clock = ms => hhmm(new Date(ms).toISOString()) } = {}) {
  const at = iso => { const ms = Date.parse(iso); return Number.isFinite(ms) ? clock(ms, now) : iso; };
  const t = String(term), cx = { at, name: id => (RUN_ID_RE.test(id) ? label(id) ?? id : id), billing, status };
  for (const g of GROUPS) { const w = g(t, cx); if (w) return w; }
  return W('unknown', t, { fix: 'see norn plan (the Waiting lanes on the dashboard)' });
}

// ---- the run itself: withdrawn, a condition to rule on, its after conditions, the automatic lane order, its clock ----
function runWords(t, { at, name }) {
  let m;
  if (t.startsWith('withdraw: ')) return W('withdrawn', `withdrawn: ${t.slice(10)}`);
  if (t.startsWith('needs a ruling: ')) return W('ruling', `needs a ruling (the check-in repairs it): ${t.slice(16)}`, { clears: 'when the check-in rules on it' });
  const after = (k, P) => t.match(new RegExp(`^after ${k}:(${NID(P)}):(\\w+) unmet$`));
  if ((m = after('run', 'RUN'))) return W('after', `waits for ${name(m[1])} to ${AFTER_WORD[m[2]] ?? m[2]}`, { clears: 'by itself when it does', extra: { run: m[1] } });
  if ((m = after('q', 'Q'))) return W('after', m[2] === 'applied' ? `waits for your answer (${m[1]}) to be applied` : `waits for your answer (${m[1]})`, { fix: `answer ${m[1]} (the Inbox)` });
  if ((m = after('dlv', 'DLV'))) return W('after', `waits for finished work ${m[1]} to reach main`, { clears: 'by itself when it merges' });
  if ((m = after('dir', 'DIR'))) return W('after', `waits for instruction ${m[1]} to be done`, { clears: 'by itself when it is done' });
  if ((m = t.match(/^after \(auto\): (?:run|dlv):(\S+):merged - (.*)$/))) return W('order', `waits for ${name(m[1])} to merge first (an automatic lane order: ${m[2]})`, { clears: 'by itself when it lands', fix: 'rule the collision (norn collide) to start it anyway' });
  if ((m = t.match(/^not_before (\S+)$/))) return W('not-before', `not before ${at(m[1])}`, { clears: 'by itself at that time' });
  return null;
}
// ---- the budget file, the merge leader, a pause ----
function homeWords(t) {
  let m;
  if ((m = t.match(/^budget (.+) unreadable \((.*)\): held until it parses$/)))
    return W('budget', `held: the budget file ${m[1]} cannot be read`, { reason: `the budget file ${m[1]} does not parse (${m[2]})`, clears: 'by itself once the file parses', fix: `fix the JSON in ${m[1]}`, extra: { file: m[1] } });
  if ((m = t.match(/^MERGE: (.+) - this home only opens PRs$/)))
    return W('leader', `waits: this home is not the merge leader (${m[1]})`, { clears: 'by itself when the tick confirms this home as merge leader' });
  if ((m = t.match(/^PAUSED (\w+) \((.+)\)$/))) return W('paused', 'held: paused', { reason: `Norn is paused (${PAUSE_MODES[m[1]]?.label ?? m[1]}): the file ${m[2]} holds every start`,
    fix: `resume all (the header's pause menu, or norn resume --all) - it deletes the project's own PAUSED file; a machine-level ${m[2]} is deleted by hand`, extra: { file: m[2], resume: true } });
  return null;
}
// ---- the usage guard ----
function usageWords(t, { billing, status }) {
  let m;
  if (t === 'usage: weekly unknown') {
    const bm = billingOf({ billing }), short = 'held: weekly usage not measured yet (on API billing, set Billing to api)';
    return bm && bm.type !== 'api'
      ? W('usage', short, { reason: `the weekly usage is not measured yet, and the usage guard holds Claude work it cannot measure (billing: ${bm.label})`, setting: 'billing',
        fix: 'run norn calib --pct N, N = the weekly % claude.ai shows (Settings > Usage), so Norn can measure the week; on API billing set Billing (Settings) to api instead', extra: { command: 'norn calib --pct N' } })
      : W('usage', short, { reason: 'the weekly usage is not measured yet, and the usage guard holds Claude work it cannot measure (Billing is not set)', setting: 'billing',
        fix: 'set Billing (Settings): on API billing choose api (no weekly limit, nothing to measure); on a plan (pro, max-5x, max-20x, ultra) choose it, then run norn calib --pct N with the weekly % claude.ai shows', extra: { command: 'norn calib --pct N' } });
  }
  if (t === 'usage: RATE_OK unknown') return W('usage', 'held: hourly usage not measured yet', { reason: 'the hourly usage rate is not measured yet (STATUS.md has no RATE_OK line)', setting: 'billing',
    fix: 'run norn status (the tick writes STATUS.md every pass; the tick log says why it did not); on API billing set Billing (Settings) to api', extra: { command: 'norn status' } });
  if (t === 'usage: RATE_OK=0') return W('usage', 'held: usage over the hourly cap', { reason: 'Claude usage over the last 2 h is above the hourly rate cap', setting: 'usage_rate_cap_pct_per_h',
    clears: 'by itself as the trailing 2 h rate falls under the cap', fix: 'wait, or raise the usage rate cap (Settings)' });
  if ((m = t.match(/^usage: weekly ([\d.]+) % >= guard ([\d.]+) %$/))) {
    const reset = status.match(/reset (\d{4}-\d\d-\d\dT\d\d:\d\dZ)/)?.[1] ?? null;
    return W('usage', `held: weekly usage at the stop (${m[1]} % of ${m[2]} %)`, { reason: `the week's usage (${m[1]} %) reached the weekly stop (${m[2]} %)`, setting: 'weekly_stop_pct',
      clears: reset ? `by itself at the weekly reset (${hhmm(reset)})` : 'by itself at the weekly reset', fix: 'wait for the reset, or raise the weekly stop (Settings)' });
  }
  if ((m = t.match(/^usage: api spend \$([\d.]+) in 24 h >= cap \$([\d.]+)$/))) return W('usage', `held: API spend $${m[1]} in 24 h reached the $${m[2]} daily cap`,
    { reason: `API spend ($${m[1]} in the last 24 h) reached the $${m[2]} daily cap`, setting: 'api_usd_per_day', clears: 'by itself as the last 24 h of spend falls under the cap', fix: 'wait, or raise or clear the API daily cap (Settings)' });
  return null;
}
// ---- a closed quota, the login ----
function quotaWords(t, { at }) {
  let m;
  if ((m = t.match(/^limit: (\S+) out of quota until (\S+) \(([^)]*)\) - (.*)$/)))
    return W('quota', `held: ${m[1]} is out of quota until ${at(m[2])}`, { reason: `${m[1]} hit its usage limit (${m[3]}); it resets at ${at(m[2])}`, clears: 'by itself at the reset', fix: m[4] });
  if ((m = t.match(/^auth: (\S+) (login down|vendor outage) since (\S+) \((.*)\)(?:; (.*))?$/))) {
    const cmd = loginCommand(m[1]), probe = m[5] ? ` (${m[5].replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, x => at(x))})` : '';
    return m[2] === 'vendor outage'
      ? W('login', `held: a ${m[1]} vendor outage since ${at(m[3])}; it resumes by itself, no login needed${probe}`, { reason: `${m[1]} reports an outage (${m[4]})`, clears: 'by itself when a probe passes', fix: 'nothing to do: a vendor outage, not your login' })
      : W('login', `held: the ${m[1]} login is down since ${at(m[3])}; run ${cmd}${probe}`, { reason: `the ${m[1]} login is down (${m[4]})`, fix: `run ${cmd} in a terminal`, extra: { command: cmd } });
  }
  if ((m = t.match(/^auth: (\S+) probe passed (\S+); (?:one canary launch since \S+, the rest wait for it|a canary launch is starting)$/)))
    return W('login', `held: the ${m[1]} login is back; one test launch goes first and the rest wait for it`, { clears: 'by itself when the test launch lives' });
  return null;
}
// ---- folders, merges, the crew, other homes, other lanes ----
function laneWords(t, { name }) {
  let m;
  if ((m = t.match(/^worktree held by (\S+)/))) return W('folder', `waits for its folder (${RUN_ID_RE.test(m[1]) ? name(m[1]) : 'another run'} is writing there)`, { clears: 'by itself when that run ends', extra: { run: RUN_ID_RE.test(m[1]) ? m[1] : null } });
  if ((m = t.match(/^lane worktree \S+ held by (\S+)/))) return W('folder', `waits for its lane's folder (${RUN_ID_RE.test(m[1]) ? name(m[1]) : 'another run'} is writing there)`, { clears: 'by itself when that run ends', extra: { run: RUN_ID_RE.test(m[1]) ? m[1] : null } });
  if ((m = t.match(/^merge slots full: (\d+) merge/))) return W('merge', `waits for a merge slot (${m[1]} merge${m[1] === '1' ? '' : 's'} running)`, { setting: 'policy.merge.parallel', clears: 'by itself when a merge ends' });
  if (/^MERGE \S+: /.test(t)) return W('lane-writing', 'held: its lane is still writing (a merge needs a prepared merge brief)', { reason: t.replace(/^MERGE \S+: /, ''),
    fix: 'write a staged brief: norn merge-brief --sha <READY sha>', extra: { command: 'norn merge-brief --sha <READY sha>' } });
  if ((m = t.match(new RegExp(`^dwarf: (.+) is busy on (${NID('RUN')})$`)))) return W('dwarf', `waits for ${m[1]}, its pinned dwarf (busy on ${name(m[2])})`, { reason: `the lane is pinned to ${m[1]}, who is busy on ${m[2]}`,   // a pinned dwarf works its lane only, one run at a time
    clears: `by itself when ${m[2]} ends`, fix: 'wait, or unpin the dwarf: norn crew unpin <id>', extra: { command: 'norn crew unpin <id>' } });
  if (t.startsWith('crew store ')) return W('dwarf', 'held: the crew store is unreadable', { reason: t, fix: 'repair or move the crew store file: no worker run starts without a dwarf' });
  if ((m = t.match(/^claim: (.*) \(held by (.+)\)$/))) return W('claim', `waits for the home ${m[2]}: it has claimed this work (${m[1]})`, { clears: `by itself when ${m[2]} ends or releases its claim` });
  if ((m = t.match(/^collide: territory \(([^)]*)\) land-first: waits up to (\d+) min for (\S+) of lane (\S+)/)))
    return W('collide', `waits up to ${m[2]} min for lane ${m[4]} to land ${m[3]} first (its files overlap)`, { clears: 'by itself when it lands or the wait runs out' });
  if ((m = t.match(/^collide: (\w+)(?: \(([^)]*)\))*.* - waits for lane (\S+?)(?: \(a wait, (.*)\))?$/)))
    return W('collide', `waits for lane ${m[3]}: their work collides (${m[1]})`, { clears: `by itself when lane ${m[3]} lands`, fix: m[4] ? null : 'rule the collision (norn collide) to start it anyway' });
  return null;
}
// ---- capacity: a slot kept for an older run, the project's share, the cap, the machine, a refused start ----
function capacityWords(t, { at, name }) {
  let m;
  if ((m = t.match(/^cap ([\w, ]+): kept for (.+) \(fill order per cap\)$/)))
    return W('kept', 'waits for a worker slot', { reason: `the next ${m[1].split(', ')[0]} slot goes to ${m[2].split(', ').map(name).join(', ')} first (the fill order)`, setting: m[1].split(', ')[0], clears: 'by itself when a slot frees up' });
  if ((m = t.match(/^ceiling: (\S+) runs (\d+) Claude worker\(s\), (\w+) (\d+)$/)))
    return W('ceiling', `waits: ${m[1]} already runs its most Claude workers (${m[2]} of ${m[4]})`, { setting: m[3], clears: `by itself when a ${m[1]} run ends`, fix: 'raise the project ceiling (Settings > Capacity)' });
  if ((m = t.match(/^reserved: the free Claude slot is kept for (.+)$/)))
    return W('reserved', `waits: the free Claude slot is kept for another project's reserve (${m[1].replace(/ \(reserve_claude_workers, (\d+) owed\)/g, ', $1 owed')})`, { setting: 'reserve_claude_workers', clears: 'by itself when that project starts its work or has none left' });
  if ((m = t.match(/^share: the next Claude slot goes to (\S+) \(waiting since (\S+)\)$/)))
    return W('share', `waits: the next Claude slot goes to ${m[1]}, which has waited longer`, { reason: `${m[1]} has waited for a Claude slot since ${at(m[2])}: the fair share gives it the next one`, clears: 'by itself after that start' });
  if ((m = t.match(/^cap: (\d+) (\S+) workers running, budget (\w+)=(\d+): (\d+) slot\(s\) kept for the queued merges \(fill\.merge_reserve\)$/)))
    return W('cap', `waits for a worker slot (${m[5]} kept for the queued merges)`, { reason: `${m[1]} ${m[2]} workers run of ${m[4]} (${m[3]}), and ${m[5]} slot(s) stay free for the merges that wait`, setting: 'policy.fill.merge_reserve', clears: 'by itself when the merges start' });
  if ((m = t.match(/^cap: (\d+) (\S+) workers running, budget (\w+)=(\d+)/)))
    return W('cap', 'waits for a worker slot', { reason: `${m[1]} ${m[2]} workers run of ${m[4]} (${m[3]})`, setting: m[3], clears: 'by itself when a slot frees up' });
  if ((m = t.match(/^resources: CPU busy (\d+) % > fill\.max_cpu_pct (\S+)$/)))
    return W('busy', 'held: CPU / memory gate', { reason: `this machine is busy (CPU ${m[1]} % > ${m[2]} %)`, setting: 'policy.fill.max_cpu_pct', clears: 'by itself when the CPU frees up' });
  if ((m = t.match(/^resources: free RAM ([\d.]+) GB < fill\.min_free_gb (\S+)$/)))
    return W('busy', 'held: CPU / memory gate', { reason: `this machine is low on memory (${m[1]} GB free < ${m[2]} GB)`, setting: 'policy.fill.min_free_gb', clears: 'by itself when memory frees up' });
  if (t.startsWith('refused: ')) return W('refused', `not started: ${t.slice(9)}`, { clears: 'the next fill pass tries again' });
  return null;
}
// ---- a term whose kind its prefix names but whose detail no pattern above reads (a form the walk may write later): the kind's plain
// sentence, the raw term as its reason; only a term of no known kind stays 'unknown' ----
const KINDS = [[/^resources:/, 'busy', 'held: CPU / memory gate'], [/^cap[ :]/, 'cap', 'waits for a worker slot'], [/^usage:/, 'usage', 'held: the usage guard'],
  [/^limit:/, 'quota', 'held: out of quota'], [/^auth:/, 'login', 'held: the login guard'], [/^claim:/, 'claim', 'waits for another home: it has claimed this work'],
  [/^collide:/, 'collide', 'waits for another lane: their work collides'], [/^MERGE: /, 'leader', 'waits: this home is not the merge leader'],
  [/^MERGE /, 'lane-writing', 'held: its lane is still writing (a merge needs a prepared merge brief)']];
function kindWords(t) { const k = KINDS.find(([re]) => re.test(t)); return k ? W(k[1], k[2], { reason: t }) : null; }
const GROUPS = [runWords, homeWords, usageWords, quotaWords, laneWords, capacityWords, kindWords];

// CAPACITY-UX 4.3: the one reason a row shows first (the rest are "+ n more"): what only you can clear, then what clears by itself, the
// slot wait last; the share codes sit between kept and cap
export const REASON_ORDER = ['withdrawn', 'ruling', 'paused', 'login', 'quota', 'usage', 'budget', 'leader', 'after', 'order', 'not-before', 'folder', 'lane-writing', 'merge', 'dwarf',
  'claim', 'collide', 'kept', 'ceiling', 'reserved', 'share', 'cap', 'busy', 'refused', 'unknown'];
const rank = c => REASON_ORDER.indexOf(c);
const READY = () => ({ ...W('ready', 'ready to start'), term: null, more: 0 });
/** a fill-walk row ({ ready, terms }) -> its first reason: waitWords(...) + { term, more (the other terms' count) }; a row with no term
 * is ready; null = no row. ctx as waitWords. */
export function firstReason(row, ctx = {}) {
  if (!row) return null;
  const ws = row.ready ? [] : (row.terms || []).map(t => ({ ...waitWords(t, ctx), term: t }));
  if (!ws.length) return READY();
  return { ...ws.reduce((a, b) => (rank(b.code) < rank(a.code) ? b : a)), more: ws.length - 1 };
}
