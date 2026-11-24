// NORN-DASH-1123-SHELL (SPEC dash-owner-1123 s.5, 6, 7, 9, 10): the wiring lane - Talk becomes Controller (one name: label, id, URL), the
// Tests and Code pages wired and served, /api/source (was /api/tests/source), the close icon on every drawer, home names saved and shown,
// the header's per-project running / cap / reserve (never the machine sum), and the queue entries' agent + priority.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, ENGINE } from './helpers/dash-fixture.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { TABS, ONE_PROJECT, loadTab, renderTab } from '../engine/dash/ui.mjs';
import { BAR, MORE, PAGE_KEYS, routeTab, renderStatus, renderBar } from '../engine/dash/shell.mjs';
import { TABS as SERVER_TABS } from '../engine/dash/server.mjs';
import { threadOnly } from '../engine/dash/home.mjs';
import { poolLine } from '../engine/dash/widgets.mjs';
import { ledgerConfig } from '../engine/lib/ledger.mjs';
import { fedOf } from '../engine/lib/claimsref.mjs';
import { registerHome } from '../engine/lib/claims.mjs';

const DASH = path.join(ENGINE, 'dash');
const raw = (url, p) => new Promise((ok, no) => http.get(url + p, { agent: false }, r => { let t = ''; r.setEncoding('utf8'); r.on('data', c => { t += c; }); r.on('end', () => ok({ status: r.statusCode, text: t })); }).on('error', no));

