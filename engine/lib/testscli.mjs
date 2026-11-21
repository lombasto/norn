// META-TEND TESTS: `norn tests` - measure | history | check | mutation | lean | gate | for | run. Code only, no model. Writes <state>/tests/ only:
//   measure.json (the last full measure), history.jsonl (one summary row per measure), mutation.json (the merged trial matrices),
//   candidates.json (the last lean analysis), advisories.json (the last merge check), waves.jsonl (one row per gated wave),
//   git-history.json (tests vs code per day), times.json + impact.json (TESTS-RUNTIME: the per-test timing table and source -> tests,
//   lib/testtimes.mjs). measure reads a node:test suite (ci-suite) or a pytest suite (--junitxml); check / mutation / lean / gate read
//   node:test only. testsView + testsPart read them for the dash's Tests tab (small files only, never measure.json).
// test-diet S1: `run` - a run's node tests, through the machine's result cache (testcache.mjs) under policy.tests (testpolicy.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonS, readText } from './fsnap.mjs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitHistory, summarize, mergeCheck, leanGate, leafNames, mutationMatrix, addTrial, neverFailing, duplicates, slowest } from './testlean.mjs';
import { crossings } from './advisory.mjs';
import { subdirOf, inDir, projectHome } from './monorepo.mjs';
import { suiteKind, runPytest, timesTable, impactMap, testsFor, breakdown, slowestTests, TIMES_FILE, IMPACT_FILE } from './testtimes.mjs';
import { repoIndex, runCached, cacheDir, prune } from './testcache.mjs';
import { testsPolicy, pickInRepo, policyWords, BROWSER_SKIP_ENV } from './testpolicy.mjs';

export const TESTS_USAGE = 'usage: norn tests measure [--no-coverage] | history [--points N] | check --base REF | mutation --report R --kills K --tests a,b [--label L] [--wall S] | lean | gate --base REF [--restore] | for FILE... | run [FILE...] [--changed [--base REF]] [-- node flags]    '
  + '[--project P | --state D] [--repo DIR] [--json]   (check = the merge-time advisories, exit 0; gate exit 1 = the wave lost coverage or a mutant\'s last killer; for = the test files that cover each FILE, from the last measure\'s coverage; '
  + 'run = node test files through the machine\'s result cache under policy.tests, --changed adds the files policy.tests.mode picks for the change; exit 1 = a red)';
const FLAGS = { measure: ['no-coverage!'], history: ['points'], check: ['base'], mutation: ['report', 'kills', 'tests', 'label', 'wall'], lean: [], gate: ['base', 'restore!'], for: [], run: ['changed!', 'base'] };
const POSITIONAL = new Set(['for', 'run']);   // for: the files to look up; run: the test files
const CI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ci-suite.mjs');
const fwd = s => s.split('\\').join('/');
const TEST_GLOB = /^tests\/[^/]+\.test\.mjs$/;
// measure reads both suites; check / mutation / lean / gate read node:test only: a pytest project (Solve Shack) gets the measure, the git
// history and the impact answer, and the rest says so, rather than a check that always answers "no test file changed"
const NODE_ONLY = new Set(['check', 'mutation', 'lean', 'gate']);
const NOT_NODE = (repo, kind) => `this project's suite is ${kind ? `a ${kind} suite` : 'neither a node:test suite (tests/*.test.mjs) nor a pytest suite (tests/test_*.py)'} (${repo}): the merge check, mutation trials and lean tests read node:test only - nothing checked`;

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
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const readJson = readJsonS;   // META-DASH-ASYNC R1: snapshot-aware (lib/fsnap.mjs)
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); };
const appendLine = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(v) + '\n'); };

