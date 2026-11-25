// RM-a-55 impacted-tests (lib/testimpact.mjs): pytest and cargo test discovery, the impact map over the code graph (docs/code-graph.md),
// the runner command per group and the light pick; then `norn tests index / for / run --changed` end to end on a synthetic repo through
// norn-code. Synthetic sources only, sandbox only (mkTmp).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { ensurePart } from '../engine/lib/rustbin.mjs';
import { scanPytest, scanRust, graphIndex, testGroups, pickGraph } from '../engine/lib/testimpact.mjs';
import { testsCmd } from '../engine/lib/testscli.mjs';

test.after(cleanTmp);

const PY = `import pytest
from pkg.water import flow


def helper():
    return 1


# a comment above wins when there is no docstring
@pytest.mark.parametrize("x", [1, 2])
def test_flow_runs(x):
    assert flow(x)
    s = """
def test_not_a_case():
    pass
"""


async def test_async_one():
    """Docstring first line.

    more
    """
    assert True


class TestBank:
    def test_holds(self):
        def test_inner():
            pass
        assert True

    class TestNested:
        def test_deep(self):
            pass


class Helper:
    def test_ignored(self):
        pass
`;
test('scanPytest: module tests, Test* class methods (nested too) with node ids, docstring or comment desc; a string, a helper class and an inner def are no cases', () => {
  const cs = scanPytest('tests/test_water.py', PY);
  assert.deepEqual(cs.map(c => c.id), ['tests/test_water.py::test_flow_runs', 'tests/test_water.py::test_async_one', 'tests/test_water.py::TestBank::test_holds', 'tests/test_water.py::TestBank::TestNested::test_deep']);
  const by = Object.fromEntries(cs.map(c => [c.name, c]));
  assert.deepEqual([by.test_flow_runs.line, by.test_flow_runs.lines, by.test_flow_runs.desc, by.test_flow_runs.runner], [11, 6, 'a comment above wins when there is no docstring', 'pytest']);
  assert.equal(by.test_async_one.desc, 'Docstring first line.');
  assert.deepEqual([by['TestBank::test_holds'].line, by['TestBank::test_holds'].lines], [28, 4]);
});

const RS = `use crate::flow::Flow;
// a string and a comment that look like tests: "#[test] fn fake() {}"
const S: &str = "#[test] fn fake() {}";
const R: &str = r#"#[test] fn raw() { "}" }"#;
fn takes(f: fn(u32) -> u32) -> char { let _ = f; '{' }

#[cfg(test)]
mod tests {
    use super::*;

    // the first check
    #[test]
    fn first() {
        let x = '}';
        assert_eq!(x, '}');
    }

    #[tokio::test(flavor = "current_thread")]
    async fn second<'a>() {}

    mod deeper {
        #[test]
        #[ignore]
        fn third() {}
    }

    fn not_a_test() {}
}
`;
test('scanRust: #[test] and #[<path>::test] functions named by module path + inline mods as libtest names them; strings, raw strings, chars and fn types do not confuse it', () => {
  const cs = scanRust('src/water.rs', RS, { module: 'crate::water', crate: 'pond' });
  assert.deepEqual(cs.map(c => c.name), ['water::tests::first', 'water::tests::second', 'water::tests::deeper::third']);
  assert.deepEqual([cs[0].id, cs[0].line, cs[0].lines, cs[0].desc, cs[0].runner, cs[0].crate], ['src/water.rs::water::tests::first', 12, 5, 'the first check', 'cargo', 'pond']);
  assert.deepEqual(scanRust('tests/it.rs', '#[test]\nfn top() {}\n', { module: 'crate' }).map(c => c.name), ['top'], 'a target root has no module prefix');
});

