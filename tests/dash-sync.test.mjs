// NORN-UI-SYNC: Settings > Sync on the dash fixture - the state block, the ledger form (the doorbell topic is write-only: never echoed),
// the guided set up / join through the server (POST /api/sync/plan | apply, the library's syncJoin in-process via o.syncWork with a fake
// gh), reconcile from the page, and the cross-home conflict chip on a Lanes row. Temp bare repos: one origin, one ledger remote reached under a
// GitHub-shaped URL through git's url.<base>.insteadOf (env); two dashboards = two machines. Synthetic names only; no network, no sleeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture } from './helpers/dash-fixture.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { syncOp } from '../engine/dash/syncwork.mjs';
import { snap } from '../engine/lib/fsnap.mjs';
import { renderTab, syncLines } from '../engine/dash/ui.mjs';
import { conflictChips } from '../engine/dash/pages/lanes.mjs';
import { homeOf, record } from '../engine/lib/records.mjs';

const URL_ = 'https://github.com/synthetic/ledger.git', TOPIC = 'synthetic-topic-4242';
const fwdp = p => p.split(path.sep).join('/');
const git = (cwd, ...a) => { const r = spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', windowsHide: true }); if (r.status) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const ident = ['-c', 'user.name=t', '-c', 'user.email=t@x'];
const heads = dir => spawnSync('git', ['--git-dir', dir, 'for-each-ref', '--format=%(refname) %(objectname)'], { encoding: 'utf8', windowsHide: true }).stdout;
function viaGithub(ledgerRemote) {
  const keep = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'].map(k => [k, process.env[k]]);
  Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${fwdp(ledgerRemote)}.insteadOf`, GIT_CONFIG_VALUE_0: URL_ });
  return () => { for (const [k, v] of keep) if (v === undefined) delete process.env[k]; else process.env[k] = v; };
}
/** origin (main + lane branch norn/gen) and an empty bare ledger remote */
function remotes() {
  const t = mkTmp('meta-dsync-w-', 'x'), root = path.dirname(path.dirname(t));
  const origin = path.join(root, 'origin.git'), ledgerRemote = path.join(root, 'ledger-remote.git');
  for (const d of [origin, ledgerRemote]) spawnSync('git', ['init', '-q', '--bare', '-b', 'main', d], { windowsHide: true });
  const seed = path.join(root, 'seed');
  spawnSync('git', ['init', '-q', '-b', 'main', seed], { windowsHide: true });
  fs.writeFileSync(path.join(seed, 'README.md'), 'kestrel\n');
  git(seed, 'add', '.'); git(seed, ...ident, 'commit', '-qm', 'init'); git(seed, 'remote', 'add', 'origin', origin); git(seed, 'push', '-q', 'origin', 'main');
  return { origin, ledgerRemote };
}
/** one machine = one dash fixture (syncOp in-process outside the request's file snapshot, as in its worker thread): kestrel's repo a clone of origin, machine.json with a ledger block (no remote), the fake gh's answer in g */
async function machine(w, g, extra = {}) {
  const f = await fixture({ dash: { syncWork: (op, a) => snap.exit(() => syncOp(op, { ...a, gh: args => (args[1] === 'repos/synthetic/ledger' ? (g.priv === null ? null : `${g.priv}\n`) : args[1] === 'user' ? 'joiner-login\n' : null), openPr: () => false, ledgerOpts: { push: false, gc: false } })) }, ...extra });
  const repo = f.pa.root;
  record(f.pa.state, { kind: 'run', ev: 'end', id: 'RUN-2', by: 'launcher', data: { exit: 0, outcome: 'done' } });   // the fixture's running run: a cut refuses one
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'remote', 'add', 'origin', w.origin); git(repo, 'fetch', '-q', 'origin'); git(repo, 'reset', '-q', 'origin/main');
  const mf = path.join(f.root, 'local', 'machine.json');
  fs.writeFileSync(mf, JSON.stringify({ home: f.root, ledger: { dir: fwdp(path.join(f.root, 'ledger.git')), state_root: fwdp(path.dirname(f.pa.state)), reviews: fwdp(path.join(f.root, 'reviews')) } }, null, 2) + '\n');
  fs.mkdirSync(path.join(f.root, 'reviews'), { recursive: true });
  return { ...f, mf, settings: async () => (await f.get('/api/settings?project=kestrel')).data };
}

test('Settings > Sync: solo state, the ledger form saves the remote and a write-only topic (never echoed), a stale version is refused', { timeout: 120000 }, async () => {
  const w = remotes(), A = await machine(w, { priv: true });
  try {
    let s = (await A.settings()).sync;
    assert.equal(s.home, null); assert.equal(s.doorbell, false);
    const r = await A.post('/api/sync/ledger', { project: 'kestrel', version: s.version, remote: URL_, topic: TOPIC });
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.doorbell, true);
    assert.doesNotMatch(JSON.stringify(r.data), new RegExp(TOPIC));
    assert.equal(JSON.parse(fs.readFileSync(A.mf, 'utf8')).ledger.doorbell.topic, TOPIC);
    const d = await A.settings();
    assert.doesNotMatch(JSON.stringify(d), new RegExp(TOPIC));
    assert.equal(d.sync.remote, URL_); assert.equal(d.sync.doorbell, true);
    const html = renderTab('settings', d, { project: 'kestrel', setCat: 'sync' });
    for (const id of ['sub-sync-machine', 'sub-sync-setup', 'sub-sync-duplicates', 'sub-sync-leases', 'sync-topic', 'sync-home']) assert.match(html, new RegExp(`id="${id}"`));
    assert.match(html, /placeholder="set \(hidden\)"/); assert.doesNotMatch(html, new RegExp(TOPIC));
    assert.match(html, /data-key="policy\.sync\.lease_s"/);
    const stale = await A.post('/api/sync/ledger', { project: 'kestrel', version: s.version, topic: 'other-topic' });
    assert.equal(stale.status, 409);
    s = d.sync;
    assert.equal((await A.post('/api/sync/ledger', { project: 'kestrel', version: s.version, topic: 'bad topic!' })).status, 400);
  } finally { await A.done(); }
});

test('set up from the page: a public ledger is refused; Check is the dry run; Apply pauses, cuts the first home, publishes and resumes', { timeout: 180000 }, async () => {
  const w = remotes(), g = { priv: false }, A = await machine(w, g), undo = viaGithub(w.ledgerRemote);
  try {
    const body = { project: 'kestrel', home: 'a', remote: URL_, topic: TOPIC, bare: true };
    const pub = await A.post('/api/sync/plan', body);
    assert.equal(pub.data.ok, false); assert.match(pub.data.refused.join('\n'), /synthetic\/ledger is PUBLIC/);
    assert.match(syncLines(pub.data).join('\n'), /^REFUSED: /m);
    g.priv = true;
    const led = heads(w.ledgerRemote), dry = await A.post('/api/sync/plan', body);
    assert.equal(dry.data.ok, true, syncLines(dry.data).join('\n')); assert.equal(dry.data.dry, true);
    assert.match(dry.data.lines.join('\n'), /DRY RUN/);
    assert.equal(heads(w.ledgerRemote), led); assert.equal(homeOf(A.pa.state), null);
    const r = await A.post('/api/sync/apply', body);
    const out = r.data.lines.join('\n');
    assert.equal(r.data.ok, true, out);
    assert.match(out, /kestrel: paused for the cut/); assert.match(out, /kestrel: resumed/);
    assert.doesNotMatch(out, /next: publish/);
    assert.doesNotMatch(JSON.stringify(r.data), new RegExp(TOPIC));
    assert.equal(fs.existsSync(path.join(A.pa.state, 'PAUSED')), false);
    assert.equal(homeOf(A.pa.state).id, 'a');
    assert.match(heads(w.ledgerRemote), /refs\/heads\/home\/a /);
    const s = (await A.settings()).sync;
    assert.equal(s.home, 'a'); assert.equal(s.remote, URL_); assert.equal(s.doorbell, true);
    // a second machine: home id a is taken; it joins as b; a re-join is a no-op
    const B = await machine(w, { priv: true });
    try {
      const jb = { project: 'kestrel', home: 'b', remote: URL_ };
      const taken = await B.post('/api/sync/plan', { ...jb, home: 'a' });
      assert.equal(taken.data.ok, false); assert.match(taken.data.refused.join('\n'), /home id a is taken/);
      const j = await B.post('/api/sync/apply', jb);
      assert.equal(j.data.ok, true, j.data.lines.join('\n'));
      assert.equal(homeOf(B.pa.state).id, 'b');
      const mf = fs.readFileSync(B.mf, 'utf8'), again = await B.post('/api/sync/apply', jb);
      assert.equal(again.data.ok, true); assert.equal(again.data.noop, true, again.data.lines.join('\n'));
      assert.equal(fs.readFileSync(B.mf, 'utf8'), mf);
      // reconcile from the page: Find duplicates is the dry run, nothing written
      const rc = await B.post('/api/sync/reconcile', { project: 'kestrel', dry: true });
      assert.equal(rc.status, 200); assert.ok(Array.isArray(rc.data.pairs)); assert.deepEqual(rc.data.written, []);
      assert.match(syncLines(rc.data)[0], /likely duplicate pair/);
      // the remote is fixed once this machine is a home
      const v = (await B.settings()).sync.version;
      assert.equal((await B.post('/api/sync/ledger', { project: 'kestrel', version: v, remote: 'https://github.com/synthetic/other.git' })).status, 409);
    } finally { await B.done(); }
  } finally { undo(); await A.done(); }
});

test('a bad home id or no remote is refused before any work', { timeout: 60000 }, async () => {
  const w = remotes(), A = await machine(w, { priv: true });
  try {
    assert.equal((await A.post('/api/sync/plan', { project: 'kestrel', home: 'Bad-1', remote: URL_ })).status, 400);
    assert.equal((await A.post('/api/sync/plan', { project: 'kestrel', home: 'a' })).status, 400);
  } finally { await A.done(); }
});

test('the real worker thread runs the library: a ledger remote with no access is refused (the step before gh)', { timeout: 60000 }, async () => {
  const A = await fixture();
  try {
    fs.writeFileSync(path.join(A.root, 'local', 'machine.json'), JSON.stringify({ home: A.root, ledger: { dir: fwdp(path.join(A.root, 'ledger.git')), state_root: fwdp(path.dirname(A.pa.state)) } }) + '\n');
    const r = await A.post('/api/sync/plan', { project: 'kestrel', home: 'a', remote: fwdp(path.join(A.root, 'no-such.git')), bare: true });
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.ok, false);
    assert.match(r.data.refused.join('\n'), /no access to the ledger remote/);
  } finally { await A.done(); }
});

test('the conflict chip: a lane predicted to conflict with another home\'s branch says so on its Lanes row', { timeout: 60000 }, async () => {
  assert.equal(conflictChips([]), '');
  const two = conflictChips([{ ref: 'norn/b/x', home: 'b', n: 2, files: ['a.js', 'b.js'] }, { ref: 'norn/b/y', home: 'b', n: 1 }]);
  assert.equal((two.match(/conflicts with b/g) || []).length, 1);
  assert.match(two, /norn\/b\/x: 2 files/);
  const A = await fixture();
  try {
    fs.writeFileSync(path.join(A.pa.state, 'overlap.json'), JSON.stringify({ lanes: { render: { lane: 'render', conflicts: [{ ref: 'norn/b/x', home: 'b', n: 1, files: ['a.js'] }], overlaps: [] } } }));
    const rows = (await A.get('/api/lanes?project=kestrel')).data.lanes;
    const render = rows.find(l => l.name === 'render' && l.project === 'kestrel');
    assert.deepEqual(render.conflicts.map(c => c.home), ['b']);
  } finally { await A.done(); }
});
