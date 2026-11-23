// META-TEND P5: the audit run kind (the vendor `/doctor prompt-audit`, read-only), its report -> one advisory + card per hunk, the
// triggers (events, never a calendar), the stop rule (REPORT 6) and the watch after an accepted hunk. Sandbox state only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { parseAudit, auditsView, auditTriggers, stopRule, auditPrompt, auditScope, acceptText, policyModels, AUDIT_CMD } from '../engine/lib/audit.mjs';
import { startRun, writeTrees } from '../engine/lib/runs.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { settled } from './helpers/settled.mjs';

after(cleanTmp);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// the shape Claude Code 2.1.314's /doctor prompt-audit printed headless (trimmed): a Step 5 finding heading + a Step 6 diff
const REPORT = (n = 1, tag = 'step') => `# Prompt audit

## Findings

${Array.from({ length: n }, (_, i) => `### ${i + 1}. \`CLAUDE.md:${2 + i}\` \u2014 High confidence \u2014 \`remove\`

- **Evidence:** \`IMPORTANT: You MUST ALWAYS think step ${i}.\``).join('\n\n')}

### ${n + 1}. \`AGENTS.md:9\` \u2014 Low confidence \u2014 \`flag\`

## Proposed diff

\`\`\`diff
--- a/CLAUDE.md
+++ b/CLAUDE.md
${Array.from({ length: n }, (_, i) => `@@ -${2 + i},1 +${1 + i},0 @@\n-IMPORTANT: You MUST ALWAYS think ${tag} ${i}.`).join('\n')}
\`\`\`
`;

test('parseAudit: the Step 5 findings and the Step 6 diff split one hunk each, matched to their finding', () => {
  const a = parseAudit(REPORT(2));
  assert.equal(a.findings.length, 3);
  assert.deepEqual(a.findings.map(f => [f.file, f.line, f.confidence, f.action]), [['CLAUDE.md', 2, 'high', 'remove'], ['CLAUDE.md', 3, 'high', 'remove'], ['AGENTS.md', 9, 'low', 'flag']]);
  assert.equal(a.hunks.length, 2);
  assert.equal(a.hunks[1].line, 3); assert.equal(a.hunks[1].finding.line, 3);
  assert.match(a.hunks[0].patch, /^--- a\/CLAUDE\.md\n\+\+\+ b\/CLAUDE\.md\n@@ -2,1 \+1,0 @@\n-IMPORTANT/);
  assert.equal(a.hunks[0].removed, 'IMPORTANT: You MUST ALWAYS think step 0.');
  assert.deepEqual(parseAudit('the surface is clean').hunks, [], 'a clean audit = no hunk');
});

test('scope + prompt: the project files only (repo, project folder, memory), never user-level; the vendor command names them', () => {
  const p = { root: 'C:/r', project_dir: 'C:/np/x' };
  const rows = [{ path: 'C:/r/CLAUDE.md', exists: true }, { path: 'C:/np/x/rules/a.md', exists: true }, { path: 'C:/h/.claude/CLAUDE.md', exists: true, kind: 'user' },
    { path: 'C:/h/.claude/projects/r/memory/MEMORY.md', exists: true, kind: 'memory' }, { path: 'C:/r/AGENTS.md', exists: true, generated: true }, { path: 'C:/r/gone.md', exists: false }];
  const s = auditScope(rows, p);
  assert.deepEqual(s, ['C:/r/CLAUDE.md', 'C:/np/x/rules/a.md', 'C:/h/.claude/projects/r/memory/MEMORY.md']);
  assert.equal(auditPrompt(['C:/r/CLAUDE.md', 'C:/a b/x.md']), `${AUDIT_CMD} C:/r/CLAUDE.md "C:/a b/x.md"`);
});