// a synthetic code graph in the reader's Graph shape (docs/code-graph.md "Shapes")
const edge = (from, to, kind) => ({ from, to, kind, how: 'exact', line: 1, col: 1, spec: to, trust: 'unmeasured' });
function graph(prefix = '') {
  const P = f => prefix + f;
  const files = new Map([
    ['py/pyproject.toml', { lang: null }], ['py/pkg/__init__.py', { lang: 'python' }], ['py/pkg/water.py', { lang: 'python' }], ['py/pkg/sky.py', { lang: 'python' }],
    ['py/pkg/lone.py', { lang: 'python' }], ['py/tests/conftest.py', { lang: 'python' }], ['py/tests/fixture_util.py', { lang: 'python' }],
    ['py/tests/test_water.py', { lang: 'python' }], ['py/tests/test_sky.py', { lang: 'python' }], ['vendor/x/test_v.py', { lang: 'python', excluded: 'vendored' }],
    ['rs/Cargo.toml', { lang: null }], ['rs/pond/Cargo.toml', { lang: null }], ['rs/pond/src/lib.rs', { lang: 'rust', crate: 'pond', module: 'crate' }],
    ['rs/pond/src/flow.rs', { lang: 'rust', crate: 'pond', module: 'crate::flow' }], ['rs/pond/src/bank.rs', { lang: 'rust', crate: 'pond', module: 'crate::bank' }],
    ['rs/pond/tests/it.rs', { lang: 'rust', crate: 'pond', module: 'crate' }], ['rs/pond/tests/common/mod.rs', { lang: 'rust', crate: 'pond', module: 'crate::common' }],
  ].map(([f, r]) => [P(f), { excluded: null, ...r }]));
  const edges = [['py/tests/test_water.py', 'py/pkg/water.py', 'import'], ['py/tests/test_water.py', 'py/pkg/__init__.py', 'package-init'], ['py/pkg/water.py', 'py/pkg/sky.py', 'import-local'],
    ['py/tests/test_sky.py', 'py/pkg/sky.py', 'import'], ['py/tests/conftest.py', 'py/tests/fixture_util.py', 'import'],
    ['rs/pond/src/lib.rs', 'rs/pond/src/flow.rs', 'mod'], ['rs/pond/src/lib.rs', 'rs/pond/src/bank.rs', 'mod'], ['rs/pond/src/bank.rs', 'rs/pond/src/flow.rs', 'use'],
    ['rs/pond/tests/it.rs', 'rs/pond/src/lib.rs', 'use'], ['rs/pond/tests/it.rs', 'rs/pond/tests/common/mod.rs', 'mod']].map(([a, b, k]) => edge(P(a), P(b), k));
  const texts = { 'py/tests/test_water.py': 'def test_a():\n    pass\n\ndef test_b():\n    pass\n', 'py/tests/test_sky.py': 'def test_c():\n    pass\n', 'vendor/x/test_v.py': 'def test_v():\n    pass\n',
    'rs/pond/src/bank.rs': 'use crate::flow;\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn holds() {}\n}\n', 'rs/pond/tests/it.rs': 'mod common;\n#[test]\nfn whole() {}\n',
    'rs/Cargo.toml': '[workspace]\nmembers = ["pond"]\n', 'rs/pond/Cargo.toml': '[package]\nname = "pond"\n' };
  const tracked = [...files.keys(), P('py/tests/__init__.py')];
  return { g: { ok: true, stamp: { commit: 'c'.repeat(40), tree: 't'.repeat(40) }, root: '/r', prefix, files, edges, unresolved: [] }, read: f => texts[f.slice(prefix.length)] ?? (files.has(f) ? '' : null), tracked };
}

test('graphIndex: the tests a source reaches through the import edges, nearest first, every row inferred; conftest.py counts, mod edges only down the test\'s own tree, vendored tests left out', () => {
  const { g, read, tracked } = graph(), ix = graphIndex(g, { read, tracked });
  assert.deepEqual(Object.keys(ix.tests).sort(), ['py/tests/test_sky.py', 'py/tests/test_water.py', 'rs/pond/src/bank.rs', 'rs/pond/tests/it.rs']);
  assert.ok(Object.values(ix.tests).every(r => r.basis === 'inferred'));
  assert.deepEqual(ix.tests['py/tests/test_water.py'], { runner: 'pytest', basis: 'inferred', dir: 'py', id: 'tests/test_water.py' }, 'pytest runs in the folder of its pyproject.toml');
  assert.deepEqual(ix.tests['rs/pond/tests/it.rs'], { runner: 'cargo', basis: 'inferred', dir: 'rs', crate: 'pond', cmd: 'cargo test -p pond --test it' }, 'cargo runs in its workspace, the target by name');
  assert.equal(ix.tests['rs/pond/src/bank.rs'].cmd, 'cargo test -p pond bank::');
  assert.deepEqual(ix.sources['py/pkg/sky.py'], ['py/tests/test_sky.py', 'py/tests/test_water.py'], 'the direct importer first, the one 2 hops away after');
  assert.deepEqual(ix.sources['py/tests/fixture_util.py'], ['py/tests/test_sky.py', 'py/tests/test_water.py'], 'what conftest.py imports reaches every test below it');
  assert.deepEqual(ix.sources['rs/pond/src/lib.rs'], ['rs/pond/tests/it.rs']);
  assert.deepEqual(ix.sources['rs/pond/tests/common/mod.rs'], ['rs/pond/tests/it.rs'], 'the test target\'s own mod tree');
  assert.deepEqual(ix.sources['rs/pond/src/flow.rs'], ['rs/pond/src/bank.rs'], 'it.rs reaches lib.rs, but lib.rs\'s mod edges are no imports of the crate');
  assert.deepEqual(ix.uncovered, ['py/pkg/lone.py']);
  assert.deepEqual([ix.cases.length, ix.files['py/tests/test_water.py'], ix.graph.commit, ix.partial], [5, { lines: 6, cases: 2 }, 'c'.repeat(40), []]);
});

