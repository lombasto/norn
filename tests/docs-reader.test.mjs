// META-UX-BUILD S3: Docs = the one reader (REPORT s.2). The list = the project's docs + every file the ONE instruction scan finds,
// grouped by who loads it, each group capped; a file is its own part; Rendered / Source with each finding beside its paragraph / line;
// a phone shows the list, a tap opens the reader with Back; old Instructions file links land here.
// Sandbox only: pure renders, the shared dash fixture (temp dirs, no real ~/.claude) and a private headless browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DOC_GROUPS, docsList, firstDoc, placeFindings, findingsByLine, docKey } from '../engine/dash/docparts.mjs';
import { renderTab, loadTab, loadParts, partsKey } from '../engine/dash/ui.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

const n = k => Array.from({ length: k }, (_, i) => i);
const row = (id, name, load, kind, extra = {}) => ({ id, name, load, kind, path: `C:/r/${name}`, exists: true, tokens: 100, findings: 0, harness: ['claude'], ...extra });
/** an instruction view as the scan builds it: one row of each kind, a MEMORY.md index + 45 topic files (one in no index) */
function view() {
  const rows = [row('s1', 'CLAUDE.md', 'session', 'repo', { findings: 2 }), row('s2', 'AGENTS.md', 'session', 'user', { where: 'home', harness: ['codex'] }),
    row('c1', 'CHECKIN.md', 'checkin', 'prompt'), row('h1', 'CHAT.md', 'chat', 'prompt'), row('r1', 'impl.md', 'role', 'agent', { role: 'implementer' }),
    row('o1', 'common-rules.txt', 'on-demand', 'rules'), row('m0', 'MEMORY.md', 'session', 'memory'),
    ...n(45).map(i => row(`t${i}`, `topic-${i}.md`, 'on-demand', 'memory-topic')), row('k1', 'SKILL.md', 'session', 'skill'), row('x1', 'gen.md', 'source', 'agent-source'),
    row('p1', 'PLAN.md', 'on-demand', 'repo')];
  return { rows, findings: [{ id: 'A-1', path: 'C:/r/CLAUDE.md', line: 3, severity: 'medium', why: 'a never line nothing enforces' }, { id: 'A-2', path: 'C:/r/ROADMAP.md', line: 2, severity: 'low', why: 'x' }],
    memory_map: { lines: 69, kb: 12.9, max_lines: 200, max_kb: 25, topics: n(45).map(i => ({ id: `t${i}`, name: `topic-${i}.md`, linked: i === 7 ? 0 : 1 })), orphans: [{ id: 't7' }], broken: [] } };
}
const DOCS = [{ i: 0, tab: 'Plan', path: 'C:/r/PLAN.md', exists: true }, { i: 1, tab: 'Roadmap', path: 'C:/r/ROADMAP.md', exists: true }, { i: 2, tab: 'Gone', path: 'C:/r/gone.md', exists: false }];

test('the list: project docs + every scanned file, grouped by who loads it, each group capped with its count; the Memory group carries the gauge', () => {
  const l = docsList({ v: view(), docs: DOCS });
  assert.equal(l.files, 55 + 2, 'every scanned file + the project docs the scan does not list (PLAN.md shows once)');
  assert.deepEqual(l.groups.map(g => g.id), ['session', 'checkin', 'chat', 'role', 'on-demand', 'memory', 'skills', 'source', 'project']);
  assert.deepEqual(l.groups.map(g => g.label), DOC_GROUPS.map(x => x[1]));
  const g = id => l.groups.find(x => x.id === id);
  assert.deepEqual(g('session').rows.map(r => [r.key, r.findings, r.note]), [['s1', 2, ''], ['s2', 0, 'user, codex']]);
  assert.equal(g('role').rows[0].note, 'role implementer');
  assert.equal(g('memory').n, 46); assert.equal(g('memory').rows.length, 40, 'capped (SUB_CAP)');
  assert.equal(g('memory').rows[0].key, 'm0', 'the index first'); assert.equal(g('memory').rows.find(r => r.key === 't7').linked, 0);
  assert.deepEqual(g('on-demand').rows.map(r => r.key), ['o1', 'p1'], 'a project doc the scan lists stays in its load group');
  assert.deepEqual(g('project').rows.map(r => [r.key, r.findings, r.exists]), [[docKey(1), 1, true], [docKey(2), 0, false]], 'findings count by path on a project doc');
  assert.deepEqual(l.memory, { lines: 69, kb: 12.9, max_lines: 200, max_kb: 25, topics: 45, orphans: 1, broken: 0 });
  assert.equal(docsList({ v: view(), docs: DOCS, limit: 80 }).groups.find(x => x.id === 'memory').rows.length, 46);
  assert.equal(firstDoc(l), 's1');
  const pending = docsList({ v: null, docs: DOCS });
  assert.deepEqual(pending.groups.map(x => x.id), ['project'], 'before the first scan lands: the project docs');
});

