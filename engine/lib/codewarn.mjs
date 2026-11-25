// RM-a-67 warn-on-edit: one short line the first time a run edits a risky file - many files import it, or it keeps getting fixes - e.g.
// "engine/x.py: 41 files import this; 6 fixes in 90 days; changes with engine/y.py (5 of 9 landings) (measured at 1a2b3c4d5e6f)".
// warnTable builds, from the stored code signals (codesignals.mjs readSignals, docs/code-signals.md), the table of ONLY the files over a
// threshold with their line ready to print, stamped with the indexed commit; writeWarnTable stores it as <state>/code/warn.json where the
// index is refreshed. norn-hook (engine/hook-rs, the PostToolUse hook every claude run has) reads that table and nothing else - no Node, no
// git - under the per-project switch policy.code.warn (off | on | ab), prints the line through the hook's additionalContext (the channel
// mail and the scope refusals reach the worker by; a harness that runs no Norn hook, e.g. codex, gets nothing) and records the run in
// <state>/code/warn/<RUN>.txt: its first line `<mode> <group>`, then one `shown <file>` per line shown. warnsOf reads that record.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './policy.mjs';

// the one place for the thresholds: a file is in the table when `dependents` or more files import it, or it had `fixes` or more fix
// landings in the signals' short window; its line is at most `tokens` (estimated as characters / chars_per_token)
export const WARN_LIMITS = Object.freeze({ dependents: 10, fixes: 3, tokens: 60, chars_per_token: 4 });
export const WARN_FILE = 'warn.json';
export const warnFile = state => path.join(state, 'code', WARN_FILE);
const markFile = (state, run) => path.join(state, 'code', 'warn', `${run}.txt`);
const tokensOf = t => Math.ceil(t.length / WARN_LIMITS.chars_per_token);
const files = n => (n === 1 ? '1 file imports this' : `${n} files import this`);

/** one file's line, or null when it is under every threshold. x: the signals' FileSignals; sig: the stored signals object */
export function warnLine(file, x, sig) {
  const dep = Number.isInteger(x.fan_in) ? x.fan_in : 0, fix = x.fixes ? x.fixes.n_90d : 0;
  if (dep < WARN_LIMITS.dependents && fix < WARN_LIMITS.fixes) return null;
  const p = x.partners[0], stamp = ` (measured at ${sig.sha})`;
  const parts = [dep ? files(dep) : null, fix ? `${fix} ${fix === 1 ? 'fix' : 'fixes'} in ${sig.limits.fix_short_days} days` : null,
    p ? `changes with ${p.file} (${p.shared} of ${x.landings} landings)` : null].filter(Boolean);
  // over the cap the partner goes first, then the path keeps its tail
  let line = `${file}: ${parts.join('; ')}${stamp}`;
  if (tokensOf(line) > WARN_LIMITS.tokens && p) line = `${file}: ${parts.slice(0, -1).join('; ')}${stamp}`;
  const over = line.length - WARN_LIMITS.tokens * WARN_LIMITS.chars_per_token;
  return over > 0 ? `...${line.slice(over + 3)}` : line;
}

/** the table of the stored signals `sig` (null: none stored -> null) -> { sha, at, basis, limits, files: { file: line } } */
export function warnTable(sig) {
  if (!sig) return null;
  const out = {};
  for (const [f, x] of Object.entries(sig.files).sort(([a], [b]) => (a < b ? -1 : 1))) { const l = warnLine(f, x, sig); if (l) out[f] = l; }
  return { sha: sig.sha, at: sig.at, basis: 'measured', limits: WARN_LIMITS, files: out };
}
/** store the table of `sig` beside the index (no signals: the old table goes, so no line describes a commit no index holds) */
export function writeWarnTable(state, sig) {
  const t = warnTable(sig);
  if (!t) { fs.rmSync(warnFile(state), { force: true }); return null; }
  fs.mkdirSync(path.dirname(warnFile(state)), { recursive: true });
  atomicWrite(warnFile(state), JSON.stringify(t));
  return t;
}

/** the run's record of lines shown -> { mode, group, shown, files } (group 'warn' or 'control'), or null when the hook never marked it */
export function warnsOf(state, run) {
  let t;
  try { t = fs.readFileSync(markFile(state, run), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const [head, ...rows] = t.split('\n').filter(Boolean), [mode, group] = head.split(' '), shown = rows.filter(r => r.startsWith('shown ')).map(r => r.slice(6));
  return { mode, group, shown: shown.length, files: shown };
}
