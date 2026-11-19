// RM-35: the dashboard's one diff viewer (engine/dash/diffview.mjs) - line ops numbered on both sides, word highlights inside a changed
// line pair, unchanged runs collapsed, a unified-diff patch read into the same ops, unified / side-by-side HTML that wraps instead of
// scrolling sideways; and the picture-in-picture panel (index.html #dvpip) opened from the "changed outside Norn" notice: View diff,
// side by side, next change, Esc, the page as it was; a full-screen sheet with no sideways scroll at 390 px. Temp state dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { diffLines, diffWords, collapse, parsePatch, renderDiff, diffBlock, diffStats } from '../engine/dash/diffview.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { writeViews, VIEW_FILES } from '../engine/lib/views.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

const kinds = ops => ops.map(o => o.t[0]).join('');

test('diffLines: equal / removed / added lines, numbered on both sides; dels before adds in a change', () => {
  const ops = diffLines('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n');
  assert.equal(kinds(ops), 'edaeea');
  assert.deepEqual(ops.map(o => [o.t, o.a, o.b, o.text]), [['eq', 1, 1, 'a'], ['del', 2, null, 'b'], ['add', null, 2, 'B'], ['eq', 3, 3, 'c'], ['eq', 4, 4, 'd'], ['add', null, 5, 'e']]);
  assert.deepEqual(diffStats(ops), { add: 2, del: 1 });
  assert.equal(kinds(diffLines('', 'x\ny')), 'aa', 'from nothing');
  assert.equal(kinds(diffLines('x\r\ny\r\n', 'x\ny\n')), 'ee', 'CRLF and LF are the same line');
  assert.equal(kinds(diffLines('same\n', 'same\n')), 'e');
});

test('diffWords: only the changed words of a line pair are marked', () => {
  const w = diffWords('Running (0) since 20:16', 'Running (5) since 21:22');
  assert.deepEqual(w.filter(x => x.t !== 'eq').map(x => x.t + ':' + x.s), ['del:0', 'add:5', 'del:20', 'add:21', 'del:16', 'add:22']);
  assert.equal(w.filter(x => x.t !== 'add').map(x => x.s).join(''), 'Running (0) since 20:16', 'the before side reads back whole');
  assert.equal(w.filter(x => x.t !== 'del').map(x => x.s).join(''), 'Running (5) since 21:22', 'and the after side');
});

test('collapse: unchanged runs fold to ctx lines around each change; the head and tail keep only their changed side', () => {
  const a = Array.from({ length: 30 }, (_, i) => 'l' + i), b = [...a]; b[15] = 'changed';
  const c = collapse(diffLines(a.join('\n'), b.join('\n')), 3);
  assert.equal(kinds(c), 'seeedaeees');
  assert.deepEqual(c.filter(o => o.t === 'skip').map(o => [o.n, o.a]), [[12, 1], [11, 20]]);
  assert.equal(kinds(collapse(diffLines('x\ny\nz', 'x\nY\nz'), 3)), 'edae', 'a short run is never folded');
});

test('parsePatch: a unified hunk (the fixer, the audit) -> the same ops, numbered from its @@ head; a second hunk is a gap', () => {
  const p = parsePatch(['--- a/CLAUDE.md', '+++ b/CLAUDE.md', '@@ -3,2 +3,2 @@', ' keep', '-old rule', '+new rule', '@@ -40,1 +40,1 @@', '-x', '+y'].join('\n'));
  assert.deepEqual(p.files, ['CLAUDE.md']);
  assert.deepEqual(p.ops.map(o => [o.t, o.a, o.b]), [['eq', 3, 3], ['del', 4, null], ['add', null, 4], ['skip', 40, 40], ['del', 40, null], ['add', null, 40]]);
  assert.equal(kinds(parsePatch('+only added\n').ops), 'a', 'a draft without heads');
});

test('renderDiff / diffBlock: unified and side by side, word marks, line numbers, a folded run, escaped text, one box', () => {
  const ops = diffLines('<b>1</b>\nkeep\n' + 'same\n'.repeat(10) + 'end old\n', '<b>2</b>\nkeep\n' + 'same\n'.repeat(10) + 'end new\n');
  const u = renderDiff(ops), s = renderDiff(ops, { mode: 'split' });
  assert.match(u, /class="dv dv-unified" data-dv-changes="2"/);
  assert.match(s, /class="dv dv-split" data-dv-changes="2"/);
  assert.ok(u.includes('&lt;b&gt;') && !u.includes('<b>1'), 'the text is escaped');
  assert.match(u, /<mark class="dv-w">old<\/mark>/); assert.match(u, /<mark class="dv-w">new<\/mark>/);
  assert.match(u, /5 unchanged lines/, 'the run between the changes is folded');
  assert.match(s, /<span class="dv-n">1<\/span><span class="dv-t dv-del">/, 'side by side: the before number, then its text');
  assert.equal((u.match(/data-dv-chg=/g) || []).length, 2, 'each change is a stop for next / previous');
  assert.match(renderDiff(diffLines('a', 'a')), /no difference/);
  const box = diffBlock({ patch: '@@ -1 +1 @@\n-a\n+b' }, { title: 'X.md:1' });
  assert.match(box, /class="dvbox"/); assert.match(box, /\+1<\/span> <span class="dv-minus">-1/); assert.match(box, /data-act="diff-open" data-dv-patch="@@ -1 \+1 @@\n-a\n\+b"/);
  assert.match(diffBlock({ url: '/api/x?a=1&b=2' }, {}), /data-dv-url="\/api\/x\?a=1&amp;b=2"/);
});

