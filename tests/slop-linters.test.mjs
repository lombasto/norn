// NORN-DASH-1123 item 8 (SPEC 8, S1-S3): Slop's Linters section - per tool of slop/tools.mjs TOOLS, its pinned version + lock hash, its
// rules by level (BLOCK / WARN / shadow), its open findings and its could-not-run findings; the Rules part carries it and the page
// renders it inside the Rules view (still four views). Synthetic rows only; the rules dir and tools/ are the repo's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lintersView } from '../engine/lib/slop/linters.mjs';
import { guardRows, guardView } from '../engine/lib/guardview.mjs';
import { GUARD_SUBS, guardPart, guardSummary } from '../engine/dash/guardparts.mjs';
import { slopPage } from '../engine/dash/pages/slop.mjs';

const hold = blocks => ({ branch: 'norn/a/demo', run: 'RUN-a-1', lane: 'demo', blocks });
const ROWS = () => guardRows({ holds: [hold([
  { fp: 'f1', rule: 'LJ/no-console', file: 'src/a.mjs', line: 3, msg: 'Unexpected console statement.' },
  { fp: 'f2', rule: 'LJ/no-console', file: 'src/b.mjs', line: 1, msg: 'Unexpected console statement.' },
  { fp: 'f3', rule: 'LJ', file: '*', line: 0, msg: 'could not run: the eslint install failed (no network)' },
  { fp: 'f4', rule: 'K1', file: 'src/c.mjs', line: 2, msg: 'a stray token' }])] });

test('lintersView (S1): the real rules dir lists eslint 10.15.0 from tools/lint with a lock hash and LJ\'s levels', () => {
  const [t, ...more] = lintersView([]).tools;
  assert.deepEqual(more.map(m => m.tool), ['ast-grep', 'gitleaks'], 'the tool sets of TOOLS, then the pinned scanners (slop-secrets.test.mjs)');
  assert.deepEqual([t.tool, t.set, t.version, t.rules], ['eslint', 'lint', '10.15.0', ['LJ']]);
  assert.match(t.lock, /^[0-9a-f]{12}$/);
  for (const r of ['no-unused-vars', 'no-duplicate-imports', 'no-debugger', 'no-console', 'no-warning-comments', 'no-restricted-properties']) assert.ok(t.levels.BLOCK.includes(r), r);
  assert.deepEqual(t.levels.WARN, ['*']); assert.deepEqual(t.levels.shadow, ['*']);
  assert.deepEqual([t.open.n, t.could_not_run], [0, []]);
});

test('lintersView (S2): a could-not-run row lands under its tool with its why; its other findings count per rule; a non-lint rule stays out', () => {
  const t = lintersView(ROWS()).tools[0];
  assert.deepEqual(t.could_not_run, [{ id: 'S-f3', rule: 'LJ', why: 'the eslint install failed (no network)', branch: 'norn/a/demo' }]);
  assert.equal(t.open.n, 2);
  assert.deepEqual(t.open.by, { 'no-console': 2 });
  assert.deepEqual(t.open.ids, ['S-f1', 'S-f2']);
});

test('guard view + Rules part (S3): linters rides the guard view into the rules part; the page renders it in the Rules view; four views', () => {
  const g = { ...guardView(ROWS()), project: 'demo' };
  assert.equal(g.linters.tools[0].tool, 'eslint');
  const P = guardPart(g, 'rules');
  assert.deepEqual(P.rules.linters, g.linters);
  assert.equal(GUARD_SUBS.length, 4);
  const html = slopPage({ ...guardSummary(g), sub: 'rules', rules: P.rules });
  const sec = html.slice(html.indexOf('id="slop-linters"'));
  assert.ok(html.includes('id="slop-linters"'), 'the Linters section');
  assert.match(sec, /<h2>Linters/);
  assert.match(sec, /eslint 10\.15\.0/);
  assert.match(sec, /tools\/lint/);
  assert.match(sec, /BLOCK[\s\S]*no-unused-vars/);
  assert.match(sec, /shadow[\s\S]*every other rule/);
  assert.match(sec, /2 open/);
  assert.match(sec, /could not run: 1/);
  assert.match(sec, /the eslint install failed \(no network\)/);
  assert.doesNotMatch(html, /="linters"/, 'no fifth view');
});
