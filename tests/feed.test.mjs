// Live feed per agent (LANE-MAP-DESIGN 2, 4 slice 1): each harness adapter owns feed(run, cursor, env) -> { events, cursor };
// one normalised event shape for every harness; the cursor is a byte offset per file (resume = no repeats); unknown records skip.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS } from '../engine/lib/harness/index.mjs';
import { readLines } from '../engine/lib/harness/common.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(HERE, 'fixtures', 'feed');
const CL_SID = '22222222-3333-4444-8555-666666666666', CX_SID = '33333333-4444-4555-8666-777777777777';
const KINDS = ['tool', 'text', 'step', 'usage', 'marker', 'error'];
const tmp = () => mkTmp('meta-feed-');

function dirs() {
  const root = tmp(), projectsDir = path.join(root, 'claude-projects'), codexDir = path.join(root, 'codex-sessions');
  fs.mkdirSync(path.join(projectsDir, 'C--fx-wt'), { recursive: true });
  fs.copyFileSync(path.join(FX, 'claude.jsonl'), path.join(projectsDir, 'C--fx-wt', CL_SID + '.jsonl'));
  const day = path.join(codexDir, '2026', '11', '08'); fs.mkdirSync(day, { recursive: true });
  fs.copyFileSync(path.join(FX, 'codex-rollout.jsonl'), path.join(day, `rollout-2026-11-08T11-00-00-${CX_SID}.jsonl`));
  const log = path.join(root, 'codex.log');
  fs.writeFileSync(log, ['OpenAI Codex', '--------', 'model: gpt-6.1-sol', `session id: ${CX_SID}`, '--------', 'user', 'brief ...', ''].join('\n'));
  return { root, projectsDir, codexDir, log, env: { projectsDir, codexDir, memo: new Map() } };
}
const run = (executor, data = {}) => ({ id: 'RUN-7', kind: 'run', state: 'running', created: '2026-11-08T10:00:00Z', data: { executor, ...data }, end: null });
const shape = evs => { for (const e of evs) { assert.ok(KINDS.includes(e.kind), e.kind); assert.equal(typeof e.summary, 'string'); assert.ok(e.at && typeof e.at === 'object', 'per-event cursor'); } };

test('claude feed: tool_use -> tool (name + first arg), text -> first line, TodoWrite -> step, usage -> ctx, tool_result pairs by id', async () => {
  const { env } = dirs();
  const r = (await ADAPTERS.claude.feed(run('claude', { session_id: CL_SID }), null, env));
  shape(r.events);
  const tools = r.events.filter(e => e.kind === 'tool' && !e.done);
  assert.deepEqual(tools.map(e => [e.name, e.summary, e.id]), [['Bash', 'cat /fx/brief.md', 'toolu_1'], ['Edit', '/fx/wt/engine/lib/feed.mjs', 'toolu_3']]);
  assert.deepEqual(r.events.filter(e => e.kind === 'text').map(e => e.summary), ['Reading the brief first.']);
  assert.deepEqual(r.events.filter(e => e.kind === 'step').map(e => e.summary), ['Writing the red test']);
  assert.equal(r.events.filter(e => e.kind === 'usage').at(-1).ctx, 3 + 200 + 21500);
  const done = r.events.find(e => e.done && e.id === 'toolu_1');
  assert.equal(done.kind, 'tool'); assert.equal(done.ts, '2026-11-08T10:00:07.200Z');
  const err = r.events.find(e => e.id === 'toolu_3' && e.done);
  assert.equal(err.kind, 'error'); assert.match(err.summary, /String not found/);
  assert.ok(!r.events.some(e => /execute it exactly/.test(e.summary)), 'the human prompt (the brief) is not an event');
});

test('codex feed: rollout custom_tool_call / function_call -> tool, assistant message -> text, reasoning summary -> step, token_count -> ctx', async () => {
  const { env, log } = dirs();
  const r = (await ADAPTERS.codex.feed(run('codex-sol', { log }), null, env));
  shape(r.events);
  assert.deepEqual(r.events.filter(e => e.kind === 'tool' && !e.done).map(e => [e.name, e.summary, e.id]),
    [['exec', 'Get-Content /fx/rules.txt -TotalCount 40', 'call_1'], ['clock.sleep', 'duration_ms 50000', 'call_2']]);
  assert.deepEqual(r.events.filter(e => e.done).map(e => e.id), ['call_1', 'call_2']);
  assert.deepEqual(r.events.filter(e => e.kind === 'text').map(e => e.summary), ["I'll read the rules, then build the set."]);
  assert.deepEqual(r.events.filter(e => e.kind === 'step').map(e => e.summary), ['Checking the reference images']);
  assert.deepEqual(r.events.filter(e => e.kind === 'usage').map(e => e.ctx), [26469, 31000]);
  assert.ok(!r.events.some(e => /Memory rules/.test(e.summary)), 'developer messages are not events');
});

