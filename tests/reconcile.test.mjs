// RM-46 S5 (multi-home SPEC sec. 8 S5, Q3 = project-wide): norn sync reconcile. Two synthetic homes (a = the bare home, b) on temp
// trees; b's shared logs are copied into a's homes/b/ as the fetch would. The likely duplicate pairs across homes (title words, a shared
// branch / doc link, overlapping lane claims; active directives and decisions too) become one keep / merge / drop card each, never twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { record, loadShared, readEvents } from '../engine/lib/records.mjs';
import { loadRoadmap } from '../engine/lib/roadmap.mjs';
import { pairsOf, reconcile, RECONCILE } from '../engine/lib/reconcile.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const META = path.resolve('engine/bin/norn.mjs');
const fwdp = p => p.split(path.sep).join('/');
const w = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const rec = (s, e) => record(s, { by: 'checkin', ...e }, { views: false });
const item = (s, parent, title, links = []) => rec(s, { kind: 'item', ev: 'create', data: { title, kind: 'item', parent, links } }).id;
const dir = (s, text) => record(s, { kind: 'directive', ev: 'create', by: 'owner', data: { text, via: 'cli', scope: [] } }, { views: false }).id;
const dec = (s, lane, question, choice) => rec(s, { kind: 'decision', ev: 'create', data: { lane, question, choice, why: 'synthetic', on_runs: [] } }).id;
// the fetch, in short: the other home's shared logs copied verbatim under <state>/homes/<h>/
const copy = (from, h, to) => { for (const f of ['records.jsonl', 'roadmap.jsonl']) if (fs.existsSync(path.join(from, f))) w(path.join(to, 'homes', h, f), fs.readFileSync(path.join(from, f))); };

// two synthetic roadmaps: one twin pair by words, one by a shared branch, one by overlapping lane claims; unrelated items; a same-home near twin
function homes() {
  const t = mkTmp('reconcile-'), meta = path.join(t, 'meta'), a = path.join(meta, 'state', 'demo'), b = path.join(t, 'b', 'state', 'demo');
  w(path.join(a, 'home.json'), JSON.stringify({ id: 'a', bare_home: 'a' }) + '\n');
  w(path.join(b, 'home.json'), JSON.stringify({ id: 'b', bare_home: 'a' }) + '\n');
  const ta = rec(a, { kind: 'item', ev: 'create', data: { title: 'Quality', kind: 'theme' } }).id, tb = rec(b, { kind: 'item', ev: 'create', data: { title: 'Quality', kind: 'theme' } }).id;
  const A = { slop: item(a, ta, 'PR slop check', ['doc:docs/slop.md']), phone2: item(a, ta, 'phone layout tweaks'), phone: item(a, ta, 'dashboard phone layout'),
    rcpt: item(a, ta, 'install receipts', ['branch:norn/receipts']), alpha: item(a, ta, 'alpha work', ['lane:p']) };
  const B = { slop: item(b, tb, 'PR slop check: run it in CI', ['run:RUN-b-7']), backup: item(b, tb, 'ledger backup restore'),
    rcpt: item(b, tb, 'receipt viewer', ['branch:norn/receipts']), beta: item(b, tb, 'beta thing', ['lane:q']) };
  A.dir = dir(a, 'keep every test hermetic with META_ROOT'); A.push = dir(a, 'push only when asked');
  B.dir = dir(b, 'tests stay hermetic: META_ROOT'); B.cost = dir(b, 'report the cost per lane');
  A.dec = dec(a, 'x', 'ledger remote per project', 'one repo'); A.fonts = dec(a, 'x', 'dashboard font', 'system ui');
  B.dec = dec(b, 'y', 'ledger remote per project', 'one repo');
  A.linked = item(a, ta, 'hermetic suite', ['dir:' + A.dir]);
  copy(b, 'b', a);
  const claims = { 'work/demo/a/p.json': { kind: 'work', project: 'demo', home: 'a', lane: 'p', items: [], scope: ['src/a/**'] },
    'work/demo/b/q.json': { kind: 'work', project: 'demo', home: 'b', lane: 'q', items: [], scope: ['src/a/x.js'] } };
  return { t, meta, a, b, A, B, claims };
}
const keyOf = (x, y, kind) => `${kind}:${[x, y].sort().join('+')}`;
const cards = s => Object.values(loadShared(s, 'question').items).filter(i => i.kind === 'question' && i.data.reconcile);

