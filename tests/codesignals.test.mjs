// RM-a-60 (docs/code-signals.md): lib/codesignals.mjs over a synthetic repo - partners from main's first-parent landings (a merged branch
// counts once, a batch landing past the cap is skipped, both counts carried), fix history (fix / revert landings, the 90 and 365 day
// counts, the newest first, a fix inside a merged branch dated at its landing, a commit older than the window dropped), fix_first in Borda
// order, an untyped history reading n/a with the reason - and `norn code history` storing it, `norn code signals` printing it, readSignals.
// RM-a-70: the rank check (the rankings of 90 days ago against the fixes since, the baseline, n/a with the reason) and its line on the files
// part and in the daily report. Sandbox only (mkTmp).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { codeIndex } from '../engine/lib/codeindex.mjs';
import { codeSignals, readSignals, typeOf, checkLine, SIGNAL_LIMITS } from '../engine/lib/codesignals.mjs';
import { codeCmd, codeAt } from '../engine/lib/codecli.mjs';
import { rankLines, renderDaily } from '../engine/lib/slop/daily.mjs';
import { CLASSES, APART } from '../engine/lib/slop/loc.mjs';

test.after(cleanTmp);
const NOW = Date.parse('2026-11-20T12:00:00Z');
function world(typed = true) {
  const d = mkTmp('meta-sig-'), repo = path.join(d, 'repo'), state = path.join(d, 'state', 'kestrel');
  let k = 0;
  const w = f => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), `// ${f}\nexport const v${k++} = 1;\n`); };
  const g = (args, at) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...(at ? { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : {}) } });
  const land = (files, msg, at) => { files.forEach(w); g(['add', '-A']); g(['commit', '-q', '-m', typed ? msg : `change ${k}`], at); };
  fs.mkdirSync(repo, { recursive: true }); g(['init', '-q', '-b', 'main']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']); g(['config', 'core.autocrlf', 'false']);
  land(['src/a.mjs', 'src/b.mjs', 'src/c.mjs', 'notes.md'], 'fix: ancient', '2025-01-01T10:00:00Z');   // past the 365-day window
  fs.writeFileSync(path.join(repo, 'src/main.mjs'), "import { v } from './a.mjs';\n"); land([], 'feat: main', '2025-01-02T10:00:00Z');
  land(['src/a.mjs', 'src/b.mjs', 'src/c.mjs'], 'feat: a b c', '2026-06-01T10:00:00Z');
  land(['src/a.mjs', 'src/b.mjs'], 'feat(b): more', '2026-07-01T10:00:00Z');
  land(['src/a.mjs', 'src/b.mjs'], 'fix: b', '2026-08-01T10:00:00Z');
  g(['checkout', '-q', '-b', 'topic']);
  land(['src/c.mjs'], 'feat: c', '2026-10-10T10:00:00Z'); land(['src/a.mjs'], 'fix(a): off by one', '2026-10-11T10:00:00Z');
  g(['checkout', '-q', 'main']); g(['merge', '-q', '--no-ff', '-m', 'Merge branch topic', 'topic'], '2026-10-20T10:00:00Z');
  land(['src/a.mjs', 'src/b.mjs', ...Array.from({ length: 30 }, (_, i) => `gen/z${String(i).padStart(2, '0')}.txt`)], 'chore: format everything', '2026-11-01T10:00:00Z');
  land(['src/c.mjs'], 'Revert "feat: c"', '2026-11-10T10:00:00Z');
  return { repo, state, g, merge: g(['rev-parse', '--short=12', 'HEAD~2']).trim() };
}

test('typeOf: the conventional types (scope and ! allowed), git\'s Revert "...", nothing else', () => {
  assert.deepEqual(['fix: x', 'Fix(ui)!: y', 'feat(a): z', 'Revert "feat: c"', 'Merge branch topic', 'WIP: no', 'fixed it', 'chore:x'].map(typeOf), ['fix', 'fix', 'feat', 'revert', null, null, null, null]);
});

