// collide-why: every why collide.mjs builds stays under the record limit (records.mjs validates a collision action's why at max 600).
// A queued run whose Scope covered many files of stale lanes once made the hold's why 616 chars and every tick threw. Made-up lanes
// (hemline-a, hemline-b) with ~60 long synthetic paths: each grade's why names the first few items and "+N more", and the hold is
// recorded through the real record path (openCase + caseAction via runs.mjs noteCollideHeld).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp } from './helpers/tmp.mjs';
import { collisions, whyOf, WHY_MAX } from '../engine/lib/collide.mjs';
import { casesOf, actionsOf } from '../engine/lib/intents.mjs';
import { noteCollideHeld } from '../engine/lib/runs.mjs';

const FILES = Array.from({ length: 60 }, (_, i) => `hemline/src/weave/a-rather-long-module-name-for-the-hem-${String(i).padStart(2, '0')}.mjs`);
const GLOBS = Array.from({ length: 60 }, (_, i) => `hemline/src/weave/part-${String(i).padStart(2, '0')}/**`);
const PARTS = FILES.map((f, i) => f.replace('weave/', `weave/part-${String(i).padStart(2, '0')}/`));
const RM = Array.from({ length: 60 }, (_, i) => `RM-${100 + i}`);
const me = x => ({ lane: 'hemline-b', run: 'RUN-9', state: 'queued', since: 2, role: 'work', scope: ['hemline/**'], touched: [], ...x });
const o = x => ({ lane: 'hemline-a', run: 'RUN-1', state: 'running', since: 1, role: 'work', scope: ['hemline/**'], touched: [], ...x });
const hold = { kinds: { item: 'hold', territory: 'hold', exclusive: 'hold' } };
const one = (a, b, ctx = {}) => { const h = collisions(a, [b], { policy: hold, now: 3, ...ctx }); assert.equal(h.length, 1, JSON.stringify(h)); return h[0]; };
// the first items within a list's room, the rest counted: each list shows at least one item and "+N more" for the ones not shown
const capped = (why, ...lists) => {
  assert.ok(why.length <= WHY_MAX, `why is ${why.length} chars: ${why}`);
  for (const L of lists) { const k = L.filter(x => why.includes(x)).length; assert.ok(k >= 1 && why.includes(`+${L.length - k} more`), why); }
};

test('each grade with ~60 items names the first few and "+N more", under the record limit', () => {
  capped(one(me({ touched: FILES }), o({ touched: FILES })).why, FILES);   // same-files
  capped(one(me({ scope: GLOBS }), o({ scope: ['x/**'], touched: PARTS })).why, GLOBS, PARTS);   // covers (my Scope list)
  capped(one(me({ scope: ['x/**'], touched: FILES }), o({ scope: GLOBS.map(g => g.replace('part-', 'z')), exclusive: ['hemline/**'] })).why, FILES);   // exclusive, changed files
  capped(one(me({ scope: GLOBS }), o({ exclusive: GLOBS })).why, GLOBS);   // exclusive, Scope
  capped(one(me({ tip: 'a1', touched: ['q.mjs'] }), o({ tip: 'b2', touched: ['r.mjs'], scope: ['q/**'] }), { conflicts: { 'a1 b2': { conflict: true, files: FILES } } }).why, FILES);   // conflict
  const sc = one(me({ scope: GLOBS }), o({ scope: GLOBS }), { tracked: PARTS });
  assert.equal(sc.grade, 'scopes'); capped(sc.why, GLOBS); assert.match(sc.why, /share 60 tracked files/);
  capped(one(me({ items: RM }), o({ items: RM })).why, RM);   // item
  capped(whyOf({ kind: 'scope', home: 'b', lane: 'hemline-a', what: FILES, noScope: true }), FILES);
});

test('a 60-file collision records its hold through the real record path (the tick no longer throws)', () => {
  const t = mkTmp('meta-cwhy-'), state = path.join(t, 'state', 'k');
  fs.mkdirSync(state, { recursive: true });
  const a = me({ scope: GLOBS }), b = o({ scope: ['x/**'], touched: PARTS }), h = one(a, b);   // the trigger's shape: a wide Scope covers many files
  assert.equal(h.verdict, 'hold');
  const n = noteCollideHeld(state, 'RUN-9', { held: [h], me: a, g: { intents: [b] }, cases: casesOf(state) }, { door: 'fill' });
  assert.deepEqual(n.holders, ['hemline-a']);
  const acts = actionsOf(casesOf(state)[n.cols[0]]);
  assert.equal(acts.at(-1).action, 'hold'); assert.equal(acts.at(-1).why, h.why);
});
