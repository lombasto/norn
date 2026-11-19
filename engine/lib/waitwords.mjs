// RM-21 S1 (CAPACITY-UX 2, 4.3): ONE word module for why a queued run waits. The fill walk (runs.mjs walkQueue) writes its terms as
// strings - `norn ready`, META-QUEUE.md and the digest print them as they are; every page turns them into one plain sentence here.
// Pure. waitWords(term) -> { code, text, fix, clears, setting, acts } (+ file / command / resume where the fix has one); firstReason(row)
// picks the one reason a walk row shows, by the order of CAPACITY-UX 4.3. A term no pattern matches comes back as code 'unknown' with
// the raw term: tests/waitwords.test.mjs keeps one sample per term kind the walk writes and fails on that.
import { billingOf } from './billing.mjs';
import { loginCommand } from './authguard.mjs';

const AFTER_WORD = { merged: 'merge', done: 'finish', ended: 'end' };
// a cap key or an executor name -> the slot's name ("a free Claude slot")
const SLOT = { max_claude_workers: 'Claude', max_codex: 'Codex', max_sol: 'Codex (sol)', max_astra: 'Codex (astra)', claude: 'Claude', codex: 'Codex', 'codex-sol': 'Codex (sol)', 'codex-astra': 'Codex (astra)' };
const slot = k => SLOT[k] ?? k.replace(/^max_/, '');
const hhmm = iso => `${String(iso).slice(0, 16).replace('T', ' ')}Z`;
const W = (code, text, o = {}) => ({ code, text, fix: o.fix ?? null, clears: o.clears ?? null, setting: o.setting ?? null, acts: o.acts ?? [], ...o.extra });

/**
 * one fill-walk term -> { code, text, fix, clears (null = only the fix clears it), setting (the Settings row that governs it), acts }.
 * ctx: { label (run id -> its name; default the id), now, billing (the budget billing key), status (STATUS.md text: the weekly reset),
 *   state (the project's state dir: tells this project's PAUSED file from all of Norn's), clock ((ms, now) -> words; default the UTC
 *   minute; the Plan passes its day-aware dayClock - this module imports no plan.mjs: plan.mjs imports it) }
 */
