// META-TEND P2 (REPORT 4.2 gap 1-2, 4.3): the work class on every run - stamped at launch with a `basis`; old runs inferred at read
// time and marked so; the cost per COMPLETED stage by class x executor x model x effort; the Fable count.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { workClass, classOfRun, CLASS_LABELS, isFable } from '../engine/lib/workclass.mjs';
import { classCost } from '../engine/lib/classcost.mjs';
import { POLICY_DEFAULTS } from '../engine/lib/policy.mjs';
import { queueRun } from '../engine/lib/runs.mjs';

after(cleanTmp);
const POL = { executors: { ...POLICY_DEFAULTS.executors, critical_implementation: { executor: 'kestrel-implementer', model: 'claude-opus-5-5', effort: 'medium' },
  planning: { executor: 'kestrel-planner', model: 'claude-opus-5-5', effort: 'high' }, chores: { executor: 'grok', model: '', effort: '' } }, critical_lanes: ['core'] };

test('workClass: given class, check-ins, merges, stage words, role agents, policy match - each with its basis', () => {
  const c = d => workClass(d, POL);
  assert.deepEqual(c({ cls: 'review', kind: 'worker', agent: 'kestrel-implementer' }), { class: 'review', basis: 'given' });
  assert.deepEqual(c({ kind: 'checkin', tickClass: 'minor' }), { class: 'checkin_minor', basis: 'role' });
  assert.deepEqual(c({ kind: 'checkin' }), { class: 'checkin_major', basis: 'role' });
  assert.deepEqual(c({ kind: 'worker', stage: 'MERGE', agent: 'kestrel-runner' }), { class: 'merge', basis: 'stage' });
  assert.deepEqual(c({ kind: 'worker', stage: 'DIAG', agent: 'kestrel-planner' }), { class: 'diagnosis', basis: 'stage' });
  assert.deepEqual(c({ kind: 'worker', stage: 'S3', agent: 'kestrel-planner' }), { class: 'planning', basis: 'agent' });
  assert.deepEqual(c({ kind: 'worker', stage: 'S3', lane: 'water', agent: 'kestrel-implementer' }), { class: 'implementation', basis: 'agent' });
  assert.deepEqual(c({ kind: 'worker', stage: 'S3', lane: 'core', agent: 'kestrel-implementer' }), { class: 'critical_implementation', basis: 'agent' });
  assert.deepEqual(c({ kind: 'worker', agent: 'kestrel-runner', stage: 'PUBLISH' }), { class: 'docs', basis: 'stage' });
  assert.deepEqual(c({ kind: 'cli', executor: 'grok' }), { class: 'chores', basis: 'policy' }, 'grok does chores + passfail: the first, chores');
  assert.deepEqual(c({ kind: 'codex', executor: 'codex-sol', model: 'gpt-6.1-sol', effort: 'medium' }), { class: 'review', basis: 'policy' });
  assert.deepEqual(c({ kind: 'worker', executor: 'claude', agent: 'someone' }), { class: 'implementation', basis: 'default' });
  for (const k of ['checkin_major', 'checkin_minor', 'merge', 'audit', 'chat', 'planning']) assert.ok(CLASS_LABELS[k], k);
});

test('classOfRun: a stamped run keeps its class; an old one is inferred and marked; a helper with class but no basis = given', () => {
  assert.deepEqual(classOfRun({ class: 'docs', class_basis: 'stage' }, POL), { class: 'docs', basis: 'stage', inferred: false });
  assert.deepEqual(classOfRun({ class: 'chores', role: 'helper' }, POL), { class: 'chores', basis: 'given', inferred: false });
  assert.deepEqual(classOfRun({ kind: 'checkin', tick_class: 'minor' }, POL), { class: 'checkin_minor', basis: 'role', inferred: true });
  assert.ok(isFable({ model: 'claude-fable-5-2' }) && isFable({ executor: 'fable' }) && !isFable({ model: 'claude-opus-5-5' }));
});

test('the launcher stamps class + class_basis on the run record (start and queue share the fields); a Fable run gets the cost-class notice', () => {
  const st = mkTmp('meta-wc-'), wt = mkTmp('meta-wc-wt-');
  const base = { state: st, locksDir: path.join(st, 'locks'), executor: 'fake', kind: 'fake', lane: 'water', brief: path.join(wt, 'b.md'), worktree: wt, lock: false, tick: null,
    budget: {}, policy: { auto_resume_handoff: false, trigger_on_exit: false }, env: { FAKE_MS: '10' } };
  fs.writeFileSync(base.brief, '# b');
  const a = queueRun({ ...base, stage: 'MERGE', agent: 'kestrel-runner', workPolicy: POL });
  const b = queueRun({ ...base, lane: 'w2', stage: 'S1', model: 'claude-fable-5-2', cls: 'critical_implementation' });
  const items = loadState(st).items;
  assert.equal(items[a.run].data.class, 'merge');
  assert.equal(items[a.run].data.class_basis, 'stage');
  assert.equal(items[b.run].data.class, 'critical_implementation');
  assert.equal(items[b.run].data.class_basis, 'given');
  assert.ok((items[b.run].data.warnings || []).some(w => /Fable/.test(w) && /cost class/.test(w)), 'the Fable notice is on the run');
  assert.ok(!(items[a.run].data.warnings || []).some(w => /Fable/.test(w)));
});

