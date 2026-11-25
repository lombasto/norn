// `norn code history`'s index (SPEC dash-owner-1123 s.7): per tracked text file of a repo folder its size, age, change and importance.
// Deterministic: git and the tree at HEAD, no model. Sizes are HEAD's blobs (one `git cat-file --batch`); the 26-week growth is rebuilt
// backwards from them through the first-parent numstat (each newer commit undone: lines -= added - deleted), so a week's size is the
// file at the last first-parent commit on or before that week's end - what `git show <rev>:<file>` counts. fan_in = the files that
// import it, from the code graph (codegraph.mjs fans: JS / TS, Python, Rust; any other file n/a with fan_in_why). importance = the
// Borda count over fan_in and churn_90d (rank aggregation needs no invented weights), scaled 0-100. rel_churn = churn / lines (Nagappan & Ball 2005, relative code churn).
// Paths are relative to the folder (a monorepo project indexes its own folder: ls-tree lists it, log --relative keeps to it); the graph's
// are relative to the repo root, so a file here is the graph's prefix + file. The graph's exclusion rule (vendored, generated) drops files.
import { execFileSync } from 'node:child_process';
import { fans, excluded } from './codegraph.mjs';

const DAY = 86400e3, LAST = 5;
const LANG = { mjs: 'javascript', cjs: 'javascript', js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', json: 'json', md: 'markdown',
  rs: 'rust', go: 'go', cs: 'csharp', java: 'java', rb: 'ruby', sh: 'shell', ps1: 'powershell', yml: 'yaml', yaml: 'yaml', toml: 'toml', c: 'c', h: 'c', cpp: 'cpp',
  html: 'html', css: 'css', txt: 'text' };
const langOf = f => { const m = /\.([^./]+)$/.exec(f); return (m && LANG[m[1].toLowerCase()]) ?? 'other'; };
const git = (dir, args, input) => execFileSync('git', ['-C', dir, '-c', 'core.quotePath=false', ...args], { input, maxBuffer: 1 << 30, windowsHide: true, timeout: 300000, stdio: ['pipe', 'pipe', 'pipe'] });
/** a text's line count: its newlines, plus a last line without one (numstat counts it the same way) */
export const lineCount = buf => { let n = 0; for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) n++; return buf.length && buf[buf.length - 1] !== 10 ? n + 1 : n; };
// git's own test: a NUL in the first 8000 bytes is a binary
const isBinary = buf => buf.subarray(0, 8000).includes(0);

/** HEAD's blobs under dir -> [{ file, buf }], text files only, the ones skip(file) names dropped */
function headBlobs(dir, skip) {
  const ents = git(dir, ['ls-tree', '-r', '-z', 'HEAD']).toString('utf8').split('\0').filter(Boolean).map(l => { const t = l.indexOf('\t'), [, type, sha] = l.slice(0, t).split(' '); return { type, sha, file: l.slice(t + 1) }; })
    .filter(e => e.type === 'blob' && !skip(e.file));
  if (!ents.length) return [];
  const out = git(dir, ['cat-file', '--batch'], ents.map(e => e.sha).join('\n') + '\n'), blobs = [];
  let at = 0;
  for (const e of ents) {
    const nl = out.indexOf(10, at), size = Number(out.subarray(at, nl).toString().split(' ')[2]), buf = out.subarray(nl + 1, nl + 1 + size);
    at = nl + 1 + size + 1;
    if (!isBinary(buf)) blobs.push({ file: e.file, buf });
  }
  return blobs;
}
/** the first-parent history, newest first -> [{ sha, t (ms), day (UTC), subject, stat: [[file, added, deleted]] }] (binary rows dropped) */
function history(dir) {
  return git(dir, ['log', '--first-parent', '--no-renames', '--relative', '--numstat', '--format=%x01%H%x02%ct%x02%s', 'HEAD']).toString('utf8').split('\x01').filter(Boolean).map(c => {
    const [head, ...rows] = c.split('\n'), [sha, ct, subject] = head.split('\x02');
    return { sha, t: Number(ct) * 1000, day: new Date(Number(ct) * 1000).toISOString().slice(0, 10), subject, stat: rows.map(r => r.split('\t')).filter(r => r.length === 3 && r[0] !== '-').map(([a, d, f]) => [f, Number(a), Number(d)]) };
  });
}
/** Borda points per value: the values below it + half the others equal to it (ties share the mean rank); codesignals.mjs ranks with it too */
export function borda(vals) {
  const s = [...vals].sort((a, b) => a - b), lo = v => { let i = 0; while (i < s.length && s[i] < v) i++; return i; }, hi = v => { let i = lo(v); while (i < s.length && s[i] === v) i++; return i; };
  const m = new Map();
  return vals.map(v => { if (!m.has(v)) { const a = lo(v), b = hi(v); m.set(v, a + (b - a - 1) / 2); } return m.get(v); });
}

