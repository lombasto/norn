// RM-46 S2b (multi-home SPEC 4.4, 4.5, 5): the work claim at every dispatch path (runs.mjs claimDoor in startRun, the fill) and the
// tick's lease step (tick.mjs claimsPass: renew, fence, stale, take over, release). Two synthetic homes a and b of project demo share one
// temp bare remote; each has its own state dir (home.json) and ledger repo. FAKE executor only; clocks are injected, no test sleeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startRun, queueRun, fillQueue, readiness, claimDoor, RunRefused, hbPath } from '../engine/lib/runs.mjs';
import { claimsPass } from '../engine/lib/tick.mjs';
import { claimWork, releaseWork, renewWork, takeWork, listClaims, readSync, writeSync } from '../engine/lib/claims.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { tryDigest } from '../engine/lib/digest.mjs';
import { fedOf } from '../engine/lib/claimsref.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const S = 1000, POL = { lease_s: 3600, renew_s: 600, fence_s: 3000, stale_grace_s: 300 };
function rig() {
  const t = mkTmp('meta-claimdispatch-'), remote = path.join(t, 'remote.git');
  spawnSync('git', ['init', '-q', '--bare', remote], { windowsHide: true });
  const at = key => { const r = spawnSync('git', ['show', `refs/heads/claims:${key}`], { env: { ...process.env, GIT_DIR: remote }, encoding: 'utf8', windowsHide: true }); return r.status ? null : JSON.parse(r.stdout); };
  const home = id => {
    const root = path.join(t, id), state = path.join(root, 'state', 'demo'), locks = path.join(root, 'state', 'locks');
    fs.mkdirSync(state, { recursive: true }); fs.mkdirSync(locks, { recursive: true });
    fs.writeFileSync(path.join(state, 'home.json'), JSON.stringify({ id, bare_home: 'a' }));
    const ledger = { dir: path.join(root, 'ledger.git'), remote, branch: `machine/host-${id}` }, offline = { ...ledger, remote: path.join(t, 'gone.git') };
    const opts = (lane, { scope = `src/${lane}/**`, ...o } = {}) => {
      const wt = path.join(root, 'wt', lane), brief = path.join(root, `brief-${lane}.md`);
      fs.mkdirSync(wt, { recursive: true });
      fs.writeFileSync(brief, `mode: done\n${scope === null ? '' : `Scope: ${scope}\n`}Tests: none\nDone: synthetic\n`);
      return { state, locksDir: locks, executor: 'fake', lane, worktree: wt, brief, notes: path.join(root, `NOTES-${lane}.md`), hbMs: 150, staleMs: 3000,
        policy: { auto_resume_max: 0 }, budget: {}, tick: null, git_ledger: ledger, ...o };
    };
    const runs = () => Object.values(loadState(state).items).filter(i => i.kind === 'run');
    // a running run of a lane with no process behind it (the fence / take-over tests stop it through the kill seam)
    const fakeRunning = lane => { const e = record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane } });
      fs.mkdirSync(path.dirname(hbPath(state, e.id)), { recursive: true }); fs.writeFileSync(hbPath(state, e.id), JSON.stringify({ run: e.id, pid: 424242, supervisor_pid: 434343 })); return e.id; };
    return { id, state, ledger, offline, f: fedOf(ledger), opts, runs, fakeRunning, item: id2 => loadState(state).items[id2] };
  };
  return { t, remote, at, a: home('a'), b: home('b') };
}
const me = (home, lane, o = {}) => ({ project: 'demo', home, lane, branch: `norn/${home}/${lane}`, items: [], scope: [`src/${lane}/**`], touched: [], ...o });
const started = h => h.runs().filter(r => r.history.some(x => x.ev === 'start'));

