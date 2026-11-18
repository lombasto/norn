// META-UX-R1 addendum C: every run gets a stable, distinguishable human name, deterministic from its run id (never re-rolled),
// stored in the RUN record at launch (records lib = every launcher, any harness) and shown in agents / lanes / overview.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentName, runName, ADJECTIVES, NOUNS } from '../engine/lib/names.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { renderTab, loadTab } from '../engine/dash/ui.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { mkTmp } from './helpers/tmp.mjs';

test('agentName: deterministic, two words, unique for the first 3,904 runs, neighbours differ in both words', () => {
  assert.equal(new Set(ADJECTIVES).size, ADJECTIVES.length); assert.equal(new Set(NOUNS).size, NOUNS.length);
  assert.ok(!ADJECTIVES.some(a => NOUNS.includes(a)), 'no word in both lists');
  assert.equal(agentName('RUN-7'), agentName('RUN-7'));
  assert.match(agentName('RUN-1'), /^[a-z]+-[a-z]+$/);
  const all = Array.from({ length: ADJECTIVES.length * NOUNS.length - 1 }, (_, i) => agentName('RUN-' + (i + 1)));
  assert.equal(new Set(all).size, all.length, 'unique');
  for (let i = 1; i < 500; i++) { const [a1, n1] = agentName('RUN-' + i).split('-'), [a2, n2] = agentName('RUN-' + (i + 1)).split('-'); assert.ok(a1 !== a2 && n1 !== n2, `RUN-${i} vs RUN-${i + 1}`); }
  assert.match(agentName('RUN-' + (ADJECTIVES.length * NOUNS.length + 5)), /^[a-z]+-[a-z]+-2$/, 'past the table: a cycle suffix, still unique');
  assert.equal(agentName('not-a-run'), null);
});

test('the RUN start event stores the name at launch; older runs without one get the same derived name', () => {
  const dir = mkTmp('meta-names-');
  try {
    const r = record(dir, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'fake', executor: 'fake', lane: 'x' } });
    assert.equal(r.data.name, agentName(r.id));
    const stored = fs.readFileSync(path.join(dir, 'runs.jsonl'), 'utf8'); assert.ok(stored.includes(`"name":"${agentName(r.id)}"`), 'in the event log');
    const r2 = record(dir, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'fake', executor: 'fake', lane: 'x', name: 'chosen' } });
    assert.equal(r2.data.name, agentName(r2.id), 'derived from the id, never a caller choice');
    const it = loadState(dir).items[r.id]; assert.equal(runName(it), agentName(r.id));
    assert.equal(runName({ id: 'RUN-9', data: {} }), agentName('RUN-9'), 'legacy run: derived');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the dashboard shows run names: agents tree, lanes, overview running rows, inbox', async () => {
  const f = await fixture();
  try {
    const tree = (await f.get('/api/agents')).data.tree, n2 = tree.find(n => n.id === 'RUN-2');
    assert.equal(n2.name, agentName('RUN-2'));
    const lanes = (await f.get('/api/lanes')).data.lanes; assert.equal(lanes.find(l => l.name === 'render').run_name, agentName('RUN-2'));
    const get = async r => (await f.get(r)).data;
    for (const tab of ['runs', 'lanes', 'overview']) assert.ok(renderTab(tab, await loadTab(tab, 'kestrel', get), { project: 'kestrel' }).includes(agentName('RUN-2')), tab);
    assert.ok(renderTab('inbox', await loadTab('inbox', 'kestrel', get), { project: 'kestrel' }).includes(agentName('RUN-1')), 'inbox unreviewed run');
  } finally { await f.done(); }
});
