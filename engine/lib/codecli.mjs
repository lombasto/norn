// `norn code history` (SPEC dash-owner-1123 s.7): writes <state>/code/index.json, codeindex.mjs's per-file index of the project folder
// (git only, no model). tickCode is the tick's hook: it starts the verb detached when HEAD moved past the index. codeAt answers the dash's
// /api/code: the summary (<= 4 numbers) or one part of the Code tab (files | growth | outliers | file | map), read from that one file.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { readJsonS } from './fsnap.mjs';
import { atomicWrite } from './policy.mjs';
import { projectHome } from './monorepo.mjs';
import { codeIndex } from './codeindex.mjs';

export const CODE_USAGE = 'usage: norn code history [--project P | --state D] [--repo DIR] [--json]   (history = <state>/code/index.json: per tracked text file '
  + 'its lines, growth over 26 weeks, churn over 90 days, fan-in and importance, from git)';
export const CODE_FILE = 'index.json', CODE_CAP = 40, CODE_SORTS = ['importance', 'lines', 'growth', 'churn', 'fan_in', 'file'];
const FLAGS = { history: [] }, START_GAP_MS = 10 * 60e3;
const indexOf = state => path.join(state, 'code', CODE_FILE);

function parse(verb, argv) {
  const spec = [...FLAGS[verb], 'project', 'state', 'repo', 'json!'], f = {};
  for (let i = 0; i < argv.length; i++) {
    const s = spec.find(x => '--' + x.replace(/!$/, '') === argv[i]);
    if (!s) throw new Error(`unexpected ${argv[i]}`);
    if (s.endsWith('!')) f[s.slice(0, -1)] = true;
    else { if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`); f[s] = argv[++i]; }
  }
  return f;
}
/** o: { out, err, where(flags) -> { project, state }, now } -> exit code */
export function codeCmd(argv, { out = console.log, err = console.error, where, now } = {}) {
  const verb = argv[0];
  let f, w;
  try { if (!FLAGS[verb]) throw new Error(verb ? `unknown verb ${verb}` : 'missing verb'); f = parse(verb, argv.slice(1)); w = where(f); }
  catch (e) { err('error: ' + e.message); err(CODE_USAGE); return 2; }
  const dir = f.repo || (w.project?.root ? projectHome(w.project) : process.cwd()), t0 = Date.now();
  let ix;
  try { ix = codeIndex(dir, { now: now ?? Date.now() }); } catch (e) { err(`error: code history: ${String(e.stderr || e.message).trim()} (${dir})`); return 2; }
  const file = indexOf(w.state), ms = Date.now() - t0, lines = ix.files.reduce((n, x) => n + x.lines, 0);
  fs.mkdirSync(path.dirname(file), { recursive: true }); atomicWrite(file, JSON.stringify(ix));
  if (f.json) out(JSON.stringify({ files: ix.files.length, lines, sha: ix.sha, ms }));
  else out(`code history: ${ix.files.length} files, ${lines} lines at ${ix.sha} in ${(ms / 1000).toFixed(1)} s -> ${file}`);
  return 0;
}

/** the tick's hook: `norn code history` detached when HEAD is not the index's sha (not while one started in the last 10 min; the mark is
 *  the start time) -> the tick-log words | null */
export function tickCode(p, state, { metaCmd, spawnFn, now = Date.now() } = {}) {
  if (!p?.file || !p.root) return null;
  let head;
  try { head = execFileSync('git', ['-C', projectHome(p), 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; /* no git repo: nothing to index */ }
  if (head === readJsonS(indexOf(state))?.sha) return null;
  const mark = path.join(state, 'code', 'history.started');
  try { if (now - Number(fs.readFileSync(mark, 'utf8')) < START_GAP_MS) return null; } catch { /* never started: start it now */ }
  fs.mkdirSync(path.dirname(mark), { recursive: true }); fs.writeFileSync(mark, String(now));
  const args = [metaCmd, 'code', 'history', '--project', p.file, '--state', state];
  let r = spawnFn ? spawnFn(process.execPath, args) : null;
  if (!r) { const c = spawn(process.execPath, args, { cwd: p.root, detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); r = { pid: c.pid }; }
  return `code history: started pid ${r?.pid ?? '?'}`;
}

// ---- the Code tab's parts ----
const areaOf = f => (f.includes('/') ? f.split('/')[0] : '.');
const rowOf = x => { const g = x.growth, d = g.at(-1) - g[0];
  return { file: x.file, lines: x.lines, lang: x.lang, growth: g, delta: d, pct: g[0] ? Math.round(100 * d / g[0]) : null, churn_90d: x.churn_90d, rel_churn: x.rel_churn, commits_90d: x.commits_90d, fan_in: x.fan_in, importance: x.importance }; };
const SORT = { importance: (a, b) => b.importance - a.importance || b.churn_90d - a.churn_90d, lines: (a, b) => b.lines - a.lines, growth: (a, b) => b.delta - a.delta,
  churn: (a, b) => b.churn_90d - a.churn_90d, fan_in: (a, b) => (b.fan_in ?? -1) - (a.fan_in ?? -1), file: () => 0 };
const sorted = (rows, k) => [...rows].sort((a, b) => SORT[k](a, b) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
/** the folders a filter offers: every directory one or two levels deep, with its file count -> [[folder, n]] by name */
function foldersOf(files) {
  const m = new Map();
  for (const { file } of files) { const p = file.split('/').slice(0, -1); for (let k = 1; k <= Math.min(2, p.length); k++) { const d = p.slice(0, k).join('/'); m.set(d, (m.get(d) ?? 0) + 1); } }
  return [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
/** p: { name, state }; url: the request's URL (part, limit, sort, folder, file) -> the summary | a part ({ list: null } etc. while no index) */
export async function codeAt(p, url) {
  const ix = await fs.promises.readFile(indexOf(p.state), 'utf8').then(JSON.parse, () => null), q = k => url.searchParams.get(k), part = q('part');
  if (part === null) {
    if (!ix) return { project: p.name, index: null, total: null, commands: { history: 'norn code history' } };
    const top = sorted(ix.files.map(rowOf), 'importance')[0];
    return { project: p.name, index: { at: ix.at, sha: ix.sha }, total: { files: ix.files.length, lines: ix.files.reduce((n, x) => n + x.lines, 0), added_30d: ix.added_30d, hotspot: top?.file ?? null }, commands: { history: 'norn code history' } };
  }
  if (part === 'map') return { map: null };
  const rows = ix ? ix.files.map(rowOf) : null;
  if (part === 'files') {
    if (!rows) return { list: null };
    const sort = CODE_SORTS.includes(q('sort')) ? q('sort') : 'importance', folder = String(q('folder') ?? '').replace(/\/+$/, ''), lim = Number(q('limit'));
    const hit = sorted(rows.filter(r => !folder || r.file.startsWith(`${folder}/`)), sort), shown = hit.slice(0, Number.isInteger(lim) && lim > 0 ? lim : CODE_CAP);
    return { list: { sort, folder, folders: foldersOf(ix.files), limit: shown.length, matched: hit.length, shown: shown.length, rows: shown } };
  }
  if (part === 'growth') {
    if (!rows) return { days: [], areas: [], fastest: [] };
    const by = new Map();
    for (const x of ix.files) { const a = areaOf(x.file), s = by.get(a) ?? ix.weeks.map(() => 0); x.growth.forEach((n, i) => { s[i] += n; }); by.set(a, s); }
    const areas = [...by].sort((a, b) => b[1].at(-1) - a[1].at(-1) || (a[0] < b[0] ? -1 : 1)).map(([a, s]) => ({ key: a, label: a, points: s.map((y, i) => ({ x: ix.weeks[i], y })) }));
    return { days: ix.weeks, areas, fastest: sorted(rows.filter(r => r.delta > 0), 'growth').slice(0, 10) };
  }
  if (part === 'outliers') {
    if (!rows) return { size: [], growth: [], churn: [] };
    const pts = k => rows.map(r => ({ id: r.file, label: r.file, value: r[k] }));
    return { size: pts('lines'), growth: pts('delta'), churn: pts('churn_90d') };
  }
  if (part === 'file') {
    const x = ix?.files.find(f => f.file === q('file'));
    return { file: x ? { ...rowOf(x), born: x.born, bytes: x.bytes, last: x.last, days: ix.weeks } : null };
  }
  throw new Error(`unknown code part ${part}`);
}
