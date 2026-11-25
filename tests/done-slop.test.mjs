// SloppaChoppa 2 S2 (the worker hears first): `norn done` checks the run's branch in the worker's own session and refuses a DONE
// with open BLOCK findings (exit 4, no result); stopped / handoff are never refused; the check it ran is stored, and the run end's
// check (endCheck) reads it instead of checking the same head and rule set again. Temp git repos; K15 (junk names) needs no tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { endCheck } from '../engine/lib/slop/runend.mjs';
import { slopResumes } from '../engine/lib/slop/daily.mjs';
import { record } from '../engine/lib/records.mjs';
import { slopChecks, slopHolds } from '../engine/lib/slop/host.mjs';
import { binOf, CODE_STORE_SCHEMA } from '../engine/lib/rustbin.mjs';
import { doneSlop } from '../engine/bin/norn.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const NORN = path.join(import.meta.dirname, '..', 'engine', 'bin', 'norn.mjs');
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };

/** a state with run RUN-1 whose worktree is on feat/x with one junk file (K15 BLOCK) past main */
function fixture({ policy = {} } = {}) {
  const root = mkTmp('meta-done-slop-'), state = path.join(root, 'state'), wt = path.join(root, 'wt');
  fs.mkdirSync(path.join(state, 'runs'), { recursive: true }); fs.mkdirSync(wt);
  git(wt, 'init', '-q', '-b', 'main'); git(wt, 'config', 'user.email', 't@t'); git(wt, 'config', 'user.name', 't'); git(wt, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'a\n'); git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'a');
  git(wt, 'checkout', '-q', '-b', 'feat/x');
  fs.writeFileSync(path.join(wt, 'a.txt.orig'), 'left by a merge\n'); git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'oops');
  fs.writeFileSync(path.join(state, 'runs', 'RUN-1.spec.json'), JSON.stringify({ run: 'RUN-1', lane: 'x', worktree: wt, policy }));
  return { root, state, wt };
}
const done = ({ root, state }, ...a) => spawnSync(process.execPath, [NORN, 'done', ...a], { encoding: 'utf8', env: { ...process.env, META_ROOT: root, META_RUN_ID: 'RUN-1', META_RUN_STATE: state, META_RESULT_DIR: '' }, windowsHide: true });
const result = state => path.join(state, 'results', 'RUN-1', 'result.json');

test('norn done with a BLOCK on the branch: the list with what / why / fix and the two ways out, no result, exit 4; fixed: DONE', () => {
  const fx = fixture();
  let r = done(fx);
  assert.equal(r.status, 4, r.stdout + r.stderr);
  assert.match(r.stdout, /1 BLOCK finding\(s\)[\s\S]*K15 `a\.txt\.orig`[\s\S]*what: [\s\S]*why: [\s\S]*fix: /);
  assert.match(r.stdout, /run `norn done` again/); assert.match(r.stdout, /norn done --outcome stopped --why "slop waiver needed"/);
  assert.match(r.stdout, /DONE refused/);
  assert.equal(fs.existsSync(result(fx.state)), false, 'no result written');
  assert.deepEqual(slopHolds(fx.state)['feat/x'].blocks.map(b => b.rule), ['K15'], 'the check it ran is stored (the hold)');
  git(fx.wt, 'rm', '-q', 'a.txt.orig'); fs.writeFileSync(path.join(fx.wt, 'b.txt'), 'b\n'); git(fx.wt, 'add', '-A'); git(fx.wt, 'commit', '-q', '-m', 'fix');
  r = done(fx);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /RUN-1 DONE/);
  assert.equal(JSON.parse(fs.readFileSync(result(fx.state), 'utf8')).outcome, 'done');
  assert.equal(slopHolds(fx.state)['feat/x'], undefined, 'the clean check drops the hold');
});

test('norn done: stopped and handoff are never refused; slop off for the project = no check', () => {
  const fx = fixture();
  const r = done(fx, '--outcome', 'stopped', '--why', 'slop waiver needed');
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /RUN-1 STOPPED/);
  assert.equal(slopChecks(fx.state).length, 0, 'no check for a STOPPED (the run end checks it)');
  const ho = fixture();
  assert.equal(done(ho, '--outcome', 'handoff', '--handoff', 'half way').status, 0); assert.equal(slopChecks(ho.state).length, 0);
  const off = fixture({ policy: { slop: { enabled: false } } });
  assert.equal(done(off).status, 0); assert.equal(slopChecks(off.state).length, 0);
});

test('endCheck: the run end reads the check norn done stored at this head and rule set, and checks a new head', () => {
  const fx = fixture();
  assert.equal(done(fx).status, 4);
  const c = endCheck({ repo: fx.wt, state: fx.state, lane: 'x', run: 'RUN-1' });
  assert.equal(c.result, null, 'not checked again'); assert.equal(slopChecks(fx.state).length, 1, 'not stored again');
  assert.deepEqual(c.open.map(f => f.rule), ['K15']);
  fs.writeFileSync(path.join(fx.wt, 'b.txt'), 'b\n'); git(fx.wt, 'add', '-A'); git(fx.wt, 'commit', '-q', '-m', 'more');
  const c2 = endCheck({ repo: fx.wt, state: fx.state, lane: 'x', run: 'RUN-1' });
  assert.ok(c2.result, 'a new head is checked'); assert.equal(slopChecks(fx.state).length, 2);
});

