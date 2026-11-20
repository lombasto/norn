// META-DOD 2 (owner DIR-68): what a claude run may touch, enforced while it runs - deny rules + one PreToolUse hook
// (norn scope check). Temp dirs only; the hook is driven with Claude Code's documented PreToolUse payload (code.claude.com/docs hooks).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkTmp } from './helpers/tmp.mjs';
import { checkTool, scopeOf, scopeSettings, scopeHookOf, refusals, refusalFeed, refusalsFile, withRefusals } from '../engine/lib/scope.mjs';
import { scopeOfLaunch, mailHookOf } from '../engine/lib/runs.mjs';
import { SETTINGS, sectionOf, withDefaults } from '../engine/lib/policy.mjs';
import { adapterFor } from '../engine/lib/harness/index.mjs';
import { guardRows } from '../engine/lib/guardview.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });

function world() {
  const root = mkTmp('meta-scope-'), wt = path.join(root, 'wt'), other = path.join(root, 'other'), notes = path.join(root, 'reviews', 'lane', 'NOTES.md');
  const extra = path.join(root, 'extra'), state = path.join(root, 'state');
  for (const d of [wt, other, extra, path.dirname(notes), state]) fs.mkdirSync(d, { recursive: true });
  const brief = path.join(root, 'brief.md');
  fs.writeFileSync(brief, '# t\nScope: engine/lib/**, tests/**, docs\nTests: tests/a.test.mjs\nDone: ## DONE\n');
  return { root, wt, other, notes, extra, state, brief, spec: { run: 'RUN-1', lane: 'demo', kind: 'run', worktree: wt, addDirs: [extra], notes, brief, state } };
}
const ctx = (w, more = {}) => scopeOf({ ...w.spec, ...more });
const bash = (command, cwd) => ({ tool_name: 'Bash', tool_input: { command }, cwd });
const refusedBy = (r, re) => { assert.ok(r, 'refused'); assert.match(r, re); };

test('file tools: inside the worktree (in Scope), its addDirs and the NOTES folder pass; outside or outside Scope is refused with a plain reason', () => {
  const w = world(), c = ctx(w);
  const edit = (p, tool = 'Edit') => checkTool({ tool_name: tool, tool_input: { file_path: p }, cwd: w.wt }, c);
  assert.equal(edit(path.join(w.wt, 'engine', 'lib', 'x.mjs')), null);
  assert.equal(edit(path.join(w.wt, 'docs', 'a.md'), 'Write'), null);
  assert.equal(edit(path.join(w.extra, 'y.txt'), 'Write'), null);
  assert.equal(edit(w.notes, 'Write'), null);
  assert.equal(edit(path.join(path.dirname(w.notes), 'shot-dark.png'), 'Write'), null);
  refusedBy(edit(path.join(w.root, 'c', 'stray.txt'), 'Write'), /outside .*worktree/i);
  refusedBy(edit(path.join(w.wt, 'README.md')), /Scope/);
  refusedBy(checkTool({ tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(w.other, 'n.ipynb') }, cwd: w.wt }, c), /outside/);
  // no Scope line in the brief: the whole worktree
  fs.writeFileSync(w.brief, '# no ready lines\n');
  assert.equal(checkTool({ tool_name: 'Edit', tool_input: { file_path: path.join(w.wt, 'README.md') }, cwd: w.wt }, ctx(w)), null);
  // a relative path resolves against the call's cwd
  assert.equal(checkTool({ tool_name: 'Write', tool_input: { file_path: 'tests/b.test.mjs' }, cwd: w.wt }, ctx(w)), null);
});

