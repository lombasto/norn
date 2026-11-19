// META-TEND TESTS: the fixture of `ci-suite --measure --coverage` (tests/ci-suite.test.mjs): one test with a subtest over crew.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { dwarfDisplay } from '../../../engine/lib/crew.mjs';

test('outer', async t => {
  await t.test('inner crew balin-2', () => assert.equal(dwarfDisplay('balin-2'), 'Balin II'));
});
