// META-TEND P3: the rule ledger (every must / never rule, ONE declared home, what enforces it, when it last fired), the repeat
// detector (REPORT 3.6: the same correction 2-3+ times -> one approval card with a drafted enforcement), drift (rule vs its hook /
// test / policy line; a rule pointing at code that is gone) and the ladder (REPORT 5.3 view 6) + the counts on the Instructions rows.
// Sandbox only: a fixture repo (git), a fixture home, a fixture state.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { instructionsView } from '../engine/lib/instructions.mjs';
import { repeats, onceTracked } from '../engine/lib/rules.mjs';
import { SEVERITIES, TIERS } from '../engine/lib/advisory.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { board } from '../engine/dash/widgets.mjs';
import { record } from '../engine/lib/records.mjs';

after(cleanTmp);
const w = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); return f; };
const fwd = p => p.replace(/\\/g, '/');
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', windowsHide: true });
const TRAILER = 'Never add attribution trailers to a commit message';

function fx() {
  const state = mkTmp('meta-rules-'), base = path.dirname(path.dirname(state)), repo = path.join(base, 'repo'), home = path.join(base, 'home');
  git(base, 'init', '-q', repo); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  w(path.join(repo, 'AGENTS.md'), ['# Agents',
    `- ${TRAILER}.`,                                                    // 2: prose only, also in rules/common.md (several homes), said again x3
    '- Never run `uv sync` in the main tree.',                         // 3: a deny rule enforces it
    '- You must keep `tests/lean.test.mjs` green before a merge.',     // 4: a test enforces it; CI ran it
    '- Never push to main. <!-- prose-only -->',                       // 5: prose only, by choice
    '- A hook blocks this: never edit the generated views by hand.',   // 6: says a hook, none found (drift)
    '- You must read `docs/gone.md` first.',                           // 7: points at a file that is gone (drift)
    '- You must run the slop check before a merge.',                   // 8: a Norn gate (slop) enforces it; fired at report.json
    '- Never start a long run while `${root}/.superpowers/QUIET` is on.', // 9: a runtime flag file, never tracked (path not found, low)
    ''].join('\n'));
  w(path.join(repo, 'CLAUDE.md'), '@AGENTS.md\n');
  w(path.join(repo, 'rules', 'common.md'), [`${TRAILER}, ever.`, 'SPEED MODE switches (dashboard Settings): A on, B on, C on, D on - an OFF item does not apply. <!-- policy:speed_mode -->', ''].join('\n'));
  w(path.join(repo, 'tests', 'lean.test.mjs'), '// a test\n');
  w(path.join(repo, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(uv sync:*)', 'Bash(rm -rf /:*)'] } }, null, 1));
  w(path.join(repo, 'docs', 'gone.md'), '# once here\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
  git(repo, 'rm', '-q', 'docs/gone.md'); git(repo, 'commit', '-qm', 'drop docs/gone.md');                    // once tracked, now deleted = gone
  w(path.join(state, 'ci-main.json'), JSON.stringify({ ts: 1, runs: [{ conclusion: 'success', createdAt: '2026-11-13T10:00:00Z', status: 'completed' }, { conclusion: 'failure', createdAt: '2026-11-12T10:00:00Z', status: 'completed' }] }));
  w(path.join(state, 'slop', 'report.json'), JSON.stringify({ day: '2026-11-14', at: '2026-11-14T02:02:32.422Z' }));
  const said = ['no attribution trailers on commits, I said this already', 'again: commits carry no attribution trailers', 'still seeing attribution trailers on commit messages - never add them'];
  said.forEach(t => record(state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: t, via: 'chat' } }));
  record(state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'ship the island before the beam lane', via: 'chat' } });
  const p = { name: 'kestrel', root: fwd(repo), state, project_dir: path.join(base, 'proj'), rules_read_whole: [path.join(repo, 'rules', 'common.md')], policy: { speed_mode: { A: true, B: false, C: true, D: true } } };
  return { p, repo, home, state };
}
const view = (f, o = {}) => instructionsView(f.p, { home: f.home, git: false, standing: null, ...o });

