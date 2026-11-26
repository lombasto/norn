// ci-suite --census fixture (tests/ci-suite.test.mjs): starts no process of its own; its counts are the runner's own node processes.
import test from 'node:test';

test('census plain: no process', () => {});
