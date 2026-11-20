// RM-35 (handedit-diff): a file Norn wrote never trips its own hand-edit guard. The false "changed outside Norn" notice came from
// guarded writers that read the hash file, wrote the view, and wrote the WHOLE hash map back without a lock: a second writer in
// between (the fill under queue.lock vs `norn views`, the dashboard, a lane worktree's engine) lost the other's hash, so the next
// write saw Norn's own text as a hand edit. Also a rename blocked on Windows (EPERM / EBUSY: an editor, a scanner) must never leave
// the hash ahead of or behind the file. Temp state dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeGuarded, writeGuardedAsync, hashKey } from '../engine/lib/views.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const writer = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'guard-writer.mjs');
const run = (...args) => new Promise((res, rej) => {
  const c = spawn(process.execPath, [writer, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { err += d; });
  c.on('error', rej); c.on('exit', code => code === 0 ? res(JSON.parse(out)) : rej(new Error(`writer exit ${code}: ${err}`)));
});

test('writers in four processes on one file and one hash file: none refuses another\'s text, and the hash ends equal to the file', async () => {
  const state = mkTmp('meta-guard-race-'), hf = path.join(state, 'views', 'queue-hashes.json'), f = path.join(state, 'META-QUEUE.md');
  const rs = await Promise.all(['a', 'b', 'c', 'd'].map(t => run(hf, f, t, '15')));
  assert.deepEqual(rs.map(r => r.errors).flat(), [], 'no write failed');
  assert.deepEqual(rs.map(r => r.refused), [0, 0, 0, 0], 'Norn never calls its own text a hand edit');
  assert.equal(JSON.parse(fs.readFileSync(hf, 'utf8'))[hashKey(f)], sha(fs.readFileSync(f, 'utf8')), 'the hash is the file\'s');
});

test('writers in four processes on four files sharing one hash file: no writer loses another\'s key', async () => {
  const state = mkTmp('meta-guard-keys-'), hf = path.join(state, 'views', 'hashes.json'), fs4 = ['A', 'B', 'C', 'D'].map(x => path.join(state, 'views', x + '.md'));
  const rs = await Promise.all(fs4.map((f, i) => run(hf, f, 'w' + i, '12')));
  assert.deepEqual(rs.map(r => r.errors).flat(), []);
  const h = JSON.parse(fs.readFileSync(hf, 'utf8'));
  for (const f of fs4) assert.equal(h[hashKey(f)], sha(fs.readFileSync(f, 'utf8')), `${path.basename(f)} keeps its hash`);
});

// Hypothesis (a) of the brief: a rename blocked on Windows (the target open in an editor, a scanner on the fresh tmp: EPERM / EBUSY).
// Simulated by failing fs.renameSync onto the view file: a short block is retried and the write lands; a lasting one is a write
// failure - thrown, the hash and the write record left as they were (never ahead of the file), no tmp file left behind.
test('a rename blocked like Windows does it: retried through a short block; a lasting block throws and leaves the hash at the file', () => {
  const state = mkTmp('meta-guard-eperm-'), hf = path.join(state, 'views', 'roadmap-hashes.json'), f = path.join(state, 'views', 'ROADMAP.md');
  assert.equal(writeGuarded(hf, f, 'one\n'), 'written');
  const real = fs.renameSync; let left = 0;
  fs.renameSync = (a, b) => { if (path.resolve(b) === path.resolve(f) && left-- > 0) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }); return real(a, b); };
  try {
    left = 3;
    assert.equal(writeGuarded(hf, f, 'two\n'), 'written', 'a short block is waited out');
    assert.equal(fs.readFileSync(f, 'utf8'), 'two\n');
    left = 1e9;
    assert.throws(() => writeGuarded(hf, f, 'three\n'), { code: 'EPERM' }, 'a lasting block is a write failure, said as one');
  } finally { fs.renameSync = real; }
  assert.equal(fs.readFileSync(f, 'utf8'), 'two\n');
  assert.equal(JSON.parse(fs.readFileSync(hf, 'utf8'))[hashKey(f)], sha('two\n'), 'the hash is the text on disk, not the one that never landed');
  assert.deepEqual(fs.readdirSync(path.dirname(f)).filter(x => x.endsWith('.tmp') || x.endsWith('.lock')), [], 'no tmp or lock left');
  assert.equal(writeGuarded(hf, f, 'four\n'), 'written', 'and the next write is no "hand edit"');
});

test('the async writer (the dash server) shares the lock, the retry and the write record', async () => {
  const state = mkTmp('meta-guard-async-'), hf = path.join(state, 'views', 'roadmap-hashes.json'), f = path.join(state, 'views', 'ROADMAP.md');
  const rs = await Promise.all([...Array(8)].map((_, i) => writeGuardedAsync(hf, f, `t${i}\n`, { role: 'dashboard' })));
  assert.ok(!rs.includes('refused'), 'eight requests of one process never refuse each other');
  assert.equal(JSON.parse(fs.readFileSync(hf, 'utf8'))[hashKey(f)], sha(fs.readFileSync(f, 'utf8')));
});
