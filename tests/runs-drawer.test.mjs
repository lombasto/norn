// Runs: the agent and priority columns, the one-tap feed buttons and the compact run drawer (owner list 2026-11-23 item 4; SPEC 4
// R1-R7): Summary / Activity / Feed / Facts on the drawer's head, one section shown, a row tap opening Summary and any other open
// (a &run= load, another page's feed link) Feed; the close button with its Norn art and its classic X. Synthetic rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTab } from '../engine/dash/ui.mjs';
import { runsViewOf, runView, openRunView, RUN_VIEWS } from '../engine/dash/pages/runs.mjs';
import { closeBtn } from '../engine/dash/norn/assets.mjs';

const DASH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'dash');
const NOW = Date.parse('2026-11-23T12:00:00Z'), ago = x => new Date(NOW - x * 60000).toISOString();
const items = n => Array.from({ length: n }, (_, i) => ({ n: i + 1, title: `item ${i + 1}`, state: i < 2 ? 'done' : i === 2 ? 'doing' : 'open' }));
const data = () => ({
  tree: [{ id: 'RUN-2', dwarf: { id: 'brokk', name: 'Brokk' }, agent: 'kestrel-implementer', priority: 'P1', kind: 'worker', executor: 'claude', model: 'claude-opus-5-5', effort: 'medium',
    lane: 'gen-water', stage: 'S3', state: 'running', started: ago(41), project: 'kestrel', acts: { tools: 212, words: 3100, commits: 4 }, children: [],
    progress: { line: 'wiring the reporter', items: items(7), done: 2, total: 7, pace: { state: 'on track', elapsed_min: 41, budget_min: 90, sessions: 2, handoffs: 1 }, alarms: [] } },
  { id: 'RUN-1', kind_word: 'check-in', kind: 'worker', executor: 'claude', lane: 'old', state: 'exited', outcome: 'done', started: ago(90), ended: ago(60), project: 'kestrel', children: [] }],
  queue: [{ id: 'RUN-9', dwarf: { id: 'eitri', name: 'Eitri' }, kind: 'worker', lane: 'gen', stage: 'G2', queued: ago(25), project: 'kestrel' }],
  plan: { parts: [{ project: 'kestrel', priorities: ['P0', 'P1', 'P2'], upnext: [{ id: 'RUN-9', position: 1, status: 'waiting', priority: 'P1', estimate: { word: '~40 min' } }] }] },
});
const page = (run = null) => renderTab('runs', data(), { now: NOW, projects: [], runsView: runsViewOf(new URLSearchParams()), run });
const rowOf = (html, id) => html.match(new RegExp(`<tr class="rrow[^"]*" id="node-${id}"[^]*?<!--/row-->`))?.[0] ?? '';
const cell = (row, label) => row.match(new RegExp(`<td[^>]*data-label="${label}"[^]*?</td>`))?.[0] ?? '';
const docOf = html => html.slice(html.indexOf('id="run-doc"'));
const shown = doc => [...doc.matchAll(/<div class="rd-view" data-view="(\w+)"( hidden)?>/g)].filter(m => !m[2]).map(m => m[1]);

test('R1 the columns: agent and priority after run; the run cell holds the id, the agent cell the dwarf and the agent file', () => {
  const h = page(), heads = [...h.matchAll(/<th>([^<]*)<\/th>/g)].map(m => m[1]);
  assert.deepEqual(heads, ['state', 'run', 'agent', 'priority', 'lane · stage', 'model', 'age', 'tools', 'words', 'commits', 'pace']);
  const r = rowOf(h, 'RUN-2');
  assert.doesNotMatch(cell(r, 'run'), /Brokk/, 'the dwarf left the run cell'); assert.match(cell(r, 'run'), /RUN-2/);
  assert.match(cell(r, 'agent'), /Brokk[^]*kestrel-implementer/, 'the dwarf and the agent file');
  assert.match(cell(rowOf(h, 'RUN-1'), 'agent'), /check-in/, 'no dwarf: the kind word');
  assert.match(cell(r, 'priority'), /class="chip idle prio"[^>]*>P1</, 'the run priority as a chip');
  assert.match(cell(rowOf(h, 'RUN-1'), 'priority'), /class="chip idle prio dflt"[^>]*>P2</, 'no priority: the default P2, faded');
  assert.match(cell(rowOf(h, 'RUN-9'), 'agent'), /Eitri/, 'a queued row: its dwarf (the agent arrives with the queue entry)');
});

test('R2 a queued row: the priority select in the priority cell, none in pace', () => {
  const q = rowOf(page(), 'RUN-9');
  assert.match(cell(q, 'priority'), /<select class="pl-prio" data-act="prio" data-project="kestrel" data-run="RUN-9"[^>]*>[^]*<option selected>P1<\/option>/);
  assert.doesNotMatch(cell(q, 'pace'), /<select/); assert.match(cell(q, 'pace'), /~40 min/, 'pace keeps the estimate');
});

