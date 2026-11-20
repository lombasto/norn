// GAP-8 (handedits.mjs): a generated file edited by hand is refused by its writer - and no longer goes quiet. handEdits lists it
// (from the hash files, level-triggered), "Keep my version" records the choice (the notice leaves; a NEW edit brings it back) and
// "Let Norn take it back" keeps a .bak of the hand text and lets the next write regenerate it. Temp state dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { record, loadState } from '../engine/lib/records.mjs';
import { writeViews, VIEW_FILES } from '../engine/lib/views.mjs';
import { handEdits, takeBack, keepEdit, handEditDiff } from '../engine/lib/handedits.mjs';
import crypto from 'node:crypto';
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

// RM-35: the notice says what changed and who probably did it, from the write record views.mjs keeps per file (views/last/), and
// offers the diff (last written by Norn vs now). One case each: a person's edit, an older Norn snapshot, a foreign writer, a lost hash.
const setup = () => {
  const state = path.join(mkTmp('meta-handedit-who-'), 'state', 'demo');
  fs.mkdirSync(state, { recursive: true });
  record(state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'first', via: 'chat' } });
  writeViews(state, loadState(state));   // record() writes the views itself: these two calls find them unchanged
  const f = path.resolve(state, 'views', VIEW_FILES.directives), v1 = fs.readFileSync(f, 'utf8');
  record(state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'second', via: 'chat' } });
  writeViews(state, loadState(state));
  return { state, f, v1, v2: fs.readFileSync(f, 'utf8') };
};
const notice = e => renderTab('inbox', { items: [{ type: 'handedit', id: 'edit-x', project: 'demo', file: e.file.split(path.sep).join('/'), created: e.edited, generated: e.generated, verdict: e.verdict, recommend: e.recommend, why: e.why, lines: e.lines, diff: e.diff, title: 'x changed outside Norn' }] }, { project: 'demo', now: Date.now() });

test('a person\'s edit (the header removed): said as a person or a tool, no recommendation, the diff is last written vs now', async () => {
  const { state, f, v2 } = setup();
  fs.writeFileSync(f, v2.replace(/^<!--.*-->\n/, '') + 'my note\n');
  const [e] = await handEdits(state);
  assert.equal(e.verdict, 'person'); assert.equal(e.recommend, null); assert.equal(e.diff, true);
  assert.match(e.lines[0], /^Norn last wrote it at \d\d:\d\dZ \([^,]+, pid \d+/, 'Norn\'s last write: when, which role, which process');
  assert.ok(e.lines.some(l => /GENERATED header is gone, so a person or another tool edited it/.test(l)));
  const d = await handEditDiff(state, f);
  assert.equal(d.before, v2, 'before = the text Norn last wrote'); assert.match(d.after, /my note/);
  const html = notice(e);
  assert.match(html, /data-act="diff-open" data-dv-url="\/api\/handedit\/diff\?project=demo&amp;file=[^"]+"[^>]*>View diff/);
  assert.doesNotMatch(html, /Recommended/); assert.match(html, /Let Norn take it back/); assert.match(html, /Keep my version/);
});

test('an older Norn snapshot written back: "an older Norn copy wrote this (stale), not a person" and take it back is recommended with the reason', async () => {
  const { state, f, v1 } = setup();
  fs.writeFileSync(f, v1);   // a stale writer: Norn's own earlier text
  const [e] = await handEdits(state);
  assert.equal(e.verdict, 'stale'); assert.equal(e.recommend, 'takeback');
  assert.ok(e.lines.some(l => /Norn wrote exactly this at \d\d:\d\dZ \([^,]+, pid \d+.*An older Norn copy wrote this \(stale\), not a person\./.test(l)), e.lines.join(' | '));
  assert.match(notice(e), /<b>Recommended: Let Norn take it back<\/b> - it is an older copy of Norn&#39;s own text\./);
});

test('a foreign writer: Norn\'s header on a text Norn never wrote, and a lane worktree\'s engine among the writers - said, without a guess', async () => {
  const { state, f, v2 } = setup();
  const lf = fs.readdirSync(path.join(state, 'views', 'last')).find(x => x.startsWith(VIEW_FILES.directives) && x.endsWith('.json')), lp = path.join(state, 'views', 'last', lf);
  const log = JSON.parse(fs.readFileSync(lp, 'utf8'));
  for (const w of log.writes) Object.assign(w, { engine: path.join('C:', 'norn'), branch: 'main' });   // the install's engine ...
  Object.assign(log.writes[0], { engine: path.join('C:', 'norn', 'state', 'norn', 'wt', 'old-lane'), branch: 'norn/old-lane' });   // ... and once a lane worktree's
  fs.writeFileSync(lp, JSON.stringify(log));
  fs.writeFileSync(f, v2.replace('second', 'second, as another program wrote it'));
  const [e] = await handEdits(state);
  assert.equal(e.verdict, 'header'); assert.equal(e.recommend, null);
  assert.ok(e.lines.some(l => /A Norn engine from a lane worktree also writes this file \([^,]+, pid \d+, engine on norn\/old-lane in .*old-lane/.test(l)), e.lines.join(' | '));
  assert.ok(e.lines.some(l => /GENERATED header, but Norn has no record of writing this text: most likely not edited by a person/.test(l)));
  assert.match(notice(e), /most likely not edited by a person/);
});

test('a lost hash (the file is Norn\'s last text, its hash record missed it): said so, take it back recommended; no record = said too', async () => {
  const { state, f, v1 } = setup();
  const hf = path.join(state, 'views', 'hashes.json'), h = JSON.parse(fs.readFileSync(hf, 'utf8'));
  h[Object.keys(h).find(k => k.endsWith(VIEW_FILES.directives))] = crypto.createHash('sha256').update(v1).digest('hex');
  fs.writeFileSync(hf, JSON.stringify(h));
  const [e] = await handEdits(state);
  assert.equal(e.verdict, 'lost-hash'); assert.equal(e.recommend, 'takeback');
  assert.ok(e.lines.some(l => /exactly what Norn last wrote; only Norn's hash record missed that write/.test(l)));
  fs.rmSync(path.join(state, 'views', 'last'), { recursive: true });
  fs.appendFileSync(f, 'x\n');
  const [n] = await handEdits(state);
  assert.equal(n.diff, false, 'no kept text: no diff offered');
  assert.match(n.lines[0], /no record of its last write here/);
  assert.doesNotMatch(notice(n), /View diff/);
});