function fx() {
  const t = mkTmp('meta-audit-'), state = path.join(t, 'state'), root = path.join(t, 'repo');
  fs.mkdirSync(state, { recursive: true }); fs.mkdirSync(root, { recursive: true });
  const p = { name: 'demo', root, state, policy: { checkin_model: 'claude-opus-5-5', executors: { claude: { model: 'claude-sonnet-5-5' } } } };
  const audit = (n, at, tag) => {
    const notes = path.join(state, `audit-${at.replace(/[:.]/g, "")}.md`); fs.writeFileSync(notes, REPORT(n, tag));
    const s = record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'audit', executor: 'claude', lane: 'audit', stage: 'audit', worktree: root, notes } }, { now: () => new Date(at) });
    record(state, { kind: 'run', ev: 'end', id: s.id, by: 'launcher', data: { exit: 0, outcome: 'done' } });
    return s.id;
  };
  const decide = (id, verdict, at) => record(state, { kind: 'decision', ev: 'create', by: 'dashboard', data: { lane: 'audit', advisory: id, question: 'audit hunk', choice: verdict === 'accept' ? 'accepted: apply the hunk' : 'declined: keep the text', why: 'test' } }, { now: () => new Date(at) });
  return { t, state, root, p, audit, decide, view: () => auditsView(p, loadState(state).items) };
}

test('auditsView: one advisory + open card per hunk; accept / decline = a decision citing the advisory; the stop rule stays manual', () => {
  const f = fx();
  const r1 = f.audit(2, '2026-11-01T10:00:00.000Z');
  let v = f.view();
  assert.equal(v.runs.length, 1); assert.equal(v.runs[0].outcome, 'done');
  assert.equal(v.cards.length, 2);
  const c = v.cards[0];
  assert.equal(c.phase, 'P5'); assert.equal(c.key, 'audit-hunk'); assert.equal(c.severity, 'high'); assert.equal(c.fix.tier, 'card'); assert.equal(c.run, r1);
  assert.equal(c.path, path.join(f.root, 'CLAUDE.md').replace(/\\/g, '/'));
  assert.match(acceptText(c), new RegExp(`advisory ${c.id}.*Patch:\\n--- a/CLAUDE.md`, 's'));
  assert.equal(f.view().cards[0].id, c.id, 'the same hunk keeps its id');
  f.decide(v.cards[0].id, 'accept', '2026-11-01T11:00:00.000Z');
  f.decide(v.cards[1].id, 'decline', '2026-11-01T11:01:00.000Z');
  v = f.view();
  assert.equal(v.cards.length, 0);
  assert.deepEqual([v.runs[0].accepted, v.runs[0].declined, v.runs[0].open], [1, 1, 0]);
  assert.equal(v.rule.mode, 'manual'); assert.match(v.rule.why, /1 of the first 2 audits ran/);
  const r2 = f.audit(3, '2026-11-02T10:00:00.000Z', 'again');
  for (const h of f.view().cards) f.decide(h.id, 'accept', '2026-11-02T11:00:00.000Z');
  v = f.view();
  assert.equal(v.runs.find(r => r.id === r2).accepted, 3);
  assert.equal(v.rule.mode, 'manual'); assert.match(v.rule.why, /yielded 1 and 3 accepted hunks/);
});

test('stopRule: auto only when the first two audits are decided with 3+ accepted hunks each', () => {
  const a = (acc, open = 0) => ({ outcome: 'done', hunks: [...Array(acc).fill({ status: 'accepted' }), ...Array(open).fill({ status: 'open' })] });
  assert.equal(stopRule([]).mode, 'manual');
  assert.match(stopRule([a(3), a(3, 1)]).why, /still have open hunks/);
  assert.equal(stopRule([a(3), a(4), a(0)]).mode, 'auto');
  assert.equal(stopRule([a(2), a(5)]).mode, 'manual');
});

