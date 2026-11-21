// The Ready lines of a brief (META-DOD 1): Scope: / Tests: / Done:, the optional Exclusive: (lane-collide S1a: the files the run moves,
// renames, splits or rewrites wholesale), and whether a path is inside Scope. A leaf module: the Ready gate (dod.mjs), the run scope
// guard (scope.mjs, META-DOD 2) and the collision model (collide.mjs) read it.
const KEYS = ['Scope', 'Tests', 'Done'];
const fwd = p => String(p).replace(/\\/g, '/');
/** a Ready-line word without its quotes / backticks / trailing punctuation */
export const clean = w => w.replace(/^[`'"(]+|[`'")]+$/g, '').replace(/[.,;:]+$/, '').replace(/[`'")]+$/, '');

/** the Ready lines of a brief text: { scope: [path | glob], exclusive: [path | glob], tests, done, missing: ['Tests:', ..] } (first line
 *  of each key wins; Exclusive: is never missing) */
export function parseReady(text) {
  const got = {};
  for (const l of String(text ?? '').split(/\r?\n/)) {
    const m = l.match(/^\s*(?:[-*]\s+)?(Scope|Tests|Done|Exclusive):[ \t]*(.*?)\s*$/);
    if (m && !(m[1] in got)) got[m[1]] = m[2];
  }
  const words = k => (got[k] ?? '').split(/[\s,]+/).map(clean).filter(Boolean), scope = words('Scope');
  const missing = KEYS.filter(k => !(k === 'Scope' ? scope.length : (got[k] ?? '').trim())).map(k => k + ':');
  return { scope, exclusive: words('Exclusive'), tests: got.Tests ?? null, done: got.Done ?? null, missing };
}

const globRe = g => new RegExp('^' + g.split(/(\*\*\/|\*\*|\*|\?)/).map(t => t === '**/' ? '(?:.*/)?' : t === '**' ? '.*' : t === '*' ? '[^/]*' : t === '?' ? '[^/]'
  : t.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('') + '$');
/** a repo-relative path inside Scope: a glob (** / * / ?) matches it, a bare entry = that file or every path under that folder */
export function inScope(p, scope) {
  const f = fwd(p);
  return scope.some(s => { const g = fwd(s).replace(/^\.\//, '').replace(/\/+$/, ''); return /[*?]/.test(g) ? globRe(g).test(f) : f === g || f.startsWith(g + '/'); });
}

// RM-46 S2a (SPEC sec. 5): do two Scope sets share a path? A bare entry p means p and p/**; a segment holding `**` beside other chars
// (eng**.md = eng.*\.md, which may cross '/') splits into its one-segment and its many-segment readings, so the test stays exact for the
// globs inScope accepts. Pairs of patterns run a memoised DP over (segment i, segment j), and per segment pair one over chars.
const norm = s => fwd(s).replace(/^\.\//, '').replace(/\/+$/, '');
/** a pattern -> its alternatives as segment lists (each `**` alone in its segment) */
function alts(p) {
  let out = [[]];
  for (const s of p.split('/')) {
    const k = s.indexOf('**');
    if (s === '**' || k < 0) { out = out.map(a => [...a, s]); continue; }
    const pre = s.slice(0, k), post = s.slice(k + 2).replace(/^\*+/, '');
    const one = x => x.replace(/\*+/g, '*'), tails = [[one(pre + '*' + post)], [one(pre + '*'), '**', one('*' + post)]];
    out = out.flatMap(a => tails.map(t => [...a, ...t]));
  }
  return out;
}
const expand = set => set.map(norm).filter(Boolean).flatMap(p => (/[*?]/.test(p) ? [p] : [p, p + '/**'])).flatMap(alts);
/** two chars-with-wildcards segments ('*' = any run, '?' = one char) can name one segment */
function segX(x, y) {
  const memo = new Map();
  const go = (p, q) => {
    const k = p * (y.length + 1) + q;
    if (memo.has(k)) return memo.get(k);
    let r;
    if (p === x.length && q === y.length) r = true;
    else if (x[p] === '*') r = go(p + 1, q) || (q < y.length && go(p, q + 1));
    else if (y[q] === '*') r = go(p, q + 1) || (p < x.length && go(p + 1, q));
    else r = p < x.length && q < y.length && (x[p] === '?' || y[q] === '?' || x[p] === y[q]) && go(p + 1, q + 1);
    memo.set(k, r);
    return r;
  };
  return go(0, 0);
}
/** two segment lists can match one path */
function segsX(A, B) {
  const memo = new Map();
  const go = (i, j) => {
    const k = i * (B.length + 1) + j;
    if (memo.has(k)) return memo.get(k);
    let r;
    if (i === A.length && j === B.length) r = true;
    else if (A[i] === '**') r = go(i + 1, j) || (j < B.length && go(i, j + 1));
    else if (B[j] === '**') r = go(i, j + 1) || (i < A.length && go(i + 1, j));
    else r = i < A.length && j < B.length && segX(A[i], B[j]) && go(i + 1, j + 1);
    memo.set(k, r);
    return r;
  };
  return go(0, 0);
}
/** two Scope lists (paths / globs) share a path */
export function globsIntersect(a, b) {
  const A = expand(a || []), B = expand(b || []);
  return A.some(x => B.some(y => segsX(x, y)));
}
