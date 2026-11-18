// norn delegate (metadelegate DESIGN sec. 2-3, 6 S1): read-only helpers under a parent run. FAKE executor + temp dirs only.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCommand, startRun, stopRun, RunRefused, RunError, hbPath } from '../engine/lib/runs.mjs';
import { capsOfRun } from '../engine/lib/executors.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { delegateStart, delegateWait, pickExecutors, helperBrief } from '../engine/lib/delegate.mjs';
import { agentsTree } from '../engine/lib/agents.mjs';
import { POLICY_DEFAULTS } from '../engine/lib/policy.mjs';
import { GROK } from './helpers/command-matrix.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { runEnded, HANG_CAP_MS } from './helpers/wait.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const META = path.join(HERE, '..', 'engine', 'bin', 'norn.mjs');

// parents hold until stopped: stop whatever a failed test left running
const held = [];
after(() => { for (const h of held) { try { if (h.d.item(h.run)?.state === 'running') stopRun({ state: h.d.state, locksDir: h.d.locks, run: h.run, by: 'owner' }); } catch { /* ended meanwhile */ } } });
function sandbox() {
  const t = mkTmp('meta-dlg-');
  const d = { t, state: path.join(t, 'state', 'demo'), locks: path.join(t, 'state', 'locks'), wt: path.join(t, 'wt'), notes: path.join(t, 'NOTES.md') };
  for (const k of ['state', 'locks', 'wt']) fs.mkdirSync(d[k], { recursive: true });
  d.item = id => loadState(d.state).items[id];
  // ended AND its supervisor gone: its end-of-run tail (lock release, queue fill, tick) is done (FINDING L1)
  // progress-based (DEC-84 B): fails when the run's supervisor is gone unsettled, never on a clock
  d.ended = id => runEnded(d.state, id);
  // a running parent worker holding the worktree lock: the fake lives until the test releases (d.release) or stops it - no clock
  // a loaded machine can outrun; after() stops any a failed test left behind. No test here measures heartbeat staleness, so the lost
  // sweep keeps the engine's STALE_MS: a 3 s staleMs swept a held parent "lost" when the runner stalled it (CI 43125458306, Windows)
  d.parent = () => {
    const tag = Math.random().toString(16).slice(2), b = path.join(t, `parent-${tag}.md`);
    fs.writeFileSync(b, `mode: sleep\nuntil: ${path.join(t, `release-${tag}`)}\n`);
    const run = startRun({ state: d.state, locksDir: d.locks, executor: 'fake', lane: 'demo', worktree: d.wt, notes: d.notes, brief: b, hbMs: 150,
      policy: { auto_resume_max: 0 }, budget: {}, tick: null }).run;
    held.push({ d, run, until: path.join(t, `release-${tag}`) });
    return run;
  };
  d.release = run => fs.writeFileSync(held.find(h => h.d === d && h.run === run).until, '');
  d.opts = (o = {}) => ({ state: d.state, locksDir: d.locks, env: {}, cls: 'chores', executor: 'fake', q: 'where is X built? cite file:line', hbMs: 150, ...o });
  return d;
}

