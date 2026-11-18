// META-GTP-FED (GT-PARITY-PLAN 2.10; pull agents - GitHub Actions self-hosted runners / Buildkite agents): labels, the claim protocol over
// the ledger repo's `claims` branch (a rejected non-fast-forward push = a lost race), `norn node run`, the home's read-only import.
// Temp dirs + temp bare repos only; the fake executor stands in for claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp, { spawn, spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startRun, queueRun, fillQueue, readiness } from '../engine/lib/runs.mjs';
import { loadState, record, kindOfId } from '../engine/lib/records.mjs';
import { parseLabels, osLabel, servedLabels, claimRun, claimKey, updateClaim, releaseClaim, pushLedger, nodeUsage, fetchClaims, readClaims } from '../engine/lib/fed.mjs';
import { mapPath } from '../engine/lib/fednode.mjs';
import { ledgerConfig, commitLedger } from '../engine/lib/ledger.mjs';
import { digest } from '../engine/lib/digest.mjs';
import { buildStatus, weeklyEstimate, crTotal } from '../engine/lib/status.mjs';
import { alive } from './helpers/settled.mjs';
import { mkTmp, SYSTEM_TMP } from './helpers/tmp.mjs';
import { fromTemplate } from './helpers/git-template.mjs';
import { waitFor, waitForSync, runEnded, childAlive, HANG_CAP_MS } from './helpers/wait.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const META = path.join(HERE, '..', 'engine', 'bin', 'norn.mjs');
const PIN = { free_gb: 64, cpu_pct: 1 };
// a valid machine.json (schema 1) + extra slots
function machineFile(dir, extra = {}, name = 'machine.json') {
  const f = path.join(dir, name);
  fs.writeFileSync(f, JSON.stringify({ schema: 1, home: dir, claude: { exe: 'claude', config_dir: dir, projects_dir: dir }, node: process.execPath,
    scheduler: { kind: 'cron', name: 'x', interval_min: 5 }, dash: { port: 0, bind: '127.0.0.1' }, projects: [], ...extra }));
  return f;
}
function sandbox(name = 'demo') {
  const t = mkTmp('meta-fed-');
  const d = { t, state: path.join(t, 'state', name), locks: path.join(t, 'state', 'locks'), notes: path.join(t, 'NOTES.md') };
  for (const k of ['state', 'locks']) fs.mkdirSync(d[k], { recursive: true });
  d.wt = n => { const w = path.join(t, 'wt' + n); fs.mkdirSync(w, { recursive: true }); return w; };
  d.brief = (body = 'mode: done\n', n = 'brief.md') => { const f = path.join(t, n); fs.writeFileSync(f, body); return f; };
  d.item = id => loadState(d.state).items[id];
  // GAP-2: a queued run reads its budget FILE at fill (no copy is kept): each launch writes the budget it is given to a file of its own
  let nb = 0;
  d.opts = (o = {}) => {
    const budget = o.budget ?? { max_claude_workers: 4 }, budget_file = path.join(t, `budget-${++nb}.json`);
    fs.writeFileSync(budget_file, JSON.stringify(budget));
    return { state: d.state, locksDir: d.locks, executor: 'fake', lane: 'demo', worktree: d.wt(1), brief: d.brief(), notes: d.notes, hbMs: 150, staleMs: 3000,
      policy: { auto_resume_max: 0 }, tick: null, ...o, budget, budget_file };
  };
  // progress-based (DEC-84 B): fails when the run's supervisor is gone unsettled, never on a clock
  d.ended = id => runEnded(d.state, id);
  return d;
}

