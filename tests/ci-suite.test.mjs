// META-GTP-CI 1: the CI suite runner fails only on a red NOT in tests/KNOWN-REDS.txt (GT-PARITY-PLAN 2.11). The fixture file has
// a listed red, a listed subtest red (its parent's "subtests failed" is not a red of its own) and an opt-in new red.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseKnown, judge, suiteEnv, pickTests, importsOf, timeRow, censusEnv } from '../engine/lib/cisuite.mjs';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { skipWhy } from './helpers/cdp.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CI = path.join(REPO, 'engine', 'bin', 'ci-suite.mjs');
const FX = 'tests/fixtures/ci-suite';
const suite = (env = {}) => spawnSync(process.execPath, [CI, '--known', `${FX}/known.txt`, `${FX}/*.test.mjs`],
  { cwd: REPO, encoding: 'utf8', env: { ...process.env, ...env } });

test('parseKnown: "<file> :: <name>" lines, # comments and blanks skipped; a line without :: throws', () => {
  assert.deepEqual(parseKnown('# c\n\ntests/a.test.mjs :: GOLDEN:\r\n tests\\b.test.mjs ::  x y \n'),
    [{ file: 'tests/a.test.mjs', name: 'GOLDEN:' }, { file: 'tests/b.test.mjs', name: 'x y' }]);
  assert.throws(() => parseKnown('tests/a.test.mjs GOLDEN'), /KNOWN-REDS line 1/);
});

test('judge: a listed red (exact name or prefix, same file) passes; a new red fails; a listed red that passed is reported, not failed', () => {
  const known = parseKnown('tests/a.test.mjs :: GOLDEN:\ntests/b.test.mjs :: DEC-362: x\ntests/c.test.mjs :: gone');
  const j = judge([{ file: 'tests/a.test.mjs', name: 'GOLDEN: kestrel byte-same' }, { file: 'tests/b.test.mjs', name: 'DEC-362: x' },
    { file: 'tests/a.test.mjs', name: 'DEC-362: x' }], known);
  assert.deepEqual(j.listed.map(f => f.name), ['GOLDEN: kestrel byte-same', 'DEC-362: x']);
  assert.deepEqual(j.fresh, [{ file: 'tests/a.test.mjs', name: 'DEC-362: x' }]);
  assert.deepEqual(j.fixed, [{ file: 'tests/c.test.mjs', name: 'gone' }]);
  assert.equal(j.ok, false);
  assert.equal(judge([], []).ok, true);
});

test('ci-suite: only listed reds -> exit 0; a new red -> exit 1 naming it', () => {
  const ok = suite();
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /ci-suite: 2 listed red\(s\), 0 new/);
  assert.match(ok.stdout, /listed red now passes \(remove it\): tests\/fixtures\/ci-suite\/gone\.test\.mjs :: never fails/);
  const bad = suite({ CI_SUITE_FX_NEW: '1' });
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /NEW RED: tests\/fixtures\/ci-suite\/fx\.test\.mjs :: fx new red/);
  assert.doesNotMatch(bad.stdout, /NEW RED: .*fx parent/);
});

test('tests/KNOWN-REDS.txt is empty (GOLDEN + DEC-362 fixed at the cause, 5ea9e25); any listed red names a test that exists', () => {
  const known = parseKnown(fs.readFileSync(path.join(REPO, 'tests', 'KNOWN-REDS.txt'), 'utf8'));
  assert.deepEqual(known.map(k => k.file), []);   // the list only shrinks: a new entry needs the controller's ruling
  for (const k of known) assert.ok(fs.readFileSync(path.join(REPO, k.file), 'utf8').includes(`test('${k.name}`), `${k.file} has no test '${k.name}...'`);
});

// DEC-78: smoke.test.mjs runs alone (concurrency 1) after the parallel set, so its < 60 s budget measures smoke, not contention.
test.after(cleanTmp);
const SER = 'tests/fixtures/ci-suite-serial';
const serial = (red = '', globs = [`${SER}/*.test.mjs`]) => {
  const log = path.join(mkTmp('meta-ci-serial-'), 'log');
  fs.writeFileSync(log, '');
  const r = spawnSync(process.execPath, [CI, '--known', `${SER}/known.txt`, ...globs],
    { cwd: REPO, encoding: 'utf8', env: { ...process.env, CI_SUITE_LOG: log, CI_SUITE_RED: red } });
  const ev = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => l.split(' ')).map(([f, w, t]) => ({ f, w, t: +t }));
  return { ...r, ev };
};

