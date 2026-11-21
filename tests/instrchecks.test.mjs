// META-PRACTICE-P1: instructions coverage (memory folder, CLAUDE.local.md, .claude/rules, imports), the free static checks 1-19 +
// 21-23 (REPORT sec. 3.2; no model call), the per-role "memory off" launch key, and the Instructions tab's findings + summary.
// Sandbox only: a fixture repo (git), a fixture home with a fixture memory folder, a fixture state.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { discover, matches, instructionsView, sessionsOn, harnessRows } from '../engine/lib/instructions.mjs';
import { staticChecks, CHECKS, memoryDir } from '../engine/lib/instrchecks.mjs';
import { memoryOf, MEMORY_DEFAULT, memoryEnv } from '../engine/lib/launchpolicy.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { MORE } from '../engine/dash/shell.mjs';
import { record } from '../engine/lib/records.mjs';
import { TIERS } from '../engine/lib/advisory.mjs';

after(cleanTmp);
const w = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); return f; };
const fwd = p => p.replace(/\\/g, '/');
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', windowsHide: true });
const RULE = 'every lane writes only its own notes file and ends it with exactly one end marker';

function fx({ claudeOnly = false } = {}) {
  const state = mkTmp('meta-ichk-'), base = path.dirname(path.dirname(state)), repo = path.join(base, 'repo'), home = path.join(base, 'home');
  git(base, 'init', '-q', repo); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  if (claudeOnly) w(path.join(repo, 'CLAUDE.md'), '# Claude only\nRun the tests.\n');
  else {
    w(path.join(repo, 'CLAUDE.md'), '@AGENTS.md\n@docs/i1.md\n@missing.md\nClaude-only line.\n');
    w(path.join(repo, 'AGENTS.md'), ['# Agents', 'Never push to main.', 'You MUST test. NEVER skip. ALWAYS lint. CRITICAL: MUST stop.',
      'Think step by step before you answer.', 'On 2026-01-02 the tool was renamed.', 'Work only in lane old-lane-7.', 'Use claude-3-opus for reviews.',
      'See `rules/OLD.md` for the rules.', `Rule: ${RULE}.`, ''].join('\n'));
    w(path.join(repo, 'rules', 'OLD.md'), 'Moved: rules/NEW.md\n');
    w(path.join(repo, 'rules', 'NEW.md'), '# New\n');
    for (let i = 1; i <= 5; i++) w(path.join(repo, 'docs', `i${i}.md`), `# i${i}\n@${i < 5 ? `i${i + 1}` : 'i1'}.md\n`);   // a 5-hop chain + a cycle
    w(path.join(repo, 'sub', 'AGENTS.md'), '# sub\n' + 'x'.repeat(33 * 1024) + '\n');
    w(path.join(repo, 'sub', 'CLAUDE.md'), '# sub claude\nTwin.\n');
    w(path.join(repo, '.claude', 'rules', 'bad.md'), '---\npaths: [unclosed\n---\nBad.\n');
    w(path.join(repo, '.claude', 'rules', 'always.md'), 'No frontmatter.\n');
    w(path.join(repo, '.claude', 'rules', 'zero.md'), '---\npaths:\n  - "nomatch/**/*.zz"\n---\nZero.\n');
    w(path.join(repo, '.claude', 'rules', 'ok.md'), '---\npaths:\n  - "docs/**/*.md"\n---\nDocs rule.\n');
    w(path.join(repo, '.claude', 'agents', 'rev.md'), '---\nname: rev\ndescription: reviews\nmodel: sonnet\neffort: low\n---\nReview.\n');
    w(path.join(repo, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node hooks/gone.mjs' }] }],
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'prompt', prompt: 'SECRET-VALUE' }] }] } }, null, 1));
  }
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
  if (!claudeOnly) { git(repo, 'worktree', 'add', '-q', path.join(base, 'wt'), '-b', 'wt'); w(path.join(repo, 'CLAUDE.local.md'), '# mine\n'); }   // in 1 of 2 worktrees
  const mem = path.join(home, '.claude', 'projects', fwd(repo).replace(/[^A-Za-z0-9]/g, '-'), 'memory');
  if (!claudeOnly) {
    w(path.join(mem, 'MEMORY.md'), ['## Rules', '- [ok](ok.md) — a pointer', '- [gone](gone.md) — missing', '- [Norn resumed 11-11](norn-paused-2026-11-09.md) — names drift',
      '- [long](ok.md) — ' + 'rule text '.repeat(20), '- bad dash â€” here', `- [dup](ok.md) — ${RULE}`, ...Array.from({ length: 200 }, (_, i) => `- note ${i}`), ''].join('\n'));
    w(path.join(mem, 'ok.md'), '---\nname: ok\ntype: feedback\nmodified: 2026-11-01\n---\nOk.\n');
    w(path.join(mem, 'norn-paused-2026-11-09.md'), '---\ntype: project\n---\nPaused.\n');
    w(path.join(mem, 'orphan.md'), 'No frontmatter.\n');
  }
  const items = { 'L-1': { id: 'L-1', kind: 'lane', state: 'done', data: { name: 'old-lane-7' } } };
  const p = { name: 'kestrel', root: fwd(repo), state, project_dir: path.join(base, 'proj'), policy: { executors: { rev: { model: 'claude-opus-5-5', effort: 'high' } } } };
  return { p, repo, home, mem, state, items, base };
}
const by = (fs2, n) => fs2.filter(f => f.check === n);

