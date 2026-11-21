// TEST-GOVERNANCE S1 (DIR-23, design §3 B1): the one test-command classifier. classify(cmd) -> { kind, files, runner }: kind 'full'
// (a whole suite: ci-suite.mjs without --changed, node --test with no file or a folder / glob, pytest with no test file, npm test),
// 'test' (named test files, or a runner it cannot size: cargo, go, jest ...), 'watch' (tail -f, Get-Content -Wait, an until / while
// loop that sleeps: no bound but the run's own end) or null. The transcript fold (progress.mjs), the context split (standing.mjs),
// the run feed (dash/activity.mjs) and the scope hook's test rules (testpolicy.mjs, policy.tests) all read it: one home, no copies.

const fwd = s => String(s).replace(/\\/g, '/');
/** a command line -> segments (arrays of words) split at && || ; | & and newlines outside quotes; the quotes kept out of the words */
function segments(cmd) {
  const out = []; let seg = [], w = '', has = false, q = null;
  const word = () => { if (has) seg.push(w); w = ''; has = false; }, cut = () => { word(); if (seg.length) out.push(seg); seg = []; };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) { if (ch === q) q = null; else w += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (ch === '\n') cut(); else word(); continue; }
    if (ch === ';' || ch === '|' || (ch === '&' && !/[0-9>]$/.test(w) && cmd[i + 1] !== '>')) { cut(); if (cmd[i + 1] === ch) i++; continue; }
    w += ch; has = true;
  }
  cut();
  return out;
}
const base = w => fwd(w).split('/').pop().replace(/\.(exe|cmd)$/i, '').toLowerCase();
const WRAP = new Set(['sudo', 'command', 'nohup', 'time', 'exec', 'env', 'nice', 'call', 'start-process', 'do', 'then', 'else', '{', '(', '!']);   // + the shell words that open a loop body
const SHELLS = /^(sh|bash|zsh|dash|powershell|pwsh)$/;
// words that take the next word as their value (node / pytest flags), so the value is not read as a test path
const NODE_VAL = /^(--test-reporter|--test-reporter-destination|--test-name-pattern|--test-skip-pattern|--test-concurrency|--test-timeout|--test-shard|--import|--require|-r|--loader|--experimental-loader|--env-file|--test-coverage-include|--test-coverage-exclude)$/;
const PY_VAL = /^(-k|-m|-p|-n|-c|-o|-W|--deselect|--ignore|--ignore-glob|--rootdir|--basetemp|--junitxml|--cov|--cov-report|--tb|--log-level|--timeout|--durations|--maxfail|--confcutdir|--dist)$/;
const REDIR = /^\d*[<>]/;
/** the positional words after index i (flags, their values and redirections dropped) */
function args(ws, i, val) {
  const out = [];
  for (let k = i; k < ws.length; k++) {
    const a = ws[k];
    if (REDIR.test(a)) { if (/^\d*[<>]+&?$/.test(a)) k++; continue; }
    if (a.startsWith('-')) { if (val.test(a)) k++; continue; }
    out.push(fwd(a));
  }
  return out;
}
const TEST_FILE = /(?:^|\/)([\w.-]+\.test\.[cm]?[jt]s|test_[\w-]+\.py|[\w-]+_test\.py)(?:::.*)?$/;
const fileName = a => (a.match(TEST_FILE) || [])[1] ?? null;
// a positional a runner reads as a whole folder or many files: a glob, a folder (no extension), '.'
const wide = a => /[*?[]/.test(a) || !/\.[A-Za-z0-9]{1,6}(::.*)?$/.test(a);

/** one segment's words -> { kind, files, runner } | null */
function one(ws, depth) {
  for (let prev; prev !== ws.length;) {   // drop VAR=x, wrappers and `timeout [flags] N` in front of the command
    prev = ws.length;
    while (ws.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[0]) || WRAP.has(base(ws[0])))) ws = ws.slice(1);
    if (ws[0] && /^(uv|poetry|pipenv|hatch|pdm|rye)$/.test(base(ws[0])) && ws[1] === 'run') { let k = 2; while (k < ws.length && ws[k].startsWith('-')) k++; ws = ws.slice(k); }
    if (ws[0] && base(ws[0]) === 'timeout') { let k = 1; while (k < ws.length && ws[k].startsWith('-')) k++; if (/^\d+(\.\d+)?[smhd]?$/.test(ws[k] ?? '')) k++; ws = ws.slice(k); }
  }
  if (!ws.length) return null;
  const name = base(ws[0]);
  if (SHELLS.test(name) && depth < 4) {
    const i = ws.findIndex((x, k) => k > 0 && /^-(c|command)$/i.test(x));
    return i > 0 && ws[i + 1] !== undefined ? classify(ws.slice(i + 1).join(' '), depth + 1) : null;
  }
  // ci-suite.mjs as the script node runs (or the command itself), never as a file another command reads (`cat`, `grep x ci-suite.mjs`)
  const ci = /(^|[\\/])ci-suite\.mjs$/, script = name !== 'node' ? ws[0] : ws.some(x => x === '--check' || x === '-c') ? undefined : ws.slice(1).find(x => !x.startsWith('-'));
  if (script !== undefined && ci.test(script)) return { kind: ws.includes('--changed') ? 'test' : 'full', files: [], runner: 'ci-suite' };
  // test-diet S1: `norn tests run` is the runner of a run's node tests (testcache.mjs: the machine's result cache, policy.tests)
  const nornAt = name === 'node' && /(^|[\\/])(norn|meta)\.mjs$/.test(ws[1] ?? '') ? 2 : /^(norn|meta)$/.test(name) ? 1 : -1;
  if (nornAt > 0 && ws[nornAt] === 'tests' && ws[nornAt + 1] === 'run') { const pos = args(ws, nornAt + 2, /^--(base|project|state)$/); return { kind: 'test', files: pos.map(fileName).filter(Boolean), paths: pos.filter(fileName), runner: 'norn' }; }
  if (name === 'node' && ws.includes('--test')) {
    const pos = args(ws, 1, NODE_VAL);
    return { kind: !pos.length || pos.some(wide) ? 'full' : 'test', files: pos.map(fileName).filter(Boolean), paths: pos.filter(fileName), runner: 'node' };
  }
  const py = name === 'pytest' ? 1 : /^(python[\d.]*|py)$/.test(name) && ws[1] === '-m' && ws[2] === 'pytest' ? 3 : -1;
  if (py > 0) {
    const pos = args(ws, py, PY_VAL);
    return { kind: !pos.length || pos.some(wide) ? 'full' : 'test', files: pos.map(fileName).filter(Boolean), runner: 'pytest' };
  }
  if (/^(npm|yarn|pnpm)$/.test(name) && (ws[1] === 'test' || ws[1] === 't' || (ws[1] === 'run' && ws[2] === 'test'))) return { kind: 'full', files: [], runner: name };
  const other = name === 'npx' ? base(ws[1] ?? '') : name;
  if (/^(jest|vitest)$/.test(other) || (name === 'cargo' && /^(test|nextest)$/.test(ws[1])) || (name === 'go' && ws[1] === 'test') || name === 'ctest'
    || (name === 'dotnet' && ws[1] === 'test') || (name === 'node' && /(^|[\\/])(norn|meta)\.mjs$/.test(ws[1] ?? '') && ws[2] === 'smoke') || (/^(norn|meta)$/.test(name) && ws[1] === 'smoke'))
    return { kind: 'test', files: args(ws, 1, /^$/).map(fileName).filter(Boolean), runner: other };
  if (name === 'tail' && ws.slice(1).some(x => /^-[A-Za-z]*[fF]/.test(x) || x === '--follow' || x.startsWith('--follow='))) return { kind: 'watch', files: [], runner: 'tail' };
  if (/^(get-content|gc|cat|type)$/.test(name) && ws.some(x => /^-wait$/i.test(x))) return { kind: 'watch', files: [], runner: 'get-content' };
  return null;
}
const RANK = { full: 3, test: 2, watch: 1 };
// a poll loop: until / while ... sleep (bash) or while (...) { ... Start-Sleep } (PowerShell). A `for` loop has its own bound.
const LOOP = /(^|[\s;&|({])(until|while)\b[\s\S]*?\b(sleep|start-sleep)\b/i;

/** a shell command -> { kind: 'full' | 'test' | 'watch' | null, files: [test file names], paths: [the test files as written: node, norn tests
 *  run], runner } (the strongest segment wins) */
export function classify(cmd, depth = 0) {
  const text = String(cmd ?? '');
  let best = { kind: null, files: [], paths: [], runner: null };
  const add = r => ({ files: [...new Set([...best.files, ...r.files])], paths: [...new Set([...best.paths, ...(r.paths || [])])] });
  for (const ws of segments(text)) {
    const r = one(ws, depth);
    if (r && (RANK[r.kind] > (RANK[best.kind] ?? 0))) best = { ...r, ...add(r) };
    else if (r) Object.assign(best, add(r));
  }
  if (!best.kind && LOOP.test(text)) best = { kind: 'watch', files: [], paths: [], runner: 'loop' };
  return best;
}
/** a command that runs tests (a whole suite or named files) */
export const isTest = cmd => { const k = classify(cmd).kind; return k === 'test' || k === 'full'; };
