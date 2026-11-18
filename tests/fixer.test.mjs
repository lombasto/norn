// META-UX-BUILD S7 (REPORT meta-ux-plan s.3 "End to end" 3-5, DIR-65 Q2 A): the fixer run of a Fix all directive - its plan (one
// bounded batch per approved run, never more than the tap approved), its generated brief, its answer (audit-format hunks + one line
// per finding) and `rec show` printing a long id list as its first ids + a count. Sandbox only (temp dirs, no live state).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixPlan, fixerBrief, fixerPrompt, fixResult, briefIds, briefRows, fixBatch, runsFor } from '../engine/lib/fixer.mjs';
import { withDefaults } from '../engine/lib/policy.mjs';
import { main } from '../engine/bin/norn.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const ids = n => Array.from({ length: n }, (_, i) => `I-c16-${String(i).padStart(3, '0')}`);
function world({ n = 90, runs = 0, decRuns, rest = 0 } = {}) {
  const items = { 'DEC-1': { id: 'DEC-1', kind: 'decision', state: 'in-force', created: '2026-11-17T05:57:00Z', data: { lane: 'fixall', findings: ids(n), ...(decRuns ? { runs: decRuns } : {}) } },
    'DIR-9': { id: 'DIR-9', kind: 'directive', state: 'active', created: '2026-11-17T05:57:01Z', data: { fixall: 'DEC-1', findings: ids(n), text: 'Fix all' } } };
  const briefs = {};
  for (let i = 0; i < runs; i++) {
    const id = `RUN-${i + 1}`, b = `/s/fixer/DIR-9-${i}.brief.md`;
    items[id] = { id, kind: 'run', state: 'ended', created: `2026-11-17T06:0${i}:00Z`, end: { outcome: 'done' }, data: { lane: 'fixall', kind: 'audit', brief: b } };
    briefs[b] = ids(n).slice(i * 40, i * 40 + 40).map(x => `- id: ${x}`).join('\n');
  }
  if (rest) items['DEC-2'] = { id: 'DEC-2', kind: 'decision', state: 'in-force', created: '2026-11-17T07:00:00Z', data: { lane: 'fixall', rest_of: 'DIR-9', runs: rest } };
  return { items, readBrief: r => briefs[r.data.brief] ?? '' };
}

test('the batch lives with the class limits (policy.fixer.batch) and a send of n needs ceil(n / batch) runs', () => {
  assert.equal(fixBatch(withDefaults({}).policy), 40);
  assert.deepEqual([runsFor(1, 40), runsFor(40, 40), runsFor(41, 40), runsFor(302, 40)], [1, 1, 2, 8]);
});

test('plan: no run yet = ONE bounded batch; a directive approved as one run runs ONE batch, then offers the rest as a new tap', () => {
  const w = world(), p0 = fixPlan(w.items['DIR-9'], w.items, { batch: 40, readBrief: w.readBrief });
  assert.deepEqual([p0.approved, p0.next.length, p0.next[0], p0.more], [1, 40, 'I-c16-000', 3], 'a decision without runs approved ONE run (a send made before the runs field)');
  const w1 = world({ runs: 1 }), p1 = fixPlan(w1.items['DIR-9'], w1.items, { batch: 40, readBrief: w1.readBrief });
  assert.equal(p1.next, null, 'never more than the tap approved');
  assert.deepEqual([p1.left.length, p1.more], [50, 2], 'n left: the rest needs m runs');
  const w2 = world({ runs: 1, rest: 2 }), p2 = fixPlan(w2.items['DIR-9'], w2.items, { batch: 40, readBrief: w2.readBrief });
  assert.deepEqual([p2.approved, p2.next[0], p2.next.length], [3, 'I-c16-040', 40], 'the rest tap approves more runs: the next batch starts after the first');
  const w3 = world({ decRuns: 3 }); w3.items['RUN-7'] = { id: 'RUN-7', kind: 'run', state: 'queued', created: '2026-11-17T06:00:00Z', data: { lane: 'fixall', brief: '/s/fixer/DIR-9-x.brief.md' } };
  assert.equal(fixPlan(w3.items['DIR-9'], w3.items, { batch: 40, readBrief: () => '' }).next, null, 'a queued or running fixer run: start nothing');
  const w4 = world(); w4.items['DIR-9'].state = 'done';
  assert.equal(fixPlan(w4.items['DIR-9'], w4.items, { batch: 40 }).next, null, 'a closed directive starts nothing');
});

