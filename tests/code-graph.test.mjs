// code-graph S1b (SPEC code-graph 7.1-7.3, the contract docs/code-graph.md): the one reader engine/lib/codegraph.mjs over the
// synthetic fixtures tests/fixtures/code-graph/{js,py,rs}, each committed into a fresh repo with its own store: the stamp, the walks
// (dependencies / dependents / reach), cycles over LOAD_KINDS, fans, excluded, the { ok: false, why } answers, --no-index, and the
// `norn code graph` verbs' exit codes and --json shapes. S2: symbols() / references() and the symbols / refs verbs. S3: callers() and the callers verb.
// S5: symbols({ files }) and defsByHash(), the symbols <file>... and hash verbs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkTmp } from './helpers/tmp.mjs';
import { ensurePart } from '../engine/lib/rustbin.mjs';
import { graphAt, dependencies, dependents, cycles, reach, fans, excluded, symbols, defsByHash, references, callers, ALL_KINDS, CALL_HOWS, TRUST } from '../engine/lib/codegraph.mjs';
import { codeCmd } from '../engine/lib/codecli.mjs';

const FIX = path.join(import.meta.dirname, 'fixtures', 'code-graph');
const built = ensurePart('code', { err: s => process.stderr.write(s + '\n') });
const git = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
/** a fixture (or files) committed into its own repo -> { repo, state } */
function repoOf(lang, files = null) {
  const d = mkTmp(`cg1b-${lang}-`), repo = path.join(d, 'repo');
  if (files) for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), t); }
  else { fs.cpSync(path.join(FIX, lang), repo, { recursive: true }); fs.rmSync(path.join(repo, 'expected.json')); }
  git(repo, 'init', '-q'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'fixture');
  return { repo, state: path.join(d, 'state') };
}
const files = rows => rows.map(r => r.file);
const run = (argv, state) => { const o = [], e = []; const code = codeCmd(['graph', ...argv, '--state', state], { out: s => o.push(s), err: s => e.push(s), where: f => ({ project: null, state: f.state }) }); return { code, out: o.join('\n'), err: e.join('\n') }; };

test('norn-code is built (every test below reads its snapshots)', () => assert.ok(built.ok, built.why));