export function waitWords(term, { label = id => id, now = Date.now(), billing = null, status = '', state = null, clock = ms => hhmm(new Date(ms).toISOString()) } = {}) {
  const at = iso => { const t = Date.parse(iso); return Number.isFinite(t) ? clock(t, now) : iso; };
  const t = String(term), name = id => (/^RUN-\d+$/.test(id) ? label(id) ?? id : id);
  let m;
  if (t.startsWith('withdraw: ')) return W('withdrawn', `Withdrawn: ${t.slice(10)}.`);
  if (t.startsWith('needs a ruling: ')) return W('ruling', `Needs a ruling: ${t.slice(16)}. The check-in repairs it.`, { acts: ['start-anyway', 'cancel'] });
  if ((m = t.match(/^PAUSED \((.+)\)$/))) {
    const own = state && m[1].replace(/\\/g, '/').replace(/\/PAUSED$/, '') === String(state).replace(/\\/g, '/').replace(/\/$/, '');
    return W('paused', own === null ? `Paused (${m[1]}).` : own ? 'Paused: this project.' : 'Paused: all of Norn.', { acts: ['resume'],
      fix: `delete ${m[1]} (the header's Resume button deletes the project's own PAUSED file)`, extra: { file: m[1], resume: true } });
  }
  if ((m = t.match(/^auth: (\S+) (login down|vendor outage) since (\S+) \((.*)\)(?:; (.*))?$/))) {
    const cmd = loginCommand(m[1]), probe = m[5] ? ` (${m[5].replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, x => at(x))})` : '';
    return m[2] === 'vendor outage'
      ? W('login', `Held: a ${m[1]} vendor outage since ${at(m[3])}; it resumes by itself, no login needed${probe}.`, { clears: 'by itself when a probe passes', fix: 'nothing to do: a vendor outage, not your login' })
      : W('login', `Held: the ${m[1]} login is down since ${at(m[3])}; run ${cmd}${probe}.`, { fix: `run ${cmd} in a terminal`, extra: { command: cmd } });
  }
  if ((m = t.match(/^auth: (\S+) probe passed (\S+); (?:one canary launch since \S+, the rest wait for it|a canary launch is starting)$/)))
    return W('login', `Held: the ${m[1]} login is back; one test launch goes first and the rest wait for it.`, { clears: 'by itself when the test launch lives' });
  if ((m = t.match(/^limit: (\S+) out of quota until (\S+) \(([^)]*)\) - (.*)$/)))
    return W('quota', `Held: ${m[1]} is out of quota until ${at(m[2])}.`, { clears: 'by itself at the reset', fix: m[4], acts: ['quota-back'] });
  if (t === 'usage: weekly unknown') {
    const bm = billingOf({ billing });
    return bm && bm.type !== 'api'
      ? W('usage', `Held: the weekly usage is not measured yet, and the usage guard holds Claude work it cannot measure (billing: ${bm.label}).`, { setting: 'billing',
        fix: 'run norn calib --pct N, N = the weekly % claude.ai shows (Settings > Usage), so Norn can measure the week; on API billing set Billing (Settings) to api instead', extra: { command: 'norn calib --pct N' } })
      : W('usage', 'Held: the weekly usage is not measured yet, and the usage guard holds Claude work it cannot measure (Billing is not set).', { setting: 'billing',
        fix: 'set Billing (Settings): on API billing choose api (no weekly limit, nothing to measure); on a plan (pro, max-5x, max-20x, ultra) choose it, then run norn calib --pct N with the weekly % claude.ai shows', extra: { command: 'norn calib --pct N' } });
  }
  if (t === 'usage: RATE_OK unknown') return W('usage', 'Held: the hourly usage rate is not measured yet (STATUS.md has no RATE_OK line).', { setting: 'billing',
    fix: 'run norn status (the tick writes STATUS.md every pass; the tick log says why it did not); on API billing set Billing (Settings) to api', extra: { command: 'norn status' } });
  if (t === 'usage: RATE_OK=0') return W('usage', 'Held: usage over the hourly cap. Clears by itself.', { setting: 'usage_rate_cap_pct_per_h',
    clears: 'by itself as the trailing 2 h rate falls under the cap', fix: 'wait, or raise the usage rate cap (Settings)' });
  if ((m = t.match(/^usage: weekly ([\d.]+) % >= guard ([\d.]+) %$/))) {
    const reset = status.match(/reset (\d{4}-\d\d-\d\dT\d\d:\d\dZ)/)?.[1] ?? null;
    return W('usage', `Held: the week's usage (${m[1]} %) reached the weekly stop (${m[2]} %). Clears at the reset.`, { setting: 'weekly_stop_pct',
      clears: reset ? `by itself at the weekly reset (${hhmm(reset)})` : 'by itself at the weekly reset', fix: 'wait for the reset, or raise the weekly stop (Settings)' });
  }
  if ((m = t.match(/^usage: api spend \$([\d.]+) in 24 h >= cap \$([\d.]+)$/))) return W('usage', `Held: API spend ($${m[1]} in 24 h) reached the $${m[2]} daily cap.`,
    { setting: 'api_usd_per_day', clears: 'by itself as the last 24 h of spend falls under the cap', fix: 'wait, or raise or clear the API daily cap (Settings)' });
  if ((m = t.match(/^budget (.+) unreadable \((.*)\): held until it parses$/)))
    return W('budget', `Held: the budget file ${m[1]} cannot be read (${m[2]}).`, { clears: 'by itself once the file parses', fix: `fix the JSON in ${m[1]}`, extra: { file: m[1] } });
  if ((m = t.match(/^after run:(RUN-\d+):(\w+) unmet$/))) return W('after', `Waiting for ${name(m[1])} to ${AFTER_WORD[m[2]] ?? `reach ${m[2]}`}.`, { acts: ['start-anyway'] });
  if ((m = t.match(/^after dlv:(DLV-\d+):(\w+) unmet$/))) return W('after', `Waiting for ${m[1]} to ${m[2] === 'merged' ? 'merge' : `reach ${m[2]}`}.`, { acts: ['start-anyway'] });
  if ((m = t.match(/^after q:(Q-\d+):(\w+) unmet$/))) return W('after', m[2] === 'applied' ? `Waiting for your answer to ${m[1]} to be applied.` : `Waiting for your answer to ${m[1]}.`, { acts: ['answer'] });
  if ((m = t.match(/^after dir:(DIR-\d+):\w+ unmet$/))) return W('after', `Waiting for instruction ${m[1]} to be done.`, { acts: ['start-anyway'] });
  if ((m = t.match(/^after (\S+) unmet$/))) return W('after', `Waiting for ${m[1]}.`, { acts: ['start-anyway'] });
  if ((m = t.match(/^not_before (\S+)$/))) return W('not-before', `Starts at ${at(m[1])}.`, { clears: 'by itself at that time', acts: ['start-now'] });
  if ((m = t.match(/^worktree held by (\S+)/))) return W('folder', `Waiting for its folder: ${/^RUN-\d+$/.test(m[1]) ? name(m[1]) : 'another run'} is writing there.`, { extra: { run: /^RUN-\d+$/.test(m[1]) ? m[1] : null } });
  if ((m = t.match(/^lane worktree \S+ held by (\S+)/))) return W('folder', `Waiting for its lane's folder: ${/^RUN-\d+$/.test(m[1]) ? name(m[1]) : 'another run'} is writing there.`, { extra: { run: /^RUN-\d+$/.test(m[1]) ? m[1] : null } });
  if ((m = t.match(/^merge slots full: (\d+) merge/))) return W('merge', `Waiting for a merge slot (${m[1]} merge${m[1] === '1' ? '' : 's'} running).`, { setting: 'policy.merge.parallel' });
  if ((m = t.match(/^MERGE \S+: .*?\blive run (RUN-\d+)/)) || /^MERGE /.test(t)) return W('folder', `Waiting: its lane is still writing${m?.[1] ? ` (${name(m[1])})` : ''}; a merge needs a prepared merge brief.`,
    { fix: 'write a staged brief: norn merge-brief --sha <READY sha>' });
  if ((m = t.match(/^labels (\S+): not served here/))) return W('elsewhere', `Offered to another machine (it needs ${m[1]}).`);
  if ((m = t.match(/^cap ([\w, ]+): kept for (.+) \(fill order per cap\)$/))) {
    const ahead = m[2].split(', ');
    return W('kept', `Waiting for a free ${slot(m[1].split(', ')[0])} slot; ${ahead.map(name).join(', ')} ${ahead.length === 1 ? 'is' : 'are'} ahead in line.`, { setting: m[1].split(', ')[0], acts: ['cap+1'] });
  }
  if ((m = t.match(/^cap: (\d+) (\S+) workers running, budget (\w+)=(\d+)$/)))
    return W('cap', `Waiting for a free ${slot(m[3])} slot (${m[1]} / ${m[4]}). Next in line.`, { setting: m[3], acts: ['cap+1'] });
  if ((m = t.match(/^resources: CPU busy (\d+) % > fill\.max_cpu_pct (\S+)$/))) return W('busy', `Held: this machine is busy (CPU ${m[1]} % > ${m[2]} %).`, { setting: 'policy.fill.max_cpu_pct', clears: 'by itself when the CPU frees up', acts: ['start-anyway'] });
  if ((m = t.match(/^resources: free RAM ([\d.]+) GB < fill\.min_free_gb (\S+)$/))) return W('busy', `Held: this machine is low on memory (${m[1]} GB free < ${m[2]} GB).`, { setting: 'policy.fill.min_free_gb', clears: 'by itself when memory frees up', acts: ['start-anyway'] });
  if (t.startsWith('refused: ')) return W('refused', `Not started: ${t.slice(9)}.`);
  return W('unknown', t);
}

// CAPACITY-UX 4.3: the one reason a row shows first; "+ n more" opens the rest
export const REASON_ORDER = ['withdrawn', 'ruling', 'paused', 'login', 'quota', 'usage', 'budget', 'after', 'not-before', 'folder', 'merge', 'elsewhere', 'kept', 'cap', 'busy', 'refused', 'unknown'];
const rank = c => REASON_ORDER.indexOf(c);
/** a fill-walk row ({ ready, terms }) -> its first reason: waitWords(...) + { term, more (the other terms' count) }; a ready row starts
 * next; null = no row. ctx as waitWords. */
export function firstReason(row, ctx = {}) {
  if (!row) return null;
  if (row.ready) return { ...W('ready', 'Starts next: nothing holds it.'), term: null, more: 0 };
  const ws = (row.terms || []).map(t => ({ ...waitWords(t, ctx), term: t }));
  if (!ws.length) return { ...W('ready', 'Starts next: nothing holds it.'), term: null, more: 0 };
  const first = ws.reduce((a, b) => (rank(b.code) < rank(a.code) ? b : a));
  return { ...first, more: ws.length - 1 };
}