const NOW = Date.parse('2026-11-13T12:00:00Z');
function fixture() {
  const st = mkTmp('meta-cc-'), at = t => ({ now: () => new Date(t), run: null });
  const run = (d, day, outcome, cr, out, hour = 8) => {
    const id = record(st, { kind: 'run', ev: 'start', by: 'launcher', data: { executor: 'claude', kind: 'worker', model: 'claude-opus-5-5', effort: 'medium', ...d } }, at(`2026-11-${day}T0${hour}:00:00Z`)).id;
    if (outcome) record(st, { kind: 'run', ev: 'end', id, by: 'launcher', data: { outcome, exit: 0, usage: { cache_read_input_tokens: cr, cache_creation_input_tokens: 0, input_tokens: 0, output_tokens: out } } }, at(`2026-11-${day}T0${hour + 1}:00:00Z`));
    return id;
  };
  const imp = { agent: 'kestrel-implementer', class: 'implementation', class_basis: 'agent' };
  const ids = {
    // stage water/S1: a hand-off then a resume that finishes it = ONE completed stage of 30M
    w1: run({ ...imp, lane: 'water', stage: 'S1' }, 10, 'handoff', 10e6, 1000), w2: run({ ...imp, lane: 'water', stage: 'S1', resume_of: 'x' }, 10, 'done', 20e6, 2000, 4),
    m1: run({ ...imp, lane: 'map', stage: 'S2' }, 11, 'done', 4e6, 500),
    s1: run({ ...imp, lane: 'sky', stage: 'S1' }, 11, 'stopped', 6e6, 100),
    // an old unstamped planner run: inferred, its own row
    p1: run({ agent: 'kestrel-planner', lane: 'plan', stage: 'SPEC' }, 12, 'done', 9e6, 900),
    f1: run({ ...imp, lane: 'fab', stage: 'S1', model: 'claude-fable-5-2' }, 12, 'done', 1e6, 100),
    live: run({ ...imp, lane: 'open', stage: 'S1' }, 12, null, 0, 0),
    old: run({ ...imp, lane: 'water', stage: 'S0' }, '01', 'done', 99e6, 1),
  };
  const dlvs = [{ id: 'DLV-1', runs: [ids.w1, ids.w2], merged_at: 'merged' }];
  return { ids, part: { project: 'x', items: Object.values(loadState(st).items), dlvs, policy: POL } };
}

test('classCost: per completed stage by class x executor x model x effort; resumes fold into their stage; inferred apart; Fable counted', () => {
  const { ids, part } = fixture();
  const c = classCost([part], { now: NOW, since: NOW - 7 * 86400000 });
  const row = (cls, src = 'stamped', model = 'claude-opus-5-5') => c.rows.find(r => r.class === cls && r.src === src && r.model === model);
  const imp = row('implementation');
  assert.equal(imp.stages, 3, 'water/S1 (2 runs) + map/S2 + sky/S1; the live stage and the old one are out');
  assert.equal(imp.runs, 4);
  assert.equal(imp.done, 2); assert.equal(imp.stopped, 1); assert.equal(imp.merged, 1);
  assert.equal(imp.cache_read.median, 17e6, 'median of 30M and 4M per done stage');
  assert.equal(imp.cache_read.p90, 30e6);
  assert.equal(imp.output.median, 1750);
  assert.equal(imp.executor, 'kestrel-implementer'); assert.equal(imp.effort, 'medium');
  assert.ok(imp.cost_per_done > 0, 'weighted tokens of all its stages / done stages');
  const pl = row('planning', 'inferred');
  assert.ok(pl && pl.stages === 1 && pl.basis.includes('stage'), 'the old planner run: inferred, never in a stamped row');
  assert.ok(!row('planning'), 'no stamped planning row');
  assert.equal(c.open, 1);
  const k = c.byClass.find(r => r.class === 'implementation');
  assert.equal(k.stages, 4, 'the per-kind view sums every model (opus 3 + fable 1)');
  assert.ok(c.byClassModel.some(r => r.class === 'implementation' && r.model === 'claude-fable-5-2'));
  assert.deepEqual(c.fable.runs, [ids.f1]);
  assert.equal(c.inferred_runs, 1);
});

