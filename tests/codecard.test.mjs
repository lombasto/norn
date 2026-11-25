// RM-a-57 (docs/code-graph.md "A consumer: norn code card"): lib/codecard.mjs - one short card per file from the two contract readers
// (a synthetic graph in the reader's shape, stored signals, the tests index): what it is, who depends on it (the top five by their own
// fan-in), what changes with it, its fixes, its tests and the stamps; a part with no index reads "not indexed", never a guess; every
// card under CARD_LIMITS.tokens. The A/B switch (every second run by number) and the report that refuses under min_group runs per group.
// Sandbox only (mkTmp).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { cards, cardGroup, markCard, cardReport, CARD_LIMITS } from '../engine/lib/codecard.mjs';
import { codeCmd } from '../engine/lib/codecli.mjs';

test.after(cleanTmp);
const NOW = Date.parse('2026-11-20T12:00:00Z'), SHA = 'a'.repeat(40);
const edge = (from, to) => ({ from, to, line: 1, col: 1, kind: 'import', how: 'exact', spec: to, trust: 'unmeasured' });
function world() {
  const d = mkTmp('meta-card-'), repo = path.join(d, 'repo'), state = path.join(d, 'state', 'kestrel');
  fs.mkdirSync(path.join(repo, 'lib'), { recursive: true }); fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(repo, 'lib', 'core.mjs'), 'a\nb\nc\n'); fs.writeFileSync(path.join(repo, 'lib', 'leaf.mjs'), 'x\n');
  const users = Array.from({ length: 7 }, (_, i) => `lib/u${i}.mjs`), files = new Map([['lib/core.mjs', { lang: 'javascript', excluded: null }], ['lib/leaf.mjs', { lang: 'javascript', excluded: null }], ...users.map(u => [u, { lang: 'javascript', excluded: null }])]);
  // u6 is imported by every other user: the most depended-on importer comes first
  const edges = [...users.map(u => edge(u, 'lib/core.mjs')), ...users.slice(0, 6).map(u => edge(u, 'lib/u6.mjs'))];
  const graph = { ok: true, stamp: { commit: SHA, tree: 'b'.repeat(40), indexed_at: '2026-11-20T10:00:00Z', age_s: 7200, asked: 'HEAD', exact: true, worktree: false }, root: repo.replace(/\\/g, '/'), prefix: '', files, edges, unresolved: [], indexed: null };
  return { d, repo, state, graph };
}
const sig = (o = {}) => ({ at: '2026-11-19T12:00:00Z', sha: 'c'.repeat(12), basis: 'measured', window: { days: 365, from: '2025-11-20', to: '2026-11-20' }, limits: { fix_short_days: 90 },
  landings: 40, batches_skipped: 1, fixes: { status: 'measured', typed: 30, commits: 35 },
  files: { 'lib/core.mjs': { landings: 9, partners: [{ file: 'lib/leaf.mjs', shared: 4, share: 0.44, landings: 6 }], fixes: { n_90d: 1, n_365d: 3, last: [{ sha: 'd'.repeat(12), day: '2026-11-01', subject: 'fix(core): keep the order', type: 'fix' }] }, fix_first: 80, importance: 70, churn_90d: 50, fan_in: 7 } }, ...o });
const writeSig = (state, s) => { fs.mkdirSync(path.join(state, 'code'), { recursive: true }); fs.writeFileSync(path.join(state, 'code', 'signals.json'), JSON.stringify(s)); };
const writeImpact = state => { fs.mkdirSync(path.join(state, 'tests'), { recursive: true }); fs.writeFileSync(path.join(state, 'tests', 'impact.json'), JSON.stringify({ at: '2026-11-18T12:00:00Z', sha: 'e'.repeat(12), sources: { 'lib/core.mjs': ['tests/core.test.mjs'], 'lib/leaf.mjs': [] } })); };

