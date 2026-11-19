// RM-34: a lane's driver (lib/purpose.mjs) from real record shapes - lines copied from state/solve-shack and state/norn into
// tests/fixtures/purpose (free text cut to its first line, machine paths made generic); brief-heads.json = the first heading of
// each brief those runs ran. Read-only fixtures: no temp dir, no process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadState, readEvents } from '../engine/lib/records.mjs';
import { foldRoadmap, loadRoadmap } from '../engine/lib/roadmap.mjs';
import { laneDriver, laneBriefFiles, briefObjective, NO_DRIVER, laneType, laneOutput, ccType, LANE_TYPES } from '../engine/lib/purpose.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'purpose');
function project(name) {
  const dir = path.join(FIX, name), heads = JSON.parse(fs.readFileSync(path.join(dir, 'brief-heads.json'), 'utf8'));
  return { dir, items: loadState(dir).items, roadmap: loadRoadmap(dir), briefTitle: f => heads[String(f).split(/[\\/]/).pop()] ?? null, briefsDir: `C:\\state\\${name}\\briefs`, project: name };
}
const kinds = d => d.sources.map(s => `${s.kind}:${s.id}`);

test('solve-shack run-efficiency: RM-33 (its run carries the item) + its S1 brief; the MERGE briefs are not the objective', () => {
  const d = laneDriver('run-efficiency', project('solve-shack'));
  assert.deepEqual(kinds(d), ['rm:RM-33', 'brief:task-run-efficiency-S1-resume-brief.md']);
  assert.equal(d.objective, 'Run efficiency: load balance, core use and cost from solve.out');
  assert.equal(d.finding, null);
  assert.equal(d.sources[0].href, '?project=solve-shack&tab=roadmap#rm-RM-33');
  assert.equal(d.sources[1].title, '"Was this run well run?": load balance, core use and cost from solve.out, on the Results tab');
  assert.equal(d.sources[1].doc, 'brief:task-run-efficiency-S1-resume-brief.md');
  assert.match(d.sources[1].href, /tab=docs&doc=brief%3Atask-run-efficiency-S1-resume-brief\.md$/);
  assert.ok(!laneBriefFiles('run-efficiency', project('solve-shack').items).some(f => /MERGE/.test(f)), 'MERGE / MERGE2 briefs are landing work');
});

test('solve-shack queue-watchdog: the owner lane - RM-34 from its runs, DIR-26 (scoped to the lane), its S1 brief; Q/DEC are not listed when an item drives it', () => {
  const d = laneDriver('queue-watchdog', project('solve-shack'));
  assert.deepEqual(kinds(d), ['rm:RM-34', 'dir:DIR-26', 'brief:task-queue-watchdog-S1-brief.md']);
  assert.match(d.objective, /^Queue watchdog: requeue a job that waits too long for nodes/);
  assert.equal(d.sources[1].title.startsWith('Queue watchdog'), true, 'the directive heading loses its "## 7." markdown');
  assert.equal(d.sources[1].href, '?project=solve-shack&tab=records');
});

test('solve-shack docs-fixer-2 as the check-in created it (before RM-26 linked it): no runs, no link, no directive -> the finding', () => {
  const p = project('solve-shack'), lane = p.items['L:docs-fixer-2'];
  const before = foldRoadmap(readEvents(path.join(p.dir, 'roadmap.jsonl')).filter(e => e.seq < 48));   // seq 48 = its lane: link
  const d = laneDriver('docs-fixer-2', { ...p, roadmap: before });
  assert.deepEqual(d, { objective: null, sources: [], finding: NO_DRIVER });
  assert.equal(lane.by, 'checkin');
  assert.deepEqual(kinds(laneDriver('docs-fixer-2', p)), ['rm:RM-26'], 'today the records link it to RM-26');
});

test('norn capacity-ux (records before RM-21 linked the lane): the brief only - its heading is the objective', () => {
  const d = laneDriver('capacity-ux', project('norn'));
  assert.deepEqual(kinds(d), ['brief:task-capacity-ux-plan-brief.md']);
  assert.equal(d.objective, '"how much can Norn run, what is using it, why is this waiting" visible where work is shown, and adjustable there');
});