test('git: force push in any spelling, push to main / master and remote branch deletes are refused; a feature push passes', () => {
  const w = world(), c = ctx(w);
  for (const cmd of ['git push --force', 'git push -f origin feat/x', 'git push origin feat/x --force-with-lease', 'git -C . push -f', 'git push origin +feat/x',
    'git -c push.default=current push --force', 'sh -c "git push --force"', 'cd sub && git push --mirror', 'FOO=1 git push -uf origin feat/x'])
    refusedBy(checkTool(bash(cmd, w.wt), c), /force|mirror/i);
  for (const cmd of ['git push origin main', 'git push origin HEAD:main', 'git push origin feat/x:refs/heads/master', 'git push --all origin'])
    refusedBy(checkTool(bash(cmd, w.wt), c), /main|master|every branch/);
  for (const cmd of ['git push origin --delete feat/old', 'git push origin :feat/old']) refusedBy(checkTool(bash(cmd, w.wt), c), /delet/);
  assert.equal(checkTool(bash('git push -u origin feat/x', w.wt), c), null);
  assert.equal(checkTool(bash('git status && git push origin feat/x 2>&1 | tail -3', w.wt), c), null);
  // a MERGE stage run opens a PR (norn merge-land) and never pushes main; a check-in works in the main checkout and may push it, never by force
  refusedBy(checkTool(bash('git push origin main', w.wt), ctx(w, { stage: 'MERGE' })), /main/);
  const k = ctx(w, { kind: 'checkin' });
  assert.equal(checkTool(bash('git push origin main', w.wt), k), null);
  refusedBy(checkTool(bash('git push --force origin main', w.wt), k), /force/);
});

test('a bare git push from a checkout on main is a push to main', () => {
  const w = world();
  git(w.wt, 'init', '-q', '-b', 'main');
  refusedBy(checkTool(bash('git push', w.wt), ctx(w)), /main/);
  git(w.wt, 'checkout', '-q', '-b', 'feat/x');
  assert.equal(checkTool(bash('git push', w.wt), ctx(w)), null);
});

test('reset --hard / clean -fdx / branch and worktree deletes pass in the own worktree only; rm -rf outside the worktree is refused', () => {
  const w = world(), c = ctx(w);
  assert.equal(checkTool(bash('git reset --hard HEAD~1', w.wt), c), null);
  assert.equal(checkTool(bash('git clean -fdx', w.wt), c), null);
  assert.equal(checkTool(bash('git branch -D tmp/x', w.wt), c), null);
  refusedBy(checkTool(bash(`git -C "${w.other}" reset --hard`, w.wt), c), /reset --hard/);
  refusedBy(checkTool(bash(`cd "${w.other}" && git clean -fdx`, w.wt), c), /clean/);
  refusedBy(checkTool(bash('git reset --hard', w.other), c), /outside/);
  refusedBy(checkTool(bash(`git -C "${w.other}" branch -D feat/y`, w.wt), c), /branch/);
  refusedBy(checkTool(bash('git branch -d main', w.wt), c), /main/);
  refusedBy(checkTool(bash(`git worktree remove --force "${w.other}"`, w.wt), c), /worktree/);
  assert.equal(checkTool(bash(`git worktree remove "${w.wt}"`, w.wt), c), null);
  refusedBy(checkTool(bash(`rm -rf "${w.other}"`, w.wt), c), /rm -r/);
  refusedBy(checkTool(bash('rm -rf ../other', w.wt), c), /outside/);
  refusedBy(checkTool(bash('rm -fr $NORN_SCOPE_TEST_UNSET/x', w.wt), c), /cannot tell|unknown/i);
  refusedBy(checkTool({ tool_name: 'PowerShell', tool_input: { command: `Remove-Item -Recurse -Force "${w.other}"` }, cwd: w.wt }, c), /outside/);
  assert.equal(checkTool(bash('rm -rf build dist/*', w.wt), c), null);
  assert.equal(checkTool(bash(`rm -rf "${path.join(w.extra, 'old')}"`, w.wt), c), null);
  assert.equal(checkTool(bash('rm -f ../other/one-file.txt', w.wt), c), null, 'a plain rm is not rm -r');
});

test('gh: repo edit / visibility / delete are refused; other gh calls pass', () => {
  const w = world(), c = ctx(w);
  for (const cmd of ['gh repo edit --visibility public', 'gh repo delete me/x --yes', 'gh api -X PATCH repos/me/x -f visibility=public', 'gh api --method DELETE repos/me/x'])
    refusedBy(checkTool(bash(cmd, w.wt), c), /gh/);
  assert.equal(checkTool(bash('gh pr create --fill', w.wt), c), null);
  assert.equal(checkTool(bash('gh api repos/me/x/pulls', w.wt), c), null);
});

