// S6 agents tree + truthful lanes (META-GENERAL-DESIGN 5, 6, 12-S6): trimmed real transcript fixtures copied to temp dirs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transcriptInfo, subagents, codexInfo, findTranscript, findRollout, agentsTree } from '../engine/lib/agents.mjs';
import { lanesView } from '../engine/lib/lanes.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'agents');
const SID = '11111111-2222-4333-8444-555555555555';
const CSID = '01a18ee7-ebab-72f0-8d34-66a0b62f4a01';
const LAST = Date.parse('2026-10-29T14:04:37.320Z');
const tmp = p => mkTmp(p);

function fixtureDirs() {
  const root = tmp('meta-agents-');
  const projects = path.join(root, 'projects'), codex = path.join(root, 'codex', 'sessions');
  fs.cpSync(path.join(FIX, 'claude'), path.join(projects, 'C--fx-wt'), { recursive: true });
  fs.mkdirSync(path.join(codex, '2026', '10', '30'), { recursive: true });
  for (const f of fs.readdirSync(path.join(FIX, 'codex'))) fs.copyFileSync(path.join(FIX, 'codex', f), path.join(codex, '2026', '10', '30', f));
  return { root, projects, codex, main: path.join(projects, 'C--fx-wt', SID + '.jsonl') };
}

test('transcriptInfo: model, effort, ctx of the last call, cacheR sum with requestId dedupe, burn30', () => {
  const { main } = fixtureDirs();
  const i = transcriptInfo(main, new Map(), { now: LAST + 60000 });
  assert.equal(i.model, 'claude-opus-5-5');
  assert.equal(i.effort, 'medium');
  assert.equal(i.ctx, 4 + 33810 + 31513);
  assert.equal(i.cacheR, 33810 + 33810);
  assert.equal(i.burn30, 33810 + 31513);
  assert.equal(i.first, '2026-10-29T07:36:05.073Z');
  assert.equal(i.last, '2026-10-29T14:04:37.320Z');
});

test('subagents: sub jsonl model + last usage, meta.json agentType / effort / finished, first record ts', () => {
  const { main } = fixtureDirs();
  const [s, ...rest] = subagents(main, new Map(), { now: LAST });
  assert.equal(rest.length, 0);
  assert.equal(s.id, 'a178bc1fd5072dfb8');
  assert.equal(s.agentType, 'kestrel-implementer');
  assert.equal(s.description, 'IS-6 fix round (prism)');
  assert.equal(s.effort, 'high');
  assert.equal(s.finished, true);
  assert.equal(s.state, 'finished');
  assert.equal(s.model, 'claude-opus-5-5');
  assert.equal(s.ctx, 2 + 44054 + 3987);
  assert.equal(s.first, '2026-10-29T14:07:04.990Z');
});

test('codex: rollout found by session id, live token count from the last token_count line', () => {
  const { codex } = fixtureDirs();
  const f = findRollout(codex, CSID);
  assert.ok(f && f.endsWith(`-${CSID}.jsonl`));
  const c = codexInfo(f, new Map());
  assert.equal(c.total, 60559);
  assert.equal(c.last, 32522);
  assert.equal(c.window, 258400);
  assert.equal(findRollout(codex, 'nope'), null);
});

test('agentsTree: one root per RUN (running + ended < 2 h), children = subagents; codex live count; a cli run (grok) "-"', () => {
  const d = fixtureDirs();
  const state = path.join(d.root, 'state');
  const now = LAST + 10 * 60000;
  const log = path.join(d.root, 'codex.log');
  fs.writeFileSync(log, ['OpenAI Codex', '--------', 'workdir: /fx/wt', 'model: gpt-5.4', 'reasoning effort: xhigh', `session id: ${CSID}`, '--------', 'work'].join('\n'));
  record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'gen', session_id: SID, model: 'claude-opus-5-5', effort: 'medium', budget_min: 90 } });
  record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'codex', executor: 'codex-sol', lane: 'render', log } });
  record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'cli', executor: 'grok', lane: 'triage', model: 'grok-4' } });
  record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'old' } });
  record(state, { kind: 'run', ev: 'end', id: 'RUN-4', by: 'launcher', data: { exit: 0, outcome: 'done' } });
  const runs = Object.values(loadState(state).items).filter(i => i.kind === 'run');
  // RUN-4 ended "3 h ago": shift its updated stamp back
  runs.find(r => r.id === 'RUN-4').updated = new Date(now - 3 * 3600000).toISOString();
  const tree = agentsTree(runs, { projectsDir: d.projects, codexDir: d.codex, cache: new Map(), now, policy: { context: { implementer: { handoff_k: 110 } } } });
  assert.deepEqual(tree.map(r => r.id), ['RUN-1', 'RUN-2', 'RUN-3']);
  const [w, c, g] = tree;
  assert.equal(w.ctx, 4 + 33810 + 31513);
  assert.equal(w.ctx_limit, 110000);
  assert.equal(w.children.length, 1);
  assert.equal(w.children[0].agentType, 'kestrel-implementer');
  assert.equal(c.executor, 'codex-sol');
  assert.equal(c.model, 'gpt-5.4');
  assert.equal(c.effort, 'xhigh');
  assert.equal(c.tokens, 60559);
  assert.equal(c.tokens_src, 'live');
  assert.equal(g.tokens, '-');
  assert.equal(g.model, 'grok-4');
});

