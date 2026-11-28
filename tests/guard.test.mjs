// META-GUARD R1 (DIR-23 / DIR-30): Norn guards the tokens - the live runaway watch (k x the peers' median, over the hand-off line),
// the context growth of a run split by source (tool output by tool, the model's own text, injected text) and the tool-spam hint;
// alarms are GRD records the check-in rules (never a kill), a run chip, a "usage" notice class (batched unless pushed). Synthetic
// transcripts only: a normal run, a RUN-576-shaped runaway, a run over the hand-off line, a run whose context is test-runner output.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { record, readEvents, recordsFile, fold } from '../engine/lib/records.mjs';
import { transcriptTrace, toolKey } from '../engine/lib/standing.mjs';
import { contextSources, guardScan, guardWatch, guardProbe, guardChips, GUARD_DEFAULTS } from '../engine/lib/guard.mjs';
import { notify } from '../engine/lib/notify.mjs';
import { digest } from '../engine/lib/digest.mjs';
import { renderDigest } from '../engine/lib/views.mjs';
import { main } from '../engine/bin/norn.mjs';

after(cleanTmp);
const w = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); return f; };
const L = o => JSON.stringify(o);
const asst = (i, ts, { cr, cc = 0, input = 0, out = 100, text = '', tool = null }) => L({ type: 'assistant', timestamp: ts, requestId: 'q' + i,
  message: { id: 'm' + i, model: 'claude-opus-5-5', content: [...(text ? [{ type: 'text', text }] : []), ...(tool ? [{ type: 'tool_use', id: 'tu' + i, name: tool.name, input: tool.input }] : [])],
    usage: { input_tokens: input, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, output_tokens: out } } });
const res = (i, ts, chars) => L({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu' + i, content: 'x'.repeat(chars) }] } });
const T0 = Date.parse('2026-11-13T10:00:00Z'), ts = i => new Date(T0 + i * 10000).toISOString();
const READ = { name: 'Read', input: { file_path: 'a' } }, TESTS = { name: 'Bash', input: { command: 'node --test tests/x.test.mjs' } };
/** n API calls; context ctx0 + i * grow (each call writes `grow` new tokens to the cache); one tool result of `result` chars after each */
function runFile(pdir, sid, { n, ctx0 = 20000, grow = 500, tool = READ, result = 1000, big = null }) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    const ctx = ctx0 + i * grow, cc = i ? grow : ctx0;
    lines.push(asst(i, ts(i), { cr: ctx - cc, cc, tool }), res(i, ts(i), big && big.at === i ? big.chars : result));
  }
  return w(path.join(pdir, 'proj-x', sid + '.jsonl'), lines.join('\n') + '\n');
}

test('trace + sources: each turn\'s context growth split into tool output by tool (test runners apart), the model\'s text and injected text; the share of cache reads each causes', () => {
  assert.equal(toolKey('Bash', { command: 'cd x && uv run --no-sync pytest tests/a.py -q' }), 'test runner');
  assert.equal(toolKey('Bash', { command: 'git status' }), 'Bash');
  assert.equal(toolKey('mcp__norn__norn_status', {}), 'MCP');
  const dir = mkTmp('meta-guard-src-');
  const f = w(path.join(dir, 's.jsonl'), [
    asst(1, ts(1), { cc: 10000, cr: 0, text: 'y'.repeat(400), tool: READ }), res(1, ts(1), 4000),
    asst(2, ts(2), { cc: 1200, cr: 10000, tool: TESTS }), res(2, ts(2), 8000),
    asst(2, ts(2), { cc: 1200, cr: 10000 }),                                                    // the same message in a second line: once
    L({ type: 'user', timestamp: ts(3), message: { role: 'user', content: 'MAIL-4 from the controller: ' + 'z'.repeat(372) } }),
    asst(3, ts(3), { cc: 2200, cr: 11200 }), asst(4, ts(4), { cr: 13400 })].join('\n') + '\n');
  const t = transcriptTrace(f);
  assert.equal(t.e.length, 4);
  const s = contextSources(t);
  assert.equal(s.turns, 4); assert.equal(s.cache_read, 10000 + 11200 + 13400);
  const by = Object.fromEntries(s.sources.map(x => [x.key, x]));
  assert.deepEqual([by['tool:Read'].tokens, by['tool:Read'].reread], [1000, 2000], 'written after call 1: cached by call 2, read by calls 3 and 4');
  assert.deepEqual([by['tool:test runner'].tokens, by['tool:test runner'].reread], [2000, 2000]);
  assert.deepEqual([by.injected.tokens, by.injected.reread], [100, 100]);
  assert.equal(by.model.cls, 'model'); assert.equal(by['tool:Read'].cls, 'tool'); assert.equal(by.injected.cls, 'injected');
  assert.ok(Math.abs(by['tool:test runner'].share - 2000 / 34600) < 1e-9);
  assert.deepEqual(s.standing, { tokens: 10000, reread: 30000, share: 30000 / 34600 });
  assert.deepEqual(s.max, { tool: 'test runner', chars: 8000, tokens: 2000, at: 2 });
  assert.ok(Math.abs(s.tool_share - 4000 / 34600) < 1e-9);
});

