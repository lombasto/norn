// GAP-8 (handedits.mjs): a generated file edited by hand is refused by its writer - and no longer goes quiet. handEdits lists it
// (from the hash files, level-triggered), "Keep my version" records the choice (the notice leaves; a NEW edit brings it back) and
// "Let Norn take it back" keeps a .bak of the hand text and lets the next write regenerate it. Temp state dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { record, loadState } from '../engine/lib/records.mjs';
import { writeViews, VIEW_FILES } from '../engine/lib/views.mjs';
import { handEdits, takeBack, keepEdit } from '../engine/lib/handedits.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { fixture } from './helpers/dash-fixture.mjs';

test('handEdits / keepEdit / takeBack: listed, kept per text, taken back with a .bak', async () => {
  const state = path.join(mkTmp('meta-handedit-'), 'state', 'demo');
  fs.mkdirSync(state, { recursive: true });
  record(state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'first', via: 'chat' } });
  writeViews(state, loadState(state));
  const f = path.resolve(state, 'views', VIEW_FILES.directives);
  assert.deepEqual(await handEdits(state), [], 'a file Norn wrote is no hand edit');
  fs.appendFileSync(f, '\nmy own note\n');
  record(state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'second', via: 'chat' } });
  assert.deepEqual(writeViews(state, loadState(state)).refused, [f], 'the guard refuses it (the quiet part this gap fixes)');
  let e = await handEdits(state);
  assert.equal(e.length, 1); assert.equal(e[0].file, f); assert.equal(e[0].kept, false); assert.match(e[0].hashFile, /hashes\.json$/);
  await keepEdit(state, f);
  assert.equal((await handEdits(state))[0].kept, true, 'kept: the notice leaves');
  assert.deepEqual(writeViews(state, loadState(state)).refused, [f], 'a kept file is still never overwritten');
  fs.appendFileSync(f, 'and more\n');
  assert.equal((await handEdits(state))[0].kept, false, 'a NEW hand edit brings the notice back');
  await assert.rejects(takeBack(state, path.join(state, 'nope.md')), /not a hand-edited generated file/);
  const hand = fs.readFileSync(f, 'utf8'), r = await takeBack(state, f);
  assert.equal(r.bak, f + '.bak'); assert.equal(fs.readFileSync(r.bak, 'utf8'), hand);
  assert.deepEqual(writeViews(state, loadState(state)).written, [f], 'taken back: the next write regenerates it');
  assert.match(fs.readFileSync(f, 'utf8'), /second/); assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /my own note/);
  assert.deepEqual(await handEdits(state), []);
  fs.appendFileSync(f, 'again\n');
  assert.notEqual((await takeBack(state, f)).bak, f + '.bak', 'an existing .bak is never overwritten');
});

test('dashboard: the hand edit is a needs-you item; POST /api/handedit keeps it or takes it back (token-gated)', async () => {
  const f = await fixture();
  try {
    writeViews(f.pa.state, loadState(f.pa.state), f.pa.views || {});
    const file = path.resolve(f.pa.state, 'views', VIEW_FILES.directives);
    fs.appendFileSync(file, '\nhand line\n');
    const items = async () => (await f.get('/api/inbox?project=kestrel')).data.items.filter(i => i.type === 'handedit');
    let e = await items();
    assert.equal(e.length, 1);
    assert.match(e[0].title, /^DIRECTIVES\.md changed outside Norn: Norn has stopped updating it/);
    assert.equal(e[0].generated, true, 'the hand line went under the GENERATED header');
    const html = renderTab('inbox', { items: e }, { project: 'kestrel', now: Date.now() });
    assert.match(html, /Let Norn take it back/); assert.match(html, /Keep my version/); assert.match(html, /data-act="handedit"/);
    assert.match(html, /Norn never updates this file again/, 'the row says what Keep does'); assert.match(html, /most likely not edited by a person/);
    assert.ok((await f.get('/api/overview?project=kestrel')).data.needs.some(i => i.type === 'handedit'), 'it counts as needs-you');
    assert.equal((await f.post('/api/handedit', { project: 'kestrel', file: e[0].file, choice: 'keep' }, { 'x-dash-token': 'wrong' })).status, 403, 'the page token, as every POST');
    assert.equal((await f.post('/api/handedit', { project: 'kestrel', file: e[0].file, choice: 'keep' }, { origin: 'http://evil.example' })).status, 403, 'a cross-origin POST is refused');
    assert.equal((await f.post('/api/handedit', { project: 'kestrel', file: e[0].file, choice: 'nah' })).status, 400);
    assert.equal((await f.post('/api/handedit', { project: 'kestrel', file: path.join(f.root, 'kestrel-implementer.md'), choice: 'takeback' })).status, 409, 'only a listed generated file');
    assert.equal((await f.post('/api/handedit', { project: 'kestrel', file: e[0].file, choice: 'keep' })).status, 200);
    assert.deepEqual(await items(), [], 'kept: the item leaves');
    fs.appendFileSync(file, 'more\n');
    e = await items();
    assert.equal(e.length, 1, 'a new hand edit: back');
    const r = await f.post('/api/handedit', { project: 'kestrel', file: e[0].file, choice: 'takeback' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.regenerated, true, 'the dashboard rewrites the records views at once');
    assert.match(fs.readFileSync(file + '.bak', 'utf8'), /hand line\n.*more/s);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /hand line/);
    assert.deepEqual(await items(), []);
  } finally { await f.done(); }
});

test('one file named c:\\... by one writer and C:\\... by another is one key: neither refuses the other as a hand edit (the false notice and the frozen views)', { skip: process.platform !== 'win32' && 'drive letters are Windows only' }, async () => {
  const state = path.join(mkTmp('meta-handedit-case-'), 'state', 'demo');
  fs.mkdirSync(state, { recursive: true });
  const lower = s => s[0].toLowerCase() + s.slice(1), upper = s => s[0].toUpperCase() + s.slice(1);
  record(state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'first', via: 'chat' } });
  writeViews(lower(state), loadState(state));
  record(state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'second', via: 'chat' } });
  const r = writeViews(upper(state), loadState(state));
  assert.deepEqual(r.refused, [], "the other writer's text is Norn's own");
  assert.match(fs.readFileSync(path.join(state, 'views', VIEW_FILES.directives), 'utf8'), /second/, 'and the view is current');
  record(state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'third', via: 'chat' } });
  assert.deepEqual(writeViews(lower(state), loadState(state)).refused, [], 'and back again');
  assert.deepEqual(await handEdits(lower(state)), [], 'no notice');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(state, 'views', 'hashes.json'), 'utf8'))).length, 3, 'one key per view');
});