test('agentsTree: talk sessions become roots; codex without a rollout falls back to the end tokens', () => {
  const d = fixtureDirs();
  const state = path.join(d.root, 'state');
  record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'codex', executor: 'codex-astra', lane: 'x', model: 'gpt-5.4' } });
  record(state, { kind: 'run', ev: 'end', id: 'RUN-1', by: 'launcher', data: { exit: 0, outcome: 'done', tokens: 408480, codex_session: 'gone' } });
  const runs = Object.values(loadState(state).items).filter(i => i.kind === 'run');
  const tree = agentsTree(runs, { projectsDir: d.projects, codexDir: d.codex, now: Date.now(),
    sessions: [{ name: 'ask', model: 'claude-sonnet', effort: 'low', alive: true, context: 1234 }] });
  assert.equal(tree[0].tokens, 408480);
  assert.equal(tree[0].tokens_src, 'end');
  const t = tree.find(r => r.kind === 'talk');
  assert.equal(t.id, 'talk:ask');
  assert.equal(t.ctx, 1234);
  assert.equal(t.state, 'alive');
});

// ---------- lanes (design 5) ----------
function laneState() {
  const state = tmp('meta-lanes-');
  for (const n of ['gen', 'render', 'idle', 'parkd', 'gone']) record(state, { kind: 'lane', ev: 'create', by: 'controller', data: { name: n, worktree: `/wt/${n}` } });
  record(state, { kind: 'lane', ev: 'archive', id: 'L:gone', by: 'owner', data: {} });
  record(state, { kind: 'lane', ev: 'park', id: 'L:parkd', by: 'controller', data: { why: 'blocked by Q-7: x', q: 'Q-7' } });
  return state;
}

test('lanes: no lane without a LANE record; archived only with all; exited / lost / parked / refused strings', () => {
  const state = laneState();
  record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'phantom' } });
  record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'gen' } });
  record(state, { kind: 'run', ev: 'end', id: 'RUN-2', by: 'launcher', data: { exit: 0, outcome: 'handoff' } });
  record(state, { kind: 'run', ev: 'resume', id: 'RUN-2', by: 'launcher', data: { refused: 'cap 8/8', count: 8, max: 8 } });
  record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'idle' } });
  const st = loadState(state);
  const v = lanesView(st, { now: Date.now(), hbAge: id => (id === 'RUN-3' ? 10 * 60000 : 0) });
  assert.deepEqual(v.map(l => l.name).sort(), ['gen', 'idle', 'parkd', 'render']);
  const by = Object.fromEntries(v.map(l => [l.name, l.text]));
  assert.equal(by.gen, 'waiting: auto-resume refused (cap 8/8)');
  assert.equal(by.idle, 'heartbeat late (600 s)', 'a stale beat is late; only the sweep record says lost (MAIL-22)');
  assert.equal(by.parkd, 'parked by Q-7');
  assert.equal(by.render, 'no runs');
  assert.ok(lanesView(st, { all: true }).some(l => l.name === 'gone'));
  assert.ok(!lanesView(st, { all: true }).some(l => l.name === 'phantom'));
  for (const [outcome, extra, want] of [['done', {}, 'exited: DONE'], ['stopped', { why: 'red test' }, 'exited: STOPPED: red test'], ['no-result', {}, 'exited: no-result']]) {
    const s2 = laneState();
    record(s2, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'gen' } });
    record(s2, { kind: 'run', ev: 'end', id: 'RUN-1', by: 'launcher', data: { exit: 0, outcome, ...extra } });
    assert.equal(lanesView(loadState(s2)).find(l => l.name === 'gen').text, want);
  }
});
