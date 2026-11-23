// norn ask (GT-PARITY-PLAN sec. 2.6, GT-6 seance): ask a finished run. FAKE executor + temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCommand, startRun, stopOrphans, RunError, RunRefused } from '../engine/lib/runs.mjs';
import { POLICY_DEFAULTS, SETTINGS } from '../engine/lib/policy.mjs';
import { loadState } from '../engine/lib/records.mjs';
import { askPlan, askStart, askWait, coldBrief, forkPrompt, transcriptTail, checkIsolation, hashFile, noforkFile, TAIL_LINES } from '../engine/lib/ask.mjs';
import { helperBrief } from '../engine/lib/delegate.mjs';
import { settled } from './helpers/settled.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const META = path.join(HERE, '..', 'engine', 'bin', 'norn.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) {
  const t0 = performance.now();
  for (;;) { const v = fn(); if (v) return v; if (performance.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(50); }
}
function sandbox() {
  const t = mkTmp('meta-ask-');
  const d = { t, state: path.join(t, 'state', 'demo'), locks: path.join(t, 'state', 'locks'), wt: path.join(t, 'wt'), notes: path.join(t, 'NOTES.md') };
  for (const k of ['state', 'locks', 'wt']) fs.mkdirSync(d[k], { recursive: true });
  d.item = id => loadState(d.state).items[id];
  d.ended = id => waitFor(() => { const it = d.item(id); return settled(it) && it; });
  // an ENDED fake lane run with NOTES: the run to ask
  d.asked = async (mode = 'done') => {
    const b = path.join(t, `b-${Math.random().toString(16).slice(2)}.md`);
    fs.writeFileSync(b, `mode: ${mode}\n`);
    fs.writeFileSync(d.notes, '# NOTES\nbuilt the X table in engine/lib/x.mjs:12\n');
    const run = startRun({ state: d.state, locksDir: d.locks, executor: 'fake', lane: 'demo', worktree: d.wt, notes: d.notes, brief: b, hbMs: 150, staleMs: 3000,
      policy: { auto_resume_max: 0 }, budget: {}, tick: null }).run;
    await d.ended(run);
    return run;
  };
  d.opts = (o = {}) => ({ state: d.state, locksDir: d.locks, env: {}, executor: 'fake', q: 'why the X table? cite file:line', hbMs: 150, staleMs: 3000, ...o });
  return d;
}
const WT = mkTmp('meta-ask-wt-');
const item = (o = {}) => ({ id: 'RUN-7', kind: 'run', state: 'exited', history: [], ...o, data: { executor: 'claude', session_id: 'old-sid', worktree: WT, ...(o.data || {}) } });

// ---------- piece 1: the plan, the fork command line, the briefs ----------
test('claude fork command: fork_of adds --resume <sid> --fork-session, read-only (CLAUDE_RO_NOPE, no --agent, no MCP); without it no resume flags', () => {
  const base = { executor: 'claude', exe: '/x/claude', model: 'claude-opus-5-5', effort: 'medium', session_id: 'new-sid', brief: '/s/b.md', worktree: '/w', notes: '/s/out.md',
    lane: 'helper', final: '/s/f.json', resumes: 0, agent: 'kestrel-implementer', promptText: 'Q?' };
  const c = buildCommand({ ...base, readonly: true, fork_of: 'old-sid' });
  const at = f => c.args[c.args.indexOf(f) + 1];
  assert.equal(at('--resume'), 'old-sid'); assert.ok(c.args.includes('--fork-session')); assert.equal(at('--session-id'), 'new-sid');
  assert.deepEqual(at('--disallowedTools').split(','), ['Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit', 'Agent']);
  assert.ok(!c.args.includes('--agent')); assert.ok(c.args.includes('--strict-mcp-config')); assert.equal(at('-p'), 'Q?');
  const w = buildCommand(base);
  assert.ok(!w.args.includes('--resume')); assert.ok(!w.args.includes('--fork-session'));
});

test('askPlan: an ended claude run forks; fake / no fork caps / a nofork record / a gone worktree go cold; running or no session_id = exit 2', () => {
  assert.equal(askPlan({ it: item() }).mode, 'fork');
  assert.equal(askPlan({ it: item() }).sid, 'old-sid');
  for (const st of ['lost', 'killed']) assert.equal(askPlan({ it: item({ state: st }) }).mode, 'fork');
  assert.match(askPlan({ it: item({ data: { executor: 'fake' } }) }).why, /caps\.fork false/);
  assert.match(askPlan({ it: item({ data: { executor: 'codex-sol' } }) }).why, /family codex has no fork command/);
  assert.equal(askPlan({ it: item(), nofork: { claude: { run: 'RUN-3', ts: 'x' } } }).mode, 'cold');
  assert.match(askPlan({ it: item({ data: { worktree: path.join(WT, 'gone-' + Date.now()) } }) }).why, /worktree is gone/);
  for (const bad of [item({ state: 'running' }), item({ state: 'queued' }), item({ data: { session_id: null } }), undefined])
    assert.throws(() => askPlan({ it: bad }), e => e instanceof RunError && e.code === 2);
});

test('the fork prompt and the cold brief carry norn delegate\'s answer contract (one limit for every helper)', () => {
  const contract = helperBrief({ q: 'Q?', out: '/s/out.md', worktree: WT, cls: 'chores' }).split('## Answer contract')[1];
  for (const b of [forkPrompt({ q: 'Q?', asked: 'RUN-7', out: '/s/out.md' }), coldBrief({ q: 'Q?', it: item(), out: '/s/out.md' })])
    assert.equal(b.split('## Answer contract')[1], contract);
});

// ---------- piece 2: the recorded helper run, the wait, the kill criterion, the CLI ----------
test('ask (cold, fake): a helper RUN under the ENDED run (via ask, read-only, no lock); the brief carries its NOTES; the asked run is untouched', async () => {
  const d = sandbox();
  const asked = await d.asked();
  const before = JSON.stringify(d.item(asked));
  const a = askStart(d.opts({ run: asked }));
  assert.equal(a.mode, 'cold'); assert.equal(a.asked, asked);
  const r = d.item(a.run);
  assert.equal(r.data.role, 'helper'); assert.equal(r.data.parent, asked); assert.equal(r.data.via, 'ask'); assert.equal(r.data.class, 'chores');
  assert.ok(fs.readFileSync(a.brief, 'utf8').includes('built the X table in engine/lib/x.mjs:12'));
  stopOrphans(d.state);   // a helper of an ended run is NOT an orphan
  const w = askWait({ state: d.state, run: a.run, dir: a.dir, maxS: 20, staleMs: 3000 });
  assert.equal(w.code, 0, w.lines.join('\n'));
  const txt = w.lines.join('\n');
  assert.match(txt, new RegExp(`${a.run} exited done`)); assert.match(txt, /work: done/); assert.ok(txt.includes(a.out.replace(/\\/g, '/')));
  assert.ok(w.lines.length <= 60);
  assert.equal(JSON.stringify(d.item(asked)), before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(a.dir, 'ask.json'), 'utf8')).asked, asked);
});