/** dir: a git work tree folder; o.graph: codegraph.mjs graphAt of dir at HEAD, or its { ok: false, why } (none: every fan_in
 *  n/a, "no code graph asked for"); o.weeks (26), o.now (ms)
 *  -> { at, sha, weeks: [week-end days], added_30d, files: [...] } */
export function codeIndex(dir, { graph = { ok: false, why: 'no code graph asked for' }, weeks = 26, now = Date.now() } = {}) {
  const gp = f => (graph.prefix || '') + f, skip = f => Boolean(graph.ok && excluded(graph, gp(f)));
  const sha = git(dir, ['rev-parse', '--short=12', 'HEAD']).toString().trim(), blobs = headBlobs(dir, skip), commits = history(dir);
  const F = new Map(blobs.map(b => [b.file, { file: b.file, lines: lineCount(b.buf), bytes: b.buf.length, lang: langOf(b.file), born: null, commits_90d: 0, churn_90d: 0, last: [] }]));
  const since90 = now - 90 * DAY, since30 = now - 30 * DAY;
  let added30 = 0;
  for (const c of commits) for (const [f, a, d] of c.stat) {
    const x = F.get(f);
    if (!x) continue;
    x.born = c.day;   // newest first: the last write is the oldest commit
    if (c.t > since90 && c.t <= now) { x.commits_90d++; x.churn_90d += a + d; }
    if (c.t > since30 && c.t <= now) added30 += a;
    if (x.last.length < LAST) x.last.push({ sha: c.sha.slice(0, 12), day: c.day, subject: c.subject, added: a, deleted: d });
  }
  // growth: walk the week ends from the newest back, undoing every commit newer than each
  const ends = Array.from({ length: weeks }, (_, i) => now - (weeks - 1 - i) * 7 * DAY), size = new Map([...F].map(([f, x]) => [f, x.lines])), grow = new Map([...F.keys()].map(f => [f, []]));
  for (let w = weeks - 1, j = 0; w >= 0; w--) {
    for (; j < commits.length && commits[j].t > ends[w]; j++) for (const [f, a, d] of commits[j].stat) if (size.has(f)) size.set(f, size.get(f) - a + d);
    for (const [f, n] of size) grow.get(f)[w] = Math.max(0, n);
  }
  // fan_in: the graph's for every file it knows; another file is no graph language; no graph at all: its reason, never a guess
  const fm = graph.ok ? fans(graph) : null, fan = new Map([...F.keys()].map(f => [f, fm ? (fm.has(gp(f)) ? { n: fm.get(gp(f)).in } : { why: 'not a graph language' }) : { why: graph.why }]));
  const files = [...F.values()].sort((a, b) => (a.file < b.file ? -1 : 1)), n = files.length;
  const pf = borda(files.map(x => fan.get(x.file).n ?? 0)), pc = borda(files.map(x => x.churn_90d));
  return { at: new Date(now).toISOString(), sha, weeks: ends.map(t => new Date(t).toISOString().slice(0, 10)), added_30d: added30, files: files.map((x, i) => ({ ...x, rel_churn: x.lines ? Math.round(1000 * x.churn_90d / x.lines) / 1000 : null,
    growth: grow.get(x.file), fan_in: fan.get(x.file).n ?? null, ...(fan.get(x.file).why ? { fan_in_why: fan.get(x.file).why } : {}), importance: n > 1 ? Math.round(100 * (pf[i] + pc[i]) / (2 * (n - 1))) : 100 })) };
}
