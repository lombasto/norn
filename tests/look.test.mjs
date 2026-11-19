// META-CATCH S2: picture proof for look items. A roadmap item with proof form `look` (norn road edit --proof look --views ..) needs a
// Look: line in a round >= 2 brief and every MERGE / INSTALL brief (norn run refuses, exit 6), a DONE end naming an image newer than
// the run's start, and a look verdict newer than the deliverable's head before the merge queue takes it. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { record, loadState } from '../engine/lib/records.mjs';
import { loadRoadmap, foldRoadmap } from '../engine/lib/roadmap.mjs';
import { lookLine, lookItemsFor, lookBriefRefusal, doneProof, lookHold, rowLookItems, lookPolicy } from '../engine/lib/look.mjs';
import { makeResult, writeResult, readResult } from '../engine/lib/result.mjs';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';

test.after(cleanTmp);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const NORN = path.join(HERE, '..', 'engine', 'bin', 'norn.mjs');
const norn = (args, env = {}) => {
  const r = spawnSync(process.execPath, [NORN, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, META_ROLE: '', META_PROJECT: '', META_STATE: '', META_NO_TICK: '1', ...env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
const T0 = Date.parse('2026-11-08T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
const ev = (seq, e, id, data, ts = iso(T0), by = 'controller') => ({ seq, kind: 'item', ev: e, id, by, ts, data });
// a theme + one look item (lane gen) + one plain item (lane other)
const lookRoad = (extra = []) => foldRoadmap([
  ev(1, 'create', 'RM-1', { title: 'Theme', kind: 'theme' }), ev(2, 'create', 'RM-2', { title: 'Water look', kind: 'item', parent: 'RM-1', links: ['lane:gen'] }),
  ev(3, 'create', 'RM-3', { title: 'Plain', kind: 'item', parent: 'RM-1', links: ['lane:other'] }), ev(4, 'edit', 'RM-2', { proof: 'look', views: ['front', 'top'] }), ...extra]);
const image = (dir, name, mtimeMs) => { const f = path.join(dir, name); fs.writeFileSync(f, 'png'); fs.utimesSync(f, mtimeMs / 1000, mtimeMs / 1000); return f; };
const doneRun = (look, startMs = T0) => ({ id: 'RUN-5', kind: 'run', state: 'exited', created: iso(startMs - 1000), data: { lane: 'gen' },
  history: [{ ev: 'start', ts: iso(startMs) }, { ev: 'end', ts: iso(startMs + 3600e3), data: { outcome: 'done', ...(look ? { look } : {}) } }], end: { outcome: 'done', ...(look ? { look } : {}) } });

test('fold: --proof look + views live on the item; proof none clears both; the latest verdict wins', () => {
  const R = lookRoad([ev(5, 'verdict', 'RM-2', { verdict: 'fail', image: '/x/a.png' }, iso(T0 + 1)), ev(6, 'verdict', 'RM-2', { verdict: 'pass', image: '/x/b.png' }, iso(T0 + 2), 'owner')]);
  assert.deepEqual([R.items['RM-2'].proof, R.items['RM-2'].views], ['look', ['front', 'top']]);
  assert.deepEqual(R.items['RM-2'].verdict, { verdict: 'pass', image: '/x/b.png', by: 'owner', ts: iso(T0 + 2) });
  assert.deepEqual([R.items['RM-3'].proof, R.items['RM-3'].views, R.items['RM-3'].verdict], [null, [], null]);
  const C = lookRoad([ev(5, 'edit', 'RM-2', { proof: null })]);
  assert.deepEqual([C.items['RM-2'].proof, C.items['RM-2'].views], [null, []]);
});

test('the brief gate: a look item needs a Look: line in round >= 2 and every MERGE / INSTALL brief; the message names the line', () => {
  const R = lookRoad(), pol = lookPolicy({});
  assert.deepEqual(pol, { stages: ['MERGE', 'INSTALL'], min_round: 2 }, 'defaults in code');
  assert.equal(lookLine('# b\nLook: shots/before-after.png\n'), 'shots/before-after.png');
  assert.equal(lookLine('- Look: `a.png`\n'), 'a.png');
  assert.equal(lookLine('Look:\nScope: x\n'), null, 'an empty Look: line is missing');
  assert.deepEqual(lookItemsFor(R, { lane: 'gen' }).map(n => n.id), ['RM-2'], 'by the lane the item links');
  assert.deepEqual(lookItemsFor(R, { item: 'RM-2', lane: 'x' }).map(n => n.id), ['RM-2'], 'by --item');
  assert.deepEqual(lookItemsFor(R, { item: 'RM-3', lane: 'other' }), [], 'a plain item is not gated');
  const items = lookItemsFor(R, { lane: 'gen' }), noLook = 'Scope: a\nTests: b\nDone: c\n';
  const refuse = (o) => lookBriefRefusal({ items, text: noLook, brief: '/b/brief.md', policy: {}, ...o });
  assert.equal(refuse({ stage: 'S2', round: 1 }), null, 'round 1 of a build stage needs no picture');
  assert.equal(refuse({ stage: 'S2' }), null, 'no round = round 1');
  for (const o of [{ stage: 'S2', round: 2 }, { stage: 'S2', round: '3' }, { stage: 'MERGE' }, { stage: 'install-2' }, { stage: 'INSTALL' }]) {
    const m = refuse(o);
    assert.match(m, /brief \/b\/brief\.md lacks the Look: line/, JSON.stringify(o));
    assert.match(m, /RM-2 is a look item \(views front, top\)/);
  }
  assert.equal(lookBriefRefusal({ items, text: noLook + 'Look: s/sheet.png\n', brief: 'b', stage: 'MERGE', policy: {} }), null, 'a Look: line passes');
  assert.equal(lookBriefRefusal({ items: [], text: noLook, brief: 'b', stage: 'MERGE', policy: {} }), null, 'no look item: no gate');
  assert.equal(refuse({ stage: 'MERGE', policy: { look: { stages: ['DEPLOY'] } } }), null, 'the stages are project policy');
  assert.match(refuse({ stage: 'deploy', policy: { look: { stages: ['DEPLOY'] } } }), /lacks the Look: line/);
  assert.match(lookBriefRefusal({ items, text: null, brief: 'gone.md', stage: 'MERGE', policy: {} }), /lacks the Look: line/, 'an unreadable brief has no Look: line');
});

test('done proof: the DONE end names an existing image newer than the run start, else the end is unproven', () => {
  const d = mkTmp('meta-look-proof-');
  const fresh = image(d, 'after.png', T0 + 600e3), old = image(d, 'old.png', T0 - 600e3);
  assert.deepEqual(doneProof(doneRun(fresh)), { ok: true, image: fresh.replace(/\\/g, '/') });
  assert.match(doneProof(doneRun(null)).why, /RUN-5 ended done without a look image \(norn done --look <image>\)/);
  assert.match(doneProof(doneRun(path.join(d, 'nope.png'))).why, /RUN-5: look image .*nope\.png does not exist/);
  assert.match(doneProof(doneRun(old)).why, /RUN-5: look image .*old\.png is older than the run's start/);
  assert.match(doneProof(null).why, /no DONE run/);
  const stopped = { ...doneRun(fresh), end: { outcome: 'stopped' } };
  assert.match(doneProof(stopped).why, /RUN-5 ended stopped, not done/);
});

test('the merge-queue hold: unproven done, missing / stale / failed verdict hold the row; a pass verdict newer than the head lets it in', () => {
  const d = mkTmp('meta-look-hold-'), shot = image(d, 'after.png', T0 + 600e3), sheet = image(d, 'sheet.png', T0 + 700e3);
  const head = T0 + 3600e3;   // the deliverable's head commit time (ms)
  const row = { id: 'DLV-1', lane: 'gen', branch: 'feat/look', run: 'RUN-5' };
  const R0 = lookRoad();
  assert.deepEqual(rowLookItems(Object.values(R0.items), row).map(n => n.id), ['RM-2'], 'the item reaches the row by its lane');
  assert.deepEqual(rowLookItems(Object.values(R0.items), { ...row, lane: 'x' }), []);
  assert.deepEqual(rowLookItems(Object.values(lookRoad([ev(5, 'link', 'RM-2', { links: ['dlv:DLV-9'] })]).items), { id: 'DLV-9', lane: 'x' }).map(n => n.id), ['RM-2'], 'or by its DLV link');
  const hold = (R, run) => lookHold(row, { item: R.items['RM-2'], run, headMs: head });
  assert.match(hold(R0, doneRun(null)), /^RM-2 look: unproven done: RUN-5 ended done without a look image/);
  assert.match(hold(R0, doneRun(shot)), /^RM-2 look: no look verdict \(norn road verdict RM-2 pass\|fail --image <sheet>\)$/);
  const v = (verdict, ms, img = sheet) => lookRoad([ev(5, 'verdict', 'RM-2', { verdict, image: img }, iso(ms))]);
  assert.match(hold(v('pass', head - 1000), doneRun(shot)), /^RM-2 look: the verdict .* is older than the head of DLV-1/);
  assert.match(hold(v('pass', head + 400), doneRun(shot)), /older than the head/, 'the head time is whole seconds: newer = a later second');
  assert.match(hold(v('fail', head + 60e3), doneRun(shot)), /^RM-2 look: the latest verdict is fail/);
  assert.match(hold(v('pass', head + 60e3, path.join(d, 'gone.png')), doneRun(shot)), /verdict image .*gone\.png does not exist/);
  assert.match(lookHold(row, { item: v('pass', head + 60e3).items['RM-2'], run: doneRun(shot), headMs: null }), /head of DLV-1 has no commit time/);
  assert.equal(hold(v('pass', head + 60e3), doneRun(shot)), null, 'the pass path');
});

test('norn done --look stores the image (absolute) in result.json; readResult hands it on', () => {
  const d = mkTmp('meta-look-done-'), shot = image(d, 'a.png', Date.now());
  assert.equal(makeResult({ run: 'RUN-1', look: shot }).record.look, shot.replace(/\\/g, '/'));
  assert.throws(() => makeResult({ run: 'RUN-1', outcome: 'stopped', why: 'x', look: shot }), /--look is for --outcome done only/);
  writeResult(path.join(d, 'r'), { run: 'RUN-1', look: shot });
  assert.equal(readResult(path.join(d, 'r'), { run: 'RUN-1' }).look, shot.replace(/\\/g, '/'));
});

test('norn road edit --proof look --views / verdict / show: stored, refused when wrong, shown with the latest verdict', () => {
  const S = path.join(mkTmp('meta-look-road-'), 'state'), shot = image(mkTmp('meta-look-img-'), 'sheet.png', Date.now());
  const put = (e, data, id) => record(S, { kind: 'item', ev: e, id, by: 'controller', data }, { views: false });
  put('create', { title: 'Theme', kind: 'theme' }); put('create', { title: 'Water look', kind: 'item', parent: 'RM-1', links: [] });
  const road = (...a) => norn(['road', ...a, '--state', S, '--as', 'controller']);
  assert.equal(road('edit', 'RM-2', '--proof', 'look').code, 2, 'a look item names its views');
  let r = road('edit', 'RM-2', '--proof', 'look', '--views', 'front, top,far');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([loadRoadmap(S).items['RM-2'].proof, loadRoadmap(S).items['RM-2'].views], ['look', ['front', 'top', 'far']]);
  assert.equal(road('edit', 'RM-2', '--proof', 'picture').code, 2, 'only look | none');
  r = road('show', 'RM-2');
  assert.match(r.out, /proof: look; views front, top, far; verdict: none/);
  assert.equal(road('verdict', 'RM-2', 'maybe', '--image', shot).code, 2, 'pass | fail');
  assert.equal(road('verdict', 'RM-2', 'pass', '--image', shot + '.gone').code, 2, 'the image must exist');
  assert.equal(road('verdict', 'RM-2', 'pass').code, 2, 'the image is required');
  assert.equal(norn(['road', 'verdict', 'RM-2', 'pass', '--image', shot, '--state', S, '--as', 'worker']).code, 2, 'a worker records no verdict');
  r = road('verdict', 'RM-2', 'pass', '--image', shot);
  assert.equal(r.code, 0, r.err);
  assert.equal(loadRoadmap(S).items['RM-2'].verdict.image, shot.replace(/\\/g, '/'));
  assert.match(road('show', 'RM-2').out, /proof: look; views front, top, far; verdict: pass by controller \d{4}-\d\d-\d\dT\d\d:\d\d.*sheet\.png/);
  assert.equal(road('edit', 'RM-2', '--proof', 'none').code, 0);
  assert.deepEqual([loadRoadmap(S).items['RM-2'].proof, loadRoadmap(S).items['RM-2'].views], [null, []]);
  assert.doesNotMatch(road('show', 'RM-2').out, /proof:/);
  assert.equal(road('verdict', 'RM-2', 'pass', '--image', shot).code, 2, 'a verdict needs a look item');
});

test('norn run refuses (exit 6, nothing recorded) a round 2 / MERGE brief without a Look: line on a look item; passes it with one', () => {
  const t = mkTmp('meta-look-run-'), S = path.join(t, 'state'), wt = path.join(t, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  const put = (e, data, id) => record(S, { kind: 'item', ev: e, id, by: 'controller', data }, { views: false });
  put('create', { title: 'Theme', kind: 'theme' }); put('create', { title: 'Water look', kind: 'item', parent: 'RM-1', links: [] });
  put('edit', { proof: 'look', views: ['front'] }, 'RM-2');
  const bf = path.join(t, 'brief.md'); fs.writeFileSync(bf, 'Scope: a\nTests: b\nDone: c\n');
  const run = (...a) => norn(['run', '--executor', 'fake', '--state', S, '--locks', path.join(t, 'locks'), '--lane', 'gen', '--brief', bf, '--worktree', wt,
    '--notes', path.join(t, 'N.md'), '--no-tick', '--item', 'RM-2', ...a], { META_ROOT: t, HOME: t, USERPROFILE: t });
  for (const a of [['--round', '2'], ['--stage', 'MERGE']]) {
    const r = run(...a);
    assert.equal(r.code, 6, r.out + r.err);
    assert.match(r.out + r.err, /REFUSED: brief .*brief\.md lacks the Look: line/);
  }
  assert.ok(!Object.keys(loadState(S).items).some(k => /^RUN-/.test(k)), 'no run recorded');
});
