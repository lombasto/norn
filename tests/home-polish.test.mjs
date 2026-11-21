// META-HOME-POLISH R1 (DIR-17 follow-up): the chat Home reads at a glance. A check-in event is ONE line built from the record facts
// the check-in wrote (reviewed runs, DECs ruled, runs dispatched, questions asked, "nothing to rule"), never the ledger prose; a tap
// expands the full ledger text. The Home opens on the viewer's last pick, else the first project that needs you, else the first one.
// A live chat line repaints only the thread (no /api/overview, no page). The README's picture is the Home.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { homeEvents, renderThread, checkinFacts, checkinLine, pickProject, threadOnly } from '../engine/dash/home.mjs';
import { parseLedgerLine } from '../engine/dash/ledger.mjs';
import { record } from '../engine/lib/records.mjs';
import { ENGINE, fixture } from './helpers/dash-fixture.mjs';
import { dashCss } from './helpers/dash-css.mjs';

const T = m => new Date(Date.parse('2026-11-13T14:00:00.000Z') + m * 60000).toISOString().replace(/\.\d+Z$/, 'Z');
let seq = 0;
const h = (ev, ts, by, run, data = {}) => ({ seq: ++seq, ts, ev, by, run, data });
// synthetic items in the shape of the records fold of real check-ins: run review / landed / start / queue events and DEC / Q creates
// carry run = the check-in's RUN id (the launcher stamps a dispatched run's start with its parent check-in)
const ITEMS = [
  { id: 'RUN-40', kind: 'run', state: 'exited', data: { kind: 'checkin', lane: 'checkin' }, history: [h('start', T(0), 'launcher', null), h('end', T(2), 'launcher', null, { outcome: 'done' })] },
  { id: 'RUN-31', kind: 'run', state: 'exited', data: { kind: 'worker', lane: 'tide-api' }, history: [h('start', T(-60), 'launcher', null), h('end', T(-5), 'launcher', null), h('review', T(1), 'checkin', 'RUN-40', { refs: ['DEC-9'] })] },
  { id: 'RUN-33', kind: 'run', state: 'exited', data: { kind: 'codex', lane: 'charts' }, history: [h('start', T(-50), 'launcher', null), h('end', T(-4), 'launcher', null), h('review', T(1), 'checkin', 'RUN-40'), h('landed', T(1), 'checkin', 'RUN-40', { sha: 'abc1234' })] },
  { id: 'RUN-38', kind: 'run', state: 'exited', data: { kind: 'checkin', lane: 'checkin' }, history: [h('start', T(-20), 'launcher', null), h('review', T(1), 'checkin', 'RUN-40')] },
  { id: 'DEC-9', kind: 'decision', state: 'active', data: { question: 'q', choice: 'c' }, history: [h('create', T(1), 'checkin', 'RUN-40')] },
  { id: 'Q-4', kind: 'question', state: 'open', data: { title: 't' }, history: [h('create', T(1), 'checkin', 'RUN-40')] },
  { id: 'RUN-41', kind: 'run', state: 'running', data: { kind: 'worker', lane: 'charts' }, history: [h('start', T(1.5), 'launcher', 'RUN-40')] },
  { id: 'RUN-42', kind: 'run', state: 'queued', data: { kind: 'worker', lane: 'tide-api' }, history: [h('queue', T(1.6), 'launcher', 'RUN-40')] },
  // a later check-in that only looked
  { id: 'RUN-50', kind: 'run', state: 'exited', data: { kind: 'checkin', lane: 'checkin' }, history: [h('start', T(15), 'launcher', null), h('end', T(16), 'launcher', null)] },
  // an earlier decision by someone else: not this check-in's
  { id: 'DEC-8', kind: 'decision', state: 'active', data: {}, history: [h('create', T(-30), 'controller', null)] },
];
const PROSE = 'DIR-3 (owner: keep the API stable) -> reviewed RUN-31 tide-api DONE (DLV-2) and RUN-33 charts DONE; a long paragraph of rationale nobody reads at a glance';

test('checkinFacts: the records one check-in run wrote, grouped (reviewed / ruled / dispatched / asked / landed); a check-in reviewing a check-in is not counted', () => {
  assert.deepEqual(checkinFacts('RUN-40', ITEMS), { reviewed: ['RUN-31', 'RUN-33'], ruled: ['DEC-9'], dispatched: ['RUN-41', 'RUN-42'], asked: ['Q-4'], landed: ['RUN-33'] });
  assert.deepEqual(checkinFacts('RUN-50', ITEMS), { reviewed: [], ruled: [], dispatched: [], asked: [], landed: [] });
  assert.deepEqual(checkinFacts('RUN-99', []), { reviewed: [], ruled: [], dispatched: [], asked: [], landed: [] });
});