// ---------- read-only command lines ----------
test('read-only flags: grok ro drops the terminal + edit tools (dontAsk); a claude-compatible helper gets no --agent, no shell / edit tools, no MCP', () => {
  const base = { brief: '/s/delegate/x/brief.md', worktree: '/w', notes: '/s/delegate/x/out.md', lane: 'helper', final: '/s/f.json', resumes: 0, readonly: true };
  const g = buildCommand({ ...base, executor: 'grok', provider: GROK, exe: '/x/grok', model: 'grok-4.7', effort: 'high' });
  const gat = f => g.args[g.args.indexOf(f) + 1];
  for (const t of ['run_terminal_command', 'search_replace', 'write', 'spawn_subagent']) assert.ok(gat('--disallowed-tools').split(',').includes(t), t);
  assert.equal(gat('--permission-mode'), 'dontAsk'); assert.ok(g.args.includes('--no-subagents')); assert.ok(g.args.includes('--disable-web-search'));
  // a lane grok run (not read-only) keeps its terminal
  const lane = buildCommand({ ...base, readonly: false, executor: 'grok', provider: GROK, exe: '/x/grok', model: 'grok-4.7', effort: 'high' });
  assert.ok(!lane.args[lane.args.indexOf('--disallowed-tools') + 1].split(',').includes('run_terminal_command'));
  const prov = { type: 'claude-compatible', base_url: 'https://x.test', api_key_env: 'GLM_KEY', model: 'glm-5' };
  const c = buildCommand({ ...base, executor: 'glm', provider: prov, exe: '/x/claude', agent: 'kestrel-implementer', model: 'glm-5', effort: 'medium', session_id: 'u', promptText: 'Q?' });
  const at = f => c.args[c.args.indexOf(f) + 1];
  assert.ok(!c.args.includes('--agent'));
  assert.deepEqual(at('--disallowedTools').split(','), ['Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit', 'Agent']);
  assert.ok(c.args.includes('--strict-mcp-config')); assert.ok(!c.args.includes('--remote-control'));
  assert.equal(at('-p'), 'Q?');
  // the same provider as a lane worker keeps --agent and has no tool limits
  const w = buildCommand({ ...base, readonly: false, executor: 'glm', provider: prov, exe: '/x/claude', agent: 'kestrel-implementer', model: 'glm-5', effort: 'medium', session_id: 'u' });
  assert.ok(w.args.includes('--agent')); assert.ok(!w.args.includes('--disallowedTools'));
});

test('grok counts against max_grok (default 4 running = its entry\'s cap): the fifth grok run is refused with exit 4', () => {
  const d = sandbox();
  assert.deepEqual(capsOfRun({ kind: 'cli', executor: 'grok' }), ['max_grok']);
  for (let i = 0; i < 4; i++) {
    const e = record(d.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'cli', executor: 'grok', lane: 'x' } });
    fs.mkdirSync(path.join(d.state, 'hb'), { recursive: true }); fs.writeFileSync(hbPath(d.state, e.id), '{}');
  }
  const b = path.join(d.t, 'b.md'); fs.writeFileSync(b, 'x');
  assert.throws(() => startRun({ state: d.state, locksDir: d.locks, executor: 'grok', provider: GROK, exe: '/nope/grok', lane: 'x', worktree: d.wt, brief: b, budget: {}, tick: null }),
    e => e instanceof RunRefused && e.code === 4 && /max_grok=4/.test(e.message));
});

// ---------- lock: false ----------
test('lock check: lock:false is refused (exit 3) unless a read-only helper whose parent holds the worktree lock', async () => {
  const d = sandbox();
  const b = path.join(d.t, 'b.md'); fs.writeFileSync(b, 'mode: done\n');
  const o = { state: d.state, locksDir: d.locks, executor: 'fake', lane: 'x', worktree: d.wt, brief: b, notes: path.join(d.t, 'out.md'), budget: {}, tick: null, lock: false, hbMs: 150 };
  assert.throws(() => startRun(o), e => e instanceof RunRefused && e.code === 3);
  assert.throws(() => startRun({ ...o, role: 'helper', readonly: true, parent: 'RUN-9' }), e => e instanceof RunRefused && e.code === 3 && /RUN-9/.test(e.message));
  const p = d.parent();
  assert.throws(() => startRun({ ...o, role: 'helper', readonly: false, parent: p }), e => e instanceof RunRefused && e.code === 3);
  const r = startRun({ ...o, role: 'helper', readonly: true, parent: p });
  assert.equal((await d.ended(r.run)).end.outcome, 'done');
  stopRun({ state: d.state, locksDir: d.locks, run: p, by: 'owner' });
});

