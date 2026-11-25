// output-trim S1 (RM-a-56): `norn tests output-replay` - what trimming command logs WOULD have saved on a project's recorded runs, and
// whether that crosses the gate that releases building the trim (S2-S5). Measurement only: read-only on the transcripts, no hook, no
// model call. Sources: a Claude run's final JSON in <state>/logs/<lane>-<YYYYMMDD>-<HHMMSS>-<id>.json names its session_id -> the
// transcript <claude projects>/<slug>/<sid>.jsonl holds every Bash / PowerShell result; a Codex run's `codex exec` log in the same
// folder holds its commands and outputs (no per-call token use, no cost: counted in the family table, never in the saving).
// Check-in runs (checkin-*) are not worker runs and are left out. Tokens are characters / 4 (an estimate, labelled so). A cut token
// saves one 1 h cache write when it enters and one cache read per later API call of its session; dollars are that weighted share of
// the run's recorded total_cost_usd (cost.mjs WEIGHTS). Upper bound: no compaction assumed. The filters here are the SPEC section 2
// filters as a measuring stick only; the shipped ones (S2) live in norn-hook. Doc: docs/TESTING.md, "Output replay".
import fs from 'node:fs';
import path from 'node:path';
import { WEIGHTS, fromUsage } from './cost.mjs';

// every threshold of the replay, in one place (listed in docs/TESTING.md, "Output replay")
export const REPLAY = {
  chars_per_token: 4,                  // estimate, no tokenizer (the theme bans model calls)
  gate_share: 0.01,                    // gate: the test/build/install ceiling on wrap-eligible calls >= 1 % of the runs' cache reads
  rerun_window: 3,                     // reported, not gated (DEC-a-582: the wrap skips cut calls): a re-run = the same command (before its first pipe) within the next 3 shell calls
  ceiling_extra: 400,                  // the ceiling filter keeps the KEEP lines + this many characters
  since_days: 31,                      // the default window
  w_write: WEIGHTS.cache_create_1h, w_read: WEIGHTS.cache_read,
};
// strict / collapse / crlf_all / ceiling / ceiling_git: wrap-eligible calls only; excluded_*: the same cuts on the calls the wrap skips
const SAVINGS = ['strict', 'collapse', 'crlf_all', 'ceiling', 'ceiling_git', 'excluded_strict', 'excluded_ceiling', 'all_shell'];
export const FAMILIES = ['pytest', 'cargo', 'maturin', 'install', 'git', 'other'];
const TEST_BUILD = new Set(['pytest', 'cargo', 'maturin', 'install']), RERUN_FAMS = new Set(['pytest', 'cargo', 'maturin']);

/** the command family of a shell command (SPEC section 2) */
export const fam = c => { c = String(c || '');
  if (/\bpytest\b/.test(c)) return 'pytest';
  if (/\bmaturin\b/.test(c)) return 'maturin';
  if (/\bcargo\s+(\+\S+\s+)?(build|test|clippy|check|nextest|run|bench|doc)\b/.test(c)) return 'cargo';
  if (/\b(uv\s+(pip|sync|add|lock|venv)|pip3?\s+install|npm\s+(install|ci|i)\b|pnpm\s+(install|i)\b)/.test(c)) return 'install';
  if (/^\s*(cd [^;&]+(&&|;)\s*)?git\b/.test(c)) return 'git';
  return 'other'; };