test('checkinLine: one short line from the facts; "nothing to rule" when the check-in wrote nothing; long id lists are cut with +n', () => {
  assert.equal(checkinLine(checkinFacts('RUN-40', ITEMS)), 'reviewed RUN-31, RUN-33 · ruled DEC-9 · dispatched RUN-41, RUN-42 · asked Q-4 · landed RUN-33');
  assert.equal(checkinLine(checkinFacts('RUN-50', ITEMS)), 'nothing to rule');
  assert.equal(checkinLine({ reviewed: ['RUN-1', 'RUN-2', 'RUN-3', 'RUN-4', 'RUN-5'], ruled: [], dispatched: [], asked: [], landed: [] }), 'reviewed RUN-1, RUN-2, RUN-3 +2');
  assert.equal(checkinLine(null), null, 'no check-in run found: no facts line');
});

test('homeEvents: a check-in ledger line is matched to the check-in run that wrote it (minute-precise ledger time) and carries its facts line + the full text', () => {
  const runs = ITEMS.filter(i => i.kind === 'run');
  const ledger = [parseLedgerLine(`- meta ${T(2).slice(0, 16)}Z: ${PROSE}`), parseLedgerLine(`- meta ${T(16).slice(0, 16)}Z: idle pass; records none new`),
    parseLedgerLine(`- meta ${T(40).slice(0, 16)}Z: a pass with no run record`)];
  const ev = homeEvents({ runs, items: ITEMS, ledger }).filter(e => e.kind === 'checkin');
  assert.deepEqual(ev.map(e => [e.ckrun, e.line]), [['RUN-40', 'reviewed RUN-31, RUN-33 · ruled DEC-9 · dispatched RUN-41, RUN-42 · asked Q-4 · landed RUN-33'],
    ['RUN-50', 'nothing to rule'], [null, null]]);
  assert.equal(ev[0].headline, PROSE.split('; ')[0], 'the full text stays on the item (for the expand)');
});