// ---------- delegate start ----------
test('delegate: parent auto-filled from META_RUN_ID; RUN row role helper + class + q; brief + out under state/delegate; parent lock untouched', async () => {
  const d = sandbox();
  const p = d.parent();
  const long = 'where is the water picture built? '.repeat(10);
  const r = delegateStart(d.opts({ env: { META_RUN_ID: p }, q: long, read: ['a.rs', 'b.rs'] }));
  const it = d.item(r.run);
  assert.equal(it.data.parent, p); assert.equal(it.data.role, 'helper'); assert.equal(it.data.class, 'chores');
  assert.equal(it.data.q, long.slice(0, 120)); assert.equal(it.data.worktree, d.wt); assert.equal(it.data.budget_min, 10);
  assert.ok(r.dir.startsWith(path.join(d.state, 'delegate')));
  assert.equal(it.data.brief, path.join(r.dir, 'brief.md')); assert.equal(it.data.notes, path.join(r.dir, 'out.md'));
  const brief = fs.readFileSync(it.data.brief, 'utf8');
  assert.match(brief, /water picture/); assert.match(brief, /a\.rs/); assert.match(brief, /at most 40 lines/i); assert.match(brief, /UNKNOWN/); assert.match(brief, /final message IS the answer/); assert.doesNotMatch(brief, /## DONE/);
  const e = await d.ended(r.run);
  assert.equal(e.end.outcome, 'done');
  assert.match(fs.readFileSync(r.out, 'utf8'), /work: done/);
  assert.equal(d.item(p).state, 'running');
  stopRun({ state: d.state, locksDir: d.locks, run: p, by: 'owner' });
});

test('delegate refusals: no parent (2); depth 1 via META_PARENT_RUN or a parent that is itself a helper (4); parent not running (4); claude executors (2)', async () => {
  const d = sandbox();
  assert.throws(() => delegateStart(d.opts()), e => e instanceof RunError && e.code === 2 && /parent/.test(e.message));
  const p = d.parent();
  assert.throws(() => delegateStart(d.opts({ env: { META_RUN_ID: p, META_PARENT_RUN: 'RUN-77' } })), e => e instanceof RunRefused && e.code === 4 && /depth/.test(e.message));
  const h = delegateStart(d.opts({ env: { META_RUN_ID: p } }));
  assert.throws(() => delegateStart(d.opts({ env: { META_RUN_ID: h.run } })), e => e instanceof RunRefused && e.code === 4 && /depth/.test(e.message));
  for (const x of ['claude', 'kestrel-implementer', 'codex-astra'])
    assert.throws(() => delegateStart(d.opts({ env: { META_RUN_ID: p }, executor: x })), e => e instanceof RunError && e.code === 2, x);
  await d.ended(h.run);
  stopRun({ state: d.state, locksDir: d.locks, run: p, by: 'owner' });
  assert.throws(() => delegateStart(d.opts({ env: { META_RUN_ID: p } })), e => e instanceof RunRefused && e.code === 4 && /not running/.test(e.message));
});

test('delegate: the parent must hold its worktree lock (exit 3 otherwise)', () => {
  const d = sandbox();
  const e = record(d.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'x', worktree: d.wt } });
  fs.mkdirSync(path.join(d.state, 'hb'), { recursive: true }); fs.writeFileSync(hbPath(d.state, e.id), '{}');
  assert.throws(() => delegateStart(d.opts({ env: { META_RUN_ID: e.id } })), x => x instanceof RunRefused && x.code === 3 && /lock/.test(x.message));
});

test('delegate per-parent cap: policy.delegate.max_per_parent running helpers, then exit 4 "do it yourself"', () => {
  const d = sandbox();
  const p = d.parent();
  const project = { name: 'demo', policy: { delegate: { max_per_parent: 2 } } };
  const q = 'mode: sleep\nms: 6000';
  delegateStart(d.opts({ env: { META_RUN_ID: p }, project, q }));
  delegateStart(d.opts({ env: { META_RUN_ID: p }, project, q }));
  assert.throws(() => delegateStart(d.opts({ env: { META_RUN_ID: p }, project, q })), e => e instanceof RunRefused && e.code === 4 && /do it yourself/.test(e.message));
  stopRun({ state: d.state, locksDir: d.locks, run: p, by: 'owner' });
});

