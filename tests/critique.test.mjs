// META-DOD 3 (owner DIR-68): a fresh-eyes review of every plan before its build starts. A planning-class run that ends DONE queues ONE
// read-only review run on the policy's review executor (policy.dod.critique on); its findings file sits beside the plan; a build whose
// brief names the plan waits for it (after run:RUN-n:reviewed) - a clean review releases it, findings wait for the check-in's review.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findingsCount, critiqueFiles, critiqueOn, classExecutor } from '../engine/lib/critique.mjs';
import { SETTINGS, withDefaults } from '../engine/lib/policy.mjs';
import { loadState, record } from '../engine/lib/records.mjs';
import { makeEval, parseAfter } from '../engine/lib/after.mjs';
import { digest } from '../engine/lib/digest.mjs';
import { renderDigest } from '../engine/lib/views.mjs';
import { agentsTree } from '../engine/lib/agents.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { mapGraph } from '../engine/lib/map.mjs';
import { settled } from './helpers/settled.mjs';
import { waitFor, stateBusy, supervisorAlive } from './helpers/wait.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const NORN = path.join(import.meta.dirname, '..', 'engine', 'bin', 'norn.mjs');
const fwd = p => p.split(path.sep).join('/');
const runsOf = state => Object.values(loadState(state).items).filter(i => i.kind === 'run').sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4)));

test('findingsCount / critiqueFiles / the policy row: [P1]-[P3] lines count, "No findings." is 0; findings beside the plan; off by default', () => {
  assert.equal(findingsCount('- [P1] a scenario - f.mjs:3 - fix\n- [P2] b\n* [P3] c\ntext [P1] not a finding\n## DONE\n'), 3);
  assert.equal(findingsCount('No findings.\n## DONE\n'), 0);
  assert.equal(findingsCount(null), null);
  assert.deepEqual(critiqueFiles('/r/plans/PLAN.md'), { findings: '/r/plans/PLAN-CRITIQUE.md', brief: '/r/plans/PLAN-CRITIQUE.brief.md' });
  assert.equal(withDefaults({}).policy.dod.critique, 'off');
  assert.equal(critiqueOn({ dod: { critique: 'on' } }), true);
  assert.equal(critiqueOn({}), false);
  const row = SETTINGS.find(r => r.key === 'policy.dod.critique');
  assert.deepEqual(row.options, ['off', 'on']);
  assert.ok(SETTINGS.find(r => r.key === 'policy.dod.critique_filter'), 'the filter file row');
  // the review executor: a named executor runs as itself, an agent name runs on claude with that agent
  assert.deepEqual(classExecutor({ policy: { executors: { review: { executor: 'codex-sol', model: 'gpt-6.1-sol', effort: 'medium' } } } }, 'review'),
    { executor: 'codex-sol', model: 'gpt-6.1-sol', effort: 'medium' });
  assert.deepEqual(classExecutor({ policy: { executors: { review: { executor: 'kestrel-planner', model: 'claude-opus-5-5', effort: 'high' } } } }, 'review'),
    { executor: 'claude', agent: 'kestrel-planner', model: 'claude-opus-5-5', effort: 'high' });
});

/** a sandboxed project (fake review executor) + a lane worktree; -> { t, pf, state, wt, env, plan } */
function project(tag, { critique = 'on', canned } = {}) {
  const t = mkTmp(`meta-critique-${tag}-`), wt = path.join(t, 'wt'), state = path.join(t, 'state', 'kestrel'), pf = path.join(t, 'project.json');
  fs.mkdirSync(wt, { recursive: true }); fs.mkdirSync(path.join(t, 'plans'), { recursive: true });
  const filter = path.join(t, 'filter.txt'); fs.writeFileSync(filter, 'MEATY FILTER: real problems only.\n');
  fs.writeFileSync(pf, JSON.stringify({ schema: 1, name: 'kestrel', title: 'k', root: fwd(wt), ledger: '${root}/L.md', briefs_dir: '${root}',
    policy: { dod: { critique, critique_filter: fwd(filter) }, slop: { enabled: false }, executors: { review: { executor: 'fake', model: '', effort: '' } } } }));
  const env = { ...process.env, META_ROOT: t, HOME: t, USERPROFILE: t, META_HB_MS: '150', META_FILL_SAMPLE: '{"free_gb":64,"cpu_pct":0}' };   // the resource gate is not under test: a busy box (CPU > 90 %, a full suite) held the review queued (MAIL-98)
  if (canned) { const f = path.join(t, 'canned.md'); fs.writeFileSync(f, canned); env.FAKE_RO_RESULT = f; }
  return { t, pf, state, wt, env, plan: path.join(t, 'plans', 'PLAN.md') };
}
const norn = (p, args) => spawnSync(process.execPath, [NORN, 'run', '--executor', 'fake', '--project', p.pf, '--state', p.state, '--locks', path.join(p.t, 'locks'),
  '--worktree', p.wt, '--no-tick', ...args], { encoding: 'utf8', env: p.env });
