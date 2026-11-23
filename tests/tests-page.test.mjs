// SPEC dash-owner-1123 s.1 (T4-T7, page side): pages/tests.mjs rendered in node from synthetic parts - the case list (sort, filter, cap,
// "not run here yet", the folded charts), the test detail drawer, Impact (reach / sole guard / not covered), Run time's outliers - and
// its loader's requests. The 390 px check (T8) is CI's page test once the SHELL lane wires the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tests, testsLoad, TESTS_CAP } from '../engine/dash/pages/tests.mjs';
import { fileTable } from '../engine/dash/testparts.mjs';
import { tukey } from '../engine/dash/widgets.mjs';

const A = 'tests/a.test.mjs::alpha: checks one thing', B = 'tests/b.test.mjs::beta: never ran';
const GIT = { at: '2026-11-22T10:00:00Z', points: [{ day: '2026-11-21', sha: 'a', tests: 3, test_lines: 40, code_lines: 100, test_files: 2 }, { day: '2026-11-22', sha: 'b', tests: 4, test_lines: 50, code_lines: 100, test_files: 2 }] };
const base = o => ({ project: 'kestrel', suite: 'node:test', git: GIT, advisories: null, alerts: [], commands: { for: 'norn tests for' }, ...o });
const row = (id, o) => ({ id, file: id.split('::')[0], name: id.split('::')[1], desc: id.split(': ')[1], line: 3, lines: 5, last: null, median: null, runs: 0, at: null, ...o });
const LIST = { at: '2026-11-22T10:00:00Z', sha: 'abc123', total: 50, files: 2, sort: 'slowest', q: '', limit: 2, matched: 50, shown: 2, rows: [row(A, { last: 12, median: 11, runs: 9 }), row(B)] };

test('T4 Suite: the case list with lines, last and median; "not run here yet"; sort chips; the cap with show more; the charts folded at its head', () => {
  const h = tests(base({ sub: 'suite', list: LIST }));
  assert.match(h, /<details class="tablecard tfold" id="tests-time"><summary><b>Over time<\/b>[^]*class="tchart" data-chart="tests-count"/, 'the over-time charts, folded, first');
  assert.ok(h.indexOf('id="tests-time"') < h.indexOf('id="tests-list"'));
  assert.match(h, /<tr data-act="tests-case" data-id="tests\/a\.test\.mjs::alpha: checks one thing" tabindex="0"><td data-label="test"><b class="tname">alpha: checks one thing<\/b><\/td><td data-label="file"><span class="mono small">tests\/a\.test\.mjs:3<\/span><\/td><td data-label="lines" class="num">5<\/td><td data-label="last" class="num">12 ms<\/td><td data-label="median" class="num">11 ms<\/td><td data-label="runs" class="num">9<\/td><\/tr>/);
  assert.match(h, /data-id="tests\/b\.test\.mjs::beta: never ran"[^]*?<td data-label="last" class="num">-<\/td>[^]*?0 <span class="mute small">not run here yet<\/span>/);
  assert.match(h, /data-act="tests-sort" data-sort="slowest" aria-pressed="true">slowest[^]*data-sort="newest" aria-pressed="false"/);
  assert.match(h, /showing 2 of 50 · <button class="lnk" data-act="tests-more" data-limit="42">show more<\/button>/);
  assert.match(h, /id="tests-sum"[^]*<b class="mono">50<\/b><span class="small mute">tests<\/span>/, 'the count is the index\'s');
  assert.doesNotMatch(tests(base({ sub: 'suite', list: { ...LIST, matched: 2 } })), /show more/);
  assert.match(tests(base({ sub: 'suite', list: { ...LIST, q: 'zzz', rows: [], matched: 0, shown: 0 } })), /value="zzz"[^]*no test matches/);
  assert.match(tests(base({ sub: 'suite', list: null })), /id="tests-list"[^]*not measured yet[^]*norn tests index/);
  assert.equal(TESTS_CAP, 40);
});

test('T5 the test detail: its runs newest first, its file\'s sole-guard sources, its alert; Source opens the viewer at its line', () => {
  const c = { ...row(A), median: 11, max: 31, fails: 1, runs: [{ at: '2026-11-23T14:02:00Z', run: 'RUN-a-17', ms: 12, ok: true }, { at: '2026-11-22T09:00:00Z', run: 'RUN-a-3', ms: 31, ok: false }],
    reaches: ['engine/lib/modes.mjs', 'engine/lib/exec.mjs'], sole: ['engine/lib/modes.mjs'], alerts: [{ id: 'Q-7', title: `${A} failed 3 times under load` }] };
  const h = tests(base({ sub: 'suite', list: LIST, case_id: A, case: c }));
  assert.match(h, /<aside id="tests-case" class="drawer tcase" aria-label="Test detail"><div class="dh"><b class="tname">alpha: checks one thing<\/b>[^]*data-act="tests-case-close"/);
  assert.match(h, /tests\/a\.test\.mjs:3-7 · 5 lines · node:test[^]*checks: checks one thing/);
  assert.match(h, /median <b>11 ms<\/b> · max 31 ms · 1 fail[^]*RUN-a-17[^]*12 ms[^]*pass[^]*RUN-a-3[^]*31 ms[^]*fail/, 'newest first');
  assert.match(h, /reaches <b>2<\/b> source files · sole test of <b>1<\/b>[^]*data-file="engine\/lib\/modes\.mjs"[^]*>sole</);
  assert.match(h, /id="tests-case-alerts">[^]*Q-7[^]*failed 3 times under load/);
  assert.match(h, /<button data-act="test-src" data-file="tests\/a\.test\.mjs" data-line="3"[^>]*>Source<\/button>/);
  assert.match(tests(base({ sub: 'suite', list: LIST, case_id: 'tests/x.test.mjs::gone', case: null })), /id="tests-case"[^]*no such test in the index/);
  assert.doesNotMatch(tests(base({ sub: 'suite', list: LIST })), /id="tests-case"/, 'no case open: no drawer');
});

