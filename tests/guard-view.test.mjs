// META-TEND P6: the Guard overview is a query over the advisory records (it owns no data): one row per open finding of every phase
// and of SloppaChoppa, typed, ranked, each linking to the tab that fixes it; counts per type, the trend, the rule ledger summary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { advisory } from '../engine/lib/advisory.mjs';
import { guardRows, guardView, rankRows, GUARD_TYPES } from '../engine/lib/guardview.mjs';
import { orcLine, bestAction } from '../engine/dash/norn/orc.mjs';

const adv = (o) => advisory({ source: 'test', fix: { tier: 'flag', kind: 'drafts', action: 'look' }, why: 'a finding', surface: 'x', severity: 'medium', ...o });

test('guardRows: every phase and SloppaChoppa typed, each with the tab that fixes it', () => {
  const ins = {
    rows: [{ id: 'r-claude', path: 'C:/p/CLAUDE.md' }, { id: 'r-mem', path: 'C:/m/MEMORY.md' }],
    findings: [adv({ check: 14, key: 'emphasis', path: 'C:/p/CLAUDE.md', line: 7 }), adv({ check: 1, key: 'mem-big', path: 'C:/m/MEMORY.md', severity: 'high' }),
      adv({ check: 13, key: 'pointer', path: 'C:\\p\\docs\\SPEC.md', line: 3, severity: 'low' })],
    rules: { advisories: [adv({ phase: 'P3', check: '5.0-3', key: 'rule-drift-claim', path: 'C:/p/CLAUDE.md', line: 9 })] },
  };
  const rows = guardRows({ ins, docs: [{ i: 2, path: 'C:/p/docs/SPEC.md' }],
    tests: { advisories: { list: [adv({ phase: 'TESTS', key: 'tests-copy-paste', path: 'tests/a.test.mjs', severity: 'low' })] } },
    advice: { cards: [{ key: 'k1', id: 'chores', severity: 'medium', title: 'Chores on a top model', fix: 'set it to sonnet', source: { ref: 'opus-5-5' } }, { key: 'k2', id: 'docs', severity: 'low', title: 'gone', decided: true }] },
    holds: [{ branch: 'feat/x', run: 'RUN-9', blocks: [{ rule: 'K2', file: 'a.mjs', line: 4, msg: 'empty catch', fp: 'f00' }] }] });
  const by = Object.fromEntries(rows.map(r => [r.type + ':' + (r.path ?? r.surface), r]));
  assert.deepEqual(rows.map(r => r.type).sort(), ['code', 'docs', 'instructions', 'memory', 'models', 'rules', 'tests']);
  assert.deepEqual(by['instructions:C:/p/CLAUDE.md'].go, { tab: 'docs', ins: 'r-claude', line: 7 });   // META-UX-BUILD S4: a file is read and fixed in the Docs reader
  assert.deepEqual(by['memory:C:/m/MEMORY.md'].go, { tab: 'docs', ins: 'r-mem' });
  assert.deepEqual(by['docs:C:\\p\\docs\\SPEC.md'].go, { tab: 'docs', doc: 2 }, 'a finding on a listed doc is fixed on the Docs tab');
  assert.equal(by['rules:C:/p/CLAUDE.md'].go.ins, 'r-claude');
  assert.deepEqual(by['models:class chores'].go, { tab: 'usage', jump: 'usage-advice' });
  assert.equal(by['models:class chores'].cls, 'chores');
  assert.ok(!rows.some(r => r.id === 'M-k2'), 'a decided advice card is closed');
  assert.deepEqual(by['code:a.mjs'].go, { tab: 'slop', jump: 'slop-S-f00' });
  assert.equal(by['code:a.mjs'].severity, 'high');
});

test('guardView: counts per type, new first, the trend = open findings by the day first seen, the ledger summary', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  const rows = [
    { id: 'a', type: 'memory', severity: 'low', first_seen: '2026-11-01T00:00:00Z', new: false },
    { id: 'b', type: 'memory', severity: 'high', first_seen: '2026-11-10T00:00:00Z', new: false },
    { id: 'c', type: 'code', severity: 'high', first_seen: '2026-11-14T09:00:00Z', new: true },
    { id: 'd', type: 'tests', severity: 'medium', first_seen: null, new: false }];
  const v = guardView(rows, { rules: { prose: 4, repeated: 1, enforced: 2, retired: 0 }, now, days: 30 });
  assert.deepEqual(v.types.map(t => t.type), GUARD_TYPES.map(t => t[0]));
  const mem = v.types.find(t => t.type === 'memory');
  assert.deepEqual([mem.open, mem.warn, mem.new], [2, 1, 0]);
  assert.equal(v.new, 1);
  assert.deepEqual(v.rows.map(r => r.id), ['c', 'b', 'd', 'a'], 'new first, then severity');
  assert.equal(v.trend.days.length, 30);
  assert.equal(v.trend.days.at(-1), '2026-11-14');
  const ms = v.trend.series.find(s => s.key === 'memory');
  assert.equal(ms.points.find(p => p.x === '2026-11-05').y, 1);
  assert.equal(ms.points.at(-1).y, 2);
  assert.deepEqual(v.trend.series.map(s => s.key), ['code', 'tests', 'memory'], 'a type with no finding draws no line');
  assert.equal(v.trend.series.find(s => s.key === 'tests').points.at(-1).y, 1, 'never seen yet = seen today');
  assert.deepEqual(v.ledger, { prose: 4, repeated: 1, enforced: 2, retired: 0 });
});

test('the worst pick: a low row (path not found), even a new one, never outranks a warn-level finding in the order, his line or the best action', () => {
  const rows = rankRows([
    { id: 'q', type: 'rules', severity: 'low', new: true, why: 'a rule names a path git never had: C:/x/.superpowers/QUIET does not exist', go: { tab: 'instructions' } },
    { id: 'm', type: 'memory', severity: 'medium', new: false, why: 'MEMORY.md is over 200 lines.', go: { tab: 'instructions', ins: 'm' } },
    { id: 'h', type: 'tests', severity: 'high', new: false, why: 'a test is red.', go: { tab: 'tests' } },
    { id: 'n', type: 'docs', severity: 'medium', new: true, why: 'a doc is stale.', go: { tab: 'docs', doc: 1 } }]);
  assert.deepEqual(rows.map(r => r.id), ['n', 'h', 'm', 'q'], 'warn level first (new first inside it), low last');
  assert.match(orcLine({ rows }), /The worst: a doc is stale\./);
  assert.equal(bestAction(rows).row.id, 'n');
  assert.match(orcLine({ rows: rankRows(rows.filter(r => r.id !== 'n')) }), /The worst: a test is red\./, 'not the new low row');
});
