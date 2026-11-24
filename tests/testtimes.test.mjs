// The Tests tab and `norn tests`: tests vs code over git (history, the tick's daily start), the merge-time copy-paste check, test impact
// (`norn tests for`), which suite a folder holds, the code viewer's path guard (only a file inside the project repo opens) and every
// sub-view of the tab. Sandbox only: temp dirs (mkTmp), the CLI against --state / --repo, a dashboard on temp state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';
import { suiteKind, testsFor, repoFile } from '../engine/lib/testtimes.mjs';
import { classify, gitHistory, copyPaste, tickTests } from '../engine/lib/testscli.mjs';
process.env.TZ = 'UTC';   // the dash prints local time (cells.mjs fmtTime): pin the zone these expectations are written in

test.after(cleanTmp);
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const NORN = path.join(REPO, 'engine', 'bin', 'norn.mjs');
const gitIn = repo => (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
const initRepo = repo => { const g = gitIn(repo); g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('add', '-A'); g('commit', '-q', '-m', 'base'); return g; };
const IMPACT = { at: '2026-11-19T10:00:00Z', sha: 'abc123', suite: 'node:test', sources: { 'engine/x.mjs': ['tests/a.test.mjs', 'tests/b.test.mjs'], 'engine/z.mjs': ['tests/a.test.mjs'] } };
const GIT = { at: '2026-11-19T10:00:00Z', points: [{ day: '2026-11-18', sha: 'a', tests: 961, test_lines: 200, code_lines: 400, test_files: 9 }, { day: '2026-11-19', sha: 'b', tests: 805, test_lines: 150, code_lines: 400, test_files: 8 }] };

test('classify: tests by path convention (tests/, *.test.*, test_*.py, *_test.rs); vendor and non-source skipped', () => {
  assert.deepEqual(['tests/a.test.mjs', 'engine/lib/x.mjs', 'pkg/test_x.py', 'src/a_test.rs', 'engine/dash/vendor/m.js', 'README.md', 'tests/fixtures/x.json']
    .map(classify), ['test', 'code', 'test', 'test', null, null, null]);
});

test('gitHistory: per day the last first-parent commit -> test cases, test lines, code lines', () => {
  const repo = mkTmp('meta-tt-git-');
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: process.env.D, GIT_COMMITTER_DATE: process.env.D } });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, 'tests')); fs.mkdirSync(path.join(repo, 'src'));
  const commit = (day, files) => { for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(repo, f), t); process.env.D = `${day}T12:00:00Z`; g('add', '-A'); g('commit', '-q', '-m', day); };
  commit('2026-01-01', { 'src/a.mjs': 'a\nb\n', 'tests/a.test.mjs': "test('x', () => {});\n" });
  commit('2026-01-02', { 'tests/a.test.mjs': "test('x', () => {});\ntest('y', () => {});\n", 'tests/b.py': 'def test_z():\n  pass\n' });
  commit('2026-01-02', { 'src/a.mjs': 'a\nb\nc\n' });
  delete process.env.D;
  assert.deepEqual(gitHistory(repo).map(({ sha, ...x }) => x), [
    { day: '2026-01-01', tests: 1, test_lines: 1, code_lines: 2, test_files: 1 },
    { day: '2026-01-02', tests: 3, test_lines: 4, code_lines: 3, test_files: 2 }]);
});

test('copyPaste: the share of tokens in a repeated 50-token run, in the file itself or in another file, with the clone lines', () => {
  const block = n => `test('case ${n}', () => {\n  const r = run(['a', 'b', 'c'], { cwd: dir, env: { A: 1, B: 2 } });\n  assert.equal(r.code, 0); assert.match(r.out, /ok/); assert.deepEqual(r.list, [1, 2, 3]);\n});\n`;
  const c = copyPaste(block(1) + block(1));
  assert.ok(c.pct > 40 && c.pct <= 100, `pct ${c.pct}`);
  assert.deepEqual(c.clones[0], { line: 5, with: 'itself' });
  assert.equal(copyPaste(block(1)).pct, 0, 'one copy alone is not a clone');
  const o = copyPaste(block(1), [{ name: 'tests/o.test.mjs', text: '// x\n' + block(1) }]);
  assert.equal(o.pct, 100); assert.equal(o.clones[0].with, 'tests/o.test.mjs');
});