test('the brief is generated: each id with its file:line, fix sentence, ready patch and picked way; briefIds reads the batch back', () => {
  const rows = [{ id: 'I-1', key: 'instr-c16', path: 'C:\\r\\CLAUDE.md', line: 12, why: 'history in a rule file', action: 'move the history to a dated note' },
    { id: 'T-S-2', key: 'tighten-superseded', path: 'C:/r/AGENTS.md', line: 30, why: 'cites DEC-1', action: 'delete it', patch: '@@ -30,1 +29,0 @@\n-old' },
    { id: 'R-3', key: 'rule-drift-claim', path: 'C:/r/CLAUDE.md', line: 9, why: 'claims', action: 'add or drop' }];
  const b = fixerBrief({ project: 'kestrel', dir: 'DIR-9', dec: 'DEC-1', rows, picks: [{ key: 'rule-drift-claim|call', way: 'Drop the claim' }] });
  assert.match(b, /READ-ONLY/);
  assert.match(b, /- id: I-1\n  file: C:\/r\/CLAUDE\.md:12\n  finding: history in a rule file\n  fix: move the history to a dated note/);
  assert.match(b, /patch \(ready\):\n    @@ -30,1 \+29,0 @@\n    -old/);
  assert.match(b, /- id: R-3[\s\S]*the owner picked: Drop the claim/);
  assert.match(b, /- <id>: drafted` or `- <id>: skipped: <why>/);
  assert.deepEqual(briefIds(b), ['I-1', 'T-S-2', 'R-3']);
});

test('the answer: audit-format hunks + one line per finding; no parsable hunk = failed', () => {
  const text = ['### `CLAUDE.md:12` - medium - rewrite', '```diff', '--- a/CLAUDE.md', '+++ b/CLAUDE.md', '@@ -11,3 +11,3 @@', ' a', '-history 2026-10', '+See notes/history.md.', ' z', '```',
    '### `AGENTS.md:30` - medium - remove', '```diff', '--- a/AGENTS.md', '+++ b/AGENTS.md', '@@ -29,2 +29,1 @@', ' a', '-cites DEC-1', '```',
    '## Findings', '- I-1: drafted', '- `T-S-2`: drafted', '- R-3: skipped: no way picked'].join('\n');
  const files = { 'CLAUDE.md': 'a\n'.repeat(10) + 'a\nhistory 2026-10\nz\n', 'AGENTS.md': 'a\n'.repeat(29) + 'cites DEC-1\n' };
  const r = fixResult(text, ['I-1', 'T-S-2', 'R-3', 'X-4'], { readFile: f => files[f] ?? null });
  assert.equal(r.failed, false);
  assert.deepEqual(r.hunks.map(h => [h.file, h.line, h.applies]), [['CLAUDE.md', 11, true], ['AGENTS.md', 29, true]]);
  assert.match(r.hunks[0].id, /^[0-9a-f]{12}$/);
  assert.deepEqual(r.status.map(s => [s.id, s.state, s.why]), [['I-1', 'drafted', null], ['T-S-2', 'drafted', null], ['R-3', 'skipped', 'no way picked'], ['X-4', 'missing', null]]);
  assert.equal(fixResult('I could not read the files.', ['I-1']).failed, true);
});

test('rec show: a long id list prints as its first ids + a count; --full prints all', () => {
  const state = mkTmp('fixer-show-'), env = { META_STATE: state, META_ROLE: 'owner' }, o = [], e = [];
  const run = argv => main(argv, env, s => o.push(s), s => e.push(s));
  assert.equal(run(['rec', 'add', 'directive', '--text', 'Fix all '.padEnd(1200, 'x'), '--via', 'cli']), 0, e.join('\n'));
  const id = o.join('\n').match(/DIR-\d+/)[0], ev = fs.readdirSync(state).map(f => path.join(state, f)).find(f => /\.jsonl$/.test(f) && fs.readFileSync(f, 'utf8').includes(id));
  const lines = fs.readFileSync(ev, 'utf8').trim().split('\n'), first = JSON.parse(lines[0]);
  first.data.findings = ids(302); fs.writeFileSync(ev, [JSON.stringify(first), ...lines.slice(1)].join('\n') + '\n');
  o.length = 0; assert.equal(run(['rec', 'show', id]), 0, e.join('\n'));
  const short = o.join('\n');
  assert.match(short, /"I-c16-004","\+297 more \(--full prints all\)"/);
  assert.ok(!short.includes('I-c16-005'));
  assert.match(short, /\(\+\d+ chars, --full prints all\)/);
  o.length = 0; assert.equal(run(['rec', 'show', id, '--full']), 0);
  assert.ok(o.join('\n').includes('I-c16-301'));
  const full = o.join('\n');
  assert.ok(short.length * 4 < full.length, `the short show is a fraction of the full one (${short.length} vs ${full.length})`);
});

