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
import { VOICE, voicePrompt, parseHunks, voiceRoute, voiceCall, askVoice, branchClass } from '../engine/lib/slop/voice.mjs';
import { SETTINGS, applySettings, sectionOf } from '../engine/lib/policy.mjs';
import { hostWrite, voiceFindings, voicePrecision, voiceReadsToday, RATING } from '../engine/lib/slop/host.mjs';
import { endCheck } from '../engine/lib/slop/runend.mjs';
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
const asking = text => { const asked = []; const tool = (rule, _side) => { if (rule.kind !== 'model') return null; asked.push(rule); return text; }; tool.asked = asked; return tool; };

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

test('the run end calls the routed executor once, no tools (the fake executor); with no route each model rule is a WARN could-not-run, never invented', () => {
  const repo = repoOf({ 'src/a.mjs': 'export const a = 1;\n' }, { 'src/a.mjs': 'export const a = 1;\nexport const t = () => new Promise(r => setTimeout(r, 45000));\n' });
  const ans = path.join(mkTmp('slop-voice-ans-'), 'answer.md');
  fs.writeFileSync(ans, 'Here it is:\n```json\n' + answer([{ rule: 'M6', file: 'src/a.mjs', quote: 'export const t = () => new Promise(r => setTimeout(r, 45000));', why: 'a timeout the owner tunes' }]) + '\n```\n');
  const route = voiceRoute({ project: { policy: { slop: { voice_reader: 'fake' } } }, author: 'claude' });
  assert.equal(route.executor, 'fake');
  const r = slopCheck({ repo, base: 'main', rules: MODEL, tool: makeTool({ voice: route, env: { ...process.env, FAKE_RESULT: ans } }) });
  assert.ok(!r.findings.some(f => f.unrun), 'every model rule ran');
  assert.deepEqual(r.findings.map(f => [f.rule, f.line, f.shadow]), [['M6', 2, true]]);
  assert.match(r.findings[0].msg, /a timeout the owner tunes/);
  const none = slopCheck({ repo, base: 'main', rules: MODEL, tool: makeTool() });
  assert.deepEqual(none.findings.map(f => [f.rule, f.level, f.unrun, f.voice]), MODEL.map(m => [m.id, 'WARN', true, undefined]), 'no route: each model rule is a WARN "could not run", never an invented finding');
  assert.match(none.findings[0].msg, /^could not run: no second voice routed here/);
  assert.deepEqual(none.blocks, [], 'the voice is advisory: it holds nothing (SPEC 3.4)');
});

test('with no reader set the route is the author family at another model of the policy table, no tools; never another family', () => {
  const project = { policy: {} };   // the defaults: review = codex-sol, critical_implementation = implementer at Opus, docs = runner at Sonnet
  const opus = voiceRoute({ project, author: 'claude', authorModel: 'claude-opus-5-5' });
  assert.deepEqual([opus.executor, opus.family, opus.mode, opus.model, opus.cap], ['claude', 'claude', 'no-tools', 'claude-sonnet-5-5', 15], 'an Opus branch is read by the Sonnet row');
  assert.equal(voiceRoute({ project, author: 'claude', authorModel: 'claude-sonnet-5-5' }).model, 'claude-opus-5-5', 'and the reverse');
  const all = c => ({ policy: { executors: Object.fromEntries(['implementation', 'critical_implementation', 'review', 'diagnosis', 'planning', 'chores', 'passfail', 'images', 'docs'].map(k => [k, c])) } });
  const same = voiceRoute({ project: all({ executor: 'claude', model: 'claude-x', effort: 'low' }), author: 'claude', authorModel: 'claude-x' });
  assert.deepEqual([same.executor, same.mode, same.model], ['claude', 'no-tools', 'claude-x'], 'the table names no other model: the same one');
  const withFake = { policy: { executors: { review: { executor: 'fake', model: '', effort: '' } } } };
  assert.equal(voiceRoute({ project: withFake, author: 'claude', authorModel: 'claude-opus-5-5' }).family, 'claude', 'another family with no-tools is never the default');
  const typed = { executors: { tp: { type: 'openai-compatible', base_url: 'http://127.0.0.1:1/v1', model: 'tp-1', key_env: 'TP_KEY' } }, policy: { executors: { chores: { executor: 'tp', model: 'tp-1', effort: '' } } } };
  assert.equal(voiceRoute({ project: typed, author: 'claude', authorModel: 'claude-opus-5-5' }).family, 'claude', 'a typed executor on another account is never the default');
  assert.equal(voiceRoute({ project: all({ executor: 'claude', model: 'claude-x', effort: 'low' }), author: 'claude' }).model, 'claude-x', 'the author model unknown: the first row of the family');
  assert.equal(voiceRoute({ project, author: 'codex-sol', authorModel: 'gpt-x' }), null, 'the author family has no no-tools mode: no default read (never another vendor)');
});

