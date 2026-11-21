// The agent CLI sessions on this computer (UI redesign 2026-11-20, header item 1): every Claude Code and Codex CLI process on the
// machine, split into Norn's own (a run's executor or supervisor, a Talk session the dashboard started - the process or one of its
// ancestors is a pid Norn knows) and the others (a terminal, an IDE, the desktop app). Pure: the process list (strays.mjs listProcs)
// and Norn's pids go in, the counts come out; the dash server samples it in the background, never inside a request.
const CLAUDE_EXE = /^claude(\.exe)?$/i, CODEX_EXE = /^codex(\.exe)?$/i;
// the desktop app is an Electron "Claude.exe" too (its helpers carry --type=): an app, not a CLI session; the sessions it starts are
const APP = /AnthropicClaude|Claude\.app|--type=/i;
const NODE_CLI = { claude: /[\\/]@anthropic-ai[\\/]claude-code[\\/]/i, codex: /[\\/]@openai[\\/]codex[\\/]/i };
/** which agent CLI a process row is: 'claude' | 'codex' | null. p: { name, cmd } */
export function agentOf(p) {
  const name = String(p.name ?? ''), cmd = String(p.cmd ?? '');
  if (CLAUDE_EXE.test(name) && !APP.test(cmd)) return 'claude';
  if (CODEX_EXE.test(name)) return 'codex';
  if (/^node(\.exe)?$/i.test(name)) return NODE_CLI.claude.test(cmd) ? 'claude' : NODE_CLI.codex.test(cmd) ? 'codex' : null;
  return null;
}
/**
 * procs: [{ pid, ppid, name, cmd }]; norn: the pids Norn started (live runs' executor + supervisor pids, this dashboard's pid) ->
 * { claude: { norn, other }, codex: { norn, other } }. One session = one process tree: a CLI process under another of the same kind
 * (the npm wrapper's node under its shim, codex's native binary under its node launcher) is not counted again.
 */
export function agentSessions(procs, { norn = new Set() } = {}) {
  const byPid = new Map(procs.map(p => [p.pid, p])), out = { claude: { norn: 0, other: 0 }, codex: { norn: 0, other: 0 } };
  const up = function* (p) { for (let x = byPid.get(p.ppid), n = 0; x && n < 64 && x.pid !== p.pid; x = byPid.get(x.ppid), n++) { yield x; if (x.ppid === x.pid) break; } };
  for (const p of procs) {
    const k = agentOf(p); if (!k) continue;
    const anc = [...up(p)];
    if (anc.some(x => agentOf(x) === k)) continue;
    out[k][norn.has(p.pid) || anc.some(x => norn.has(x.pid)) ? 'norn' : 'other']++;
  }
  return out;
}
