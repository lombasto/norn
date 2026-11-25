// The code signals (RM-a-60, the contract is docs/code-signals.md): per indexed file, from git alone and no model - the files that change
// together with it, its fix history and the fix-first rank. A landing = one commit of main's first-parent history; the commits it brought
// in = the ones first reachable from it (each commit belongs to the oldest landing that reaches it: `git rev-list <prev landing>..<landing>`,
// done in memory over one `git log`). A landing's files are its diff against its first parent (--diff-merges=first-parent), so a merged
// branch counts once. Its fixes = the brought-in commits whose conventional-commit type is a fix type, on the files of theirs the landing
// touched. A history whose commits mostly carry no conventional type reads n/a with the reason, never a guess. fix_first = the Borda count
// over churn_90d, fan_in and fixes in the window (the same rank method as codeindex.mjs importance), scaled 0-100.
// The rank check (RM-a-70): do the rankings predict anything? Both are re-ranked as they were check_days ago (that day's landing: its tree
// and its history only, through codeIndex at that rev) and their top check_top files are scored against the fix landings since, beside the
// share of all files that got one (the baseline); a ranking at or under it says so. Too little history, an untyped one: n/a with the reason.
// Every threshold is in SIGNAL_LIMITS. Stored in <state>/code/signals.json, written by `norn code history`; readSignals is THE reader.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { atomicWrite } from './policy.mjs';
import { borda, codeIndex } from './codeindex.mjs';

/** every window and threshold of the signals (docs/code-signals.md lists each) */
export const SIGNAL_LIMITS = Object.freeze({
  window_days: 365,      // landings older than this say nothing (partners and fixes)
  batch_files: 30,       // a landing changing more files than this is a batch: skipped for partners
  min_shared: 3,         // a partner shares at least this many landings with the file ...
  min_share: 0.3,        // ... and at least this share of the file's own landings
  max_partners: 8,       // strongest first, at most this many
  fix_types: Object.freeze(['fix', 'revert']),
  fix_short_days: 90,    // the short fix count's window (the long one is window_days)
  last_fixes: 5,         // the newest fixes kept per file
  types: Object.freeze(['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert']),
  typed_min_share: 0.25, // below this share of typed commits in the window the fix history is n/a
  check_days: 90,        // the rank check re-ranks as of this many days ago and counts the fixes since
  check_top: 20,         // ... over the top this many files of each ranking
  check_min_history_days: 180, // a history younger than this: the rank check is n/a
});
export const SIGNALS_FILE = 'signals.json';
const DAY = 86400e3, TYPE = /^([a-z]+)(\([^)]*\))?!?:\s/i, GIT_REVERT = /^Revert "/;
const git = (dir, args) => execFileSync('git', ['-C', dir, '-c', 'core.quotePath=false', ...args], { maxBuffer: 1 << 30, windowsHide: true, timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] });
/** a subject's conventional-commit type (git's own `Revert "..."` is a revert) | null */
export const typeOf = s => { const m = TYPE.exec(s), t = m && m[1].toLowerCase(); return t && SIGNAL_LIMITS.types.includes(t) ? t : GIT_REVERT.test(s) ? 'revert' : null; };

/** every commit reachable from HEAD -> Map sha -> { sha, p: [parents], t (ms), s: subject, stat: [files under dir] } */
function commits(dir) {
  const m = new Map();
  for (const c of git(dir, ['log', '--no-renames', '--relative', '--numstat', '--diff-merges=first-parent', '--format=%x01%H%x02%P%x02%ct%x02%s', 'HEAD']).toString('utf8').split('\x01')) {
    if (!c) continue;
    const [head, ...rows] = c.split('\n'), [sha, ps, ct, s] = head.split('\x02');
    m.set(sha, { sha, p: ps ? ps.split(' ') : [], t: Number(ct) * 1000, s, stat: rows.map(r => r.split('\t')).filter(r => r.length === 3).map(r => r[2]) });
  }
  return m;
}

/** C: commits(dir); tip: a full sha (HEAD's, or an older landing's) -> its first-parent landings in (since, now], oldest first ->
 *  [{ sha, t, files: Set, intro: [the commits it brought in] }] */
