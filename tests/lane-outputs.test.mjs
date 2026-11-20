// lane-outputs: a lane's notes folder as its output (laneout.mjs) - the files listed and grouped with the run that wrote each, the
// path guard (no ../ escape), the owner summary taken verbatim, every owner ask a NOTES / plan text makes (one fixture per heading
// form), the CLI's background cut-off line, the lane state after its last run; runasks.mjs posts the asks as Inbox questions at a
// run's end whatever its exit (no duplicates), the tick's sweep, and an answered ruling written into its stage brief.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { groupOf, groupOutputs, walkOutputs, writerOf, insideDir, ownerSummary, summaryLine, ownerAsks, cutoffOf, laneNext, laneNow, lanePrs, stageWhere, notesDirOf } from '../engine/lib/laneout.mjs';
import { postRunAsks, sweepAsks, applyRulings, askedAlready } from '../engine/lib/runasks.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { laneDetail, fileViewer } from '../engine/dash/pages/lanes.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const NOTES = `# audit / plan (RUN-1)

Design run.

## Summary for the owner

1. The **Lanes** page hides what a lane wrote.
2. | a | b |
   |---|---|

## Open for the owner

- S1: where the outputs list lives. Default: the lane's details. Alternative: a Docs sub-view.
- Whether to keep the old chip (recommended: drop it).

## DONE
`;

// ---------- the files ----------
test('groupOf: images anywhere, brief-*.md at the top = stage briefs, other top-level .md = the report, the rest data', () => {
  assert.equal(groupOf('AUDIT.md'), 'report'); assert.equal(groupOf('NOTES.md'), 'report'); assert.equal(groupOf('MERGE-NOTES.md'), 'report');
  assert.equal(groupOf('brief-S1.md'), 'briefs'); assert.equal(groupOf('brief-worker-gil.md'), 'briefs');
  assert.equal(groupOf('shots/home-phone.png'), 'images'); assert.equal(groupOf('a.JPG'), 'images');
  assert.equal(groupOf('data/raw.json'), 'data'); assert.equal(groupOf('walk.json'), 'data'); assert.equal(groupOf('data/notes.md'), 'data');
});

test('walkOutputs + groupOutputs: every file with size, time and the run whose window holds its time; groups in order, the plan before NOTES', async () => {
  const dir = path.join(mkTmp('laneout'), 'notes', 'audit');
  for (const [f, t] of [['NOTES.md', 'n'], ['AUDIT.md', 'plan'], ['brief-S2.md', 'b2'], ['brief-S1.md', 'b1'], ['shots/a.png', 'png'], ['data/raw.csv', '1,2']]) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t);
  }
  const old = new Date('2026-11-01T10:30:00Z');
  fs.utimesSync(path.join(dir, 'shots/a.png'), old, old);
  const files = await walkOutputs(dir);
  assert.equal(files.length, 6);
  assert.equal(files.find(f => f.rel === 'data/raw.csv').size, 3);
  const runs = [{ id: 'RUN-1', created: '2026-11-01T10:00:00Z', history: [{ ev: 'end', ts: '2026-11-01T11:00:00Z' }] }, { id: 'RUN-2', created: new Date(Date.now() - 60e3).toISOString(), history: [] }];
  const g = groupOutputs(files, runs);
  assert.deepEqual(g.map(x => x.group), ['report', 'briefs', 'images', 'data']);
  assert.deepEqual(g[0].files.map(f => f.rel), ['AUDIT.md', 'NOTES.md']);
  assert.deepEqual(g[1].files.map(f => f.rel), ['brief-S1.md', 'brief-S2.md']);
  assert.equal(g[2].files[0].run, 'RUN-1', 'written in RUN-1\'s window');
  assert.equal(g[0].files[0].run, 'RUN-2', 'written now: the running RUN-2');
  assert.equal(writerOf('2026-10-01T00:00:00Z', runs), null, 'before any run');
  assert.deepEqual(await walkOutputs(path.join(dir, 'missing')), []);
});

