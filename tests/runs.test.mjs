// S4 runs + supervisor (META-GENERAL-DESIGN D6-D9, 3.3 run row, 5, 12-S4): FAKE executor only, temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCodexLog, parseClaudeFinal, buildCommand, acquireLock, lockPath, sweepLost, startRun, stopRun, RunRefused, hbPath } from '../engine/lib/runs.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { resolveShim } from '../engine/lib/paths.mjs';
import { GROK } from './helpers/command-matrix.mjs';
import { settled } from './helpers/settled.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const META = path.join(HERE, '..', 'engine', 'bin', 'norn.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) {
  const t0 = performance.now();
  for (;;) { const v = fn(); if (v) return v; if (performance.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(50); }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function sandbox() {
  const t = mkTmp('meta-runs-');
  const d = { t, state: path.join(t, 'state', 'demo'), locks: path.join(t, 'state', 'locks'), wt: path.join(t, 'wt'), wt2: path.join(t, 'wt2'), notes: path.join(t, 'NOTES.md') };
  for (const k of ['state', 'locks', 'wt', 'wt2']) fs.mkdirSync(d[k], { recursive: true });
  d.brief = (body, name = 'brief.md') => { const f = path.join(t, name); fs.writeFileSync(f, body); return f; };
  d.tickFile = path.join(t, 'ticks.txt');
  d.tick = [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(path.join(t, 'ticks.txt'))}, 'tick\\n')`];
  d.runs = () => Object.values(loadState(d.state).items).filter(i => i.kind === 'run');
  d.item = id => loadState(d.state).items[id];
  d.opts = (o = {}) => ({ state: d.state, locksDir: d.locks, executor: 'fake', lane: 'demo', worktree: d.wt, notes: d.notes, hbMs: 150, staleMs: 3000,
    policy: { auto_resume_max: 0 }, budget: {}, tick: d.tick, ...o });
  // ended AND its supervisor gone: its end-of-run tail (lock release, queue fill, tick) is done (FINDING L1)
  d.ended = id => waitFor(() => { const it = d.item(id); return settled(it) && it; });
  return d;
}

// ---------- pure parts ----------
test('codex exit banner: model, effort, session id and tokens used parse from the fixture', () => {
  const r = parseCodexLog(fs.readFileSync(path.join(HERE, 'fixtures', 'runs', 'codex-banner.log'), 'utf8'));
  assert.deepEqual(r, { model: 'gpt-6-astra', effort: 'xhigh', session_id: '01a18e15-b95e-7293-b130-0cf69a414641', tokens: 119286 });
  assert.deepEqual(parseCodexLog('OpenAI Codex\nerror: boom\n'), { model: null, effort: null, session_id: null, tokens: null });
});

test('claude --output-format json final: usage + session id + cost; junk -> nulls', () => {
  const j = { type: 'result', is_error: false, session_id: 'abc', total_cost_usd: 1.5, usage: { input_tokens: 3, cache_read_input_tokens: 400, cache_creation_input_tokens: 50, output_tokens: 7 } };
  assert.deepEqual(parseClaudeFinal(JSON.stringify(j)), { session_id: 'abc', cost_usd: 1.5, is_error: false, usage: j.usage });
  assert.deepEqual(parseClaudeFinal('not json'), { session_id: null, cost_usd: null, is_error: null, usage: null });
});

test('command lines: claude gets --session-id + agent / model / effort; codex reads the brief on stdin with -o final; grok prompt file', () => {
  const base = { brief: '/b/brief.md', worktree: '/w', notes: '/n/NOTES.md', lane: 'gen', project: 'kestrel', final: '/s/f.json', resumes: 0 };
  const c = buildCommand({ ...base, executor: 'claude', exe: '/x/claude', agent: 'kestrel-implementer', model: 'claude-opus-5-5', effort: 'medium', session_id: '11111111-2222-3333-4444-555555555555', headless: 'HEADLESS RULES' });
  assert.equal(c.exe, '/x/claude');
  const at = f => c.args[c.args.indexOf(f) + 1];
  assert.equal(at('--session-id'), '11111111-2222-3333-4444-555555555555');
  assert.equal(at('--agent'), 'kestrel-implementer'); assert.equal(at('--model'), 'claude-opus-5-5'); assert.equal(at('--effort'), 'medium');
  assert.equal(at('--output-format'), 'json'); assert.equal(at('--append-system-prompt'), 'HEADLESS RULES'); assert.equal(at('--add-dir'), '/w');
  assert.equal(at('--remote-control'), 'kestrel-gen'); assert.equal(at('--permission-mode'), 'bypassPermissions');
  assert.match(at('-p'), /Read the brief \/b\/brief\.md and execute it exactly\. Your worktree is \/w\./);
  assert.doesNotMatch(at('-p'), /AUTO-RESUME/);
  assert.equal(c.stdout, 'final'); assert.equal(c.parse, 'claude');
  const r = buildCommand({ ...base, executor: 'claude', exe: '/x/claude', agent: 'a', model: 'm', effort: 'e', session_id: 'u', resumes: 2, handoffFile: '/s/results/RUN-1/HANDOFF.md' });
  assert.match(r.args[r.args.indexOf('-p') + 1], /AUTO-RESUME \(2\) after the previous agent's hand-off: read its hand-off \/s\/results\/RUN-1\/HANDOFF\.md first/);
  const x = buildCommand({ ...base, executor: 'codex-sol', exe: '/x/codex', model: 'gpt-6.1-sol', effort: 'medium', writable_roots: ['/r/.git', '/notes'] });
  assert.deepEqual(x.args.slice(0, 3), ['exec', '--skip-git-repo-check', '--disable']);
  assert.equal(x.args[x.args.indexOf('-m') + 1], 'gpt-6.1-sol');
  assert.ok(x.args.includes('model_reasoning_effort="medium"'));
  assert.ok(x.args.includes(`sandbox_workspace_write.writable_roots=['/r/.git','/notes']`));
  assert.equal(x.args[x.args.indexOf('-o') + 1], '/s/f.json'); assert.equal(x.args.at(-1), '-');
  assert.equal(x.stdin, '/b/brief.md'); assert.equal(x.stdout, 'log'); assert.equal(x.parse, 'codex');
  const g = buildCommand({ ...base, executor: 'grok', provider: GROK, exe: '/x/grok', model: 'grok-4.7', effort: 'high' });
  assert.equal(g.args[g.args.indexOf('--prompt-file') + 1], '/b/brief.md'); assert.equal(g.args[g.args.indexOf('--cwd') + 1], '/w');
  assert.equal(g.parse, 'none');
  assert.throws(() => buildCommand({ ...base, executor: 'nope' }), /unknown executor/);
});

test('worktree lock: second writer refused (code 3) naming the holder; a stale lock is free', () => {
  const d = sandbox();
  const rel = acquireLock(d.locks, d.wt, { run: 'RUN-1' });
  assert.throws(() => acquireLock(d.locks, d.wt + path.sep, { run: 'RUN-2' }), e => e instanceof RunRefused && e.code === 3 && /RUN-1/.test(e.message));
  rel.release();
  acquireLock(d.locks, d.wt, { run: 'RUN-3' });
  const f = lockPath(d.locks, d.wt);
  fs.writeFileSync(f, JSON.stringify({ run: 'RUN-3', pid: 1, ts: new Date(Date.now() - 200000).toISOString() }));
  assert.equal(acquireLock(d.locks, d.wt, { run: 'RUN-4', staleMs: 120000 }).run, 'RUN-4');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).run, 'RUN-4');
});

test('stale heartbeat -> lost (role status); fresh heartbeat and interactive runs untouched', () => {
  const d = sandbox();
  const start = data => record(d.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'fake', lane: 'demo', ...data } }).id;
  const a = start({}), b = start({}), c = start({ kind: 'interactive' }), e = start({});
  fs.mkdirSync(path.join(d.state, 'hb'), { recursive: true });
  for (const id of [a, b]) fs.writeFileSync(hbPath(d.state, id), '{}');
  const old = new Date(Date.now() - 300000);
  fs.utimesSync(hbPath(d.state, a), old, old);
  const lost = sweepLost(d.state, { staleMs: 120000, by: 'status', now: () => new Date(Date.now() + 1000) });
  assert.deepEqual(lost.sort(), [a].sort());
  assert.equal(d.item(a).state, 'lost'); assert.match(d.item(a).lost.why, /heartbeat/);
  assert.equal(d.item(b).state, 'running'); assert.equal(d.item(c).state, 'running');
  // no heartbeat file at all: lost once the run is older than the threshold
  assert.equal(d.item(e).state, 'running');
  assert.deepEqual(sweepLost(d.state, { staleMs: 120000, by: 'status', now: () => new Date(Date.now() + 200000) }).sort(), [b, e].sort());
});

// ---------- supervised fake runs ----------
for (const [mode, outcome, exit] of [['done', 'done', 0], ['stopped', 'stopped', 0], ['handoff', 'handoff', 0], ['no-result', 'no-result', 0], ['crash', 'crash', 3]]) {
  test(`fake ${mode}: supervisor records exit ${exit} + outcome ${outcome} + usage, frees lock + heartbeat, ticks once`, async () => {
    const d = sandbox();
    const r = startRun(d.opts({ brief: d.brief(`mode: ${mode}\n`) }));
    assert.match(r.run, /^RUN-\d+$/);
    assert.equal(d.item(r.run).state, 'running');
    assert.equal(d.item(r.run).data.kind, 'fake');
    const it = await d.ended(r.run);
    assert.equal(it.state, 'exited');
    assert.equal(it.end.outcome, outcome); assert.equal(it.end.exit, exit);
    if (mode === 'stopped') assert.equal(it.end.why, 'c - fixture says so');
    assert.equal(it.end.usage.cache_read_input_tokens, 20);
    assert.ok(Number.isInteger(it.end.pid) && Number.isInteger(it.end.supervisor_pid));
    await waitFor(() => !fs.existsSync(lockPath(d.locks, d.wt)) && !fs.existsSync(hbPath(d.state, r.run)));
    await waitFor(() => fs.existsSync(d.tickFile));
    await sleep(300);
    assert.equal(fs.readFileSync(d.tickFile, 'utf8'), 'tick\n');
  });
}

test('auto-resume: HANDOFF restarts the lane (resume_of, count), the last run ends DONE, one tick at the end', async () => {
  const d = sandbox();
  const ledger = path.join(d.t, 'progress.md');
  const r = startRun(d.opts({ brief: d.brief('mode: handoff-once\n'), policy: { auto_resume_max: 2 }, ledger }));
  const first = await d.ended(r.run);
  assert.equal(first.end.outcome, 'handoff');
  const second = await waitFor(() => d.runs().find(x => x.data.resume_of === r.run));
  assert.equal((await waitFor(() => d.item(r.run).resume)).next, second.id);
  assert.equal(second.data.resumes, 1);
  const end2 = await d.ended(second.id);
  assert.equal(end2.end.outcome, 'done');
  assert.equal(d.runs().length, 2);
  await waitFor(() => fs.existsSync(d.tickFile)); await sleep(300);
  assert.equal(fs.readFileSync(d.tickFile, 'utf8'), 'tick\n');
  assert.match(fs.readFileSync(ledger, 'utf8'), new RegExp(`lane demo HANDOFF -> auto-resumed \\(1/2, same brief, fake [^)]*\\) ${second.id}$`, 'm'));
});

test('auto-resume cap: refusal is a run event naming "cap n/n"; PAUSED refuses too', async () => {
  const d = sandbox();
  const r = startRun(d.opts({ brief: d.brief('mode: handoff\n'), policy: { auto_resume_max: 1 } }));
  await d.ended(r.run);
  const second = await waitFor(() => d.runs().find(x => x.data.resume_of === r.run));
  const it = await waitFor(() => { const x = d.item(second.id); return x.resume && x; });
  assert.equal(it.end.outcome, 'handoff');
  assert.deepEqual(it.resume, { refused: 'cap 1/1', count: 1, max: 1 });
  assert.equal(d.runs().length, 2);
  await waitFor(() => fs.existsSync(d.tickFile));

  const p = sandbox();
  const paused = path.join(p.t, 'PAUSED'); fs.writeFileSync(paused, '');
  const q = startRun(p.opts({ brief: p.brief('mode: handoff\n'), policy: { auto_resume_max: 5 }, paused: [paused] }));
  const qi = await waitFor(() => { const x = p.item(q.run); return x.resume && x; });
  assert.deepEqual(qi.resume, { refused: 'paused', count: 0, max: 5 });
  assert.equal(p.runs().length, 1);
});

test('norn run CLI: second writer on the same worktree exits 3; worker cap exits 4; norn stop kills the whole tree', async () => {
  const d = sandbox();
  const budget = path.join(d.t, 'budget.json'); fs.writeFileSync(budget, JSON.stringify({ max_claude_workers: 1 }));
  const pids = path.join(d.t, 'pids.json');
  const env = { ...process.env, META_HB_MS: '150', META_NO_TICK: '1' };
  const cli = (...a) => { const x = spawnSync(process.execPath, [META, ...a], { env, encoding: 'utf8' }); return { code: x.status, out: x.stdout, err: x.stderr }; };
  const common = ['--executor', 'fake', '--state', d.state, '--locks', d.locks, '--budget', budget, '--notes', d.notes];
  const a = cli('run', ...common, '--lane', 'one', '--worktree', d.wt, '--brief', d.brief(`mode: sleep\nms: 60000\npids: ${pids}\n`));
  assert.equal(a.code, 0, a.err);
  const id = a.out.match(/STARTED (RUN-\d+)/)[1];
  const w = cli('run', ...common, '--lane', 'two', '--worktree', d.wt, '--brief', d.brief('mode: done\n', 'b2.md'));
  assert.equal(w.code, 3, w.out + w.err); assert.match(w.out, new RegExp(`REFUSED: worktree .* is held by ${id}`));
  const c = cli('run', ...common, '--lane', 'two', '--worktree', d.wt2, '--brief', d.brief('mode: done\n', 'b3.md'));
  assert.equal(c.code, 4, c.out + c.err); assert.match(c.out, /REFUSED: 1 claude workers running, budget max_claude_workers=1/);
  const p = await waitFor(() => fs.existsSync(pids) && JSON.parse(fs.readFileSync(pids, 'utf8')));
  const hb = JSON.parse(fs.readFileSync(hbPath(d.state, id), 'utf8'));
  assert.ok(alive(hb.supervisor_pid) && alive(p.pid) && alive(p.grandchild));
  const s = cli('stop', id, '--as', 'controller', '--state', d.state, '--locks', d.locks);
  assert.equal(s.code, 0, s.err);
  assert.equal(d.item(id).state, 'killed');
  await waitFor(() => !alive(hb.supervisor_pid) && !alive(p.pid) && !alive(p.grandchild), 10000);
  assert.ok(!fs.existsSync(lockPath(d.locks, d.wt)));
  await sleep(400);
  assert.equal(d.item(id).state, 'killed');
  assert.equal(cli('stop', id, '--as', 'controller', '--state', d.state, '--locks', d.locks).code, 2);
});

// CIRED-60fa8b6 R2: a stop that lands before the supervisor's first heartbeat found supervisor_pid null in the hb, killed nothing,
// and the supervisor + its `until` executor lived on for ever, beating every hbMs (a delegate / agnostic parent stopped ~3 s after
// its start on a loaded Windows box: 13 such pairs from this lane's suite runs, ~200 on the box). Red-first toy: stop in the same turn.
test('stopRun right after startRun (before the first heartbeat) still kills the supervisor and its executor', async () => {
  const d = sandbox();
  const pids = path.join(d.t, 'pids.json');
  const r = startRun({ state: d.state, locksDir: d.locks, executor: 'fake', lane: 'x', worktree: d.wt, notes: d.notes, hbMs: 150, tick: null,
    policy: { auto_resume_max: 0 }, budget: {}, brief: d.brief(`mode: sleep\nuntil: ${path.join(d.t, 'never')}\npids: ${pids}\n`) });
  const ev = stopRun({ state: d.state, locksDir: d.locks, run: r.run, by: 'owner' });
  assert.equal(ev.data.supervisor_pid, r.pid, 'the kill knows the supervisor the launcher spawned');
  await waitFor(() => !alive(r.pid), 60000);   // hang guard only: the supervisor dies at once once it is named
  const p = fs.existsSync(pids) ? JSON.parse(fs.readFileSync(pids, 'utf8')) : null;
  if (p) await waitFor(() => !alive(p.pid) && !alive(p.grandchild), 60000);
  assert.equal(d.item(r.run).state, 'killed');
});

// CIRED-b2caf4d: the same stop, but the supervisor's first beat lands between stopRun's hb read and its kill (CI Linux leg, under
// load): the stop knows only the supervisor, and on POSIX the executor leads its own process group - a group kill of the supervisor
// left the executor + its child alive. Deterministic toy: the executor is up and the hb is put back to the nameless read the stop saw.
test('a stop that read the hb before the first beat still kills an executor the supervisor has spawned since', async () => {
  const d = sandbox();
  const pids = path.join(d.t, 'pids.json');
  const r = startRun({ state: d.state, locksDir: d.locks, executor: 'fake', lane: 'x', worktree: d.wt, notes: d.notes, hbMs: 600000, tick: null,
    policy: { auto_resume_max: 0 }, budget: {}, brief: d.brief(`mode: sleep\nuntil: ${path.join(d.t, 'never')}\npids: ${pids}\n`) });
  await waitFor(() => fs.existsSync(pids));   // the executor is up: the supervisor's post-spawn beat (sync, right after spawn) is done
  const p = JSON.parse(fs.readFileSync(pids, 'utf8'));
  fs.writeFileSync(hbPath(d.state, r.run), JSON.stringify({ run: r.run, pid: null, supervisor_pid: r.pid, ts: new Date().toISOString() }));
  stopRun({ state: d.state, locksDir: d.locks, run: r.run, by: 'owner' });
  await waitFor(() => !alive(r.pid) && !alive(p.pid) && !alive(p.grandchild), 10000);
  assert.equal(d.item(r.run).state, 'killed');
});

test('detached: the run outlives the launching process (launcher exits at once, the supervisor finishes the run)', async () => {
  const d = sandbox();
  // the run lives until the test releases it (fake `until`): 'returned before the child finished' needs no clock
  const release = path.join(d.t, 'release');
  const brief = d.brief(`mode: done\nuntil: ${release}\n`);
  const env = { ...process.env, META_HB_MS: '150', META_NO_TICK: '1' };
  const x = spawnSync(process.execPath, [META, 'run', '--executor', 'fake', '--state', d.state, '--locks', d.locks, '--lane', 'x', '--worktree', d.wt, '--brief', brief, '--notes', d.notes], { env, encoding: 'utf8' });
  assert.equal(x.status, 0, x.stderr);
  const id = x.stdout.match(/STARTED (RUN-\d+)/)[1];
  assert.equal(d.item(id).state, 'running', 'launcher returned before the child finished');
  fs.writeFileSync(release, '');
  assert.equal((await d.ended(id)).end.outcome, 'done');
});

test('norn hook session: SessionStart -> RUN interactive with session id + transcript; SessionEnd -> exited ended; junk never fails', () => {
  const d = sandbox();
  const hook = input => spawnSync(process.execPath, [META, 'hook', 'session', '--state', d.state], { input, encoding: 'utf8' });
  const start = { session_id: 'sess-1', transcript_path: '/t/sess-1.jsonl', cwd: d.wt, hook_event_name: 'SessionStart', source: 'startup' };
  assert.equal(hook(JSON.stringify(start)).status, 0);
  const [r] = d.runs();
  assert.equal(r.state, 'running'); assert.equal(r.data.kind, 'interactive');
  assert.equal(r.data.session_id, 'sess-1'); assert.equal(r.data.transcript, '/t/sess-1.jsonl'); assert.equal(r.data.worktree, d.wt);
  assert.equal(hook(JSON.stringify({ ...start, source: 'resume' })).status, 0);
  assert.equal(d.runs().length, 1, 'a resumed session with a running RUN is not registered twice');
  assert.equal(hook(JSON.stringify({ session_id: 'sess-1', transcript_path: '/t/sess-1.jsonl', hook_event_name: 'SessionEnd', reason: 'exit' })).status, 0);
  assert.equal(d.item(r.id).state, 'exited'); assert.equal(d.item(r.id).end.outcome, 'ended'); assert.equal(d.item(r.id).end.reason, 'exit');
  const junk = hook('not json');
  assert.equal(junk.status, 0); assert.match(junk.stderr, /norn hook/);
  assert.equal(d.runs().length, 1);
});

test('stopRun refuses a run that is not running and an unknown id', () => {
  const d = sandbox();
  assert.throws(() => stopRun({ state: d.state, locksDir: d.locks, run: 'RUN-9', by: 'controller' }), /does not exist/);
});

// S10: Windows npm .cmd shims (codex.cmd) must spawn without a shell (Node >= 18.20.2 refuses .cmd/.bat: EINVAL, CVE-2024-27980)
const NPM_SHIM = js => [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  String.raw`IF EXIST "%dp0%\node.exe" (`, String.raw`  SET "_prog=%dp0%\node.exe"`, ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${js}" %*`, ''].join('\r\n');
test('win32: a codex-sol run whose exe is an npm .cmd shim spawns (shim -> node + JS entry, argv untouched, no shell)', { skip: process.platform !== 'win32' }, async () => {
  const d = sandbox();
  const bin = path.join(d.t, 'npm bin'), pkg = path.join(bin, 'node_modules', '@openai', 'codex', 'bin');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'codex.js'), "const fs=require('fs');process.stdout.write('SHIM-MARKER '+JSON.stringify(process.argv.slice(2))+' stdin='+fs.readFileSync(0,'utf8').trim()+'\\n');");
  const shim = path.join(bin, 'codex.cmd');
  fs.writeFileSync(shim, NPM_SHIM(String.raw`node_modules\@openai\codex\bin\codex.js`));
  const r = startRun(d.opts({ executor: 'codex-sol', exe: shim, model: 'm & "x"', effort: 'medium', brief: d.brief('hello-brief\n'), kind: 'checkin' }));
  const it = await d.ended(r.run);
  const log = fs.readFileSync(r.log, 'utf8');
  assert.doesNotMatch(log, /EINVAL/);
  assert.ok(log.includes('SHIM-MARKER ["exec"') && log.includes(JSON.stringify('m & "x"')) && log.includes('stdin=hello-brief'), log);
  assert.equal(it.end.exit, 0); assert.equal(it.end.outcome, 'done');
});