function planRun(p) {
  const bf = path.join(p.t, 'plan-brief.md');
  fs.writeFileSync(bf, 'mode: done\n# plan the water picture (owner DIR-68, DIR-12)\n');
  const r = norn(p, ['--lane', 'water', '--stage', 'PLAN', '--class', 'planning', '--brief', bf, '--notes', p.plan]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return bf;
}

test('a planning run that ends DONE queues ONE read-only review on the policy review executor; its findings sit beside the plan', async () => {
  const p = project('queue', { canned: '- [P1] the bake reads the wrong mask - plan s.2 - read the real one\n- [P2] O(n^2) over reaches - s.4 - index them\n## DONE\n' });
  const bf = planRun(p);
  await waitFor(() => runsOf(p.state).length === 2 && runsOf(p.state).every(settled), { producer: stateBusy(p.state), what: 'the plan run + its review end' });
  const [plan, rev] = runsOf(p.state);
  assert.equal(plan.end.outcome, 'done');
  assert.equal(rev.data.class, 'review'); assert.equal(rev.data.executor, 'fake'); assert.equal(rev.data.stage, 'REVIEW');
  assert.deepEqual(rev.data.critique, { of: plan.id, plan: fwd(p.plan) });
  const files = critiqueFiles(fwd(p.plan));
  assert.equal(fwd(rev.data.notes), files.findings);
  const brief = fs.readFileSync(rev.data.brief, 'utf8');
  for (const s of [fwd(p.plan), fwd(bf), 'DIR-68', 'DIR-12', 'MEATY FILTER: real problems only.', 'No findings.']) assert.ok(brief.includes(s), `review brief names ${s}`);
  assert.equal(rev.end.outcome, 'done');
  assert.match(fs.readFileSync(files.findings, 'utf8'), /^- \[P1\] the bake reads the wrong mask/);
  assert.deepEqual(rev.end.critique, { of: plan.id, plan: fwd(p.plan), file: files.findings, findings: 2 });
  // one review per plan run: asking again is a no-op
  const again = spawnSync(process.execPath, [NORN, 'critique', '--run', plan.id, '--project', p.pf, '--state', p.state, '--no-tick'], { encoding: 'utf8', env: p.env });
  assert.equal(again.status, 0, again.stdout + again.stderr); assert.match(again.stdout, /already reviewed by RUN-2/);
  assert.equal(runsOf(p.state).length, 2);
});

test('policy.dod.critique off: a planning run ends DONE and nothing is queued', async () => {
  const p = project('off', { critique: 'off' });
  planRun(p);
  await waitFor(() => runsOf(p.state).length && runsOf(p.state).every(settled), { what: 'the plan run ends' });
  assert.equal(runsOf(p.state).length, 1);
});

test('a build whose brief names the plan waits for the review; findings hold it for the check-in, whose review releases it; the digest shows them', async () => {
  const p = project('hold', { canned: '- [P1] the gate samples a lake as a bank - s.3 - sample the bank\n## DONE\n' });
  planRun(p);
  await waitFor(() => runsOf(p.state).length === 2 && runsOf(p.state).every(settled), { producer: stateBusy(p.state), what: 'the plan run + its review end' });
  const bb = path.join(p.t, 'build-brief.md');
  fs.writeFileSync(bb, `mode: done\nbuild what ${fwd(p.plan)} says\n`);
  const b = norn(p, ['--lane', 'water', '--stage', 'BUILD', '--brief', bb, '--notes', path.join(p.t, 'BUILD-NOTES.md')]);
  assert.equal(b.status, 0, b.stdout + b.stderr);
  assert.match(b.stdout, /^QUEUED RUN-3 /m); assert.match(b.stdout, /^WAITS RUN-3 for the plan review RUN-2 /m);
  const q = loadState(p.state).items['RUN-3'];
  assert.equal(q.state, 'queued'); assert.deepEqual(q.data.after, [{ kind: 'run', id: 'RUN-2', state: 'reviewed' }]);
  const d = digest(p.state, { name: 'kestrel' }), row = d.sections.critique?.[0];
  assert.ok(row, 'the digest lists the review');
  assert.deepEqual([row.id, row.of, row.findings, row.holds], ['RUN-2', 'RUN-1', 1, ['RUN-3']]);
  assert.match(renderDigest(d), /RUN-2 review of RUN-1 \(.*PLAN\.md\): 1 finding in .*PLAN-CRITIQUE\.md; holds RUN-3/);
  record(p.state, { kind: 'run', ev: 'review', id: 'RUN-2', by: 'checkin', data: { refs: ['RUN-2'], why: 'P1 folded into the build brief' } });
  assert.equal(makeEval(p.state)(parseAfter('run:RUN-2:reviewed')[0]).met, true, 'the check-in review releases the build');
});

test('a clean review (No findings.) releases the build by itself; a brief that names no plan never waits', async () => {
  const p = project('clean', { canned: 'No findings.\n## DONE\n' });
  planRun(p);
  await waitFor(() => runsOf(p.state).length === 2 && runsOf(p.state).every(settled), { producer: stateBusy(p.state), what: 'the plan run + its review end' });
  assert.equal(runsOf(p.state)[1].end.critique.findings, 0);
  assert.equal(makeEval(p.state)(parseAfter('run:RUN-2:reviewed')[0]).met, true);
  assert.equal(digest(p.state, { name: 'kestrel' }).sections.critique, undefined, 'nothing for the check-in');
  const bb = path.join(p.t, 'build-brief.md');
  fs.writeFileSync(bb, `mode: done\nbuild what ${fwd(p.plan)} says\n`);
  const b = norn(p, ['--lane', 'water', '--stage', 'BUILD', '--brief', bb, '--notes', path.join(p.t, 'BUILD-NOTES.md')]);
  assert.match(b.stdout, /^STARTED RUN-3 /m, b.stdout + b.stderr);
  assert.equal(loadState(p.state).items['RUN-3'].data.after, undefined);
  await waitFor(() => settled(loadState(p.state).items['RUN-3']), { producer: supervisorAlive(p.state, () => loadState(p.state).items['RUN-3']), what: 'RUN-3 (the build) ends' });
});

test('Agents: the plan row shows its review (queued / running / reviewed ✓ (n findings))', () => {
  const now = Date.now(), at = new Date(now - 60000).toISOString();
  const run = (id, state, data, end) => ({ id, kind: 'run', state, created: at, updated: at, data: { lane: 'water', executor: 'fake', ...data }, ...(end ? { end } : {}), history: [] });
  const runs = [run('RUN-1', 'exited', { class: 'planning' }, { outcome: 'done' }),
    run('RUN-2', 'exited', { class: 'review', critique: { of: 'RUN-1', plan: '/p/PLAN.md' } }, { outcome: 'done', critique: { of: 'RUN-1', plan: '/p/PLAN.md', file: '/p/PLAN-CRITIQUE.md', findings: 2 } }),
    run('RUN-3', 'exited', { class: 'planning' }, { outcome: 'done' }),
    run('RUN-4', 'running', { class: 'review', critique: { of: 'RUN-3', plan: '/p/B.md' } })];
  const tree = agentsTree(runs, { now });
  assert.deepEqual(tree.find(n => n.id === 'RUN-1').critique, { run: 'RUN-2', state: 'exited', outcome: 'done', findings: 2, file: '/p/PLAN-CRITIQUE.md' });
  const html = renderTab('runs', { tree }, { now, projects: [] });
  assert.match(html, /reviewed ✓ \(2 findings\)/);
  assert.match(html, /review running/);
});

test('Map: the plan run node carries its review; its sub line says reviewed ✓ (n findings)', () => {
  const at = new Date(Date.now() - 60000).toISOString();
  const run = (id, state, data, end) => ({ id, kind: 'run', state, created: at, updated: at, data: { lane: 'water', executor: 'fake', ...data }, ...(end ? { end } : {}), history: [] });
  const items = { 'L:water': { id: 'L:water', kind: 'lane', state: 'active', data: { name: 'water' }, history: [] },
    'RUN-1': run('RUN-1', 'exited', { class: 'planning' }, { outcome: 'done' }),
    'RUN-2': run('RUN-2', 'exited', { lane: 'review', class: 'review', critique: { of: 'RUN-1', plan: '/p/PLAN.md' } }, { outcome: 'done', critique: { of: 'RUN-1', plan: '/p/PLAN.md', file: '/p/PLAN-CRITIQUE.md', findings: 1 } }) };
  const m = mapGraph({ items });
  assert.deepEqual(m.nodes.find(n => n.id === 'RUN-1').critique, { run: 'RUN-2', state: 'exited', outcome: 'done', findings: 1, file: '/p/PLAN-CRITIQUE.md' });
  const html = renderTab('map', { project: 'kestrel', ...m }, { project: 'kestrel' });
  assert.match(html, /RUN-1 · reviewed ✓ \(1 finding\)/);
});
