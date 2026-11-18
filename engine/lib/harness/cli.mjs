// Harness adapter: any headless CLI, defined by DATA (project.json executors.<name> with type "cli"; META-AGNOSTIC-EXEC, DIR-66).
// The entry (spec.provider) gives exe, model, effort, turns?, brief "file" | "stdin", output "plain", common `args` with {cwd}
// {brief} {model} {effort} {turns} placeholders ("{mode}" = where the mode's args go; absent = appended), and NAMED modes
// { access: write | read-only | no-tools, args }. A run asks for a mode by name, else by access (the first mode with it).
// Output is plain text: no usage, no tool echo; the feed is the log + final text.
// exit_after_s (optional): the run goes through the EXIT WATCH (engine/bin/exit-watch.mjs) - a CLI that finished (it wrote its
// result: norn done) but stays alive with no output for that long has its process tree ended (grok RUN-1616 sat idle 51 min after DONE).
import { EMPTY, detectExe, HEADLESS_CORE, HEADLESS_MAIL, logFeed } from './common.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliMode } from '../executors.mjs';

export const WATCH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'exit-watch.mjs');

const caps = { modes: ['write', 'read-only', 'no-tools'], resume: true, mcp: 'config', output: 'final', usage: 'none', skills: 'none',
  fork: false, hooks: 'none', resume_style: 'none', noninteractive: null, chat: 'none' };   // claims nothing: an entry's caps (or its preset's) say more

/** o: { exe, worktree, brief, model, effort, provider (the cli entry), readonly | mode, turns? } */
function command(o) {
  const x = o.provider;
  if (!x || x.type !== 'cli') throw new Error(`executor ${o.executor}: no cli entry in the run spec`);
  if (o.mcp) throw new Error(`${o.executor} attaches MCP servers by config, not per run: norn harness install --family ${o.executor}`);
  let mode;
  try { mode = cliMode(x, o.mode || (o.readonly ? 'read-only' : 'write'))[1]; } catch (e) { throw new Error(`${o.executor}: ${e.message}`); }
  const turns = o.turns ?? x.turns;
  const vals = { cwd: o.worktree, brief: o.brief, model: o.model, effort: o.effort, turns: turns === undefined ? undefined : String(turns) };
  const sub = a => a.replace(/\{(cwd|brief|model|effort|turns)\}/g, (_, k) => {
    if (vals[k] === undefined || vals[k] === null) throw new Error(`${o.executor}: {${k}} has no value (set ${k} in the entry or the run)`);
    return vals[k];
  });
  const args = x.args.includes('{mode}') ? x.args.flatMap(a => (a === '{mode}' ? mode.args.map(sub) : [sub(a)])) : [...x.args.map(sub), ...mode.args.map(sub)];
  const cmd = { exe: o.exe, stdin: x.brief === 'stdin' ? o.brief : null, stdout: 'final', parse: 'none', args };
  // the exit watch needs the run's result file (the supervisor's; a probe has none) and wraps the same stdio: stdin / final / log reach the CLI unchanged
  if (x.exit_after_s !== undefined && o.result) return { ...cmd, exe: process.execPath, args: [WATCH, '--after', String(x.exit_after_s), '--result', o.result, '--', o.exe, ...args] };
  return cmd;
}

/** doctor --probe: the read-only command line, one turn */
const probe = o => command({ ...o, readonly: true, mode: undefined, turns: 1, result: undefined });   // no result file: never the exit watch

// Live feed: plain output has no tool echo and no usage, so the feed is the text of the log and the final file, one event per line.
const feed = (run, cursor, env) => logFeed([['log', run.data?.log], ['final', run.data?.final]], cursor, env);

/** `norn harness install --family <cli name>`: the entry's mcp_add template -> [exe, ...args]; null = the entry has none. */
export function mcpAddCommand(entry, { name, scope, command: cmd, args = [] }) {
  const t = entry?.mcp_add;
  if (!t) return null;
  const scopes = t.scopes || ['user'];
  const vals = { name, scope: scopes.includes(scope) ? scope : scopes[0] };
  return [entry.exe, ...t.args.flatMap(a => (a === '{command}' ? [cmd, ...args] : [a.replace(/\{(name|scope)\}/g, (_, k) => vals[k])]))];
}

// META-INSTRUCTIONS R1: the files a cli PRESET loads by itself, keyed by preset name (the cli family claims nothing of its own).
// Gemini CLI (geminicli.com/docs/cli/gemini-md): GEMINI.md from the repo root down to the working dir every session, nested ones
// below on demand, the user's ~/.gemini/GEMINI.md every session; `@file.md` lines import.
export const instructions = { 'gemini-cli': { family: 'gemini', label: 'Gemini CLI', repo: ['GEMINI.md'], user: ['${home}/.gemini/GEMINI.md'], imports: true } };

export default {
  family: 'cli', caps, instructions, command, profileArgs: () => [], profileGap: "no lean launch flags for cli presets (each CLI has its own config): a profile is ignored (today's launch)", probe, feed,
  parse: () => EMPTY(),          // plain output: no usage
  endData: () => ({}),
  detect: entry => detectExe(entry?.exe),
  headless: HEADLESS_CORE + ' Use only the tools you are given.' + HEADLESS_MAIL,
};