test('coverage: the memory folder, CLAUDE.local.md, .claude/rules and imports (cycle-safe) are rows, each with its load', () => {
  const { p, home, mem, repo } = fx();
  assert.equal(fwd(memoryDir(p.root, path.join(home, '.claude'))).toLowerCase(), fwd(mem).toLowerCase());
  const rows = discover(p, { home, git: false }), at = n => rows.find(r => fwd(r.path).toLowerCase().endsWith(n.toLowerCase()));
  const idx = at('memory/MEMORY.md');
  assert.ok(idx && idx.kind === 'memory' && idx.load === 'session' && idx.loads.some(s => s.memory));
  assert.equal(at('memory/orphan.md').kind, 'memory-topic');
  assert.equal(at('memory/orphan.md').load, 'on-demand');
  assert.equal(at('/CLAUDE.local.md').load, 'session');
  assert.equal(at('rules/always.md').load, 'session');
  assert.equal(at('rules/ok.md').load, 'on-demand');
  assert.equal(at('rules/bad.md').load, 'session', 'a frontmatter that does not parse loads always');
  assert.equal(rows.filter(r => /docs\/i1\.md$/i.test(r.path)).length, 1, 'the import cycle adds each file once');
  assert.equal(at('docs/i5.md').import_depth, 5);
  assert.ok(fs.existsSync(path.join(repo, 'AGENTS.md')));
});

test('memory off per role: default per REPORT 5.5, a policy key overrides; a worker session does not load the memory rows', () => {
  assert.deepEqual(MEMORY_DEFAULT, { worker: 'off', merge: 'off', checkin: 'on', chat: 'on' });
  assert.equal(memoryOf({}, 'worker'), 'off');
  assert.equal(memoryOf({ launch: { memory: { worker: 'on' } } }, 'worker'), 'on');
  assert.equal(memoryOf({}, 'checkin'), 'on');
  assert.deepEqual(memoryEnv({ A: '1' }, 'off'), { A: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
  assert.deepEqual(memoryEnv({ A: '1' }, 'on'), { A: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: null }, 'on clears a switch inherited from the launching process');
  const sp = { class: 'session', families: ['claude'], memory: true };
  assert.equal(matches(sp, { kind: 'worker', family: 'claude', executor: 'claude', memory: false }), false);
  assert.equal(matches(sp, { kind: 'checkin', family: 'claude', executor: 'claude', memory: true }), true);
  const { p, state } = fx({ claudeOnly: true });
  record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { executor: 'claude', kind: 'worker', memory: 'off' } });
  assert.equal(sessionsOn(state, p)[0].memory, false);
});

test('memory checks 1-6: limit, encoding, long entries, pointers + names, frontmatter, a rule restated from a repo file', () => {
  const { p, home, items } = fx();
  const f = staticChecks(discover(p, { home, git: false }), { project: p, home, items });
  for (const x of f) { assert.ok(CHECKS[x.check], `check ${x.check} known`); assert.ok(['high', 'medium', 'low', 'count'].includes(x.severity)); assert.ok(x.fix.action && x.path && x.line >= 1);
    assert.match(x.id, /^A-[0-9a-f]{10}$/, 'META-TEND DEC-278: each finding is one advisory record'); assert.equal(x.phase, 'P1'); assert.ok(TIERS.includes(x.fix.tier) && x.why && x.source); }
  assert.equal(by(f, 1)[0].severity, 'high');
  assert.ok(by(f, 2).some(x => /MEMORY\.md$/.test(x.path) && x.line === 6));
  assert.ok(by(f, 3).some(x => x.line === 5));
  assert.ok(by(f, 4).some(x => /gone\.md/.test(x.why) && x.severity === 'high'));
  assert.ok(by(f, 4).some(x => /11-11/.test(x.why)), 'title and file name disagree');
  assert.ok(by(f, 4).some(x => /orphan\.md/.test(x.why)), 'a topic file in no index');
  assert.ok(by(f, 5).some(x => /orphan\.md|norn-paused/.test(x.why)));
  assert.ok(by(f, 6).some(x => x.line === 7 && /AGENTS\.md/.test(x.why)));
});

