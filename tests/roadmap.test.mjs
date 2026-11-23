// META-ROADMAP S1 (DIR-11; SPEC sec. 1-3, 6): roadmap records (kind item, RM-n, roadmap.jsonl, structure only), the derived
// status (rule rows 1-14, first match wins), the drift detectors D1-D5, the generated view with its hand-edit guard, `norn road`.
// Synthetic records only (never a project's own text); temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { record, loadState, readEvents, fold, RecordError } from '../engine/lib/records.mjs';
import { loadRoadmap, foldRoadmap, childrenOf, derive, worldOf, detect, unplacedOf, goneLinks, buildTree, renderTree, renderRoadmapView,
  ROADMAP_HEADER, writeRoadmapView, checkLinks, RoadmapError } from '../engine/lib/roadmap.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { makeGit } from '../engine/lib/dlvgit.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const meta = (args, env = {}) => {
  const r = spawnSync(process.execPath, [META, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, META_ROLE: '', META_PROJECT: '', META_STATE: '', META_NO_TICK: '1', ...env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
const rec = (state, ev, data = {}, id, by = 'controller') => record(state, { kind: 'item', ev, id, by, data }, { views: false });
const refused = (fn, re) => assert.throws(fn, e => e instanceof RecordError && re.test(e.message), String(re));

// ---------- piece 1: the record kind ----------
test('item records: own file roadmap.jsonl, RM-n ids, create / edit / move / link / unlink / drop / reopen; loadState unchanged', () => {
  const s = mkTmp('meta-rm-');
  const t = rec(s, 'create', { title: 'Theme A', kind: 'theme' }).id;
  assert.equal(t, 'RM-1');
  assert.ok(fs.existsSync(path.join(s, 'roadmap.jsonl')), 'its own file');
  assert.ok(!fs.existsSync(path.join(s, 'records.jsonl')), 'records.jsonl untouched');
  assert.deepEqual(loadState(s).items, {}, 'loadState does not read the roadmap');
  const a = rec(s, 'create', { title: 'Item a', kind: 'item', parent: t, horizon: 'now', note: 'n', links: [], stages: ['S1 x'] }).id;
  rec(s, 'edit', { title: 'Item a2', caveat: 'default off' }, a);
  rec(s, 'link', { links: ['doc:SPEC.md'] }, a, 'launcher');
  let it = loadRoadmap(s).items[a];
  assert.equal(it.title, 'Item a2'); assert.equal(it.horizon, 'now'); assert.deepEqual(it.links, ['doc:SPEC.md']);
  assert.equal(it.caveat.text, 'default off'); assert.equal(it.caveat.by, 'controller'); assert.ok(it.caveat.ts);
  rec(s, 'unlink', { links: ['doc:SPEC.md'] }, a);
  rec(s, 'drop', { why: 'not wanted', ref: 'DEC-1' }, a, 'owner');
  it = loadRoadmap(s).items[a];
  assert.deepEqual(it.links, []); assert.equal(it.state, 'dropped'); assert.deepEqual([it.dropped.why, it.dropped.ref, it.dropped.by], ['not wanted', 'DEC-1', 'owner']);
  refused(() => rec(s, 'edit', { note: 'x' }, a), /is dropped/);
  rec(s, 'reopen', { why: 'wanted after all' }, a, 'owner');
  assert.equal(loadRoadmap(s).items[a].state, 'open');
  assert.equal(loadRoadmap(s).items[a].dropped, null);
  refused(() => rec(s, 'create', { title: 'x', kind: 'item', parent: t }, undefined, 'worker'), /role worker may not/);
});

test('item records refuse a typed status, bad links, a drop without a ref, a parentless item and a parented theme', () => {
  const s = mkTmp('meta-rm-');
  const t = rec(s, 'create', { title: 'T', kind: 'theme' }).id;
  refused(() => rec(s, 'create', { title: 'x', kind: 'item', parent: t, status: 'shipped' }), /status is derived/);
  refused(() => rec(s, 'create', { title: 'x', kind: 'item', parent: t, phase: 'past' }), /is derived/);
  refused(() => rec(s, 'create', { title: 'x', kind: 'item', parent: t, links: ['RUN-3'] }), /link/);
  refused(() => rec(s, 'create', { title: 'x', kind: 'item', parent: t, links: ['run:abc'] }), /link/);
  refused(() => rec(s, 'create', { title: 'x', kind: 'item', parent: t, horizon: 'soon' }), /horizon/);
  refused(() => rec(s, 'create', { title: 'x', kind: 'item' }), /parent/);
  refused(() => rec(s, 'create', { title: 'x', kind: 'item', parent: 'RM-9' }), /RM-9 does not exist/);
  refused(() => rec(s, 'create', { title: 'x', kind: 'theme', parent: t }), /theme/);
  refused(() => rec(s, 'create', { title: 'x', kind: 'item', parent: t, legacy: { word: 'SHIPPED' } }), /legacy/);
  const a = rec(s, 'create', { title: 'a', kind: 'item', parent: t, links: ['dir:DIR-1', 'lane:x-y', 'run:RUN-2', 'dlv:DLV-3', 'ep:EP-1', 'q:Q-4', 'dec:DEC-5', 'branch:feat/x', 'sha:abc1234', 'doc:docs/a b.md'] }).id;
  refused(() => rec(s, 'drop', { why: 'w' }, a), /ref/);
  refused(() => rec(s, 'drop', { why: 'w', ref: 'RUN-1' }, a), /ref/);
  refused(() => rec(s, 'move', { parent: a }, t), /theme/);
  refused(() => rec(s, 'move', { parent: a }, a), /under itself/);
  refused(() => rec(s, 'unlink', { links: ['dir:DIR-9'] }, a), /not linked/);
  // migration may carry a legacy claim
  const m = rec(s, 'create', { title: 'm', kind: 'item', parent: t, legacy: { word: 'SHIPPED', text: 'row', line: 3 } }, undefined, 'migration').id;
  assert.equal(loadRoadmap(s).items[m].legacy.word, 'SHIPPED');
});

test('item order: siblings in after-order (null = first, none = last); move re-parents and re-orders; a batch refers to its own creates as $n', () => {
  const s = mkTmp('meta-rm-');
  const t = rec(s, 'create', { title: 'T', kind: 'theme' }).id;
  const [a, b, c] = ['a', 'b', 'c'].map(x => rec(s, 'create', { title: x, kind: 'item', parent: t }).id);
  const order = p => childrenOf(loadRoadmap(s), p);
  assert.deepEqual(order(t), [a, b, c]);
  rec(s, 'move', { after: null }, c);
  assert.deepEqual(order(t), [c, a, b]);
  rec(s, 'move', { after: b, ref: 'DEC-7' }, a);
  assert.deepEqual(order(t), [c, b, a]);
  const d = rec(s, 'create', { title: 'd', kind: 'item', parent: t, after: c }).id;
  assert.deepEqual(order(t), [c, d, b, a]);
  refused(() => rec(s, 'move', { after: t }, a), /sibling/);
  const t2 = rec(s, 'create', { title: 'T2', kind: 'theme' }).id;
  assert.deepEqual(order(null), [t, t2]);
  rec(s, 'move', { parent: t2 }, b);
  assert.deepEqual([order(t), order(t2)], [[c, d, a], [b]]);
  rec(s, 'move', { parent: b }, a);   // items nest
  assert.deepEqual(order(b), [a]);
  refused(() => rec(s, 'move', { parent: a }, b), /under itself/);
  // a batch: one lock, its creates referred to as $n
  const out = record(s, [
    { kind: 'item', ev: 'create', by: 'controller', data: { title: 'T3', kind: 'theme' } },
    { kind: 'item', ev: 'create', by: 'controller', data: { title: 'x', kind: 'item', parent: '$0' } },
    { kind: 'item', ev: 'drop', id: '$1', by: 'controller', data: { why: 'w', ref: 'DIR-1' } },
  ], { views: false });
  const R = loadRoadmap(s);
  assert.equal(R.items[out[1].id].parent, out[0].id);
  assert.equal(R.items[out[1].id].state, 'dropped');
  // the fold is pure over events
  assert.deepEqual(Object.keys(foldRoadmap(readEvents(path.join(s, 'roadmap.jsonl'))).items), Object.keys(R.items));
  assert.equal(fold(readEvents(path.join(s, 'roadmap.jsonl'))).next.item, 8);
});

// ---------- piece 2: the derived status, rule rows 1-14 (SPEC sec. 2), pure over a synthetic world ----------
const NOW = Date.parse('2030-01-10T12:00:00Z'), DAY = 864e5;
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
// a run record as loadState folds it: start (or queue) and, when it ended, its end event; start / end = days ago
const runRec = (id, lane, { state = 'exited', outcome = 'done', start = 2, end = 1, stage, kind = 'worker', parent } = {}) => ({
  id, kind: 'run', state, created: iso(NOW - start * DAY), data: { lane, stage, kind, ...(parent ? { parent } : {}) },
  ...(state === 'exited' ? { end: { outcome } } : {}),
  history: [{ ev: ['queued', 'claimed'].includes(state) ? 'queue' : 'start', ts: iso(NOW - start * DAY), data: {} },
    ...(['exited', 'lost', 'killed'].includes(state) ? [{ ev: state === 'exited' ? 'end' : state === 'lost' ? 'lost' : 'kill', ts: iso(NOW - end * DAY), data: { outcome } }] : [])] });
const recd = (id, kind, state, data = {}) => ({ id, kind, state, created: iso(NOW - 5 * DAY), data, history: [] });
const byId = xs => Object.fromEntries(xs.map(x => [x.id, x]));
const dlvRow = (id, branch, state, { lane = null, days = 2, superseded = false } = {}) => ({ id, branch, lane, state, target: 'install', record_state: superseded ? 'superseded' : 'open',
  days, done_utc: iso(NOW - days * DAY), merges: [], ...(superseded ? { superseded: { by: 'abc1234' } } : {}) });
const W = (o = {}) => worldOf({ now: NOW, items: byId(o.items || []), dlv: o.dlv || [], branches: o.branches || {}, shas: o.shas || {}, docs: o.docs || [],
  hasInstall: !!o.install, epics: o.epics || {} });
const node = (links = [], extra = {}) => ({ id: 'RM-2', kind: 'item', title: 'x', note: '', links, stages: [], horizon: null, caveat: null, legacy: null,
  state: 'open', dropped: null, parent: 'RM-1', created: iso(NOW - 9 * DAY), ...extra });
const st = (n, w) => { const d = derive(n, w); return [d.row, d.status, d.phase]; };

test('derive rows 1-3: dropped beats live; a live run = building; an open question or a parked lane = waiting', () => {
  const live = runRec('RUN-1', 'a', { state: 'running', start: 0.1 });
  const dropped = node(['lane:a'], { state: 'dropped', dropped: { why: 'no', ref: 'DEC-1', by: 'owner', ts: iso(NOW) } });
  assert.deepEqual(st(dropped, W({ items: [live] })), [1, 'dropped', 'past']);
  const d2 = derive(node(['lane:a', 'q:Q-1']), W({ items: [live, recd('Q-1', 'question', 'open')] }));
  assert.deepEqual([d2.row, d2.status, d2.phase], [2, 'building', 'present'], 'live beats an open question');
  assert.match(d2.why, /RUN-1/);
  assert.deepEqual(st(node(['run:RUN-1']), W({ items: [live] })), [2, 'building', 'present'], 'a linked run counts as a linked lane');
  const merged = { 'feat/a': { exists: true, merged: true, installed: false } };
  const d3 = derive(node(['q:Q-1', 'branch:feat/a']), W({ items: [recd('Q-1', 'question', 'open')], branches: merged }));
  assert.deepEqual([d3.row, d3.status, d3.phase], [3, 'waiting', 'present'], 'an open question beats a shipped branch');
  assert.match(d3.why, /Q-1/);
  assert.deepEqual(st(node(['lane:a']), W({ items: [recd('L:a', 'lane', 'parked', { name: 'a' })] })), [3, 'waiting', 'present']);
  assert.deepEqual(st(node(['q:Q-1']), W({ items: [recd('Q-1', 'question', 'answered')] })).slice(1), ['idea', 'future'], 'an answered question is no wait');
});

test('derive rows 4-5: every branch / DLV at the target = shipped; on main but the install target not reached = merged, not installed', () => {
  const br = { 'feat/a': { exists: true, merged: true, installed: false }, 'feat/b': { exists: true, merged: true, installed: true } };
  assert.deepEqual(st(node(['branch:feat/a']), W({ branches: br })), [4, 'shipped', 'past'], 'no install target: main is the target');
  assert.deepEqual(st(node(['branch:feat/b']), W({ branches: br, install: true })), [4, 'shipped', 'past']);
  assert.deepEqual(st(node(['dlv:DLV-1']), W({ dlv: [dlvRow('DLV-1', 'feat/c', 'installed')], install: true })), [4, 'shipped', 'past']);
  assert.deepEqual(st(node(['dlv:DLV-1']), W({ dlv: [dlvRow('DLV-1', 'feat/c', 'done', { superseded: true })], install: true })), [4, 'shipped', 'past'], 'superseded = landed another way');
  const q = runRec('RUN-5', 'a', { state: 'queued', start: 0.1 });
  assert.deepEqual(st(node(['branch:feat/a', 'lane:a']), W({ items: [q], branches: br })), [4, 'shipped', 'past'], 'row 4 beats a queued run');
  const d5 = derive(node(['branch:feat/a', 'branch:feat/b']), W({ branches: br, install: true }));
  assert.deepEqual([d5.row, d5.status, d5.phase], [5, 'merged', 'present']);
  assert.match(d5.why, /not installed/);
});

test('derive rows 6-9: queued (none started) / queued after earlier runs / a DLV DONE not on main / an unmerged branch by its last run age', () => {
  const q = runRec('RUN-5', 'a', { state: 'queued', start: 0.1 }), old = runRec('RUN-4', 'a', { start: 3, end: 2 });
  assert.deepEqual(st(node(['lane:a']), W({ items: [q] })), [6, 'queued', 'future']);
  assert.deepEqual(st(node(['lane:a']), W({ items: [q, old] })), [7, 'building', 'present']);
  const d8 = derive(node(['lane:a']), W({ items: [old], dlv: [dlvRow('DLV-3', 'feat/a', 'done', { lane: 'a', days: 4 })] }));
  assert.deepEqual([d8.row, d8.status, d8.phase], [8, 'built', 'present'], 'a linked lane brings its DLVs');
  assert.match(d8.why, /DLV-3 DONE, not on main \(4 d\)/);
  const un = { 'feat/u': { exists: true, merged: false, installed: false } };
  assert.deepEqual(st(node(['branch:feat/u', 'lane:a']), W({ items: [runRec('RUN-6', 'a', { start: 2, end: 1 })], branches: un })), [9, 'building', 'present']);
  assert.deepEqual(st(node(['branch:feat/u', 'lane:a']), W({ items: [runRec('RUN-6', 'a', { start: 6, end: 5 })], branches: un })), [9, 'built', 'present']);
  assert.deepEqual(st(node(['branch:feat/u']), W({ branches: un })), [9, 'built', 'present'], 'no run at all: built');
});

test('derive rows 10-14: runs not all DONE = building; all DONE and no branch = shipped / built; a sha on main; planned; idea', () => {
  const stopped = runRec('RUN-7', 'a', { outcome: 'stopped', start: 2, end: 1 });
  const d10 = derive(node(['lane:a']), W({ items: [stopped] }));
  assert.deepEqual([d10.row, d10.status, d10.phase], [10, 'building', 'present']);
  assert.match(d10.why, /RUN-7 ended stopped/);
  // a planned stage with no run yet keeps it open (S1 DONE, S2 planned): 1 / 2
  const s1 = runRec('RUN-8', 'a', { stage: 'S1', start: 2, end: 1 });
  const dS = derive(node(['lane:a'], { stages: ['S1 records', 'S2 tab'] }), W({ items: [s1] }));
  assert.deepEqual([dS.row, dS.status], [10, 'building']);
  assert.deepEqual(dS.progress, { done: 1, total: 2 });
  assert.deepEqual(dS.stages.map(s => [s.key, s.state]), [['S1', 'done'], ['S2 tab', 'planned']], 'a planned stage a run carries is not listed twice');
  // a HANDOFF then its successor DONE on the same stage: the stage is DONE
  const h = runRec('RUN-9', 'a', { outcome: 'handoff', stage: 'S1', start: 3, end: 2.5 }), h2 = runRec('RUN-10', 'a', { stage: 'S1', start: 2.4, end: 2 });
  assert.deepEqual(st(node(['lane:a']), W({ items: [h, h2] })), [11, 'shipped', 'past']);
  assert.deepEqual(st(node(['lane:a']), W({ items: [h, h2], install: true })), [11, 'built', 'present']);
  assert.deepEqual(st(node(['sha:abc1234']), W({ shas: { abc1234: true } })), [12, 'shipped', 'past']);
  assert.deepEqual(st(node(['sha:abc1234']), W({ shas: { abc1234: false } })).slice(1), ['idea', 'future'], 'a sha not on main is no evidence');
  assert.deepEqual(st(node([], { horizon: 'later' }), W()), [13, 'planned', 'future']);
  assert.deepEqual(st(node([], { stages: ['S1'] }), W()), [13, 'planned', 'future']);
  assert.deepEqual(st(node(['doc:SPEC.md']), W({ docs: ['SPEC.md'] })), [13, 'planned', 'future']);
  const d14 = derive(node(['dir:DIR-1']), W({ items: [recd('DIR-1', 'directive', 'active')] }));
  assert.deepEqual([d14.row, d14.status, d14.phase], [14, 'idea', 'future'], 'a directive alone is no evidence');
  // checkin runs and withdrawn / filled queue entries are never the item's work
  assert.deepEqual(st(node(['lane:a']), W({ items: [runRec('RUN-11', 'a', { state: 'running', kind: 'checkin' })] })).slice(1), ['idea', 'future']);
  assert.deepEqual(st(node(['lane:a']), W({ items: [runRec('RUN-12', 'a', { state: 'withdrawn' })] })).slice(1), ['idea', 'future']);
  // an epic link brings its member runs
  assert.deepEqual(st(node(['ep:EP-1']), W({ items: [runRec('RUN-13', 'b', { state: 'running' })], epics: { 'EP-1': { state: 'open', title: 'e', members: ['RUN-13'] } } })).slice(0, 2), [2, 'building']);
});

test('derive spans (S2 time line): one stretch per started run, oldest first, start -> end (live: open), the run word; first = the oldest start', () => {
  const a = runRec('RUN-1', 'a', { stage: 'S1', start: 5, end: 4 }), b = runRec('RUN-2', 'a', { outcome: 'stopped', start: 3, end: 2.5 });
  const live = runRec('RUN-3', 'a', { state: 'running', start: 0.5 }), q = runRec('RUN-4', 'a', { state: 'queued', start: 0.1 });
  const d = derive(node(['lane:a']), W({ items: [live, b, q, a] }));
  assert.deepEqual(d.spans, [{ run: 'RUN-1', from: iso(NOW - 5 * DAY), to: iso(NOW - 4 * DAY), state: 'done' },
    { run: 'RUN-2', from: iso(NOW - 3 * DAY), to: iso(NOW - 2.5 * DAY), state: 'stopped' }, { run: 'RUN-3', from: iso(NOW - 0.5 * DAY), to: null, state: 'live' }],
  'queued runs are no stretch; a live run is open-ended');
  assert.equal(d.first, iso(NOW - 5 * DAY));
  const p = derive(node([], { stages: ['S1'] }), W());
  assert.deepEqual([p.spans, p.first], [[], null], 'a planned item has no dates (the view draws a stub)');
});

// ---------- piece 3: the drift detectors D1-D5 (SPEC sec. 2 "How drift is detected") ----------
const flagsOf = (n, w) => detect(n, derive(n, w), w);
const legacy = word => ({ word, text: 'a row', line: 7 });
const un = { 'feat/u': { exists: true, merged: false, installed: false }, 'feat/m': { exists: true, merged: true, installed: false } };

test('D1 claimed: a legacy word or a caveat with no evidence behind it is a claim; the status stays derived', () => {
  const n = node([], { legacy: legacy('SHIPPED') });
  const d = derive(n, W());
  assert.equal(d.status, 'idea', 'a legacy word never becomes the status');
  assert.equal(detect(n, d, W()).claimed, 'claimed: SHIPPED');
  assert.equal(flagsOf(node([], { caveat: { text: 'default off', by: 'checkin', ts: iso(NOW - DAY) } }), W()).claimed, 'claimed: default off');
  assert.equal(flagsOf(node(['branch:feat/m'], { legacy: legacy('SHIPPED') }), W({ branches: un })).claimed, null, 'evidence: no claim');
  assert.equal(flagsOf(node(), W()).claimed, null);
});

test('D2 contradiction: the legacy word disagrees with the derived status, or the caveat is older than the newest evidence', () => {
  const a = flagsOf(node(['branch:feat/u'], { legacy: legacy('SHIPPED') }), W({ branches: un }));
  assert.equal(a.drift.length, 1); assert.match(a.drift[0], /legacy says SHIPPED; records say built/);
  assert.match(flagsOf(node(['branch:feat/m'], { legacy: legacy('BUILDING') }), W({ branches: un })).drift[0], /legacy says BUILDING; records say shipped/);
  assert.deepEqual(flagsOf(node(['branch:feat/m'], { legacy: legacy('SHIPPED') }), W({ branches: un })).drift, [], 'agreeing word');
  assert.deepEqual(flagsOf(node([], { legacy: legacy('SHIPPED') }), W()).drift, [], 'no evidence = D1, not D2');
  const r = runRec('RUN-1', 'a', { start: 3, end: 2 });
  const old = flagsOf(node(['lane:a'], { caveat: { text: 'default off', by: 'checkin', ts: iso(NOW - 5 * DAY) } }), W({ items: [r] }));
  assert.match(old.drift[0], /caveat "default off" is older than the newest evidence/);
  assert.deepEqual(flagsOf(node(['lane:a'], { caveat: { text: 'default off', by: 'checkin', ts: iso(NOW - DAY) } }), W({ items: [r] })).drift, []);
});

test('D3 unplaced: recent / live lanes, DONE-not-merged DLVs, active directives and open epics that no item links', () => {
  const items = [runRec('RUN-1', 'a', { start: 1, end: 0.5 }), runRec('RUN-2', 'u', { state: 'running', start: 0.2 }), runRec('RUN-3', 'old', { start: 12, end: 10 }),
    runRec('RUN-4', 'ck', { state: 'running', kind: 'checkin' }), runRec('RUN-5', 'kid', { state: 'running', parent: 'RUN-2' }), runRec('RUN-6', 'byrun', { state: 'running' }),
    recd('DIR-1', 'directive', 'active', { text: 'do the thing' }), recd('DIR-2', 'directive', 'active'), recd('DIR-3', 'directive', 'done')];
  const dlv = [dlvRow('DLV-1', 'feat/x', 'done', { lane: 'zz' }), dlvRow('DLV-2', 'feat/a', 'done', { lane: 'a' }), dlvRow('DLV-3', 'feat/y', 'merged'), dlvRow('DLV-4', 'feat/z', 'done', { superseded: true })];
  const epics = { 'EP-1': { state: 'open', title: 'e1', members: [] }, 'EP-2': { state: 'closed', title: 'e2', members: [] }, 'EP-3': { state: 'open', title: 'e3', members: [] } };
  const w = W({ items, dlv, epics });
  const nodes = [node(['lane:a', 'dir:DIR-2', 'run:RUN-6']), node(['ep:EP-3'], { state: 'dropped', dropped: { why: 'w', ref: 'DEC-1' } })];
  const u = unplacedOf(nodes, w);
  assert.deepEqual(u.map(x => x.id).sort(), ['DIR-1', 'DLV-1', 'EP-1', 'L:u'].sort());
  assert.match(u.find(x => x.id === 'L:u').why, /live now/);
  assert.match(u.find(x => x.id === 'DLV-1').why, /feat\/x DONE 2 d, not on main/);
  assert.deepEqual(unplacedOf([node(['lane:u', 'dlv:DLV-1', 'dir:DIR-1', 'dir:DIR-2', 'ep:EP-1', 'ep:EP-3', 'lane:a', 'lane:byrun'])], w), []);
});

test('D4 idle: a present item with no run for 7 d (horizon now: 3 d); live, queued and future items are never idle', () => {
  const r = days => runRec('RUN-1', 'a', { outcome: 'stopped', start: days + 1, end: days });
  assert.equal(flagsOf(node(['lane:a']), W({ items: [r(8)] })).idle, 8);
  assert.equal(flagsOf(node(['lane:a']), W({ items: [r(5)] })).idle, null);
  assert.equal(flagsOf(node(['lane:a'], { horizon: 'now' }), W({ items: [r(5)] })).idle, 5);
  assert.equal(flagsOf(node(['lane:a'], { horizon: 'now' }), W({ items: [r(2)] })).idle, null);
  assert.equal(flagsOf(node(['lane:a']), W({ items: [r(9), runRec('RUN-2', 'a', { state: 'queued', start: 0.1 })] })).idle, null, 'queued: not idle');
  assert.equal(flagsOf(node(['lane:a']), W({ items: [runRec('RUN-1', 'a', { start: 30, end: 29 })] })).idle, null, 'past (shipped): not idle');
  assert.equal(flagsOf(node(['dlv:DLV-1']), W({ dlv: [dlvRow('DLV-1', 'feat/x', 'done', { days: 9 })] })).idle, 9, 'no run: the DLV DONE date counts');
});

test('D5 link gone: a linked branch / record / sha / doc that does not exist', () => {
  const w = W({ items: [recd('DIR-1', 'directive', 'active'), recd('L:a', 'lane', 'active', { name: 'a' }), runRec('RUN-1', 'b')], dlv: [dlvRow('DLV-1', 'feat/x', 'done')],
    branches: un, shas: { abc1234: true }, docs: ['SPEC.md'], epics: { 'EP-1': { state: 'open', members: [] } } });
  const ok = ['dir:DIR-1', 'lane:a', 'lane:b', 'run:RUN-1', 'dlv:DLV-1', 'ep:EP-1', 'branch:feat/u', 'branch:feat/x', 'sha:abc1234', 'doc:SPEC.md'];
  assert.deepEqual(flagsOf(node(ok), w).gone, []);
  const bad = ['dir:DIR-9', 'dec:DEC-9', 'q:Q-9', 'lane:zz', 'run:RUN-9', 'dlv:DLV-9', 'ep:EP-9', 'branch:feat/gone', 'sha:fff9999', 'doc:NOPE.md'];
  assert.deepEqual(flagsOf(node(bad), w).gone, bad);
  assert.deepEqual(goneLinks(['lane:zz', 'dir:DIR-1'], w), ['lane:zz']);
});

// ---------- piece 4: the tree over a real state dir, its cache, the generated view and its hand-edit guard ----------
const seedState = () => {
  const s = mkTmp('meta-rm-');
  record(s, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'build the thing', via: 'dashboard', scope: [] } }, { views: false });
  record(s, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'an unplaced wish', via: 'dashboard', scope: [] } }, { views: false });
  record(s, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'fake', lane: 'alpha', stage: 'S1' } }, { views: false });
  const t = rec(s, 'create', { title: 'Theme one', kind: 'theme' }).id;
  rec(s, 'create', { title: 'Alpha work', kind: 'item', parent: t, links: ['lane:alpha', 'dir:DIR-1'], stages: ['S1 first', 'S2 second'] });
  rec(s, 'create', { title: 'Later idea', kind: 'item', parent: t, horizon: 'later' });
  rec(s, 'create', { title: 'Theme two', kind: 'theme' });
  return s;
};