// the merge-time check end to end in a temp node:test repo: advisory only (exit 0), a copy-paste file over 25 % is named
test('norn tests check: no test file changed says so; a changed test file that repeats itself -> a NEW tests-copy-paste advisory in advisories.json', () => {
  const root = mkTmp('meta-tt-check-'), repo = path.join(root, 'repo'), st = path.join(root, 'state');
  const norn = (...a) => spawnSync(process.execPath, [NORN, 'tests', ...a, '--state', st, '--repo', repo], { encoding: 'utf8', cwd: repo });
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'tests', 'x.test.mjs'), "import test from 'node:test';\ntest('x', () => {});\n");
  const g = initRepo(repo);
  let r = norn('check', '--base', 'HEAD');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /tests check: no test file changed/);
  const dup = "test('y', () => { const r = run(['a', 'b', 'c'], { cwd: dir, env: { A: 1, B: 2 } }); assert.equal(r.code, 0); assert.match(r.out, /ok/); });\n";
  fs.writeFileSync(path.join(repo, 'tests', 'y.test.mjs'), dup + dup);
  g('add', '-A'); g('commit', '-q', '-m', 'y');
  r = norn('check', '--base', 'HEAD~1');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /1 changed test file\(s\), 1 advisory finding\(s\) - advisory, never a merge block/);
  assert.match(r.stdout, /NEW tests-copy-paste tests\/y\.test\.mjs: \d+(\.\d)?% of its tokens/);
  const adv = JSON.parse(fs.readFileSync(path.join(st, 'tests', 'advisories.json'), 'utf8'));
  assert.deepEqual([adv.base, adv.files, adv.list.map(a => [a.key, a.phase, a.fix.tier])], ['HEAD~1', ['tests/y.test.mjs'], [['tests-copy-paste', 'TESTS', 'card']]]);
  assert.equal(norn('check').status, 2, 'check needs --base');
  for (const gone of ['measure', 'lean', 'gate', 'mutation']) assert.match(norn(gone).stderr, new RegExp(`unknown verb ${gone}`));
});

// a pytest project (Solve Shack): check answers that it read nothing (it said "no test file changed" on every merge); history still
// works; the tick starts `norn tests history` once a day so the charts fill
test('a pytest project: check says it reads node:test only (exit 0), history still works; tickTests once a day', () => {
  const root = mkTmp('meta-tt-py-'), repo = path.join(root, 'repo'), st = path.join(root, 'state');
  const norn = (...a) => spawnSync(process.execPath, [NORN, 'tests', ...a, '--state', st, '--repo', repo], { encoding: 'utf8', cwd: repo });
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'tests', 'test_x.py'), 'def test_x():\n    assert 1\n');
  initRepo(repo);
  let r = norn('check', '--base', 'HEAD');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /a pytest suite .*the merge check reads node:test only - nothing checked/);
  r = norn('history'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /1 day\(s\) of history; .*: 1 test cases, 2 test lines/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(st, 'tests', 'git-history.json'), 'utf8')).points.length, 1);
  const calls = [], spawnFn = (exe, args) => (calls.push(args), { pid: 1 }), st2 = mkTmp('meta-tt-tick-');
  assert.match(tickTests({ file: 'p.json', root: repo }, st2, { metaCmd: 'norn.mjs', spawnFn }), /tests history: started pid 1/);
  assert.equal(tickTests({ file: 'p.json', root: repo }, st2, { metaCmd: 'norn.mjs', spawnFn }), null, 'not twice within 30 min');
  assert.deepEqual(calls[0].slice(1, 3), ['tests', 'history']);
  assert.equal(tickTests({ file: 'p.json', root: repo }, st, { metaCmd: 'norn.mjs', spawnFn }), null, 'history written today: nothing to start');
});