test('partners: shared landings in the window, a batch landing past the cap skipped, a merged branch once; both counts carried, strongest first', () => {
  const { repo } = world(), ix = codeIndex(repo, { now: NOW }), s = codeSignals(repo, ix, { now: NOW }), f = s.files;
  assert.equal(s.sha, ix.sha); assert.equal(s.basis, 'measured'); assert.deepEqual(s.limits, SIGNAL_LIMITS);
  assert.deepEqual([s.landings, s.batches_skipped, s.window.from, s.window.to], [6, 1, '2025-11-20', '2026-11-20']);
  assert.deepEqual([f['src/a.mjs'].landings, f['src/b.mjs'].landings, f['src/c.mjs'].landings, f['notes.md'].landings], [4, 3, 3, 0], 'the merge is one landing of a and c; the batch is none');
  assert.deepEqual(f['src/a.mjs'].partners, [{ file: 'src/b.mjs', shared: 3, share: 0.75, landings: 3 }]);
  assert.deepEqual(f['src/b.mjs'].partners, [{ file: 'src/a.mjs', shared: 3, share: 1, landings: 4 }]);
  assert.deepEqual(f['src/c.mjs'].partners, [], 'c shares 2 landings with a: under min_shared');
  assert.deepEqual(f['gen/z00.txt'].partners, []);
});

test('fix history: fix and revert landings per file, 90 / 365 days, newest first; the branch fix dated at its landing; fix_first in Borda order', () => {
  const { repo, merge } = world(), ix = codeIndex(repo, { now: NOW }), s = codeSignals(repo, ix, { now: NOW }), f = s.files;
  assert.deepEqual(s.fixes, { status: 'measured', typed: 7, commits: 7 });
  assert.deepEqual(f['src/a.mjs'].fixes, { n_90d: 1, n_365d: 2, last: [{ sha: merge, day: '2026-10-20', subject: 'fix(a): off by one', type: 'fix' }, { sha: f['src/a.mjs'].fixes.last[1].sha, day: '2026-08-01', subject: 'fix: b', type: 'fix' }] });
  assert.deepEqual([f['src/b.mjs'].fixes.n_365d, f['src/c.mjs'].fixes.n_365d, f['src/c.mjs'].fixes.last[0].type, f['notes.md'].fixes.n_365d], [1, 1, 'revert', 0], 'c\'s feat in the merge is no fix; ancient is past the window');
  const ff = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.fix_first]));
  assert.ok(ff['src/a.mjs'] > ff['src/c.mjs'] && ff['src/c.mjs'] > ff['src/b.mjs'] && ff['src/b.mjs'] > ff['gen/z00.txt'] && ff['gen/z00.txt'] > ff['notes.md'], JSON.stringify(ff));
  assert.ok(Object.values(ff).every(v => Number.isInteger(v) && v >= 0 && v <= 100));
  assert.equal(f['src/a.mjs'].importance, ix.files.find(x => x.file === 'src/a.mjs').importance, 'importance stays beside it');
});

test('a history without conventional-commit types: fixes and fix_first read n/a with the reason; partners still measured', () => {
  const { repo } = world(false), s = codeSignals(repo, codeIndex(repo, { now: NOW }), { now: NOW });
  assert.equal(s.fixes.status, 'n/a'); assert.match(s.fixes.reason, /0 of 7 commits in 365 days carry a conventional-commit type/);
  assert.deepEqual([s.files['src/a.mjs'].fixes, s.files['src/a.mjs'].fix_first, s.files['src/a.mjs'].partners.length], [null, null, 1]);
});

