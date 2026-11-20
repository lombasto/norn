// Harness adapter: Claude Code CLI (`claude -p`), also the path of every claude-compatible provider (GLM, Kimi, ...).
// Command lines are byte-same with the pre-H2 runs.mjs switch (tests/golden/commands/matrix.json).
import fs from 'node:fs';
import path from 'node:path';
import { readdirS, readdirA, existsS, existsA } from '../fsnap.mjs';
import { prompt, modeOf, readText, EMPTY, jsonObject, detectExe, HEADLESS_CORE, feedFiles, logLine, oneLine, argSummary, located, slimInput, clip, cut } from './common.mjs';
// a read-only helper (norn delegate, design sec. 3): no project agent file, no shell / edit / subagent tools, no MCP servers
export const CLAUDE_RO_NOPE = ['Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit', 'Agent'];
const caps = { modes: ['write', 'read-only', 'no-tools'], resume: true, mcp: 'flag', output: 'final', usage: 'tokens+cost', skills: 'claude',
  fork: true, hooks: 'settings', resume_style: 'flag', noninteractive: '-p', chat: 'stream' };   // --fork-session, --settings, -r/--resume, -p/--print

/**
 * o: today's run spec ({ exe, promptText | brief/worktree/notes/resumes, agent, model, effort, session_id, project, lane, headless,
 * worktree, addDirs, readonly }) plus mode, mcp { name, command, args } and remote (bind to the owner's claude.ai: the
 * built-in claude executor only - a provider never). fork_of (norn ask): answer from a FORK of that session (--resume <sid> --fork-session).
 */
function command(o) {
  const mode = modeOf(o, 'claude', caps), ro = mode !== 'write', remote = !!o.remote;
  // proc-hygiene (4): the servers the project / lane names (profile.mcp_servers, launchpolicy.mcpServersOf) join Norn's own in one config
  const servers = { ...(o.profile?.mcp_servers || {}), ...(o.mcp ? { [o.mcp.name]: { command: o.mcp.command, args: o.mcp.args } } : {}) };
  const mcp = Object.keys(servers).length ? ['--mcp-config', JSON.stringify({ mcpServers: servers })] : [];
  const tools = mode === 'read-only' ? ['--disallowedTools', CLAUDE_RO_NOPE.join(','), ...mcp, '--strict-mcp-config']
    : mode === 'no-tools' ? ['--tools', '', ...mcp, '--strict-mcp-config'] : mcp.length ? [...mcp, '--strict-mcp-config'] : [];
  const extra = mergeArgs(tools, profileArgs(o.profile));   // META-STANDING-CONTEXT R1: before `tools` is spread (it may merge into it)
  return { exe: o.exe, stdin: null, stdout: 'final', parse: 'claude', args: [
    '-p', o.promptText || prompt(o), ...(o.agent && !ro ? ['--agent', o.agent] : []),
    ...tools, '--model', o.model, '--effort', o.effort, ...(o.resumeSid && !o.fork_of ? ['--resume', o.resumeSid] : ['--session-id', o.session_id]), ...(o.fork_of ? ['--resume', o.fork_of, '--fork-session'] : []),
    '--permission-mode', 'bypassPermissions', ...(remote ? ['--remote-control', `${o.project || 'norn'}-${o.lane}`] : []), '--output-format', 'json',
    ...(o.headless ? ['--append-system-prompt', o.headless] : []), ...[o.worktree, ...(o.addDirs || []), ...(o.scope && o.notes ? [path.dirname(path.resolve(o.notes))] : []), ...(o.scope && o.resultDir ? [o.resultDir] : [])].flatMap(d => ['--add-dir', d]),
    ...(o.mail_hook || o.scope ? ['--settings', JSON.stringify(runSettings(o))] : []),
    ...extra] };
}
// the profile's flags after a command's own: --strict-mcp-config once, one --disallowedTools list (merged into the command's own)
function mergeArgs(own, extra) {
  const out = [];
  for (let i = 0; i < extra.length; i++) {
    const a = extra[i], j = own.indexOf(a);
    if (a === '--strict-mcp-config' && j >= 0) continue;
    if (a === '--disallowedTools' && j >= 0) { own[j + 1] = [...new Set([...own[j + 1].split(','), ...extra[i + 1].split(',')])].join(','); i++; continue; }
    out.push(a);
  }
  return out;
}
// META-STANDING-CONTEXT R1: a launch profile's switches (launchpolicy.mjs PROFILE_DEFAULTS; data in policy.launch) -> Claude Code 2.1.3xx
// flags. "full" (no switch) adds nothing: today's launch, byte-same. Never --bare: it never reads the OAuth login (a subscription).
export function profileArgs(p) {
  if (!p) return [];
  if (p.bare) throw new Error('launch profile ' + (p.name || '?') + ': never --bare (it never reads the OAuth login - a subscription session fails)');
  return [...(p.mcp === 'norn' || p.mcp === 'none' ? ['--strict-mcp-config'] : []), ...(p.user_setup === false ? ['--setting-sources', 'project,local'] : []),
    ...(p.skills === false ? ['--disable-slash-commands'] : []), ...(p.dynamic_prompt === false ? ['--exclude-dynamic-system-prompt-sections'] : []),
    ...(p.tools ? ['--tools', p.tools.join(',')] : []), ...(p.disallowed_tools ? ['--disallowedTools', p.disallowed_tools.join(',')] : []),
    ...(p.agents ? ['--agents', JSON.stringify(p.agents)] : [])];   // the user-level agent inline when the user setup is off (standing.inlineAgent)
}
// META-GTP-MAIL delivery (a): the launcher's PostToolUse hook (--settings JSON; merged with the user's settings) - its stdout
// (hookSpecificOutput.additionalContext) reaches the model at the next tool round; no mail = no output
// META-DOD 2: a guarded run's scope part (scope.mjs scopeSettings: deny rules, the write block, the PreToolUse hook) rides the same JSON;
// its NOTES folder is a working directory (the write block would refuse the NOTES otherwise)
const runSettings = o => { const m = o.mail_hook ? mailSettings(o.mail_hook) : { hooks: {} }; return o.scope ? { ...o.scope, hooks: { ...o.scope.hooks, ...m.hooks } } : m; };
export const mailSettings = command => ({ hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 30 }] }] } });

