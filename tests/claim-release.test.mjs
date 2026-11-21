// issue #123: the tick (tick.mjs claimsPass) releases an own work claim whose lane stays open after its work landed (merged on main, or a
// `norn runs landed` ruling), or whose lane has had no run for longer than the claim lease - only with no live and no queued run on the lane.
// The release drops the allow files that name the claim; the digest's claims rows name the reason. Two synthetic homes a and b of project
// demo share one temp bare remote; clocks are injected, no test sleeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { claimsPass } from '../engine/lib/tick.mjs';
import { claimWork, allowPair, allowKey, readSync, writeSync } from '../engine/lib/claims.mjs';
import { record } from '../engine/lib/records.mjs';
import { tryDigest } from '../engine/lib/digest.mjs';
import { fedOf } from '../engine/lib/fed.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const S = 1000, H = 3600e3, T0 = Date.UTC(2026, 10, 21), POL = { lease_s: 3600, renew_s: 600, fence_s: 3000, stale_grace_s: 300 };
const at = ms => () => new Date(ms);
function rig() {
  const t = mkTmp('meta-claimrelease-'), remote = path.join(t, 'remote.git');
  spawnSync('git', ['init', '-q', '--bare', remote], { windowsHide: true });
  const show = key => { const r = spawnSync('git', ['show', `refs/heads/claims:${key}`], { env: { ...process.env, GIT_DIR: remote }, encoding: 'utf8', windowsHide: true }); return r.status ? null : JSON.parse(r.stdout); };
  const home = id => {
    const state = path.join(t, id, 'state', 'demo');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'home.json'), JSON.stringify({ id, bare_home: 'a' }));
    const ledger = { dir: path.join(t, id, 'ledger.git'), remote, branch: `machine/host-${id}` };
    return { state, ledger, f: fedOf(ledger) };
  };
  return { show, a: home('a'), b: home('b') };
}
const rec = (state, ev, ms) => record(state, ev, { views: false, now: at(ms) });
const me = (lane, o = {}) => ({ project: 'demo', home: 'a', lane, branch: `norn/a/${lane}`, items: [], scope: ['**'], touched: [], ...o });
// home a: lane x open, one claim (scope **) confirmed now, one run started at T0 and (unless live) ended an hour later
function held(g, lane = 'x', { live = false } = {}) {
  rec(g.a.state, { kind: 'lane', ev: 'create', by: 'controller', data: { name: lane } }, T0);
  const c = claimWork(g.a.f, me(lane), { now: T0 });
  writeSync(g.a.state, 'own', { [c.key]: { project: 'demo', home: 'a', lane, nonce: c.claim.nonce, n: c.n, confirmed_ms: T0 } });
  const run = rec(g.a.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane } }, T0).id;
  if (!live) rec(g.a.state, { kind: 'run', ev: 'end', id: run, by: 'launcher', data: { exit: 0, outcome: 'done' } }, T0 + 60 * S);
  return { key: c.key, run };
}
const merged = (g, lane, run) => fs.writeFileSync(path.join(g.a.state, 'lane-paths.json'), JSON.stringify({ paths: { [lane]: { state: 'merged', branch: `norn/a/${lane}`, run } } }));
const pass = (g, now) => claimsPass(g.a.state, { ledger: g.a.ledger, policy: { sync: POL }, now });
const row = (g, key) => tryDigest(g.a.state, {}).sections.claims?.find(r => r.id === key && r.kind === 'released');

test('issue #123: an open lane whose work merged on main, no run live or queued: the pass releases its claim and the allow file naming it', () => {
  const g = rig(), { key, run } = held(g);
  const allow = allowKey('demo', 'a/x', 'b/y');
  assert.equal(allowPair(g.b.f, { project: 'demo', a: 'a/x', b: 'b/y', why: 'by hand' }).ok, true);
  assert.deepEqual(pass(g, T0 + 120 * S).released, [], 'not landed, not idle past the lease: kept');
  merged(g, 'x', run);
  assert.deepEqual(pass(g, T0 + 180 * S).released, [key]);
  assert.equal(g.show(key), null, 'the claim file is gone');
  assert.equal(g.show(allow), null, 'its allow file went with it');
  assert.deepEqual(readSync(g.a.state, 'own'), {});
  assert.match(row(g, key).why, /^a\/x: released - landed \(norn\/a\/x on main\)/);
});

test('a `norn runs landed` ruling releases the claim the same way', () => {
  const g = rig(), { key, run } = held(g);
  rec(g.a.state, { kind: 'run', ev: 'landed', id: run, by: 'checkin', data: { why: 'DEC-9: landed as PR #6' } }, T0 + 90 * S);
  assert.deepEqual(pass(g, T0 + 120 * S).released, [key]);
  assert.match(row(g, key).why, /released - landed \(ruled landed: DEC-9/);
});

test('a lane with no run for longer than the lease: released as idle past lease; at the lease it is kept', () => {
  const g = rig(), { key } = held(g), ended = T0 + 60 * S;
  assert.deepEqual(pass(g, ended + POL.lease_s * S).released, [], 'at the lease: kept (renewed)');
  assert.deepEqual(pass(g, ended + POL.lease_s * S + S).released, [key]);
  assert.equal(g.show(key), null);
  assert.match(row(g, key).why, /^a\/x: released - idle past lease \(no run for 60 min\)/);
});

test('a live or a queued run on the lane keeps its claim, landed or idle', () => {
  const g = rig(), { key, run } = held(g, 'x', { live: true });
  merged(g, 'x', run);
  assert.deepEqual(pass(g, T0 + 3 * H).released, [], 'a live run');
  rec(g.a.state, { kind: 'run', ev: 'end', id: run, by: 'launcher', data: { exit: 0, outcome: 'done' } }, T0 + 3 * H);
  rec(g.a.state, { kind: 'run', ev: 'queue', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'x' } }, T0 + 3 * H);
  assert.deepEqual(pass(g, T0 + 6 * H).released, [], 'a queued run');
  assert.ok(g.show(key), 'the claim stays on the ledger');
  assert.equal(row(g, key), undefined);
});
