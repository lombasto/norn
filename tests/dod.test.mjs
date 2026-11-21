// META-DOD 1 (owner DIR-68): the Definition of Ready (a brief's Scope / Tests / Done lines, checked by `norn run` per policy.dod.ready)
// and the Definition of Done (Norn's own check at the run end: a clean tree, every changed path in Scope, the brief's Tests + the
// project's fast gate run by Norn; a fail resumes the worker once with the evidence, a second fail is STOPPED for the check-in).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readyGate, testCounts, doneCheck, dodPrompt, DOCS_ONLY } from '../engine/lib/dod.mjs';
import { parseReady, inScope } from '../engine/lib/ready.mjs';
import { SETTINGS, sectionOf, withDefaults } from '../engine/lib/policy.mjs';
import { loadState } from '../engine/lib/records.mjs';
import { agentsTree } from '../engine/lib/agents.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { settled } from './helpers/settled.mjs';
import { waitFor, stateBusy } from './helpers/wait.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const NORN = path.join(import.meta.dirname, '..', 'engine', 'bin', 'norn.mjs');
const fwd = p => p.split(path.sep).join('/');
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
// policy.tests.mode = changed: the brief's Tests line and the gate as written (light, the default, has its own tests below)
const CHANGED = { mode: 'changed' };
const READY = 'Scope: src/**, README.md\nTests: `node -e "console.log(\'# pass 3\'); console.log(\'# fail 0\')"`\nDone: ## DONE\n';

/** a repo on main + a lane worktree feat/x with one committed change to `file` */
function laneRepo(root, file = 'src/a.mjs') {
  const repo = path.join(root, 'repo'), wt = path.join(root, 'wt');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'README.md'), 'r\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'r');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
  fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true });
  fs.writeFileSync(path.join(wt, file), 'export const a = 1;\n'); git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'a');
  return { repo, wt };
}

test('parseReady: the three plain lines (bullets allowed), Scope split into paths / globs, Tests keeps its text; missing ones named', () => {
  const r = parseReady('# brief\n\n- Scope: engine/lib/**, engine/bin/norn.mjs, `tests/**`, docs.\nTests: tests/dod.test.mjs + `node -e 1`\nDone: READY TO MERGE <sha> + ## DONE\n');
  assert.deepEqual(r.scope, ['engine/lib/**', 'engine/bin/norn.mjs', 'tests/**', 'docs']);
  assert.equal(r.tests, 'tests/dod.test.mjs + `node -e 1`');
  assert.equal(r.done, 'READY TO MERGE <sha> + ## DONE');
  assert.deepEqual(r.missing, []);
  assert.deepEqual(parseReady('# brief\nScope: a/**\n').missing, ['Tests:', 'Done:']);
  assert.deepEqual(parseReady('Scope:\nTests: x\nDone: y\n').missing, ['Scope:'], 'an empty line is missing');
  assert.deepEqual(parseReady(null).missing, ['Scope:', 'Tests:', 'Done:']);
});

test('inScope: ** / * globs, a bare name = that file or folder, nothing else', () => {
  const s = ['engine/lib/**', 'engine/bin/norn.mjs', 'tests/*.test.mjs', 'docs'];
  for (const p of ['engine/lib/dod.mjs', 'engine/lib/slop/x.mjs', 'engine/bin/norn.mjs', 'tests/dod.test.mjs', 'docs', 'docs/a/b.md']) assert.ok(inScope(p, s), p);
  for (const p of ['engine/bin/x.mjs', 'tests/helpers/x.mjs', 'docsx/a.md', 'README.md', 'engine/libx/a.mjs']) assert.ok(!inScope(p, s), p);
});