test('META-ONBOARD cut-over swap lock: a start waits while <state root>/SWAP.lock is fresh, refuses (code 4) past the wait, ignores a stale one', async () => {
  const d = sandbox(), lockF = path.join(path.dirname(d.state), 'SWAP.lock');
  fs.writeFileSync(lockF, JSON.stringify({ pid: 1, ts: new Date().toISOString(), why: 'cut-over' }));
  let t0 = Date.now();
  assert.throws(() => startRun(d.opts({ brief: d.brief('mode: done\n'), swapWaitMs: 400 })), e => e instanceof RunRefused && e.code === 4 && /swap lock/.test(e.message));
  assert.ok(Date.now() - t0 >= 380, 'it waited');
  assert.equal(d.runs().length, 0);
  // released while waiting: the start goes ahead
  const { spawn } = await import('node:child_process');
  spawn(process.execPath, ['-e', `setTimeout(() => require('fs').rmSync(${JSON.stringify(lockF)}, { force: true }), 300)`], { stdio: 'ignore' });
  t0 = Date.now();
  const a = startRun(d.opts({ brief: d.brief('mode: done\n'), swapWaitMs: 10000 }));
  assert.ok(a.run && Date.now() - t0 >= 250, 'started after the release');
  await d.ended(a.run);
  // a stale lock (a crashed cut-over) does not block
  fs.writeFileSync(lockF, JSON.stringify({ pid: 1, ts: new Date(Date.now() - 16 * 60000).toISOString() }));
  const b = startRun(d.opts({ brief: d.brief('mode: done\n'), swapWaitMs: 10000, worktree: d.wt2 }));
  assert.ok(b.run); await d.ended(b.run);
});