// ---- the start by code: the findings file the dash keeps, the tick's spawn, `norn fix start`; the result card ----
import { keepFindings, findingsFile, tickFix, fixCards, verdictText, verdictIds } from '../engine/lib/fixer.mjs';
import { record } from '../engine/lib/records.mjs';

const tmp = p => mkTmp(p);
const guardRow = (id, extra = {}) => ({ id, type: 'instructions', kind: 'drafts', batch: 'instr-c16|drafts', path: 'C:/r/CLAUDE.md', line: 3, why: `why ${id}`, action: 'move it', ...extra });

test('keepFindings: the rows of an active fixall directive, once; nothing for a directive without fixall', () => {
  const state = tmp('fixer-keep-'), w = world({ n: 3 });
  w.items['DIR-5'] = { id: 'DIR-5', kind: 'directive', state: 'active', data: { text: 'plain' } };
  const rows = [guardRow('I-c16-000'), guardRow('I-c16-001', { patch: '@@ -1 +1 @@\n-a\n+b' }), guardRow('I-c16-002', { patch: true }), guardRow('OTHER')];
  assert.deepEqual(keepFindings(state, w.items, rows), ['DIR-9']);
  const kept = JSON.parse(fs.readFileSync(findingsFile(state, 'DIR-9'), 'utf8')).rows;
  assert.deepEqual(kept.map(r => [r.id, r.key, r.line, r.patch ?? null]), [['I-c16-000', 'instr-c16|drafts', 3, null], ['I-c16-001', 'instr-c16|drafts', 3, '@@ -1 +1 @@\n-a\n+b'], ['I-c16-002', 'instr-c16|drafts', 3, null]]);
  assert.deepEqual(keepFindings(state, w.items, rows), [], 'written once');
});

test('tickFix: one detached `norn fix start DIR-n --queue` per directive with a next batch and a findings file; a start stamp stops a second', () => {
  const state = tmp('fixer-tick-'), w = world({ n: 3 }), calls = [], spawnFn = (exe, args) => { calls.push(args); return { pid: 7 }; };
  const p = { name: 'kestrel', file: 'C:/x/kestrel.json' };
  assert.deepEqual(tickFix(p, state, { metaCmd: 'norn.mjs', items: w.items, spawnFn }), [], 'no findings file yet: nothing');
  keepFindings(state, w.items, [guardRow('I-c16-000')]);
  assert.equal(tickFix(p, state, { metaCmd: 'norn.mjs', items: w.items, spawnFn }).length, 1);
  assert.deepEqual(calls[0], ['norn.mjs', 'fix', 'start', 'DIR-9', '--queue', '--project', 'C:/x/kestrel.json', '--state', state]);
  assert.equal(tickFix(p, state, { metaCmd: 'norn.mjs', items: w.items, spawnFn }).length, 0, 'the stamp: no second spawn within 5 minutes');
  assert.equal(tickFix(p, state, { metaCmd: 'norn.mjs', items: w.items, spawnFn, now: Date.now() + 6 * 60000 }).length, 1);
  const w1 = world({ n: 3, runs: 1 });
  assert.equal(tickFix(p, tmp('fixer-tick2-'), { metaCmd: 'm', items: w1.items, spawnFn }).length, 0, 'the approved run ran: nothing more');
});

test('tickFix: another directive\'s fixer queued or running holds the lane: no doomed start (no orphan brief), a wait line; it starts once that run ended', () => {
  const state = tmp('fixer-tick3-'), w = world({ n: 3 }), calls = [], spawnFn = (exe, args) => { calls.push(args); return { pid: 7 }; };
  const p = { name: 'kestrel', file: 'C:/x/kestrel.json' };
  keepFindings(state, w.items, [guardRow('I-c16-000')]);
  w.items['RUN-4'] = { id: 'RUN-4', kind: 'run', state: 'queued', created: '2026-11-17T06:00:00Z', data: { lane: 'fixall', stage: 'fixer', kind: 'audit', brief: '/s/fixer/DIR-8-x.brief.md' } };
  assert.deepEqual(tickFix(p, state, { metaCmd: 'm', items: w.items, spawnFn }), ['fix: DIR-9 waits: fixer RUN-4 is queued (one fixer run at a time)']);
  assert.equal(calls.length, 0, 'no spawn');
  w.items['RUN-4'].state = 'ended';
  assert.equal(tickFix(p, state, { metaCmd: 'm', items: w.items, spawnFn }).length, 1);
  assert.equal(calls.length, 1);
});

