// SPEC dash-owner-1123 s.7 (K1, K2, data side): lib/codeindex.mjs over a synthetic 3-commit repo - lines, growth weeks, churn, fan-in
// exact, importance's Borda order, binaries and vendor/ skipped, every week's rebuilt size equal to `git show <rev>:<file>` - and
// lib/codecli.mjs: `norn code history` writes <state>/code/index.json, codeAt serves its parts, tickCode starts it when the sha moves.
// Sandbox only (mkTmp).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { codeIndex, lineCount } from '../engine/lib/codeindex.mjs';
import { codeCmd, codeAt, tickCode } from '../engine/lib/codecli.mjs';

test.after(cleanTmp);
const DAY = 86400e3, NOW = Date.parse('2026-11-20T12:00:00Z');
const C1 = '2026-07-01T10:00:00Z', C2 = '2026-10-15T10:00:00Z', C3 = '2026-11-10T10:00:00Z';
function world() {
  const d = mkTmp('meta-code-'), repo = path.join(d, 'repo'), state = path.join(d, 'state', 'kestrel');
  const w = (f, t) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), t); };
  const g = (args, at) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...(at ? { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : {}) } });
  fs.mkdirSync(repo, { recursive: true }); g(['init', '-q', '-b', 'main']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']); g(['config', 'core.autocrlf', 'false']);
  w('engine/a.mjs', "import { b } from './b.mjs';\nimport { c } from './c.mjs';\nexport const a = b + c;\n"); w('engine/b.mjs', 'export const b = 1;\n// b\n'); w('engine/c.mjs', 'export const c = 1;\n');
  w('README.md', '# fixture\ntext');   // no final newline: still 2 lines
  w('vendor/lib.js', "import { b } from '../engine/b.mjs';\n1\n2\n3\n4\n"); w('img.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2, 10, 0, 10]));
  g(['add', '-A']); g(['commit', '-q', '-m', 'one'], C1);
  w('engine/b.mjs', 'export const b = 2;\n// b\n// more\n// more\n'); w('engine/d.mjs', "import { b } from './b.mjs';\nexport const d = b;\n");
  g(['add', '-A']); g(['commit', '-q', '-m', 'two'], C2);
  w('engine/a.mjs', "import { b } from './b.mjs';\nimport { c } from './c.mjs';\nexport const a = b + c;\n// one\n// two\n"); w('engine/b.mjs', 'export const b = 3;\n// b\n// more\n// more\n');
  g(['add', '-A']); g(['commit', '-q', '-m', 'three: grow a'], C3);
  return { repo, state, g, sha: g(['rev-parse', '--short=12', 'HEAD']).trim() };
}
const byFile = ix => Object.fromEntries(ix.files.map(f => [f.file, f]));

test('K1 K2 codeIndex: lines, born, churn, growth weeks and fan-in exact; importance in Borda order; binaries and vendor/ skipped', () => {
  const { repo, sha } = world(), ix = codeIndex(repo, { now: NOW }), f = byFile(ix);
  assert.equal(ix.sha, sha);
  assert.deepEqual(Object.keys(f).sort(), ['README.md', 'engine/a.mjs', 'engine/b.mjs', 'engine/c.mjs', 'engine/d.mjs'], 'img.png (binary) and vendor/ are dropped');
  assert.deepEqual(Object.fromEntries(ix.files.map(x => [x.file, [x.lines, x.commits_90d, x.churn_90d, x.fan_in]])),
    { 'README.md': [2, 0, 0, null], 'engine/a.mjs': [5, 1, 2, 0], 'engine/b.mjs': [4, 2, 6, 2], 'engine/c.mjs': [1, 0, 0, 1], 'engine/d.mjs': [2, 1, 2, 0] }, 'the vendor importer of b is not counted');
  assert.equal(f['engine/b.mjs'].rel_churn, 1.5);
  assert.equal(f['engine/a.mjs'].lang, 'javascript'); assert.equal(f['README.md'].lang, 'markdown');
  assert.equal(f['engine/a.mjs'].born, '2026-07-01'); assert.equal(f['engine/d.mjs'].born, '2026-10-15');
  assert.equal(f['engine/a.mjs'].bytes, fs.statSync(path.join(repo, 'engine/a.mjs')).size);
  assert.equal(ix.added_30d, 3, 'the last 30 days: a +2, b +1');
  assert.equal(ix.weeks.length, 26); assert.equal(ix.weeks.at(-1), '2026-11-20'); assert.equal(ix.weeks[0], new Date(NOW - 25 * 7 * DAY).toISOString().slice(0, 10));
  const ends = ix.weeks.map((_, i) => NOW - (25 - i) * 7 * DAY), at = (e, xs) => xs.findLast(([t]) => Date.parse(t) <= e)?.[1] ?? 0;
  assert.deepEqual(f['engine/a.mjs'].growth, ends.map(e => at(e, [[C1, 3], [C3, 5]])));
  assert.deepEqual(f['engine/b.mjs'].growth, ends.map(e => at(e, [[C1, 2], [C2, 4]])));
  assert.deepEqual(f['engine/d.mjs'].growth, ends.map(e => at(e, [[C2, 2]])));
  assert.deepEqual(f['engine/a.mjs'].last.map(c => [c.day, c.subject, c.added, c.deleted]), [['2026-11-10', 'three: grow a', 2, 0], ['2026-07-01', 'one', 3, 0]]);
  // Borda over fan_in (null = 0) and churn_90d, scaled to 0-100: b leads both, README trails both, a / c / d tie
  assert.deepEqual(Object.fromEntries(ix.files.map(x => [x.file, x.importance])), { 'README.md': 19, 'engine/a.mjs': 44, 'engine/b.mjs': 100, 'engine/c.mjs': 44, 'engine/d.mjs': 44 });
});

test('kill check: every week\'s rebuilt size equals the line count of `git show <rev>:<file>` at that week\'s first-parent rev', () => {
  const { repo, g } = world(), ix = codeIndex(repo, { now: NOW });
  ix.weeks.forEach((_, i) => {
    const e = Math.floor((NOW - (25 - i) * 7 * DAY) / 1000), rev = g(['rev-list', '--first-parent', '-1', `--before=@${e}`, 'HEAD']).trim();
    for (const x of ix.files) {
      let n = 0;
      if (rev) { try { n = lineCount(execFileSync('git', ['-C', repo, 'show', `${rev}:${x.file}`], { stdio: ['ignore', 'pipe', 'ignore'] })); } catch { n = 0; /* not there yet */ } }
      assert.equal(x.growth[i], n, `${x.file} week ${ix.weeks[i]}`);
    }
  });
});

test('codecli: history writes <state>/code/index.json; codeAt serves the summary and the files / growth / outliers / file / map parts', async () => {
  const { repo, state, sha } = world(), out = [], err = [];
  const where = f => ({ project: null, state: f.state });
  assert.equal(codeCmd(['history', '--repo', repo, '--state', state, '--json'], { out: s => out.push(s), err: s => err.push(s), where, now: NOW }), 0, err.join('\n'));
  assert.equal(JSON.parse(out.join('')).files, 5);
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'code', 'index.json'), 'utf8')).sha, sha);
  assert.equal(codeCmd(['bogus'], { out: () => {}, err: s => err.push(s), where }), 2);
  const p = { name: 'kestrel', state }, at = q => codeAt(p, new URL(`http://x/api/code?project=kestrel${q}`));
  assert.deepEqual((await at('')).total, { files: 5, lines: 14, added_30d: 3, hotspot: 'engine/b.mjs' });
  const fl = await at('&part=files&sort=lines&folder=engine&limit=2');
  assert.deepEqual(fl.list.rows.map(r => [r.file, r.lines, r.delta]), [['engine/a.mjs', 5, 5], ['engine/b.mjs', 4, 4]]);
  assert.deepEqual([fl.list.matched, fl.list.shown, fl.list.sort, fl.list.folder], [4, 2, 'lines', 'engine']);
  assert.deepEqual(fl.list.folders, [['engine', 4]]);
  const gr = await at('&part=growth');
  assert.deepEqual(gr.areas.map(a => [a.key, a.points.at(-1).y]), [['engine', 12], ['.', 2]]);
  assert.deepEqual(gr.fastest.map(r => r.file), ['engine/a.mjs', 'engine/b.mjs', 'README.md', 'engine/d.mjs', 'engine/c.mjs']);
  const ou = await at('&part=outliers');
  assert.deepEqual(ou.size.find(x => x.id === 'engine/a.mjs'), { id: 'engine/a.mjs', label: 'engine/a.mjs', value: 5 });
  assert.equal(ou.churn.find(x => x.id === 'engine/b.mjs').value, 6);
  const one = await at('&part=file&file=engine/a.mjs');
  assert.equal(one.file.lines, 5); assert.equal(one.file.days.length, 26); assert.equal(one.file.last[0].subject, 'three: grow a');
  assert.equal((await at('&part=file&file=nope.mjs')).file, null);
  assert.deepEqual(await at('&part=map'), { map: null });
  const none = { name: 'empty', state: path.join(path.dirname(state), 'empty') };
  assert.deepEqual((await codeAt(none, new URL('http://x/api/code'))).index, null);
  assert.deepEqual(await codeAt(none, new URL('http://x/api/code?part=files')), { list: null });
});

test('tickCode: starts `norn code history` detached when the sha moved, not again within 10 minutes, not when the index is at HEAD', () => {
  const { repo, state, g } = world(), calls = [], spawnFn = (exe, args) => { calls.push(args); return { pid: 7 }; };
  const p = { file: path.join(repo, 'kestrel.json'), root: repo };
  assert.equal(tickCode(p, state, { metaCmd: 'norn.mjs', spawnFn, now: NOW }), 'code history: started pid 7');
  assert.deepEqual(calls[0], ['norn.mjs', 'code', 'history', '--project', p.file, '--state', state]);
  assert.equal(tickCode(p, state, { metaCmd: 'norn.mjs', spawnFn, now: NOW + 5 * 60e3 }), null, 'one started 5 min ago');
  fs.mkdirSync(path.join(state, 'code'), { recursive: true });
  fs.writeFileSync(path.join(state, 'code', 'index.json'), JSON.stringify({ sha: g(['rev-parse', '--short=12', 'HEAD']).trim(), files: [] }));
  assert.equal(tickCode(p, state, { metaCmd: 'norn.mjs', spawnFn, now: NOW + 60 * 60e3 }), null, 'the index is at HEAD');
  assert.equal(calls.length, 1);
});