test('labels: a labelled run always queues; the home fill starts only runs whose labels it serves (none = home, as before)', async () => {
  const d = sandbox();
  const served = { node_labels: ['windows'] };
  const lin = startRun(d.opts({ worktree: d.wt(1), labels: ['linux'], ...served }));
  assert.equal(lin.queued, true, 'a labelled run is queued, never started in place');
  const win = queueRun(d.opts({ worktree: d.wt(2), labels: ['windows'], ...served }));
  const none = queueRun(d.opts({ worktree: d.wt(3), ...served }));
  assert.deepEqual(d.item(lin.run).data.labels, ['linux']);
  const rows = readiness(d.state, { resources: () => PIN });
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.equal(by[lin.run].ready, false);
  assert.match(by[lin.run].terms.join(' | '), /labels linux: not served here \(serves windows\)/);
  assert.equal(by[lin.run].offer, true, 'ready but for its labels = offered to the nodes');
  assert.equal(by[win.run].ready, true);
  assert.equal(by[none.run].ready, true);
  const started = fillQueue(d.state, { resources: () => PIN }).map(x => x.queued).sort();
  assert.deepEqual(started, [win.run, none.run].sort());
  assert.equal(d.item(lin.run).state, 'queued');
  for (const s of fillQueue(d.state, { resources: () => PIN })) assert.fail(`started ${s.next}`);
  for (const id of [win.run, none.run]) await d.ended(d.item(id).fill.next);
});

test('labels: a labelled run with another wait term is not offered (the home walk is the one readiness evaluator)', () => {
  const d = sandbox();
  const later = new Date(Date.now() + 3600e3).toISOString();
  const q = queueRun(d.opts({ labels: ['linux'], node_labels: ['windows'], notBefore: later }));
  const [row] = readiness(d.state, { resources: () => PIN });
  assert.equal(row.id, q.run);
  assert.equal(row.offer, undefined);
  assert.match(row.terms.join(' | '), /not_before/);
});