test('renderThread: the check-in is ONE line (never the ledger prose) that expands to the full text; the open state round-trips through a repaint; same markup on the phone', () => {
  const runs = ITEMS.filter(i => i.kind === 'run');
  const ev = homeEvents({ runs, items: ITEMS, ledger: [parseLedgerLine(`- meta ${T(2).slice(0, 16)}Z: ${PROSE}`), parseLedgerLine(`- meta ${T(40).slice(0, 16)}Z: ${PROSE}`)] });
  const html = renderThread(ev, { project: 'tidewatch' });
  const lis = [...html.matchAll(/<li class="ev ev-checkin[^"]*"[^>]*data-key="([^"]+)">([\s\S]*?)<\/li>/g)];
  assert.equal(lis.length, 2);
  for (const [, , li] of lis) {
    const sum = li.match(/<summary[^>]*>([\s\S]*?)<\/summary>/);
    assert.ok(sum, 'a <details> whose <summary> is the one line (tap / click expands, no script)');
    const text = sum[1].replace(/<[^>]+>/g, '');
    assert.ok(!text.includes('rationale') && !text.includes('DIR-3'), `the line is never the ledger prose: ${text}`);
    assert.match(li.slice(li.indexOf('</summary>')), /a long paragraph of rationale/, 'the full ledger text is in the expanded part');
    assert.ok(!/<details[^>]* open/.test(li), 'closed by default');
  }
  const first = lis[0][2].match(/<summary[^>]*>([\s\S]*?)<\/summary>/)[1].replace(/<[^>]+>/g, '');
  assert.match(first, /^check-in RUN-40 · \d\d:\d\d · reviewed RUN-31, RUN-33 · ruled DEC-9/);
  assert.match(lis[1][2].match(/<summary[^>]*>([\s\S]*?)<\/summary>/)[1].replace(/<[^>]+>/g, ''), /^check-in · \d\d:\d\d · no run record$/);
  // the expand survives a repaint: the client keeps the open keys and hands them back
  const key = lis[0][1], again = renderThread(ev, { project: 'tidewatch', open: new Set([key]) });
  assert.match(again, new RegExp(`data-key="${key}"><details class="ck" open>`));
  assert.ok(!new RegExp(`data-key="${lis[1][1]}"><details class="ck" open>`).test(again));
  const idx = fs.readFileSync(path.join(ENGINE, 'dash', 'index.html'), 'utf8');
  assert.match(idx, /details\.ck\[open\]/, 'homeKeep collects the open check-in keys');
  assert.match(idx, /open: S\.homeOpen/, 'and every thread paint hands them back');
  const css = dashCss();
  for (const m of css.matchAll(/@media \(max-width[^{]*\{/g)) { let i = m.index + m[0].length, depth = 1; while (depth && i < css.length) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; i++; }
    const blk = css.slice(m.index, i);
    assert.ok(!/details\.ck|ck-full/.test(blk), 'the phone uses the same check-in markup and rules'); }
});

test('pickProject: the URL, else the viewer\'s last pick (if still registered), else the first project that needs you, else the first registered', () => {
  const ps = [{ name: 'alpha', needs: 0 }, { name: 'beta', needs: 2 }, { name: 'gamma', needs: 1 }];
  assert.equal(pickProject(ps, { url: 'gamma', saved: 'alpha' }), 'gamma');
  assert.equal(pickProject(ps, { saved: 'alpha' }), 'alpha');
  assert.equal(pickProject(ps, { saved: 'gone' }), 'beta', 'a stale pick falls through');
  assert.equal(pickProject(ps, { saved: 'all' }), 'beta', '"all" is not a Home project');
  assert.equal(pickProject(ps, {}), 'beta');
  assert.equal(pickProject([{ name: 'alpha' }, { name: 'beta' }], {}), 'alpha');
  assert.equal(pickProject([], { saved: 'alpha' }), null);
  assert.equal(pickProject(ps, { url: 'all' }), 'all', 'an explicit ?project=all is kept (the other tabs show all)');
  const idx = fs.readFileSync(path.join(ENGINE, 'dash', 'index.html'), 'utf8');
  assert.match(idx, /pickProject\(projects, \{ url: S\.project, saved: \(\(\) => \{ try \{ return localStorage\.getItem\('meta-project'\)/, 'the last pick is read from browser storage in a try');
  assert.match(idx, /try \{ localStorage\.setItem\('meta-project', S\.project\); \} catch/, 'a pick is saved in a try');
});

test('/api/projects carries each project\'s needs-you count (the pick order reads it)', async () => {
  const f = await fixture();
  try {
    const { projects } = (await f.get('/api/projects')).data;
    const by = Object.fromEntries(projects.map(p => [p.name, p.needs]));
    // kestrel: its open question only - the stopped unreviewed run shows in Lanes, not in the Inbox count (UI redesign 2026-11-20)
    assert.equal(by.kestrel, 1, JSON.stringify(by)); assert.equal(by.other, 1);
  } finally { await f.done(); }
});

test('threadOnly: chat lines alone repaint only the thread (no /api/overview, no page); anything else renders the page', () => {
  assert.equal(threadOnly(['chat'], 'talk'), true);
  assert.equal(threadOnly(['chat', 'again'], 'talk'), true, 'a queued repeat of chat lines');
  assert.equal(threadOnly(['chat', 'visible'], 'talk'), true, 'chat lines that arrived while hidden');
  assert.equal(threadOnly(['chat', 'rec'], 'talk'), false);
  assert.equal(threadOnly(['chat'], 'lanes'), false);
  assert.equal(threadOnly([], 'talk'), false); assert.equal(threadOnly(['again'], 'talk'), false);
  const idx = fs.readFileSync(path.join(ENGINE, 'dash', 'index.html'), 'utf8');
  const fn = idx.slice(idx.indexOf('async function render('), idx.indexOf('await header();', idx.indexOf('async function render(')));
  assert.match(fn, /if \(threadOnly\(why, S\.tab\) && \$\('#thread'\)\) \{ await paintThread\(\); return; \}/, 'render() takes the thread-only path before header()');
  const pt = idx.slice(idx.indexOf('async function paintThread('), idx.indexOf('\n}', idx.indexOf('async function paintThread(')));
  assert.ok(pt.includes("/api/home?project=") && !pt.includes('/api/overview') && !pt.includes("$('#main').innerHTML"), 'paintThread fetches the home only and paints #thread only');
});

test('README: the picture is the Home (a sandbox demo), "What you get" names the controller chat; no private names, no phone-reach claim', () => {
  const r = fs.readFileSync(path.join(ENGINE, '..', 'README.md'), 'utf8');
  const img = r.match(/^!\[[^\]]+\]\((docs\/img\/[^)]+)\)/m);
  assert.equal(img?.[1], 'docs/img/home.png', 'the first picture is the Home');
  assert.ok(fs.existsSync(path.join(ENGINE, '..', 'docs', 'img', 'home.png')));
  const get = r.slice(r.indexOf('## What you get'), r.indexOf('## How it works'));
  assert.match(get, /controller chat/i); assert.match(get, /approv/i, 'acts through Norn verbs with approval cards');
  assert.ok(!/phone/i.test(get.split('\n').find(l => /controller chat/i.test(l)) ?? ''), 'phone reach is not built: not claimed');
  const priv = [['hl', '3'], ['high', 'lands'], ['accre', 'tion']].map(p => p.join(''));
  for (const w of [new RegExp('\\b' + priv[0] + '\\b', 'i'), new RegExp(priv[1], 'i'), new RegExp(priv[2], 'i')]) assert.ok(!w.test(r), String(w));
});
