// S3 literal-path / secret lint over tracked files (META-GENERAL-DESIGN 8): no user home path or key-shaped string is tracked.
// LEGACY = the pre-engine controller files that S4-S9 replace (they hold today's literals); the list only shrinks and is empty
// after the S9 cut-over. tests/fixtures/migration/ are anonymised copies of the live files (S2; shape byte-exact), i.e. data, not code.
// reads: **
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY = [];   // META-ONBOARD S6: the owner files left for norn-projects (their lint: norn-projects tests/)
const DATA = ['tests/fixtures/migration/'];
const BAD = [
  ['windows home path', /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s]/i],
  ['macos home path', /\/Users\/[A-Za-z0-9_.-]+/],
  ['linux home path', /\/home\/[A-Za-z0-9_.-]+/],
  ['anthropic / openai key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['github token', /\bghp_[A-Za-z0-9]{20,}/],
  ['xai key', /\bxai-[A-Za-z0-9]{20,}/],
];

export function lintText(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => { for (const [what, re] of BAD) if (re.test(line)) hits.push(`${i + 1}: ${what}`); });
  return hits;
}

test('lintText flags each pattern and passes ${...} forms', () => {
  const bs = '\\';
  assert.deepEqual(lintText(['C:' + bs + 'Users' + bs + 'bob' + bs + 'x', '"/Us' + 'ers/bob/x"', '/ho' + 'me/bob', 'k=s' + 'k-' + 'a'.repeat(24),
    'g' + 'hp_' + 'b'.repeat(24), 'x' + 'ai-' + 'c'.repeat(24)].join('\n')), ['1: windows home path', '2: macos home path', '3: linux home path',
    '4: anthropic / openai key', '5: github token', '6: xai key']);
  assert.deepEqual(lintText('"root": "${home}/dev/kestrel-mono"\ntask-META-GEN disk-usage'), []);
});

test('no tracked file outside LEGACY / migration data carries a literal home path or a key', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean);
  assert.ok(files.includes('engine/lib/records.mjs') && files.length > 20);
  const scoped = files.filter(f => !LEGACY.some(l => f === l || (l.endsWith('/') && f.startsWith(l))) && !DATA.some(d => f.startsWith(d)));
  assert.ok(scoped.includes('engine/bin/norn.mjs'));
  const hits = [];
  for (const f of scoped) {
    const p = path.join(REPO, f);
    if (!fs.existsSync(p)) continue; // deleted in the work tree, not yet committed
    const buf = fs.readFileSync(p);
    if (buf.includes(0)) continue; // binary
    for (const h of lintText(buf.toString('utf8'))) hits.push(`${f}:${h}`);
  }
  assert.deepEqual(hits, []);
});