test('R3 tools / words / commits are one-tap buttons to the feed of that kind; a row tap is run-open', () => {
  const r = rowOf(page(), 'RUN-2');
  for (const [k, v] of [['tools', '212'], ['words', '3,100'], ['commits', '4']]) assert.match(cell(r, k), new RegExp(`<button class="lnk rfeed" data-act="run-feed" data-run="RUN-2" data-project="kestrel" data-kind="${k}"[^>]*>${v}</button>`), k);
  assert.match(r, /^<tr class="rrow[^"]*" id="node-RUN-2" data-act="run-open" data-run="RUN-2" data-project="kestrel" tabindex="0"/);
  assert.doesNotMatch(r, /data-feed=/, 'data-feed is left to the other pages (they open Feed)');
  assert.match(cell(rowOf(page(), 'RUN-1'), 'tools'), /<span class="mute">-<\/span>/, 'none read: a dash, no button');
});

test('R4 R5 the drawer: 4 view buttons, one section shown; Feed for a &run= load, Summary after a row tap, the tapped kind seeds the feed', () => {
  runView.run = null;
  const load = docOf(page('RUN-2'));
  assert.deepEqual([...load.matchAll(/<button class="hf" data-act="run-view" data-view="(\w+)" aria-pressed="(\w+)">([^<]+)</g)].map(m => `${m[1]}:${m[2]}:${m[3]}`),
    RUN_VIEWS.map(([k, t]) => `${k}:${k === 'feed'}:${t}`), 'Summary · Activity · Feed · Facts, Feed pressed');
  assert.deepEqual(RUN_VIEWS.map(v => v[1]), ['Summary', 'Activity', 'Feed', 'Facts']);
  assert.deepEqual(shown(load), ['live'], 'Feed: the live section alone');
  assert.match(load, /<article class="rdoc drawer" id="run-doc" data-run="RUN-2" data-project="kestrel" data-view="feed"/);
  assert.match(load, /id="run-feed-slot" data-project="kestrel" data-run="RUN-2" data-kind="tools" data-seed="\d+"/, 'tools by default');
  openRunView('RUN-2', 'summary');
  const sum = docOf(page('RUN-2'));
  assert.deepEqual(shown(sum), ['summary']); assert.match(sum, /data-view="summary" aria-pressed="true"/);
  assert.match(sum, /id="run-feed-slot"/, 'the feed slot stays in the page: the stream never reconnects on a view switch');
  assert.match(sum, /item 1[^]*item 2[^]*item 3/); assert.doesNotMatch(sum.match(/<ol class="rd-items">[^]*?<\/ol>/)[0], /item 4/, 'the checklist folds to 3');
  assert.match(sum, /<summary class="small">4 more<\/summary>/);
  assert.match(sum, /41 min/, 'the pace band');
  openRunView('RUN-2', 'facts'); assert.deepEqual(shown(docOf(page('RUN-2'))), ['facts']);
  openRunView('RUN-2', 'activity'); const act = docOf(page('RUN-2'));
  assert.deepEqual(shown(act), ['live']); assert.match(act, /data-view="activity"/, 'Activity: the same live section, the event list hidden by the view');
  const s0 = runView.seq; openRunView('RUN-2', 'feed', 'commits');
  assert.match(docOf(page('RUN-2')), new RegExp(`data-kind="commits" data-seed="${s0 + 1}"`), 'a count tap: Feed with only that kind, a fresh seed');
  assert.match(docOf(page('RUN-1')), /data-view="feed" aria-pressed="true"/, 'another run opened from outside: Feed');
  runView.run = null;
});

test('R6 the feed: Activity details start closed (F.keep seeded), the kind toggles start with the seeded kind alone, no reconnect on a seed', () => {
  const mod = fs.readFileSync(path.join(DASH, 'pages', 'runs-feed.mjs'), 'utf8');
  assert.match(mod, /d\.open = F\.keep\.get\(d\.dataset\.k\) \?\? false/, 'a details the owner never opened is closed');
  assert.doesNotMatch(mod, /aria-pressed="true"/, 'no kind starts pressed in the markup');
  assert.match(mod, /kinds\(\[kind\]\)/, 'the seeded kind alone');
  const css = fs.readFileSync(path.join(DASH, 'css', 'runs.css'), 'utf8');
  assert.match(css, /\.rdoc\[data-view="activity"\] #feed-list/); assert.match(css, /\.rdoc\[data-view="feed"\] #feed-act/);
});

test('R7 closeBtn: the button with its label, the Norn art and the classic X; the run drawer uses it', () => {
  const b = closeBtn('data-act="runs-close"');
  assert.match(b, /^<button class="xclose" aria-label="Close \(Esc\)" title="Close \(Esc\)" data-act="runs-close">/);
  assert.match(b, /<img class="art xc-art" alt="" data-asset="icon-close-16" src="data:image\/svg\+xml,[^"]+"/);
  assert.match(b, /<svg class="xc-svg"[^>]*>[^]*style="stroke:var\(--bad\)"/);
  assert.doesNotMatch(b, />Close</, 'no text Close');
  assert.match(docOf(page('RUN-2')), /<button class="xclose"[^>]*data-act="runs-close"/);
  assert.match(docOf(page('RUN-404')), /<button class="xclose"[^>]*data-act="runs-close"/, 'the missing-run drawer too');
  const css = fs.readFileSync(path.join(DASH, 'norn', 'norn.css'), 'utf8');
  assert.match(css, /:root\.norn \.xclose \.xc-svg\{display:none\}/); assert.match(css, /:root:not\(\.norn\) \.xclose \.xc-art\{display:none\}/);
  assert.match(fs.readFileSync(path.join(DASH, 'index.html'), 'utf8'), /href="\/norn\/norn\.css"/, 'norn.css loads in both looks');
});
