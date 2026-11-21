// S8 + META-GTP-CI 3 CI workflow lint (no actionlint on this machine; Node built-ins only): the workflow runs `norn smoke` on the three desktop
// OSes, and ONLY on demand or on a push to main - a lane branch push must start no hosted run (spending is owner-only).
// META-PR-FAST (RM-29): a pull request runs only pr.yml's fast check; the full suite runs on a push to main and nightly (ci.yml).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const F = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', 'smoke.yml');

// top-level block of a 2-space YAML file: the lines under `key:` until the next unindented key
function block(text, key) {
  const lines = text.split(/\r?\n/), i = lines.findIndex(l => l === key + ':');
  assert.ok(i >= 0, `no top-level ${key}:`);
  const out = [];
  for (const l of lines.slice(i + 1)) { if (/^\S/.test(l)) break; if (l.trim() && !l.trim().startsWith('#')) out.push(l); }
  return out;
}

test('smoke workflow: triggers are workflow_dispatch + push to main only; matrix = windows / ubuntu / macos; runs norn smoke', () => {
  const t = fs.readFileSync(F, 'utf8');
  assert.ok(!t.includes('\t'), 'tabs in YAML');
  const on = block(t, 'on');
  const triggers = on.filter(l => /^ {2}\S/.test(l)).map(l => l.trim().replace(/:.*$/, ''));
  assert.deepEqual(triggers, ['workflow_dispatch', 'push']);
  assert.deepEqual(on.filter(l => /^ {4}\S/.test(l)).map(l => l.trim()), ['branches: [main]']);
  assert.doesNotMatch(t, /^\s*(pull_request|schedule|workflow_run|pull_request_target):/m);
  const jobs = block(t, 'jobs');
  const os = jobs.find(l => l.trim().startsWith('os:'));
  assert.equal(os?.trim(), 'os: [windows-latest, ubuntu-latest, macos-latest]');
  assert.ok(jobs.some(l => l.trim() === 'runs-on: ${{ matrix.os }}'));
  assert.ok(jobs.some(l => l.trim() === 'run: node engine/bin/norn.mjs smoke'));
  assert.ok(jobs.some(l => /node-version: (2[2-9]|[3-9]\d)\b/.test(l)), 'node >= 22 (setup requires it)');
  assert.deepEqual(block(t, 'permissions').map(l => l.trim()), ['contents: read']);
});

// ---------- ci.yml + nightly.yml on GitHub-hosted runners ----------
const WF = n => fs.readFileSync(path.join(path.dirname(F), n), 'utf8');
function common(t, name) {
  assert.ok(!t.includes('\t'), `${name}: tabs in YAML`);
  assert.deepEqual(block(t, 'permissions').map(l => l.trim()), ['contents: read'], name);
  assert.deepEqual(block(t, 'concurrency').map(l => l.trim()), [`group: ${name}-\${{ github.ref }}`, 'cancel-in-progress: true'], name);
  const jobs = block(t, 'jobs');
  assert.ok(jobs.some(l => l.trim() === 'os: [windows-latest, ubuntu-latest]'), `${name}: Windows + Linux hosted legs`);
  assert.ok(jobs.some(l => l.trim() === 'runs-on: ${{ matrix.os }}'), name);
  assert.doesNotMatch(t, /self-hosted/, `${name}: no self-hosted runner`);
  assert.ok(jobs.some(l => l.trim() === '- uses: actions/setup-node@v4') && /node-version: (2[2-9]|[3-9]\d)\b/.test(t), `${name}: node >= 22`);
  return jobs.map(l => l.trim());
}

test('ci.yml: push to main + nightly + dispatch, never a pull request; the full suite via ci-suite on both hosted legs', () => {
  const t = WF('ci.yml');
  const on = block(t, 'on');
  assert.deepEqual(on.filter(l => /^ {2}\S/.test(l)).map(l => l.trim()), ['push:', 'schedule:', 'workflow_dispatch:']);
  assert.ok(on.some(l => l.trim() === 'branches: [main]') && on.some(l => l.trim() === "- cron: '0 6 * * *'"));
  assert.doesNotMatch(t, /^\s*(pull_request|pull_request_target):/m);
  assert.ok(common(t, 'ci').includes('run: node engine/bin/ci-suite.mjs'));
});