test('ci-suite: smoke.test.mjs is left out of the parallel run and runs once, alone, after it; one report, one exit code', () => {
  const ok = serial();
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /ci-suite: parallel phase: 2 file\(s\), concurrency 3/);
  assert.match(ok.stdout, new RegExp(`ci-suite: serial phase: ${SER}/smoke\.test\.mjs, concurrency 1`));
  const starts = ok.ev.filter(e => e.w === 'start');
  assert.deepEqual(starts.map(e => e.f).sort(), ['p1', 'p2', 'smoke'], 'each file runs exactly once');
  const smokeStart = starts.find(e => e.f === 'smoke').t;
  for (const e of ok.ev.filter(e => e.f !== 'smoke')) assert.ok(e.t <= smokeStart, `${e.f} ${e.w} after smoke started`);
  assert.match(ok.stdout, /ci-suite: 0 listed red\(s\), 0 new/);

  const par = serial('p1');
  assert.equal(par.status, 1, par.stdout + par.stderr);
  assert.match(par.stdout, new RegExp(`NEW RED: ${SER}/p1\.test\.mjs :: p1 fixture`));
  const smk = serial('smoke');
  assert.equal(smk.status, 1, smk.stdout + smk.stderr);
  assert.match(smk.stdout, new RegExp(`NEW RED: ${SER}/smoke\.test\.mjs :: smoke fixture`));
  const both = serial('p2,smoke');
  assert.equal(both.status, 1, both.stdout + both.stderr);
  assert.match(both.stdout, /ci-suite: 0 listed red\(s\), 2 new/);
});

test('ci-suite: an explicit glob without smoke runs only the parallel phase; one naming only smoke runs only the serial one', () => {
  const p = serial('', [`${SER}/p1.test.mjs`]);
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.deepEqual(p.ev.filter(e => e.w === 'start').map(e => e.f), ['p1']);
  assert.doesNotMatch(p.stdout, /serial phase/);
  const s = serial('', [`${SER}/smoke.test.mjs`]);
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.deepEqual(s.ev.filter(e => e.w === 'start').map(e => e.f), ['smoke']);
  assert.doesNotMatch(s.stdout, /parallel phase/);
});

// CI 44335427788: a fresh ubuntu runner's first browser launch passed the 30 s DevTools wait of the first browser tests
test('ci-suite: with a browser test in the run, one browser launch (warm-up, timed) goes before the files; without one, none', { skip: skipWhy, timeout: 120000 }, () => {
  const dir = mkTmp('meta-cisuite-warm-'), f = path.join(dir, 'b.test.mjs');
  fs.writeFileSync(f, `// a browser test by its import: import { openPage } from './helpers/cdp.mjs'\nimport test from 'node:test';\ntest('b', () => {});\n`);
  const r = spawnSync(process.execPath, [CI, '--known', `${FX}/known.txt`, f.split('\\').join('/')], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ci-suite: browser warm-up \d+ ms \(.+\)\n[\s\S]*ci-suite: parallel phase/, 'timed, before the files');
  assert.doesNotMatch(r.stdout, /warm-up \d+ ms[^\n]*failed/, r.stdout);
  assert.doesNotMatch(serial('', [`${SER}/p1.test.mjs`]).stdout, /warm-up/, 'no browser test: no launch');
});

