// META-UX-BUILD S7 (REPORT s.3 "End to end" 4): the fixer's ONE result card - every file (Skip this file), every hunk as a diff,
// "Apply all n", "Discard", the rest tap; a run with no parsable hunk shows as failed, never "with the fixer". The same card in the
// Inbox and on the Slop page; on a phone no sideways scroll, Apply + Discard reachable. Sandbox only: pure renders, the shared dash
// fixture (temp dirs) and a private headless browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderTab } from '../engine/dash/ui.mjs';
import { guardSummary } from '../engine/dash/guardparts.mjs';
import { record } from '../engine/lib/records.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

const hunk = (file, line, a, b) => ({ id: `${file}-${line}`, line, patch: ['--- a/' + file, '+++ b/' + file, `@@ -${line},1 +${line},1 @@`, '-' + a, '+' + b].join('\n') });
const card = (over = {}) => ({ run: 'RUN-7', directive: 'DIR-4', dec: 'DEC-9', created: '2026-11-17T07:00:00Z', outcome: 'done', notes: 'n.md', state: 'ready',
  files: [{ file: 'CLAUDE.md', hunks: [hunk('CLAUDE.md', 3, 'old rule', 'new rule'), hunk('CLAUDE.md', 9, 'stale', 'fresh')] }, { file: 'AGENTS.md', hunks: [hunk('AGENTS.md', 2, 'x', 'y')] }],
  n: 3, ids: ['I-1', 'I-2', 'I-3', 'I-4'], status: [{ id: 'I-1', state: 'drafted' }, { id: 'I-2', state: 'drafted' }, { id: 'I-3', state: 'drafted' }, { id: 'I-4', state: 'skipped', why: 'the owner file' }],
  left: 50, more: 2, ...over });

