// hook-fast S1: norn-hook (engine/hook-rs), the per-tool-call hooks of a claude run - the mail flag (Q-b-46 ruling) and the scope
// fast path. The binary is built by ensurePart('hook') (cargo --locked) when missing or stale; every case drives the real binary as Claude Code does
// (the hook entry of the run's --settings: exec form, META_RUN_ID in the env, the payload on stdin). A --node that does not exist
// proves a call never started Node: norn-hook would exit 1 naming it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkTmp } from './helpers/tmp.mjs';
import { record } from '../engine/lib/records.mjs';
import { sendMail, ackMail, flagFile, loadMail } from '../engine/lib/mail.mjs';
import { writeScopeFile, scopeFile, scopeCheck, denyJson } from '../engine/lib/scope.mjs';
import { ensurePart, partProblem, hookEntry, binOf, srcOf, sourceHash } from '../engine/lib/rustbin.mjs';
import { writeWarnTable, warnsOf } from '../engine/lib/codewarn.mjs';

const built = ensurePart('hook', { err: s => process.stderr.write(s + '\n') });
const NO_NODE = path.join(mkTmp('meta-nohook-'), 'no-node.exe');
const hook = (sub, state, { input = '', node = process.execPath, run = 'RUN-1' } = {}) => {
  const e = hookEntry(sub, state);
  return spawnSync(e.command, e.args.map((x, i) => (e.args[i - 1] === '--node' ? node : x)), { input, encoding: 'utf8', env: { ...process.env, META_RUN_ID: run } });
};
// what `norn scope check` prints for a payload (in-process: its one function, no Node start per case)
const nodeSays = (state, input) => { const r = scopeCheck({ state, run: 'RUN-1', payload: JSON.parse(input) }); return r.deny ? denyJson(r.deny) + '\n' : ''; };
const silent = (r, what) => { assert.equal(r.status, 0, `${what}: ${r.stderr}`); assert.equal(r.stdout, '', what); };

test('norn setup builds norn-hook: it is there and newer than its source', () => {
  assert.ok(built.ok, built.why);
  assert.equal(partProblem('hook'), null);
});

test('norn-hook version: { crate, store_schema: null, source } - source is the hash of the sources it was built from (rustbin sourceHash)', () => {
  const r = spawnSync(binOf('hook'), ['version'], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { crate: '0.1.0', store_schema: null, source: sourceHash(srcOf('hook')) });
});

test('mail: a send raises the flag of each running run its address reaches (run, lane:, role:checkin); the hook runs Node only on the flag and clears it', () => {
  const s = mkTmp('meta-hookmail-');
  const run = data => record(s, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'fake', lane: 'demo', ...data } }).id;
  const a = run(), b = run({ lane: 'other' }), chk = run({ kind: 'checkin', lane: 'checkin' }), gone = run();
  record(s, { kind: 'run', ev: 'end', id: gone, by: 'launcher', data: { exit: 0, outcome: 'done' } });
  const up = () => [a, b, chk, gone].filter(r => fs.existsSync(flagFile(s, r)));
  assert.deepEqual(up(), []);
  silent(hook('mail', s, { run: a, node: NO_NODE }), 'no flag: no Node');
  sendMail(s, { by: 'controller', to: a, subject: 'one', body: 'b' });
  assert.deepEqual(up(), [a]);
  sendMail(s, { by: 'controller', to: 'lane:demo', subject: 'lane', body: 'b' });
  assert.deepEqual(up(), [a], 'lane:demo reaches a only (gone has ended)');
  sendMail(s, { by: 'controller', to: 'role:checkin', subject: 'role', body: 'b' });
  assert.deepEqual(up(), [a, chk]);
  const h = hook('mail', s, { run: a });
  assert.equal(h.status, 0, h.stderr);
  const ctx = JSON.parse(h.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /MAIL-1 .*one/); assert.match(ctx, /MAIL-2 .*lane/);
  assert.deepEqual(up(), [chk], 'the delivery cleared the flag');
  silent(hook('mail', s, { run: a, node: NO_NODE }), 'flag down: no Node');
  ackMail(s, { by: 'worker', run: a, id: 'MAIL-1' });
  assert.deepEqual(up(), [chk], 'an ack raises nothing');
  assert.equal(loadMail(s)['MAIL-3'].state, 'queued');
  assert.match(JSON.parse(hook('mail', s, { run: chk }).stdout).hookSpecificOutput.additionalContext, /MAIL-3/);
  assert.deepEqual(up(), []);
});

