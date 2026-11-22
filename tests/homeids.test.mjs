// RM-46 S1a: home ids and id formats. A synced project's state dir carries home.json { id, bare_home }: its new ids are
// <P><home>-<n>, its lanes L:<home>/<name> on branch norn/<home>/<name>; a solo dir (no home.json) allocates exactly as before.
// Synthetic homes a / b, project demo (node --test, temp dirs only).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { record, loadState, readEvents, recordsFile, idPrefix, homeOf, laneId, laneName, roleAddr, kindOfId, ITEM_LINK_RE, MAIL_TO_RE, mailboxOf } from '../engine/lib/records.mjs';
import { laneBranch } from '../engine/lib/lanenew.mjs';
import { otherLane } from '../engine/lib/slop/sweep.mjs';
import { mkTmp } from './helpers/tmp.mjs';

let tick = 0;
const now = () => new Date(Date.UTC(2026, 9, 31, 2, 0, tick++));
const rec = (dir, e, run = null) => record(dir, e, { now, views: false, run });
const home = (dir, id, bare_home) => fs.writeFileSync(path.join(dir, 'home.json'), JSON.stringify({ id, bare_home }) + '\n');
// a raw create event appended as the cut leaves it (ids written by hand: the records of the homes' pasts)
const seed = (dir, kind, ids) => {
  const f = recordsFile(dir, kind);
  fs.mkdirSync(dir, { recursive: true });
  const at = readEvents(f).length;
  fs.appendFileSync(f, ids.map((id, i) => JSON.stringify({ v: 1, seq: at + i + 1, ts: '2026-10-01T00:00:00Z', id, kind, ev: 'create', by: 'owner', run: null, data: kind === 'item' ? { title: id, kind: 'theme' } : { title: id } }) + '\n').join(''));
};
const item = { kind: 'item', ev: 'create', by: 'owner', data: { title: 'next', kind: 'theme' } };
const question = { kind: 'question', ev: 'create', by: 'controller', data: { title: 'Which basin?', lane: 'gen', body: 'b', options: [{ key: 'a', text: 'A', cost: '1h' }, { key: 'b', text: 'B', cost: '' }], recommend: { key: 'a', why: 'cited' }, class: 'ii', blocks: [], source: 'NOTES.md:1' } };

test('the bare home allocates RM-a-47 after its bare RM-46', () => {
  const d = mkTmp('meta-home-');
  seed(d, 'item', ['RM-45', 'RM-46']);
  home(d, 'a', 'a');
  assert.equal(idPrefix(d), 'a');
  assert.deepEqual(homeOf(d), { id: 'a', bare_home: 'a' });
  assert.equal(rec(d, item).id, 'RM-a-47');
  assert.equal(rec(d, item).id, 'RM-a-48');
  assert.equal(rec(d, question).id, 'Q-a-1');
});

test('a joiner continues from its own RM-b-29, whatever the bare home numbered', () => {
  const d = mkTmp('meta-home-');
  seed(d, 'item', ['RM-46', 'RM-b-28', 'RM-b-29', 'RM-c-90']);
  home(d, 'b', 'a');
  assert.equal(rec(d, item).id, 'RM-b-30');
});

test('Q-b2-3 parses: kind, number order and links (idNum keeps the trailing number)', () => {
  assert.equal(kindOfId('Q-b2-3'), 'question');
  assert.ok(ITEM_LINK_RE.test('q:Q-b2-3') && ITEM_LINK_RE.test('run:RUN-b-12') && ITEM_LINK_RE.test('lane:b/x') && ITEM_LINK_RE.test('lane:x'));
  const d = mkTmp('meta-home-');
  home(d, 'b2', 'a');
  seed(d, 'question', ['Q-b2-1', 'Q-b2-2', 'Q-b2-3']);
  assert.equal(rec(d, question).id, 'Q-b2-4');
});

test('lane create in a home gives L:a/x on norn/a/x; a foreign lane is typed b/x', () => {
  const d = mkTmp('meta-home-');
  home(d, 'a', 'a');
  assert.equal(rec(d, { kind: 'lane', ev: 'create', by: 'controller', data: { name: 'x' } }).id, 'L:a/x');
  assert.equal(laneId('x', d), 'L:a/x');
  assert.equal(laneId('b/x', d), 'L:b/x');
  assert.equal(laneName('L:a/x', d), 'x');
  assert.equal(laneName('L:b/x', d), 'b/x');
  assert.ok(loadState(d).items['L:a/x']);
  assert.equal(laneBranch('x', { name: 'demo', state: d }), 'norn/a/x');
  assert.equal(laneBranch('x', { name: 'demo', state: d, subdir: 'apps/demo' }), 'norn/a/demo/x');
  assert.equal(roleAddr('checkin', d), 'role:checkin@a');
  // sweep: another home's lane branch is theirs, our own and a plain branch are ours
  assert.equal(otherLane('norn/a/', 'norn/b/x'), true);
  assert.equal(otherLane('norn/a/', 'norn/a/x'), false);
  assert.equal(otherLane('norn/a/', 'feature'), false);
});

