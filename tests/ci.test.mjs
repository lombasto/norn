// S8 + META-GTP-CI 3 CI workflow lint (no actionlint on this machine; Node built-ins only): the workflow runs `norn smoke` on the three desktop
// OSes, and ONLY on demand or on a push to main - a lane branch push must start no hosted run (spending is owner-only).
// META-PR-FAST (RM-29): a pull request runs only pr.yml's fast check; the full suite runs on a push to main and nightly (ci.yml).
// reads: .github/workflows/*.yml
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
function common(t, name, conc = [`group: ${name}-\${{ github.ref }}`, 'cancel-in-progress: true']) {
  assert.ok(!t.includes('\t'), `${name}: tabs in YAML`);
  assert.deepEqual(block(t, 'permissions').map(l => l.trim()), ['contents: read'], name);
  assert.deepEqual(block(t, 'concurrency').map(l => l.trim()), conc, name);
  const jobs = block(t, 'jobs');
  assert.ok(jobs.some(l => l.trim() === 'os: [windows-latest, ubuntu-latest]'), `${name}: Windows + Linux hosted legs`);
  assert.ok(jobs.some(l => l.trim() === 'runs-on: ${{ matrix.os }}'), name);
  assert.doesNotMatch(t, /self-hosted/, `${name}: no self-hosted runner`);
  assert.ok(jobs.some(l => l.trim() === '- uses: actions/setup-node@v4') && /node-version: (2[2-9]|[3-9]\d)\b/.test(t), `${name}: node >= 22`);
  return jobs.map(l => l.trim());
}