test('the rule ledger: one home per rule, its enforcement linked to the real file, when it last fired, unknown said plainly', () => {
  const f = fx(), v = view(f);
  const L = v.rules, at = s => L.rules.find(r => r.text.includes(s));
  assert.ok(L.rules.every(r => /^R-[0-9a-f]{8}$/.test(r.id) && r.home?.path && ['prose', 'repeated', 'enforced', 'retired'].includes(r.state)));
  const tr = at('attribution trailers');
  assert.equal(tr.homes.length, 2, 'the same rule in AGENTS.md and rules/common.md');
  assert.match(tr.home.path, /AGENTS\.md$/, 'the declared home is the root instruction file');
  assert.equal(tr.enforcement.kind, 'prose');
  const uv = at('uv sync');
  assert.equal(uv.enforcement.kind, 'deny');
  assert.match(uv.enforcement.path, /settings\.json$/);
  assert.equal(uv.fired, null, 'no deny log exists: unknown, never guessed');
  assert.equal(uv.state, 'enforced');
  const t = at('lean.test.mjs');
  assert.equal(t.enforcement.kind, 'test');
  assert.match(t.enforcement.path, /tests\/lean\.test\.mjs$/);
  assert.equal(t.fired.at, '2026-11-13T10:00:00Z');
  assert.match(t.fired.what, /CI/);
  const sl = at('slop check');
  assert.equal(sl.enforcement.kind, 'gate');
  assert.equal(sl.fired.at, '2026-11-14T02:02:32.422Z');
  const pm = at('Never push to main');
  assert.equal(pm.enforcement.kind, 'prose');
  assert.equal(pm.enforcement.by_choice, true);
  assert.ok(!pm.text.includes('<!--'), 'the marker is not shown');
  assert.equal(at('SPEED MODE').enforcement.kind, 'gate', 'a policy-generated line is enforced by the policy');
  assert.equal(L.counts.enforced, L.rules.filter(r => r.state === 'enforced').length);
  // every finding is one advisory record
  for (const a of v.rules.advisories) { assert.match(a.id, /^A-[0-9a-f]{10}$/); assert.equal(a.phase, 'P3'); assert.ok(SEVERITIES.includes(a.severity) && TIERS.includes(a.fix.tier)); }
  const keys = v.rules.advisories.map(a => a.key);
  assert.ok(keys.includes('rule-several-homes'), 'hole 5');
  assert.ok(v.rules.advisories.some(a => a.key === 'enforcement-unexplained' && /rm -rf/.test(a.why)), 'hole 2: a deny rule no rule line explains');
  assert.ok(!v.rules.advisories.some(a => a.key === 'enforcement-unexplained' && /uv sync/.test(a.why)));
});

test('drift: a rule that says a hook with none found, a policy line the policy contradicts, a rule pointing at a file that is gone', () => {
  const f = fx(), v = view(f), d = v.rules.advisories.filter(a => a.key.startsWith('rule-drift'));
  assert.ok(d.some(a => a.key === 'rule-drift-claim' && a.line === 6 && /hook/.test(a.why)), 'hole 3: says a hook blocks it, none exists');
  assert.ok(d.some(a => a.key === 'rule-drift-policy' && /B OFF/.test(a.fix.patch ?? a.why)), 'the line says B on, the policy says B off');
  assert.ok(d.some(a => a.key === 'rule-drift-path' && a.line === 7 && /docs\/gone\.md/.test(a.why)), 'hole 4: points at code that is gone');
});

test('hole 4 asks git history: a path once tracked and deleted is gone (medium); a path never tracked is "path not found" (low, its own key + label)', () => {
  const f = fx(), v = view(f), adv = v.rules.advisories;
  const gone = adv.find(a => a.key === 'rule-drift-path' && /docs\/gone\.md/.test(a.why));
  assert.equal(gone?.severity, 'medium', 'docs/gone.md was committed, then deleted: gone');
  assert.ok(!adv.some(a => a.key === 'rule-drift-path' && /QUIET/.test(a.why)), 'a never-tracked runtime file is not "code that is gone"');
  const nf = adv.find(a => a.key === 'rule-path-unknown' && a.line === 9);
  assert.ok(nf, 'the never-tracked path is its own kind');
  assert.equal(nf.severity, 'low', 'lower than gone: it never warns');
  assert.match(nf.why, /QUIET/);
  const html = ['role', 'file', 'growing', 'checkins', 'checks'].map(sub => renderTab('context', { ...v, sub, limit: 1000 }, {})).join('');
  assert.match(html, /path not found \(a runtime file or a typo\)/, 'its own label on the ladder');
  assert.match(html, /points at code that is gone/);
});