test('graphAt: a Graph of the commit asked, its stamp exact; typed files, each edge its class\'s trust; a second call reads the store', () => {
  const r = repoOf('js'), head = git(r.repo, 'rev-parse', 'HEAD'), g = graphAt({ state: r.state, repo: r.repo });
  assert.equal(g.ok, true, g.why);
  assert.deepEqual(Object.keys(g.stamp).sort(), ['age_s', 'asked', 'commit', 'exact', 'indexed_at', 'tree', 'worktree']);
  assert.equal(g.stamp.commit, head); assert.equal(g.stamp.tree, git(r.repo, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(g.stamp.exact, true); assert.equal(g.stamp.asked, 'HEAD'); assert.equal(g.stamp.worktree, false);
  assert.equal(g.prefix, ''); assert.ok(g.indexed && g.indexed.parsed > 0);
  assert.equal(g.files.get('src/b.ts').lang, 'typescript'); assert.equal(g.files.get('src/a.mjs').lang, 'javascript');
  assert.equal(g.files.get('src/vendored.js').excluded, 'vendored'); assert.equal(g.files.get('src/gen.js').excluded, 'generated');
  assert.ok(g.edges.every(e => e.trust === TRUST[`${g.files.get(e.from).lang}/file/${e.how}`]));
  assert.equal(g.edges.find(e => e.from === 'src/main.mjs' && e.to === 'src/a.mjs').trust, 1);   // S4a: measured
  assert.equal(TRUST['javascript/file/name'], 'unmeasured'); assert.ok(Object.values(TRUST).every(t => t === 'unmeasured' || t === 'below bar' || (t >= 0 && t <= 1)));
  const again = graphAt({ state: r.state, repo: r.repo });
  assert.equal(again.indexed, null); assert.equal(again.edges.length, g.edges.length);
  assert.equal(graphAt({ state: r.state, repo: path.join(r.repo, 'src') }).prefix, 'src/');
});

test('dependencies / dependents: depth 1 and 2, each file once at its least depth, the edge it came by', () => {
  const r = repoOf('js'), g = graphAt({ state: r.state, repo: r.repo });
  const d1 = dependencies(g, 'src/main.mjs');
  assert.equal(d1.stamp, g.stamp); assert.equal(d1.file, 'src/main.mjs'); assert.equal(d1.truncated, 0);
  assert.ok(files(d1.rows).includes('src/a.mjs') && files(d1.rows).includes('src/b.ts') && !files(d1.rows).includes('src/types.ts'));
  assert.ok(d1.rows.every(x => x.depth === 1 && x.via.from === 'src/main.mjs'));
  const d2 = dependencies(g, 'src/main.mjs', { depth: 2 }), types = d2.rows.find(x => x.file === 'src/types.ts');
  assert.equal(types.depth, 2); assert.equal(types.via.kind, 'type'); assert.equal(types.via.from, 'src/b.ts');
  assert.deepEqual(files(dependencies(g, 'src/main.mjs', { kinds: ['dynamic'] }).rows), ['src/lazy.js']);
  assert.deepEqual(files(dependents(g, 'src/a.mjs').rows).sort(), ['src/legacy.cjs', 'src/main.mjs']);
  assert.deepEqual(files(dependents(g, 'src/types.ts', { depth: 2 }).rows), ['src/b.ts', 'src/main.mjs']);
});

test('reach: reverse (what depends on the files) by default, forward on ask, `to` keeps the rows matching its globs; each row has its path', () => {
  const r = repoOf('py'), g = graphAt({ state: r.state, repo: r.repo });
  const back = reach(g, ['src/fx/helpers.py']);
  assert.deepEqual(back.rows.map(x => [x.file, x.depth]), [['src/fx/core.py', 1], ['tests/test_core.py', 2]]);
  assert.deepEqual(back.rows[1].path, ['src/fx/helpers.py', 'src/fx/core.py', 'tests/test_core.py']);
  assert.deepEqual(files(reach(g, ['src/fx/helpers.py'], { to: ['tests/**'] }).rows), ['tests/test_core.py']);
  assert.ok(files(reach(g, ['tests/test_core.py'], { reverse: false }).rows).includes('src/fx/helpers.py'));
});

test('cycles: a two-file import cycle; a Rust `use` back to the crate root is none under LOAD_KINDS, one over every kind; `within` narrows', () => {
  const js = repoOf('cyc', { 'src/a.mjs': "import './b.mjs';\n", 'src/b.mjs': "import './a.mjs';\n", 'lib/c.mjs': "import '../src/a.mjs';\n" });
  const g = graphAt({ state: js.state, repo: js.repo });
  assert.deepEqual(cycles(g).cycles, [['src/a.mjs', 'src/b.mjs']]);
  assert.deepEqual(cycles(g, { within: ['lib/**'] }).cycles, []);
  const rs = repoOf('rs'), gr = graphAt({ state: rs.state, repo: rs.repo });
  assert.deepEqual(cycles(gr).cycles, []);
  assert.ok(cycles(gr, { kinds: ALL_KINDS }).cycles.some(c => c.includes('crates/app/src/main.rs') && c.includes('crates/app/src/cli.rs')));
});

test('fans: distinct importers and imports per file (package-init left out); excluded() names the rule', () => {
  const r = repoOf('py'), g = graphAt({ state: r.state, repo: r.repo }), f = fans(g);
  assert.equal(f.get('src/fx/models.py').in, 1);   // import and import-local from core.py: one importer
  assert.equal(f.get('src/fx/core.py').in, 1);
  assert.equal(f.get('src/fx/__init__.py').in, 0);   // only package-init edges reach it
  const js = repoOf('js'), gj = graphAt({ state: js.state, repo: js.repo });
  assert.equal(excluded(gj, 'src/vendored.js'), 'linguist-vendored'); assert.equal(excluded(gj, 'src/a.mjs'), null);
});

test('n/a answers: unknown file, unknown rev, no repo; --no-index on an unindexed commit answers the store\'s newest with exact false', () => {
  const r = repoOf('js'), g = graphAt({ state: r.state, repo: r.repo });
  assert.equal(dependencies(g, 'src/nope.mjs').ok, false); assert.match(reach(g, ['nope']).why, /unknown file nope/);
  assert.match(graphAt({ state: r.state, repo: r.repo, at: 'no-such-rev' }).why, /unknown rev no-such-rev/);
  assert.equal(graphAt({}).ok, false);
  fs.appendFileSync(path.join(r.repo, 'src', 'a.mjs'), '\n// more\n'); git(r.repo, 'commit', '-qam', 'two');
  const old = graphAt({ state: r.state, repo: r.repo, noIndex: true });
  assert.equal(old.ok, true, old.why); assert.equal(old.stamp.exact, false); assert.equal(old.stamp.commit, git(r.repo, 'rev-parse', 'HEAD~1'));
  const fresh = repoOf('js');
  assert.match(graphAt({ state: fresh.state, repo: fresh.repo, noIndex: true }).why, /not indexed/);
});

test('norn code graph: exit 0 with the --json shapes, 2 on usage, 3 n/a with { ok: false, why }', () => {
  const r = repoOf('js'), at = ['--repo', r.repo, '--json'];
  const ix = run(['index', ...at], r.state);
  assert.equal(ix.code, 0, ix.err); assert.deepEqual(Object.keys(JSON.parse(ix.out)).sort(), ['edges', 'files', 'ms', 'parsed', 'reused', 'stamp', 'unresolved']);
  const d = run(['deps', 'src/main.mjs', '--depth', '2', ...at], r.state), dj = JSON.parse(d.out);
  assert.equal(d.code, 0); assert.deepEqual(Object.keys(dj).sort(), ['file', 'rows', 'stamp', 'truncated']); assert.ok(dj.rows.some(x => x.file === 'src/types.ts'));
  assert.equal(run(['dependents', 'src/a.mjs', ...at], r.state).code, 0);
  assert.deepEqual(JSON.parse(run(['cycles', ...at], r.state).out).cycles, []);
  assert.equal(JSON.parse(run(['reach', 'src/types.ts', '--to', 'src/main.mjs', ...at], r.state).out).rows[0].file, 'src/main.mjs');
  const text = run(['deps', 'src/main.mjs', '--repo', r.repo], r.state);
  assert.equal(text.code, 0); assert.match(text.out.split('\n')[0], /^at [0-9a-f]{12} \(.+\), exact$/);
  const na = run(['deps', 'src/nope.mjs', ...at], r.state);
  assert.equal(na.code, 3); assert.equal(JSON.parse(na.out).ok, false);
  assert.equal(run(['deps', ...at], r.state).code, 2); assert.equal(run(['nope', ...at], r.state).code, 2);
  assert.equal(run(['deps', 'src/main.mjs', '--kinds', 'bogus', ...at], r.state).code, 2);
});

test('symbols / references (S2): the stamp and the defs of a file; refs through the name index, unique when one def has the name; n/a', () => {
  const r = repoOf('py'), s = symbols({ state: r.state, repo: r.repo, file: 'src/fx/models.py' });
  assert.equal(s.stamp.commit, git(r.repo, 'rev-parse', 'HEAD')); assert.equal(s.stamp.exact, true); assert.equal(s.file, 'src/fx/models.py');
  assert.deepEqual(s.defs.map(d => [d.qual, d.kind, d.line, d.end_line, d.exported]), [['fx.models.Model', 'class', 1, 1, true]]);
  const x = references({ state: r.state, repo: r.repo, name: 'Model' });
  assert.deepEqual(x.defs.map(d => d.id), ['src/fx/models.py#fx.models.Model#0']); assert.equal(x.truncated, 0);
  assert.deepEqual(x.rows.map(o => [o.file, o.line, o.col, o.how, o.def_ids]), [['src/fx/core.py', 3, 21, 'unique', ['src/fx/models.py#fx.models.Model#0']], ['src/fx/core.py', 12, 27, 'unique', ['src/fx/models.py#fx.models.Model#0']]]);
  assert.match(symbols({ state: r.state, repo: r.repo, file: 'nope.py' }).why, /unknown file nope\.py/);
  assert.match(references({ state: r.state, repo: r.repo, name: 'nosuch' }).why, /no definition in the tree is named nosuch/);
  assert.equal(symbols({ state: r.state, repo: r.repo }).ok, false); assert.equal(references({ state: r.state, repo: r.repo }).ok, false);
});

test('norn code graph symbols / refs: the --json shapes, the text lines with bounds, 2 on usage, 3 n/a', () => {
  const r = repoOf('py'), at = ['--repo', r.repo, '--json'];
  const s = run(['symbols', 'src/fx/core.py', ...at], r.state), sj = JSON.parse(s.out);
  assert.equal(s.code, 0, s.err); assert.deepEqual(Object.keys(sj).sort(), ['defs', 'file', 'stamp']);
  assert.deepEqual(Object.keys(sj.defs[0]).sort(), ['col', 'end_line', 'exported', 'file', 'hash', 'id', 'kind', 'line', 'name', 'qual', 'tokens']);
  const x = run(['refs', 'Model', ...at], r.state), xj = JSON.parse(x.out);
  assert.equal(x.code, 0, x.err); assert.deepEqual(Object.keys(xj).sort(), ['defs', 'name', 'rows', 'stamp', 'truncated']);
  assert.deepEqual(Object.keys(xj.rows[0]).sort(), ['col', 'def_ids', 'file', 'how', 'line', 'name']);
  const text = run(['symbols', 'src/fx/core.py', '--repo', r.repo], r.state);
  assert.equal(text.code, 0); assert.match(text.out, /^function +fx\.core\.later {2}src\/fx\/core\.py:15\.\.17 {2}exported$/m);
  assert.equal(run(['refs', ...at], r.state).code, 2); assert.equal(run(['symbols', 'src/fx/core.py', '--no-index', ...at], r.state).code, 2);
  assert.equal(run(['refs', 'nosuch', ...at], r.state).code, 3);
});

const COPIES = { 'pkg/a.py': 'def twice(x):\n    return x * 2 + 1\n', 'pkg/b.py': 'def double(x):\n    # the same body\n    return x * 2 + 1\n\ndef other(x):\n    return x * 3\n',
  'vendor/v.py': 'def twice(x):\n    return x * 2 + 1\n' };
test('symbols({ files }) / defsByHash (S5): many files in one run, each its defs or its own n/a; defs by body hash over first-party sources only', () => {
  const r = repoOf('copies', COPIES), o = { state: r.state, repo: r.repo };
  const m = symbols({ ...o, files: ['pkg/a.py', 'pkg/b.py', 'nope.py', 'vendor/v.py'] });
  assert.equal(m.stamp.commit, git(r.repo, 'rev-parse', 'HEAD')); assert.deepEqual(Object.keys(m.files).sort(), ['nope.py', 'pkg/a.py', 'pkg/b.py', 'vendor/v.py']);
  assert.deepEqual(m.files['pkg/b.py'].defs.map(d => d.name), ['double', 'other']); assert.deepEqual(m.files['pkg/a.py'].defs, symbols({ ...o, file: 'pkg/a.py' }).defs);
  assert.match(m.files['nope.py'].why, /unknown file nope\.py/); assert.equal(m.files['nope.py'].ok, false); assert.match(m.files['vendor/v.py'].why, /excluded/);
  const h = m.files['pkg/a.py'].defs[0].hash;
  assert.equal(h, m.files['pkg/b.py'].defs[0].hash); assert.notEqual(h, m.files['pkg/b.py'].defs[1].hash);
  const x = defsByHash({ ...o, hashes: [h, '0000000000000000'] });
  assert.equal(x.stamp.exact, true); assert.equal(x.truncated, 0);
  assert.deepEqual(x.defs[h].map(d => [d.file, d.name]), [['pkg/a.py', 'twice'], ['pkg/b.py', 'double']]); assert.deepEqual(x.defs['0000000000000000'], []);
  assert.equal(symbols({ ...o, file: 'pkg/a.py', files: ['pkg/b.py'] }).ok, false); assert.equal(symbols({ ...o, files: [] }).ok, false); assert.equal(defsByHash(o).ok, false);
});

test('norn code graph symbols <file>... / hash <hash>...: the --json shapes, the text lines, 2 on usage', () => {
  const r = repoOf('copies', COPIES), at = ['--repo', r.repo, '--json'];
  const s = run(['symbols', 'pkg/a.py', 'pkg/b.py', ...at], r.state), sj = JSON.parse(s.out);
  assert.equal(s.code, 0, s.err); assert.deepEqual(Object.keys(sj).sort(), ['files', 'stamp']);
  const h = sj.files['pkg/a.py'].defs[0].hash, x = run(['hash', h, ...at], r.state), xj = JSON.parse(x.out);
  assert.equal(x.code, 0, x.err); assert.deepEqual(Object.keys(xj).sort(), ['defs', 'stamp', 'truncated']); assert.equal(xj.defs[h].length, 2);
  const text = run(['hash', h, '--repo', r.repo], r.state);
  assert.equal(text.code, 0); assert.match(text.out, new RegExp(`^${h}$`, 'm')); assert.match(text.out, /^ {2}function +\S+ {2}pkg\/b\.py:1\.\.3/m);
  assert.match(run(['symbols', 'pkg/a.py', 'nope.py', '--repo', r.repo], r.state).out, /^nope\.py {2}n\/a: unknown file/m);
  assert.equal(run(['hash', ...at], r.state).code, 2); assert.equal(run(['hash', h, '--no-index', ...at], r.state).code, 2);
});

const AREA = 'src/shapes.mjs#src/shapes.mjs#Shape.area#0';
test('callers (S3): each call site whose candidates hold the def, with its how; an ambiguous one keeps its count and list; depth walks on', () => {
  const r = repoOf('js'), c = callers({ state: r.state, repo: r.repo, symbol: AREA });
  assert.equal(c.stamp.exact, true); assert.equal(c.symbol.id, AREA); assert.equal(c.truncated, 0);
  assert.deepEqual(c.rows.map(x => [x.file, x.line, x.col, x.how, x.candidates, x.caller?.qual ?? null, x.depth, x.trust]), [
    ['src/calls.mjs', 16, 17, 'self', 1, 'src/calls.mjs#Walker.walk', 1, 1],
    ['src/calls.mjs', 25, 5, 'ambiguous', 2, 'src/calls.mjs#main', 1, 'unmeasured']]);
  assert.deepEqual(c.rows[1].targets, [AREA, 'src/shapes.mjs#src/shapes.mjs#Square.area#0']);
  const d2 = callers({ state: r.state, repo: r.repo, symbol: AREA, depth: 2 });
  assert.deepEqual(d2.rows.slice(2).map(x => [x.line, x.name, x.how, x.depth]), [[24, 'walk', 'method-unique', 2], [30, 'walk', 'method-unique', 2]]);
  assert.deepEqual(callers({ state: r.state, repo: r.repo, symbol: 'src/shapes.mjs:helper' }).rows.map(x => [x.line, x.how]), [[21, 'import']]);
  assert.match(callers({ state: r.state, repo: r.repo, symbol: 'src/shapes.mjs:area' }).why, /defines 2 named area; name one by id/);
  assert.match(callers({ state: r.state, repo: r.repo, symbol: 'src/nope.mjs#x#0' }).why, /no definition has the id/);
  assert.equal(callers({ state: r.state, repo: r.repo }).ok, false);
  assert.equal(TRUST['javascript/call/method-unique'], 'below bar'); assert.deepEqual(CALL_HOWS.filter(h => TRUST[`python/call/${h}`] === 'unmeasured'), ['ambiguous', 'external', 'unresolved']);
});

test('norn code graph callers: the --json shape, the text line with its how, 2 on usage, 3 n/a', () => {
  const r = repoOf('js'), at = ['--repo', r.repo, '--json'];
  const j = run(['callers', AREA, ...at], r.state), o = JSON.parse(j.out);
  assert.equal(j.code, 0, j.err); assert.deepEqual(Object.keys(o).sort(), ['rows', 'stamp', 'symbol', 'truncated']);
  assert.deepEqual(Object.keys(o.rows[0]).sort(), ['caller', 'candidates', 'col', 'depth', 'file', 'how', 'line', 'name', 'targets', 'trust']);
  const text = run(['callers', AREA, '--repo', r.repo], r.state);
  assert.equal(text.code, 0); assert.match(text.out, /^ {2}1 {2}src\/calls\.mjs:25:5 {2}ambiguous of 2: .*Square\.area#0 {2}in src\/calls\.mjs#main$/m);
  assert.equal(run(['callers', ...at], r.state).code, 2); assert.equal(run(['callers', AREA, '--no-index', ...at], r.state).code, 2);
  assert.equal(run(['callers', 'src/shapes.mjs:area', ...at], r.state).code, 3);
});