// one project: 4 ended peers (worker / kestrel-implementer / high, 6M cache reads, 60 turns), one other-agent run (not a peer), and four live runs
function fixture() {
  const st = mkTmp('meta-guard-'), pdir = path.join(path.dirname(st), 'projects-' + path.basename(st)), at = t => ({ now: () => new Date(t), run: null });
  const start = (sid, created, data = {}) => record(st, { kind: 'run', ev: 'start', by: 'launcher', data: { executor: 'claude', kind: 'worker', lane: 'water', stage: 'S1', agent: 'kestrel-implementer', effort: 'high', session_id: sid, ...data } }, at(created)).id;
  for (let i = 0; i < 4; i++) {
    const fin = w(path.join(st, 'finals', `p${i}.json`), L({ num_turns: 60 }));
    const id = start('p' + i, `2026-11-1${i}T08:00:00Z`, { final: fin });
    record(st, { kind: 'run', ev: 'end', id, by: 'launcher', data: { outcome: 'done', exit: 0, usage: { cache_read_input_tokens: 6e6, input_tokens: 10, output_tokens: 5000, cache_creation_input_tokens: 2e5 } } }, at(`2026-11-1${i}T09:00:00Z`));
  }
  const pl = start('pl', '2026-11-12T08:00:00Z', { agent: 'kestrel-planner' });
  record(st, { kind: 'run', ev: 'end', id: pl, by: 'launcher', data: { outcome: 'done', exit: 0, usage: { cache_read_input_tokens: 90e6 } } }, at('2026-11-12T09:00:00Z'));
  runFile(pdir, 'normal', { n: 30 });
  runFile(pdir, 'runaway', { n: 227, ctx0: 60000, grow: 1100 });
  runFile(pdir, 'over', { n: 12, ctx0: 305000, grow: 300 });
  runFile(pdir, 'spam', { n: 42, ctx0: 5000, grow: 2500, tool: TESTS, result: 10000, big: { at: 3, chars: 100000 } });
  const ids = { normal: start('normal', '2026-11-13T09:59:00Z', { lane: 'docs' }), runaway: start('runaway', '2026-11-13T09:59:00Z'),
    over: start('over', '2026-11-13T09:59:00Z', { lane: 'map' }), spam: start('spam', '2026-11-13T09:59:00Z', { lane: 'tests' }) };
  return { st, pdir, ids, o: { projectsDir: pdir, now: Date.parse('2026-11-13T11:00:00Z') } };
}

test('runaway watch: a RUN-576-shaped run passes k x its peers\' median (same kind + agent + effort); a run over the hand-off line; tool spam; a normal run is quiet', () => {
  const { st, ids, o } = fixture();
  const s = guardScan(st, { policy: {} }, o);
  const run = id => s.runs.find(r => r.id === id), cls = id => run(id).flags.map(f => f.cls).sort();
  assert.deepEqual(s.policy, GUARD_DEFAULTS);
  assert.equal(s.runs.length, 4, 'only live runs are watched');
  assert.deepEqual(cls(ids.normal), []);
  const r = run(ids.runaway);
  assert.equal(r.turns, 227); assert.equal(r.peers.n, 4, 'the planner run is no peer'); assert.equal(r.peers.median_cr, 6e6); assert.equal(r.peers.median_turns, 60);
  assert.ok(r.cache_read > 40e6 && r.ratio > 6, `ratio ${r.ratio}`);
  assert.ok(cls(ids.runaway).includes('runaway'));
  assert.match(r.flags.find(f => f.cls === 'runaway').why, /x the median 6\.0M of 4 peers \(worker \/ kestrel-implementer \/ high\); 227 turns \(median 60\)/);
  assert.deepEqual(cls(ids.over), ['over-handoff']);
  assert.match(run(ids.over).flags[0].why, /above the hand-off line \(300k\) for the last 12 calls/);
  assert.deepEqual(cls(ids.spam), ['tool-spam']);
  assert.match(run(ids.spam).flags[0].why, /% of its cache reads are tool output \(test runner \d+ %\); one test runner result ~25k tokens/);
  // k and the floor are policy: k 10 quiets the runaway; a 100M floor too
  assert.ok(!guardScan(st, { policy: { guard: { k: 10 } } }, o).runs.find(x => x.id === ids.runaway).flags.some(f => f.cls === 'runaway'));
  assert.ok(!guardScan(st, { policy: { guard: { floor_m: 100 } } }, o).runs.find(x => x.id === ids.runaway).flags.some(f => f.cls === 'runaway'));
});