/** doctor --probe: the CLI path without --remote-control, the agent kept (proves it resolves), no shell / edit tools or MCP, 1 turn. */
function probe(o) {
  const c = command({ ...o, mode: 'write', readonly: false, remote: false, mcp: null });
  c.args.push('--disallowedTools', CLAUDE_RO_NOPE.join(','), '--strict-mcp-config', '--max-turns', '1');
  return c;
}

// the pre-H2 parser: the fields the run `end` record has always carried
export function parseClaudeFinal(text) {
  try {
    const j = JSON.parse(text);
    return { session_id: j.session_id ?? null, cost_usd: j.total_cost_usd ?? null, is_error: j.is_error ?? null, usage: j.usage ?? null };
  } catch { return { session_id: null, cost_usd: null, is_error: null, usage: null }; }
}

const num = v => (Number.isFinite(v) ? v : null);
/** normalized: { session_id, model, is_error, usage { input, cache_read, cache_write, output }, cost_usd } */
function parse(text) {
  let j;
  try { j = JSON.parse(text); } catch { return EMPTY(); }
  if (!j || typeof j !== 'object') return EMPTY();
  const u = j.usage;
  return { session_id: j.session_id ?? null, model: Object.keys(j.modelUsage || {})[0] ?? null, is_error: j.is_error ?? null,
    usage: u ? { input: num(u.input_tokens), cache_read: num(u.cache_read_input_tokens), cache_write: num(u.cache_creation_input_tokens), output: num(u.output_tokens) } : null,
    cost_usd: j.total_cost_usd ?? null };
}

/** the run `end` record fields (records schema unchanged): usage (raw claude usage) + cost_usd when known */
function endData({ final }) {
  const f = parseClaudeFinal(readText(final));
  return { usage: f.usage, ...(f.cost_usd !== null ? { cost_usd: f.cost_usd } : {}) };
}

/** projects_dir/<any>/<sid>.jsonl (D8) or null. */
export function findTranscript(projectsDir, sid) {
  if (!projectsDir || !sid) return null;
  for (const d of readdirS(projectsDir)) { const f = path.join(projectsDir, d.name, sid + '.jsonl'); if (existsS(f)) return f; }   // META-DASH-ASYNC R1: snapshot-aware
  return null;
}
/** findTranscript on fs.promises (primes the snapshot the sync form then reads) */
export async function findTranscriptA(projectsDir, sid) {
  if (!projectsDir || !sid) return null;
  const fs_ = (await readdirA(projectsDir)).map(d => path.join(projectsDir, d.name, sid + '.jsonl'));
  const has = await Promise.all(fs_.map(existsA));
  return fs_.find((_, i) => has[i]) ?? null;
}

export const usageCtx = u => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
const resultText = b => typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map(x => x?.text ?? '').join('\n') : '';
/**
 * One transcript record -> normalised events (LANE-MAP-DESIGN 2). The human prompt (the brief) and thinking are not events.
 * RM-36: a tool event carries its input (slimInput), a result its text (clip), a text event its words (cut), a TodoWrite step
 * its whole list - the activity view (dash/activity.mjs) is derived from these.
 */
