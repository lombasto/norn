// Owner bug 2026-11-19: a stream / poll re-paint rebuilds #main and cleared what the owner was typing (an Inbox answer lost after 5-10 s).
// One mechanism keeps every typed input / textarea of #main (S.drafts): its text, focus and caret survive the re-paint and a tab switch;
// sending the answer drops its draft. The answer box is a textarea (a type=search box clears on Esc).
import test from 'node:test';
import assert from 'node:assert/strict';
import { record } from '../engine/lib/records.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

// type into the element as the owner would (an input event), then put the caret at [s, e]
const typeInto = (sel, text, s, e) => `(() => { const t = document.querySelector(${JSON.stringify(sel)}); t.focus(); t.value = ${JSON.stringify(text)};
  t.dispatchEvent(new Event('input', { bubbles: true })); t.setSelectionRange(${s}, ${e}); return true; })()`;
// a live record makes the stream re-render #main: wait until the element is a new node
async function liveRepaint(f, pg, sel) {
  await pg.ev(`window.__old = document.querySelector(${JSON.stringify(sel)}); true`);
  record(f.pa.state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'a live change ' + Date.now(), via: 'cli' } });
  assert.ok(await pg.until(`(n => !!n && n !== window.__old)(document.querySelector(${JSON.stringify(sel)}))`, 30000), 'the page re-rendered live');
}
const state = sel => `(t => t && JSON.stringify({ tag: t.tagName, value: t.value, focus: document.activeElement === t, sel: [t.selectionStart, t.selectionEnd] }))(document.querySelector(${JSON.stringify(sel)}))`;

// one browser for both pages: a browser's teardown is the slow part on a loaded machine
test('the browser: an Inbox answer keeps its text, focus and caret across a live re-render and a tab switch; Send drops the draft; the Records search box keeps them too', { skip: skipWhy, timeout: 240000 }, async () => {
  const f = await fixture(), pg = await openPage();
  try {
    assert.equal(await pg.go(`${f.url}/?project=kestrel&tab=inbox`), 'inbox');
    const box = '#ans-Q-1';
    await pg.until(`!!document.querySelector(${JSON.stringify(box)})`);
    await pg.ev(typeInto(box, 'take the cheap model first', 5, 8));
    await liveRepaint(f, pg, box);
    assert.deepEqual(JSON.parse(await pg.ev(state(box))), { tag: 'TEXTAREA', value: 'take the cheap model first', focus: true, sel: [5, 8] }, 'text, focus and caret survive');
    // a tab switch and back: the draft is still there
    await pg.ev('document.querySelector("#tab-lanes").click()'); await pg.until('document.body.dataset.ready === "lanes"');
    await pg.ev('document.querySelector("#tab-inbox").click()'); await pg.until('document.body.dataset.ready === "inbox"');
    assert.equal(await pg.until(`document.querySelector(${JSON.stringify(box)})?.value`), 'take the cheap model first', 'the draft outlives a tab switch');
    // Send: typed words are a message in the Q's thread (INBOX-REPLIES: the Q stays open), and the box's draft is gone
    await pg.ev('document.querySelector("[data-act=answer-text][data-id=\'Q-1\']").click()');
    assert.ok(await pg.until(`document.querySelector(${JSON.stringify(box)})?.value === '' && /take the cheap model first/.test(document.querySelector('#qt-Q-1')?.textContent ?? '')`, 30000), 'the message shows in the thread and the draft is dropped');
    // a second page: the Records search box (no id: keyed by its data-filter)
    await pg.ev('document.querySelector("#tab-more").click()'); await pg.until('!document.querySelector("#more-sheet").hidden');
    await pg.ev('document.querySelector("#more-sheet a[data-tab=records]").click()'); await pg.until('document.body.dataset.ready === "records"');
    const find = '[data-filter=records]';
    await pg.until(`!!document.querySelector(${JSON.stringify(find)})`);
    await pg.ev(typeInto(find, 'relief', 2, 2));
    await liveRepaint(f, pg, find);
    assert.deepEqual(JSON.parse(await pg.ev(state(find))), { tag: 'INPUT', value: 'relief', focus: true, sel: [2, 2] }, 'text, focus and caret survive');
  } finally { await pg.close(); await f.done(); }
});