test('testsFor + norn tests for: a source file -> the test files that cover it (impact.json); a test file is itself; unknown says so', () => {
  const a = testsFor(IMPACT, ['engine\\z.mjs', 'tests/b.test.mjs', 'engine/none.mjs']);
  assert.deepEqual(a.rows, [{ file: 'engine/z.mjs', tests: ['tests/a.test.mjs'], known: true }, { file: 'tests/b.test.mjs', tests: ['tests/b.test.mjs'], known: true }, { file: 'engine/none.mjs', tests: [], known: false }]);
  assert.deepEqual(a.tests, ['tests/a.test.mjs', 'tests/b.test.mjs']);
  const root = mkTmp('meta-tt-for-'), repo = path.join(root, 'repo'), st = path.join(root, 'state');
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true }); fs.writeFileSync(path.join(repo, 'tests', 'a.test.mjs'), '');
  initRepo(repo);
  const norn = (...a) => spawnSync(process.execPath, [NORN, 'tests', 'for', ...a, '--state', st, '--repo', repo], { encoding: 'utf8', cwd: repo });
  let r = norn('engine/x.mjs');
  assert.equal(r.status, 2); assert.match(r.stderr, /no impact map \(.*impact\.json does not exist\)/);
  fs.mkdirSync(path.join(st, 'tests'), { recursive: true }); fs.writeFileSync(path.join(st, 'tests', 'impact.json'), JSON.stringify(IMPACT));
  r = norn('engine/x.mjs', 'engine/nope.mjs');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /engine\/x\.mjs: tests\/a\.test\.mjs tests\/b\.test\.mjs/); assert.match(r.stdout, /engine\/nope\.mjs: not in the impact map's coverage/);
  assert.match(r.stdout, /2 test file\(s\) to run \(the impact map at abc123/);
  assert.equal(norn().status, 2);
});

test('suiteKind: which suite a folder holds (node:test, pytest one folder down, neither)', () => {
  const d = mkTmp('meta-tt-kind-');
  assert.equal(suiteKind(d), null);
  fs.mkdirSync(path.join(d, 'tests', 'unit'), { recursive: true }); fs.writeFileSync(path.join(d, 'tests', 'unit', 'test_a.py'), '');
  assert.equal(suiteKind(d), 'pytest', 'one folder down');
  fs.writeFileSync(path.join(d, 'tests', 'x.test.mjs'), '');
  assert.equal(suiteKind(d), 'node:test');
});

test('repoFile (the code viewer\'s guard): only a file inside the project repo - no absolute path, no .. out, no link out, nothing under .git', () => {
  const root = mkTmp('meta-tt-guard-'), repo = path.join(root, 'repo'), out = path.join(root, 'outside');
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true }); fs.mkdirSync(path.join(repo, '.git')); fs.mkdirSync(out);
  fs.writeFileSync(path.join(repo, 'tests', 'a.test.mjs'), 'x'); fs.writeFileSync(path.join(repo, '.git', 'config'), 'secret'); fs.writeFileSync(path.join(out, 'b.txt'), 'secret');
  assert.equal(repoFile(repo, 'tests/a.test.mjs'), fs.realpathSync.native(path.join(repo, 'tests', 'a.test.mjs')));
  assert.ok(repoFile(repo, 'tests\\a.test.mjs'), 'a backslash path inside is fine');
  for (const bad of ['../outside/b.txt', 'tests/../../outside/b.txt', path.join(out, 'b.txt'), '/etc/passwd', 'C:/Windows/win.ini', '.git/config', 'tests', 'tests/missing.mjs', '', 'tests/a.test.mjs\0'])
    assert.equal(repoFile(repo, bad), null, JSON.stringify(bad));
  let linked = true;
  try { fs.symlinkSync(out, path.join(repo, 'tests', 'link'), 'junction'); } catch { linked = false; }
  if (linked) assert.equal(repoFile(repo, 'tests/link/b.txt'), null, 'a junction / link out of the repo');
});

