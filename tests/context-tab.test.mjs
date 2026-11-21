// META-UX-BUILD S4: Context = Instructions without the reader and the checks (REPORT s.2, owner DIR-65 "3) A": label + URL renamed,
// the URL says tab=context). Summary of at most 4 numbers + Per role / Per file / Is it growing? / Check-ins per day,
// each its own part, state in the URL; the two standing-context tables are ONE table in Per role; the checks stay reachable from
// one link (not in the default view) until the Slop slice moves them.
// Sandbox only: pure renders, the shared dash fixture (temp dirs, no real ~/.claude) and a private headless browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT_SUBS, contextNumbers, standingRows, INS_PARTS, measuredRows, fileAdvice } from '../engine/dash/insparts.mjs';
import { ctxView, filesOf } from '../engine/dash/pages/context.mjs';
import { TABS, ONE_PROJECT, renderTab, loadTab, loadParts, partsKey } from '../engine/dash/ui.mjs';
import { MORE } from '../engine/dash/shell.mjs';
import { TABS as SERVER_TABS } from '../engine/dash/server.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

const role = (key, runs, t1, extra = {}) => ({ key, role: key.split(' ')[0], family: key.includes('(') ? 'codex' : 'claude', runs, measured: runs, median_turn1: t1, median_create1: 900, median_turns: 30, cache_read: 2.5e6, ...extra });
const split = (total, run) => ({ run, total, parts: [{ key: 'base', label: 'harness base', tokens: total - 1000 }, { key: 'prompt', label: 'the brief', tokens: 1000 }] });
/** an Instructions summary as /api/instructions answers it (no lists) */
function summary() {
  return { project: 'kestrel', at: '2026-11-14T10:00:00Z', method: 'est', sessions: 148, total: 386500, counts: { files: 3, hints: 2, suggest: 1, findings: 4, rules: 5, advisories: 1 },
    standing: [{ key: 'checkin:major', label: 'check-in (major)', sessions: 12, tokens: 30000 }, { key: 'worker:claude:implementer', label: 'worker implementer (claude)', sessions: 7, tokens: 20000 },
      { key: 'worker:codex:implementer', label: 'worker implementer (codex)', sessions: 2, tokens: 22000 }, { key: 'chat', label: 'chat', sessions: 1, tokens: 15000 }],
    measured: { method: 'median of the first request', window_days: 7, roles: [role('worker', 319, 21100), role('merge', 6, 21600), role('checkin', 347, 32800), role('worker (codex)', 10, 25600)],
      parts: { checkin: split(32800, 'r-1'), worker: split(21100, 'r-2'), merge: split(21600, 'r-3') },
      trend: { days: 30, rows: [{ day: '2026-11-09', key: 'checkin', median_turn1: 50000 }, { day: '2026-11-12', key: 'checkin', median_turn1: 40000 }, { day: '2026-11-14', key: 'checkin', median_turn1: 30000 },
        { day: '2026-11-14', key: 'worker', median_turn1: 21100 }] } },
    checkins: [{ day: '2026-11-14', n: 9, mechanical: 5, minor: 3, full: 1 }],
    managed: { files: 3, open: 4, fixed: 0, by_severity: { medium: 4 }, memory: { checkin: 'off', worker: 'off' } },
    memory_map: null, audits: { runs: [], triggers: [], cards: [], rule: { why: 'w', mode: 'manual' }, command: 'norn audit' } };
}
const row = (id, name, load, tokens, extra = {}) => ({ id, name, load, path: `C:/r/${name}`, exists: true, tokens, standing_tokens: tokens, loads_day: 3, loads_today: 2, cost_today: tokens * 2, harness: ['claude'], findings: 0, hints: 0, ...extra });
const ROWS = Array.from({ length: 45 }, (_, i) => row(`f${i}`, `file-${i}.md`, i ? 'on-demand' : 'session', 100 + i));

test('the tab is Context (label + URL id); the API route stays /api/instructions', () => {
  assert.ok(TABS.some(t => t[0] === 'context' && t[1] === 'Context')); assert.ok(!TABS.some(t => t[0] === 'instructions'));
  assert.ok(SERVER_TABS.includes('context') && !SERVER_TABS.includes('instructions'));
  assert.ok(MORE.find(g => g[0] === 'Health')[1].includes('context')); assert.ok(ONE_PROJECT.includes('context'));
  assert.deepEqual(CONTEXT_SUBS.map(x => x[0]), ['role', 'file', 'growing', 'checkins']);
  assert.deepEqual(CONTEXT_SUBS.map(x => x[1]), ['Per role', 'Per file', 'Is it growing?', 'Check-ins per day']);
});