test('norn fix start: says why nothing starts; refuses a directive that is not a Fix all one or has no findings file', () => {
  const root = tmp('fixer-start-'), state = path.join(root, 'state'), repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const pf = path.join(root, 'kestrel.json'), fwd = s => s.split(path.sep).join('/');
  fs.writeFileSync(pf, JSON.stringify({ schema: 1, name: 'kestrel', title: 'K', root: fwd(repo), policy: { lanes: {} } }));
  const env = { META_ROOT: root, META_ROLE: 'owner' }, o = [], e = [];
  const run = argv => main(argv, env, s => o.push(s), s => e.push(s));
  const dec = record(state, { kind: 'decision', ev: 'create', by: 'dashboard', data: { lane: 'fixall', question: 'Fix all', choice: 'send', why: 'tap', findings: ['I-1'] } });
  const dir = record(state, { kind: 'directive', ev: 'create', by: 'dashboard', data: { text: 'Fix all', via: 'dashboard', findings: ['I-1'], fixall: dec.id } });
  const plain = record(state, { kind: 'directive', ev: 'create', by: 'dashboard', data: { text: 'plain', via: 'dashboard' } });
  assert.equal(run(['fix', 'start', plain.id, '--project', pf, '--state', state]), 2);
  assert.match(e.join('\n'), /not a Fix all directive/);
  e.length = 0;
  assert.equal(run(['fix', 'start', dir.id, '--project', pf, '--state', state]), 2);
  assert.match(e.join('\n'), /no findings file yet/);
  fs.mkdirSync(path.join(state, 'fixer'), { recursive: true });
  fs.writeFileSync(findingsFile(state, dir.id), JSON.stringify({ rows: [{ id: 'I-1', key: 'k', path: 'CLAUDE.md', line: 2, why: 'w', action: 'a' }] }));
  const d2 = record(state, { kind: 'directive', ev: 'done', id: dir.id, by: 'checkin', data: { refs: [dec.id] } });
  o.length = 0; e.length = 0;
  assert.equal(run(['fix', 'start', dir.id, '--project', pf, '--state', state]), 0, e.join('\n') + String(d2.id));
  assert.match(o.join('\n'), /nothing to start \(the directive is done\)/);
});

test('norn fix start routes the fixer by the PROJECT policy (Settings, as the dash says), not the bare budget', () => {
  const root = tmp('fixer-route-'), state = path.join(root, 'state'), repo = path.join(root, 'repo'), fwd = s => s.split(path.sep).join('/');
  fs.mkdirSync(repo, { recursive: true });
  const pf = path.join(root, 'kestrel.json'), bf = path.join(root, 'budget.json');
  fs.writeFileSync(pf, JSON.stringify({ schema: 1, name: 'kestrel', title: 'K', root: fwd(repo), policy: { lanes: {}, executors: { docs: { executor: 'fake', model: 'm-proj', effort: 'low' } } } }));
  fs.writeFileSync(bf, JSON.stringify({ policy: { executors: { docs: { executor: 'no-such-budget' } } } }));
  const e = [], o = [], run = argv => main(argv, { META_ROOT: root, META_ROLE: 'owner' }, s => o.push(s), s => e.push(s));
  const dec = record(state, { kind: 'decision', ev: 'create', by: 'dashboard', data: { lane: 'fixall', question: 'Fix all', choice: 'send', why: 'tap', findings: ['I-1'] } });
  const dir = record(state, { kind: 'directive', ev: 'create', by: 'dashboard', data: { text: 'Fix all', via: 'dashboard', findings: ['I-1'], fixall: dec.id } });
  fs.mkdirSync(path.join(state, 'fixer'), { recursive: true });
  fs.writeFileSync(findingsFile(state, dir.id), JSON.stringify({ rows: [{ id: 'I-1', key: 'k', path: 'CLAUDE.md', line: 2, why: 'w', action: 'a' }] }));
  assert.equal(run(['fix', 'start', dir.id, '--project', pf, '--state', state, '--budget', bf]), 0, e.join(' '));
  assert.match(o.join('\n'), /docs class [(]fake m-proj low[)]/, 'the project policy routes the docs class');
});

