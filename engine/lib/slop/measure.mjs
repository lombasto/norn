// SloppaChoppa 2 S4 (SPEC 4.1 growth, 4.4 U1 / U2): growth and structure numbers, by code. The size line of a branch (net lines by
// area, tests apart: git numstat + loc.mjs classes); the function and file ratchets, in SHADOW (recorded, never held: the replay
// over the last merged branches sets their level); one point per landing on main; hotspots (commits in 30 days x the file's
// complexity sum); fan-in and fan-out over the import graph (graph.mjs). The function numbers come from ESLint's own size rules run
// with every threshold at zero (one more ESLint pass over the touched files, the lint run's tool): each function reports its number
// and the message carries it. JS only today: ruff's and clippy's numbers are a follow-up.
import { gitRun, blobs, diffEntries } from './check.mjs';
import { classOf, areaOf, landings, num, delta } from './loc.mjs';
import { parseEslint } from './tools.mjs';
import { masked, lineText, usesOf, isJs } from './scan.mjs';
import { packOf } from './lang/index.mjs';
import { importGraph, fans } from './graph.mjs';

/** SPEC 4.1 b / c: the function caps, the file ratchet, the branch's WARN (growth.branch_warn); S4's replay proposes their levels */
export const CAPS = { complexity: 20, lines: 80, depth: 4, params: 6 };
export const FILE_CAP = { lines: 1500, grew: 20 };
export const BRANCH_WARN = 600;
export const FAN_OUT = 15;
const METRIC = { complexity: 'complexity', 'max-lines-per-function': 'lines', 'max-depth': 'depth', 'max-params': 'params', 'max-statements': 'statements' };
/** the ONE measure run: ESLint core size rules at zero, no repo config (the numbers are Choppa's, not the repo's gate) */
export const MEASURE_RUN = { id: 'measure', kind: 'lint', tool: 'eslint', config: null, selectors: [], rules: Object.fromEntries(Object.keys(METRIC).map(r => [r, ['error', r === 'max-lines-per-function' ? { max: 0 } : 0]])) };   // its number form is >= 1
const sign = n => `${n >= 0 ? '+' : ''}${num(n)}`;

// ---------- the numbers of one file ----------
// the name ESLint gives ("Function 'foo'", "Method 'm'"), else the binding left of an anonymous one (`const bar = (p) =>`)
const nameOf = (x, text) => /'([^']+)'/.exec(x.msg)?.[1] || /([\w$]+)\s*[:=]\s*(?:async\s*)?(?:function\b\s*\*?\s*)?$/.exec(lineText(text, x.line).slice(0, x.column - 1))?.[1] || '(anonymous)';
// the lines of the block that starts at a statement (its first `{` before the function's end, to the matching `}`), on code only
function blockSpan(code, line, column, end) {
  const starts = [0]; for (let i = 0; i < code.length; i++) if (code[i] === '\n') starts.push(i + 1);
  const lineOf = i => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= i) lo = m; else hi = m - 1; } return lo + 1; };
  const open = code.indexOf('{', (starts[line - 1] ?? 0) + column - 1);
  if (open < 0 || lineOf(open) > end) return [line, line];
  for (let i = open, d = 0; i < code.length; i++) { if (code[i] === '{') d++; else if (code[i] === '}' && --d === 0) return [line, lineOf(i)]; }
  return [line, end];
}
/**
 * One file's ESLint messages of the measure run (parseEslint's shape) -> [{ name, key (name#n: the nth of that name, stable across
 * moves), line, end, complexity, lines, depth, params, statements, extract: [a, b] (the largest nested block: the extraction candidate) }]
 */