test('a named reader: allowed for review or never routed (the save refuses it, 400); read-only when its family has no no-tools mode', () => {
  const named = voiceRoute({ project: { policy: { slop: { voice_reader: 'codex-sol gpt-x' } } }, author: 'claude', authorModel: 'claude-opus-5-5' });
  assert.deepEqual([named.executor, named.mode, named.model], ['codex-sol', 'read-only', 'gpt-x'], 'a named reader with its model');
  assert.equal(voiceRoute({ project: { policy: { slop: { voice_reader: 'codex-sol' } } }, author: 'claude' }).model, 'gpt-6.1-sol', 'no model named: its row of the policy table');
  const typed = { executors: { tp: { type: 'openai-compatible', base_url: 'http://127.0.0.1:1/v1', model: 'tp-1', key_env: 'TP_KEY' } } };
  assert.equal(voiceRoute({ project: { ...typed, policy: { slop: { voice_reader: 'tp' } } }, author: 'claude' }), null, 'a typed executor does chores and pass/fail only: never a reader');
  assert.equal(voiceRoute({ project: { ...typed, policy: { slop: { voice_reader: 'tp' }, allowed_classes: { tp: ['review'] } } }, author: 'claude' })?.executor, 'tp', 'allowed for review: routed');
  const extra = { providers: ['tp'] };
  assert.throws(() => applySettings({ policy: {} }, { 'policy.slop.voice_reader': 'tp' }, extra), e => e.status === 400 && /not allowed to do review/.test(e.message));
  assert.throws(() => applySettings({ policy: {} }, { 'policy.slop.voice_reader': 'nobody' }, extra), e => e.status === 400, 'an unknown executor');
  assert.throws(() => applySettings({ policy: { slop: { voice_reader: 'tp' }, allowed_classes: { tp: ['review'] } } }, { 'policy.allowed_classes.tp': ['chores'] }, extra), e => e.status === 400, 'narrowing the reader out of review is refused too');
  assert.equal(applySettings({ policy: {} }, { 'policy.slop.voice_reader': 'codex-sol gpt-x' }, extra).policy.slop.voice_reader, 'codex-sol gpt-x');
  assert.equal(applySettings({ policy: { slop: { voice_reader: 'codex-sol' } } }, { 'policy.slop.voice_reader': 'default' }, extra).policy.slop.voice_reader, 'default');
  const row = SETTINGS.find(s => s.key === 'policy.slop.voice_reader');
  assert.deepEqual([row.label, sectionOf(row).join('/'), SETTINGS.indexOf(row) - SETTINGS.findIndex(s => s.key === 'policy.slop.voice_reads_per_day')], ['Second voice: reader', 'voice/onoff', 1], 'beside the cap');
});

test('a read runs lean in its own empty folder: the prompt on stdin, no memory, skills, hooks or MCP servers; read-only in the empty folder', () => {
  const route = voiceRoute({ project: { policy: {} }, author: 'claude', authorModel: 'claude-opus-5-5' });
  const at = mkTmp('slop-voice-call-'), c = voiceCall({ ...route, exe: 'claude' }, at), a = c.cmd.args;
  for (const flag of ['--strict-mcp-config', '--disable-slash-commands', '--exclude-dynamic-system-prompt-sections']) assert.ok(a.includes(flag), flag);
  assert.equal(a[a.indexOf('--setting-sources') + 1], 'project,local', 'no user setup: no user memory, hooks, plugins');
  assert.equal(a[a.indexOf('--tools') + 1], '', 'no tools');
  assert.ok(!a.includes('--mcp-config') && !a.includes('--settings') && !a.includes('--agent'), a.join(' '));
  assert.deepEqual(a.flatMap((x, i) => (x === '--add-dir' ? [a[i + 1]] : [])), [c.cwd], 'the empty folder only');
  assert.deepEqual(fs.readdirSync(c.cwd), [], 'nothing in the folder the voice reads');
  assert.ok(!c.brief.startsWith(c.cwd) && !c.final.startsWith(c.cwd));
  const ro = voiceCall({ ...voiceRoute({ project: { policy: { slop: { voice_reader: 'codex-sol' } } }, author: 'claude' }), exe: 'codex' }, at);
  assert.ok(ro.cmd.args.includes('read-only') && !ro.cmd.args.includes('workspace-write'), ro.cmd.args.join(' '));
  assert.equal(voiceCall({ executor: 'fake', family: 'fake', model: 'fake', effort: 'low', mode: 'no-tools' }, at).cmd.args.includes('--read-only'), false);
});

test('a reader whose exe is a Windows npm .cmd shim spawns (node + its entry, no shell)', { skip: process.platform !== 'win32' }, () => {
  const bin = mkTmp('slop-voice-shim-');
  fs.writeFileSync(path.join(bin, 'cli.js'), "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify({result:s.length?'{\"findings\":[]}':'no stdin'})));\n");
  fs.writeFileSync(path.join(bin, 'claude.cmd'), '@ECHO off\r\n"%_prog%"  "%dp0%\\cli.js" %*\r\n');
  const route = { ...voiceRoute({ project: { policy: {} }, author: 'claude', authorModel: 'claude-opus-5-5' }), exe: path.join(bin, 'claude.cmd') };
  assert.equal(askVoice(route, 'the prompt'), '{"findings":[]}');
});