test('item overlap: norn run on lane y of home b is refused (exit 3, the holder named) when a claims the same item; nothing starts on b', () => {
  const g = rig();
  const th = record(g.b.state, { kind: 'item', ev: 'create', by: 'controller', data: { title: 'Core', kind: 'theme' } }, { views: false });
  const it = record(g.b.state, { kind: 'item', ev: 'create', by: 'controller', data: { title: 'shared work', kind: 'item', parent: th.id, links: ['lane:y'] } }, { views: false });
  assert.equal(claimWork(g.a.f, me('a', 'x', { items: [it.id], scope: ['docs/**'] })).won, true);
  assert.throws(() => startRun(g.b.opts('y')), e => e instanceof RunRefused && e.code === 3 && /claim: item overlaps a\/x/.test(e.message));
  assert.equal(started(g.b).length, 0, 'no run started on b');
  assert.equal(g.at('work/demo/b/y.json'), null, 'no claim written for b');
});

test('scope overlap queues the run with "held by a" in the digest; the fill keeps it queued and starts it after a releases', () => {
  const g = rig();
  const ra = startRun(g.a.opts('x', { scope: 'src/**' }));
  assert.ok(ra.run, 'a starts');
  const ca = g.at('work/demo/a/x.json');
  assert.equal(ca.home, 'a'); assert.deepEqual(ca.scope, ['src/**']);
  assert.deepEqual(g.a.item(ra.run).data.claim, { key: 'work/demo/a/x.json', n: ca.n }, 'the start record names its claim');
  const rb = startRun(g.b.opts('y'));
  assert.equal(rb.queued, true);
  assert.match(rb.why, /claim: scope overlaps a\/x: src\/\*\*/);
  const row = tryDigest(g.b.state, {}).sections.claims.find(r => r.id === rb.run);
  assert.match(row.why, /^held by a: /);
  assert.deepEqual(fillQueue(g.b.state), [], 'still held while a claims');
  assert.equal(g.b.item(rb.run).state, 'queued');
  assert.equal(releaseWork(g.a.f, { project: 'demo', home: 'a', lane: 'x' }).ok, true);
  claimsPass(g.b.state, { ledger: g.b.ledger });   // the tick's one fetch: b now sees the release
  const filled = fillQueue(g.b.state);
  assert.equal(filled.length, 1);
  assert.equal(filled[0].queued, rb.run);
  assert.equal(g.at('work/demo/b/y.json').home, 'b');
  assert.equal(tryDigest(g.b.state, {}).sections.claims, undefined, 'the held row leaves with the start');
});

test('no double start: two homes dispatch overlapping work (b on a stale view of the claims) - exactly one starts', () => {
  const g = rig();
  listClaims(g.b.f);   // b's last fetch: before a claims
  const ra = startRun(g.a.opts('x', { scope: null }));   // no Scope: line = the whole repo
  const rb = startRun(g.b.opts('y'));
  assert.ok(ra.run && !ra.queued);
  assert.equal(rb.queued, true, 'b re-checks on the fetched tip and waits');
  assert.match(rb.why, /brief has no Scope: line/);
  assert.equal(started(g.a).length + started(g.b).length, 1);
  assert.deepEqual(fillQueue(g.b.state), []);
  assert.equal(started(g.b).length, 0);
});

