// RM-a-68 risk rank: where a diff stands against the repo's own recent landings, so the second voice's daily reads go to the diffs that
// most need a second reader. A few plain numbers per diff - files and lines changed (git), the fix history and the fix-first rank of
// the files it touches and the companion files it leaves out (the code signals, read through their one reader: docs/code-signals.md) -
// and the same numbers for each of the last RISK_LIMITS.landings landings (first-parent commits before the diff's base). The rank is a
// percentile against that history (Borda over the numbers, the signals' own method: no invented weights), never an absolute score.
// No stored signals = n/a with the reason. No model.
import { execFileSync } from 'node:child_process';
import { readSignals } from './codesignals.mjs';

// the one place of this module's thresholds (docs/code-signals.md "A consumer: the risk rank")
export const RISK_LIMITS = Object.freeze({ landings: 100, min_landings: 10, why: 3 });
// the numbers, in this order (ties of the "why" list keep it); fix: needs a typed history (signals fixes.status 'measured')
export const RISK_NUMBERS = Object.freeze([
  { key: 'lines', label: 'lines changed' }, { key: 'files', label: 'files changed' }, { key: 'fixes', label: 'fixes 365 d of its files', fix: true },
  { key: 'fix_first', label: 'top fix-first rank', fix: true }, { key: 'companions', label: 'companions left out' }]);

const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
// numstat lines -> { path: lines } (a binary file's '-' counts 0 lines)
const numstat = lines => { const m = {}; for (const l of lines) { const x = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l); if (x) m[x[3]] = (m[x[3]] ?? 0) + (Number(x[1]) || 0) + (Number(x[2]) || 0); } return m; };

/** one change's numbers from its numstat map and the signals: { files, lines, fixes, fix_first, companions, left_out } */
export function riskNumbers(stat, s) {
  const files = Object.keys(stat), sig = files.map(f => s.files[f]).filter(Boolean), inDiff = new Set(files), fixOk = s.fixes.status === 'measured';
  const left_out = files.flatMap(f => (s.files[f]?.partners || []).filter(p => !inDiff.has(p.file) && s.files[p.file]).map(p => ({ file: f, partner: p.file, shared: p.shared, landings: s.files[f].landings })));
  return { files: files.length, lines: files.reduce((n, f) => n + stat[f], 0), fixes: fixOk ? sig.reduce((n, x) => n + x.fixes.n_365d, 0) : null,
    fix_first: fixOk ? Math.max(0, ...sig.map(x => x.fix_first)) : null, companions: new Set(left_out.map(x => x.partner)).size, left_out };
}

// a value's standing in a pool: the pool members below it plus half the others equal to it (the Borda count of docs/code-signals.md)
const below = (v, pool) => pool.reduce((n, w) => n + (w < v ? 1 : w === v ? 0.5 : 0), 0);
/**
 * The rank of numbers `me` against `pool` (the landings' numbers): per number its Borda count over pool + me, summed; the percentile =
 * landings with a lower sum plus half the equal ones, of all landings. -> { pct, why: [{ key, label, value, pct }] (the numbers that put
 * it there: its highest standings, at most RISK_LIMITS.why), used: [keys] }
 */
export function rankOf(me, pool, used) {
  const all = [...pool, me], sum = x => used.reduce((n, k) => n + below(x[k], all.map(y => y[k])) - 0.5, 0);   // minus its own half
  const mine = sum(me), sums = pool.map(sum), pct = Math.round(100 * below(mine, sums) / pool.length);
  const why = RISK_NUMBERS.filter(n => used.includes(n.key)).map(n => ({ key: n.key, label: n.label, value: me[n.key], pct: Math.round(100 * below(me[n.key], pool.map(y => y[n.key])) / pool.length) }))
    .map((x, i) => ({ ...x, i })).sort((a, b) => b.pct - a.pct || a.i - b.i).slice(0, RISK_LIMITS.why).map(({ i, ...x }) => x);
  return { pct, why, used };
}

/** the landings before `at`: the first-parent history ending at it, each its diff against its first parent -> [{ sha, stat }] */
export function landingsBefore(dir, at, n = RISK_LIMITS.landings) {
  const out = [];
  for (const l of git(dir, ['log', '--first-parent', '-m', '--numstat', '--no-renames', '--relative', '--format=%x00%H', '-n', String(n), at, '--']).split('\n')) {
    if (l.startsWith('\0')) out.push({ sha: l.slice(1).trim(), lines: [] });
    else if (l.trim() && out.length) out.at(-1).lines.push(l);
  }
  return out.map(x => ({ sha: x.sha, stat: numstat(x.lines) }));
}

/**
 * The risk rank of the diff base..head in dir (paths relative to dir: a monorepo project's folder), against the landings up to the merge
 * base. state: the project's state folder (the signals). -> { base, head, sha (the signals' indexed commit) | null, basis, numbers,
 * left_out, landings, pct | null, why, na (the reason, when pct is null), line (the one-line rank) }
 */
export function codeRisk({ dir, state, base, head = 'HEAD' }) {
  const mb = git(dir, ['merge-base', base, head]).trim(), h = git(dir, ['rev-parse', head]).trim();
  const stat = numstat(git(dir, ['diff', '--numstat', '--no-renames', '--relative', mb, h, '--']).split('\n'));
  const r = { base: mb, head: h, sha: null, basis: 'measured', landings: 0, pct: null, why: [] };
  const na = why => ({ ...r, numbers: { files: Object.keys(stat).length, lines: Object.values(stat).reduce((a, b) => a + b, 0) }, left_out: [], na: why, line: `risk rank n/a: ${why}` });
  const s = readSignals(state);
  if (!s) return na('no code signals stored yet (`norn code history` writes them)');
  const lands = landingsBefore(dir, mb);
  if (lands.length < RISK_LIMITS.min_landings) return { ...na(`only ${lands.length} landings before ${mb.slice(0, 12)} (a rank needs ${RISK_LIMITS.min_landings})`), sha: s.sha };
  const { left_out, ...numbers } = riskNumbers(stat, s), used = RISK_NUMBERS.filter(n => !n.fix || s.fixes.status === 'measured').map(n => n.key);
  const k = rankOf(numbers, lands.map(l => riskNumbers(l.stat, s)), used), fixNa = s.fixes.status === 'measured' ? '' : `; fix history n/a (${s.fixes.reason})`;
  return { ...r, sha: s.sha, numbers, left_out, landings: lands.length, pct: k.pct, why: k.why, na: null,
    line: `riskier than ${k.pct} % of the last ${lands.length} landings (${k.why.map(w => `${w.label} ${w.value}, over ${w.pct} %`).join('; ')}) · measured from git and the signals at ${s.sha}${fixNa}` };
}