test('a cli entry is picked only in a mode it declares, and its call carries the entry', () => {
  const cli = modes => ({ type: 'cli', exe: 'tool.exe', model: 'm-1', effort: 'low', brief: 'file', args: ['--prompt-file', '{brief}', '{mode}', '-m', '{model}'], modes });
  const project = modes => ({ executors: { other: cli(modes) }, policy: { allowed_classes: { other: ['review'] }, slop: { voice_reader: 'other' } } });
  const r = voiceRoute({ project: project({ rw: { access: 'write', args: ['--all'] }, quiet: { access: 'no-tools', args: ['--no-tools'] } }), author: 'claude' });
  assert.deepEqual([r.executor, r.family, r.mode, r.model], ['other', 'cli', 'no-tools', 'm-1']);
  assert.ok(voiceCall(r, mkTmp('slop-voice-cli-')).cmd.args.includes('--no-tools'));
  assert.equal(voiceRoute({ project: project({ rw: { access: 'write', args: ['--all'] } }), author: 'claude' }), null, 'a cli entry with neither no-tools nor read-only is never picked');
});

test('the daily cap: the reads of the day are counted from the stored checks; over it each model rule is the WARN could-not-run, no call', () => {
  const repo = repoOf({ 'src/a.mjs': 'export const a = 1;\n' }, { 'src/a.mjs': 'export const a = 2;\n' });
  const state = mkTmp('slop-voice-cap-'), ans = path.join(mkTmp('slop-voice-ans-'), 'answer.md');
  fs.writeFileSync(ans, answer([]));
  const route = { ...voiceRoute({ project: { policy: { slop: { voice_reader: 'fake' } } }, author: 'claude' }), cap: 2 };
  hostWrite(state, { type: 'check', branch: 'feat/old', base: 'b'.repeat(40), head: 'o'.repeat(40), hash: 'x', blocks: [], findings: [], voice_reads: 1, at: '2001-01-01T00:00:00.000Z' });
  hostWrite(state, { type: 'check', branch: 'feat/w', base: 'b'.repeat(40), head: 'w'.repeat(40), hash: 'x', blocks: [], findings: [], voice_reads: 1 });
  assert.equal(voiceReadsToday(state), 1, 'only today (UTC) counts');
  const was = process.env.FAKE_RESULT;
  process.env.FAKE_RESULT = ans;
  try {
    const one = endCheck({ repo, state, voice: route });
    assert.ok(!one.result.findings.some(f => f.unrun), 'under the cap: read');
    assert.equal(one.check.voice_reads, 1);
    assert.equal(voiceReadsToday(state), 2);
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'again');
    const over = endCheck({ repo, state, voice: route }), unrun = over.result.findings.filter(f => f.unrun);
    assert.deepEqual(unrun.map(f => [f.rule, f.level, f.msg]), MODEL.map(m => [m.id, 'WARN', 'could not run: daily cap 2 reached']));
    assert.equal(over.check.voice_reads, undefined, 'no call: no read counted');
    assert.deepEqual(over.result.blocks, []);
  } finally { if (was === undefined) delete process.env.FAKE_RESULT; else process.env.FAKE_RESULT = was; }
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

test('the dashboard: a V- row with its thumb; POST /api/slop/rate records it, the row leaves and the rule shows its precision', async () => {
  const { fixture } = await import('./helpers/dash-fixture.mjs');
  const f = await fixture();
  try {
    hostWrite(f.pa.state, { type: 'check', branch: 'feat/v', lane: 'v', run: 'RUN-1', base: 'b'.repeat(40), head: 'h'.repeat(40), hash: 'x', blocks: [], findings: [vf('M1', 0)] });
    const fp = vf('M1', 0).fp, rules = async () => (await f.get('/api/guard?project=kestrel&part=rules')).data.rules;
    const voiceRows = async () => (await f.get('/api/guard?project=kestrel&part=fix')).data.fix.batches.flatMap(x => x.rows).filter(r => r.rate);
    const before = await rules();
    assert.deepEqual((await voiceRows()).map(r => [r.id, r.rate.fp]), [['V-' + fp, fp]]);
    assert.equal(before.precision.find(p => p.rule === 'M1').rated, 0);
    assert.equal((await f.post('/api/slop/rate', { project: 'kestrel', fp: 'f'.repeat(16), up: true })).status, 400, 'no model finding: refused');
    assert.equal((await f.post('/api/slop/rate', { project: 'kestrel', fp, up: 'yes' })).status, 400);
    const r = await f.post('/api/slop/rate', { project: 'kestrel', fp, up: true });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const after = await rules();
    assert.equal((await voiceRows()).length, 0, 'a rated finding leaves the Guard');
    assert.deepEqual(['rated', 'up', 'precision'].map(k => after.precision.find(p => p.rule === 'M1')[k]), [1, 1, 1]);
  } finally { await f.done(); }
});
