// SloppaChoppa stage F (RM-43): the second voice - the `model` rule kind. Temp git repos; the model is the fake executor (FAKE_RESULT =
// the canned answer) or a recorded answer: no real model call. The quote check, the docs / test-only skips, the ranked budget, the
// routing, the ratings and the Guard rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadRules, slopCheck, fingerprint, matchAny } from '../engine/lib/slop/check.mjs';
import { makeTool } from '../engine/lib/slop/tools.mjs';
import { VOICE, voicePrompt, parseHunks, voiceRoute, branchClass } from '../engine/lib/slop/voice.mjs';
import { hostWrite, voiceFindings, voicePrecision, RATING } from '../engine/lib/slop/host.mjs';
import { guardRows } from '../engine/lib/guardview.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
function repoOf(base, head) {
  const dir = mkTmp('slop-voice-'), put = files => { for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); } };
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'core.autocrlf', 'false');
  put(base); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--allow-empty', '-m', 'base'); git(dir, 'checkout', '-q', '-b', 'feat/v');
  put(head); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'head');
  return dir;
}
const MODEL = loadRules().filter(r => r.kind === 'model');
const answer = findings => JSON.stringify({ findings });
// a tool that records the model prompts it got and answers with `text`
const asking = text => { const asked = []; const tool = (rule, side) => { if (rule.kind !== 'model') return null; asked.push(rule); return text; }; tool.asked = asked; return tool; };

test('the six questions ship as model rules, every one in shadow at WARN', () => {
  assert.deepEqual(MODEL.map(r => r.id), ['M1', 'M2', 'M3', 'M4', 'M5', 'M6']);
  for (const r of MODEL) { assert.equal(r.shadow, true, r.id); assert.equal(r.level, 'WARN', r.id); assert.ok(r.question.length > 20, r.id); }
  assert.deepEqual(MODEL.filter(r => r.on.includes('tests')).map(r => r.id), ['M3'], 'a test-only branch asks question 3 alone');
});

test('the quote check: a finding stays only when its quote is an added line of its file; fingerprint = rule + file + quote; at most 10', () => {
  const added = Array.from({ length: 12 }, (_, i) => `export const v${i} = ${i};`);
  const repo = repoOf({ 'src/a.mjs': 'export const old = 1;\n' }, { 'src/a.mjs': ['export const old = 1;', ...added].join('\n') + '\n', 'src/b.mjs': 'export const b = 2;\n' });
  const tool = asking(answer([
    { rule: 'M1', file: 'src/a.mjs', quote: 'export const old = 1;', why: 'a base line: invented' },
    { rule: 'M1', file: 'src/a.mjs', quote: 'export const nowhere = 0;', why: 'no such line' },
    { rule: 'M1', file: 'src/b.mjs', quote: 'export const v1 = 1;', why: 'the right line in the wrong file' },
    { rule: 'M9', file: 'src/a.mjs', quote: 'export const v1 = 1;', why: 'a rule nobody asked' },
    { rule: 'M6', file: 'src/a.mjs', quote: '   export  const v0 = 0;  ', why: 'whitespace aside, an added line' },
    ...added.slice(1).map(q => ({ rule: 'M1', file: 'src/a.mjs', quote: q, why: 'one' })),
  ]));
  const r = slopCheck({ repo, base: 'main', rules: MODEL, tool });
  assert.equal(tool.asked.length, 1, 'ONE call for all six questions');
  assert.equal(r.findings.length, VOICE.max_findings);
  assert.ok(r.findings.every(f => f.file === 'src/a.mjs' && added.includes(f.snippet) && f.shadow && f.voice && f.new && f.level === 'WARN'));
  const m6 = r.findings.find(f => f.rule === 'M6');
  assert.equal(m6.line, 2, 'the line of the quoted added line');
  assert.equal(m6.fp, fingerprint('M6', 'src/a.mjs', 'export const v0 = 0;'));
  assert.deepEqual(r.blocks, [], 'shadow: never holds');
});

test('a docs-only branch is not read; a test-only branch asks question 3 alone; a code branch asks all six', () => {
  const docs = asking(answer([]));
  slopCheck({ repo: repoOf({ 'README.md': 'a\n' }, { 'README.md': 'b\n', 'docs/x.md': 'c\n' }), base: 'main', rules: MODEL, tool: docs });
  assert.equal(docs.asked.length, 0);
  const tests = asking(answer([]));
  slopCheck({ repo: repoOf({ 'tests/a.test.mjs': 'a\n' }, { 'tests/a.test.mjs': 'b\n', 'README.md': 'c\n' }), base: 'main', rules: MODEL, tool: tests });
  assert.equal(tests.asked.length, 1);
  assert.match(tests.asked[0].prompt, /^M3: /m);
  assert.doesNotMatch(tests.asked[0].prompt, /^M[124-6]: /m);
  const code = asking(answer([]));
  slopCheck({ repo: repoOf({ 'src/a.mjs': 'a\n' }, { 'src/a.mjs': 'b\n' }), base: 'main', rules: MODEL, tool: code });
  assert.equal(code.asked[0].id, 'M1+M2+M3+M4+M5+M6');
});

