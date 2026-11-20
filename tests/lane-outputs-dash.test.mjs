// lane-outputs on the dashboard: GET /api/lane (Findings, the grouped Outputs with their runs, the follow-up, what happens next),
// the Lanes row's next state, a notes file opened in place through the Docs reader's path route (an image is shown, never read as
// text; nothing outside the allowed roots opens), and the details at 390 px with a file open: no sideways scroll.
// Sandbox only: the shared dash fixture (temp dirs) and a private headless browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { record } from '../engine/lib/records.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5c1d6e10000000049454e44ae426082', 'hex');
// lane audit: a planner run that wrote its report, a stage brief, a shot and data, then ended without `norn done`
function audit(f, { outcome = 'no-result' } = {}) {
  const S = f.pa.state, dir = path.join(S, 'notes', 'audit');
  record(S, { kind: 'lane', ev: 'create', by: 'controller', data: { name: 'audit' } });
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true }); fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const run = record(S, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'audit', stage: 'plan', agent: 'planner', notes: path.join(dir, 'NOTES.md').replace(/\\/g, '/') } }).id;
  fs.writeFileSync(path.join(dir, 'NOTES.md'), `# audit / plan\n\n## Summary for the owner\n\n1. The ${'very '.repeat(30)}long finding about **Lanes**.\n2. | col a | col b |\n\n## Open for the owner\n\n- S1: where the list lives. Default: the details.\n`);
  fs.writeFileSync(path.join(dir, 'AUDIT.md'), `# Audit\n\n| ${Array.from({ length: 12 }, (_, i) => `column ${i}`).join(' | ')} |\n|${'---|'.repeat(12)}\n\n\`\`\`\n${'x'.repeat(400)}\n\`\`\`\n`);
  fs.writeFileSync(path.join(dir, 'brief-S1.md'), '# audit / S1: the list\n');
  fs.writeFileSync(path.join(dir, 'shots', 'lanes-phone.png'), PNG);
  fs.writeFileSync(path.join(dir, 'data', 'walk.json'), JSON.stringify({ long: 'y'.repeat(500) }));
  record(S, { kind: 'run', ev: 'end', id: run, by: 'launcher', data: { exit: 0, outcome, cutoff: ['Measure test time'] } });
  return { dir, run };
}

test('GET /api/lane: Findings verbatim, Outputs grouped with their run, the next state; the Lanes row says it too; a file opens in place, nothing outside the roots does', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const { dir, run } = audit(f), fwd = p => p.replace(/\\/g, '/');
    const { status, data } = await f.get('/api/lane?project=kestrel&lane=audit');
    assert.equal(status, 200);
    assert.match(data.findings.text, /^1\. The (very )+long finding about \*\*Lanes\*\*\.\n2\. \| col a \| col b \|$/);
    assert.deepEqual(data.outputs.map(g => [g.group, g.files.map(x => x.rel)]), [['report', ['AUDIT.md', 'NOTES.md']], ['briefs', ['brief-S1.md']], ['images', ['shots/lanes-phone.png']], ['data', ['data/walk.json']]]);
    assert.ok(data.outputs.flatMap(g => g.files).every(x => x.run === run && x.size > 0 && x.mtime), 'each file: its run, size and time');
    assert.equal(data.next.words, 'ended without a result: 5 files written; review');
    assert.deepEqual(data.cutoff, ['Measure test time']);
    assert.equal(data.runs[0].outcome, 'no-result');
    assert.equal((await f.get('/api/lane?project=kestrel&lane=nope')).status, 404);
    const lanes = (await f.get('/api/lanes?project=kestrel')).data.lanes, row = lanes.find(l => l.name === 'audit');
    assert.equal(row.next.key, 'noresult'); assert.deepEqual(row.cutoff, ['Measure test time']);
    assert.match(row.status_line, /col a/);
    assert.equal(lanes.find(l => l.name === 'render').next, undefined, 'a running lane has no next state yet');
    const doc = async p => f.get('/api/docs?project=kestrel&part=file&file=' + encodeURIComponent('path:' + p));
    const img = await doc(path.join(dir, 'shots', 'lanes-phone.png'));
    assert.equal(img.status, 200); assert.equal(img.data.doc.image, true); assert.equal(img.data.doc.text, '');
    const md = await doc(path.join(dir, 'AUDIT.md'));
    assert.equal(md.data.doc.path, fwd(fs.realpathSync.native(path.join(dir, 'AUDIT.md')))); assert.match(md.data.doc.text, /column 11/); assert.equal(md.data.doc.code, undefined);
    assert.equal((await doc(path.join(dir, 'data', 'walk.json'))).data.doc.code, 'json');
    const outside = path.join(path.dirname(f.root), `lane-outputs-outside-${process.pid}.md`);
    fs.writeFileSync(outside, 'secret');
    try {
      for (const p of [outside, path.join(dir, '..', '..', '..', '..', path.basename(outside))]) assert.equal((await doc(p)).status, 403, p);
    } finally { fs.rmSync(outside, { force: true }); }
  } finally { await f.done(); }
});

test('the browser at 390 px: Details opens the lane\'s findings and outputs; a Markdown file, an image and data open in place; never a sideways scroll', { skip: skipWhy, timeout: 180000 }, async () => {
  const f = await fixture(), pg = await openPage([390, 844]);
  try {
    audit(f);
    await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await pg.go(`${f.url}/?project=kestrel&tab=lanes`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'lanes' && !!document.querySelector('#lane-audit .lane-next')`, 90000), 'the row says what happens next');
    assert.match(await pg.ev(`document.querySelector('#lane-audit .lane-next').textContent`), /ended without a result: 5 files written; review/);
    await pg.ev(`document.querySelector('#lane-audit [data-act="lane-detail"]').click()`);
    assert.ok(await pg.until(`!!document.querySelector('#lane-det #lane-outputs [data-act="lane-file"]')`, 30000), 'the details load');
    assert.match(await pg.ev(`document.querySelector('#lane-findings').textContent`), /long finding about Lanes/);
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll with the details open');
    for (const [rel, sel] of [['AUDIT.md', '.fileview .md table'], ['shots/lanes-phone.png', '.fileview img.fileview-img'], ['data/walk.json', '.fileview .fileview-src .ln']]) {
      await pg.ev(`[...document.querySelectorAll('[data-act="lane-file"]')].find(b => b.textContent === ${JSON.stringify(rel)}).click()`);
      assert.ok(await pg.until(`!!document.querySelector(${JSON.stringify(sel)})`, 30000), `${rel} opens in place`);
      assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, `no sideways scroll with ${rel} open`);
    }
    if (await pg.ev(`!!document.querySelector('.fileview img')`)) assert.ok(await pg.until(`document.querySelector('.fileview img').naturalWidth === 1`, 30000), 'the image loads from /api/file');
  } finally { await pg.close(); await f.done(); }
});
