// The worker floor (floor.mjs; local/budget.json worker_min_model + worker_min_effort): Claude models and efforts ranked; a worker run
// below it is raised at launch (a check-in is not); a Settings save below it is refused, raising it raises the settings below it; a
// profile is raised to it; the check-in prompt names it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { loadState } from '../engine/lib/records.mjs';
import { claudeRank, modelBelow, effortBelow, raiseToFloor, floorOf, floorText, CHECKIN_FLOOR } from '../engine/lib/floor.mjs';
import { applySettings, floorChanges, belowFloor, checkinBelowFloor, merged, settingsView, onlyChanged, split, sectionOf, SETTINGS, generatedLines } from '../engine/lib/policy.mjs';
import { profilePolicy, profileBudget, getProfile } from '../engine/lib/profiles.mjs';
import { queueRun } from '../engine/lib/runs.mjs';
import { policyLine } from '../engine/lib/tick.mjs';

after(cleanTmp);
const FLOOR = { worker_min_model: 'claude-opus-5-5', worker_min_effort: 'medium' };

test('claudeRank: family first, then version; aliases; non-Claude models are not ranked', () => {
  assert.ok(modelBelow('claude-haiku-5-5', 'claude-opus-5-5'));
  assert.ok(modelBelow('claude-sonnet-5-5', 'claude-opus-5-5'));
  assert.ok(modelBelow('claude-opus-4-1', 'claude-opus-5-5'), 'an older Opus is below');
  assert.ok(modelBelow('claude-3-5-sonnet', 'claude-opus-5-5'), 'the old id order too');
  assert.ok(!modelBelow('claude-opus-5-5', 'claude-opus-5-5'));
  assert.ok(!modelBelow('claude-fable-5-2', 'claude-opus-5-5'), 'Fable is above Opus');
  assert.ok(!modelBelow('opus', 'claude-opus-5-5'), 'an alias = the latest of its family');
  assert.ok(modelBelow('sonnet', 'claude-opus-5-5'));
  assert.ok(!modelBelow('claude-opus-5-5[1m]', 'claude-opus-5-5'), 'a suffix keeps the model');
  for (const m of ['gpt-6.1-sol', 'fake', '', undefined, 'glm-5']) { assert.equal(claudeRank(m), null, String(m)); assert.ok(!modelBelow(m, 'claude-opus-5-5')); }
  assert.ok(effortBelow('low', 'medium') && !effortBelow('medium', 'medium') && !effortBelow('xhigh', 'medium') && !effortBelow('', 'medium'));
});

test('floorOf / raiseToFloor: a run below is raised, a non-Claude one is left alone; no floor = no change', () => {
  const f = floorOf(FLOOR);
  assert.deepEqual(f, { model: 'claude-opus-5-5', effort: 'medium' });
  assert.equal(floorOf({}), null);
  assert.equal(floorOf({ worker_min_model: 'not-a-model' }), null);
  assert.match(floorText(f), /claude-opus-5-5.*medium/);
  assert.deepEqual(raiseToFloor({ model: 'claude-haiku-5-5', effort: 'low' }, f),
    { model: 'claude-opus-5-5', effort: 'medium', raised: { model: ['claude-haiku-5-5', 'claude-opus-5-5'], effort: ['low', 'medium'] } });
  assert.deepEqual(raiseToFloor({ model: 'claude-opus-5-5', effort: 'high' }, f).raised, null);
  assert.deepEqual(raiseToFloor({ model: 'gpt-6.1-sol', effort: 'low' }, f), { model: 'gpt-6.1-sol', effort: 'low', raised: null }, 'codex keeps its own scale');
  assert.deepEqual(raiseToFloor({ model: 'claude-sonnet-5-5', effort: 'low' }, null).raised, null);
});

test('the launcher raises a worker run below the floor and says so; a check-in keeps its model; no floor = as asked', () => {
  const st = mkTmp('meta-floor-'), wt = mkTmp('meta-floor-wt-');
  const base = { state: st, locksDir: path.join(st, 'locks'), executor: 'fake', kind: 'fake', brief: path.join(wt, 'b.md'), worktree: wt, lock: false, tick: null,
    policy: { auto_resume_handoff: false, trigger_on_exit: false }, env: { FAKE_MS: '10' } };
  fs.writeFileSync(base.brief, '# b');
  const low = queueRun({ ...base, lane: 'a', model: 'claude-haiku-5-5', effort: 'low', budget: FLOOR }).run;
  const ok = queueRun({ ...base, lane: 'b', model: 'claude-opus-5-5', effort: 'high', budget: FLOOR }).run;
  const free = queueRun({ ...base, lane: 'c', model: 'claude-haiku-5-5', effort: 'low', budget: {} }).run;
  const ck = queueRun({ ...base, lane: 'd', kind: 'checkin', model: 'claude-sonnet-5-5', effort: 'low', budget: FLOOR }).run;
  const items = loadState(st).items, d = id => items[id].data;
  assert.equal(d(low).model, 'claude-opus-5-5');
  assert.equal(d(low).effort, 'medium');
  assert.deepEqual(d(low).floor, { model: ['claude-haiku-5-5', 'claude-opus-5-5'], effort: ['low', 'medium'] });
  assert.ok(d(low).warnings.some(w => /worker floor/.test(w)), 'the run carries the notice');
  assert.equal(d(ok).model, 'claude-opus-5-5'); assert.equal(d(ok).effort, 'high'); assert.equal(d(ok).floor, undefined);
  assert.equal(d(free).model, 'claude-haiku-5-5', 'no floor: as asked');
  assert.equal(d(ck).model, 'claude-sonnet-5-5', 'a check-in keeps its own model');
  const spec = JSON.parse(fs.readFileSync(path.join(st, 'runs', low + '.queue.json'), 'utf8'));
  assert.equal(spec.model, 'claude-opus-5-5', 'the queued spec starts raised');
});