// 11-13 RUN-471 / RUN-477 / RUN-481 / RUN-505: a worker's own META_RUN_ID / META_ROLE / META_STATE (and CLAUDECODE) leaked into
// the suite it ran - 4 CLI test files went red and the suite hung; the MERGE of feat/meta-shot stopped on it.
test('ci-suite: the calling run identity (META_RUN_ID, META_ROLE, META_STATE, ..., CLAUDECODE) never reaches the suite', () => {
  const r = spawnSync(process.execPath, [CI, '--known', 'tests/fixtures/ci-suite-env/known.txt', 'tests/fixtures/ci-suite-env/*.test.mjs'],
    { cwd: REPO, encoding: 'utf8', env: { ...process.env, META_RUN_ID: 'RUN-1', META_RUN_STATE: '/x/state', META_ROLE: 'checkin', META_STATE: '/x/state',
      META_PROJECT: 'p', META_SESSION_ID: 's', META_RESUMES: '1', META_NOTES: '/x/NOTES.md', META_JOB: 'j', META_PARENT_RUN: 'RUN-2', CLAUDECODE: '1' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ci-suite: 0 listed red\(s\), 0 new/);
});

// 11-13 MAIL-33: `node --test` run straight from a worker (no ci-suite) inherited META_RUN_ID / META_RUN_STATE / META_JOB: 4 tests in
// cli / digest / delegate went red and mail.test hung. tests/helpers/tmp.mjs (every spawning test file imports it) drops CALLER_ENV.
// wt-reds: META_RESULT_DIR too - with it and no META_RUN_ID the fake executor's writeResult threw, so probe.test (fake) went red in a worker.
test('tests/helpers/tmp.mjs: importing it drops the calling run identity (CALLER_ENV, META_JOB, META_PARENT_RUN, META_RESULT*) from process.env', () => {
  const ids = { META_RUN_ID: 'RUN-1', META_RUN_STATE: '/x/state', META_ROLE: 'checkin', META_STATE: '/x/state', META_PROJECT: 'p',
    META_SESSION_ID: 's', META_RESUMES: '1', META_NOTES: '/x/NOTES.md', META_JOB: 'j', META_PARENT_RUN: 'RUN-2', CLAUDECODE: '1',
    META_RESULT: '/x/state/results/RUN-1/result.json', META_RESULT_DIR: '/x/state/results/RUN-1' };
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    "await import('./tests/helpers/tmp.mjs'); console.log(JSON.stringify(Object.keys(process.env).filter(k => /^(META_|CLAUDECODE$)/i.test(k))))"],
    { cwd: REPO, encoding: 'utf8', env: { ...process.env, ...ids, META_WALL_STEP_MS: '5' } });
  assert.equal(r.status, 0, r.stderr);
  const left = JSON.parse(r.stdout);
  assert.deepEqual(left.filter(k => k in ids), []);
  assert.ok(left.includes('META_WALL_STEP_MS'), 'a test knob passes through');
});

test('suiteEnv: the temp repos of the suite skip git auto maintenance (a gc / maintenance process per commit or fetch, not under test); the git config entries of a caller are kept', () => {
  const e = suiteEnv({ PATH: 'p' });
  const cfg = Object.fromEntries(Array.from({ length: Number(e.GIT_CONFIG_COUNT) }, (_, i) => [e['GIT_CONFIG_KEY_' + i], e['GIT_CONFIG_VALUE_' + i]]));
  assert.deepEqual(cfg, { 'maintenance.auto': 'false', 'gc.auto': '0' });
  const k = suiteEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.x', GIT_CONFIG_VALUE_0: 'y' });
  assert.equal(k.GIT_CONFIG_COUNT, '3'); assert.equal(k.GIT_CONFIG_KEY_0, 'core.x'); assert.equal(k.GIT_CONFIG_KEY_2, 'gc.auto');
});

// CI-HANG-B7F6833 R2: a file that never exits is killed at the per-file wall cap, its output so far is printed, and the suite fails naming it
test('ci-suite: each file prints "start <file>"; a file past --file-cap is killed (tree), its output printed, the suite red naming it', { timeout: 120000 }, async () => {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [CI, '--file-cap', '5', 'tests/fixtures/ci-suite-hang/*.test.mjs'],
    { cwd: REPO, encoding: 'utf8', env: suiteEnv(process.env), timeout: 90000 });
  assert.equal(r.error, undefined, 'the suite itself ended (no hang)');
  assert.ok(Date.now() - t0 < 60000, 'ended near the cap');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /ci-suite: start tests\/fixtures\/ci-suite-hang\/hang\.test\.mjs/);
  assert.match(r.stdout, /ci-suite: start tests\/fixtures\/ci-suite-hang\/ok\.test\.mjs/);
  assert.match(r.stdout, /hang-fixture: before the hang/, 'the buffered output so far is printed');
  assert.match(r.stdout, /HANG RED: tests\/fixtures\/ci-suite-hang\/hang\.test\.mjs :: no exit within the 5 s per-file cap \(killed\)/);
  assert.doesNotMatch(r.stdout, /HANG RED: tests\/fixtures\/ci-suite-hang\/ok\.test\.mjs/);
  const bad = spawnSync(process.execPath, [CI, '--file-cap', '0', 'tests/fixtures/ci-suite-hang/ok.test.mjs'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(bad.status, 2); assert.match(bad.stderr, /--file-cap/);
});

