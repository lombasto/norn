// RM-46 S1c (multi-home SPEC 4.1, 4.2): publish home/<id>, fetch every home/* + claims, byte-identical copies under <state>/homes/<h>/.
// Two synthetic homes (a, b) on temp trees, one temp bare repo as the shared remote; never a real remote. Clocks are injected (o.now).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ledgerConfig, ledgerFiles } from '../engine/lib/ledger.mjs';
import { publishHome, fetchHomes, syncStatus, syncStep, publishDue, HOME_FILES } from '../engine/lib/sync.mjs';
import { sendMail, listMail } from '../engine/lib/mail.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const META = path.resolve('engine/bin/norn.mjs');
const FAKE_TOPIC = 'fake-topic-Sy9cQ1';
const fwdp = p => p.split(path.sep).join('/');
const w = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const g = (dir, ...a) => { const r = spawnSync('git', a, { env: { ...process.env, GIT_DIR: dir }, encoding: 'utf8', windowsHide: true }); return { out: r.stdout.trim(), status: r.status, err: r.stderr }; };
const ref = (id, ns = 'heads') => `refs/${ns}/home/${id}`;   // built, never a literal: the lint reads a slash-home-slash-name as a home path
const T0 = Date.parse('2026-11-20T10:00:00Z');

function remoteRepo() {
  const t = mkTmp('sync-remote-'), remote = path.join(t, 'remote.git');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', remote], { windowsHide: true }).status, 0);
  return fwdp(remote);
}
// one home: <t>/meta/state/demo (synced, home.json) + state/solo (no home.json) + local/machine.json (a FAKE topic) + its ledger repo
function home(id, remote) {
  const t = mkTmp(`sync-home-${id}-`), meta = path.join(t, 'meta'), st = path.join(meta, 'state', 'demo');
  const mf = path.join(meta, 'local', 'machine.json');
  const ledger = { dir: fwdp(path.join(t, 'ledger.git')), state_root: fwdp(path.join(meta, 'state')), reviews: fwdp(path.join(t, 'reviews')), remote };
  w(mf, JSON.stringify({ schema: 1, home: fwdp(t), node: fwdp(process.execPath), codex: null, git: { exe: 'git' }, scheduler: { kind: 'cron', name: 'x', interval_min: 15 },
    claude: { exe: fwdp(process.execPath), config_dir: fwdp(path.join(t, 'cfg')), projects_dir: fwdp(path.join(t, 'cfg', 'projects')) }, dash: { port: 8737, bind: '127.0.0.1' },
    projects: [], notify: { backend: 'ntfy', topic: FAKE_TOPIC }, ledger }));
  w(path.join(st, 'home.json'), JSON.stringify({ id, bare_home: 'a', cut_at: '2026-11-20T09:00:00Z' }) + '\n');
  for (const [f, s] of [['records.jsonl', `{"id":"Q-${id}-1"}\r\n`], ['roadmap.jsonl', '{"id":"RM-1"}\n'], ['mail.jsonl', 'm\n'], ['waivers.jsonl', 'v\n'],
    ['relay.jsonl', 'r\n'], ['runs.jsonl', Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a])], ['deliverables.jsonl', 'd\n'], ['epics.jsonl', 'e\n'], ['adopt.jsonl', 'p\n'],
    ['instructions.jsonl', 'i\n'], ['guard.jsonl', 'g\n'], ['notify.jsonl', 'n\n'], ['budget.json', '{}'], ['STATUS.md', 's'], ['runs/RUN-1.json', '{}'], ['views/x.md', 'x']]) w(path.join(st, f), s);
  w(path.join(meta, 'state', 'solo', 'records.jsonl'), 'solo\n');
  return { t, meta, st, mf, cfg: ledgerConfig({ ledger }, { metaRoot: meta, machineFile: mf }) };
}
const tree = (dir, ref) => g(dir, 'ls-tree', '-r', '--name-only', ref).out.split('\n').filter(Boolean).sort();

