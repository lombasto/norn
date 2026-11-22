// META-ADOPT A1 (SPEC meta-adopt sec. 2-7): the scan, the planning-file importer, the record kind `proposal` (ADP-n, adopt.jsonl),
// the facts-only draft, decide (the sha rule), apply for the six parts, and `norn adopt`. Synthetic repos in temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { record, loadState, readEvents, recordsFile, RecordError } from '../engine/lib/records.mjs';
import { loadRoadmap } from '../engine/lib/roadmap.mjs';
import { loadProject } from '../engine/lib/config.mjs';
import { scan, importPlan, catalogueOf, AdoptError, draftFacts, proposalOf, adoptStart, adoptDecide, adoptApply, renderProposal, laneNameOf } from '../engine/lib/adopt.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const META = path.join(HERE, '..', 'engine', 'bin', 'norn.mjs');
const FIX = path.join(HERE, 'fixtures', 'adopt'), GOLD = path.join(HERE, 'golden', 'adopt');
const git = (cwd, ...a) => { const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t.test', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
/** a repo at <dir> with files { path: text } committed on main (none = an empty repo, no commit) */
function repo(dir, files = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); }
  if (Object.keys(files).length) { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init'); }
  return dir;
}
const base = () => path.dirname(path.dirname(mkTmp('meta-adopt-', 'demo')));
const CI = 'name: ci\non: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: npm test\n';
const NODE = { 'package.json': JSON.stringify({ name: 'x', scripts: { test: 'node --test', lint: 'eslint .' } }, null, 1), '.github/workflows/ci.yml': CI,
  'README.md': '# x\n', 'AGENTS.md': '# agents\nkeep it small\n', 'CONTRIBUTING.md': '# contributing\n',
  'ROADMAP.md': '# Roadmap\n\n## Sync\n- [IN PROGRESS] Offline sync (branch feat/sync)\n- [ ] Retry queue\n\n## Now\n- [ ] Export to CSV\n' };