test('norn fix start: another directive\'s fixer queued = refused before its brief is written (no orphan brief)', () => {
  const root = tmp('fixer-held-'), state = path.join(root, 'state'), repo = path.join(root, 'repo'), fwd = s => s.split(path.sep).join('/');
  fs.mkdirSync(repo, { recursive: true });
  const pf = path.join(root, 'kestrel.json'), bf = path.join(root, 'budget.json');
  fs.writeFileSync(pf, JSON.stringify({ schema: 1, name: 'kestrel', title: 'K', root: fwd(repo), policy: { lanes: {}, executors: { docs: { executor: 'fake', model: 'm', effort: 'low' } } } }));
  // a full worker cap holds the first fixer queued: --queue starts at once when no gate is shut, and the unpinned resource sample
  // (free RAM / CPU) was that gate - shut on a busy runner (QUEUED), open on an idle one (STARTED, CI-RED-F8E2980 windows)
  fs.writeFileSync(bf, JSON.stringify({ max_claude_workers: 0 }));
  const e = [], o = [], run = argv => main(argv, { META_ROOT: root, META_ROLE: 'owner', META_NO_TICK: '1' }, s => o.push(s), s => e.push(s));
  const dirs = ['I-1', 'I-2'].map(f => {
    const dec = record(state, { kind: 'decision', ev: 'create', by: 'dashboard', data: { lane: 'fixall', question: 'Fix all', choice: 'send', why: 'tap', findings: [f] } });
    const dir = record(state, { kind: 'directive', ev: 'create', by: 'dashboard', data: { text: 'Fix all', via: 'dashboard', findings: [f], fixall: dec.id } });
    fs.mkdirSync(path.join(state, 'fixer'), { recursive: true });
    fs.writeFileSync(findingsFile(state, dir.id), JSON.stringify({ rows: [{ id: f, key: 'k', path: 'CLAUDE.md', line: 2, why: 'w', action: 'a' }] }));
    return dir.id;
  });
  assert.equal(run(['fix', 'start', dirs[0], '--queue', '--project', pf, '--state', state, '--budget', bf]), 0, e.join(' '));
  assert.match(o.join('\n'), /QUEUED RUN-\d+ fixer of/);
  const briefs = () => fs.readdirSync(path.join(state, 'fixer')).filter(f => f.endsWith('.brief.md'));
  assert.equal(briefs().length, 1);
  assert.equal(run(['fix', 'start', dirs[1], '--queue', '--project', pf, '--state', state, '--budget', bf]), 2);
  assert.match(e.join('\n'), new RegExp(`${dirs[1]}: fixer RUN-\\d+ is queued \\(one fixer run at a time\\)`));
  assert.equal(briefs().length, 1, 'the refused start wrote no brief');
});

test('the result card: one per ended fixer run without a verdict - files with their hunks, the status lines; no hunk = failed', () => {
  const w = world({ n: 3, runs: 1 }), notes = '/s/fixer/DIR-9-0.md';
  w.items['RUN-1'].data.notes = notes;
  const text = ['### `CLAUDE.md:3` - medium - rewrite', '```diff', '--- a/CLAUDE.md', '+++ b/CLAUDE.md', '@@ -2,2 +2,2 @@', ' x', '-old', '+new', '```',
    '### `AGENTS.md:9` - medium - remove', '```diff', '--- a/AGENTS.md', '+++ b/AGENTS.md', '@@ -8,2 +8,1 @@', ' y', '-gone', '```', '## Findings', '- I-c16-000: drafted', '- I-c16-001: drafted', '- I-c16-002: skipped: no way picked'].join('\n');
  const files = { 'CLAUDE.md': 'x\nx\nold\n', 'AGENTS.md': 'y\n'.repeat(8) + 'gone\n' }, readFile = f => files[path.basename(f)] ?? null;
  const [c] = fixCards(w.items, { readNotes: () => text, readBrief: w.readBrief, root: '/r', readFile });
  assert.deepEqual([c.run, c.directive, c.state, c.n, c.files.map(f => f.file)], ['RUN-1', 'DIR-9', 'ready', 2, ['CLAUDE.md', 'AGENTS.md']]);
  assert.deepEqual(c.status.map(s => s.state), ['drafted', 'drafted', 'skipped']);
  assert.equal(fixCards(w.items, { readNotes: () => 'I could not.', readBrief: w.readBrief })[0].state, 'failed');
  assert.equal(fixCards(w.items, { readNotes: () => text, readBrief: w.readBrief, root: '/r', readFile: () => null })[0].fail, 'no hunk applies', 'the files are not there: nothing applies');
  w.items['DEC-3'] = { id: 'DEC-3', kind: 'decision', state: 'in-force', created: '2026-11-17T08:00:00Z', data: { lane: 'fixall-result', directive: 'DIR-9', run: 'RUN-1', ids: ['I-c16-000'], choice: 'apply' } };
  assert.equal(fixCards(w.items, { readNotes: () => text, readBrief: w.readBrief, root: '/r', readFile }).length, 0, 'a verdict: the card leaves');
  const t = verdictText(c, { choice: 'apply', skip: ['AGENTS.md'], close: 'DEC-3' });
  assert.match(t, /Apply the fixer hunks of RUN-1 \(Fix all DIR-9, DEC-1\): 1 hunk\(s\) in CLAUDE\.md\./);
  assert.match(t, /leave AGENTS\.md as it is/);
  assert.match(t, /`norn rec done DIR-9 --refs DEC-3`/);
  assert.equal(verdictText(c, { choice: 'discard' }), null, 'a discard that closes nothing: no directive');
  assert.match(verdictText(c, { choice: 'discard', close: 'DEC-3' }), /^Then close DIR-9/);
});

