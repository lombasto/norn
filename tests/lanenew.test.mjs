// lanenew.mjs: a lane's first brief carries the Tests: line that points at the testing rules (TEST-GOVERNANCE S2, owner Q-32).
// Driven through laneSteps with a fake io: no git, no files, no records written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { laneSteps, BRIEF_TESTS, TESTING_DOC } from '../engine/lib/lanenew.mjs';
import { runSteps } from '../engine/lib/steps.mjs';
import { parseReady } from '../engine/lib/ready.mjs';

const P = { name: 'kestrel', root: 'C:/r/kestrel', state: 'C:/s/kestrel', lane_defaults: { worktree: 'C:/s/kestrel/wt/a' } };
const fakeIo = made => ({ git: () => ({ ok: true, out: 'main' }), exists: f => !/\.md$/.test(f), mkdir: () => {}, state: () => ({ items: {} }),
  record: (s, ev) => ({ id: ev.kind === 'directive' ? 'DIR-1' : 'L:a' }), create: (f, t) => { made[f] = t; } });

test('a lane brief carries one Tests: line: the changed files\' tests, never the full suite, and the rules\' path', () => {
  const made = {}, r = runSteps(laneSteps(P, { name: 'a', task: 'Add a usage line' }), fakeIo(made));
  assert.equal(r.brief_created, true);
  const text = made[Object.keys(made)[0]];
  assert.match(text, /Add a usage line/);
  assert.equal(text.split('\n').filter(l => l.startsWith('Tests:')).length, 1);
  assert.ok(text.includes(BRIEF_TESTS));
  assert.match(BRIEF_TESTS, /never the full suite/);
  assert.match(parseReady(text).tests, /docs\/TESTING\.md$/, 'the Ready parser reads it as the Tests line');
  assert.ok(fs.existsSync(TESTING_DOC), 'the rules file exists in the engine checkout');
  assert.doesNotMatch(BRIEF_TESTS, /`/, 'no backticks: the Done check runs no command from the placeholder');
});