function landingsOf(C, tip, since, now) {
  const chain = [], owner = new Set(), lands = [];
  for (let s = tip; s && C.has(s); s = C.get(s).p[0]) chain.push(s);
  for (const s of chain.reverse()) {   // oldest first: each landing owns what no older one reaches
    const st = [s], intro = [];
    while (st.length) { const x = st.pop(); if (owner.has(x) || !C.has(x)) continue; owner.add(x); intro.push(C.get(x)); st.push(...C.get(x).p); }
    const c = C.get(s);
    if (c.t > since && c.t <= now) lands.push({ sha: s, t: c.t, files: new Set(c.stat), intro });
  }
  return lands;
}
/** the non-batch landings per known file (n) and per pair of them (pair: file -> Map partner -> shared), and the batches skipped */
function coChange(lands, K) {
  const n = new Map(), pair = new Map(), bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  let batches = 0;
  for (const l of lands) {
    if (l.files.size > SIGNAL_LIMITS.batch_files) { batches++; continue; }
    const k = [...l.files].filter(f => K.has(f));
    for (const f of k) { bump(n, f); const m = pair.get(f) ?? new Map(); pair.set(f, m); k.forEach(g => g !== f && bump(m, g)); }
  }
  return { n, pair, batches };
}
/** a landing's fixes on the known files it touched -> Map file -> the newest fix commit it brought in on that file (+ its type) */
function fixesOn(l, K) {
  const hit = new Map();
  for (const c of l.intro) {
    const t = typeOf(c.s);
    if (!SIGNAL_LIMITS.fix_types.includes(t)) continue;
    for (const f of c.stat) if (K.has(f) && l.files.has(f) && !(hit.get(f)?.t > c.t)) hit.set(f, { ...c, type: t });
  }
  return hit;
}
/** a file's partners over the thresholds, strongest first */
const partnersOf = (pair, n, f) => { const mine = n.get(f) ?? 0, L = SIGNAL_LIMITS;
  return [...(pair.get(f) ?? [])].map(([file, shared]) => ({ file, shared, share: Math.round(100 * shared / mine) / 100, landings: n.get(file) }))
    .filter(p => p.shared >= L.min_shared && p.shared / mine >= L.min_share).sort((a, b) => b.shared - a.shared || b.share - a.share || (a.file < b.file ? -1 : 1)).slice(0, L.max_partners); };

/** the window's own (non-merge) commits and how many carry a type -> { own, typed, ok (typed_min_share reached) } */
const typedOf = lands => { const own = lands.flatMap(l => l.intro.filter(c => c.p.length < 2)), typed = own.filter(c => typeOf(c.s)).length; return { own, typed, ok: own.length > 0 && typed / own.length >= SIGNAL_LIMITS.typed_min_share }; };
const typedWhy = (typed, n, span) => (n ? `${typed} of ${n} commits in ${span} carry a conventional-commit type (under ${100 * SIGNAL_LIMITS.typed_min_share} %)` : `no commit in ${span}`);

/** dir: the indexed folder; ix: codeIndex's answer (its files, churn, fan_in, importance) -> the signals (docs/code-signals.md), with the rank check */
export function codeSignals(dir, ix, { now = Date.now() } = {}) {
  const C = commits(dir), head = git(dir, ['rev-parse', 'HEAD']).toString().trim();
  return { ...signalsAt(C, head, ix, now), check: rankCheck(dir, C, head, now) };
}
/** the signals of the landing tip as at now (ix: codeIndex at that landing) */
function signalsAt(C, tip, ix, now) {
  const L = SIGNAL_LIMITS, since = now - L.window_days * DAY, short = now - L.fix_short_days * DAY, lands = landingsOf(C, tip, since, now), K = new Set(ix.files.map(x => x.file));
  const { own, typed, ok } = typedOf(lands);
  const { n, pair, batches } = coChange(lands, K), fixes = new Map();
  for (const l of lands) for (const [f, c] of fixesOn(l, K)) { const xs = fixes.get(f) ?? []; fixes.set(f, xs); xs.unshift({ sha: l.sha.slice(0, 12), day: new Date(l.t).toISOString().slice(0, 10), t: l.t, subject: c.s, type: c.type }); }
  const N = ix.files.length, fx = x => fixes.get(x.file) ?? [];
  const pf = borda(ix.files.map(x => x.fan_in ?? 0)), pc = borda(ix.files.map(x => x.churn_90d)), px = borda(ix.files.map(x => fx(x).length));
  const files = Object.fromEntries(ix.files.map((x, i) => [x.file, { landings: n.get(x.file) ?? 0, partners: partnersOf(pair, n, x.file),
    fixes: ok ? { n_90d: fx(x).filter(f => f.t > short).length, n_365d: fx(x).length, last: fx(x).slice(0, L.last_fixes).map(({ t, ...f }) => f) } : null,
    fix_first: ok ? (N > 1 ? Math.round(100 * (pf[i] + pc[i] + px[i]) / (3 * (N - 1))) : 100) : null, importance: x.importance, churn_90d: x.churn_90d, fan_in: x.fan_in }]));
  const fix = ok ? { status: 'measured', typed, commits: own.length }
    : { status: 'n/a', typed, commits: own.length, reason: typedWhy(typed, own.length, `${L.window_days} days`) };
  return { at: new Date(now).toISOString(), sha: ix.sha, basis: 'measured', window: { days: L.window_days, from: new Date(since).toISOString().slice(0, 10), to: new Date(now).toISOString().slice(0, 10) }, limits: L, landings: lands.length, batches_skipped: batches, fixes: fix, files };
}