test('norn lane-purpose: RM-34 from the run link and the brief heading (once), the docs of the item', () => {
  const p = project('norn'), d = laneDriver('lane-purpose', p);
  assert.deepEqual(kinds(d), ['rm:RM-34', 'brief:task-lane-purpose-S1-brief.md']);
  assert.equal(d.objective, 'Every lane says why it exists: its objective and where it is written; runs name their lane');
  // the item's create events only (no run: link): the brief heading alone names it
  const rm = foldRoadmap(readEvents(path.join(p.dir, 'roadmap.jsonl')).filter(e => e.ev === 'create'));
  assert.deepEqual(kinds(laneDriver('lane-purpose', { ...p, roadmap: rm })), ['rm:RM-34', 'brief:task-lane-purpose-S1-brief.md']);
  // an item's doc: link is a source (the Docs viewer); a dropped item drives nothing
  rm.items['RM-34'].links.push('doc:norn/docs/lanes.md');
  assert.deepEqual(laneDriver('lane-purpose', { ...p, roadmap: rm }).sources.at(-1), { kind: 'doc', id: 'norn/docs/lanes.md', title: 'lanes.md', href: '?project=norn&tab=docs&doc=doc%3Anorn%2Fdocs%2Flanes.md', doc: 'doc:norn/docs/lanes.md' });
  rm.items['RM-34'].state = 'dropped';
  assert.deepEqual(kinds(laneDriver('lane-purpose', { ...p, roadmap: rm })), ['brief:task-lane-purpose-S1-brief.md']);
});

test('a lane with only questions and decisions: the open question, then the decisions; a superseded directive gives way', () => {
  const items = {
    'L:x': { id: 'L:x', kind: 'lane', state: 'active', data: { name: 'x' }, history: [] },
    'Q-1': { id: 'Q-1', kind: 'question', state: 'open', data: { lane: 'x', title: 'Which layout?' } },
    'Q-2': { id: 'Q-2', kind: 'question', state: 'answered', data: { lane: 'x', title: 'old' } },
    'DEC-4': { id: 'DEC-4', kind: 'decision', state: 'in-force', data: { lane: 'x', question: 'Ship it behind a flag?' } },
  };
  assert.deepEqual(kinds(laneDriver('x', { items })), ['q:Q-1', 'dec:DEC-4']);
  assert.equal(laneDriver('x', { items }).objective, 'Which layout?');
  items['DIR-1'] = { id: 'DIR-1', kind: 'directive', state: 'superseded', superseded_by: 'DIR-2', data: { text: 'old ask', scope: ['x'] } };
  items['DIR-2'] = { id: 'DIR-2', kind: 'directive', state: 'active', data: { text: '## 3. **New** ask\nmore', scope: ['x'] } };
  assert.deepEqual(laneDriver('x', { items }), { objective: 'New ask', sources: [{ kind: 'dir', id: 'DIR-2', title: 'New ask', href: '?project=&tab=records' }], finding: null });
});

test('briefObjective: the words after "task <lane> <stage> -", a bare heading as it is', () => {
  assert.equal(briefObjective('# task rm7 S1 (RM-7) - land a lane as a PR'), 'land a lane as a PR');
  assert.equal(briefObjective('# reader-gaps'), 'reader-gaps');
});

// MAIL-29: the lane's type (the current stage's) and its output, on the real run lines of state/norn (tests/fixtures/purpose/norn)
const run = (id, ev, data, state) => ({ id, kind: 'run', state, data: { kind: 'worker', ...data }, history: [{ ev }] });
test('lane type on real shapes: dwarves = design, norn-bugs-1118 = bug fix, ci-fix4 = CI fix, lane-purpose = build; the tooltip names the signal', () => {
  const p = project('norn'), t = n => laneType(n, p);
  assert.deepEqual(t('dwarves'), { type: 'design', signal: 'RUN-67: agent planner', now: null });
  assert.deepEqual(t('norn-bugs-1118'), { type: 'bug fix', signal: 'brief task-norn-bugs-1118-RESUME-brief.md: "bugs"', now: null }, 'the brief names the bugs (its newest run, S1)');
  assert.deepEqual(t('ci-fix4'), { type: 'CI fix', signal: 'RUN-46: stage red-main', now: null });
  assert.deepEqual(t('lane-purpose'), { type: 'build', signal: 'RUN-123: stage S1', now: null }, 'no word in the brief or RM-34: the build stage');
  assert.deepEqual(laneType('lane-purpose', { ...p, commits: ['feat(lanes): laneDriver derives ...', 'feat(dash): Lanes rows ...', 'fix(dash): x', 'Merge pull request #17'] }),
    { type: 'build', signal: 'commits: build 2, bug fix 1', now: null }, 'the branch tips\' commit types come before the stage');
  assert.equal(laneType('checkin', p).type, 'check-in');
  assert.deepEqual(laneType('seabed', p), { type: null, signal: 'no run yet', now: null });
  for (const n of ['dwarves', 'norn-bugs-1118', 'ci-fix4', 'lane-purpose']) assert.ok(LANE_TYPES.includes(t(n).type), n);
});

