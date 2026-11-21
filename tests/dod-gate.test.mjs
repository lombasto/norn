// NORN-DOD-GATE-FAST: the worker Done check's gate follows policy.merge.suite (mergebrief.mjs suiteMode). changed (default): a
// ci-suite gate runs on the change only (--changed <the branch's merge base>), so a worker's Done check runs the tests its diff
// touches, never the full suite (RUN-1491: 209/227 files at the 20 min timeout); skip: no gate (as mergeq / landing); a gate that
// is not ci-suite runs as configured (all of it under policy.tests.mode = changed). Known reds (the worktree's tests/KNOWN-REDS.txt) read green. Mode + files show on the card.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readyGate, doneCheck, gateProgress, dodPrompt } from '../engine/lib/dod.mjs';
import { parseReady } from '../engine/lib/ready.mjs';
import { dodChips } from '../engine/dash/widgets.mjs';
import { agentsTree } from '../engine/lib/agents.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const SUITE = path.join(import.meta.dirname, '..', 'engine', 'bin', 'ci-suite.mjs').split(path.sep).join('/');
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const READY = parseReady('Scope: src/**, tests/**\nTests: `node -e ""`\nDone: ## DONE\n');
// the gate runs under policy.tests.mode = changed only (light replaces it with the light set: tests/dod.test.mjs)
const CHANGED = { mode: 'changed' };
const PASS = "import test from 'node:test';\ntest('ok', () => {});\n", FAIL = name => `import test from 'node:test';\ntest('${name}', () => { throw new Error('red'); });\n`;

/** main: tests/a (green), tests/b (an unlisted red), tests/k (a red KNOWN-REDS lists); the lane branch feat/x changes src/<changed>.mjs */
function suiteRepo(root, changed) {
  const repo = path.join(root, 'repo'), wt = path.join(root, 'wt'), w = (d, f, s) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), s); };
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  w(repo, 'tests/a.test.mjs', PASS); w(repo, 'tests/b.test.mjs', FAIL('b red')); w(repo, 'tests/k.test.mjs', FAIL('k red'));
  w(repo, 'tests/KNOWN-REDS.txt', 'tests/k.test.mjs :: k red\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'r');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
  w(wt, `src/${changed}.mjs`, 'export const a = 1;\n'); git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'c');
  return { repo, wt, base: git(repo, 'rev-parse', 'main') };
}
const gateOf = d => d.tests.find(x => x.name === 'gate');

test('changed mode (the default): a ci-suite gate gets --changed <merge base>; only the touched test file runs', async () => {
  const t = mkTmp('meta-dodgate-ch-'), { wt, base } = suiteRepo(t, 'a');
  const d = await doneCheck({ worktree: wt, dod: { ready: READY, tests: CHANGED, gate: { cmd: `node "${SUITE}"`, suite: 'changed' } }, logDir: path.join(t, 'logs'), run: 'RUN-1' });
  const g = gateOf(d), log = fs.readFileSync(g.log, 'utf8');
  assert.equal(d.ok, true, `${JSON.stringify(d)}\n${log}`);
  assert.equal(g.cmd, `node "${SUITE}" --changed ${base}`);
  assert.deepEqual(g.suite, { mode: 'changed', files: 1, done: 1 });
  assert.match(log, /start tests\/a\.test\.mjs/); assert.doesNotMatch(log, /tests\/b\.test\.mjs/, 'the unlisted red of an untouched file never ran');
});

test('a red KNOWN-REDS lists (red on main too) reads green; an unlisted red fails', async () => {
  const t = mkTmp('meta-dodgate-kr-'), { wt } = suiteRepo(t, 'k');
  const d = await doneCheck({ worktree: wt, dod: { ready: READY, tests: CHANGED, gate: { cmd: `node "${SUITE}"`, suite: 'changed' } }, logDir: path.join(t, 'logs'), run: 'RUN-1' });
  assert.equal(d.ok, true, fs.readFileSync(gateOf(d).log, 'utf8'));
  assert.match(fs.readFileSync(gateOf(d).log, 'utf8'), /listed red: tests\/k\.test\.mjs :: k red/);
  const u = mkTmp('meta-dodgate-kr2-'), b = suiteRepo(u, 'b');
  const r = await doneCheck({ worktree: b.wt, dod: { ready: READY, tests: CHANGED, gate: { cmd: `node "${SUITE}"`, suite: 'changed' } }, logDir: path.join(u, 'logs'), run: 'RUN-2' });
  assert.equal(r.ok, false); assert.match(r.why, /gate exit 1/);
});

test('skip mode runs no gate (as the batch gate and the landing check); a gate that is not ci-suite runs as configured', async () => {
  const t = mkTmp('meta-dodgate-sk-'), { wt } = suiteRepo(t, 'a'), cmd = 'node -e "console.log(\'ℹ pass 2\')"';
  const s = await doneCheck({ worktree: wt, dod: { ready: READY, tests: CHANGED, gate: { cmd: `node "${SUITE}"`, suite: 'skip' } }, logDir: path.join(t, 'logs'), run: 'RUN-1' });
  assert.equal(s.ok, true); assert.equal(gateOf(s), undefined); assert.match(s.gate_skipped, /merge\.suite = skip/);
  const o = await doneCheck({ worktree: wt, dod: { ready: READY, tests: CHANGED, gate: { cmd, suite: 'changed' } }, logDir: path.join(t, 'logs'), run: 'RUN-2' });
  assert.equal(gateOf(o).cmd, cmd, 'the command is untouched');
  assert.deepEqual(gateOf(o).suite, { mode: 'as-configured', files: null, done: null });
});