// the dashboard: /api/tests = the summary (+ the open alerts the test machinery raised), ?part= one sub-view; /api/source opens a
// test's file only from inside the project repo
async function tabFixture() {
  const { fixture } = await import('./helpers/dash-fixture.mjs'), { record } = await import('../engine/lib/records.mjs');
  const f = await fixture(), d = path.join(f.pa.state, 'tests'), repo = f.pa.root;
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true }); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(repo, 'tests', 'a.test.mjs'), Array.from({ length: 80 }, (_, i) => (i === 59 ? "test('two <slow>', async () => { await new Promise(r => setTimeout(r, 300)); });" : `// line ${i + 1} of a long test file that wraps on a phone: ${'x'.repeat(i % 7 * 20)}`)).join('\n'));
  fs.writeFileSync(path.join(f.root, 'secret.txt'), 'outside the repo');
  fs.writeFileSync(path.join(d, 'impact.json'), JSON.stringify(IMPACT)); fs.writeFileSync(path.join(d, 'git-history.json'), JSON.stringify(GIT));
  fs.writeFileSync(path.join(d, 'advisories.json'), JSON.stringify({ at: GIT.at, base: 'origin/main', head: 'def456', files: ['tests/a.test.mjs'], list: [{ id: 'A-1', key: 'tests-copy-paste', severity: 'low', path: 'tests/a.test.mjs', why: '40% of its tokens are in a 50-token run that is repeated (limit 25%)', fix: { tier: 'card', action: 'fold the copies into one helper or a table of cases' }, new: true }] }));
  fs.mkdirSync(path.join(f.pa.state, 'mq'), { recursive: true });
  fs.writeFileSync(path.join(f.pa.state, 'mq', 'batch-3.json'), JSON.stringify({ n: 3, status: 'merged', result: 'green', gate: 'node engine/bin/ci-suite.mjs', built: GIT.at, done_at: GIT.at, members: [{ id: 'RUN-5' }], runs: [{ label: 'tip', ok: true, ms: 61000 }] }));
  record(f.pa.state, { kind: 'question', ev: 'create', by: 'controller', data: { title: 'tests/a.test.mjs::outer::two failed 3 times under load', lane: 'gen', area: 'tests', options: [{ key: 'a', text: 'quarantine this test' }, { key: 'b', text: 'open a fix lane' }], recommend: { key: 'a', why: 'passes alone' } } });
  return f;
}
test('Tests tab: the summary (numbers, alerts as Inbox questions) and each sub-view\'s part; Impact for files; the source guard; beside Spend in More', async () => {
  const { loadTab, renderTab } = await import('../engine/dash/ui.mjs'), { TESTS_SUBS, codeView } = await import('../engine/dash/testparts.mjs');
  const { renderMore } = await import('../engine/dash/shell.mjs');
  const f = await tabFixture(), get = async p => (await f.get(p)).data, now = Date.parse('2026-11-19T12:00:00Z');
  try {
    const view = async (sub, batch) => { const d = await loadTab('tests', 'kestrel', get, { sub, batch }); return { d, html: renderTab('tests', d, { now }) }; };
    assert.deepEqual(TESTS_SUBS.map(x => x[1]), ['Suite', 'Costs and health', 'Impact', 'Run time'], '4 sub-views (CLAUDE.md: never a fifth)');
    const first = await loadTab('tests', 'kestrel', get);
    assert.deepEqual([first.project, first.sub, first.git.points.length], ['kestrel', 'suite', 2]);
    const s = await view('suite');
    assert.equal(s.d.alerts.length, 1);
    assert.match(s.html, /id="tests-alerts"[^]*failed 3 times under load[^]*data-act="answer"[^]*data-choice="a"[^]*quarantine this test - recommended[^]*data-tab="inbox"/);
    assert.match(s.html, /id="tests-sum"[^]*<b class="mono">805<\/b><span class="small mute">test cases \(git\)[^]*<b class="mono">0\.38:1<\/b><span class="small mute">test lines per code line[^]*alerts: they need you/);
    for (const re of [/id="tests-time"/, /data-chart="tests-count"/, /data-chart="tests-lines"/]) assert.match(s.html, re);
    assert.match(s.html, /aria-label="test cases per day \(tests\), 2026-11-18 to 2026-11-19: test cases 805"/);   // UX review 6: the unit in the label
    assert.doesNotMatch(s.html, /id="tests-scope"/, 'git history there: no banner');
    const c = await view('costs');
    assert.match(c.html, /id="tests-merges"[^]*batch-3<\/b> <b class="mono">61 s<\/b>[^]*node engine\/bin\/ci-suite\.mjs/);
    assert.match(c.html, /id="tests-adv"[^]*def456 vs origin\/main · 1 changed test file\(s\)[^]*tests-copy-paste[^]*new[^]*tests\/a\.test\.mjs/);
    const i = await view('impact', 'files:engine/z.mjs,engine/none.mjs');
    assert.match(i.html, /from impact\.json \(2026-11-19T10:00, abc123\)/);
    assert.match(i.html, /2 file\(s\) → <b>1 test file\(s\)<\/b>/); assert.match(i.html, /engine\/none\.mjs<\/span> <span class="small mute">not in the impact map/);
    assert.match(i.html, /data-act="test-src" data-file="tests\/a\.test\.mjs"/);
    assert.match(i.html, /norn tests for engine\/z\.mjs engine\/none\.mjs/);
    const nl = await view('impact', 'lane:nope');
    assert.match(nl.html, /refused<\/span> no lane nope in kestrel/);
    const rt = await view('runtime');
    assert.match(rt.html, /id="tests-runtime"[^]*aria-pressed="true"[^>]*>24 h[^]*over budget[^]*In force: <b>policy\.tests: mode light, budget 3 min, browser ci, full suite deny<\/b>/);
    assert.match(rt.html, /data-act="open-setting" data-setting="policy\.tests\.run_budget_min"/);
    assert.match(rt.html, /id="tests-rt-rows"><li data-run="RUN-\d+"/, "the fixture's worker run is listed");
    // the code viewer: inside the repo only
    const r = await f.get('/api/source?project=kestrel&file=tests/a.test.mjs');
    assert.equal(r.status, 200); assert.equal(r.data.lines, 80); assert.match(r.data.text, /two <slow>/);
    for (const bad of ['../secret.txt', 'tests/../../secret.txt', path.join(f.root, 'secret.txt'), '.git/config', ''])
      assert.equal((await f.get(`/api/source?project=kestrel&file=${encodeURIComponent(bad)}`)).status, 403, bad);
    const cv = codeView({ file: 'tests/a.test.mjs', text: r.data.text, line: 60 });
    assert.match(cv, /<tr id="srcl-60" class="focus" data-focus="1"><td class="ln mute">60<\/td><td class="lt"><code class="hljs"><span class="hljs-title function_">test<\/span>/);
    assert.match(cv, /&lt;slow&gt;/, 'escaped');
  } finally { await f.done(); }
  assert.match(renderMore('tests', {}), /<h3>Health<\/h3><ul>[^]*data-tab="spend"[^]*data-tab="tests" aria-current="page"/, 'beside Spend under Health in More (stage NAV)');
});