test('lane type follows the stage: capacity-ux reads design while it plans, build once S1 starts; a MERGE in flight is shown, not the type', () => {
  const p = project('norn');
  assert.deepEqual(laneType('capacity-ux', p), { type: 'design', signal: 'RUN-52: stage plan', now: null });
  const items = { ...p.items, 'RUN-140': run('RUN-140', 'start', { lane: 'capacity-ux', stage: 'S1', brief: 'C:\\state\\norn\\briefs\\task-capacity-ux-S1-brief.md' }, 'exited') };
  assert.deepEqual(laneType('capacity-ux', { ...p, items }), { type: 'build', signal: 'RUN-140: stage S1', now: null });
  items['RUN-141'] = run('RUN-141', 'queue', { lane: 'capacity-ux', stage: 'MERGE', brief: 'C:\\state\\norn\\briefs\\task-capacity-ux-MERGE-brief.md' }, 'queued');
  assert.deepEqual(laneType('capacity-ux', { ...p, items }), { type: 'build', signal: 'RUN-140: stage S1', now: 'MERGE' });
  items['RUN-141'] = { ...items['RUN-141'], state: 'exited' };
  assert.equal(laneType('capacity-ux', { ...p, items }).now, null, 'a finished MERGE is no longer what the lane does now');
});

test('lane type from the roadmap: the item\'s words, then its theme\'s; a word in the brief comes first', () => {
  const p = project('norn'), rm = structuredClone(p.roadmap);
  rm.items['RM-34'].title = 'Remove the legacy run watcher';
  assert.deepEqual(laneType('lane-purpose', { ...p, roadmap: rm }), { type: 'refactor', signal: 'RM-34: "legacy"', now: null });
  rm.items['RM-34'].title = 'Every lane says why it exists'; rm.items['RM-2'] = { id: 'RM-2', kind: 'theme', title: 'SloppaChoppa catches tech debt', links: [], state: 'open' }; rm.items['RM-34'].parent = 'RM-2';
  assert.deepEqual(laneType('lane-purpose', { ...p, roadmap: rm }), { type: 'refactor', signal: 'RM-34\'s theme RM-2: "tech debt"', now: null });
  assert.equal(laneType('norn-bugs-1118', { ...p, roadmap: rm }).type, 'bug fix');
  assert.equal(ccType('fix(queue): x'), 'fix'); assert.equal(ccType('feat!: y'), 'feat'); assert.equal(ccType('Merge pull request #17'), null);
});

test('lane output: code -> a PR to the repo and its state (no PR yet / PR #n open / merged); a design lane -> its notes, not in git', () => {
  const row = (id, state, pr) => ({ id, state, repo: 'C:/Users/x/Documents/Github/norn-public', lane: 'lane-purpose', pr });
  assert.deepEqual(laneOutput('build', { deliverables: [] }), { kind: 'code', text: 'code → PR to the repo · no PR yet', href: null });
  assert.deepEqual(laneOutput('build', { deliverables: [row('DLV-20', 'done', null)] }), { kind: 'code', text: 'code → PR to norn-public · no PR yet', href: null });
  assert.deepEqual(laneOutput('build', { deliverables: [row('DLV-3', 'merged', null), row('DLV-20', 'done', { url: 'https://github.com/lombasto/norn/pull/18', number: 18 })] }),
    { kind: 'code', text: 'code → PR to lombasto/norn · PR #18 open', href: 'https://github.com/lombasto/norn/pull/18' }, 'the newest deliverable');
  assert.equal(laneOutput('bug fix', { deliverables: [row('DLV-20', 'merged', { url: 'https://github.com/lombasto/norn/pull/18', number: 18 })] }).text, 'code → PR to lombasto/norn · merged');
  assert.deepEqual(laneOutput('design', { notes: 'state/norn/notes/dwarves/' }),
    { kind: 'documents', text: 'documents → state/norn/notes/dwarves/ (not in git; backed up only if the ledger is on)', href: null });
  assert.equal(laneOutput('check-in', {}), null);
  assert.equal(laneOutput(null, {}), null);
});
