// META-CTX-ENFORCE R1 (owner DIR-56): ONE context measure (the last request, never a sum; the peak beside it), the limit shown = the
// run's policy hand-off line, and the limits enforced for every launched claude run: the hook's orders (once each), the supervisor's
// hard-max end as HANDOFF. FAKE executor, temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ctxRole, ctxLimits, ctxLevel, transcriptCtx, ctxOrder, runOrder, HANDOFF_PROMPT, ctxView } from '../engine/lib/ctxlimit.mjs';
import { agentsTree } from '../engine/lib/agents.mjs';
import { handoffK } from '../engine/lib/guard.mjs';
import { startRun } from '../engine/lib/runs.mjs';
import { loadState } from '../engine/lib/records.mjs';
import { POLICY_DEFAULTS, SETTINGS } from '../engine/lib/policy.mjs';
import { injectJson } from '../engine/lib/mail.mjs';
import { ctxMeter } from '../engine/dash/cells.mjs';
import { settled } from './helpers/settled.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 30000) {
  const t0 = performance.now();
  for (;;) { const v = fn(); if (v) return v; if (performance.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(50); }
}
const U = (inp, cr, cc) => ({ input_tokens: inp, cache_read_input_tokens: cr, cache_creation_input_tokens: cc, output_tokens: 50 });
const line = (i, u) => JSON.stringify({ type: 'assistant', timestamp: new Date(Date.parse('2026-11-14T10:00:00Z') + i * 60000).toISOString(), requestId: `req-${i}`,
  message: { id: `msg-${i}`, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: u } });
const transcript = (file, ctxs) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ctxs.map((c, i) => line(i, U(4, c - 1004, 1000))).join('\n') + '\n'); };
const project = (dir, context) => {
  const f = path.join(dir, 'project.json');
  fs.writeFileSync(f, JSON.stringify({ schema: 1, name: 'demo', title: 'Demo', root: dir.replace(/\\/g, '/'), policy: { context } }));
  return f;
};

test('one measure: the CURRENT context = the last request (input + cache read + cache creation), never a sum; the levels of a role', () => {
  const t = mkTmp('meta-ctx-'), f = path.join(t, 'p', 'x', 's.jsonl');
  transcript(f, [40000, 64000, 52000]);
  assert.equal(transcriptCtx(f), 52000, 'the last request, not 156k summed nor the 64k peak');
  assert.equal(transcriptCtx(path.join(t, 'none.jsonl')), null);
  assert.equal(ctxRole({ kind: 'checkin' }), 'checkin');
  assert.equal(ctxRole({ kind: 'chat' }), 'controller');
  assert.equal(ctxRole({ kind: 'worker', agent: 'kestrel-planner' }), 'planner');
  assert.equal(ctxRole({ kind: 'worker', agent: 'kestrel-implementer' }), 'implementer');
  assert.deepEqual(POLICY_DEFAULTS.context.checkin, { no_new_step_k: 90, handoff_k: 110, hard_max_k: 150 }, 'a check-in has its own row');
  assert.ok(SETTINGS.some(s => s.key === 'policy.context.checkin.handoff_k'), 'and its Settings rows');
  const c = ctxLimits({ context: { implementer: { handoff_k: 100 } } }, 'implementer');
  assert.deepEqual(c, { role: 'implementer', no_new_step_k: 90, handoff_k: 100, hard_max_k: 150 });
  assert.deepEqual([89999, 90000, 100000, 150000].map(x => ctxLevel(x, c)), [null, 'no_new_step', 'handoff', 'hard_max']);
  assert.equal(handoffK({ data: { kind: 'checkin' } }, { context: { checkin: { handoff_k: 70 } } }), 70, 'the guard reads the same role row');
});

test('one hand-off wording: the chat turn and a run order share the head', () => {
  const c = ctxLimits({}, 'implementer'), head = HANDOFF_PROMPT.split(' After this turn')[0].replace('{ctx}', '120k').replace('{limit}', '110k');
  assert.ok(runOrder('handoff', 120000, c).startsWith(head), runOrder('handoff', 120000, c));
  assert.match(runOrder('handoff', 120000, c), /norn done --outcome handoff --handoff-file/);
  assert.match(runOrder('no_new_step', 95000, c), /no new step/i);
});

test('the shown limit = the run role\'s policy hand-off line (+ hard max), not the model window', () => {
  const pol = { context: { checkin: { handoff_k: 80, hard_max_k: 120 } } };
  assert.deepEqual(ctxView({ kind: 'checkin' }, pol), { ctx_role: 'checkin', ctx_limit: 80000, ctx_hard: 120000, ctx_no_step: 90000 });
  assert.equal(ctxView({ kind: 'worker', agent: 'x-runner' }, {}).ctx_limit, 110000);
});

