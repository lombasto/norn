// GTP-LEDGER (norn DIR-1 / DIR-83): the git-backed ledger - one bare repo, a whitelist, a private index, a per-pass commit.
// Temp trees only: a fake meta root with state/<p>/ + a reviews dir + local/machine.json (a FAKE ntfy topic).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ledgerConfig, commitLedger, ledgerFiles, ledgerLog, ledgerStatus, ledgerRestore, secretsOf, BIG_BYTES } from '../engine/lib/ledger.mjs';
import { KINDS } from '../engine/lib/records.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const FAKE_TOPIC = 'fake-topic-Zq81xY2';
const w = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const lg = (cfg, ...a) => { const r = spawnSync('git', a, { env: { ...process.env, GIT_DIR: cfg.dir }, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };

export function ledgerTree() {
  const t = mkTmp('meta-ledger-');
  const meta = path.join(t, 'sdd-codex'), st = path.join(meta, 'state', 'p'), rev = path.join(t, 'reviews');
  const mf = path.join(meta, 'local', 'machine.json');
  w(mf, JSON.stringify({ schema: 1, notify: { backend: 'ntfy', topic: FAKE_TOPIC }, api: { token: 'tok-ABCDEFGH123' }, ledger: {} }));
  // runs.jsonl stays JSON: a run started in a sibling state dir reads it (liveRuns: the caps and the crew's busy dwarves)
  for (const [f, s] of [['records.jsonl', '{"a":1}\n'], ['runs.jsonl', '{"r":1}\n'], ['runs-2026-10.jsonl', 'r\n'], ['deliverables.jsonl', 'd\n'], ['notify.jsonl', 'n\n'],
    ['notify-batch.jsonl', 'b\n'], ['STATUS.md', 's'], ['DIGEST.md', 'g'], ['checkin-gate.json', '{}'], ['runs/RUN-1.spec.json', '{}'], ['views/hashes.json', '{}'],
    ['views/OWNER-QUESTIONS.md', 'q'], ['logs/RUN-1.log', 'L'], ['hb/RUN-1.hb', ''], ['records.lock', ''], ['usage-cache.json', '{}'], ['deliverables-cache.json', '{}'],
    ['tick.log', 't'], ['runs/RUN-1.log', 'x']]) w(path.join(st, f), s);
  w(path.join(meta, 'state', 'locks', 'abc.json'), '{}');
  w(path.join(rev, 'lane', 'NOTES.md'), 'notes\n'); w(path.join(rev, 'lane', 'shot.png'), Buffer.alloc(1024, 1));
  w(path.join(rev, 'lane', 'logs', 'x.txt'), 'l'); w(path.join(rev, 'clone', '.git', 'HEAD'), 'ref'); w(path.join(rev, 'clone', 'src.go'), 'go');
  w(path.join(rev, 'lane', 'scratch', 'tmp.md'), 's'); w(path.join(rev, 'scratch-merge', 'state', 'x.md'), 's');
  fs.writeFileSync(path.join(rev, 'lane', 'huge.png'), Buffer.alloc(BIG_BYTES + 1, 2));
  const cfg = ledgerConfig({ ledger: { dir: path.join(t, 'ledger.git'), state_root: path.join(meta, 'state'), reviews: rev } }, { metaRoot: meta, machineFile: mf });
  return { t, meta, st, rev, mf, cfg };
}

test('ledger config: no `ledger` slot = off; defaults = <dev>/norn-ledger.git, <meta>/state, <dev>/<install dir name>-reviews; work tree = their common parent', () => {
  assert.equal(ledgerConfig({}, { metaRoot: 'C:/x/sdd-codex' }), null);
  assert.equal(ledgerConfig(null, { metaRoot: 'C:/x/sdd-codex' }), null);
  const c = ledgerConfig({ ledger: {} }, { metaRoot: 'C:/x/sdd-codex' });
  assert.equal(c.dir, path.resolve('C:/x/norn-ledger.git'));
  assert.equal(c.state_root, path.resolve('C:/x/sdd-codex/state'));
  assert.equal(c.reviews, path.resolve('C:/x/sdd-codex-reviews'));
  assert.equal(c.root, path.resolve('C:/x'));
  assert.match(c.branch, /^machine\/[a-z0-9._-]+$/);
});

test('ledger whitelist: state text records / runs / views / generated .md / gate + the reviews dir; never logs, hb, locks, caches, local/, .git, scratch*, a nested clone, > 5 MB', () => {
  const { cfg } = ledgerTree();
  const { files, big } = ledgerFiles(cfg);
  const rel = [...files.keys()].sort();
  for (const f of ['records.jsonl', 'runs.jsonl', 'runs-2026-10.jsonl', 'deliverables.jsonl', 'notify.jsonl', 'notify-batch.jsonl', 'STATUS.md', 'DIGEST.md',
    'checkin-gate.json', 'runs/RUN-1.spec.json', 'views/hashes.json', 'views/OWNER-QUESTIONS.md']) assert.ok(rel.includes(`sdd-codex/state/p/${f}`), f);
  assert.ok(rel.includes('reviews/lane/NOTES.md') && rel.includes('reviews/lane/shot.png'));
  assert.ok(!rel.some(f => /\/(logs|hb)\/|\.lock$|-cache\.json$|tick\.log$|RUN-1\.log$|\/local\/|\/\.git\/|huge\.png|locks\/|scratch|clone\//.test(f)), rel.join('\n'));
  assert.deepEqual(big, ['reviews/lane/huge.png']);
});

test('ledger commit: first commit on machine/<host> names the skipped > 5 MB file; unchanged = no-op; change / delete = a new commit', () => {
  const { st, rev, cfg } = ledgerTree();
  const a = commitLedger(cfg, 'test pass');
  assert.ok(a.sha && !a.noop, JSON.stringify(a));
  assert.equal(lg(cfg, 'rev-parse', cfg.branch), a.sha);
  const msg = lg(cfg, 'log', '-1', '--format=%B', cfg.branch);
  assert.match(msg, /^ledger: test pass/);
  assert.match(msg, /reviews\/lane\/huge\.png/);
  const tracked = lg(cfg, 'ls-tree', '-r', '--name-only', cfg.branch).split('\n');
  assert.ok(tracked.includes('sdd-codex/state/p/records.jsonl') && !tracked.some(f => f.includes('logs/')));
  assert.ok(fs.existsSync(path.join(cfg.dir, 'info', 'exclude')) && /logs\//.test(fs.readFileSync(path.join(cfg.dir, 'info', 'exclude'), 'utf8')));
  assert.equal(commitLedger(cfg, 'again').noop, true);
  fs.appendFileSync(path.join(st, 'records.jsonl'), '{"b":2}\n');
  fs.rmSync(path.join(rev, 'lane', 'shot.png'));
  const b = commitLedger(cfg, 'pass 2');
  assert.ok(b.sha && b.sha !== a.sha);
  assert.equal(lg(cfg, 'show', `${cfg.branch}:sdd-codex/state/p/records.jsonl`), '{"a":1}\n{"b":2}'.trim());
  assert.ok(!lg(cfg, 'ls-tree', '-r', '--name-only', cfg.branch).includes('reviews/lane/shot.png'));
  assert.equal(lg(cfg, 'rev-list', '--count', cfg.branch), '2');
});

test('ledger secrets: a staged file holding a machine.json secret value refuses the commit; the log names the FILE only, never the value', () => {
  const { rev, mf, cfg } = ledgerTree();
  const s = secretsOf(mf);
  assert.ok(s.includes(FAKE_TOPIC) && s.includes('tok-ABCDEFGH123'));
  w(path.join(rev, 'lane', 'leak.md'), `ntfy at https://ntfy.sh/${FAKE_TOPIC}\n`);
  const r = commitLedger(cfg, 'leaky');
  assert.equal(r.sha, undefined);
  assert.deepEqual(r.refused, ['reviews/lane/leak.md']);
  const log = fs.readFileSync(path.join(cfg.dir, 'ledger.log'), 'utf8');
  assert.match(log, /refused.*reviews\/lane\/leak\.md/);
  assert.ok(!log.includes(FAKE_TOPIC) && !JSON.stringify(r).includes(FAKE_TOPIC));
  assert.throws(() => lg(cfg, 'rev-parse', '--verify', cfg.branch));   // nothing committed
  fs.rmSync(path.join(rev, 'lane', 'leak.md'));
  assert.ok(commitLedger(cfg, 'clean').sha);
});

test('ledger lock: a held lock (one writer) fails the commit with "lock busy", never waits forever', () => {
  const { cfg } = ledgerTree();
  commitLedger(cfg, 'init');
  fs.writeFileSync(path.join(cfg.dir, 'ledger.lock'), JSON.stringify({ pid: 1, ts: new Date().toISOString() }));
  const r = commitLedger(cfg, 'blocked', { lockTimeoutMs: 200 });
  assert.match(r.error, /lock busy/);
});

test('ledger status / log / restore: restore checks out a sha into a scratch dir and refuses a live state path or a non-empty dir', () => {
  const { st, cfg, t } = ledgerTree();
  const a = commitLedger(cfg, 'one');
  fs.appendFileSync(path.join(st, 'records.jsonl'), 'x\n');
  const s = ledgerStatus(cfg);
  assert.equal(s.head, a.sha); assert.equal(s.pending, 1); assert.ok(s.tracked > 10);
  commitLedger(cfg, 'two');
  const l = ledgerLog(cfg, 5);
  assert.equal(l.length, 2); assert.match(l[0], /ledger: two/);
  const to = path.join(t, 'scratch');
  ledgerRestore(cfg, { at: a.sha, to });
  assert.equal(fs.readFileSync(path.join(to, 'sdd-codex', 'state', 'p', 'records.jsonl'), 'utf8'), '{"a":1}\n');
  assert.throws(() => ledgerRestore(cfg, { at: a.sha, to }), /not empty/);
  assert.throws(() => ledgerRestore(cfg, { at: a.sha, to: path.join(st, 'x') }), /live/);
  assert.throws(() => ledgerRestore(cfg, { at: a.sha, to: cfg.root }), /live/);
  assert.throws(() => ledgerRestore(cfg, { at: a.sha, to: path.join(cfg.reviews, 'r') }), /live/);
});

// ---------- piece 2 + 3: the tick pass end, the run end, `norn ledger` (a temp META_ROOT; PAUSED = a pass that starts nothing) ----------
const META = path.resolve('engine/bin/norn.mjs');
const fwdp = p => p.split(path.sep).join('/');
function metaRootTree({ ledger } = {}) {
  const t = mkTmp('meta-ledger-root-');
  const root = path.join(t, 'root'); fs.mkdirSync(root, { recursive: true });
  const pf = path.join(t, 'demo.project.json');
  fs.writeFileSync(pf, JSON.stringify({ schema: 1, name: 'demo', title: 'demo', root: fwdp(root), ledger: '${root}/progress.md', briefs_dir: '${root}', checkin: { cwd: '${root}' } }));
  const lslot = ledger === undefined ? { dir: fwdp(path.join(t, 'norn-ledger.git')), reviews: fwdp(path.join(t, 'reviews')) } : ledger;
  w(path.join(t, 'local', 'machine.json'), JSON.stringify({ schema: 1, home: fwdp(t), node: fwdp(process.execPath),
    claude: { exe: fwdp(process.execPath), config_dir: fwdp(path.join(t, 'cfg')), projects_dir: fwdp(path.join(t, 'cfg', 'projects')) }, codex: null, git: { exe: fwdp(process.execPath) },
    scheduler: { kind: 'cron', name: 'x', interval_min: 15 }, dash: { port: 8737, bind: '127.0.0.1' }, projects: [{ name: 'demo', config: fwdp(pf) }],
    notify: { backend: 'ntfy', topic: FAKE_TOPIC }, ...(lslot ? { ledger: lslot } : {}) }));
  const state = path.join(t, 'state', 'demo');
  w(path.join(state, 'records.jsonl'), '{"r":1}\n'); w(path.join(t, 'reviews', 'lane', 'NOTES.md'), 'n\n');
  fs.writeFileSync(path.join(t, 'state', 'PAUSED'), '');
  const meta = (...a) => spawnSync(process.execPath, [META, ...a], { env: { ...process.env, META_ROOT: t, META_STATE: '', META_PROJECT: '' }, encoding: 'utf8' });
  return { t, state, meta, dir: path.join(t, 'norn-ledger.git') };
}
const branchOf = dir => fs.readdirSync(path.join(dir, 'refs', 'heads', 'machine'))[0];

test('ledger at the tick pass end: a PAUSED pass commits the state + reviews; no `ledger` slot = no repo; a broken ledger never fails the tick', () => {
  const a = metaRootTree();
  let r = a.meta('tick', '--reason', 'test');
  assert.equal(r.status, 0, r.stderr);
  const cfg = { dir: a.dir };
  const br = `machine/${branchOf(a.dir)}`;
  assert.match(lg(cfg, 'log', '-1', '--format=%s', br), /^ledger: tick demo \(test\)/);
  const tracked = lg(cfg, 'ls-tree', '-r', '--name-only', br).split('\n');
  assert.ok(tracked.includes('state/demo/records.jsonl') && tracked.includes('reviews/lane/NOTES.md') && !tracked.some(f => f.startsWith('local/')), tracked.join(','));

  const off = metaRootTree({ ledger: null });
  r = off.meta('tick', '--reason', 'test');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(off.dir));

  const bad = metaRootTree();
  fs.writeFileSync(bad.dir, 'a file, not a repo');
  r = bad.meta('tick', '--reason', 'test');
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(bad.state, 'tick.log'), 'utf8'), /ledger: failed/);
});

test('ledger at the run end: the supervisor commits after the `end` record (spec.git_ledger); a ledger failure leaves the end record intact', async () => {
  const { startRun } = await import('../engine/lib/runs.mjs');
  const { loadState } = await import('../engine/lib/records.mjs');
  const { cfg, meta, t } = ledgerTree();
  const state = path.join(meta, 'state', 'q'), wt = path.join(t, 'wt'); fs.mkdirSync(wt); fs.mkdirSync(state);
  const brief = path.join(t, 'brief.md'); fs.writeFileSync(brief, 'FAKE: done\n');
  const id = startRun({ state, locksDir: path.join(meta, 'state', 'locks'), executor: 'fake', lane: 'demo', worktree: wt, notes: path.join(t, 'NOTES.md'), hbMs: 150, staleMs: 3000,
    policy: { auto_resume_max: 0, trigger_on_exit: false }, budget: {}, brief, git_ledger: cfg }).run;
  const t0 = performance.now();   // monotonic deadline (the WSL runner's wall clock steps ~16 s)
  let msg = '';
  while (performance.now() - t0 < 30000) {
    try { msg = lg(cfg, 'log', '-1', '--format=%s', cfg.branch); } catch { /* not yet */ }
    if (msg) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.match(msg, new RegExp(`^ledger: run end ${id}`));
  const recs = lg(cfg, 'show', `${cfg.branch}:sdd-codex/state/q/runs.jsonl`);
  assert.ok(recs.split('\n').some(l => l.includes(`"${id}"`) && l.includes('"end"')));
  assert.ok(loadState(state).items[id].history.some(h => h.ev === 'end'));
});

test('norn ledger status | log | restore: off without the slot; restore into a scratch dir, refused over the live state', () => {
  const a = metaRootTree();
  assert.equal(a.meta('tick', '--reason', 'one').status, 0);
  fs.appendFileSync(path.join(a.state, 'records.jsonl'), '{"r":2}\n');
  let r = a.meta('ledger', 'status');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /branch machine\//); assert.match(r.stdout, /pending 1/);
  assert.ok(!r.stdout.includes(FAKE_TOPIC));
  assert.equal(a.meta('tick', '--reason', 'two').status, 0);
  r = a.meta('ledger', 'log', '-n', '1');
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1); assert.match(lines[0], /ledger: tick demo \(two\)/);
  const sha = lines[0].split(' ')[0], to = path.join(mkTmp('ledger-restore-'), 'to');
  r = a.meta('ledger', 'restore', '--at', sha, '--to', to);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(to, 'state', 'demo', 'records.jsonl'), 'utf8'), '{"r":1}\n{"r":2}\n');
  r = a.meta('ledger', 'restore', '--at', sha, '--to', path.join(a.state, 'x'));
  assert.equal(r.status, 1); assert.match(r.stderr, /live path/);
  r = a.meta('ledger', 'bogus');
  assert.equal(r.status, 2);
  r = metaRootTree({ ledger: null }).meta('ledger', 'status');
  assert.equal(r.status, 1); assert.match(r.stderr, /ledger is off/);
});

