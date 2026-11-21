// META-ROADMAP S3 (DIR-11; SPEC sec. 3 + sec. 6 row S3): roadmap edits from the dashboard (POST, token, role dashboard, 409 on a
// stale item / order), `norn run --item` and `norn rec add lane --item` link work to items, the digest's Unplaced row, the
// check-in prompt's roadmap duty. Synthetic records only (never a project's own text); temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { record, readEvents, recordsFile, loadState } from '../engine/lib/records.mjs';
import { loadRoadmap, childrenOf, roadmapViewPath } from '../engine/lib/roadmap.mjs';
import { digest } from '../engine/lib/digest.mjs';
import { renderDigest } from '../engine/lib/views.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const META = path.join(HERE, '..', 'engine', 'bin', 'norn.mjs');
const meta = (args, env = {}) => {
  const r = spawnSync(process.execPath, [META, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, META_ROLE: '', META_PROJECT: '', META_STATE: '', META_NO_TICK: '1', ...env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
const item = (S, ev, data, id, by = 'controller') => record(S, { kind: 'item', ev, id, by, data }, { views: false });
const rev = (S, id) => loadRoadmap(S).items[id].history.at(-1).seq;

// ---------- the dashboard POST routes ----------
test('roadmap POST: token + role dashboard; add / edit / move / link / unlink / drop / reopen; the reply carries the new tree; the view follows', async () => {
  const f = await fixture();
  try {
    const S = f.pa.state, P = (op, b, h) => f.post('/api/roadmap/' + op, { project: 'kestrel', ...b }, h);
    const t1 = item(S, 'create', { title: 'Core', kind: 'theme' }).id, t2 = item(S, 'create', { title: 'Ops', kind: 'theme' }).id;
    const a = item(S, 'create', { title: 'Item a', kind: 'item', parent: t1 }).id, b = item(S, 'create', { title: 'Item b', kind: 'item', parent: t1 }).id;
    const seeded = readEvents(recordsFile(S, 'item')).length;
    assert.equal((await P('add', { title: 'x', parent: t1 }, { 'x-dash-token': 'wrong' })).status, 403, 'the page token, as every dashboard write');
    assert.equal((await P('add', { title: 'x', parent: t1 }, { origin: 'https://evil.example' })).status, 403);
    let r = await P('add', { title: 'From the phone', parent: t1, horizon: 'next', note: 'n', links: ['lane:gen'] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const n = r.data.id;
    assert.equal(n, 'RM-5');
    assert.deepEqual(r.data.tree.themes[0].children.map(x => x.id), [a, b, n], 'the reply carries the rebuilt tree');
    assert.equal(r.data.tree.themes[0].children[2].rev, rev(S, n), 'each node carries its rev (the last event seq) for the stale check');
    assert.equal((await P('add', { title: 'bad link', parent: t1, links: ['lane:nope'] })).status, 400, 'a link to nothing is refused');
    assert.equal((await P('add', { title: 'typed', parent: t1, status: 'shipped' })).status, 400, 'status is never typed');
    assert.equal((await P('add', { title: 'T3', kind: 'theme' })).data.id, 'RM-6', 'a theme sits at the root');

    r = await P('edit', { id: n, rev: rev(S, n), title: 'Renamed', note: 'a note', horizon: 'now' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    let it = loadRoadmap(S).items[n];
    assert.deepEqual([it.title, it.note, it.horizon], ['Renamed', 'a note', 'now']);
    r = await P('edit', { id: n, rev: rev(S, n) - 1, title: 'stale' });
    assert.equal(r.status, 409); assert.match(r.data.error, /changed elsewhere/);
    assert.equal((await P('edit', { id: n, title: 'no rev' })).status, 400, 'rev is required on an existing item');
    assert.equal((await P('edit', { id: 'RM-99', rev: 1, title: 'x' })).status, 404);

    // move: up one (after a), with the order the page saw under the target parent
    r = await P('move', { id: n, rev: rev(S, n), after: a, order: [a, b, n] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(childrenOf(loadRoadmap(S), t1), [a, n, b]);
    r = await P('move', { id: b, rev: rev(S, b), after: null, order: [a, b, n] });
    assert.equal(r.status, 409, 'a stale order is refused'); assert.match(r.data.error, /order changed/);
    assert.deepEqual(childrenOf(loadRoadmap(S), t1), [a, n, b], 'nothing written');
    assert.equal((await P('move', { id: b, rev: rev(S, b), after: null })).status, 400, 'a move names the order it saw');
    r = await P('move', { id: b, rev: rev(S, b), parent: t2, order: [] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual([childrenOf(loadRoadmap(S), t1), childrenOf(loadRoadmap(S), t2)], [[a, n], [b]], 'moved to another theme (last)');

    assert.equal((await P('link', { id: n, rev: rev(S, n), links: ['dir:DIR-1'] })).status, 200);
    assert.equal((await P('link', { id: n, rev: rev(S, n), links: ['run:RUN-99'] })).status, 400);
    assert.equal((await P('unlink', { id: n, rev: rev(S, n), links: ['lane:gen'] })).status, 200);
    assert.deepEqual(loadRoadmap(S).items[n].links, ['dir:DIR-1']);
    assert.equal((await P('drop', { id: n, rev: rev(S, n), why: 'not now' })).status, 400, 'a drop cites its ruling');
    assert.equal((await P('drop', { id: n, rev: rev(S, n), why: 'not now', ref: 'DIR-1' })).status, 200);
    assert.equal(loadRoadmap(S).items[n].state, 'dropped');
    assert.equal((await P('reopen', { id: n, rev: rev(S, n), why: 'back' })).status, 200);
    assert.equal((await P('fly', { id: n, rev: rev(S, n) })).status, 404);

    const evs = readEvents(recordsFile(S, 'item')).slice(seeded);
    assert.ok(evs.length >= 9 && evs.every(e => e.by === 'dashboard'), 'every edit is one record append by dashboard');
    assert.match(fs.readFileSync(roadmapViewPath(S, f.pa), 'utf8'), /Renamed/, 'the generated ROADMAP view follows the edit');
  } finally { await f.done(); }
});

// ---------- launcher links: norn run --item, norn rec add lane --item ----------
const sandbox = () => {
  const t = mkTmp('meta-rm3-'), state = path.join(t, 'state', 'demo'), locks = path.join(t, 'state', 'locks'), wt = path.join(t, 'wt');
  for (const d of [state, locks, wt]) fs.mkdirSync(d, { recursive: true });
  const brief = path.join(t, 'brief.md'); fs.writeFileSync(brief, 'mode: done\n');
  const th = item(state, 'create', { title: 'Core', kind: 'theme' }).id, it = item(state, 'create', { title: 'Work', kind: 'item', parent: th }).id;
  const dir = record(state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'go', via: 'chat' } }, { views: false }).id;
  return { t, state, locks, wt, brief, th, it, dir };
};

test('norn run --item RM-n links the new run to the item (by launcher); an unknown or dropped item refuses before any run', () => {
  const d = sandbox();
  const run = (...more) => meta(['run', '--executor', 'fake', '--lane', 'w', '--brief', d.brief, '--worktree', d.wt, '--locks', d.locks, '--after', `dir:${d.dir}`, '--state', d.state, ...more]);
  let o = run('--item', d.it);
  assert.equal(o.code, 0, o.err);
  const id = /QUEUED (RUN-\d+)/.exec(o.out)[1];
  const R = loadRoadmap(d.state);
  assert.deepEqual(R.items[d.it].links, ['run:' + id]);
  assert.equal(R.items[d.it].history.at(-1).by, 'launcher');
  const runs = () => Object.values(loadState(d.state).items).filter(i => i.kind === 'run').length;
  const before = runs();
  o = run('--item', 'RM-9');
  assert.equal(o.code, 2); assert.match(o.err, /RM-9/);
  item(d.state, 'drop', { why: 'w', ref: d.dir }, d.it, 'owner');
  o = run('--item', d.it);
  assert.equal(o.code, 2); assert.match(o.err, /dropped/);
  assert.equal(runs(), before, 'a refused --item records no run');
});

test('norn rec add lane --item RM-n links lane:<name> to the item; an unknown item refuses before the lane is created', () => {
  const d = sandbox();
  let o = meta(['rec', 'add', 'lane', '--name', 'surf', '--item', d.it, '--state', d.state, '--as', 'controller']);
  assert.equal(o.code, 0, o.err);
  assert.equal(o.out, 'L:surf');
  assert.deepEqual(loadRoadmap(d.state).items[d.it].links, ['lane:surf']);
  o = meta(['rec', 'add', 'lane', '--name', 'other', '--item', 'RM-9', '--state', d.state, '--as', 'controller']);
  assert.equal(o.code, 2); assert.match(o.err, /RM-9/);
  assert.equal(loadState(d.state).items['L:other'], undefined, 'no lane without its item link');
  o = meta(['rec', 'add', 'question', '--lane', 'x', '--title', 't', '--item', d.it, '--state', d.state, '--as', 'controller']);
  assert.equal(o.code, 2, '--item is a lane flag only');
});

// ---------- the digest row + the check-in duty ----------
test('digest: a project with a roadmap carries "Unplaced on the roadmap" (the audit D3) until it is 0; no roadmap = no row', () => {
  const s = mkTmp('meta-rm3-dg-');
  const dir = record(s, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'a new wish', via: 'chat' } }, { views: false }).id;
  const git = () => '', dg = () => digest(s, {}, { git, dlv: [] });
  let d = dg();
  assert.equal(d.sections.roadmap, undefined, 'no roadmap yet: no row (the migration places the backlog)');
  assert.doesNotMatch(renderDigest(d), /Unplaced/);
  const th = item(s, 'create', { title: 'Core', kind: 'theme' }).id;
  d = dg();
  assert.deepEqual(d.sections.roadmap.map(r => [r.kind, r.id]), [['dir', dir]]);
  assert.match(renderDigest(d), /## 7 Unplaced on the roadmap \(1\)\n- DIR-1 dir: a new wish/);
  item(s, 'create', { title: 'The wish', kind: 'item', parent: th, links: ['dir:' + dir] });
  d = dg();
  assert.deepEqual(d.sections.roadmap, []);
  assert.match(renderDigest(d), /## 7 Unplaced on the roadmap \(0\)\n- \(none\)/);
});

// ---------- the edit drawer (ui.mjs, pure) + the page wiring ----------
const { renderTab } = await import('../engine/dash/ui.mjs');
const { renderRmEditor, rmEditBody, rmFind } = await import('../engine/dash/pages/roadmap.mjs');
const uiNode = (id, title, o = {}) => ({ id, kind: 'item', title, state: o.state || 'open', rev: o.rev ?? 1, parent: o.parent ?? null, phase: o.phase || 'future', status: o.status || 'idea',
  why: 'no evidence', note: o.note || '', horizon: o.horizon ?? null, links: o.links || [], live: [], queued: [], stages: [], branches: [], spans: [], progress: { done: 0, total: 0 },
  flags: { claimed: null, drift: [], idle: null, gone: [] }, dropped: o.dropped || null, children: [] });
const uiTree = () => {
  const t1 = { ...uiNode('RM-1', 'Core', { rev: 1 }), kind: 'theme', counts: { past: 0, present: 0, future: 3 } };
  t1.children = [uiNode('RM-3', 'First', { parent: 'RM-1', rev: 3, links: ['dir:DIR-2', 'lane:gen'] }), uiNode('RM-4', 'Second', { parent: 'RM-1', rev: 4, horizon: 'next' }),
    uiNode('RM-5', 'Third', { parent: 'RM-1', rev: 9, note: 'n' })];
  const t2 = { ...uiNode('RM-2', 'Ops', { rev: 2 }), kind: 'theme', counts: { past: 0, present: 0, future: 0 }, children: [] };
  return { project: 'p', title: 'P', generated: '2030-01-10T12:00:00Z', themes: [t1, t2], unplaced: [], counts: { items: 3, past: 0, present: 0, future: 3, live: 0, drift: 0, claimed: 0, idle: 0, gone: 0, unplaced: 0 } };
};

test('roadmap edit drawer: every row (tree and board) and theme has an edit button, the top an Add button; the drawer edits structure only', () => {
  const d = uiTree();
  for (const view of ['tree', 'board']) {
    const h = renderTab('roadmap', d, { project: 'p', look: 'norn', rm: { view }, now: Date.parse('2030-01-10T12:00:00Z') });
    for (const id of ['RM-3', 'RM-4', 'RM-5']) assert.match(h, new RegExp(`data-rm-edit="${id}"`), `${view}: ${id} edit button`);
    assert.match(h, /data-rm-edit="new"/, `${view}: Add`);
  }
  assert.match(renderTab('roadmap', d, { project: 'p', look: 'norn', rm: {}, now: 0 }), /data-rm-edit="RM-1"/, 'a theme is editable (rename / drop)');
  assert.match(renderTab('roadmap', { themes: [], counts: {} }, { project: 'p', rm: {} }), /data-rm-edit="new"/, 'an empty roadmap can start from the page');
  const e = renderRmEditor(d, 'RM-4', {});
  for (const k of ['title', 'horizon', 'note', 'theme', 'link', 'why', 'ref']) assert.match(e, new RegExp(`data-rme="${k}"`), k);
  for (const a of ['edit', 'up', 'down', 'theme', 'link', 'drop']) assert.match(e, new RegExp(`data-rme-act="${a}"`), a);
  assert.doesNotMatch(e, /data-rme="status"/, 'no status field: it is derived');
  assert.match(e, /value="Second"/); assert.match(e, /<option value="next" selected>/);
  const r = renderRmEditor(d, 'RM-3', {});
  assert.match(r, /data-rme-act="unlink" data-link="dir:DIR-2"/); assert.match(r, /data-rme="ref" value="DIR-2"/, 'the drop ruling is prefilled from a linked DIR / DEC');
  const dropped = uiTree(); dropped.themes[0].children[1] = uiNode('RM-4', 'Second', { state: 'dropped', dropped: { why: 'later', ref: 'DIR-2' } });
  assert.match(renderRmEditor(dropped, 'RM-4', {}), /data-rme-act="reopen"/);
  assert.doesNotMatch(renderRmEditor(dropped, 'RM-4', {}), /data-rme-act="drop"/);
  const add = renderRmEditor(d, 'new', {});
  assert.match(add, /data-rme-act="add"/); assert.match(add, /<option value="RM-1"/); assert.match(add, /<option value="theme">/, 'a new theme from the page');
  assert.match(renderRmEditor(d, 'RM-77', {}), /Reload/);
});

test('the page wires the edit drawer: its own aside, opened by data-rm-edit, POSTs /api/roadmap/<op> with the token, repaints from the reply tree', () => {
  const html = fs.readFileSync(path.join(HERE, '..', 'engine', 'dash', 'index.html'), 'utf8');
  assert.match(html, /<aside id="rmed" class="drawer" hidden/);
  assert.match(html, /import \{[^}]*renderRmEditor[^}]*rmEditBody[^}]*\} from '\/pages\/roadmap\.mjs'/);
  assert.match(html, /closest\?\.\('\[data-rm-edit\]'\)/);
  assert.match(html, /post\('\/api\/roadmap\/' \+ b\.op/);
  assert.match(html, /S\.rmData = r\.tree/);
});
