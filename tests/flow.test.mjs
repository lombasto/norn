// META-GTP-FLOW (GT-PARITY-PLAN sec. 2.9): reusable workflows - engine/flows/<name>.json, instantiated by `norn flow start` as an
// epic of chained queued runs. Piece 1: the schema + validator. Temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadFlow, validateFlow, renderFlow, FlowError, CLASSES, FLOWS_DIR } from '../engine/lib/flows.mjs';
import { loadState, record } from '../engine/lib/records.mjs';
import { fillQueue } from '../engine/lib/runs.mjs';
import { settled } from './helpers/settled.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const tmp = () => mkTmp('meta-flow-');
// a flow dir with one template and a flow built from `steps` (+ extra top-level fields)
function flowDir(steps, extra = {}, tpl = 'step {{step}} of {{flow}} for {{topic}}\n') {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'templates'));
  fs.writeFileSync(path.join(d, 'templates', 'a.md'), tpl);
  const def = { name: 'demo', title: 'demo {{topic}}', vars: { topic: { doc: 'what' }, q: { default: '' } },
    defaults: { lane: 'demo', worktree: '{{topic}}/wt', notes: '{{topic}}/{{step}}-NOTES.md', brief_template: 'templates/a.md', budget_min: 30 },
    steps, ...extra };
  fs.writeFileSync(path.join(d, 'demo.json'), JSON.stringify(def));
  return d;
}
const S = (id, o = {}) => ({ id, title: `the ${id} step`, class: 'implementer', ...o });
const refused = (fn, re) => assert.throws(fn, e => e instanceof FlowError && re.test(e.message), `want FlowError ${re}`);

test('a valid flow loads: steps in dependency order, defaults applied, class resolved', () => {
  const d = flowDir([S('build', { needs: ['spec', 'q:{{q}}:answered'], need_state: 'merged' }), S('spec', { class: 'planner' })]);
  const f = loadFlow('demo', { dir: d });
  assert.deepEqual(f.order, ['spec', 'build']);
  const b = f.steps.find(s => s.id === 'build');
  assert.equal(b.need_state, 'merged');
  assert.equal(b.lane, 'demo');
  assert.equal(b.executor, CLASSES.implementer.executor);
  assert.equal(f.steps.find(s => s.id === 'spec').effort, CLASSES.planner.effort);
});

test('the validator refuses cycles, unknown needs, undeclared placeholders, bad executors and a required ask var', () => {
  refused(() => loadFlow('demo', { dir: flowDir([S('a', { needs: ['b'] }), S('b', { needs: ['a'] })]) }), /cycle: a -> b -> a|cycle: b -> a -> b/);
  refused(() => loadFlow('demo', { dir: flowDir([S('a', { needs: ['nope'] })]) }), /unknown need "nope"/);
  refused(() => loadFlow('demo', { dir: flowDir([S('a', { needs: ['a'] })]) }), /needs itself/);
  refused(() => loadFlow('demo', { dir: flowDir([S('a')], {}, 'uses {{undeclared}}\n') }), /missing var \{\{undeclared\}\}/);
  refused(() => loadFlow('demo', { dir: flowDir([S('a', { stage: '{{nope}}' })]) }), /missing var \{\{nope\}\}/);
  refused(() => loadFlow('demo', { dir: flowDir([S('a', { executor: 'fake' })]) }), /class or executor, not both/);
  refused(() => loadFlow('demo', { dir: flowDir([S('a', { class: 'wizard' })]) }), /unknown class "wizard"/);
  refused(() => loadFlow('demo', { dir: flowDir([S('a', { class: undefined })]) }), /class or an executor/);
  refused(() => loadFlow('demo', { dir: flowDir([S('a', { ask: 'topic' })]) }), /ask var topic must not be required/);
  refused(() => loadFlow('demo', { dir: flowDir([S('a', { need_state: 'ended' })]) }), /need_state/);
  refused(() => loadFlow('demo', { dir: flowDir([S('a'), S('a')]) }), /duplicate step id a/);
  refused(() => loadFlow('demo', { dir: flowDir([S('a', { brief_template: 'templates/missing.md' })]) }), /brief_template .*does not exist/);
  refused(() => loadFlow('demo', { dir: flowDir([S('a', { brief_template: { builtin: 'nope', args: {} } })]) }), /unknown builtin/);
  refused(() => loadFlow('nope', { dir: flowDir([S('a')]) }), /no flow nope/);
  refused(() => validateFlow({ name: 'x', title: 't', steps: [] }, { dir: tmp() }), /at least one step/);
});