// R2 (controller ruling): "Apply all n" counts only hunks that apply to the file as it is now; one that does not shows "does not apply" with
// its reason, is left out of n and of the verdict, and its finding stays open (the plan offers it to a later batch).
import { hunkMisfit } from '../engine/lib/fixer.mjs';
import { renderTab } from '../engine/dash/ui.mjs';

test('one hunk applies, one does not: the card counts 1, says why for the other, its finding stays open for a later batch', () => {
  const w = world({ n: 3, runs: 1 });
  w.items['RUN-1'].data.notes = '/s/fixer/DIR-9-0.md';
  const brief = ['- id: I-c16-000', '  file: CLAUDE.md:3', '- id: I-c16-001', '  file: AGENTS.md:9', '- id: I-c16-002', '  file: AGENTS.md:20'].join('\n');
  const files = { 'CLAUDE.md': 'x\r\nx\r\nold\r\n', 'AGENTS.md': 'y\n'.repeat(8) + 'gone\n' }, readFile = f => files[path.basename(f)] ?? null;
  const text = ['### `CLAUDE.md:3` - medium - rewrite', '```diff', '--- a/CLAUDE.md', '+++ b/CLAUDE.md', '@@ -2,2 +2,2 @@', ' x', '-old', '+new', '```',
    '### `AGENTS.md:9` - medium - remove', '```diff', '--- a/AGENTS.md', '+++ b/AGENTS.md', '@@ -9,1 +8,0 @@', '-gone', '```',
    '## Findings', '- I-c16-000: drafted', '- I-c16-001: drafted', '- I-c16-002: skipped: no way picked'].join('\n');
  const [c] = fixCards(w.items, { readNotes: () => text, readBrief: () => brief, root: '/r', readFile });
  assert.deepEqual([c.state, c.n, c.bad, c.open], ['ready', 1, 1, ['I-c16-001']], 'Apply all 1; the zero-context hunk does not apply; its finding stays open');
  const bad = c.files.find(f => f.file === 'AGENTS.md').hunks[0];
  assert.deepEqual([bad.applies, bad.why], [false, 'no context line (git apply refuses a zero-context hunk)']);
  assert.equal(c.files.find(f => f.file === 'CLAUDE.md').hunks[0].applies, true, 'CRLF file + exact context: applies');
  const page = renderTab('inbox', { items: [{ type: 'fixresult', id: 'RUN-1', project: 'k', card: c }] }, { project: 'k' });
  assert.match(page, /Apply all <span[^>]*>1</);
  assert.match(page, /does not apply<\/span> no context line/);
  const t = verdictText(c, { choice: 'apply' });
  assert.match(t, /: 1 hunk\(s\) in CLAUDE\.md\./); assert.match(t, /leave the block\(s\) that do not apply \(AGENTS\.md:9\)/);
  // the verdict records the open id: the plan gives it back to the rest (a later batch)
  w.items['DEC-3'] = { id: 'DEC-3', kind: 'decision', state: 'in-force', created: '2026-11-17T08:00:00Z', data: { lane: 'fixall-result', directive: 'DIR-9', run: 'RUN-1', ids: ['I-c16-000', 'I-c16-002'], open: ['I-c16-001'], choice: 'apply' } };
  assert.deepEqual(fixPlan(w.items['DIR-9'], w.items, { readBrief: () => brief }).left, ['I-c16-001']);
  assert.deepEqual(verdictIds(c), { ids: ['I-c16-000', 'I-c16-002'], open: ['I-c16-001'] });
  // a failed card (no hunk parses or applies): Discard resolves nothing, every finding stays open
  assert.deepEqual(verdictIds({ ...c, state: 'failed' }), { ids: [], open: ['I-c16-000', 'I-c16-001', 'I-c16-002'] });
});

