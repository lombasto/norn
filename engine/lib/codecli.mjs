// `norn code history` (SPEC dash-owner-1123 s.7): writes <state>/code/index.json, codeindex.mjs's per-file index of the project folder
// (git only, no model). tickCode is the tick's hook: it starts the verb detached when HEAD moved past the index. codeAt answers the dash's
// /api/code: the summary (<= 4 numbers) or one part of the Code tab (files | growth | outliers | file | map), read from that one file.
// `norn code map [--refresh]` draws the Floorplan map (codemap.mjs); the same hook starts its metered refresh when HEAD moved past it.
// history also stores the code signals (codesignals.mjs, docs/code-signals.md); `norn code signals` prints them, the Files part joins them.
// RM-a-58: `norn code links` refreshes <state>/code/declinks.json (declinks.mjs: each decision / directive tied to the paths it governs) and
// prints its coverage; `norn code why <file>` lists a file's governing records. The hook starts `code links` when main or the records moved.
// `norn code suspects` ranks the recent landings against a trace or symptom words (codesuspects.mjs, RM-a-61).
// `norn code risk <base>..<head>` ranks a diff against the last 100 landings (coderisk.mjs, RM-a-68).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { readJsonS } from './fsnap.mjs';
import { atomicWrite } from './policy.mjs';
import { projectHome } from './monorepo.mjs';
import { codeIndex } from './codeindex.mjs';
import { drawMap, tickMap, mapAt } from './codemap.mjs';
import { codeSignals, writeSignals, readSignals } from './codesignals.mjs';
import { refreshLinks, whyOf, linksSummary, linksFresh } from './declinks.mjs';
import { deliverableConfig } from './deliverables.mjs';
import { suspects, suspectsLines } from './codesuspects.mjs';
import { codeRisk } from './coderisk.mjs';

export const CODE_USAGE = 'usage: norn code history [--project P | --state D] [--repo DIR] [--json]   (history = <state>/code/index.json: per tracked text file '
  + 'its lines, growth over 26 weeks, churn over 90 days, fan-in and importance, from git)\n'
  + 'usage: norn code map [--refresh] [--project P | --state D] [--repo DIR] [--json]   (map = <state>/code/map: the Floorplan map from the pinned '
  + 'tools/floorplan, seeded by docs/architecture.json; --refresh = the tick\'s metered update, skipped over 0.05 % of plan)\n'
  + 'usage: norn code signals <file>.. | --top N [--project P | --state D] [--json]   (signals = <state>/code/signals.json, stored by history: the files '
  + 'that change together with a file, its fix history and the fix-first rank, from git; docs/code-signals.md)\n'
  + 'usage: norn code links [--project P | --state D] [--repo DIR] [--json]   (links = <state>/code/declinks.json: each in-force DEC / active DIR tied '
  + 'to the paths it governs - stated (--paths), else its runs\' files, else its lane\'s landings - and whether one changed on main since)\n'
  + 'usage: norn code why <file> [--project P | --state D] [--repo DIR] [--json]   (the decisions and directives governing <file>, newest first, at most 10)\n'
  + 'usage: norn code suspects "<symptom words>" | --trace <file> [--since <sha | Nd>] [--top N] [--project P | --state D] [--repo DIR] [--json]   (the recent '
  + 'landings to read first against a bug: trace files, their partners, then symptom words; a batch merge judged per member branch; docs/code-signals.md)\n'
  + 'usage: norn code risk <base>..<head> [--project P | --state D] [--repo DIR] [--json]   (where the diff stands against the last 100 landings before '
  + 'its merge base: a percentile, with the numbers that put it there; docs/code-signals.md)';
export const CODE_FILE = 'index.json', CODE_CAP = 40, CODE_SORTS = ['importance', 'fix_first', 'lines', 'growth', 'churn', 'fan_in', 'file'];
const FLAGS = { history: [], map: ['refresh!'], signals: ['top'], links: [], why: [], suspects: ['trace', 'since', 'top'], risk: [] }, START_GAP_MS = 10 * 60e3;
const indexOf = state => path.join(state, 'code', CODE_FILE);