test('fence: an unconfirmed claim stops its live run at fence_s (own clock); a renew after a wake keeps it', () => {
  const g = rig(), T0 = Date.UTC(2026, 10, 20);
  const c = claimWork(g.a.f, me('a', 'x'), { now: T0 });
  writeSync(g.a.state, 'own', { [c.key]: { project: 'demo', home: 'a', lane: 'x', nonce: c.claim.nonce, n: c.n, confirmed_ms: T0 } });
  const run = g.a.fakeRunning('x'), killed = [];
  const off = { ledger: g.a.offline, policy: { sync: POL }, kill: p => killed.push(p) };
  assert.deepEqual(claimsPass(g.a.state, { ...off, now: T0 + 3000 * S }).fenced, [], 'at fence_s: not yet');
  assert.equal(g.a.item(run).state, 'running');
  const r = claimsPass(g.a.state, { ...off, now: T0 + 3001 * S });
  assert.deepEqual(r.fenced, [run]);
  assert.equal(g.a.item(run).state, 'lost');
  assert.match(g.a.item(run).history.find(h => h.ev === 'lost').data.why, /^fenced: claim not confirmed for 3001 s/);
  assert.deepEqual(killed, [434343, 424242], 'the supervisor and the executor');
  assert.match(readSync(g.a.state, 'rows').events.at(-1).why, /fenced/);
  // a machine waking from sleep WITH network: the same pass renews first, so it is not fenced
  const run2 = g.a.fakeRunning('x');
  const w = claimsPass(g.a.state, { ledger: g.a.ledger, policy: { sync: POL }, now: T0 + 4000 * S, kill: p => killed.push(p) });
  assert.equal(w.renewed, 1); assert.deepEqual(w.fenced, []);
  assert.equal(g.a.item(run2).state, 'running');
  assert.equal(g.at(c.key).run, run2, 'the renew names the live run');
  assert.equal(readSync(g.a.state, 'own')[c.key].confirmed_ms, T0 + 4000 * S);
});

test('stale shows only after lease_s + grace observed; take works only when stale; the holder then stops its run', () => {
  const g = rig(), T0 = Date.UTC(2026, 10, 20), killed = [];
  const c = claimWork(g.a.f, me('a', 'x'), { now: T0 });
  writeSync(g.a.state, 'own', { [c.key]: { project: 'demo', home: 'a', lane: 'x', nonce: c.claim.nonce, n: c.n, confirmed_ms: T0 } });
  const pass = (now, h = g.b) => claimsPass(h.state, { ledger: h.ledger, policy: { sync: POL }, now, kill: p => killed.push(p) });
  const take = now => takeWork(g.b.f, { project: 'demo', home: 'a', lane: 'x', seen: readSync(g.b.state, 'seen'), now, pol: POL });
  const T1 = T0 + 7 * 24 * 3600 * S;   // b first looks a week later (offline meanwhile): its timer starts at zero
  assert.deepEqual(pass(T1).stale, []);
  assert.deepEqual(pass(T1 + 3899 * S).stale, [], 'one second short of lease_s + grace');
  assert.equal(take(T1 + 3899 * S).notStale, true);
  renewWork(g.a.f, { [c.key]: { nonce: c.claim.nonce } }, { now: T1 + 3899 * S });   // a renews: a new n restarts b's timer
  assert.deepEqual(pass(T1 + 3900 * S).stale, []);
  assert.deepEqual(pass(T1 + 7799 * S).stale, []);
  assert.deepEqual(pass(T1 + 7800 * S).stale, [c.key]);
  assert.match(tryDigest(g.b.state, {}).sections.claims.find(r => r.kind === 'stale').why, /a\/x stale: n=2 .*norn claim take a\/x --project demo/);
  const tk = take(T1 + 7800 * S);
  assert.equal(tk.ok, true);
  assert.equal(g.at(c.key), null, 'the claim is gone');
  // the holder: its next renew finds the file gone - its lane's run stops, the claim leaves its own list, a digest row says so
  const run = g.a.fakeRunning('x');
  const h = pass(T1 + 7900 * S, g.a);
  assert.deepEqual(h.taken, [c.key]);
  assert.equal(g.a.item(run).state, 'lost');
  assert.match(g.a.item(run).history.find(x => x.ev === 'lost').data.why, /^claim taken over on /);
  assert.equal(readSync(g.a.state, 'own')[c.key], undefined);
  assert.equal(tryDigest(g.a.state, {}).sections.claims.find(r => r.kind === 'taken').id, c.key);
});