test('watch after apply: the next runs after an accepted hunk - a stopped run or a correction naming the removed text is an alarm', () => {
  const f = fx();
  f.audit(1, '2026-11-01T10:00:00.000Z');
  const id = f.view().cards[0].id;
  f.decide(id, 'accept', '2026-11-01T11:00:00.000Z');
  record(f.state, { kind: 'directive', ev: 'create', by: 'dashboard', data: { via: 'dashboard', text: `Apply audit hunk (advisory ${id}) ... IMPORTANT ALWAYS think step` } }, { now: () => new Date('2026-11-01T11:00:01.000Z') });
  let v = f.view();
  assert.deepEqual(v.runs[0].watch, [{ id, seen: 0, of: 5, alarms: [], done: false }], 'the accept directive itself is no alarm');
  const run = record(f.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'x', worktree: f.root } }, { now: () => new Date('2026-11-01T12:00:00.000Z') });
  record(f.state, { kind: 'run', ev: 'end', id: run.id, by: 'launcher', data: { exit: 0, outcome: 'stopped', why: 'c - blocked' } });
  record(f.state, { kind: 'directive', ev: 'create', by: 'owner', data: { via: 'chat', text: 'Again: IMPORTANT, you must ALWAYS think step by step before acting' } }, { now: () => new Date('2026-11-01T13:00:00.000Z') });
  v = f.view();
  assert.equal(v.runs[0].watch[0].seen, 1);
  assert.equal(v.runs[0].watch[0].alarms.length, 2);
  assert.equal(v.advisories.length, 1); assert.equal(v.advisories[0].key, 'audit-watch'); assert.match(v.advisories[0].why, /stopped: c - blocked; DIR-\d+ names the removed text/);
});

test('triggers: never audited; a policy model change; a harness update; a repeated correction naming a rule; budget and growth', () => {
  const p = { policy: { checkin_model: 'claude-opus-5-5', executors: { claude: { model: 'claude-sonnet-5-5' } } } };
  assert.deepEqual(policyModels(p.policy), { checkin_model: 'claude-opus-5-5', 'executors.claude.model': 'claude-sonnet-5-5' });
  assert.deepEqual(auditTriggers(p, {}).map(t => t.key), ['never']);
  const stamp = { models: { checkin_model: 'claude-opus-5', 'executors.claude.model': 'claude-sonnet-5-5' }, harness: '2.1.300', sizes: { 'c:/r/agents.md': 900 } };
  const rows = [{ path: 'C:/r/CLAUDE.md', exists: true, load: 'session', tokens: 3200 }, { path: 'C:/r/AGENTS.md', exists: true, load: 'session', tokens: 1300 }, { path: 'C:/r/docs/x.md', exists: true, load: 'on-demand', tokens: 9000 }];
  const t = auditTriggers(p, { rows, machine: { claude: { version: '2.1.314' } }, stamp, cards: [{ id: 'A-1', rule: 'R-1', why: 'said 3 times' }, { id: 'A-2', rule: null, why: 'no rule' }] });
  assert.deepEqual(t.map(x => x.key), ['model', 'harness', 'repeat', 'budget', 'grown']);
  assert.match(t[0].why, /checkin_model claude-opus-5 -> claude-opus-5-5/);
  assert.match(t[1].why, /2\.1\.300 -> 2\.1\.314/);
  assert.equal(auditTriggers(p, { stamp: { ...stamp, models: policyModels(p.policy), harness: '2.1.314' }, machine: { claude: { version: '2.1.314' } } }).length, 0, 'nothing moved = no trigger');
});

