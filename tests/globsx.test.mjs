// RM-46 S2a (SPEC sec. 5): globsIntersect - two Scope glob sets intersect when one path can match a pattern of each. A table of pairs,
// each tested both ways round (the test is symmetric); the false rows are the near misses the claims overlap rule must let pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { globsIntersect, inScope } from '../engine/lib/ready.mjs';

const T = [
  ['a/**', 'a/b/c.js', true], ['*.md', 'docs/x.md', false], ['a/*/c', 'a/b/*', true], ['**', 'x/y/z.js', true],
  ['engine/lib', 'engine/lib/x.mjs', true], ['engine/lib/x.mjs', 'engine/lib/y.mjs', false], ['engine/lib/*.mjs', 'engine/lib/x.mjs', true],
  ['engine/lib/*.mjs', 'engine/lib/sub/x.mjs', false], ['engine/**/x.mjs', 'engine/lib/sub/x.mjs', true], ['engine/**/x.mjs', 'engine/x.mjs', true],
  ['docs/**', 'engine/**', false], ['**/*.md', 'engine/*.mjs', false], ['**/*.md', '*/README.md', true], ['a?c', 'abc', true], ['a?c', 'ac', false],
  ['a*c', 'a?c', true], ['x*.js', '*y.js', true], ['x*.js', '*y.ts', false], ['./engine/lib/', 'engine/lib/a.mjs', true],
  ['tests/fed*.test.mjs', 'tests/fed.test.mjs', true], ['tests/fed*.test.mjs', 'tests/claims.test.mjs', false],
  ['.github/workflows/**', 'engine/lib/slop/**', false], ['a/**/b', 'a/**/c', false], ['a/**/b', 'a/x/**', true], ['*', 'a/b', false],
  ['src', 'src2/x', false], ['a/b/c/**', 'a/*', false], ['a/**', 'a', true], ['eng**', 'engine/lib/x.mjs', true], ['eng**.md', 'docs/x.md', false], ['engine/x.mjs', '**/*.md', true],
  ['**/x', 'x', true], ['a/*/c', 'a/*.js', false], ['engine\\lib\\**', 'engine/lib/a.mjs', true],
];

test('globsIntersect: the pair table, both ways round', () => {
  for (const [a, b, want] of T) {
    assert.equal(globsIntersect([a], [b]), want, `${a} vs ${b}`);
    assert.equal(globsIntersect([b], [a]), want, `${b} vs ${a}`);
  }
});

test('globsIntersect: sets - any pair intersects; an empty set intersects nothing', () => {
  assert.equal(globsIntersect(['docs/**', 'engine/x.mjs'], ['tests/**', 'engine/*.mjs']), true);
  assert.equal(globsIntersect(['docs/**', 'engine/x.mjs'], ['tests/**', 'engine/lib/*.mjs']), false);
  assert.equal(globsIntersect([], ['**']), false);
});

test('globsIntersect never misses a path inScope matches (a bare path also names the folder under it, so only this direction is exact)', () => {
  const paths = ['a/b/c.js', 'docs/x.md', 'engine/lib/x.mjs', 'engine/x.mjs', 'x', 'engine/lib/sub/x.mjs', 'README.md', 'src2/x', 'a/b'];
  const globs = ['a/**', '*.md', '**/*.md', 'engine/lib', 'engine/**/x.mjs', 'engine/lib/*.mjs', '**/x', 'eng**', 'src', '*', 'a/*', 'a?b/**'];
  for (const p of paths) for (const g of globs) if (inScope(p, [g])) assert.equal(globsIntersect([g], [p]), true, `${g} vs ${p}`);
});