test('render: required vars, unknown vars refused; defaults filled; a need term with an empty var is dropped', () => {
  const f = loadFlow('demo', { dir: flowDir([S('spec'), S('build', { needs: ['spec', 'q:{{q}}:answered'] })]) });
  refused(() => renderFlow(f, {}), /missing var topic/);
  refused(() => renderFlow(f, { topic: 'x', zz: '1' }), /unknown var zz/);
  const r = renderFlow(f, { topic: 'T' }, { epic: 'EP-1', briefs_dir: 'B' });
  assert.equal(r.title, 'demo T');
  const b = r.steps.find(s => s.id === 'build');
  assert.deepEqual(b.needs, [{ step: 'spec', state: 'done' }]);
  assert.equal(b.notes, 'T/build-NOTES.md');
  assert.equal(b.brief, 'step build of demo for T\n');
  const b2 = renderFlow(f, { topic: 'T', q: 'Q-7' }).steps.find(s => s.id === 'build');
  assert.deepEqual(b2.needs, [{ step: 'spec', state: 'done' }, { term: { kind: 'q', id: 'Q-7', state: 'answered' } }]);
  refused(() => renderFlow(f, { topic: 'T', q: 'bogus' }), /step build: need "q:bogus:answered"/);
});

// ---------- piece 2: norn flow start | status | resume (CLI, fake executor, temp state) ----------
const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const meta = args => {
  const r = spawnSync(process.execPath, [META, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, META_ROLE: '', META_PROJECT: '', META_STATE: '', META_NO_TICK: '1', META_HB_MS: '150' } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 30000) {
  const t0 = performance.now();   // monotonic: a wall-clock step (the WSL runner, CI 43116967024) never trips the deadline
  for (;;) { const v = fn(); if (v) return v; if (performance.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(100); }
}
// a sandbox: state + a flows dir with flow `chain` = a -> b -> c (fake briefs: `mode: {{mode}}`; b's own template: `mode: {{mode_b}}`);
// b may ask (var pick)
function flowSandbox({ modeB = 'done' } = {}) {
  const t = tmp(), state = path.join(t, 'state', 'demo'), flows = path.join(t, 'flows'), briefs = path.join(t, 'briefs');
  fs.mkdirSync(state, { recursive: true }); fs.mkdirSync(path.join(t, 'wt')); fs.mkdirSync(path.join(flows, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(t, 'budget.json'), JSON.stringify({ max_claude_workers: 4 }));
  fs.writeFileSync(path.join(flows, 'templates', 'step.md'), 'mode: {{mode}}\nstep {{step}} of {{epic}} pick {{pick}}\n');
  fs.writeFileSync(path.join(flows, 'templates', 'b.md'), 'mode: {{mode_b}}\nstep {{step}} of {{epic}} pick {{pick}}\n');
  const def = { name: 'chain', title: 'chain {{topic}}', vars: { topic: {}, root: {}, mode: { default: 'done' }, mode_b: { default: modeB }, pick: { default: '' } },
    defaults: { executor: 'fake', lane: 'chain', worktree: '{{root}}/wt', notes: '{{root}}/{{step}}-NOTES.md', brief_template: 'templates/step.md', budget_min: 5 },
    steps: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', needs: ['a'], ask: 'pick', brief_template: 'templates/b.md' }, { id: 'c', title: 'C', needs: ['b'] }] };
  fs.writeFileSync(path.join(flows, 'chain.json'), JSON.stringify(def));
  // a project only for its fill policy: the resource gate (META-GTP-DAG piece 5) would hold the fake runs on a busy test machine
  const pj = path.join(t, 'project.json'), fwdT = t.split(path.sep).join('/');
  fs.writeFileSync(pj, JSON.stringify({ schema: 1, name: 'demo', title: 'demo', root: fwdT, ledger: '${root}/L.md', briefs_dir: '${root}/briefs', policy: { fill: { min_free_gb: 0, max_cpu_pct: 101 } } }));
  const common = ['--project', pj, '--state', state, '--flows-dir', flows, '--briefs-dir', briefs, '--budget', path.join(t, 'budget.json')];
  const runs = () => Object.values(loadState(state).items).filter(i => i.kind === 'run');
  const status = ep => JSON.parse(meta(['flow', 'status', ep, '--json', ...common]).out);
  const allSettled = () => runs().length && runs().every(r => r.state === 'queued' || settled(r));
  return { t, state, flows, briefs, common, runs, status, allSettled, root: t.replace(/\\/g, '/') };
}
// the project root as a git repo with a main branch (one empty commit): the repo a MERGE step's merge worktree is made from
function gitMain(dir) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  for (const a of [['init', '-q', '-b', 'main'], ['commit', '-q', '--allow-empty', '-m', 'init']]) {
    const r = spawnSync('git', ['-C', dir, ...a], { env, encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
  }
}
const startChain = (d, topic) => meta(['flow', 'start', 'chain', '--var', `topic=${topic}`, '--var', `root=${d.root}`, '--as', 'controller', ...d.common]);

test('flow start: one epic, every step queued with --epic and after: from needs; the chain runs to DONE; status = step -> run -> state', async () => {
  const d = flowSandbox();
  const dry = meta(['flow', 'start', 'chain', '--var', 'topic=x', '--var', `root=${d.root}`, '--dry-run', ...d.common]);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /\(dry run\) flow chain P2: chain x/);
  assert.match(dry.out, /b  -  dry  after run:<a>:done/);
  assert.equal(d.runs().length, 0, 'a dry run writes no record');
  assert.ok(!fs.existsSync(d.briefs), 'a dry run writes no brief');
  const miss = meta(['flow', 'start', 'chain', '--var', 'topic=x', '--as', 'controller', ...d.common]);
  assert.equal(miss.code, 2);
  assert.match(miss.err, /missing var root/);
  const r = startChain(d, 'x');
  assert.equal(r.code, 0, r.err);
  const ep = r.out.match(/^(EP-\d+) flow chain/)[1];
  // the launches only: a step already done by now has filled its queued successor into a new run carrying the same data.flow
  const by = Object.fromEntries(d.runs().filter(x => !x.data.from_queue).map(x => [x.data.flow.step, x]));
  assert.deepEqual(Object.keys(by).sort(), ['a', 'b', 'c']);
  for (const x of Object.values(by)) assert.equal(x.data.epic, ep);
  assert.deepEqual(by.b.data.after, [{ kind: 'run', id: by.a.id, state: 'done' }]);
  assert.deepEqual(by.c.data.after, [{ kind: 'run', id: by.b.id, state: 'done' }]);
  assert.equal(fs.readFileSync(by.b.data.brief, 'utf8'), `mode: done\nstep b of ${ep} pick \n`);
  await waitFor(() => d.status(ep).done);
  await waitFor(d.allSettled);
  const s = meta(['flow', 'status', ep, ...d.common]);
  assert.match(s.out, new RegExp(`${ep} flow chain open: chain x  3/3  DONE`));
  assert.match(s.out, new RegExp(`  c  ${by.c.id}  done  C`));
  assert.match(meta(['epic', 'show', ep, '--state', d.state]).out, /DONE/);
  assert.match(meta(['flow', 'resume', ep, ...d.common]).out, /nothing to resume/);
});

test('flow resume: a STOPPED step is re-queued with its withdrawn successors; done steps never re-run', async () => {
  const d = flowSandbox({ modeB: 'stopped' });
  const r = startChain(d, 'y');
  assert.equal(r.code, 0, r.err);
  const ep = r.out.match(/^(EP-\d+)/)[1];
  await waitFor(() => { const s = d.status(ep).steps; return s[1].state === 'gone' && s[2].state === 'gone'; });
  await waitFor(d.allSettled);
  const st = d.status(ep);
  assert.equal(st.steps[0].state, 'done');
  assert.match(st.steps[1].why, /ended stopped/);
  const aRun = st.steps[0].run;
  const res = meta(['flow', 'resume', ep, '--var', 'mode_b=done', ...d.common]);
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, new RegExp(`${ep} resume from b`));
  assert.match(res.out, new RegExp(`b  RUN-\\d+  QUEUED .*after run:${aRun}:done`));
  assert.match(res.out, /flow-EP-\d+-b-r2-brief\.md/);
  await waitFor(() => d.status(ep).done);
  await waitFor(d.allSettled);
  const end = d.status(ep);
  assert.deepEqual(end.steps.map(s => s.runs.length), [1, 2, 2], 'a ran once; b and c twice');
  assert.equal(end.vars.mode_b, 'done', 'the resume vars are the checkpoint of the new runs');
});

test('flow resume --var <ask>=Q-n: the STOPPED ask step is passed, its successors wait for the owner answer', async () => {
  const d = flowSandbox({ modeB: 'stopped' });
  const ep = startChain(d, 'z').out.match(/^(EP-\d+)/)[1];
  await waitFor(() => d.status(ep).steps[2].state === 'gone');
  await waitFor(d.allSettled);
  assert.match(meta(['flow', 'resume', ep, '--var', 'pick=Q-99', ...d.common]).err, /Q-99 does not exist/);
  const q = record(d.state, { kind: 'question', ev: 'create', by: 'controller', data: { title: 'pick one', lane: 'chain', owner_only: true } }).id;
  const res = meta(['flow', 'resume', ep, '--var', `pick=${q}`, ...d.common]);
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, /resume from c/);
  assert.match(res.out, new RegExp(`c  RUN-\\d+  QUEUED .*after q:${q}:answered`));
  let st = d.status(ep);
  assert.equal(st.steps[1].state, 'passed');
  assert.equal(st.steps[1].ask_q, q);
  assert.equal(st.steps[2].state, 'queued', 'waits for the owner');
  record(d.state, { kind: 'question', ev: 'answer', id: q, by: 'owner', data: { text: 'the second', via: 'chat' } });
  fillQueue(d.state);
  await waitFor(() => d.status(ep).done);
  await waitFor(d.allSettled);
  st = d.status(ep);
  assert.deepEqual(st.steps.map(s => s.runs.length), [1, 1, 2], 'b (passed) is not re-run');
  assert.match(fs.readFileSync(loadState(d.state).items[st.steps[2].run].data.brief, 'utf8'), new RegExp(`pick ${q}`));
});

// ---------- piece 3: the shipped flows (engine/flows), each dry-run + run to DONE on the fake executor ----------
const SHIPPED = {
  merge: (t, d) => ({ lane: 'demo', branch: 'feat/demo', worktree: d.wt('lane'), notes: `${t}/MERGE-NOTES.md` }),
  'spec-then-build': (t, d) => ({ topic: 'a widget', lane: 'widget', worktree: d.wt('build'), branch: 'feat/widget', notes_dir: t }),
  'art-round': (t, d) => ({ subject: 'a heron sprite', lane: 'art', worktree: d.wt('art'), out_dir: t, dest: 'assets/heron.png' }),
  door: (t, d) => ({ n: '9', branches: 'feat/a,feat/b', door_worktree: d.wt('door9'), door_branch: 'door9', main_checkout: d.wt('main'), notes_dir: t }),
  'lean-tests': (t, d) => ({ scope: 'tests/drift.test.mjs', lane: 'lean', worktree: d.wt('lean'), branch: 'feat/lean-1', notes_dir: t }),
};
const STEPS = { merge: ['merge'], 'spec-then-build': ['spec', 'build', 'merge'], 'art-round': ['generate', 'critique', 'vendor'], door: ['stage-a', 'stage-b'], 'lean-tests': ['analyse', 'wave', 'verify'] };

test('every shipped flow validates; no code branch names a flow (the kill criterion)', () => {
  const names = fs.readdirSync(FLOWS_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')).sort();
  assert.deepEqual(names, Object.keys(SHIPPED).sort());
  for (const n of names) assert.deepEqual(loadFlow(n).order, STEPS[n], n);
  const src = fs.readFileSync(path.join(FLOWS_DIR, '..', 'lib', 'flows.mjs'), 'utf8') + fs.readFileSync(META, 'utf8');
  for (const n of names) assert.doesNotMatch(src, new RegExp(`['"]${n}['"]\\s*\\)?\\s*(===|!==|\\?)|(===|!==)\\s*['"]${n}['"]`), `a code branch on flow ${n}`);
  // a whole-var need holds after terms; empty = no need
  const f = validateFlow({ name: 'x', title: 't', vars: { after: { default: '' } }, steps: [{ id: 'a', title: 'a', needs: ['{{after}}'], executor: 'fake', budget_min: 1,
    lane: 'l', worktree: 'w', notes: 'n', brief_template: { builtin: 'merge', args: { lane: 'l', branch: 'b', worktree: 'w', notes: 'n' } } }] }, { dir: tmp() });
  const st = tmp();   // GAP-6: the merge builtin's merge worktree lives under the flow's state dir
  assert.deepEqual(renderFlow(f, {}, { state: st }).steps[0].needs, []);
  assert.deepEqual(renderFlow(f, { after: 'run:RUN-1:done,q:Q-2' }, { state: st }).steps[0].needs.map(n => n.term.id), ['RUN-1', 'Q-2']);
});

for (const name of Object.keys(SHIPPED)) {
  test(`shipped flow ${name}: dry run renders every step brief; on the fake executor it runs to DONE`, async () => {
    const d = flowSandbox();
    d.wt = n => { const w = path.join(d.t, n); fs.mkdirSync(w, { recursive: true }); return w.split(path.sep).join('/'); };
    if (STEPS[name].includes('merge')) gitMain(d.t);   // GAP-6: a MERGE run works in its own merge worktree of the project's repo
    const vars = Object.entries(SHIPPED[name](d.root, d)).flatMap(([k, v]) => ['--var', `${k}=${v}`]);
    const common = d.common.filter((x, i, a) => x !== '--flows-dir' && a[i - 1] !== '--flows-dir');   // the shipped flows dir
    const dry = meta(['flow', 'start', name, ...vars, '--dry-run', ...common]);
    assert.equal(dry.code, 0, dry.err);
    assert.deepEqual([...dry.out.matchAll(/^ {2}([\w-]+) {2}- {2}dry/gm)].map(m => m[1]), STEPS[name]);
    assert.equal(d.runs().length, 0);
    const r = meta(['flow', 'start', name, ...vars, '--executor', 'fake', '--as', 'controller', ...common]);
    assert.equal(r.code, 0, r.err);
    const ep = r.out.match(/^(EP-\d+)/)[1];
    const st = () => JSON.parse(meta(['flow', 'status', ep, '--json', ...common]).out);
    // META-OOTB-FIX FLOW-STALL (CI 43536392454): a stall names its step - the flow status + every run's supervisor log tail (no timeout change)
    try { await waitFor(() => st().done, 60000); }
    catch (e) {
      const logs = d.runs().map(x => `--- ${x.id} ${x.data.flow?.step ?? '?'} ${x.state} ${x.data.log ?? '(no log)'}\n`
        + (x.data.log && fs.existsSync(x.data.log) ? fs.readFileSync(x.data.log, 'utf8').trimEnd().split('\n').slice(-20).join('\n') : ''));
      throw new Error(`${e.message}: flow ${name} ${ep} not done\nnorn flow status ${ep} --json:\n${meta(['flow', 'status', ep, '--json', ...common]).out}\n${logs.join('\n')}`);
    }
    await waitFor(d.allSettled);
    const end = st();
    assert.deepEqual(end.steps.map(s => [s.id, s.state, s.runs.length]), STEPS[name].map(s => [s, 'done', 1]));
    for (const s of end.steps) {
      const run = loadState(d.state).items[s.run], text = fs.readFileSync(run.data.brief, 'utf8');
      assert.doesNotMatch(text, /\{\{\w+\}\}/, `${name}/${s.id}: every placeholder filled`);
      assert.ok(text.includes(ep) || /meta-merge/.test(text), `${name}/${s.id}: the brief names its epic (or is the merge-brief)`);
    }
    if (name === 'door') for (const s of end.steps) assert.match(fs.readFileSync(loadState(d.state).items[s.run].data.brief, 'utf8'), /skills\/door\/SKILL\.md[\s\S]*GPU lock and QUIET rules are unchanged/);
    if (STEPS[name].includes('merge')) assert.equal(loadState(d.state).items[end.steps.find(s => s.id === 'merge').run].data.stage, 'MERGE');
  });
}
