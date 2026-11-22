// H1 `norn harness install`: register the norn MCP server with one harness family. Names and paths only, never keys
// (the server reads no secrets; META-EXEC-S1 rule). claude is registered through its own `mcp add` CLI, a configured cli executor
// through the `mcp_add` template of its project.json entry (META-AGNOSTIC-EXEC: --family <cli name>);
// codex (config.toml) and opencode (opencode.json) are config files this module edits in place, keeping everything else.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROFILES } from './mcp.mjs';
import { which, resolveShim } from './paths.mjs';
import { isCli } from './executors.mjs';
import { mcpAddCommand } from './harness/cli.mjs';

const SERVER_NAME = 'norn';
// META-ADOPT A4: the machine-scoped setup server sits beside a project's "norn" server, under its own name
const SETUP_NAME = 'norn-setup';

export const FAMILIES = ['claude', 'codex', 'opencode'];

export function serverArgs({ node, meta, project, state, profile, family }) {
  return [node, meta, 'mcp', ...(profile === 'setup' ? [] : project ? ['--project', project] : ['--state', state]), '--profile', profile, '--client', family];
}

const tomlStr = s => JSON.stringify(String(s));   // a JSON string is a valid TOML basic string for these values
export const tomlBlock = (name, { command, args }) => `[mcp_servers.${name}]\ncommand = ${tomlStr(command)}\nargs = [${args.map(tomlStr).join(', ')}]\n`;

// Replace the [mcp_servers.<name>] table and its sub-tables ([mcp_servers.<name>.env], ...) with `block`, or append it.
export function upsertToml(text, name, block) {
  const head = `[mcp_servers.${name}]`, sub = `[mcp_servers.${name}.`;
  const lines = text.replace(/\r\n/g, '\n').split('\n'), kept = [];
  let skip = false;
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith('[')) skip = t === head || t.startsWith(sub);
    if (!skip) kept.push(l);
  }
  const body = kept.join('\n').replace(/\n+$/, '');
  return body ? body + '\n\n' + block : block;
}

/** The plan for one family: { family, commands: [[exe, ...args]], files: [{ path, content }] }. o: { family, node, meta, project | state, profile, scope, codexConfig, opencodeConfig, home, executors? (the project's) } */
export function installPlan(o) {
  const cli = Object.entries(o.executors || {}).find(([n, x]) => n === o.family && isCli(x) && x.mcp_add)?.[1];
  if (!FAMILIES.includes(o.family) && !cli) throw new Error(`--family must be ${FAMILIES.join(' | ')} | a configured cli executor with mcp_add (got ${JSON.stringify(o.family)})`);
  if (!PROFILES.includes(o.profile)) throw new Error(`--profile must be ${PROFILES.join(' | ')} (got ${JSON.stringify(o.profile)})`);
  const setup = o.profile === 'setup', name = setup ? SETUP_NAME : SERVER_NAME;
  if (setup && (o.project || o.state)) throw new Error('profile setup is machine-scoped: no --project / --state');
  if (!setup && !o.project && !o.state) throw new Error('--project <project.json> or --state <dir> is required');
  const [command, ...args] = serverArgs(o);
  if (o.family === 'claude') {
    const scope = o.scope || (setup ? 'user' : 'local');
    return { family: o.family, name, commands: [['claude', 'mcp', 'add', '--scope', scope, name, '--', command, ...args]], files: [] };
  }
  if (cli) return { family: o.family, name, commands: [mcpAddCommand(cli, { name, scope: o.scope, command, args })], files: [] };
  if (o.family === 'codex') {
    const file = o.codexConfig || path.join(o.home, '.codex', 'config.toml');
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    return { family: o.family, name, commands: [], files: [{ path: file, content: upsertToml(before, name, tomlBlock(name, { command, args })) }] };
  }
  const file = o.opencodeConfig || path.join(o.home, '.config', 'opencode', 'opencode.json');
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) : { $schema: 'https://opencode.ai/config.json' };
  cfg.mcp = { ...(cfg.mcp || {}), [name]: { type: 'local', command: [command, ...args], enabled: true } };
  return { family: o.family, name, commands: [], files: [{ path: file, content: JSON.stringify(cfg, null, 2) + '\n' }] };
}

const quote = a => (/[\s"]/.test(a) ? JSON.stringify(a) : a);
/** Print the plan; unless dry, write the files and run the commands (exe from `exes[family]`, default the bare name). */
export function applyPlan(plan, { dry = false, out, exes = {} }) {
  for (const f of plan.files) {
    out(`=== ${f.path}${dry ? ' (dry run)' : ''}\n${f.content.trimEnd()}`);
    if (!dry) { fs.mkdirSync(path.dirname(f.path), { recursive: true }); fs.writeFileSync(f.path, f.content); }
  }
  for (const [exe, ...args] of plan.commands) {
    out('$ ' + [exe, ...args].map(quote).join(' '));
    if (dry) continue;
    // no shell: a shell would split the 'C:/Program Files/...' node path; npm .cmd shims resolve to node + entry (paths.mjs)
    const found = exes[plan.family] || (path.isAbsolute(exe) && fs.existsSync(exe) ? exe : which(exe));
    if (!found) throw new Error(`${exe} is not on PATH`);
    const sp = resolveShim(found, args);
    execFileSync(sp.exe, sp.args, { stdio: 'inherit', windowsHide: true });
  }
}