test('alarms are GRD records: raised once per run + class, a probe fact wakes the check-in, a run chip, the digest row; closed when the run ends; never a kill', () => {
  const { st, ids, o } = fixture();
  const p = { name: 'x', policy: {} };
  const a = guardWatch(st, p, o);
  assert.deepEqual(a.raised.map(x => `${x.run} ${x.cls}`).sort(), [`${ids.over} over-handoff`, `${ids.runaway} over-handoff`, `${ids.runaway} runaway`, `${ids.spam} tool-spam`].sort());
  assert.ok(a.raised.every(x => /^GRD-\d+$/.test(x.id)));
  assert.equal(guardWatch(st, p, o).raised.length, 0, 'the next watch raises nothing new');
  const items = Object.values(fold(readEvents(recordsFile(st, 'guard'))).items);
  assert.ok(items.every(i => i.kind === 'guard' && i.state === 'open'));
  const run = fold(readEvents(recordsFile(st, 'run'))).items[ids.runaway];
  assert.equal(run.state, 'running', 'the watch never kills');
  assert.deepEqual(guardProbe(st)({ at: Date.now() + 1000 }).sort(), items.map(i => 'guard:' + i.id).sort());
  const chips = guardChips(st);
  assert.deepEqual(chips.get(ids.runaway).map(c => c.cls).sort(), ['over-handoff', 'runaway']);
  const d = digest(st, { name: 'x' }, { now: o.now, dlv: [] });
  assert.equal(d.sections.guard.length, 4);
  assert.match(renderDigest(d), /## 8 Usage guard \(4\)[\s\S]*GRD-\d+ RUN-\d+ runaway/);
  // the check-in rules one: let it run / mail it / stop it
  const g = a.raised.find(x => x.cls === 'runaway').id;
  const cli = args => { const out = [], err = []; const code = main(args, { ...process.env, META_ROLE: 'checkin' }, s => out.push(s), s => err.push(s)); return { code, out: out.join('\n'), err: err.join('\n') }; };
  assert.equal(cli(['guard', 'rule', g, '--action', 'shrug', '--why', 'w', '--state', st]).code, 2);
  const r = cli(['guard', 'rule', g, '--action', 'mail', '--why', 'asked it to hand off', '--state', st]);
  assert.equal(r.code, 0, r.err);
  assert.equal(fold(readEvents(recordsFile(st, 'guard'))).items[g].state, 'ruled');
  // the run ends: its open alarms close
  record(st, { kind: 'run', ev: 'end', id: ids.over, by: 'launcher', data: { outcome: 'handoff', exit: 0 } });
  const b = guardWatch(st, p, o);
  assert.deepEqual(b.closed.length, 1);
  assert.equal(guardChips(st).has(ids.over), false);
  const j = JSON.parse(cli(['guard', '--json', '--state', st]).out);
  assert.ok(Array.isArray(j.open) && j.open.length === 2);
});

test('notice class "usage": batched into the FYI digest by default (off for the phone), pushed only with policy guard.push', async () => {
  const st = mkTmp('meta-guard-n-');
  const r = await notify({ title: 'RUN-7 runaway', body: 'GRD-1: 43.5M cache reads = 6.1x', cls: 'usage', machine: { notify: { backend: 'none' } }, state: st });
  assert.equal(r.batched, true); assert.equal(r.sent, false);
  const log = fs.readFileSync(path.join(st, 'notify.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(log.at(-1).class, 'usage');
  const p = await notify({ title: 'RUN-7 runaway', body: 'GRD-1', cls: 'usage', push: true, machine: { notify: { backend: 'none' } }, state: st });
  assert.notEqual(p.batched, true);
});

test('L-20: a records error is an error - the scan and the watch throw; no alarm is closed as "run gone" or raised again', () => {
  const { st, o } = fixture(), p = { name: 'x', policy: {} };
  const open = guardWatch(st, p, o).raised.length, guards = () => Object.values(fold(readEvents(recordsFile(st, 'guard'))).items).filter(g => g.state === 'open').length;
  assert.ok(open > 0);
  fs.appendFileSync(recordsFile(st, 'run'), '{ torn\n');
  assert.throws(() => guardScan(st, p, o), /runs\.jsonl/, 'no runs is not what the records say');
  assert.throws(() => guardWatch(st, p, o), /runs\.jsonl/);
  assert.equal(guards(), open, 'every alarm stays open');
});
