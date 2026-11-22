// H1 `norn harness install`: register the norn MCP server for claude / codex / opencode / a configured cli executor (grok). Names only, never keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installPlan, tomlBlock, upsertToml, applyPlan } from '../engine/lib/harness.mjs';
import { GROK } from './helpers/command-matrix.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const tmp = () => mkTmp('meta-harness-');
const CFG = tmp();
const run = (...args) => {
  const env = { ...process.env };
  for (const k of ['META_STATE', 'META_PROJECT', 'META_ROLE', 'META_RUN_ID']) delete env[k];
  env.CLAUDE_CONFIG_DIR = CFG;   // never the real ~/.claude.json
  const r = spawnSync(process.execPath, [META, 'harness', ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
const SECRET = /api[_-]?key|token|secret|password|sk-/i;
const o = { node: 'C:/node/node.exe', meta: 'C:/meta/engine/bin/norn.mjs', project: 'C:/p/kestrel.json', profile: 'controller' };

test('server args: node + norn.mjs mcp --project P --profile X --client <family>', () => {
  const p = installPlan({ ...o, family: 'claude', scope: 'local' });
  assert.deepEqual(p.commands, [['claude', 'mcp', 'add', '--scope', 'local', 'norn', '--', 'C:/node/node.exe', 'C:/meta/engine/bin/norn.mjs', 'mcp', '--project', 'C:/p/kestrel.json', '--profile', 'controller', '--client', 'claude']]);
  const executors = { grok: { ...GROK, exe: 'grok' } };   // the kestrel entry (its mcp_add template), exe as before
  const g = installPlan({ ...o, family: 'grok', executors });
  assert.deepEqual(g.commands[0].slice(0, 8), ['grok', 'mcp', 'add', 'norn', '--scope', 'user', '--', 'C:/node/node.exe']);
  assert.equal(g.commands[0].at(-1), 'grok');
  assert.equal(installPlan({ ...o, family: 'grok', executors, scope: 'project' }).commands[0][5], 'project');
  assert.equal(installPlan({ ...o, family: 'grok', executors, scope: 'local' }).commands[0][5], 'user');
  assert.throws(() => installPlan({ ...o, family: 'grok' }), /--family must be/, 'no entry, no family');
  assert.throws(() => installPlan({ ...o, family: 'claude', profile: 'boss' }), /profile/);
});

test('codex config.toml: the [mcp_servers.norn] table is added or replaced, other tables kept, idempotent', () => {
  const before = 'model = "gpt"\n\n[mcp_servers.norn]\ncommand = "old"\n\n[mcp_servers.norn.env]\nX = "1"\n\n[profiles.fast]\nmodel = "m"\n';
  const block = tomlBlock('norn', { command: 'C:/node/node.exe', args: ['a b', 'c"d'] });
  assert.equal(block, '[mcp_servers.norn]\ncommand = "C:/node/node.exe"\nargs = ["a b", "c\\"d"]\n');
  const after = upsertToml(before, 'norn', block);
  assert.equal(after, 'model = "gpt"\n\n[profiles.fast]\nmodel = "m"\n\n' + block);
  assert.equal(upsertToml(after, 'norn', block), after);
  assert.equal(upsertToml('', 'norn', block), block);
});

test('norn harness install --family codex / opencode writes the config files; --dry-run writes nothing; no keys anywhere', () => {
  const d = tmp(), toml = path.join(d, 'config.toml'), oc = path.join(d, 'opencode.json');
  // an absolute project path ON THIS HOST (C:/p/... is relative on Linux: the CLI resolves it against the cwd, as it should)
  const PJ = path.resolve(d, 'p', 'kestrel.json').replace(/\\/g, '/');
  fs.writeFileSync(toml, 'model = "gpt"\n');
  fs.writeFileSync(oc, JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { other: { type: 'local', command: ['x'] } } }));
  const dry = run('install', '--family', 'codex', '--project', PJ, '--codex-config', toml, '--dry-run');
  assert.equal(dry.code, 0, dry.err); assert.match(dry.out, /\[mcp_servers\.norn\]/);
  assert.equal(fs.readFileSync(toml, 'utf8'), 'model = "gpt"\n');
  const r = run('install', '--family', 'codex', '--project', PJ, '--codex-config', toml);
  assert.equal(r.code, 0, r.err);
  const t = fs.readFileSync(toml, 'utf8');
  assert.match(t, /^model = "gpt"\n/);
  assert.match(t, new RegExp(String.raw`\[mcp_servers\.norn\]\ncommand = ".*node[^"]*"\nargs = \[".*norn\.mjs", "mcp", "--project", "${PJ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}", "--profile", "controller", "--client", "codex"\]`));
  const r2 = run('install', '--family', 'opencode', '--project', PJ, '--opencode-config', oc, '--profile', 'checkin');
  assert.equal(r2.code, 0, r2.err);
  const j = JSON.parse(fs.readFileSync(oc, 'utf8'));
  assert.deepEqual(j.mcp.other, { type: 'local', command: ['x'] });
  assert.equal(j.mcp.norn.type, 'local'); assert.equal(j.mcp.norn.enabled, true);
  assert.deepEqual(j.mcp.norn.command.slice(2), ['mcp', '--project', PJ, '--profile', 'checkin', '--client', 'opencode']);
  assert.doesNotMatch(t + JSON.stringify(j), SECRET);
  const cl = run('install', '--family', 'claude', '--project', PJ, '--dry-run');
  assert.equal(cl.code, 0, cl.err); assert.match(cl.out, /^\$ claude mcp add --scope local norn -- /m);
  assert.doesNotMatch(cl.out, SECRET);
  const bad = run('install', '--family', 'nope', '--project', PJ);
  assert.equal(bad.code, 2); assert.match(bad.err, /usage: norn harness install/);
  assert.equal(run('install', '--family', 'codex').code, 2);   // --project or --state is required
});

test('applyPlan runs the registration command without a shell: an arg with a space (C:/Program Files/...) arrives intact', () => {
  const d = tmp(), outFile = path.join(d, 'argv.json'), lines = [];
  const plan = { family: 'claude', files: [], commands: [['claude', '-e', 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))', outFile, 'C:/Program Files/nodejs/node.exe', 'a"b']] };
  applyPlan(plan, { out: s => lines.push(s), exes: { claude: process.execPath } });
  assert.deepEqual(JSON.parse(fs.readFileSync(outFile, 'utf8')), ['C:/Program Files/nodejs/node.exe', 'a"b']);
  assert.match(lines[0], /^\$ claude -e /);
});

// META-ADOPT A4: the setup profile is machine-scoped - no --project / --state, its own server name beside a project's "meta"
test('setup profile: machine-scoped server args, server name norn-setup, claude at user scope; a project with it is refused', () => {
  const s = { node: 'C:/node/node.exe', meta: 'C:/meta/engine/bin/norn.mjs', profile: 'setup' };
  assert.deepEqual(installPlan({ ...s, family: 'claude' }).commands, [['claude', 'mcp', 'add', '--scope', 'user', 'norn-setup', '--', 'C:/node/node.exe', 'C:/meta/engine/bin/norn.mjs', 'mcp', '--profile', 'setup', '--client', 'claude']]);
  const t = installPlan({ ...s, family: 'codex', codexConfig: 'C:/nowhere/config.toml' }).files[0].content;
  assert.match(t, /\[mcp_servers\.norn-setup\]\ncommand = "C:\/node\/node\.exe"\nargs = \["C:\/meta\/engine\/bin\/norn\.mjs", "mcp", "--profile", "setup", "--client", "codex"\]/);
  assert.throws(() => installPlan({ ...s, family: 'claude', project: 'C:/p/kestrel.json' }), /machine-scoped/);
});

// RM-9 (Q-39): install registers the norn server only; every other server in the config (whatever its name) is kept as it is
test('harness install adds the norn server and touches no other server', () => {
  const d = tmp(), home = path.join(d, 'home'), toml = path.join(home, '.codex', 'config.toml'), oc = path.join(home, '.config', 'opencode', 'opencode.json');
  fs.mkdirSync(path.dirname(toml), { recursive: true }); fs.mkdirSync(path.dirname(oc), { recursive: true });
  fs.writeFileSync(toml, `model = "gpt"\n\n[mcp_servers.meta]\ncommand = "node"\nargs = ["x.mjs"]\n`);
  fs.writeFileSync(oc, JSON.stringify({ mcp: { meta: { type: 'local', command: ['node', 'x.mjs'] } } }));
  const o = { node: 'C:/node/node.exe', meta: 'C:/inst/engine/bin/norn.mjs' };
  assert.deepEqual(installPlan({ ...o, family: 'claude', state: 'C:/s', profile: 'worker', cwd: 'C:/x' }).commands.map(c => c.slice(0, 6)), [['claude', 'mcp', 'add', '--scope', 'local', 'norn']]);
  const t = installPlan({ ...o, family: 'codex', state: 'C:/s', profile: 'worker', codexConfig: toml }).files[0].content;
  assert.match(t, /^model = "gpt"\n\n\[mcp_servers\.meta\]\n/); assert.match(t, /\[mcp_servers\.norn\]\n/);
  const j = JSON.parse(installPlan({ ...o, family: 'opencode', state: 'C:/s', profile: 'worker', opencodeConfig: oc }).files[0].content);
  assert.deepEqual(Object.keys(j.mcp).sort(), ['meta', 'norn']);
});
