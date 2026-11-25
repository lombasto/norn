// RM-a-58 decision-paths: `norn rec add decision|directive` warns (one stderr line, exit 0, record unchanged) when its text names repo
// paths tracked at HEAD (git ls-files) and it has no --paths (a decision: and no --on-runs); declinks.namedPaths finds them; the
// check-in, controller and records prompts ask for --paths on a ruling that governs code and none on a process ruling.
// Sandbox only (mkTmp), synthetic names.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { record } from '../engine/lib/records.mjs';
import { namedPaths } from '../engine/lib/declinks.mjs';

test.after(cleanTmp);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..'), NORN = path.join(ROOT, 'engine', 'bin', 'norn.mjs');

function world() {
  const d = mkTmp('meta-recpaths-'), repo = path.join(d, 'repo'), state = path.join(d, 'state', 'kestrel');
  fs.mkdirSync(state, { recursive: true });
  for (const f of ['engine/a.mjs', 'engine/lib/b.mjs', 'docs/x.md', 'README.md']) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), 'x\n'); }
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', windowsHide: true });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('add', '-A'); g('commit', '-q', '-m', 'base');
  const cli = (role, ...a) => { const env = { ...process.env, META_STATE: state, META_ROLE: role }; delete env.META_RUN_ID; delete env.META_PROJECT;
    const r = spawnSync(process.execPath, [NORN, 'rec', 'add', ...a], { env, cwd: repo, encoding: 'utf8', windowsHide: true }); return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }; };
  const created = id => fs.readFileSync(path.join(state, 'records.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find(e => e.id === id && e.ev === 'create');
  return { repo, state, cli, created };
}
const warns = s => s.split('\n').filter(l => /^warning: .*--paths/.test(l));
const dec = (...more) => ['decision', '--lane', 'z', '--question', 'split engine/a.mjs?', '--choice', 'yes, and docs/x.md too', '--why', 'see engine/lib/b.mjs:12.', ...more];

test('namedPaths: only paths tracked at HEAD (files, or folders holding them); a word that only looks like a path is none', () => {
  const files = ['engine/a.mjs', 'engine/lib/b.mjs', 'docs/x.md', 'README.md'];
  assert.deepEqual(namedPaths('change `engine/a.mjs`, .\\docs\\x.md: and engine/lib/b.mjs:12 (README.md).', files), ['engine/a.mjs', 'docs/x.md', 'engine/lib/b.mjs', 'README.md']);
  assert.deepEqual(namedPaths('all of engine/lib/ stays', files), ['engine/lib']);
  assert.deepEqual(namedPaths('engine/zzz.mjs and a/b and x.md and engine and n/a, queue/dispatch', files), []);
});

test('a decision naming repo files without --paths: exit 0, one warning line naming the files and the flag', () => {
  const W = world(), r = W.cli('controller', ...dec());
  assert.equal(r.code, 0, r.err); assert.match(r.out, /^DEC-\d+$/);
  const w = warns(r.err); assert.equal(w.length, 1, r.err);
  for (const f of ['engine/a.mjs', 'docs/x.md', 'engine/lib/b.mjs']) assert.ok(w[0].includes(f), f);
  assert.match(w[0], /--paths engine\/a\.mjs,docs\/x\.md,engine\/lib\/b\.mjs/);
});

test('no warning with --paths, with --on-runs, or when the text holds no tracked path; a directive warns the same way', () => {
  const W = world();
  assert.deepEqual(warns(W.cli('controller', ...dec('--paths', 'engine/a.mjs')).err), []);
  const run = record(W.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'z' } }, { views: false }).id;
  assert.deepEqual(warns(W.cli('controller', ...dec('--on-runs', run)).err), []);
  const plain = W.cli('controller', 'decision', '--lane', 'z', '--question', 'queue order?', '--choice', 'engine/zzz.mjs first, then a/b', '--why', 'n/a and x.md');
  assert.equal(plain.code, 0, plain.err); assert.deepEqual(warns(plain.err), []);
  const d = W.cli('owner', 'directive', '--text', 'keep docs/x.md short', '--via', 'chat', '--new');
  assert.equal(d.code, 0, d.err); assert.equal(warns(d.err).length, 1, d.err); assert.match(warns(d.err)[0], /docs\/x\.md/);
  assert.deepEqual(warns(W.cli('owner', 'directive', '--text', 'keep docs/x.md short, really', '--via', 'chat', '--paths', 'docs/x.md', '--new').err), []);
});

test('the record is the same with and without the warning', () => {
  const W = world(), a = W.cli('controller', ...dec());
  // the same decision recorded where there is no repo to list: no warning, and the same data
  const env = { ...process.env, META_STATE: W.state, META_ROLE: 'controller' }; delete env.META_RUN_ID; delete env.META_PROJECT;
  const r = spawnSync(process.execPath, [NORN, 'rec', 'add', ...dec()], { env, cwd: mkTmp('meta-recpaths-nogit-'), encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr); assert.equal(warns(a.err).length, 1); assert.deepEqual(warns(r.stderr), []);
  assert.deepEqual(W.created(r.stdout.trim()).data, W.created(a.out).data);
});

test('the check-in, controller and records prompts ask for --paths on a code ruling and none on a process ruling', () => {
  for (const f of ['CHECKIN.md', 'CONTROLLER.md', 'RECORDS.md']) {
    const t = fs.readFileSync(path.join(ROOT, 'engine', 'prompts', f), 'utf8');
    assert.match(t, /governs code[^\n]*--paths/, f);
    assert.match(t, /process ruling[^\n]*(?:\n[^\n]*)?none/, f);
  }
});