// an empty page says why and what fills it; a pytest project's merge check says node:test only itself; the banner is only for a suite Norn
// cannot read (its git charts still fill)
test('Tests tab: nothing yet, a pytest project, a suite Norn cannot read', async () => {
  const { renderTab } = await import('../engine/dash/ui.mjs');
  const base = { project: 'ss', git: null, alerts: [], advisories: null, commands: { history: 'norn tests history', for: 'norn tests for' } };
  const empty = renderTab('tests', { ...base, sub: 'suite' }, {});
  assert.match(empty, /id="tests-scope"[^>]*>Nothing yet\. The tick fills the charts under <b>Suite<\/b> from git once a day/);
  assert.match(empty, /no history yet/);
  const costs = renderTab('tests', { ...base, suite: 'pytest', git: GIT, sub: 'costs', merges: [] }, {});
  assert.doesNotMatch(costs, /id="tests-scope"/, 'no banner for a pytest suite');
  assert.match(costs, /id="tests-adv"[^]*node:test only[^]*this project's suite is pytest/);
  const neither = renderTab('tests', { ...base, suite: false, git: GIT, sub: 'suite' }, {});
  assert.match(neither, /id="tests-scope"[^]*node:test suites \(tests\/\*\.test\.mjs\) and pytest suites[^]*this project's tests\/ holds neither/);
  assert.match(neither, /id="tests-time"/, 'the git charts still fill');
});

test('the browser: Tests at 390 px - every sub-view without sideways scroll; a test file Impact names opens in the code viewer', { skip: skipWhy, timeout: 240000 }, async () => {
  const f = await tabFixture(), pg = await openPage([390, 844]);
  try {
    await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await pg.go(`${f.url}/?project=kestrel&tab=tests`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'tests' && !!document.querySelector('#tests-time')`, 90000), 'Suite loads');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll (Suite)');
    for (const sub of ['costs', 'impact', 'runtime']) {
      await pg.ev(`document.querySelector('#tests-sub-${sub}').click()`);
      assert.ok(await pg.until(`document.querySelector('#tests-sub')?.dataset.sub === '${sub}' && !document.querySelector('#tests-sub-loading')`, 60000), sub);
      assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, `no sideways scroll (${sub})`);
    }
    assert.match(await pg.ev('location.search'), /sub=runtime/);
    await pg.ev(`document.querySelector('#tests-sub-impact').click()`);
    assert.ok(await pg.until(`!!document.querySelector('#tests-impact-files') && !document.querySelector('#tests-sub-loading')`, 60000));
    await pg.ev(`(() => { document.querySelector('#tests-impact-files').value = 'engine/z.mjs'; document.querySelector('[data-act=tests-impact]').click(); })()`);
    assert.ok(await pg.until(`!!document.querySelector('#tests-impact-out [data-act=test-src]')`, 60000), 'Impact names the test file');
    await pg.ev(`document.querySelector('#tests-impact-out [data-act=test-src]').click()`);
    assert.ok(await pg.until(`!document.querySelector('#srcview').hidden && document.querySelectorAll('#srcview-code tr').length === 80`, 30000), 'the viewer opens the file');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll (viewer)');
  } finally { await pg.close(); await f.done(); }
});


// test-diet S1: the Run time view - per worker run its wall vs test time, the duplicates the test cache spared it, over budget, the policy
test('Run time: runtimePart folds runs + the cache log + policy.tests; the view filters by window, over budget and saved', async () => {
  const { runtimePart } = await import('../engine/lib/testscli.mjs'), { renderTab } = await import('../engine/dash/ui.mjs');
  const now = Date.parse('2026-11-20T12:00:00Z'), ago = h => new Date(now - h * 3600e3).toISOString();
  const runs = [{ id: 'RUN-1', lane: 'ui', state: 'exited', started: ago(2), ended: ago(1), speed: { wall_ms: 3600e3, test_ms: 900e3 } },
    { id: 'RUN-2', lane: 'git', state: 'running', started: ago(0.5), ended: null, speed: { wall_ms: 1800e3, test_ms: 60e3 } },
    { id: 'RUN-3', lane: 'old', state: 'exited', started: ago(40), ended: ago(39), speed: null },
    { id: 'RUN-4', lane: 'gone', state: 'exited', started: ago(100), ended: ago(99), speed: null }];
  const cache = [{ run: 'RUN-2', how: 'reused', saved_ms: 20000 }, { run: 'RUN-2', how: 'waited', saved_ms: 5000 }, { run: 'RUN-1', how: 'ran', saved_ms: 0 }, { run: null, how: 'reused', saved_ms: 1 }];
  const p = runtimePart({ runs, cache, policy: { tests: { run_budget_min: 5 } }, now });
  assert.equal(p.words, 'policy.tests: mode light, budget 5 min, browser ci, full suite deny');
  assert.deepEqual(p.settings, ['policy.tests.mode', 'policy.tests.run_budget_min', 'policy.tests.browser', 'policy.tests.full_suite']);
  assert.deepEqual(p.rows.map(r => [r.id, r.test_pct, r.over, r.dup, r.saved_ms]), [['RUN-2', 3.3, false, 2, 25000], ['RUN-1', 25, true, 0, 0], ['RUN-3', null, false, 0, 0]], 'newest first; 3 days only');
  const page = (testsRt = {}) => renderTab('tests', { project: 'k', git: null, alerts: [], commands: { history: 'norn tests history' }, sub: 'runtime', ...p }, { now, testsRt });
  const day = page();
  assert.match(day, /2 runs: 16 min of 1 h 30 in tests \(18 %\), 25 s saved by the cache/);
  assert.match(day, /data-run="RUN-2"[^]*running[^]*cache: 2 duplicates spared, 25 s saved/);
  assert.match(day, /data-run="RUN-1"[^]*over budget[^]*\(<b>25 %<\/b>\)/);
  assert.doesNotMatch(day, /data-run="RUN-3"/, '24 h window');
  assert.match(page({ window: '3d' }), /data-run="RUN-3"[^]*no transcript: no split/);
  assert.deepEqual([...page({ over: true }).matchAll(/<li data-run="([^"]+)"/g)].map(m => m[1]), ['RUN-1']);
  assert.deepEqual([...page({ saved: true }).matchAll(/<li data-run="([^"]+)"/g)].map(m => m[1]), ['RUN-2']);
  assert.match(day, /data-go="runs" data-gojump="node-RUN-1"/);
});