// ---- the rank check ----
const RANKS = { fix_first: { label: 'fix-first', order: (a, b) => b.fix_first - a.fix_first || b.importance - a.importance }, importance: { label: 'importance', order: (a, b) => b.importance - a.importance || b.churn_90d - a.churn_90d } };
/** C, head: the commits and HEAD; now -> { status: 'measured', basis, as_of, days, sha (the landing ranked), files (then), fixed (of them, fixed since),
 *  fix_first | importance: { status: 'measured', top: [{ file, rank, fixed }], hit } | { status: 'n/a', reason } } | { status: 'n/a', reason, ... } */
function rankCheck(dir, C, head, now) {
  const L = SIGNAL_LIMITS, then = now - L.check_days * DAY, span = `the last ${L.check_days} days`, base = { basis: 'measured', as_of: new Date(then).toISOString().slice(0, 10), days: L.check_days };
  const na = (reason, o = {}) => ({ status: 'n/a', reason, ...base, ...o });
  let born = Infinity; for (const c of C.values()) born = Math.min(born, c.t);
  if (now - born < L.check_min_history_days * DAY) return na(`the history starts ${new Date(born).toISOString().slice(0, 10)}: under ${L.check_min_history_days} days`);
  let tip = head; while (C.get(tip)?.t > then) tip = C.get(tip).p[0];   // main's tip on the check day: its newest landing at or before it
  if (!C.has(tip)) return na(`no landing on or before ${new Date(then).toISOString().slice(0, 10)}`);
  const since = landingsOf(C, head, then, now), ty = typedOf(since), o = { sha: tip.slice(0, 12) };
  if (!ty.ok) return na(typedWhy(ty.typed, ty.own.length, span), o);
  const ix = codeIndex(dir, { now: then, rev: tip }), old = signalsAt(C, tip, ix, then), K = new Set(ix.files.map(x => x.file)), fixed = new Set();
  for (const l of since) for (const f of fixesOn(l, K).keys()) fixed.add(f);
  Object.assign(o, { files: K.size, fixed: fixed.size });
  if (K.size <= L.check_top) return na(`${K.size} files ${L.check_days} days ago: the top ${L.check_top} is every file`, o);
  if (!fixed.size) return na(`no file got a fix in ${span}: nothing to predict`, o);
  const rows = Object.entries(old.files).map(([file, x]) => ({ file, ...x })), rank = k => {
    if (k === 'fix_first' && old.fixes.status !== 'measured') return { status: 'n/a', reason: `${L.check_days} days ago: ${old.fixes.reason}` };
    const top = [...rows].sort((a, b) => RANKS[k].order(a, b) || (a.file < b.file ? -1 : 1)).slice(0, L.check_top).map(x => ({ file: x.file, rank: x[k], fixed: fixed.has(x.file) }));
    return { status: 'measured', top, hit: top.filter(x => x.fixed).length };
  };
  return { status: 'measured', ...base, ...o, fix_first: rank('fix_first'), importance: rank('importance') };
}
/** the one line of a ranking's check (k: 'fix_first' | 'importance'; check: the stored signals' check, null = none stored) */
export function checkLine(check, k) {
  const lab = RANKS[k].label, r = check?.status === 'measured' ? check[k] : check;
  if (!r) return `${lab} check: not built yet (\`norn code history\` writes it)`;
  if (r.status !== 'measured') return `${lab} check: n/a (${r.reason})`;
  const n = r.top.length, worse = r.hit * check.files <= check.fixed * n;   // the top's share at or under the baseline's, in whole numbers
  return `${r.hit} of the top ${n} ${lab} files got a fix in the last ${check.days} days; baseline ${Math.round(100 * check.fixed / check.files)} % of files${worse ? ': at or under the baseline, the ranking predicted nothing' : ''}`;
}

const fileOf = state => path.join(state, 'code', SIGNALS_FILE);
/** stores the signals beside the index */
export function writeSignals(state, sig) { fs.mkdirSync(path.join(state, 'code'), { recursive: true }); atomicWrite(fileOf(state), JSON.stringify(sig)); }
/** THE reader (docs/code-signals.md): state = the project's state folder -> the stored signals | null (none written yet) */
export function readSignals(state) {
  let s;
  try { s = fs.readFileSync(fileOf(state), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  return JSON.parse(s);
}
