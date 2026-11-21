// lane-collide S1c (SPEC 4A.1, stale): the tick's stale corrections behind the proof of death, on temp records (made-up lanes and items:
// lane bake ran RUN-n on item "Bake the tiles"). A caveat that names an ended run as running gains the fact, once; `norn collide undo`
// writes the old text back and the tick leaves it so. A run with a live successor is left alone. This home's claim of a dead lane is
// released (claims.mjs releaseWork); a lane with a dirty worktree and another home's claim are left alone; a `**` claim is listed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkTmp } from './helpers/tmp.mjs';
import { record } from '../engine/lib/records.mjs';
import { loadRoadmap } from '../engine/lib/roadmap.mjs';
import { collidePass } from '../engine/lib/tick.mjs';
import { casesOf, actionsOf, readCollide } from '../engine/lib/intents.mjs';
import { claimWork, allowPair, writeSync, readSync } from '../engine/lib/claims.mjs';
import { fedOf } from '../engine/lib/fed.mjs';

const NORN = path.join(import.meta.dirname, '..', 'engine', 'bin', 'norn.mjs');
const OLD = '2026-01-05T10:00:00Z';
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: OLD, GIT_COMMITTER_DATE: OLD, GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, ...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
const norn = (state, ...args) => spawnSync(process.execPath, [NORN, ...args, '--state', state], { encoding: 'utf8', windowsHide: true,
  env: { ...process.env, META_ROOT: path.dirname(state), META_NO_TICK: '1', META_RUN_ID: '', META_ROLE: '' } });

function rig() {
  const t = mkTmp('meta-cstale-'), state = path.join(t, 'state', 'k');
  fs.mkdirSync(state, { recursive: true });
  const th = record(state, { kind: 'item', ev: 'create', by: 'controller', data: { title: 'World', kind: 'theme' } }, { views: false });
  const item = (title, caveat) => { const it = record(state, { kind: 'item', ev: 'create', by: 'controller', data: { title, kind: 'item', parent: th.id } }, { views: false });
    if (caveat) record(state, { kind: 'item', ev: 'edit', id: it.id, by: 'controller', data: { caveat } }, { views: false }); return it.id; };
  const run = (lane, stage, outcome, o = {}) => { const id = record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane, stage, ...o } }).id;
    if (outcome) record(state, { kind: 'run', ev: 'end', id, by: 'launcher', data: { outcome, exit: outcome === 'done' ? 0 : 1 } }); return id; };
  const p = { name: 'k', state, policy: {} };
  return { t, state, item, run, p, caveat: id => loadRoadmap(state).items[id].caveat?.text ?? null };
}

test('caveat: an item caveat that names an ended run as running gains the fact once; undo writes the old text back and the tick leaves it', () => {
  const r = rig(), R = r.run('bake', 'S2', 'stopped');
  const it = r.item('Bake the tiles', `${R} running the tile bake - do not start another`);
  const before = r.caveat(it);
  collidePass(r.state, r.p);
  const after = r.caveat(it);
  assert.ok(after.startsWith(before + ' [norn '), `the words stay, the fact is added: ${after}`);
  assert.match(after, new RegExp(`\\[norn \\d\\d-\\d\\d \\d\\d:\\d\\dZ: ${R} ended \\d\\d-\\d\\d \\d\\d:\\d\\dZ, stopped\\]$`));
  const [c] = Object.values(casesOf(r.state));
  assert.equal(c.data.kind, 'stale');
  assert.deepEqual(actionsOf(c).map(a => [a.action, a.auto, a.args.before]), [['caveat', true, before]]);
  assert.ok(readCollide(r.state).handled.some(h => h.col === c.id && h.kind === 'stale'), 'collide.json: handled by Norn');
  collidePass(r.state, r.p);
  assert.equal(r.caveat(it), after, 'a second pass adds nothing');
  assert.equal(actionsOf(casesOf(r.state)[c.id]).length, 1);
  const u = norn(r.state, 'collide', 'undo', c.id, '--as', 'checkin', '--why', 'the run is mine to judge');
  assert.equal(u.status, 0, u.stderr);
  assert.equal(r.caveat(it), before, 'the old text is back');
  collidePass(r.state, r.p);
  assert.equal(r.caveat(it), before, 'an undone correction is not made again');
});