test('readyGate: policy.dod.ready off | warn | refuse (default off); a MERGE stage brief is Norn\'s own and exempt', () => {
  const t = mkTmp('meta-dod-ready-'), bad = path.join(t, 'bad.md'), good = path.join(t, 'good.md');
  fs.writeFileSync(bad, '# x\nScope: a/**\n'); fs.writeFileSync(good, READY);
  assert.equal(withDefaults({}).policy.dod.ready, 'off');
  assert.deepEqual(readyGate({ brief: bad, policy: {} }).refused, null);
  const w = readyGate({ brief: bad, policy: { dod: { ready: 'warn' } } });
  assert.equal(w.refused, null); assert.match(w.warning, /lacks Tests:, Done:/);
  const r = readyGate({ brief: bad, policy: { dod: { ready: 'refuse' } } });
  assert.match(r.refused, /bad\.md lacks Tests:, Done: \(policy\.dod\.ready = refuse\): add the lines Scope: \/ Tests: \/ Done:/);
  assert.equal(readyGate({ brief: bad, policy: { dod: { ready: 'refuse' } }, stage: 'MERGE' }).refused, null);
  const g = readyGate({ brief: good, policy: { dod: { ready: 'refuse' } } });
  assert.equal(g.refused, null); assert.deepEqual(g.dod.ready.scope, ['src/**', 'README.md']); assert.equal(g.dod.ok, true);
  assert.deepEqual(g.dod.tests, { mode: 'light', run_budget_min: 3, browser: 'ci', full_suite: 'deny' }, 'policy.tests rides on the spec');
  assert.deepEqual(readyGate({ brief: good, policy: { dod: { ready: 'warn' }, tests: { mode: 'off', run_budget_min: 9 } } }).dod.tests, { mode: 'off', run_budget_min: 9, browser: 'ci', full_suite: 'deny' });
  assert.match(readyGate({ brief: path.join(t, 'none.md'), policy: { dod: { ready: 'refuse' } } }).refused, /not readable/);
  const row = SETTINGS.find(s => s.key === 'policy.dod.ready');
  assert.deepEqual([row.type, row.options, sectionOf(row).join('/')], ['enum', ['off', 'warn', 'refuse'], 'agents/rounds']);
});

test('testCounts: node test / TAP and pytest summaries; none = null', () => {
  assert.deepEqual(testCounts('ℹ tests 5\nℹ pass 4\nℹ fail 1\n'), { pass: 4, fail: 1 });
  assert.deepEqual(testCounts('# pass 2\n# fail 0\n# pass 3\n# fail 1\n'), { pass: 5, fail: 1 });
  assert.deepEqual(testCounts('==== 12 passed, 2 failed in 3.1s ===='), { pass: 12, fail: 2 });
  assert.equal(testCounts('nothing here'), null);
});

test('doneCheck: green = clean tree, changes in Scope, Tests + gate exit 0 with counts and logs - Norn\'s own record', async () => {
  const t = mkTmp('meta-dod-green-'), { wt } = laneRepo(t);
  const d = await doneCheck({ worktree: wt, dod: { ready: parseReady(READY), tests: CHANGED, gate: { cmd: 'node -e "console.log(\'ℹ pass 7\')"' } }, logDir: path.join(t, 'logs'), run: 'RUN-1' });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.deepEqual(d.changed, ['src/a.mjs']);
  assert.deepEqual(d.tests.map(x => [x.name, x.code, x.ok, x.counts]), [['tests', 0, true, { pass: 3, fail: 0 }], ['gate', 0, true, { pass: 7, fail: 0 }]]);
  for (const x of d.tests) assert.ok(fs.existsSync(x.log), x.log);
  assert.ok(d.at && d.head);
});

// RUN-1063 / RUN-1072 (11-15): a README + 2 pictures branch stopped twice - the full-suite gate timed out at 997 pass, 0 fail.
// CI runs no suite for such a push and the docs-only MERGE runs none either: the Done check skips its gate the same way.
test('doneCheck: a docs-only branch (the CI paths-ignore) skips the gate, its Tests still run; one code file brings the gate back', async () => {
  const t = mkTmp('meta-dod-docs-'), { wt } = laneRepo(t, 'docs/img/a.png');
  fs.writeFileSync(path.join(wt, 'README.md'), 'r2\n'); git(wt, 'commit', '-q', '-am', 'readme');
  const tests = 'Tests: `node -e "console.log(\'# pass 1\')"`\nDone: ## DONE\n', gate = { cmd: 'node -e "process.exit(1)"' };
  const d = await doneCheck({ worktree: wt, dod: { ready: parseReady(`Scope: README.md, docs/**\n${tests}`), tests: CHANGED, gate }, logDir: path.join(t, 'logs'), run: 'RUN-1' });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.deepEqual(d.tests.map(x => x.name), ['tests'], 'no gate job');
  assert.match(d.gate_skipped, /docs-only/);
  fs.writeFileSync(path.join(wt, 'a.mjs'), 'x\n'); git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'code');
  const c = await doneCheck({ worktree: wt, dod: { ready: parseReady(`Scope: README.md, docs/**, a.mjs\n${tests}`), tests: CHANGED, gate }, logDir: path.join(t, 'logs'), run: 'RUN-2' });
  assert.deepEqual(c.tests.map(x => [x.name, x.ok]), [['tests', true], ['gate', false]], 'a code change runs the gate');
  assert.equal(c.gate_skipped, undefined);
});