test('ask refusals: unknown run / no question (2); a running run (2)', async () => {
  const d = sandbox();
  assert.throws(() => askStart(d.opts({ run: 'RUN-99' })), e => e instanceof RunError && e.code === 2);
  const asked = await d.asked();
  assert.throws(() => askStart(d.opts({ run: asked, q: ' ' })), e => e instanceof RunError && e.code === 2);
  const a = askStart(d.opts({ run: asked, q: 'mode: sleep\nms: 3000' }));   // the running ask itself cannot be asked
  assert.throws(() => askStart(d.opts({ run: a.run })), e => e instanceof RunError && e.code === 2 && /running/.test(e.message));
  assert.equal(askWait({ state: d.state, run: a.run, dir: a.dir, maxS: 0.2, staleMs: 3000 }).code, 5);
  assert.equal(askWait({ state: d.state, run: a.run, dir: a.dir, maxS: 20, staleMs: 3000 }).code, 0);
});

test('kill criterion: a fork that changed the asked transcript records its executor in nofork.json; later asks of it go cold', () => {
  const t = mkTmp('meta-ask-kc-');
  const state = path.join(t, 'state'), dir = path.join(state, 'ask', 'RUN-7-x'), tr = path.join(t, 'old.jsonl');
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(tr, '{"a":1}\n');
  fs.writeFileSync(path.join(dir, 'ask.json'), JSON.stringify({ asked: 'RUN-7', run: 'RUN-8', executor: 'claude', mode: 'fork', transcript: tr, hash_before: hashFile(tr) }));
  assert.equal(checkIsolation(state, dir), null);
  assert.ok(!fs.existsSync(noforkFile(state)));
  fs.appendFileSync(tr, '{"b":2}\n');
  const k = checkIsolation(state, dir);
  assert.equal(k.executor, 'claude'); assert.equal(k.run, 'RUN-7'); assert.notEqual(k.hash_after, k.hash_before);
  const nofork = JSON.parse(fs.readFileSync(noforkFile(state), 'utf8'));
  assert.equal(askPlan({ it: item(), nofork }).mode, 'cold');
  // a cold ask is never checked
  fs.writeFileSync(path.join(dir, 'ask.json'), JSON.stringify({ asked: 'RUN-7', mode: 'cold', transcript: tr, hash_before: 'x' }));
  assert.equal(checkIsolation(state, dir), null);
});