/** the agent cut its own output: piped to tail / grep / ..., run quiet, or sent to a log file */
export const piped = c => /\|\s*(tail|head|grep|rg|Select-Object|Select-String|findstr|wc|sed|awk|cut)\b|\s-q\b|--quiet|-qq|> ?\S+\.(log|txt)/.test(String(c || ''));
// a line that names a failure, error or warning: never dropped (the property's line set)
export const KEEP = /\b(error|errors|failed|failure|failures|fail|panic|panicked|traceback|exception|warning|warn|fatal|abort|denied|conflict|rejected|xfail|xpass)\b|^E\s|^\s*-->|^\s*\|\s|^\s*=\s(note|help)|^FAILED|^ERROR|assert/i;
const NOISE = {
  pytest: [/^\S+\.py\s+[.sxXEF]+\s*(\[\s*\d+%\])?$/, /^\S+::\S+\s+PASSED/, /^(platform|cachedir|rootdir|configfile|plugins|testpaths|collecting|collected)\b/, /^\[gw\d+\]\s.*PASSED/, /^[.sx]+\s*(\[\s*\d+%\])?$/, /^created: \d+\/\d+ workers/, /^\d+ workers \[\d+ items\]/, /^bringing up nodes/],
  cargo: [/^\s*(Compiling|Checking|Fresh|Downloaded|Downloading|Updating|Locking|Adding|Blocking|Documenting|Packaging|Verifying|Archiving|Unpacking)\s/, /^\s*Running\s+(unittests|tests|benches|`)/, /^test \S+ \.\.\. ok$/, /^\s*Doc-tests\s/, /^running \d+ tests?$/, /^\s*Finished\s/],
  maturin: [/^\s*(Compiling|Checking|Fresh|Downloaded|Downloading|Updating|Locking)\s/, /^\s*(📦|🔗|🐍|🍹|💻|🛠|⚠️  Warning: CPython|📡|✏️|🎁|👀)/u, /^\s*Finished\s/],
  install: [/^Requirement already satisfied/, /^\s*(Collecting|Downloading|Using cached|Obtaining|Preparing metadata|Building wheel|Created wheel|Stored in directory)\b/, /^\s*[+~-] \S+==\S+$/, /^(Resolved|Prepared|Uninstalled|Audited|Built|Installed) \d+ packages? in/, /^\s*━|^\s*\|?[#█▌ ]+\|?\s+\d+(\.\d+)?\s?[kM]?B/, /^(added|removed|changed) \d+ packages?/, /^up to date, audited/, /^\d+ packages are looking for funding/, /^\s+run `npm fund`/],
  git: [/^(remote: )?(Enumerating|Counting|Compressing|Writing|Receiving|Resolving|Total|Delta compression|Unpacking) /, /^From \S+$/, /^\s+[0-9a-f]{7,}\.\.[0-9a-f]{7,}\s+\S+\s+->\s/, /^ \* \[new (branch|tag)\]/],
};
const CRLF = /^warning: in the working copy of '[^']*', (LF will be replaced by CRLF|CRLF will be replaced by LF) the next time Git touches it$/;
const TRAILER = 'x'.repeat(70);   // the trailer line a trimmed log ends with ("[norn trim T-<n>: <k> lines cut ...]"), sized not printed

/** the wrap (SPEC section 1, DIR-a-82) would take this call: a filter matches it (git: fetch / pull / push / clone only) and the agent
 *  left its output whole (no pipe, file, -q, heredoc or background run) -> null, else the reason it is passed untouched */
export const skipReason = (c, { background = false } = {}) => { const f = fam(c);
  if (f === 'other' || (f === 'git' && !/\bgit\s+(fetch|pull|push|clone)\b/.test(c))) return 'no filter matches';
  if (background) return 'background';
  if (/<<-?\s*['"]?\w/.test(c)) return 'heredoc';
  if (piped(c) || /(?:^|[\s;])(?:1|\*|&)?>>?\s*(?!&)[^\s&|]|\|\s*(Out-File|Set-Content|Add-Content|Tee-Object|tee)\b/i.test(c)) return 'cut by the agent';
  return null; };

/** the strict filter of family f; collapse: repeated CRLF warnings kept once */
export function trimText(f, text, { collapse = false } = {}) {
  const N = NOISE[f]; if (!N) return text;
  const out = []; let dropped = 0, crlf = 0;
  for (const l of text.split('\n')) {
    if (KEEP.test(l)) { if (collapse && CRLF.test(l) && crlf++) { dropped++; continue; } out.push(l); continue; }
    if (N.some(r => r.test(l))) { dropped++; continue; }
    out.push(l);
  }
  return dropped ? [...out, TRAILER].join('\n') : text;
}

/** one Claude transcript -> { rounds, calls: [{ cmd, out, round }] } (rounds = distinct assistant API messages) */
export function claudeCalls(text) {
  const uses = new Map(), calls = [], ids = new Set(); let rounds = 0;
  for (const l of text.split('\n')) { if (!l) continue; let e; try { e = JSON.parse(l); } catch { continue; }
    const c = e.message?.content; if (!Array.isArray(c)) continue;
    if (e.type === 'assistant' && e.message?.id && !ids.has(e.message.id)) { ids.add(e.message.id); rounds++; }
    for (const b of c) {
      if (b.type === 'tool_use' && (b.name === 'Bash' || b.name === 'PowerShell')) uses.set(b.id, { cmd: String(b.input?.command ?? ''), round: rounds, background: !!b.input?.run_in_background });
      if (b.type === 'tool_result' && uses.has(b.tool_use_id)) calls.push({ ...uses.get(b.tool_use_id), out: typeof b.content === 'string' ? b.content : (b.content || []).map(x => x.text || '').join('\n') });
    } }
  return { rounds, calls };
}

// a `codex exec` log: "exec" + the command line(s) ending " in <cwd>", later " succeeded in Nms:" / " exited N in Nms:" + its output;
// parallel calls print their exec blocks first and their results after, in the same order
const CODEX_MARK = /^(exec|codex|thinking|user|tokens used|hook: .*|\d{4}-\d\d-\d\dT\S+Z .*)$/, CODEX_RES = /^ (succeeded|exited -?\d+|failed) in \d+m?s:$/;
export const isCodexLog = text => /^OpenAI Codex v/m.test(text.slice(0, 2000));
// Codex logs the shell it starts: `"...powershell.exe" -Command '<script>'` / `"bash" -lc '<script>'` -> the script (families match on it)
const SHELL_WRAP = /^"?[^"\s]*?(?:powershell|pwsh|bash|zsh|sh)(?:\.exe)?"?\s+(?:-NoProfile\s+)?(?:-Command|-lc|-c)\s+(['"])([\s\S]*)\1$/i;
const unwrap = c => (c.match(SHELL_WRAP)?.[2] ?? c);
/** a Codex exec log -> [{ cmd, out }] */
export function codexCalls(text) {
  const L = text.split(/\r?\n/), pending = [], calls = [];
  for (let i = 0; i < L.length; i++) {
    if (L[i] === 'exec') { const c = []; while (i + 1 < L.length && !CODEX_MARK.test(L[i + 1]) && !CODEX_RES.test(L[i + 1])) c.push(L[++i]); const s = c.join('\n'), at = s.lastIndexOf(' in '); pending.push(unwrap(at < 0 ? s : s.slice(0, at))); continue; }
    if (CODEX_RES.test(L[i])) { const o = []; while (i + 1 < L.length && !CODEX_MARK.test(L[i + 1]) && !CODEX_RES.test(L[i + 1])) o.push(L[++i]); calls.push({ cmd: pending.shift() ?? '', out: o.join('\n') }); }
  }
  return calls;
}

const RUN_NAME = /^(.+)-(\d{8})-\d{6}-[0-9a-f]+\.(json|log)$/;
const transcriptIndex = dir => { const m = new Map(); let ds = []; try { ds = fs.readdirSync(dir); } catch { return m; }
  for (const d of ds) { let fs2 = []; try { fs2 = fs.readdirSync(path.join(dir, d)); } catch { continue; } for (const f of fs2) if (f.endsWith('.jsonl')) m.set(f.slice(0, -6), path.join(dir, d, f)); }
  return m; };
const median = (s, p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null);

/** the replay over <state>/logs since day `since` (YYYY-MM-DD) -> the replay.json object */
export function outputReplay({ state, projectsDir, since, now = Date.now() }) {
  since = since || new Date(now - REPLAY.since_days * 864e5).toISOString().slice(0, 10);
  const logs = path.join(state, 'logs'), day = since.replace(/-/g, ''), idx = transcriptIndex(projectsDir), names = (() => { try { return fs.readdirSync(logs); } catch { return []; } })();
  const fresh = () => Object.fromEntries(FAMILIES.map(f => [f, { results: 0, cut: 0, chars: 0, sizes: [] }])), F = fresh(), C = fresh();   // Claude / Codex
  const S = Object.fromEntries(SAVINGS.map(k => [k, { tokens: 0, usd: 0 }]));
  const runs = { claude: 0, codex: 0, na: [] }, tot = { cache_read: 0, usd: 0 }, rr = { cut: 0, rerun: 0 }, ex = {}, T = REPLAY.chars_per_token;
  const count = (calls, A) => { const prev = [];   // the family table per harness; re-runs on Claude runs (as the saving)
    for (const c of calls) { const f = fam(c.cmd), a = A[f], cut = piped(c.cmd); a.results++; a.cut += cut; a.chars += c.out.length; a.sizes.push(c.out.length);
      if (A === F && RERUN_FAMS.has(f)) { const base = x => x.split('|')[0].replace(/\s+2>&1\s*$/, '').trim(); rr.cut += cut;
        if (prev.some(p => p.f === f && p.cut && p.cmd !== c.cmd && base(p.cmd) === base(c.cmd))) rr.rerun++; }
      prev.unshift({ f, cut, cmd: c.cmd }); prev.length = Math.min(prev.length, REPLAY.rerun_window); } };
  const ok = new Set(names.filter(n => n.endsWith('.json')).map(n => n.slice(0, -5)));
  for (const n of names) {
    const m = n.match(RUN_NAME); if (!m || m[1] === 'checkin' || m[2] < day) continue;
    const run = n.slice(0, -m[3].length - 1), file = path.join(logs, n);
    if (m[3] === 'log') {   // a Codex run: its exec log (a Claude run's .log is the launcher log, read through its .json)
      if (ok.has(run)) continue; const text = fs.readFileSync(file, 'utf8'); if (!isCodexLog(text)) continue;
      runs.codex++; count(codexCalls(text), C); continue; }
    let j; try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { runs.na.push({ run, reason: `final JSON unreadable (${e.message})` }); continue; }
    if (!j.session_id) { runs.na.push({ run, reason: 'the final JSON names no session_id' }); continue; }
    const t = idx.get(j.session_id); if (!t) { runs.na.push({ run, reason: `no transcript for session ${j.session_id} under ${projectsDir}` }); continue; }
    const { rounds, calls } = claudeCalls(fs.readFileSync(t, 'utf8')), u = fromUsage(j.usage || {}), cost = Number(j.total_cost_usd) || 0;
    runs.claude++; tot.cache_read += u.cache_read; tot.usd += cost; count(calls, F);
    const add = (k, chars, rem) => { if (chars <= 0) return; const tok = chars / T; S[k].tokens += tok * rem; if (u.weighted > 0) S[k].usd += tok * (REPLAY.w_write + rem * REPLAY.w_read) / u.weighted * cost; };
    for (const c of calls) { const f = fam(c.cmd), rem = Math.max(0, rounds - c.round), lines = c.out.split('\n'), cr = lines.filter(x => CRLF.test(x)), why = skipReason(c.cmd, c);
      add('all_shell', c.out.length, rem); if (cr.length > 1 && (!why || why === 'no filter matches')) add('crlf_all', cr.slice(1).join('\n').length, rem);
      if (f === 'other') continue;
      if (why) ex[why] = (ex[why] || 0) + 1;
      const strict = c.out.length - trimText(f, c.out).length, cut = c.out.length - lines.filter(x => KEEP.test(x)).join('\n').length - REPLAY.ceiling_extra;
      if (why === 'no filter matches') { add('ceiling_git', cut, rem); continue; }   // git diff / show / log / status: content, the ceiling row only
      if (why) { add('excluded_strict', strict, rem); if (TEST_BUILD.has(f)) add('excluded_ceiling', cut, rem); continue; }
      add('strict', strict, rem); add('collapse', c.out.length - trimText(f, c.out, { collapse: true }).length, rem);
      add('ceiling_git', cut, rem); if (TEST_BUILD.has(f)) add('ceiling', cut, rem); }
  }
  const table = A => Object.fromEntries(FAMILIES.map(f => { const { sizes, ...a } = A[f]; sizes.sort((x, y) => x - y); return [f, { ...a, p50: median(sizes, 0.5), p90: median(sizes, 0.9), max: sizes.at(-1) ?? null }]; }));
  const families = { claude: table(F), codex: table(C) };
  for (const v of Object.values(S)) { v.share_cache_read = tot.cache_read ? v.tokens / tot.cache_read : null; v.share_spend = tot.usd ? v.usd / tot.usd : null; }
  const share = S.ceiling.share_cache_read, rshare = rr.cut ? rr.rerun / rr.cut : null;
  const gate = share === null ? { met: null, why: 'no Claude run with recorded cache reads in the window' }
    : { met: share >= REPLAY.gate_share, ceiling_share: share };
  return { at: new Date(now).toISOString(), since, estimate: `tokens = characters / ${T}`, measured: 'replayed on the recorded transcripts and Codex logs', thresholds: REPLAY,
    runs, totals: tot, families, savings: S, skipped: ex, rerun: { ...rr, share: rshare }, gate };
}

const pct = v => (v === null || v === undefined ? 'n/a' : `${(100 * v).toFixed(v < 0.001 ? 3 : 2)} %`), M = v => (v / 1e6).toFixed(v < 1e5 ? 4 : 2);
const LABEL = { strict: 'strict filters (SPEC s.2)', collapse: '+ CRLF warning collapse', crlf_all: 'CRLF collapse on every shell result', ceiling: 'ceiling: test/build/install to error lines', ceiling_git: 'ceiling incl. git diff/show/log', excluded_strict: 'not reachable: strict, calls the wrap skips', excluded_ceiling: 'not reachable: ceiling, calls the wrap skips', all_shell: 'for scale: all shell output' };
/** the printed report */
export function replayLines(r) {
  const rows = h => FAMILIES.map(f => { const a = r.families[h][f]; return `  ${h.padEnd(7)} ${f.padEnd(8)} ${String(a.results).padStart(7)} ${`${a.cut} (${a.results ? Math.round(100 * a.cut / a.results) : 0} %)`.padStart(14)} ${M(a.chars).padStart(9)} M  ${[a.p50, a.p90, a.max].map(x => x ?? '-').join(' / ')}`; });
  const S = r.savings, g = r.gate;
  return [`output replay since ${r.since}: ${r.runs.claude} Claude run(s), ${r.runs.codex} Codex log(s), ${r.runs.na.length} n/a; ${M(r.totals.cache_read)} M cache reads, $${r.totals.usd.toFixed(2)} spend (${r.estimate}, an estimate)`,
    '  harness family   results  cut by agent     chars     p50 / p90 / max chars', ...rows('claude'), ...(r.runs.codex ? rows('codex') : []),
    '  saving (Claude runs, wrap-eligible calls; Codex logs carry no per-call tokens or cost): cache-read tokens saved / share of cache reads / dollars / share of spend',
    `  calls of a filtered family the wrap skips: ${Object.entries(r.skipped).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}`,
    ...Object.entries(S).map(([k, v]) => `  ${LABEL[k].padEnd(44)} ${M(v.tokens).padStart(9)} M  ${pct(v.share_cache_read).padStart(8)}  $${v.usd.toFixed(2).padStart(8)}  ${pct(v.share_spend)}`),
    `  saving range: ${M(S.strict.tokens)} M tokens / $${S.strict.usd.toFixed(2)} (strict) to ${M(S.ceiling.tokens)} M tokens / $${S.ceiling.usd.toFixed(2)} (ceiling)`,
    `  re-runs: ${r.rerun.rerun} of ${r.rerun.cut} cut test/build calls (${pct(r.rerun.share)}) run again with another cut within ${REPLAY.rerun_window} calls (reported only: the wrap skips cut calls)`,
    g.met === null ? `gate: n/a - ${g.why}` : `gate: ${g.met ? 'MET - build past S1' : 'NOT MET - S2-S5 stay parked'} (ceiling ${pct(g.ceiling_share)} of cache reads vs ${pct(REPLAY.gate_share)})`,
    ...r.runs.na.map(x => `  ${x.run}: n/a - ${x.reason}`)];
}