test('labels: the run record refuses a bad labels list; norn run --labels queues and the CLI prints the labels term', () => {
  const d = sandbox();
  assert.throws(() => queueRun(d.opts({ labels: ['ok', 'Not ok'] })), /labels/);
  const mf = machineFile(d.t, { fed: { labels: ['windows'] } });
  const r = spawnSync(process.execPath, [META, 'run', '--executor', 'fake', '--lane', 'demo', '--brief', d.brief(), '--worktree', d.wt(5), '--state', d.state, '--locks', d.locks,
    '--machine', mf, '--labels', 'linux', '--no-tick'], { encoding: 'utf8', env: { ...process.env, META_FILL_SAMPLE: JSON.stringify(PIN) } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /QUEUED RUN-\d+ .*labels linux/);
});

// ---------- piece 2: the claim protocol over the ledger repo (branch `claims`, one file per claimed run) ----------
const gitIn = (dir, ...a) => { const r = spawnSync('git', a, { env: { ...process.env, GIT_DIR: dir }, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
function fedRig() {
  const t = mkTmp('meta-fedrig-');
  // an empty bare remote: one template per process (helpers/git-template.mjs, DEC-85), copied into each rig
  const { remote } = fromTemplate('fed-remote', root => { const remote = path.join(root, 'remote.git'); spawnSync('git', ['init', '-q', '--bare', remote]); return { remote }; }, t);
  const ep = host => ({ dir: path.join(t, host + '.git'), remote, host });   // a machine's own ledger repo (a temp clone of the remote)
  const tipClaims = () => { const r = spawnSync('git', ['ls-tree', '-r', '--name-only', 'refs/heads/claims'], { env: { ...process.env, GIT_DIR: remote }, encoding: 'utf8' }); return r.status ? [] : r.stdout.split('\n').filter(Boolean); };
  const claimAt = key => JSON.parse(gitIn(remote, 'show', `refs/heads/claims:${key}`));
  return { t, remote, ep, tipClaims, claimAt };
}
const RUN = { home: 'home', project: 'demo', run: 'RUN-1', labels: ['linux'] };

test('claims: a claim is one commit of one file on `claims`; a second claimer finds it and loses', () => {
  const g = fedRig();
  const a = claimRun(g.ep('nodea'), RUN), b = claimRun(g.ep('nodeb'), RUN);
  assert.equal(a.won, true);
  assert.equal(b.won, undefined);
  assert.equal(b.lost, true);
  assert.equal(b.by, 'nodea');
  assert.deepEqual(g.tipClaims(), [claimKey('home', 'demo', 'RUN-1')]);
  const c = g.claimAt(a.key);
  assert.equal(c.node, 'nodea');
  assert.equal(c.state, 'claimed');
  assert.equal(c.nonce, a.claim.nonce);
});

// the git subcommands fn spawns (fed.mjs calls spawnSync: counted through the builtin's export)
function gitSubs(fn) {
  const orig = cp.spawnSync, log = [];
  cp.spawnSync = function (cmd, args, ...rest) { if (/^git(.exe)?$/i.test(String(cmd))) log.push(args[0]); return orig.call(this, cmd, args, ...rest); };
  syncBuiltinESMExports();
  try { return [fn(), log]; } finally { cp.spawnSync = orig; syncBuiltinESMExports(); }
}

test('claims: two racing processes with two temp clones -> exactly one claim per run', async () => {
  const g = fedRig();
  const FED = path.join(HERE, '..', 'engine', 'lib', 'fed.mjs');
  const racer = (host, run) => new Promise(res => {
    const code = `import(${JSON.stringify(pathToFileURL(FED).href)}).then(m => { const r = m.claimRun(${JSON.stringify(g.ep(host))}, ${JSON.stringify({ ...RUN, run })}); process.stdout.write(JSON.stringify({ won: !!r.won, by: r.by ?? null })); })`;
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', x => { out += x; }); p.stderr.on('data', x => { err += x; });
    p.on('close', c => res({ host, c, err, r: out ? JSON.parse(out) : null }));
  });
  for (const run of ['RUN-1', 'RUN-2', 'RUN-3', 'RUN-4']) {
    const rs = await Promise.all([racer('nodea', run), racer('nodeb', run)]);
    for (const x of rs) assert.equal(x.c, 0, x.err);
    const won = rs.filter(x => x.r.won);
    assert.equal(won.length, 1, `${run}: ${JSON.stringify(rs.map(x => x.r))}`);
    assert.equal(g.claimAt(claimKey('home', 'demo', run)).node, won[0].host);
    const loser = rs.find(x => !x.r.won);
    assert.ok(loser.r.by === won[0].host || loser.r.by === null, 'the loser names the winner, or saw a moved tip (contended, next pass)');
  }
});

// a home state dir whose queued runs carry the home's ledger (spec.git_ledger, as runSpec stamps it from machine.json)
function fedHome(g, served = ['windows']) {
  const d = sandbox();
  d.led = { dir: path.join(g.t, 'home.git'), remote: g.remote, branch: 'machine/home' };
  d.q = (o = {}) => queueRun(d.opts({ labels: ['linux'], node_labels: served, git_ledger: d.led, ...o }));
  return d;
}

test('claims: the home fill records a node claim (queued -> claimed) and never starts a claimed run, even one it serves', () => {
  const g = fedRig(), d = fedHome(g, ['windows', 'linux']);
  const q = d.q();
  const c = claimRun(g.ep('nodeb'), { ...RUN, project: 'demo', run: q.run, lease_s: 900 });
  assert.equal(c.won, true);
  assert.deepEqual(fillQueue(d.state, { resources: () => PIN }), []);
  const it = d.item(q.run);
  assert.equal(it.state, 'claimed');
  assert.equal(it.claim.node, 'nodeb');
});

test('claims: the home claims a labelled run it serves (state home, no lease) before it starts it; a node then loses', async () => {
  const g = fedRig(), d = fedHome(g, ['linux']);
  const q = d.q();
  const [s] = fillQueue(d.state, { resources: () => PIN });
  assert.equal(s.queued, q.run);
  const key = claimKey('home', 'demo', q.run);
  assert.equal(g.claimAt(key).node, 'home');
  assert.equal(g.claimAt(key).state, 'home');
  const b = claimRun(g.ep('nodeb'), { ...RUN, run: q.run });
  assert.equal(b.lost, true);
  assert.equal(b.by, 'home');
  await d.ended(s.next);
});

test('claims: an expired lease returns the run to the queue (recorded); a heartbeat in time keeps it; the node then finds its claim gone', () => {
  const g = fedRig(), d = fedHome(g);
  const q = d.q();
  const T0 = Date.now(), nb = g.ep('nodeb');
  const c = claimRun(nb, { ...RUN, run: q.run, lease_s: 60, now: T0 });
  fillQueue(d.state, { now: T0 + 30e3, resources: () => PIN });
  assert.equal(d.item(q.run).state, 'claimed');
  assert.equal(updateClaim(nb, c.key, c.claim.nonce, { heartbeat_at: new Date(T0 + 50e3).toISOString() }).ok, true);
  fillQueue(d.state, { now: T0 + 100e3, resources: () => PIN });
  assert.equal(d.item(q.run).state, 'claimed', 'heartbeat at +50 s, lease 60 s: alive at +100 s');
  fillQueue(d.state, { now: T0 + 111e3, resources: () => PIN });
  const it = d.item(q.run);
  assert.equal(it.state, 'queued', 'lease expired: back in the queue');
  assert.match(it.release.why, /lease expired: nodeb/);
  assert.deepEqual(g.tipClaims(), [], 'the claim file is removed by the same CAS');
  assert.equal(updateClaim(nb, c.key, c.claim.nonce, { heartbeat_at: new Date().toISOString() }).gone, true, 'the node learns it lost the lease');
  const again = claimRun(g.ep('nodec'), { ...RUN, run: q.run });
  assert.equal(again.won, true, 'the returned run is claimable again');
});

test('claims: a lease release and a heartbeat built on the same tip - exactly one wins; a lost release records nothing', () => {
  const g = fedRig(), nb = g.ep('nodeb'), home = g.ep('home');
  const T0 = Date.now();
  const c = claimRun(nb, { ...RUN, lease_s: 1, now: T0 - 5000 });
  let hb;
  const rel = releaseClaim(home, c.key, c.claim.nonce, 'lease expired', { beforePush: () => { hb = updateClaim(nb, c.key, c.claim.nonce, { heartbeat_at: new Date(T0).toISOString() }); } });
  assert.equal(hb.ok, true);
  assert.equal(rel.ok, undefined);
  assert.equal(g.claimAt(c.key).heartbeat_at, new Date(T0).toISOString(), 'the heartbeat stands; the run was not returned');
});

test('claims: a done claim fills the home run (next = the node run, its outcome); an after: run:RUN-n:done dependent starts', async () => {
  const g = fedRig(), d = fedHome(g);
  const q = d.q();
  const nb = g.ep('nodeb'), c = claimRun(nb, { ...RUN, run: q.run, lease_s: 900 });
  fillQueue(d.state, { resources: () => PIN });
  const dep = queueRun(d.opts({ worktree: d.wt(7), after: [{ kind: 'run', id: q.run, state: 'done' }] }));
  assert.deepEqual(fillQueue(d.state, { resources: () => PIN }), [], 'claimed = still waiting');
  assert.equal(updateClaim(nb, c.key, c.claim.nonce, { state: 'done', node_run: 'RUN-wsl-3', outcome: 'done', head: null }).ok, true);
  const st = fillQueue(d.state, { resources: () => PIN });
  const it = d.item(q.run);
  assert.equal(it.state, 'filled');
  assert.deepEqual([it.fill.next, it.fill.node, it.fill.outcome], ['RUN-wsl-3', 'nodeb', 'done']);
  assert.deepEqual(st.map(x => x.queued), [dep.run]);
  await d.ended(st[0].next);
});

// ---------- piece 3: norn node run (own state dir, ids prefixed by the node id), the home's read-only import ----------
test('node: a state dir with node.json { id } names its records RUN-<id>-n; kindOfId and the fold take them', () => {
  const d = sandbox();
  fs.writeFileSync(path.join(d.state, 'node.json'), JSON.stringify({ id: 'wsl' }));
  const a = record(d.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'fake', lane: 'x' } });
  const b = record(d.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'fake', lane: 'x' } });
  assert.deepEqual([a.id, b.id], ['RUN-wsl-1', 'RUN-wsl-2']);
  assert.equal(kindOfId('RUN-wsl-2'), 'run');
  assert.equal(kindOfId('RUN-12'), 'run');
  assert.equal(kindOfId('RUN-Wsl-2'), null);
  record(d.state, { kind: 'run', ev: 'end', id: 'RUN-wsl-2', by: 'launcher', data: { exit: 0, outcome: 'done' } });
  assert.equal(loadState(d.state).items['RUN-wsl-2'].state, 'exited');
});

