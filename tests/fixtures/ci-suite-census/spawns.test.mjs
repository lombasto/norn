// ci-suite --census fixture (tests/ci-suite.test.mjs): starts 2 git processes and 1 node process more than plain.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('census spawns: git twice', () => { for (let i = 0; i < 2; i++) assert.equal(spawnSync('git', ['--version']).status, 0); });
test('census spawns: node once', () => assert.equal(spawnSync(process.execPath, ['-e', '']).status, 0));
