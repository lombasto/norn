// Shared bits of the harness adapters (HARNESS-DESIGN sec. 3): the worker prompt, the mode check, detect (exe + --version),
// the empty normalized parse and the shared headless snippet core. Node built-ins only.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolveShim } from '../paths.mjs';

// gap #3: a run ends with `norn done` (its own result: the outcome); NOTES are the worker's free-form log, never its outcome
export const DONE_LINE = 'End with `norn done` (done) or `norn done --outcome stopped --why "<why>"` or `norn done --outcome handoff --handoff-file F` (F: state, commits, the exact next step, open questions): that records your outcome; a run that does not run it ends no-result.';
export function prompt({ brief, worktree, resumes = 0, handoffFile }) {
  let p = `Read the brief ${brief} and execute it exactly. Your worktree is ${worktree}. You run headless: no one answers questions. ${DONE_LINE.replace(/`/g, '')}`;
  if (resumes > 0) p += ` AUTO-RESUME (${resumes}) after the previous agent's hand-off: ${handoffFile ? `read its hand-off ${handoffFile} first and continue from its exact next step` : 'continue the brief'}; re-check the worktree HEAD + git status before your first commit.`;
  return p;
}

export const MODES = ['write', 'read-only', 'no-tools'];
// capability flags (META-GTP-HARNESS; Gas Town internal/config/agents.go:20-110 SupportsForkSession / SupportsHooks / ResumeStyle /
// NonInteractive): fork = the CLI can fork a session (gates a seance); hooks = 'settings' (lifecycle hooks from a settings file) |
// 'none'; resume_style = 'flag' (--resume <id>) | 'subcommand' (<exe> ... resume <id>) | 'none'; noninteractive = the flag or
// subcommand that makes the CLI headless (null = the entry's own args say it). Each value is checked against the CLI's recorded
// --help (tests/fixtures/help).
export const HOOKS = ['settings', 'none'];
export const RESUME_STYLES = ['flag', 'subcommand', 'none'];
// chat (META-CONTROLLER SPEC sec. 1): how the family hosts the owner's controller chat - 'stream' (one long-lived process, stream-json
// in and out, resumed by session id) | 'turns' (one process per message, resumed) | 'cold' (a fresh run per message carrying the
// last turns) | 'none'. A family with a chat style other than none has chatCommand(o) + chatEvents(line).
export const CHATS = ['stream', 'turns', 'cold', 'none'];
export const CAP_KEYS = ['modes', 'resume', 'mcp', 'output', 'usage', 'skills', 'fork', 'hooks', 'resume_style', 'noninteractive', 'chat'];
/** o.mode, else today's o.readonly flag; refuses a mode the family lacks. */
export function modeOf(o, family, caps) {
  const m = o.mode || (o.readonly ? 'read-only' : 'write');
  if (!MODES.includes(m)) throw new Error(`unknown mode ${JSON.stringify(m)} (${MODES.join(' | ')})`);
  if (!caps.modes.includes(m)) throw new Error(`${family} has no ${m} mode (${caps.modes.join(' | ')})`);
  return m;
}

/** The first n bytes of a file as text (a log banner), or null. */
export function readHead(f, n = 8192) {
  try { const fd = fs.openSync(f, 'r'); try { const b = Buffer.alloc(n); return b.subarray(0, fs.readSync(fd, b, 0, n, 0)).toString('utf8'); } finally { fs.closeSync(fd); } } catch { return null; }
}
/** readHead on fs.promises (the feed's log banner) */
export async function readHeadA(f, n = 8192) {
  try { const fh = await fs.promises.open(f, 'r'); try { const b = Buffer.alloc(n); return b.subarray(0, (await fh.read(b, 0, n, 0)).bytesRead).toString('utf8'); } finally { await fh.close(); } } catch { return null; }
}
export const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
/** One JSON line -> its object, else null (blank, malformed, a scalar). */
export const jsonObject = line => { try { const j = JSON.parse(line); return j && typeof j === 'object' ? j : null; } catch { return null; } };
export const EMPTY = () => ({ session_id: null, model: null, is_error: null, usage: null, cost_usd: null });

/** { exe, version } | null - the version is the first line of `<exe> --version` (null when it does not answer in 15 s). */
export function detectExe(exe) {
  if (!exe) return null;
  let version = null;
  try {
    const sp = resolveShim(exe, ['--version']);
    const r = spawnSync(sp.exe, sp.args, { encoding: 'utf8', timeout: 15000, windowsHide: true, input: '' });
    version = String(r.stdout || '').split(/\r?\n/).map(l => l.trim()).find(Boolean) || null;
  } catch { /* not runnable */ }
  return { exe, version };
}

// the per-family HEADLESS snippet core: the outcome contract is the same for every harness - `norn done` writes the run's own result
// (gap #3: the only source of its outcome); its NOTES are its free-form log
// META-BETA-PREP (DIR-52): the slop sentence on its own - a pack of a project whose SloppaChoppa switch is off leaves it out (setup.mjs)
export const HEADLESS_SLOP = ' Before you end with `norn done`, run `norn slop check` in your worktree and fix every BLOCK it lists.';
// proc-hygiene (6): 84 `tail -f <log> | grep --line-buffered` watchers outlived the workers that started them (tail -f never exits)
export const HEADLESS_WATCH = 'Wait on a command\'s exit, never on `tail -f | grep`; a watcher you start must end by itself (`timeout N`, `grep -m1`). ';
export const HEADLESS_CORE = 'You run headless: nobody answers questions and your process ends with your turn. Decide under the '
  + "brief's DECISION-RULES or stop. Write your log to your NOTES file. " + HEADLESS_WATCH + DONE_LINE
  + HEADLESS_SLOP;