test('executor pick: allowed for the class, enabled, key set (API types), grok on (its entry enabled); claude-pool executors never', () => {
  const pol = structuredClone(POLICY_DEFAULTS);
  const providers = { grok: GROK, glm: { type: 'claude-compatible', base_url: 'https://g', api_key_env: 'GLM_KEY', model: 'glm' },
    kimi: { type: 'claude-compatible', base_url: 'https://k', api_key_env: 'KIMI_KEY', model: 'k', enabled: false } };
  assert.deepEqual(pickExecutors({ policy: pol, cls: 'chores', providers, env: {} }), ['grok']);
  assert.deepEqual(pickExecutors({ policy: pol, cls: 'chores', providers, env: { GLM_KEY: 'x', KIMI_KEY: 'y' } }), ['grok', 'glm']);
  providers.grok = { ...GROK, enabled: false };
  assert.deepEqual(pickExecutors({ policy: pol, cls: 'chores', providers, env: { GLM_KEY: 'x' } }), ['glm']);
  assert.deepEqual(pickExecutors({ policy: pol, cls: 'diagnosis', providers, env: { GLM_KEY: 'x' } }), []);
  assert.match(helperBrief({ q: 'Q', read: [], out: '/o.md', worktree: '/w', parent: 'RUN-1', cls: 'chores' }), /READ-ONLY/);
});

// ---------- wait + children ----------
test('delegate wait: exit 5 while a helper runs, 0 once all ended; prints outcome + answer + out path in <= 60 lines', async () => {
  const d = sandbox();
  const p = d.parent();
  // the slow helper lives until the test releases it - a fixed sleep (was ms: 2500) is outrun by a loaded machine (CI 42658635075)
  const release = path.join(d.t, 'release-slow');
  const slow = delegateStart(d.opts({ env: { META_RUN_ID: p }, q: `mode: sleep\nuntil: ${release}` }));
  const fast = delegateStart(d.opts({ env: { META_RUN_ID: p } }));
  const w1 = delegateWait({ state: d.state, runs: [slow.run, fast.run], maxS: 0.3 });
  assert.equal(w1.code, 5); assert.match(w1.lines.join('\n'), new RegExp(`${slow.run} running`));
  fs.writeFileSync(release, '');
  const w2 = delegateWait({ state: d.state, runs: [slow.run, fast.run], maxS: 20 });
  assert.equal(w2.code, 0);
  const txt = w2.lines.join('\n');
  assert.match(txt, new RegExp(`${fast.run} exited done`)); assert.match(txt, /work: done/); assert.ok(txt.includes(fast.out.replace(/\\/g, '/')));
  assert.ok(w2.lines.length <= 60);
  assert.throws(() => delegateWait({ state: d.state, runs: ['RUN-999'], maxS: 1 }), e => e instanceof RunError && e.code === 2);
  stopRun({ state: d.state, locksDir: d.locks, run: p, by: 'owner' });
});

test('delegate wait: the maxS deadline ignores a wall-clock step forward or backward mid-wait (CLOCK-1, CI 43110056439)', async () => {
  const d = sandbox();
  const p = d.parent();
  const release = path.join(d.t, 'release-slow');
  const slow = delegateStart(d.opts({ env: { META_RUN_ID: p }, q: `mode: sleep\nuntil: ${release}` }));
  const short = delegateStart(d.opts({ env: { META_RUN_ID: p }, q: 'mode: sleep\nms: 2500' }));
  const realNow = Date.now;
  // the wall clock steps by `jump` ms after its first read inside delegateWait
  const jumped = (jump, run, maxS) => {
    let calls = 0;
    Date.now = () => realNow() + (calls++ > 0 ? jump : 0);
    const t0 = performance.now();
    try { return { code: delegateWait({ state: d.state, runs: [run], maxS }).code, ms: performance.now() - t0 }; }
    finally { Date.now = realNow; }
  };
  const fwd = jumped(3600e3, slow.run, 1);       // +1 h: the deadline must not fire early
  assert.equal(fwd.code, 5); assert.ok(fwd.ms >= 900, `forward step ended the wait after ${fwd.ms.toFixed(0)} ms, not ~1000`);
  const back = jumped(-3600e3, short.run, 0.3);   // -1 h: the deadline must not move out
  assert.equal(back.code, 5); assert.ok(back.ms < 1500, `backward step held the wait ${back.ms.toFixed(0)} ms, not ~300`);
  fs.writeFileSync(release, '');
  await d.ended(slow.run); await d.ended(short.run);
  stopRun({ state: d.state, locksDir: d.locks, run: p, by: 'owner' });
});

