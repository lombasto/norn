// Gap #5: a directive that restates an ACTIVE one. Refused when it is written (CLI exit 3, dashboard 409, chat tool error) unless
// --new / new: true; an existing pair is a digest row ("possible duplicate directives: DIR-a ~ DIR-b") the check-in folds.
// The thresholds are pinned on the two real pairs that stayed active on a live project, and on unrelated directives.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dupMatch, dupOf, dupPairs, dupMessage, wordsOf } from '../engine/lib/dupdirs.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { digest } from '../engine/lib/digest.mjs';
import { renderDigest } from '../engine/lib/views.mjs';
import { handle, context } from '../engine/lib/mcp.mjs';
import { threadFile } from '../engine/lib/chatact.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const REAL = {
  'DIR-2': 'Offline priority while real-cluster work waits for the owner: input-file reader gaps first (RM-12: plasticity/TB, solver choice EQSLV/PCG, NEQIT, OUTRES).',
  'DIR-6': 'RM-12: read more of what the input file asks for - plasticity/TB, solver choice (EQSLV/PCG), NEQIT, OUTRES. Parse them in the input-file reader with tests',
  'DIR-4': "Regenerate tests_shots now; do not wait for the owner's look at the redesigned window (RM-22).",
  'DIR-7': "Regenerate tests_shots for the redesigned window now (DIR-4); do not wait for the owner's look (RM-22). Keep the shot tests green.",
};
const UNRELATED = [
  'Stop dispatching codex until the weekly cap resets; claude workers only.',
  'Add contact detection to the mesh importer (RM-12) with tests.',
  'Write the README section for the input-file reader install steps.',
  'Keep the dashboard quiet at night: no notifications between 22:00 and 07:00.',
  'Merge DLV-4 after the owner reviews the screenshots of the new window.',
  "Use the cluster's PCG solver for every long run; never the sparse direct solver on the login node.",
];
const dirs = texts => Object.fromEntries(Object.entries(texts).map(([id, text]) => [id, { id, kind: 'directive', state: 'active', data: { text }, history: [] }]));

test('the two real pairs match; every unrelated pair (and each unrelated text against the real ones) does not', () => {
  assert.match(dupMatch(REAL['DIR-6'], { id: 'DIR-2', text: REAL['DIR-2'] }).why, /same roadmap item RM-12/);
  assert.match(dupMatch(REAL['DIR-7'], { id: 'DIR-4', text: REAL['DIR-4'] }).why, /names DIR-4/);
  assert.equal(dupMatch(REAL['DIR-6'], { id: 'DIR-4', text: REAL['DIR-4'] }), null, 'the two subjects are not one');
  assert.equal(dupMatch(REAL['DIR-7'], { id: 'DIR-2', text: REAL['DIR-2'] }), null);
  const all = [...UNRELATED, ...Object.values(REAL)];
  for (const a of UNRELATED) for (const b of all) if (a !== b) {
    assert.equal(dupMatch(a, { id: 'DIR-99', text: b }), null, `${a} ~ ${b}`);
    assert.equal(dupMatch(b, { id: 'DIR-99', text: a }), null, `${b} ~ ${a}`);
  }
  assert.equal(dupMatch('cap 2', { id: 'DIR-1', text: 'cap 4' }), null, 'a one-word restatement is below the shared-word floor');
  assert.deepEqual([...wordsOf('Parse the input-file (RM-12) DIR-3')].sort(), ['file', 'input', 'parse']);
});

test('dupOf picks the active directive it restates; never a done / superseded one or a Fix all directive (Norn\'s own)', () => {
  const items = dirs({ 'DIR-2': REAL['DIR-2'], 'DIR-4': REAL['DIR-4'] });
  const d = dupOf(items, REAL['DIR-6']);
  assert.equal(d.id, 'DIR-2'); assert.equal(d.line, REAL['DIR-2']);
  assert.match(dupMessage(d), /^looks like a duplicate of DIR-2: Offline priority .*; update DIR-2 instead .*norn rec supersede DIR-2 --by .*or pass --new to create anyway$/);
  assert.equal(dupOf(items, UNRELATED[0]), null);
  items['DIR-2'].state = 'done';
  assert.equal(dupOf(items, REAL['DIR-6']), null, 'a done directive binds nothing');
  items['DIR-4'].data.fixall = 'DEC-9';
  assert.equal(dupOf(items, REAL['DIR-7']), null, 'a Fix all directive is the engine\'s');
});

test('dupPairs: oldest pair first; a pair the owner kept with --new (distinct_from) is not a row', () => {
  const items = dirs(REAL);
  assert.deepEqual(dupPairs(items).map(r => r.id), ['DIR-2~DIR-6', 'DIR-4~DIR-7']);
  items['DIR-7'].data.distinct_from = ['DIR-4'];
  assert.deepEqual(dupPairs(items).map(r => r.id), ['DIR-2~DIR-6']);
});