// META-GTP-MAIL delivery (b): the line for executors WITHOUT the mail hook (a claude run gets its mail from a PostToolUse hook)
export const HEADLESS_MAIL = ' Mail: check your mail between steps (MCP norn_mail check, else `norn mail check --run $META_RUN_ID`), act on it, and ack each one (norn_mail ack / norn mail ack MAIL-n).';

// ---------- live feed (LANE-MAP-DESIGN 2): the shared tail + the normalised event; each adapter owns its record parsing ----------
// Normalised event: { ts, kind: 'tool'|'text'|'step'|'usage'|'marker'|'error', name?, summary, ctx?, id?, done?, at } where
// `at` = the cursor ({ <file key>: byte offset }) right after the record that produced it (events of one record share it).
export const FEED_BACKLOG = 256 * 1024;   // a first open reads at most the last 256 KB of a file
export const FEED_MAX = 1024 * 1024;      // one poll reads at most 1 MB of appended bytes

/**
 * Complete lines appended to `file` since byte `offset` (null = first open: the backlog window, from a line boundary; an offset
 * past the end = the file was truncated / replaced: start over). -> Promise<{ lines [{ text, end }], offset } | null (no file)>.
 * META-DASH-ASYNC R1 (DEC-338): the stat + the read run on fs.promises - the dash feed polls this every 2 s on its event loop.
 */
export async function readLines(file, offset, { backlog = FEED_BACKLOG, max = FEED_MAX } = {}) {
  let st; try { st = await fs.promises.stat(file); } catch { return null; }
  let start = Number.isInteger(offset) && offset >= 0 && offset <= st.size ? offset : null, skip = false;
  if (start === null) { start = Math.max(0, st.size - backlog); skip = start > 0; }
  if (st.size <= start) return { lines: [], offset: start };
  const buf = Buffer.alloc(Math.min(st.size - start, max));
  const fh = await fs.promises.open(file, 'r');
  let n; try { n = (await fh.read(buf, 0, buf.length, start)).bytesRead; } finally { await fh.close(); }
  let pos = 0;
  if (skip) { const nl = buf.indexOf(10); if (nl < 0 || nl >= n) return { lines: [], offset: start }; pos = nl + 1; }
  const lines = [];
  for (let nl = buf.indexOf(10, pos); nl >= 0 && nl < n; nl = buf.indexOf(10, pos)) {
    lines.push({ text: buf.subarray(pos, nl).toString('utf8').replace(/\r$/, ''), end: start + nl + 1 }); pos = nl + 1;
  }
  // one record longer than a whole poll window: drop it (its tail then fails to parse and is skipped) rather than stall
  if (!lines.length && n === max) pos = n;
  return { lines, offset: start + pos };
}

/** Tail files [[key, path]] from cursor through parse(text, key) -> events[]; -> Promise<{ events (each with its `at`), cursor }>. */
export async function feedFiles(files, cursor, parse, env = {}) {
  const cur = { ...(cursor || {}) }, events = [];
  for (const [key, file] of files) {
    if (!file) continue;
    const r = await readLines(file, cur[key], env);
    if (!r) continue;
    for (const l of r.lines) {
      cur[key] = l.end;
      let evs = [];
      try { evs = parse(l.text, key) || []; } catch { evs = []; }   // unknown / broken records are skipped, never an error
      const at = { ...cur };
      for (const e of evs) events.push({ ts: null, ...e, at });
    }
    cur[key] = r.offset;
  }
  return { events, cursor: cur };
}

/** One line of at most n characters (the first non-empty line of s). */
export function oneLine(s, n = 160) {
  const t = String(s ?? '').split(/\r?\n/).map(x => x.trim()).find(Boolean) || '';
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
const ARG_KEYS = ['file_path', 'command', 'cmd', 'pattern', 'path', 'url', 'query', 'skill', 'description', 'prompt'];
/** A tool call's first argument as a short summary (80 chars): a known key, else the first string, else "key value". */
export function argSummary(input) {
  if (typeof input === 'string') return oneLine(input, 80);
  if (!input || typeof input !== 'object') return '';
  for (const k of ARG_KEYS) if (typeof input[k] === 'string' && input[k].trim()) return oneLine(input[k], 80);
  const e = Object.entries(input).find(([, v]) => typeof v === 'string' && v.trim()) || Object.entries(input)[0];
  return e ? oneLine(typeof e[1] === 'string' ? e[1] : `${e[0]} ${JSON.stringify(e[1])}`, 80) : '';
}

/** A plain-text log line -> a text event; blank lines -> nothing. */
export function logLine(text) {
  const t = String(text).trim();
  if (!t) return [];
  return [{ kind: 'text', summary: oneLine(t) }];
}
/** The plain-log feed (a cli executor, fake, a run without a structured transcript): the run's log, optional extra files. */
export const logFeed = (files, cursor, env) => feedFiles(files, cursor, logLine, env);

/** env.memo-cached file lookup (a hit is kept; a miss is retried after retryMs, so a directory walk never runs every poll); find may be async */
export async function located(env, key, find, retryMs = 30000) {
  const m = env?.memo, now = Date.now();
  const c = m?.get(key);
  if (c?.file) return c.file;
  if (c && now - c.miss < retryMs) return null;
  const file = await find();
  m?.set(key, file ? { file } : { miss: now });
  return file;
}
