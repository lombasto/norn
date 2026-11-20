// issue #87: the generated roadmap view follows a linked run's state change (start / end / requeue / kill) - a run that ended never
// reads "live" in the file - and `norn run --item RM-n` checks that the run's lane belongs to the item (warn + why, or refuse
// without --why when another lane is linked). Synthetic records only; temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { record, loadState } from '../engine/lib/records.mjs';
import { loadRoadmap, refreshRoadView, roadmapViewPath } from '../engine/lib/roadmap.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const meta = args => {
  const r = spawnSync(process.execPath, [META, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, META_ROLE: '', META_PROJECT: '', META_STATE: '', META_NO_TICK: '1' } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
const item = (S, ev, data, id) => record(S, { kind: 'item', ev, id, by: 'controller', data }, { views: false });
const start = (S, lane) => record(S, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane, stage: 'S1' } }, { views: false }).id;
const end = (S, id) => record(S, { kind: 'run', ev: 'end', id, by: 'launcher', data: { exit: 0, outcome: 'handoff' } }, { views: false });

test('refreshRoadView: a linked run that ends re-renders the view (no longer live); no change or an unlinked run renders nothing', () => {
  const s = mkTmp('meta-rmfresh-'), view = roadmapViewPath(s);
  assert.equal(refreshRoadView(s), 'fresh', 'no roadmap: nothing to render');
  assert.equal(fs.existsSync(view), false);
  const r1 = start(s, 'alpha'), r2 = start(s, 'beta');
  const th = item(s, 'create', { title: 'Theme', kind: 'theme' }).id;
  item(s, 'create', { title: 'Alpha work', kind: 'item', parent: th, links: ['lane:alpha', 'run:' + r1], stages: ['S1 a', 'S2 b'] });
  assert.equal(refreshRoadView(s), 'written');
  assert.match(fs.readFileSync(view, 'utf8'), new RegExp(`live: ${r1}`), 'the linked run reads live while it runs');
  assert.equal(refreshRoadView(s), 'fresh', 'nothing changed: no render');
  end(s, r2);
  assert.equal(refreshRoadView(s), 'fresh', 'an unlinked run ended: no render');
  end(s, r1);
  assert.equal(refreshRoadView(s), 'written', 'the linked run ended: the view is rendered again');
  assert.doesNotMatch(fs.readFileSync(view, 'utf8'), new RegExp(`run live|live: ${r1}`), 'an ended run never reads live');
  assert.equal(refreshRoadView(s), 'fresh');
});

const sandbox = () => {
  const t = mkTmp('meta-rmfresh-cli-'), state = path.join(t, 'state', 'demo'), locks = path.join(t, 'state', 'locks'), wt = path.join(t, 'wt');
  for (const d of [state, locks, wt]) fs.mkdirSync(d, { recursive: true });
  const brief = path.join(t, 'brief.md'); fs.writeFileSync(brief, 'mode: done\n');
  const th = item(state, 'create', { title: 'Core', kind: 'theme' }).id;
  const look = item(state, 'create', { title: 'Look work', kind: 'item', parent: th }).id, bare = item(state, 'create', { title: 'Bare', kind: 'item', parent: th }).id;
  record(state, { kind: 'lane', ev: 'create', by: 'controller', data: { name: 'looks' } }, { views: false });
  item(state, 'link', { links: ['lane:looks'] }, look);
  const dir = record(state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'go', via: 'chat' } }, { views: false }).id;
  const run = (lane, id, ...more) => meta(['run', '--executor', 'fake', '--lane', lane, '--brief', brief, '--worktree', wt, '--locks', locks, '--after', `dir:${dir}`, '--state', state, '--item', id, ...more]);
  return { state, look, bare, run };
};
const runs = S => Object.values(loadState(S).items).filter(i => i.kind === 'run').length;
const lastLink = (S, id) => loadRoadmap(S).items[id].history.at(-1);

test('norn run --item: another lane linked to the item refuses without --why (no run); with --why it warns and records the why', () => {
  const d = sandbox(), before = runs(d.state);
  let o = d.run('perf', d.look);
  assert.equal(o.code, 2, o.out + o.err);
  assert.match(o.err, /lane perf is not linked to RM-2.*looks.*--why/);
  assert.equal(runs(d.state), before, 'a refused --item records no run');
  o = d.run('perf', d.look, '--why', 'the perf pass measures the look item');
  assert.equal(o.code, 0, o.err);
  assert.match(o.err, /warning: lane perf is not linked to RM-2/);
  const id = /QUEUED (RUN-\d+)/.exec(o.out)[1];
  assert.deepEqual(lastLink(d.state, d.look).data, { links: ['run:' + id], why: 'the perf pass measures the look item' });
  assert.ok(fs.existsSync(roadmapViewPath(d.state)), 'the link re-renders the view');
  o = d.run('looks', d.look);
  assert.equal(o.code, 0, o.err);
  assert.doesNotMatch(o.err, /warning/, 'the linked lane: no warning');
  assert.equal(lastLink(d.state, d.look).data.why, undefined);
});

test('norn run --item: an item with no lane linked warns and records a why; a later run of that lane is quiet', () => {
  const d = sandbox();
  let o = d.run('w', d.bare);
  assert.equal(o.code, 0, o.err);
  assert.match(o.err, /warning: lane w is not linked to RM-3/);
  assert.match(lastLink(d.state, d.bare).data.why, /lane w/);
  o = d.run('w', d.bare);
  assert.equal(o.code, 0, o.err);
  assert.doesNotMatch(o.err, /warning/, 'an earlier run of lane w is linked: quiet');
  assert.equal(lastLink(d.state, d.bare).data.why, undefined);
});
