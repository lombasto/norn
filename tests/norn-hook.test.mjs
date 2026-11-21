// hook-fast S1: norn-hook (engine/hook-rs), the per-tool-call hooks of a claude run - the mail flag (Q-b-46 ruling) and the scope
// fast path. The binary is built by ensureHook (cargo) when missing or stale; every case drives the real binary as Claude Code does
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
import { ensureHook, hookProblem, hookEntry } from '../engine/lib/hookbin.mjs';

const built = ensureHook({ err: s => process.stderr.write(s + '\n') });
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
  assert.equal(hookProblem(), null);
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
});
