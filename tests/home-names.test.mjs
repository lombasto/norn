// NORN-DASH-1123 item 6 (SPEC 6, H1-H4): computer (home) names travel on the claims ref. Two synthetic homes (a, b) on temp trees and one
// temp bare remote (never a real one): home a names home b, b's fetch shows it (homeNames + <ledger dir>/home-names.json); a bad name
// is refused; homeChip shows the name with the id in its title; Settings > Sync's Computers rows render both homes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ledgerConfig } from '../engine/lib/ledger.mjs';
import { fedOf } from '../engine/lib/claimsref.mjs';
import { registerHome, setHomeName, homeNames, localClaims, homeKey } from '../engine/lib/claims.mjs';
import { fetchHomes, renameHome } from '../engine/lib/sync.mjs';
import { homeChip, homeName, setHomeNames } from '../engine/dash/cells.mjs';
import { settings } from '../engine/dash/pages/settings.mjs';
import { SECTIONS } from '../engine/lib/policy.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const fwdp = p => p.split(path.sep).join('/');
const w = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const T0 = Date.parse('2026-11-23T10:00:00Z');
function remoteRepo() {
  const remote = path.join(mkTmp('names-remote-'), 'remote.git');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', remote], { windowsHide: true }).status, 0);
  return fwdp(remote);
}
// one home: <t>/meta/state/demo (synced: home.json) + its own ledger repo; registered on the claims ref
function home(id, remote) {
  const t = mkTmp(`names-home-${id}-`), meta = path.join(t, 'meta');
  const ledger = { dir: fwdp(path.join(t, 'ledger.git')), state_root: fwdp(path.join(meta, 'state')), reviews: fwdp(path.join(t, 'reviews')), remote };
  w(path.join(meta, 'state', 'demo', 'home.json'), JSON.stringify({ id, bare_home: 'a', cut_at: '2026-11-23T09:00:00Z' }) + '\n');
  const cfg = ledgerConfig({ ledger }, { metaRoot: meta, machineFile: path.join(meta, 'local', 'machine.json') });
  assert.equal(registerHome(fedOf(cfg), { id, projects: ['demo'], now: T0 }).ok, true);
  return { cfg, f: fedOf(cfg), cache: path.join(cfg.dir, 'home-names.json') };
}