test('file checks 7-13: CLAUDE.local.md, rules, imports, the Codex 32 KiB chain, twins, Claude-only root, Moved: stubs', () => {
  const { p, home, items } = fx();
  const f = staticChecks(discover(p, { home, git: false }), { project: p, home, items });
  assert.ok(by(f, 7).some(x => /not git-ignored/.test(x.why)));
  assert.ok(by(f, 7).some(x => /1 of 2 worktrees/.test(x.why)));
  assert.ok(by(f, 8).some(x => /bad\.md$/.test(x.path) && /does not parse/.test(x.why)));
  assert.ok(by(f, 8).some(x => /zero\.md$/.test(x.path) && /0 files/.test(x.why)));
  assert.ok(by(f, 8).some(x => /always\.md$/.test(x.path) && x.severity === 'count'));
  assert.ok(!by(f, 8).some(x => /ok\.md$/.test(x.path)));
  assert.ok(by(f, 9).some(x => /missing\.md/.test(x.why) && x.severity === 'high'));
  assert.ok(by(f, 9).some(x => /hops/.test(x.why)));
  assert.ok(by(f, 10).some(x => /sub\/AGENTS\.md$/.test(fwd(x.path)) && x.severity === 'high'));
  assert.ok(by(f, 11).some(x => /sub/.test(fwd(x.path))));
  assert.ok(!by(f, 11).some(x => fwd(x.path) === `${p.root}/CLAUDE.md`), 'the root CLAUDE.md imports AGENTS.md: no twin');
  assert.ok(by(f, 13).some(x => /rules\/NEW\.md/.test(x.fix.action) && x.severity === 'high'));
  const c = fx({ claudeOnly: true });
  assert.ok(by(staticChecks(discover(c.p, { home: c.home, git: false }), { project: c.p, home: c.home, items: {} }), 12).length === 1);
});

test('prose checks 14-19 and agents / hooks / harness checks 21-23 (keys only, never a hook value)', () => {
  const { p, home, items } = fx();
  const f = staticChecks(discover(p, { home, git: false }), { project: p, home, items, harness: [{ family: 'claude', label: 'Claude Code', verified: { version: '2.1.314', date: '2026-11-13' } }, { family: 'codex', label: 'Codex' }], versions: { claude: '2.1.400' } });
  const ag = x => /AGENTS\.md$/.test(x.path) && !/sub/.test(fwd(x.path));
  assert.ok(by(f, 14).some(ag));
  assert.ok(by(f, 15).some(x => ag(x) && x.line === 4));
  assert.ok(by(f, 16).some(ag));
  assert.ok(by(f, 17).some(x => ag(x) && x.line === 6));
  assert.ok(by(f, 18).some(x => ag(x) && x.line === 7 && /claude-3-opus/.test(x.why)));
  assert.ok(by(f, 19).some(ag));
  assert.ok(by(f, 21).some(x => /rev\.md$/.test(x.path) && /model/.test(x.why)));
  assert.ok(by(f, 22).some(x => /Stop/.test(x.why) && x.severity === 'high'));
  assert.ok(by(f, 22).some(x => /PreToolUse/.test(x.why) && /prompt/.test(x.why)));
  assert.ok(!JSON.stringify(f).includes('SECRET-VALUE') && !JSON.stringify(f).includes('gone.mjs'));
  assert.ok(by(f, 23).some(x => /Codex/.test(x.why)));
  assert.ok(by(f, 23).some(x => /2\.1\.400/.test(x.why) && x.severity === 'medium'));
  assert.ok(!by(f, 23).some(ag), 'a harness finding never sits on a project file (bug 3)');
  assert.ok(!f.some(x => x.check === 20), 'check 20 is P5');
});