/** run ci-suite --measure on `files` (all of tests/*.test.mjs when empty) in repo -> { measure, status, wall_ms } */
function runMeasure(repo, files, { coverage = true, log } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'norn-measure-')), out = path.join(tmp, 'm.json'), t0 = Date.now();
  const known = fs.existsSync(path.join(repo, 'tests', 'KNOWN-REDS.txt')) ? path.join(repo, 'tests', 'KNOWN-REDS.txt') : (fs.writeFileSync(path.join(tmp, 'k.txt'), ''), path.join(tmp, 'k.txt'));
  const r = spawnSync(process.execPath, [CI, '--known', known, '--measure', out, ...(coverage ? ['--coverage'] : []), ...files], { cwd: repo, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (log) { fs.mkdirSync(path.dirname(log), { recursive: true }); fs.writeFileSync(log, (r.stdout || '') + (r.stderr || '')); }
  const measure = readJson(out);
  fs.rmSync(tmp, { recursive: true, force: true });
  return { measure, status: r.status, wall_ms: Date.now() - t0 };
}
/** TESTS-RUNTIME: the timing table + the impact map of a measure, beside it (the Tests tab reads these, never measure.json) */
function writeTimes(dir, repo, measure, o) {
  const readFile = f => { try { return fs.readFileSync(path.join(repo, f), 'utf8'); } catch { return null; } };
  writeJson(path.join(dir, TIMES_FILE), timesTable(measure, { readFile, ...o }));
  const im = impactMap(measure, { sha: o.sha });
  if (im) writeJson(path.join(dir, IMPACT_FILE), im);
}
// --relative: from a monorepo project's folder the names are relative to it (as tests/x.test.mjs), never the repo's top
const changedTests = (repo, base, filter = 'AMD') => git(repo, ['diff', '--name-only', '--relative', `--diff-filter=${filter}`, base, '--', 'tests']).split('\n').map(fwd).filter(f => TEST_GLOB.test(f));

/** o: { env, out, err, where(flags) -> { project, state } } */
export function testsCmd(argv, { out = console.log, err = console.error, where, env = process.env } = {}) {
  const verb = argv[0], dd = verb === 'run' ? argv.indexOf('--') : -1, rest = dd >= 0 ? argv.slice(dd + 1) : [];   // run: `--` passes node flags on
  let f;
  try { if (!FLAGS[verb]) throw new Error(verb ? `unknown verb ${verb}` : 'missing verb'); f = parse(verb, (dd >= 0 ? argv.slice(0, dd) : argv).slice(1)); }
  catch (e) { err('error: ' + e.message); err(TESTS_USAGE); return 2; }
  let w;
  try { w = where(f); } catch (e) { err('error: ' + e.message); return 2; }
  const dir = path.join(w.state, 'tests');
  // gap #7: a monorepo project (project.subdir; not with an explicit --repo) measures its own folder: its tests/, its history
  // `run` tests the checkout it is called in (a worker's worktree, not the project's main checkout); the other verbs the project's
  const top = fwd(git(f.repo || (verb === 'run' ? process.cwd() : w.project?.root) || process.cwd(), ['rev-parse', '--show-toplevel']));
  const repo = !f.repo && subdirOf(w.project) ? fwd(inDir(top, subdirOf(w.project))) : top;
  const sha = () => git(repo, ['rev-parse', '--short=12', 'HEAD']);
  const print = (v, text) => (f.json ? out(JSON.stringify(v, null, 1)) : text.forEach(l => out(l)));

  const kind = suiteKind(repo);
  if (verb === 'run') return kind === 'node:test' ? testsRun(f, { repo, state: w.state, project: w.project, rest, out, err, env, print })
    : (err(`error: tests run: runs node:test files (tests/*.test.mjs); this project's suite is ${kind ?? 'neither node:test nor pytest'} - run its test files with their own runner, one at a time`), 2);
  if (NODE_ONLY.has(verb) && kind !== 'node:test') {
    if (verb === 'check') { print({ list: [], suite: kind ?? false }, [`tests check: ${NOT_NODE(repo, kind)}`]); return 0; }   // advisory: a merge goes on
    err(`error: tests ${verb}: ${NOT_NODE(repo, kind)}`); return 2;
  }
  if (verb === 'measure') {
    if (!kind) { err(`error: tests measure: ${repo} holds neither a node:test suite (tests/*.test.mjs) nor a pytest suite (tests/test_*.py)`); return 2; }
    const log = path.join(dir, 'measure.log'), cov = !f['no-coverage'];
    const r = kind === 'pytest' ? runPytest(repo, w.project?.merge?.gate?.cmd, { coverage: cov, log }) : runMeasure(repo, [], { coverage: cov, log });
    if (r.error) { err(`error: tests measure: ${r.error}`); return 2; }
    if (!r.measure) { err(`error: the suite wrote no measure (exit ${r.status}; log ${fwd(log)})`); return 1; }
    const row = { ...summarize(r.measure, { sha: sha() }), suite: kind, run: process.env.META_RUN_ID || null };
    writeJson(path.join(dir, 'measure.json'), { ...r.measure, sha: row.sha });
    appendLine(path.join(dir, 'history.jsonl'), row);
    writeTimes(dir, repo, r.measure, { sha: row.sha, run: row.run, via: 'measure', exit: r.status, wall_ms: r.wall_ms ?? null });
    print(row, [`measured ${row.tests} ${kind} tests in ${row.files} files: suite ${Math.round(row.suite_ms / 1000)} s${row.coverage ? `, line coverage ${row.coverage.pct}% (${row.coverage.covered}/${row.coverage.total})` : r.coverage ? ` (coverage: ${r.coverage})` : ''} (suite exit ${r.status})`]);
    return 0;
  }
  if (verb === 'for') {
    if (!f._.length) { err('error: tests for needs one or more files (paths relative to the project folder)'); return 2; }
    const im = readJson(path.join(dir, IMPACT_FILE));
    if (!im) { err('error: no impact map yet: norn tests measure (with coverage) writes it'); return 2; }
    const a = testsFor(im, f._);
    print({ ...a, at: im.at, sha: im.sha }, [...a.rows.map(r => `${r.file}: ${r.tests.length ? r.tests.join(' ') : r.known ? 'no test covers it' : 'not in the last measure\'s coverage'}`),
      `${a.tests.length} test file(s) to run (coverage of the measure at ${im.sha ?? '?'}, ${im.at})`]);
    return 0;
  }
  if (verb === 'history') {
    const h = gitHistory(repo, { points: Number(f.points) || 24 });
    writeJson(path.join(dir, 'git-history.json'), { at: new Date().toISOString(), repo, points: h });
    const l = h.at(-1);
    print(h, [`${h.length} day(s) of history; ${l ? `${l.day}: ${l.tests} test cases, ${l.test_lines} test lines vs ${l.code_lines} code lines (${(l.test_lines / (l.code_lines || 1)).toFixed(2)}:1)` : 'no commits'}`]);
    return 0;
  }
  if (verb === 'mutation') {
    if (!f.report || !f.kills || !f.tests) { err('error: mutation needs --report, --kills and --tests'); return 2; }
    const measure = readJson(path.join(dir, 'measure.json'));
    if (!measure) { err('error: no measure yet (norn tests measure): the trial names its tests from it'); return 2; }
    const files = f.tests.split(',').map(s => fwd(s.trim())).filter(Boolean);
    const kills = fs.readFileSync(f.kills, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const m = mutationMatrix(readJson(f.report), kills, leafNames(measure, files));
    const label = f.label || path.basename(m.files[0]?.file ?? 'trial', '.mjs');
    const stored = addTrial(readJson(path.join(dir, 'mutation.json')), label, m, { tests: files, wall_s: f.wall ? Number(f.wall) : null, at: new Date().toISOString() });
    writeJson(path.join(dir, 'mutation.json'), stored);
    print(m.files, m.files.map(x => `${x.file}: ${x.mutants} mutants, score ${x.score}% (${x.killed} killed, ${x.survived} survived, ${x.timeout} timeout), test-process ${Math.round(x.ms / 1000)} s`));
    return 0;
  }
  if (verb === 'lean') {
    const measure = readJson(path.join(dir, 'measure.json')), mx = readJson(path.join(dir, 'mutation.json'));
    if (!measure) { err('error: no measure yet (norn tests measure)'); return 2; }
    const ms = Object.fromEntries(measure.files.flatMap(x => x.tests.map(t => [`${path.basename(x.file)} :: ${t.name}`, t.ms])));
    const c = { at: new Date().toISOString(), sha: measure.sha, slowest: slowest(measure, 20, p => fs.readFileSync(path.join(repo, p), 'utf8')),
      never: mx ? neverFailing(mx).map(t => ({ test: t, ms: ms[t] ?? null })) : [], duplicates: mx ? duplicates(mx, ms).map(d => ({ ...d, ms: ms[d.test] ?? null })) : [],
      mutation: mx ? mx.files : [] };
    writeJson(path.join(dir, 'candidates.json'), c);
    print(c, [`${c.never.length} never-failing, ${c.duplicates.length} duplicate candidate(s) (mutation: ${mx ? mx.trials.map(t => t.label).join(', ') : 'none'}); slowest: ${c.slowest.slice(0, 3).map(s => `${Math.round(s.ms)} ms ${s.name.slice(0, 50)}`).join('; ')}`,
      ...c.never.map(x => `  never fails: ${x.test}`), ...c.duplicates.map(x => `  duplicate:   ${x.test}  (kills ${x.kills}, ${x.same ? 'the same set as' : 'all inside'} ${x.within})`)]);
    return 0;
  }
  // check + gate: the test files the branch / wave changed vs --base
  if (!f.base) { err(`error: ${verb} needs --base REF`); return 2; }
  const base = readJson(path.join(dir, 'measure.json'));
  const changed = changedTests(repo, f.base), present = changed.filter(x => fs.existsSync(path.join(repo, x)));
  const head = present.length ? runMeasure(repo, present).measure : { coverage: true, files: [] };
  if (!head) { err('error: the changed test files wrote no measure'); return 1; }
  if (verb === 'check') {
    if (!changed.length) { print({ list: [] }, ['tests check: no test file changed']); return 0; }
    const added = changedTests(repo, f.base, 'A'), texts = Object.fromEntries(present.map(x => [x, fs.readFileSync(path.join(repo, x), 'utf8')]));
    const corpus = fs.readdirSync(path.join(repo, 'tests')).filter(x => x.endsWith('.test.mjs')).map(x => `tests/${x}`).filter(x => !texts[x])
      .map(x => ({ name: x, text: fs.readFileSync(path.join(repo, x), 'utf8') }));
    const list = crossings(w.state, mergeCheck({ base: base ?? { coverage: false, files: [] }, head, added, texts, corpus }));
    writeJson(path.join(dir, 'advisories.json'), { at: new Date().toISOString(), base: f.base, head: sha(), files: changed, base_measure: base?.sha ?? null, list });
    // the next merge compares with this one: the changed files' measures replace theirs in measure.json (a full measure resets it)
    if (base) {
      const folded = { ...base, at: new Date().toISOString(), sha: sha(), suite_ms: null, folded: changed, files: [...base.files.filter(x => !changed.includes(x.file)), ...head.files].sort((a, b) => a.file.localeCompare(b.file)) };
      writeJson(path.join(dir, 'measure.json'), folded);
      appendLine(path.join(dir, 'history.jsonl'), { ...summarize(folded, { sha: folded.sha }), via: 'merge check', suite: 'node:test', run: process.env.META_RUN_ID || null });
      writeTimes(dir, repo, folded, { sha: folded.sha, run: process.env.META_RUN_ID || null, via: 'merge check' });
    }
    print(list, [`tests check: ${changed.length} changed test file(s), ${list.length} advisory finding(s)${base ? '' : ' (no base measure: copy-paste only)'} - advisory, never a merge block`,
      ...list.map(a => `  ${a.new ? 'NEW ' : ''}${a.key} ${a.path ?? ''}: ${a.why}`)]);
    return 0;
  }
  // gate
  if (!base?.coverage) { err('error: gate needs a measure with coverage of the base (norn tests measure at the base)'); return 2; }
  const removed = leafNames(base, changed).filter(n => !new Set(leafNames(head)).has(n));
  const g = leanGate({ base, after: head, matrix: readJson(path.join(dir, 'mutation.json')), removed, changed });
  let restored = [];
  if (!g.ok && f.restore) { git(repo, ['checkout', f.base, '--', ...changed]); restored = changed; }
  const row = { at: new Date().toISOString(), base: f.base, head: sha(), ok: g.ok, files: changed, removed, before: g.before, after: g.after, score: g.score ?? null,
    lost_lines: g.lost_lines.length, lost_sample: g.lost_lines.slice(0, 20), lost_mutants: g.lost_mutants, restored,
    ms_before: base.files.filter(x => changed.includes(x.file)).reduce((n, x) => n + x.ms, 0), ms_after: head.files.reduce((n, x) => n + x.ms, 0) };
  appendLine(path.join(dir, 'waves.jsonl'), row);
  print(row, [`tests gate: ${g.ok ? 'PASS' : 'FAIL'} - ${removed.length} test(s) cut, tests ${g.before.tests} -> ${g.after.tests}, coverage ${g.before.cov?.pct}% -> ${g.after.cov?.pct}%`
    + `${g.score ? `, mutation score ${g.score.before}% -> ${g.score.after}%` : ''}`,
    ...(g.ok ? [] : [`  lost ${g.lost_lines.length} covered line(s): ${g.lost_lines.slice(0, 5).map(l => `${l.src}:${l.line}`).join(', ')}`, `  lost ${g.lost_mutants.length} mutant kill(s): ${g.lost_mutants.slice(0, 5).join(', ')}`,
      restored.length ? `  restored from ${f.base}: ${restored.join(', ')}` : '  (--restore puts the removed tests back)'])]);
  return g.ok ? 0 : 1;
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

const readLines = f => { try { return (readText(f) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
/** the tick's hook: `norn tests history` (git only, cheap) detached once a day, so the Tests tab's charts fill without anyone running it
 * (not while one started in the last 30 min). -> the tick-log words | null */
export function tickTests(p, state, { metaCmd, spawnFn, now = Date.now() } = {}) {
  if (!p?.file) return null;
  const at = readJson(path.join(state, 'tests', 'git-history.json'))?.at, day = d => new Date(d).toISOString().slice(0, 10);
  if (at && day(at) === day(now)) return null;
  const mark = path.join(state, 'tests', 'history.started');
  try { if (now - fs.statSync(mark).mtimeMs < 30 * 60e3) return null; } catch { /* never started: start it now */ }
  fs.mkdirSync(path.dirname(mark), { recursive: true }); fs.writeFileSync(mark, String(now));
  const args = [metaCmd, 'tests', 'history', '--project', p.file, '--state', state];
  let r = spawnFn ? spawnFn(process.execPath, args) : null;
  if (!r) { const c = spawn(process.execPath, args, { cwd: p.root, detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); r = { pid: c.pid }; }
  return `tests history: started pid ${r?.pid ?? '?'}`;
}

// ---------- the Tests tab (TESTS-RUNTIME, test-diet S1): a summary + four sub-views, each its own part (dash/testparts.mjs TESTS_SUBS) ----------
// The governance machinery (the test-governance lane, DIR-23 a-g) writes these beside the measure; until a file exists its view says
// "not measured yet", never a number. Ids are timesTable's (file::group::name).
//   costs.json    { at, cpu_pct (the machine's CPU % while measured), tests: { id: { cpu_s, peak_mb, children: { browser, server, git, other }, alone_ms, load_ms } } }
//   health.json   { at, days, tests: { id: { fails, reruns, load_only, hangs } }, quarantine: { id: { by, until, why, q } } }
//   tiers.json    { at, tests: { id: { tier: worker | pr | post-batch | nightly, verdict: keep | move | merge | delete | rewrite, evidence, q } } }
//   history.jsonl rows may carry cpu_min (the suite's CPU-minutes for that measure)
// An alert the machinery raises is an open Inbox question with data.area 'tests' (the server lists them: the tab links, never copies).
const GOV = ['costs.json', 'health.json', 'tiers.json'];
const read = (state, f) => readJson(path.join(state, 'tests', f));
/** META-DASH-ASYNC R1: the files the summary + a part read, for the dash to prime on fs.promises */
export const testsFiles = (state, sub = null) => [...['history.jsonl', 'git-history.json', TIMES_FILE, 'advisories.json'],
  ...(sub === 'costs' ? [...GOV, 'candidates.json', 'mutation.json'] : sub === 'impact' ? [IMPACT_FILE] : sub === 'suite' ? ['waves.jsonl'] : sub === 'runtime' ? [] : ['mutation.json', 'candidates.json', 'waves.jsonl'])]
  .map(f => path.join(state, 'tests', f));
/** which suite the project folder holds ('node:test' | 'pytest' | false = neither; null = no project folder), off the sync path */
export const suiteOf = project => (project?.root ? fs.promises.access(path.join(projectHome(project), 'tests')).then(() => suiteKind(projectHome(project)) ?? false, () => false) : Promise.resolve(null));
const timesHead = t => (t ? { at: t.at, sha: t.sha, run: t.run, via: t.via, suite: t.suite, exit: t.exit, total_ms: t.total_ms, wall_ms: t.wall_ms, coverage: t.coverage,
  tests: t.tests.length, files: t.files.length, failed: t.tests.filter(x => !x.ok).length, slowest: t.tests[0] ? { id: t.tests[0].id, name: t.tests[0].name, ms: t.tests[0].ms } : null } : null);
/** the Tests tab's summary: small files only; a missing file = null / [] (not measured yet). suite = suiteOf's answer.
 *  guardview reads advisories from it (the merge check's findings are Slop rows) */
export function testsView(state, suite = null) {
  return { suite, history: readLines(path.join(state, 'tests', 'history.jsonl')), git: read(state, 'git-history.json'), times: timesHead(read(state, TIMES_FILE)),
    advisories: read(state, 'advisories.json'), commands: { measure: 'norn tests measure', history: 'norn tests history', lean: 'norn tests lean', for: 'norn tests for' } };
}
const cap = (list, limit) => ({ rows: list.slice(0, limit), n: list.length });
/**
 * one sub-view's part of the Tests tab -> its data. o: { limit, picked: { files, lane, lanes } (impact: the server resolves a lane's changed
 * files), merges: the merge queue's batches (costs: per merge gate time + what it ran) }. Run time is the server's (runtimePart: run records + transcripts)
 */
export function testsPart(state, name, { limit = 40, picked = null, merges = [] } = {}) {
  const t = read(state, TIMES_FILE);
  if (name === 'suite') {   // + the charts over time (suite CPU-minutes per full run, the last lean-tests wave)
    const over = { cpu: readLines(path.join(state, 'tests', 'history.jsonl')).filter(r => typeof r.cpu_min === 'number').map(r => ({ at: r.at, cpu_min: r.cpu_min })), wave: readLines(path.join(state, 'tests', 'waves.jsonl')).at(-1) ?? null };
    return t ? { breakdown: breakdown(t), tests: cap(slowestTests(t), limit), ...over } : { breakdown: null, tests: { rows: [], n: 0 }, ...over };
  }
  if (name === 'costs') {
    const [costs, health, tiers] = GOV.map(f => read(state, f));
    const cost = id => costs?.tests?.[id] ?? null, hl = id => health?.tests?.[id] ?? null, q = id => health?.quarantine?.[id] ?? null, tr = id => tiers?.tests?.[id] ?? null;
    const rows = (t?.tests ?? []).map(x => ({ id: x.id, file: x.file, name: x.name, line: x.line, ms: x.ms, cost: cost(x.id), health: hl(x.id), quarantine: q(x.id), tier: tr(x.id) }))
      .sort((a, b) => (b.cost?.cpu_s ?? 0) - (a.cost?.cpu_s ?? 0) || (b.health?.fails ?? 0) - (a.health?.fails ?? 0) || b.ms - a.ms);
    const mx = read(state, 'mutation.json');
    return { sources: { costs: costs ? { at: costs.at, cpu_pct: costs.cpu_pct ?? null } : null, health: health ? { at: health.at, days: health.days ?? 7 } : null, tiers: tiers ? { at: tiers.at } : null },
      rows: cap(rows, limit), merges, lean: read(state, 'candidates.json'), mutation: mx ? { files: mx.files, trials: mx.trials } : null };
  }
  if (name === 'impact') {
    const im = read(state, IMPACT_FILE);
    return { impact: im ? { at: im.at, sha: im.sha, suite: im.suite, sources: Object.keys(im.sources).sort() } : null, lanes: picked?.lanes ?? [],
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