test('Agents: a check-in shows its LAST request (not the summed end usage), its peak and its role\'s hand-off line', () => {
  const t = mkTmp('meta-ctx-'), projects = path.join(t, 'projects'), sid = '11111111-2222-4333-8444-000000000869';
  transcript(path.join(projects, 'C--x', sid + '.jsonl'), [30000, 64000, 61000]);
  const now = Date.parse('2026-11-14T10:10:00Z');
  const run = { kind: 'run', id: 'RUN-869', state: 'exited', created: '2026-11-14T10:00:00Z', updated: '2026-11-14T10:05:00Z',
    data: { kind: 'checkin', executor: 'claude', lane: 'checkin', session_id: sid },
    end: { outcome: 'done', usage: U(24, 1112337, 40000) } };
  const [n] = agentsTree([run], { projectsDir: projects, cache: new Map(), now, policy: { context: { checkin: { handoff_k: 100 } } } });
  assert.equal(n.ctx, 61000, 'the last request');
  assert.equal(n.ctx_peak, 64000);
  assert.equal(n.ctx_limit, 100000);
  assert.equal(n.ctx_hard, 150000);
  const [m] = agentsTree([{ ...run, data: { ...run.data, session_id: null } }], { projectsDir: projects, cache: new Map(), now });
  assert.equal(m.ctx, null, 'no transcript = no context number (never the summed usage)');
});

test('the hook: past no_new_step one "no new step" order, at handoff_k the hand-off order - each once; mail rides beside it', () => {
  const t = mkTmp('meta-ctx-'), state = path.join(t, 'state'), f = path.join(t, 'p', 'x', 'sid-1.jsonl');
  const pf = project(t, { implementer: { no_new_step_k: 30, handoff_k: 40, hard_max_k: 60 } });
  fs.mkdirSync(path.join(state, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(state, 'runs', 'RUN-1.spec.json'), JSON.stringify({ run: 'RUN-1', kind: 'worker', agent: 'implementer', ctx_from: pf, projectsDir: path.join(t, 'p'), session_id: 'sid-1' }));
  const hook = () => spawnSync(process.execPath, [META, 'mail', 'check', '--inject', '--run', 'RUN-1', '--state', state],
    { encoding: 'utf8', env: { ...process.env, META_RUN_ID: 'RUN-1', META_ROLE: '' }, timeout: 30000 });
  const ctxOf = r => r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
  transcript(f, [20000]);
  assert.equal(ctxOf(hook()), '', 'under the mark: nothing');
  transcript(f, [20000, 33000]);
  assert.match(ctxOf(hook()), /no-new-step mark \(30k\)/);
  assert.equal(ctxOf(hook()), '', 'once');
  transcript(f, [20000, 33000, 45000]);
  const h = ctxOf(hook());
  assert.match(h, /^NORN HAND-OFF \(from Norn, not the owner\): this session's context is 45k, past the hand-off point \(40k\)\./);
  assert.match(h, /At 60k \(hard max\)/);
  assert.equal(ctxOf(hook()), '', 'the hand-off order once too');
  assert.equal(ctxOrder(state, 'RUN-1'), null);
  const both = JSON.parse(injectJson([{ id: 'MAIL-1', data: { from: 'role:checkin', subject: 'hi' }, text: 'body' }], 'ORDER')).hookSpecificOutput.additionalContext;
  assert.match(both, /^ORDER\n\nMAIL for you \(1;/,'the order first, the mail beside it');
  assert.equal(JSON.parse(injectJson([], 'ORDER')).hookSpecificOutput.additionalContext, 'ORDER');
  assert.equal(injectJson([]), '');
  const no = spawnSync(process.execPath, [META, 'mail', 'check', '--inject', '--run', 'RUN-2', '--state', state], { encoding: 'utf8', env: { ...process.env, META_RUN_ID: 'RUN-2' } });
  assert.equal(no.status, 0); assert.equal(no.stdout.trim(), '', 'a run without a spec / transcript: the hook says nothing, never fails');
});

test('fake run: past the hard max the supervisor ends the run as HANDOFF (its result + a forced HANDOFF.md, ctx_forced on the end) and auto-resume takes it', async () => {
  const t = mkTmp('meta-ctx-'), state = path.join(t, 'state', 'demo'), locks = path.join(t, 'state', 'locks'), wt = path.join(t, 'wt'), notes = path.join(t, 'NOTES.md');
  const projects = path.join(t, 'projects');
  for (const d of [state, locks, wt]) fs.mkdirSync(d, { recursive: true });
  const pf = project(t, { implementer: { no_new_step_k: 30, handoff_k: 40, hard_max_k: 60 } });
  const brief = path.join(t, 'brief.md');
  fs.writeFileSync(brief, `mode: sleep\nms: 30000\nctx_dir: ${path.join(projects, 'C--wt')}\nctx_steps: 20000,45000,70000\nctx_ms: 100\nresumed_mode: done\n`);
  const r = startRun({ state, locksDir: locks, executor: 'fake', lane: 'demo', worktree: wt, notes, hbMs: 100, staleMs: 3000, projectsDir: projects, ctx_from: pf,
    policy: { auto_resume_max: 1, trigger_on_exit: false }, budget: {}, brief });
  const end = await waitFor(() => { const it = loadState(state).items[r.run]; return settled(it) && it.history.find(h => h.ev === 'end'); });
  assert.equal(end.data.outcome, 'handoff');
  assert.deepEqual(end.data.ctx_forced, { ctx: 70000, hard_max_k: 60, role: 'implementer' });
  assert.equal(end.data.outcome_source, 'result');
  assert.match(fs.readFileSync(end.data.handoff, 'utf8'), /^# Forced hand-off[\s\S]*hard max \(60k\)/);
  const resumed = await waitFor(() => loadState(state).items[r.run].history.find(h => h.ev === 'resume'));
  assert.ok(resumed.data.next, JSON.stringify(resumed.data));
  const next = await waitFor(() => { const it = loadState(state).items[resumed.data.next]; return settled(it) && it; });
  assert.ok(next);
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'runs', resumed.data.next + '.spec.json'), 'utf8')).ctx_from, pf, 'the resume keeps the policy source');
});

