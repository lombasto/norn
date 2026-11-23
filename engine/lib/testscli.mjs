// `norn tests` - history | check | for | index | run. Code only, no model. Writes <state>/tests/ only: git-history.json (tests vs code per day
//   over git: `history`, which the tick starts once a day), advisories.json (`check`: the merge-time copy-paste advisory of the changed
//   test files) and cases.json + impact.json + times.json (`index`, testindex.mjs: the tick starts it when impact.json is not at HEAD).
//   `for` answers from impact.json. testsView + testsPart read them (and the machine's per-case log) for the dash's Tests tab.
// `run`: a run's node tests, through the machine's result cache (testcache.mjs) under policy.tests (testpolicy.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { readJsonS } from './fsnap.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { advisory, crossings } from './advisory.mjs';
import { subdirOf, inDir, projectHome } from './monorepo.mjs';
import { suiteKind, testsFor, IMPACT_FILE } from './testtimes.mjs';
import { repoIndex, runCached, cacheDir, cacheDirOf, cacheLog, caseLog, casesFile, prune } from './testcache.mjs';
import { buildIndex, writeIndex, median, CASES_FILE } from './testindex.mjs';
import { testsPolicy, pickInRepo, policyWords, BROWSER_SKIP_ENV } from './testpolicy.mjs';

export const TESTS_USAGE = 'usage: norn tests history [--points N] | check --base REF | for FILE... | index | run [FILE...] [--changed [--base REF]] [-- node flags]    '
  + '[--project P | --state D] [--repo DIR] [--json]   (check = the merge-time copy-paste advisory of the changed test files, exit 0; for = the test files that cover each FILE, from impact.json; '
  + 'index = cases.json, impact.json and times.json: every test case, what each test file reaches, the median time per file; '
  + 'run = node test files through the machine\'s result cache under policy.tests, --changed adds the files policy.tests.mode picks for the change; exit 1 = a red)';
const FLAGS = { history: ['points'], check: ['base'], for: [], index: [], run: ['changed!', 'base'] };
const POSITIONAL = new Set(['for', 'run']);   // for: the files to look up; run: the test files
const fwd = s => s.split('\\').join('/');
const TEST_GLOB = /^tests\/[^/]+\.test\.mjs$/;
// check reads tests/*.test.mjs: a pytest project (Solve Shack) is told so, rather than "no test file changed" on every merge
const NOT_NODE = (repo, kind) => `this project's suite is ${kind ? `a ${kind} suite` : 'neither a node:test suite (tests/*.test.mjs) nor a pytest suite (tests/test_*.py)'} (${repo}): the merge check reads node:test only - nothing checked`;