test('caveat undo: refused when the caveat was edited after Norn noted it (the edit stays)', () => {
  const r = rig(), R = r.run('bake', 'S2', 'stopped');
  const it = r.item('Bake the tiles', `${R} running`);
  collidePass(r.state, r.p);
  record(r.state, { kind: 'item', ev: 'edit', id: it, by: 'controller', data: { caveat: 'rewritten by hand' } }, { views: false });
  const [c] = Object.values(casesOf(r.state));
  const u = norn(r.state, 'collide', 'undo', c.id, '--as', 'checkin', '--why', 'w');
  assert.equal(u.status, 3, u.stdout);
  assert.match(u.stderr, /changed since/);
  assert.equal(r.caveat(it), 'rewritten by hand');
});

test('caveat: a run that handed its stage on to a live successor is left alone', () => {
  const r = rig(), R = r.run('bake', 'S2', 'stopped');
  r.run('bake', 'S2', null);   // the next round of the same lane and stage: running
  const it = r.item('Bake the tiles', `${R} running the tile bake`);
  collidePass(r.state, r.p);
  assert.equal(r.caveat(it), `${R} running the tile bake`);
  assert.deepEqual(casesOf(r.state), {});
});

// two synthetic homes a and b of project demo on one temp bare remote (the claims-dispatch rig, smaller)
function homes() {
  const t = mkTmp('meta-cstale-h-'), remote = path.join(t, 'remote.git');
  git(t, 'init', '-q', '--bare', remote);
  const home = id => {
    const state = path.join(t, id, 'state', 'demo');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'home.json'), JSON.stringify({ id, bare_home: 'a' }));
    const ledger = { dir: path.join(t, id, 'ledger.git'), remote, branch: `machine/host-${id}` };
    return { id, state, ledger, f: fedOf(ledger), p: { name: 'demo', state, policy: {} } };
  };
  const a = home('a'), b = home('b');
  /** lane L of home h: an old worktree with one commit (its tip unchanged for months), a run that ended, and h's claim of the lane */
  const lane = (h, L, { scope = [`src/${L}/**`] } = {}) => {
    const wt = path.join(t, h.id, 'wt', L);
    fs.mkdirSync(wt, { recursive: true });
    git(wt, 'init', '-q', '-b', `norn/${h.id}/${L}`); fs.writeFileSync(path.join(wt, 'a.txt'), 'a\n'); git(wt, 'add', '-A'); git(wt, 'commit', '-qm', 'work');
    const run = record(h.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: L, stage: 'S1', worktree: wt } }).id;
    record(h.state, { kind: 'run', ev: 'end', id: run, by: 'launcher', data: { outcome: 'done', exit: 0 } });
    const c = claimWork(h.f, { project: 'demo', home: h.id, lane: L, branch: `norn/${h.id}/${L}`, items: [], scope, touched: [] });
    assert.equal(c.won, true);
    writeSync(h.state, 'own', { ...readSync(h.state, 'own'), [c.key]: { project: 'demo', home: h.id, lane: L, nonce: c.claim.nonce, n: c.n, confirmed_ms: Date.now() } });
    return { wt, key: c.key };
  };
  return { a, b, lane };
}

test('claims: this home\'s claim of a dead lane is released; a dirty worktree and another home\'s claim are left alone; a ** claim is listed', () => {
  const g = homes(), now = Date.now() + 5 * 864e5;   // past recent_days (3) after the runs ended
  const dead = g.lane(g.a, 'old'), dirty = g.lane(g.a, 'wip');
  // b's whole-repo claim would be held by a's two claims: the owner allowed the pairs, so it is on the ledger beside them
  for (const l of ['a/old', 'a/wip']) assert.ok(allowPair(g.b.f, { project: 'demo', a: 'b/far', b: l, why: 'fixture' }).ok);
  const theirs = g.lane(g.b, 'far', { scope: [] });
  fs.writeFileSync(path.join(dirty.wt, 'a.txt'), 'not committed\n');
  const r = collidePass(g.a.state, g.a.p, { now, ledger: g.a.ledger });
  assert.deepEqual(r.released, [dead.key]);
  assert.deepEqual(Object.keys(readSync(g.a.state, 'own')), [dirty.key], 'the dirty lane keeps its claim');
  const c = Object.values(casesOf(g.a.state)).find(x => x.data.kind === 'stale');
  assert.deepEqual(actionsOf(c).map(a => [a.action, a.args.claim.lane]), [['claim-release', 'old']]);
  const wide = readCollide(g.a.state).wide;
  assert.deepEqual(wide.map(w => w.key), [theirs.key], 'b\'s claim with no Scope (the whole repo) is listed');
  assert.deepEqual(collidePass(g.a.state, g.a.p, { now, ledger: g.a.ledger }).released, [], 'nothing is released twice');
  assert.equal(readSync(g.b.state, 'own')[theirs.key]?.lane, 'far', 'b\'s own record is untouched');
});