test('4 numbers at most: one check-in, one worker, today by N sessions, the check-in load since the first day of the trend', () => {
  const ns = contextNumbers(summary());
  assert.equal(ns.length, 4);
  assert.deepEqual(ns.map(x => x.n), ['~32.8k', '~21.1k', '~386.5k', '-40 %']);
  assert.match(ns[2].label, /148 sessions/); assert.match(ns[3].label, /since 2026-11-09/);
  assert.equal(ns[3].cls, 'ok', 'shrinking = ok'); assert.equal(ns[3].mark, 'shrinking');
  assert.deepEqual(ns.slice(0, 3).map(x => x.mark), ['medium', 'medium', 'low'], 'a load bubble is marked low / medium / high (today: its mean per session)');
  assert.match(ns[2].label, /~2\.6k each/);
  const bare = contextNumbers({ total: 0, sessions: 0, measured: null });
  assert.equal(bare.length, 4); assert.equal(bare[0].n, '-');
});

test('ONE standing table: each measured role with the per-profile estimates of the same role beneath it', () => {
  const rs = standingRows(summary().measured, summary().standing);
  assert.deepEqual(rs.map(r => r.key), ['worker', 'merge', 'checkin', 'worker (codex)', 'chat']);
  const w = rs.find(r => r.key === 'worker');
  assert.equal(w.measured.median_turn1, 21100); assert.deepEqual(w.profiles.map(p => p.key), ['worker:claude:implementer']);
  assert.deepEqual(rs.find(r => r.key === 'worker (codex)').profiles.map(p => p.key), ['worker:codex:implementer']);
  assert.deepEqual(rs.find(r => r.key === 'checkin').profiles.map(p => p.label), ['check-in (major)']);
  const chat = rs.find(r => r.key === 'chat');
  assert.equal(chat.measured, null, 'an estimate with no measured run keeps its own row'); assert.equal(chat.profiles[0].sessions, 1);
  assert.equal(rs.find(r => r.key === 'merge').profiles.length, 0);
});

