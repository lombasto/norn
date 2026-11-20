// The feed drawer's activity view on the dashboard (RM-36): the renderer (ui.mjs renderActivity), /api/feed?full=1 replaying a run
// past the backlog window, the head's plan fields (the brief's items, the ones NOTES name done, the worktree), a touched file in the
// Docs reader by its path, and the drawer in a real browser at 390 px - live (a call appended opens the Now line) and replayed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { record } from '../engine/lib/records.mjs';
import { transcriptEvents } from '../engine/lib/harness/claude.mjs';
import { activityOf } from '../engine/dash/activity.mjs';
import { renderActivity, renderFeedEvent } from '../engine/dash/cells.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'feed-activity');
const DASH = { feedPollMs: 40, feedLingerMs: 150 };
const clean = (html, where) => assert.ok(!/undefined|NaN|\[object Object\]/.test(html.replace(/<[^>]*>/g, m => m.replace(/"[^"]*"/g, '""'))), `${where}: undefined / NaN in text`);
const fwd = s => s.split('\\').join('/');

function sse(url) {
  const c = { events: [], closed: false, status: null };
  let buf = '';
  const req = http.get(url, res => {
    c.status = res.statusCode; res.setEncoding('utf8');
    res.on('data', s => { buf += s;
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2); const ev = { event: 'message', data: '' };
        for (const l of block.split('\n')) { const m = l.match(/^(\w+): ?(.*)$/); if (m) { if (m[1] === 'data') ev.data += m[2]; else ev[m[1]] = m[2]; } }
        if (ev.data) { ev.json = JSON.parse(ev.data); c.events.push(ev); }
      } });
    res.on('end', () => { c.closed = true; });
  });
  req.on('error', () => { c.closed = true; });
  c.close = () => req.destroy();
  c.wait = async (pred, ms = 5000) => { const t = performance.now(); while (!pred(c)) { if (performance.now() - t > ms) throw new Error('timeout: ' + c.events.length + ' events'); await new Promise(r => setTimeout(r, 20)); } };
  return c;
}
// a claude run on the fixture's dashboard whose transcript is a recorded run with its paths moved into a real worktree (so a file opens)
function claudeRun(f, { pad = 0, state = 'running', name = 'claude-rm19.jsonl' } = {}) {
  const sid = '44444444-5555-4666-8777-' + String(Date.now()).slice(-12).padStart(12, '0'), wt = path.join(f.root, 'wt-act');
  fs.mkdirSync(path.join(wt, 'engine', 'lib'), { recursive: true }); fs.writeFileSync(path.join(wt, 'engine', 'lib', 'policy.mjs'), '// policy\nexport const x = 1;\n');
  const filler = Array.from({ length: pad }, (_, i) => JSON.stringify({ type: 'attachment', attachment: { type: 'filler', n: i, pad: 'x'.repeat(1000) }, timestamp: '2026-11-18T03:00:00Z' })).join('\n');
  const text = fs.readFileSync(path.join(FX, name), 'utf8').split('/fx/wt').join(fwd(wt));
  const file = path.join(f.root, 'claude-projects', 'C--fx-wt', sid + '.jsonl');
  const half = text.split('\n'), mid = Math.floor(half.length / 2);   // the filler sits between the run's halves: its start falls out of the window
  fs.writeFileSync(file, filler ? [...half.slice(0, mid), filler, ...half.slice(mid)].join('\n') : text);
  const brief = path.join(f.root, 'brief-act.md'), notes = path.join(f.root, 'NOTES-act.md');
  fs.writeFileSync(brief, '# task\n1. **Now**, one sentence\n2. **Files**: every file\n3. **Commits**: this run\n');
  fs.writeFileSync(notes, '# notes\n- Now: done\n- Files: started\n');
  const r = record(f.pa.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'gen', session_id: sid, worktree: fwd(wt), brief, notes, budget_min: 60 } });
  if (state !== 'running') record(f.pa.state, { kind: 'run', ev: 'end', id: r.id, by: 'launcher', data: { exit: 0, outcome: 'done' } });
  return { id: r.id, wt: fwd(wt), file, url: `${f.url}/api/feed?project=kestrel&run=${r.id}` };
}

