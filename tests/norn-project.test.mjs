// (the norn project.json / SessionStart-hook assertions live in norn-projects tests/owner-config.test.mjs since META-ONBOARD S6)
// NORN-WATCH S2 (DIR-83, DEC-684 option a): the `norn` project - its own state dir, its own gated check-in, machine-wide caps,
// checkin.max_quiet_min, the MERGE brief template with the merge-shots mode from project policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProject } from '../engine/lib/config.mjs';
import { renderCheckin, tick, projectBudget } from '../engine/lib/tick.mjs';
import { buildStatus } from '../engine/lib/status.mjs';
import { startRun } from '../engine/lib/runs.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { readGate, gateFile } from '../engine/lib/gate.mjs';
import { renderMergeBrief, renderBatchBrief, MERGE_TEMPLATE } from '../engine/lib/mergebrief.mjs';
import { mergeWtPath } from '../engine/lib/mergewt.mjs';
import { settled } from './helpers/settled.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const META = path.join(REPO, 'engine', 'bin', 'norn.mjs');
const tmp = p => mkTmp(p);
const fwd = p => p.replace(/\\/g, '/');
const readBudget = () => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'status', 'BUDGET.json'), 'utf8').replace(/^﻿/, ''));
const sleepMs = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const exited = (state, id) => { for (let i = 0; i < 1200; i++) { if (loadState(state).items[id]?.state === 'exited' && settled(loadState(state).items[id])) return; sleepMs(50); } throw new Error(`timeout ${id}`); };

// a tick-able project named `name` whose state is <t>/state/<name> (sibling state dirs = one machine)
function proj(t, name, extra = {}) {
  const root = path.join(t, 'root-' + name), state = path.join(t, 'state', name);
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(state, { recursive: true });
  return { name, root, state, ledger: path.join(t, name + '-ledger.md'), briefs_dir: t, checkin: { cwd: root }, views: {}, ...extra };
}
const liveRun = (state, data) => {
  const r = record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', worktree: state, brief: 'b', ...data } });
  fs.mkdirSync(path.join(state, 'hb'), { recursive: true }); fs.writeFileSync(path.join(state, 'hb', r.id + '.hb'), '{}');
  return r;
};

test('two projects in sibling state dirs: a norn run records to state/norn; the kestrel cap counts it; kestrel STATUS / --unreviewed show no norn run', () => {
  const t = tmp('meta-norn2-');
  const kestrel = proj(t, 'kestrel'), norn = proj(t, 'norn');
  const budget = { ...readBudget(), max_claude_workers: 1 };
  fs.writeFileSync(path.join(t, 'b.md'), 'brief\n');
  const r = startRun({ state: norn.state, locksDir: path.join(t, 'state', 'locks'), executor: 'fake', kind: 'worker', lane: 'meta-watch', project: 'norn',
    brief: path.join(t, 'b.md'), worktree: norn.root, budget, hbMs: 100, staleMs: 3000, tick: null, env: { FAKE_MS: '2500' } });
  assert.ok(loadState(norn.state).items[r.run], 'the norn run is in state/norn');
  assert.ok(!fs.existsSync(path.join(kestrel.state, 'runs.jsonl')) || !loadState(kestrel.state).items[r.run], 'and not in state/kestrel');
  assert.throws(() => startRun({ state: kestrel.state, locksDir: path.join(t, 'state', 'locks'), executor: 'fake', kind: 'worker', lane: 'x', project: 'kestrel',
    brief: path.join(t, 'b.md'), worktree: kestrel.root, budget, hbMs: 100, staleMs: 3000, tick: null }), e => e.code === 4 && /budget max_claude_workers=1/.test(e.message),
  'the kestrel claude cap is full with the norn run (caps are machine-wide)');
  exited(norn.state, r.run);
  const ended = loadState(norn.state).items[r.run];
  assert.ok(!ended.review, 'the norn end is unreviewed');
  const s = buildStatus({ state: kestrel.state, project: 'kestrel', budget, projectsDir: path.join(t, 'none'), usageJson: {}, cacheFile: path.join(t, 'uc.json') });
  assert.doesNotMatch(s.text, new RegExp(`${r.run} \\w+ unreviewed`), 'kestrel Records do not list the norn end');
  assert.doesNotMatch(s.text, /meta-watch/);
  const ns = buildStatus({ state: norn.state, project: 'norn', budget, projectsDir: path.join(t, 'none'), usageJson: {}, cacheFile: path.join(t, 'uc2.json') });
  assert.match(ns.text, new RegExp(`^- ${r.run} exited unreviewed meta-watch`, 'm'), 'the norn STATUS lists it');
  const env = { ...process.env, META_ROOT: t };
  const u = spawnSync(process.execPath, [META, 'runs', '--unreviewed', '--state', kestrel.state], { env, encoding: 'utf8' });
  assert.equal(u.status, 0, u.stderr); assert.equal(u.stdout.trim(), '');
  const un = spawnSync(process.execPath, [META, 'runs', '--unreviewed', '--state', norn.state], { env, encoding: 'utf8' });
  assert.match(un.stdout, new RegExp(`${r.run} +exited`));
});