test('check 23 sits on the adapter that holds the rules, at its family line (bug 3: it sat on AGENTS.md L1)', () => {
  const { p, home, items } = fx();
  const f = staticChecks(discover(p, { home, git: false }), { project: p, home, items, harness: harnessRows().map(h => ({ ...h, verified: null })) });
  const gem = by(f, 23).find(x => /Gemini/.test(x.why));
  assert.match(gem.path, /engine\/lib\/harness\/cli\.mjs$/); assert.match(gem.fix.action, /in cli\.mjs/);
  const line = fs.readFileSync(gem.path, 'utf8').split(/\r?\n/)[gem.line - 1];
  assert.match(line, /family: 'gemini'/);
  assert.match(by(f, 23).find(x => /Claude Code/.test(x.why)).path, /harness\/claude\.mjs$/);
});

test('Context (the checks page, Per file) shows findings in place (severity chips, counts, fix) and the managed line; fixed since last scan', () => {
  const { p, home, repo } = fx();
  const v = instructionsView(p, { home, git: false, standing: null, remember: true });
  assert.ok(v.findings.length > 10 && v.managed.files === v.rows.length);
  assert.equal(v.managed.memory.worker, 'off');
  const html = ['role', 'file', 'growing', 'checkins', 'checks'].map(sub => renderTab('context', { ...v, sub, limit: 1000 }, {})).join('');   // META-UX-BUILD S4: the checks page + Per file
  assert.match(html, /id="ins-managed"/);
  assert.match(html, /files scanned/);
  assert.match(html, /memory loaded by/);
  assert.match(html, /chip bad">high/);
  assert.match(html, /id="ins-findings"/);
  // DEC-273: one row per file x check (count + the check's title), its lines in an expandable list - not one row per line
  const groups = new Set(v.findings.map(f => `${f.path}|${f.check}`));
  assert.equal((html.match(/class="insgroup/g) || []).length, groups.size);
  assert.ok(groups.size < v.findings.length, 'the toy has a check with several lines in one file');
  assert.match(html, /<details class="insgroup[^"]*"><summary>[\s\S]*?C\d+[\s\S]*?<\/summary>/);
  assert.ok(v.findings.every(f => f.surface), 'each finding carries its check title');
  // each file row names its open findings (a chip)
  const r1 = v.rows.find(r => r.findings > 0);
  assert.match(html, new RegExp(`id="ins-row-${r1.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]*?${r1.findings} finding`));
  assert.ok(html.includes(v.findings[0].fix.action.slice(0, 20).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')));
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Agents\nRun the tests.\n');
  const v2 = instructionsView(p, { home, git: false, standing: null, remember: true });
  assert.ok(v2.managed.fixed > 0 && v2.managed.open < v.managed.open);
});

// META-TEND P1-VISUAL (REPORT 5.3 views 2, 3, 5): the shared stack / bars widgets and the three pictures on real view data
test('the shared widgets (widgets.mjs, one set): stack = one bar of parts + a plain-word legend; bars = one labelled bar per row', async () => {
  const { stack, bars } = await import('../engine/dash/widgets.mjs');
  const s = stack([{ key: 'base', label: 'harness base', value: 300 }, { key: 'memory', label: 'memory <index>', value: 100 }, { key: 'skills', label: 'empty', value: 0 }], { fmt: n => `~${n}` });
  assert.match(s, /role="img" aria-label="harness base ~300, memory &lt;index&gt; ~100"/);
  assert.match(s, /class="insseg seg-base" style="width:75\.00%"/);
  assert.match(s, /class="insseg seg-memory" style="width:25\.00%"/);
  assert.doesNotMatch(s, /empty/, 'a zero part is left out of bar and legend');
  assert.match(s, /class="small inslegend"[\s\S]*harness base ~300/);
  const b = bars([{ label: 'lines', value: 105, cls: 'over' }, { label: 'size', value: 20, cls: 'st-fresh' }], { fmt: v => `${v} %`, max: 100 });
  assert.equal((b.match(/<li>/g) || []).length, 2);
  assert.match(b, /class="bar over"><i style="width:100\.0%"/, 'over the max = full, coloured');
  assert.match(b, /class="bar st-fresh"><i style="width:20\.0%"/);
  assert.match(b, /105 %/);
});

test('Context sits in Health beside Usage; the tab draws what one session loads, the file map and the memory map', () => {
  const { p, home, mem } = fx();
  // one main-tree session read ok.md through the Read tool (last opened); a worktree session mentioning orphan.md in prose does not count
  const proj = path.dirname(mem);
  w(path.join(proj, 's1.jsonl'), JSON.stringify({ type: 'assistant', timestamp: '2026-11-10T08:00:00Z', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(mem, 'ok.md') } }] } }) + '\n'
    + JSON.stringify({ type: 'user', timestamp: '2026-11-10T08:01:00Z', message: { content: 'see memory/orphan.md' } }) + '\n');
  const standing = { window_days: 7, roles: [], days: [], method: 'm', parts: {
    worker: { run: 'RUN-1', method: 'request', total: 1000, parts: [{ key: 'base', label: 'harness base prompt + tool schemas', ours: false, tokens: 700 }, { key: 'claude_md', label: 'CLAUDE.md / AGENTS.md chain', ours: true, tokens: 300 }, { key: 'memory', label: 'memory index', ours: true, tokens: 0 }] },
    chat: { run: 'chat', method: 'request', total: 2000, parts: [{ key: 'base', label: 'harness base prompt + tool schemas', ours: false, tokens: 1500 }, { key: 'memory', label: 'memory index', ours: true, tokens: 500 }] } } };
  const v = instructionsView(p, { home, git: false, standing, now: Date.parse('2026-11-14T12:00:00Z') });
  assert.deepEqual(MORE.find(g => g[0] === 'Health')[1], ['spend', 'slop', 'tests', 'context'], 'Context in Health beside Spend, Slop and Tests (UX review 2)');
  assert.ok(!MORE.find(g => g[0] === 'History')[1].includes('context'));
  // file map data: every row has loads per day and one state of four
  assert.ok(v.rows.every(r => typeof r.loads_day === 'number' && ['fresh', 'stale', 'conflict', 'generated-stale'].includes(r.map_state)));
  assert.equal(v.rows.find(r => r.name === 'AGENTS.md' && /repo\/AGENTS\.md$/.test(r.path)).map_state, 'conflict', 'a memory line restates it (check 6)');
  // memory map: index -> topics, broken links, entries in no index, the gauge, last opened / changed
  const m = v.memory_map;
  assert.ok(m && m.lines > 200 && m.max_lines === 200 && m.max_kb === 25);
  assert.deepEqual(m.broken.map(x => x.file), ['gone.md']);
  assert.deepEqual(m.orphans.map(x => x.name), ['orphan.md']);
  const ok = m.topics.find(t => t.name === 'ok.md');
  assert.ok(ok.linked >= 1 && ok.opened === '2026-11-10T08:00:00Z');
  assert.equal(m.topics.find(t => t.name === 'orphan.md').opened, null, 'a prose mention is not an open');
  const html = ['role', 'file', 'growing', 'checkins', 'checks'].map(sub => renderTab('context', { ...v, sub, limit: 1000 }, {})).join('');   // META-UX-BUILD S4: every Context view; nothing removed, only moved
  // view 2: one stacked bar per role, the memory switch per role
  assert.match(html, /id="ins-loads"/);
  assert.match(html, /controller \/ chat[\s\S]*?memory on[\s\S]*?class="wstack"/);
  assert.match(html, /workers[\s\S]*?memory off/);
  assert.match(html, /merge runs[\s\S]*?no session measured/);
  // view 3: blocks grouped by load class, coloured by state, a click opens the file
  assert.match(html, /id="ins-filemap"/);
  for (const g of ['always loaded', 'on demand', 'per role']) assert.ok(html.includes(g), g);
  assert.match(html, /class="fmblk st-conflict"[^>]*data-ins="/);
  // view 5: the memory map
  assert.match(html, /id="ins-memory"/);
  assert.match(html, /200 lines/); assert.match(html, /25 KB/);
  assert.match(html, /gone\.md[\s\S]*?missing/);
  assert.match(html, /orphan\.md/);
  assert.match(renderTab('context', { ...v, memory_map: null, sub: 'checks' }, {}), /id="ins-memory"[\s\S]*?No MEMORY\.md for this repo/, 'no memory folder: said, not hidden');
  // the opened file shows its own findings
  const agents = v.rows.find(r => r.name === 'AGENTS.md' && /repo\/AGENTS\.md$/.test(r.path));
  const own = v.findings.filter(x => x.path === agents.path || x.other === agents.path);   // the file part sends its own findings (server docFile)
  const open = renderTab('docs', { groups: [], files: 0, file: agents.id, doc: { ...agents, text: '# Agents', findings: own } }, {});   // META-UX-BUILD S3: the Docs reader
  assert.ok(own.length); assert.match(open, /id="doc-file-findings"[\s\S]*?restates|id="doc-file-findings"[\s\S]*?C\d+/);
});