test('renderActivity: Now with its duration and words, Plan, Files by group (each opens in Docs, edits as diffs), Commands with test counts, Commits', () => {
  const evs = fs.readFileSync(path.join(FX, 'claude-rm19.jsonl'), 'utf8').trim().split('\n').flatMap(l => transcriptEvents(l));
  const v = activityOf(evs, { root: '/fx/wt', now: Date.parse(evs.at(-1).ts) + 3000, brief: [{ n: 1, title: 'Now' }, { n: 2, title: 'policy' }], notesDone: [1] });
  const html = renderActivity(v);
  clean(html, 'activity');
  for (const id of ['id="fa-now"', 'id="fa-dur"', 'data-k="plan"', 'data-k="files"', 'data-k="cmds"', 'data-k="commits"', 'id="fa-g-edited"', 'id="fa-g-created"', 'id="fa-g-read"']) assert.ok(html.includes(id), id);
  assert.match(html, /Thinking \/ writing/); assert.match(html, /5 pass, 0 fail/); assert.match(html, /feat\(policy\): policy\.done_lanes/);
  assert.match(html, /data-act="feed-doc" data-path="\/fx\/wt\/engine\/lib\/policy\.mjs"/);
  assert.match(html, /class="dvbox fxdiff"/, 'edits drawn by the shared diff component (RM-35)'); assert.match(html, /class="dv-row dv-add"/);
  assert.match(html, /2 of 2 done/, 'Now from the NOTES, policy from the commit');
  const ended = renderActivity(activityOf(evs, { ended: true }), { ended: true });
  assert.match(ended, /The run has ended/); assert.ok(!ended.includes('id="fa-dur"'), 'no ticking duration once ended');
  clean(renderActivity(activityOf([], {})), 'empty');
  const e = renderFeedEvent({ ts: '2026-11-18T10:00:00Z', kind: 'tool', name: 'Edit', id: 't1', summary: '/fx/wt/a.mjs', input: { file_path: '/fx/wt/a.mjs', old_string: 'a <b>', new_string: 'a <c>' } });
  assert.match(e, /^<details class="fl fl-x k-tool" data-tid="t1"><summary>/); assert.match(e, /data-act="diff-open" data-dv-before="a &lt;b&gt;" data-dv-after="a &lt;c&gt;"/, 'Open = the diff viewer');
  assert.match(e, /<div class="dv-row dv-del"[^>]*>(<span class="dv-n">\d*<\/span>){2}<span class="dv-t">-a &lt;<mark class="dv-w">b<\/mark>&gt;<\/span>/); assert.match(e, /<div class="dv-row dv-add"[^>]*>(<span class="dv-n">\d*<\/span>){2}<span class="dv-t">\+a &lt;<mark class="dv-w">c<\/mark>&gt;<\/span>/);
  const w = renderFeedEvent({ ts: null, kind: 'tool', name: 'Write', id: 't3', summary: '/fx/wt/n.mjs', input: { file_path: '/fx/wt/n.mjs', content: 'new\nfile' } });
  assert.deepEqual([...w.matchAll(/<div class="dv-row (dv-\w+)"[^>]*>(?:<span class="dv-n">\d*<\/span>){2}<span class="dv-t">([^<]*)<\/span>/g)].map(m => `${m[1]} ${m[2]}`), ['dv-add +new', 'dv-add +file'], 'a Write: its content as added lines');
  assert.match(renderFeedEvent({ ts: null, kind: 'tool', name: 'Bash', id: 't2', summary: 'ls' }), /^<div class="fl k-tool"/, 'other calls stay one line');
});

test('/api/feed?full=1 replays the whole run past the backlog window; the head carries the worktree, the brief\'s items and the ones NOTES name done', async () => {
  const f = await fixture({ dash: DASH });
  try {
    const run = claudeRun(f, { pad: 300, state: 'exited' });   // 300 KB of non-event records ahead of the run: past the 256 KB window
    const firstRead = s => s.events.some(e => e.event === 'ev' && e.json.name === 'Read');
    const full = sse(run.url + '&full=1'); await full.wait(x => x.closed);
    const part = sse(run.url); await part.wait(x => x.closed);
    assert.ok(firstRead(full), 'full: the first calls of the run'); assert.ok(full.events.some(e => e.json.input?.old_string !== undefined), 'with their input');
    const n = c => c.events.filter(e => e.event === 'ev').length;
    assert.ok(n(full) > n(part), `the backlog window alone shows less (${n(part)} vs ${n(full)})`);
    const h = full.events.filter(e => e.event === 'head').at(-1).json;
    assert.equal(h.worktree, run.wt);
    assert.deepEqual(h.brief_items, [{ n: 1, title: 'Now' }, { n: 2, title: 'Files' }, { n: 3, title: 'Commits' }]);
    assert.deepEqual(h.notes_done, [1], '"Files: started" is not done');
  } finally { await f.done(); }
});

