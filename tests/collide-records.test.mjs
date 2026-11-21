// lane-collide S1b: the collision record kind (COL-n in collide.jsonl; events open, action, undo, outcome) and the case verbs
// `norn collide list | show | allow | undo` - who may allow (SPEC 4A.3), what undo may reverse (an allow only), a worker applies nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkTmp } from './helpers/tmp.mjs';
import { record, RecordError } from '../engine/lib/records.mjs';
import { casesOf, actionsOf, rulingsOf, openCase, caseAction } from '../engine/lib/intents.mjs';

const NORN = path.join(import.meta.dirname, '..', 'engine', 'bin', 'norn.mjs');
function fixture() {
  const t = mkTmp('meta-crec-'), state = path.join(t, 'state', 'k');
  fs.mkdirSync(state, { recursive: true });
  const env = { ...process.env, META_ROOT: t, HOME: t, USERPROFILE: t, META_NO_TICK: '1', META_RUN_ID: '', META_ROLE: '' };
  const norn = (args, extra = {}) => spawnSync(process.execPath, [NORN, 'collide', ...args, '--state', state], { encoding: 'utf8', windowsHide: true, env: { ...env, ...extra } });
  // a held case as the door opens it: territory / exclusive, web-nav ahead of web-runs, one hold action
  const hit = { kind: 'territory', grade: 'exclusive', verdict: 'hold', other: 'web-nav', files: ['web/nav.mjs'], why: 'Exclusive: web/** of lane web-nav meets this run\'s Scope web/pages/**', pick: { remedy: 'wait', args: { lane: 'web-nav' }, why: 'a move cannot be merged by hand cheaply' } };
  const held = () => { const id = openCase(state, hit, { lane: 'web-runs', state: 'queued', run: 'RUN-9' }, { lane: 'web-nav', state: 'unlanded', dlv: 'DLV-3' }, { door: 'run' }); caseAction(state, id, 'hold', { args: { run: 'RUN-9' }, why: hit.why }); return id; };
  return { t, state, norn, held, hit };
}

test('the kind: COL-n in collide.jsonl; open reuses the open case of the same key; bad actions and undos are refused', () => {
  const f = fixture();
  const id = f.held();
  assert.equal(id, 'COL-1');
  assert.ok(fs.readFileSync(path.join(f.state, 'collide.jsonl'), 'utf8').includes('"COL-1"'));
  assert.equal(openCase(f.state, f.hit, { lane: 'web-runs' }, null, { door: 'fill' }), 'COL-1', 'one case per key while it is open');
  const c = casesOf(f.state)['COL-1'];
  assert.deepEqual([c.state, c.data.key, c.data.pair, c.data.a.lane, c.data.b.lane, c.data.files_n], ['open', 'territory/exclusive:web-nav>web-runs', 'web-nav+web-runs', 'web-nav', 'web-runs', 1]);
  assert.throws(() => caseAction(f.state, id, 'fold'), RecordError, 'S1b records hold, after, told, released, allow');
  assert.throws(() => record(f.state, { kind: 'collision', ev: 'undo', id, by: 'controller', data: { action: 0, why: 'x' } }), /undo: action must name an action/);
  assert.throws(() => record(f.state, { kind: 'collision', ev: 'open', by: 'launcher', data: { key: 'k', kind: 'nope', why: 'w', a: { lane: 'a' }, b: { lane: 'b' }, files: [] } }), RecordError);
  record(f.state, { kind: 'collision', ev: 'outcome', id, by: 'tick', data: { closed_at: new Date().toISOString(), cause: 'merged' } });
  assert.equal(casesOf(f.state)[id].state, 'closed');
  assert.equal(openCase(f.state, f.hit, { lane: 'web-runs' }, null, { door: 'fill' }), 'COL-2', 'a closed case is history: the same cause again opens a new one');
});