function parse(verb, argv) {
  const spec = [...FLAGS[verb], 'project', 'state', 'repo', 'json!'], f = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const s = spec.find(x => '--' + x.replace(/!$/, '') === argv[i]);
    if (!s && POSITIONAL.has(verb) && !argv[i].startsWith('--')) { f._.push(argv[i]); continue; }
    if (!s) throw new Error(`unexpected ${argv[i]}`);
    if (s.endsWith('!')) f[s.slice(0, -1)] = true;
    else { if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`); f[s] = argv[++i]; }
  }
  return f;
}
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const readJson = readJsonS;   // META-DASH-ASYNC R1: snapshot-aware (lib/fsnap.mjs)
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); };
// --relative: from a monorepo project's folder the names are relative to it (as tests/x.test.mjs), never the repo's top
const changedTests = (repo, base) => git(repo, ['diff', '--name-only', '--relative', '--diff-filter=AMD', base, '--', 'tests']).split('\n').map(fwd).filter(f => TEST_GLOB.test(f));

// ---------- history: tests vs code over git (the Tests tab's charts) ----------
const CODE_EXT = /\.(mjs|cjs|js|jsx|ts|tsx|py|rs|go|cs|java|kt|c|cc|cpp|h|hpp|swift|rb)$/i;
const SKIP = /(^|\/)(node_modules|vendor|third_party|dist|build|target|\.venv)\//i;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(py|go|rs)$/i;
/** 'test' | 'code' | null (not source) */
export function classify(p) {
  const f = fwd(p);
  if (!CODE_EXT.test(f) || SKIP.test(f)) return null;
  return TEST_PATH.test(f) ? 'test' : 'code';
}
// one test case per match: node:test / mocha / jest test( it(, pytest def test_, Rust #[test], Go func TestX(
const TEST_CASE = String.raw`^\s*((test|it)(\.(only|skip|todo))?\s*\(|(async\s+)?def\s+test_|#\[(\w+::)?test\]|func\s+Test\w*\()`;
const grepCounts = (repo, sha, pattern) => {
  let out = '';
  try { out = git(repo, ['grep', '-I', '-c', '-E', pattern, sha]); } catch (e) { if (e.status !== 1) throw e; }   // 1 = no match
  return out.split('\n').filter(Boolean).map(l => { const m = l.slice(sha.length + 1).match(/^(.*):(\d+)$/); return m ? [m[1], Number(m[2])] : null; }).filter(Boolean);
};
/** the numbers of one commit: { tests (cases), test_lines, code_lines, test_files } */
function countAt(repo, sha) {
  const r = { tests: 0, test_lines: 0, code_lines: 0, test_files: 0 };
  for (const [p, n] of grepCounts(repo, sha, '')) { const k = classify(p); if (k === 'test') { r.test_lines += n; r.test_files++; } else if (k === 'code') r.code_lines += n; }
  for (const [p, n] of grepCounts(repo, sha, TEST_CASE)) if (classify(p) === 'test') r.tests += n;
  return r;
}
/** tests vs code over the first-parent history of ref: one point per day, the last `points` days that have commits -> [{ day, sha, ... }] */
export function gitHistory(repo, { ref = 'HEAD', points = 24 } = {}) {
  const days = new Map();
  for (const l of git(repo, ['log', '--first-parent', '--format=%H %cI', ref]).split('\n').filter(Boolean)) {
    const [sha, iso] = l.split(' '), day = iso.slice(0, 10);
    if (!days.has(day)) days.set(day, sha);   // newest first: the day's last commit
  }
  const all = [...days.entries()].reverse(), step = Math.max(1, Math.ceil(all.length / points));
  const pick = all.filter((_, i) => (all.length - 1 - i) % step === 0).slice(-points);
  return pick.map(([day, sha]) => ({ day, sha: sha.slice(0, 12), ...countAt(repo, sha) }));
}

// ---------- check: copy-paste (jscpd-style, built-ins only), token windows that also occur elsewhere ----------
const TOKEN = /[A-Za-z_$][\w$]*|\d+(\.\d+)?|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|\S/g;
/** tokens of JS source without comments; literals stay as written (jscpd's default "strict" mode compares them) */
const tokens = src => String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1').match(TOKEN) ?? [];
/**
 * the share of `src`'s tokens inside a window of `min` tokens (jscpd's default min-tokens 50) that occurs twice - in src itself
 * or in one of `others` (texts). -> { pct, tokens, dup_tokens, clones: [{ line, with }] (the first line of each cloned run) }
 */
export function copyPaste(src, others = [], { min = 50 } = {}) {
  const t = tokens(src), seen = new Map();
  const key = (a, i) => a.slice(i, i + min).join('\u0001');
  others.forEach((o, k) => { const a = tokens(o.text); for (let i = 0; i + min <= a.length; i++) if (!seen.has(key(a, i))) seen.set(key(a, i), o.name ?? `other ${k}`); });
  const own = new Map(), dup = new Uint8Array(t.length), hits = [];
  for (let i = 0; i + min <= t.length; i++) {
    const k = key(t, i), w = seen.get(k) ?? (own.has(k) && i - own.get(k) >= min ? 'itself' : null);
    if (!own.has(k)) own.set(k, i);
    if (w) { if (!dup[i]) hits.push({ i, with: w }); for (let j = i; j < i + min; j++) dup[j] = 1; }
  }
  const n = dup.reduce((a, b) => a + b, 0);
  // token index -> line: count newlines before each hit's first token
  const pos = [], re = new RegExp(TOKEN.source, 'g'), body = String(src).replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
  let m; while ((m = re.exec(body))) pos.push(m.index);
  const lineOf = i => body.slice(0, pos[i] ?? 0).split('\n').length;
  const clones = hits.filter((h, k) => k === 0 || h.i > hits[k - 1].i + 1).map(h => ({ line: lineOf(h.i), with: h.with }));
  return { pct: t.length ? Math.round(1000 * n / t.length) / 10 : 0, tokens: t.length, dup_tokens: n, clones };
}
const COPY_PCT = 25;
/** texts: { file: source } of the changed test files, corpus: [{ name, text }] of the others -> a tests-copy-paste advisory per file over COPY_PCT */
const mergeCheck = (texts, corpus) => Object.entries(texts).flatMap(([file, text]) => {
  const c = copyPaste(text, corpus.filter(o => o.name !== file));
  return c.pct > COPY_PCT ? [advisory({ phase: 'TESTS', check: 'copy-paste', key: 'tests-copy-paste', severity: 'low', surface: 'test file', path: file,
    why: `${c.pct}% of its tokens are in a 50-token run that is repeated (limit ${COPY_PCT}%)`, source: 'owner DIR-19 + DIR-47 (lean tests); jscpd min-tokens 50',
    items: c.clones.slice(0, 10).map(x => ({ line: x.line, text: `same as ${x.with}` })), fix: { tier: 'card', action: 'fold the copies into one helper or a table of cases', kind: 'drafts' } })] : [];
});

/** o: { env, out, err, where(flags) -> { project, state } } */
export function testsCmd(argv, { out = console.log, err = console.error, where, env = process.env } = {}) {
  const verb = argv[0], dd = verb === 'run' ? argv.indexOf('--') : -1, rest = dd >= 0 ? argv.slice(dd + 1) : [];   // run: `--` passes node flags on
  let f;
  try { if (!FLAGS[verb]) throw new Error(verb ? `unknown verb ${verb}` : 'missing verb'); f = parse(verb, (dd >= 0 ? argv.slice(0, dd) : argv).slice(1)); }
  catch (e) { err('error: ' + e.message); err(TESTS_USAGE); return 2; }
  let w;
  try { w = where(f); } catch (e) { err('error: ' + e.message); return 2; }
  const dir = path.join(w.state, 'tests');
  // gap #7: a monorepo project (project.subdir; not with an explicit --repo) reads its own folder: its tests/, its history
  // `run` tests the checkout it is called in (a worker's worktree, not the project's main checkout); the other verbs the project's
  const top = fwd(git(f.repo || (verb === 'run' ? process.cwd() : w.project?.root) || process.cwd(), ['rev-parse', '--show-toplevel']));
  const repo = !f.repo && subdirOf(w.project) ? fwd(inDir(top, subdirOf(w.project))) : top;
  const sha = () => git(repo, ['rev-parse', '--short=12', 'HEAD']);
  const print = (v, text) => (f.json ? out(JSON.stringify(v, null, 1)) : text.forEach(l => out(l)));

  const kind = suiteKind(repo);
  if (verb === 'run') return kind === 'node:test' ? testsRun(f, { repo, state: w.state, project: w.project, rest, out, err, env, print })
    : (err(`error: tests run: runs node:test files (tests/*.test.mjs); this project's suite is ${kind ?? 'neither node:test nor pytest'} - run its test files with their own runner, one at a time`), 2);
  if (verb === 'for') {
    if (!f._.length) { err('error: tests for needs one or more files (paths relative to the project folder)'); return 2; }
    const im = readJson(path.join(dir, IMPACT_FILE));
    if (!im) { err(`error: no impact map (${fwd(path.join(dir, IMPACT_FILE))} does not exist)`); return 2; }
    const a = testsFor(im, f._);
    print({ ...a, at: im.at, sha: im.sha }, [...a.rows.map(r => `${r.file}: ${r.tests.length ? r.tests.join(' ') : r.known ? 'no test covers it' : 'not in the impact map\'s coverage'}`),
      `${a.tests.length} test file(s) to run (the impact map at ${im.sha ?? '?'}, ${im.at})`]);
    return 0;
  }
  if (verb === 'index') {
    if (kind !== 'node:test') { err(`error: tests index: indexes node:test suites (tests/*.test.mjs); this project's suite is ${kind ?? 'neither node:test nor pytest'} (${repo})`); return 2; }
    const tests = fs.readdirSync(path.join(repo, 'tests')).filter(x => x.endsWith('.test.mjs')).map(x => `tests/${x}`), code = git(repo, ['ls-files']).split('\n').map(fwd).filter(x => classify(x) === 'code');
    const idx = buildIndex({ ix: repoIndex(repo), tests, code, log: cacheLog(cacheDirOf(w.state)), sha: sha() });
    writeIndex(dir, idx);
    print({ cases: idx.cases.cases.length, files: tests.length, covered: Object.keys(idx.impact.sources).length, uncovered: idx.impact.uncovered.length, timed: idx.times.files.length, sha: idx.cases.sha },
      [`tests index: ${idx.cases.cases.length} test cases in ${tests.length} files; ${Object.keys(idx.impact.sources).length} source files covered, ${idx.impact.uncovered.length} not; ${idx.times.files.length} files timed (at ${idx.cases.sha})`]);
    return 0;
  }
  if (verb === 'history') {
    const h = gitHistory(repo, { points: Number(f.points) || 24 });
    writeJson(path.join(dir, 'git-history.json'), { at: new Date().toISOString(), repo, points: h });
    const l = h.at(-1);
    print(h, [`${h.length} day(s) of history; ${l ? `${l.day}: ${l.tests} test cases, ${l.test_lines} test lines vs ${l.code_lines} code lines (${(l.test_lines / (l.code_lines || 1)).toFixed(2)}:1)` : 'no commits'}`]);
    return 0;
  }
  // check: the test files the branch changed vs --base, each against the rest of tests/ - advisory, a merge goes on whatever it finds
  if (kind !== 'node:test') { print({ list: [], suite: kind ?? false }, [`tests check: ${NOT_NODE(repo, kind)}`]); return 0; }
  if (!f.base) { err('error: check needs --base REF'); return 2; }
  const changed = changedTests(repo, f.base);
  if (!changed.length) { print({ list: [] }, ['tests check: no test file changed']); return 0; }
  const texts = Object.fromEntries(changed.filter(x => fs.existsSync(path.join(repo, x))).map(x => [x, fs.readFileSync(path.join(repo, x), 'utf8')]));
  const corpus = fs.readdirSync(path.join(repo, 'tests')).filter(x => x.endsWith('.test.mjs')).map(x => `tests/${x}`).filter(x => !texts[x])
    .map(x => ({ name: x, text: fs.readFileSync(path.join(repo, x), 'utf8') }));
  const list = crossings(w.state, mergeCheck(texts, corpus));
  writeJson(path.join(dir, 'advisories.json'), { at: new Date().toISOString(), base: f.base, head: sha(), files: changed, list });
  print(list, [`tests check: ${changed.length} changed test file(s), ${list.length} advisory finding(s) - advisory, never a merge block`,
    ...list.map(a => `  ${a.new ? 'NEW ' : ''}${a.key} ${a.path ?? ''}: ${a.why}`)]);
  return 0;
}

// test-diet S1: `norn tests run [FILE...] [--changed [--base REF]] [-- node flags]`. Each file runs through the machine's result cache (a pass
// on the same content in the last day is reused, a copy running in another run is waited for); --changed adds the files policy.tests.mode
// picks for the branch's change against the merge base (committed, uncommitted and untracked). Inside a run (META_RUN_ID) browser tests
// skip while policy.tests.browser = ci. One line per file, a red's output tail (failures only); exit 1 = a red, 2 = nothing runnable.
const sec = ms => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
/** the branch's changed files against the merge base with base (committed, uncommitted, untracked), repo-relative */
export const changedFiles = (repo, base) => { const mb = git(repo, ['merge-base', base, 'HEAD']);
  return [...new Set([...git(repo, ['diff', '--name-only', '--relative', mb]).split('\n'), ...git(repo, ['ls-files', '--others', '--exclude-standard']).split('\n')].map(fwd).filter(Boolean))]; };
async function testsRun(f, { repo, state, project, rest, out, err, env, print }) {
  const t = testsPolicy(project?.policy), run = env.META_RUN_ID || null;
  if (run && t.mode === 'off') { err('error: tests run: policy.tests.mode = off - tests do not run in a run of this project; CI runs them on the PR'); return 2; }
  let files = f._.map(fwd), picked = null;
  if (f.changed) {
    const base = f.base || 'origin/main';
    let changed;
    try { changed = changedFiles(repo, base); } catch (e) { err(`error: tests run --changed: no diff against ${base} (${String(e.stderr || e.message).trim().split('\n')[0]})`); return 2; }
    picked = pickInRepo(repo, state, t.mode, changed);
    if (!f.json) out(`tests run: ${changed.length} file(s) changed since ${base}: ${picked.run.length} test file(s) by policy.tests.mode = ${t.mode}${picked.none.length ? `; no test covers ${picked.none.join(' ')} directly (left to CI)` : ''}${picked.left.length ? `; ${picked.left.length} more importers left to CI` : ''}`);
    files = [...new Set([...files, ...picked.run])];
  }
  if (!files.length) { print({ files: [], picked }, ['tests run: no test file to run']); return 0; }
  const gone = files.filter(x => !fs.existsSync(path.join(repo, x)));
  if (gone.length) { err(`error: tests run: no such test file in ${repo}: ${gone.join(' ')}`); return 2; }
  const skip = !!run && t.browser === 'ci', cdir = cacheDir(env), ix = repoIndex(repo), rows = [];
  prune(cdir);
  for (const x of files) {
    const r = await runCached(x, { ix, dir: cdir, run, env, childEnv: skip ? BROWSER_SKIP_ENV : {}, extra: skip ? 'browser:skip' : '', nodeArgs: rest, say: l => !f.json && out(`tests run: ${l}`) });
    rows.push(r);
    if (f.json) continue;
    const c = r.counts ? `${r.counts.pass} pass ${r.counts.fail} fail` : '';
    out(r.how === 'ran' ? `${r.ok ? 'pass' : 'FAIL'} ${x} ${sec(r.ms)}${c ? ` (${c})` : ''}${r.timed_out ? ' - timed out' : ''}`
      : `pass ${x} - ${r.how === 'waited' ? 'waited for' : 'reused'} the pass of ${r.by ?? 'a hand run'} at ${r.at.slice(11, 16)}Z on the same content (${sec(r.saved_ms)} saved)`);
    if (!r.ok && r.tail) out(r.tail.trimEnd());
  }
  const bad = rows.filter(r => !r.ok), n = h => rows.filter(r => r.how === h).length, saved = rows.reduce((a, r) => a + r.saved_ms, 0);
  print({ policy: t, picked, files: rows.map(({ tail: _t, ...r }) => r) }, [`tests run: ${rows.length} file(s): ${n('ran')} ran, ${n('reused') + n('waited')} reused (${sec(saved)} saved), ${bad.length} red${skip ? ' - browser tests skipped (CI runs them)' : ''} · ${policyWords(t)}`]);
  return bad.length ? 1 : 0;
}

/** the tick's hook, each verb detached so the Tests tab fills without anyone running it: `norn tests history` (git only, cheap) once a day
 * (not while one started in the last 30 min); `norn tests index` (node:test suites) when impact.json is not at the repo's HEAD (not while one
 * started in the last 10 min; the mark is the start time: the stamp tells a fresh map). -> the tick-log words | null */
export function tickTests(p, state, { metaCmd, spawnFn, now = Date.now() } = {}) {
  if (!p?.file) return null;
  const start = (verb, gapMs) => {
    const mark = path.join(state, 'tests', `${verb}.started`);
    try { if (now - Number(fs.readFileSync(mark, 'utf8')) < gapMs) return null; } catch { /* never started: start it now */ }
    fs.mkdirSync(path.dirname(mark), { recursive: true }); fs.writeFileSync(mark, String(now));
    const args = [metaCmd, 'tests', verb, '--project', p.file, '--state', state];
    let r = spawnFn ? spawnFn(process.execPath, args) : null;
    if (!r) { const c = spawn(process.execPath, args, { cwd: p.root, detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); r = { pid: c.pid }; }
    return `tests ${verb}: started pid ${r?.pid ?? '?'}`;
  };
  const at = readJson(path.join(state, 'tests', 'git-history.json'))?.at, day = d => new Date(d).toISOString().slice(0, 10), said = [];
  if (!at || day(at) !== day(now)) said.push(start('history', 30 * 60e3));
  const home = p.root ? projectHome(p) : null, have = readJson(path.join(state, 'tests', IMPACT_FILE))?.sha;
  const head = () => { try { return git(home, ['rev-parse', '--short=12', 'HEAD']); } catch { return null; /* no git repo: no map to index */ } };
  if (home && suiteKind(home) === 'node:test') { const h = head(); if (h && h !== have) said.push(start('index', 10 * 60e3)); }
  return said.filter(Boolean).join('; ') || null;
}

// ---------- the Tests tab: a summary + four sub-views, each its own part (dash/testparts.mjs TESTS_SUBS) ----------
// A source that does not exist yet says so, never a number. An alert the machinery raises is an open Inbox question with data.area
// 'tests' (the server lists them: the tab links, never copies).
const read = (state, f) => readJson(path.join(state, 'tests', f));
/** the files the summary + a part read, for the dash to prime on fs.promises (off the sync path) */
export const testsFiles = (state, sub = null) => [...['git-history.json', 'advisories.json', ...(['suite', 'case'].includes(sub) ? [CASES_FILE] : []), ...(['impact', 'case'].includes(sub) ? [IMPACT_FILE] : [])].map(f => path.join(state, 'tests', f)),
  ...(['suite', 'case', 'runtime'].includes(sub) ? [casesFile(cacheDirOf(state))] : [])];
/** which suite the project folder holds ('node:test' | 'pytest' | false = neither; null = no project folder), off the sync path */
export const suiteOf = project => (project?.root ? fs.promises.access(path.join(projectHome(project), 'tests')).then(() => suiteKind(projectHome(project)) ?? false, () => false) : Promise.resolve(null));
/** the Tests tab's summary: small files only; a missing file = null (not there yet). suite = suiteOf's answer.
 *  guardview reads advisories from it (the merge check's findings are Slop rows) */
export function testsView(state, suite = null) {
  return { suite, git: read(state, 'git-history.json'), advisories: read(state, 'advisories.json'), commands: { history: 'norn tests history', for: 'norn tests for' } };
}
// SPEC dash-owner-1123 s.1: per-case times come from the machine's case log (testcache cases.jsonl), this project's rows only (a run's
// state folder is the project's; a hand run has none) and only the ids its cases.json knows
export const CASE_DAYS = 7, SUITE_SORTS = ['slowest', 'longest', 'file', 'newest'];
const caseRows = (state, ids, since = 0) => { const me = path.basename(path.resolve(state)); return caseLog(cacheDirOf(state), { since }).filter(r => (!r.state || r.state === me) && ids.has(r.id)); };
const byId = rows => { const m = new Map(); for (const r of rows) m.set(r.id, [...(m.get(r.id) ?? []), r]); return m; };
/** a test file's static reach (impact.json sources) and the sources it alone covers */
const guardOf = (im, file) => { const xs = Object.entries(im?.sources ?? {}).filter(([, ts]) => ts.includes(file)); return { reaches: xs.map(([s]) => s), sole: xs.filter(([, ts]) => ts.length === 1).map(([s]) => s) }; };
const areaOf = f => { const d = f.split('/').slice(0, -1); return d.slice(0, 2).join('/') || '.'; };
const SORT = { slowest: (a, b) => (b.median ?? -1) - (a.median ?? -1), longest: (a, b) => b.lines - a.lines, file: (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
  newest: (a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')) };
/**
 * one sub-view's part of the Tests tab -> its data. o: { picked: { files, lane, lanes } (impact: the server resolves a lane's changed
 * files), merges: the merge queue's batches (costs: per merge gate time + what it ran), limit / sort / q (suite: the cap, SUITE_SORTS, a
 * name or file filter), case (the case part's id), alerts (case: the open test alerts; one whose title starts with the id is its own) }.
 * Suite = the case list (the summary's git charts at its head); case = one case's detail; runtime = per-case medians for the outlier chart
 * (the per-run list is the server's runtimePart: run records + transcripts)
 */
export function testsPart(state, name, { picked = null, merges = [], limit = 40, sort = 'slowest', q = '', case: id = null, alerts = [], now = Date.now() } = {}) {
  if (name === 'costs') return { merges };
  if (name === 'suite') {
    const cs = read(state, CASES_FILE);
    if (!cs) return { list: null };
    const st = byId(caseRows(state, new Set(cs.cases.map(c => c.id)))), s = SORT[sort] ? sort : 'slowest', needle = String(q ?? '').trim().toLowerCase();
    const all = cs.cases.map(c => { const rs = st.get(c.id) ?? []; return { ...c, last: rs.at(-1)?.ms ?? null, at: rs.at(-1)?.at ?? null, median: median(rs.map(r => r.ms)), runs: rs.length }; });
    const hit = all.filter(c => !needle || c.name.toLowerCase().includes(needle) || c.file.toLowerCase().includes(needle)).sort((a, b) => SORT[s](a, b) || a.file.localeCompare(b.file) || a.line - b.line);
    const rows = hit.slice(0, Math.max(1, Number(limit) || 40));
    return { list: { at: cs.at, sha: cs.sha, total: all.length, files: Object.keys(cs.files ?? {}).length, sort: s, q: needle, limit: rows.length, matched: hit.length, shown: rows.length, rows } };
  }
  if (name === 'case') {
    const c = read(state, CASES_FILE)?.cases.find(x => x.id === id);
    if (!c) return { case: null };
    const rs = caseRows(state, new Set([c.id])).reverse(), ms = rs.map(r => r.ms).filter(Number.isFinite);
    return { case: { ...c, runs: rs.slice(0, 20).map(({ at, run, state: s, ms: m, ok }) => ({ at, run, state: s, ms: m, ok })), median: median(ms), max: ms.length ? Math.max(...ms) : null, fails: rs.filter(r => !r.ok).length,
      ...guardOf(read(state, IMPACT_FILE), c.file), alerts: alerts.filter(a => String(a.title ?? '').startsWith(c.id)) } };
  }
  if (name === 'runtime') {
    const cs = read(state, CASES_FILE), label = new Map((cs?.cases ?? []).map(c => [c.id, c.name]));
    const st = byId(caseRows(state, new Set(label.keys()), now - CASE_DAYS * 86400e3));
    return { medians: [...st].map(([cid, rs]) => { const ms = rs.map(r => r.ms).filter(Number.isFinite); return { id: cid, label: label.get(cid), file: rs[0].file, value: median(ms), max: ms.length ? Math.max(...ms) : null, runs: rs.length }; })
      .filter(c => Number.isFinite(c.value)).sort((a, b) => b.value - a.value || a.id.localeCompare(b.id)), case_days: CASE_DAYS };
  }
  if (name === 'impact') {
    const im = read(state, IMPACT_FILE), tests = [...new Set(Object.values(im?.sources ?? {}).flat())];
    const files = tests.map(t => { const g = guardOf(im, t), areas = new Map(); for (const s of g.reaches) areas.set(areaOf(s), (areas.get(areaOf(s)) ?? 0) + 1);
      return { file: t, reaches: g.reaches.length, sole: g.sole, areas: [...areas].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])) }; })
      .sort((a, b) => b.reaches - a.reaches || b.sole.length - a.sole.length || a.file.localeCompare(b.file));
    return { impact: im ? { at: im.at, sha: im.sha, suite: im.suite, sources: Object.keys(im.sources).sort() } : null, lanes: picked?.lanes ?? [], files, uncovered: im?.uncovered ?? [],
      picked: picked && (picked.files?.length || picked.lane) ? { lane: picked.lane ?? null, error: picked.error ?? null, files: picked.files ?? [], ...(im ? testsFor(im, picked.files ?? []) : { rows: [], tests: [] }) } : null };
  }
  throw new Error(`unknown tests part ${name}`);
}
/**
 * test-diet S1: the Tests tab's Run time part - per worker run of the last RUNTIME_DAYS: its wall time, its time in test commands and
 * the share (speed.mjs speedOf over its transcript), the duplicate test files the machine's test cache spared it (testcache.mjs log rows
 * how reused | waited: count, saved_ms) and whether it went past policy.tests.run_budget_min. runs: [{ id, lane, state, started, ended,
 * speed: { wall_ms, test_ms } | null }] (the server reads them); cache: the cache log rows; policy: the project policy.
 */
export const RUNTIME_DAYS = 3, RUNTIME_SETTINGS = ['policy.tests.mode', 'policy.tests.run_budget_min', 'policy.tests.browser', 'policy.tests.full_suite'];
export function runtimePart({ runs, cache, policy, now = Date.now() }) {
  const t = testsPolicy(policy), since = now - RUNTIME_DAYS * 86400e3, budget = t.run_budget_min > 0 ? t.run_budget_min * 60000 : null, by = new Map();
  for (const c of cache) if (c.run && (c.how === 'reused' || c.how === 'waited')) { const x = by.get(c.run) ?? { n: 0, saved_ms: 0 }; x.n++; x.saved_ms += c.saved_ms || 0; by.set(c.run, x); }
  const rows = runs.filter(r => Date.parse(r.ended ?? r.started) >= since).map(r => { const s = r.speed, d = by.get(r.id) ?? { n: 0, saved_ms: 0 };
    return { id: r.id, lane: r.lane ?? null, state: r.state, started: r.started, ended: r.ended ?? null, wall_ms: s?.wall_ms ?? null, test_ms: s?.test_ms ?? null,
      test_pct: s?.wall_ms > 0 ? Math.round(1000 * s.test_ms / s.wall_ms) / 10 : null, over: budget !== null && (s?.test_ms ?? 0) > budget, dup: d.n, saved_ms: d.saved_ms }; })
    .sort((a, b) => String(b.started).localeCompare(String(a.started)));
  return { policy: t, words: policyWords(t), settings: RUNTIME_SETTINGS, days: RUNTIME_DAYS, rows };
}
