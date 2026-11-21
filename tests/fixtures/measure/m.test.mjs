// META-TEND TESTS: the fixture of `ci-suite --measure --coverage` (tests/ci-suite.test.mjs): one test with a subtest over crew.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { slugOf } from '../../../engine/lib/crew.mjs';

test('outer', async t => {
  await t.test('inner crew slug', () => assert.equal(slugOf('Brakdun son of Haldur'), 'brakdun-son-of-haldur'));
});
