// DEC-362: a policy save rewrites the <!-- policy:key --> lines in the generator SOURCES (project.json policy_targets) and then runs
// norn gen for that project, so the generated targets follow and `norn gen --check` stays clean (no drift). Temp home / meta only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installProject, genCheck, genAfterPolicy } from '../engine/lib/setup.mjs';
import { loadProject, loadMachine } from '../engine/lib/config.mjs';
import { handle } from '../engine/lib/mcp.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fwd = p => p.replace(/\\/g, '/');

// temp home with <home>/dev/sdd-codex = a meta root holding a copy of the demo fixture sources and a machine.json that registers demo
function sandbox({ register = true } = {}) {
  const t = mkTmp('meta-polgen-');
  const home = fwd(path.join(t, 'hx')), meta = `${home}/dev/sdd-codex`, cfg = fwd(path.join(t, 'cfg'));
  // the fixture's own state/ stays out, tested relative to the fixture: every Norn worktree itself sits under <root>/state/...
  const src = path.join(REPO, 'tests', 'fixtures', 'projects', 'demo');
  fs.cpSync(src, `${meta}/projects/demo`, { recursive: true, filter: s => !/^state([\\/]|$)/.test(path.relative(src, s)) });
  fs.mkdirSync(cfg, { recursive: true }); fs.mkdirSync(`${meta}/local`, { recursive: true });
  const pf = `${meta}/projects/demo/project.json`;
  fs.writeFileSync(`${meta}/local/machine.json`, JSON.stringify({ schema: 1, home, claude: { exe: 'claude', config_dir: cfg, projects_dir: `${home}/.claude/projects` },
    codex: null, node: process.execPath, scheduler: { kind: 'windows-task', name: 't', interval_min: 15 }, dash: { port: 0, bind: '127.0.0.1' },
    projects: register ? [{ name: 'demo', config: '${norn}/projects/demo/project.json' }] : [] }, null, 1));
  fs.writeFileSync(`${meta}/local/budget.json`, '{}\n');
  const machine = loadMachine(`${meta}/local/machine.json`, { meta });
  const p = loadProject(pf, { home, meta });
  return { t, home, meta, cfg, machine, p };
}

test('DEC-362: policy_targets name the generator sources (agents / skills / rules), never a generated target', () => {
  const sb = sandbox();
  const srcRoot = `${sb.meta}/projects/demo/`;
  for (const f of sb.p.policy_targets.filter(f => !f.endsWith('CHECKIN.rendered.md'))) assert.ok(f.startsWith(srcRoot), f);
  assert.ok(!sb.p.policy_targets.some(f => f.includes('/.claude/')), 'no ~/.claude target');
});

test('DEC-362: an mcp policy save lands in the source AND the regenerated target; norn gen --check stays ok', () => {
  const sb = sandbox();
  assert.deepEqual(installProject(sb.p, sb.machine, { meta: sb.meta, out: () => {} }), []);
  const ctx = { profile: 'controller', project: sb.p, state: sb.p.state, env: { META_ROOT: sb.meta }, writer: 'controller', via: 'chat:test' };
  // a VALID new hand-off (no-new-step <= hand-off <= hard max) from the project's own values: a fixed 105 went invalid when the
  // owner's context trial (d5597f8, 11-06) moved the implementer to 170 / 200 / 220
  const c = sb.p.policy.context.implementer, mid = c.no_new_step_k + Math.floor((c.hard_max_k - c.no_new_step_k) / 2);
  const v = mid === c.handoff_k ? mid + 1 : mid;
  assert.ok(v >= c.no_new_step_k && v <= c.hard_max_k && v !== c.handoff_k, JSON.stringify(c));
  const r = handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'norn_settings', arguments: { set: { key: 'policy.context.implementer.handoff_k', value: v } } } }, ctx);
  assert.ok(!r.result.isError, JSON.stringify(r.result));
  const want = new RegExp(`at ~${v}k \\(even mid-wait\\)`);
  assert.match(fs.readFileSync(`${sb.meta}/projects/demo/agents/demo-implementer.md`, 'utf8'), want, 'source rewritten');
  assert.match(fs.readFileSync(`${sb.cfg}/agents/demo-implementer.md`, 'utf8'), want, 'target regenerated');
  assert.ok(r.result.structuredContent.gen.ran, 'gen ran');
  assert.deepEqual(genCheck(sb.p, sb.machine, { meta: sb.meta, out: () => {} }), []);
});

test('genAfterPolicy runs only for a project registered in this meta root\'s machine.json (else a note, nothing written)', () => {
  const sb = sandbox({ register: false });
  const g = genAfterPolicy(sb.p);
  assert.equal(g.ran, false); assert.match(g.why, /not registered/);
  assert.deepEqual(fs.readdirSync(sb.cfg), []);
  const none = genAfterPolicy({ ...sb.p, meta: fwd(path.join(sb.t, 'nowhere')) });
  assert.equal(none.ran, false); assert.match(none.why, /no machine\.json/);
});
