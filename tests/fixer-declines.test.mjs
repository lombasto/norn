// A fixer run that declines every finding with a reason is 'declined', not 'failed' (solve-shack RUN-180: "0 hunks in 0 files, 2
// skipped", both moves rightly refused). A declined finding keeps its reason and is not offered to the fixer again until its fix sentence
// or its file changes; the owner accepts the decline (the finding closes) or re-scopes it. `norn instructions suggest` never proposes
// moving a block out of a file read whole or out of a hard-stop section. Sandbox only (temp dirs, pure renders).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixResult, fixCards, verdictIds, fixPlan, fixDeclines, markDeclines, findingSig, fixerSigs, sigsFile, DECLINE_LANE } from '../engine/lib/fixer.mjs';
import { fixSheet, guardSummary } from '../engine/dash/guardparts.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { suggest, paragraphs } from '../engine/lib/instructions.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { record } from '../engine/lib/records.mjs';
import { fixture } from './helpers/dash-fixture.mjs';

const DECLINE = ['I looked at both and changed nothing.', '## Findings',
  '- T-S-ade581a4: skipped: moving the hard stops out of RULES.md is unsafe: every worker reads it whole',
  '- T-S-cebedfcb: skipped: the brief forbids the new file the move needs'].join('\n');
const IDS = ['T-S-ade581a4', 'T-S-cebedfcb'];

/** a project: RULES.md + CHECKIN.md in a temp repo, one fixall directive, one ended fixer run whose brief + sigs + notes are on disk */
function world(notes = DECLINE) {
  const root = mkTmp('fx-decl-'), repo = path.join(root, 'repo'), fx = path.join(root, 'state', 'fixer');
  fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(fx, { recursive: true });
  const rules = path.join(repo, 'RULES.md'), checkin = path.join(repo, 'CHECKIN.md');
  fs.writeFileSync(rules, '# Rules\n\nEvery worker reads this file whole.\n\n## Hard stops\n\nNever push main.\n');
  fs.writeFileSync(checkin, '# Check-in\n\n' + 'step\n'.repeat(40));
  const rows = [{ id: IDS[0], key: 'tighten-large|drafts', path: rules, line: 5, why: 'loaded 3.0x a day', action: 'move it to an on-demand file and leave a one-line pointer' },
    { id: IDS[1], key: 'tighten-large|drafts', path: checkin, line: 26, why: 'loaded 3.0x a day', action: 'move it to an on-demand file and leave a one-line pointer' }];
  const brief = path.join(fx, 'DIR-11-20261119T070000.brief.md'), note = brief.replace(/\.brief\.md$/, '.md');
  fs.writeFileSync(brief, rows.map(r => `- id: ${r.id}\n  file: ${r.path}:${r.line}`).join('\n'));
  fs.writeFileSync(sigsFile(brief), JSON.stringify(fixerSigs(rows)));
  fs.writeFileSync(note, notes);
  const items = { 'DEC-3': { id: 'DEC-3', kind: 'decision', state: 'in-force', created: '2026-11-19T06:00:00Z', data: { lane: 'fixall', findings: IDS } },
    'DIR-11': { id: 'DIR-11', kind: 'directive', state: 'active', created: '2026-11-19T06:00:01Z', data: { fixall: 'DEC-3', findings: IDS, text: 'Fix all' } },
    'RUN-180': { id: 'RUN-180', kind: 'run', state: 'ended', created: '2026-11-19T07:00:00Z', end: { outcome: 'done', at: '2026-11-19T07:20:00Z' }, data: { lane: 'fixall', stage: 'fixer', kind: 'audit', brief, notes: note } } };
  const guard = rows.map(r => ({ ...r, type: 'instructions', kind: 'drafts', batch: r.key, severity: 'low', surface: 'tighten: large', go: { tab: 'context' } }));
  return { root, repo, rules, checkin, rows, guard, items, brief, note };
}