// CI 44932573347: runGate drops every META_* var from the gate's env, so a gate run inside a test lost META_TEST_OWNER; the nested
// ci-suite then took the real machine gate lock (the engine root's state/locks) and waited 90 min for the CI suite that held it
test('a gate run inside a test keeps META_TEST_OWNER, so the ci-suite it starts takes no machine gate lock', async () => {
  const t = mkTmp('meta-dodgate-own-'), { wt } = suiteRepo(t, 'a'), cmd = 'node -e "console.log(\'owner=\' + (process.env.META_TEST_OWNER || \'none\'))"';
  const d = await doneCheck({ worktree: wt, dod: { ready: READY, tests: CHANGED, gate: { cmd, suite: 'changed' } }, logDir: path.join(t, 'logs'), run: 'RUN-1', locksDir: path.join(t, 'locks') });
  assert.match(fs.readFileSync(gateOf(d).log, 'utf8'), new RegExp(`owner=${process.env.META_TEST_OWNER}`));
});

test('readyGate records the suite mode from suiteMode (default changed; a bad value is refused)', () => {
  const t = mkTmp('meta-dodgate-rg-'), b = path.join(t, 'b.md');
  fs.writeFileSync(b, 'Scope: a/**\nTests: `x`\nDone: d\n');
  const g = { cmd: 'node engine/bin/ci-suite.mjs', timeout_min: 20 };
  assert.equal(readyGate({ brief: b, policy: { dod: { ready: 'warn' } }, gate: g }).dod.gate.suite, 'changed');
  assert.equal(readyGate({ brief: b, policy: { dod: { ready: 'warn' }, merge: { suite: 'skip' } }, gate: g }).dod.gate.suite, 'skip');
  assert.throws(() => readyGate({ brief: b, policy: { dod: { ready: 'warn' }, merge: { suite: 'full' } }, gate: g }), /merge\.suite must be one of/);
});

test('gateProgress reads the files to run and the files done from a ci-suite log; a timeout names mode and files done / total', async () => {
  assert.deepEqual(gateProgress('ci-suite: 3 test file(s) to run\nci-suite: done tests/a.test.mjs\nci-suite: done tests/b.test.mjs\n'), { files: 3, done: 2 });
  assert.deepEqual(gateProgress('no suite here'), { files: null, done: null });
  const t = mkTmp('meta-dodgate-to-'), { wt } = suiteRepo(t, 'a'), fake = path.join(t, 'ci-suite.mjs');
  fs.writeFileSync(fake, "console.log('ci-suite: 227 test file(s) to run'); for (let i = 0; i < 209; i++) console.log('ci-suite: done f' + i); setInterval(() => {}, 1000);\n");
  const d = await doneCheck({ worktree: wt, dod: { ready: READY, tests: CHANGED, gate: { cmd: `node "${fake.split(path.sep).join('/')}"`, suite: 'changed', timeout_min: 0.02 } }, logDir: path.join(t, 'logs'), run: 'RUN-1' });
  assert.equal(d.ok, false);
  assert.match(d.why, /gate exit \S+ \(timed out after 0\.02 min: changed, 209\/227 files done\)/);
  assert.match(dodPrompt(d), /gate: changed, 209\/227 files/);
});

test('the run card\'s Done evidence shows the gate mode, its files and its time', () => {
  const tests = [{ name: 'gate', code: 0, counts: { pass: 9, fail: 0 }, log: 'L', ms: 41000, suite: { mode: 'changed', files: 6, done: 6 } }];
  assert.match(dodChips(null, { ok: true, why: null, tests }, { evidence: true }), /gate exit 0, 9 pass 0 fail \(gate: changed, 6 files, 41 s\)/);
  const cut = [{ name: 'gate', code: null, counts: null, log: 'L', ms: 1200000, suite: { mode: 'changed', files: 227, done: 209 } }];
  assert.match(dodChips(null, { ok: false, why: 'x', tests: cut }, { evidence: true }), /gate: changed, 209\/227 files, 1200 s/);
});

// a8b060ac: Runs is one table and a row opens the run document - the Done chip there carries the gate evidence (its title)
test('the Runs run document carries the Done gate entry\'s mode, files and time (agentsTree passes ms + suite)', () => {
  const now = Date.now(), at = new Date(now - 60000).toISOString();
  const runs = [{ id: 'RUN-1', kind: 'run', state: 'ended', created: at, data: { lane: 'x', executor: 'fake' }, history: [],
    end: { outcome: 'done', dod: { ok: true, why: null, tests: [{ name: 'gate', code: 0, counts: { pass: 9, fail: 0 }, log: 'L', ms: 41000, suite: { mode: 'changed', files: 6, done: 6 } }] } } }];
  const tree = agentsTree(runs, { now });
  assert.deepEqual(tree[0].dod.tests[0].suite, { mode: 'changed', files: 6, done: 6 }); assert.equal(tree[0].dod.tests[0].ms, 41000);
  assert.match(renderTab('runs', { tree }, { now, projects: [], run: 'RUN-1' }), /gate exit 0, 9 pass 0 fail \(gate: changed, 6 files, 41 s\)/);
});
