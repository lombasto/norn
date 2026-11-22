// lane-collide S1a: the pure collision model (engine/lib/collide.mjs) on synthetic intents - the SPEC's incidents re-told with made-up
// lane and item names, and their near-misses. No git, no files: the judge is pure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { collisions, recommend, readScope, staleCaveats, dead, ahead, hitLines, UNREADABLE } from '../engine/lib/collide.mjs';
import { parseReady } from '../engine/lib/ready.mjs';

const I = (lane, o = {}) => ({ lane, run: null, stage: 'S1', state: 'running', since: 0, role: 'work', items: [], part_of: null, scope: null, exclusive: [],
  touched: [], commits: 0, branch: `norn/${lane}`, tip: null, dlv: null, stacked_on: [], names: {}, tests: null, done: null, brief: `/briefs/${lane}.md`, ...o });
const kinds = hs => hs.map(h => `${h.kind}${h.grade ? '/' + h.grade : ''}:${h.verdict}:${h.pick?.remedy}`);

test('parseReady reads the Exclusive: line (optional; the Ready gate does not ask for it)', () => {
  const r = parseReady('# b\nScope: web/**\nExclusive: web/app.mjs, `web/pages/**`\nTests: t\nDone: d\n');
  assert.deepEqual(r.exclusive, ['web/app.mjs', 'web/pages/**']);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(parseReady('Scope: a/**\nTests: t\nDone: d\n').exclusive, []);
});

test('readScope: path tokens are the Scope; `none` first claims nothing; prose or no line is not readable', () => {
  assert.deepEqual(readScope(['web/**', 'tests/web.test.mjs']).scope, ['web/**', 'tests/web.test.mjs']);
  assert.deepEqual(readScope(parseReady('Scope: none (a review; no code)').scope).scope, []);
  const prose = readScope(parseReady('Scope: the files PLAN.md gives NAV (web/** at most), tests/**').scope);
  assert.equal(prose.scope, null);
  assert.match(prose.why, /prose/);
  assert.equal(readScope([]).scope, null);
  assert.match(UNREADABLE, /changed files only/);
});

test('first come: running and unlanded work is ahead of queued and new runs; two queued runs by queue time; two running: neither', () => {
  assert.equal(ahead(I('a'), I('b', { state: 'queued' })), true);
  assert.equal(ahead(I('a', { state: 'unlanded' }), I('b', { state: 'new' })), true);
  assert.equal(ahead(I('a', { state: 'queued', since: 1 }), I('b', { state: 'queued', since: 2 })), true);
  assert.equal(ahead(I('a'), I('b')), false);
  assert.equal(ahead(I('b'), I('a')), false);
});

test('incident 1 (one item, many lanes): a second work lane on RM-7 while lane brook holds it -> item, warn; pick fold (no commits) / wait (commits) / part (apart)', () => {
  const brook = I('brook', { run: 'RUN-11', items: ['RM-7'], touched: ['game/brook/flow.py'], commits: 3 });
  const me = I('brook-shape', { state: 'new', items: ['RM-7'], scope: ['game/brook/**'] });
  assert.deepEqual(kinds(collisions(me, [brook])), ['item:warn:fold', 'territory/covers:warn:narrow'], 'its Scope also covers what brook changed');
  assert.deepEqual(kinds(collisions({ ...me, scope: null }, [brook])), ['item:warn:fold'], 'an unreadable Scope cannot be a part');
  assert.equal(collisions({ ...me, commits: 2 }, [brook])[0].pick.remedy, 'wait');
  const apart = collisions({ ...me, scope: ['game/banks/**'] }, [brook]);
  assert.deepEqual(kinds(apart), ['item:warn:part']);
  assert.deepEqual(apart[0].pick.args, { of: 'brook' });
  const lines = hitLines(collisions(me, [brook])[0], me);
  assert.match(lines[0], /^collide: item, warn - lane brook\. RM-7: lane brook holds it \(RUN-11 running\)/);
  assert.match(lines[1], /SloppaChoppa: fold +continue on lane brook: norn run --lane brook --stage S1 --brief \/briefs\/brook-shape\.md/);
});

test('item near-misses: a declared part, a MERGE stage, a review, a helper; the same lane never collides with itself', () => {
  const brook = I('brook', { items: ['RM-7'], touched: ['game/brook/flow.py'] });
  assert.deepEqual(collisions(I('x', { state: 'new', items: ['RM-7'], part_of: 'brook' }), [brook]), []);
  assert.deepEqual(collisions(I('x', { state: 'new', items: ['RM-7'], role: 'landing', stage: 'MERGE' }), [brook]), []);
  assert.deepEqual(collisions(I('x', { state: 'new', items: ['RM-7'], role: 'review' }), [brook]), []);
  assert.deepEqual(collisions(I('x', { state: 'new', items: ['RM-7'], role: 'helper', scope: ['game/brook/**'] }), [brook]), []);
  assert.deepEqual(collisions(I('brook', { state: 'new', items: ['RM-7'], scope: ['game/brook/**'] }), [brook]), []);
});