test('node: path_map maps a home path to the node (first matching prefix; a Windows drive is case-blind)', () => {
  const map = [{ from: 'D:/Work/dev', to: '/mnt/d/Work/dev' }, { from: 'C:/', to: '/mnt/c/' }];
  assert.equal(mapPath('d:\\Work\\dev\\wt\\a.md', map), '/mnt/d/Work/dev/wt/a.md');
  assert.equal(mapPath('c:/Temp/x', map), '/mnt/c/Temp/x');
  assert.equal(mapPath('/srv/x', map), '/srv/x');
  assert.equal(mapPath(undefined, map), undefined);
});

// home + nodes on one box: one remote, every machine its own ledger repo + state root + reviews dir + machine.json (fed.host names it)
function fedWorld() {
  const g = fedRig();
  const machine = (name, extra = {}) => {
    const root = path.join(g.t, name), meta = path.join(root, 'meta');
    const ledger = { dir: path.join(root, 'ledger.git'), remote: g.remote, state_root: path.join(meta, 'state'), reviews: path.join(root, 'reviews') };
    fs.mkdirSync(path.join(meta, 'state'), { recursive: true });
    fs.mkdirSync(ledger.reviews, { recursive: true });
    const mf = machineFile(root, { ledger, ...extra });
    return { root, meta, mf, ledger, state: p => path.join(meta, 'state', p) };
  };
  const home = machine('home', { fed: { host: 'home', labels: ['windows'] } });
  const hcfg = ledgerConfig(JSON.parse(fs.readFileSync(home.mf, 'utf8')), { metaRoot: home.meta, machineFile: home.mf });
  const d = sandbox();
  d.state = home.state('demo');
  fs.mkdirSync(d.state, { recursive: true });
  d.q = (o = {}) => queueRun(d.opts({ labels: ['linux'], node_labels: ['windows'], git_ledger: hcfg, ...o }));
  d.publish = () => { fillQueue(d.state, { resources: () => PIN }); const c = commitLedger(hcfg, 'test', { push: false, gc: false }); assert.ok(!c.error, c.error); pushLedger(hcfg); };
  // FED-2 D8: a node whose fed.path_map covers the home paths shares the filesystem (this box: the identity map of the temp dir); none = its own workspace
  const node = (host, fed = {}) => machine(host, { fed: { host, labels: ['linux'], heartbeat_s: 1, path_map: [{ from: SYSTEM_TMP, to: SYSTEM_TMP }], ...fed } });
  // the node run is its own producer: spawnSync returns when it ends; HANG_CAP_MS is only a hang guard (DEC-84 B; a 60 s timeout
  // killed a slow but live node on the loaded Windows leg, CI 43207062452: status null)
  const nodeRunCli = (n, args = []) => spawnSync(process.execPath, [META, 'node', 'run', '--home', g.remote, '--machine', n.mf, ...args],
    { encoding: 'utf8', env: { ...process.env, META_ROOT: n.meta, META_FILL_SAMPLE: JSON.stringify(PIN) }, timeout: HANG_CAP_MS });
  return { g, home, hcfg, d, node, nodeRunCli };
}
const remoteFile = (g, ref, key) => { const r = spawnSync('git', ['show', `${ref}:${key}`], { env: { ...process.env, GIT_DIR: g.remote }, encoding: 'utf8' }); return r.status ? null : r.stdout; };

