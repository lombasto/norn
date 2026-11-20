// META-QUEUE-SPEC R1 (RUN-819 / RUN-814: a queued run kept the launch spec of its queue time - a policy change made while it waited never
// reached its launch): the policy-derived parts of a launch spec, resolved in ONE place - by `norn run` at dispatch and again by the
// queue fill at start (runs.mjs fillPass) from the CURRENT project.json + budget.json. What the dispatcher gave explicitly (--model,
// --effort, --agent, --class) stays as given.
import fs from 'node:fs';
import path from 'node:path';
import { loadProject } from './config.mjs';
import { withDefaults, merged, laneMatch } from './policy.mjs';
import { isTyped } from './executors.mjs';

// ---------- lean launch profiles (policy.launch: { roles: { worker | merge | checkin | chat: name }, profiles: { name: overrides } }) ----------
// harness-agnostic switches; each adapter maps them to its flags (profileArgs) or states a gap (profileGap)
//   mcp: 'all' (default) | 'norn' (only Norn's own server) | 'none';  user_setup: false = the user-level settings (plugins, their hooks
//   and skills; ~/.claude/skills stay) not loaded;  skills: false = no skills;  dynamic_prompt: false = cwd / git status out of the system
//   prompt (cache reuse across runs);  tools / disallowed_tools: [names].  Never bare (it never reads the OAuth login).
// lean = the calibration's best (NOTES, 2026-11-13, haiku, Claude Code 2.1.314: 46.6k -> 20.5k turn 1): skills KEPT - switching them off
// grows the Artifact / Workflow tool schemas by ~10k (48.1k) - and the harness tools no Norn role uses dropped.
export const LEAN_DROP_TOOLS = ['Artifact', 'Workflow', 'ScheduleWakeup', 'ReportFindings'];
export const PROFILE_DEFAULTS = {
  full: {},
  lean: { mcp: 'norn', user_setup: false, dynamic_prompt: false, disallowed_tools: LEAN_DROP_TOOLS },
};
export const PROFILE_ROLES = ['worker', 'merge', 'checkin', 'chat'];
// proc-hygiene (4, census 2026-11-19: 8 ansys-mechanical-mcp + ~32 python + agentmemory for 6 workers that never use them): a worker
// or merge loads no MCP server of the owner's own setup unless the project or lane names it (mcpServersOf). DEC-30 (owner Q-45 / DEC-21):
// only under a lean or named profile - the full profile stays byte-same with a launch without one. A profile that sets mcp itself
// ('all' included) wins; a check-in or the chat keeps the profile's default.
const STRICT_MCP_ROLES = ['worker', 'merge'];
/** the launch profile of a role under a project's policy: { name, ...switches } ("full" = today's launch; lean / named: strict MCP for workers) */
export function profileOf(policy, role) {
  const L = policy?.launch || {}, name = L.roles?.[role] ?? L.default ?? 'full';
  return { name, ...(name !== 'full' && STRICT_MCP_ROLES.includes(role) ? { mcp: 'none' } : {}), ...(PROFILE_DEFAULTS[name] || {}), ...(L.profiles?.[name] || {}) };
}
/** the MCP servers a lane's run may load, by name: policy.launch.mcp_servers (every lane) + launch.lane_mcp_servers { <lane glob>: [names] } */
export function mcpServersOf(policy, lane) {
  const L = policy?.launch || {};
  const byLane = Object.entries(L.lane_mcp_servers || {}).filter(([g]) => laneMatch([g], lane)).flatMap(([, v]) => v);
  return [...new Set([...(L.mcp_servers || []), ...byLane].map(String))];
}
/** each named server's definition from the owner's Claude config (<config dir>/.claude.json or the one beside it, then the worktree's
 *  .mcp.json) -> { found: { name: def }, missing: [names] } */
