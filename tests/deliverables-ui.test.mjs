// META-DELIVERABLES 6 (DELIVERABLES-SPEC 3): the "Done, not installed" card on Inbox, the deliverable drawer, the Map
// band state. Temp-dir dashboards + fixture git repos only (never the live dash / state).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { renderTab, loadTab, deliverablesCard, renderDeliverable } from '../engine/dash/ui.mjs';
import { mapGraph } from '../engine/lib/map.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { fixture as dash } from './helpers/dash-fixture.mjs';

const GENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
const g = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: GENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (repo, file, text, msg) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); g(repo, 'add', file); g(repo, 'commit', '-q', '-m', msg); return g(repo, 'rev-parse', 'HEAD'); };
const NOW = Date.parse('2026-11-08T12:00:00Z');
const row = o => ({ id: 'DLV-1', project: 'kestrel', record_state: 'open', state: 'done', target: 'install', at_target: false, repo: 'C:/r', branch: 'feat/shader-cache',
  lane: 'shadercache', run: null, delivers: 'no compile freeze after a Prism change', tip: '6246900bc1234567', done_utc: '2026-10-28T17:00:00Z', days: 10.8, behind: 1002, ahead: 14,
  native: true, native_files: ['engine/prism/prism-core/src/horizon.rs'], park: null, asked: null, due: true, ...o });

test('card: "Done, not installed" rows by age - branch, what it delivers, days, behind main, native, an open button; parked shows reason + age', () => {
  const rows = [row({ id: 'DLV-3', branch: 'feat/cloud-f1', state: 'merged', days: 1.2, behind: null, native: false, due: false }),
    row(), row({ id: 'DLV-2', branch: 'feat/fine', days: 4, record_state: 'parked', park: { why: 'owner: port onto the C4 sink', days: 2.4, expired: false }, due: false }),
    row({ id: 'DLV-9', state: 'installed', at_target: true })];
  const html = deliverablesCard({ rows }, { now: NOW, project: 'kestrel' });
  assert.match(html, /id="deliverables"/); assert.match(html, /Done, not installed <b>3<\/b>/);
  assert.ok(html.indexOf('DLV-1') < html.indexOf('DLV-2') && html.indexOf('DLV-2') < html.indexOf('DLV-3'), 'oldest first');
  assert.doesNotMatch(html, /DLV-9/, 'installed = at target, not on the card');
  for (const s of ['feat/shader-cache', 'no compile freeze', '10.8 d', '1002 behind', 'native', 'owner: port onto the C4 sink', 'parked 2 d', 'merged', 'question due'])
    assert.ok(html.includes(s), s);
  assert.match(html, /<button[^>]*data-dlv="DLV-1"[^>]*data-project="kestrel"/);
  assert.match(deliverablesCard({ rows: [] }, { now: NOW }), /Nothing done-not-installed/);
  assert.match(deliverablesCard({ rows: [], error: 'git failed' }, { now: NOW }), /git failed/);
});

test('drawer: the deliverable opened - state, tip, behind / ahead, native files, park, question, and the commands that move it', () => {
  const html = renderDeliverable(row({ asked: 'Q-12', record_state: 'parked', park: { why: 'owner: after the door', days: 8, expired: true }, due: false }), { now: NOW });
  for (const s of ['DLV-1', 'feat/shader-cache', '6246900bc', '1002 behind', '14 ahead', 'engine/prism/prism-core/src/horizon.rs', 'owner: after the door', 'expired', 'Q-12',
    'norn deliverables park DLV-1 --why', 'DONE', 'MERGED', 'INSTALLED']) assert.ok(html.includes(s), s);
});

test('map: a lane band carries its deliverable state; the SVG draws it with an open target', () => {
  const st = { items: { 'L:gen': { id: 'L:gen', kind: 'lane', state: 'active', data: { name: 'gen' }, history: [] } } };
  const m = mapGraph(st, { deliverables: [row({ lane: 'gen' }), row({ id: 'DLV-4', lane: 'other' })] });
  const band = m.bands.find(b => b.lane === 'gen');
  assert.equal(band.deliverables.length, 1); assert.equal(band.deliverables[0].id, 'DLV-1'); assert.equal(band.deliverables[0].state, 'done');
  assert.deepEqual(mapGraph(st, {}).bands.find(b => b.lane === 'gen').deliverables, []);
  const html = renderTab('map', { project: 'kestrel', ...m }, { project: 'kestrel', now: NOW });
  assert.match(html, /class="dlv done[^"]*"[^>]*data-dlv="DLV-1"/);
  assert.match(html, /DLV-1 done 10\.8 d · 1002 behind · native/);
});

test('server: /api/deliverables (git-derived, cached child CLI) feeds the Inbox card and the Map bands', async () => {
  const f = await dash();
  try {
    const repo = f.pa.root;
    g(repo, 'init', '-q', '-b', 'main'); g(repo, 'config', 'commit.gpgsign', 'false');
    commit(repo, 'README.md', 'r', 'init');
    g(repo, 'checkout', '-q', '-b', 'feat/a'); const a = commit(repo, 'src/a.rs', 'a', 'feat(a): a'); g(repo, 'checkout', '-q', 'main');
    g(repo, 'update-ref', 'refs/remotes/origin/feat/a', a);
    record(f.pa.state, { kind: 'deliverable', ev: 'create', by: 'controller', data: { repo, branch: 'feat/a', lane: 'gen', delivers: 'the a layer', done_utc: new Date(Date.now() - 3 * 864e5).toISOString() } }, { views: false });
    // the first call never waits for git: it answers pending and starts the child; the cached rows follow
    const first = await f.get('/api/deliverables?project=kestrel');
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.pending, true); assert.deepEqual(first.data.rows, []);
    assert.match(deliverablesCard(first.data, {}), /reading git/);
    let r = first;
    for (let i = 0; i < 240 && r.data.pending; i++) { await new Promise(res => setTimeout(res, 250)); r = await f.get('/api/deliverables?project=kestrel'); }
    assert.equal(r.data.pending, false);
    assert.equal(r.data.rows.length, 1); assert.equal(r.data.rows[0].branch, 'feat/a'); assert.equal(r.data.rows[0].state, 'done'); assert.equal(r.data.rows[0].project, 'kestrel');
    assert.equal((await f.get('/api/deliverables?project=all')).data.rows.length, 1);
    const get = async u => (await f.get(u)).data;
    const ib = renderTab('inbox', await loadTab('inbox', 'kestrel', get), { project: 'kestrel' });
    assert.match(ib, /id="deliverables"[\s\S]*feat\/a/);
    const m = (await f.get('/api/map?project=kestrel')).data;
    assert.equal(m.bands.find(b => b.lane === 'gen').deliverables[0].branch, 'feat/a');
    g(repo, 'merge', '-q', '--no-ff', '-m', 'merge a', 'feat/a');
    void loadState;
  } finally { await f.done(); }
});
