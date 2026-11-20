// META-CIWATCH: a red CI run on the project's main is a gate fact (wakes the check-in once per red run) and a level-triggered
// digest row (run, sha, failing tests) that leaves only when a LATER run on main is green. Injected gh, temp state only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { record } from '../engine/lib/records.mjs';
import { checkinGate, noteCheckin } from '../engine/lib/gate.mjs';
import { gateProbes } from '../engine/lib/tick.mjs';
import { digest } from '../engine/lib/digest.mjs';
import { renderDigest } from '../engine/lib/views.mjs';
import { ciMain, ciProbe, redRun, failedTests, CI_TTL_MS } from '../engine/lib/ciwatch.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const tmp = p => mkTmp(p);
const T0 = Date.parse('2026-11-09T18:00:00Z');
const min = m => new Date(T0 + m * 60000);
const run = (id, conclusion, created, sha = `${id}abcdef0123456789`) => ({ databaseId: id, conclusion, status: conclusion ? 'completed' : 'in_progress', headSha: sha, createdAt: created });
const LOG = [
  'suite (self-hosted, Windows, X64)\tsuite (fails only on a red not in tests/KNOWN-REDS.txt)\t2026-11-09T17:56:51.4959267Z ✖ failing tests:',
  'suite (self-hosted, Windows, X64)\tsuite\t2026-11-09T17:56:51.4960022Z ✖ CLI: norn run --after/--inputs queues (met now -> started at once) (1764.7464ms)',
  'suite (self-hosted, Windows, X64)\tsuite\t2026-11-09T17:56:51.49Z NEW RED: tests/queue-after.test.mjs :: CLI: norn run --after/--inputs queues (met now -> started at once)',
  'suite (self-hosted, Linux, X64)\tsuite\t2026-11-09T17:56:52.10Z NEW RED: tests/gate.test.mjs :: tick: a minor wake runs the reduced prompt',
  'suite (self-hosted, Linux, X64)\tsuite\t2026-11-09T17:56:52.11Z ci-suite: 0 listed red(s), 1 new',
].join('\n');

// a fake gh: `runs` is the list it answers (newest first, as gh does); every call is counted by verb
function fakeGh(runs, { log = LOG } = {}) {
  const g = args => {
    g.calls.push(args.slice(0, 2).join(' '));
    if (args[0] === 'run' && args[1] === 'list') return JSON.stringify(g.runs);
    if (args[0] === 'run' && args[1] === 'view') { assert.ok(args.includes('--log-failed')); return log; }
    throw new Error('unexpected gh ' + args.join(' '));
  };
  g.runs = runs; g.calls = [];
  return g;
}

test('redRun: the newest failure with no success after it; in-progress / cancelled runs neither clear nor raise it', () => {
  assert.equal(redRun([]), null);
  assert.equal(redRun([run(3, 'success', '2026-11-09T18:06:00Z'), run(2, 'failure', '2026-11-09T17:43:00Z')]), null, 'a later green clears it');
  assert.equal(redRun([run(3, '', '2026-11-09T18:06:00Z'), run(4, 'cancelled', '2026-11-09T18:01:00Z'), run(2, 'failure', '2026-11-09T17:43:00Z')]).databaseId, 2);
  assert.equal(redRun([run(5, 'failure', '2026-11-09T18:10:00Z'), run(2, 'failure', '2026-11-09T17:43:00Z')]).databaseId, 5, 'the newest red');
  assert.equal(redRun([run(2, 'failure', '2026-11-09T17:43:00Z'), run(3, 'success', '2026-11-09T18:06:00Z')]), null, 'order by createdAt, not list position');
});

test('failedTests: the ci-suite NEW RED lines (file :: name), else the node runner\'s failing-test list; deduped, prefixes stripped', () => {
  assert.deepEqual(failedTests(LOG), ['tests/queue-after.test.mjs :: CLI: norn run --after/--inputs queues (met now -> started at once)',
    'tests/gate.test.mjs :: tick: a minor wake runs the reduced prompt']);
  const plain = 'x\ty\t2026Z ✖ failing tests:\nx\ty\t2026Z \nx\ty\t2026Z test at tests/a.test.mjs:9:1\nx\ty\t2026Z ✖ a thing breaks (12.5ms)\nx\ty\t2026Z ✖ a thing breaks (12.5ms)\n';
  assert.deepEqual(failedTests(plain), ['a thing breaks']);
  assert.deepEqual(failedTests('no failures here'), []);
});

