// S3 config: ${var} expansion + cycle detection + schema check (META-GENERAL-DESIGN 4.2 / 4.3).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandVars, expandLate, loadProject, loadMachine, validate, ConfigError, PROJECT_SCHEMA, MACHINE_SCHEMA } from '../engine/lib/config.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const tmp = () => mkTmp('meta-cfg-');
const H = '/hh/u', M = '/mm/meta';

test('expansion: a cycle is refused and the cycle path is named', () => {
  assert.throws(() => expandVars('${a}', { a: '${b}', b: '${c}', c: '${a}' }), e => e instanceof ConfigError && /cycle: a -> b -> c -> a/.test(e.message));
  assert.throws(() => expandVars('${s}', { s: 'x${s}' }), /cycle: s -> s/);
  assert.throws(() => expandVars('${missing}', {}), /unknown variable \$\{missing\}/);
});

const proj = (over = {}) => ({ schema: 1, name: 'demo', title: 'Demo', root: '${home}/dev/demo',
  vars: { plan: '${root}/plan', notes_root: '${dev}/notes' }, ledger: '${plan}/progress.md',
  lane_defaults: { worktree: '${dev}/demo-${lane}', notes: '${notes_root}/${lane}/NOTES.md' }, ...over });
const write = (dir, obj) => { const f = path.join(dir, 'project.json'); fs.writeFileSync(f, JSON.stringify(obj)); return f; };

test('loadProject: builtins home / meta / state / root, ${dev} defaults to the parent of root, every string expanded', () => {
  const p = loadProject(write(tmp(), proj()), { home: H, meta: M });
  assert.equal(p.root, '/hh/u/dev/demo');
  assert.equal(p.ledger, '/hh/u/dev/demo/plan/progress.md');
  assert.equal(p.vars.notes_root, '/hh/u/dev/notes');
  assert.equal(p.state, '/mm/meta/state/demo');
  assert.equal(p.lane_defaults.worktree, '/hh/u/dev/demo-${lane}');
  assert.equal(expandLate(p.lane_defaults.notes, { lane: 'gen' }), '/hh/u/dev/notes/gen/NOTES.md');
});

test('loadProject: a cycle through root and vars is refused; a var may not shadow a builtin', () => {
  assert.throws(() => loadProject(write(tmp(), proj({ root: '${dev}/demo', vars: { dev: '${root}/..' } })), { home: H, meta: M }), /cycle: (root -> dev -> root|dev -> root -> dev)/);
  assert.throws(() => loadProject(write(tmp(), proj({ vars: { home: '/x' } })), { home: H, meta: M }), /vars\.home shadows a builtin/);
});

test('schema: required, type, additionalProperties and enum are checked with the json path', () => {
  const { name, ...noName } = proj();
  assert.throws(() => loadProject(write(tmp(), noName), { home: H, meta: M }), /project\.json: \$\.name is required/);
  assert.throws(() => loadProject(write(tmp(), proj({ root: 7 })), { home: H, meta: M }), /\$\.root must be string/);
  assert.throws(() => loadProject(write(tmp(), proj({ rooot: 'x' })), { home: H, meta: M }), /\$\.rooot is not allowed/);
  assert.throws(() => loadProject(write(tmp(), proj({ schema: 2 })), { home: H, meta: M }), /\$\.schema must be one of 1/);
  assert.throws(() => loadProject(write(tmp(), proj({ docs: [{ tab: 'x' }] })), { home: H, meta: M }), /\$\.docs\[0\]\.path is required/);
  assert.deepEqual(validate({ type: 'object', properties: { a: { type: 'integer', minimum: 1 } } }, { a: 0 }), ['$.a must be >= 1']);
});

// the owner's kestrel project.json (ledger, views) is asserted in norn-projects tests/owner-config.test.mjs (META-ONBOARD S6)
test('the demo fixture project.json validates and expands with no unresolved variable but ${lane} and spawn-time ${env:*}', () => {
  const dir = path.join(REPO, 'tests', 'fixtures', 'projects', 'demo');
  const p = loadProject(path.join(dir, 'project.json'), { home: H, meta: M });
  assert.equal(p.name, 'demo');
  assert.equal(p.root, '/hh/u/dev/demo-repo');
  assert.equal(p.state, '/mm/meta/state/demo');
  assert.equal(p.install.agents, dir.replace(/\\/g, '/') + '/agents');
  assert.equal(p.install.resume_hook, '/mm/meta/state/demo/resume-hook.json');
  const left = JSON.stringify(p).match(/\$\{[^}]*\}/g) || [];
  assert.deepEqual([...new Set(left)].filter(v => !v.startsWith('${env:')), ['${lane}']);
});