test('a card per file: what, dependents (top five by fan-in), partners, fixes, tests, stamps; under the token cap', () => {
  const w = world(); writeSig(w.state, sig()); writeImpact(w.state);
  const r = cards({ state: w.state, repo: w.repo, files: ['lib/core.mjs', './lib/leaf.mjs'], graph: w.graph, now: NOW });
  const [c, l] = r.cards;
  assert.equal(c.file, 'lib/core.mjs'); assert.equal(c.lang, 'javascript'); assert.equal(c.lines, 3);
  assert.equal(c.dependents.n, 7); assert.equal(c.dependents.top.length, 5); assert.equal(c.dependents.top[0], 'lib/u6.mjs');
  assert.deepEqual(c.partners.map(p => p.file), ['lib/leaf.mjs']);
  assert.equal(c.fixes.n_365d, 3); assert.deepEqual(c.tests, ['tests/core.test.mjs']);
  assert.equal(c.stamps.graph.commit, SHA.slice(0, 12)); assert.equal(c.stamps.graph.age_s, 7200); assert.equal(c.stamps.signals.sha, 'c'.repeat(12));
  assert.match(c.text, /^lib\/core\.mjs · javascript, 3 lines/); assert.match(c.text, /used by 7 files: lib\/u6\.mjs/); assert.match(c.text, /\+2 more/);
  assert.match(c.text, /fixes: 1 in 90 d, 3 in 365 d; last 2026-11-01 fix\(core\): keep the order/); assert.match(c.text, /tests: tests\/core\.test\.mjs/);
  assert.match(c.text, /indexed: graph aaaaaaaaaaaa \(2 h\), signals cccccccccccc \(24 h\), tests eeeeeeeeeeee \(2 d\); measured/);
  assert.equal(l.file, 'lib/leaf.mjs'); assert.equal(l.dependents.n, 0); assert.deepEqual(l.tests, []); assert.equal(l.partners.na, 'not indexed');
  assert.match(l.text, /tests: none cover it/);
  for (const x of r.cards) { assert.ok(x.tokens <= CARD_LIMITS.tokens, `${x.file}: ${x.tokens}`); assert.equal(x.tokens, Math.ceil(x.text.length / CARD_LIMITS.chars_per_token)); }
});

test('a part whose index does not exist reads "not indexed", never a guess; long lists are cut to the cap', () => {
  const w = world();
  const r = cards({ state: w.state, repo: w.repo, files: ['lib/core.mjs'], graph: { ok: false, why: 'norn-code is not built' }, now: NOW });
  const c = r.cards[0];
  assert.equal(c.lang, null); assert.equal(c.lines, 3);
  for (const k of ['dependents', 'partners', 'fixes', 'tests']) assert.equal(c[k].na, 'not indexed', k);
  assert.match(c.text, /used by: not indexed/); assert.match(c.text, /changes with: not indexed/); assert.match(c.text, /fixes: not indexed/); assert.match(c.text, /tests: not indexed/);
  assert.equal(r.not_indexed.graph, 'norn-code is not built'); assert.match(r.not_indexed.signals, /none stored/);
  // an untyped history: the fixes read n/a with the reason (measured: the signals say so), not "not indexed"
  writeSig(w.state, sig({ fixes: { status: 'n/a', typed: 0, commits: 7, reason: '0 of 7 commits carry a type' } }));
  assert.match(cards({ state: w.state, repo: w.repo, files: ['lib/core.mjs'], graph: w.graph, now: NOW }).cards[0].text, /fixes: n\/a \(0 of 7 commits carry a type\)/);
  // a file with long partner paths and subjects still fits the cap
  const big = sig(); big.files['lib/core.mjs'].partners = Array.from({ length: 8 }, (_, i) => ({ file: `lib/${'deep/'.repeat(40)}p${i}.mjs`, shared: 5, share: 0.5, landings: 9 }));
  writeSig(w.state, big);
  const c2 = cards({ state: w.state, repo: w.repo, files: ['lib/core.mjs'], graph: w.graph, now: NOW }).cards[0];
  assert.ok(c2.tokens <= CARD_LIMITS.tokens, String(c2.tokens)); assert.match(c2.text, /changes with: .*\+\d+ more/);
});