test('list and show: the open cases with their actions; --json carries the record', () => {
  const f = fixture();
  f.held();
  const l = f.norn(['list']);
  assert.equal(l.status, 0, l.stderr);
  assert.equal(l.stdout.trim(), 'COL-1 open territory (exclusive) hold web-nav > web-runs door run - hold');
  const s = f.norn(['show', 'COL-1']);
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /^ {2}Exclusive: web\/\*\* of lane web-nav/m);
  assert.match(s.stdout, /^ {2}SloppaChoppa: wait \(a move cannot be merged by hand cheaply\)$/m);
  assert.match(s.stdout, /^ {2}1\. \S+ hold by launcher \(auto\) \{"run":"RUN-9"\}/m);
  assert.deepEqual(JSON.parse(f.norn(['show', 'COL-1', '--json']).stdout).actions.map(a => a.action), ['hold']);
  assert.equal(f.norn(['show', 'COL-7']).status, 2);
});

test('allow: SPEC 4A.3 decides the role; the pair ruling is an allow action; undo withdraws it, a hold has no undo', () => {
  const f = fixture();
  f.held();
  const worker = f.norn(['allow', 'COL-1', '--as', 'controller', '--why', 'w'], { META_RUN_ID: 'RUN-5', META_ROLE: 'worker' });
  assert.equal(worker.status, 3);
  assert.match(worker.stderr, /a worker run applies no remedy/);
  assert.equal(f.norn(['allow', 'COL-1', '--as', 'controller']).status, 2, '--why is required');
  const ck = f.norn(['allow', 'COL-1', '--as', 'checkin', '--why', 'w']);
  assert.equal(ck.status, 3);
  assert.match(ck.stderr, /an allow past territory \(exclusive\) is the controller's/);
  const hold = f.norn(['undo', 'COL-1', '--as', 'controller', '--why', 'w']);
  assert.equal(hold.status, 3);
  assert.match(hold.stderr, /\(hold\) has no undo: a hold ends by itself when the holder lands, or by norn collide allow/);
  const ok = f.norn(['allow', 'COL-1', '--as', 'controller', '--why', 'the restructure leaves pages alone']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^COL-1: allow web-nav\+web-runs for territory/);
  assert.deepEqual(Object.keys(rulingsOf(casesOf(f.state))), ['web-nav+web-runs']);
  const un = f.norn(['undo', 'COL-1', '--as', 'controller', '--why', 'it moves pages after all']);
  assert.equal(un.status, 0, un.stderr);
  assert.deepEqual(rulingsOf(casesOf(f.state)), {});
  assert.deepEqual(actionsOf(casesOf(f.state)['COL-1']).map(a => [a.action, a.undone]), [['hold', false], ['allow', true]]);
  assert.equal(f.norn(['undo', 'COL-1', '--action', '2', '--as', 'controller', '--why', 'w']).status, 3, 'already undone');
});

test('allow <a> <b>: a ruling on a pair with no case opens one (kind any); a check-in may allow only its own column', () => {
  const f = fixture();
  const ck = f.norn(['allow', 'lib-a', 'lib-b', '--as', 'checkin', '--why', 'w']);
  assert.equal(ck.status, 3, 'every kind includes item: the controller\'s');
  const ord = f.norn(['allow', 'lib-a', 'lib-b', '--kind', 'order', '--as', 'checkin', '--why', 'stacked on purpose']);
  assert.equal(ord.status, 0, ord.stderr);
  const c = casesOf(f.state)['COL-1'];
  assert.deepEqual([c.data.kind, c.data.key, c.data.door], ['any', 'ruling:lib-a+lib-b', 'cli']);
  assert.deepEqual(rulingsOf(casesOf(f.state))['lib-a+lib-b'].kinds, ['order']);
  const all = f.norn(['allow', 'lib-b', 'lib-a', '--as', 'controller', '--why', 'one feature']);
  assert.equal(all.status, 0, all.stderr);
  assert.equal(Object.keys(casesOf(f.state)).length, 1, 'the open ruling case of the pair takes the second allow');
  assert.deepEqual(rulingsOf(casesOf(f.state))['lib-a+lib-b'].kinds, [], 'every kind');
});