test('sync publish: home/<id> carries exactly the shared files + copy/runs + copy/deliverables of each synced project, verbatim; pushed; a second pass is a no-op', () => {
  const remote = remoteRepo(), a = home('a', remote);
  assert.deepEqual(HOME_FILES.map(x => x.to), ['home.json', 'records.jsonl', 'roadmap.jsonl', 'mail.jsonl', 'waivers.jsonl', 'relay.jsonl', 'copy/runs.jsonl', 'copy/deliverables.jsonl', 'seen.json']);
  const r = publishHome(a.cfg, { now: T0 });
  assert.ok(r.sha && r.pushed, JSON.stringify(r));
  const want = ['demo/copy/deliverables.jsonl', 'demo/copy/runs.jsonl', 'demo/home.json', 'demo/mail.jsonl', 'demo/records.jsonl', 'demo/relay.jsonl', 'demo/roadmap.jsonl', 'demo/waivers.jsonl'];
  assert.deepEqual(tree(a.cfg.dir, ref('a')), want);
  assert.deepEqual(tree(remote, ref('a')), want);
  assert.equal(g(remote, 'cat-file', 'blob', 'home/a:demo/records.jsonl').out, '{"id":"Q-a-1"}');
  assert.notEqual(g(a.cfg.dir, 'rev-parse', '-q', '--verify', 'refs/heads/' + a.cfg.branch).status, 0, 'publish never commits the backup branch');
  assert.deepEqual(publishHome(a.cfg, { now: T0 }), { noop: true });
  fs.appendFileSync(path.join(a.st, 'roadmap.jsonl'), '{"id":"RM-2"}\n');
  fs.appendFileSync(path.join(a.st, 'epics.jsonl'), 'local only\n');
  const r2 = publishHome(a.cfg, { now: T0 });
  assert.ok(r2.sha && r2.pushed && r2.sha !== r.sha);
  assert.equal(g(remote, 'rev-parse', ref('a') + '^').out, r.sha, 'fast-forward on top of the last publish');
});

test('sync publish: a machine.json secret value in a shared file refuses the whole publish and logs the file only', () => {
  const remote = remoteRepo(), a = home('a', remote);
  fs.appendFileSync(path.join(a.st, 'mail.jsonl'), `{"body":"${FAKE_TOPIC}"}\n`);
  const r = publishHome(a.cfg, { now: T0 });
  assert.deepEqual(r.refused, ['demo/mail.jsonl']);
  assert.notEqual(g(a.cfg.dir, 'rev-parse', '-q', '--verify', ref('a')).status, 0);
  assert.notEqual(g(remote, 'rev-parse', '-q', '--verify', ref('a')).status, 0);
  const log = fs.readFileSync(path.join(a.cfg.dir, 'sync.log'), 'utf8');
  assert.match(log, /refused.*demo\/mail\.jsonl/); assert.ok(!log.includes(FAKE_TOPIC));
});

test('sync fetch: b writes byte-identical copies of home a under <state>/homes/a/, only for its synced projects; never its own home; outside the backup walk', () => {
  const remote = remoteRepo(), a = home('a', remote), b = home('b', remote);
  assert.ok(publishHome(a.cfg, { now: T0 }).pushed); assert.ok(publishHome(b.cfg, { now: T0 }).pushed);
  const r = fetchHomes(b.cfg, { now: T0 });
  assert.deepEqual(r.homes, ['a']);
  const has = HOME_FILES.filter(x => x.to !== 'seen.json');   // home a has not fetched yet: no receipts of its own to publish
  for (const x of has) assert.deepEqual(fs.readFileSync(path.join(b.st, 'homes', 'a', x.to)), fs.readFileSync(path.join(a.st, x.from)), x.to);
  assert.ok(!fs.existsSync(path.join(b.st, 'homes', 'b')), 'own home is never copied');
  assert.ok(!fs.existsSync(path.join(b.meta, 'state', 'solo', 'homes')), 'a solo project gets no copies');
  assert.equal(r.written.length, has.length);
  assert.deepEqual(fetchHomes(b.cfg, { now: T0 }).written, [], 'unchanged blobs are not rewritten');
  fs.appendFileSync(path.join(a.st, 'records.jsonl'), '{"id":"Q-a-2"}\n'); publishHome(a.cfg, { now: T0 });
  assert.deepEqual(fetchHomes(b.cfg, { now: T0 }).written, ['demo/homes/a/records.jsonl']);
  assert.deepEqual(fs.readFileSync(path.join(b.st, 'homes', 'a', 'records.jsonl')), fs.readFileSync(path.join(a.st, 'records.jsonl')));
  assert.ok(![...ledgerFiles(b.cfg).files.keys()].some(f => f.includes('/homes/')), 'copies are not in the backup walk');
  assert.ok(g(b.cfg.dir, 'rev-parse', '-q', '--verify', ref('a', 'sync')).status === 0);
});