test('node run: claims the offered linux run, runs it in its own state dir (RUN-wsl-1), DONE, pushes machine/<host>; the home records the fill and imports the node run read-only', async () => {
  const w = fedWorld(), { d, g } = w;
  const q = d.q();
  d.publish();
  const n = w.node('nodew', { id: 'wsl' });
  const r = w.nodeRunCli(n);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, new RegExp(`CLAIMED home/demo/${q.run} -> RUN-wsl-1`));
  assert.match(r.stdout, /RUN-wsl-1 done/);
  const nst = n.state('demo'), it = loadState(nst).items['RUN-wsl-1'];
  assert.equal(it.state, 'exited');
  assert.equal(it.end.outcome, 'done');
  assert.deepEqual(it.data.claim_of, { home: 'home', project: 'demo', run: q.run, node: 'nodew' });
  assert.match(fs.readFileSync(d.notes, 'utf8'), /work: done/, 'the NOTES path (shared filesystem: path_map) got the log');
  const claim = JSON.parse(remoteFile(g, 'refs/heads/claims', claimKey('home', 'demo', q.run)));
  assert.deepEqual([claim.state, claim.node_run, claim.outcome], ['done', 'RUN-wsl-1', 'done']);
  assert.match(remoteFile(g, 'refs/heads/machine/nodew', 'meta/state/demo/runs.jsonl'), /RUN-wsl-1/, 'the node events are on machine/<host>');
  // home: never in its own runs.jsonl; the fill records claim + fill and imports the node runs into fed-cache.json
  fillQueue(d.state, { resources: () => PIN });
  const h = loadState(d.state).items;
  assert.equal(h[q.run].state, 'filled');
  assert.deepEqual([h[q.run].fill.next, h[q.run].fill.node, h[q.run].fill.outcome], ['RUN-wsl-1', 'nodew', 'done']);
  assert.equal(h['RUN-wsl-1'], undefined, 'no foreign event in the home runs.jsonl');
  assert.doesNotMatch(fs.readFileSync(path.join(d.state, 'runs.jsonl'), 'utf8'), /"id":"RUN-wsl-1"/);
  const cacheF = path.join(d.state, 'fed-cache.json'), cache = JSON.parse(fs.readFileSync(cacheF, 'utf8'));
  assert.equal(cache.nodes.nodew.find(x => x.id === 'RUN-wsl-1').state, 'exited', 'the fill imported the node run');
  assert.equal(digest(d.state, {}, { dlv: [], ready: [] }).sections.finished.length, 0, 'a fake run is no work row (isWork), at home or on a node');
  cache.nodes.nodew.find(x => x.id === 'RUN-wsl-1').data.kind = 'worker';   // as a claude run on the node
  fs.writeFileSync(cacheF, JSON.stringify(cache));
  const dg = digest(d.state, {}, { dlv: [], ready: [] });
  const row = dg.sections.finished.find(x => x.id === 'RUN-wsl-1');
  assert.ok(row, JSON.stringify(dg.sections.finished));
  assert.equal(row.node, 'nodew');
  const all = spawnSync(process.execPath, [META, 'runs', '--all-nodes', '--state', d.state, '--machine', w.home.mf], { encoding: 'utf8', env: { ...process.env, META_ROOT: w.home.meta } });
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /nodew\s+RUN-wsl-1\s+exited\s+done/);
  assert.match(all.stdout, new RegExp(`home\\s+${q.run}\\s+filled`));
  const nothing = w.nodeRunCli(n);
  assert.equal(nothing.status, 0);
  assert.match(nothing.stdout, /no offered run/);
});