test('machine.json: schema checked, ${norn} / ${home} expanded in project configs', () => {
  const d = tmp(), f = path.join(d, 'machine.json');
  const m = { schema: 1, home: H, claude: { exe: '/bin/claude', version: null, projects_dir: H + '/.claude/projects', config_dir: H + '/.claude' },
    node: '/bin/node', scheduler: { kind: 'cron', name: 'norn-tick', interval_min: 15 }, dash: { port: 8737, bind: '127.0.0.1' },
    projects: [{ name: 'demo', config: '${norn}/projects/demo/project.json' }] };
  fs.writeFileSync(f, JSON.stringify(m));
  assert.equal(loadMachine(f, { meta: M }).projects[0].config, '/mm/meta/projects/demo/project.json');
  fs.writeFileSync(f, JSON.stringify({ ...m, dash: { port: 'x', bind: '127.0.0.1' } }));
  assert.throws(() => loadMachine(f, { meta: M }), /machine\.json: \$\.dash\.port must be integer/);
  assert.equal(PROJECT_SCHEMA.properties.name.type, 'string'); assert.equal(MACHINE_SCHEMA.required.includes('claude'), true);
});

test('META-ONBOARD S3: ${project_dir} = the directory of the project.json (a builtin; a var may not shadow it)', () => {
  const d = tmp(), f = write(d, proj({ rules_read_whole: ['${project_dir}/rules/R.md'], vars: { plan: '${root}/plan', notes_root: '${dev}/notes', mine: '${project_dir}/x' }, checkin_extra: '${mine}' }));
  const p = loadProject(f, { home: H, meta: M });
  const pd = path.resolve(d).split(path.sep).join('/');
  assert.equal(p.project_dir, pd);
  assert.deepEqual(p.rules_read_whole, [pd + '/rules/R.md']); assert.equal(p.checkin_extra, pd + '/x');
  assert.throws(() => loadProject(write(tmp(), proj({ vars: { project_dir: '/x' } })), { home: H, meta: M }), /vars\.project_dir shadows a builtin/);
});

test('META-ONBOARD S3: machine.json may carry projects_home (${home} expands)', () => {
  const d = tmp(), f = path.join(d, 'machine.json');
  const m = { schema: 1, home: H, claude: { exe: '/c', version: null, config_dir: '/c', projects_dir: '/c/p' }, node: '/n',
    scheduler: { kind: 'cron', name: 'x', interval_min: 15 }, dash: { port: 1, bind: '127.0.0.1' }, projects: [], projects_home: '${home}/.norn/projects' };
  fs.writeFileSync(f, JSON.stringify(m));
  assert.equal(loadMachine(f, { home: H, meta: M }).projects_home, H + '/.norn/projects');
});

test('META-ONBOARD cut-over expand: local/compat.json maps an old project.json to its new home (loadProject follows it)', () => {
  const meta = tmp(), oldD = path.join(meta, 'projects', 'demo'), newD = path.join(tmp(), 'demo');
  fs.mkdirSync(oldD, { recursive: true }); fs.mkdirSync(newD);
  const oldF = write(oldD, proj({ rules_read_whole: ['${norn}/projects/demo/R.md'] })), newF = write(newD, proj({ rules_read_whole: ['${project_dir}/R.md'] }));
  const fw = p => path.resolve(p).split(path.sep).join('/');
  assert.equal(loadProject(oldF, { home: H, meta }).file, fw(oldF), 'no compat: the file as given');
  const c = { swap: '2026-11-11T17:00:00.000Z', runs: ['demo RUN-1'], paths: [{ from: process.platform === 'win32' ? fw(oldF).toUpperCase() : fw(oldF), to: fw(newF) }], retained: [fw(oldF)] };
  fs.mkdirSync(path.join(meta, 'local')); fs.writeFileSync(path.join(meta, 'local', 'compat.json'), JSON.stringify(c));   // case-insensitive match only on Windows
  const p = loadProject(oldF, { home: H, meta });
  assert.equal(p.file, fw(newF)); assert.equal(p.project_dir, fw(newD)); assert.deepEqual(p.rules_read_whole, [fw(newD) + '/R.md']);
  assert.equal(loadProject(newF, { home: H, meta }).file, fw(newF));
});