test('mail to RUN-b-12 (another home) and role:checkin@b is valid; a home run reads lane:a/x and role:checkin@a', () => {
  assert.ok(MAIL_TO_RE.test('RUN-b-12') && MAIL_TO_RE.test('role:checkin@b') && MAIL_TO_RE.test('lane:b/x') && MAIL_TO_RE.test('RUN-12'));
  assert.ok(!MAIL_TO_RE.test('role:checkin@') && !MAIL_TO_RE.test('lane:/x'));
  const d = mkTmp('meta-home-');
  home(d, 'a', 'a');
  const m = rec(d, { kind: 'mail', ev: 'create', by: 'controller', data: { from: 'role:controller@a', to: 'RUN-b-12', subject: 'S', body: 'hello' } });
  assert.equal(m.id, 'MAIL-a-1');
  assert.equal(rec(d, { kind: 'mail', ev: 'create', by: 'checkin', data: { from: 'role:checkin@a', to: 'role:checkin@b', subject: 'S', body: 'hi' } }).data.to, 'role:checkin@b');
  assert.throws(() => rec(d, { kind: 'mail', ev: 'create', by: 'controller', data: { from: 'role:controller@a', to: 'RUN-a-12', subject: 'S', body: 'x' } }), /RUN-a-12 does not exist/);
  const runs = { 'RUN-a-3': { id: 'RUN-a-3', data: { lane: 'x', kind: 'checkin' } } };
  assert.deepEqual([...mailboxOf(runs, 'RUN-a-3', 'a')], ['RUN-a-3', 'lane:a/x', 'role:checkin@a']);
});

test('a solo dir allocates exactly as before: bare ids, max over every id of the kind, L:x on norn/x', () => {
  const d = mkTmp('meta-home-');
  seed(d, 'item', ['RM-3', 'RM-node-7']);
  assert.equal(idPrefix(d), null);
  assert.equal(homeOf(d), null);
  assert.equal(rec(d, item).id, 'RM-8');
  assert.equal(rec(d, question).id, 'Q-1');
  assert.equal(rec(d, { kind: 'lane', ev: 'create', by: 'controller', data: { name: 'x' } }).id, 'L:x');
  assert.equal(laneId('x', d), 'L:x');
  assert.equal(laneName('L:x', d), 'x');
  assert.equal(laneBranch('x', { name: 'demo', state: d }), 'norn/x');
  assert.equal(laneBranch('x', { name: 'demo', state: d, subdir: 'apps/demo' }), 'norn/demo/x');
  assert.equal(roleAddr('checkin', d), 'role:checkin');
  assert.equal(otherLane(null, 'norn/b/x'), false);
  const runs = { 'RUN-3': { id: 'RUN-3', data: { lane: 'x', kind: 'checkin' } } };
  assert.deepEqual([...mailboxOf(runs, 'RUN-3')], ['RUN-3', 'lane:x', 'role:checkin']);
  // a fed node (node.json) keeps its prefix and today's rule
  const n = mkTmp('meta-home-');
  fs.writeFileSync(path.join(n, 'node.json'), JSON.stringify({ id: 'wsl' }));
  seed(n, 'item', ['RM-9']);
  assert.equal(idPrefix(n), 'wsl');
  assert.equal(rec(n, item).id, 'RM-wsl-10');
  assert.equal(rec(n, { kind: 'lane', ev: 'create', by: 'controller', data: { name: 'x' } }).id, 'L:x');
});

test('C17: a home.json that does not parse is an integrity error, never a solo dir (no id loses its home prefix)', () => {
  const d = mkTmp('meta-home-');
  seed(d, 'item', ['RM-b-29']);
  fs.writeFileSync(path.join(d, 'home.json'), '{"id": "b", "bare_home": "a"');
  assert.throws(() => homeOf(d), /home\.json.*not JSON/);
  assert.throws(() => idPrefix(d), /home\.json.*not JSON/);
  assert.throws(() => rec(d, item), /home\.json.*not JSON/);
  assert.equal(readEvents(recordsFile(d, 'item')).length, 1, 'nothing recorded');
});
