// metaexec X1: `norn doctor --probe <name>` - ONE minimal request (a 1-word reply, 1 turn) through the command line `norn run`
// would spawn for that executor, proving endpoint + model + agent resolve. Exit 0 ok / 1 with one line of reason. The key of a
// provider is read from the env at spawn time only (child env), never printed: any echo of it in the child's output is masked.
// Codex is never probed (it would spend the Codex plan; a real run proves it), nor an openai-compatible entry (the Codex CLI path).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { BUILTIN, isApi, isCli, isOpenAI, isTyped, providerEnv } from './executors.mjs';
import { adapterFor, harnessOf } from './harness/index.mjs';
import { resolveShim } from './paths.mjs';

export class ProbeRefused extends Error { constructor(msg, code = 1) { super(msg); this.code = code; } }

const PROMPT = 'Reply with the single word OK. Use no tools.';

/** The probe's command { exe, args, env (vars to set, null = delete), parse, model, agent } in temp dir `dir`; throws ProbeRefused. */
export function probeCommand({ name, entry = {}, machine, env = process.env, dir }) {
  if (!isTyped(entry) && !Object.hasOwn(BUILTIN, name)) throw new ProbeRefused(`unknown executor "${name}"`, 2);
  if (BUILTIN[name]?.kind === 'codex') throw new ProbeRefused(`Codex is not probed (it would spend the Codex plan; a real run proves it)`);
  if (isOpenAI(entry)) throw new ProbeRefused(`executor ${name} (openai-compatible) is not probed: it runs through the Codex CLI; a real run proves it`);
  if (entry.enabled === false) throw new ProbeRefused(`executor ${name} is disabled`);
  const vars = isApi(entry) ? providerEnv(entry, env) : { vars: {}, missing: null };
  if (vars.missing) throw new ProbeRefused(`key var ${vars.missing} unset`);
  const cli = isCli(entry);
  const model = entry.model || BUILTIN[name]?.model, effort = 'low', agent = cli ? undefined : entry.agent;
  const brief = path.join(dir, 'probe-brief.md');
  fs.writeFileSync(brief, cli ? PROMPT + '\n' : 'mode: done\n');
  const o = { executor: name, brief, worktree: dir, model, effort, agent, promptText: PROMPT, session_id: crypto.randomUUID(), readonly: true, ...(cli ? { provider: entry } : {}) };
  // through the executor's harness adapter (H2): its probe() = the run command line cut to one turn, no shell / edit tools
  const family = harnessOf(name, entry), exe = family === 'fake' ? undefined : cli ? entry.exe : machine?.[family]?.exe;
  if (family !== 'fake' && !exe) throw new ProbeRefused(cli ? `no ${name} executable (executors.${name}.exe)` : `no ${family} executable (machine.json)`);
  const c = adapterFor(family).probe({ ...o, exe });
  return { ...c, env: vars.vars, model, agent };
}

const oneLine = s => String(s ?? '').split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? '';

/** Runs the probe; prints exactly one line ("ok probe <name>: ..." / "PROBE FAILED <name>: <reason>"); returns the exit code. */
export function runProbe({ name, entry = {}, machine, env = process.env, out, timeoutMs = 180000 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-probe-'));
  const secret = isApi(entry) ? env[entry.api_key_env] : null;
  const mask = s => (secret ? s.split(secret).join('***') : s).slice(0, 300);
  const fail = (why, code = 1) => { out(`PROBE FAILED ${name}: ${mask(why)}`); return code; };
  try {
    let c;
    try { c = probeCommand({ name, entry, machine, env, dir }); } catch (e) { if (e instanceof ProbeRefused) return fail(e.message, e.code); throw e; }
    const childEnv = { ...env };
    for (const [k, v] of Object.entries(c.env)) { if (v === null) delete childEnv[k]; else childEnv[k] = String(v); }
    let sp;
    try { sp = resolveShim(c.exe, c.args); } catch (e) { return fail(e.message); }
    const t0 = Date.now();
    const r = spawnSync(sp.exe, sp.args, { cwd: dir, env: childEnv, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, input: '' });
    const ms = Date.now() - t0;
    if (r.error) return fail(r.error.code === 'ETIMEDOUT' ? `no answer in ${timeoutMs / 1000} s` : r.error.message);
    let res = null;
    if (c.parse === 'claude') { try { res = JSON.parse(r.stdout); } catch { res = null; } }
    if (r.status !== 0 || (c.parse === 'claude' && (!res || res.is_error))) {
      return fail(oneLine(res?.result) || oneLine(r.stderr) || oneLine(r.stdout) || `exit ${r.status}${r.signal ? ' ' + r.signal : ''}`);
    }
    if (c.parse !== 'claude' && !oneLine(r.stdout)) return fail('empty reply');
    out(mask(`ok probe ${name}: ${c.exe} model ${c.model}${c.agent ? ` agent ${c.agent}` : ''}${isApi(entry) ? ` endpoint ${entry.base_url}` : ''} (${ms} ms)`));
    return 0;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