test('the default view: 4 numbers, 4 sub-views, Per role = what one session loads + the ONE standing table; no reader, no checks; one link to them', () => {
  const html = renderTab('context', { ...summary(), sub: 'role', parts_loading: false });
  assert.match(html, /id="context-sum"/); assert.equal((html.match(/class="subnum/g) || []).length, 4);
  assert.equal((html.match(/data-act="sub" data-sub="/g) || []).length, 4, 'the 4 sub-view buttons; no footer link (the checks page is reached from Slop)');
  assert.match(html, /class="chip warn submark">medium</, 'each load bubble carries its mark');
  for (const gone of ['context-links', 'context-what', 'ins-count']) assert.doesNotMatch(html, new RegExp(`id="${gone}"`), `${gone} is gone`);
  assert.match(html, /id="context-sub-role"[^>]*aria-pressed="true"/);
  assert.match(html, /id="ins-loads"/); assert.match(html, /id="ctx-roles"/);
  assert.equal((html.match(/<table/g) || []).length, 1, 'the two standing tables are one');
  assert.doesNotMatch(html, /id="ins-standing"/); assert.equal((html.match(/<h3>Standing context/g) || []).length, 1);
  for (const gone of ['ins-table', 'ins-findings', 'ins-ladder', 'ins-hints', 'ins-suggest', 'ins-repeats', 'ins-audits', 'ins-memory', 'ins-managed', 'ins-filemap', 'ins-trend', 'ins-checkins'])
    assert.doesNotMatch(html, new RegExp(`id="${gone}"`), `${gone} is not in the default view`);
  assert.equal((html.match(/<tr class="ctxrole"/g) || []).length, 5, 'one row per role; its launch-profile estimates inside it');
  const many = renderTab('context', { ...summary(), standing: [...summary().standing, { key: 'worker:claude:runner', label: 'worker runner (claude)', sessions: 3, tokens: 5000 }], sub: 'role' });
  assert.match(many, /<td class="num">10<\/td><td class="num"><details class="ctxprofs"><summary>~5\.0k-20\.0k <span class="small mute">2 profiles<\/span><\/summary>[\s\S]*worker runner \(claude\) · 3 today · ~5\.0k/);
});

test('each sub-view is its own part: Per file (count card, file map, most tokens, the files capped), growing, check-ins; the checks page keeps every check', () => {
  const s = summary();
  assert.match(renderTab('context', { ...s, sub: 'file', parts_loading: true }), /id="context-sub-loading"/);
  const file = renderTab('context', { ...s, sub: 'file', limit: 40, rows: ROWS, parts_loading: false });
  assert.doesNotMatch(file, /id="ins-count"/, 'the numbers show once, at the top'); assert.match(file, /id="ins-filemap"/);
  assert.equal((file.match(/<table/g) || []).length, 1, 'Files and the file map are one view: one table under the map');
  assert.equal((file.match(/<tr id="ins-row-/g) || []).length, 40); assert.match(file, /showing 40 of 45/);
  assert.match(file, /data-ins="f0"/, 'a file name opens the Docs reader');
  assert.match(renderTab('context', { ...s, sub: 'growing', parts_loading: false }), /id="ins-trend"/);
  assert.match(renderTab('context', { ...s, sub: 'checkins', parts_loading: false }), /id="ins-checkins"[\s\S]*9<\/b> \(5 mechanical/);
  const checks = renderTab('context', { ...s, sub: 'checks', parts_loading: false, rows: ROWS, findings: [], hints: [], suggest: [], rules: { rules: [], counts: { prose: 0, repeated: 0, enforced: 0, retired: 0 }, cards: [], advisories: [] } });
  for (const id of ['ins-managed', 'ins-findings-card', 'ins-ladder', 'ins-repeats', 'ins-audits', 'ins-memory']) assert.match(checks, new RegExp(`id="${id}"`), id);
  for (const id of ['ins-hints-card', 'ins-suggest-card']) assert.doesNotMatch(checks, new RegExp(`id="${id}"`), `${id} moved to Slop (S5)`);
  assert.match(checks, /data-go="slop" data-gosub="fix"/, 'the hints and tightening candidates: one link to Slop › To fix');
  assert.match(checks, /data-sub="role"/, 'back to Context');
  assert.doesNotMatch(checks, /id="context-subs"/, 'the checks page is no fifth sub-view');
});

test('Per file: the map groups are its filter chips; every block and every name opens Docs; skills + MCP servers are measured rows; "in Slop" opens the finding', () => {
  const s = summary(), mcp = { run: 'chat', total: 3000, parts: [{ key: 'mcp', tokens: 900, items: [{ name: 'mcp__norn__ask', tokens: 600 }, { name: 'mcp__gh__pr', tokens: 200 }, { name: 'MCP Server Instructions', tokens: 100 }] }, { key: 'skills', label: 'skills list', tokens: 1200, items: [] }] };
  const measured = { ...s.measured, parts: { ...s.measured.parts, chat: mcp, worker: { ...s.measured.parts.worker, parts: [...s.measured.parts.worker.parts, { key: 'skills', tokens: 1500, items: [] }] } } };
  assert.deepEqual(measuredRows(measured).map(m => [m.name, m.tokens, m.roles.join(',')]), [['skills list (descriptions)', 1500, 'worker,chat'], ['MCP server norn', 600, 'chat'], ['MCP server gh', 200, 'chat'], ['MCP server instructions', 100, 'chat']]);
  const rows = [row('cm', 'CLAUDE.md', 'session', 3000, { findings: 2, hints: 1, slop: { finding: 'A-1f', hint: 'H-2h' } }), row('od', 'notes.md', 'on-demand', 400, { loads_day: 0, reads: 3 }), row('wk', 'impl.md', 'role', 800, { role: 'worker' }), row('src', 'gen.md', 'source', 50)];
  assert.deepEqual(fileAdvice(rows[0]).filter(a => a.go).map(a => a.finding), ['A-1f', 'H-2h'], 'each advice names the Slop row it opens');
  assert.deepEqual(filesOf(rows, 'top').map(r => r.id), ['cm', 'wk'], 'most tokens per day: the files that cost anything, the most first');
  assert.deepEqual(filesOf(rows, 'on-demand').map(r => r.id), ['od']); assert.deepEqual(filesOf(rows, 'all').map(r => r.id), ['cm', 'wk', 'od'], 'a generator source is not loaded');
  const page = () => renderTab('context', { ...s, measured, sub: 'file', rows, parts_loading: false });
  try {
    ctxView.show = 'all';
    let html = page();
    assert.match(html, /class="fchips ctxshow" role="group" aria-label="Files"/);
    for (const [k, n] of [['session', 5], ['role', 1], ['on-demand', 1], ['top', 2], ['all', 7]]) assert.match(html, new RegExp(`data-act="ctx-show" data-show="${k}" aria-pressed="${k === 'all'}">[^<]+<b>${n}</b>`), k);
    for (const id of ['cm', 'od', 'wk']) { assert.match(html, new RegExp(`class="fmblk[^"]*" data-ins="${id}"[^>]*>[^<]+</button>`), `the ${id} block carries its name`); assert.match(html, new RegExp(`<td><button class="lnk" data-ins="${id}"`)); }
    assert.match(html, /on demand<\/b> <span class="mute">1 file · opened 3x in 30 d/, 'on demand says how often a run opened one, never "0 tokens / day"');
    assert.doesNotMatch(html, /0 tokens \/ day/);
    assert.match(html, /class="fmblk st-measured"[^>]*>MCP server norn</); assert.equal((html.match(/<tr class="ctxmeas"/g) || []).length, 4);
    assert.match(html, /data-go="slop" data-gosub="fix" data-gofinding="A-1f">in Slop/, 'bug 5: the link names its finding');
    ctxView.show = 'top'; html = page();
    assert.equal((html.match(/<tr id="ins-row-/g) || []).length, 2); assert.doesNotMatch(html, /ctxmeas/);
    assert.match(html, /<button class="fmblk st-fresh" data-ins="cm"[^>]*>CLAUDE\.md<\/button>/, 'bug 6: a most-tokens-per-day name opens the file');
    ctxView.show = 'on-demand'; html = page();
    assert.deepEqual([...html.matchAll(/<tr id="ins-row-(\w+)"/g)].map(m => m[1]), ['od']);
  } finally { ctxView.show = 'all'; }
});

test('the loader: the summary alone for Per role / growing / check-ins; the files part for Per file; every list for the checks; keyed by sub', async () => {
  const s = summary(), got = [];
  const get = async u => { got.push(u); return u.includes('part=') ? { rows: ROWS } : s; };
  const d = await loadTab('context', 'kestrel', get, {});
  assert.deepEqual(got, ['/api/instructions?project=kestrel']); assert.equal(d.sub, 'role'); assert.equal(d.parts_loading, false);
  const f = await loadTab('context', 'kestrel', get, { sub: 'file' });
  assert.equal(f.parts_loading, true); assert.equal(f.sub, 'file');
  got.length = 0; await loadParts('context', 'kestrel', f, get);
  assert.deepEqual(got, ['/api/instructions?project=kestrel&part=files']);
  const k = await loadTab('context', 'kestrel', get, { sub: 'checks' });
  got.length = 0; await loadParts('context', 'kestrel', k, get);
  assert.deepEqual(got, INS_PARTS.filter(p => p !== 'hints' && p !== 'suggest').map(p => `/api/instructions?project=kestrel&part=${p}`), 'hints + suggest are Slop rows now (S5)');
  assert.notEqual(partsKey('context', 'kestrel', f), partsKey('context', 'kestrel', k));
  const f2 = await loadTab('context', 'kestrel', get, { sub: 'file', parts: { context: { key: partsKey('context', 'kestrel', f), data: { rows: ROWS } } } });
  assert.equal(f2.parts_loading, false); assert.equal(f2.rows.length, 45);
  assert.equal((await loadTab('context', 'kestrel', get, { sub: 'nope' })).sub, 'role');
});

test('the browser: tab=context opens Context; a sub-view tap is in the URL (Back returns); the phone has no sideways scroll', { skip: skipWhy, timeout: 180000 }, async () => {
  const f = await fixture(); let pg;
  try {
    pg = await openPage([390, 844]);
    await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await pg.go(`${f.url}/?project=kestrel&tab=context`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'context' && !!document.querySelector('#context-subs')`, 90000), 'tab=context opens Context');
    assert.match(await pg.ev('location.search'), /tab=context/);
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll (Per role)');
    await pg.ev(`document.querySelector('#context-sub-file').click()`);
    assert.ok(await pg.until(`!!document.querySelector('#ins-table [data-ins]')`, 60000), 'Per file loads its part');
    assert.match(await pg.ev('location.search'), /sub=file/);
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll (Per file)');
    for (const sub of ['growing', 'checkins']) {
      await pg.ev(`document.querySelector('#context-sub-${sub}').click()`);
      assert.ok(await pg.until(`document.querySelector('#context-sub')?.dataset.sub === '${sub}'`, 30000), sub);
      assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, `no sideways scroll (${sub})`);
    }
    await pg.ev('history.back()');
    assert.ok(await pg.until(`document.querySelector('#context-sub')?.dataset.sub === 'growing'`, 30000), 'Back returns to the sub-view before');
    await pg.ev(`document.querySelector('[data-sub=checks]').click()`);
    assert.ok(await pg.until(`!!document.querySelector('#ins-ladder') && !!document.querySelector('#ins-findings-card')`, 60000), 'the checks stay reachable');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll (checks)');
  } finally { await pg?.close(); await f.done(); }
});