test('release: the tick CAS-deletes the own claim of a lane that is done', () => {
  const g = rig(), T0 = Date.UTC(2026, 10, 20);
  record(g.a.state, { kind: 'lane', ev: 'create', by: 'controller', data: { name: 'x' } }, { views: false });
  const c = claimWork(g.a.f, me('a', 'x'), { now: T0 });
  writeSync(g.a.state, 'own', { [c.key]: { project: 'demo', home: 'a', lane: 'x', nonce: c.claim.nonce, n: c.n, confirmed_ms: T0 } });
  assert.deepEqual(claimsPass(g.a.state, { ledger: g.a.ledger, now: T0 + 60 * S }).released, []);
  record(g.a.state, { kind: 'lane', ev: 'done', id: 'L:a/x', by: 'checkin', data: {} });
  assert.deepEqual(claimsPass(g.a.state, { ledger: g.a.ledger, now: T0 + 120 * S }).released, [c.key]);
  assert.equal(g.at(c.key), null);
  assert.deepEqual(readSync(g.a.state, 'own'), {});
});

test('exempt: a check-in starts with no claim and no ledger contact; helpers and audits never claim; a MERGE stage only passes the leader door', () => {
  const g = rig();
  const ck = startRun(g.b.opts('checkin', { kind: 'checkin', lock: false, git_ledger: g.b.offline, scope: null }));
  assert.ok(ck.run && !ck.queued);
  for (const o of [{ role: 'helper', lock: false }, { kind: 'audit' }]) assert.equal(claimDoor(g.b.opts('y', o)), null, JSON.stringify(o));
  // S6a: a MERGE stage claims no work; it starts only on the merge leader (a local check: b holds no leader claim)
  assert.throws(() => claimDoor(g.b.opts('y', { stage: 'MERGE' })), e => e instanceof RunRefused && e.code === 3 && /MERGE: no merge leader confirmed yet/.test(e.message));
  assert.equal(claimDoor({ ...g.b.opts('y'), state: path.join(g.t, 'solo') }), null, 'a solo state dir (no home.json) never claims');
  assert.equal(spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/heads/claims'], { env: { ...process.env, GIT_DIR: g.remote }, windowsHide: true }).status, 1, 'the claims branch was never written');
});

// queue-stall (11-21: three queued runs read READY in norn ready / META-QUEUE.md while every fill started none): the walk is the one
// readiness evaluator, so the claim door's no-network pre-check is one of its terms - the dry walk and the fill agree on a held row.
test('a claim-held queued run is not READY in the dry walk: it names the holder, and the fill starts nothing', () => {
  const g = rig();
  assert.equal(claimWork(g.a.f, me('a', 'x', { scope: ['src/**'] })).won, true);
  const rb = startRun(g.b.opts('y'));
  assert.equal(rb.queued, true);
  const [row] = readiness(g.b.state);
  assert.equal(row.id, rb.run);
  assert.equal(row.ready, false, 'the dry walk sees the hold the start sees');
  assert.ok(row.terms.some(t => /^claim: scope overlaps a\/x: src\/\*\* \(held by a\)$/.test(t)), row.terms.join(' | '));
  assert.deepEqual(fillQueue(g.b.state), []);
  assert.equal(g.b.item(rb.run).state, 'queued');
});

test('a row the fill walk called ready but whose start was refused leaves one fill.log line per why', () => {
  const g = rig();
  listClaims(g.b.f);   // b's last fetch: before a claims - its walk sees no hold, the start's CAS round does
  const qb = queueRun(g.b.opts('y'));
  assert.equal(claimWork(g.a.f, me('a', 'x', { scope: ['src/**'] })).won, true);
  assert.deepEqual(fillQueue(g.b.state), []);
  assert.equal(g.b.item(qb.run).state, 'queued');
  const lines = () => fs.readFileSync(path.join(g.b.state, 'fill.log'), 'utf8').trim().split('\n');
  assert.equal(lines().length, 1);
  assert.match(lines()[0], new RegExp(`${qb.run} not started: refused: claim: scope overlaps a/x`));
  fillQueue(g.b.state);
  assert.equal(lines().length, 1, 'the same why is logged once');
});
