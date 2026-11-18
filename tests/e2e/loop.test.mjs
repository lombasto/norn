// META-GTP-CI 2 (GT-PARITY-PLAN 2.11): the real loop end to end on the fake executor, in a temp state + a temp git repo - no
// network, no live state. norn run (stage a, held by an `until` file) -> norn run --queue --after run:<a>:done (stage b QUEUED)
// -> release a -> a DONE -> the supervisor's fill starts b -> b DONE -> its branch becomes a DLV -> norn merge-brief renders.
// The executor is a project-typed one with runner: fake (a provider RUN, so its branch delivers - a bare `--executor fake`
// run never does); its base_url is never called. Every wait is on a condition (a record / a file), never a fixed sleep: a loaded box only makes it slower, not red.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadState } from '../../engine/lib/records.mjs';
import { loadDeliverables } from '../../engine/lib/deliverables.mjs';
import { mkTmp } from '../helpers/tmp.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const META = path.join(REPO, 'engine', 'bin', 'norn.mjs');
const fwd = s => s.split(path.sep).join('/');
const tick = () => new Promise(r => setTimeout(r, 50));
async function until(what, fn, ms = 120000) {   // poll a condition; the cap only turns a hang into a named failure
  const t0 = performance.now();
  for (;;) { const v = fn(); if (v) return v; if (performance.now() - t0 > ms) throw new Error(`e2e: timed out waiting for ${what}`); await tick(); }
}
const git = (cwd, ...a) => {
  const r = spawnSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

test('e2e loop: run -> queue --after -> fill -> run -> DONE -> DLV -> merge-brief', async tc => {
  const t = fs.realpathSync(mkTmp('meta-e2e-'));
  const metaRoot = path.join(t, 'meta'), state = path.join(metaRoot, 'state', 'e2e'), locks = path.join(t, 'locks'), repo = path.join(t, 'repo');
  fs.mkdirSync(state, { recursive: true }); fs.mkdirSync(locks, { recursive: true }); fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'e2e\n');
  git(repo, 'add', 'README.md'); git(repo, 'commit', '-q', '-m', 'init');
  const wt = n => { const w = path.join(t, 'wt-' + n); git(repo, 'worktree', 'add', '-q', '-b', 'feat/e2e-' + n, w); return w; };
  const wtA = wt('a'), wtB = wt('b');
  const release = path.join(t, 'release-a');
  tc.after(() => fs.writeFileSync(release, 'end\n'));   // a failed assertion never leaves stage a's fake waiting
  const file = (n, body) => { const f = path.join(t, n); fs.writeFileSync(f, body); return f; };
  const briefA = file('brief-a.md', `# e2e stage a\nmode: done\nuntil: ${fwd(release)}\n`);
  const briefB = file('brief-b.md', '# e2e stage b - the queued stage\nmode: done\n');
  const notesA = path.join(t, 'NOTES-a.md'), notesB = path.join(t, 'NOTES-b.md');
  const budget = file('budget.json', JSON.stringify({ max_claude_workers: 4 }));
  const pf = file('project.json', JSON.stringify({ schema: 1, name: 'e2e', title: 'e2e', root: fwd(repo), executors: { e2e: { type: 'claude-compatible',
    runner: 'fake', base_url: 'http://127.0.0.1:9/never-called', api_key_env: 'META_E2E_KEY', model: 'e2e-model', effort: 'medium' } } }));
  const liveBefore = fs.existsSync(path.join(REPO, 'state', 'e2e'));
  const env = { ...process.env, META_HB_MS: '150', META_NO_TICK: '1', META_E2E_KEY: 'e2e-dummy', META_ROOT: metaRoot, META_FILL_SAMPLE: '{"free_gb":64,"cpu_pct":0}' };   // the fill's resource gate is not under test (a busy box holds b queued)   // with --project the state is ${meta}/state/<name>: a temp META_ROOT keeps it here
  for (const k of ['META_RUN_ID', 'META_PROJECT', 'META_STATE']) delete env[k];
  const meta = (...a) => { const r = spawnSync(process.execPath, [META, ...a], { env, encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  const common = ['--executor', 'e2e', '--project', pf, '--locks', locks, '--budget', budget];
  const item = id => loadState(state).items[id];

  // 1. stage a starts and is held until released
  const a = meta('run', ...common, '--lane', 'a', '--worktree', wtA, '--brief', briefA, '--notes', notesA);
  assert.equal(a.code, 0, a.out + a.err);
  const runA = a.out.match(/STARTED (RUN-\d+) lane a/)?.[1];
  assert.ok(runA, a.out);
  // 2. stage b queues behind it
  const b = meta('run', ...common, '--lane', 'b', '--worktree', wtB, '--brief', briefB, '--notes', notesB, '--queue', '--after', `run:${runA}:done`);
  assert.equal(b.code, 0, b.out + b.err);
  const runB = b.out.match(/QUEUED (RUN-\d+) lane b .*waits for its after: conditions/)?.[1];
  assert.ok(runB, b.out);
  assert.doesNotMatch(b.out, /STARTED/);
  assert.equal(item(runB).state, 'queued');
  assert.match(JSON.stringify(item(runB).data.after), new RegExp(`"${runA}"`), "b waits on a");
  await until(`${runA} running`, () => item(runA)?.state === 'running');
  assert.equal(item(runB).state, 'queued', 'b must wait while a runs');

  // 3. release a -> DONE -> the fill (supervisor exit) starts b -> b DONE
  fs.writeFileSync(release, 'go\n');
  const endA = await until(`${runA} ended`, () => { const it = item(runA); return it?.end && it; });
  assert.equal(endA.end.outcome, 'done');
  const filled = await until(`${runB} filled`, () => item(runB)?.history.find(h => h.ev === 'fill'));
  const next = filled.data.next;
  assert.match(next, /^RUN-\d+$/);
  const endB = await until(`${next} ended`, () => { const it = item(next); return it?.end && it; });
  assert.equal(endB.end.outcome, 'done');
  assert.equal(endB.data.lane, 'b');
  assert.match(fs.readFileSync(notesB, 'utf8'), /work: done\s*$/);

  // 4. both branches became deliverables; b's names its run and what it delivers (the brief heading)
  const dlvOf = br => Object.values(loadDeliverables(state)).find(x => x.data.branch === br);
  const dB = await until('the DLV of feat/e2e-b', () => dlvOf('feat/e2e-b'));
  assert.match(dB.id, /^DLV-\d+$/);
  assert.equal(dB.data.run, next);
  assert.equal(dB.data.delivers, 'e2e stage b - the queued stage');
  // the tip is the branch head's 40-hex sha (after.mjs / deliverables.mjs read it as a commit), never the branch name
  assert.match(dB.data.tip, /^[0-9a-f]{40}$/);
  assert.equal(dB.data.tip, git(wtB, 'rev-parse', 'HEAD'));
  assert.ok(dlvOf('feat/e2e-a'), 'stage a delivered too');

  // 5. the MERGE stage brief for b renders
  const mb = path.join(t, 'merge', 'MERGE-b.md');
  const m = meta('merge-brief', '--project', pf, '--lane', 'b', '--branch', 'feat/e2e-b', '--worktree', wtB, '--notes', notesB, '--out', mb);
  assert.equal(m.code, 0, m.out + m.err);
  const txt = fs.readFileSync(mb, 'utf8');
  assert.equal(fs.existsSync(path.join(REPO, 'state', 'e2e')), liveBefore, 'no state written under the engine root');
  assert.ok(txt.includes('feat/e2e-b') && txt.includes(fwd(wtB)), 'merge brief names the branch and the worktree');
  assert.doesNotMatch(txt, /\{\{\w+\}\}/);
});