test('norn ask CLI: blocks and prints the answer (exit 0, <= 60 lines); --max-s 0.2 on a slow ask = 5; a running run = 2', async () => {
  const d = sandbox();
  const asked = await d.asked();
  const env = { ...process.env, META_NO_TICK: '1', META_HB_MS: '150' };
  for (const k of ['META_STATE', 'META_PROJECT', 'META_ROLE', 'META_PARENT_RUN', 'META_RUN_ID']) delete env[k];
  const run = (...a) => spawnSync(process.execPath, [META, 'ask', ...a, '--state', d.state, '--locks', d.locks], { env, encoding: 'utf8' });
  const a = run(asked, '--executor', 'fake', '--q', 'why the X table?', '--max-s', '30');
  assert.equal(a.status, 0, a.stderr + a.stdout);
  assert.match(a.stdout, /cold/); assert.match(a.stdout, /exited done/); assert.match(a.stdout, /work: done/); assert.ok(a.stdout.trim().split('\n').length <= 60);
  const qf = path.join(d.t, 'q.txt'); fs.writeFileSync(qf, 'mode: sleep\nms: 2500\n');
  const s = run(asked, '--executor', 'fake', '--q-file', qf, '--max-s', '0.2');
  assert.equal(s.status, 5, s.stderr + s.stdout);
  const id = s.stdout.match(/(RUN-\d+) running/)[1];
  assert.equal(run(id, '--executor', 'fake', '--q', 'x').status, 2);
  assert.equal(run('--q', 'x').status, 2);
  await d.ended(id);
});

// ---------- piece 3: policy ask.max_per_day ----------
test('policy ask.max_per_day: default 10 (a Settings row); spent = exit 4 "read its NOTES yourself"', async () => {
  assert.equal(POLICY_DEFAULTS.ask.max_per_day, 10);
  const row = SETTINGS.find(s => s.key === 'policy.ask.max_per_day');
  assert.ok(row && row.max >= 10 && row.recommended === '10', 'a Settings row');
  const d = sandbox();
  const asked = await d.asked();
  const project = { name: 'demo', policy: { ask: { max_per_day: 1 } } };
  const a = askStart(d.opts({ run: asked, project }));
  assert.throws(() => askStart(d.opts({ run: asked, project })), e => e instanceof RunRefused && e.code === 4 && /max_per_day=1/.test(e.message));
  assert.equal(askWait({ state: d.state, run: a.run, dir: a.dir, maxS: 20, staleMs: 3000 }).code, 0);
});