test('N1-N3: one name Controller - TABS, BAR, PAGE_KEYS and the server TABS hold controller and none holds talk; ?tab=talk opens Lanes; the page renders the thread', async () => {
  for (const [what, ids] of [['ui TABS', TABS.map(t => t[0])], ['BAR', BAR.map(b => b[0])], ['server TABS', SERVER_TABS], ['PAGE_KEYS', Object.keys(PAGE_KEYS)], ['ONE_PROJECT', ONE_PROJECT]]) {
    assert.ok(ids.includes('controller'), `${what} holds controller`); assert.ok(!ids.includes('talk'), `${what} holds no talk`);
  }
  assert.deepEqual(TABS[0], ['controller', 'Controller']); assert.deepEqual(BAR[0], ['controller', 'Controller']);
  assert.equal(routeTab('talk'), 'lanes'); assert.equal(routeTab('controller'), 'controller');
  assert.match(renderBar('controller', { project: 'kestrel' }), /id="tab-controller" data-tab="controller" aria-current="page"><svg[^]*?<span class="bl">Controller<\/span>/);
  const seen = [], d = await loadTab('controller', 'kestrel', async p => { seen.push(p); return { project: 'kestrel', events: [] }; });
  assert.deepEqual(seen, ['/api/home?project=kestrel']);
  assert.match(renderTab('controller', d, { project: 'kestrel' }), /<div id="panel-controller">[^]*id="thread"/);
  assert.equal(threadOnly(['chat'], 'controller'), true); assert.equal(threadOnly(['chat'], 'talk'), false);
  const html = fs.readFileSync(path.join(DASH, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /'talk'|tab=talk/, 'index.html names the page controller everywhere');
});

test('K5: ?tab=code routes (More > Health after Tests); /api/code serves its parts, /api/source a repo file, /api/tests/source is a 404; the pages and sheets are served', async () => {
  assert.equal(routeTab('code'), 'code'); assert.deepEqual(TABS.find(t => t[0] === 'code'), ['code', 'Code']); assert.ok(SERVER_TABS.includes('code'));
  assert.deepEqual(MORE[0][1].slice(MORE[0][1].indexOf('tests'), MORE[0][1].indexOf('tests') + 2), ['tests', 'code']);
  assert.deepEqual(PAGE_KEYS.code, ['derived']);
  const f = await fixture();
  try {
    const s = await f.get('/api/code?project=kestrel');
    assert.equal(s.status, 200); assert.equal(s.data.project, 'kestrel'); assert.equal(s.data.index, null);
    assert.deepEqual((await f.get('/api/code?project=kestrel&part=files')).data, { list: null });
    const src = await f.get('/api/source?project=kestrel&file=PLAN.md');
    assert.equal(src.status, 200); assert.equal(src.data.file, 'PLAN.md'); assert.match(src.data.text, /step one/);
    assert.equal((await f.get('/api/source?project=kestrel&file=..%2Fescape')).status, 403);
    assert.equal((await f.get('/api/tests/source?project=kestrel&file=PLAN.md')).status, 404, 'no alias for the old route');
    for (const p of ['/pages/tests.mjs', '/pages/code.mjs', '/css/tests.css', '/css/code.css']) assert.equal((await raw(f.url, p)).status, 200, p);
    const d = await loadTab('code', 'kestrel', async p => (await f.get(p)).data);
    assert.match(renderTab('code', d, {}), /<div id="panel-code">[^]*No code index yet/);
    const html = fs.readFileSync(path.join(DASH, 'index.html'), 'utf8');
    for (const css of ['/css/tests.css', '/css/code.css']) assert.match(html, new RegExp(`<link rel="stylesheet" href="${css}">`));
    assert.doesNotMatch(html, /\/api\/tests\/source/); assert.match(html, /\/api\/source\?/);
  } finally { await f.done(); }
});

test('Tests wired: the &case= param reaches testsPart (the case part), the Suite part takes sort and q; ui.mjs renders through pages/tests.mjs', async () => {
  const f = await fixture(), T = path.join(f.pa.state, 'tests');
  fs.mkdirSync(T, { recursive: true });
  const c = id => ({ id, file: 'tests/a.test.mjs', name: id.split('::')[1], line: 3, span: 2 });
  fs.writeFileSync(path.join(T, 'cases.json'), JSON.stringify({ at: '2026-11-23T10:00:00Z', sha: 'abc', files: { 'tests/a.test.mjs': {} }, cases: [c('tests/a.test.mjs::alpha one'), c('tests/a.test.mjs::beta two')] }));
  try {
    const one = await f.get(`/api/tests?project=kestrel&part=case&case=${encodeURIComponent('tests/a.test.mjs::beta two')}`);
    assert.equal(one.status, 200); assert.equal(one.data.case?.name, 'beta two', 'the case id reaches testsPart');
    const l = (await f.get('/api/tests?project=kestrel&part=suite&sort=file&q=alpha')).data.list;
    assert.equal(l.sort, 'file'); assert.equal(l.q, 'alpha'); assert.deepEqual(l.rows.map(r => r.name), ['alpha one']);
    const d = await loadTab('tests', 'kestrel', async p => (await f.get(p)).data, { case: 'tests/a.test.mjs::beta two' });
    assert.equal(d.case?.name, 'beta two');
    assert.match(renderTab('tests', d, {}), /<div id="panel-tests">[^]*id="tests-case"/);
  } finally { await f.done(); }
  const ui = fs.readFileSync(path.join(DASH, 'ui.mjs'), 'utf8');
  assert.doesNotMatch(ui, /function testsSuite|const TESTS_PART/, 'the old Tests renderers are gone from ui.mjs');
  const html = fs.readFileSync(path.join(DASH, 'index.html'), 'utf8');
  assert.match(html, /q\.get\('case'\)/); assert.match(html, /&case=/);
});

test('H5: POST /api/sync/name names a home on the claims ref; /api/strip then carries home_names; a bad name is refused', async () => {
  const remote = path.join(mkTmp('shell-names-remote-'), 'remote.git').split(path.sep).join('/');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', remote], { windowsHide: true }).status, 0);
  const t = mkTmp('shell-names-'), ledgerDir = path.join(t, 'ledger.git').split(path.sep).join('/');
  let f;
  try {
    f = await fixture({ synced: true, dash: { machine: { home: t, ledger: { dir: ledgerDir, remote } } } });
    const m = { ledger: { dir: ledgerDir, state_root: path.dirname(f.pa.state), remote } };
    const cfg = ledgerConfig(m, { metaRoot: f.root });
    assert.equal(registerHome(fedOf(cfg), { id: 'a', projects: ['kestrel'], now: Date.now() }).ok, true);
    assert.equal(registerHome(fedOf(cfg), { id: 'b', projects: ['kestrel'], now: Date.now() }).ok, true);
    const r = await f.post('/api/sync/name', { project: 'kestrel', home: 'b', name: ' Laptop ' });
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.ok, true); assert.deepEqual(r.data.names, { b: 'Laptop' });
    assert.deepEqual((await f.get('/api/strip?project=kestrel')).data.home_names, { b: 'Laptop' });
    const bad = await f.post('/api/sync/name', { project: 'kestrel', home: 'b', name: 'no<script>' });
    assert.equal(bad.status, 400, JSON.stringify(bad.data));
  } finally { await f?.done(); }
});