test('the path guard: a file inside the notes folder resolves; ../, an absolute path and a drive never do', () => {
  const dir = path.join(mkTmp('laneout'), 'notes', 'audit');
  assert.equal(insideDir(dir, 'shots/a.png'), path.join(dir, 'shots', 'a.png'));
  for (const bad of ['../x.md', '../../state/records.jsonl', 'shots/../../x', path.resolve('/etc/passwd'), 'C:/Windows/win.ini', '', '.']) assert.equal(insideDir(dir, bad), null, bad);
});

test('notesDirOf: the newest run\'s NOTES folder, else <state>/notes/<lane>', () => {
  const items = { 'RUN-3': { id: 'RUN-3', kind: 'run', data: { lane: 'a', notes: '/x/notes/a-S2/NOTES.md' } }, 'RUN-9': { id: 'RUN-9', kind: 'run', data: { lane: 'a', notes: '/x/notes/a/NOTES.md' } } };
  assert.equal(notesDirOf('/s', 'a', items), path.resolve('/x/notes/a'));
  assert.equal(notesDirOf('/s', 'b', items), path.resolve('/s/notes/b'));
});

// ---------- the summary ----------
test('ownerSummary: the LAST "Summary for the owner" / "For the owner" section, verbatim (markdown kept); never "Open for the owner"', () => {
  const s = ownerSummary(NOTES);
  assert.equal(s.heading, 'Summary for the owner');
  assert.equal(s.text, '1. The **Lanes** page hides what a lane wrote.\n2. | a | b |\n   |---|---|');
  assert.equal(ownerSummary('# x\n## For the owner, in ten lines\n- one\n## Next\n').text, '- one');
  assert.equal(ownerSummary('# x\n## Summary for the owner\nold\n## RUN 2\n### Summary for the owner (10 lines)\nnew\n').text, 'new', 'the newest run\'s');
  assert.equal(ownerSummary('# x\n## Open for the owner\n- a\n'), null);
  assert.equal(summaryLine(NOTES), '|---|---|', 'its last non-empty line');
});