test('DOCS_ONLY is the paths-ignore of .github/workflows/ci.yml (push to main)', () => {
  const yml = fs.readFileSync(path.join(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  const lists = [...yml.matchAll(/paths-ignore:\n((?:\s+- .+\n)+)/g)].map(m => [...m[1].matchAll(/- '([^']+)'/g)].map(x => x[1]));
  assert.equal(lists.length, 1);
  for (const l of lists) assert.deepEqual(l, DOCS_ONLY);
});

test('doneCheck: an untracked file, a path outside Scope and a red test each fail with the evidence', async () => {
  const t = mkTmp('meta-dod-red-'), { wt } = laneRepo(t, 'lib/b.mjs');
  fs.writeFileSync(path.join(wt, 'stray.txt'), 'x');
  const ready = parseReady('Scope: src/**\nTests: tests/a.test.mjs\nDone: ## DONE\n');
  fs.mkdirSync(path.join(wt, 'tests')); fs.writeFileSync(path.join(wt, 'tests', 'a.test.mjs'), '');
  git(wt, 'add', 'tests'); git(wt, 'commit', '-q', '-m', 't');
  const d = await doneCheck({ worktree: wt, dod: { ready, tests: CHANGED, test_cmd: 'node -e "process.exit(3)" -- {files}' }, logDir: path.join(t, 'logs'), run: 'RUN-2' });
  assert.equal(d.ok, false);
  assert.deepEqual(d.dirty, ['stray.txt']);
  assert.deepEqual(d.out_of_scope, ['lib/b.mjs', 'tests/a.test.mjs']);
  assert.deepEqual(d.tests.map(x => [x.name, x.cmd, x.code, x.ok]), [['tests', 'node -e "process.exit(3)" -- tests/a.test.mjs', 3, false]]);
  assert.match(d.why, /1 uncommitted \/ untracked file\(s\); 2 changed path\(s\) outside Scope; tests exit 3/);
  assert.match(dodPrompt(d, 'B.md'), /stray\.txt[\s\S]*lib\/b\.mjs[\s\S]*exit 3[\s\S]*B\.md/);
  const none = await doneCheck({ worktree: wt, dod: { ready: parseReady('Scope: **\nTests: the suite\nDone: x\n'), tests: CHANGED }, logDir: path.join(t, 'l2'), run: 'RUN-3' });
  assert.match(none.why, /Tests: nothing runnable/);
});

test('doneCheck: the NOTES file and its shots are allowed beside Scope', async () => {
  const t = mkTmp('meta-dod-notes-'), { wt } = laneRepo(t, 'src/a.mjs');
  fs.mkdirSync(path.join(wt, 'notes')); fs.writeFileSync(path.join(wt, 'notes', 'N.md'), 'n'); fs.writeFileSync(path.join(wt, 'notes', 'v-dark.png'), 'p');
  fs.writeFileSync(path.join(wt, 'notes', 'other.mjs'), 'o');
  git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'n');
  const d = await doneCheck({ worktree: wt, dod: { ready: parseReady(READY), notes: path.join(wt, 'notes', 'N.md') }, logDir: path.join(t, 'logs'), run: 'RUN-4' });
  assert.deepEqual(d.out_of_scope, ['notes/other.mjs']);
});

// test-diet S1: the Done check follows policy.tests. A lane that changed src/a.mjs (tests/a.test.mjs covers it) and src/b.mjs (no test).
function lightLane(t, { red = false } = {}) {
  const { wt } = laneRepo(t);
  fs.mkdirSync(path.join(wt, 'tests'));
  fs.writeFileSync(path.join(wt, 'tests', 'a.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { a } from '../src/a.mjs';\ntest('a', () => assert.equal(a, ${red ? 2 : 1}));\n`);
  fs.writeFileSync(path.join(wt, 'tests', 'z.test.mjs'), "import test from 'node:test';\ntest('z', () => {});\n");
  fs.writeFileSync(path.join(wt, 'src', 'b.mjs'), 'export const b = 1;\n');
  git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'tests');
  return { wt, cache: path.join(t, 'cache'), logDir: path.join(t, 'logs') };
}
const LIGHT_READY = parseReady('Scope: src/**, tests/**\nTests: light (policy.tests)\nDone: ## DONE\n'), GATE = { cmd: 'node -e "process.exit(1)"' };

test('doneCheck light: the light set runs through the test cache (a second check reuses it), no gate, the uncovered module named; a red fails', async () => {
  const t = mkTmp('meta-dod-light-'), { wt, cache, logDir } = lightLane(t);
  const d = await doneCheck({ worktree: wt, dod: { ready: LIGHT_READY, gate: GATE }, logDir, run: 'RUN-1', cache });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.deepEqual(d.tests.map(x => [x.name, x.cmd, x.ok, x.cached]), [['tests/a.test.mjs', 'norn tests run tests/a.test.mjs', true, 'ran'], ['tests/z.test.mjs', 'norn tests run tests/z.test.mjs', true, 'ran']]);
  assert.deepEqual(d.tests[0].counts, { pass: 1, fail: 0 });
  assert.match(d.gate_skipped, /light set replaces the gate; CI runs the rest/);
  assert.deepEqual(d.tests_uncovered, ['src/b.mjs']);
  assert.match(fs.readFileSync(d.tests[0].log, 'utf8'), /pass tests\/a\.test\.mjs ran/);
  const again = await doneCheck({ worktree: wt, dod: { ready: LIGHT_READY, gate: GATE }, logDir, run: 'RUN-2', cache });
  assert.deepEqual(again.tests.map(x => [x.cached, x.by]), [['reused', 'RUN-1'], ['reused', 'RUN-1']], 'the same content: no second run');
  const u = mkTmp('meta-dod-light-red-'), r = lightLane(u, { red: true });
  const red = await doneCheck({ worktree: r.wt, dod: { ready: LIGHT_READY }, logDir: r.logDir, run: 'RUN-3', cache: r.cache });
  assert.equal(red.ok, false);
  assert.match(red.why, /tests\/a\.test\.mjs exit 1/);
  assert.match(fs.readFileSync(red.tests[0].log, 'utf8'), /FAIL tests\/a\.test\.mjs ran[\s\S]*strictly equal/, 'a red\'s output tail in the log');
});

test('doneCheck light: the Tests line\'s node test files join the set, its other commands run as written; past run_budget_min nothing more starts - left to CI, not red', async () => {
  const t = mkTmp('meta-dod-budget-'), { wt, cache, logDir } = lightLane(t);
  const ready = parseReady('Scope: src/**, tests/**\nTests: `node --test tests/z.test.mjs` and `node -e "console.log(\'# pass 1\')"`\nDone: x\n');
  const all = await doneCheck({ worktree: wt, dod: { ready, tests: { run_budget_min: 0 } }, logDir, run: 'RUN-1', cache });
  assert.equal(all.ok, true, JSON.stringify(all));
  assert.deepEqual(all.tests.map(x => x.name), ['tests/a.test.mjs', 'tests/z.test.mjs', 'tests'], 'budget 0 = none: every job runs');
  assert.equal(all.tests[2].cmd, 'node -e "console.log(\'# pass 1\')"');
  const cut = await doneCheck({ worktree: wt, dod: { ready, tests: { run_budget_min: 0.002 } }, logDir, run: 'RUN-2', cache: path.join(t, 'cache2') });
  assert.equal(cut.ok, true, 'what the budget left is unknown, not red');
  assert.deepEqual(cut.tests.map(x => x.name), ['tests/a.test.mjs']);
  assert.deepEqual(cut.tests_left, ['tests/z.test.mjs', 'node -e "console.log(\'# pass 1\')"']);
  assert.match(cut.tests_left_why, /run_budget_min = 0\.002 spent in the Done check: left to CI \(unknown, not a pass\)/);
});

test('doneCheck off: no tests and no gate, said so; Tests: none still holds a writing run to its word', async () => {
  const t = mkTmp('meta-dod-off-'), { wt, cache, logDir } = lightLane(t);
  const d = await doneCheck({ worktree: wt, dod: { ready: LIGHT_READY, gate: GATE, tests: { mode: 'off' } }, logDir, run: 'RUN-1', cache });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.deepEqual(d.tests, []);
  assert.match(d.tests_off, /policy\.tests\.mode = off: the Done check runs no tests and no gate/);
  assert.match(d.gate_skipped, /mode = off/);
  const none = await doneCheck({ worktree: wt, dod: { ready: parseReady('Scope: **\nTests: none - a design\nDone: x\n'), tests: { mode: 'off' } }, logDir, run: 'RUN-2', cache });
  assert.match(none.why, /the brief declares no tests/);
});

/** a sandboxed project + `norn run --executor fake` on the lane worktree; -> { r, state } */
function normRun(t, wt, repo, { brief, policy, gate }) {
  const state = path.join(t, 'state', 'kestrel'), pf = path.join(t, 'project.json');
  fs.writeFileSync(pf, JSON.stringify({ schema: 1, name: 'kestrel', title: 'k', root: fwd(repo), ledger: '${root}/L.md', briefs_dir: '${root}', policy, ...(gate ? { merge: { gate } } : {}) }));
  const bf = path.join(t, 'brief.md'); fs.writeFileSync(bf, brief);
  const env = { ...process.env, META_ROOT: t, HOME: t, USERPROFILE: t, META_HB_MS: '150' };
  const r = spawnSync(process.execPath, [NORN, 'run', '--executor', 'fake', '--project', pf, '--state', state, '--locks', path.join(t, 'locks'), '--lane', 'x',
    '--brief', bf, '--worktree', wt, '--notes', path.join(t, 'NOTES.md'), '--no-tick'], { encoding: 'utf8', env });
  return { r, state };
}

test('norn run refuses a brief without the Ready lines (refuse, exit 6), warns (warn), says nothing (off)', async () => {
  const t = mkTmp('meta-dod-run-'), { repo, wt } = laneRepo(t);
  const a = normRun(t, wt, repo, { brief: 'mode: done\n', policy: { dod: { ready: 'refuse' } } });
  assert.equal(a.r.status, 6, a.r.stdout + a.r.stderr);
  assert.match(a.r.stdout, /^REFUSED: brief .*brief\.md lacks Scope:, Tests:, Done: \(policy\.dod\.ready = refuse\)/m);
  assert.ok(!fs.existsSync(a.state) || !Object.keys(loadState(a.state).items).some(k => /^RUN-/.test(k)), 'no run recorded');
  for (const [mode, want] of [['warn', /^WARNING RUN-1: brief .*brief\.md lacks Scope:, Tests:, Done: \(policy\.dod\.ready = warn\)/m], ['off', null]]) {
    const t2 = mkTmp(`meta-dod-run-${mode}-`), l = laneRepo(t2), b = normRun(t2, l.wt, l.repo, { brief: 'mode: done\n', policy: { dod: { ready: mode } } });
    assert.equal(b.r.status, 0, b.r.stdout + b.r.stderr);
    assert.match(b.r.stdout, /^STARTED RUN-1 /m);
    if (want) assert.match(b.r.stdout, want); else assert.doesNotMatch(b.r.stdout, /WARNING|lacks/);
    assert.deepEqual(loadState(b.state).items['RUN-1'].data.dod_ready, mode === 'warn' ? { mode: 'warn', ok: false, missing: ['Scope:', 'Tests:', 'Done:'] } : undefined);
    await waitFor(() => settled(loadState(b.state).items['RUN-1']), { what: 'the run ends' });
  }
});

test('run end: a DONE whose Done check fails is STOPPED, resumed once with the evidence; the second fail stays STOPPED for the check-in', async () => {
  const t = mkTmp('meta-dod-end-'), { repo, wt } = laneRepo(t);
  fs.writeFileSync(path.join(wt, 'stray.txt'), 'left behind');
  const { r, state } = normRun(t, wt, repo, { brief: `mode: done\n${READY}`, policy: { dod: { ready: 'refuse' }, slop: { enabled: false } }, gate: { cmd: 'node -e ""' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const runs = () => Object.values(loadState(state).items).filter(i => i.kind === 'run').sort((a, b) => a.id.localeCompare(b.id));
  await waitFor(() => runs().length === 2 && runs().every(settled), { producer: stateBusy(state), what: 'the run + its one Done resume end' });
  const [first, second] = runs();
  assert.equal(first.data.dod_ready.ok, true, 'Ready recorded at dispatch');
  assert.equal(first.end.outcome, 'stopped'); assert.match(first.end.why, /^Done check failed: 1 uncommitted/);
  assert.deepEqual(first.end.dod.dirty, ['stray.txt']);
  assert.equal(first.resume.next ?? first.history.find(h => h.ev === 'resume')?.data?.next, second.id);
  assert.equal(second.data.dod_of, first.id);
  assert.equal(second.end.outcome, 'stopped', 'the second fail is the check-in\'s');
  assert.equal(runs().length, 2, 'no second resume');
});

test('run end: a green Done check keeps DONE and records the evidence (exit codes, counts, logs)', async () => {
  const t = mkTmp('meta-dod-ok-'), { repo, wt } = laneRepo(t);
  const { r, state } = normRun(t, wt, repo, { brief: `mode: done\n${READY}`, policy: { dod: { ready: 'refuse' }, slop: { enabled: false } }, gate: { cmd: 'node -e ""' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const id = 'RUN-1';
  await waitFor(() => settled(loadState(state).items[id]), { what: 'the run ends' });
  const e = loadState(state).items[id].end;
  assert.equal(e.outcome, 'done'); assert.equal(e.dod.ok, true);
  // policy.tests at its default (light): the brief's `node -e` command runs as written, the light set replaces the gate
  assert.deepEqual(e.dod.tests.map(x => [x.name, x.code]), [['tests', 0]]);
  assert.match(e.dod.gate_skipped, /policy\.tests\.mode = light: the light set replaces the gate/);
  assert.equal(e.dod.tests_policy, 'policy.tests: mode light, budget 3 min, browser ci, full suite deny');
  assert.deepEqual(e.dod.tests_uncovered, ['src/a.mjs'], 'no test covers the changed module: named, left to CI');
});

test('Agents shows Ready and Done with the evidence', () => {
  const now = Date.now(), at = new Date(now - 60000).toISOString();
  const runs = [
    { id: 'RUN-1', kind: 'run', state: 'ended', created: at, data: { lane: 'x', executor: 'fake', dod_ready: { mode: 'refuse', ok: true, missing: [] } },
      end: { outcome: 'done', dod: { ok: true, why: null, tests: [{ name: 'tests', code: 0, counts: { pass: 3, fail: 0 }, log: 'L1' }, { name: 'gate', code: 0, counts: null, log: 'L2' }] } }, history: [] },
    { id: 'RUN-2', kind: 'run', state: 'ended', created: at, data: { lane: 'y', executor: 'fake', dod_ready: { mode: 'warn', ok: false, missing: ['Tests:'] } },
      end: { outcome: 'stopped', dod: { ok: false, why: '1 uncommitted / untracked file(s)', tests: [] } }, history: [] }];
  const tree = agentsTree(runs, { now });
  assert.deepEqual(tree.map(n => [n.dod_ready?.ok, n.dod?.ok]), [[true, true], [false, false]]);
  // the Runs page shows the evidence in the open run's document (the list rows carry none): open each run in turn
  const one = renderTab('runs', { tree }, { now, projects: [], run: 'RUN-1' }), two = renderTab('runs', { tree }, { now, projects: [], run: 'RUN-2' });
  assert.match(one, /Ready ✓/); assert.match(one, /Done ✓/); assert.match(two, /Ready ✗/); assert.match(two, /Done ✗/);
  assert.match(one, /tests exit 0, 3 pass 0 fail/); assert.match(two, /1 uncommitted \/ untracked file/); assert.match(two, /lacks Tests:/);
});