test('findings sit beside their paragraph (Rendered) or line (Source); no line = about the whole file', () => {
  const paras = [{ anchor: 'pa', line: 1, end: 2 }, { anchor: 'pb', line: 4, end: 6 }];
  const fs = [{ id: 1, line: 5 }, { id: 2, line: 3 }, { id: 3 }, { id: 4, line: 1 }];
  const p = placeFindings(paras, fs);
  assert.deepEqual(p.at.get('pb').map(x => x.id), [1]); assert.deepEqual(p.at.get('pa').map(x => x.id), [2, 4], 'a blank line between: the paragraph before');
  assert.deepEqual(p.whole.map(x => x.id), [3]);
  const b = findingsByLine(fs, 6);
  assert.deepEqual([...b.at.keys()].sort(), [1, 3, 5]); assert.deepEqual(b.whole.map(x => x.id), [3]);
});

const FILE = { key: 's1', name: 'CLAUDE.md', path: 'C:/r/CLAUDE.md', load: 'session', tokens: 1234, lines: 7, text: '# Rules\n\nNever push to main.\n\nRun the tests.\n\nEnd.',
  paras: [{ anchor: 'p1', line: 1, end: 1, age_days: 2, changed: '2026-11-12T00:00:00Z' }, { anchor: 'p3', line: 3, end: 3, age_days: 70, stale: true, changed: '2026-09-01T00:00:00Z' }, { anchor: 'p5', line: 5, end: 5 }, { anchor: 'p7', line: 7, end: 7 }],
  findings: [{ id: 'A-1', check: 14, line: 3, severity: 'medium', surface: 'emphasis density', why: 'a never line nothing enforces', fix: { action: 'bind it with a hook', kind: 'call', ways: ['Bind it with a hook or gate', 'Accept it as prose'] } },
    { id: 'A-3', check: 15, line: 3, severity: 'low', surface: 'dated-model phrases', why: 'names a dated model', fix: { action: 'drop the date', kind: 'drafts' } },
    { id: 'A-9', check: 16, severity: 'low', surface: 'history in an always-loaded file', why: 'history in an always-loaded file', fix: { action: 'move it', kind: 'drafts', tier: 'flag' } }] };

