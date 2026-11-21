// META-TEND P5 check 20: read evidence from the session transcripts (Read with offset / limit, a Skill call, a shell read) and the
// decisions that cite a file (its line too); never read + never cited in the window = a prune advisory (never a delete). Sandbox only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { readEvidence, paraMarks, transcriptReads } from '../engine/lib/readev.mjs';
import { record, loadState } from '../engine/lib/records.mjs';

after(cleanTmp);
const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const use = (ts, name, input) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { id: 'm' + Math.random(), content: [{ type: 'tool_use', id: 't', name, input }] } });

test('readEvidence: reads (whole / a range), skills, shell reads and decision cites per file; never read + never cited = a prune advisory', () => {
  const t = mkTmp('meta-readev-'), root = path.join(t, 'repo').replace(/\\/g, '/'), state = path.join(t, 'state');
  fs.mkdirSync(state, { recursive: true });
  const rows = [
    { id: 'r1', path: `${root}/docs/design.md`, exists: true, load: 'on-demand', kind: 'repo' },
    { id: 'r2', path: `${root}/rules/common.md`, exists: true, load: 'on-demand', kind: 'rules' },
    { id: 'r3', path: `${root}/.claude/skills/tend/SKILL.md`, exists: true, load: 'on-demand', kind: 'skill' },
    { id: 'r4', path: `${root}/docs/old-notes.md`, exists: true, load: 'on-demand', kind: 'repo' },
    { id: 'r5', path: `${root}/CLAUDE.md`, exists: true, load: 'session', kind: 'repo' },
  ];
  const tr = path.join(t, 'sess.jsonl');
  fs.writeFileSync(tr, [
    use('2026-11-10T10:00:00.000Z', 'Read', { file_path: `${root}/docs/design.md`.replace(/\//g, '\\'), offset: 10, limit: 5 }),
    use('2026-11-11T10:00:00.000Z', 'Read', { file_path: `${root}/docs/design.md` }),
    use('2026-11-12T10:00:00.000Z', 'Skill', { skill: 'tend' }),
    use('2026-09-01T10:00:00.000Z', 'Read', { file_path: `${root}/docs/old-notes.md` }),   // older than 30 days: no evidence
    use('2026-11-12T11:00:00.000Z', 'Bash', { command: `sed -n '1,40p' ${root}/rules/common.md` }),
    JSON.stringify({ type: 'user', message: { content: 'docs/old-notes.md is mentioned, not opened' } }), ''].join('\n'));
  record(state, { kind: 'decision', ev: 'create', by: 'controller', data: { lane: 'x', question: 'which rule', choice: 'per rules/common.md l.3', why: 'the rule says so' } }, { now: () => new Date('2026-11-13T10:00:00.000Z') });
  const ev = readEvidence(rows, { root, state }, { items: loadState(state).items, files: [tr], now: NOW });
  assert.equal(ev.transcripts, 1);
  assert.deepEqual(ev.files.r1.ranges, [[10, 14], null]); assert.equal(ev.files.r1.reads, 2); assert.equal(ev.files.r1.last, '2026-11-11T10:00:00.000Z');
  assert.equal(ev.files.r3.reads, 1, 'the Skill call = its SKILL.md read');
  assert.equal(ev.files.r2.reads, 1); assert.deepEqual(ev.files.r2.cites, [{ id: 'DEC-1', line: 3 }]);
  assert.equal(ev.files.r4.reads, 0);
  assert.deepEqual(ev.advisories.map(a => [a.check, a.key, a.row, a.severity, a.fix.tier]), [[20, 'never-read', 'r4', 'low', 'card']], 'on-demand only: CLAUDE.md loads every session');
  assert.match(ev.advisories[0].fix.action, /Norn deletes nothing/);
  assert.match(ev.advisories[0].why, /never read in the 5 days the transcripts cover \(1 session transcripts\)/, 'the span the evidence covers, said plainly'); assert.equal(ev.covered_days, 5);
  assert.deepEqual(paraMarks({ line: 12, end: 20 }, ev.files.r1), { read: 2, cited: [] });
  assert.deepEqual(paraMarks({ line: 1, end: 9 }, ev.files.r1), { read: 1, cited: [] });
  assert.deepEqual(paraMarks({ line: 2, end: 4 }, ev.files.r2), { read: 1, cited: ['DEC-1'] });
  assert.equal(readEvidence(rows, { root, state }, { files: [], now: NOW }).advisories.length, 0, 'no transcript = no claim');
  // bug 4: a worker reads its worktree's copy - that is a read of the project's file (its repo-relative path)
  const wt = path.join(t, 'wt.jsonl');
  fs.writeFileSync(wt, [use('2026-11-13T09:00:00.000Z', 'Read', { file_path: `${t}/state/wt/lane-a/docs/old-notes.md`.replace(/\//g, '\\') }), use('2026-11-13T09:01:00.000Z', 'Read', { file_path: `${t}/elsewhere/docs/old-notes.md` }), ''].join('\n'));
  assert.equal(readEvidence(rows, { root, state }, { files: [wt], now: NOW }).files.r4.reads, 1, 'the worktree copy counts; another checkout outside a worktree does not');
  // appended lines are read on the next call (the cache keeps the offset)
  fs.appendFileSync(tr, use('2026-11-13T10:00:00.000Z', 'Read', { file_path: `${root}/docs/old-notes.md` }) + '\n');
  assert.equal(transcriptReads(tr).filter(e => e[1] === 'read').length, 4);
});