// ---------- the asks: one fixture per heading form ----------
const asks = t => ownerAsks(t).map(a => ({ kind: a.kind, words: a.words, default: a.default, briefs: a.briefs, options: a.options?.map(o => `${o.key}${o.rec ? '*' : ''}`) }));
test('an "Open for the owner" section: each item one ask, its default and alternatives, its stage', () => {
  const xs = ownerAsks(NOTES);
  assert.equal(xs.length, 2);
  assert.deepEqual([xs[0].words, xs[0].default, xs[0].alts, xs[0].stage], ['S1: where the outputs list lives', "the lane's details", ['a Docs sub-view'], 'S1']);
  assert.equal(xs[1].default, 'drop it');
});
test('"Decisions for you", "your rulings", "owner to decide", "Questions for the owner" headings; a section with no list = one ask', () => {
  assert.deepEqual(asks('# n\n## Decisions for you\n\n- Run the calibration or not.\n- Keep the headline as is? Default: yes.\n').map(a => [a.words, a.default ?? null]), [['Run the calibration or not', null], ['Keep the headline as is?', 'yes']]);
  assert.equal(asks('# n\n## Your rulings\n1. Pick the order of the briefs\n').length, 1);
  assert.deepEqual(asks('# n\n## Owner to decide\nWhether the cache is kept across restarts.\n').map(a => a.words), ['Whether the cache is kept across restarts']);
  assert.equal(asks('# n\n## Questions for the owner\n- a thing to pick\n').length, 1);
  assert.deepEqual(asks('# n\n### Classify (code, then owner rulings)\n- keep in W\n- move to B\n'), [], 'an aside naming rulings is no ask');
  assert.deepEqual(asks('# n\n## Owner rulings (binding)\n- Read OWNER-RULINGS.md first\n## Owner ruling (Q-12)\nS1: x\n'), [], 'rulings already given');
});
test('a STOPPED heading is an ask while it is the last outcome heading; a later DONE answers it', () => {
  const stopped = '# worker-gil\n## Tests\n- ok\n## STOPPED: step 3 measured as a regression; reverted, owner to decide\nkeep it reverted or try a smaller read?\n';
  assert.deepEqual(asks(stopped).map(a => a.kind), ['stopped']);
  assert.match(ownerAsks(stopped)[0].text, /^step 3 measured as a regression; reverted, owner to decide keep it reverted/);
  assert.deepEqual(asks(stopped + '## RUN (finish)\n- DEC-28: dropped\n## DONE\n'), []);
});
test('a "not queued" brief list: a lead-in line, a list item and a heading', () => {
  assert.deepEqual(asks('# p\n## Summary for the owner\n8. Ranked briefs, not queued: `brief-a.md`, `brief-b.md`.\n').map(a => [a.kind, a.briefs]), [['not-queued', ['brief-a.md', 'brief-b.md']]]);
  assert.deepEqual(asks('# p\n## Not queued\n- brief-x.md: the fast path\n- brief-y.md\n').map(a => a.briefs), [['brief-x.md', 'brief-y.md']]);
});
test('a lead-in line before a list ("Owner rulings the briefs wait on (each brief has a default):") and Q-blocks with keyed alternatives', () => {
  const plan = '# UI audit\n## 9. Stages\nOwner rulings the briefs wait on (each brief has a default):\n1. S1: where the landed list lives. Default: a Landed card. Alternative: the Done filter.\n2. **[look]** S3: card subtitles. Default: body font.\n\nMore prose.\n';
  assert.deepEqual(asks(plan).map(a => [a.words, a.default]), [['S1: where the landed list lives', 'a Landed card'], ['[look] S3: card subtitles', 'body font']]);
  const qs = '# tg: owner rulings\n\nEach ruling below.\n\nQ1. **What does a MERGE run test?**\n   - (a) **changed** tests plus smoke. Recommended.\n   - (b) full suite.\n\nQ2. **Where does the suite run?**\n   - (a) nightly\n   - (b) **GitHub Actions** (recommended)\n';
  assert.deepEqual(asks(qs).map(a => [a.words, a.options]), [['What does a MERGE run test?', ['a*', 'b']], ['Where does the suite run?', ['a', 'b*']]]);
});

test('cutoffOf: the CLI\'s "Background tasks still running ... stopping them" line -> the task names', () => {
  assert.deepEqual(cutoffOf('start RUN-296\nBackground tasks still running 10m after the last turn (subagent "Measure test time from run logs"); stopping them. Set X=0 to wait.\nexit=0'), ['Measure test time from run logs']);
  assert.deepEqual(cutoffOf('Background tasks still running 10m after the last turn (subagent "A", shell "B"); stopping them.'), ['A', 'B']);
  assert.equal(cutoffOf('exit=0'), null);
});

// ---------- the lane state ----------
test('laneNext: one state in words after the last run - never a bare DONE', () => {
  assert.equal(laneNext({}), null, 'not ended');
  assert.equal(laneNext({ outcome: 'done', asks: [{ id: 'Q-1' }, { id: 'Q-2' }] }).words, 'needs your input: 2 rulings');
  assert.equal(laneNext({ outcome: 'done', prs: [{ number: 7, state: 'open' }] }).words, 'PR #7 awaiting your approval');
  assert.equal(laneNext({ outcome: 'done', prs: [{ number: 7, state: 'approved' }] }).words, 'awaiting merge: PR #7 approved');
  assert.equal(laneNext({ outcome: 'done', prs: [{ number: 9, state: 'merged', merged_at: '2026-11-19T20:00:00Z' }, { number: 7, state: 'closed' }] }).words, 'shipped: PR #9 merged 2026-11-19');
  assert.equal(laneNext({ outcome: 'done', stages: [{ key: 'S1', state: 'later', ref: 'RM-40', horizon: 'next' }, { key: 'S2', state: 'drop' }] }).words, 'stages on the roadmap (RM-40, horizon next), none queued');
  assert.equal(laneNext({ outcome: 'done', notQueued: ['brief-a.md'] }).words, 'not queued: brief-a.md');
  assert.equal(laneNext({ outcome: 'no-result', written: ['A.md', 'B.md'] }).words, 'ended without a result: 2 files written; review');
  assert.equal(laneNext({ outcome: 'done', deliverable: 'done' }).words, 'awaiting merge: no PR yet');
  assert.equal(laneNext({ outcome: 'done' }).words, 'done: nothing waits on you');
});