test('`norn code history` stores the signals; readSignals reads them; `norn code signals` prints files and --top; codeAt joins them', async () => {
  const { repo, state, merge } = world(), out = [], err = [], where = f => ({ project: null, state: f.state });
  const run = argv => { out.length = 0; return codeCmd(argv, { out: s => out.push(s), err: s => err.push(s), where, now: NOW }); };
  assert.equal(readSignals(state), null, 'none written yet');
  assert.equal(run(['signals', 'src/a.mjs', '--state', state]), 2); assert.match(err.join('\n'), /norn code history/);
  assert.equal(run(['history', '--repo', repo, '--state', state]), 0, err.join('\n'));
  const sig = readSignals(state);
  assert.equal(sig.sha, JSON.parse(fs.readFileSync(path.join(state, 'code', 'index.json'), 'utf8')).sha);
  assert.equal(run(['signals', 'src/a.mjs', './src/c.mjs', '--state', state]), 0, err.join('\n'));
  const txt = out.join('\n');
  assert.match(txt, new RegExp(`src/a\\.mjs · fix first ${sig.files['src/a.mjs'].fix_first} · importance \\d+`));
  assert.match(txt, /fixes: 1 in 90 days, 2 in 365 days; last 2026-10-20 [0-9a-f]{8} fix\(a\): off by one/);
  assert.match(txt, /changes with: src\/b\.mjs 3 shared \(75 % of 4 landings; it has 3\)/);
  assert.match(txt, /src\/c\.mjs[^]*changes with: none over the thresholds/);
  assert.match(txt, /measured from git at [0-9a-f]{12}/);
  assert.equal(run(['signals', 'src/a.mjs', '--json', '--state', state]), 0);
  const j = JSON.parse(out.join(''));
  assert.deepEqual([j.sha, j.fixes.status, j.files[0].file, j.files[0].fixes.last[0].sha], [sig.sha, 'measured', 'src/a.mjs', merge]);
  assert.equal(run(['signals', '--top', '2', '--state', state]), 0);
  assert.equal(out.filter(l => /^\s*\d+ /.test(l)).length, 2); assert.match(out.join('\n'), /^\s*\d+ .*src\/a\.mjs/m);
  assert.equal(run(['signals', 'nope.mjs', '--state', state]), 1); assert.match(out.join('\n'), /nope\.mjs: not in the index/);
  assert.equal(run(['signals', '--state', state]), 2, 'a file or --top');
  const p = { name: 'kestrel', state }, at = q => codeAt(p, new URL(`http://x/api/code?project=kestrel${q}`));
  const fl = await at('&part=files&sort=fix_first&limit=3');
  assert.equal(fl.list.sort, 'fix_first'); assert.deepEqual(fl.list.rows.map(r => r.file)[0], 'src/a.mjs');
  assert.deepEqual([fl.list.rows[0].fix_first, fl.list.rows[0].fixes_365d], [sig.files['src/a.mjs'].fix_first, 2]);
  assert.deepEqual(fl.list.checks, ['fix_first', 'importance'].map(rank => ({ rank, status: 'n/a', line: checkLine(sig.check, rank) })), 'the rank check line, worded by the signals');
  assert.match(fl.list.checks[0].line, /^fix-first check: n\/a \(5 files 90 days ago/);
  const one = (await at('&part=file&file=src/a.mjs')).file;
  assert.deepEqual([one.partners, one.fixes.last[0].subject, one.fixes_na], [sig.files['src/a.mjs'].partners, 'fix(a): off by one', null]);
});

test('`norn code signals` on an untyped history prints n/a and the reason', () => {
  const { repo, state } = world(false), out = [], where = f => ({ project: null, state: f.state }), o = { out: s => out.push(s), err: () => {}, where, now: NOW };
  assert.equal(codeCmd(['history', '--repo', repo, '--state', state], o), 0);
  out.length = 0; assert.equal(codeCmd(['signals', 'src/a.mjs', '--state', state], o), 0);
  assert.match(out.join('\n'), /fix first n\/a[^]*fixes: n\/a \(0 of 7 commits in 365 days carry a conventional-commit type/);
});

// RM-a-70 rank-selfcheck: the fix-first and importance rankings as they were check_days ago (that landing's tree and history only), their
// top check_top files against the fix landings since, beside the share of all files that got one (the baseline)
const T = { hot: Array.from({ length: 6 }, (_, i) => `src/h${i}.mjs`), cold: Array.from({ length: 54 }, (_, i) => `lib/c${String(i).padStart(2, '0')}.mjs`) };
function checkWorld({ start = '2026-01-05T10:00:00Z', after, typed = true }) {
  const d = mkTmp('meta-chk-'), repo = path.join(d, 'repo');
  let k = 0;
  const w = f => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), `// ${f}\nexport const v${k++} = ${k};\n`); };
  const g = (args, at) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...(at ? { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : {}) } });
  const land = (files, msg, at) => { files.forEach(w); g(['add', '-A']); g(['commit', '-q', '-m', typed ? msg : `change ${k}`], at); };
  fs.mkdirSync(repo, { recursive: true }); g(['init', '-q', '-b', 'main']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']); g(['config', 'core.autocrlf', 'false']);
  land([...T.hot, ...T.cold], 'feat: start', start);
  ['2026-06-10', '2026-07-10', '2026-08-10'].forEach((day, i) => land(T.hot, `fix: hot ${i}`, `${day}T10:00:00Z`));   // before the check day (2026-08-22)
  after.forEach(([files, day, msg], i) => land(files, msg ?? `fix: later ${i}`, `${day}T10:00:00Z`));
  return repo;
}
// the past landing's code graph, injected (norn-code is not needed): every file of that tree, no edge, or the edges given
const graphOfTree = (repo, at, edges = []) => ({ ok: true, prefix: '', files: new Map(execFileSync('git', ['-C', repo, 'ls-tree', '-r', '--name-only', at], { encoding: 'utf8', windowsHide: true }).trim().split('\n').map(p => [p, { lang: 'javascript', excluded: null }])), edges });
const sigOf = (repo, pastGraph = at => graphOfTree(repo, at)) => codeSignals(repo, codeIndex(repo, { now: NOW }), { now: NOW, pastGraph });