test('pr.yml: pull_request only; slop of the diff, norn smoke and ci-suite --changed run as three side-by-side Linux jobs; no full suite', () => {
  const t = WF('pr.yml');
  assert.ok(!t.includes('\t'), 'tabs in YAML');
  assert.deepEqual(block(t, 'on').map(l => l.trim()), ['pull_request:']);
  assert.deepEqual(block(t, 'permissions').map(l => l.trim()), ['contents: read']);
  assert.deepEqual(block(t, 'concurrency').map(l => l.trim()), ['group: pr-${{ github.ref }}', 'cancel-in-progress: true']);
  const jobs = block(t, 'jobs'), names = jobs.filter(l => /^ {2}\S/.test(l)).map(l => l.trim());
  assert.deepEqual(names, ['slop:', 'smoke:', 'tests:']);
  assert.doesNotMatch(t, /needs:/, 'the three jobs run side by side');
  assert.equal(jobs.filter(l => l.trim() === 'runs-on: ubuntu-latest').length, 3);
  const runs = jobs.map(l => l.trim()).filter(l => l.startsWith('run: '));
  assert.deepEqual(runs.filter(l => /norn\.mjs|ci-suite/.test(l)), ['run: node engine/bin/norn.mjs smoke',
    'run: node engine/bin/ci-suite.mjs --changed "origin/${{ github.base_ref }}" --concurrency 4']);
  // slop (d3afd1fe): a `run: |` block - the PR head's diff from its merge base with the target, --ci (no machine-only rules)
  const s = jobs.map(l => l.trim()), at = s.indexOf('- name: slop check of the PR\'s diff from its merge base');
  assert.deepEqual(s.slice(at + 1, at + 5), ['shell: bash', 'run: |', 'base=$(git merge-base "origin/${{ github.base_ref }}" HEAD)',
    'node engine/bin/norn.mjs slop check --ci --diff "$base..HEAD"']);
  assert.ok(jobs.some(l => l.trim() === 'ref: ${{ github.event.pull_request.head.sha }}'), 'slop checks out the PR head');
  assert.equal(jobs.filter(l => l.trim() === 'fetch-depth: 0').length, 2, 'slop and tests diff against the base: full history');
  const code = t.split(/\r?\n/).filter(l => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(code, /retry|retries|continue-on-error/i, 'never retries');
});

test('only pr.yml runs on a pull request (DIR-2: no second job runs the full suite on a PR)', () => {
  const on = fs.readdirSync(path.dirname(F)).filter(n => /\.ya?ml$/.test(n) && block(WF(n), 'on').some(l => /^ {2}pull_request(_target)?:/.test(l)));
  assert.deepEqual(on, ['pr.yml']);
});

test('nightly.yml: cron 06:00 UTC + dispatch; e2e, norn smoke, the load-flaky set 3x on both legs; no retries', () => {
  const t = WF('nightly.yml');
  assert.deepEqual(block(t, 'on').map(l => l.trim()), ['schedule:', "- cron: '0 6 * * *'", 'workflow_dispatch:']);
  const jobs = common(t, 'nightly');
  assert.ok(jobs.includes('run: node --test "tests/e2e/*.test.mjs"'), 'e2e');
  assert.ok(jobs.includes('run: node engine/bin/norn.mjs smoke'), 'norn smoke');
  assert.ok(jobs.some(l => /--test-concurrency=3 tests\/agnostic\.test\.mjs tests\/delegate\.test\.mjs tests\/queue\.test\.mjs \|\| exit 1/.test(l)), 'load-flaky set 3x');
  const code = t.split(/\r?\n/).filter(l => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(code, /retry|retries|continue-on-error/i, 'never retries');
});