test('NORN-CTX-1M: a [1m] run reads its role\'s _1m row (hand-off 500k), a plain run the plain row (200k); every caller through ctxRole', () => {
  const pol = { context: { implementer: { no_new_step_k: 170, handoff_k: 200, hard_max_k: 220 } } }, m1 = 'claude-opus-5-5[1m]';
  assert.equal(ctxRole({ kind: 'worker', agent: 'kestrel-implementer', model: m1 }), 'implementer_1m');
  assert.equal(ctxRole({ kind: 'worker', agent: 'kestrel-planner', model: m1 }), 'planner_1m');
  assert.equal(ctxRole({ kind: 'worker', agent: 'kestrel-runner', model: m1 }), 'runner_1m');
  assert.equal(ctxRole({ kind: 'checkin', model: m1 }), 'checkin', 'a role with no _1m row keeps its plain row');
  assert.equal(ctxLimits(pol, ctxRole({ agent: 'kestrel-implementer', model: m1 })).handoff_k, 500);
  assert.equal(ctxLimits(pol, ctxRole({ agent: 'kestrel-implementer', model: 'claude-opus-5-5' })).handoff_k, 200);
  assert.deepEqual(POLICY_DEFAULTS.context.planner_1m, { no_new_step_k: 800, handoff_k: 900, hard_max_k: 950 });
  assert.equal(ctxView({ kind: 'worker', agent: 'x-implementer', model: m1 }, pol).ctx_limit, 500000);
  assert.equal(handoffK({ data: { agent: 'x-implementer', model: m1 } }, pol), 500, 'the guard reads the same tier');
  const row = d => ctxMeter({ ctx: 300000, ...ctxView(d, pol) });
  assert.ok(row({ agent: 'x-implementer', model: m1 }).includes('hand-off 500k (1M tier) · max 560k'), 'the run row names the tier');
  assert.doesNotMatch(row({ agent: 'x-implementer', model: 'claude-opus-5-5' }), /1M tier/);
});

test('NORN-CTX-1M fake [1m] run: the supervisor\'s hard max is the _1m row (560k), not the plain 220k', async () => {
  const t = mkTmp('meta-ctx-'), state = path.join(t, 'state', 'demo'), locks = path.join(t, 'state', 'locks'), wt = path.join(t, 'wt'), notes = path.join(t, 'NOTES.md');
  const projects = path.join(t, 'projects');
  for (const d of [state, locks, wt]) fs.mkdirSync(d, { recursive: true });
  const pf = project(t, { implementer: { no_new_step_k: 170, handoff_k: 200, hard_max_k: 220 } });
  const brief = path.join(t, 'brief.md');
  fs.writeFileSync(brief, `mode: sleep\nms: 30000\nctx_dir: ${path.join(projects, 'C--wt')}\nctx_steps: 230000,570000\nctx_ms: 300\n`);
  const r = startRun({ state, locksDir: locks, executor: 'fake', lane: 'demo', worktree: wt, notes, hbMs: 100, staleMs: 3000, projectsDir: projects, ctx_from: pf,
    model: 'claude-opus-5-5[1m]', policy: { auto_resume_max: 0, trigger_on_exit: false }, budget: {}, brief });
  const end = await waitFor(() => { const it = loadState(state).items[r.run]; return settled(it) && it.history.find(h => h.ev === 'end'); });
  assert.deepEqual(end.data.ctx_forced, { ctx: 570000, hard_max_k: 560, role: 'implementer_1m' });
  assert.equal(loadState(state).items[r.run].history.find(h => h.ev === 'start').data.ctx_marks.hard_max_k, 560, 'the start record\'s marks are the tier\'s');
});
