// RM-a-68 (engine/lib/slop/rules/README.md "The second voice"): lib/coderisk.mjs over a synthetic repo - a diff's numbers (files, lines,
// the fix history and fix-first rank of its files, the companions it leaves out), its percentile against the landings before its merge
// base with the numbers that put it there, n/a with the reason (no signals, too few landings), an untyped history ranking without the fix
// numbers - and `norn code risk <base>..<head>`. Sandbox only (mkTmp).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { codeIndex } from '../engine/lib/codeindex.mjs';
import { codeSignals, writeSignals } from '../engine/lib/codesignals.mjs';
import { codeRisk, rankOf, RISK_LIMITS } from '../engine/lib/coderisk.mjs';
import { codeCmd } from '../engine/lib/codecli.mjs';

test.after(cleanTmp);
const NOW = Date.parse('2026-11-20T12:00:00Z');
// main: 12 three-line doc landings and 3 fix landings that change src/a.mjs with src/b.mjs; branch big: 40 lines of a without b; branch tiny: a one-line doc
function world({ typed = true, signals = true, docs = 12 } = {}) {
  const d = mkTmp('meta-risk-'), repo = path.join(d, 'repo'), state = path.join(d, 'state', 'kestrel');
  const g = (args, at) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...(at ? { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : {}) } });
  const put = (f, t) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), t); };
  let k = 0;
  const land = (files, msg, n = 1) => { const at = new Date(Date.parse('2026-10-01T10:00:00Z') + k++ * 36e5).toISOString(); for (const f of files) put(f, Array.from({ length: n }, (_, i) => `// ${f} ${k} ${i}\n`).join('')); g(['add', '-A']); g(['commit', '-q', '-m', typed ? msg : `change ${k}`], at); };
  fs.mkdirSync(repo, { recursive: true }); g(['init', '-q', '-b', 'main']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']); g(['config', 'core.autocrlf', 'false']);
  for (let i = 0; i < docs; i++) land([`docs/n${i}.md`], `docs: note ${i}`, 3);
  for (let i = 0; i < 3; i++) land(['src/a.mjs', 'src/b.mjs'], `fix: a and b ${i}`, 2);
  if (signals) writeSignals(state, codeSignals(repo, codeIndex(repo, { now: NOW }), { now: NOW }));
  g(['checkout', '-q', '-b', 'big']); land(['src/a.mjs'], 'feat: a grows', 40);
  g(['checkout', '-q', 'main']); g(['checkout', '-q', '-b', 'tiny']); land(['docs/t.md'], 'docs: one line');
  g(['checkout', '-q', 'main']);
  return { repo, state };
}

test('rankOf: Borda over the numbers used, the percentile of landings below (ties half), the highest standings as the why', () => {
  const pool = [1, 2, 3, 4].map(v => ({ lines: v, files: 1, companions: 0 })), used = ['lines', 'files', 'companions'];
  const top = rankOf({ lines: 9, files: 1, companions: 1 }, pool, used);
  assert.equal(top.pct, 100);
  assert.deepEqual(top.why.map(w => [w.key, w.value, w.pct]), [['lines', 9, 100], ['companions', 1, 100], ['files', 1, 50]], 'highest standing first, ties in RISK_NUMBERS order');
  assert.equal(rankOf({ lines: 0, files: 1, companions: 0 }, pool, used).pct, 0);
  assert.equal(rankOf({ lines: 2, files: 1, companions: 0 }, pool, used).pct, 38, 'sums 4, 5.5, 6.5, 7.5 against its 5.5: one below, one equal (half) = 1.5 of 4');
  assert.equal(RISK_LIMITS.landings, 100);
});

test('a diff ranked against the landings before its merge base: the big fix-file change that leaves its companion out is high, a doc line is low', () => {
  const { repo, state } = world(), big = codeRisk({ dir: repo, state, base: 'main', head: 'big' }), tiny = codeRisk({ dir: repo, state, base: 'main', head: 'tiny' });
  assert.deepEqual(big.numbers, { files: 1, lines: 42, fixes: 3, fix_first: big.numbers.fix_first, companions: 1 });
  assert.deepEqual(big.left_out, [{ file: 'src/a.mjs', partner: 'src/b.mjs', shared: 3, landings: 3 }]);
  assert.equal(big.landings, 15);
  assert.ok(big.pct >= 80, big.line);   // the three fix landings of a and b stand high too
  assert.ok(tiny.pct <= 30 && tiny.pct < big.pct, tiny.line);
  assert.deepEqual([tiny.numbers.companions, tiny.numbers.fixes], [0, 0]);
  assert.match(big.line, /^riskier than \d+ % of the last 15 landings \(.*companions left out 1, over \d+ %.*\) · measured from git and the signals at [0-9a-f]{12}$/);
  assert.equal(big.why.length, RISK_LIMITS.why);
  assert.equal(big.sha.length, 12);
});

test('n/a with the reason: no signals stored, or too few landings for a percentile; never a guessed rank', () => {
  const none = world({ signals: false }), r = codeRisk({ dir: none.repo, state: none.state, base: 'main', head: 'big' });
  assert.deepEqual([r.pct, r.line], [null, 'risk rank n/a: no code signals stored yet (`norn code history` writes them)']);
  assert.deepEqual(r.numbers, { files: 1, lines: 42 });
  const few = world({ docs: 2 }), f = codeRisk({ dir: few.repo, state: few.state, base: 'main', head: 'big' });
  assert.equal(f.pct, null);
  assert.match(f.line, /^risk rank n\/a: only 5 landings before [0-9a-f]{12} \(a rank needs 10\)$/);
});

test('an untyped history: the fix numbers are n/a and left out of the rank, the line says why', () => {
  const { repo, state } = world({ typed: false }), r = codeRisk({ dir: repo, state, base: 'main', head: 'big' });
  assert.deepEqual([r.numbers.fixes, r.numbers.fix_first], [null, null]);
  assert.ok(r.why.every(w => !['fixes', 'fix_first'].includes(w.key)));
  assert.match(r.line, /; fix history n\/a \(0 of \d+ commits in 365 days carry a conventional-commit type/);
});

test('norn code risk <base>..<head>: the line, the numbers, what it leaves out; --json the object; a bad range is exit 2', () => {
  const { repo, state } = world(), where = () => ({ project: null, state }), run = argv => { const o = [], e = []; const code = codeCmd(argv, { out: l => o.push(l), err: l => e.push(l), where }); return { code, o, e }; };
  const txt = run(['risk', 'main..big', '--repo', repo]);
  assert.equal(txt.code, 0, txt.e.join('\n'));
  assert.match(txt.o[0], /^riskier than \d+ % of the last 15 landings/);
  assert.equal(txt.o[1], `  1 files, 42 lines; fixes 365 d 3, top fix first ${codeRisk({ dir: repo, state, base: 'main', head: 'big' }).numbers.fix_first}, companions left out 1`);
  assert.equal(txt.o[2], '  left out: src/b.mjs (changes with src/a.mjs: 3 of 3 landings)');
  const js = run(['risk', 'main..big', '--repo', repo, '--json']);
  assert.equal(JSON.parse(js.o[0]).left_out[0].partner, 'src/b.mjs');
  assert.equal(run(['risk', 'main', '--repo', repo]).code, 2);
  assert.equal(run(['risk', 'main..nope', '--repo', repo]).code, 2);
});
