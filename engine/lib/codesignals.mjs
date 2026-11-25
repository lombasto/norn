// The code signals (RM-a-60, the contract is docs/code-signals.md): per indexed file, from git alone and no model - the files that change
// together with it, its fix history and the fix-first rank. A landing = one commit of main's first-parent history; the commits it brought
// in = the ones first reachable from it (each commit belongs to the oldest landing that reaches it: `git rev-list <prev landing>..<landing>`,
// done in memory over one `git log`). A landing's files are its diff against its first parent (--diff-merges=first-parent), so a merged
// branch counts once. Its fixes = the brought-in commits whose conventional-commit type is a fix type, on the files of theirs the landing
// touched. A history whose commits mostly carry no conventional type reads n/a with the reason, never a guess. fix_first = the Borda count
// over churn_90d, fan_in and fixes in the window (the same rank method as codeindex.mjs importance), scaled 0-100.
// Every threshold is in SIGNAL_LIMITS. Stored in <state>/code/signals.json, written by `norn code history`; readSignals is THE reader.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { atomicWrite } from './policy.mjs';
import { borda } from './codeindex.mjs';

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
});
export const SIGNALS_FILE = 'signals.json';
const DAY = 86400e3, TYPE = /^([a-z]+)(\([^)]*\))?!?:\s/i, GIT_REVERT = /^Revert "/;
const git = (dir, args) => execFileSync('git', ['-C', dir, '-c', 'core.quotePath=false', ...args], { maxBuffer: 1 << 30, windowsHide: true, timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] });
/** a subject's conventional-commit type (git's own `Revert "..."` is a revert) | null */
export const typeOf = s => { const m = TYPE.exec(s), t = m && m[1].toLowerCase(); return t && SIGNAL_LIMITS.types.includes(t) ? t : GIT_REVERT.test(s) ? 'revert' : null; };
const dayOf = t => new Date(t).toISOString().slice(0, 10);

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

/** dir: the indexed folder; ix: codeIndex's answer (its files, churn, fan_in, importance) -> the signals (docs/code-signals.md) */
export function codeSignals(dir, ix, { now = Date.now() } = {}) {
  const L = SIGNAL_LIMITS, since = now - L.window_days * DAY, short = now - L.fix_short_days * DAY, C = commits(dir), chain = [];
  for (let s = git(dir, ['rev-parse', 'HEAD']).toString().trim(); s && C.has(s); s = C.get(s).p[0]) chain.push(s);
  const owner = new Set(), lands = [];
  for (const s of chain.reverse()) {   // oldest first: each landing owns what no older one reaches
    const st = [s], intro = [];
    while (st.length) { const x = st.pop(); if (owner.has(x) || !C.has(x)) continue; owner.add(x); intro.push(C.get(x)); st.push(...C.get(x).p); }
    const c = C.get(s);
    if (c.t > since && c.t <= now) lands.push({ sha: s, t: c.t, files: new Set(c.stat), intro });
  }
  const own = lands.flatMap(l => l.intro.filter(c => c.p.length < 2)), typed = own.filter(c => typeOf(c.s)).length;
  const ok = own.length > 0 && typed / own.length >= L.typed_min_share;
  const K = new Set(ix.files.map(x => x.file)), n = new Map(), pair = new Map(), fixes = new Map();
  let batches = 0;
  for (const l of lands) {
    if (l.files.size > L.batch_files) batches++;
    else {
      const k = [...l.files].filter(f => K.has(f));
      for (const f of k) { n.set(f, (n.get(f) ?? 0) + 1); const m = pair.get(f) ?? new Map(); pair.set(f, m); for (const g of k) if (g !== f) m.set(g, (m.get(g) ?? 0) + 1); }
    }
    const hit = new Map();   // file -> the newest fix commit of this landing on it
    for (const c of l.intro) { const t = typeOf(c.s); if (L.fix_types.includes(t)) for (const f of c.stat) if (K.has(f) && l.files.has(f) && !(hit.get(f)?.t > c.t)) hit.set(f, { ...c, type: t }); }
    for (const [f, c] of hit) { const xs = fixes.get(f) ?? []; fixes.set(f, xs); xs.push({ sha: l.sha.slice(0, 12), day: dayOf(l.t), t: l.t, subject: c.s, type: c.type }); }
  }
  const N = ix.files.length, nFix = x => (fixes.get(x.file) ?? []).length;
  const pf = borda(ix.files.map(x => x.fan_in ?? 0)), pc = borda(ix.files.map(x => x.churn_90d)), px = borda(ix.files.map(nFix));
  const files = {};
  ix.files.forEach((x, i) => {
    const mine = n.get(x.file) ?? 0, xs = (fixes.get(x.file) ?? []).reverse();
    const partners = [...(pair.get(x.file) ?? [])].map(([file, shared]) => ({ file, shared, share: Math.round(100 * shared / mine) / 100, landings: n.get(file) }))
      .filter(p => p.shared >= L.min_shared && p.shared / mine >= L.min_share).sort((a, b) => b.shared - a.shared || b.share - a.share || (a.file < b.file ? -1 : 1)).slice(0, L.max_partners);
    files[x.file] = { landings: mine, partners, fixes: ok ? { n_90d: xs.filter(f => f.t > short).length, n_365d: xs.length, last: xs.slice(0, L.last_fixes).map(({ t, ...f }) => f) } : null,
      fix_first: ok ? (N > 1 ? Math.round(100 * (pf[i] + pc[i] + px[i]) / (3 * (N - 1))) : 100) : null, importance: x.importance, churn_90d: x.churn_90d, fan_in: x.fan_in };
  });
  const fix = ok ? { status: 'measured', typed, commits: own.length }
    : { status: 'n/a', typed, commits: own.length, reason: own.length ? `${typed} of ${own.length} commits in ${L.window_days} days carry a conventional-commit type (under ${100 * L.typed_min_share} %)` : `no commit in ${L.window_days} days` };
  return { at: new Date(now).toISOString(), sha: ix.sha, basis: 'measured', window: { days: L.window_days, from: dayOf(since), to: dayOf(now) }, limits: L, landings: lands.length, batches_skipped: batches, fixes: fix, files };
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