const cli = (state, ...args) => {
  const env = { ...process.env, META_STATE: state, META_ROLE: 'owner' };
  delete env.META_RUN_ID; delete env.META_PROJECT;
  const r = spawnSync(process.execPath, [META, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
const addDir = (s, text, ...more) => cli(s, 'rec', 'add', 'directive', '--text', text, '--via', 'chat', ...more);

test('CLI: a restatement is refused (exit 3, names the DIR and the way out); --new creates it and records distinct_from', () => {
  const s = mkTmp('meta-dupdir-');
  assert.equal(addDir(s, REAL['DIR-2']).out, 'DIR-1');
  assert.equal(addDir(s, REAL['DIR-4']).out, 'DIR-2');
  const r = addDir(s, REAL['DIR-6']);
  assert.equal(r.code, 3, r.err);
  assert.match(r.err, /looks like a duplicate of DIR-1: Offline priority while real-cluster work waits for the owner: .*update DIR-1 instead.*or pass --new to create anyway/);
  assert.equal(Object.keys(loadState(s).items).length, 2, 'nothing written');
  const n = addDir(s, REAL['DIR-6'], '--new');
  assert.equal(n.code, 0, n.err); assert.equal(n.out, 'DIR-3');
  assert.deepEqual(loadState(s).items['DIR-3'].data.distinct_from, ['DIR-1']);
  assert.equal(addDir(s, UNRELATED[0]).code, 0, 'an unrelated directive passes');
  // the way out the message names: supersede the old one by the new wording
  assert.equal(cli(s, 'rec', 'supersede', 'DIR-1', '--by', 'DIR-3', '--why', 'restated').code, 0);
  assert.equal(loadState(s).items['DIR-1'].state, 'superseded');
  assert.match(addDir(s, REAL['DIR-2']).err, /duplicate of DIR-3:/, 'only active directives count: the old wording now matches the new one, not DIR-1');
});

test('digest: existing duplicates are a row "possible duplicate directives: DIR-a ~ DIR-b"; it leaves when the check-in folds them', () => {
  const s = mkTmp('meta-dupdir-dg-');
  const T0 = Date.parse('2026-11-09T00:00:00Z'), now = () => new Date(T0);
  // written before the guard (or around it): record() itself never refuses, the surfaces do
  for (const id of ['DIR-2', 'DIR-4', 'DIR-6', 'DIR-7']) record(s, { kind: 'directive', ev: 'create', by: 'owner', data: { text: REAL[id], via: 'chat' } }, { now, run: null });
  record(s, { kind: 'directive', ev: 'create', by: 'dashboard', data: { text: REAL['DIR-2'], via: 'dashboard', findings: ['x'], fixall: 'DEC-1' } }, { now, run: null });
  const dg = () => digest(s, {}, { now: T0 + 3600e3, git: () => null, dlv: [], evalAfter: () => ({ met: null, gone: false }), ready: [] });
  const d = dg();
  assert.deepEqual(d.sections.dupdirs.map(r => r.id), ['DIR-1~DIR-3', 'DIR-2~DIR-4'], 'the Fix all directive (DIR-5) is never paired');
  const md = renderDigest(d);
  assert.match(md, /## 12 Possible duplicate directives \(2\)\n- possible duplicate directives: DIR-1 ~ DIR-3 \(same roadmap item RM-12.*META rec supersede DIR-1 --by DIR-3/);
  assert.match(md, /- possible duplicate directives: DIR-2 ~ DIR-4 \(same roadmap item RM-22/);
  record(s, { kind: 'directive', ev: 'supersede', id: 'DIR-1', by: 'checkin', data: { by: 'DIR-3', why: 'restated by DIR-3' } }, { now, run: null });
  assert.deepEqual(dg().sections.dupdirs.map(r => r.id), ['DIR-2~DIR-4']);
  record(s, { kind: 'directive', ev: 'supersede', id: 'DIR-2', by: 'checkin', data: { by: 'DIR-4', why: 'restated by DIR-4' } }, { now, run: null });
  assert.equal(dg().sections.dupdirs, undefined, 'no pair: no section');
});

test('CHECKIN.md tells the check-in to fold the row and never to restate an active directive', () => {
  const md = fs.readFileSync(path.join(path.dirname(META), '..', 'prompts', 'CHECKIN.md'), 'utf8');
  assert.match(md, /possible duplicate directives: DIR-a ~ DIR-b/);
  assert.match(md, /META rec supersede DIR-a --by DIR-b/);
  assert.match(md, /Never create \(or ask for\) a directive that restates an active one/);
});

test('dashboard POST /api/directive: a restatement is 409 with the message; new: true creates it; Norn\'s Fix all directive is never checked', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post('/api/directive', { text: REAL['DIR-4'] })).status, 200);
    const r = await f.post('/api/directive', { text: REAL['DIR-7'] });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /looks like a duplicate of DIR-\d+: Regenerate tests_shots now.*pass new: true to create anyway/);
    const ok = await f.post('/api/directive', { text: REAL['DIR-7'], new: true });
    assert.equal(ok.status, 200);
    const it = loadState(f.pa.state).items[ok.data.id];
    assert.equal(it.data.distinct_from.length, 1);
  } finally { await f.done(); }
});

test('chat norn_directive: a restatement is a tool error naming the DIR; new: true records it', async () => {
  const s = mkTmp('meta-dupdir-mcp-');
  fs.mkdirSync(path.dirname(threadFile(s)), { recursive: true });
  for (const text of [REAL['DIR-2'], REAL['DIR-6']]) fs.appendFileSync(threadFile(s), JSON.stringify({ ts: new Date().toISOString(), seg: 1, kind: 'owner', text }) + '\n');
  const ctx = context({ state: s, project: null, profile: 'chat', client: 'chat', env: {}, cli: () => 0, approvalMs: 60000, pollMs: 10, notifyFn: () => {} });
  let n = 0;
  const call = async a => (await handle({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name: 'norn_directive', arguments: a } }, ctx)).result;
  const txt = r => r.content.map(c => c.text).join('\n');
  assert.ok(!(await call({ text: REAL['DIR-2'] })).isError);
  const dup = await call({ text: REAL['DIR-6'] });
  assert.ok(dup.isError); assert.match(txt(dup), /looks like a duplicate of DIR-1: .*pass new: true to create anyway/);
  const ok = await call({ text: REAL['DIR-6'], new: true });
  assert.ok(!ok.isError, txt(ok));
  assert.deepEqual(loadState(s).items['DIR-2'].data.distinct_from, ['DIR-1']);
});
