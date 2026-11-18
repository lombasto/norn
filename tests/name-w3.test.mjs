// META-NAME-W3 (DEC-257): the template / config variable `meta` becomes `norn`; the old `{{meta}}` / `${meta}` keep resolving
// (a read-only alias) so an existing project.json or custom template works unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject, loadMachine, portable, ConfigError, oldNameUses } from '../engine/lib/config.mjs';
import { renderFlow, BUILTIN_VARS } from '../engine/lib/flows.mjs';
import { renderCheckin } from '../engine/lib/tick.mjs';
import { renderMergeBrief } from '../engine/lib/mergebrief.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => mkTmp('meta-namew3-');
const H = '/hh/u', M = '/mm/meta';
const proj = (root, over = {}) => ({ schema: 1, name: 'demo', title: 'Demo', root, ...over });
const write = (d, obj, n = 'project.json') => { const f = path.join(d, n); fs.writeFileSync(f, JSON.stringify(obj)); return f; };

test('project.json: ${norn} and the old ${meta} resolve the same (root, docs, state default)', () => {
  const d = tmp();
  const a = loadProject(write(d, proj('${norn}/projects/x', { docs: [{ tab: 'R', path: '${norn}/README.md' }] }), 'a.json'), { home: H, meta: M });
  const b = loadProject(write(d, proj('${meta}/projects/x', { docs: [{ tab: 'R', path: '${meta}/README.md' }] }), 'b.json'), { home: H, meta: M });
  assert.equal(a.root, '/mm/meta/projects/x'); assert.equal(b.root, a.root);
  assert.equal(a.docs[0].path, '/mm/meta/README.md'); assert.equal(b.docs[0].path, a.docs[0].path);
  assert.equal(a.state, '/mm/meta/state/demo');
  assert.throws(() => loadProject(write(d, proj('/r', { vars: { norn: 'x' } }), 'c.json'), { home: H, meta: M }), e => e instanceof ConfigError && /vars\.norn shadows a builtin/.test(e.message));
});

test('the shipped projects/example/project.json uses ${norn} and loads', () => {
  const f = path.join(REPO, 'projects', 'example', 'project.json');
  assert.deepEqual(oldNameUses(fs.readFileSync(f, 'utf8')), []);
  assert.match(fs.readFileSync(f, 'utf8'), /\$\{norn\}/);
  assert.equal(loadProject(f, { home: H, meta: M }).root, '/mm/meta/projects/example');
});

test('machine.json: ${norn} and ${meta} resolve the same; portable() stores the new name', () => {
  const d = tmp();
  const m = c => ({ schema: 1, home: H, claude: { exe: '/bin/claude', version: null, projects_dir: H + '/.claude/projects', config_dir: H + '/.claude' },
    node: '/bin/node', scheduler: { kind: 'cron', name: 'norn-tick', interval_min: 15 }, dash: { port: 8737, bind: '127.0.0.1' },
    projects: [{ name: 'demo', config: c }] });
  const n = loadMachine(write(d, m('${norn}/projects/demo/project.json'), 'n.json'), { meta: M }).projects[0].config;
  const o = loadMachine(write(d, m('${meta}/projects/demo/project.json'), 'o.json'), { meta: M }).projects[0].config;
  assert.equal(n, '/mm/meta/projects/demo/project.json'); assert.equal(o, n);
  assert.equal(portable(path.join(d, 'x', 'p.json'), { meta: d }), '${norn}/x/p.json');
});

test('oldNameUses names each old form once', () => {
  assert.deepEqual(oldNameUses('a ${norn} {{norn}}'), []);
  assert.deepEqual(oldNameUses('root ${meta}/x ${meta}/y and {{meta}} go'), ['${meta}', '{{meta}}']);
});

test('flow templates: {{norn}} is a builtin; {{meta}} still renders the same', () => {
  assert.ok(BUILTIN_VARS.includes('norn') && BUILTIN_VARS.includes('meta'));
  const f = { name: 'demo', title: 'x {{norn}} | {{meta}}', vars: {}, steps: [], order: [] };
  assert.equal(renderFlow(f, {}, { norn: 'node "/n/norn.mjs"' }).title, 'x node "/n/norn.mjs" | node "/n/norn.mjs"');
});

test('check-in pack: {{norn}} and {{meta}} in a custom checkin_extra render the same command', () => {
  const d = tmp(), extra = path.join(d, 'extra.md');
  fs.writeFileSync(extra, 'A {{norn}} status\nB {{meta}} status\n');
  const txt = fs.readFileSync(renderCheckin({ name: 'demo', root: d, state: path.join(d, 'st'), checkin_extra: extra }, { budgetFile: path.join(d, 'b.json') }), 'utf8');
  const a = txt.match(/^A (.*) status$/m)[1], b = txt.match(/^B (.*) status$/m)[1];
  assert.match(a, /^node ".*\/engine\/bin\/norn\.mjs"$/); assert.equal(b, a);
});

test('merge brief: the shipped MERGE templates render with no placeholder left', () => {
  const P = { name: 'norn', root: '/h/dev/x', meta: '/h/dev/x', state: '/h/state/norn', deliverables: { main: 'main' }, policy: {} };
  const O = { lane: 'l', branch: 'feat/l', worktree: '/h/dev/x-l', notes: '/h/r/l/NOTES.md' };
  for (const t of [renderMergeBrief(P, O), renderMergeBrief(P, { ...O, sha: 'abcdef1' })]) {
    assert.doesNotMatch(t, /\{\{\w+\}\}/); assert.match(t, /node "\/h\/dev\/x\/engine\/bin\/norn\.mjs"/);
  }
});

test('every shipped template, prompt and doc uses {{norn}} / ${norn}, never the old name', () => {
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!['node_modules', '.git', 'state', 'local'].includes(e.name)) walk(p); } else if (/\.(md|txt|json)$/.test(e.name)) files.push(p); } };
  for (const d of ['engine', 'projects', 'docs']) if (fs.existsSync(path.join(REPO, d))) walk(path.join(REPO, d));
  for (const f of fs.readdirSync(REPO)) if (/\.md$/.test(f)) files.push(path.join(REPO, f));
  const hits = files.filter(f => oldNameUses(fs.readFileSync(f, 'utf8')).length).map(f => path.relative(REPO, f));
  assert.deepEqual(hits, []);
});
