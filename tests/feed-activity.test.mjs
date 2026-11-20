// The feed's activity view (RM-36): dash/activity.mjs folds a run's feed events into what the worker is doing - the open call as a
// sentence, the plan, the files it touched, its commands with test counts, its commits. Pure: tested on transcripts trimmed from
// real runs (tests/fixtures/feed-activity, paths made neutral) through the claude adapter's own parser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transcriptEvents } from '../engine/lib/harness/claude.mjs';
import { clip, slimInput } from '../engine/lib/harness/common.mjs';
import { activityInit, activityAdd, activityView, activityOf, sentence, shell, stripCd, parseTests, briefItems, namedDone, relPath, fmtDur } from '../engine/dash/activity.mjs';

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'feed-activity');
const events = name => fs.readFileSync(path.join(FX, name), 'utf8').trim().split('\n').flatMap(l => transcriptEvents(l));
const ROOT = '/fx/wt', at = (evs, s = 5) => Date.parse(evs.at(-1).ts) + s * 1000;
const call = (name, input) => ({ name, input, ts: '2026-11-18T10:00:00Z' });

test('the claude adapter: a tool event carries its input, a result its text, a text event its words; long results keep their failure lines', () => {
  const evs = events('claude-rm19.jsonl');
  const read = evs.find(e => e.kind === 'tool' && e.name === 'Read');
  assert.equal(read.input.file_path, '/fx/wt/engine/lib/policy.mjs'); assert.equal(typeof read.summary, 'string');
  const edit = evs.find(e => e.kind === 'tool' && e.name === 'Edit');
  assert.equal(typeof edit.input.old_string, 'string'); assert.equal(typeof edit.input.new_string, 'string');
  assert.ok(evs.some(e => e.done && /ℹ pass 5/.test(e.text ?? '')), 'a test result keeps its counts');
  assert.ok(evs.find(e => e.kind === 'text').text.length >= evs.find(e => e.kind === 'text').summary.length);
  const big = ['head', ...Array.from({ length: 400 }, (_, i) => `line ${i} ok`), 'not ok 7 - the drawer paints', ...Array.from({ length: 400 }, (_, i) => `more ${i}`), '# pass 18', '# fail 1'].join('\n');
  const c = clip(big);
  assert.ok(c.length < 4500); assert.match(c, /^head/); assert.match(c, /not ok 7 - the drawer paints/); assert.match(c, /# fail 1$/);
  const w = slimInput({ file_path: 'a.md', content: 'x\n'.repeat(5000), nested: { a: 1 }, todos: [{ content: 'one', status: 'pending', activeForm: 'Doing one' }], n: 3 });
  assert.equal(w.content_lines, 5001); assert.ok(w.content.length <= 3000); assert.equal(w.nested, undefined); assert.equal(w.n, 3); assert.equal(w.todos[0].activeForm, 'Doing one');
});

test('now: one plain sentence per tool kind, relative to the worktree', () => {
  assert.equal(sentence(call('Read', { file_path: '/fx/wt/engine/lib/views.mjs', offset: 100, limit: 51 }), ROOT), 'Reading engine/lib/views.mjs, lines 100-150');
  assert.equal(sentence(call('Read', { file_path: 'C:\\fx\\wt\\a.md' }), 'C:/fx/wt'), 'Reading a.md');
  assert.equal(sentence(call('Edit', { file_path: '/fx/wt/tests/handedits.test.mjs' }), ROOT), 'Editing tests/handedits.test.mjs');
  assert.equal(sentence(call('Write', { file_path: '/elsewhere/x.md' }), ROOT), 'Writing /elsewhere/x.md');
  assert.equal(sentence(call('Grep', { pattern: 'hashKey', path: '/fx/wt/engine/lib' }), ROOT), "Searching engine/lib for 'hashKey'");
  assert.equal(sentence(call('Grep', { pattern: 'x', glob: '*.mjs' }), ROOT), "Searching the worktree for 'x' in *.mjs");
  assert.equal(sentence(call('Glob', { pattern: '**/*.test.mjs' }), ROOT), 'Looking for files **/*.test.mjs');
  const bash = c => sentence(call('Bash', { command: c }), ROOT);
  assert.equal(bash('cd "/fx/wt" && mkdir -p "$TEMP/e" && META_ROOT="$TEMP/e" timeout 300 node --test tests/dash-lanes.test.mjs 2>&1 | tail -5'), 'Running tests: node --test tests/dash-lanes.test.mjs 2>&1 | tail -5');
  assert.equal(bash('python -m pytest tests/test_x.py -q'), 'Running tests: python -m pytest tests/test_x.py -q');
  assert.equal(bash('git add a && git commit -qm "fix(queue): one lock"'), 'Committing: fix(queue): one lock');
  assert.equal(bash(`git commit -m "$(cat <<'EOF'\nfeat(x): heredoc subject\n\nbody\nEOF\n)"`), 'Committing: feat(x): heredoc subject');
  assert.equal(bash('sed -n 100,150p engine/lib/views.mjs'), 'Reading engine/lib/views.mjs, lines 100-150');
  assert.equal(bash('cat /fx/wt/README.md | head -20'), 'Reading README.md');
  assert.equal(bash('grep -rn "hashKey" engine/lib --include=*.mjs'), "Searching engine/lib for 'hashKey'");
  assert.equal(bash('git log --oneline -3'), 'Running git log: git log --oneline -3');
  assert.equal(bash('ls engine'), 'Running ls engine');
  assert.equal(sentence(call('Agent', { description: 'Search the docs' }), ROOT), 'Delegating: Search the docs');
  assert.equal(stripCd('cd "/fx/wt" && META_ROOT="$TEMP/x" timeout 300 node --test a && cd b'), 'node --test a && cd b', 'only the leading prefixes go');
  assert.deepEqual(shell('wc -l tests/a.test.mjs'), { kind: 'read', file: 'tests/a.test.mjs' });
});

test('now on a recorded run: the open call with how long; between calls "Thinking / writing"; the worker\'s latest words; an ended run says so', () => {
  const evs = events('claude-rm19.jsonl');
  const i = evs.findIndex(e => e.kind === 'tool' && e.name === 'Read'), s = evs.slice(0, i + 1).reduce(activityAdd, activityInit());
  const open = activityView(s, { root: ROOT, now: Date.parse(evs[i].ts) + 125000 });
  assert.match(open.now.text, /^Reading engine\/lib\/policy\.mjs/); assert.equal(open.now.busy, true); assert.equal(Math.round(open.now.secs), 125); assert.equal(fmtDur(open.now.secs), '2 min');
  const idle = activityOf(evs, { root: ROOT, now: at(evs) });
  assert.equal(idle.now.text, 'Thinking / writing'); assert.equal(idle.now.busy, false);
  assert.match(idle.words.text, /hand-off/);
  assert.equal(activityOf(evs, { root: ROOT, ended: true }).now.text, 'The run has ended');
  assert.equal(activityOf([], {}).now, null);
});

test('files: every file touched this run, grouped Read / Edited / Created with counts, newest first; shell reads count; a failed edit does not', () => {
  const evs = events('claude-rm19.jsonl'), v = activityOf(evs, { root: ROOT, now: at(evs) });
  assert.deepEqual(v.files.edited.map(f => [f.rel, f.reads, f.edits, f.diffs.length]), [['engine/lib/policy.mjs', 3, 3, 3]]);
  assert.deepEqual(v.files.created.map(f => f.rel), ['/fx/norn/state/norn/results/RUN-23/HANDOFF.md']);
  assert.ok(v.files.created[0].diffs[0].write && v.files.created[0].diffs[0].new.length > 0, 'a created file: its content');
  for (const f of ['engine/dash/ui.mjs', 'engine/dash/index.html', 'tests/helpers/dash-fixture.mjs', 'engine/lib/lanes.mjs']) assert.ok(v.files.read.some(r => r.rel === f), f + ' (read through the shell)');
  const lasts = v.files.read.map(r => r.last); assert.deepEqual(lasts, [...lasts].sort().reverse(), 'newest first');
  const r = activityOf([{ ts: '2026-11-18T10:00:00Z', kind: 'tool', name: 'Edit', id: 't1', input: { file_path: '/fx/wt/a.mjs', old_string: 'x', new_string: 'y' } },
    { ts: '2026-11-18T10:00:01Z', kind: 'error', id: 't1', done: true, summary: 'String not found', text: '<tool_use_error>String not found</tool_use_error>' }], { root: ROOT });
  assert.equal(r.files.edited.length + r.files.read.length + r.files.created.length, 0, 'a refused edit touched nothing');
});

test('commands and tests: duration and outcome per call; pass / fail counts from node --test (spec, TAP), pytest and ci-suite; failing names', () => {
  const evs = events('claude-rm19.jsonl'), v = activityOf(evs, { root: ROOT });
  const t = v.cmds.find(c => c.tests);
  assert.deepEqual(t.tests, { pass: 5, fail: 0, failed: [] }); assert.equal(t.outcome, 'ok'); assert.ok(t.secs > 1 && t.secs < 60, String(t.secs));
  assert.ok(v.cmds.every(c => !/^cd /.test(c.cmd)), 'the cd prefix is gone');
  const rd = activityOf(events('claude-readable.jsonl'), { root: ROOT });
  const red = rd.cmds.filter(c => c.tests?.fail);
  assert.ok(red.some(c => c.tests.pass === 3 && c.tests.fail === 2), 'probe: 3 pass, 2 fail');
  assert.ok(red.some(c => c.tests.failed.some(n => /setup elicitation/.test(n))), 'a failing test name');
  assert.ok(rd.cmds.some(c => c.outcome === 'background'), 'a backgrounded call says so');
  assert.deepEqual(parseTests('TAP version 13\nok 1 - a\nnot ok 2 - the drawer paints\n  ---\n1..2\n# tests 2\n# pass 1\n# fail 1\n'), { pass: 1, fail: 1, failed: ['the drawer paints'] });
  assert.deepEqual(parseTests('FAILED tests/test_feed.py::test_now - AssertionError\n========= 18 passed, 1 failed in 0.52s =========\n'), { pass: 18, fail: 1, failed: ['tests/test_feed.py::test_now'] });
  assert.deepEqual(parseTests('==== 4 passed, 2 warnings in 1.20s ====\n'), { pass: 4, fail: 0, failed: [] });
  assert.deepEqual(parseTests('=== a\nℹ pass 13\nℹ fail 1\n=== b\nℹ pass 2\nℹ fail 0\n✖ failing tests:\n✖ a red one (12.5ms)\n'), { pass: 15, fail: 1, failed: ['a red one'] });
  assert.deepEqual(parseTests('NEW RED: tests/x.test.mjs :: it breaks\nci-suite: 2 listed red(s), 1 new, 0 leak(s), 0 hang(s)\n'), { pass: null, fail: 1, listed: 2, failed: ['tests/x.test.mjs :: it breaks'] });
  assert.equal(parseTests('no counts here'), null);
});

test('commits: from the commit result ([branch sha] subject), else the -m message of a quiet commit; a refused commit is none', () => {
  const v = activityOf(events('claude-rm19.jsonl'), { root: ROOT });
  assert.equal(v.commits.length, 1); assert.match(v.commits[0].subject, /^feat\(policy\): policy\.done_lanes\.old_days/); assert.equal(v.commits[0].sha, null);
  const ev = (id, cmd, text, kind = 'tool') => [{ ts: '2026-11-18T10:00:00Z', kind: 'tool', name: 'Bash', id, input: { command: cmd } }, { ts: '2026-11-18T10:00:02Z', kind, id, done: true, text }];
  const w = activityOf([...ev('a', 'git commit -m "x"', '[norn/feed-activity 1a2b3c4] fix(feed): the now line\n 1 file changed'),
    ...ev('b', 'git commit -m "y"', 'nothing to commit, working tree clean'), ...ev('c', 'git commit -qm "z"', 'Exit code 1\nhook failed', 'error')]);
  assert.deepEqual(w.commits.map(c => [c.branch, c.sha, c.subject]), [['norn/feed-activity', '1a2b3c4', 'fix(feed): the now line']]);
  assert.equal(w.cmds.find(c => c.id === 'c').outcome, 'error'); assert.equal(w.cmds.find(c => c.id === 'c').exit, 1);
});

test('plan: the todo list when the worker keeps one, else the brief\'s numbered items done when the NOTES (with a done word) or a commit name them', () => {
  const todos = [{ content: 'Write the test', status: 'completed', activeForm: 'Writing the test' }, { content: 'Build it', status: 'in_progress', activeForm: 'Building it' }, { content: 'Ship', status: 'pending', activeForm: 'Shipping' }];
  const t = activityOf(transcriptEvents(JSON.stringify({ type: 'assistant', timestamp: '2026-11-18T10:00:00Z', message: { content: [{ type: 'tool_use', id: 'x', name: 'TodoWrite', input: { todos } }] } })));
  assert.deepEqual(t.plan, { source: 'todos', items: [{ text: 'Write the test', state: 'done' }, { text: 'Building it', state: 'current' }, { text: 'Ship', state: 'next' }] });
  const brief = '# task\n## Build\n1. **Now**, one plain sentence\n2. **Plan**: the todo list\n3. **Files**: every file\n4. **Edits live**: each Edit\n\nTests:\n1. not an item\n';
  const items = briefItems(brief);
  assert.deepEqual(items, [{ n: 1, title: 'Now' }, { n: 2, title: 'Plan' }, { n: 3, title: 'Files' }, { n: 4, title: 'Edits live' }]);
  assert.deepEqual(namedDone(items, '- Now: done\n- Plan: started\n- step 4 landed\n- the files view is next', { doneWord: true }), [1, 4], 'the NOTES need a done word');
  const commit = { ts: '2026-11-18T10:00:02Z', kind: 'tool', id: 'c', done: true, text: '[b 1a2b3c4] feat(dash): the Files group of the activity view' };
  const v = activityOf([{ ts: '2026-11-18T10:00:00Z', kind: 'tool', name: 'Bash', id: 'c', input: { command: 'git commit -m "x"' } }, commit], { brief: items, notesDone: [1] });
  assert.deepEqual(v.plan.items.map(i => [i.n, i.state]), [[1, 'done'], [2, 'current'], [3, 'done'], [4, 'next']]);
  assert.equal(activityOf([], {}).plan.source, null);
});

test('live = replayed: folding the events as they arrive gives the view of the whole run at once; diffs keep old -> new', () => {
  const evs = events('claude-readable.jsonl'), s = activityInit();
  for (const e of evs.slice(0, 80)) activityAdd(s, e);
  activityView(s, { root: ROOT });   // a paint mid-run changes nothing
  for (const e of evs.slice(80)) activityAdd(s, e);
  const o = { root: ROOT, now: at(evs) };
  assert.deepEqual(activityView(s, o), activityOf(evs, o));
  assert.equal(relPath('C:\\fx\\WT\\a\\b.mjs', 'c:/fx/wt/'), 'a/b.mjs');
});
