// RM-46 S6b (SPEC sec. 6, 7, 8 S6b): norn sync join - a second machine joins a synced project as home b, in the spec's order: access,
// the ledger repo is private, register, machine.json, the cut (dry run shown, then applied), the first publish + fetch, the collaborator
// step. A synthetic world: one bare git "origin" and one bare ledger remote; home a (the bare home) has cut and published. The ledger is
// reached under a GitHub-shaped URL through git's url.<base>.insteadOf (env), so the private check and the collaborator line run on a
// fake gh; no network, no test sleeps. Synthetic names only (project demo, repo synthetic/ledger, login joiner-login).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { syncCut } from '../engine/lib/synccut.mjs';
import { syncJoin, publishHome } from '../engine/lib/sync.mjs';
import { ledgerConfig } from '../engine/lib/ledger.mjs';
import { homeOf } from '../engine/lib/records.mjs';
import { listClaims } from '../engine/lib/claims.mjs';
import { fedOf } from '../engine/lib/fed.mjs';
import { main } from '../engine/bin/norn.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const URL_ = 'https://github.com/synthetic/ledger.git';
const git = (cwd, ...a) => { const r = spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', windowsHide: true }); if (r.status) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const ident = ['-c', 'user.name=t', '-c', 'user.email=t@x'];
const TS = '2026-11-20T10:00:00Z';
const line = (id, kind, ev, by, data = {}) => JSON.stringify({ v: 1, seq: 1, ts: TS, id, kind, ev, by, run: null, data });
const fwdp = p => p.split(path.sep).join('/');

// the ledger remote answers under URL_ for every git this process starts (restored after each test)
function viaGithub(ledgerRemote) {
  const keep = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'].map(k => [k, process.env[k]]);
  Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${fwdp(ledgerRemote)}.insteadOf`, GIT_CONFIG_VALUE_0: URL_ });
  return () => { for (const [k, v] of keep) if (v === undefined) delete process.env[k]; else process.env[k] = v; };
}
const fakeGh = (priv, calls = []) => args => { calls.push(args.join(' ')); return args[1] === 'repos/synthetic/ledger' ? (priv === null ? null : `${priv}\n`) : args[1] === 'user' ? 'joiner-login\n' : null; };

/** one machine: meta root (mkTmp: <t>/state/demo), machine.json (its ledger block: remote only for home a), a clone of origin, paused */
function rig(w, name, { remote = null } = {}) {
  const state = mkTmp(`meta-join-${name}-`, 'demo'), meta = path.dirname(path.dirname(state)), mf = path.join(meta, 'local', 'machine.json');
  fs.mkdirSync(path.dirname(mf), { recursive: true }); fs.mkdirSync(path.join(meta, 'reviews'), { recursive: true });
  const machine = { ledger: { dir: fwdp(path.join(meta, 'ledger.git')), state_root: fwdp(path.join(meta, 'state')), reviews: fwdp(path.join(meta, 'reviews')), ...(remote ? { remote } : {}) }, fed: { host: 'host-' + name } };
  fs.writeFileSync(mf, JSON.stringify(machine, null, 2) + '\n');
  const repo = path.join(meta, 'repo');
  spawnSync('git', ['clone', '-q', w.origin, repo], { windowsHide: true });
  git(repo, 'branch', 'norn/w', 'main'); git(repo, 'push', '-q', 'origin', 'norn/w');
  fs.writeFileSync(path.join(state, 'records.jsonl'), line('L:w', 'lane', 'create', 'checkin', { name: 'w' }) + '\n');
  fs.writeFileSync(path.join(state, 'roadmap.jsonl'), line('RM-1', 'item', 'create', 'owner', { title: `${name}'s first`, links: ['lane:w'] }) + '\n');
  fs.writeFileSync(path.join(state, 'PAUSED'), JSON.stringify({ mode: 'drain', by: 'owner', at: TS }) + '\n');
  return { state, meta, mf, machine, repo, project: { name: 'demo', root: repo, state } };
}
/** origin + ledger remote; home a cut as the bare home (its lane branch moved to norn/a/w) and published; home b not joined yet */
function world() {
  const t = mkTmp('meta-join-w-', 'x'), root = path.dirname(path.dirname(t));
  const origin = path.join(root, 'origin.git'), ledgerRemote = path.join(root, 'ledger-remote.git');
  for (const d of [origin, ledgerRemote]) spawnSync('git', ['init', '-q', '--bare', '-b', 'main', d], { windowsHide: true });
  const seed = path.join(root, 'seed');
  spawnSync('git', ['init', '-q', '-b', 'main', seed], { windowsHide: true });
  fs.writeFileSync(path.join(seed, 'README.md'), 'demo\n');
  git(seed, 'add', '.'); git(seed, ...ident, 'commit', '-qm', 'init'); git(seed, 'remote', 'add', 'origin', origin); git(seed, 'push', '-q', 'origin', 'main');
  const w = { origin, ledgerRemote };
  const A = rig(w, 'a', { remote: fwdp(ledgerRemote) });
  const cfgA = ledgerConfig(A.machine, { metaRoot: A.meta, machineFile: A.mf });
  const cut = syncCut({ state: A.state, project: A.project, home: 'a', bare: true, apply: true, ledger: cfgA, machineFile: A.mf, openPr: () => false, ledgerOpts: { push: false, gc: false } });
  assert.deepEqual(cut.refused, []);
  assert.equal(publishHome(cfgA).pushed, true);
  // home b: the same branch name on origin would clash with a's renamed one only if a kept it; b's lane branch is its own norn/w (a moved to norn/a/w)
  const B = rig({ origin }, 'b');
  return { w, A, B };
}
const join = (B, o = {}) => syncJoin({ home: 'b', remote: URL_, topic: 'fake-topic-0000', machineFile: B.mf, metaRoot: B.meta, projects: [B.project], openPr: () => false, ledgerOpts: { push: false, gc: false }, gh: fakeGh(true), ...o });
const heads = dir => spawnSync('git', ['--git-dir', dir, 'for-each-ref', '--format=%(refname) %(objectname)'], { encoding: 'utf8', windowsHide: true }).stdout;
const tree = dir => { const o = {}; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else o[path.relative(dir, p)] = fs.readFileSync(p, 'utf8'); } }; walk(dir); return o; };