test('the audit run kind: read-only, holds no tree lock, outcome = its exit, the final message becomes its report (notes)', async () => {
  const f = fx(), locks = path.join(f.t, 'locks'), notes = path.join(f.state, 'audits', 'audit-x.md'), canned = path.join(f.t, 'canned.txt');
  fs.mkdirSync(path.dirname(notes), { recursive: true });
  fs.writeFileSync(canned, REPORT(1));
  assert.deepEqual(writeTrees({ kind: 'audit', worktree: f.root }), []);
  const brief = path.join(f.t, 'b.md'); fs.writeFileSync(brief, 'mode: done\n');
  const r = startRun({ state: f.state, locksDir: locks, executor: 'fake', lane: 'audit', stage: 'audit', worktree: f.root, notes, brief, kind: 'audit', readonly: true,
    hbMs: 150, staleMs: 3000, policy: { auto_resume_max: 0, trigger_on_exit: false }, budget: {}, env: { FAKE_RESULT: canned } });
  assert.deepEqual(fs.existsSync(locks) ? fs.readdirSync(locks) : [], [], 'no worktree lock');
  for (const t0 = Date.now(); ; await sleep(50)) { const it = loadState(f.state).items[r.run]; if (settled(it) && it.end) break; if (Date.now() - t0 > 30000) throw new Error('timeout'); }
  const it = loadState(f.state).items[r.run];
  assert.equal(it.data.kind, 'audit'); assert.equal(it.end.outcome, 'done');
  assert.equal(f.view().cards.length, 1);
});

test('dash: the Inbox holds one card per open hunk; accept = a decision + the directive, decline = a decision; the tab lists the audits', async () => {
  const { fixture } = await import('./helpers/dash-fixture.mjs');
  const { renderTab } = await import('../engine/dash/ui.mjs');
  const f = await fixture();
  try {
    const st = f.pa.state, notes = path.join(st, 'audits', 'audit-1.md');
    fs.mkdirSync(path.dirname(notes), { recursive: true }); fs.writeFileSync(notes, REPORT(2));
    const s = record(st, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'audit', executor: 'claude', lane: 'audit', stage: 'audit', worktree: st, notes } });
    record(st, { kind: 'run', ev: 'end', id: s.id, by: 'launcher', data: { exit: 0, outcome: 'done' } });
    const ib = await f.get('/api/inbox?project=kestrel'), cards = ib.data.items.filter(i => i.type === 'audit');
    assert.equal(cards.length, 2);
    assert.match(renderTab('inbox', ib.data, { project: 'kestrel', now: Date.now() }), /id="inbox-audit"[\s\S]*CLAUDE\.md:2[\s\S]*data-act="audit-accept"[\s\S]*data-act="audit-decline"/);
    assert.equal((await f.post('/api/audit', { project: 'kestrel', id: cards[0].id, verdict: 'maybe' })).status, 400);
    const a = await f.post('/api/audit', { project: 'kestrel', id: cards[0].id, verdict: 'accept' });
    assert.equal(a.status, 200);
    const items = loadState(st).items;
    assert.equal(items[a.data.id].data.advisory, cards[0].id); assert.match(items[a.data.id].data.choice, /^accepted/);
    assert.ok(items[a.data.directive].data.text.startsWith(`Apply audit hunk (advisory ${cards[0].id}`));
    assert.equal((await f.post('/api/audit', { project: 'kestrel', id: cards[0].id, verdict: 'accept' })).status, 409, 'decided = closed');
    const d = await f.post('/api/audit', { project: 'kestrel', id: cards[1].id, verdict: 'decline' });
    assert.equal(d.data.directive, null);
    const v = auditsView({ ...f.pa, name: 'kestrel' }, loadState(st).items);
    const html = ['checks', 'growth'].map(sub => renderTab('context', { sub, rows: [], audits: v, measured: { roles: [], trend: { days: 30, rows: [{ day: '2026-11-13', key: 'worker', median_turn1: 30000 }, { day: '2026-11-14', key: 'worker', median_turn1: 32000 }, { day: '2026-11-14', key: 'checkin', median_turn1: 61000 }] } } }, {})).join('');   // META-UX-BUILD S4: the audits on the checks page, the trend in Growth
    assert.match(html, /id="ins-audits"[\s\S]*triggers stay manual[\s\S]*id="ins-audit-runs"[\s\S]*RUN-\d+[\s\S]*done[\s\S]*<td class="num">2<\/td><td class="num">1<\/td><td class="num">1<\/td><td class="num">0<\/td>[\s\S]*0 of 5 runs watched/);
    assert.match(html, /id="ins-trend"[\s\S]*<polyline points="[^"]+"\/>[\s\S]*workers <b>~32\.0k<\/b>[\s\S]*check-ins <b>~61\.0k<\/b>/);
  } finally { await f.done(); }
});