test('the result card: every file with Skip this file, every hunk as a diff, Apply all n, Discard, the rest tap', () => {
  const page = renderTab('inbox', { items: [{ type: 'fixresult', id: 'RUN-7', project: 'kestrel', card: card(), created: '2026-11-17T07:00:00Z' }] }, { project: 'kestrel', now: Date.parse('2026-11-17T08:00:00Z') });
  assert.equal((page.match(/class="fxcard/g) || []).length, 1, 'ONE card');
  for (const f of ['CLAUDE.md', 'AGENTS.md']) assert.match(page, new RegExp(`data-act="fx-skip"[^>]*data-file="${f}"`), `Skip this file for ${f}`);
  assert.equal((page.match(/Skip this file/g) || []).length, 2);
  for (const t of ['-old rule', '+new rule', '-stale', '+fresh', '+y']) assert.ok(page.includes(t), `the diff line ${t}`);
  assert.match(page, /class="fxdiff[^"]*"/);
  assert.match(page, /data-act="fixresult"[^>]*data-choice="apply"[^>]*>Apply all <span[^>]*>3</);
  assert.match(page, /data-act="fixresult"[^>]*data-choice="discard"/);
  assert.match(page, /3 drafted · 1 skipped/); assert.ok(page.includes('the owner file'), 'a skip says why');
  assert.match(page, /data-act="fixall-rest"[^>]*data-dir="DIR-4"[^>]*>50 left: send the fixer for the rest \(2 runs\)/);
  const none = renderTab('inbox', { items: [{ type: 'fixresult', id: 'RUN-7', project: 'kestrel', card: card({ more: 0 }) }] }, { project: 'kestrel' });
  assert.doesNotMatch(none, /fixall-rest/, 'no rest tap while approved runs remain or nothing is left');
});

test('a run with no parsable hunk: the card says failed, Discard only; the Slop page never says "with the fixer" for it', () => {
  const bad = card({ state: 'failed', files: [], n: 0, status: [{ id: 'I-1', state: 'missing' }], more: 0 });
  const page = renderTab('inbox', { items: [{ type: 'fixresult', id: 'RUN-7', project: 'kestrel', card: bad }] }, { project: 'kestrel' });
  assert.match(page, /failed: no parsable hunk/);
  assert.doesNotMatch(page, /data-choice="apply"/); assert.match(page, /data-choice="discard"/);
  const g = { project: 'kestrel', rows: [], total: 0, sent: [{ id: 'DEC-9', directive: 'DIR-4', n: 4, open: 4, fixer: { at: 'failed', run: 'RUN-7', left: 4, more: 0 } }], fixcards: [bad] };
  const s = guardSummary(g);
  assert.equal(s.fixcards.length, 1, 'the summary carries the cards');
  const slop = renderTab('slop', { ...s, limit: 40, sub: 'fix', fix: { batches: [], nb: 0, n: 0 }, parts_loading: false }, { project: 'kestrel' });
  assert.match(slop, /id="slop-fixcards"[^]*failed: no parsable hunk/);
  assert.doesNotMatch(slop, /with the fixer/);
  assert.match(slop, /id="slop-sent"[^]*RUN-7 failed/);
});

test('the Slop line says where each Fix all is', () => {
  const at = (x, extra = {}) => renderTab('slop', { ...guardSummary({ project: 'k', rows: [], total: 0, sent: [{ id: 'DEC-9', directive: 'DIR-4', n: 9, open: 9, fixer: { at: x, run: 'RUN-7', left: 9, more: 1, ...extra } }] }), limit: 40, sub: 'fix', fix: { batches: [], nb: 0, n: 0 }, parts_loading: false }, { project: 'k' });
  assert.match(at('queued'), /fixer RUN-7 queued/);
  assert.match(at('running'), /fixer RUN-7 running/);
  assert.match(at('card'), /RUN-7 drafted: apply on its card/);
  assert.match(at('starting'), /the engine starts the fixer/);
  assert.match(at('rest'), /9 left: send the fixer for the rest/);
});

test('phone: the card in the Inbox, no sideways scroll, Apply and Discard reachable; Skip this file takes the file out of Apply all n', { timeout: 240000 }, async t => {
  const f = await fixture();
  try {
    let s = (await f.get('/api/guard?project=kestrel&part=summary')).data;
    for (let i = 0; s.pending && i < 1200; i++) { await new Promise(r => setTimeout(r, 100)); s = (await f.get('/api/guard?project=kestrel&part=summary')).data; }
    const sh = (await f.get('/api/guard?project=kestrel&part=sheet')).data.sheet, keys = sh.items.filter(i => i.kind !== 'call').map(i => i.key);   // the fixture findings are on Norn's own prompts: offered, never pre-ticked, so ticked by hand
    const sent = await f.post('/api/fixall', { project: 'kestrel', sig: sh.sig, keys, picks: {} });
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    const state = f.pa.state, fx = path.join(state, 'fixer'), brief = path.join(fx, `${sent.data.directive}-1.brief.md`), notes = path.join(fx, `${sent.data.directive}-1.md`);
    const ids = (await f.get('/api/records?project=kestrel')).data.directives.find(x => x.id === sent.data.directive).data.findings;
    fs.mkdirSync(fx, { recursive: true });
    fs.writeFileSync(brief, `- id: ${ids[0]}\n`);
    const long = 'a long rule line that would push a narrow screen sideways if the diff did not wrap '.repeat(3);
    fs.writeFileSync(path.join(f.pa.root, 'CLAUDE.md'), `x\nx\n${long}\n`); fs.writeFileSync(path.join(f.pa.root, 'AGENTS.md'), 'y\n'.repeat(8) + 'gone\n');
    fs.writeFileSync(notes, ['### `CLAUDE.md:3` - medium - rewrite', '```diff', '--- a/CLAUDE.md', '+++ b/CLAUDE.md', '@@ -2,2 +2,2 @@', ' x', '-' + long, '+new', '```',
      '### `AGENTS.md:9` - medium - remove', '```diff', '--- a/AGENTS.md', '+++ b/AGENTS.md', '@@ -8,2 +8,1 @@', ' y', '-gone', '```', '## Findings', `- ${ids[0]}: drafted`].join('\n'));
    const run = record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { lane: 'fixall', kind: 'audit', executor: 'fake', brief, notes } });
    record(state, { kind: 'run', ev: 'end', id: run.id, by: 'launcher', data: { outcome: 'done', exit: 0 } });
    const ib = (await f.get('/api/inbox?project=kestrel')).data.items.filter(x => x.type === 'fixresult');
    assert.deepEqual(ib.map(x => [x.card.state, x.card.n]), [['ready', 2]], JSON.stringify(ib));
    if (skipWhy) { t.diagnostic(`browser part skipped: ${skipWhy}`); return; }
    const pg = await openPage([390, 844]);
    try {
      await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await pg.go(`${f.url}/?project=kestrel&tab=inbox`);
      assert.ok(await pg.until(`document.querySelector('.fxcard [data-choice=apply]')`, 60000), 'the card shows');
      assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on a phone');
      assert.ok(await pg.ev(`['apply', 'discard'].every(c => { const r = document.querySelector('.fxcard [data-choice=' + c + ']').getBoundingClientRect(); return r.left >= 0 && r.right <= 390 && r.width > 0; })`), 'Apply and Discard reachable');
      assert.equal(await pg.ev(`document.querySelector('.fxcard [data-choice=apply] .fx-kept').textContent`), '2');
      await pg.ev(`document.querySelector('.fxcard [data-act=fx-skip][data-file="AGENTS.md"]').click()`);
      assert.equal(await pg.ev(`document.querySelector('.fxcard [data-choice=apply] .fx-kept').textContent`), '1', 'a skipped file leaves Apply all n');
      await pg.go(`${f.url}/?project=kestrel&tab=slop`);
      assert.ok(await pg.until(`document.querySelector('#slop-fixcards .fxcard')`, 60000), 'the same card on the Slop page');
      assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on the Slop page');
    } finally { await pg.close(); }
  } finally { await f.done(); }
});