test('sync join: access, private, register, machine.json, the cut (dry run, then applied), the first publish + fetch, the collaborator step', () => {
  const { w, B } = world(), undo = viaGithub(w.ledgerRemote);
  try {
    const calls = [];
    const r = join(B, { gh: fakeGh(true, calls) });
    assert.deepEqual(r.refused, [], r.lines.join('\n'));
    const at = re => r.lines.findIndex(l => re.test(l));
    const order = [/^1\. access/, /^2\. private: synthetic\/ledger is private/, /^3\. registered homes\/b\.json/, /^4\. machine\.json/, /DRY RUN/, /APPLIED/, /^6\. publish/, /^6\. fetch/, /^7\. /].map(at);
    assert.ok(order.every(i => i >= 0), r.lines.join('\n'));
    assert.deepEqual([...order].sort((x, y) => x - y), order, 'the steps run in the spec\'s order');
    assert.match(r.lines.at(-1), /gh api -X PUT repos\/synthetic\/ledger\/collaborators\/joiner-login -f permission=push/);
    assert.ok(calls.includes('api repos/synthetic/ledger --jq .private'));
    // the effects: home.json (joiner of bare home a), machine.json, the claims registration, home/b on the remote, a's copies here
    assert.deepEqual({ id: homeOf(B.state).id, bare: homeOf(B.state).bare_home }, { id: 'b', bare: 'a' });
    const led = JSON.parse(fs.readFileSync(B.mf, 'utf8')).ledger;
    assert.deepEqual([led.remote, led.home_id, led.doorbell], [URL_, 'b', { topic: 'fake-topic-0000' }]);
    const cfgB = ledgerConfig({ ledger: led }, { metaRoot: B.meta, machineFile: B.mf });
    assert.ok(listClaims(fedOf(cfgB))['homes/b.json'], 'registered');
    assert.match(heads(w.ledgerRemote), /refs\/heads\/home\/b /, 'the first publish pushed home/b');
    assert.ok(fs.existsSync(path.join(B.state, 'homes', 'a', 'roadmap.jsonl')), 'the first fetch copied home a');
    assert.match(fs.readFileSync(path.join(B.state, 'roadmap.jsonl'), 'utf8'), /"RM-b-1"/, 'the cut renamed b\'s ids');
    assert.match(heads(w.origin), /refs\/heads\/norn\/b\/w /, 'and moved b\'s lane branch');
  } finally { undo(); }
});