test('a fixer run that skipped every finding with a reason is declined, not failed; one that meant to change code and gave no hunk is failed', () => {
  const r = fixResult(DECLINE, IDS);
  assert.deepEqual([r.declined, r.failed, r.fail], [true, false, null]);
  const lost = fixResult('## Findings\n- T-S-ade581a4: drafted\n- T-S-cebedfcb: skipped: no way', IDS);
  assert.deepEqual([lost.declined, lost.failed, lost.fail], [false, true, 'no parsable hunk'], 'a drafted finding without its hunk: failed');
  assert.equal(fixResult('- T-S-ade581a4: skipped\n- T-S-cebedfcb: skipped: x', IDS).failed, true, 'a skip without a reason is not a decline');
  assert.equal(fixResult('I could not read the files.', IDS).fail, 'no parsable hunk');
  const w = world(), [c] = fixCards(w.items);
  assert.deepEqual([c.state, c.fail, c.n], ['declined', null, 0]);
  assert.deepEqual(verdictIds(c), { ids: IDS, open: [] }, 'closing a declined card resolves its findings: the plan never re-offers them');
  const page = renderTab('inbox', { items: [{ type: 'fixresult', id: c.run, project: 'solve-shack', card: c }] }, { project: 'solve-shack' });
  assert.match(page, /<span class="chip[^"]*">declined<\/span> <b>Fixer result RUN-180/);
  assert.doesNotMatch(page, /failed: no parsable hunk/);
  assert.doesNotMatch(page, /data-choice="apply"/); assert.match(page, /data-choice="discard"[^>]*>Close</);
  assert.ok(page.includes('every worker reads it whole'), 'each reason on the card');
});

test('the same finding is not offered again: the row says "declined by RUN-n: <reason>" until its fix or its file changes', () => {
  const w = world(), d = fixDeclines(w.items);
  assert.deepEqual([...d.keys()], IDS);
  assert.equal(d.get(IDS[1]).why, 'the brief forbids the new file the move needs');
  const rows = markDeclines(w.guard, w.items);
  assert.deepEqual(rows.map(r => r.declined), [{ run: 'RUN-180', why: d.get(IDS[0]).why }, { run: 'RUN-180', why: d.get(IDS[1]).why }]);
  const g = { project: 'solve-shack', rows, total: rows.length, sent: [], fixcards: [] };
  assert.equal(fixSheet(g).items.length, 0, 'Fix all offers neither');
  assert.equal(guardSummary(g).offer, 0);
  // the closed directive's plan never takes them again either
  w.items['DEC-4'] = { id: 'DEC-4', kind: 'decision', state: 'in-force', created: '2026-11-19T08:00:00Z', data: { lane: 'fixall-result', directive: 'DIR-11', run: 'RUN-180', ids: IDS, choice: 'discard' } };
  assert.deepEqual(fixPlan(w.items['DIR-11'], w.items, { readBrief: r => fs.readFileSync(r.data.brief, 'utf8') }).left, []);
  // the page: the reason and the owner's two answers on the row
  const page = renderTab('slop', { ...guardSummary(g), limit: 40, sub: 'fix', fix: { batches: [{ key: 'tighten-large|drafts', kind: 'drafts', title: 'Tighten: a large block', severity: 'low', n: 2, rows }], nb: 1, n: 2, open: 'tighten-large|drafts' }, parts_loading: false }, { project: 'solve-shack' });
  assert.match(page, /declined by RUN-180: the brief forbids the new file the move needs/);
  assert.match(page, /data-act="fixdecline" data-verdict="accept" data-id="T-S-cebedfcb"/);
  assert.match(page, /data-act="fixdecline" data-verdict="rescope" data-id="T-S-cebedfcb"/);
  // the file changes: the decline lapses, the finding is offered again
  fs.appendFileSync(w.checkin, 'one more step\n');
  const after = markDeclines(w.guard, w.items);
  assert.deepEqual(after.map(r => !!r.declined), [true, false]);
  assert.equal(fixSheet({ ...g, rows: after }).items[0].n, 1);
});