test('sync publish offline: the commit stays local and the next pass pushes it (fast-forward only)', () => {
  const remote = remoteRepo(), a = home('a', remote);
  const off = { ...a.cfg, remote: fwdp(path.join(a.t, 'missing.git')) };
  const r = publishHome(off, { now: T0 });
  assert.ok(r.sha && r.offline && !r.pushed, JSON.stringify(r));
  assert.equal(g(a.cfg.dir, 'rev-parse', ref('a')).out, r.sha);
  const r2 = publishHome(a.cfg, { now: T0 });
  assert.ok(r2.pushed && !r2.sha, JSON.stringify(r2));
  assert.equal(g(remote, 'rev-parse', ref('a')).out, r.sha);
  assert.deepEqual(publishHome(a.cfg, { now: T0 }), { noop: true });
});

test('sync publish rejected (a second install with the same id): logged, publishing stops, the status shows it', () => {
  const remote = remoteRepo(), a = home('a', remote), twin = home('a', remote);
  assert.ok(publishHome(twin.cfg, { now: T0 }).pushed);
  fs.appendFileSync(path.join(a.st, 'records.jsonl'), '{"id":"Q-a-2"}\n');
  const r = publishHome(a.cfg, { now: T0 });
  assert.ok(r.rejected, JSON.stringify(r));
  assert.ok(publishHome(a.cfg, { now: T0 }).stopped);
  assert.match(fs.readFileSync(path.join(a.cfg.dir, 'sync.log'), 'utf8'), /push rejected/);
  assert.match(syncStatus(a.cfg).stopped, /rejected/);
  assert.match(syncStep(a.cfg, 'tick'), /sync: publish stopped/);
});

test('sync fetch failure: the last copies stay, the status says stale since the last good fetch; a vanished home is marked gone, its copies kept', () => {
  const remote = remoteRepo(), a = home('a', remote), b = home('b', remote);
  publishHome(a.cfg, { now: T0 });
  assert.equal(fetchHomes(b.cfg, { now: T0 }).homes.length, 1);
  const r = fetchHomes({ ...b.cfg, remote: fwdp(path.join(b.t, 'missing.git')) }, { now: T0 + 60000 });
  assert.ok(r.error);
  let s = syncStatus(b.cfg);
  assert.equal(s.fetched_at, new Date(T0).toISOString()); assert.ok(s.fetch_error);
  assert.ok(fs.existsSync(path.join(b.st, 'homes', 'a', 'records.jsonl')));
  assert.equal(g(remote, 'update-ref', '-d', ref('a')).status, 0);
  const r2 = fetchHomes(b.cfg, { now: T0 + 120000 });
  assert.deepEqual(r2.homes, []); assert.deepEqual(r2.gone, ['demo/a']);
  assert.ok(fs.existsSync(path.join(b.st, 'homes', 'a', 'records.jsonl')), 'no data is lost');
  s = syncStatus(b.cfg);
  assert.equal(s.fetch_error, null); assert.deepEqual(s.gone, ['demo/a']);
});

test('sync off: no ledger remote or no synced project = publish / fetch / step do nothing; two home ids on one machine = an error', () => {
  const r0 = home('a', remoteRepo());
  fs.rmSync(path.join(r0.st, 'home.json'));
  assert.deepEqual(publishHome(r0.cfg), { off: true });
  w(path.join(r0.st, 'home.json'), '{"id":"a"}'); w(path.join(r0.meta, 'state', 'solo', 'home.json'), '{"id":"b"}');
  assert.match(publishHome(r0.cfg).error, /several homes \(a, b\)/);
  const a = home('a', null);
  assert.deepEqual(publishHome(a.cfg), { off: true });
  assert.deepEqual(fetchHomes(a.cfg), { off: true });
  assert.equal(syncStep(a.cfg, 'tick'), null);
  assert.equal(syncStep(null, 'tick'), null);
});

test('norn sync publish | fetch | status: the CLI over machine.json ledger.remote + home.json', () => {
  const remote = remoteRepo(), a = home('a', remote), b = home('b', remote);
  const run = (h, ...args) => spawnSync(process.execPath, [META, 'sync', ...args, '--machine', h.mf], { env: { ...process.env, META_ROOT: h.meta, META_STATE: '', META_PROJECT: '' }, encoding: 'utf8', windowsHide: true });
  let r = run(a, 'publish');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /published home\/a [0-9a-f]{10}, pushed/);
  r = run(b, 'fetch');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /fetched 1 home \(a\), 8 copies written/);
  r = run(b, 'status');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /home b/); assert.match(r.stdout, /fetched 20\d\d-/); assert.ok(!r.stdout.includes(FAKE_TOPIC));
  r = run(b, 'bogus');
  assert.equal(r.status, 2);
});