test('buildTree: themes -> items with derived status + flags, counts and unplaced; cached on the records files (0 work when nothing changed)', () => {
  const s = seedState();
  const memo = {};
  const tr = buildTree({ stateDir: s, project: { name: 'demo', title: 'Demo' }, memo });
  assert.deepEqual(tr.themes.map(t => [t.id, t.title, t.children.length]), [['RM-1', 'Theme one', 2], ['RM-4', 'Theme two', 0]]);
  const [a, l] = tr.themes[0].children;
  assert.deepEqual([a.id, a.status, a.phase, a.live.length, a.progress.total], ['RM-2', 'building', 'present', 1, 2]);
  assert.deepEqual([l.status, l.phase], ['planned', 'future']);
  assert.deepEqual(tr.unplaced.map(u => u.id), ['DIR-2']);
  assert.deepEqual([tr.counts.items, tr.counts.present, tr.counts.future, tr.counts.live, tr.counts.unplaced], [2, 1, 1, 1, 1]);
  assert.deepEqual(tr.themes[0].counts, { past: 0, present: 1, future: 1 });
  assert.equal(buildTree({ stateDir: s, project: { name: 'demo' }, memo }), tr, 'nothing changed: the cached tree');
  assert.equal(memo.hits, 1);
  rec(s, 'link', { links: ['dir:DIR-2'] }, 'RM-3');
  const tr2 = buildTree({ stateDir: s, project: { name: 'demo' }, memo });
  assert.notEqual(tr2, tr, 'an append rebuilds');
  assert.deepEqual(tr2.unplaced, []);
  const text = renderTree(tr2);
  assert.match(text, /RM-1 Theme one/); assert.match(text, /RM-2 +building +0\/2 +Alpha work/); assert.match(text, /RUN-1/);
  const md = renderRoadmapView(tr2);
  assert.ok(md.startsWith(ROADMAP_HEADER));
  assert.match(md, /\| building \| RM-2 Alpha work \| 0\/2 \|/);
  assert.match(md, /## Unplaced \(0\)/);
});

test('the ROADMAP view: written, unchanged, rewritten, and a hand edit refused (the views hash guard)', () => {
  const s = seedState();
  const p = path.join(s, 'views', 'ROADMAP.md');
  assert.equal(writeRoadmapView(s, buildTree({ stateDir: s }), p), 'written');
  assert.ok(fs.readFileSync(p, 'utf8').startsWith(ROADMAP_HEADER));
  assert.equal(writeRoadmapView(s, buildTree({ stateDir: s }), p), 'unchanged');
  rec(s, 'edit', { title: 'Alpha work, renamed' }, 'RM-2');
  assert.equal(writeRoadmapView(s, buildTree({ stateDir: s }), p), 'written');
  assert.match(fs.readFileSync(p, 'utf8'), /Alpha work, renamed/);
  fs.appendFileSync(p, '\nhand edit\n');
  rec(s, 'edit', { title: 'Alpha again' }, 'RM-2');
  assert.equal(writeRoadmapView(s, buildTree({ stateDir: s }), p), 'refused');
  assert.match(fs.readFileSync(p, 'utf8'), /hand edit/, 'the hand edit is kept, never overwritten');
});

test('checkLinks refuses a link to something that does not exist (records, lanes, runs; a branch with no repo to check)', () => {
  const s = seedState();
  checkLinks(s, ['lane:alpha', 'dir:DIR-1', 'run:RUN-1']);
  assert.throws(() => checkLinks(s, ['lane:nope', 'dir:DIR-9']), e => e instanceof RoadmapError && /lane:nope/.test(e.message) && /dir:DIR-9/.test(e.message));
  assert.throws(() => checkLinks(s, ['branch:feat/x']), e => e instanceof RoadmapError && /repo/.test(e.message));
});

test('C8: a deliverables view or an epics read that fails is that error, never "every dlv: / ep: link is gone"', () => {
  const s = seedState(), repo = mkTmp('meta-road-repo-');
  const g = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8', windowsHide: true }).stdout.trim();
  g('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g('add', '-A'); g('commit', '-qm', 'init');
  g('checkout', '-q', '-b', 'feat/x'); fs.writeFileSync(path.join(repo, 'a.txt'), 'b\n'); g('commit', '-qam', 'x'); const tip = g('rev-parse', 'HEAD'); g('checkout', '-q', 'main');
  const id = record(s, { kind: 'deliverable', ev: 'create', by: 'controller', data: { repo, branch: 'feat/x', tip, delivers: 'x', done_utc: new Date().toISOString() } }, { views: false }).id;
  const real = makeGit(), broken = (r, args, o) => { if (args[0] === 'cherry') throw new Error('git cherry: boom'); return real(r, args, o); };
  assert.throws(() => checkLinks(s, [`dlv:${id}`], { git: broken }), e => !(e instanceof RoadmapError) && /git cherry: boom/.test(e.message));
  checkLinks(s, [`dlv:${id}`]);   // the same link with a working git: valid
  fs.appendFileSync(path.join(s, 'epics.jsonl'), '{"torn"');
  assert.throws(() => checkLinks(s, ['ep:EP-1']), e => !(e instanceof RoadmapError) && /integrity/.test(e.message));
});

// ---------- piece 5: norn road (SPEC sec. 3) ----------
test('norn road add | edit | move | link | unlink | drop | reopen | list | show; roles; refused links; the view follows every edit', () => {
  const s = seedState();
  const r = (...a) => meta(['road', ...a, '--state', s, '--as', 'controller']);
  let o = meta(['road', 'show', '--state', s]);
  assert.equal(o.code, 0, o.err);
  assert.match(o.out, /RM-2 +building +0\/2 +Alpha work/);
  assert.match(o.out, /Unplaced \(1\)\n +DIR-2/);
  o = meta(['road', 'add', '--title', 'x', '--theme', 'RM-1', '--state', s]);
  assert.equal(o.code, 2); assert.match(o.err, /role/);
  assert.equal(meta(['road', 'add', '--title', 'x', '--theme', 'RM-1', '--state', s, '--as', 'worker']).code, 2, 'workers write no roadmap records');
  o = r('add', '--title', 'New one', '--theme', 'RM-4', '--horizon', 'next', '--links', 'lane:alpha', '--stages', 'S1 one;S2 two');
  assert.equal(o.code, 0, o.err); assert.equal(o.out, 'RM-5');
  assert.equal(r('add', '--kind', 'theme', '--title', 'Theme three').out, 'RM-6');
  o = r('add', '--from', 'DIR-2', '--theme', 'RM-4');
  assert.equal(o.out, 'RM-7');
  let R = loadRoadmap(s);
  assert.deepEqual([R.items['RM-7'].title, R.items['RM-7'].links], ['an unplaced wish', ['dir:DIR-2']]);
  assert.deepEqual(R.items['RM-5'].stages, ['S1 one', 'S2 two']);
  o = r('add', '--title', 'bad', '--theme', 'RM-4', '--links', 'lane:nope');
  assert.equal(o.code, 2); assert.match(o.err, /does not exist: lane:nope/);
  assert.equal(r('add', '--title', 'bad', '--theme', 'RM-4', '--status', 'shipped').code, 2, 'no status flag');
  assert.equal(r('edit', 'RM-5', '--note', 'a note', '--caveat', 'default off', '--horizon', 'none').code, 0);
  R = loadRoadmap(s);
  assert.deepEqual([R.items['RM-5'].note, R.items['RM-5'].caveat.text, R.items['RM-5'].horizon], ['a note', 'default off', null]);
  assert.equal(r('move', 'RM-7', '--first', '--ref', 'DEC-3').code, 0);
  assert.deepEqual(childrenOf(loadRoadmap(s), 'RM-4'), ['RM-7', 'RM-5']);
  assert.equal(r('move', 'RM-5', '--theme', 'RM-6').code, 0);
  assert.deepEqual(childrenOf(loadRoadmap(s), 'RM-6'), ['RM-5']);
  assert.equal(r('link', 'RM-5', 'dir:DIR-1', 'run:RUN-1').code, 0);
  assert.equal(r('link', 'RM-5', 'run:RUN-9').code, 2);
  assert.equal(r('unlink', 'RM-5', 'run:RUN-1').code, 0);
  assert.deepEqual(loadRoadmap(s).items['RM-5'].links, ['lane:alpha', 'dir:DIR-1']);
  assert.match(r('drop', 'RM-5', '--why', 'w').err, /ref/);
  assert.match(r('drop', 'RM-5', '--why', 'w', '--ref', 'DIR-9').err, /dir:DIR-9/);
  assert.equal(r('drop', 'RM-5', '--why', 'not now', '--ref', 'DIR-1').code, 0);
  assert.equal(loadRoadmap(s).items['RM-5'].state, 'dropped');
  assert.equal(r('reopen', 'RM-5', '--why', 'back').code, 0);
  const list = JSON.parse(meta(['road', 'list', '--json', '--state', s]).out);
  assert.deepEqual(list.map(i => [i.id, i.status]).slice(0, 2), [['RM-2', 'building'], ['RM-3', 'planned']]);
  const one = JSON.parse(meta(['road', 'show', 'RM-2', '--json', '--state', s]).out);
  assert.deepEqual([one.id, one.status, one.row, one.live], ['RM-2', 'building', 2, ['RUN-1']]);
  assert.match(meta(['road', 'show', 'RM-2', '--state', s]).out, /RM-2 +building/);
  const view = fs.readFileSync(path.join(s, 'views', 'ROADMAP.md'), 'utf8');
  assert.match(view, /Theme three/, 'the view was regenerated by the edits');
});

test('norn road audit prints D1-D5 and exits 1 while the Unplaced list is not empty; norn road apply writes a whole plan under one lock', () => {
  const s = seedState();
  let o = meta(['road', 'audit', '--state', s]);
  assert.equal(o.code, 1);
  assert.match(o.out, /D3 unplaced \(1\)\n +DIR-2/);
  assert.match(o.out, /D1 claimed \(0\)/); assert.match(o.out, /D5 link gone \(0\)/);
  const plan = path.join(s, '..', 'plan.json');
  fs.writeFileSync(plan, JSON.stringify({ title: 'a plan', themes: [{ title: 'Applied', items: [
    { title: 'one', lanes: ['alpha'], stages: ['S1 a'], caveat: 'default off' },
    { title: 'two', dir: ['DIR-2'], horizon: 'later', items: [{ title: 'two.child', note: 'n' }] },
    { title: 'gone', dropped: { why: 'no', ref: 'DIR-1' } }] }] }));
  const before = fs.readFileSync(path.join(s, 'roadmap.jsonl'), 'utf8');
  fs.writeFileSync(path.join(s, '..', 'bad.json'), JSON.stringify({ themes: [{ title: 'B', items: [{ title: 'x', lanes: ['nope'] }] }] }));
  o = meta(['road', 'apply', path.join(s, '..', 'bad.json'), '--state', s, '--as', 'controller']);
  assert.equal(o.code, 2); assert.match(o.err, /lane:nope/);
  assert.equal(fs.readFileSync(path.join(s, 'roadmap.jsonl'), 'utf8'), before, 'a refused plan writes nothing');
  o = meta(['road', 'apply', plan, '--state', s, '--as', 'controller']);
  assert.equal(o.code, 0, o.err);
  assert.match(o.out, /applied 5 nodes \(1 theme, 4 items\)/);
  const R = loadRoadmap(s), th = childrenOf(R, null).at(-1);
  assert.equal(R.items[th].title, 'Applied');
  const [one, two, gone] = childrenOf(R, th).map(id => R.items[id]);
  assert.deepEqual([one.title, one.caveat.text, two.title, gone.state, R.items[childrenOf(R, two.id)[0]].title], ['one', 'default off', 'two', 'dropped', 'two.child']);
  o = meta(['road', 'audit', '--state', s, '--json']);
  assert.equal(o.code, 0, 'DIR-2 placed: unplaced is empty');
  assert.equal(JSON.parse(o.out).counts.unplaced, 0);
});

// ---------- META-ROADMAP S4 (SPEC sec. 5): import a hand-kept catalogue, review the plan, apply, the view takes the old path ----------
test('norn road import --legacy: a dry-run plan (nothing written), the review summary; apply as migration; the view replaces the frozen file', () => {
  const s = seedState(), root = path.join(s, '..', 'repo');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'map.md'), '# map\n');
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'adopt', 'catalogue.md'), 'utf8');
  const old = path.join(root, 'ROADMAP.md');
  fs.writeFileSync(old, src.replace(/DIR-3\b/g, 'DIR-1').replace(/RUN-4\b/g, 'RUN-1'));   // the fixture copy, citing a directive + a run this state has
  const pj = path.join(s, '..', 'project.json');
  fs.writeFileSync(pj, JSON.stringify({ schema: 1, name: 'demo', title: 'Demo', root, views: { roadmap: old } }));
  const before = fs.readFileSync(path.join(s, 'roadmap.jsonl'), 'utf8');
  const plan = path.join(s, '..', 'plan.json');
  let o = meta(['road', 'import', '--legacy', old, '--out', plan, '--project', pj, '--state', s]);
  assert.equal(o.code, 0, o.err);
  assert.equal(fs.readFileSync(path.join(s, 'roadmap.jsonl'), 'utf8'), before, 'the import is a dry run: no record');
  assert.match(o.out, /^placed 7 of 8 rows \(87\.5 %\); 3 themes; 1 not placed/m);
  assert.match(o.out, /^## Now \(2\)$/m);
  assert.match(o.out, /L14 +SHIPPED +TIDE CACHE +links: dir:DIR-1, run:RUN-1; unresolved: branch:feat\/tide-cache$/m, 'what does not resolve is listed for the review');
  assert.match(o.out, /^not placed: L30 \(Maps and look\): no item text$/m);
  const p = JSON.parse(fs.readFileSync(plan, 'utf8'));
  assert.deepEqual(p.themes.map(t => t.title), ['Now', 'Maps and look', 'Platform']);
  assert.deepEqual(p.themes[1].items[0].links, ['doc:docs/map.md'], 'a doc is linked when it exists under the project root');
  assert.deepEqual(p.themes[1].items[3].dropped, undefined, 'DEC-12 is unknown here: no drop, the word stays a claim');
  o = meta(['road', 'import', '--legacy', old, '--project', pj, '--state', s, '--sections', 'nope']);
  assert.equal(o.code, 1, 'nothing placed: exit 1'); assert.match(o.out, /placed 0 of 0 rows/);
  p.themes[0].title = 'Installs and doors';   // the review renames a theme in the plan file
  fs.writeFileSync(plan, JSON.stringify(p));
  o = meta(['road', 'apply', plan, '--project', pj, '--state', s, '--as', 'migration']);
  assert.equal(o.code, 0, o.err);
  assert.match(o.out, /applied 10 nodes \(3 themes, 7 items\)/);
  assert.match(o.err, /edited by hand - not rewritten/, 'the hand-kept file is never overwritten before it is frozen');
  assert.equal(fs.readFileSync(old, 'utf8').includes('# ROADMAP: the tide-app program'), true);
  const R = loadRoadmap(s), tide = Object.values(R.items).find(i => i.title === 'TIDE CACHE');
  assert.deepEqual([tide.legacy.word, tide.legacy.line, tide.by, R.items[tide.parent].title], ['SHIPPED', 14, 'migration', 'Installs and doors']);
  fs.renameSync(old, path.join(root, 'ROADMAP-LEGACY.md'));   // the freeze: nothing deleted
  o = meta(['road', 'audit', '--project', pj, '--state', s, '--json']);
  const a = JSON.parse(o.out);
  assert.ok(a.claimed.some(c => c.title === 'Watch app' && /MERGED DEFAULT OFF/.test(c.claim)), 'a legacy word with no evidence is a claim');
  assert.ok(a.drift.some(d => d.title === 'TIDE CACHE' && /legacy says SHIPPED; records say building/.test(d.drift)), 'drift: the row says SHIPPED, a run is live');
  const md = fs.readFileSync(old, 'utf8');
  assert.ok(md.startsWith(ROADMAP_HEADER), 'the generated view now sits at the old path');
  assert.match(md, /^## Now \(present\)$/m); assert.match(md, /^## Built, not at the target$/m); assert.match(md, /^## Order \(horizon\)$/m);
  fs.appendFileSync(old, '\nhand edit\n');
  o = meta(['road', 'edit', tide.id, '--note', 'n', '--project', pj, '--state', s, '--as', 'controller']);
  assert.equal(o.code, 0, o.err); assert.match(o.err, /edited by hand/);
});

test('OOTB-R2 N-4: a fake-executor run (a rehearsal) never counts toward the derived status: a DONE rehearsal does not ship an item', () => {
  const fake = r => ({ ...r, data: { ...r.data, executor: 'fake' } });
  const reh = fake(runRec('RUN-1', 'a', { stage: 'IMPLEMENT' }));
  assert.deepEqual(st(node(['lane:a']), W({ items: [reh] })), [14, 'idea', 'future'], 'only a rehearsal: no evidence');
  assert.equal(derive(node(['lane:a']), W({ items: [reh] })).evidence, false);
  assert.deepEqual(st(node(['lane:a']), W({ items: [fake(runRec('RUN-2', 'a', { state: 'running', start: 0.1 }))] })), [14, 'idea', 'future'], 'a live rehearsal is not building');
  const real = { ...runRec('RUN-3', 'a', { stage: 'IMPLEMENT' }), data: { lane: 'a', stage: 'IMPLEMENT', kind: 'worker', executor: 'claude' } };
  assert.deepEqual(st(node(['lane:a']), W({ items: [reh, real] })), [11, 'shipped', 'past'], 'a real run still counts');
});