test('stageWhere + lanePrs: a stage queued / built / merged / on the roadmap / dropped; every PR of the lane, newest first', () => {
  const items = { 'RUN-5': { id: 'RUN-5', kind: 'run', state: 'queued', data: { lane: 'a' }, history: [] }, 'RUN-6': { id: 'RUN-6', kind: 'run', state: 'exited', end: { outcome: 'done' }, data: { lane: 'a-s2' }, history: [{ ev: 'end', ts: 'x' }] } };
  const R = { items: { 'RM-40': { id: 'RM-40', horizon: 'next' } } };
  assert.equal(stageWhere({ key: 'S1', state: 'queue', ref: 'RUN-5' }, { items }).where, 'queued as RUN-5');
  assert.equal(stageWhere({ key: 'S2', state: 'launched', ref: 'RUN-6' }, { items }).where, 'built (RUN-6)');
  assert.equal(stageWhere({ key: 'S2', state: 'launched', ref: 'RUN-6' }, { items, rows: [{ lane: 'a-s2', state: 'merged', run: 'RUN-6' }] }).where, 'merged (RUN-6)');
  assert.equal(stageWhere({ key: 'S3', state: 'later', ref: 'RM-40' }, { R }).where, 'on the roadmap as RM-40, horizon next');
  assert.equal(stageWhere({ key: 'S4', state: 'drop' }).where, 'dropped');
  const rows = [{ id: 'DLV-1', lane: 'a', branch: 'norn/a', state: 'merged', prs: [{ number: 12, state: 'merged', merged_at: 't' }, { number: 9, state: 'closed' }] }, { id: 'DLV-2', lane: 'a', branch: 'norn/ci-fix', state: 'done', prs: [{ number: 14, url: 'u', state: 'open' }] }, { id: 'DLV-3', lane: 'b', prs: [{ number: 1 }] }];
  assert.deepEqual(lanePrs(rows, 'a').map(p => [p.number, p.state, p.dlv]), [[14, 'open', 'DLV-2'], [12, 'merged', 'DLV-1'], [9, 'closed', 'DLV-1']]);
});

// ---------- the asks reach the Inbox ----------
function laneState({ notes = NOTES, outcome = 'done', end = true } = {}) {
  const root = mkTmp('runasks'), state = path.join(root, 'state'), dir = path.join(state, 'notes', 'audit');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'brief-S1.md'), '# audit / S1: outputs list\n');
  record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'audit', stage: 'plan', agent: 'planner', brief: path.join(state, 'b.md'), notes: path.join(dir, 'NOTES.md') } });
  fs.writeFileSync(path.join(dir, 'NOTES.md'), notes);
  if (end) record(state, { kind: 'run', ev: 'end', id: 'RUN-1', by: 'launcher', data: { exit: 0, outcome } });
  return { root, state, dir };
}
const qs = state => Object.values(loadState(state).items).filter(i => i.kind === 'question');