test('the Docs page: the grouped list beside the reader; line numbers in the gutter, a line\'s findings one gutter marker whose popover names each rule and sends it to the fixer', () => {
  const l = docsList({ v: view(), docs: DOCS });
  const base = { project: 'kestrel', ...l, pending: false, sig: 's', limit: 40, file: 's1', picked: false, doc: FILE, parts_loading: false };
  const html = renderTab('docs', base, { project: 'kestrel' });
  for (const id of ['docs-list', 'docs-reader', 'docs-g-session', 'docs-g-memory', 'docs-memory', 'docs-head', 'docs-mode', 'doc-body', 'doc-toc', 'doc-file-findings', 'docf-s1']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(!/lists no docs/.test(html));
  assert.match(html, /57 files/);
  assert.match(html, /id="docf-s1"[^>]*data-docfile="s1" aria-current="true"/);
  assert.match(html, /docs-g-memory[^]*showing 40 of 46[^]*data-act="sub-more"/);
  assert.match(html, /id="ins-p3"><div class="dgut"><span class="dln gage-old" title="70 d old[^"]*STALE">3<\/span><details class="dmark"><summary class="chip warn" aria-label="2 findings on line 3">2<\/summary><div class="dpop"[^>]*>[^]*<b>emphasis density<\/b> <span class="small mute">line 3 · check 14[^]*a never line nothing enforces[^]*Fix:<\/span> bind it with a hook/, 'the gutter: the line number (coloured by its age), then one marker for the line');
  assert.match(html, /<\/details><\/div><div class="docptext"><p>Never push to main\.<\/p>\s*<\/div><\/div>/, 'the text itself carries no line number and no finding');
  assert.doesNotMatch(html, /<aside class="docfind">|class="small mute">L\d/, 'nothing inline any more');
  assert.match(html, /data-act="doc-fix" data-id="A-1" data-way="Bind it with a hook or gate"[^]*data-act="doc-fix" data-id="A-1" data-way="Accept it as prose"/, 'your call: one button per way');
  assert.match(html, /data-act="doc-fix" data-id="A-3"[^>]*>Send to the fixer</, 'a drafts finding: one button');
  assert.doesNotMatch(html, /data-act="doc-fix" data-id="A-9"/, 'a finding outside the project (tier flag) has no button');
  assert.match(html, /id="ins-strip"[^]*loaded whole with every session: ~0 loads a day/, 'bug 4: an always-loaded file is read on every load');
  assert.doesNotMatch(html, /read 0x/);
  assert.match(html, /id="doc-file-findings"[^]*history in an always-loaded file/, 'a finding with no line: about the whole file');
  assert.match(html, /data-act="doc-view" data-view="md" aria-pressed="true"/);
  assert.match(html, /data-act="doc-back"/);
  assert.match(html, /<h1 id="rules">Rules<\/h1>/);
  const src = renderTab('docs', { ...base, src: true }, { project: 'kestrel' });
  assert.match(src, /id="doc-src"/); assert.match(src, /id="docl-3"[^>]*><td class="ln mute"><details class="dmark">[^]*<\/details>3<\/td><td class="lt"><code>Never push to main\.<\/code><\/td><\/tr>/, 'Source: the marker beside the line number, no third column');
  assert.match(src, /data-view="src" aria-pressed="true"/);
  assert.match(renderTab('docs', { ...base, doc: null, parts_loading: true }, {}), /id="docs-loading"/);
  assert.match(renderTab('docs', { ...base, picked: true }, {}), /class="docsplit picked"/, 'a picked file: the phone shows the reader');
  assert.match(renderTab('docs', { ...base, file: null, doc: null }, {}), /id="docs-none"/, 'a phone with no pick: the list only, no file fetched');
  assert.match(renderTab('docs', { ...base, line: 3 }, {}), /id="ins-p3"[^>]*|focus" data-focus="1" id="ins-p3"/);
  assert.match(renderTab('docs', { ...base, line: 3 }, {}), /docpara stale hasfind focus" data-focus="1" id="ins-p3"/, 'a link with a line lands on its paragraph');
});

test('GET /api/docs: the grouped list from the one scan (pending at first); ?part=file opens one file with its paragraphs and findings; the loader', { timeout: 180000 }, async () => {
  const f = await fixture();
  try {
    const get = async r => { const x = await f.get(r); if (x.status !== 200) throw new Error(`${r}: ${x.status}`); return x.data; };
    let d = await get('/api/docs?project=kestrel');
    for (let i = 0; d.pending && i < 1200; i++) { await new Promise(r => setTimeout(r, 100)); d = await get('/api/docs?project=kestrel'); }
    assert.ok(d.sig && Number.isInteger(d.files) && d.files >= 3, JSON.stringify(d).slice(0, 300));
    const project = d.groups.find(g => g.id === 'project');
    assert.deepEqual(project.rows.map(r => [r.key, r.name, r.exists]), [['doc-0', 'Plan', true], ['doc-1', 'Missing', false]]);
    assert.ok(d.groups.some(g => g.id === 'checkin'), 'the scan files join the list');
    const withF = d.groups.flatMap(g => g.rows).find(r => r.findings);
    const file = (await get(`/api/docs?project=kestrel&part=file&file=${withF.key}`)).doc;
    assert.equal(file.key, withF.key); assert.ok(file.paras.length && file.text.length);
    assert.equal(file.findings.length >= withF.findings, true);
    const placed = placeFindings(file.paras, file.findings);
    assert.ok(placed.at.size > 0, 'a finding of the real scan sits beside a paragraph');
    const plan = (await get('/api/docs?project=kestrel&part=file&file=doc-0')).doc;
    assert.match(plan.text, /step one/); assert.equal(plan.paras[0].line, 1);
    assert.equal((await f.get('/api/docs?project=kestrel&part=file&file=doc-1')).status, 404, 'a missing doc');
    assert.equal((await f.get('/api/docs?project=kestrel&part=file&file=nope')).status, 404);
    assert.equal((await f.get('/api/docs?project=kestrel&part=nope')).status, 400);
    const t = await loadTab('docs', 'kestrel', get, { wide: true });
    assert.equal(t.file, firstDoc(t)); assert.equal(t.parts_loading, true);
    const parts = await loadParts('docs', 'kestrel', t, get);
    const t2 = await loadTab('docs', 'kestrel', get, { wide: true, parts: { docs: { key: partsKey('docs', 'kestrel', t), data: parts } } });
    assert.equal(t2.parts_loading, false); assert.equal(t2.doc.key, t.file);
    const phone = await loadTab('docs', 'kestrel', get, {});
    assert.equal(phone.file, null, 'a phone with no file in the URL: the list only'); assert.equal(phone.parts_loading, false);
  } finally { await f.done(); }
});

test('the phone: the list, a tap opens the reader with Back (pushed), Back returns; an Instructions file link lands on the Docs reader', { skip: skipWhy, timeout: 180000 }, async () => {
  const f = await fixture(); let pg;
  try {
    pg = await openPage([390, 844]);
    await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    const shown = sel => `(() => { const e = document.querySelector('${sel}'); return !!e && e.getClientRects().length > 0; })()`;
    await pg.go(`${f.url}/?project=kestrel&tab=docs`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'docs' && document.querySelector('#docs-g-checkin')`, 90000), 'the scan files are listed');
    assert.ok(await pg.ev(shown('#docs-list'))); assert.ok(!(await pg.ev(shown('#docs-reader'))), 'the phone shows the list first');
    const key = await pg.ev(`document.querySelector('#docs-g-checkin [data-docfile]').dataset.docfile`);
    await pg.ev(`document.querySelector('#docs-g-checkin [data-docfile]').click()`);
    assert.ok(await pg.until(`document.querySelector('#doc-body') && document.querySelector('.docsplit.picked')`, 60000), 'the reader');
    assert.ok(!(await pg.ev(shown('#docs-list'))), 'the reader replaces the list'); assert.ok(await pg.ev(shown('[data-act=doc-back]')));
    assert.match(await pg.ev('location.search'), new RegExp(`[?&]doc=${key}`));
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll (reader)');
    await pg.ev(`document.querySelector('[data-act=doc-view][data-view=src]').click()`);
    assert.ok(await pg.until(`!!document.querySelector('#doc-src')`, 20000), 'Source');
    await pg.ev(`document.querySelector('[data-act=doc-back]').click()`);
    assert.ok(await pg.until(`!document.querySelector('.docsplit.picked') && ${shown('#docs-list')}`, 20000), 'Back: the list');
    await pg.ev('history.back()');
    assert.ok(await pg.until(`!!document.querySelector('.docsplit.picked #docs-head')`, 20000), 'browser Back: the file again');
    await pg.go(`${f.url}/?project=kestrel&tab=context&sub=file`);   // Context, Per file
    assert.ok(await pg.until(`!!document.querySelector('#ins-table [data-ins]:not([disabled])')`, 60000));
    await pg.ev(`document.querySelector('#ins-table [data-ins]:not([disabled])').click()`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'docs' && !!document.querySelector('.docsplit.picked #docs-head')`, 60000), 'a Context file link opens the Docs reader');
    assert.match(await pg.ev('location.search'), /tab=docs&doc=/);
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll (list)');
  } finally { await pg?.close(); await f.done(); }
});