test('the owner\'s answer: accept closes the finding; re-scope gives it a new fix and the fixer may take it again', () => {
  const w = world();
  w.items['DEC-5'] = { id: 'DEC-5', kind: 'decision', state: 'in-force', created: '2026-11-19T09:00:00Z', data: { lane: DECLINE_LANE, finding: IDS[0], run: 'RUN-180', verdict: 'accept' } };
  w.items['DEC-6'] = { id: 'DEC-6', kind: 'decision', state: 'in-force', created: '2026-11-19T09:01:00Z', data: { lane: DECLINE_LANE, finding: IDS[1], run: 'RUN-180', verdict: 'rescope', scope: 'trim the run-review steps in place' } };
  const rows = markDeclines(w.guard, w.items);
  assert.deepEqual(rows.map(r => r.id), [IDS[1]], 'the accepted decline closed its finding');
  assert.deepEqual([rows[0].action, rows[0].rescoped, rows[0].declined], ['trim the run-review steps in place', 'DEC-6', undefined]);
  assert.equal(fixSheet({ project: 'k', rows, sent: [] }).items[0].n, 1, 'offered again with the new fix');
  // the re-scoped fix declined again: it stands again (its fingerprint is the new fix)
  assert.notEqual(findingSig(rows[0], fs.readFileSync(w.checkin, 'utf8')), findingSig(w.guard[1], fs.readFileSync(w.checkin, 'utf8')));
  const brief2 = w.brief.replace('070000', '100000'), note2 = brief2.replace(/\.brief\.md$/, '.md');
  fs.writeFileSync(brief2, `- id: ${IDS[1]}\n  file: x`); fs.writeFileSync(sigsFile(brief2), JSON.stringify(fixerSigs(rows))); fs.writeFileSync(note2, `- ${IDS[1]}: skipped: still unsafe`);
  w.items['RUN-200'] = { id: 'RUN-200', kind: 'run', state: 'ended', created: '2026-11-19T10:00:00Z', end: { outcome: 'done' }, data: { lane: 'fixall', brief: brief2, notes: note2 } };
  assert.deepEqual(markDeclines(w.guard, w.items)[0].declined, { run: 'RUN-200', why: 'still unsafe' });
});

test('a run without its fingerprints declines nothing; a later run that drafts the finding ends the decline', () => {
  const w = world();
  fs.rmSync(sigsFile(w.brief));
  assert.equal(fixDeclines(w.items).size, 0);
  const w2 = world(), b = w2.brief.replace('070000', '090000'), n = b.replace(/\.brief\.md$/, '.md');
  fs.writeFileSync(b, `- id: ${IDS[0]}\n  file: x`); fs.writeFileSync(sigsFile(b), '{}'); fs.writeFileSync(n, `- ${IDS[0]}: drafted`);
  w2.items['RUN-190'] = { id: 'RUN-190', kind: 'run', state: 'ended', created: '2026-11-19T09:00:00Z', end: { outcome: 'done' }, data: { lane: 'fixall', brief: b, notes: n } };
  assert.deepEqual([...fixDeclines(w2.items).keys()], [IDS[1]]);
});

test('suggest never proposes moving a block out of a file read whole or out of a hard-stop section: trim in place', () => {
  const dir = mkTmp('fx-sug-'), big = 'word '.repeat(420).trim();
  const whole = path.join(dir, 'RULES.md'), safety = path.join(dir, 'GUIDE.md'), free = path.join(dir, 'NOTES.md');
  fs.writeFileSync(whole, `# Rules\n\nEvery worker reads this file whole.\n\n${big}\n`);
  fs.writeFileSync(safety, `# Guide\n\n## Hard stops\n\n${big}\n\n## Style\n\nCheck-ins: read the ledger first.\n`);
  fs.writeFileSync(free, `# Notes\n\n${big}\n\nCheck-ins: read the ledger first.\n`);
  const rows = [whole, safety, free].map((p, i) => ({ id: `f${i}`, path: p, name: path.basename(p), loads: [{ class: 'session' }] }));
  const paras = new Map(rows.map(r => [r.id, paragraphs(fs.readFileSync(r.path, 'utf8'), null)]));
  const perDay = new Map(rows.map(r => [r.id, { loads: 3, byRole: { checkin: 2, worker: 1 } }]));
  const s = suggest({ rows, paras, perDay });
  const of = (p, cls) => s.find(x => x.path === p && x.class === cls);
  assert.match(of(whole, 'large').action, /^trim it in place.*the file says it is read whole/);
  assert.match(of(safety, 'large').action, /^trim it in place.*hard-stop \/ safety section \(Hard stops\)/);
  assert.match(of(safety, 'one-role').action, /^move it to the checkin prompt/, 'outside the hard-stop section a move is still proposed');
  assert.match(of(free, 'large').action, /^move it to an on-demand file/);
  for (const x of s.filter(x => x.path === whole)) assert.doesNotMatch(x.action, /^move/);
});

