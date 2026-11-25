// RM-a-60 (docs/code-signals.md): lib/codesignals.mjs over a synthetic repo - partners from main's first-parent landings (a merged branch
// counts once, a batch landing past the cap is skipped, both counts carried), fix history (fix / revert landings, the 90 and 365 day
// counts, the newest first, a fix inside a merged branch dated at its landing, a commit older than the window dropped), fix_first in Borda
// order, an untyped history reading n/a with the reason - and `norn code history` storing it, `norn code signals` printing it, readSignals.
// Sandbox only (mkTmp).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { codeIndex } from '../engine/lib/codeindex.mjs';
import { codeSignals, readSignals, typeOf, SIGNAL_LIMITS } from '../engine/lib/codesignals.mjs';
import { codeCmd, codeAt } from '../engine/lib/codecli.mjs';

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
  const one = (await at('&part=file&file=src/a.mjs')).file;
  assert.deepEqual([one.partners, one.fixes.last[0].subject, one.fixes_na], [sig.files['src/a.mjs'].partners, 'fix(a): off by one', null]);
});

test('`norn code signals` on an untyped history prints n/a and the reason', () => {
  const { repo, state } = world(false), out = [], where = f => ({ project: null, state: f.state }), o = { out: s => out.push(s), err: () => {}, where, now: NOW };
  assert.equal(codeCmd(['history', '--repo', repo, '--state', state], o), 0);
  out.length = 0; assert.equal(codeCmd(['signals', 'src/a.mjs', '--state', state], o), 0);
  assert.match(out.join('\n'), /fix first n\/a[^]*fixes: n\/a \(0 of 7 commits in 365 days carry a conventional-commit type/);
});
