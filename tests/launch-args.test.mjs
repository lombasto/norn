// GAP-4: the check-in types its `norn run` lines, and once invented `--agent worker`. Every value a caller can make up is checked against
// what exists before the run starts or queues (launchargs.mjs), the refusal (exit 2) names the valid choices, and the check-in prompt
// shows them on its launch line. The CLI on temp state with the fake executor.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { launchParts, profileOf } from '../engine/lib/launchpolicy.mjs';
import claude from '../engine/lib/harness/claude.mjs';
import { queueRun } from '../engine/lib/runs.mjs';
import { parseAfter } from '../engine/lib/after.mjs';
import { knownExecutors, knownModels, launchArgsRefusal } from '../engine/lib/launchargs.mjs';
import { renderCheckin } from '../engine/lib/tick.mjs';
import { FLOOR_MODELS } from '../engine/lib/floor.mjs';

after(cleanTmp);
const NORN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');

function sandbox(policy) {
  const t = mkTmp('meta-launch-args-');
  const d = { t, state: path.join(t, 'state', 'p'), wt: path.join(t, 'wt'), brief: path.join(t, 'brief.md'), project: path.join(t, 'project.json') };
  fs.mkdirSync(d.state, { recursive: true }); fs.mkdirSync(d.wt); fs.mkdirSync(path.join(t, 'local'));
  fs.writeFileSync(d.brief, 'mode: done\n');
  fs.writeFileSync(d.project, JSON.stringify({ schema: 1, name: 'p', title: 'P', root: t.replace(/\\/g, '/'), executors: {}, ...(policy ? { policy } : {}) }));
  record(d.state, { kind: 'lane', ev: 'create', by: 'owner', data: { name: 'work' } }, { views: false });
  d.gate = record(d.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'fake', executor: 'fake', lane: 'gate', worktree: d.wt } }, { views: false }).id;
  // every launch waits on the open gate run: one that passes the checks only QUEUES (nothing is spawned)
  d.cli = (args, { executor = 'fake', brief = d.brief, worktree = d.wt } = {}) => {
    const r = spawnSync(process.execPath, [NORN, 'run', '--executor', executor, '--project', d.project, '--state', d.state, '--brief', brief, '--worktree', worktree,
      '--no-tick', '--after', `run:${d.gate}:done`, ...args],
      { encoding: 'utf8', windowsHide: true, env: { ...process.env, META_ROOT: t, META_ROLE: '', META_PROJECT: '', META_STATE: '', META_RUN_ID: '', META_NO_TICK: '1' } });
    return { code: r.status, out: (r.stdout + r.stderr).trim() };
  };
  return d;
}

