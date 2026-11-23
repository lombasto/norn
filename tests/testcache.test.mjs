// test-diet S1 item 2: the machine-wide test-result cache (engine/lib/testcache.mjs). Two runs asking for the same test file on the same
// content at once start ONE node process: the second waits for the first's result. A pass is reused, a changed import makes a new key,
// a fail is never reused, a lock left by a dead run is taken over. A temp repo with one slow test file that counts its own starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp } from './helpers/tmp.mjs';
import { repoIndex, keyOf, runCached, cacheLog, caseLog, caseIds, freshPass } from '../engine/lib/testcache.mjs';

const SLOW = `import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { v } from '../engine/m.mjs';
test('slow', async () => { fs.appendFileSync(process.env.COUNT_FILE, 'x\\n'); await new Promise(r => setTimeout(r, 1500)); assert.equal(v, 1); });
`;
function world() {
  const d = mkTmp('meta-tc-'), root = path.join(d, 'repo'), dir = path.join(d, 'cache'), count = path.join(d, 'count.txt');
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(root, 'engine'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tests', 'a.test.mjs'), SLOW);
  fs.writeFileSync(path.join(root, 'engine', 'm.mjs'), 'export const v = 1;\n');
  fs.writeFileSync(count, '');
  const starts = () => fs.readFileSync(count, 'utf8').split('\n').filter(Boolean).length;
  const me = Math.round(performance.timeOrigin);
  const go = (run, o = {}) => runCached('tests/a.test.mjs', { ix: repoIndex(root), dir, run, childEnv: { COUNT_FILE: count }, pollMs: 100, alive: () => true, start: () => me, ...o });
  return { root, dir, starts, go };
}

test('two runs at once on the same test and content: one node process, the second waits for its result; a third run reuses it', async () => {
  const w = world(), said = [];
  const [a, b] = await Promise.all([w.go('RUN-1'), w.go('RUN-2', { say: l => said.push(l) })]);
  assert.equal(w.starts(), 1, 'one node process ran the file');
  assert.deepEqual([a.how, a.ok, a.by], ['ran', true, 'RUN-1']);
  assert.deepEqual([b.how, b.ok, b.by], ['waited', true, 'RUN-1']);
  assert.equal(a.key, b.key);
  assert.equal(a.counts?.pass, 1);
  assert.match(said.join('\n'), /tests\/a\.test\.mjs: already running in RUN-1 on the same content .* waiting for its result instead of a second copy/);
  const c = await w.go('RUN-3');
  assert.deepEqual([c.how, c.ok, c.by, w.starts()], ['reused', true, 'RUN-1', 1]);
  assert.ok(c.saved_ms > 1000, `a reuse spares the file's run time (${c.saved_ms} ms)`);
  const log = cacheLog(w.dir);
  assert.deepEqual(log.map(r => [r.run, r.how, r.ok]), [['RUN-1', 'ran', true], ['RUN-2', 'waited', true], ['RUN-3', 'reused', true]]);
  assert.ok(log.every(r => r.key === a.key && r.file === 'tests/a.test.mjs'));
  assert.equal(fs.readdirSync(w.dir).filter(n => n.endsWith('.lock')).length, 0, 'the lock is freed');
});

test('an edited import is a new key and runs again; a fail is never reused; a lock left by a dead run is taken over', async () => {
  const w = world();
  const k1 = keyOf('tests/a.test.mjs', repoIndex(w.root)).key;
  assert.equal(keyOf('tests/a.test.mjs', repoIndex(w.root)).key, k1, 'the key is stable');
  assert.ok(keyOf('tests/a.test.mjs', repoIndex(w.root)).deps >= 2, 'the test and the module it imports');
  assert.notEqual(keyOf('tests/a.test.mjs', repoIndex(w.root), 'browser').key, k1, 'extra (the browser mode) is part of the key');
  fs.writeFileSync(path.join(w.root, 'engine', 'm.mjs'), 'export const v = 2;\n');
  assert.notEqual(keyOf('tests/a.test.mjs', repoIndex(w.root)).key, k1);
  const kRun = () => keyOf('tests/a.test.mjs', repoIndex(w.root), '\0').key;   // runCached's extra: the browser mode \0 the node flags
  const k2 = kRun();
  const r1 = await w.go('RUN-1');
  assert.deepEqual([r1.how, r1.ok, r1.key], ['ran', false, k2]);
  assert.match(r1.tail, /strictly equal/, 'a red carries its output tail');
  assert.equal(freshPass(w.dir, k2), null);
  const r2 = await w.go('RUN-2');
  assert.deepEqual([r2.how, r2.ok, w.starts()], ['ran', false, 2], 'the fail ran again');
  // back to the passing content, with a lock a dead run left behind
  fs.writeFileSync(path.join(w.root, 'engine', 'm.mjs'), 'export const v = 1;\n');
  const k3 = kRun();
  fs.writeFileSync(path.join(w.dir, `${k3}.lock`), JSON.stringify({ pid: 999999, started: 1, run: 'RUN-dead', file: 'tests/a.test.mjs', at: '2026-11-20T00:00:00Z' }));
  const r3 = await w.go('RUN-3', { alive: () => false });
  assert.deepEqual([r3.how, r3.ok, r3.key, w.starts()], ['ran', true, k3, 3]);
  assert.equal(fs.existsSync(path.join(w.dir, `${k3}.lock`)), false);
  assert.deepEqual(cacheLog(w.dir).map(r => r.how), ['ran', 'ran', 'ran']);
});

// SPEC dash-owner-1123 s.1.1 / T3: per-case times ride a second reporter that runNode adds itself - the key is still keyOf(file, extra \0 node flags)
test('runCached records per-case times: the result json and cases.jsonl get one row per case; a reuse adds none; the key is unchanged', async () => {
  const w = world();
  fs.writeFileSync(path.join(w.root, 'tests', 'a.test.mjs'), `import test from 'node:test';
test('casecheck: fast', () => {});
test('casecheck: busy 30 ms', () => { const t = Date.now(); while (Date.now() - t < 30); });
`);
  const r1 = await w.go('RUN-1', { env: { ...process.env, META_RUN_STATE: path.join(w.root, 'st', 'kestrel') } });
  assert.deepEqual([r1.how, r1.ok, r1.counts?.pass], ['ran', true, 2]);
  assert.equal(r1.key, keyOf('tests/a.test.mjs', repoIndex(w.root), '\0').key, 'the reporter arguments are not part of the key');
  const res = freshPass(w.dir, r1.key);
  assert.deepEqual(res.cases.map(c => [c.id, c.line, c.ok]), [['tests/a.test.mjs::casecheck: fast', 2, true], ['tests/a.test.mjs::casecheck: busy 30 ms', 3, true]]);
  assert.ok(res.cases[1].ms >= 29, `the busy case took its 30 ms (${res.cases[1].ms})`);
  const rows = caseLog(w.dir);
  assert.deepEqual(rows.map(r => [r.run, r.state, r.file, r.id, r.ok]), [['RUN-1', 'kestrel', 'tests/a.test.mjs', 'tests/a.test.mjs::casecheck: fast', true], ['RUN-1', 'kestrel', 'tests/a.test.mjs', 'tests/a.test.mjs::casecheck: busy 30 ms', true]]);
  assert.equal((await w.go('RUN-2')).how, 'reused');
  assert.equal(caseLog(w.dir).length, 2, 'a reused file did not run: no row');
});

test('caseIds: subtests end before their parent; each gets its title path', () => {
  const rows = [{ name: 'one', nesting: 0, line: 2, ms: 1, ok: true }, { name: 'deep', nesting: 2, line: 4, ms: 1, ok: false }, { name: 'two', nesting: 1, line: 3, ms: 1, ok: true },
    { name: 'three', nesting: 1, line: 5, ms: 1, ok: true }, { name: 'outer', nesting: 0, line: 3, ms: 3, ok: false }];
  assert.deepEqual(caseIds('tests/a.test.mjs', rows).map(c => c.id.split('::').slice(1).join('::')), ['one', 'outer::two::deep', 'outer::two', 'outer::three', 'outer']);
});