export function mcpDefs(names, { claudeDir, worktree } = {}) {
  const read = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8'))?.mcpServers || {}; } catch { return {}; } };
  const pools = [claudeDir && path.join(claudeDir, '.claude.json'), claudeDir && path.join(path.dirname(claudeDir), '.claude.json'), worktree && path.join(worktree, '.mcp.json')].filter(Boolean).map(read);
  const found = {}, missing = [];
  for (const n of names) { const d = pools.find(p => p[n])?.[n]; if (d) found[n] = d; else missing.push(n); }
  return { found, missing };
}
// META-PRACTICE-P1 (Q1 = yes, DIR-49): the auto-memory folder per role, a launch key apart from the profile (the profile stays
// byte-same). Default per REPORT sec. 5.5: workers + merges off (their rules live in versioned files; Claude Code does the same for its
// subagents, and it keeps workers out of the controller's notebook); check-ins + the chat on. policy.launch.memory.<role> = on | off.
export const MEMORY_DEFAULT = { worker: 'off', merge: 'off', checkin: 'on', chat: 'on' };
export const memoryOf = (policy, role) => (policy?.launch?.memory?.[role] ?? MEMORY_DEFAULT[role] ?? 'on') === 'off' ? 'off' : 'on';
/** the launch env with auto memory off (Claude Code's documented switch); on = the switch deleted (null: supervisor.mjs) - a launch from
 *  a memory-off session inherits it otherwise (META-QUEUE-SPEC R1, live: an "on" run under a worker loaded 0 memory tokens) */
export const memoryEnv = (env, mem) => ({ ...(env || {}), CLAUDE_CODE_DISABLE_AUTO_MEMORY: mem === 'off' ? '1' : null });
/** the role of a run spec / launch: checkin | merge | worker */
export const roleOfSpec = o => (o.kind === 'checkin' ? 'checkin' : /merge|door/i.test(String(o.lane || '')) ? 'merge' : 'worker');