test('incident 2/3 (a restructure): Exclusive: of a running lane meets my Scope -> territory/exclusive, hold; pick wait; two running lanes only warn', () => {
  const nav = I('web-nav', { run: 'RUN-20', scope: ['web/**'], exclusive: ['web/app.mjs', 'web/pages/**'], touched: ['web/app.mjs'] });
  const me = I('web-cap', { state: 'new', scope: ['web/pages/board.mjs', 'web/css/board.css'] });
  const [h] = collisions(me, [nav]);
  assert.deepEqual(kinds([h]), ['territory/exclusive:hold:wait']);
  assert.match(h.why, /Exclusive: web\/app\.mjs web\/pages\/\*\* of lane web-nav meets this run's Scope web\/pages\/board\.mjs/);
  assert.equal(h.pick.args.after, 'run:RUN-20:merged');
  assert.deepEqual(kinds(collisions({ ...me, state: 'running' }, [nav])), ['territory/exclusive:warn:wait'], 'running beside it: neither holds the other');
  assert.deepEqual(kinds(collisions({ ...me, state: 'running', scope: ['web/pages/board.mjs'], exclusive: [] }, [{ ...nav, state: 'queued' }])),
    ['territory/exclusive:warn:wait'], 'a queued holder is behind a running run: no hold');
});

test('covers: my Scope covers files an unlanded branch changes -> warn; pick wait (landing it removes the collision)', () => {
  const cap = I('capacity', { state: 'unlanded', dlv: 'DLV-4', touched: ['web/app.mjs', 'web/widgets.mjs', 'tests/web.test.mjs'] });
  const [h] = collisions(I('web-nav', { state: 'new', scope: ['web/**', 'tests/**'] }), [cap]);
  assert.deepEqual(kinds([h]), ['territory/covers:warn:wait']);
  assert.deepEqual(h.files, ['web/app.mjs', 'web/widgets.mjs'], 'tests/** is commons');
  assert.equal(h.pick.args.after, 'dlv:DLV-4:merged');
});

test('incident 4 (two lanes on one area): readable Scopes that share tracked files -> territory/scopes, warn; pick narrow, or wait when the task is the other\'s files', () => {
  const tracked = ['web/app.mjs', 'web/nav.mjs', 'web/pages/runs.mjs', 'web/css/runs.css', 'tests/web.test.mjs'];
  const nav = I('web-nav', { run: 'RUN-30', scope: ['web/**'] });
  const me = I('web-runs', { state: 'queued', scope: ['web/**'], tests: 'tests/web.test.mjs', done: 'the runs page lists runs' });
  const [h] = collisions(me, [nav], { tracked });
  assert.deepEqual(kinds([h]), ['territory/scopes:warn:narrow']);
  assert.equal(h.files.length, 4);
  assert.deepEqual(h.pick.args.drop, ['web/**']);
  const told = collisions(me, [{ ...nav, touched: ['web/nav.mjs'] }], { tracked });
  assert.deepEqual(kinds(told), ['territory/covers:warn:narrow']);
  assert.deepEqual(told[0].pick.args.drop, ['web/nav.mjs']);
  assert.equal(collisions({ ...me, done: 'web/nav.mjs shows the runs entry' }, [{ ...nav, touched: ['web/nav.mjs'] }], { tracked })[0].pick.remedy, 'wait');
  assert.match(hitLines(h, me)[1], /SloppaChoppa: narrow leave out of this Scope the files lane web-nav holds: web\/\*\* \(both run now\)/);
});

test('the pick reads the project commons too: one item in files apart but for a project common -> part, not fold (C14)', () => {
  const brook = I('brook', { items: ['RM-7'], touched: ['shared/util.py'] });
  const me = I('brook-shape', { state: 'new', items: ['RM-7'], scope: ['shared/**', 'game/shape/**'] });
  assert.deepEqual(kinds(collisions(me, [brook])), ['item:warn:fold', 'territory/covers:warn:narrow'], 'shared/** is no common by default');
  assert.deepEqual(kinds(collisions(me, [brook], { policy: { commons: ['shared/**'] } })), ['item:warn:part']);
});

test('territory near-misses: tests/** only, Scope: none, a prose Scope, a helper, wide Scopes that only touch', () => {
  const tracked = Array.from({ length: 40 }, (_, i) => `src/m${i}.mjs`).concat(['tests/a.test.mjs', 'docs/x.md']);
  const a = I('a', { scope: ['src/m1.mjs', 'tests/**', 'docs/**'], touched: ['src/m1.mjs', 'tests/a.test.mjs'] });
  assert.deepEqual(collisions(I('b', { state: 'new', scope: ['src/m2.mjs', 'tests/**'] }), [a], { tracked }), [], 'commons only');
  assert.deepEqual(collisions(I('b', { state: 'new', scope: [] }), [a], { tracked }), [], 'Scope: none writes nothing');
  assert.deepEqual(collisions(I('b', { state: 'new', scope: null }), [a], { tracked }), [], 'prose: changed files only, and b changed none');
  assert.deepEqual(collisions(I('b', { state: 'new', role: 'helper', scope: ['src/**'] }), [a], { tracked }), []);
  const wide = I('w', { scope: ['src/**'] }), half = I('h', { state: 'new', scope: Array.from({ length: 30 }, (_, i) => `src/m${i}.mjs`).concat(['lib/**']) });
  assert.equal(collisions(half, [wide], { tracked, policy: { narrow_files: 25 } }).length, 1, 'inside the other: counted');
  assert.deepEqual(collisions({ ...half, scope: [...half.scope, 'src/extra/**'] }, [{ ...wide, scope: Array.from({ length: 35 }, (_, i) => `src/m${i + 4}.mjs`) }], { tracked }), [],
    '26 shared files of 30 and 35, neither inside: past narrow_files, too wide to mean anything');
});

test('order/stacked: my branch contains commits of an unmerged lane -> hold with the derived condition; planned and named', () => {
  const base = I('base-lane', { state: 'unlanded', dlv: 'DLV-9', run: 'RUN-40', branch: 'norn/base-lane' });
  const me = I('top', { state: 'new', stacked_on: [{ lane: 'base-lane', n: 4 }] });
  const [h] = collisions(me, [base]);
  assert.deepEqual(kinds([h]), ['order/stacked:hold:wait']);
  assert.equal(h.after, 'dlv:DLV-9:merged');
  assert.match(h.why, /contains 4 commits of lane base-lane's unmerged branch norn\/base-lane/);
  assert.match(hitLines(h, me).join('\n'), /waits for dlv:DLV-9:merged/);
  const items = { 'RM-3': { stages: ['S1', 'S2'] } };
  const s1 = I('s1', { run: 'RUN-41', stage: 'S1', items: ['RM-3'], part_of: null }), s2 = I('s2', { state: 'new', stage: 'S2', items: ['RM-3'], part_of: 's1' });
  assert.deepEqual(kinds(collisions(s2, [s1], { items })), ['order/planned:hold:wait']);
  assert.deepEqual(collisions({ ...s2, stage: 'S1' }, [{ ...s1, stage: 'S2' }], { items }), [], 'the earlier stage waits for nothing');
  assert.deepEqual(kinds(collisions(I('n', { state: 'new', names: { runs: ['RUN-41'] } }), [s1])), ['order/named:warn:wait']);
});

test('stale: a caveat naming an ended run as running is found; a run that handed off to a live successor, a fresh heartbeat, an open deliverable are alive', () => {
  const ev = (id, state, o = {}) => ({ id, kind: 'run', state, data: { lane: 'brook', stage: 'S2', kind: 'worker' }, history: [{ ts: '2026-11-19T22:10:00Z' }], ...o });
  const runs = { 'RUN-5': ev('RUN-5', 'exited', { end: { outcome: 'stopped' } }) };
  const items = { 'RM-2': { id: 'RM-2', state: 'open', caveat: { text: 'RUN-5 running the bank pass; do not start another' } } };
  const [h] = staleCaveats(items, { runs });
  assert.equal(h.kind, 'stale');
  assert.match(h.why, /RM-2's caveat names RUN-5 as running; RUN-5 ended 2026-11-19 22:10Z \(stopped\)/);
  assert.equal(h.pick.remedy, 'correct');
  const handed = { 'RUN-5': ev('RUN-5', 'exited', { end: { outcome: 'handoff' } }), 'RUN-6': ev('RUN-6', 'running') };
  assert.deepEqual(staleCaveats(items, { runs: handed }), [], 'continues as RUN-6');
  assert.equal(dead('RUN-5', { runs, hbAge: () => 1000, staleMs: 120000 }), null, 'a fresh heartbeat');
  assert.equal(dead('RUN-5', { runs, openDlvRuns: new Set(['RUN-5']) }), null, 'its deliverable is open');
  assert.deepEqual(staleCaveats({ 'RM-2': { ...items['RM-2'], caveat: { text: 'RUN-5 found the bank bug' } } }, { runs }), [], 'no live word: not a claim that it runs');
});

test('recommend is the first SPEC 4A.2 row that fits: territory against a DONE branch waits; a running run is never narrowed', () => {
  const a = I('a', { state: 'unlanded', run: 'RUN-1', touched: ['x/a.mjs'] }), b = I('b', { state: 'running', scope: ['x/**'] });
  assert.equal(recommend({ kind: 'territory', grade: 'covers' }, b, a).remedy, 'wait');
  assert.equal(recommend({ kind: 'territory', grade: 'covers' }, b, { ...a, state: 'running' }).why, 'a running run is never stopped for a file overlap');
});