test('`norn tick` with no --project ticks every registered project (kestrel + norn)', async () => {
  const t = tmp('meta-norn3-');
  const pj = name => {
    const root = path.join(t, 'root-' + name); fs.mkdirSync(root, { recursive: true });
    const f = path.join(t, `${name}.project.json`);
    fs.writeFileSync(f, JSON.stringify({ schema: 1, name, title: name, root: fwd(root), ledger: '${root}/progress.md', briefs_dir: '${root}', checkin: { cwd: '${root}', ...(name === 'norn' ? { max_quiet_min: 360 } : {}) } }));
    return f;
  };
  fs.mkdirSync(path.join(t, 'local'));
  fs.writeFileSync(path.join(t, 'local', 'budget.json'), JSON.stringify(readBudget()));
  fs.writeFileSync(path.join(t, 'local', 'machine.json'), JSON.stringify({ schema: 1, home: fwd(t), node: fwd(process.execPath),
    claude: { exe: fwd(process.execPath), config_dir: fwd(path.join(t, 'cfg')), projects_dir: fwd(path.join(t, 'cfg', 'projects')) }, codex: null, git: { exe: fwd(process.execPath) },
    scheduler: { kind: 'cron', name: 'x', interval_min: 15 }, dash: { port: 8737, bind: '127.0.0.1' },
    projects: [{ name: 'kestrel', config: fwd(pj('kestrel')) }, { name: 'norn', config: fwd(pj('norn')) }] }));
  const r = spawnSync(process.execPath, [META, 'tick', '--dry', '--reason', 'test'], { env: { ...process.env, META_ROOT: t, META_HB_MS: '150' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^tick kestrel \(test\): .*check-in RUN-1/m);
  assert.match(r.stdout, /^tick norn \(test\): .*check-in RUN-1/m);
  for (const n of ['kestrel', 'norn']) { assert.equal(loadState(path.join(t, 'state', n)).items['RUN-1'].data.kind, 'checkin'); exited(path.join(t, 'state', n), 'RUN-1'); }
});

test('checkin.max_quiet_min overrides the machine checkin_max_quiet_min for that project only', () => {
  const B = { checkin_max_quiet_min: 60, max_claude_workers: 2 };
  assert.equal(projectBudget({ checkin: { max_quiet_min: 360 } }, B).checkin_max_quiet_min, 360);
  assert.equal(projectBudget({ checkin: {} }, B).checkin_max_quiet_min, 60);
  assert.equal(projectBudget({}, B), B);
  assert.equal(B.checkin_max_quiet_min, 60, 'the machine budget is untouched');
  const t = tmp('meta-norn4-');
  const budget = { ...readBudget(), calib_time_utc: new Date().toISOString(), checkin_max_quiet_min: 60 };
  const machine = { claude: { exe: 'x', projects_dir: path.join(t, 'none') } };
  const go = p => tick({ project: p, machine, budget, budgetFile: path.join(t, 'budget.json'), reason: 'test', dry: true, hbMs: 100, staleMs: 3000, fakeMs: 200 });
  for (const [p, want] of [[proj(t, 'kestrel'), /check-in RUN-2 .*forced: last check-in RUN-1 1\d\d min ago \(max quiet 60\)/], [proj(t, 'norn', { checkin: { cwd: path.join(t, 'root-norn'), max_quiet_min: 360 } }), /skip: no change since RUN-1$/]]) {
    let r = go(p);
    assert.match(r.msg, /check-in RUN-1/, r.msg);
    exited(p.state, 'RUN-1');
    const g = readGate(p.state);
    fs.writeFileSync(gateFile(p.state), JSON.stringify({ ...g, start: new Date(Date.parse(g.start) - 120 * 60000).toISOString() }));   // the last real check-in was 2 h ago
    r = go(p);
    assert.match(r.msg, want, `${p.name}: ${r.msg}`);
    if (/RUN-2/.test(r.msg)) exited(p.state, 'RUN-2');
  }
});

test('MERGE brief template: filled from the lane + the project policy merge.shots (default "after"); bad mode refused', () => {
  const t = tmp('meta-norn5-');
  assert.ok(fs.existsSync(MERGE_TEMPLATE));
  const p = { name: 'norn', root: '/h/dev/sdd-codex', meta: '/h/dev/sdd-codex', state: '/h/state/norn', deliverables: { main: 'main' }, policy: {} };
  const o = { lane: 'meta-watch', branch: 'feat/norn-watch', worktree: '/h/dev/sdd-codex-watch', notes: '/h/dev/sdd-codex-reviews/meta-watch/MERGE-NOTES.md', ui: true };
  const after = renderMergeBrief(p, o);
  assert.doesNotMatch(after, /\{\{/);
  for (const s of ['feat/norn-watch', '/h/dev/sdd-codex-watch', 'merge --no-ff -m "merge: feat/norn-watch (meta-watch)" origin/feat/norn-watch', 'norn.mjs" smoke', 'merge-land --project', '--branch feat/norn-watch', 'norn.mjs" done', 'MERGE-NOTES.md']) assert.ok(after.includes(s), s);
  assert.match(after, /SHOTS AFTER/);
  // 11-09 VISUAL-B merge: the notice named a local folder (useless on a phone) - the shots ride as ntfy attachments
  assert.match(after, /up to 3 key shots/); assert.doesNotMatch(after, /shot paths in --body/);
  assert.doesNotMatch(after, /SHOTS BEFORE/);
  const before = renderMergeBrief({ ...p, policy: { merge: { shots: 'before' } } }, o);
  assert.match(before, /SHOTS BEFORE/); assert.match(before, /done --outcome stopped --why "shots sent before the merge/);
  const noUi = renderMergeBrief(p, { ...o, ui: false });
  assert.match(noUi, /no dash \/ UI change: no screenshots/);
  assert.throws(() => renderMergeBrief({ ...p, policy: { merge: { shots: 'sometimes' } } }, o), /merge\.shots must be one of after, before/);
  assert.throws(() => renderMergeBrief(p, { ...o, branch: '' }), /branch/);
  // the CLI writes the brief (the check-in's one command); the shots mode comes from the project file
  const pj = path.join(t, 'project.json');
  fs.writeFileSync(pj, JSON.stringify({ schema: 1, name: 'norn', title: 'n', root: fwd(t), ledger: '${root}/L.md', briefs_dir: '${root}', policy: { merge: { shots: 'before' } } }));
  const outF = path.join(t, 'task-MERGE-brief.md');
  const r = spawnSync(process.execPath, [META, 'merge-brief', '--project', pj, '--lane', 'meta-watch', '--branch', 'feat/x', '--worktree', fwd(t) + '-x', '--notes', fwd(t) + '/N.md', '--ui', '--out', outF],
    { env: { ...process.env, META_ROOT: t }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /merge-brief -> .*task-MERGE-brief\.md \(shots before\)/);
  assert.match(fs.readFileSync(outF, 'utf8'), /SHOTS BEFORE/);
});

test('MERGE briefs: policy.merge.suite full (default: the ci-suite step, as before) | skip (no ci-suite; conflicted-area tests only; smoke stays); bad value refused (DIR-24)', () => {
  const p = { name: 'norn', root: '/h/dev/sdd-codex', meta: '/h/dev/sdd-codex', state: '/h/state/norn', deliverables: { main: 'main' }, policy: {} };
  const W = mergeWtPath(p.state, 'L', 'abcdef1');   // GAP-6: the staged merge's own merge worktree
  const suite = s => ({ ...p, policy: { merge: { suite: s } } });
  const o = { lane: 'L', branch: 'feat/x', worktree: '/h/wt', notes: '/h/n/NOTES.md', ui: true };
  const b = { n: 3, tip: 'a'.repeat(40), base: 'b'.repeat(40), gate: 'node engine/bin/ci-suite.mjs', gate_log: '/g.log', scratch: '/s', notes: '/h/n/N.md', ui: false,
    members: [{ id: 'DLV-1', branch: 'feat/a', lane: 'a', sha: 'c'.repeat(40), merge: 'd'.repeat(40) }] };
  const kinds = { rebase: q => renderMergeBrief(q, o), staged: q => renderMergeBrief(q, { ...o, sha: 'abcdef1' }), batch: q => renderBatchBrief(q, b) };
  const today = {   // today's text, bit for bit
    rebase: ["2. Suite in /h/wt: `node engine/bin/ci-suite.mjs` (smoke.test.mjs runs alone after the rest). Only the known reds of the project's known-red list may be\n   red; a load red must pass alone (run it alone, name it). Any other red = STOPPED, nothing merged.\n",
      '--body "<PR url>, suite + smoke green"', 'Write NOTES: the PR url, the tested merge sha, the merge-land line, suite counts + named reds, smoke result'],
    staged: [`3. Suite in ${W} on the uncommitted merge: \`node engine/bin/ci-suite.mjs\` (smoke.test.mjs runs alone after the rest). Only the known reds of\n   the project's known-red list may be red; a load red must pass alone (run it alone, name it). Any other red =\n   \`git -C ${W} merge --abort\`, STOPPED, nothing merged.\n`,
      '--body "<PR url>, abcdef1 tested, suite + smoke green"', 'Write NOTES: the PR url, the tested merge sha, the merge-land line, suite counts + named reds, smoke result'],
    batch: ['The gate `node engine/bin/ci-suite.mjs` ran GREEN on the batch tip ' + 'a'.repeat(40), '--body "<one PR url per branch>, gate + smoke green"'],
  };
  for (const [k, render] of Object.entries(kinds)) {
    const dflt = render(p), full = render(suite('full')), skip = render(suite('skip'));
    assert.equal(full, dflt, `${k}: full is the default`);
    for (const s of today[k]) assert.ok(full.includes(s), `${k} full keeps: ${s}`);
    assert.doesNotMatch(full, /merge\.suite/);
    assert.doesNotMatch(skip, /\{\{|ci-suite\.mjs` \(|Suite in/, `${k}: skip runs no ci-suite`);
    assert.match(skip, /merge\.suite = skip/);
    assert.match(skip, /norn\.mjs" smoke/, `${k}: the smoke always stays`);
    assert.match(skip, k === 'batch' ? /--body "<one PR url per branch>, gate skipped \(policy merge\.suite = skip\) \+ smoke green/ : /--body "<PR url>, (abcdef1 tested, )?suite skipped \(policy merge\.suite = skip\)/, `${k}: the notify body says which ran`);
    if (k !== 'batch') {
      assert.match(skip, /conflicts?.*only the test files of the conflicted areas/s);
      assert.match(skip, /a red there = .*--outcome stopped --why "red in a conflicted area/s);
      assert.match(skip, /clean .* runs no test/);
      assert.match(skip, /Write NOTES: the PR url, the tested merge sha, the merge-land line, suite skipped \(policy merge\.suite = skip\)/);
    }
    assert.throws(() => render(suite('sometimes')), /merge\.suite must be one of full, skip/);
  }
  assert.ok(kinds.staged(suite('skip')).includes(`a red there = \`git -C ${W} merge --abort\``));
});

test('MERGE briefs: a project with merge.gate.cmd runs its own gate (from its monorepo subdir), never ci-suite.mjs; gate.dir wins', () => {
  const p = { name: 'shack', root: '/h/mono', subdir: 'shack', meta: '/h/norn', state: '/h/state/shack', deliverables: { main: 'main' }, policy: {},
    merge: { gate: { cmd: '"/h/mono/shack/.venv/Scripts/python.exe" -m pytest tests -q' } } };
  const o = { lane: 'L', branch: 'feat/x', worktree: '/h/wt', notes: '/h/n/NOTES.md' };
  for (const brief of [renderMergeBrief(p, o), renderMergeBrief(p, { ...o, sha: 'abcdef1' })]) {
    assert.match(brief, /Suite in .*: `cd shack && "\/h\/mono\/shack\/\.venv\/Scripts\/python\.exe" -m pytest tests -q` \(the project's merge gate, project\.json merge\.gate\.cmd\)\. Only the known reds/);
    assert.doesNotMatch(brief, /ci-suite\.mjs/);
  }
  const own = renderMergeBrief({ ...p, merge: { gate: { cmd: 'make test', dir: 'other' } } }, o);
  assert.match(own, /`cd other && make test`/);
});
