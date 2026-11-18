// Harness adapter: Codex CLI (`codex exec`, brief on stdin, final message to -o, banner + "tokens used" in the log).
// Command lines are byte-same with the pre-H2 runs.mjs switch (tests/golden/commands/matrix.json).
import fs from 'node:fs';
import path from 'node:path';
import { readdirS, readdirA } from '../fsnap.mjs';
import { modeOf, readText, readHeadA, detectExe, HEADLESS_CORE, HEADLESS_MAIL, feedFiles, logLine, oneLine, argSummary, located, jsonObject } from './common.mjs';

const caps = { modes: ['write', 'read-only'], resume: true, mcp: 'flag', output: 'log', usage: 'tokens', skills: 'agents',
  fork: true, hooks: 'settings', resume_style: 'subcommand', chat: 'none', noninteractive: 'exec' };   // codex exec fork | resume, features: hooks stable

// an openai-compatible executor (DEC-622): a Codex custom model provider by -c overrides; the key is read by Codex from the env
// var NAMED env_key (never written here); wire_api default "responses"
function providerArgs(o) {
  const p = o.provider;
  if (p?.type !== 'openai-compatible') return [];
  const n = o.executor, q = JSON.stringify, at = `model_providers.${n}`;
  return ['-c', `model_provider=${q(n)}`, '-c', `${at}.name=${q(n)}`, '-c', `${at}.base_url=${q(p.base_url)}`,
    '-c', `${at}.env_key=${q(p.api_key_env)}`, '-c', `${at}.wire_api=${q(p.wire_api || 'responses')}`];
}

/** o: { exe, brief, model, effort, final, writable_roots, readonly | mode, mcp, provider? (an openai-compatible entry) } */
function command(o) {
  // gap #3: the run's result directory is writable in the sandbox (`norn done` writes the outcome there)
  const mode = modeOf(o, 'codex', caps), roots = [...(o.writable_roots || []), ...(o.resultDir ? [String(o.resultDir).split('\\').join('/')] : [])];
  const sandbox = mode === 'read-only' ? ['-s', 'read-only'] : ['-s', 'workspace-write',
    ...(roots.length ? ['-c', `sandbox_workspace_write.writable_roots=[${roots.map(r => `'${r}'`).join(',')}]`] : []),
    '-c', 'sandbox_workspace_write.network_access=true'];
  // per-run MCP attach: -c overrides of [mcp_servers.<name>] (a JSON string / array is valid TOML for these values)
  const mcp = o.mcp ? ['-c', `mcp_servers.${o.mcp.name}.command=${JSON.stringify(o.mcp.command)}`, '-c', `mcp_servers.${o.mcp.name}.args=${JSON.stringify(o.mcp.args || [])}`] : [];
  return { exe: o.exe, stdin: o.brief, stdout: 'log', parse: 'codex', args: [
    'exec', '--skip-git-repo-check', '--disable', 'code_mode', '-m', o.model, '-c', `model_reasoning_effort="${o.effort}"`, ...providerArgs(o), ...sandbox, ...mcp, '-o', o.final, '-'] };
}

// the pre-H2 parser: banner fields between the first two "--------" lines + the last "tokens used" count
export function parseCodexLog(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const seps = lines.reduce((a, l, i) => (l === '--------' ? [...a, i] : a), []);
  const banner = seps.length >= 2 ? lines.slice(seps[0] + 1, seps[1]) : [];
  const field = k => { const l = banner.find(x => x.startsWith(k + ': ')); return l ? l.slice(k.length + 2).trim() : null; };
  let tokens = null;
  for (let i = lines.length - 2; i >= 0; i--) if (lines[i].trim() === 'tokens used' && /^[\d,]+$/.test(lines[i + 1].trim())) { tokens = Number(lines[i + 1].trim().replace(/,/g, '')); break; }
  return { model: field('model'), effort: field('reasoning effort'), session_id: field('session id'), tokens };
}

/** normalized: the log has only a total -> usage { input/cache_read/cache_write/output null, total } */
function parse(text) {
  const c = parseCodexLog(text);
  return { session_id: c.session_id, model: c.model, is_error: null,
    usage: c.tokens === null ? null : { input: null, cache_read: null, cache_write: null, output: null, total: c.tokens }, cost_usd: null };
}

/** the run `end` record fields (records schema unchanged) */
function endData({ log }) {
  const c = parseCodexLog(readText(log));
  return { tokens: c.tokens, usage: c.tokens === null ? null : { tokens: c.tokens },
    ...(c.model ? { model: c.model } : {}), ...(c.effort ? { effort: c.effort } : {}), ...(c.session_id ? { codex_session: c.session_id } : {}) };
}

/** <codex sessions>/YYYY/MM/DD/rollout-<ts>-<sid>.jsonl, newest day first, or null. */
export function findRollout(sessionsDir, sid) {
  if (!sessionsDir || !sid) return null;
  const want = `-${sid}.jsonl`;
  const walk = d => {   // META-DASH-ASYNC R1: snapshot-aware (findRolloutA primes the same walk)
    const ents = [...readdirS(d)].sort((a, b) => (a.name < b.name ? 1 : -1));
    for (const e of ents) if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith(want)) return path.join(d, e.name);
    for (const e of ents) if (e.isDirectory()) { const f = walk(path.join(d, e.name)); if (f) return f; }
    return null;
  };
  return walk(sessionsDir);
}
/** findRollout on fs.promises (the same walk, newest day first; primes the snapshot the sync form then reads) */
export async function findRolloutA(sessionsDir, sid) {
  if (!sessionsDir || !sid) return null;
  const want = `-${sid}.jsonl`;
  const walk = async d => {
    const ents = [...await readdirA(d)].sort((a, b) => (a.name < b.name ? 1 : -1));
    for (const e of ents) if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith(want)) return path.join(d, e.name);
    for (const e of ents) if (e.isDirectory()) { const f = await walk(path.join(d, e.name)); if (f) return f; }
    return null;
  };
  return walk(sessionsDir);
}