export function functionsOf(xs, text = '') {
  const by = new Map(), depth = [];
  for (const x of xs) {
    const k = METRIC[x.rule];
    if (k === 'depth') { depth.push(x); continue; }
    if (!k) continue;
    const at = `${x.line}:${x.column}`, f = by.get(at) || by.set(at, { name: nameOf(x, text), line: x.line, column: x.column, complexity: 0, lines: 0, depth: 0, params: 0, statements: 0, blocks: [] }).get(at);
    f[k] = Number(/(?:of |\()(\d+)\)?\. Maximum/.exec(x.msg)?.[1] || 0);
  }
  const fns = [...by.values()].sort((a, b) => a.line - b.line || a.column - b.column), seen = {}, code = masked(text, ['code'], 'x.mjs');
  for (const f of fns) { f.end = f.line + Math.max(f.lines, 1) - 1; f.key = `${f.name}#${(seen[f.name] = (seen[f.name] || 0) + 1)}`; }
  // max-depth counts per function: a block belongs to the innermost function around it
  for (const x of depth) {
    const f = fns.filter(g => g.line <= x.line && x.line <= g.end).sort((a, b) => (a.end - a.line) - (b.end - b.line))[0];
    if (f) { f.depth = Math.max(f.depth, Number(/\((\d+)\)/.exec(x.msg)?.[1] || 0)); f.blocks.push(blockSpan(code, x.line, x.column, f.end)); }
  }
  return fns.map(({ blocks, column, ...f }) => ({ ...f, extract: blocks.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]) || a[0] - b[0])[0] || null }));
}