test('POST /api/fixdecline: the row shows the decline; re-scope needs the new fix; accept closes the finding (ONE decision); a second tap is refused', { timeout: 240000 }, async () => {
  const f = await fixture();
  try {
    let s = (await f.get('/api/guard?project=kestrel&part=summary')).data;
    for (let i = 0; s.pending && i < 1200; i++) { await new Promise(r => setTimeout(r, 100)); s = (await f.get('/api/guard?project=kestrel&part=summary')).data; }
    const fix = (await f.get('/api/guard?project=kestrel&part=fix&limit=500')).data.fix, rows = fix.batches.flatMap(b => b.rows);
    const row = rows.find(r => r.path && (r.kind ?? 'drafts') !== 'count');
    assert.ok(row, 'the fixture has a finding to decline');
    const state = f.pa.state, fx = path.join(state, 'fixer'), brief = path.join(fx, 'DIR-1-20261119T070000.brief.md'), note = brief.replace(/\.brief\.md$/, '.md');
    fs.mkdirSync(fx, { recursive: true });
    let text = null; try { text = fs.readFileSync(row.path, 'utf8'); } catch { /* no file: the fingerprint holds null */ }
    fs.writeFileSync(brief, `- id: ${row.id}\n  file: ${row.path}`); fs.writeFileSync(sigsFile(brief), JSON.stringify({ [row.id]: findingSig(row, text) }));
    fs.writeFileSync(note, `## Findings\n- ${row.id}: skipped: the move is unsafe`);
    const run = record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'audit', executor: 'claude', lane: 'fixall', stage: 'fixer', brief, notes: note } });
    record(state, { kind: 'run', ev: 'end', id: run.id, by: 'launcher', data: { exit: 0, outcome: 'done' } });
    const now = (await f.get('/api/guard?project=kestrel&part=fix&limit=500')).data.fix.batches.flatMap(b => b.rows).find(r => r.id === row.id);
    assert.deepEqual(now.declined, { run: run.id, why: 'the move is unsafe' });
    assert.equal((await f.post('/api/fixdecline', { project: 'kestrel', id: row.id, verdict: 'rescope' })).status, 400, 're-scope needs the new fix');
    const before = (await f.get('/api/records?project=kestrel')).data.decisions.length;
    const r = await f.post('/api/fixdecline', { project: 'kestrel', id: row.id, verdict: 'accept' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const decs = (await f.get('/api/records?project=kestrel')).data.decisions;
    assert.equal(decs.length, before + 1);
    assert.deepEqual([decs.find(d => d.id === r.data.id).data.lane, decs.find(d => d.id === r.data.id).data.verdict], [DECLINE_LANE, 'accept']);
    const gone = (await f.get('/api/guard?project=kestrel&part=fix&limit=500')).data.fix.batches.flatMap(b => b.rows);
    assert.ok(!gone.some(x => x.id === row.id), 'the accepted decline closed the finding');
    assert.equal((await f.post('/api/fixdecline', { project: 'kestrel', id: row.id, verdict: 'accept' })).status, 409);
  } finally { await f.done(); }
});