test('the diff viewer: the notice\'s View diff opens it over the page; side by side, next change, Esc closes and the page is as it was; a phone gets a full-screen sheet, no sideways scroll at 390 px', { timeout: 240000 }, async t => {
  const f = await fixture();
  try {
    record(f.pa.state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'a directive with a long line that must wrap inside the viewer on a narrow phone screen and never push it sideways', via: 'chat' } });
    writeViews(f.pa.state, loadState(f.pa.state), f.pa.views || {});
    const file = path.resolve(f.pa.state, 'views', VIEW_FILES.directives);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^<!--.*-->\n/, '').replace('long line', 'long hand-edited line') + 'a person\'s note\n');
    const e = (await f.get('/api/inbox?project=kestrel')).data.items.find(i => i.type === 'handedit');
    assert.ok(e?.diff, 'the row offers a diff'); assert.equal(e.verdict, 'person');
    const d = await f.get(`/api/handedit/diff?project=kestrel&file=${encodeURIComponent(e.file)}`);
    assert.equal(d.status, 200); assert.match(d.data.before, /GENERATED/); assert.match(d.data.after, /a person's note/); assert.match(d.data.sub, /last written by Norn .* vs now/);
    assert.equal((await f.get(`/api/handedit/diff?project=kestrel&file=${encodeURIComponent(path.join(f.root, 'nope.md'))}`)).status, 409);
    if (skipWhy) { t.diagnostic(`browser part skipped: ${skipWhy}`); return; }
    const pg = await openPage([1280, 900]);
    try {
      await pg.go(`${f.url}/?project=kestrel&tab=inbox`);
      assert.ok(await pg.until(`document.querySelector('[data-act=diff-open][data-dv-url]')`, 60000), 'View diff on the notice');
      await pg.ev(`(document.querySelector('#main').dataset.mark = 'kept', document.querySelector('[data-act=diff-open][data-dv-url]').click())`);
      assert.ok(await pg.until(`!document.querySelector('#dvpip').hidden && document.querySelector('#dvpip-body .dv-unified [data-dv-chg]')`, 30000), 'the panel shows the unified diff');
      assert.match(await pg.ev(`document.querySelector('#dvpip-sub').textContent`), /last written by Norn .* vs now/);
      assert.ok(await pg.ev(`!!document.querySelector('#dvpip-body mark.dv-w')`), 'the changed words are marked');
      await pg.ev(`document.querySelector('#dvpip [data-dv-mode=split]').click()`);
      assert.ok(await pg.ev(`!!document.querySelector('#dvpip-body .dv-split')`), 'side by side');
      await pg.ev(`document.querySelector('#dvpip [data-dv-nav="1"]').click()`);
      assert.match(await pg.ev(`document.querySelector('#dvpip-pos').textContent`), /^1 \/ \d+ change/);
      assert.ok(await pg.ev(`!!document.querySelector('#dvpip-body .dv-cur')`), 'next change is marked');
      await pg.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      assert.ok(await pg.ev(`document.querySelector('#dvpip').hidden`), 'Esc closes it');
      assert.equal(await pg.ev(`document.querySelector('#main').dataset.mark`), 'kept', 'the page underneath is the same page');
      // the phone on the same browser: a second browser's launch + teardown (a process listing per round, Edge's rundown) does not fit the cap on a busy machine
      await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await pg.go(`${f.url}/?project=kestrel&tab=inbox`);
      assert.ok(await pg.until(`document.querySelector('[data-act=diff-open][data-dv-url]')`, 60000));
      assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'the notice: no sideways scroll');
      await pg.ev(`document.querySelector('[data-act=diff-open][data-dv-url]').click()`);
      assert.ok(await pg.until(`!document.querySelector('#dvpip').hidden && document.querySelector('#dvpip-body .dv-unified')`, 30000), 'unified on a phone');
      assert.deepEqual(await pg.ev(`(r => [r.left, r.top, r.width])(document.querySelector('#dvpip').getBoundingClientRect())`), [0, 0, 390], 'a full-screen sheet');
      assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll with the viewer open');
      assert.ok(await pg.ev(`(b => b.scrollWidth <= b.clientWidth)(document.querySelector('#dvpip-body'))`), 'the diff wraps inside the sheet');
      assert.ok(await pg.ev(`(r => r.right <= 390 && r.width > 0)(document.querySelector('#dvpip-close').getBoundingClientRect())`), 'Close is reachable');
    } finally { await pg.close(); }
  } finally { await f.done(); }
});