test('children stopped with the parent: a parent that ends or is killed takes its running helpers down (lost, why names the parent)', async () => {
  const d = sandbox();
  const p = d.parent();
  const h = delegateStart(d.opts({ env: { META_RUN_ID: p }, q: 'mode: sleep\nms: 30000' }));
  d.release(p);   // the parent ends on its own, after its helper started
  await d.ended(p);
  const e = await d.ended(h.run);
  assert.equal(e.state, 'lost'); assert.match(e.history.at(-1).data.why, new RegExp(`parent ${p}`));
  const p2 = d.parent();
  const h2 = delegateStart(d.opts({ env: { META_RUN_ID: p2 }, q: 'mode: sleep\nms: 30000' }));
  stopRun({ state: d.state, locksDir: d.locks, run: p2, by: 'owner' });
  assert.equal((await d.ended(h2.run)).state, 'lost');
});

// ---------- Agents view ----------
test('agentsTree: helpers nest under their parent (kind helper, q) and the parent shows helper count + tokens', () => {
  const d = sandbox();
  record(d.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'gen' } });
  record(d.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'provider', executor: 'glm', lane: 'helper', role: 'helper', parent: 'RUN-1', q: 'where?' } });
  record(d.state, { kind: 'run', ev: 'end', id: 'RUN-2', by: 'launcher', data: { exit: 0, outcome: 'done', usage: { input_tokens: 100, output_tokens: 20 } } });
  record(d.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'cli', executor: 'grok', lane: 'helper', role: 'helper', parent: 'RUN-1', q: 'log?' } });
  const runs = Object.values(loadState(d.state).items).filter(i => i.kind === 'run');
  const tree = agentsTree(runs, { now: Date.now() });
  assert.deepEqual(tree.map(n => n.id), ['RUN-1']);
  const kids = tree[0].children.filter(c => c.kind === 'helper');
  assert.deepEqual(kids.map(c => [c.id, c.q]), [['RUN-2', 'where?'], ['RUN-3', 'log?']]);
  assert.deepEqual(tree[0].helpers, { n: 2, running: 1, tokens: 120 });
});

// ---------- CLI ----------
test('norn delegate CLI: ask blocks and prints the answer (exit 0); start prints the RUN id; wait exits 5 then 0; a helper env is refused', async () => {
  const d = sandbox();
  const p = d.parent();
  const env = { ...process.env, META_RUN_ID: p, META_NO_TICK: '1', META_HB_MS: '150' };
  for (const k of ['META_STATE', 'META_PROJECT', 'META_ROLE', 'META_PARENT_RUN']) delete env[k];
  const run = (...a) => spawnSync(process.execPath, [META, 'delegate', ...a, '--state', d.state, '--locks', d.locks], { env, encoding: 'utf8' });
  // ask / wait end when the run ends (its producer, the supervisor, dead = swept lost after STALE_MS, delegateWait): the --max-s here
  // is only the hang guard, never what the test asserts (DEC-84 B; a 30 s deadline sampled the loaded Windows leg, CI 43207062452)
  const GUARD = String(HANG_CAP_MS / 1000);
  const a = run('ask', '--executor', 'fake', '--q', 'who calls Y?', '--max-s', GUARD);
  assert.equal(a.status, 0, a.stderr + a.stdout);
  assert.match(a.stdout, /exited done/); assert.match(a.stdout, /work: done/); assert.ok(a.stdout.trim().split('\n').length <= 60);
  const s = run('start', '--executor', 'fake', '--q', 'mode: sleep\nms: 2000');
  assert.equal(s.status, 0, s.stderr); const id = s.stdout.trim().match(/^(RUN-\d+)/)[1];
  assert.equal(run('wait', id, '--max-s', '0.2').status, 5);
  assert.equal(run('wait', id, '--max-s', GUARD).status, 0);
  const h = spawnSync(process.execPath, [META, 'delegate', 'ask', '--executor', 'fake', '--q', 'x', '--state', d.state, '--locks', d.locks], { env: { ...env, META_PARENT_RUN: p }, encoding: 'utf8' });
  assert.equal(h.status, 4); assert.match(h.stdout, /depth/);
  assert.equal(run('nope').status, 2);
  stopRun({ state: d.state, locksDir: d.locks, run: p, by: 'owner' });
});
