// META-UX-BUILD S1: the Instructions view in parts - the first answer is a small summary (the lists' counts, no list); each list is
// its own part (GET /api/instructions?part=<name>), capped at what the page shows + its full count. Shared by the server (it cuts
// the parts from the cached view) and the page (the ladder's column order and caps). Pure, no I/O: the browser loads it too.
export const INS_PARTS = ['files', 'rules', 'findings', 'hints', 'suggest'];
// suggest 30 = the Tighten list's length; ladder 40 cards per state column; advisories 60 lines per group (the ladder's findings);
// hints / findings: the first 60 / 120 (the Guard lists every finding)
export const INS_CAPS = { suggest: 30, hints: 60, findings: 120, ladder: 40, advisories: 60 };
const LISTS = ['rows', 'hints', 'suggest', 'findings', 'rules', 'evidence'];
// the ladder's column order (most homes / repeats / newest fired / newest retired first)
export const LADDER_ORDER = { prose: (a, b) => b.homes.length - a.homes.length, repeated: (a, b) => b.repeats - a.repeats,
  enforced: (a, b) => String(b.fired?.at ?? '').localeCompare(String(a.fired?.at ?? '')), retired: (a, b) => String(b.retired_at ?? '').localeCompare(String(a.retired_at ?? '')) };
export const LADDER_STATES = Object.keys(LADDER_ORDER);

/** the view without its lists + { counts: { files, hints, suggest, findings, rules, advisories } } */
export function insSummary(v) {
  const out = Object.fromEntries(Object.entries(v).filter(([k]) => !LISTS.includes(k)));
  out.counts = { files: (v.rows || []).length, hints: (v.hints || []).length, suggest: (v.suggest || []).length, findings: (v.findings || []).length,
    rules: (v.rules?.rules || []).length, advisories: (v.rules?.advisories || []).length };
  return out;
}

/** one part of the view, capped; throws on an unknown name */
export function insPart(v, name) {
  if (name === 'files') return { rows: v.rows || [] };
  if (name === 'suggest') return { suggest: (v.suggest || []).slice(0, INS_CAPS.suggest), suggest_n: (v.suggest || []).length };
  if (name === 'hints') return { hints: (v.hints || []).slice(0, INS_CAPS.hints), hints_n: (v.hints || []).length };
  if (name === 'findings') return { findings: (v.findings || []).slice(0, INS_CAPS.findings), findings_n: (v.findings || []).length };
  if (name === 'rules') {
    const L = v.rules;
    if (!L) return { rules: null };
    const rules = LADDER_STATES.flatMap(st => L.rules.filter(r => r.state === st).sort(LADDER_ORDER[st]).slice(0, INS_CAPS.ladder));
    const adv = [], adv_counts = {};
    for (const a of L.advisories || []) { adv_counts[a.key] = (adv_counts[a.key] || 0) + 1; if (adv_counts[a.key] <= INS_CAPS.advisories) adv.push(a); }
    return { rules: { ...L, rules, advisories: adv, adv_counts } };
  }
  throw Object.assign(new Error(`unknown part ${name} (one of ${INS_PARTS.join(', ')})`), { status: 400 });
}