test('pairsOf: the twins pair up across homes (words, a shared branch, overlapping claims; directives and decisions too); unrelated and same-home items do not', () => {
  const h = homes(), ps = pairsOf(h.a, { claims: h.claims });
  const got = Object.fromEntries(ps.map(p => [p.key, p.why]));
  assert.deepEqual(Object.keys(got).sort(), [keyOf(h.A.slop, h.B.slop, 'item'), keyOf(h.A.rcpt, h.B.rcpt, 'item'), keyOf(h.A.alpha, h.B.beta, 'item'),
    keyOf(h.A.dir, h.B.dir, 'directive'), keyOf(h.A.dec, h.B.dec, 'decision')].sort());
  assert.match(got[keyOf(h.A.slop, h.B.slop, 'item')], /words 0\.67/);
  assert.match(got[keyOf(h.A.rcpt, h.B.rcpt, 'item')], /branch:norn\/receipts/);
  assert.match(got[keyOf(h.A.alpha, h.B.beta, 'item')], /claims overlap: a\/p b\/q/);
  assert.equal(RECONCILE.jaccard, 0.5);
  assert.deepEqual(pairsOf(h.a, { claims: {} }).map(p => p.key).includes(keyOf(h.A.alpha, h.B.beta, 'item')), false, 'no claims: no claim pair');
});

test('reconcile: a dry run writes nothing; the real run writes one card per pair; a re-run, here or on the other home, writes none', () => {
  const h = homes(), before = fs.readFileSync(path.join(h.a, 'records.jsonl'), 'utf8');
  const dry = reconcile(h.a, { by: 'checkin', claims: h.claims, dry: true });
  assert.equal(dry.pairs.length, 5); assert.deepEqual(dry.written, []);
  assert.equal(fs.readFileSync(path.join(h.a, 'records.jsonl'), 'utf8'), before, 'a dry run writes no card');
  const r = reconcile(h.a, { by: 'checkin', claims: h.claims, views: false });
  assert.equal(r.written.length, 5);
  const cs = cards(h.a), q = cs.find(c => c.data.reconcile.key === keyOf(h.A.slop, h.B.slop, 'item'));
  assert.equal(cs.length, 5);
  assert.deepEqual(q.data.options.map(o => o.key), ['keep', `merge:${h.B.slop}:${h.A.slop}`, `merge:${h.A.slop}:${h.B.slop}`, `drop:${h.A.slop}`, `drop:${h.B.slop}`]);
  assert.equal(q.data.options[1].text, `merge ${h.B.slop} into ${h.A.slop}`);
  const again = reconcile(h.a, { by: 'checkin', claims: h.claims, views: false });
  assert.deepEqual([again.pairs.length, again.written.length, again.carded], [0, 0, 5]);
  copy(h.a, 'a', h.b);
  assert.deepEqual(reconcile(h.b, { by: 'checkin', claims: h.claims, views: false }).written, [], 'home b sees a\'s cards in the merged view: never asked twice');
});