function world() {
  const root = mkTmp('meta-hookscope-'), wt = path.join(root, 'Wt'), notes = path.join(root, 'reviews', 'lane', 'NOTES.md'), extra = path.join(root, 'extra'), state = path.join(root, 'state');
  for (const d of [wt, extra, path.dirname(notes), path.join(state, 'runs')]) fs.mkdirSync(d, { recursive: true });
  const brief = path.join(root, 'brief.md');
  fs.writeFileSync(brief, '# t\nScope: engine/lib/**, tests/*.mjs, ./docs/\nDone: ## DONE\n');
  const spec = { run: 'RUN-1', lane: 'demo', kind: 'run', worktree: wt, addDirs: [extra], notes, brief, state };
  fs.writeFileSync(path.join(state, 'runs', 'RUN-1.spec.json'), JSON.stringify(spec));
  writeScopeFile(state, 'RUN-1', spec);
  return { root, wt, notes, extra, state, brief };
}
const pay = (tool_name, tool_input, cwd) => JSON.stringify({ session_id: 'S', hook_event_name: 'PreToolUse', tool_name, tool_input, cwd });

test('scope: the calls scope.mjs surely allows pass without Node; every other call gets exactly Node\'s answer', () => {
  const w = world(), sub = (...p) => path.join(w.wt, ...p);
  const pass = [
    pay('Bash', { command: 'git status && git diff --stat | head -5' }, w.wt), pay('Bash', { command: 'grep -rn "x" engine/lib; sed -n 1,5p a.mjs' }, w.wt),
    pay('PowerShell', { command: 'Get-ChildItem engine' }, w.wt), pay('Read', { file_path: 'C:/anywhere' }, w.wt), pay('Bash', {}, w.wt),
    pay('Edit', { file_path: sub('engine', 'lib', 'x.mjs') }, w.wt), pay('Write', { file_path: 'tests/a.mjs' }, w.wt),
    pay('Write', { file_path: sub('docs', 'a', 'b.md') }, w.wt), pay('Write', { file_path: w.notes }, w.wt), pay('Write', { file_path: path.join(w.extra, 'y') }, w.wt),
    pay('Edit', { file_path: path.join(w.wt.toUpperCase(), 'ENGINE', 'LIB', 'X.mjs') }, w.wt),
  ];
  if (process.platform !== 'win32') pass.pop();   // POSIX keeps case: another file
  for (const p of pass) {
    silent(hook('scope', w.state, { input: p, node: NO_NODE }), p);
    assert.equal(nodeSays(w.state, p), '', `Node agrees: ${p}`);
  }
  const judged = [
    pay('Bash', { command: 'git push --force' }, w.wt), pay('Bash', { command: 'git push origin feat/x' }, w.wt), pay('Bash', { command: 'rm -rf ../other' }, w.wt),
    pay('Bash', { command: 'node --test tests/' }, w.wt), pay('Bash', { command: 'bash -c "gh repo delete me/x"' }, w.wt),
    pay('Edit', { file_path: sub('README.md') }, w.wt), pay('Write', { file_path: path.join(w.root, 'stray.txt') }, w.wt), pay('Edit', { file_path: '../x/../Wt/tests/a/b.mjs' }, w.wt),
  ];
  for (const p of judged) {
    const h = hook('scope', w.state, { input: p });
    assert.equal(h.status, 0, h.stderr);
    assert.equal(h.stdout, nodeSays(w.state, p), p);
  }
  assert.match(hook('scope', w.state, { input: judged[0] }).stdout, /"permissionDecision":"deny".*force/);
  // a run with no scope file (its spec cannot be read either): Node's fail-closed refusal
  assert.match(JSON.parse(hook('scope', w.state, { input: pass[0], run: 'RUN-9' }).stdout).hookSpecificOutput.permissionDecisionReason, /spec/);
  // the brief edited since launch: a file call goes to Node (scopeOf reads the brief at each call); a shell call does not need it
  fs.writeFileSync(w.brief, '# t\nScope: docs\nDone: ## DONE\n');
  fs.utimesSync(w.brief, new Date(), new Date(Date.now() + 5000));
  assert.equal(hook('scope', w.state, { input: pass[5], node: NO_NODE }).status, 1);
  assert.match(hook('scope', w.state, { input: pass[5] }).stdout, /outside the brief's Scope/);
  silent(hook('scope', w.state, { input: pass[0], node: NO_NODE }), 'shell call');
  assert.ok(fs.existsSync(scopeFile(w.state, 'RUN-1')));
  // test-diet S1: a run whose policy.tests checks nothing (tests_free in the scope file) passes its test commands here; by default
  // (policy.tests light, a budget) a test command goes to Node, `norn tests run` included
  const test = pay('Bash', { command: 'node --test tests/a.test.mjs' }, w.wt), nt = pay('Bash', { command: 'norn tests run --changed' }, w.wt);
  assert.equal(JSON.parse(fs.readFileSync(scopeFile(w.state, 'RUN-1'), 'utf8')).tests_free, false);
  for (const p of [test, nt]) assert.equal(hook('scope', w.state, { input: p, node: NO_NODE }).status, 1, `Node judges: ${p}`);
  const free = path.join(w.root, 'free.json');
  fs.writeFileSync(free, JSON.stringify({ schema: 1, name: 'demo', title: 'Demo', root: w.root.replace(/\\/g, '/'), policy: { tests: { mode: 'changed', run_budget_min: 0, browser: 'allow', full_suite: 'allow' } } }));
  const spec = JSON.parse(fs.readFileSync(path.join(w.state, 'runs', 'RUN-1.spec.json'), 'utf8'));
  writeScopeFile(w.state, 'RUN-1', { ...spec, ctx_from: free });
  for (const p of [test, nt]) silent(hook('scope', w.state, { input: p, node: NO_NODE }), p);
  assert.equal(hook('scope', w.state, { input: judged[0], node: NO_NODE }).status, 1, 'the other checks stay');
});

// RM-a-67 warn-on-edit: the PostToolUse hook prints a risky file's line (codewarn.mjs's table) on a run's first edit of it, without Node
function warnWorld(mode, { subdir = '' } = {}) {
  const root = mkTmp('meta-hookwarn-'), wt = path.join(root, 'Wt'), state = path.join(root, 'state'), proj = path.join(root, 'project.json');
  for (const d of [path.join(wt, subdir), path.join(state, 'runs')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(proj, JSON.stringify({ schema: 1, name: 'demo', policy: mode ? { code: { warn: mode } } : {} }));
  const runs = [1, 2].map(() => record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'fake', lane: 'demo' } }).id);   // RUN-1 odd, RUN-2 even
  for (const run of runs) fs.writeFileSync(path.join(state, 'runs', `${run}.spec.json`), JSON.stringify({ run, worktree: wt, ctx_from: proj, state, ...(subdir ? { subdir } : {}) }));
  const row = o => ({ landings: 9, partners: [], fixes: { n_90d: 0, n_365d: 0, last: [] }, fan_in: 0, ...o });
  writeWarnTable(state, { at: '2026-11-24T00:00:00.000Z', sha: '1a2b3c4d5e6f', basis: 'measured', limits: { fix_short_days: 90 }, files: { 'lib/Core.mjs': row({ fan_in: 41 }), 'lib/calm.mjs': row({}) } });
  const edit = (file, tool = 'Edit') => JSON.stringify({ session_id: 'S', hook_event_name: 'PostToolUse', tool_name: tool, tool_input: { file_path: file }, cwd: path.join(wt, subdir) });
  return { state, edit, line: 'lib/Core.mjs: 41 files import this (measured at 1a2b3c4d5e6f)' };
}
const said = r => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout).hookSpecificOutput.additionalContext; };

