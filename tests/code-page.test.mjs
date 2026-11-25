// SPEC dash-owner-1123 s.7 (K3, K4, page side; RM-a-60: the fix-first sort and columns, the drawer's partners and fixes): pages/code.mjs rendered in node from synthetic parts - the summary (<= 4 numbers), Files
// (fileTable, sorts, the folder filter, show more), the file drawer (growth chart, last commits, the viewer), Growth (timeChart + the
// fastest), Outliers (the oversized file past the fence), Map (the drawn map in a sandboxed iframe on /code-map/; none drawn: the
// not-built text, no iframe) - and its loader's requests. The 390 px
// check is CI's page test once the SHELL lane wires the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { code, codeLoad, CODE_SUBS } from '../engine/dash/pages/code.mjs';

const WEEKS = Array.from({ length: 26 }, (_, i) => new Date(Date.parse('2026-05-29T12:00:00Z') + i * 7 * 86400e3).toISOString().slice(0, 10));
const ramp = (a, b) => WEEKS.map((_, i) => Math.round(a + (b - a) * i / 25));
const row = (file, o) => ({ file, lines: 100, lang: 'javascript', growth: ramp(80, 100), delta: 20, pct: 25, churn_90d: 300, rel_churn: 3, commits_90d: 4, fan_in: 2, importance: 50, fix_first: 60, fixes_365d: 3, ...o });
const base = o => ({ project: 'kestrel', index: { at: '2026-11-20T12:00:00Z', sha: 'abc123def456' }, total: { files: 783, lines: 98400, added_30d: 6100, hotspot: 'engine/dash/server.mjs' }, ...o });
const LIST = { sort: 'importance', folder: '', folders: [['engine', 300], ['engine/dash', 40], ['tests', 252]], limit: 2, matched: 783, shown: 2,
  rows: [row('engine/dash/server.mjs', { lines: 2180, delta: 640, pct: 41, churn_90d: 3900, importance: 98 }), row('docs/notes.md', { lang: 'markdown', fan_in: null, importance: 97 })] };