test('ledger remote: ledger.remote set = a detached push of machine/<host> after a commit (the commit never waits for it)', async () => {
  const { cfg, t } = ledgerTree();
  const remote = path.join(t, 'remote.git');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', remote]).status, 0);
  const r = commitLedger({ ...cfg, remote: remote.split(path.sep).join('/') }, 'pushed');
  assert.ok(r.sha);
  let got = '';
  for (const t0 = performance.now(); performance.now() - t0 < 20000 && got !== r.sha; await new Promise(res => setTimeout(res, 100)))
    got = spawnSync('git', ['--git-dir', remote, 'rev-parse', '-q', '--verify', cfg.branch], { encoding: 'utf8' }).stdout.trim();
  assert.equal(got, r.sha);
});

test('ledger whitelist: the backup carries every KINDS file (roadmap, mail, waivers, adopt, instructions, guard - RM-46 S1c, F4)', () => {
  const { st, cfg } = ledgerTree();
  const want = [...new Set(Object.values(KINDS).map(k => k.file))].map(f => `${f}.jsonl`);
  for (const f of want) w(path.join(st, f), '{"x":1}\n');
  const rel = [...ledgerFiles(cfg).files.keys()];
  for (const f of want) assert.ok(rel.includes(`sdd-codex/state/p/${f}`), f);
  assert.ok(want.includes('roadmap.jsonl'));
});