test('warn: switch on, the first edit of a file in the table shows its line once; other files, other tools and a second edit say nothing; the run record counts', () => {
  const w = warnWorld('on', { subdir: 'apps/web' }), h = (input, run = 'RUN-1', node = NO_NODE) => hook('mail', w.state, { input, node, run });
  assert.equal(said(h(w.edit('lib/Core.mjs'))), w.line, 'a monorepo project: the path is relative to its folder');
  silent(h(w.edit('lib/Core.mjs', 'Write')), 'once per file per run');
  silent(h(w.edit('lib/calm.mjs')), 'under every threshold');
  silent(h(w.edit('../other/lib/Core.mjs')), 'outside the project folder');
  silent(h(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls lib/Core.mjs' } })), 'not an edit');
  assert.deepEqual(warnsOf(w.state, 'RUN-1'), { mode: 'on', group: 'warn', shown: 1, files: ['lib/Core.mjs'] });
  // the flag up too: Node delivers the mail, the line goes first in the same answer; the mail hook alone after that
  sendMail(w.state, { by: 'controller', to: 'RUN-2', subject: 'hello', body: 'b' });
  const both = said(h(w.edit('lib/Core.mjs', 'NotebookEdit').replace('file_path', 'notebook_path'), 'RUN-2', process.execPath));
  assert.ok(both.startsWith(`${w.line}\n\n`), both); assert.match(both, /MAIL-1 .*hello/);
  silent(h(w.edit('lib/Core.mjs'), 'RUN-2'), 'shown once, the flag down');
  assert.equal(warnsOf(w.state, 'RUN-2').shown, 1);
});

test('warn: the switch off (the default), no table, and the control group of ab say nothing and start no Node', () => {
  const off = warnWorld(null);
  silent(hook('mail', off.state, { input: off.edit('lib/Core.mjs'), node: NO_NODE }), 'switch off');
  assert.equal(warnsOf(off.state, 'RUN-1'), null, 'an off run is not marked');
  const none = warnWorld('on');
  fs.rmSync(path.join(none.state, 'code', 'warn.json'));
  silent(hook('mail', none.state, { input: none.edit('lib/Core.mjs'), node: NO_NODE }), 'no table');
  const ab = warnWorld('ab');
  silent(hook('mail', ab.state, { input: ab.edit('lib/Core.mjs'), node: NO_NODE, run: 'RUN-1' }), 'odd run: control');
  assert.deepEqual(warnsOf(ab.state, 'RUN-1'), { mode: 'ab', group: 'control', shown: 0, files: [] });
  assert.equal(said(hook('mail', ab.state, { input: ab.edit('lib/Core.mjs'), node: NO_NODE, run: 'RUN-2' })), ab.line, 'even run: the warn group');
  assert.equal(warnsOf(ab.state, 'RUN-2').group, 'warn');
});
