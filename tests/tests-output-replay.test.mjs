// `norn tests output-replay` (output-trim S1): a synthetic project with planted Claude transcripts (one result per family, one piped,
// one plain file read), a Codex exec log and a run whose transcript is gone -> the family table, the saving range and the gate.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanTmp, mkTmp } from './helpers/tmp.mjs';
import { testsCmd } from '../engine/lib/testscli.mjs';
import { REPLAY, fam, trimText } from '../engine/lib/outreplay.mjs';

after(cleanTmp);
const PYTEST = ['platform linux -- Python 3.12.0, pytest-8.0.0', 'rootdir: /w', 'collected 40 items', '', ...Array.from({ length: 30 }, (_, i) => `tests/test_m${i}.py ....  [ ${i * 3}%]`),
  'E   assert 1 == 2', 'FAILED tests/test_m3.py::test_x - assert 1 == 2', '1 failed, 39 passed in 2.00s'].join('\n');
const CARGO = [...Array.from({ length: 40 }, (_, i) => `   Compiling crate${i} v0.1.${i}`), 'warning: unused variable: `x`', '  --> src/lib.rs:3:9', '   Finished `dev` profile in 9.0s'].join('\n');
const MATURIN = ['📦 Including license file', ...Array.from({ length: 10 }, (_, i) => `   Compiling dep${i} v1.0.0`), '🐍 Found CPython 3.12', '   Finished `release` profile in 30s'].join('\n');
const INSTALL = [...Array.from({ length: 20 }, (_, i) => `Requirement already satisfied: pkg${i} in /venv/lib`), 'ERROR: pip resolver conflict'].join('\n');
const CRLF = i => `warning: in the working copy of 'src/f${i}.rs', LF will be replaced by CRLF the next time Git touches it`;
const GIT = ['remote: Enumerating objects: 9, done.', 'remote: Counting objects: 100% (9/9), done.', 'From https://example.invalid/repo', ...Array.from({ length: 8 }, (_, i) => CRLF(i))].join('\n');
const PIPED = '3 passed in 0.10s', CAT = 'line one\nline two';
const CALLS = [['uv run pytest -x', PYTEST], ['cargo build --release', CARGO], ['maturin develop', MATURIN], ['pip install -r req.txt', INSTALL],
  ['git fetch origin', GIT], ['cargo test 2>&1 | tail -n 50', CARGO], ['uv run pytest -q | tail -3', PIPED], ['cat notes.txt', CAT], ['uv run pytest -q | tail -5', PIPED]];

/** a Claude transcript: one assistant round per call (tool_use) + its result, then `extra` rounds with no tool */
function transcript(calls, extra = 4) {
  const L = []; let n = 0;
  for (const [cmd, out] of calls) { n++; L.push({ type: 'assistant', message: { id: `m${n}`, content: [{ type: 'tool_use', id: `t${n}`, name: n % 2 ? 'Bash' : 'PowerShell', input: { command: cmd } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: [{ type: 'text', text: out }] }] } }); }
  for (let i = 0; i < extra; i++) L.push({ type: 'assistant', message: { id: `x${i}`, content: [{ type: 'text', text: 'ok' }] } });
  return L.map(x => JSON.stringify(x)).join('\n') + '\n';
}
const CODEX = ['2026-11-20T10:00:00.000Z start RUN-9 executor=codex model=m', 'OpenAI Codex v0.1.0', '--------', 'session id: s-codex', '--------', 'user', 'do it', 'codex', 'I will run the tests.',
  'exec', `"bash" -lc 'cargo test' in /w`, ' exited 101 in 900ms:', '   Compiling a v0.1.0', 'test t1 ... ok', 'error: test failed', 'exec', `"C:/Windows/powershell.exe" -Command 'git log -1' in C:/w`, ' succeeded in 3ms:', 'hello',
  'codex', 'Done.', 'tokens used', '1,234', '2026-11-20T10:05:00.000Z exit=0'].join('\n');