test('onceTracked: a file that lived only on a merged-in side branch counts (full history, not the simplified one); a never-tracked path does not', () => {
  const base = mkTmp('meta-rules-hist-'), repo = path.join(base, 'r');
  git(base, 'init', '-q', '-b', 'main', repo); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  w(path.join(repo, 'a.txt'), 'a\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'a');
  git(repo, 'switch', '-q', '-c', 'side'); w(path.join(repo, 'old', 'x.md'), 'x\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'add x');
  git(repo, 'rm', '-q', 'old/x.md'); git(repo, 'commit', '-qm', 'drop x');
  git(repo, 'switch', '-q', 'main'); git(repo, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');   // the merge is TREESAME to main
  git(repo, 'branch', '-q', '-D', 'side');                                                               // only reachable through the merge
  assert.equal(onceTracked(fwd(path.join(repo, 'old', 'x.md'))), true, 'tracked once, on the merged side');
  assert.equal(onceTracked(fwd(path.join(repo, '.superpowers', 'QUIET'))), false, 'never tracked');
});

test('the repeat detector: the same correction 3 times -> one ranked approval card with a drafted enforcement; nothing installed', () => {
  const f = fx(), before = fs.readFileSync(path.join(f.repo, '.claude', 'settings.json'), 'utf8');
  const v = view(f), cards = v.rules.cards;
  assert.equal(cards.length, 1, 'one card per cluster; the lone directive is no cluster');
  const c = cards[0];
  assert.equal(c.key, 'rule-repeated');
  assert.equal(c.items.length, 3);
  assert.match(c.why, /3 times/);
  assert.match(c.why, /AGENTS\.md/, 'written, and still broken: it names the line');
  assert.equal(c.fix.tier, 'card');
  assert.match(c.fix.patch, /co-authored-by/i, 'a commit-message rule gets a merge-gate draft');
  assert.equal(c.severity, 'medium');
  const tr = v.rules.rules.find(r => r.text.includes('attribution trailers'));
  assert.equal(tr.state, 'repeated');
  assert.equal(tr.repeats, 3);
  assert.equal(fs.readFileSync(path.join(f.repo, '.claude', 'settings.json'), 'utf8'), before, 'Norn never installs a hook by itself');
  // ranked: a bigger cluster first; unrelated texts never cluster
  const r = repeats([{ id: 'a', text: 'never sleep in the foreground of a worker shell' }, { id: 'b', text: 'again a worker used sleep in the foreground shell' },
    { id: 'c', text: 'commits carry attribution trailers again' }, { id: 'd', text: 'no attribution trailers on commits' }, { id: 'e', text: 'I said: no attribution trailers in commits' },
    { id: 'f', text: 'bake the trees once at load' }]);
  assert.deepEqual(r.map(x => x.members.map(m => m.id).sort()), [['c', 'd', 'e'], ['a', 'b']]);
});

test('retired: a rule gone from the files since the last remembered scan', () => {
  const f = fx();
  view(f, { remember: true });
  fs.writeFileSync(path.join(f.repo, 'AGENTS.md'), fs.readFileSync(path.join(f.repo, 'AGENTS.md'), 'utf8').replace(/^- Never push to main.*\n/m, ''));
  const v = view(f, { remember: true });
  const gone = v.rules.rules.find(r => r.text.includes('Never push to main'));
  assert.equal(gone.state, 'retired');
  assert.ok(gone.retired_at);
});

test('the ladder: rules as columns by state, each card home / enforcement / last fired, a click opens the source line; chips on the rows', () => {
  const f = fx(), v = view(f), html = ['role', 'file', 'growing', 'checkins', 'checks'].map(sub => renderTab('context', { ...v, sub, limit: 1000 }, {})).join('');
  assert.match(html, /id="ins-ladder"/);
  for (const col of ['prose only', 'repeated', 'enforced', 'retired']) assert.match(html, new RegExp(`class="wbcol[^"]*"[^>]*>\\s*<h4>${col}`, 'i'));
  const uv = v.rules.rules.find(r => r.text.includes('uv sync'));
  assert.match(html, new RegExp(`data-ins="${uv.home.row}" data-line="3"`));
  assert.match(html, /last fired: unknown/);
  assert.match(html, /fired 2026-11-13/);
  assert.match(html, /id="ins-repeats"[\s\S]*3 times[\s\S]*data-act="adv-approve"/);
  const agents = v.rows.find(r => /AGENTS\.md$/.test(r.path));
  assert.ok(agents.rules.total >= 7 && agents.rules.prose >= 1);
  assert.match(html, new RegExp(`id="ins-row-${agents.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]*?${agents.rules.total} rules`));
  // the one board widget
  const b = board([{ key: 'a', label: 'A', cards: ['<i>x</i>'] }, { key: 'b', label: 'B', cards: [], note: 'none' }], { id: 'bx' });
  assert.match(b, /id="bx"/);
  assert.match(b, /<h4>A <b>1<\/b><\/h4>/);
  assert.match(b, /none/);
});

test('L-19: a corrupt rules.json throws and is not written back (the retired list is kept); a missing one is the first scan', () => {
  const f = fx(), file = path.join(f.state, 'instructions', 'rules.json');
  view(f, { remember: true });
  assert.ok(fs.existsSync(file), 'a remembered scan keeps its rules');
  fs.writeFileSync(file, '{ torn');
  assert.throws(() => view(f, { remember: true }), SyntaxError);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ torn', 'never overwritten after a failed read');
});