test('hunkMisfit says why a hunk does not apply: wrong line, wrong counts, a line not as quoted, no file', () => {
  const f = 'a\nb\nc\nd\n', p = (h, ...l) => ['--- a/f', '+++ b/f', h, ...l].join('\n');
  assert.equal(hunkMisfit(p('@@ -2,2 +2,2 @@', ' b', '-c', '+C'), f), null);
  assert.equal(hunkMisfit(p('@@ -1,2 +1,2 @@', ' b', '-c', '+C'), f), 'the old lines are at line 2, not 1');
  assert.match(hunkMisfit(p('@@ -2,3 +2,2 @@', ' b', '-c', '+C'), f), /^the @@ header counts 3 old and 2 new line\(s\), the hunk has 2 and 2$/);
  assert.match(hunkMisfit(p('@@ -2,2 +2,2 @@', ' b', '-cc', '+C'), f), /^line 3 is not as the hunk quotes it/);
  assert.equal(hunkMisfit(p('@@ -2,2 +2,2 @@', ' b', '-c', '+C'), null), 'the file is not there');
});

test('the brief quotes the exact lines now around each finding, its path relative to the root', () => {
  const b = fixerBrief({ project: 'k', dir: 'DIR-9', dec: 'DEC-1', root: 'C:/r', rows: [{ id: 'I-1', path: 'C:\\r\\docs\\CLAUDE.md', line: 6, why: 'w' }],
    readFile: () => '\uFEFF' + Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join('\r\n') });
  assert.match(b, /- id: I-1\n  file: docs\/CLAUDE\.md:6\n/);
  assert.match(b, /lines now [^\n]*\n    2\| l2\n[^]*    10\| l10$/m);
  assert.doesNotMatch(b, / {4}1\| | {4}11\| /);
  assert.match(b, /EXACT CONTEXT/);
  assert.deepEqual(briefRows(b), [{ id: 'I-1', file: 'docs/CLAUDE.md', line: 6 }]);
  // a very long CONTEXT line is cut and says so (the real batch: 40 findings in memory files with 2000-char lines made a 329 kB brief);
  // the finding's own line stays whole (cut, the fixer skipped 10 of 40 findings "the line is cut, so I cannot quote it")
  const long = 'w'.repeat(2000), c = fixerBrief({ project: 'k', dir: 'DIR-9', dec: 'DEC-1', rows: [{ id: 'I-2', path: 'C:/r/M.md', line: 1, why: 'w' }], readFile: () => `${'v'.repeat(2000)}\n${long}` });
  assert.match(c, /    1\| v{2000}\n/, 'the finding line: whole');
  assert.match(c, new RegExp(`    2\\| w{300}… \\[cut: 1700 more chars: Read line 2 in the file to quote it whole\\]`));
  assert.match(c, /never skip a finding because a line is cut/);
  assert.ok(c.length < 6000, 'the brief stays small');
  // the run's prompt is a pointer to the brief file, never the brief itself (a Windows command line holds ~32k chars)
  const pr = fixerPrompt('C:\\s\\fixer\\DIR-9-1.brief.md');
  assert.match(pr, /^Read C:\/s\/fixer\/DIR-9-1\.brief\.md /); assert.ok(pr.length < 400);
});

// ---- the dash: Send -> the findings file + "starting"; a fixer run's end -> ONE result card in the Inbox; Apply (a skipped file) = ONE
// decision + ONE directive; the rest tap approves the runs the rest needs. The shared dash fixture (temp dirs), no browser.
import { fixture } from './helpers/dash-fixture.mjs';