test('postRunAsks: one question per ask (the default recommended, the notes as origin, the stage brief named); a second post adds none', () => {
  const { state, dir } = laneState();
  const posted = postRunAsks(state, 'RUN-1');
  assert.deepEqual(posted.map(p => p.title), ['audit: S1: where the outputs list lives', 'audit: Whether to keep the old chip (recommended: drop it)']);
  const [q1, q2] = qs(state);
  assert.equal(q1.by, 'launcher');
  assert.deepEqual(q1.data.options.map(o => [o.key, o.text]), [['default', "the lane's details"], ['alt1', 'a Docs sub-view']]);
  assert.equal(q1.data.recommend.key, 'default'); assert.equal(q1.data.recommend.from, 'source');
  assert.deepEqual(q1.data.origin, { file: path.join(dir, 'NOTES.md').replace(/\\/g, '/'), section: 'Open for the owner', line: 13 });
  assert.equal(q1.data.brief, path.join(dir, 'brief-S1.md').replace(/\\/g, '/'));
  assert.equal(q2.data.brief, undefined);
  assert.deepEqual(postRunAsks(state, 'RUN-1'), [], 'no duplicates');
});

test('the asks reach the Inbox whatever the exit: no-result, STOPPED, a lost run swept by the tick; a hand-posted ask is not asked twice', () => {
  const nr = laneState({ outcome: 'no-result' });
  assert.equal(postRunAsks(nr.state, 'RUN-1').length, 2);
  const st = laneState({ notes: '# gil\n## STOPPED: step 3 regressed; reverted, owner to decide\n', outcome: 'stopped' });
  assert.deepEqual(postRunAsks(st.state, 'RUN-1').map(p => p.title), ['audit: stopped - step 3 regressed; reverted, owner to decide']);
  const lost = laneState({ end: false });
  assert.deepEqual(sweepAsks(lost.state), [], 'the first sweep starts the clock');
  record(lost.state, { kind: 'question', ev: 'create', by: 'controller', data: { title: 'Ruling 1 (S1): where does the outputs list live?', lane: 'audit', options: [], blocks: [] } });
  record(lost.state, { kind: 'run', ev: 'lost', id: 'RUN-1', by: 'launcher', data: { why: 'stale heartbeat' } });
  const swept = sweepAsks(lost.state);
  assert.deepEqual(swept.map(x => [x.run, x.posted.map(p => p.title)]), [['RUN-1', ['audit: Whether to keep the old chip (recommended: drop it)']]]);
  assert.deepEqual(sweepAsks(lost.state), [], 'each run once');
  assert.equal(askedAlready(['Q3 tests: per-run test budget and what happens past it'], 'tg: The per-run test budget, and what happens past it', 'tg'), true);
  assert.equal(askedAlready(['Q3 tests: per-run test budget'], 'tg: Where does the suite run?', 'tg'), false);
});

