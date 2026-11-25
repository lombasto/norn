// RM-a-59 (lane test-smells): T4 (a new or changed test with no assertion) and T5 (every assertion on a mock the test made) for
// node:test, pytest and Rust #[test], on the ast kind (ast-grep). Temp git repos, the rules' recorded ast-grep output (`norn slop fixtures`
// compares it with the real tool nightly).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadRules, slopCheck } from '../engine/lib/slop/check.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const put = (dir, files) => { for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); } };
/** main = base, feat/x = head (a base file absent from head is deleted) */
function repoOf({ base, head }) {
  const dir = mkTmp('meta-slop-smells-');
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'core.autocrlf', 'false');
  put(dir, base); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--allow-empty', '-m', 'base'); git(dir, 'checkout', '-q', '-b', 'feat/x');
  for (const f of Object.keys(base)) if (!(f in head)) fs.rmSync(path.join(dir, f));
  put(dir, head); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--allow-empty', '-m', 'head');
  return dir;
}
const rule = id => loadRules().find(r => r.id === id);
/** a fixture side's check with the rule's recorded ast-grep output -> its new findings as "file:line" */
function check(r, which, recorded = r.fixture[which].recorded) {
  const res = slopCheck({ repo: repoOf(r.fixture[which]), base: 'main', head: 'HEAD', rules: [r], tool: (x, side) => JSON.stringify(recorded[side] ?? []) });
  return { res, at: res.findings.filter(f => f.new).map(f => `${f.file}:${f.line}`) };
}
const lineOf = (text, s) => text.split('\n').findIndex(l => l.includes(s)) + 1;

test('T4 and T5 are ast rules on ast-grep for js, py and rs, WARN and shadow: they record, never hold', () => {
  for (const id of ['T4', 'T5']) {
    const r = rule(id);
    assert.equal(r.kind, 'ast'); assert.equal(r.tool, 'ast-grep'); assert.equal(r.level, 'WARN'); assert.equal(r.shadow, true);
    assert.deepEqual(Object.keys(r.match).sort(), ['js', 'py', 'rs']);
    const { res } = check(r, 'hit');
    assert.ok(res.findings.length > 0 && res.findings.every(f => f.shadow && f.level === 'WARN'), JSON.stringify(res.findings));
    assert.deepEqual(res.blocks, [], `${id}: a shadow WARN holds nothing`);
  }
});

test('T4 hit: a test with no assertion that calls only print / log and constructors in each language - node:test test / it / t.test, pytest functions and methods, Rust #[test] (with #[ignore])', () => {
  const r = rule('T4'), h = r.fixture.hit.head, js = h['tests/a.test.mjs'], py = h['tests/test_parse.py'], rs = h['src/parse.rs'];
  assert.deepEqual(check(r, 'hit').at.sort(), [
    `src/parse.rs:${lineOf(rs, 'fn builds_a_parser')}`, `src/parse.rs:${lineOf(rs, 'fn empty')}`,
    `tests/a.test.mjs:${lineOf(js, "'builds a parser'")}`, `tests/a.test.mjs:${lineOf(js, "t.test('sub'")}`, `tests/a.test.mjs:${lineOf(js, "it('empty'")}`,
    `tests/test_parse.py:${lineOf(py, 'def test_builds_a_parser')}`, `tests/test_parse.py:${lineOf(py, 'def test_empty')}`].sort());
  assert.ok(!check(r, 'hit').at.includes(`tests/a.test.mjs:${lineOf(js, "'parent'")}`), 'a parent whose body runs subtests is no finding: each subtest is its own');
});