test('T6 Impact: test files by reach and sole guard (the list expands in place); the sources no test reaches, each opens in the viewer', () => {
  const impact = { at: '2026-11-22T09:12:00Z', sha: '1a2b3c4', suite: 'node:test', sources: ['engine/lib/a.mjs', 'engine/lib/b.mjs'] };
  const files = [{ file: 'tests/records.test.mjs', reaches: 41, sole: ['engine/lib/a.mjs'], areas: [['engine/lib', 38], ['engine/dash', 3]] }, { file: 'tests/sync.test.mjs', reaches: 35, sole: [], areas: [['engine/lib', 35]] }];
  const h = tests(base({ sub: 'impact', impact, lanes: [], picked: null, files, uncovered: ['engine/lib/c.mjs'] }));
  assert.match(h, /id="tests-impact-pick"/, 'the pick form stays');
  assert.match(h, /Test files by what they protect <span class="mute small">impact map at 1a2b3c4, 09:12/);
  assert.match(h, /data-label="reaches" class="num">41<\/td><td data-label="sole guard of" class="num"><details class="tsole"><summary>1<\/summary><div><button[^>]*data-file="engine\/lib\/a\.mjs"[^]*engine\/lib \(38\), engine\/dash \(3\)/);
  assert.match(h, /tests\/sync\.test\.mjs[^]*data-label="sole guard of" class="num">0<\/td>/);
  assert.match(h, /id="tests-uncovered"><summary>Not covered by any test: <b>1<\/b> source file<\/summary><p class="small"><button class="lnk mono small" data-act="test-src" data-file="engine\/lib\/c\.mjs"/);
  assert.match(tests(base({ sub: 'impact', impact: null, lanes: [], picked: null, files: [], uncovered: [] })), /not measured yet[^]*norn tests index/);
});

test('T7 Run time: the per-run list first, then the slowest tests; the outliers are exactly the medians past Q3 + 1.5 IQR', () => {
  const vals = [10, 11, 12, 13, 14, 15, 16, 400, 900], medians = vals.map((v, i) => ({ id: `tests/t.test.mjs::case ${i}`, label: `case ${i}`, value: v, max: i === 0 ? 50 : v }));
  const h = tests(base({ sub: 'runtime', rows: [], words: 'policy.tests: mode light', settings: [], medians, case_days: 7 }), { now: Date.parse('2026-11-23T00:00:00Z') });
  assert.ok(h.indexOf('id="tests-runtime"') < h.indexOf('id="tests-slowest"'));
  const fence = tukey(vals).fence, want = medians.filter(m => m.value > fence).map(m => m.id).sort();
  const got = [...h.matchAll(/class="wodot out[^"]*" data-act="tests-case" data-id="([^"]+)"/g)].map(m => m[1]).sort();
  assert.deepEqual(got, want); assert.deepEqual(want, ['tests/t.test.mjs::case 7', 'tests/t.test.mjs::case 8']);
  assert.match(h, /class="wodot spread" data-act="tests-case" data-id="tests\/t\.test\.mjs::case 0"/, 'slow sometimes: max over 3x the median');
  assert.match(h, /Slowest tests <span class="mute small">median, last 7 days/);
  assert.match(tests(base({ sub: 'runtime', rows: [], settings: [], medians: [] })), /no test case timed here yet/);
});

test('testsLoad: the summary, the open view\'s part (Suite: cap, sort, filter) and the open case', async () => {
  const asked = [], get = async u => { asked.push(u); return u.includes('part=case') ? { case: { id: A } } : u.includes('part=') ? { list: LIST } : base({}); };
  const d = await testsLoad('kestrel', get, { sub: 'suite', sort: 'longest', q: 'alpha', case: A });
  assert.deepEqual(asked, ['/api/tests?project=kestrel', '/api/tests?project=kestrel&part=suite&limit=40&sort=longest&q=alpha', `/api/tests?project=kestrel&part=case&case=${encodeURIComponent(A)}`]);
  assert.deepEqual([d.sub, d.case_id, d.case.id, d.list.total], ['suite', A, A, 50]);
  asked.length = 0;
  await testsLoad('kestrel', get, { sub: 'impact', batch: 'lane:x' });
  assert.deepEqual(asked, ['/api/tests?project=kestrel', '/api/tests?project=kestrel&part=impact&lane=x']);
});

test('fileTable: a header per column (sortable when asked), each cell labelled for the phone card, a row action', () => {
  const h = fileTable([{ file: 'tests/a.test.mjs', n: 3 }], [{ key: 'file', label: 'test file' }, { key: 'n', label: 'reaches', num: true }], { sort: { key: 'n', act: 'x-sort' }, act: 'x-open', id: 'ft' });
  assert.equal(h, '<table class="ftable" id="ft"><thead><tr><th><button class="lnk" data-act="x-sort" data-sort="file">test file</button></th><th class="num" aria-sort="descending"><button class="lnk" data-act="x-sort" data-sort="n">reaches</button></th></tr></thead>'
    + '<tbody><tr data-act="x-open" data-id="tests/a.test.mjs" tabindex="0"><td data-label="test file">tests/a.test.mjs</td><td data-label="reaches" class="num">3</td></tr></tbody></table>');
});
