// RM-a-65: the Slop page's To fix view lists the stored refactoring targets (`norn code targets`, guardOf's targets part), each with
// its rank, its Scope and a "copy as brief" button that copies the whole brief text; nothing stored, no card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { slopPage } from '../engine/dash/pages/slop.mjs';

const brief = 'Split src/big.mjs: move one group out\n\nScope: src/big.mjs, src/big-b.mjs\nTests: tests/big.test.mjs\nDone: a, b live in src/big-b.mjs';
const targets = { at: '2026-11-25T10:00:00.000Z', stamp: { graph: 'abc123def456' }, rank_na: null,
  list: [{ kind: 'split', title: 'Split src/big.mjs: move one group out', rank: 0.82, scope: ['src/big.mjs', 'src/big-b.mjs'], text: brief },
    { kind: 'extract', title: 'Extract from run() in src/a.mjs', rank: null, scope: ['src/a.mjs'], text: 'Extract <run> & co' }] };
const page = d => slopPage({ sub: 'fix', fix: { batches: [] }, ...d });

test('the To fix view lists the top targets, each with its rank, its Scope and a copy-as-brief button holding the brief', () => {
  const html = page({ targets });
  assert.match(html, /<section class="card" id="slop-targets">/);
  assert.equal((html.match(/class="tgt"/g) || []).length, 2);
  assert.match(html, /Split src\/big\.mjs: move one group out/);
  assert.match(html, /fix first 0\.82/);
  assert.match(html, /fix first n\/a/);
  assert.match(html, /src\/big\.mjs, src\/big-b\.mjs/);
  const btn = html.match(/<button[^>]*data-act="copy-path"[^>]*>/g) || [];
  assert.equal(btn.length, 2);
  assert.match(btn[0], /aria-label="Copy as brief"/);
  assert.ok(btn[0].includes(`data-copy="Split src/big.mjs: move one group out\n\nScope: src/big.mjs, src/big-b.mjs`), 'the whole brief is copied');
  assert.ok(btn[1].includes('data-copy="Extract &lt;run&gt; &amp; co"'), 'the brief text is escaped');
  assert.match(html, /norn code targets/);
});

test('no stored targets: no card', () => {
  assert.doesNotMatch(page({ targets: null }), /slop-targets/);
  assert.doesNotMatch(page({ targets: { ...targets, list: [] } }), /slop-targets/);
});