// META-UX-BUILD S4 (REPORT s.2, owner DIR-65 "3) A"): the Context tab = the Instructions view's cost half, in the sub-view pattern
// (subviews.mjs). The summary answer carries what Per role, Is it growing? and Check-ins per day show; Per file loads the files
// part; the checks are one link away and load their lists.
/** [id, label]: the 4 sub-views of Context (the stop rule: never a fifth) */
export const CONTEXT_SUBS = [['role', 'Per role'], ['file', 'Per file'], ['growing', 'Is it growing?'], ['checkins', 'Check-ins per day']];
/** the parts each Context view loads beyond the summary (checks = the page one link away, not a sub-view) */
// META-UX-BUILD S5: hints and suggest (Tighten) are Slop rows now - the checks page no longer loads them
export const contextParts = sub => (sub === 'file' ? ['files'] : sub === 'checks' ? INS_PARTS.filter(k => k !== 'hints' && k !== 'suggest') : []);
const tk = n => (!Number.isFinite(n) ? '-' : n >= 1000 ? `~${(n / 1000).toFixed(1)}k` : `~${n}`);
// Per file: which files to look at first, and what to do about each. A file's cost per day = its standing tokens x its loads per day
// (the file map's measure); its problems = what the checks found. Advice is plain: one line per problem, the worst first.
export const FILE_BUDGET = 3000;   // a file every session loads, past this many tokens, is a candidate to slim (audit.mjs AUDIT_BUDGET_TOKENS)
export const perDay = r => Math.round((r.standing_tokens ?? r.tokens ?? 0) * (r.loads_day || 0));
/** a file row -> [{ sev: bad | warn | idle, text, go? }] (empty = nothing to do) */
export function fileAdvice(r) {
  const out = [], st = r.standing_tokens ?? r.tokens ?? 0;
  if (!r.exists && !r.generated) out.push({ sev: 'bad', text: 'listed as loaded, but the file is missing: restore it or drop the reference' });
  if (r.generated && ['drift', 'missing', 'unmanaged'].includes(r.drift)) out.push({ sev: 'bad', text: 'a generated copy out of sync with its source: regenerate it' });
  if (r.load === 'session' && st > FILE_BUDGET) out.push({ sev: 'warn', text: `every session loads it at ${tk(st)} tokens (budget ${tk(FILE_BUDGET).slice(1)}): move detail that only some tasks need into an on-demand doc or a skill` });
  if (r.map_state === 'conflict') out.push({ sev: 'warn', text: 'says something another loaded file also says: keep it in one place' });
  if (r.stale) out.push({ sev: 'warn', text: `${r.stale} paragraph${r.stale > 1 ? 's' : ''} no run has read lately: delete or confirm ${r.stale > 1 ? 'them' : 'it'}`, go: 'slop' });
  if (r.findings) out.push({ sev: 'warn', text: `${r.findings} finding${r.findings > 1 ? 's' : ''} from the checks`, go: 'slop' });
  if (r.hints) out.push({ sev: 'idle', text: `${r.hints} lint hint${r.hints > 1 ? 's' : ''}`, go: 'slop' });
  return out;
}
const SEV_W = { bad: 3, warn: 2, idle: 1 };
/** the files to look at first: cost per day, then how bad its problems are; only files with something to do; at most n */
export function worstFiles(rows = [], n = 5) {
  const all = rows.filter(r => r.load !== 'source').map(r => ({ r, adv: fileAdvice(r), day: perDay(r) })).filter(x => x.adv.length);
  // strictly by tokens per day (what a fix saves), then how bad its problems are
  const sev = x => x.adv.reduce((k, a) => k + SEV_W[a.sev], 0);
  return all.sort((a, b) => b.day - a.day || sev(b) - sev(a)).slice(0, n);
}
const roleOf = (m, key) => (m?.roles || []).find(r => r.key === key);

/** the summary numbers (4): one check-in and one worker before any work (measured median), today's load, the check-in load trend */
export function contextNumbers(v) {
  const m = v.measured, c = roleOf(m, 'checkin'), w = roleOf(m, 'worker');
  const pts = (m?.trend?.rows || []).filter(r => r.key === 'checkin' && Number.isFinite(r.median_turn1) && r.median_turn1 > 0).sort((a, b) => a.day.localeCompare(b.day));
  const pct = pts.length > 1 ? Math.round(100 * (pts.at(-1).median_turn1 - pts[0].median_turn1) / pts[0].median_turn1) : null;
  return [{ n: tk(c?.median_turn1), label: 'tokens: one check-in, before any work' }, { n: tk(w?.median_turn1), label: 'tokens: one worker, before any work' },
    { n: tk(v.total), label: `tokens loaded today by ${v.sessions ?? 0} sessions` },
    pct === null ? { n: '-', label: 'check-in load: no trend yet' } : { n: `${pct > 0 ? '+' : ''}${pct} %`, label: `check-in load since ${pts[0].day} (${pct < 0 ? 'shrinking' : pct > 0 ? 'growing' : 'flat'})`, cls: pct < 0 ? 'ok' : pct > 0 ? 'warn' : '' }];
}

// a launch profile (instructions.mjs profileKey: checkin:<tick> | chat | worker:<family>[:<agent>]) -> the measured role key (standing.mjs keyOf)
const profileRole = k => { const [kind, fam] = k.split(':'); return kind === 'worker' ? (fam === 'claude' ? 'worker' : `worker (${fam})`) : kind; };
/** the ONE standing table: each measured role (median per session) with the per-profile estimates of the same role beneath it;
 * an estimate with no measured run is its own row (measured: null) */
export function standingRows(measured, standing = []) {
  const out = (measured?.roles || []).map(r => ({ key: r.key, measured: r, profiles: [] }));
  for (const s of standing || []) {
    const k = profileRole(s.key);
    let r = out.find(x => x.key === k);
    if (!r) out.push(r = { key: k, measured: null, profiles: [] });
    r.profiles.push(s);
  }
  return out;
}
