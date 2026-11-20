// RM-46 S2a (SPEC 3.6, 4.4, 5): work claims on the shared `claims` branch - registration, claimWork's CAS rounds, the overlap rule
// (item / branch refuse, scope queues, own home never blocks), allow pairs, release. Temp bare remotes only; races are forced through
// casClaims' beforePush seam, so no test sleeps. Synthetic homes a, b, c and project demo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { claimWork, workKey, registerHome, registerProject, allowPair, releaseWork, listClaims, overlapOf } from '../engine/lib/claims.mjs';
import { claimRun } from '../engine/lib/fed.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { fromTemplate } from './helpers/git-template.mjs';

const gitIn = (dir, ...a) => { const r = spawnSync('git', a, { env: { ...process.env, GIT_DIR: dir }, encoding: 'utf8', windowsHide: true }); return r.status ? null : r.stdout.trim(); };
function rig() {
  const t = mkTmp('meta-claims-');
  const { remote } = fromTemplate('claims-remote', root => { const remote = path.join(root, 'remote.git'); spawnSync('git', ['init', '-q', '--bare', remote], { windowsHide: true }); return { remote }; }, t);
  const ep = home => ({ dir: path.join(t, home + '.git'), remote, host: 'host-' + home });   // each home's own ledger repo
  const files = () => (gitIn(remote, 'ls-tree', '-r', '--name-only', 'refs/heads/claims') || '').split('\n').filter(Boolean);
  const at = key => { const s = gitIn(remote, 'show', `refs/heads/claims:${key}`); return s ? JSON.parse(s) : null; };
  const tip = () => gitIn(remote, 'rev-parse', '-q', '--verify', 'refs/heads/claims');
  return { t, remote, ep, files, at, tip };
}
const me = (home, lane, o = {}) => ({ project: 'demo', home, lane, branch: `norn/${home}/${lane}`, items: [], scope: [`src/${lane}/**`], touched: [], run: `RUN-${home}-1`, ...o });

test('registry: a home registers by CAS-creating homes/<id>.json; the id is then taken; a project file names its bare home', () => {
  const g = rig();
  const a = registerHome(g.ep('a'), { id: 'a', branch: 'home/a', projects: ['demo'], now: Date.UTC(2026, 10, 20) });
  assert.equal(a.ok, true);
  assert.deepEqual(g.at('homes/a.json'), { v: 1, kind: 'home', id: 'a', branch: 'home/a', projects: ['demo'], joined_at: '2026-11-20T00:00:00.000Z' });
  const again = registerHome(g.ep('x'), { id: 'a', branch: 'home/a', projects: [] });
  assert.equal(again.exists, true, 'a second home with id a is refused');
  assert.equal(registerProject(g.ep('a'), { project: 'demo', repo: 'owner/demo', bare_home: 'a' }).ok, true);
  assert.deepEqual(g.at('projects/demo.json'), { v: 1, kind: 'project', project: 'demo', repo: 'owner/demo', bare_home: 'a' });
  assert.equal(registerProject(g.ep('b'), { project: 'demo', repo: 'owner/demo', bare_home: 'b' }).exists, true);
});

test('claimWork: a new claim is one CAS commit of work/<project>/<home>/<lane>.json; an unchanged own claim costs no push; a change bumps n', () => {
  const g = rig(), fa = g.ep('a');
  const r = claimWork(fa, me('a', 'x', { items: ['RM-a-1'] }));
  assert.equal(r.won, true);
  assert.equal(r.key, 'work/demo/a/x.json');
  assert.equal(r.n, 1);
  const c = g.at(r.key);
  assert.equal(c.kind, 'work'); assert.equal(c.n, 1); assert.equal(c.lease_s, 3600); assert.deepEqual(c.items, ['RM-a-1']);
  const t = g.tip(), same = claimWork(fa, me('a', 'x', { items: ['RM-a-1'] }));
  assert.equal(same.won, true); assert.equal(same.again, true); assert.equal(g.tip(), t, 'unchanged: no push');
  const more = claimWork(fa, me('a', 'x', { items: ['RM-a-1'], touched: ['src/x/a.js'] }));
  assert.equal(more.n, 2);
  assert.equal(g.at(r.key).nonce, c.nonce, 'the nonce stays');
  assert.deepEqual(g.at(r.key).touched, ['src/x/a.js']);
});