// ---------- the ratchets (SPEC 4.1 b, c and the anti-gaming row) ----------
const excessOf = fns => fns.reduce((s, f) => s + Object.keys(CAPS).reduce((t, m) => t + Math.max(0, f[m] - CAPS[m]), 0), 0);
const codeLines = text => (text || '').split('\n').filter(l => /\S/.test(l)).length;
// a function new at head whose name is used once more in the file, inside another function, counts with that caller (main -> main2)
function folded(fns, text, baseKeys) {
  const code = masked(text, ['code'], 'x.mjs'), out = fns.map(f => ({ ...f })), gone = new Set();
  for (const f of out) {
    if (baseKeys.has(f.key) || f.name === '(anonymous)' || usesOf(code, f.name) !== 2) continue;
    const re = new RegExp(`(?<![\\w$])${f.name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g'), lines = [...code.matchAll(re)].map(m => code.slice(0, m.index).split('\n').length).filter(l => l < f.line || l > f.end);
    const caller = lines.length === 1 && out.filter(g => g !== f && !gone.has(g) && g.line <= lines[0] && lines[0] <= g.end).sort((a, b) => (a.end - a.line) - (b.end - b.line))[0];
    if (!caller) continue;
    caller.complexity += f.complexity - 1; caller.lines += f.lines; caller.statements += f.statements; caller.depth = Math.max(caller.depth, f.depth); gone.add(f);
  }
  return out.filter(f => !gone.has(f));
}
const metricWords = ms => Object.entries(ms).map(([m, [b, h]]) => `${m} ${b ?? 'new'} -> ${h}${CAPS[m] ? ` (cap ${CAPS[m]})` : ''}`).join(', ');
/**
 * ratchets({ file, base: { text, fns } | null (the file is new), head: { text, fns } }) -> the shadow findings
 * [{ ratchet: function | file | excess, file, line, name, metrics: { metric: [base, head] }, msg, extract?, shadow: true }]: a function over a
 * cap that grew in a metric over its cap, or newly crosses one; a file over FILE_CAP.lines that grew by more than FILE_CAP.grew; a
 * file whose summed excess over the caps grew (so splitting nothing off and shuffling cannot hide it).
 */
export function ratchets({ file, base, head }) {
  const out = [], bfns = base?.fns || [], bk = new Map(bfns.map(f => [f.key, f])), hfns = folded(head.fns || [], head.text || '', new Set(bk.keys()));
  for (const f of hfns) {
    const b = bk.get(f.key), ms = {};
    for (const m of Object.keys(CAPS)) if (f[m] > CAPS[m] && (!b || b[m] <= CAPS[m] || f[m] > b[m])) ms[m] = [b ? b[m] : null, f[m]];
    if (!Object.keys(ms).length) continue;
    const ex = f.extract && f.extract[1] > f.extract[0] ? `; extract lines ${f.extract[0]}-${f.extract[1]} (its largest nested block)` : '';
    out.push({ ratchet: 'function', file, line: f.line, name: f.name, metrics: ms, msg: `function ${f.name} (${file}:${f.line}): ${metricWords(ms)}${ex}`, ...(ex ? { extract: f.extract } : {}), shadow: true });
  }
  const bl = codeLines(base?.text), hl = codeLines(head.text);
  if (hl > FILE_CAP.lines && hl - bl > FILE_CAP.grew) out.push({ ratchet: 'file', file, line: 0, name: file, metrics: { lines: [bl, hl] }, msg: `file ${file}: ${num(bl)} -> ${num(hl)} code lines (over ${num(FILE_CAP.lines)}, grew by more than ${FILE_CAP.grew}): the split proposal`, shadow: true });
  const be = excessOf(folded(bfns, base?.text || '', new Set(bfns.map(f => f.key)))), he = excessOf(hfns);
  if (he > be) out.push({ ratchet: 'excess', file, line: 0, name: file, metrics: { excess: [be, he] }, msg: `file ${file}: its summed excess over the function caps grew ${be} -> ${he}`, shadow: true });
  return out;
}

// ---------- the size line (SPEC 4.1 a) ----------
/** `git diff --numstat -z -M` text -> { code, tests, docs, config, areas: { area: net code } } (a rename counts at its new path; binaries and the apart classes not at all) */
export function sizeOfNumstat(raw) {
  const s = { code: 0, tests: 0, docs: 0, config: 0, areas: {} }, parts = raw.split('\0');
  for (let i = 0; i < parts.length - 1;) {
    const [a, d, p] = parts[i++].replace(/^\n/, '').split('\t'), f = p === '' ? (i++, parts[i++]) : p;
    if (a === '-') continue;
    const c = classOf(f), n = Number(a) - Number(d);
    if (!(c in s)) continue;
    s[c] += n;
    if (c === 'code') s.areas[areaOf(f)] = (s.areas[areaOf(f)] || 0) + n;
  }
  s.areas = Object.fromEntries(Object.entries(s.areas).filter(([, n]) => n).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]) || (x[0] < y[0] ? -1 : 1)));
  return s;
}
/** the size line: "size: code +412 net (engine/lib +300, ...), tests +80, docs +12"; WARN past `warn` net code lines, or when a fix / refactor brief (its first heading) made the code bigger */
export function sizeLine(s, { warn = BRANCH_WARN, brief = null } = {}) {
  const areas = Object.entries(s.areas || {}), shown = areas.slice(0, 4).map(([a, n]) => `${a} ${sign(n)}`), rest = areas.slice(4).reduce((t, [, n]) => t + n, 0);
  const why = s.code > warn ? `past ${num(warn)} net code lines` : s.code > 0 && /^#+.*\b(fix|refactor)/im.test(brief || '') ? 'a fix brief made the code bigger' : null;
  const parts = [`code ${sign(s.code)} net${shown.length ? ` (${shown.join(', ')}${areas.length > 4 ? `, ${sign(rest)} in ${areas.length - 4} more` : ''})` : ''}`, ...['tests', 'docs', 'config'].filter(c => s[c]).map(c => `${c} ${sign(s[c])}`)];
  return `${why ? 'WARN ' : ''}size: ${parts.join(', ')}${why ? ` - ${why}` : ''}`;
}

// ---------- one diff ----------
const measureTexts = (tool, side, texts) => {
  if (!texts.size) return new Map();
  const raw = tool(MEASURE_RUN, side, { texts }), by = new Map();
  for (const x of raw === null ? [] : parseEslint(raw)) (by.get(x.file) || by.set(x.file, []).get(x.file)).push(x);
  return by;
};
/**
 * measureDiff({ repo, base, head, tool, brief }) -> { size, line (the size line), ratchets, error? }: the size of base..head and the
 * ratchets over its touched JS code files (both sides; a rename's base under its old path). A measure run that throws is said
 * (error) and its ratchets are empty: they are shadow, so nothing passes or holds by it.
 */
export function measureDiff({ repo, base, head, tool, brief = null }) {
  const size = sizeOfNumstat(gitRun(repo, ['diff', '--numstat', '-z', '-M', base, head])), line = sizeLine(size, { brief });
  const es = diffEntries(repo, base, head).filter(e => e.status !== 'D' && isJs(e.path) && classOf(e.path) === 'code');
  const ht = blobs(repo, es.map(e => `${head}:${e.path}`)), olds = es.filter(e => e.old), ot = blobs(repo, olds.map(e => `${base}:${e.old}`)), bt = es.map(e => (e.old ? ot[olds.indexOf(e)] : null));
  try {
    const H = measureTexts(tool, 'head', new Map(es.map((e, k) => [e.path, ht[k]]).filter(([, t]) => t !== null)));
    const B = measureTexts(tool, 'base', new Map(es.map((e, k) => [e.old, bt[k]]).filter(([f, t]) => f && t !== null && t !== undefined)));
    const rs = es.flatMap((e, k) => (ht[k] === null ? [] : ratchets({ file: e.path, base: bt[k] ? { text: bt[k], fns: functionsOf(B.get(e.old) || [], bt[k]) } : null, head: { text: ht[k], fns: functionsOf(H.get(e.path) || [], ht[k]) } })));
    return { size, line, ratchets: rs };
  } catch (e) { return { size, line, ratchets: [], error: String(e.message).split('\n')[0] }; }
}

// ---------- per landing, per week (SPEC 4.1 d-f) ----------
const branchOf = subject => /^Merge pull request #\d+ from [^/\s]+\/(\S+)/.exec(subject)?.[1] || /^Merge branch '?([^'\s]+)'?/.exec(subject)?.[1] || null;
/**
 * one point per first-parent landing on ref since a day: [{ sha, day, branch, item, subject, code_net, tests_net, over_cap }] (over_cap:
 * the ratchet hits of the landing's diff from its first parent). items: { branch: deliverable id }; skip: Set(sha) already stored.
 */
export function landingPoints(repo, ref, since, { tool, items = {}, skip = new Set() } = {}) {
  return landings(repo, ref, since).filter(l => !skip.has(l.sha)).map(l => {
    const branch = branchOf(l.subject), parent = gitRun(repo, ['rev-parse', '--verify', '--quiet', `${l.sha}^1`], { ok: [0, 1] }).trim();
    const m = parent ? measureDiff({ repo, base: parent, head: l.sha, tool }) : null;
    return { sha: l.sha, day: l.day, branch, item: (branch && items[branch]) || null, subject: l.subject, code_net: (l.added.code || 0) - (l.deleted.code || 0),
      tests_net: (l.added.tests || 0) - (l.deleted.tests || 0), over_cap: m && !m.error ? m.ratchets.length : null };
  });
}
/** the n merges (points with a branch) that grew the code most */
export const topMerges = (points, n = 5) => points.filter(p => p.branch).sort((a, b) => b.code_net - a.code_net || (a.sha < b.sha ? -1 : 1)).slice(0, n);

/** U3's churn half: commits in `days` per JS code file at ref times its complexity sum there (the measure run), top n */
export function hotspots(repo, ref, { tool, days = 30, now = Date.now(), n = 5 } = {}) {
  const since = new Date(now - days * 864e5).toISOString(), commits = new Map();
  for (const f of gitRun(repo, ['log', '--no-merges', '--no-renames', '--format=', '--name-only', `--since=${since}`, ref]).split('\n').filter(Boolean)) commits.set(f, (commits.get(f) || 0) + 1);
  const tree = new Set(gitRun(repo, ['ls-tree', '-r', '--name-only', ref]).split('\n')), files = [...commits.keys()].filter(f => tree.has(f) && isJs(f) && classOf(f) === 'code');
  const texts = blobs(repo, files.map(f => `${ref}:${f}`)), by = measureTexts(tool, 'head', new Map(files.map((f, k) => [f, texts[k]]).filter(([, t]) => t !== null)));
  return files.map(f => { const complexity = functionsOf(by.get(f) || []).reduce((s, x) => s + x.complexity, 0); return { file: f, commits: commits.get(f), complexity, score: commits.get(f) * complexity }; })
    .filter(h => h.score).sort((a, b) => b.score - a.score || (a.file < b.file ? -1 : 1)).slice(0, n);
}
/** U2: fan-in and fan-out over the code files of the tree at ref (the language packs) -> { in: top n, out: top n } as [{ file, in, out }] */
export function fanList(repo, ref, { n = 5 } = {}) {
  const tree = gitRun(repo, ['ls-tree', '-r', '--name-only', ref]).split('\n').filter(Boolean), files = tree.filter(f => packOf(f) && classOf(f) === 'code');
  const rows = [...fans(importGraph(files, blobs(repo, files.map(f => `${ref}:${f}`)), tree))].map(([file, x]) => ({ file, ...x }));
  const top = k => rows.filter(r => r[k]).sort((a, b) => b[k] - a[k] || (a.file < b.file ? -1 : 1)).slice(0, n);
  return { in: top('in'), out: top('out') };
}

// ---------- the daily's growth section ----------
/** { merges (the week's top five by code growth), areas (each area's change and share of the week's growth), hotspots, fan } */
export function growthOf({ loc, points, hotspots: hs, fan }) {
  const then = loc.series.length > 7 ? loc.series[loc.series.length - 8] : loc.series[0], ch = a => (loc.areas[a]?.code || 0) - (then?.areas[a]?.code || 0);
  const names = [...new Set([...Object.keys(loc.areas), ...Object.keys(then?.areas || {})])], grew = names.reduce((s, a) => s + Math.max(0, ch(a)), 0);
  const areas = names.filter(a => ch(a)).map(a => ({ area: a, code: loc.areas[a]?.code || 0, then: then?.areas[a]?.code || 0, share: grew && ch(a) > 0 ? ch(a) / grew : 0 })).sort((a, b) => (b.code - b.then) - (a.code - a.then));
  return { since: then?.day ?? null, merges: topMerges(points.filter(p => !then || p.day > then.day)), areas, hotspots: hs, fan };
}
/** the markdown lines of growthOf's result ({ error }: the section says it could not run) */
export function renderGrowth(g) {
  if (g.error) return ['## Growth: could not run', '', g.error, ''];
  const L = [`## Growth: the five merges that grew the code most in 7 d (since ${g.since ?? '-'})`, ''];
  g.merges.forEach((p, i) => L.push(`${i + 1}. \`${p.sha.slice(0, 7)}\` ${p.branch} code ${sign(p.code_net)}, tests ${sign(p.tests_net)}${p.over_cap ? `, ${p.over_cap} over a cap (shadow)` : ''}${p.item ? ` (${p.item})` : ''}: ${p.subject.slice(0, 80)}`));
  if (!g.merges.length) L.push('No merge on main in 7 d.');
  L.push('', '| area | code | 7 d | share of the growth |', '|---|---:|---:|---:|', ...g.areas.map(a => `| ${a.area} | ${num(a.code)} | ${delta(a.code, a.then)} | ${Math.round(100 * a.share)} % |`));
  L.push('', '## Hotspots: commits in 30 d x the file\'s complexity sum', '');
  g.hotspots.forEach((h, i) => L.push(`${i + 1}. \`${h.file}\` ${num(h.score)} = ${h.commits} commits x complexity ${num(h.complexity)}`));
  if (!g.hotspots.length) L.push('None (no JS code file changed in 30 d).');
  L.push('', `## Fan-in / fan-out (the import graph; fan-out over ${FAN_OUT} is a split candidate)`, '', 'fan-in (imported by):', ...g.fan.in.map(r => `- \`${r.file}\` ${r.in}`), '', 'fan-out (imports):',
    ...g.fan.out.map(r => `- \`${r.file}\` imports ${r.out}${r.out > FAN_OUT ? ` (over ${FAN_OUT})` : ''}`), '');
  return L;
}

/**
 * The ratchets' replay (SPEC 4 "replay before voice"): per merge of the last `last` on main's first-parent line (newest first), its
 * branch (the second parent) measured from its merge base with the first -> [{ merge, subject, size, ratchets, error? }]
 */
export function measureReplay({ repo, main = 'HEAD', last = 50, tool }) {
  return gitRun(repo, ['log', '--merges', '--first-parent', `-n${last}`, '--format=%H %P %s', main]).split('\n').filter(Boolean).map(l => {
    const [sha, p1, p2, ...s] = l.split(' '), base = gitRun(repo, ['merge-base', p1, p2]).trim(), m = measureDiff({ repo, base, head: p2, tool });
    return { merge: sha.slice(0, 8), subject: s.join(' '), size: m.size, ratchets: m.ratchets, ...(m.error ? { error: m.error } : {}) };
  });
}