test('norn run --class: a known class is stamped (basis given), none = derived, an unknown one refused (exit 2)', async () => {
  const { main } = await import('../engine/bin/norn.mjs');
  const root = mkTmp('meta-wc-cli-'), st = path.join(root, 'state', 'x'), wt = mkTmp('meta-wc-cli-wt-'), brief = path.join(wt, 'b.md');
  fs.mkdirSync(st, { recursive: true }); fs.writeFileSync(brief, '# b');
  const dep = record(st, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'fake', executor: 'fake', lane: 'dep' } }).id;   // never ends: the runs below stay queued
  const env = { ...process.env, META_ROOT: root, META_NO_TICK: '1' }, e = [];
  const run = (...a) => main(['run', '--executor', 'fake', '--worktree', wt, '--brief', brief, '--state', st, '--after', `run:${dep}`, ...a], env, () => {}, s => e.push(s));
  assert.equal(run('--lane', 'a', '--class', 'review'), 0, e.join('\n'));
  assert.equal(run('--lane', 'b', '--stage', 'MERGE', '--agent', 'x-runner'), 0, e.join('\n'));
  assert.equal(run('--lane', 'c', '--class', 'bogus'), 2);
  const items = Object.values(loadState(st).items).filter(i => i.kind === 'run' && i.id !== dep);
  const of = lane => items.find(i => i.data.lane === lane).data;
  assert.deepEqual([of('a').class, of('a').class_basis], ['review', 'given']);
  assert.deepEqual([of('b').class, of('b').class_basis], ['merge', 'stage']);
  assert.ok(!items.some(i => i.data.lane === 'c'));
});

test('Spend page: the per-kind-of-work card (cost per finished task by class, by model, the full grid with bars) and the Fable count', async () => {
  const { renderTab } = await import('../engine/dash/ui.mjs');
  const { part } = fixture();
  const classes = classCost([part], { now: NOW, since: NOW - 7 * 86400000 });
  const zero = { cache_read: 0, cache_create: 0, input: 0, output: 0, weighted: 0, pct: null, runs: 0, tokens: 0 };
  const p = { project: 'x', window: 'rolling', days: 7, since: '2026-11-06T12:00:00Z', rows: [], totals: { claude: zero, codex: zero, provider: zero, unmeasured: 0 },
    checkins: { ticks: 0 }, calib: { cacheR_per_pct: 1e6, mix: 1, weights: { input: 10, output: 50, cache_create_1h: 20, cache_create_5m: 12.5 } }, cost: { runs: 0, ms: 1, bytesRead: 0 },
    secondary: null, headline: null, account: null, classes };
  const html = renderTab('spend', { parts: [p], sub: 'work' }, { project: 'x', now: NOW });
  assert.match(html, /id="spend-class"[\s\S]*What each kind of work costs/);
  assert.match(html, /id="spend-class-kind"[\s\S]*Implementation[\s\S]*class="bar/);
  assert.match(html, /id="spend-class-model"[\s\S]*claude-fable-5-2/);
  assert.match(html, /id="spend-class-grid"[\s\S]*kestrel-implementer[\s\S]*medium/);
  assert.match(html, /id="spend-fable"[\s\S]*1 Fable run/);
  // META-TEND P6: on the shared widgets (bars), and a Slop chip in place on the class row a model advice is about
  assert.match(html, /<ol class="wbars" id="spend-class-kind">/);
  const cls = classes.byClass[0].class;
  const withAdv = renderTab('spend', { sub: 'work', parts: [{ ...p, advice: { cards: [{ id: cls, key: 'k1', severity: 'medium', title: 'on a top model at xhigh' }] } }] }, { project: 'x', now: NOW });
  assert.match(withAdv, /id="spend-class-kind"[^]*?<\/li>/);
  assert.match(withAdv.match(/id="spend-class-kind"[^]*?<\/li>/)[0], /gchip" data-go="spend" data-gosub="advice"[^>]*><span class="chip warn">1 Slop finding/);
  assert.match(html, /inferred/, 'the inferred rows are marked');
});

test('/api/usage carries the class table per project (classes)', async () => {
  const { fixture: dash } = await import('./helpers/dash-fixture.mjs');
  const f = await dash();
  try {
    const a = await f.get('/api/usage?project=kestrel');
    assert.equal(a.status, 200);
    const c = a.data.parts[0].classes;
    assert.ok(c && Array.isArray(c.rows) && Array.isArray(c.byClass) && c.fable && Number.isInteger(c.fable.count), JSON.stringify(c)?.slice(0, 200));
  } finally { await f.done(); }
});
