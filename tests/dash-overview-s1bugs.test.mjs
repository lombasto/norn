// VISUAL-B S1 bugs (controller, shots-s1/norn-s1-overview-dark.png): (1) the Running card header counted running workers the
// table never listed (a worker whose lane has no LANE record); (2) Burn showed the budget's reset key (a past reset), not the next one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { record } from '../engine/lib/records.mjs';
import { fixture } from './helpers/dash-fixture.mjs';

test('the Running card lists every run its header counts (a worker with no LANE record too)', async () => {
  const f = await fixture();
  try {
    const S = f.pa.state;
    const { id } = record(S, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'nolane', log: path.join(S, 'logs', 'seabed.log') } });
    fs.writeFileSync(path.join(S, 'hb', `${id}.hb`), '{}');
    const o = (await f.get('/api/overview')).data, runs = o.running.lanes.map(l => l.run);
    assert.ok(o.running.claude.n >= 1, 'the running worker is counted');
    assert.equal(o.running.lanes.length, o.running.claude.n + o.running.codex.n + o.running.merge.n, 'one row per counted run (merge-slot: the merges apart)');
    assert.ok(runs.includes(id), 'the worker without a LANE record has a row');
    assert.equal(o.running.lanes.find(l => l.run === id).name, 'nolane');
    assert.equal(o.running.lanes.find(l => l.name === 'render')?.run, 'RUN-2', 'a lane row keeps its LANE fields');
  } finally { await f.done(); }
});

test('Burn shows the NEXT weekly reset (the budget key rolled forward past now)', async () => {
  const f = await fixture();
  try {
    const u = (await f.get('/api/overview')).data.burn.usage, t = Date.parse(u.resetAt), now = Date.now();
    assert.ok(t > now, `reset ${u.resetAt} is in the future`);
    assert.ok(t - now <= 7 * 86400000, 'within one week');
    assert.equal(new Date(t).getUTCDay(), new Date(Date.parse('2026-11-04T08:00')).getUTCDay(), 'same weekday as the key');
  } finally { await f.done(); }
});