function project() {
  const state = mkTmp('outreplay-'), cfg = path.join(path.dirname(state), 'claude'), logs = path.join(state, 'logs'), tdir = path.join(cfg, 'projects', 'C--w');
  fs.mkdirSync(logs, { recursive: true }); fs.mkdirSync(tdir, { recursive: true });
  const run = (name, sid, usage, cost) => fs.writeFileSync(path.join(logs, name + '.json'), JSON.stringify({ session_id: sid, usage, total_cost_usd: cost }));
  run('lane-a-20261120-101010-aaaaaa', 'sid-a', { cache_read_input_tokens: 20000, cache_creation_input_tokens: 5000, input_tokens: 100, output_tokens: 1000 }, 2);
  fs.writeFileSync(path.join(tdir, 'sid-a.jsonl'), transcript(CALLS));
  run('lane-b-20261121-101010-bbbbbb', 'sid-gone', { cache_read_input_tokens: 1000 }, 1);   // its transcript was never planted
  run('checkin-20261121-111111-cccccc', 'sid-a', { cache_read_input_tokens: 1 }, 1);         // a check-in: not a worker run
  run('lane-old-20261001-101010-dddddd', 'sid-a', { cache_read_input_tokens: 1 }, 1);       // before --since
  fs.writeFileSync(path.join(logs, 'lane-c-20261120-090000-eeeeee.log'), CODEX);
  return { state, env: { CLAUDE_CONFIG_DIR: cfg } };
}
const cmd = (p, args) => { const out = [], err = []; const code = testsCmd(['output-replay', ...args], { out: l => out.push(l), err: l => err.push(l), env: p.env, where: () => ({ state: p.state, project: null }) }); return { code, out: out.join('\n'), err: err.join('\n') }; };

test('output-replay: per-family counts, characters, agent-cut share, saving range, gate verdict; replay.json written', () => {
  const p = project(), r = cmd(p, ['--since', '2026-11-01']);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(fs.readFileSync(path.join(p.state, 'trim', 'replay.json'), 'utf8'));
  assert.deepEqual([j.runs.claude, j.runs.codex, j.runs.na.length], [1, 1, 1]);
  assert.match(j.runs.na[0].reason, /no transcript/); assert.equal(j.runs.na[0].run, 'lane-b-20261121-101010-bbbbbb');
  const F = j.families.claude, X = j.families.codex;
  assert.deepEqual([F.pytest.results, F.pytest.cut, F.cargo.results, F.cargo.cut, F.maturin.results, F.install.results, F.git.results, F.other.results], [3, 2, 2, 1, 1, 1, 1, 1]);
  assert.equal(F.pytest.chars, PYTEST.length + 2 * PIPED.length); assert.equal(F.other.chars, CAT.length); assert.equal(F.cargo.chars, 2 * CARGO.length);
  assert.deepEqual([X.cargo.results, X.git.results, X.other.results, X.pytest.results, X.git.chars], [1, 1, 0, 0, 'hello'.length]);   // shell wrappers unwrapped
  assert.equal(X.cargo.chars, ['   Compiling a v0.1.0', 'test t1 ... ok', 'error: test failed'].join('\n').length);
  const S = j.savings;
  for (const k of ['strict', 'collapse', 'crlf_all', 'ceiling', 'ceiling_git', 'excluded_strict', 'excluded_ceiling', 'all_shell']) assert.ok(S[k].tokens > 0 && S[k].usd > 0, k);
  assert.ok(S.strict.tokens <= S.collapse.tokens && S.ceiling.tokens <= S.ceiling_git.tokens && S.ceiling_git.tokens <= S.all_shell.tokens);
  // the wrap skips the 3 piped calls: their cuts are their own rows; 1 of them was run again with another cut within 3 calls (reported, not gated)
  assert.deepEqual(j.skipped, { 'cut by the agent': 3 });
  assert.deepEqual([j.rerun.cut, j.rerun.rerun], [3, 1]);
  assert.equal(j.gate.met, j.savings.ceiling.share_cache_read >= REPLAY.gate_share); assert.equal(j.gate.met, true); assert.equal(j.estimate, `tokens = characters / ${REPLAY.chars_per_token}`);
  for (const s of [/pytest\s+3\s+2 \(67 %\)/, /saving range/, /\$/, /gate: MET/, /lane-b-20261121-101010-bbbbbb: n\/a - no transcript/]) assert.match(r.out, s);
});

test('output-replay: no run in the window reads the gate as n/a with the reason', () => {
  const p = project(), r = cmd(p, ['--since', '2026-12-01']);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /gate: n\/a - no Claude run with recorded cache reads/);
});

test('the strict filters drop only listed noise: every KEEP line survives; the collapse keeps the first CRLF warning', () => {
  assert.deepEqual([fam('uv run pytest -x'), fam('cargo +nightly clippy'), fam('cd w && git push'), fam('npm ci'), fam('sed -n 1,9p x')], ['pytest', 'cargo', 'git', 'install', 'other']);
  const t = trimText('pytest', PYTEST); assert.match(t, /E {3}assert 1 == 2\nFAILED/); assert.doesNotMatch(t, /test_m5\.py/);
  assert.equal(trimText('git', GIT).split('\n').filter(l => l.startsWith('warning: in the working copy')).length, 8);
  assert.equal(trimText('git', GIT, { collapse: true }).split('\n').filter(l => l.startsWith('warning: in the working copy')).length, 1);
});