test('ciMain: one gh call per call at most - the list once per 10 min, the failed log once per red run; gh absent = no red, never a throw', () => {
  const t = tmp('meta-ciw-'), cacheFile = path.join(t, 'ci-main.json');
  const gh = fakeGh([run(42667438887, 'failure', '2026-11-09T17:43:00Z'), run(42663820965, 'success', '2026-11-09T17:00:00Z')]);
  const o = { repo: 'example/norn', cacheFile, gh };
  let c = ciMain({ ...o, now: min(0) });
  assert.deepEqual(gh.calls, ['run list']);
  assert.equal(c.red.databaseId, 42667438887); assert.equal(c.red.seen, min(0).toISOString(), 'first seen = when Norn first read it red');
  assert.equal(c.red.failing, null, 'names not read yet');
  c = ciMain({ ...o, now: min(1) });
  assert.deepEqual(gh.calls, ['run list', 'run view'], 'the failed log, once');
  assert.equal(c.red.failing.length, 2); assert.equal(c.red.seen, min(0).toISOString());
  for (const m of [2, 5, 9]) c = ciMain({ ...o, now: min(m) });
  assert.equal(gh.calls.length, 2, 'cached: no call inside 10 min');
  gh.runs = [run(42668000000, '', '2026-11-09T18:05:00Z'), ...gh.runs];
  c = ciMain({ ...o, now: new Date(T0 + CI_TTL_MS) });
  assert.deepEqual(gh.calls.slice(2), ['run list']); assert.equal(c.red.databaseId, 42667438887, 'in progress after the red: still red');
  assert.equal(c.red.failing.length, 2, 'names kept for the same red run'); assert.equal(c.latest.databaseId, 42668000000);
  gh.runs[0] = run(42668000000, 'success', '2026-11-09T18:05:00Z');
  c = ciMain({ ...o, now: new Date(T0 + 2 * CI_TTL_MS) });
  assert.equal(c.red, null, 'a later green clears it');
  // gh absent / logged out: nothing red, nothing thrown, retried only after the TTL
  let n = 0;
  const broken = () => { n++; throw new Error('gh: not logged in'); };
  const b = { repo: 'o/r', gh: broken, cacheFile: path.join(t, 'broken.json') };
  assert.equal(ciMain({ ...b, now: min(0) }).red, null);
  assert.equal(ciMain({ ...b, now: min(3) }).red, null);
  assert.equal(n, 1);
  // a failed log read leaves the names unknown and is retried after the TTL, not on every call
  const g2 = fakeGh([run(7, 'failure', '2026-11-09T17:43:00Z')]);
  const b2 = { repo: 'o/r', cacheFile: path.join(t, 'g2.json') };
  ciMain({ ...b2, gh: g2, now: min(0) });
  assert.equal(ciMain({ ...b2, gh: broken, now: min(1) }).red.failing, null);
  ciMain({ ...b2, gh: broken, now: min(2) });
  assert.equal(n, 2, 'one failed log read inside the TTL');
});