test('K3 the summary and Files: at most 4 numbers; the table with growth sparkline + delta, churn, fan-in, importance; sorts, folder filter, show more', () => {
  const h = code(base({ sub: 'files', list: LIST }));
  assert.deepEqual(CODE_SUBS.map(([k]) => k), ['files', 'growth', 'outliers', 'map']);
  assert.equal((h.match(/class="subnum/g) || []).length, 4);
  assert.match(h, /id="code-sum"[^]*783[^]*files[^]*98,400[^]*lines[^]*\+6,100[^]*lines added in 30 days[^]*server\.mjs[^]*top hotspot/);
  assert.match(h, /<tr data-act="code-file" data-id="engine\/dash\/server\.mjs" tabindex="0"><td data-label="file"><span class="mono small">engine\/dash\/server\.mjs<\/span><\/td><td data-label="lines" class="num">2,180<\/td><td data-label="26 w" class="num"><span class="mono cspark" aria-hidden="true">[▁-█]{26}<\/span> \+41 %<\/td><td data-label="churn 90 d" class="num">3,900<\/td><td data-label="fan-in" class="num">2<\/td><td data-label="importance" class="num">98<\/td><td data-label="fixes 365 d" class="num">3<\/td><td data-label="fix first" class="num">60<\/td><\/tr>/);
  assert.match(h, /data-id="docs\/notes\.md"[^]*?<td data-label="fan-in" class="num"><span class="mute">n\/a<\/span><\/td>/, 'fan-in is JS only');
  assert.match(h, /data-act="code-sort" data-sort="importance" aria-pressed="true"[^]*data-sort="fix_first" aria-pressed="false">fix first<[^]*data-sort="lines" aria-pressed="false"/);
  assert.match(code(base({ sub: 'files', list: { ...LIST, sort: 'fix_first' } })), /data-sort="fix_first" aria-pressed="true"/);
  assert.match(h, /fix first = of churn, fan-in and fixes \(not built yet/, 'no signals stored: says so');
  const na = code(base({ sub: 'files', list: { ...LIST, fixes: { status: 'n/a', reason: '0 of 9 commits carry a type' }, rows: [row('a.mjs', { fix_first: null, fixes_365d: null })] } }));
  assert.match(na, /\(n\/a: 0 of 9 commits carry a type\)[^]*<td data-label="fixes 365 d" class="num"><span class="mute">n\/a<\/span><\/td><td data-label="fix first" class="num"><span class="mute">n\/a<\/span><\/td>/);
  assert.match(h, /<select id="code-folder" data-act="code-folder" aria-label="folder"><option value="" selected>all<\/option><option value="engine">engine \(300\)<\/option><option value="engine\/dash">engine\/dash \(40\)<\/option>/);
  assert.match(code(base({ sub: 'files', list: { ...LIST, folder: 'tests' } })), /<option value="tests" selected>/);
  assert.match(h, /showing 2 of 783 · <button class="lnk" data-act="code-more" data-limit="42">show more<\/button>/);
  assert.match(code(base({ sub: 'files', list: null, index: null, total: null })), /id="code-files"[^]*not built yet[^]*norn code history/);
  assert.equal((code(base({ sub: 'files', list: null, index: null, total: null })).match(/class="subnum/g) || []).length, 0, 'no index: no number');
});

test('the file drawer: its growth chart, its last commits, the code viewer over /api/source; an unreadable file says why', () => {
  const file = { ...row('engine/a.mjs', { lines: 3 }), born: '2026-07-01', bytes: 80, days: WEEKS, last: [{ sha: 'abc123def456', day: '2026-11-10', subject: 'feat: grow a', added: 2, deleted: 0 }] };
  const h = code(base({ sub: 'files', list: LIST, file_id: 'engine/a.mjs', file, source: { file: 'engine/a.mjs', text: 'const a = 1;\nexport { a };\n', lines: 3 } }));
  assert.match(h, /<aside id="code-file" class="drawer cfile" aria-label="File detail">[^]*engine\/a\.mjs[^]*data-act="code-file-close"/);
  assert.match(h, /id="code-file"[^]*class="tchart" data-chart="code-file-growth"/);
  assert.match(h, /id="code-file-commits"[^]*abc123de[^]*2026-11-10[^]*feat: grow a[^]*\+2 -0/);
  assert.match(h, /id="code-file"[^]*class="codeview" id="srcview-code"[^]*<tr id="srcl-1">/);
  assert.match(code(base({ sub: 'files', list: LIST, file_id: 'x.bin', file: { ...file, file: 'x.bin' }, source: { error: 'Not a text file' } })), /id="code-file"[^]*Not a text file/);
  assert.match(code(base({ sub: 'files', list: LIST, file_id: 'gone.mjs', file: null })), /id="code-file"[^]*not in the index/);
  assert.match(h, /id="code-file-partners"[^]*not built yet/, 'no signals stored');
});

test('the file drawer: the files that change together with it and its last fixes; an untyped history reads n/a with the reason', () => {
  const file = { ...row('engine/a.mjs', { lines: 3, fix_first: 71 }), born: '2026-07-01', bytes: 80, days: WEEKS, last: [], signals: 'abc123def456',
    partners: [{ file: 'engine/b.mjs', shared: 4, share: 0.67, landings: 5 }], fixes: { n_90d: 1, n_365d: 2, last: [{ sha: 'fed321cba654', day: '2026-10-20', subject: 'fix(a): off by one', type: 'fix' }] }, fixes_na: null };
  const h = code(base({ sub: 'files', list: LIST, file_id: 'engine/a.mjs', file, source: { file: 'engine/a.mjs', text: 'x\n' } }));
  assert.match(h, /fix first 71/);
  assert.match(h, /Changes together with[^]*id="code-file-partners"[^]*engine\/b\.mjs[^]*4 shared landings · 67 % of this file's · it has 5/);
  assert.match(h, /Last fixes[^]*1 in 90 days, 2 in 365 days[^]*id="code-file-fixes"[^]*fed321cb[^]*2026-10-20[^]*fix\(a\): off by one/);
  assert.match(code(base({ sub: 'files', list: LIST, file_id: 'engine/a.mjs', file: { ...file, partners: [] } })), /id="code-file-partners">no file over the thresholds/);
  const na = code(base({ sub: 'files', list: LIST, file_id: 'engine/a.mjs', file: { ...file, fix_first: null, fixes: null, fixes_na: '0 of 9 commits carry a type' } }));
  assert.match(na, /fix first n\/a[^]*id="code-file-fixes">n\/a: 0 of 9 commits carry a type/);
});

test('K3 Growth: lines per top-level area over 26 weeks and the 10 fastest-growing files', () => {
  const areas = [{ key: 'engine', label: 'engine', points: WEEKS.map((x, i) => ({ x, y: 1000 + i })) }, { key: 'tests', label: 'tests', points: WEEKS.map((x, i) => ({ x, y: 500 + i })) }];
  const fastest = Array.from({ length: 10 }, (_, i) => row(`engine/f${i}.mjs`, { delta: 100 - i }));
  const h = code(base({ sub: 'growth', days: WEEKS, areas, fastest }));
  assert.match(h, /class="tchart" data-chart="code-growth"[^]*data-series="engine"[^]*data-series="tests"/);
  assert.equal((h.match(/data-act="code-file" data-id="engine\/f\d\.mjs"/g) || []).length, 10);
  assert.match(h, /id="code-fastest"[^]*engine\/f0\.mjs[^]*\+100/);
});

test('K4 Outliers: size, growth and churn charts; the oversized fixture file is past the fence', () => {
  const pts = v => Array.from({ length: 9 }, (_, i) => ({ id: `engine/m${i}.mjs`, label: `engine/m${i}.mjs`, value: v + i }));
  const size = [...pts(100), { id: 'engine/huge.mjs', label: 'engine/huge.mjs', value: 5000 }];
  const h = code(base({ sub: 'outliers', size, growth: pts(10), churn: pts(40) }));
  for (const k of ['size', 'growth', 'churn']) assert.match(h, new RegExp(`id="code-out-${k}"`));
  assert.match(h, /id="code-out-size"[^]*class="wobar out" data-act="code-file" data-id="engine\/huge\.mjs"/);
  assert.doesNotMatch(h, /class="wobar out" data-act="code-file" data-id="engine\/m\d\.mjs"/);
});

test('K3 Map: the drawn map in an iframe sandboxed to scripts only on /code-map/; none drawn: the not-built text and no iframe', () => {
  const h = code(base({ sub: 'map', map: null }));
  assert.match(h, /id="code-map"[^]*not built yet[^]*norn code map/);
  assert.doesNotMatch(h, /<iframe/);
  const map = { at: '2026-11-24T10:00:00Z', sha: 'abc123def456', tool: '0.11.0', workflow: 'refresh', calls: 2, pct: 0.008, bytes: 2900000, skipped: null };
  const m = code(base({ sub: 'map', map }));
  assert.match(m, /<iframe id="code-map-frame" class="cmap" sandbox="allow-scripts" src="\/code-map\/\?project=kestrel" title="Architecture map \(Floorplan\)" loading="lazy" referrerpolicy="no-referrer"><\/iframe>/);
  assert.match(m, /id="code-map"[^]*abc123def456[^]*Floorplan 0\.11\.0/);
  assert.doesNotMatch(m, /allow-same-origin/);
  const s = code(base({ sub: 'map', map: { ...map, skipped: { at: '2026-11-24T12:00:00Z', sha: 'fff000fff000', why: '~0.06 % > 0.05 % of plan (10 model jobs)' } } }));
  assert.match(s, /refresh skipped at fff000fff000[^]*0\.06 % &gt; 0\.05 %[^]*norn code map/);
});

test('codeLoad: the summary, the open view\'s part (Files: cap, sort, folder) and, with a file open, its part and its source', async () => {
  const asked = [], get = async u => { asked.push(u); return u.includes('part=file&') ? { file: { file: 'engine/a.mjs' } } : u.startsWith('/api/source') ? { text: 'x' } : {}; };
  const d = await codeLoad('kestrel', get, { sub: 'files', sort: 'lines', folder: 'engine/dash', file: 'engine/a.mjs' });
  assert.deepEqual(asked, ['/api/code?project=kestrel', '/api/code?project=kestrel&part=files&limit=40&sort=lines&folder=engine%2Fdash',
    '/api/code?project=kestrel&part=file&file=engine%2Fa.mjs', '/api/source?project=kestrel&file=engine%2Fa.mjs']);
  assert.deepEqual([d.sub, d.file_id, d.file.file, d.source.text], ['files', 'engine/a.mjs', 'engine/a.mjs', 'x']);
  asked.length = 0; const e = await codeLoad('kestrel', async u => { asked.push(u); if (u.startsWith('/api/source')) throw new Error('Not a text file'); return {}; }, { sub: 'bogus', file: 'x.bin' });
  assert.equal(e.sub, 'files'); assert.equal(e.source.error, 'Not a text file');
  asked.length = 0; await codeLoad('kestrel', async u => { asked.push(u); return {}; }, { sub: 'map' });
  assert.deepEqual(asked, ['/api/code?project=kestrel', '/api/code?project=kestrel&part=map']);
});

test('RM-a-70 Files: the rank check line above the table (fix first and importance, as the signals word it); none stored says not built', () => {
  const checks = [{ rank: 'fix_first', status: 'measured', line: '12 of the top 20 fix-first files got a fix in the last 90 days; baseline 9 % of files' },
    { rank: 'importance', status: 'measured', line: '2 of the top 20 importance files got a fix in the last 90 days; baseline 9 % of files: at or under the baseline, the ranking predicted nothing' }];
  const h = code(base({ sub: 'files', list: { ...LIST, checks } }));
  assert.match(h, /<p class="small" id="code-check">rank check: 12 of the top 20 fix-first files got a fix in the last 90 days; baseline 9 % of files · 2 of the top 20 importance files[^<]*at or under the baseline, the ranking predicted nothing<\/p>[^]*id="code-rows"/);
  const na = code(base({ sub: 'files', list: { ...LIST, checks: [{ rank: 'fix_first', status: 'n/a', line: 'fix-first check: n/a (the history starts 2026-06-01: under 180 days)' }] } }));
  assert.match(na, /id="code-check">rank check: fix-first check: n\/a \(the history starts 2026-06-01: under 180 days\)</);
});