/** a sample: the node repo + a merged branch feat/sync + a live branch feat/live; its project.json + META_ROOT = base */
function sample() {
  const b = base(), root = repo(path.join(b, 'repo'), NODE);
  git(root, 'checkout', '-q', '-b', 'feat/sync'); fs.writeFileSync(path.join(root, 'sync.js'), 'x\n'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'sync');
  git(root, 'checkout', '-q', 'main'); git(root, 'merge', '-q', '--no-ff', '-m', 'merge sync', 'feat/sync');
  git(root, 'checkout', '-q', '-b', 'feat/live'); fs.writeFileSync(path.join(root, 'live.js'), 'x\n'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'live');
  git(root, 'checkout', '-q', 'main');
  const pdir = path.join(b, 'proj'); fs.mkdirSync(path.join(pdir, 'rules'), { recursive: true });
  const file = path.join(pdir, 'project.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 1, name: 'demo', title: 'Demo', root: root.replace(/\\/g, '/'), briefs_dir: '${state}/briefs',
    lane_defaults: { worktree: '${state}/wt/${lane}', notes: '${state}/notes/${lane}/NOTES.md' } }, null, 1) + '\n');
  const load = () => loadProject(file, { meta: b });
  return { b, root, file, pdir, load, state: load().state };
}
const meta = (args, env = {}) => {
  const r = spawnSync(process.execPath, [META, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, META_ROLE: '', META_PROJECT: '', META_STATE: '', META_NO_TICK: '1', ...env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
const items = state => Object.values(loadRoadmap(state).items);

// ---------- the scan ----------
test('scan: node repo - commands from the root manifest, backed by a CI line (file:line); agent file, plans, branches; path adopt', () => {
  const s = sample(), f = scan(s.root);
  const t = f.commands.find(c => c.id === 'test');
  assert.equal(t.cmd, 'npm test'); assert.match(t.source, /package\.json scripts\.test/); assert.equal(t.ci, '.github/workflows/ci.yml:9');
  assert.equal(f.commands.find(c => c.id === 'lint').cmd, 'npm run lint');
  assert.deepEqual(f.agent_files.map(a => a.file), ['AGENTS.md']);
  assert.deepEqual(f.plans, [{ file: 'ROADMAP.md', items: 3, themes: 1 }]);
  assert.deepEqual(f.branches.map(x => [x.name, x.merged]).sort(), [['feat/live', false], ['feat/sync', true]]);
  assert.equal(f.path, 'adopt'); assert.match(f.path_why, /3 planning item\(s\) in 1 file\(s\).*1 branch\(es\) in flight/);
  assert.equal(f.default_branch, 'main'); assert.equal(f.docs.contributing, 'CONTRIBUTING.md');
});

test('scan: python, rust, a monorepo with no root manifest, an empty repo; untracked files are never read; not a repo is refused', () => {
  const b = base();
  const py = scan(repo(path.join(b, 'py'), { 'pyproject.toml': '[project]\nname = "p"\n[tool.pytest.ini_options]\n[tool.ruff]\n', 'uv.lock': '', 'tests/test_a.py': 'def test_a(): pass\n' }));
  assert.deepEqual(py.commands.map(c => [c.id, c.cmd]), [['test', 'uv run pytest'], ['lint', 'uv run ruff check .']]);
  const rs = scan(repo(path.join(b, 'rs'), { 'Cargo.toml': '[package]\nname = "r"\n', 'src/main.rs': 'fn main() {}\n' }));
  assert.equal(rs.commands.find(c => c.id === 'test').cmd, 'cargo test');
  const mono = scan(repo(path.join(b, 'mono'), { 'packages/a/package.json': '{"scripts":{"test":"jest"}}', 'packages/b/Cargo.toml': '[package]\n', 'README.md': '# m\n' }));
  assert.deepEqual(mono.commands, [], 'a sub-folder manifest is named, never guessed from');
  assert.deepEqual(mono.manifests, ['packages/a/package.json', 'packages/b/Cargo.toml']);
  const emptyDir = repo(path.join(b, 'empty'));
  fs.writeFileSync(path.join(emptyDir, 'ROADMAP.md'), '- [ ] untracked item\n');
  const e = scan(emptyDir);
  assert.equal(e.history.commits, 0); assert.equal(e.size.files, 0); assert.deepEqual(e.plans, [], 'an untracked file is never opened');
  assert.equal(e.path, 'new');
  fs.mkdirSync(path.join(b, 'plain'));
  assert.throws(() => scan(path.join(b, 'plain')), AdoptError);
});

// ---------- the planning-file importer: goldens on three shapes ----------
for (const shape of ['checklist', 'ladder', 'todo']) {
  test(`importPlan golden: ${shape}.md`, () => {
    const text = fs.readFileSync(path.join(FIX, shape + '.md'), 'utf8');
    const got = importPlan(text, { file: shape + '.md', branches: ['feat/offline-sync', 'feat/tide-cache', 'feat/storm-alerts'], docs: ['docs/design/theme.md', 'docs/map.md'] });
    const want = JSON.parse(fs.readFileSync(path.join(GOLD, shape + '.json'), 'utf8'));
    assert.deepEqual(got, want);
    for (const t of got.themes) for (const it of t.items) assert.ok(!('status' in it), 'never a typed status');
  });
}

// ---------- the legacy catalogue mode (META-ROADMAP S4, SPEC sec. 5): `norn road import --legacy` on a fixture copy ----------
const KNOWN = { ids: ['DIR-3', 'DEC-12', 'RUN-4', 'Q-2', 'DLV-1'], branches: ['feat/tide-cache', 'feat/storm-alerts', 'feat/offline-sync'],
  shas: ['abc1234f0'], docs: { 'docs/map.md': 'docs/map.md', 'spec-STORM.md': 'plans/spec-STORM.md' }, lanes: { 'feat/storm-alerts': 'storm-alerts' } };
test('catalogueOf golden: catalogue.md (numbered sections, Status-column tables only, links resolved, archive skipped)', () => {
  const text = fs.readFileSync(path.join(FIX, 'catalogue.md'), 'utf8');
  const got = catalogueOf(text, { file: 'ROADMAP.md', ...KNOWN });
  const want = JSON.parse(fs.readFileSync(path.join(GOLD, 'catalogue.json'), 'utf8'));
  assert.deepEqual(got, want);
  assert.deepEqual(got.themes.map(t => [t.title, t.items.length]), [['Now', 2], ['Maps and look', 4], ['Platform', 1]],
    'sec. 1b (no Status column), 8 (a list), 9 (bullets) and Superseded give no items; standing-rule bullets are prose');
  const [tide, storm] = got.themes[0].items, [station, offline, , old] = got.themes[1].items, watch = got.themes[2].items[0];
  assert.deepEqual([tide.title, tide.legacy.word, tide.legacy.line], ["TIDE CACHE", "SHIPPED", 14]);
  assert.deepEqual(tide.links, ['dir:DIR-3', 'run:RUN-4', 'branch:feat/tide-cache', 'sha:abc1234f0']);
  assert.deepEqual(storm.links, ['dec:DEC-12', 'branch:feat/storm-alerts', 'lane:storm-alerts', 'doc:plans/spec-STORM.md']);
  assert.deepEqual([station.title, station.legacy.word], ['Station map', "SPEC'D"]);
  assert.deepEqual([offline.legacy.word, offline.links], ['BUILT NOT WIRED', ['q:Q-2', 'dlv:DLV-1', 'branch:feat/offline-sync']]);
  assert.deepEqual(old.dropped, { why: 'legacy row: DROPPED (DEC-12: replaced by the new one)', ref: 'DEC-12' });
  assert.deepEqual([watch.legacy.word, watch.links, watch.unresolved], ['MERGED DEFAULT OFF', [], ['dir:DIR-9']], 'an unknown id is never linked; it is listed for the review');
  assert.deepEqual(got.misses, [{ line: 30, theme: 'Maps and look', why: 'no item text' }]);
  assert.equal(got.count, 7);
  for (const t of got.themes) for (const it of t.items) { assert.ok(!('status' in it), 'never a typed status'); assert.ok(!it.horizon, 'a catalogue row carries no horizon'); }
  const only = catalogueOf(text, { file: 'ROADMAP.md', sections: ['3', 'maps and look'], ...KNOWN });
  assert.deepEqual(only.themes.map(t => t.title), ['Maps and look', 'Platform'], '--sections picks by number or title');
  const one = catalogueOf('## 1. T\n| Item | Status |\n|---|---|\n| APP: offline maps (owner) | REQUESTED |\n| LAYERS = one per source - ruled | SPEC\'D |\n', {});
  assert.deepEqual(one.themes[0].items.map(i => i.title), ['APP: offline maps', 'LAYERS = one per source'], 'a one-word head keeps its next clause');
});

// ---------- the record kind ----------
test('proposal records: ADP-n in adopt.jsonl; one open per project; roles (a check-in creates + drafts, never decides / applies); loadState unchanged', () => {
  const st = mkTmp('meta-adopt-rec-', 'demo');
  const c = record(st, { kind: 'proposal', ev: 'create', by: 'checkin', data: { facts: 'adopt/ADP-1/facts.json', sha: 'a'.repeat(64), path: 'adopt', why: 'w' } });
  assert.equal(c.id, 'ADP-1'); assert.ok(fs.existsSync(path.join(st, 'adopt.jsonl'))); assert.deepEqual(loadState(st).items, {});
  assert.throws(() => record(st, { kind: 'proposal', ev: 'create', by: 'owner', data: { facts: 'f', sha: 'b'.repeat(64), path: 'adopt', why: 'w' } }), /ADP-1 is open/);
  record(st, { kind: 'proposal', ev: 'draft', id: 'ADP-1', by: 'checkin', data: { file: 'd', sha: 'c'.repeat(64), source: 'facts', parts: [{ id: 'rules', type: 'rules', lines: 1, sha: 'd'.repeat(64) }] } });
  assert.throws(() => record(st, { kind: 'proposal', ev: 'decide', id: 'ADP-1', by: 'checkin', data: { part: 'rules', verdict: 'approve', off: [], sha: 'd'.repeat(64) } }), /may not proposal decide/);
  assert.throws(() => record(st, { kind: 'proposal', ev: 'apply', id: 'ADP-1', by: 'checkin', data: { parts: [] } }), /may not proposal apply/);
  assert.throws(() => record(st, { kind: 'proposal', ev: 'decide', id: 'ADP-1', by: 'owner', data: { part: 'nope', verdict: 'approve', off: [], sha: 'd'.repeat(64) } }), /no part nope/);
  assert.throws(() => record(st, { kind: 'proposal', ev: 'decide', id: 'ADP-1', by: 'owner', data: { part: 'rules', verdict: 'maybe', off: [], sha: 'd'.repeat(64) } }), RecordError);
  record(st, { kind: 'proposal', ev: 'decide', id: 'ADP-1', by: 'owner', data: { part: 'rules', verdict: 'skip', off: [], sha: 'd'.repeat(64) } });
  record(st, { kind: 'proposal', ev: 'apply', id: 'ADP-1', by: 'owner', data: { parts: [], complete: false } });
  assert.equal(proposalOf(st).state, 'open', 'a partial apply stays open');
  record(st, { kind: 'proposal', ev: 'close', id: 'ADP-1', by: 'owner', data: { why: 'not now' } });
  assert.equal(proposalOf(st).state, 'closed');
  assert.equal(record(st, { kind: 'proposal', ev: 'create', by: 'owner', data: { facts: 'f', sha: 'e'.repeat(64), path: 'new', why: 'w' } }).id, 'ADP-2');
});

// ---------- the facts-only draft + the sha rule ----------
test('draftFacts: six parts from the facts; the profile is never decided; every line names its source', () => {
  const s = sample(), d = draftFacts(scan(s.root), {});
  assert.deepEqual(d.parts.map(p => p.id), ['profile', 'commands', 'rules', 'instructions', 'roadmap', 'first']);
  const P = id => d.parts.find(p => p.id === id);
  assert.equal(P('profile').pick, true); assert.ok(P('profile').lines.some(l => l.id === 'try-it'));
  assert.deepEqual(P('commands').lines.map(l => l.text), ['npm test', 'npm run lint']);
  assert.equal(P('roadmap').lines.length, 3);
  assert.equal(P('roadmap').lines[0].legacy.word, 'IN PROGRESS'); assert.deepEqual(P('roadmap').lines[0].links, ['branch:feat/sync']);
  assert.match(P('instructions').lines[0].text, /keep AGENTS\.md/);
  assert.equal(P('first').pick, true); assert.equal(P('first').lines[0].text, 'Export to CSV', 'a "now" item first');
  for (const p of d.parts) for (const l of p.lines) assert.ok(l.id && l.text && l.source, `${p.id} ${JSON.stringify(l)}`);
});

test('decide keeps its verdict while the part sha is unchanged; a changed part returns to "to review"; a pick part needs one line', () => {
  const s = sample(), P = s.load();
  adoptStart(s.state, { project: P, by: 'owner' });
  adoptDecide(s.state, { part: 'rules', verdict: 'approve', by: 'owner' });
  adoptDecide(s.state, { part: 'roadmap', verdict: 'approve', by: 'owner' });
  assert.throws(() => adoptDecide(s.state, { part: 'profile', verdict: 'approve', by: 'owner' }), /pick one/);
  adoptDecide(s.state, { part: 'profile', verdict: 'approve', pick: 'try-it', by: 'owner' });
  fs.appendFileSync(path.join(s.root, 'ROADMAP.md'), '- [ ] One more\n'); git(s.root, 'commit', '-qam', 'more');
  adoptStart(s.state, { project: P, by: 'owner' });   // the open proposal is re-drafted
  const p = proposalOf(s.state), st = id => p.parts.find(x => x.id === id).status;
  assert.equal(p.id, 'ADP-1'); assert.equal(st('rules'), 'approved'); assert.equal(st('profile'), 'approved'); assert.equal(st('roadmap'), 'to review');
});

// SHIP-READY R1: a stranger's `adopt show` marked all three first-task lines [x] under "(pick one)" before any pick - read as "all picked"
test('adopt show: a pick part marks no line [x] until one is picked, then only that one', () => {
  const s = sample();
  adoptStart(s.state, { project: s.load(), by: 'owner' });
  const marks = () => renderProposal(proposalOf(s.state), { part: 'first' }).filter(l => /^ {4}f\d/.test(l)).map(l => l.match(/\[(.)\]/)[1]);
  assert.equal(marks().length, 3);
  assert.deepEqual(marks().filter(m => m === 'x'), [], renderProposal(proposalOf(s.state), { part: 'first' }).join('\n'));
  adoptDecide(s.state, { part: 'first', verdict: 'approve', pick: 'f2', by: 'owner' });
  const m = marks(); assert.equal(m[1], 'x'); assert.deepEqual(m.filter(x => x === 'x').length, 1);
});

// ---------- apply ----------
test('apply: roadmap -> RM records (migration, legacy_by), RULES.md + rules_read_whole, merge.gate, profile DEC, first-task lane; the repo is untouched; a second adoption adds 0', async () => {
  const s = sample(), head = git(s.root, 'rev-parse', 'HEAD');
  adoptStart(s.state, { project: s.load(), by: 'owner' });
  for (const part of ['commands', 'rules', 'instructions', 'roadmap']) adoptDecide(s.state, { part, verdict: 'approve', by: 'owner' });
  adoptDecide(s.state, { part: 'profile', verdict: 'approve', pick: 'try-it', by: 'owner' });
  adoptDecide(s.state, { part: 'first', verdict: 'approve', pick: proposalOf(s.state).parts.find(x => x.id === 'first').lines[0].id, by: 'owner' });
  const dry = await adoptApply(s.state, { project: s.load(), by: 'owner', dryRun: true, metaRoot: s.b });
  assert.ok(dry.lines.length >= 5); assert.equal(items(s.state).length, 0, 'dry run writes nothing'); assert.ok(!fs.existsSync(path.join(s.pdir, 'rules', 'RULES.md')));
  const r = await adoptApply(s.state, { project: s.load(), by: 'owner', metaRoot: s.b });
  const its = items(s.state);
  assert.equal(its.filter(i => i.kind === 'theme').length, 1); assert.equal(its.filter(i => i.kind === 'item').length, 3);
  const sync = its.find(i => i.title === 'Offline sync');
  assert.equal(sync.by, 'migration'); assert.equal(sync.legacy.word, 'IN PROGRESS'); assert.deepEqual(sync.links.filter(l => l.startsWith('branch:')), ['branch:feat/sync']);
  const ev = readEvents(recordsFile(s.state, 'item')).find(e => e.data.title === 'Offline sync');
  assert.equal(ev.data.legacy_by, 'owner');
  const rules = fs.readFileSync(path.join(s.pdir, 'rules', 'RULES.md'), 'utf8');
  assert.match(rules, /AGENTS\.md/); assert.match(rules, /## Commands[\s\S]*npm test/);
  const pj = JSON.parse(fs.readFileSync(s.file, 'utf8'));
  assert.equal(pj.merge.gate.cmd, 'npm test'); assert.deepEqual(pj.rules_read_whole, ['${project_dir}/rules/RULES.md']);
  const decs = Object.values(loadState(s.state).items).filter(i => i.kind === 'decision');
  assert.equal(decs.length, 1); assert.equal(decs[0].data.choice, 'try-it');
  assert.ok(r.lines.some(l => /caps/.test(l)), 'the profile line says what happened to the caps');
  const lane = Object.values(loadState(s.state).items).find(i => i.kind === 'lane');
  assert.equal(lane.id, 'L:export-to-csv'); assert.ok(fs.existsSync(lane.data.worktree));
  assert.ok(its.find(i => i.title === 'Export to CSV').links.includes('lane:export-to-csv'), 'the first task links its item');
  assert.equal(proposalOf(s.state).state, 'applied');
  assert.equal(git(s.root, 'rev-parse', 'HEAD'), head); assert.equal(git(s.root, 'status', '--porcelain'), '', 'nothing written into the repo');
  // a second adoption: ADP-2, every line is already there; approving all and applying adds 0 records and keeps RULES.md
  adoptStart(s.state, { project: s.load(), by: 'owner' });
  const p2 = proposalOf(s.state);
  assert.equal(p2.id, 'ADP-2');
  assert.ok(p2.parts.find(x => x.id === 'roadmap').lines.every(l => l.already), 'roadmap lines already there');
  for (const part of ['commands', 'rules', 'instructions', 'roadmap']) adoptDecide(s.state, { part, verdict: 'approve', by: 'owner' });
  for (const part of ['profile', 'first']) adoptDecide(s.state, { part, verdict: 'skip', by: 'owner' });
  await adoptApply(s.state, { project: s.load(), by: 'owner', metaRoot: s.b });
  assert.equal(items(s.state).length, 4, '0 new roadmap records');
  assert.equal(fs.readFileSync(path.join(s.pdir, 'rules', 'RULES.md'), 'utf8'), rules, 'RULES.md is the user\'s file now');

});

test('the first-task lane name is cut at a word boundary (<= 40 chars); one over-long word is cut as it is (SHIP-READY W7)', () => {
  assert.equal(laneNameOf('Write an AGENTS.md for this repository, how to build and test'), 'write-an-agents-md-for-this-repository');
  assert.equal(laneNameOf('x'.repeat(50)), 'x'.repeat(40));
  assert.equal(laneNameOf('Short task'), 'short-task'); assert.equal(laneNameOf('!!'), 'first-task');
});