/** an agent file (frontmatter + body) -> the --agents definition { description, prompt, tools?, model? } (Claude Code), or null */
export function agentDef(file) {
  let t; try { t = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const fm = {};
  for (const l of m[1].split(/\r?\n/)) { const k = l.match(/^([\w-]+):\s*(.*)$/); if (k) fm[k[1]] = k[2].trim(); }
  return { description: fm.description || fm.name || path.basename(file, '.md'), prompt: m[2], ...(fm.tools ? { tools: fm.tools.split(/\s*,\s*/).filter(Boolean) } : {}), ...(fm.model ? { model: fm.model } : {}) };
}
/**
 * A profile without the user setup (user_setup: false) also loses the user-level agents (~/.claude/agents; calibration: "--agent not
 * found"). The run's agent from the user config dir is then passed inline (profile.agents -> --agents); a project agent
 * (<worktree>/.claude/agents) still loads with the project source. o: { claudeDir, worktree } -> the profile (+ agents)
 */
export function inlineAgent(profile, agent, { claudeDir, worktree } = {}) {
  if (!profile || profile.user_setup !== false || !agent) return profile;
  if (worktree && fs.existsSync(path.join(worktree, '.claude', 'agents', `${agent}.md`))) return profile;
  const def = claudeDir ? agentDef(path.join(claudeDir, 'agents', `${agent}.md`)) : null;
  return def ? { ...profile, agents: { [agent]: def } } : profile;
}

/**
 * The Claude agents a run may name with --agent: the user's (<claudeDir>/agents), the worktree's (.claude/agents) and the project's own
 * (install.agents). -> sorted names. A plugin agent (plugin:name) is not listed here and is never refused (Claude Code resolves it).
 */
export function knownAgents({ claudeDir, worktree, project } = {}) {
  const names = new Set();
  for (const d of [claudeDir && path.join(claudeDir, 'agents'), worktree && path.join(worktree, '.claude', 'agents'), project?.install?.agents]) {
    if (!d) continue;
    try { for (const f of fs.readdirSync(d)) if (f.endsWith('.md')) names.add(f.slice(0, -3)); } catch { /* no dir */ }
  }
  return [...names].sort();
}
/** null = agent ok (none, a plugin agent, or a known one); else the refusal text. A Claude run on an unknown agent used to start and
 *  crash at once ("--agent 'worker' not found"): it is refused before it starts, naming the agents there are. */
export function agentRefusal(agent, o = {}) {
  if (!agent || String(agent).includes(':')) return null;
  const names = knownAgents(o);
  return names.includes(agent) ? null : `--agent ${agent}: no such agent (known: ${names.join(', ') || 'none'}; or leave --agent out)`;
}

/** the parts the fill resolves again, in record order */
export const FILL_PARTS = ['memory', 'profile', 'model', 'effort', 'agent', 'class'];
/** the flags that win over the policy (flag name -> spec key) */
const EXPLICIT = { model: 'model', effort: 'effort', agent: 'agent', class: 'cls' };

/**
 * The policy-derived launch parts of executor `executor` on `lane` under project `project` (loadProject) + `budget` (budget.json),
 * explicit = { model?, effort?, agent?, class? } (the command line). -> { profile, memory, env, model, effort, agent, cls, workPolicy, provider }
 */
export function launchParts({ project, budget = {}, executor, lane, explicit = {}, claudeDir, worktree }) {
  const xc = project?.executors?.[executor] || {};
  const pol = withDefaults(merged(budget, project?.policy)).policy;   // META-TEND P2: the class table the launcher stamps from (workclass.mjs)
  const DEF = { claude: [budget.claude_model || 'claude-opus-5-5', budget.claude_effort || 'medium'], 'codex-sol': ['gpt-6.1-sol', budget.codex_sol_effort || 'medium'],
    'codex-astra': ['gpt-6-astra', budget.codex_astra_effort || 'medium'], fake: ['fake', '-'] }[executor] || [];
  // a typed executor (claude-compatible / openai-compatible / cli): data only; its model / effort / exe come from the entry
  const prov = isTyped(xc) ? xc : undefined;
  if (prov) DEF.push(prov.model, prov.effort || 'medium');
  const role = roleOfSpec({ lane }), agent = explicit.agent || xc.agent, memory = memoryOf(project?.policy, role);
  let profile = profileOf(project?.policy, role);
  const names = profile.mcp === 'all' ? [] : mcpServersOf(project?.policy, lane);   // proc-hygiene (4): the named servers ride strict
  if (names.length) { const { found, missing } = mcpDefs(names, { claudeDir, worktree }); profile = { ...profile, mcp_servers: found, ...(missing.length ? { mcp_missing: missing } : {}) }; }
  return {
    profile: inlineAgent(profile, agent, { claudeDir, worktree }),   // META-STANDING-CONTEXT R1: policy.launch (full = today's launch)
    memory, env: memoryEnv(xc.env, memory),   // META-PRACTICE-P1: auto memory per role
    agent, model: explicit.model || xc.model || DEF[0], effort: explicit.effort || xc.effort || DEF[1], cls: explicit.class,
    workPolicy: { executors: pol.executors, critical_lanes: pol.critical_lanes }, provider: prov,
  };
}

/** what a queued spec keeps to resolve its parts again at fill: the files read + the explicit flags (undefined = none given) */
export const refillOf = ({ projectFile, budgetFile, meta, explicit, claudeDir }) => (projectFile
  ? { project_file: projectFile, budget_file: budgetFile, meta, claude_dir: claudeDir, explicit: Object.fromEntries(Object.entries(explicit).filter(([, v]) => v !== undefined)) }
  : undefined);

/**
 * At fill: spec with its policy-derived parts from the CURRENT project.json + budget (spec.refill), and the record of it
 * { from [files], parts [FILL_PARTS], explicit [flags kept] }. No refill (a spec not from `norn run --project`) = unchanged, at_fill null.
 * spec.budget is already the budget in force now (runs.mjs liveBudget: GAP-2), so the worker floor startRun raises the refilled
 * model / effort to is the live one too. A project.json that no longer loads throws (the caller keeps the run queued).
 */
export function resolveAtFill(spec) {
  const r = spec.refill;
  if (!r) return { spec, at_fill: null };
  const project = loadProject(r.project_file, r.meta ? { meta: r.meta } : {});
  const p = launchParts({ project, budget: spec.budget || {}, executor: spec.executor, lane: spec.lane, explicit: r.explicit || {}, claudeDir: r.claude_dir, worktree: spec.worktree });
  const { provider, ...parts } = p;
  if (spec.provider && !provider) throw new Error(`executor ${spec.executor} is no longer a typed executor in ${project.file}`);
  const bf = spec.budget_file;
  return {
    spec: { ...spec, ...parts, ...(spec.provider ? { provider } : {}) },
    at_fill: { from: [project.file, ...(bf && fs.existsSync(bf) ? [bf.replace(/\\/g, '/')] : [])], parts: FILL_PARTS,
      explicit: Object.keys(EXPLICIT).filter(k => r.explicit?.[k] !== undefined) },
  };
}