test('the tick pass end publishes home/<id> after the ledger commit (SPEC 4.1)', () => {
  const remote = remoteRepo(), a = home('a', remote), root = path.join(a.t, 'root'), pf = path.join(a.t, 'demo.project.json');
  fs.mkdirSync(root, { recursive: true });
  w(pf, JSON.stringify({ schema: 1, name: 'demo', title: 'demo', root: fwdp(root), ledger: '${root}/progress.md', briefs_dir: '${root}', checkin: { cwd: '${root}' } }));
  const m = JSON.parse(fs.readFileSync(a.mf, 'utf8')); m.projects = [{ name: 'demo', config: fwdp(pf) }]; w(a.mf, JSON.stringify(m));
  w(path.join(a.meta, 'state', 'PAUSED'), '');
  const r = spawnSync(process.execPath, [META, 'tick', '--reason', 't'], { env: { ...process.env, META_ROOT: a.meta, META_STATE: '', META_PROJECT: '' }, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(tree(remote, ref('a')).includes('demo/records.jsonl'));
});

// HOME-MAIL S1 (receipts): each home publishes seen.json - per other home the highest seq it holds of each shared log + polled_at (5 min)
function mailHomes() {
  const remote = remoteRepo(), a = home('a', remote), b = home('b', remote);
  for (const h of [a, b]) for (const f of ['mail.jsonl', 'records.jsonl', 'roadmap.jsonl', 'waivers.jsonl', 'runs.jsonl']) w(path.join(h.st, f), '');
  // one settled round: each home holds the other's logs and has published its receipts
  for (const h of [a, b, a, b, a]) { publishHome(h.cfg, { now: T0 }); fetchHomes(h.cfg, { now: T0 }); }
  publishHome(b.cfg, { now: T0 });
  return { a, b };
}

test('receipts: a sends + publishes, b passes + publishes, a passes -> a reads the mail "at b"; no publish is due on either home after the hop', () => {
  const { a, b } = mailHomes(), T1 = T0 + 60000;
  assert.equal(publishDue(a.cfg), false); assert.equal(publishDue(b.cfg), false);
  const m = sendMail(a.st, { by: 'controller', to: 'role:controller@b', subject: 'hop', body: 'the text' });
  assert.ok(publishHome(a.cfg, { now: T1 }).pushed);
  fetchHomes(b.cfg, { now: T1 });
  const seen = JSON.parse(fs.readFileSync(path.join(b.st, 'seen.json'), 'utf8'));
  assert.equal(seen.polled_at, '2026-11-20T10:00:00Z', 'rounded down to 5 min');
  assert.equal(seen.held.a['mail.jsonl'], m.seq);
  assert.ok(publishHome(b.cfg, { now: T1 }).pushed);
  fetchHomes(a.cfg, { now: T1 });
  const [row] = listMail(a.st, { now: T1 });
  assert.equal(row.id, m.id); assert.equal(row.state, 'queued');
  assert.match(row.where, /^at b,/);
  assert.equal(publishDue(a.cfg), false, 'a: its receipts of b did not change (the logs of b did not)');
  assert.equal(publishDue(b.cfg), false);
});

test('receipts: with the pass of b skipped the row reads "sent, b last polled T"; no receipt from b (an older version) reads unknown', () => {
  const { a } = mailHomes(), T1 = T0 + 60000;
  sendMail(a.st, { by: 'controller', to: 'role:controller@b', subject: 'wait', body: 'x' });
  publishHome(a.cfg, { now: T1 });
  assert.equal(listMail(a.st, { now: T1 })[0].where, 'sent, b last polled 2026-11-20T10:00:00Z');
  fs.rmSync(path.join(a.st, 'homes', 'b', 'seen.json'));
  assert.equal(listMail(a.st, { now: T1 })[0].where, 'sent, b unknown');
});

test('receipts: a publish where only polled_at moved is a heartbeat and rings no doorbell; a new receipt rings', () => {
  const { a, b } = mailHomes(), rings = [], T6 = T0 + 6 * 60000;
  const bell = JSON.parse(fs.readFileSync(b.mf, 'utf8')); bell.ledger.doorbell = { topic: 'fake-bell-Zq1' }; w(b.mf, JSON.stringify(bell));
  fetchHomes(b.cfg, { now: T6 });
  assert.equal(syncStep(b.cfg, 'tick', { now: T6, ring: () => rings.push('ring') }) !== null, true);
  assert.deepEqual(rings, [], 'heartbeat only: no ring');
  sendMail(a.st, { by: 'controller', to: 'role:controller@b', subject: 'ring', body: 'x' }); publishHome(a.cfg, { now: T6 });
  fetchHomes(b.cfg, { now: T6 });
  syncStep(b.cfg, 'tick', { now: T6, ring: () => rings.push('ring') });
  assert.deepEqual(rings, ['ring'], 'what b holds of a moved: rung');
});