test('gate fact: a red main run wakes the check-in once (ci:red:<run>, MAJOR); the same red does not re-wake; green leaving is no news; a new red wakes', () => {
  const state = path.join(tmp('meta-ciwg-'), 'state', 'demo');
  const gh = fakeGh([run(100, 'success', '2026-11-09T17:00:00Z')]);
  const p = { name: 'demo', state, ci: { repo: 'o/r', gh } };
  const B = { max_claude_workers: 2 }, LIVE = { band: 1, rate_ok: 1, rate_band: 0, quiet: false };
  const baseline = m => {
    const c = record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'checkin', executor: 'fake', lane: 'checkin' } }, { now: () => min(m), run: null });
    noteCheckin(state, { run: c.id, start: min(m).toISOString(), live: LIVE, budget: B });
    record(state, { kind: 'run', ev: 'end', id: c.id, by: 'launcher', data: { outcome: 'done', exit: 0 } }, { now: () => min(m + 1), run: null });
  };
  const gate = m => checkinGate({ state, budget: B, live: LIVE, now: min(m), probes: [ciProbe(p, { now: min(m) })] });
  baseline(0);
  assert.equal(gate(5).run, false, 'green main: no fact');
  gh.runs = [run(101, 'failure', '2026-11-09T18:08:00Z'), ...gh.runs];
  const g = gate(16);   // the 10-min cache (read at 5) expired: the tick reads the red run
  assert.equal(g.run, true); assert.equal(g.cls, 'major'); assert.deepEqual(g.changes, ['+ci:red:101']);
  baseline(17);
  assert.equal(gate(20).run, false, 'the check-in that started after it saw it: no second wake for the same red run');
  gh.runs = [run(102, 'success', '2026-11-09T18:20:00Z'), ...gh.runs];
  assert.equal(gate(30).run, false, 'green again: the row leaves, no wake');
  gh.runs = [run(103, 'failure', '2026-11-09T18:30:00Z'), ...gh.runs];
  assert.deepEqual(gate(41).changes, ['+ci:red:103'], 'a new red run wakes again');
  // the tick wires it: a project with `ci` gets the probe, one without does not
  assert.ok(gateProbes(p, {}).some(f => (f({ at: min(42).getTime(), running: [], runs: [], items: [] }) || []).includes('ci:red:103')));
  assert.ok(!gateProbes({ name: 'x', state }, {}).some(f => (f({ at: min(42).getTime(), running: [], runs: [], items: [] }) || []).some(x => x.startsWith('ci:'))));
  // gh absent: no fact, no throw
  const off = { name: 'demo', state: path.join(tmp('meta-ciwo-'), 'state', 'demo'), ci: { repo: 'o/r', gh: () => { throw new Error('ENOENT gh'); } } };
  assert.deepEqual(ciProbe(off, { now: min(0) })({ at: min(0).getTime() }), []);
});

test('digest: a CI-red row (run, sha, failing tests) while main is red; it leaves only when a later run on main is green', () => {
  const state = path.join(tmp('meta-ciwd-'), 'state', 'demo');
  fs.mkdirSync(state, { recursive: true });
  const gh = fakeGh([run(42667438887, 'failure', '2026-11-09T17:43:00Z', 'e48344a0123456789')]);
  const p = { name: 'demo', state, ci: { repo: 'example/norn', gh } };
  const opt = m => ({ now: T0 + m * 60000, dlv: [], evalAfter: () => ({ met: false, gone: false }), ready: [] });
  let d = digest(state, p, opt(0));
  assert.deepEqual(d.sections.ci.map(r => [r.id, r.run, r.sha, r.failing]), [['CI-42667438887', 42667438887, 'e48344a0123456789', null]]);
  assert.equal(d.counts.ci, 1);
  d = digest(state, p, opt(1));   // second read: the failing tests
  assert.deepEqual(d.sections.ci[0].failing, failedTests(LOG));
  const md = renderDigest(d);
  assert.match(md, /CI red on main \(1\)/);
  assert.match(md, /CI-42667438887 example\/norn run 42667438887 e48344a01 failure created 2026-11-09T17:43:00Z/);
  assert.match(md, /tests\/queue-after\.test\.mjs :: CLI: norn run/);
  assert.match(md, /fix task \(never a re-run\): fix it on lane ci-fix stage CI-42667438887 round 1 - META rec add lane --name ci-fix/, 'the ONE ci-fix lane (lifecycle.mjs ciFixPlan)');
  gh.runs = [run(42668000000, '', '2026-11-09T18:05:00Z'), ...gh.runs];
  assert.equal(digest(state, p, opt(11)).sections.ci.length, 1, 'still red while the next run is in progress');
  gh.runs[0] = run(42668000000, 'success', '2026-11-09T18:05:00Z');
  assert.deepEqual(digest(state, p, opt(22)).sections.ci, [], 'a later green run: the row leaves');
  assert.deepEqual(digest(state, { name: 'noci', state }, opt(0)).sections.ci, [], 'no ci key: no section rows');
});
