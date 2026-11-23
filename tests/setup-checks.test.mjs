// The "Set up" steps (setupOf, on the strip) count what is really in place: a repo's own agent rules file (CLAUDE.md,
// AGENTS.md) is rules, a cap set in budget.json (Settings) is chosen unless it is the starter cap norn setup wrote, and the merge gate
// step sets the proposed command in one click on the Settings write path. Temp dirs only (dash fixture).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, budget0 } from './helpers/dash-fixture.mjs';
import { getProfile, profileBudget } from '../engine/lib/profiles.mjs';

const setup = async (f, p = 'kestrel') => (await f.get(`/api/strip?project=${p}`)).data.setup;

test('a repo with CLAUDE.md and budget caps has no rules or caps gap; the card would name the file and the values', async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.pa.root, 'CLAUDE.md'), '# rules\n');
    const s = await setup(f);
    assert.equal(s.rules, true); assert.deepEqual(s.rules_from, ['CLAUDE.md']);
    assert.equal(s.caps_chosen, true); assert.equal(s.caps_from, 'budget');
    assert.deepEqual(s.caps, { max_claude_workers: budget0.max_claude_workers, max_codex: budget0.max_codex, weekly_stop_pct: budget0.weekly_stop_pct });
    const o = await setup(f, 'other');
    assert.equal(o.rules, false, 'no agent file, no RULES.md: a rules gap'); assert.deepEqual(o.rules_from, []);
  } finally { await f.done(); }
});

test('the starter caps norn setup wrote are nobody\'s choice; a cap changed in Settings is', async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(f.budgetFile, JSON.stringify(profileBudget(getProfile('try-it')), null, 2) + '\n');
    let s = await setup(f);
    assert.equal(s.caps_chosen, false); assert.equal(s.caps_from, null);
    const g = (await f.get('/api/settings?project=kestrel')).data;
    assert.equal((await f.post('/api/settings', { project: 'kestrel', version: g.version, changes: { max_claude_workers: 5 } })).status, 200);
    s = await setup(f);
    assert.equal(s.caps_chosen, true); assert.equal(s.caps_from, 'budget'); assert.equal(s.caps.max_claude_workers, 5);
  } finally { await f.done(); }
});

test('the merge gate step: one click writes merge.gate.cmd to project.json; a stale settings version is refused', async () => {
  const f = await fixture();
  try {
    let s = await setup(f);
    assert.equal(s.gate, null);
    assert.equal((await f.post('/api/adopt/gate', { project: 'kestrel', cmd: 'npm test' })).status, 400, 'the version the page saw is required');
    assert.equal((await f.post('/api/adopt/gate', { project: 'kestrel', cmd: 'npm test', version: 'stale' })).status, 409);
    const r = await f.post('/api/adopt/gate', { project: 'kestrel', cmd: 'node ci.mjs --changed origin/main', version: s.version });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const pj = JSON.parse(fs.readFileSync(f.pa.file, 'utf8'));
    assert.deepEqual(pj.merge, { gate: { cmd: 'node ci.mjs --changed origin/main' } });
    assert.deepEqual(pj.policy, { lanes: {} }, 'the rest of project.json is kept');
    s = await setup(f);
    assert.equal(s.gate, 'node ci.mjs --changed origin/main');
  } finally { await f.done(); }
});