test('norn run refuses an invented executor / model / effort / stage / lane / number / brief, naming the valid choices (exit 2)', () => {
  const d = sandbox(), lane = ['--lane', 'work'];
  const refused = (r, re) => { assert.equal(r.code, 2, r.out); assert.match(r.out, re); assert.doesNotMatch(r.out, /QUEUED|STARTED/); };
  refused(d.cli(lane, { executor: 'worker' }), /unknown executor "worker" \(known here: claude, fake, codex-sol, codex-astra\)/);
  refused(d.cli([...lane, '--model', 'gpt-6'], { executor: 'claude' }), new RegExp(`--model gpt-6: not a model of executor claude \\(known: ${FLOOR_MODELS.join(', ')}, haiku, sonnet, opus, fable; or leave --model out`));
  refused(d.cli([...lane, '--model', 'claude-opus-5-5'], { executor: 'codex-sol' }), /--model claude-opus-5-5: not a model of executor codex-sol \(known: gpt-6\.1-sol;/);
  refused(d.cli([...lane, '--model', 'claude-opus-5-5[1m]', '--effort', 'extreme'], { executor: 'claude' }), /--effort extreme: not an effort of executor claude \(known: low, medium, high, xhigh;/);
  refused(d.cli([...lane, '--stage', 'stage two']), /--stage "stage two": a stage name is letters, digits/);
  refused(d.cli(['--lane', 'my lane']), /--lane "my lane": not a lane name \(lanes here: work; a new lane name is/);
  refused(d.cli([...lane, '--round', 'two']), /--round two: a whole number/);
  refused(d.cli([...lane, '--budget-min', '-5']), /--budget-min -5: a whole number/);
  refused(d.cli(lane, { brief: path.join(d.t, 'task-work-S1-brief.md') }), /--brief .*task-work-S1-brief\.md: no such file \(write the brief first\)/);
  refused(d.cli([...lane, '--after', 'soon']), /error: /);   // --after parses (after.mjs) or is a usage error
  // a value that exists passes: a known model with its context suffix, a new lane name, the fake executor's free model
  const ok = d.cli(['--lane', 'new-lane', '--stage', 'S1', '--round', '2', '--model', 'claude-opus-5-5[1m]', '--effort', 'high'], { executor: 'fake' });
  assert.equal(ok.code, 0, ok.out); assert.match(ok.out, /QUEUED/);
});

test('a check-in\'s --worktree / --notes must lie inside the project\'s folders; the owner may point anywhere', () => {
  const d = sandbox(), out = mkTmp('meta-launch-args-out-'), as = ['--as', 'checkin', '--lane', 'work'];
  let r = d.cli(as, { worktree: out });
  assert.equal(r.code, 2, r.out); assert.match(r.out, /--worktree .*: outside the project's folders \(.*\); leave it out for the lane's own worktree/);
  r = d.cli([...as, '--notes', path.join(out, 'NOTES.md')]);
  assert.equal(r.code, 2, r.out); assert.match(r.out, /--notes .*NOTES\.md: outside the project's folders/);
  r = d.cli([...as, '--notes', path.join(d.t, 'notes', 'NOTES.md')]);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /QUEUED/);
  r = d.cli(['--lane', 'other'], { worktree: out });
  assert.equal(r.code, 0, r.out); assert.match(r.out, /QUEUED/);
});

test('the value lists: typed executors join, disabled ones leave; a Claude model the budget names is known; fake / typed models are free', () => {
  const p = { executors: { glm: { type: 'claude-compatible', base_url: 'https://x', api_key_env: 'K', model: 'glm-5' }, old: { type: 'cli', exe: 'x', model: 'm', enabled: false }, 'codex-astra': { enabled: false } } };
  assert.deepEqual(knownExecutors(p), ['claude', 'fake', 'codex-sol', 'glm']);
  assert.deepEqual(knownExecutors(p, { fake: false }), ['claude', 'codex-sol', 'glm']);
  assert.ok(knownModels('claude', { budget: { claude_model: 'claude-opus-4-7' } }).includes('claude-opus-4-7'));
  assert.equal(knownModels('fake'), null); assert.equal(knownModels('glm', { project: p }), null);
  const base = { lane: 'work', state: mkTmp('meta-launch-args-st-'), budget: {}, project: p };
  assert.equal(launchArgsRefusal({ ...base, executor: 'glm', model: 'anything', effort: 'any' }), null);
  assert.equal(launchArgsRefusal({ ...base, executor: 'codex-astra' }), null, 'a disabled executor: norn run names it disabled, not unknown');
  assert.equal(launchArgsRefusal({ ...base, executor: 'claude', model: '', effort: '' }), null, 'blank = the policy\'s');
});

test('the check-in prompt names the valid executors, models and efforts on its launch line', () => {
  const state = mkTmp('meta-launch-args-ck-');
  const prev = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = mkTmp('meta-launch-args-empty-');
  try {
    const txt = fs.readFileSync(renderCheckin({ name: 'p', root: state, state, executors: { glm: { type: 'claude-compatible', base_url: 'https://x', api_key_env: 'K', model: 'glm-5' } } }, { budget: {} }), 'utf8');
    assert.match(txt, /--executor <x> \[--agent <a>\] --model <m>/);
    assert.match(txt, /<x> = claude \| codex-sol \| codex-astra \| glm;/);
    assert.match(txt, /<m> per executor = claude: claude-haiku-5-5, [^;]*; codex-sol: gpt-6\.1-sol; codex-astra: gpt-6-astra; glm: the model of its entry \(leave --model out\);/);
    assert.match(txt, /<e> = low \| medium \| high \| xhigh;/);
    assert.doesNotMatch(txt, /\{\{\w+\}\}/);
  } finally { if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev; }
});

// overhead-audit S1 (owner Q-45): norn launches lean for worker / merge / check-in / chat (project policy, as Settings writes it); a
// project without policy.launch (solve-shack) stays full. Every run's record names the profile it launched with, full included.
const LEAN = { launch: { roles: { worker: 'lean', merge: 'lean', checkin: 'lean', chat: 'lean' } } };
const LEAN_FLAGS = ['--strict-mcp-config', '--setting-sources', '--exclude-dynamic-system-prompt-sections'];
const argsOf = profile => claude.command({ exe: 'claude', promptText: 'x', model: 'claude-opus-5-5', effort: 'medium', session_id: 's', worktree: 'w', profile }).args;

test('under a lean project policy a worker, merge or check-in launch carries the lean flags; a project without one launches full', () => {
  const lean = { policy: LEAN }, full = { policy: {} };
  for (const [lane, role] of [['work', 'worker'], ['merge-work', 'merge']]) {
    const p = launchParts({ project: lean, executor: 'claude', lane }).profile;
    assert.equal(p.name, 'lean', role);
    const a = argsOf(p);
    for (const fl of LEAN_FLAGS) assert.ok(a.includes(fl), `${role}: ${fl}`);
    assert.equal(a[a.indexOf('--setting-sources') + 1], 'project,local');
    assert.deepEqual(a[a.indexOf('--disallowedTools') + 1].split(','), ['Artifact', 'Workflow', 'ScheduleWakeup', 'ReportFindings']);
    assert.ok(!a.includes('--bare'));
    const fp = launchParts({ project: full, executor: 'claude', lane }).profile;
    assert.equal(fp.name, 'full'); assert.deepEqual(argsOf(fp), argsOf(undefined), 'full = the launch without a profile, byte-same');
  }
  for (const role of ['checkin', 'chat']) { assert.equal(profileOf(LEAN, role).name, 'lean'); assert.equal(profileOf({}, role).name, 'full'); }
  const ck = argsOf(profileOf(LEAN, 'checkin'));
  for (const fl of LEAN_FLAGS) assert.ok(ck.includes(fl), `checkin: ${fl}`);
});

test('every run record names its launch profile: lean under the lean policy, full without one (worker, merge, check-in)', () => {
  const recOf = (d, lane, kind) => Object.values(loadState(d.state).items).find(i => i.kind === 'run' && i.data.lane === lane && (!kind || i.data.kind === kind))?.data;
  for (const [policy, want] of [[LEAN, 'lean'], [undefined, 'full']]) {
    const d = sandbox(policy);
    for (const [args, lane, kind] of [[['--lane', 'work'], 'work'], [['--lane', 'merge-work'], 'merge-work']]) {
      const r = d.cli(args);
      assert.equal(r.code, 0, r.out); assert.match(r.out, /QUEUED/);
      assert.equal(recOf(d, lane, kind)?.launch_profile, want, `${lane}: ${want}`);
    }
    // a check-in starts from the tick (tick.mjs: profile = profileOf(policy, 'checkin')); its queue record goes through the same fields
    queueRun({ state: d.state, locksDir: path.join(d.t, 'locks'), lock: false, executor: 'fake', kind: 'checkin', lane: 'checkin', worktree: d.wt, brief: d.brief, promptText: 'x', budget: {}, budget_file: path.join(d.t, 'local', 'budget.json'),
      profile: profileOf(policy, 'checkin'), after: parseAfter(`run:${d.gate}:done`) });
    assert.equal(recOf(d, 'checkin', 'checkin')?.launch_profile, want, `checkin: ${want}`);
  }
});