test('the input is ranked and capped: rule-hit hunks first, then code, then tests; what does not fit is listed by name', () => {
  const big = 'x'.repeat(Math.floor(VOICE.diff_tokens * VOICE.bytes_per_token * 0.6));
  const hunk = (file, line, text) => ({ file, text: `@@ -0,0 +${line},1 @@\n+${text}`, added: [{ line, text }] });
  const hunks = [hunk('tests/t.test.mjs', 1, big), hunk('src/plain.mjs', 1, big), hunk('src/hit.mjs', 7, big)];
  const p = voicePrompt({ rules: MODEL.filter(r => r.id === 'M1'), hunks, hits: [{ rule: 'K19', file: 'src/hit.mjs', line: 7, msg: 'drops the error', snippet: 'catch { return null; }' }],
    brief: 'Intro\nScope: src/**\n1. add the hit\n2. nothing else\nprose', context: [], match: matchAny });
  assert.deepEqual(p.shown, ['src/hit.mjs'], 'the hunk with a rule hit wins the budget');
  assert.deepEqual(p.listed.sort(), ['src/plain.mjs', 'tests/t.test.mjs']);
  assert.match(p.prompt, /K19 src\/hit\.mjs:7 drops the error/);
  assert.match(p.prompt, /Scope: src\/\*\*\n1\. add the hit\n2\. nothing else/);
  assert.doesNotMatch(p.prompt, /Intro|prose/);
  const q = voicePrompt({ rules: MODEL.filter(r => r.id === 'M1'), hunks: [hunk('tests/t.test.mjs', 1, 'x'), hunk('src/plain.mjs', 1, 'y')], match: matchAny });
  assert.ok(q.prompt.indexOf('--- src/plain.mjs') < q.prompt.indexOf('--- tests/t.test.mjs'), 'code before tests');
  assert.equal(branchClass(['docs/a.md', 'tests/b.test.mjs'], matchAny), 'tests');
  assert.equal(parseHunks('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n').map(h => h.added.map(a => a.line)).join(), '2,3');
});

test('the run end calls the routed executor once, no tools (the fake executor); with no route the model rules are skipped, never invented', () => {
  const repo = repoOf({ 'src/a.mjs': 'export const a = 1;\n' }, { 'src/a.mjs': 'export const a = 1;\nexport const t = () => new Promise(r => setTimeout(r, 45000));\n' });
  const ans = path.join(mkTmp('slop-voice-ans-'), 'answer.md');
  fs.writeFileSync(ans, 'Here it is:\n```json\n' + answer([{ rule: 'M6', file: 'src/a.mjs', quote: 'export const t = () => new Promise(r => setTimeout(r, 45000));', why: 'a timeout the owner tunes' }]) + '\n```\n');
  const route = voiceRoute({ project: { policy: { executors: { review: { executor: 'fake', model: '', effort: '' } } } }, author: 'claude' });
  assert.equal(route.executor, 'fake');
  const r = slopCheck({ repo, base: 'main', rules: MODEL, tool: makeTool({ voice: route, env: { ...process.env, FAKE_RESULT: ans } }) });
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.findings.map(f => [f.rule, f.line, f.shadow]), [['M6', 2, true]]);
  assert.match(r.findings[0].msg, /a timeout the owner tunes/);
  const none = slopCheck({ repo, base: 'main', rules: MODEL, tool: makeTool() });
  assert.deepEqual(none.findings, []);
  assert.deepEqual(none.skipped.map(s => s.rule), MODEL.map(m => m.id));
  assert.match(none.skipped[0].why, /no second voice routed here/);
});

test('the route: another model family than the author when the policy table has one, else the review route', () => {
  const project = { policy: {} };   // the defaults: review = codex-sol, critical_implementation = implementer (claude) with a model
  assert.equal(voiceRoute({ project, author: 'claude' }).executor, 'codex-sol');
  const other = voiceRoute({ project, author: 'codex-sol' });
  assert.equal(other.family, 'claude');
  assert.ok(other.model);
  const one = { policy: { executors: Object.fromEntries(['implementation', 'critical_implementation', 'review', 'diagnosis', 'planning', 'chores', 'passfail', 'images', 'docs'].map(c => [c, { executor: 'codex-sol', model: 'gpt-x', effort: 'low' }])) } };
  assert.deepEqual([voiceRoute({ project: one, author: 'codex-sol' }).executor, voiceRoute({ project: one, author: 'codex-sol' }).model], ['codex-sol', 'gpt-x']);
});