test('the A/B switch: off gives no group; ab gives the card to even run numbers; markCard records the group once', () => {
  assert.equal(cardGroup({}, 'RUN-a-4'), null);
  assert.equal(cardGroup({ code: { card: 'off' } }, 'RUN-a-4'), null);
  assert.equal(cardGroup({ code: { card: 'ab' } }, 'RUN-a-4'), 'card');
  assert.equal(cardGroup({ code: { card: 'ab' } }, 'RUN-a-5'), 'control');
  assert.equal(cardGroup({ code: { card: 'ab' } }, undefined), null);
  const w = world();
  markCard(w.state, 'RUN-a-4', 'card'); markCard(w.state, 'RUN-a-4', 'control');
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.state, 'code', 'card', 'RUN-a-4.json'), 'utf8')).group, 'card');
});

test('the report: refuses under min_group runs per group; compares tokens, files read and the done rate over finished runs', () => {
  const w = world(), items = {};
  const run = (n, outcome) => { const id = `RUN-a-${n}`; items[id] = { id, kind: 'run', state: 'exited', data: {}, end: { outcome } }; markCard(w.state, id, n % 2 ? 'control' : 'card'); };
  for (let n = 1; n <= 20; n++) run(n, n % 4 === 1 ? 'stopped' : 'done');
  items['RUN-a-99'] = { id: 'RUN-a-99', kind: 'run', state: 'running', data: {}, end: null }; markCard(w.state, 'RUN-a-99', 'control');   // still running: not counted
  const usageOf = it => ({ total: idNum(it.id) % 2 ? 2e6 : 1e6 }), readsOf = it => (idNum(it.id) % 2 ? 12 : 8);
  const few = cardReport({ state: w.state, items, usageOf, readsOf });
  assert.equal(few.ok, false); assert.match(few.why, /too few runs/); assert.deepEqual([few.groups.card.runs, few.groups.control.runs], [10, 10]);
  for (let n = 21; n <= 30; n++) run(n, 'done');
  const r = cardReport({ state: w.state, items, usageOf, readsOf });
  assert.equal(r.ok, true); assert.equal(r.groups.card.runs, 15); assert.equal(r.groups.control.runs, 15);
  assert.equal(r.groups.card.tokens_per_run, 1e6); assert.equal(r.groups.control.tokens_per_run, 2e6);
  assert.equal(r.groups.card.files_per_run, 8); assert.equal(r.groups.control.files_per_run, 12);
  assert.equal(r.groups.card.done_rate, 1); assert.equal(r.groups.control.done_rate, 10 / 15);
});
const idNum = id => Number(id.split('-').at(-1));

test('norn code card: several files in one call, --json; --report says too few runs', () => {
  const w = world(); writeSig(w.state, sig());
  const out = [], err = [], where = () => ({ project: null, state: w.state });
  // no graph store for this repo here: the dependents read "not indexed"
  assert.equal(codeCmd(['card', 'lib/core.mjs', 'lib/leaf.mjs', '--repo', w.repo, '--json'], { out: s => out.push(s), err: s => err.push(s), where, now: NOW }), 0, err.join('\n'));
  const j = JSON.parse(out[0]);
  assert.deepEqual(j.cards.map(c => c.file), ['lib/core.mjs', 'lib/leaf.mjs']); assert.equal(j.cap, CARD_LIMITS.tokens);
  out.length = 0;
  assert.equal(codeCmd(['card', 'lib/core.mjs', '--repo', w.repo], { out: s => out.push(s), err: s => err.push(s), where, now: NOW }), 0);
  assert.match(out.join('\n'), /^lib\/core\.mjs · /);
  out.length = 0;
  assert.equal(codeCmd(['card', '--report'], { out: s => out.push(s), err: s => err.push(s), where }), 1);
  assert.match(out.join('\n'), /too few runs: card 0, control 0 \(15 each needed\)/);
  assert.equal(codeCmd(['card'], { out: () => {}, err: s => err.push(s), where }), 2);
});