test('node run: a lost lease fences the node run (recorded lost, tree killed) - never two executions', async () => {
  const w = fedWorld(), { d, g } = w;
  const q = d.q({ brief: d.brief('mode: sleep\nms: 60000\n', 'sleep.md') });
  d.publish();
  const n = w.node('nodew', { id: 'wsl', heartbeat_s: 1 });
  const p = spawn(process.execPath, [META, 'node', 'run', '--home', g.remote, '--machine', n.mf], { env: { ...process.env, META_ROOT: n.meta, META_FILL_SAMPLE: JSON.stringify(PIN) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', x => { out += x; }); p.stderr.on('data', x => { out += x; });
  const done = new Promise(res => p.on('close', res));
  const key = claimKey('home', 'demo', q.run);
  await waitFor(() => { const c = remoteFile(g, 'refs/heads/claims', key); return c && JSON.parse(c).state === 'running'; }, { producer: childAlive(p), what: 'the node claims and runs' });
  const c = JSON.parse(remoteFile(g, 'refs/heads/claims', key));
  // the home's release races the node's 1 s heartbeat (CI 43116967024 Windows): a heartbeat landing between its fetch and its push
  // makes the CAS contended - the engine contract (fed.mjs releaseClaim; fillQueue's fedPass looks again next pass). The first release
  // is forced into that race (beforePush waits for a heartbeat to move the claims tip); the home then releases on the new tip until
  // its CAS lands (each contended CAS = another heartbeat landed first; the claim keeps its nonce, so it is never `gone` here).
  const tip = () => spawnSync('git', ['rev-parse', 'refs/heads/claims'], { env: { ...process.env, GIT_DIR: g.remote }, encoding: 'utf8' }).stdout.trim();
  // the heartbeat's producer is the node process (a sync wait: its liveness by pid, the event loop does not run here)
  const heartbeatLands = () => { const t = tip(); waitForSync(() => tip() !== t, { producer: () => alive(p.pid), what: 'a node heartbeat moves the claims tip', pollMs: 100 }); };
  const raced = releaseClaim(w.g.ep('home'), key, c.nonce, 'test: the home expired it', { beforePush: heartbeatLands });
  assert.equal(raced.contended, true, JSON.stringify(raced));
  let rel;
  while ((rel = releaseClaim(w.g.ep('home'), key, c.nonce, 'test: the home expired it')).contended);
  assert.equal(rel.ok, true, JSON.stringify(rel));
  assert.equal(await done, 0, out);
  assert.match(out, /lease lost/);
  const it = loadState(n.state('demo')).items['RUN-wsl-1'];
  assert.equal(it.state, 'lost');
  assert.match(it.lost.why, /lease lost/);
});

// ---------- FED-2 piece 1 (D8): a node with no shared filesystem checks the run's branch out into its own workspace (actions/checkout) ----------
const gitC = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const inDir = (p, dir) => { const r = path.relative(path.resolve(dir), path.resolve(p)); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
// the home lane worktree: a clone of a temp origin on branch `lane-x`, pushed (what the node checks out)
// (DEC-85) built once per process (helpers/git-template.mjs) and copied into each rig: same commit, same paths in the rig
const laneRepo = g => fromTemplate('fed-lane', buildLaneRepo, g.t);
function buildLaneRepo(root) {
  const origin = path.join(root, 'origin.git'), wt = path.join(root, 'home-wt');
  gitC(root, 'init', '-q', '--bare', origin);
  fs.mkdirSync(wt);
  gitC(wt, 'init', '-q', '-b', 'lane-x');
  fs.writeFileSync(path.join(wt, 'README.md'), 'lane x\n');
  gitC(wt, 'add', 'README.md'); gitC(wt, 'commit', '-q', '-m', 'lane x');
  gitC(wt, 'remote', 'add', 'origin', origin); gitC(wt, 'push', '-q', 'origin', 'lane-x');
  return { origin, wt, head: gitC(wt, 'rev-parse', 'HEAD') };
}

test('workspace: a node with no shared filesystem never claims an offer it cannot check out (no git worktree at home)', () => {
  const w = fedWorld(), { d, g } = w;
  const q = d.q();
  d.publish();
  const n = w.node('nodew', { id: 'wsl', path_map: [{ from: '/srv/elsewhere', to: '/x' }] });   // a map that does not cover the home paths
  const r = w.nodeRunCli(n);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /no offered run/);
  assert.equal(remoteFile(g, 'refs/heads/claims', claimKey('home', 'demo', q.run)), null, 'not claimed');
});

// ---------- FED-2 piece 3: Claude rows are offered to nodes again (DEC-47's interim "node 2 non-Claude only" lifted) - the one guard counts all nodes ----------
function guardRig(w, { calib_pct = 95, weekly_stop_pct = 98 } = {}) {
  const { d } = w, empty = mkTmp('meta-fedp-');
  const budget = { max_claude_workers: 4, weekly_stop_pct, calib_time_utc: new Date(Date.now() - 3600000).toISOString().slice(0, 16) + 'Z', calib_pct, cacheR_per_pct: 10000000 };
  const statusFile = path.join(d.state, 'STATUS.md');
  const o = { state: d.state, project: 'demo', budget, projectsDir: empty, usageJson: {} };
  return { budget, statusFile, o, status: () => { const s = buildStatus(o); fs.writeFileSync(statusFile, s.text); return s; } };
}
const offered = d => { try { return JSON.parse(fs.readFileSync(path.join(d.state, 'views', 'FED-OFFERS.json'), 'utf8')).rows; } catch { return []; } };

test('claude rows: a Claude-account labelled row is offered while the guard allows; its node usage, imported by the home fill, holds the next one', async () => {
  const w = fedWorld(), { d } = w, G = guardRig(w);
  assert.equal(G.status().weekly, 95);
  const a = d.q({ budget: G.budget, statusFile: G.statusFile, brief: d.brief('mode: done\ncache_read: 40000000\n', 'a.md') });
  d.publish();
  assert.deepEqual(offered(d).map(r => [r.id, r.executor]), [[a.run, 'fake']], 'a Claude-account row (fake = claude) is offered to the nodes');
  const n = w.node('nodew', { id: 'wsl' });
  const r = w.nodeRunCli(n);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(loadState(n.state('demo')).items['RUN-wsl-1'].end.node_usage.cache_read, 40e6);
  const b = d.q({ budget: G.budget, statusFile: G.statusFile, worktree: d.wt(2) });
  fillQueue(d.state, { resources: () => PIN });   // imports the node run into fed-cache.json
  const s = G.status();
  assert.equal(s.weekly, 99, '95 + 40M / 10M from the node');
  fillQueue(d.state, { resources: () => PIN });
  assert.deepEqual(offered(d), [], 'the guard (now counting the node) holds the next Claude row: never offered');
  const row = readiness(d.state, { resources: () => PIN }).find(x => x.id === b.run);
  assert.ok(row.terms.some(t => /^usage: weekly 99\.0 % >= guard 98 %/.test(t)), JSON.stringify(row.terms));
});

// ---------- FED-2 piece 4: the proof on this box (temp repos, the fake executor) ----------
test('proof: a node with NO path_map runs a labelled run from its own checkout, DONE seen at home with its notes; its cache_read N moves the home estimate by exactly N / cacheR_per_pct (once)', async () => {
  const w = fedWorld(), { d, g } = w, L = laneRepo(g), G = guardRig(w, { calib_pct: 50 });
  const N = 12345678, est = () => weeklyEstimate(G.o, new Date());
  const before = est();
  const q = d.q({ worktree: L.wt, budget: G.budget, statusFile: G.statusFile, brief: d.brief(`mode: done\ncache_read: ${N}\n`, 'proof.md') });
  G.status(); d.publish();
  const n = w.node('nodew', { id: 'wsl', path_map: undefined });
  const r = w.nodeRunCli(n);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const it = loadState(n.state('demo')).items['RUN-wsl-1'];
  assert.equal(path.resolve(it.data.worktree), path.resolve(n.state('demo'), 'ws', 'demo'), 'its own checkout');
  assert.deepEqual(it.end.node_usage, { tokens: 10 + N + 30 + 5, cache_read: N });
  assert.equal(est().all.nodes, 0, 'not imported yet: the home counts nothing before its fill');
  fillQueue(d.state, { resources: () => PIN });
  const h = loadState(d.state).items[q.run];
  assert.deepEqual([h.state, h.fill.outcome, h.fill.node, h.fill.next], ['filled', 'done', 'nodew', 'RUN-wsl-1'], 'DONE seen at home');
  assert.match(fs.readFileSync(h.fill.notes, 'utf8'), /## fake RUN-wsl-1[\s\S]*work: done/, 'with its notes');
  const after = est();
  assert.equal(crTotal(after.all) - crTotal(before.all), N, 'the account cacheR moved by exactly the node run\'s cache_read');
  assert.equal(after.pct - before.pct, N / G.budget.cacheR_per_pct, 'the estimate moved by exactly N / cacheR_per_pct');
  assert.match(G.status().text, /\(\+ nodes 12\.3M/);
  fillQueue(d.state, { resources: () => PIN }); fillQueue(d.state, { resources: () => PIN });   // more fills re-import the same node run
  assert.equal(crTotal(est().all) - crTotal(before.all), N, 'counted once, never twice');
});