test('W1-W4: the strip shows the page project\'s running / cap / reserve, never the machine sum; the merge slot reserved; the pool says "not counted"', async () => {
  const s = { running: { claude: { n: 3, cap: 8 }, merge: { n: 1, cap: 1, reserved: true }, codex: { n: 0, cap: 2 }, share: { reserve: 2, ceiling: null } }, usage: {}, checkin: {}, needs_you: 0 };
  const html = renderStatus(s, { project: 'kestrel', now: 0 });
  assert.match(html, /kestrel: <b>3 running<\/b> · cap any · reserve 2/, 'W2: reserve 2, no ceiling = any');
  assert.doesNotMatch(html, /\/ 10\b|\/ 11\b/, 'W1: no claude cap + codex cap sum');
  assert.match(html, /merge <b>1<\/b> \/ 1 reserved/, 'W4: the merge slot as reserved');
  assert.match(renderStatus({ ...s, running: { ...s.running, share: { reserve: 0, ceiling: 3 } } }, { project: 'kestrel' }), /kestrel: <b>3 running<\/b> · cap 3 · reserve 0/);
  assert.match(poolLine({ claude: { using: 5, cap: 8 }, sessions: null }, s.running), /not counted/, 'W3');
  const f = await fixture();
  try {
    const b = JSON.parse(fs.readFileSync(f.budgetFile, 'utf8'));
    fs.writeFileSync(f.budgetFile, JSON.stringify({ ...b, project_workers: { kestrel: { reserve_claude_workers: 2 } } }));
    const r = (await f.get('/api/strip?project=kestrel')).data.running;
    assert.deepEqual(r.share, { reserve: 2, ceiling: null }, 'no project ceiling = null (any)');
    assert.equal(r.merge.reserved, true);
  } finally { await f.done(); }
  assert.match(fs.readFileSync(path.join(DASH, 'index.html'), 'utf8'), /poolLine\(ov\.pool \?\? null, ov\.running\)/);
});

test('queue entries carry agent and priority', async () => {
  const f = await fixture(), { record } = await import('../engine/lib/records.mjs');
  try {
    record(f.pa.state, { kind: 'run', ev: 'queue', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'gen', priority: 'P1', agent: 'kestrel-implementer' } });
    const q = (await f.get('/api/agents?project=kestrel&part=live')).data.queue.find(x => x.lane === 'gen');
    assert.equal(q.agent, 'kestrel-implementer'); assert.equal(q.priority, 'P1');
  } finally { await f.done(); }
});

test('no text "Close" button is left in engine/dash: every drawer closes with closeBtn (the icon)', () => {
  const files = fs.readdirSync(DASH, { recursive: true }).filter(x => /\.(mjs|html)$/.test(x) && !String(x).startsWith('vendor'));
  const hits = files.flatMap(x => (fs.readFileSync(path.join(DASH, x), 'utf8').match(/<button[^>]*>\s*Close\s*<\/button>/g) || []).map(m => `${x}: ${m}`));
  assert.deepEqual(hits, []);
  const html = fs.readFileSync(path.join(DASH, 'index.html'), 'utf8');
  for (const id of ['srcview-close', 'dlv-close', 'rmed-close', 'dvpip-close']) assert.match(html, new RegExp(`data-close="id=&quot;${id}&quot;"`), id);
  assert.match(html, /closeBtn\(/);
  assert.match(fs.readFileSync(path.join(DASH, 'pages', 'spend.mjs'), 'utf8'), /closeBtn\(/);
});