test('Settings: a worker setting saved below the floor is refused; raising the floor raises the ones below it in the same save', () => {
  const view = merged({}, {});
  // a new floor: the defaults below it (docs on Sonnet, the merge run on Sonnet) are raised in the same save, and only those are written
  const fc = floorChanges(view, FLOOR);
  assert.deepEqual(fc.raised.map(r => r.key).sort(), ['policy.checkin.merge_model', 'policy.executors.docs.model']);
  const updated = applySettings(view, fc.changes), parts = split(onlyChanged(view, fc.changes, updated));
  assert.equal(parts.budget.worker_min_model, 'claude-opus-5-5');
  assert.equal(parts.policy.executors.docs.model, 'claude-opus-5-5');
  assert.equal(parts.policy.checkin.merge_model, 'claude-opus-5-5');
  assert.deepEqual(belowFloor(updated), []);
  // under a floor: asking for less is refused, naming the key and the floor
  const under = merged(FLOOR, parts.policy);
  assert.throws(() => applySettings(under, { 'policy.executors.review.model': 'claude-sonnet-5-5' }), e => e.status === 400 && /review\.model.*worker minimum.*claude-opus-5-5/.test(e.message));
  assert.throws(() => applySettings(under, { claude_effort: 'low' }), e => e.status === 400 && /claude_effort = low/.test(e.message));
  assert.ok(applySettings(under, { 'policy.executors.review.model': 'claude-opus-5-5', 'policy.executors.review.effort': 'high' }));
  // a codex route keeps its own model / effort scale
  assert.ok(applySettings(under, { 'policy.executors.review.executor': 'codex-sol', 'policy.executors.review.model': 'gpt-6.1-sol', 'policy.executors.review.effort': 'low' }));
  // lowering the floor itself is allowed, then lower settings are too
  assert.ok(applySettings(under, { worker_min_model: '', 'policy.executors.review.model': 'claude-sonnet-5-5' }));
  // the dropdowns do not offer what is below the floor (the value in force stays)
  const rows = settingsView(under), row = k => rows.find(r => r.key === k);
  assert.ok(!row('policy.executors.review.model').options.includes('claude-sonnet-5-5'));
  assert.ok(row('policy.executors.review.model').options.includes('claude-opus-5-5'));
  assert.deepEqual(row('claude_effort').options, ['medium', 'high', 'xhigh']);
  for (const k of ['worker_min_model', 'worker_min_effort']) assert.deepEqual(sectionOf(SETTINGS.find(s => s.key === k)), ['executors', 'minimum']);
  assert.match(generatedLines(under).executors, /Worker minimum: claude-opus-5-5/);
});

test('profiles are raised to the floor in force; the check-in prompt names it', () => {
  const f = floorOf(FLOOR), pol = profilePolicy(getProfile('try-it'), { floor: f });
  for (const [cls, r] of Object.entries(pol.executors)) {
    assert.ok(!modelBelow(r.model, 'claude-opus-5-5'), `${cls}: ${r.model}`);
    assert.ok(!effortBelow(r.effort, 'medium'), `${cls}: ${r.effort}`);
  }
  const b = profileBudget(getProfile('try-it'), { floor: f });
  assert.equal(b.claude_model, 'claude-opus-5-5');
  assert.equal(b.checkin_model, getProfile('try-it').budget.checkin_model, 'the check-in model is not a worker model');
  assert.equal(profilePolicy(getProfile('try-it')).executors.docs.model, 'claude-sonnet-5-5', 'no floor: the profile as written');
  assert.match(policyLine(FLOOR), /WORKER MINIMUM: .*claude-opus-5-5.*medium/);
  assert.doesNotMatch(policyLine({}), /WORKER MINIMUM/);
});

test('the check-in floor (policy CHECKIN_FLOOR): a check-in model or effort below it is listed, never refused or raised', () => {
  assert.deepEqual(CHECKIN_FLOOR, { model: 'claude-opus-5-5', effort: 'medium' });
  assert.deepEqual(checkinBelowFloor(merged({}, {})), [], 'the defaults (Opus 5.5, medium) meet it');
  assert.deepEqual(checkinBelowFloor(merged({ checkin_model: 'claude-fable-5-2', checkin_effort: 'high' }, {})), []);
  const low = merged({ checkin_model: 'claude-sonnet-5-5', checkin_effort: 'low' }, {});
  assert.deepEqual(checkinBelowFloor(low).map(r => [r.key, r.value, r.to]), [['checkin_model', 'claude-sonnet-5-5', 'claude-opus-5-5'], ['checkin_effort', 'low', 'medium']]);
  assert.ok(applySettings(merged({}, {}), { checkin_model: 'claude-sonnet-5-5', checkin_effort: 'low' }), 'a save below it goes through (the review warns)');
  assert.deepEqual(floorChanges(merged({}, {}), { checkin_model: 'claude-sonnet-5-5' }).raised, [], 'the worker floor does not raise it');
  assert.deepEqual(belowFloor(merged({ ...FLOOR, checkin_model: 'claude-sonnet-5-5' }, {})).map(r => r.key).filter(k => k.startsWith('checkin_')), [], 'not a worker setting');
  for (const k of ['checkin_model', 'checkin_effort']) assert.match(SETTINGS.find(s => s.key === k).help, /check-in floor \(claude-opus-5-5, effort medium\)/);
});