// ---------- ratings: thumbs on a model finding, per-rule precision, the promotion / demotion line (records the owner makes) ----------
const stateWith = findings => {
  const state = mkTmp('slop-voice-state-');
  hostWrite(state, { type: 'check', branch: 'feat/v', lane: 'v', run: 'RUN-1', base: 'b'.repeat(40), head: 'h'.repeat(40), hash: 'x', blocks: [], findings });
  return state;
};
const vf = (rule, i) => ({ rule, level: 'WARN', file: 'src/a.mjs', line: i + 1, msg: `${rule} finding ${i}`, snippet: `line ${i}`, fp: fingerprint(rule, 'src/a.mjs', `line ${i}`), new: true, shadow: true, voice: true });

test('a rating is recorded once per finding (the last one counts) and only on a stored model finding', () => {
  const state = stateWith([vf('M1', 0), vf('M1', 1), { ...vf('K2', 2), level: 'BLOCK', shadow: undefined, voice: undefined }]);
  hostWrite(state, { type: 'rating', fp: vf('M1', 0).fp, up: false, by: 'dashboard' });
  hostWrite(state, { type: 'rating', fp: vf('M1', 0).fp, up: true, by: 'dashboard' });
  assert.throws(() => hostWrite(state, { type: 'rating', fp: vf('K2', 2).fp, up: true, by: 'dashboard' }), /no model finding/);
  assert.throws(() => hostWrite(state, { type: 'rating', fp: 'f'.repeat(16), up: true, by: 'dashboard' }), /no model finding/);
  assert.throws(() => hostWrite(state, { type: 'rating', fp: vf('M1', 1).fp, up: 'yes', by: 'dashboard' }), /up is true or false/);
  const p = voicePrecision(state, MODEL).find(x => x.rule === 'M1');
  assert.deepEqual([p.rated, p.up, p.precision], [1, 1, 1]);
  assert.deepEqual(voiceFindings(state).flatMap(b => b.findings.map(f => f.fp)), [vf('M1', 1).fp], 'a rated finding leaves the list');
});

test('precision per rule; at 90 % over 20 rated it may go to BLOCK, under 50 % to TREND - a line to act on, never a level change', () => {
  const fs20 = Array.from({ length: RATING.rated }, (_, i) => vf('M2', i)), fs19 = Array.from({ length: RATING.rated - 1 }, (_, i) => vf('M3', i)), low = Array.from({ length: RATING.rated }, (_, i) => vf('M4', i));
  const state = stateWith([...fs20, ...fs19, ...low]);
  fs20.forEach((f, i) => hostWrite(state, { type: 'rating', fp: f.fp, up: i < 18, by: 'owner' }));    // 18 / 20 = 90 %
  fs19.forEach(f => hostWrite(state, { type: 'rating', fp: f.fp, up: true, by: 'owner' }));            // 100 % but only 19 rated
  low.forEach((f, i) => hostWrite(state, { type: 'rating', fp: f.fp, up: i < 9, by: 'owner' }));       // 45 %
  const by = Object.fromEntries(voicePrecision(state, MODEL).map(p => [p.rule, p]));
  assert.equal(by.M2.suggest, 'BLOCK'); assert.equal(by.M2.precision, 0.9);
  assert.equal(by.M3.suggest, null, 'fewer than 20 rated: no call yet');
  assert.equal(by.M4.suggest, 'TREND');
  assert.deepEqual([by.M5.rated, by.M5.precision, by.M5.suggest], [0, null, null]);
  assert.ok(MODEL.every(r => r.shadow && r.level === 'WARN'), 'the rule files are untouched: the owner or the controller records the change');
});

test('the Guard lists each unrated model finding with its thumbs (shadow: low, never a fix batch to send)', () => {
  const rows = guardRows({ voice: [{ branch: 'feat/v', run: 'RUN-1', findings: [vf('M5', 0)] }] });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.id, 'V-' + vf('M5', 0).fp);
  assert.deepEqual([r.type, r.severity, r.kind, r.path, r.line], ['code', 'low', 'count', 'src/a.mjs', 1]);
  assert.deepEqual(r.rate, { fp: vf('M5', 0).fp, rule: 'M5' });
  assert.match(r.why, /^M5: /);
  assert.equal(r.quote, 'line 0');
});