test('rank check: the top 20 as ranked 90 days ago against the fixes since, beside the baseline; both rankings, measured at the old landing', () => {
  const repo = checkWorld({ after: [[[...T.hot.slice(0, 4), 'lib/c50.mjs', 'lib/c51.mjs'], '2026-10-01']] }), s = sigOf(repo), c = s.check;
  const old = execFileSync('git', ['-C', repo, 'rev-list', '--first-parent', '-1', '--before=2026-08-22T12:00:00Z', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim().slice(0, 12);
  assert.deepEqual([c.status, c.basis, c.as_of, c.sha, c.days, c.files, c.fixed], ['measured', 'measured', '2026-08-22', old, 90, 60, 6]);
  assert.deepEqual([SIGNAL_LIMITS.check_days, SIGNAL_LIMITS.check_top, SIGNAL_LIMITS.check_min_history_days], [90, 20, 180]);
  for (const k of ['fix_first', 'importance']) {
    const r = c[k];
    assert.equal(r.status, 'measured'); assert.equal(r.top.length, 20); assert.equal(r.hit, 4, k);
    assert.deepEqual(r.top.slice(0, 6).map(x => x.file).sort(), [...T.hot].sort(), `${k}: the hot files led 90 days ago`);
    assert.deepEqual(r.top.filter(x => x.fixed).map(x => x.file).sort(), T.hot.slice(0, 4));
  }
  assert.equal(checkLine(c, 'fix_first'), '4 of the top 20 fix-first files got a fix in the last 90 days; baseline 10 % of files');
  assert.equal(checkLine(c, 'importance'), '4 of the top 20 importance files got a fix in the last 90 days; baseline 10 % of files');
});

test('rank check: a ranking at or under the baseline says so', () => {
  const s = sigOf(checkWorld({ after: [[T.cold.slice(48), '2026-10-01']] }));
  assert.deepEqual([s.check.fix_first.hit, s.check.fixed], [0, 6]);
  assert.equal(checkLine(s.check, 'fix_first'), '0 of the top 20 fix-first files got a fix in the last 90 days; baseline 10 % of files: at or under the baseline, the ranking predicted nothing');
});

test('rank check: too little history, an untyped history or no fix since reads n/a with the reason', () => {
  const short = sigOf(checkWorld({ start: '2026-06-01T10:00:00Z', after: [[T.hot, '2026-10-01']] })).check;
  assert.deepEqual([short.status, short.reason], ['n/a', 'the history starts 2026-06-01: under 180 days']);
  assert.equal(checkLine(short, 'fix_first'), 'fix-first check: n/a (the history starts 2026-06-01: under 180 days)');
  const untyped = sigOf(checkWorld({ after: [[T.hot, '2026-10-01']], typed: false })).check;
  assert.deepEqual([untyped.status, untyped.reason], ['n/a', '0 of 1 commits in the last 90 days carry a conventional-commit type (under 25 %)']);
  const none = sigOf(checkWorld({ after: [[T.hot, '2026-10-01', 'feat: grow']] })).check;
  assert.deepEqual([none.status, none.reason], ['n/a', 'no file got a fix in the last 90 days: nothing to predict']);
  assert.equal(checkLine(null, 'importance'), 'importance check: not built yet (`norn code history` writes it)');
  const few = sigOf(world()[`repo`]).check;
  assert.deepEqual([few.status, few.reason], ['n/a', '5 files 90 days ago: the top 20 is every file']);
});

test('rank check: the past importance ranks from the code graph AT the ranked landing; that graph not ok: importance n/a with its reason, fix-first still measured', () => {
  const repo = checkWorld({ after: [[[...T.hot.slice(0, 4), 'lib/c50.mjs', 'lib/c51.mjs'], '2026-10-01']] }), asked = [];
  const edges = T.cold.slice(0, 40).map(f => ({ from: f, to: 'lib/c50.mjs', kind: 'import', how: 'exact' }));   // c50: imported by 40 files then
  const c = sigOf(repo, at => { asked.push(at); return graphOfTree(repo, at, edges); }).check;
  assert.deepEqual(asked.map(x => x.slice(0, 12)), [c.sha], 'the graph of the ranked landing, not of HEAD');
  assert.equal(c.importance.status, 'measured');
  assert.equal(c.importance.top.find(x => x.file === 'lib/c50.mjs')?.fixed, true, "c50's past fan-in ranks it into the top");
  assert.equal(c.importance.hit, 5);
  const no = sigOf(repo, () => ({ ok: false, why: 'norn-code is not built (x)' })).check;
  assert.deepEqual([no.status, no.fix_first.status, no.fix_first.hit], ['measured', 'measured', 4], 'fix-first does not depend on the graph');
  assert.deepEqual(no.importance, { status: 'n/a', reason: `no code graph at ${no.sha}: norn-code is not built (x)` }, 'never ranked from churn alone');
  assert.equal(checkLine(no, 'importance'), `importance check: n/a (no code graph at ${no.sha}: norn-code is not built (x))`);
});

test('rank check in the daily report: rankLines reads the stored check, renderDaily prints it under its own heading; none stored says not built', () => {
  const { repo, state } = world(), o = { out: () => {}, err: () => {}, where: f => ({ project: null, state: f.state }), now: NOW };
  assert.deepEqual(rankLines(state), { sha: null, lines: ['fix-first check: not built yet (`norn code history` writes it)', 'importance check: not built yet (`norn code history` writes it)'] });
  assert.equal(codeCmd(['history', '--repo', repo, '--state', state], o), 0);
  const r = rankLines(state), sig = readSignals(state);
  assert.deepEqual(r, { sha: sig.sha, lines: [checkLine(sig.check, 'fix_first'), checkLine(sig.check, 'importance')] });
  const loc = { series: [], ref: 'main', head: 'abcdef0123', totals: Object.fromEntries(CLASSES.map(c => [c, 1])), apart: Object.fromEntries(APART.map(c => [c, 0])), areas: {}, landings: [] }, sw = { main: 'main', real: [], empty: [], unrelated: [], dead: [], at_risk: [], remote_merged: [] };
  const { markdown } = renderDaily(loc, sw, { day: '2026-11-20', ranks: r });
  assert.ok(markdown.includes(`## Rank check (signals at ${sig.sha})\n\n- ${r.lines[0]}\n- ${r.lines[1]}\n`), markdown);
  fs.writeFileSync(path.join(state, 'code', 'signals.json'), '{ torn');
  assert.match(rankLines(state).lines[0], /^could not read the code signals: /);
});
