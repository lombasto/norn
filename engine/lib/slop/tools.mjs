// META-SLOP-A: the pinned tools of the rules. A tool is fetched by npx at an EXACT version into Norn's own tool cache
// (<meta root>/state/tools/npm; never a global install). The main test suite reads RECORDED tool output (each rule's fixture);
// `norn slop fixtures` runs the real tools on the fixtures - the nightly-style check, never in the merge gate.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { which, resolveShim } from '../paths.mjs';
import { metaRoot } from '../config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TOOLS = { eslint: { pkg: 'eslint@10.15.0', config: path.join(HERE, 'eslint.config.mjs') } };
export const NORN = path.join(HERE, '..', '..', 'bin', 'norn.mjs');
export const toolCache = (env = process.env) => path.join(metaRoot(env), 'state', 'tools', 'npm');

/** the npx argv of a pinned package: [exe, args] without a shell (an npm .cmd shim resolved to node + its entry) */
export function npxArgv(pkg, args, env = process.env) {
  const npx = which('npx', { env });
  if (!npx) throw new Error('npx not found on PATH (Node.js ships it): the K3 tool cannot be fetched');
  return resolveShim(npx, ['--yes', pkg, ...args]);
}

/** ESLint `-f json` output -> [{ file (relative to dir), line, msg }] */
export function parseEslint(raw, dir) {
  return JSON.parse(raw).flatMap(r => r.messages.filter(m => m.ruleId).map(m => ({
    file: (path.isAbsolute(r.filePath) ? path.relative(dir, r.filePath) : r.filePath).replace(/\\/g, '/'), line: m.line, msg: m.message,
  })));
}

/**
 * The real tool runner: tool(rule, side, { dir, files }) -> raw output | null (no output for that side). A command rule runs once, at
 * check time (its output is the machine's, not a side's: the check keeps only the lines whose source the diff touches). o.env.
 */
export function makeTool({ env = process.env } = {}) {
  return (rule, side, { dir, files } = {}) => {
    if (rule.kind === 'command') {
      const r = spawnSync(process.execPath, [NORN, ...rule.argv], { cwd: dir, env, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 });
      if (r.error) throw r.error;
      return r.stdout;
    }
    const t = TOOLS[rule.tool];
    if (!t) throw new Error(`${rule.id}: unknown tool ${rule.tool}`);
    fs.copyFileSync(t.config, path.join(dir, 'eslint.config.mjs'));
    const { exe, args } = npxArgv(t.pkg, ['-f', 'json', ...files], env);
    const r = spawnSync(exe, args, { cwd: dir, env: { ...env, npm_config_cache: toolCache(env), npm_config_update_notifier: 'false' }, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 });
    if (r.error) throw r.error;
    if (r.status !== 0 && r.status !== 1) throw new Error(`${t.pkg} exited ${r.status}: ${String(r.stderr).trim().split('\n').slice(-2).join(' ')}`);
    return r.stdout;
  };
}
export const runTool = makeTool();