test('the claude command of a guarded run: one --settings with the deny rules, the write block, the PreToolUse scope hook beside the mail hook; the NOTES folder is a working directory', () => {
  const w = world(), hook = scopeHookOf({ executor: 'claude', state: w.state });
  assert.match(hook, /scope check --run \$META_RUN_ID --state "[^"]+"$/);
  const base = { ...w.spec, exe: 'claude', executor: 'claude', mode: 'write', model: 'opus', effort: 'medium', session_id: 'S', promptText: 'p', mail_hook: 'MAILHOOK' };
  const before = adapterFor('claude').command(base).args;
  assert.equal(before.filter(a => a === '--settings').length, 1, 'mail only: as before');
  const args = adapterFor('claude').command({ ...base, scope: scopeSettings(base, hook) }).args;
  assert.equal(args.filter(a => a === '--settings').length, 1);
  const set = JSON.parse(args[args.indexOf('--settings') + 1]);
  assert.equal(set.permissions.blockWritesOutsideWorkingDirectories, true);
  for (const r of ['Bash(git push --force*)', 'PowerShell(git push --force*)', 'Bash(gh repo delete*)', 'Bash(git push * main)']) assert.ok(set.permissions.deny.includes(r), r);
  assert.equal(set.hooks.PostToolUse[0].hooks[0].command, 'MAILHOOK');
  assert.equal(set.hooks.PreToolUse[0].matcher, 'Bash|PowerShell|Edit|Write|NotebookEdit');
  assert.equal(set.hooks.PreToolUse[0].hooks[0].command, hook);
  const dirs = args.flatMap((a, i) => (a === '--add-dir' ? [args[i + 1]] : []));
  assert.deepEqual(dirs, [w.wt, w.extra, path.dirname(w.notes)]);
  // a MERGE run opens a PR and gets the main rule like a lane run; only a check-in has none
  assert.ok(scopeSettings({ ...w.spec, stage: 'MERGE' }, hook).permissions.deny.includes('Bash(git push * main)'));
  assert.ok(!scopeSettings({ ...w.spec, kind: 'checkin' }, hook).permissions.deny.includes('Bash(git push * main)'));
});

test('norn scope check = the PreToolUse hook: a refusal is a deny with its reason, recorded for the run feed and the Slop list; a pass prints nothing', async () => {
  const w = world();
  fs.mkdirSync(path.join(w.state, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(w.state, 'runs', 'RUN-1.spec.json'), JSON.stringify(w.spec));
  const hook = (payload, run = 'RUN-1') => spawnSync(process.execPath, [META, 'scope', 'check', '--run', run, '--state', w.state],
    { input: JSON.stringify({ session_id: 'S', hook_event_name: 'PreToolUse', ...payload }), encoding: 'utf8', env: { ...process.env, META_RUN_ID: 'RUN-1' } });
  const ok = hook(bash('git push origin feat/x', w.wt));
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), '');
  const no = hook(bash('git push --force', w.wt), '$META_RUN_ID');
  assert.equal(no.status, 0, no.stderr);
  const o = JSON.parse(no.stdout).hookSpecificOutput;
  assert.equal(o.hookEventName, 'PreToolUse');
  assert.equal(o.permissionDecision, 'deny');
  assert.match(o.permissionDecisionReason, /^Norn refused this Bash call: .*force/);
  const rs = refusals(w.state);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].run, 'RUN-1');
  assert.equal(rs[0].tool, 'Bash');
  const f = (await refusalFeed(w.state, 'RUN-1', {}));
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].kind, 'error');
  assert.match(f.events[0].summary, /refused/);
  assert.equal((await refusalFeed(w.state, 'RUN-1', f.cursor)).events.length, 0, 'the cursor moves past it');
  assert.equal((await refusalFeed(w.state, 'RUN-2', {})).events.length, 0, 'another run sees none');
  const rows = guardRows({ refusals: rs }).filter(r => r.id.startsWith('R-'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'code');
  assert.equal(rows[0].run, 'RUN-1');
  assert.match(rows[0].why, /force/);
  // a run whose spec cannot be read is refused (the guard fails closed), with the reason
  const lost = hook(bash('ls', w.wt), 'RUN-9');
  assert.match(JSON.parse(lost.stdout).hookSpecificOutput.permissionDecisionReason, /spec/);
});

// ROUND 2: the guard is per project - policy.dod.scope off | on (default off), read at launch from the run's CURRENT project.json
const projectWith = (w, dod) => {
  const f = path.join(w.root, `project-${dod?.scope ?? 'none'}.json`);
  fs.writeFileSync(f, JSON.stringify({ schema: 1, name: 'demo', title: 'Demo', root: w.root.replace(/\\/g, '/'), policy: dod ? { dod } : {} }));
  return f;
};