export function transcriptEvents(text) {
  const j = JSON.parse(text), ts = j.timestamp ?? null, m = j.message;
  if (j.type === 'assistant' && m && Array.isArray(m.content)) {
    const out = [];
    for (const b of m.content) {
      if (b?.type === 'text' && String(b.text ?? '').trim()) out.push({ ts, kind: 'text', summary: oneLine(b.text), text: cut(String(b.text).trim(), 2000) });
      else if (b?.type === 'tool_use' && b.name === 'TodoWrite') {
        const todos = slimInput(b.input).todos || [], t = todos.find(x => x.status === 'in_progress');
        out.push({ ts, kind: 'step', name: 'TodoWrite', summary: t ? oneLine(t.activeForm || t.content) : `plan: ${todos.filter(x => x.status === 'completed').length} of ${todos.length} done`, todos });
      } else if (b?.type === 'tool_use') out.push({ ts, kind: 'tool', name: String(b.name ?? 'tool'), id: b.id ?? null, summary: argSummary(b.input), input: slimInput(b.input) });
    }
    if (m.usage) { const ctx = usageCtx(m.usage); out.push({ ts, kind: 'usage', summary: `context ${Math.round(ctx / 1000)}k`, ctx }); }
    return out;
  }
  if (j.type === 'user' && Array.isArray(m?.content))
    return m.content.filter(b => b?.type === 'tool_result').map(b => ({ ts, kind: b.is_error ? 'error' : 'tool', id: b.tool_use_id ?? null, done: true,
      summary: b.is_error ? oneLine(resultText(b).replace(/<\/?tool_use_error>/g, '')) : '', text: clip(resultText(b)) }));
  return [];
}

/**
 * META-CONTROLLER C0 (SPEC sec. 1): one stream-json line of a chat session -> Norn's normalised chat events:
 * session { session_id, model, permission_mode, mcp [{ name, status }] } | text { text } | tool { name, id, input } |
 * result { id, is_error, text, permission? { decision, source } } | usage { ctx } | turn { ok, subtype, session_id, cost_usd, denials, error? }.
 * Hooks, thinking, rate-limit and progress lines are no events.
 */
export function chatEvents(line) {
  const j = jsonObject(line), m = j?.message;
  if (!j) return [];
  if (j.type === 'system' && j.subtype === 'init')
    return [{ kind: 'session', session_id: j.session_id ?? null, model: j.model ?? null, permission_mode: j.permissionMode ?? null,
      mcp: (j.mcp_servers || []).map(s => ({ name: s.name, status: s.status })), ...(Array.isArray(j.slash_commands) ? { commands: j.slash_commands.map(String) } : {}) }];
  if (j.type === 'assistant' && Array.isArray(m?.content)) {
    const out = m.content.flatMap(b => b?.type === 'text' && String(b.text ?? '').trim() ? [{ kind: 'text', text: b.text }]
      : b?.type === 'tool_use' ? [{ kind: 'tool', name: String(b.name ?? 'tool'), id: b.id ?? null, input: b.input ?? {} }] : []);
    // R1: a local command's reply (/context ...) is a synthetic line with all-zero usage - no model call, so no context reading
    if (m.usage && usageCtx(m.usage) > 0) out.push({ kind: 'usage', ctx: usageCtx(m.usage) });
    return out;
  }
  if (j.type === 'user' && Array.isArray(m?.content)) {
    const decided = new Map((j.tool_result_meta || []).filter(x => x?.permission_decision).map(x => [x.id, x.permission_decision]));
    return m.content.filter(b => b?.type === 'tool_result').map(b => {
      const p = decided.get(b.tool_use_id);
      return { kind: 'result', id: b.tool_use_id ?? null, is_error: !!b.is_error, text: resultText(b), ...(p ? { permission: { decision: p.decision, source: p.source } } : {}) };
    });
  }
  if (j.type === 'result') {
    const ok = !j.is_error && j.subtype === 'success';
    // C5: the turn's own token use (result.usage sums the turn's model calls; the assistant lines repeat a call's usage per content
    // block, so they are no token count) - cost_usd stays the CLI's per-process running total (the cost line takes deltas)
    const u = j.usage && typeof j.usage === 'object' ? { usage: { input: num(j.usage.input_tokens), cache_read: num(j.usage.cache_read_input_tokens),
      cache_write: num(j.usage.cache_creation_input_tokens), output: num(j.usage.output_tokens) } } : {};
    return [{ kind: 'turn', ok, subtype: j.subtype ?? null, session_id: j.session_id ?? null, cost_usd: j.total_cost_usd ?? null,
      denials: (j.permission_denials || []).length, ...u, ...(ok ? {} : { error: String(j.result ?? j.subtype ?? '') }) }];
  }
  return [];
}