// the exec tool's input is a script: its first cmd / command string literal is what it runs
function scriptSummary(s) {
  const m = String(s ?? '').match(/\b(?:cmd|command)\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) { try { return oneLine(JSON.parse(`"${m[1]}"`), 80); } catch { return oneLine(m[1], 80); } }
  return argSummary(String(s ?? ''));
}
function parseArgs(a) { if (typeof a !== 'string') return a; try { return JSON.parse(a); } catch { return a; } }
const outputs = new Set(['function_call_output', 'custom_tool_call_output']);
/** One rollout record -> normalised events (LANE-MAP-DESIGN 2); session / world / developer records are not events. */
export function rolloutEvents(text) {
  const j = JSON.parse(text), ts = j.timestamp ?? null, p = j.payload;
  if (!p || typeof p !== 'object') return [];
  if (j.type === 'response_item') {
    if (p.type === 'function_call') return [{ ts, kind: 'tool', name: p.namespace ? `${p.namespace}.${p.name}` : String(p.name ?? 'tool'), id: p.call_id ?? null, summary: argSummary(parseArgs(p.arguments)) }];
    if (p.type === 'custom_tool_call') return [{ ts, kind: 'tool', name: String(p.name ?? 'tool'), id: p.call_id ?? null, summary: scriptSummary(p.input) }];
    if (outputs.has(p.type)) return [{ ts, kind: 'tool', id: p.call_id ?? null, done: true, summary: '' }];
    if (p.type === 'message' && p.role === 'assistant') {
      const t = (p.content || []).map(c => c?.text ?? '').join('\n');
      return t.trim() ? [{ ts, kind: 'text', summary: oneLine(t) }] : [];
    }
    if (p.type === 'reasoning') {
      const t = (p.summary || []).map(c => c?.text ?? '').join('\n').replace(/\*\*/g, '');
      return t.trim() ? [{ ts, kind: 'step', summary: oneLine(t) }] : [];
    }
    return [];
  }
  if (j.type === 'event_msg' && p.type === 'token_count' && Number.isFinite(p.info?.last_token_usage?.total_tokens)) {
    const ctx = p.info.last_token_usage.total_tokens;
    return [{ ts, kind: 'usage', summary: `context ${Math.round(ctx / 1000)}k`, ctx, ...(Number.isFinite(p.info.model_context_window) ? { window: p.info.model_context_window } : {}) }];
  }
  if (j.type === 'event_msg' && p.type === 'error') return [{ ts, kind: 'error', summary: oneLine(p.message ?? 'error') }];
  return [];
}

/**
 * Live feed: the rollout <codex sessions>/.../rollout-*-<sid>.jsonl (session id from the run end or the log banner); before the
 * banner names a session, the run log itself. env: { codexDir, memo }.
 */
async function feed(run, cursor, env = {}) {   // META-DASH-ASYNC R1: every lookup + read on fs.promises (the dash polls it)
  const d = run.data || {}, end = run.end || {};
  const sid = end.codex_session || await located(env, 'codex-sid', async () => (d.log ? parseCodexLog(await readHeadA(d.log)).session_id : null), 1000);
  const file = sid ? await located(env, 'rollout', () => findRolloutA(env.codexDir, sid)) : null;
  if (file) return feedFiles([['rollout', file]], cursor, rolloutEvents, env);
  return feedFiles([['log', d.log]], cursor, logLine, env);
}

/**
 * META-CONTROLLER C0: one `codex exec --json` line -> Norn's normalised chat events (the shapes recorded so far: a quota-refused
 * turn; C7 adds the rest): session { session_id } | notice { text } | turn { ok: false, error }.
 */
export function chatEvents(line) {
  const j = jsonObject(line);
  if (j?.type === 'thread.started') return [{ kind: 'session', session_id: j.thread_id ?? null }];
  if (j?.type === 'item.completed' && j.item?.type === 'error') return [{ kind: 'notice', text: String(j.item.message ?? '') }];
  if (j?.type === 'turn.failed') return [{ kind: 'turn', ok: false, error: String(j.error?.message ?? '') }];
  return [];
}

// META-INSTRUCTIONS R1: the files Codex CLI loads by itself (developers.openai.com/codex/guides/agents-md): AGENTS.override.md /
// AGENTS.md from the repo root down to the working dir every session (deeper ones only under them), the user's ~/.codex/AGENTS.md
// every session (a `norn gen` target: harness-global.md). No imports.
export const instructions = { family: 'codex', label: 'Codex CLI', repo: ['AGENTS.md', 'AGENTS.override.md'], user: ['${home}/.codex/AGENTS.md'],
  imports: false, skills: '.codex/skills' };

export default {
  family: 'codex', caps, instructions, command, profileArgs: () => [], profileGap: "no lean launch flags are mapped for Codex yet: its MCP servers, skills and instructions come from ~/.codex/config.toml and AGENTS.md, with no verified per-run switch - a profile is ignored (today's launch)", parse, endData, feed, chatEvents,
  // never probed: a probe would spend the Codex plan (a real run proves it)
  probe: () => { throw new Error('Codex is not probed (it would spend the Codex plan; a real run proves it)'); },
  detect: machine => detectExe(machine?.codex?.exe),
  headless: HEADLESS_CORE + ' The brief arrives on stdin; your sandbox is the worktree plus its writable roots: never write outside them.' + HEADLESS_MAIL,
};