test('T4 miss: an assertion (assert, t.assert, t.plan, throw, pytest.raises, self.assert*, unwrap, ?, should_panic, a named helper) or any call that can throw / panic (DEC-a-599: a helper, the code under test, a call inside println!, an import, an attribute read) is silent', () => {
  const r = rule('T4'), m = r.fixture.miss;
  assert.deepEqual(check(r, 'miss').at, []);
  // the one recorded match is the old assertion-less test, at base and head alike: an unchanged test is no new finding
  const js = m.head['tests/a.test.mjs'];
  assert.deepEqual(m.recorded.head.map(x => `${x.file}:${x.line}`), [`tests/a.test.mjs:${lineOf(js, "'old smoke'")}`]);
  assert.equal(m.recorded.base.length, 1);
  // the helpers it is silent on: a function of the file, an import from a helper module, a pytest fixture argument, a fn of the Rust test module
  for (const s of ["'local helper'", "'imported helper'"]) assert.ok(lineOf(js, s) > 0);
  for (const s of ['def test_fixture(parsed)', 'def test_local_helper', 'def test_imported_helper']) assert.ok(lineOf(m.head['tests/test_parse.py'], s) > 0);
  assert.ok(lineOf(m.head['src/parse.rs'], 'fn local_helper') > 0);
  // a test whose one check is that the code does not throw / raise / panic: the call can fail it
  assert.ok(lineOf(js, "'does not throw'") > 0 && lineOf(m.head['src/parse.rs'], 'fn does_not_panic') > 0);
  for (const s of ['def test_does_not_raise', 'def test_importable', 'def test_attribute_resolves']) assert.ok(lineOf(m.head['tests/test_parse.py'], s) > 0);
});

test('T4: a changed test that loses its assertion is new; the same match at base is not', () => {
  const r = rule('T4'), hit = { file: 'tests/a.test.mjs', ruleId: 'T4.js.0.JavaScript', line: 3, column: 1, endLine: 3, text: "test('x', () => { console.log(1); })" };
  const fx = { base: { 'tests/a.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert';\ntest('x', () => { assert.ok(f()); })\n" },
    head: { 'tests/a.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert';\ntest('x', () => { console.log(1); })\n" } };
  assert.deepEqual(check({ ...r, fixture: { x: fx } }, 'x', { head: [hit], base: [] }).at, ['tests/a.test.mjs:3']);
  const same = { base: fx.head, head: { 'tests/a.test.mjs': fx.head['tests/a.test.mjs'] + "test('y', () => { assert.ok(1); })\n" } };
  assert.deepEqual(check({ ...r, fixture: { x: same } }, 'x', { head: [hit], base: [hit] }).at, []);
});

test('T5 hit: every assertion on a mock the test made - node:test mock.fn, unittest.mock Mock, a mockall Mock<T>::new()', () => {
  const r = rule('T5'), h = r.fixture.hit.head;
  assert.deepEqual(check(r, 'hit').at.sort(), [`src/send.rs:${lineOf(h['src/send.rs'], 'fn sends_once')}`, `tests/a.test.mjs:${lineOf(h['tests/a.test.mjs'], "'sends once'")}`,
    `tests/test_send.py:${lineOf(h['tests/test_send.py'], 'def test_sends_once')}`].sort());
});

test('T5 miss: an assertion on the real result, a mock the test did not make (a decorator, a shared one), a helper it cannot see into, a mock handed to the code (an argument, put into an object or struct, assigned, its member passed) and a second mock', () => {
  const r = rule('T5');
  assert.deepEqual(check(r, 'miss').at, []);
  assert.deepEqual(r.fixture.miss.recorded, { head: [], base: [] }, 'ast-grep itself matches none of them');
  const h = r.fixture.miss.head;
  for (const s of ["'handed on'", "'put into an object'", "'assigned'", "'two mocks'"]) assert.ok(lineOf(h['tests/a.test.mjs'], s) > 0, s);
  for (const s of ['def test_assigned_into_an_object', 'def test_member_handed_on', 'def test_two_mocks']) assert.ok(lineOf(h['tests/test_send.py'], s) > 0, s);
  assert.ok(lineOf(h['src/send.rs'], 'fn put_into_a_struct') > 0);
});