test('sync join: a re-join is a no-op (state, machine.json, remotes untouched)', () => {
  const { w, B } = world(), undo = viaGithub(w.ledgerRemote);
  try {
    assert.deepEqual(join(B).refused, []);
    const st = tree(B.state), mf = fs.readFileSync(B.mf, 'utf8'), led = heads(w.ledgerRemote), org = heads(w.origin);
    const again = join(B);
    assert.deepEqual(again.refused, []);
    assert.equal(again.noop, true, again.lines.join('\n'));
    assert.deepEqual(tree(B.state), st); assert.equal(fs.readFileSync(B.mf, 'utf8'), mf); assert.equal(heads(w.ledgerRemote), led); assert.equal(heads(w.origin), org);
  } finally { undo(); }
});

test('sync join: a taken home id is refused before anything is written', () => {
  const { w, B } = world(), undo = viaGithub(w.ledgerRemote);
  try {
    const mf = fs.readFileSync(B.mf, 'utf8'), led = heads(w.ledgerRemote);
    const r = join(B, { home: 'a' });
    assert.match(r.refused.join('\n'), /home id a is taken/);
    assert.equal(fs.readFileSync(B.mf, 'utf8'), mf); assert.equal(homeOf(B.state), null); assert.equal(heads(w.ledgerRemote), led);
  } finally { undo(); }
});

test('sync join: a public ledger (fake gh) is refused; gh with no answer needs --i-checked-private; no access is refused', () => {
  const { w, B } = world(), undo = viaGithub(w.ledgerRemote);
  try {
    const mf = fs.readFileSync(B.mf, 'utf8'), led = heads(w.ledgerRemote);
    assert.match(join(B, { gh: fakeGh(false) }).refused.join('\n'), /synthetic\/ledger is PUBLIC/);
    assert.match(join(B, { gh: fakeGh(null) }).refused.join('\n'), /--i-checked-private/);
    assert.match(join(B, { remote: fwdp(path.join(B.meta, 'no-such.git')) }).refused.join('\n'), /no access to the ledger remote/);
    assert.equal(fs.readFileSync(B.mf, 'utf8'), mf); assert.equal(homeOf(B.state), null); assert.equal(heads(w.ledgerRemote), led);
    // a non-GitHub ledger (a bare path) with --i-checked-private joins
    const r = join(B, { remote: fwdp(w.ledgerRemote), gh: fakeGh(null), iCheckedPrivate: true });
    assert.deepEqual(r.refused, [], r.lines.join('\n'));
    assert.match(r.lines.join('\n'), /--i-checked-private/);
  } finally { undo(); }
});

test('cli: norn sync join needs --home and --ledger', async () => {
  const o = [], e = [], env = { ...process.env, META_ROOT: path.dirname(path.dirname(mkTmp('meta-join-cli-', 'x'))) };
  assert.equal(await main(['sync', 'join', '--home', 'b'], env, s => o.push(s), s => e.push(s)), 2);
  assert.match(e.join('\n'), /--ledger/);
  assert.equal(await main(['sync', 'join', '--home', 'B!', '--ledger', URL_], env, s => o.push(s), s => e.push(s)), 2);
});