test('race: two homes claim one item on the same tip - exactly one claim lands, the loser re-reads and is refused (it names the holder)', () => {
  const g = rig(), fa = g.ep('a'), fb = g.ep('b');
  claimWork(fa, me('a', 'seed'));   // a non-empty tip both build on
  let rb;
  const ra = claimWork(fa, me('a', 'x', { items: ['RM-7'] }), { beforePush: () => { if (!rb) rb = claimWork(fb, me('b', 'y', { items: ['RM-7'] })); } });
  assert.equal(rb.won, true, 'b pushed first');
  assert.equal(ra.refused, true);
  assert.equal(ra.hit.kind, 'item');
  assert.match(ra.why, /b\/y/);
  assert.deepEqual(g.files().filter(k => k.startsWith('work/demo/') && !k.endsWith('seed.json')), ['work/demo/b/y.json'], 'exactly one claim landed');
});

test('overlap: item and branch refuse; scope only queues with the globs named; disjoint globs pass (the near miss); own home never blocks', () => {
  const g = rig(), fa = g.ep('a'), fb = g.ep('b');
  assert.equal(claimWork(fa, me('a', 'x', { items: ['RM-1'], scope: ['engine/lib/slop/**'], branch: 'norn/a/x' })).won, true);
  const br = claimWork(fb, me('b', 'y', { branch: 'norn/a/x', scope: ['docs/**'] }));
  assert.equal(br.refused, true); assert.equal(br.hit.kind, 'branch');
  const sc = claimWork(fb, me('b', 'z', { scope: ['engine/lib/slop/door.mjs'] }));
  assert.equal(sc.queued, true); assert.equal(sc.hit.kind, 'scope');
  assert.match(sc.why, /scope overlaps a\/x: engine\/lib\/slop\/\*\*/);
  const tch = claimWork(fb, me('b', 't', { scope: ['docs/**'], touched: ['engine/lib/slop/x.mjs'] }));
  assert.equal(tch.queued, true, 'touched counts as scope');
  assert.equal(claimWork(fb, me('b', 'w', { scope: ['engine/lib/slopx/**', 'engine/lib/*.md'] })).won, true, 'disjoint globs pass');
  assert.equal(claimWork(fa, me('a', 'v', { items: ['RM-1'], scope: ['engine/lib/slop/**'] })).won, true, 'own claims never block own dispatch');
  assert.equal(overlapOf(me('a', 'x', { scope: ['a/**'] }), me('a', 'y', { scope: ['a/**'] })), null, 'same home: no overlap');
});

test('a brief without a Scope: line claims the whole repo; others queue behind it and the why says so', () => {
  const g = rig();
  assert.equal(claimWork(g.ep('a'), me('a', 'x', { scope: [] })).won, true);
  assert.deepEqual(g.at('work/demo/a/x.json').scope, ['**']);
  const q = claimWork(g.ep('b'), me('b', 'y', { scope: ['docs/x.md'] }));
  assert.equal(q.queued, true);
  assert.match(q.why, /brief has no Scope: line/);
});

test('ambiguous end: a push reported rejected that did land is read back by nonce + n and counts as won', () => {
  const g = rig(), fa = g.ep('a'), fc = g.ep('c');
  claimWork(fa, me('a', 'seed'));
  const r = claimWork(fa, me('a', 'x'), { beforePush: sha => {
    // the push lands, then another home builds on it: a's own push of that sha now looks like a lost race
    assert.equal(spawnSync('git', ['push', '-q', g.remote, `${sha}:refs/heads/claims`], { env: { ...process.env, GIT_DIR: fa.dir }, windowsHide: true }).status, 0);
    assert.equal(claimWork(fc, me('c', 'q')).won, true);
  } });
  assert.equal(r.won, true);
  assert.equal(g.at('work/demo/a/x.json').nonce, r.claim.nonce);
});

test('contention: three rejected rounds give queued (claims branch busy); every round re-checks on the new tip', () => {
  const g = rig(), fa = g.ep('a'), fc = g.ep('c');
  let k = 0;
  const r = claimWork(fa, me('a', 'x'), { beforePush: () => { assert.equal(claimWork(fc, me('c', `q${++k}`)).won, true); } });
  assert.equal(r.queued, true);
  assert.match(r.why, /claims branch busy/);
  assert.equal(k, 3);
  assert.equal(g.at('work/demo/a/x.json'), null);
});