test('a "not queued" list asks which brief to queue (only the briefs no run took); the lane reads "needs your input" then', () => {
  const { state, dir } = laneState({ notes: '# p\n## Summary for the owner\n8. Ranked briefs, not queued: `brief-fast.md`, `brief-S1.md`, `brief-gone.md`.\n' });
  fs.writeFileSync(path.join(dir, 'brief-fast.md'), '# fast\n');
  record(state, { kind: 'run', ev: 'queue', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'audit-s1', stage: 'S1', brief: path.join(dir, 'brief-S1.md') } });
  postRunAsks(state, 'RUN-1');
  const [q] = qs(state);
  assert.deepEqual(q.data.options.map(o => o.text), ['Queue brief-fast.md (ranked first)', 'Queue none of them now']);
  const now = laneNow({ lane: 'audit', items: loadState(state).items, notes: fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf8') });
  assert.equal(now.next.words, 'needs your input: 1 ruling'); assert.deepEqual(now.not_queued, ['brief-fast.md']); assert.equal(now.asks_open, 1);
  assert.equal(now.status_line, '8. Ranked briefs, not queued: `brief-fast.md`, `brief-S1.md`, `brief-gone.md`.'.replace(/^8\. /, ''));
});

test('applyRulings: an answered ask that names a stage brief is written into the brief once', () => {
  const { state, dir } = laneState();
  postRunAsks(state, 'RUN-1');
  const q = qs(state)[0];
  record(state, { kind: 'question', ev: 'answer', id: q.id, by: 'owner', data: { choice: 'alt1', text: 'Rule: (alt1)', via: 'dashboard' } });
  assert.deepEqual(applyRulings(state), [{ q: q.id, brief: path.join(dir, 'brief-S1.md').replace(/\\/g, '/') }]);
  const b = fs.readFileSync(path.join(dir, 'brief-S1.md'), 'utf8');
  assert.match(b, new RegExp(`## Owner ruling \\(${q.id}\\)\naudit: S1: where the outputs list lives\n\n\\(alt1\\) a Docs sub-view\n`));
  assert.deepEqual(applyRulings(state), [], 'once');
  assert.deepEqual(ownerAsks(b), [], 'the written ruling is no new ask');
});

// ---------- the dashboard's parts ----------
test('laneDetail: Findings verbatim first, what happens next, the follow-up, every PR, the grouped Outputs; fileViewer per kind', () => {
  const d = { project: 'p', lane: 'audit', dir: '/s/notes/audit', findings: ownerSummary(NOTES), next: { key: 'input', words: 'needs your input: 2 rulings', cls: 'needs' }, asks_open: 2, status_line: 'last line', cutoff: ['Measure'],
    plan: { run: 'RUN-1', title: 'Decide: audit plan', open: 1, stages: [{ key: 'S1', title: 'outputs', where: 'on the roadmap as RM-40, horizon next', by: 'dashboard', at: '2026-11-19T10:00:00Z' }] },
    asks: [{ id: 'Q-3', title: 'audit: S1', open: false, state: 'answered', answer: { choice: 'default', text: 'details', by: 'owner', at: '2026-11-19T11:00:00Z' } }],
    prs: [{ number: 12, url: 'https://github.com/o/r/pull/12', state: 'merged', merged_at: '2026-11-19T12:00:00Z', dlv: 'DLV-1', branch: 'norn/audit' }],
    outputs: [{ group: 'report', label: 'Report', files: [{ rel: 'AUDIT.md', path: '/s/notes/audit/AUDIT.md', size: 2048, mtime: '2026-11-19T09:00:00Z', run: 'RUN-1' }] }], written: [] };
  const h = laneDetail(d, { project: 'p', now: Date.parse('2026-11-19T13:00:00Z') });
  assert.ok(h.indexOf('id="lane-findings"') < h.indexOf('id="lane-outputs"'));
  assert.match(h, /<strong>Lanes<\/strong>/);
  assert.match(h, /needs your input: 2 rulings/); assert.match(h, /Open decisions: 2/); assert.match(h, /background work cut off: Measure/); assert.match(h, /last line/);
  assert.match(h, /S1<\/b> outputs - on the roadmap as RM-40, horizon next/); assert.match(h, /picked by dashboard/);
  assert.match(h, /answer: \(default\) details - owner/);
  assert.match(h, /href="https:\/\/github.com\/o\/r\/pull\/12"[^>]*>PR #12<\/a> <span class="chip ok">merged<\/span> merged/);
  assert.match(h, /data-act="lane-file" data-path="\/s\/notes\/audit\/AUDIT.md">AUDIT.md<\/button> <span class="mute">2.0 KB · [^·]+ · RUN-1/);
  assert.match(laneDetail(null), /loading/);
  assert.match(fileViewer({ name: 'a.png', path: 'C:/s/a.png', image: true }, { project: 'p' }), /<img class="fileview-img" alt="a.png" src="\/api\/file\?project=p&amp;path=C%3A%2Fs%2Fa.png">/);
  assert.match(fileViewer({ name: 'A.md', path: '/s/A.md', text: '# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nx\n```\n' }), /<h1[^>]*>T<\/h1>[\s\S]*<table>[\s\S]*<code/);
  const src = fileViewer({ name: 'run.sh', path: '/s/run.sh', text: 'echo <a>\nexit', code: 'sh' });
  assert.match(src, /<td class="ln mute">1<\/td><td class="lt"><code>echo &lt;a&gt;<\/code>/); assert.match(src, /<td class="ln mute">2<\/td>/);
  assert.match(fileViewer({ path: '/x', error: 'Outside the allowed roots' }), /not shown/);
});
