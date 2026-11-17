// A monorepo project (subdir): the steering-file scan keeps to its own folder - the files from the repo root down to the subdir load
// every session (its runs work there), files nested under it load on demand, and the repo's other folders (other projects) are left
// out (their CLAUDE.md was scanned, flagged and sent to the fixer as this project's). Norn's own prompts are marked as Norn's.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { discover } from '../engine/lib/instructions.mjs';
import { guardRows } from '../engine/lib/guardview.mjs';

after(cleanTmp);
const put = (f, t = '# x\n') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };

test('subdir project: root + the folders down to the subdir every session, nested on demand, other folders left out', () => {
  const root = mkTmp('mono-'), state = mkTmp('mono-state-'), home = mkTmp('mono-home-');
  for (const f of ['CLAUDE.md', 'apps/CLAUDE.md', 'apps/shack/CLAUDE.md', 'apps/shack/ui/CLAUDE.md', 'apps/other/CLAUDE.md', 'tools/CLAUDE.md']) put(path.join(root, f));
  const rel = r => path.relative(root, r.path).replace(/\\/g, '/');
  const rows = discover({ name: 'shack', root, subdir: 'apps/shack', state }, { home, git: false }).filter(r => r.kind === 'repo');
  const by = Object.fromEntries(rows.map(r => [rel(r), r.load]));
  assert.deepEqual(by, { 'CLAUDE.md': 'session', 'apps/CLAUDE.md': 'session', 'apps/shack/CLAUDE.md': 'session', 'apps/shack/ui/CLAUDE.md': 'on-demand' });
  // without a subdir the whole repo is the project, as before
  const all = discover({ name: 'mono', root, state }, { home, git: false }).filter(r => r.kind === 'repo').map(rel).sort();
  assert.deepEqual(all, ['CLAUDE.md', 'apps/CLAUDE.md', 'apps/other/CLAUDE.md', 'apps/shack/CLAUDE.md', 'apps/shack/ui/CLAUDE.md', 'tools/CLAUDE.md']);
});

test("Norn's own prompts are marked norn_file and a finding on one is never ticked by a project's Fix all", () => {
  const root = mkTmp('mono2-'), state = mkTmp('mono2-state-'), home = mkTmp('mono2-home-');
  const rows = discover({ name: 'p', root, state }, { home, git: false });
  const ck = rows.find(r => r.name === 'CHECKIN.md');
  assert.ok(ck?.norn_file, 'the check-in prompt is Norn\'s');
  const g = guardRows({ ins: { rows, findings: [{ id: 'A-1', key: 'instr-c16', check: 16, severity: 'medium', surface: 's', path: ck.path, line: 3, why: 'w', source: 's', fix: { action: 'a', kind: 'drafts' } }] } });
  assert.equal(g.find(r => r.id === 'A-1').owner_file, true);
});