test('reconcile: the answer applies - merge moves the links and drops the merged item with a ref; a directive merge re-links; drop and keep', () => {
  const h = homes();
  reconcile(h.a, { by: 'checkin', claims: h.claims, views: false });
  const byKey = k => cards(h.a).find(c => c.data.reconcile.key === k).id;
  const answer = (k, choice) => record(h.a, { kind: 'question', ev: 'answer', id: byKey(k), by: 'owner', data: { text: 'ok', via: 'dashboard', choice } }, { views: false });
  answer(keyOf(h.A.slop, h.B.slop, 'item'), `merge:${h.A.slop}:${h.B.slop}`);
  answer(keyOf(h.A.dir, h.B.dir, 'directive'), `merge:${h.A.dir}:${h.B.dir}`);
  answer(keyOf(h.A.dec, h.B.dec, 'decision'), `drop:${h.A.dec}`);
  answer(keyOf(h.A.rcpt, h.B.rcpt, 'item'), 'keep');
  const r = reconcile(h.a, { by: 'checkin', claims: h.claims, views: false });
  assert.equal(r.applied.length, 4); assert.deepEqual(r.written, []);
  const R = loadRoadmap(h.a), st = loadShared(h.a, 'question').items;
  const ruling = id => Object.values(st).find(i => i.kind === 'decision' && i.data.reconcile_q === id);
  const qs = byKey(keyOf(h.A.slop, h.B.slop, 'item'));
  assert.equal(R.items[h.A.slop].state, 'dropped');
  assert.equal(R.items[h.A.slop].dropped.ref, ruling(qs).id);
  assert.match(R.items[h.A.slop].dropped.why, new RegExp(`merged into ${h.B.slop}`));
  // the kept item is home b's: its link event is written here and stays pending until b relays it (SPEC 3.8)
  const own = readEvents(path.join(h.a, 'roadmap.jsonl')).find(e => e.ev === 'link' && e.id === h.B.slop);
  assert.deepEqual(own.data.links, ['doc:docs/slop.md']);
  assert.equal(st[h.A.dir].state, 'superseded');
  assert.deepEqual(R.items[h.A.linked].links, ['dir:' + h.B.dir], 'the roadmap link follows the merged directive');
  assert.equal(st[h.A.dec].state, 'superseded');
  assert.equal(R.items[h.A.rcpt].state, 'open', 'keep both drops nothing');
  for (const k of [qs, byKey(keyOf(h.A.rcpt, h.B.rcpt, 'item'))]) assert.equal(st[k].state, 'applied');
  assert.deepEqual(reconcile(h.a, { by: 'checkin', claims: h.claims, views: false }), { pairs: [], carded: 5, written: [], applied: [] }, 'nothing twice');
});

test('cli: norn sync reconcile --dry-run prints the pair count and the pairs, writes no card', () => {
  const h = homes(), root = h.meta;
  w(path.join(root, 'local', 'machine.json'), JSON.stringify({ schema: 1, home: fwdp(h.t), node: fwdp(process.execPath), codex: null, git: { exe: 'git' },
    scheduler: { kind: 'cron', name: 'x', interval_min: 15 }, claude: { exe: fwdp(process.execPath), config_dir: fwdp(path.join(h.t, 'cfg')), projects_dir: fwdp(path.join(h.t, 'cfg', 'projects')) },
    dash: { port: 8737, bind: '127.0.0.1' }, projects: [], notify: { backend: 'ntfy', topic: 'fake-topic-Rc5x' },
    ledger: { dir: fwdp(path.join(h.t, 'ledger.git')), state_root: fwdp(path.join(root, 'state')), reviews: fwdp(path.join(h.t, 'reviews')), remote: fwdp(path.join(h.t, 'none.git')) } }));
  const r = spawnSync(process.execPath, [META, 'sync', 'reconcile', '--dry-run'], { env: { ...process.env, META_ROOT: root, META_ROLE: 'checkin' }, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^demo: 4 likely duplicate pairs \(dry run, no card written\)/m, 'no claims fetched: the claim pair is not seen');
  assert.match(r.stdout, new RegExp(`item ${h.A.slop} \\+ ${h.B.slop}: words 0\\.67`));
  assert.equal(cards(h.a).length, 0);
});