test('the per-file strip: one segment per paragraph, width by tokens, coloured by age, read and cite marks', async () => {
  const { renderTab } = await import('../engine/dash/ui.mjs');
  const file = { id: 'r1', path: 'C:/r/AGENTS.md', name: 'AGENTS.md', text: 'a\n\nb\n', tokens: 30, lines: 3, read_days: 30, evidence: { reads: 3, last: '2026-11-13T10:00:00.000Z', ranges: [], cites: [{ id: 'DEC-7', line: 3 }] },
    paras: [{ anchor: 'p1', line: 1, end: 1, tokens: 10, age_days: 3, read: 2, cited: [] }, { anchor: 'p2', line: 3, end: 3, tokens: 20, age_days: 45, stale: true, read: 0, cited: ['DEC-7'] }] };
  const html = renderTab('docs', { groups: [], files: 0, file: 'r1', doc: file }, {});   // META-UX-BUILD S3: the strip heads the Docs reader
  assert.match(html, /id="ins-strip"[\s\S]*class="psg age-new" href="#ins-p1" style="flex-basis:33\.33%"[^>]*><i class="pread"><\/i><\/a><a class="psg age-old stale" href="#ins-p2"[^>]*><i class="pcite"><\/i><\/a>/);
  assert.match(html, /read 3x in 30 days[\s\S]*cited by DEC-7/);
});

// the shape a real headless audit (RUN-850, norn, 2026-11-14) printed: findings in a table, the file in the heading, hunks headed "@@ F<n> :<lines>"
const TABLE_REPORT = `## Findings (file is \`CHECKIN-norn.md\` unless noted)

| # | Location | Evidence | Pattern | Why it's a problem | Conf. | Action |
|---|---|---|---|---|---|---|
| 1 | :46-47 | "every MERGE brief" | G2 out-of-date fact | the engine does it | High | **rewrite** (confirm first) |
| 3 | :2, :9 | "OWNS", "ALWAYS" | G1a: shouting | reasons given | Medium | rewrite |
| 7 | \`AGENTS.md:14\` | model pinned | G2 | stale | Low | flag |

## Proposed diff (\`C:/np/norn/rules/CHECKIN-norn.md\`)
\`\`\`diff
@@ F1 :46-47
-full-suite gate: (1) every MERGE brief you stage
-replaces its suite step
+full-suite gate: (1) policy.merge.suite puts it into every brief
@@ F3 :9
-  ALWAYS pass the NOTES' sha
+  pass the NOTES' sha
\`\`\`
`;
test('parseAudit: the table form - findings by row, the file from the heading, loose "@@ F<n> :<lines>" hunks made unified', () => {
  const a = parseAudit(TABLE_REPORT);
  assert.deepEqual(a.findings.map(f => [f.n, f.file, f.line, f.end, f.confidence, f.action]),
    [[1, 'CHECKIN-norn.md', 46, 47, 'high', 'rewrite'], [3, 'CHECKIN-norn.md', 2, 9, 'medium', 'rewrite'], [7, 'AGENTS.md', 14, 14, 'low', 'flag']]);
  assert.equal(a.hunks.length, 2);
  assert.deepEqual(a.hunks.map(h => [h.file, h.line, h.finding?.n]), [['C:/np/norn/rules/CHECKIN-norn.md', 46, 1], ['C:/np/norn/rules/CHECKIN-norn.md', 9, 3]]);
  assert.equal(a.hunks[0].patch, '--- a/C:/np/norn/rules/CHECKIN-norn.md\n+++ b/C:/np/norn/rules/CHECKIN-norn.md\n@@ -46,2 +46,1 @@ F1\n-full-suite gate: (1) every MERGE brief you stage\n-replaces its suite step\n+full-suite gate: (1) policy.merge.suite puts it into every brief\n');
});