test('allow: an owner allow file skips the pair; release removes the claim and the allow files that name it', () => {
  const g = rig(), fa = g.ep('a'), fb = g.ep('b');
  claimWork(fa, me('a', 'x', { scope: ['src/**'] }));
  assert.equal(claimWork(fb, me('b', 'y', { scope: ['src/y/**'] })).queued, true);
  const al = allowPair(fb, { project: 'demo', a: 'b/y', b: 'a/x', why: 'synthetic', now: 0 });
  assert.equal(al.ok, true);
  assert.equal(al.key, 'allow/demo/a~x+b~y.json', 'the pair is sorted');
  assert.equal(claimWork(fb, me('b', 'y', { scope: ['src/y/**'] })).won, true);
  const rel = releaseWork(fa, { project: 'demo', home: 'a', lane: 'x' });
  assert.equal(rel.ok, true);
  assert.deepEqual(g.files().sort(), ['work/demo/b/y.json']);
  assert.equal(releaseWork(fa, { project: 'demo', home: 'a', lane: 'x' }).gone, true);
});

test('offline: the pre-check holds on the last fetched claims without the network; a new claim with no ledger queues', () => {
  const g = rig(), fa = g.ep('a'), fb = g.ep('b');
  claimWork(fa, me('a', 'x', { scope: ['src/**'] }));
  assert.equal(claimWork(fb, me('b', 'y', { scope: ['src/y/**'] })).queued, true);   // b has now fetched a's claim
  const off = { ...fb, remote: path.join(g.t, 'gone.git') };
  const pre = claimWork(off, me('b', 'y', { scope: ['src/y/**'] }));
  assert.equal(pre.queued, true); assert.equal(pre.hit.kind, 'scope', 'held by the pre-check, no fetch');
  const lost = claimWork(off, me('b', 'z', { scope: ['docs/**'] }));
  assert.equal(lost.queued, true); assert.match(lost.why, /claim: ledger unreachable/);
  const won = claimWork(fa, me('a', 'x', { scope: ['src/**'] }));   // a's own unchanged claim, fetched view: no network needed
  assert.equal(claimWork({ ...fa, remote: path.join(g.t, 'gone.git') }, me('a', 'x', { scope: ['src/**'] })).won, true);
  assert.equal(won.again, true);
});

test('fed run claims and work claims share the branch under their own folders; list reads both', () => {
  const g = rig();
  assert.equal(claimRun(g.ep('n1'), { home: 'a', project: 'demo', run: 'RUN-1', labels: ['linux'] }).won, true);
  assert.equal(claimWork(g.ep('a'), me('a', 'x')).won, true);
  assert.deepEqual(g.files().sort(), ['runs/a/demo/RUN-1.json', 'work/demo/a/x.json']);
  const l = listClaims(g.ep('b'));
  assert.deepEqual(Object.keys(l).sort(), ['runs/a/demo/RUN-1.json', 'work/demo/a/x.json']);
  assert.equal(workKey('demo', 'a', 'x'), 'work/demo/a/x.json');
});

test('cli: norn claim list | allow | release on the ledger remote; release takes the home id from the project home.json', async () => {
  const g = rig(), { main } = await import('../engine/bin/norn.mjs');
  const stateRoot = path.join(g.t, 'state'), mf = path.join(g.t, 'machine.json');
  fs.mkdirSync(path.join(stateRoot, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(stateRoot, 'demo', 'home.json'), JSON.stringify({ id: 'a', bare_home: 'a' }));
  fs.writeFileSync(mf, JSON.stringify({ schema: 1, home: g.t, claude: { exe: 'claude', config_dir: g.t, projects_dir: g.t }, node: process.execPath,
    scheduler: { kind: 'cron', name: 'x', interval_min: 5 }, dash: { port: 0, bind: '127.0.0.1' }, projects: [],
    ledger: { dir: path.join(g.t, 'cli.git'), remote: g.remote, state_root: stateRoot } }));
  claimWork(g.ep('a'), me('a', 'x'));
  claimWork(g.ep('b'), me('b', 'y', { scope: ['docs/**'] }));
  const run = argv => { const o = [], e = []; const code = main(argv, { ...process.env, META_ROOT: g.t }, s => o.push(s), s => e.push(s)); return { code, out: o.join('\n'), err: e.join('\n') }; };
  const l = run(['claim', 'list', '--project', 'demo', '--machine', mf]);
  assert.equal(l.code, 0, l.err);
  assert.match(l.out, /work\/demo\/a\/x\.json  n=1/);
  assert.equal(run(['claim', 'allow', 'a/x', 'b/y', '--project', 'demo', '--why', 'synthetic', '--machine', mf]).code, 0);
  assert.deepEqual(g.files().filter(k => k.startsWith('allow/')), ['allow/demo/a~x+b~y.json']);
  const r = run(['claim', 'release', 'x', '--project', 'demo', '--machine', mf]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(g.files().sort(), ['work/demo/b/y.json']);
  assert.equal(run(['claim', 'take', 'b/y', '--machine', mf]).code, 2, 'take is S2b');
});
