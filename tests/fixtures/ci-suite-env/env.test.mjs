// Fixture for tests/ci-suite.test.mjs: the identity a calling Norn run / agent CLI carries in its env never reaches the suite.
import test from 'node:test';
import assert from 'node:assert/strict';

const CALLER = ['META_RUN_ID', 'META_RUN_STATE', 'META_ROLE', 'META_STATE', 'META_PROJECT', 'META_SESSION_ID', 'META_RESUMES', 'META_NOTES', 'META_JOB',
  'META_PARENT_RUN', 'META_RESULT_DIR', 'META_RESULT', 'CLAUDECODE'];
test('the suite runs without the caller run identity', () => {
  for (const k of CALLER) assert.equal(process.env[k], undefined, `${k} leaked into the suite`);
});