test('Docs opens a file a run touched by its path (code as one block); a path outside the roots is refused', async () => {
  const f = await fixture({ dash: DASH });
  try {
    const run = claudeRun(f), key = 'path:' + run.wt + '/engine/lib/policy.mjs';
    const r = await f.get(`/api/docs?project=kestrel&part=file&file=${encodeURIComponent(key)}`);
    assert.equal(r.status, 200); assert.equal(r.data.doc.name, 'policy.mjs'); assert.equal(r.data.doc.code, 'mjs'); assert.match(r.data.doc.text, /export const x/);
    const out = path.join(path.dirname(f.root), 'outside-act.md'); fs.writeFileSync(out, 'x');
    try { assert.equal((await f.get(`/api/docs?project=kestrel&part=file&file=${encodeURIComponent('path:' + fwd(out))}`)).status, 403); } finally { fs.rmSync(out, { force: true }); }
    assert.equal((await f.get(`/api/docs?project=kestrel&part=file&file=${encodeURIComponent('path:' + run.wt + '/nope.mjs')}`)).status, 404);
    assert.equal((await f.get(`/api/docs?project=kestrel&part=file&file=${encodeURIComponent('path:relative/x.mjs')}`)).status, 400);
  } finally { await f.done(); }
});

test('the browser at 390 px: the drawer opens on the activity view (raw events behind a toggle), a live call shows in Now, a file opens in Docs; replayed once ended', { skip: skipWhy, timeout: 240000 }, async () => {
  const f = await fixture({ dash: DASH }), pg = await openPage([390, 844]);
  try {
    await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    const run = claudeRun(f);
    await pg.go(`${f.url}/?project=kestrel&tab=runs`);
    assert.ok(await pg.until(`!!document.querySelector('[data-feed="${run.id}"]')`, 60000), 'the run row');
    await pg.ev(`document.querySelector('[data-feed="${run.id}"]').click()`);
    assert.ok(await pg.until(`!!document.querySelector('#feed-act #fa-now') && /policy\\.mjs/.test(document.querySelector('#feed-act').textContent)`, 30000), 'the activity view');
    assert.equal(await pg.ev(`document.querySelector('#feed-list').hidden`), true, 'a phone: the raw list behind the toggle');
    assert.match(await pg.ev(`document.querySelector('#fa-now').textContent`), /Thinking \/ writing/);
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll (drawer)');
    await pg.ev(`document.querySelector('#feed-raw-tog').click()`);
    assert.equal(await pg.ev(`document.querySelector('#feed-list').hidden`), false, 'the toggle shows the raw list');
    assert.ok(await pg.ev(`!!document.querySelector('#feed-list details.fl-x')`), 'an Edit line opens to its diff');
    // live: a Read call starts (no result yet) -> Now says what it reads
    fs.appendFileSync(run.file, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_live', name: 'Read', input: { file_path: run.wt + '/engine/lib/views.mjs', offset: 100, limit: 51 } }] } }) + '\n');
    assert.ok(await pg.until(`/Reading engine\\/lib\\/views\\.mjs, lines 100-150/.test(document.querySelector('#fa-now').textContent)`, 20000), 'the live call in Now');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll (raw list open)');
    // a file opens in the Docs reader (the phone: the drawer closes)
    await pg.ev(`document.querySelector('#fa-g-edited + ul [data-act="feed-doc"]').click()`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'docs' && !!document.querySelector('#docs-head') && /policy\\.mjs/.test(document.querySelector('#docs-head').textContent)`, 60000), 'the file in Docs');
    assert.match(await pg.ev('location.search'), /tab=docs&doc=path%3A/);
    assert.equal(await pg.ev(`document.querySelector('#feed').hidden`), true);
    // replayed: the run ends; reopened, the drawer shows the whole run and says it ended
    record(f.pa.state, { kind: 'run', ev: 'end', id: run.id, by: 'launcher', data: { exit: 0, outcome: 'done' } });
    await pg.go(`${f.url}/?project=kestrel&tab=runs`);
    assert.ok(await pg.until(`!!document.querySelector('[data-feed="${run.id}"]')`, 60000));
    await pg.ev(`document.querySelector('[data-feed="${run.id}"]').click()`);
    assert.ok(await pg.until(`/The run has ended/.test(document.querySelector('#fa-now')?.textContent ?? '') && !!document.querySelector('#fa-g-edited')`, 30000), 'replayed');
    assert.match(await pg.ev(`document.querySelector('#feed-act').textContent`), /5 pass, 0 fail/);
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll (replayed)');
  } finally { await pg.close(); await f.done(); }
});