test('codex feed without a rollout (no session id yet) tails the run log instead', async () => {
  const { env, root } = dirs();
  const log = path.join(root, 'early.log'); fs.writeFileSync(log, 'OpenAI Codex\nstarting\n');
  const r = (await ADAPTERS.codex.feed(run('codex-sol', { log }), null, env));
  assert.deepEqual(r.events.map(e => [e.kind, e.summary]), [['text', 'OpenAI Codex'], ['text', 'starting']]);
});

test('cursor resume: a second call from the returned cursor yields only appended records; a torn last line waits; per-event cursor resumes mid-batch', async () => {
  const { env, projectsDir } = dirs();
  const f = path.join(projectsDir, 'C--fx-wt', CL_SID + '.jsonl'), R = run('claude', { session_id: CL_SID });
  const a = (await ADAPTERS.claude.feed(R, null, env));
  assert.deepEqual((await ADAPTERS.claude.feed(R, a.cursor, env)).events, [], 'nothing appended -> nothing');
  const line = JSON.stringify({ type: 'assistant', timestamp: '2026-11-08T10:01:00.000Z', requestId: 'req_D',
    message: { id: 'msg_D', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_9', name: 'Read', input: { file_path: '/fx/wt/x.md' } }] } });
  fs.appendFileSync(f, line.slice(0, 40));
  const b = (await ADAPTERS.claude.feed(R, a.cursor, env));
  assert.deepEqual(b.events, [], 'an incomplete line is not parsed'); assert.deepEqual(b.cursor, a.cursor);
  fs.appendFileSync(f, line.slice(40) + '\n{"type":"brand-new-record-kind","x":1}\nnot json at all\n');
  const c = (await ADAPTERS.claude.feed(R, b.cursor, env));
  assert.deepEqual(c.events.map(e => [e.kind, e.name, e.summary]), [['tool', 'Read', '/fx/wt/x.md']], 'unknown / broken records are skipped, never an error');
  // events of one record share its cursor; the SSE id rides on the last event of a record (server)
  const same = (x, y) => JSON.stringify(x?.at) === JSON.stringify(y?.at), i = a.events.findIndex((e, k) => k > 2 && !same(e, a.events[k + 1]));
  const again = (await ADAPTERS.claude.feed(R, a.events[i].at, env)).events;
  assert.deepEqual(again.map(e => e.summary), [...a.events.slice(i + 1), ...c.events].map(e => e.summary), 'an event cursor resumes right after that record');
});

test('first open of a big file starts at the backlog window on a line boundary; a truncated file restarts', async () => {
  const root = tmp(), f = path.join(root, 'big.log');
  fs.writeFileSync(f, Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n') + '\n');
  const r = (await readLines(f, null, { backlog: 100 }));
  assert.ok(r.lines.length > 5 && r.lines.length < 15, String(r.lines.length));
  assert.match(r.lines[0].text, /^line \d+$/); assert.equal(r.lines.at(-1).text, 'line 999'); assert.equal(r.offset, fs.statSync(f).size);
  fs.writeFileSync(f, 'fresh\n');
  assert.deepEqual((await readLines(f, r.offset, { backlog: 100 })).lines.map(l => l.text), ['fresh']);
});

test('cli / fake / check-in feeds tail their logs (plain text: no tool echo, no context); "## DONE" is text (gap #3)', async () => {
  const root = tmp(), log = path.join(root, 'run.log');
  fs.writeFileSync(log, 'working on it\n\n## DONE\n');
  for (const fam of ['cli', 'fake']) {
    const r = (await ADAPTERS[fam].feed(run(fam, { log }), null, {}));
    shape(r.events);
    assert.deepEqual(r.events.map(e => [e.kind, e.summary]), [['text', 'working on it'], ['text', '## DONE']], fam);
  }
  const ci = (await ADAPTERS.claude.feed(run('claude', { kind: 'checkin', log, session_id: 'no-such-session' }), null, { projectsDir: root, memo: new Map() }));
  assert.deepEqual(ci.events.map(e => e.kind), ['text', 'text'], 'a claude run without a transcript (check-in) falls back to its log');
});
