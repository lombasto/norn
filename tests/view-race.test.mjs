// VIEW-RACE: several processes write one generated view at once (every supervisor's fill, the tick, `norn status`, the dash server).
// Unlocked, one writer took another's fresh text for a hand edit (a false "changed outside Norn" notice, the view frozen). Now one lock
// per hash file + the recent Norn renders per file: no refusal between writers, an older Norn render is taken back with a record, and a
// real edit (header removed, or a body no recent render had) is still refused and listed. Temp state dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HEADER, RECENT, recentFile, writeGuarded, writeGuardedAsync } from '../engine/lib/views.mjs';
import { handEdits } from '../engine/lib/handedits.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'view-race-worker.mjs');
const setup = () => {
  const state = path.join(mkTmp('meta-view-race-'), 'state', 'demo'), vdir = path.join(state, 'views');
  fs.mkdirSync(vdir, { recursive: true });
  return { state, hf: path.join(vdir, 'queue-hashes.json'), file: path.join(state, 'META-QUEUE.md') };
};
const view = s => `${HEADER}\n# view\n\n${s}\n`;
const run = args => new Promise((res, rej) => {
  const c = spawn(process.execPath, [WORKER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { err += d; });
  c.on('error', rej); c.on('exit', code => (code === 0 ? res(JSON.parse(out)) : rej(new Error(`worker exit ${code}: ${err}`))));
});

test('two writers (child processes, one sync, one async) on one view: no refusal in 200 rounds each, no notice, no lock left', async () => {
  const { state, hf, file } = setup();
  const r = await Promise.all([run([hf, file, 'a', '200', 'sync']), run([hf, file, 'b', '200', 'async'])]);
  assert.deepEqual(r.map(x => x.refused), [0, 0], "neither writer took the other's text for a hand edit");
  assert.deepEqual(await handEdits(state), [], 'no Inbox notice');
  assert.ok(!fs.existsSync(hf + '.lock'), 'the lock is released');
  assert.match(fs.readFileSync(file, 'utf8'), /writer [ab] round 199/);
  assert.ok(JSON.parse(fs.readFileSync(recentFile(hf), 'utf8'))[path.resolve(file)].length <= RECENT, 'the history is capped');
});

test('a real edit is still refused and listed: the header removed, or a body no recent render had', async () => {
  const { state, hf, file } = setup();
  assert.equal(writeGuarded(hf, file, view('one')), 'written');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(HEADER + '\n', ''));
  assert.equal(writeGuarded(hf, file, view('two')), 'refused');
  assert.equal(await writeGuardedAsync(hf, file, view('two')), 'refused', 'the async writer too');
  let e = await handEdits(state);
  assert.equal(e.length, 1); assert.equal(e[0].generated, false);
  fs.writeFileSync(file, view('one') + 'my note\n');   // under an intact header: still a person's text
  assert.equal(writeGuarded(hf, file, view('two')), 'refused');
  e = await handEdits(state);
  assert.equal(e.length, 1); assert.equal(e[0].generated, true);
  assert.match(fs.readFileSync(file, 'utf8'), /my note/);
});

test('an older Norn render is taken back by Norn itself: written over, a line in views/reclaimed.jsonl, never an Inbox notice', async () => {
  const { state, hf, file } = setup();
  for (const s of ['one', 'two', 'three']) writeGuarded(hf, file, view(s));
  fs.writeFileSync(file, view('one'));   // a racing writer's older text (or one a lost hash-file update forgot)
  assert.deepEqual(await handEdits(state), [], 'not listed meanwhile: it is Norn\'s own text');
  assert.equal(writeGuarded(hf, file, view('four')), 'written');
  assert.equal(fs.readFileSync(file, 'utf8'), view('four'));
  const rec = fs.readFileSync(path.join(state, 'views', 'reclaimed.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rec.length, 1); assert.equal(rec[0].file.toLowerCase(), path.resolve(file).toLowerCase());
});

test('a stale lock (a crashed writer) is broken; a live one is waited for', async () => {
  const { hf, file } = setup();
  fs.writeFileSync(hf + '.lock', JSON.stringify({ pid: 1, token: 'dead', ts: new Date(Date.now() - 60000).toISOString() }));
  assert.equal(writeGuarded(hf, file, view('one')), 'written');
  assert.ok(!fs.existsSync(hf + '.lock'));
  fs.writeFileSync(hf + '.lock', JSON.stringify({ pid: 1, token: 'live', ts: new Date().toISOString() }));
  const p = writeGuardedAsync(hf, file, view('two'));
  await new Promise(r => setTimeout(r, 150));
  assert.equal(fs.readFileSync(file, 'utf8'), view('one'), 'waits while the holder is live');
  fs.unlinkSync(hf + '.lock');
  assert.equal(await p, 'written');
});