test('slopResumes: the daily report counts the run ends resumed with slop BLOCK findings in the last 7 days', () => {
  const state = mkTmp('meta-done-slop-rs-'), now = Date.parse('2026-11-20T12:00:00Z');
  for (const [id, at] of [['RUN-1', now - 3600e3], ['RUN-2', now - 8 * 864e5]]) {
    record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'x' } }, { now: () => new Date(at) });
    record(state, { kind: 'run', ev: 'end', id, by: 'launcher', data: { exit: 0, outcome: 'done' } }, { now: () => new Date(at) });
    record(state, { kind: 'run', ev: 'resume', id, by: 'launcher', data: { next: 'RUN-9', slop: 2 } }, { now: () => new Date(at) });
  }
  assert.equal(slopResumes(state, now), 1, 'the one inside the week');
});

// NORN-DONE-FRESH: `norn done` is the engine on PATH; its stored check reads the code graph (K10) when the worktree holds an imports
// root (rustbin graphReads, the supervisor's condition too). Then norn-code of THIS engine is ensured first, a build announced in one
// line; a part that cannot be had refuses the DONE with rustbin's ONE reason and stores no check. A fake code part in a temp store and
// an injected cargo: no real cargo runs here
const EXE = process.platform === 'win32' ? '.exe' : '';
function codePart(root) {
  const src = path.join(root, 'eng', 'code-rs'), store = path.join(root, 'store');
  fs.mkdirSync(path.join(src, 'src'), { recursive: true }); fs.writeFileSync(path.join(src, 'Cargo.toml'), '[package]\nname = "x"\n'); fs.writeFileSync(path.join(src, 'src', 'main.rs'), 'fn main() {}\n');
  return [{ p: 'code', src, store, exe: binOf('code', { src, store }) }];
}
const says = () => ({ status: 0, stdout: JSON.stringify({ ok: true, store_schema: CODE_STORE_SCHEMA }) + '\n' });
const graphFixture = () => { const fx = fixture(); fs.mkdirSync(path.join(fx.wt, 'engine')); fs.writeFileSync(path.join(fx.wt, 'engine', 'a.mjs'), 'export const a = 1;\n'); git(fx.wt, 'add', '-A'); git(fx.wt, 'commit', '-q', '-m', 'engine'); return fx; };

test('norn done, the check reads the graph: norn-code is built first, said in one line, then the check runs and is stored', async () => {
  const fx = graphFixture(), parts = codePart(fx.root), outs = [], calls = [];
  const cargo = async args => {
    assert.equal(slopChecks(fx.state).length, 0, 'built before the check');
    calls.push(args); const t = args[args.indexOf('--target-dir') + 1]; fs.mkdirSync(path.join(t, 'release'), { recursive: true }); fs.writeFileSync(path.join(t, 'release', 'norn-code' + EXE), 'bin'); return { status: 0 };
  };
  await doneSlop(fx.state, 'RUN-1', s => outs.push(s), s => outs.push(s), { parts, rust: { cargo, cc: () => null, run: says } });
  assert.deepEqual(calls.map(a => a[0]), ['clean', 'build'], 'the package cleaned, then built (rustbin.mjs plan)');
  assert.match(outs[0], /^norn done: building norn-code \(the code graph .*\) for this engine's sources before the branch check/);
  assert.equal(slopChecks(fx.state).length, 1, 'the check ran and is stored');
});

test('norn done: a check that does not read the graph builds nothing; a part that cannot be had refuses the DONE with the ONE reason and stores no check', async () => {
  const fx = fixture(), outs = [];
  assert.equal(await doneSlop(fx.state, 'RUN-1', s => outs.push(s), s => outs.push(s), { parts: codePart(fx.root), rust: { cargo: () => assert.fail('no graph read: no build'), cc: () => null } }), true, 'K15 still refuses');
  assert.doesNotMatch(outs.join('\n'), /building norn-code/);
  assert.equal(slopChecks(fx.state).length, 1);
  const gx = graphFixture(), gouts = [];
  const refused = await doneSlop(gx.state, 'RUN-1', s => gouts.push(s), s => gouts.push(s), { parts: codePart(gx.root), rust: { cc: () => null, cargo: async a => a[0] === 'clean' ? { status: 0 } : ({ status: 101, stdout: '', stderr: 'error: linker `cc` not found\n' }) } });
  assert.equal(refused, true);
  const all = gouts.join('\n');
  assert.match(all, /norn-code \(the code graph .*\) did not build \(cargo exit 101: error: linker `cc` not found\); build command: cargo build --release --locked /);
  assert.match(all, /RUN-1 DONE refused: the branch check cannot run/);
  assert.doesNotMatch(all, /K10/, 'not a K10 finding');
  assert.equal(slopChecks(gx.state).length, 0, 'no check stored'); assert.equal(slopHolds(gx.state)['feat/x'], undefined);
});