test('the launcher guards write runs of executors that run Claude Code hooks; read-only runs and other harnesses get no scope part', () => {
  const w = world();
  w.spec.ctx_from = projectWith(w, { scope: 'on' });
  const s = scopeOfLaunch({ ...w.spec, executor: 'claude' });
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, scopeHookOf({ state: w.state }));
  assert.equal(scopeOfLaunch({ ...w.spec, executor: 'claude', mode: 'read-only' }), undefined);
  assert.equal(scopeOfLaunch({ ...w.spec, executor: 'codex' }), undefined);
  assert.equal(scopeOfLaunch({ ...w.spec, executor: 'claude', state: undefined }), undefined);
});

test('policy.dod.scope: off (and the default) launches a claude run with no deny rules, no write block and the hook for shell tools only (the full-suite deny); on launches as round 1', () => {
  const w = world(), off = projectWith(w, { scope: 'off' }), none = projectWith(w, null), on = projectWith(w, { scope: 'on' });
  assert.equal(withDefaults({}).policy.dod.scope, 'off');
  const launch = o => { const spec = { ...w.spec, executor: 'claude', ...o }; return adapterFor('claude').command({ ...spec, mail_hook: mailHookOf(spec), scope: scopeOfLaunch(spec) }).args; };
  const settingsOf = args => JSON.parse(args[args.indexOf('--settings') + 1]);
  for (const o of [{ ctx_from: off }, { ctx_from: none }, { refill: { project_file: off } }, { env: { META_PROJECT: off } }, {}]) {
    assert.equal(scopeOfLaunch({ ...w.spec, executor: 'claude', ...o }).permissions, undefined, JSON.stringify(o));
    const args = launch(o), st = settingsOf(args);
    assert.equal(st.permissions, undefined); assert.equal(st.hooks.PreToolUse[0].matcher, 'Bash|PowerShell'); assert.ok(st.hooks.PostToolUse, 'the mail hook stays');
    assert.ok(args.includes(path.dirname(w.notes)), 'the NOTES folder comes with the hook (harness/claude.mjs: any scope part)');
  }
  for (const o of [{ ctx_from: on }, { refill: { project_file: on } }, { env: { META_PROJECT: on } }]) {
    const args = launch(o), st = settingsOf(args);
    assert.equal(st.permissions.blockWritesOutsideWorkingDirectories, true);
    assert.ok(st.permissions.deny.includes('Bash(git push --force*)'));
    assert.equal(st.hooks.PreToolUse[0].hooks[0].command, scopeHookOf({ state: w.state }));
    assert.ok(args.includes(path.dirname(w.notes)));
  }
  // the CURRENT policy: switching the project off reaches the next launch
  fs.writeFileSync(on, fs.readFileSync(off));
  assert.equal(scopeOfLaunch({ ...w.spec, executor: 'claude', ctx_from: on }).permissions, undefined);
  const row = SETTINGS.find(r => r.key === 'policy.dod.scope');
  assert.deepEqual([row.type, row.options, sectionOf(row).join('/')], ['enum', ['off', 'on'], 'agents/rounds']);
  assert.equal(SETTINGS.indexOf(row), SETTINGS.findIndex(r => r.key === 'policy.dod.ready') + 1, 'the row sits beside dod.ready');
});