// ---------- RM-26 S0: the per-file time JSON (--json) and the process census (--census) ----------
test('timeRow: cases_ms sums the top-level case lines only; outside_ms is the rest of the wall', () => {
  assert.deepEqual(timeRow('tests/a.test.mjs', 1000.4, [{ top: 'a', ms: 100.2 }, { top: 'b', ms: 299.9 }, { file: null, name: 'b', nesting: 0 }]),
    { file: 'tests/a.test.mjs', wall_ms: 1000, cases_ms: 400, outside_ms: 600, cases: 2 });
  assert.deepEqual(timeRow('tests/b.test.mjs', 50, []), { file: 'tests/b.test.mjs', wall_ms: 50, cases_ms: 0, outside_ms: 50, cases: 0 });
});

test('ci-suite --json F: one row per file (wall_ms, cases_ms, outside_ms, cases, phase); the reds are judged as before', () => {
  const out = path.join(mkTmp('meta-ci-json-'), 'sub', 'times.json');
  const r = spawnSync(process.execPath, [CI, '--known', `${FX}/known.txt`, '--json', out, `${FX}/*.test.mjs`], { cwd: REPO, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ci-suite: 2 listed red\(s\), 0 new/);
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(j.census, false); assert.equal(j.platform, process.platform);
  assert.deepEqual(j.files.map(x => [x.file, x.phase, x.cases]), [['tests/fixtures/ci-suite/fx.test.mjs', 'parallel', 3]]);
  const [x] = j.files;
  assert.ok(x.wall_ms > 0 && x.cases_ms <= x.wall_ms && x.outside_ms === x.wall_ms - x.cases_ms, JSON.stringify(x));
  assert.ok(!('git_procs' in x) && !('node_procs' in x), 'no census without --census');
  for (const a of [['--census'], ['--json']]) {
    const bad = spawnSync(process.execPath, [CI, ...a], { cwd: REPO, encoding: 'utf8', windowsHide: true });
    assert.equal(bad.status, 2); assert.match(bad.stderr, /--census needs --json|--json needs a file/);
  }
});

test('censusEnv: the caller\'s NODE_OPTIONS kept, an outer census preload replaced by this one (a process counts in the innermost census)', () => {
  const e = censusEnv('--max-old-space-size=4096 --require="C:/t/a/census-preload.cjs"', 'C:/t/b/census-preload.cjs', 'C:/t/b/f.census');
  assert.equal(e.NODE_OPTIONS, '--max-old-space-size=4096 --require="C:/t/b/census-preload.cjs"');
  assert.equal(censusEnv(undefined, '/t/p.cjs', '/t/d').NODE_OPTIONS, '--require="/t/p.cjs"');
  assert.equal(e.GIT_TRACE2_EVENT, path.join('C:/t/b/f.census', 'trace2'));
});

test('ci-suite --census: git_procs (GIT_TRACE2_EVENT, a file per git process) and node_procs (a --require preload) per file', () => {
  // plain starts no process; spawns starts 3 git and 1 node more, the node one on a .txt entry as slop-fix.test.mjs's Done check does
  // (CI 45728652472: an --import preload sent it through the ESM loader, ERR_UNKNOWN_FILE_EXTENSION)
  const d = mkTmp('meta-ci-census-'), out = path.join(d, 'times.json'), fx = path.join(d, 'fx');
  fs.mkdirSync(fx);
  fs.writeFileSync(path.join(fx, 'chk.txt'), 'process.exit(0)\n');
  fs.writeFileSync(path.join(fx, 'plain.test.mjs'), "import test from 'node:test';\ntest('census plain', () => {});\n");
  fs.writeFileSync(path.join(fx, 'spawns.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { spawnSync } from 'node:child_process';\n" +
    "test('census spawns: git twice', () => { for (let i = 0; i < 2; i++) assert.equal(spawnSync('git', ['--version']).status, 0); });\n" +
    `test('census spawns: node once, on a .txt entry', () => { const r = spawnSync(process.execPath, [${JSON.stringify(path.join(fx, 'chk.txt'))}], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); });\n` +
    "test('census spawns: git from an engine module', async () => { const { probe } = await import('./engine/lib/probe.mjs'); assert.equal(probe(), 0); });\n" +
    "test('census spawns: a jobguard command line', () => { spawnSync('no-such-jobguard', ['run', '1000', '-', '\"git\" rev-parse HEAD']); });\n");
  fs.mkdirSync(path.join(fx, 'engine', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(fx, 'engine', 'lib', 'probe.mjs'), "import { spawnSync } from 'node:child_process';\nexport const probe = () => spawnSync('git', ['--version']).status;\n");
  // the inner suite runs without an outer harness's --import (`norn tests run` adds its read recorder, testcache.mjs withRecorder):
  // censusEnv keeps the caller's NODE_OPTIONS, and any --import sends `node chk.txt` through the ESM loader (the CI 45728652472 red)
  const env = suiteEnv(process.env), opts = String(env.NODE_OPTIONS ?? '').replace(/\s*--import[= ]\S+/g, '').trim();
  if (opts) env.NODE_OPTIONS = opts; else delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, [CI, '--json', out, '--census', `${fx.split('\\').join('/')}/*.test.mjs`], { cwd: REPO, encoding: 'utf8', windowsHide: true, env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const j = JSON.parse(fs.readFileSync(out, 'utf8')), [plain, spawns] = j.files;
  assert.equal(j.census, true);
  assert.deepEqual([plain.file, spawns.file].map(f => path.basename(f)), ['plain.test.mjs', 'spawns.test.mjs']);
  assert.equal(plain.git_procs, 0, JSON.stringify(plain));
  assert.ok(plain.node_procs >= 1, 'the file\'s own node --test process is counted');
  assert.equal(spawns.git_procs - plain.git_procs, 3, JSON.stringify(j.files));
  assert.equal(spawns.node_procs - plain.node_procs, 1, JSON.stringify(j.files));
  // census v2 (RM-26 S6B-0): the 4 children the test file starts itself count under `tests`, the one an engine module starts under
  // that module, and a jobguard command line (here a missing helper: the line is written before the start) counts once as jobguard
  assert.deepEqual(Object.keys(spawns.sites), ['lib/probe.mjs', 'tests'], JSON.stringify(spawns));
  assert.equal(spawns.sites['lib/probe.mjs'], 1, JSON.stringify(spawns));
  assert.equal(spawns.sites.tests - (plain.sites.tests ?? 0), 4, JSON.stringify(j.files));
  assert.deepEqual([plain.jobguard, spawns.jobguard], [0, 1], JSON.stringify(j.files));
});

// ---------- META-PR-FAST (RM-29): the fast PR job runs the test files a change touches ----------
test('pickTests: a changed test, a test named after a changed module, a fixture folder and a direct importer are picked; one level only', () => {
  const src = {
    'tests/mergeq.test.mjs': '', 'tests/mergeq-batch.test.mjs': '', 'tests/merger.test.mjs': '',
    'tests/a.test.mjs': "import { x } from '../engine/lib/x.mjs';\nimport y from \"../engine/lib/y.mjs\";",
    'tests/b.test.mjs': "const m = await import('../engine/lib/x.mjs');",
    'tests/c.test.mjs': "import { h } from './helpers/h.mjs'; // names engine/lib/x.mjs and runs.mjs in text only",
    'tests/d.test.mjs': "const FX = 'tests/fixtures/ci-suite';",
    'tests/e.test.mjs': '',
  };
  const read = f => src[f] ?? null, tests = Object.keys(src);
  assert.deepEqual(pickTests(['engine/lib/x.mjs'], tests, read), { run: ['tests/a.test.mjs', 'tests/b.test.mjs'], left: [] });
  assert.deepEqual(pickTests(['engine/lib/mergeq.mjs'], tests, read).run, ['tests/mergeq-batch.test.mjs', 'tests/mergeq.test.mjs'], 'stem: name or name-*');
  assert.deepEqual(pickTests(['tests/helpers/h.mjs'], tests, read).run, ['tests/c.test.mjs'], 'a changed helper picks its importers');
  assert.deepEqual(pickTests(['tests/fixtures/ci-suite/fx.test.mjs'], tests, read).run, ['tests/d.test.mjs']);
  assert.deepEqual(pickTests(['tests\\e.test.mjs', 'README.md', 'docs/x.md', 'engine/dash/index.html'], tests, read).run, ['tests/e.test.mjs']);
  assert.deepEqual(pickTests(['engine/lib/runs.mjs'], tests, read).run, [], 'a name in the text is no import');
  assert.deepEqual(importsOf('tests/sub/z.test.mjs', "import a from '../../engine/lib/a.mjs'; import './b.mjs'; import fs from 'node:fs';"),
    ['engine/lib/a.mjs', 'tests/sub/b.mjs']);
});

test('pickTests max: the close picks always run; importers run most-changed-imports first, the rest is left (named)', () => {
  const src = { 'tests/x.test.mjs': '', 'tests/i1.test.mjs': "import '../engine/lib/x.mjs';", 'tests/i2.test.mjs': "import '../engine/lib/x.mjs'; import '../engine/lib/y.mjs';",
    'tests/i3.test.mjs': "import '../engine/lib/y.mjs';" };
  const p = pickTests(['engine/lib/x.mjs', 'engine/lib/y.mjs'], Object.keys(src), f => src[f], 1);
  assert.deepEqual(p, { run: ['tests/i2.test.mjs', 'tests/x.test.mjs'], left: ['tests/i1.test.mjs', 'tests/i3.test.mjs'] });
  assert.deepEqual(pickTests(['engine/lib/x.mjs'], Object.keys(src), f => src[f], 0), { run: ['tests/x.test.mjs'], left: ['tests/i1.test.mjs', 'tests/i2.test.mjs'] });
});

test('pickTests: a test whose // reads: header matches a changed file is a close pick, never under the importers\' cap (task-NORN-TEST-READS)', () => {
  const src = { 'tests/ci.test.mjs': "// reads: .github/workflows/*.yml\nimport '../engine/lib/z.mjs';", 'tests/slop-pr.test.mjs': '// slop on a PR\n// reads: .github/workflows/pr.yml, engine/lib/slop/rules/README.md\n',
    'tests/i1.test.mjs': "import '../engine/lib/x.mjs';", 'tests/other.test.mjs': "import test from 'node:test';" };
  assert.deepEqual(pickTests(['.github/workflows/pr.yml', 'engine/lib/x.mjs'], Object.keys(src), f => src[f], 0), { run: ['tests/ci.test.mjs', 'tests/slop-pr.test.mjs'], left: ['tests/i1.test.mjs'] });
  assert.deepEqual(pickTests(['engine/lib/slop/rules/README.md'], Object.keys(src), f => src[f]).run, ['tests/slop-pr.test.mjs']);
});

test('ci-suite --changed BASE: runs only the picked files of BASE...HEAD; nothing picked -> exit 0 without a run; usage errors exit 2', () => {
  const t = mkTmp('meta-ci-changed-'), g = (...a) => spawnSync('git', ['-C', t, ...a], { encoding: 'utf8' });
  const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(t, f)), { recursive: true }); fs.writeFileSync(path.join(t, f), s); };
  const ok = name => `import test from 'node:test';\ntest('${name}', () => {});\n`;
  w('engine/lib/x.mjs', 'export const x = 1;\n'); w('engine/lib/y.mjs', 'export const y = 1;\n'); w('known.txt', '');
  w('tests/a.test.mjs', `import { x } from '../engine/lib/x.mjs';\n${ok('a')}`); w('tests/y.test.mjs', ok('y')); w('tests/z.test.mjs', ok('z'));
  g('init', '-q', '-b', 'main'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  const run = (...a) => spawnSync(process.execPath, [CI, '--known', 'known.txt', ...a], { cwd: t, encoding: 'utf8' });
  const none = run('--changed', 'main');
  assert.equal(none.status, 0, none.stdout + none.stderr); assert.match(none.stdout, /0 file\(s\) changed since main: 0 test file\(s\) picked/);
  assert.doesNotMatch(none.stdout, /phase/);
  g('switch', '-q', '-c', 'pr'); w('engine/lib/x.mjs', 'export const x = 2;\n'); w('engine/lib/y.mjs', 'export const y = 2;\n'); w('README.md', 'x\n');
  g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'pr');
  const r = run('--changed', 'main');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /3 file\(s\) changed since main: 2 test file\(s\) picked/);
  assert.deepEqual([...r.stdout.matchAll(/ci-suite: start (\S+)/g)].map(m => m[1]).sort(), ['tests/a.test.mjs', 'tests/y.test.mjs']);
  const capped = run('--changed', 'main', '--max', '0');
  assert.deepEqual([...capped.stdout.matchAll(/ci-suite: start (\S+)/g)].map(m => m[1]), ['tests/y.test.mjs']);
  assert.match(capped.stdout, /1 more import a changed file, left to the full suite after the merge: tests\/a\.test\.mjs/);
  for (const [a, re] of [[['--max', '3'], /--max needs --changed/], [['--changed'], /--changed needs a base ref/], [['--changed', 'nope'], /git diff nope\.\.\.HEAD failed/]]) {
    const b = run(...a); assert.equal(b.status, 2, b.stdout + b.stderr); assert.match(b.stderr, re);
  }
});