// RM-26 S0 (DEC-a-651 Q6): a dispatch is its own concurrency group and nothing cancels a running suite; the per-file time JSON is an
// artifact on both legs; the census runs only on a dispatch that asks for it (census input), never on a push or the nightly.
test('ci.yml: push to main + nightly + dispatch, never a pull request; the full suite via ci-suite on both hosted legs', () => {
  const t = WF('ci.yml');
  const on = block(t, 'on');
  assert.deepEqual(on.filter(l => /^ {2}\S/.test(l)).map(l => l.trim()), ['push:', 'schedule:', 'workflow_dispatch:']);
  assert.ok(on.some(l => l.trim() === 'branches: [main]') && on.some(l => l.trim() === "- cron: '0 6 * * *'"));
  assert.doesNotMatch(t, /^\s*(pull_request|pull_request_target):/m);
  const jobs = common(t, 'ci', ["group: ci-${{ github.event_name == 'workflow_dispatch' && github.run_id || github.ref }}", 'cancel-in-progress: false']);
  const at = jobs.indexOf('run: node engine/bin/ci-suite.mjs --json "$RUNNER_TEMP/ci-times.json" $CENSUS');
  assert.ok(at > 0 && jobs[at - 1] === "CENSUS: ${{ github.event_name == 'workflow_dispatch' && inputs.census && '--census' || '' }}", 'the census only on a dispatch asking for it');
  const up = jobs.indexOf('- name: upload the per-file times');
  assert.deepEqual(jobs.slice(up + 1, up + 6), ['if: ${{ always() && !matrix.code_rs_only }}', 'uses: actions/upload-artifact@v4', 'with:',
    'name: ci-times-${{ matrix.os }}', 'path: ${{ runner.temp }}/ci-times.json'], 'the times JSON uploaded on both legs, red or green');
  assert.ok(up > at);
  const inp = on.map(l => l.trim()), ci = inp.indexOf('census:');
  assert.deepEqual(inp.slice(ci + 1, ci + 4).filter(l => !l.startsWith('description:')), ['type: boolean', 'default: false']);
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
  assert.deepEqual(s.slice(at + 1, at + 7), ['env:', 'META_ROOT: ${{ runner.temp }}/norn', 'shell: bash', 'run: |', 'base=$(git merge-base "origin/${{ github.base_ref }}" HEAD)',
    'node engine/bin/norn.mjs slop check --ci --diff "$base..HEAD"']);
  assert.ok(jobs.some(l => l.trim() === 'ref: ${{ github.event.pull_request.head.sha }}'), 'slop checks out the PR head');
  assert.equal(jobs.filter(l => l.trim() === 'fetch-depth: 0').length, 2, 'slop and tests diff against the base: full history');
  const code = t.split(/\r?\n/).filter(l => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(code, /retry|retries|continue-on-error/i, 'never retries');
});

// NORN-CI-SLOP-BUILD: the slop check reads the code graph (K10), so norn-code must exist in the clone's store before it runs, built by
// Norn's own part build (rustbin ensurePart), never skipped; smoke shares the step pattern for both parts. The cache is keyed by the
// parts' sources (target/ left out), so a PR that does not touch Rust builds nothing.
test('pr.yml: slop and smoke build their Rust parts through ensurePart before their check, cached by the parts\' sources', () => {
  const lines = WF('pr.yml').split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#')).map(l => l.trim());
  const job = n => { const i = lines.indexOf(`${n}:`), j = lines.findIndex((l, k) => k > i && /^(slop|smoke|tests):$/.test(l)); return lines.slice(i + 1, j < 0 ? undefined : j); };
  const key = parts => `key: rust-${parts.join('-')}-\${{ runner.os }}-\${{ runner.arch }}-\${{ hashFiles(${parts.map(p => `'engine/${p}-rs/**', '!engine/${p}-rs/target/**'`).join(', ')}) }}`;
  for (const [n, parts, check] of [['slop', ['code'], "- name: slop check of the PR's diff from its merge base"], ['smoke', ['hook', 'code'], '- name: norn smoke']]) {
    const s = job(n), c = s.indexOf('path: .git/norn/rust/bin'), b = s.findIndex(l => l.startsWith("- name: Norn's Rust parts")), at = s.indexOf(check);
    assert.ok(c > 0 && s[c - 2] === '- uses: actions/cache@v4' && s[c + 1] === key(parts), `${n}: the store's bin/ cached by the parts' sources`);
    assert.ok(b > c && b < at, `${n}: the build step runs after the cache restore, before the check`);
    assert.deepEqual(s.slice(b + 1, b + 5), ['env:', `PARTS: ${parts.join(' ')}`, 'shell: bash', 'run: |'], n);
    const body = s.slice(b + 5, at);
    assert.ok(body.some(l => l === 'import { ensurePart, binOf } from "./engine/lib/rustbin.mjs";') && body.some(l => /ensurePart\(p, /.test(l)), `${n}: Norn's part build`);
    assert.ok(body.some(l => l.includes('process.exit(1)')), `${n}: a part that cannot be had fails the step`);
  }
  assert.ok(!job('tests').some(l => /norn\/rust|ensurePart/.test(l)), 'the tests job needs no part');
});

// A workflow-level env (indent 0) or job-level env (indent 4) offers only github, needs, strategy, matrix, vars, secrets and inputs:
// naming runner, job, steps or env there makes GitHub reject the whole file and start nothing (pr.yml from 11-20 to META-PR-YML-ENV).
test('every workflow: no workflow- or job-level env names a context GitHub does not offer there (runner, job, steps, env)', () => {
  const bad = [];
  for (const n of fs.readdirSync(path.dirname(F)).filter(n => /\.ya?ml$/.test(n))) {
    const lines = WF(n).split(/\r?\n/);
    lines.forEach((l, i) => {
      const m = /^( {0}| {4})env:\s*$/.exec(l); if (!m) return;
      if (m[1].length === 4 && lines.slice(0, i).reverse().find(x => /^\S/.test(x) && !x.startsWith('#')) !== 'jobs:') return;
      for (let j = i + 1; j < lines.length; j++) {
        const x = lines[j]; if (!x.trim() || x.trim().startsWith('#')) continue;
        if (x.length - x.trimStart().length <= m[1].length) break;
        if (/\$\{\{[^}]*\b(runner|job|steps|env)\./.test(x)) bad.push(`${n}:${j + 1}: ${x.trim()}`);
      }
    });
  }
  assert.deepEqual(bad, [], 'a workflow- or job-level env names a context it does not have; set it on the step instead');
  // pr.yml's META_ROOT sits inside a step (indent 8 or more), where `runner` exists
  const mr = WF('pr.yml').split(/\r?\n/).filter(l => /^\s*META_ROOT:/.test(l));
  assert.equal(mr.length, 1); assert.match(mr[0], /^ {8,}META_ROOT: \$\{\{ runner\.temp \}\}\/norn$/);
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