function parse(verb, argv) {
  const spec = [...FLAGS[verb], 'project', 'state', 'repo', 'json!'], f = ['signals', 'suspects', 'risk'].includes(verb) ? { _: [] } : {};
  for (let i = 0; i < argv.length; i++) {
    if (f._ && !argv[i].startsWith('--')) { f._.push(argv[i]); continue; }   // signals: the files named; suspects: the symptom words; risk: the range
    const s = spec.find(x => '--' + x.replace(/!$/, '') === argv[i]);
    if (!s && verb === 'why' && f.file === undefined && !argv[i].startsWith('--')) { f.file = argv[i]; continue; }   // why's one operand
    if (!s) throw new Error(`unexpected ${argv[i]}`);
    if (s.endsWith('!')) f[s.slice(0, -1)] = true;
    else { if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`); f[s] = argv[++i]; }
  }
  if (verb === 'why' && !f.file) throw new Error('why needs a file');
  return f;
}
/** o: { out, err, where(flags) -> { project, state }, now } -> exit code */
export function codeCmd(argv, { out, err, where, now } = {}) {
  const verb = argv[0];
  let f, w;
  try { if (!FLAGS[verb]) throw new Error(verb ? `unknown verb ${verb}` : 'missing verb'); f = parse(verb, argv.slice(1)); w = where(f); }
  catch (e) { err('error: ' + e.message); err(CODE_USAGE); return 2; }
  const dir = f.repo || (w.project?.root ? projectHome(w.project) : process.cwd()), t0 = Date.now();
  if (verb === 'map') return mapCmd(f, w.state, dir, { out, err });
  if (verb === 'signals') return signalsCmd(f, w.state, { out, err });
  if (verb === 'links' || verb === 'why') return linksCmd(verb, f, w, dir, { out, err, now });
  if (verb === 'suspects') return suspectsCmd(f, w.state, dir, { out, err, now });
  if (verb === 'risk') return riskCmd(f, w.state, dir, { out, err });
  let ix, sig;
  try { ix = codeIndex(dir, { now: now ?? Date.now() }); sig = codeSignals(dir, ix, { now: now ?? Date.now() }); } catch (e) { err(`error: code history: ${String(e.stderr || e.message).trim()} (${dir})`); return 2; }
  const file = indexOf(w.state), ms = Date.now() - t0, lines = ix.files.reduce((n, x) => n + x.lines, 0);
  writeSignals(w.state, sig); atomicWrite(file, JSON.stringify(ix));   // the index last: its sha is what the tick checks
  if (f.json) out(JSON.stringify({ files: ix.files.length, lines, sha: ix.sha, ms }));
  else out(`code history: ${ix.files.length} files, ${lines} lines at ${ix.sha} in ${(ms / 1000).toFixed(1)} s -> ${file}; signals: fixes ${sig.fixes.status}, ${sig.landings} landings`);
  return 0;
}

/** `norn code links` / `norn code why <file>`: refresh the index when main or the records moved, then its coverage / the file's records */
function linksCmd(verb, f, w, repo, { out, err, now = Date.now() }) {
  let r;
  try { r = refreshLinks({ state: w.state, repo, main: deliverableConfig(w.project || {}).main, now }); } catch (e) { err(`error: code ${verb}: ${String(e.stderr || e.message).trim()} (${repo})`); return 2; }
  const ix = r.ix, how = 'stated = measured; runs / landings = inferred';
  if (verb === 'links') {
    const s = linksSummary(ix);
    if (f.json) out(JSON.stringify({ ...s, sha: ix.sha, main: ix.main, built: r.built, file: r.file }));
    else out(`code links: ${s.linked} of ${s.records} records linked (stated ${s.by_source.stated}, runs ${s.by_source.runs}, landings ${s.by_source.landings}), ${s.links} links at ${ix.main} ${ix.sha} (${how}) -> ${r.file}`);
    return 0;
  }
  const y = whyOf(ix, f.file, now);
  if (f.json) { out(JSON.stringify(y)); return 0; }
  out([`code why ${y.file}: ${y.matched} records at ${y.sha} (${how})${y.matched > y.rows.length ? `, newest ${y.rows.length} shown` : ''}`,
    ...y.rows.map(x => `  ${x.id}  ${x.age_d} d  ${x.source}${x.from.length ? ` (${x.from.join(', ')})` : ''}  ${x.stale ? `STALE: changed in ${x.stale.sha} ${x.stale.at}` : 'current'}  ${x.title}`)].join('\n'));
  return 0;
}

/** `norn code signals <file>.. | --top N`: the stored signals (readSignals) printed -> exit code (1 = a named file is not in the index) */
function signalsCmd(f, state, { out, err }) {
  const top = f.top === undefined ? null : Number(f.top);
  if (top === null ? !f._.length : f._.length || !(Number.isInteger(top) && top > 0)) { err('error: code signals: name files, or --top N (N > 0)'); err(CODE_USAGE); return 2; }
  let s;
  try { s = readSignals(state); } catch (e) { err(`error: code signals: ${e.message}`); return 2; }
  if (!s) { err('error: code signals: none stored yet (`norn code history` writes them; the tick starts it when the sha moves)'); return 2; }
  const head = { sha: s.sha, at: s.at, basis: s.basis, window: s.window, fixes: s.fixes }, na = s.fixes.status === 'measured' ? null : `n/a (${s.fixes.reason})`;
  const stamp = `${s.basis} from git at ${s.sha}, ${s.at.slice(0, 16)} · window ${s.window.days} days (${s.window.from} to ${s.window.to}) · ${s.landings} landings, ${s.batches_skipped} batches skipped`;
  if (top) {
    const rows = Object.entries(s.files).filter(([, x]) => x.fix_first !== null).sort(([a, x], [b, y]) => y.fix_first - x.fix_first || y.importance - x.importance || (a < b ? -1 : 1)).slice(0, top);
    if (f.json) { out(JSON.stringify({ ...head, files: rows.map(([file, x]) => ({ file, ...x })) })); return 0; }
    if (na) out(`fix first: ${na}`);
    else { out('fix first  fixes 365 d  churn 90 d  importance  file'); for (const [file, x] of rows) out(`${String(x.fix_first).padStart(9)}  ${String(x.fixes.n_365d).padStart(11)}  ${String(x.churn_90d).padStart(10)}  ${String(x.importance).padStart(10)}  ${file}`); }
    out(stamp); return 0;
  }
  const pick = f._.map(x => x.replace(/\\/g, '/').replace(/^\.\//, '')), miss = pick.filter(x => !s.files[x]).length;
  if (f.json) { out(JSON.stringify({ ...head, files: pick.map(file => (s.files[file] ? { file, ...s.files[file] } : { file, missing: 'not in the index' })) })); return miss ? 1 : 0; }
  for (const file of pick) fileLines(file, s, na).forEach(l => out(l));
  out(stamp);
  return miss ? 1 : 0;
}
/** `norn code suspects "<words>" | --trace F`: codesuspects.mjs's ranking -> exit code (1 = no suspect found) */
function suspectsCmd(f, state, dir, { out, err, now }) {
  const top = f.top === undefined ? undefined : Number(f.top);
  if ((!f._.length && !f.trace) || (top !== undefined && !(Number.isInteger(top) && top > 0))) { err('error: code suspects: symptom words or --trace <file>, and --top N with N > 0'); err(CODE_USAGE); return 2; }
  let r;
  try { r = suspects({ dir, state, words: f._.join(' '), trace: f.trace ?? null, since: f.since, top, now: now ?? Date.now() }); } catch (e) { err(`error: code suspects: ${String(e.stderr || e.message).trim()}`); return 2; }
  if (f.json) out(JSON.stringify(r)); else suspectsLines(r).forEach(l => out(l));
  return r.found ? 0 : 1;
}
/** `norn code risk <base>..<head>`: coderisk.mjs's rank -> exit code (0 also when n/a: the line says why; 2 = no such range) */
function riskCmd(f, state, dir, { out, err }) {
  const m = f._.length === 1 && /^(.+?)\.\.(.+)$/.exec(f._[0]);
  if (!m) { err('error: code risk: one range <base>..<head>'); err(CODE_USAGE); return 2; }
  let r;
  try { r = codeRisk({ dir, state, base: m[1], head: m[2] }); } catch (e) { err(`error: code risk: ${String(e.stderr || e.message).trim().split('\n')[0]}`); return 2; }
  if (f.json) { out(JSON.stringify(r)); return 0; }
  out(r.line);
  const n = r.numbers;
  out(`  ${n.files} files, ${n.lines} lines${n.fixes === undefined ? '' : `; fixes 365 d ${n.fixes ?? 'n/a'}, top fix first ${n.fix_first ?? 'n/a'}, companions left out ${n.companions}`}`);
  for (const x of r.left_out) out(`  left out: ${x.partner} (changes with ${x.file}: ${x.shared} of ${x.landings} landings)`);
  return 0;
}
/** one file's signals in words: the rank line, the fixes line, the partners line */
function fileLines(file, s, na) {
  const x = s.files[file];
  if (!x) return [`${file}: not in the index (new, removed, or the index is older than it)`];
  const fx = x.fixes, last = fx?.last[0];
  return [`${file} · fix first ${x.fix_first ?? 'n/a'} · importance ${x.importance}`,
    `  fixes: ${na ?? `${fx.n_90d} in ${s.limits.fix_short_days} days, ${fx.n_365d} in ${s.window.days} days${last ? `; last ${last.day} ${last.sha.slice(0, 8)} ${last.subject}` : ''}`}`,
    `  changes with: ${x.partners.length ? x.partners.map(p => `${p.file} ${p.shared} shared (${Math.round(100 * p.share)} % of ${x.landings} landings; it has ${p.landings})`).join(', ') : `none over the thresholds (${x.landings} landings)`}`];
}

/** `norn code map`: draw (the first map, or the owner's unmetered update) or --refresh (metered) -> exit code (a skipped refresh is 0) */
async function mapCmd(f, state, repo, { out, err }) {
  let r;
  try { r = await drawMap({ state, repo, refresh: Boolean(f.refresh) }); } catch (e) { err(`error: code map: ${String(e.stderr || e.message).trim()}`); return 2; }
  if (f.json) out(JSON.stringify(r));
  else out(r.drawn ? `code map: drew ${r.workflow} at ${r.sha} (${r.calls} model jobs${r.pct === null ? '' : `, ~${r.pct.toFixed(3)} % of plan`}) -> ${r.file}` : `code map: ${r.skipped ? `refresh skipped: ${r.skipped}` : r.why}`);
  return r.drawn || r.skipped || r.sha ? 0 : 2;
}

/** the tick's hook: `norn code history` detached when HEAD is not the index's sha (not while one started in the last 10 min; the mark is
 *  the start time), and the map's metered refresh (codemap.mjs tickMap) -> the tick-log words | null */
export function tickCode(p, state, { metaCmd, spawnFn, now = Date.now() } = {}) {
  if (!p?.file || !p.root) return null;
  let head;
  try { head = execFileSync('git', ['-C', projectHome(p), 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; /* no git repo: nothing to index */ }
  const said = [tickHistory(p, state, { metaCmd, spawnFn, now, head }), tickMap(p, state, { metaCmd, spawnFn, now, head }), tickLinks(p, state, { metaCmd, spawnFn, now })].filter(Boolean);
  return said.length ? said.join('; ') : null;
}
function tickHistory(p, state, { metaCmd, spawnFn, now, head }) {
  if (head === readJsonS(indexOf(state))?.sha) return null;
  const mark = path.join(state, 'code', 'history.started');
  try { if (now - Number(fs.readFileSync(mark, 'utf8')) < START_GAP_MS) return null; } catch { /* never started: start it now */ }
  fs.mkdirSync(path.dirname(mark), { recursive: true }); fs.writeFileSync(mark, String(now));
  const args = [metaCmd, 'code', 'history', '--project', p.file, '--state', state];
  let r = spawnFn ? spawnFn(process.execPath, args) : null;
  if (!r) { const c = spawn(process.execPath, args, { cwd: p.root, detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); r = { pid: c.pid }; }
  return `code history: started pid ${r?.pid ?? '?'}`;
}

// RM-a-58: `norn code links` detached when main or the records moved past the stored index (not while one started in the last 10 min;
// never in a project with no in-force decision or active directive: nothing to link)
function tickLinks(p, state, { metaCmd, spawnFn, now }) {
  const lf = linksFresh({ state, repo: projectHome(p), main: deliverableConfig(p).main });
  if (lf.fresh || !lf.governing || !lf.head) return null;
  const mark = path.join(state, 'code', 'links.started');
  try { if (now - Number(fs.readFileSync(mark, 'utf8')) < START_GAP_MS) return null; } catch { /* never started: start it now */ }
  fs.mkdirSync(path.dirname(mark), { recursive: true }); fs.writeFileSync(mark, String(now));
  const args = [metaCmd, 'code', 'links', '--project', p.file, '--state', state];
  let r = spawnFn ? spawnFn(process.execPath, args) : null;
  if (!r) { const c = spawn(process.execPath, args, { cwd: p.root, detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); r = { pid: c.pid }; }
  return `code links: started pid ${r?.pid ?? '?'}`;
}

// ---- the Code tab's parts ----
const areaOf = f => (f.includes('/') ? f.split('/')[0] : '.');
const rowOf = (x, sg) => { const g = x.growth, d = g.at(-1) - g[0];   // sg: the file's signals (none stored for this index: null)
  return { file: x.file, lines: x.lines, lang: x.lang, growth: g, delta: d, pct: g[0] ? Math.round(100 * d / g[0]) : null, churn_90d: x.churn_90d, rel_churn: x.rel_churn, commits_90d: x.commits_90d, fan_in: x.fan_in, importance: x.importance,
    fix_first: sg?.fix_first ?? null, fixes_365d: sg?.fixes?.n_365d ?? null }; };
const SORT = { importance: (a, b) => b.importance - a.importance || b.churn_90d - a.churn_90d, fix_first: (a, b) => (b.fix_first ?? -1) - (a.fix_first ?? -1) || b.importance - a.importance, lines: (a, b) => b.lines - a.lines, growth: (a, b) => b.delta - a.delta,
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
  if (part === 'map') return { map: mapAt(p.state) };
  let sig = part === 'files' || part === 'file' ? readSignals(p.state) : null;
  if (sig?.sha !== ix?.sha) sig = null;   // signals of another commit say nothing about this index
  const rows = ix ? ix.files.map(x => rowOf(x, sig?.files[x.file])) : null;
  if (part === 'files') {
    if (!rows) return { list: null };
    const sort = CODE_SORTS.includes(q('sort')) ? q('sort') : 'importance', folder = String(q('folder') ?? '').replace(/\/+$/, ''), lim = Number(q('limit'));
    const hit = sorted(rows.filter(r => !folder || r.file.startsWith(`${folder}/`)), sort), shown = hit.slice(0, Number.isInteger(lim) && lim > 0 ? lim : CODE_CAP);
    return { list: { sort, folder, folders: foldersOf(ix.files), limit: shown.length, matched: hit.length, shown: shown.length, rows: shown, fixes: sig ? sig.fixes : null } };
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
    const sg = x && sig?.files[x.file];
    return { file: x ? { ...rowOf(x, sg), born: x.born, bytes: x.bytes, last: x.last, days: ix.weeks, signals: sig ? sig.sha : null, partners: sg ? sg.partners : null, fixes: sg?.fixes ?? null,
      fixes_na: sig && sig.fixes.status !== 'measured' ? sig.fixes.reason : null } : null };
  }
  throw new Error(`unknown code part ${part}`);
}