/**
 * META-CONTROLLER C1 (SPEC sec. 1 + 3; C0 facts 1 + 4): the owner's controller chat = ONE long-lived process, stream-json in and out,
 * stdin kept open (one user line per message), a fresh session by --session-id, a later process on the same thread by --resume.
 * Read-only file tools (the shell / edit / subagent tools refused), MCP only from --mcp-config and its tools allowed without a prompt
 * (C3 adds the approval tool). o: { exe, model, effort, session_id, resume?, mcp? { name, command, args }, system? (the role pack),
 * cwd, addDirs?, rawShell? off | ask | on (C5 Settings: off = the shell / edit tools refused by flag; ask / on = they reach the permission
 * prompt, where norn_approve shows a card or allows) } -> { exe, args, cwd, stdin: 'stream' }.
 */
function chatCommand(o) {
  if (!o.session_id) throw new Error('chat needs a session_id');
  // META-CONTROLLER C3: every prompt of the CLI goes to the owner's approval card (C0 fact 2: the tool is called in -p mode)
  const mcp = o.mcp ? ['--mcp-config', JSON.stringify({ mcpServers: { [o.mcp.name]: { command: o.mcp.command, args: o.mcp.args } } }), '--allowedTools', `mcp__${o.mcp.name}`,
    '--permission-prompt-tool', `mcp__${o.mcp.name}__norn_approve`] : [];
  const chatOwn = [...(o.rawShell && o.rawShell !== 'off' ? [] : ['--disallowedTools', CLAUDE_RO_NOPE.join(',')]), ...mcp, '--strict-mcp-config'], chatExtra = mergeArgs(chatOwn, profileArgs(o.profile));   // the chat is always strict
  return { exe: o.exe, cwd: o.cwd, stdin: 'stream', args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', o.model, '--effort', o.effort, ...(o.resume ? ['--resume', o.session_id] : ['--session-id', o.session_id]),
    ...chatOwn, ...(o.system ? ['--append-system-prompt', o.system] : []),
    ...(o.addDirs || []).flatMap(d => ['--add-dir', d]), ...chatExtra],
    // a tier-2 call waits up to 30 min for the owner's tap: the CLI's MCP tool timeout must outlast it
    ...(o.mcp ? { env: { MCP_TOOL_TIMEOUT: String(CHAT_TOOL_TIMEOUT_MS) } } : {}) };
}
const CHAT_TOOL_TIMEOUT_MS = 35 * 60000;

/**
 * Live feed: the run's transcript <projects_dir>/<proj>/<session_id>.jsonl, incremental by byte offset; a run without one
 * (a check-in, a provider that writes none) tails its log instead. env: { projectsDir, memo }.
 */
async function feed(run, cursor, env = {}) {   // META-DASH-ASYNC R1: every lookup + read on fs.promises (the dash polls it)
  const d = run.data || {}, end = run.end || {};
  const file = end.transcript || d.transcript || await located(env, 'transcript', () => findTranscriptA(env.projectsDir, d.session_id));
  if (file && await existsA(file)) return feedFiles([['transcript', file]], cursor, transcriptEvents, env);
  return feedFiles([['log', d.log]], cursor, logLine, env);
}

// META-INSTRUCTIONS R1: the files Claude Code loads by itself (code.claude.com/docs memory): the repo's CLAUDE.md, CLAUDE.local.md and
// .claude/CLAUDE.md at the session root every session, nested ones when the session reads files under them (on demand), the user's
// <config dir>/CLAUDE.md every session; a `@path` line imports that file into the importer's load. --agent <role> loads one agent file.
export const instructions = { family: 'claude', label: 'Claude Code', repo: ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md'],
  user: ['${claude_config}/CLAUDE.md'], imports: true, agents: '.claude/agents', skills: '.claude/skills',
  verified: { version: '2.1.314', date: '2026-11-14', source: 'code.claude.com/docs memory (META-PRACTICE-P1 check 23: re-check on a CLI update)' } };

export default {
  family: 'claude', caps, instructions, mailHook: true, command, profileArgs, probe, parse, endData, feed, chatCommand, chatEvents,
  detect: machine => detectExe(machine?.claude?.exe),
  headless: HEADLESS_CORE + ' Tools: Claude Code tools; Bash is Git Bash (POSIX). Never end a turn waiting for a background job (it dies with you).',
};