test('the dash: Send keeps the findings file; a fixer run\'s end is ONE Inbox card; Apply / Discard and the rest tap write one record each', { timeout: 240000 }, async () => {
  const f = await fixture();
  try {
    let s = (await f.get('/api/guard?project=kestrel&part=summary')).data;
    for (let i = 0; s.pending && i < 1200; i++) { await new Promise(r => setTimeout(r, 100)); s = (await f.get('/api/guard?project=kestrel&part=summary')).data; }
    const sh = (await f.get('/api/guard?project=kestrel&part=sheet')).data.sheet, keys = sh.items.filter(i => i.kind !== 'call').map(i => i.key);   // the fixture findings are on Norn's own prompts: offered, never pre-ticked, so ticked by hand
    assert.equal(sh.usage.batch, 40, 'the sheet gets the batch: it says the real number of runs before the tap');
    const sent = await f.post('/api/fixall', { project: 'kestrel', sig: sh.sig, keys, picks: {} });
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    const state = f.pa.state, dir = sent.data.directive;
    const s1 = (await f.get('/api/guard?project=kestrel&part=summary')).data;
    assert.equal(s1.sent[0].fixer.at, 'starting', 'sent, no run yet: the tick starts it');
    const kept = JSON.parse(fs.readFileSync(findingsFile(state, dir), 'utf8')).rows;
    assert.equal(kept.length, sent.data.n, 'the dash kept every sent row for the brief');
    // a fixer run of ONE finding (a batch of 1), ended with a two-file answer
    const fx = path.join(state, 'fixer'), brief = path.join(fx, `${dir}-1.brief.md`), notes = path.join(fx, `${dir}-1.md`), first = kept[0].id;
    fs.writeFileSync(brief, `- id: ${first}\n`);
    fs.writeFileSync(path.join(f.pa.root, 'CLAUDE.md'), 'x\nx\nold\n'); fs.writeFileSync(path.join(f.pa.root, 'AGENTS.md'), 'y\n'.repeat(8) + 'gone\n');
    fs.writeFileSync(notes, ['### `CLAUDE.md:3` - medium - rewrite', '```diff', '--- a/CLAUDE.md', '+++ b/CLAUDE.md', '@@ -2,2 +2,2 @@', ' x', '-old', '+new', '```',
      '### `AGENTS.md:9` - medium - remove', '```diff', '--- a/AGENTS.md', '+++ b/AGENTS.md', '@@ -8,2 +8,1 @@', ' y', '-gone', '```', '## Findings', `- ${first}: drafted`].join('\n'));
    const run = record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { lane: 'fixall', kind: 'audit', executor: 'fake', brief, notes } });
    const s2 = (await f.get('/api/guard?project=kestrel&part=summary')).data;
    assert.deepEqual([s2.sent[0].fixer.at, s2.sent[0].fixer.run], ['running', run.id]);
    record(state, { kind: 'run', ev: 'end', id: run.id, by: 'launcher', data: { outcome: 'done', exit: 0 } });
    const inbox = (await f.get('/api/inbox?project=kestrel')).data.items.filter(x => x.type === 'fixresult');
    assert.equal(inbox.length, 1, 'ONE card');
    assert.deepEqual(inbox[0].card.files.map(x => [x.file, x.hunks.length]), [['CLAUDE.md', 1], ['AGENTS.md', 1]]);
    const g = (await f.get('/api/guard?project=kestrel')).data;
    assert.equal(g.fixcards.length, 1, 'the same card on the Slop page');
    const before = (await f.get('/api/records?project=kestrel')).data;
    const ap = await f.post('/api/fixresult', { project: 'kestrel', run: run.id, choice: 'apply', skip: ['AGENTS.md'] });
    assert.equal(ap.status, 200, JSON.stringify(ap.data));
    assert.equal(ap.data.closes, sent.data.n === 1);
    const after = (await f.get('/api/records?project=kestrel')).data;
    assert.equal(after.decisions.length, before.decisions.length + 1); assert.equal(after.directives.length, before.directives.length + 1);
    const v = after.decisions.find(x => x.id === ap.data.id), d = after.directives.find(x => x.id === ap.data.directive);
    assert.deepEqual([v.data.lane, v.data.choice, v.data.ids, v.data.skipped_files], ['fixall-result', 'apply', [first], ['AGENTS.md']]);
    assert.match(d.data.text, new RegExp(`Apply the fixer hunks of ${run.id}[^]*1 hunk[^]*CLAUDE.md[^]*leave AGENTS.md as it is`));
    assert.equal((await f.post('/api/fixresult', { project: 'kestrel', run: run.id, choice: 'discard' })).status, 409, 'decided once');
    assert.equal((await f.get('/api/inbox?project=kestrel')).data.items.filter(x => x.type === 'fixresult').length, 0, 'the card leaves');
    if (sent.data.n > 1) {
      const rest = await f.post('/api/fixall', { project: 'kestrel', rest: dir });
      assert.equal(rest.status, 200, JSON.stringify(rest.data));
      assert.deepEqual([rest.data.left, rest.data.runs], [sent.data.n - 1, Math.ceil((sent.data.n - 1) / 40)]);
      assert.equal((await f.get('/api/guard?project=kestrel&part=summary')).data.sent[0].fixer.at, 'starting', 'the rest tap: the tick starts the next batch');
    }
  } finally { await f.done(); }
});