test('home names: home a names home b on the claims ref; b\'s fetch then shows it (homeNames + home-names.json); the id stays the key', () => {
  const remote = remoteRepo(), a = home('a', remote), b = home('b', remote);
  const r = renameHome(a.cfg, { home: 'b', name: '  Laptop ', by: 'a', now: T0 + 1000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.names, { b: 'Laptop' });
  assert.deepEqual(JSON.parse(fs.readFileSync(a.cache, 'utf8')), { b: 'Laptop' }, 'the rename writes the namer\'s cache');
  assert.equal(fs.existsSync(b.cache), false);
  const fr = fetchHomes(b.cfg, { now: T0 + 2000 });
  assert.ok(!fr.error, JSON.stringify(fr));
  assert.deepEqual(homeNames(b.f), { b: 'Laptop' });
  assert.deepEqual(JSON.parse(fs.readFileSync(b.cache, 'utf8')), { b: 'Laptop' }, 'the fetch writes the cache');
  const c = localClaims(b.f)[homeKey('b')];
  assert.deepEqual([c.id, c.kind, c.branch, c.name, c.named_by, c.named_at], ['b', 'home', 'home/b', 'Laptop', 'a', '2026-11-23T10:00:01.000Z']);
  // b names a; a's earlier name of b survives (one file per home)
  assert.equal(setHomeName(b.f, { id: 'a', name: 'Desk', by: 'b', now: T0 + 3000 }).ok, true);
  assert.deepEqual(homeNames(b.f), { a: 'Desk', b: 'Laptop' });
  // a lost race: b pushes a name between a's commit and a's push; a's push is rejected, the next round retries on the new tip, both stay
  let raced = null;
  const lost = setHomeName(a.f, { id: 'b', name: 'Laptop 2', by: 'a', now: T0 + 4000 }, { beforePush: () => { raced ??= setHomeName(b.f, { id: 'a', name: 'Desk 2', by: 'b', now: T0 + 3500 }); } });
  assert.equal(raced.ok, true); assert.equal(lost.ok, true, JSON.stringify(lost));
  assert.deepEqual(homeNames(a.f), { a: 'Desk 2', b: 'Laptop 2' });
  assert.equal(setHomeName(a.f, { id: 'zz', name: 'Nobody', by: 'a' }).unknown, true, 'an unregistered home is not named');
});

test('home names: a bad name is refused (length, characters) and nothing is pushed', () => {
  const remote = remoteRepo(), a = home('a', remote);
  for (const bad of ['', '   ', 'x'.repeat(25), 'Desk<b>', 'a/b', 'Büro', 'tab\tname']) {
    assert.throws(() => setHomeName(a.f, { id: 'a', name: bad, by: 'a' }), /home name/, JSON.stringify(bad));
    const r = renameHome(a.cfg, { home: 'a', name: bad, by: 'a' });
    assert.ok(r.refused?.length && !r.ok, JSON.stringify(r));
  }
  assert.equal(setHomeName(a.f, { id: 'a', name: 'x'.repeat(24), by: 'a' }).ok, true, '24 chars is fine');
  assert.equal(setHomeName(a.f, { id: 'a', name: 'My desk_2-b', by: 'a' }).ok, true, 'letters, digits, space, - and _');
});

test('homeChip: "on <name>" with the title "home <id> (<name>)"; the bare id when the home has no name; names are escaped', () => {
  setHomeNames({ b: 'Laptop', c: 'A&B' });
  try {
    assert.equal(homeName('b'), 'Laptop'); assert.equal(homeName('a'), 'a');
    assert.match(homeChip({ home: 'b' }), /class="chip onhome" title="home b \(Laptop\)">on Laptop</);
    assert.match(homeChip({ home: 'a' }), /class="chip onhome" title="home a">on a</);
    assert.match(homeChip({ home: 'c' }), />on A&amp;B</);
    assert.equal(homeChip({}), '');
  } finally { setHomeNames({}); }
  assert.match(homeChip({ home: 'b' }), />on b</, 'a cleared map shows the id again');
});

test('Settings > Sync: the Computers block has one row per home with a name input; this computer is marked; Save names', () => {
  setHomeNames({ a: 'Desk' });
  try {
    const sync = { home: 'a', remote: 'set', head: 'abc1234567', pushed: true, fetched_at: '2026-11-23T10:00:00Z', homes: [{ home: 'b', head: 'def', lag_s: 300, ahead_s: 0 }] };
    const html = settings({ sections: SECTIONS.filter(c => c.id === 'sync'), settings: [], sync, project: 'demo', version: 'v1' }, { setCat: 'sync', now: T0 });
    const block = html.slice(html.indexOf('id="sync-homes"'));
    assert.ok(html.includes('id="sync-homes"'), 'the Computers block');
    assert.match(block, /data-home-row="a"[\s\S]*?this computer[\s\S]*?<input[^>]*data-home-name="a"[^>]*value="Desk"/);
    assert.match(block, /data-home-row="b"[\s\S]*?<input[^>]*data-home-name="b"[^>]*value=""/);
    assert.match(block, /maxlength="24"/);
    assert.match(block, /data-act="home-names-save"/);
    assert.match(block, /id="sync-names-out"/);
    const solo = settings({ sections: SECTIONS.filter(c => c.id === 'sync'), settings: [], sync: { home: null }, project: 'demo', version: 'v1' }, { setCat: 'sync' });
    assert.ok(!solo.includes('id="sync-homes"'), 'solo: no Computers block');
  } finally { setHomeNames({}); }
});