test('graphIndex in a monorepo project: graph paths mapped by Graph.prefix, files outside the project left out', () => {
  const { g, read, tracked } = graph('apps/eng/'), ix = graphIndex(g, { read, tracked });
  assert.deepEqual(ix.sources['py/pkg/sky.py'], ['py/tests/test_sky.py', 'py/tests/test_water.py']);
  assert.deepEqual([ix.tests['py/tests/test_sky.py'].dir, ix.tests['rs/pond/tests/it.rs'].dir], ['py', 'rs']);
});

test('testGroups + pickGraph: one pytest command per root folder with node ids, one cargo command per target; light takes the nearest test per changed source, a .py nobody reaches is named', () => {
  const { g, read, tracked } = graph(), ix = graphIndex(g, { read, tracked });
  assert.deepEqual(testGroups(ix, ['py/tests/test_water.py', 'py/tests/test_sky.py', 'rs/pond/tests/it.rs', 'tests/x.test.mjs']), [
    { runner: 'pytest', dir: 'py', tests: ['py/tests/test_sky.py', 'py/tests/test_water.py'], cmd: 'python -m pytest tests/test_sky.py tests/test_water.py' },
    { runner: 'cargo', dir: 'rs', tests: ['rs/pond/tests/it.rs'], cmd: 'cargo test -p pond --test it' },
    { runner: 'node:test', dir: '.', tests: ['tests/x.test.mjs'], cmd: 'norn tests run tests/x.test.mjs' }]);
  assert.deepEqual(pickGraph(ix, ['py/pkg/sky.py', 'py/pkg/lone.py', 'README.md']).tests, ['py/tests/test_sky.py'], 'light: the nearest one');
  assert.deepEqual(pickGraph(ix, ['py/pkg/sky.py', 'py/pkg/lone.py']).none, ['py/pkg/lone.py']);
  assert.deepEqual(pickGraph(ix, ['py/pkg/sky.py', 'rs/pond/tests/it.rs'], { per: Infinity }).tests, ['py/tests/test_sky.py', 'py/tests/test_water.py', 'rs/pond/tests/it.rs'], 'a changed test file runs itself');
});

const built = ensurePart('code', { err: s => process.stderr.write(s + '\n') });
test('norn tests index / for / run --changed on a pytest + cargo repo: one index, the inferred tests and their runner commands', { skip: !built.ok && built.why }, () => {
  const d = mkTmp('meta-timp-'), repo = path.join(d, 'repo'), state = path.join(d, 'state'), w = (f, t) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), t); };
  w('pyproject.toml', '[project]\nname = "pond"\n'); w('pond/__init__.py', ''); w('pond/water.py', 'def flow(x):\n    return x\n'); w('pond/lone.py', 'X = 1\n');
  w('tests/test_water.py', 'from pond.water import flow\n\ndef test_flow():\n    assert flow(1) == 1\n');
  w('Cargo.toml', '[package]\nname = "bank"\nversion = "0.1.0"\nedition = "2021"\n'); w('src/lib.rs', 'pub mod vault;\n'); w('src/vault.rs', 'pub fn hold() -> u32 { 1 }\n');
  w('tests/hold.rs', 'use bank::vault::hold;\n#[test]\nfn holds() { assert_eq!(hold(), 1); }\n');
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore', windowsHide: true });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('add', '-A'); g('commit', '-q', '-m', 'base');
  const lines = [], errs = [], norn = (...a) => { lines.length = 0; errs.length = 0; return testsCmd([...a, '--repo', repo], { out: l => lines.push(l), err: l => errs.push(l), where: () => ({ state, project: null }), env: {} }); };
  assert.equal(norn('index'), 0, errs.join('\n'));
  assert.match(lines[0], /tests index: 2 test cases in 2 files;.*; by runner: 1 pytest, 1 cargo/);
  const im = JSON.parse(fs.readFileSync(path.join(state, 'tests', 'impact.json'), 'utf8'));
  assert.deepEqual([im.suite, im.sources['pond/water.py'], im.sources['src/vault.rs'], im.tests['tests/hold.rs'].basis], ['pytest + cargo', ['tests/test_water.py'], ['tests/hold.rs'], 'inferred']);
  assert.equal(im.graph.commit.length, 40);
  assert.equal(norn('for', 'pond/water.py', 'src/vault.rs'), 0, errs.join('\n'));
  assert.ok(lines.includes('pytest: python -m pytest tests/test_water.py') && lines.includes('cargo: cargo test -p bank --test hold'), lines.join('\n'));
  w('pond/water.py', 'def flow(x):\n    return x * 1\n'); g('checkout', '-q', '-b', 'lane'); g('commit', '-qam', 'change');
  assert.equal(norn('run', '--changed', '--base', 'main'), 0, errs.join('\n'));
  assert.match(lines.join('\n'), /1 test file\(s\) inferred[\s\S]*pytest: python -m pytest tests\/test_water\.py/);
});
