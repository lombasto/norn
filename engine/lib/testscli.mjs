// META-TEND TESTS: `norn tests` - measure | history | check | mutation | lean | gate. Code only, no model. Writes <state>/tests/ only:
//   measure.json (the last full measure), history.jsonl (one summary row per measure), mutation.json (the merged trial matrices),
//   candidates.json (the last lean analysis), advisories.json (the last merge check), waves.jsonl (one row per gated wave),
//   git-history.json (tests vs code per day). testsView reads them for the dash's Tests tab (small files only, never measure.json).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonS, readText } from './fsnap.mjs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitHistory, summarize, mergeCheck, leanGate, leafNames, mutationMatrix, addTrial, neverFailing, duplicates, slowest } from './testlean.mjs';
import { crossings } from './advisory.mjs';
import { subdirOf, inDir, projectHome } from './monorepo.mjs';

export const TESTS_USAGE = 'usage: norn tests measure [--no-coverage] | history [--points N] | check --base REF | mutation --report R --kills K --tests a,b [--label L] [--wall S] | lean | gate --base REF [--restore]    '
  + '[--project P | --state D] [--repo DIR] [--json]   (check = the merge-time advisories, exit 0; gate exit 1 = the wave lost coverage or a mutant\'s last killer)';
const FLAGS = { measure: ['no-coverage!'], history: ['points'], check: ['base'], mutation: ['report', 'kills', 'tests', 'label', 'wall'], lean: [], gate: ['base', 'restore!'] };
const CI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ci-suite.mjs');
const fwd = s => s.split('\\').join('/');
const TEST_GLOB = /^tests\/[^/]+\.test\.mjs$/;
/** does the folder hold a node:test suite (tests/*.test.mjs)? measure / check / lean / gate read only those; a pytest project (Solve Shack)
 * gets the git history and says so, rather than a check that always answers "no test file changed" */
export const nodeSuite = dir => { try { return fs.readdirSync(path.join(dir, 'tests')).some(x => x.endsWith('.test.mjs')); } catch { return false; } };
const NOT_NODE = repo => `this project has no node:test suite (tests/*.test.mjs in ${repo}): per-test timing, the merge check and lean tests read node:test only - nothing checked`;

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
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const readJson = readJsonS;   // META-DASH-ASYNC R1: snapshot-aware (lib/fsnap.mjs)
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); };
const appendLine = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(v) + '\n'); };

/** run ci-suite --measure on `files` (all of tests/*.test.mjs when empty) in repo -> { measure, status, log } */
function runMeasure(repo, files, { coverage = true, log } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'norn-measure-')), out = path.join(tmp, 'm.json');
  const known = fs.existsSync(path.join(repo, 'tests', 'KNOWN-REDS.txt')) ? path.join(repo, 'tests', 'KNOWN-REDS.txt') : (fs.writeFileSync(path.join(tmp, 'k.txt'), ''), path.join(tmp, 'k.txt'));
  const r = spawnSync(process.execPath, [CI, '--known', known, '--measure', out, ...(coverage ? ['--coverage'] : []), ...files], { cwd: repo, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (log) { fs.mkdirSync(path.dirname(log), { recursive: true }); fs.writeFileSync(log, (r.stdout || '') + (r.stderr || '')); }
  const measure = readJson(out);
  fs.rmSync(tmp, { recursive: true, force: true });
  return { measure, status: r.status };
}
// --relative: from a monorepo project's folder the names are relative to it (as tests/x.test.mjs), never the repo's top
const changedTests = (repo, base, filter = 'AMD') => git(repo, ['diff', '--name-only', '--relative', `--diff-filter=${filter}`, base, '--', 'tests']).split('\n').map(fwd).filter(f => TEST_GLOB.test(f));

/** o: { env, out, err, where(flags) -> { project, state } } */
export function testsCmd(argv, { out = console.log, err = console.error, where } = {}) {
  const verb = argv[0];
  let f;
  try { if (!FLAGS[verb]) throw new Error(verb ? `unknown verb ${verb}` : 'missing verb'); f = parse(verb, argv.slice(1)); }
  catch (e) { err('error: ' + e.message); err(TESTS_USAGE); return 2; }
  let w;
  try { w = where(f); } catch (e) { err('error: ' + e.message); return 2; }
  const dir = path.join(w.state, 'tests');
  // gap #7: a monorepo project (project.subdir; not with an explicit --repo) measures its own folder: its tests/, its history
  const top = fwd(git(f.repo || w.project?.root || process.cwd(), ['rev-parse', '--show-toplevel']));
  const repo = !f.repo && subdirOf(w.project) ? fwd(inDir(top, subdirOf(w.project))) : top;
  const sha = () => git(repo, ['rev-parse', '--short=12', 'HEAD']);
  const print = (v, text) => (f.json ? out(JSON.stringify(v, null, 1)) : text.forEach(l => out(l)));

  if (verb !== 'history' && !nodeSuite(repo)) {
    if (verb === 'check') { print({ list: [], suite: false }, [`tests check: ${NOT_NODE(repo)}`]); return 0; }   // advisory: a merge goes on
    err(`error: tests ${verb}: ${NOT_NODE(repo)}`); return 2;
  }
  if (verb === 'measure') {
    const { measure, status } = runMeasure(repo, [], { coverage: !f['no-coverage'], log: path.join(dir, 'measure.log') });
    if (!measure) { err(`error: the suite wrote no measure (exit ${status}; log ${fwd(path.join(dir, 'measure.log'))})`); return 1; }
    const row = summarize(measure, { sha: sha() });
    writeJson(path.join(dir, 'measure.json'), { ...measure, sha: row.sha });
    appendLine(path.join(dir, 'history.jsonl'), row);
    print(row, [`measured ${row.tests} tests in ${row.files} files: suite ${Math.round(row.suite_ms / 1000)} s${row.coverage ? `, line coverage ${row.coverage.pct}% (${row.coverage.covered}/${row.coverage.total})` : ''} (suite exit ${status})`]);
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
      appendLine(path.join(dir, 'history.jsonl'), { ...summarize(folded, { sha: folded.sha }), via: 'merge check' });
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

const readLines = f => { try { return (readText(f) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
/** META-DASH-ASYNC R1: the files testsView reads, for the dash to prime on fs.promises */
export const testsFiles = state => ['mutation.json', 'history.jsonl', 'git-history.json', 'candidates.json', 'advisories.json', 'waves.jsonl'].map(f => path.join(state, 'tests', f));
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
/** the Tests tab of one project: everything <state>/tests holds, small files only; a missing file = null / [] (not measured yet).
 * suite: does the project folder hold a node:test suite (false = the page says which parts can fill; the dash finds it with suiteOf, off the sync path) */
export const suiteOf = project => project?.root ? fs.promises.readdir(path.join(projectHome(project), 'tests')).then(xs => xs.some(x => x.endsWith('.test.mjs')), () => false) : Promise.resolve(null);
export function testsView(state, suite = null) {
  const dir = path.join(state, 'tests'), mx = readJson(path.join(dir, 'mutation.json'));
  return { suite, history: readLines(path.join(dir, 'history.jsonl')), git: readJson(path.join(dir, 'git-history.json')), lean: readJson(path.join(dir, 'candidates.json')),
    mutation: mx ? { files: mx.files, trials: mx.trials } : null, advisories: readJson(path.join(dir, 'advisories.json')), waves: readLines(path.join(dir, 'waves.jsonl')),
    commands: { measure: 'norn tests measure', history: 'norn tests history', lean: 'norn tests lean' } };
}