test('TEST-GOVERNANCE S1: a fake worker (a resumed run too) issuing the full suite is denied by the hook, naming the changed-file command; scope off still denies it; full_suite = allow lets it run', () => {
  const w = world();
  fs.mkdirSync(path.join(w.state, 'runs'), { recursive: true });
  const project = policy => { const f = path.join(w.root, `project-${JSON.stringify(policy).replace(/\W/g, '')}.json`); fs.writeFileSync(f, JSON.stringify({ schema: 1, name: 'demo', title: 'Demo', root: w.root.replace(/\\/g, '/'), policy })); return f; };
  const hook = (spec, command) => {
    fs.writeFileSync(path.join(w.state, 'runs', 'RUN-1.spec.json'), JSON.stringify(spec));
    const r = spawnSync(process.execPath, [META, 'scope', 'check', '--run', 'RUN-1', '--state', w.state],
      { input: JSON.stringify({ session_id: 'S', hook_event_name: 'PreToolUse', ...bash(command, w.wt) }), encoding: 'utf8', env: { ...process.env, META_RUN_ID: 'RUN-1' } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason : null;
  };
  const off = { ...w.spec, ctx_from: project({ dod: { scope: 'off' } }) };
  for (const spec of [w.spec, off, { ...off, resumes: 1, resumeOf: 'RUN-0' }, { ...off, stage: 'MERGE' }]) {
    const why = hook(spec, 'cd ' + w.wt + ' && node engine/bin/ci-suite.mjs');
    assert.match(why, /^Norn refused this Bash call: a full test suite \(ci-suite\)/);
    assert.match(why, /node engine\/bin\/ci-suite\.mjs --changed origin\/main/);
    assert.equal(hook(spec, 'node engine/bin/ci-suite.mjs --changed origin/main'), null);
    assert.equal(hook(spec, 'META_ROOT=/tmp/r node --test tests/a.test.mjs'), null);
  }
  assert.match(hook(off, 'python -m pytest tests -q'), /python -m pytest <tests\/test_x\.py>/);
  // scope off: the full-suite deny only, no file guard
  assert.equal(hook(off, 'git push --force'), null);
  assert.match(hook(w.spec, 'git push --force'), /force/, 'a spec with no project file keeps the whole guard');
  assert.equal(hook({ ...w.spec, ctx_from: project({ tests: { budget: { full_suite: 'allow' } }, dod: { scope: 'on' } }) }, 'node engine/bin/ci-suite.mjs'), null);
  assert.ok(refusals(w.state).some(r => /full test suite/.test(r.why)), 'the deny is recorded for the run feed and the Slop list');
});

test('TEST-GOVERNANCE S1: the launch installs the hook alone (shell tools) when the scope guard is off and full_suite = deny; none with allow; the Settings row', () => {
  const w = world(), f = policy => { const p = path.join(w.root, `p-${Object.keys(policy).join('')}.json`); fs.writeFileSync(p, JSON.stringify({ schema: 1, name: 'demo', title: 'Demo', root: w.root.replace(/\\/g, '/'), policy })); return p; };
  const s = scopeOfLaunch({ ...w.spec, executor: 'claude', ctx_from: f({ dod: { scope: 'off' } }) });
  assert.deepEqual(s, { hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: scopeHookOf({ state: w.state }), timeout: 30 }] }] } });
  assert.equal(scopeOfLaunch({ ...w.spec, executor: 'claude', ctx_from: f({ tests: { budget: { full_suite: 'allow' } } }) }), undefined);
  assert.equal(scopeOfLaunch({ ...w.spec, executor: 'claude', mode: 'read-only' }), undefined);
  assert.equal(withDefaults({}).policy.tests.budget.full_suite, 'deny');
  const row = SETTINGS.find(r => r.key === 'policy.tests.budget.full_suite');
  assert.deepEqual([row.type, row.options, row.recommended, sectionOf(row).join('/')], ['enum', ['deny', 'allow'], 'deny', 'agents/rounds']);
  assert.match(row.help, /runs in CI/);
});

test('the run feed: the adapter poll plus the run refusals, both cursor keys carried', async () => {
  const w = world();
  fs.mkdirSync(path.dirname(refusalsFile(w.state)), { recursive: true });
  fs.writeFileSync(refusalsFile(w.state), JSON.stringify({ at: '2026-11-14T00:00:00Z', run: 'RUN-1', tool: 'Write', target: 'C:/c/x', why: 'outside' }) + '\n');
  const r = (await withRefusals({ events: [{ kind: 'tool', at: { transcript: 10 } }], cursor: { transcript: 10 } }, w.state, 'RUN-1', { scope: 0 }));
  assert.deepEqual(r.events.map(e => e.kind), ['tool', 'error']);
  assert.deepEqual(r.events[0].at, { scope: 0, transcript: 10 });
  assert.equal(r.events[1].at.transcript, 10);
  assert.ok(r.cursor.scope > 0 && r.cursor.transcript === 10);
  assert.equal((await withRefusals({ events: [], cursor: { transcript: 10 } }, w.state, 'RUN-1', r.cursor)).events.length, 0);
});
