// META-INSTRUCTIONS R1: the Instructions view - every file that steers an agent (per harness), its load class, ~tokens, daily cost
// and read-only lint hints; the dashboard tab, `norn instructions [--json]` and the MCP read (norn_status view instructions).
// Sandbox only: a fixture repo, a fixture home (never the owner's real ~/.claude) and a fixture state.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { mark, slowStep, loopReport } from './helpers/loopwatch.mjs';
import { loadProject } from '../engine/lib/config.mjs';
import { record, recordsFile } from '../engine/lib/records.mjs';
import { standingRuns } from '../engine/lib/standing.mjs';
import { estTokens, TOKEN_METHOD, discover, sessionsOn, dailyCost, lint, instructionsView, formatInstructions, knownCommands } from '../engine/lib/instructions.mjs';
import { renderTab, loadTab, TABS } from '../engine/dash/ui.mjs';
import { MORE } from '../engine/dash/shell.mjs';
import { guardRows, guardView } from '../engine/lib/guardview.mjs';
import { guardSummary, guardPart } from '../engine/dash/guardparts.mjs';
import { TABS as SERVER_TABS, createDashboard } from '../engine/dash/server.mjs';
import { ADAPTERS } from '../engine/lib/harness/index.mjs';

after(cleanTmp);
const HERE = path.dirname(fileURLToPath(import.meta.url)), META = path.join(HERE, '..', 'engine', 'bin', 'norn.mjs');
const w = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); return f; };
const fwd = p => p.replace(/\\/g, '/');
const DUP = 'Every lane writes only its own NOTES file and ends it with exactly one end marker; the launcher records the run, never the agent itself, and the check-in reads it back.';
const OLD = new Date(Date.now() - 3 * 86400000);

/** a fixture project: repo (CLAUDE.md importing AGENTS.md, GEMINI.md, a nested CLAUDE.md, a repo agent), a home (user files), the
 * project dir (rules, checkin_extra, an agent + a skill for norn gen) and a state with directives. */
function fx() {
  const state = mkTmp('meta-ins-'), base = path.dirname(path.dirname(state)), repo = path.join(base, 'repo'), home = path.join(base, 'home'), pd = path.join(base, 'proj');
  w(path.join(repo, 'CLAUDE.md'), `# Repo rules\n@AGENTS.md\n\nRead \`docs/real.md\` and \`engine/missing.mjs\` first; run \`norn gen --check\` and \`meta frobnicate\`.\n\n${DUP}\n\nSee DIR-1 for the old cadence.\n`);
  w(path.join(repo, 'AGENTS.md'), '# Agents\nUse the tests.\n');
  w(path.join(repo, 'GEMINI.md'), '# Gemini\nBe brief.\n');
  w(path.join(repo, 'sub', 'CLAUDE.md'), '# Sub\nOnly here.\n');
  w(path.join(repo, 'docs', 'real.md'), 'real\n');
  w(path.join(repo, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\n---\nReview.\n');
  w(path.join(home, '.claude', 'CLAUDE.md'), '# user claude\n');
  w(path.join(home, '.codex', 'AGENTS.md'), '# user codex\n');
  w(path.join(home, '.gemini', 'GEMINI.md'), '# user gemini\n');
  w(path.join(pd, 'rules', 'DECISION-RULES.md'), '# Decide\n' + 'x'.repeat(400) + '\n');
  w(path.join(pd, 'rules', 'CHECKIN-x.md'), '# Check-in extra\n');
  const other = w(path.join(pd, 'rules', 'other.md'), `# Other\n\n${DUP}\n\nAlways run \`uv sync\` before a test.\n`);
  fs.utimesSync(other, OLD, OLD);
  w(path.join(pd, 'agents', 'implementer.md'), '---\nname: implementer\n---\nImplement the brief.\n');
  w(path.join(pd, 'skills', 'foo', 'SKILL.md'), '---\nname: foo\ndescription: Use when testing foo things\n---\nThe whole foo skill body, long enough to cost more than its description does in a session.\n');
  const pf = w(path.join(pd, 'project.json'), JSON.stringify({ schema: 1, name: 'kestrel', title: 'K', root: fwd(repo),
    rules_read_whole: ['${project_dir}/rules/DECISION-RULES.md'], checkin_extra: '${project_dir}/rules/CHECKIN-x.md',
    executors: { gem: { preset: 'gemini-cli', model: 'gemini-x', enabled: true } },
    install: { agents: '${project_dir}/agents', skills: '${project_dir}/skills' } }, null, 1));
  const p = { ...loadProject(pf, { home: fwd(home), meta: fwd(base) }), state: fwd(state) };
  const machine = { home: fwd(home), claude: { config_dir: fwd(path.join(home, '.claude')) }, codex: null, projects: [] };
  return { state, base, repo, home, pd, p, machine, other };
}
const byName = (rows, rel) => rows.find(r => r.path.toLowerCase().endsWith(rel.toLowerCase()));

test('token estimate: ceil(chars / 4), no tokenizer dependency, the method written down', () => {
  assert.equal(estTokens(''), 0);
  assert.equal(estTokens('abcd'.repeat(10)), 10);
  assert.equal(estTokens('a'.repeat(4001)), 1001);
  assert.match(TOKEN_METHOD, /chars? \/ 4/); assert.match(TOKEN_METHOD, /~/);
});

test('harness data rows: Claude Code, Codex and the Gemini CLI preset name their own instruction files', () => {
  assert.deepEqual(ADAPTERS.claude.instructions.repo.slice(0, 1), ['CLAUDE.md']);
  assert.deepEqual(ADAPTERS.codex.instructions.repo.slice(0, 1), ['AGENTS.md']);
  assert.deepEqual(ADAPTERS.cli.instructions['gemini-cli'].repo, ['GEMINI.md']);
});

test('discovery per harness on a fixture repo: repo + nested + user + rules + check-in + prompts + gen targets, each with load, ~tokens, lines, change, generated', () => {
  const f = fx();
  const rows = discover(f.p, { home: f.home, machine: f.machine });
  const claude = byName(rows, 'repo/CLAUDE.md');
  assert.deepEqual(claude.harness, ['claude']); assert.equal(claude.kind, 'repo'); assert.equal(claude.load, 'session');
  assert.equal(claude.generated, false); assert.equal(claude.tokens, estTokens(fs.readFileSync(path.join(f.repo, 'CLAUDE.md'), 'utf8')));
  assert.ok(claude.lines >= 7 && claude.changed && ['git', 'mtime'].includes(claude.changed_by));
  const agents = byName(rows, 'repo/AGENTS.md');   // codex loads it, and claude through the @AGENTS.md import
  assert.deepEqual([...agents.harness].sort(), ['claude', 'codex']); assert.equal(agents.load, 'session');
  assert.deepEqual(byName(rows, 'repo/GEMINI.md').harness, ['gemini']);
  assert.equal(byName(rows, 'sub/CLAUDE.md').load, 'on-demand');
  assert.equal(byName(rows, '.claude/agents/reviewer.md').load, 'role');
  const user = byName(rows, 'home/.claude/CLAUDE.md');
  assert.equal(user.kind, 'user'); assert.equal(user.machine_only, true); assert.equal(user.load, 'session');
  assert.deepEqual(byName(rows, 'home/.codex/AGENTS.md').harness, ['codex']);
  assert.deepEqual(byName(rows, 'home/.gemini/GEMINI.md').harness, ['gemini']);
  assert.equal(byName(rows, 'rules/DECISION-RULES.md').load, 'checkin');
  assert.equal(byName(rows, 'rules/CHECKIN-x.md').load, 'checkin');
  assert.equal(byName(rows, 'rules/other.md').load, 'on-demand');
  assert.equal(byName(rows, 'prompts/CHECKIN.md').load, 'checkin');
  assert.equal(byName(rows, 'prompts/CHAT.md').load, 'chat');
  // norn gen targets: the agent (role implementer, generated, drift state) and its source (feeds it); the skill lists its description
  const tgt = byName(rows, 'home/.claude/agents/implementer.md');
  assert.equal(tgt.generated, true); assert.equal(tgt.drift, 'missing'); assert.equal(tgt.load, 'role'); assert.equal(tgt.role, 'implementer');
  const src = byName(rows, 'proj/agents/implementer.md');
  assert.equal(src.generated, false); assert.equal(src.load, 'source'); assert.ok(src.feeds.includes(tgt.id) && src.feeds.length === 2, 'the agent target + the gem pack');
  const sk = byName(rows, 'home/.claude/skills/foo/SKILL.md');
  assert.equal(sk.load, 'session'); assert.ok(sk.standing_tokens < sk.tokens && sk.standing_tokens > 0, JSON.stringify(sk) + 'a skill costs its description per session');
  for (const r of rows) assert.ok(r.id && r.path && Number.isInteger(r.tokens) && Number.isInteger(r.lines), JSON.stringify(r));
  assert.equal(new Set(rows.map(r => r.id)).size, rows.length, 'ids are unique');
});

test('daily cost from synthetic runs: tokens x the sessions that loaded it today; standing context per role', () => {
  const f = fx();
  const day = new Date().toISOString().slice(0, 10);
  for (const d of [{ kind: 'worker', executor: 'claude', agent: 'implementer', lane: 'a' }, { kind: 'worker', executor: 'claude', agent: 'implementer', lane: 'b' },
    { kind: 'codex', executor: 'codex-sol', lane: 'c' }, { kind: 'checkin', executor: 'claude', lane: 'checkin', tick_class: 'major' }, { kind: 'cli', executor: 'gem', lane: 'g' }])
    record(f.state, { kind: 'run', ev: 'start', by: 'launcher', data: d });
  const ses = sessionsOn(f.state, f.p, day);
  assert.equal(ses.length, 5);
  assert.equal(sessionsOn(f.state, f.p, '2001-01-01').length, 0, 'another day: none');
  const rows = discover(f.p, { home: f.home, machine: f.machine });
  const c = dailyCost(rows, ses);
  const get = rel => byName(c.rows, rel);
  assert.equal(get('repo/CLAUDE.md').loads_today, 3);                      // 2 claude workers + the claude check-in
  assert.equal(get('repo/CLAUDE.md').cost_today, 3 * get('repo/CLAUDE.md').tokens);
  assert.equal(get('repo/AGENTS.md').loads_today, 4);                      // + the codex worker
  assert.equal(get('repo/GEMINI.md').loads_today, 1);                      // the gemini-cli preset run
  assert.equal(get('rules/DECISION-RULES.md').loads_today, 1);
  assert.equal(get('home/.claude/agents/implementer.md').loads_today, 2);
  assert.equal(get('sub/CLAUDE.md').loads_today, 0);
  assert.equal(get('proj/agents/implementer.md').cost_today, get('home/.claude/agents/implementer.md').cost_today, 'a source shows what its targets cost');
  const sk = get('home/.claude/skills/foo/SKILL.md');
  assert.equal(sk.cost_today, 3 * sk.standing_tokens);
  const total = c.rows.filter(r => r.load !== 'source').reduce((n, r) => n + r.cost_today, 0);
  assert.equal(c.total, total, 'sources are not counted twice');
  const st = Object.fromEntries(c.standing.map(s => [s.key, s]));
  assert.equal(st['worker:claude:implementer'].sessions, 2);
  assert.equal(st['worker:claude:implementer'].tokens, ['repo/CLAUDE.md', 'repo/AGENTS.md', 'home/.claude/CLAUDE.md', 'home/.claude/agents/implementer.md'].reduce((n, r) => n + get(r).tokens, 0) + sk.standing_tokens);
  assert.ok(st['checkin:major'].tokens > st['worker:codex'].tokens);
});

test('lint hints (read-only): a missing path, an unknown norn command, a duplicated paragraph, a stale DIR citation, a clash with a newer directive', () => {
  const f = fx();
  const d1 = record(f.state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'check in every 15 min', via: 'chat' } });
  const d2 = record(f.state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'check in every 30 min', via: 'chat' } });
  record(f.state, { kind: 'directive', ev: 'supersede', id: d1.id, by: 'owner', data: { by: d2.id, why: 'slower' } });
  record(f.state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'Never run `uv sync` in the main tree.', via: 'chat' } });
  const before = fs.readFileSync(path.join(f.repo, 'CLAUDE.md'), 'utf8');
  const rows = discover(f.p, { home: f.home, machine: f.machine });
  const hints = lint(rows, { project: f.p, commands: knownCommands() });
  const of = (rel, kind) => hints.filter(h => h.kind === kind && h.path.toLowerCase().endsWith(rel.toLowerCase()));
  assert.equal(of('repo/CLAUDE.md', 'missing-path').length, 1); assert.match(of('repo/CLAUDE.md', 'missing-path')[0].text, /engine\/missing\.mjs/);
  assert.ok(of('repo/CLAUDE.md', 'missing-path')[0].line >= 1);
  assert.equal(of('repo/CLAUDE.md', 'unknown-command').length, 1); assert.match(of('repo/CLAUDE.md', 'unknown-command')[0].text, /meta frobnicate/);
  assert.equal(of('repo/CLAUDE.md', 'duplicate').length, 1); assert.match(of('repo/CLAUDE.md', 'duplicate')[0].text, /other\.md/);
  assert.equal(of('rules/other.md', 'duplicate').length, 1);
  assert.equal(of('repo/CLAUDE.md', 'stale-citation').length, 1); assert.match(of('repo/CLAUDE.md', 'stale-citation')[0].text, /DIR-1.*superseded.*DIR-2/);
  const clash = of('rules/other.md', 'directive-clash');
  assert.equal(clash.length, 1); assert.match(clash[0].text, /uv sync/); assert.match(clash[0].text, /DIR-3/);
  assert.ok(!hints.some(h => h.kind === 'unknown-command' && /norn gen/.test(h.text)), 'norn gen exists');
  assert.ok(!hints.some(h => /docs\/real\.md/.test(h.text)), 'an existing path is no hint');
  assert.equal(fs.readFileSync(path.join(f.repo, 'CLAUDE.md'), 'utf8'), before, 'lint edits nothing');
});

test('lint: a ${root} / ~/ path on a POSIX root is an absolute path, still checked (CI-RED-42B7708: Linux roots start with /)', () => {
  const d = mkTmp('meta-instr-posix-'), f = path.join(d, 'AGENTS.md');
  fs.writeFileSync(f, ['# A', '- Never start a run while `${root}/.superpowers/QUIET` is on.', '- Read `~/notes/plan.md` first.', '- See `/etc/never.conf`.', ''].join('\n'));
  const rows = [{ id: 'a1', path: f, exists: true, generated: false, chars: fs.statSync(f).size }];
  const HOME = '/ho' + 'me/kpos';   // built from parts: no literal home path (lint)
  const hints = lint(rows, { project: { root: '/srv/kestrel-posix' }, home: HOME, commands: new Set() }).filter(h => h.kind === 'missing-path');
  const q = hints.find(h => /QUIET/.test(h.text));
  assert.ok(q, 'the expanded POSIX path is a hint');
  assert.deepEqual(q.cands, ['/srv/kestrel-posix/.superpowers/QUIET'], 'checked as itself, not joined to a base');
  assert.deepEqual(hints.find(h => /plan\.md/.test(h.text))?.cands, [HOME + '/notes/plan.md']);
  assert.ok(!hints.some(h => /never\.conf/.test(h.text)), 'a literal /path token stays no candidate');
});

test('L-17: a broken input is an error, never an empty view - a corrupt gen manifest drops no target, corrupt records read as no runs', () => {
  const f = fx(), manifest = w(path.join(f.p.meta, 'local', 'install-manifest.json'), '{ not json');
  assert.throws(() => discover(f.p, { home: f.home, machine: f.machine }), SyntaxError, 'the gen targets and their drift are what the page is for');
  fs.rmSync(manifest);
  fs.appendFileSync(recordsFile(f.state, 'run'), '{ not json\n');
  const rows = discover(f.p, { home: f.home, machine: f.machine });
  for (const [what, fn] of [['sessionsOn', () => sessionsOn(f.state, f.p)], ['lint', () => lint(rows, { project: f.p, home: f.home })], ['standingRuns', () => standingRuns(f.state, f.p)],
    ['instructionsView', () => instructionsView(f.p, { home: f.home, machine: f.machine })]]) assert.throws(fn, /runs\.jsonl/, `${what}: a records error is shown, not an empty view`);
});

test('the view + text: rows with hints, totals, the method; `norn instructions --json` and text in a sandbox home', () => {
  const f = fx();
  const v = instructionsView(f.p, { home: f.home, machine: f.machine });
  assert.equal(v.project, 'kestrel'); assert.equal(v.method, TOKEN_METHOD); assert.ok(v.rows.length >= 15 && Array.isArray(v.hints) && Array.isArray(v.standing));
  assert.ok(byName(v.rows, 'repo/CLAUDE.md').hints >= 3);
  const txt = formatInstructions(v);
  assert.match(txt, /~\d/); assert.match(txt, /CLAUDE\.md/); assert.match(txt, /hint/i);
  const env = { ...process.env, HOME: f.home, USERPROFILE: f.home, META_ROOT: f.base, META_STATE: '' };
  const pf = path.join(f.pd, 'project.json');
  const r = spawnSync(process.execPath, [META, 'instructions', '--project', pf, '--json'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.ok(byName(j.rows, 'home/.claude/CLAUDE.md'), 'the fixture home, not the real one');
  const t = spawnSync(process.execPath, [META, 'instructions', '--project', pf], { env, encoding: 'utf8' });
  assert.equal(t.status, 0, t.stderr); assert.match(t.stdout, /standing context/i);
});

// ---------- the dashboard tab ----------
const VIEW = {
  project: 'kestrel', day: '2026-11-13', method: TOKEN_METHOD, sessions: 3, total: 9000,
  rows: [
    { id: 'a1', path: 'C:/r/CLAUDE.md', name: 'CLAUDE.md', where: 'repo', harness: ['claude'], kind: 'repo', load: 'session', tokens: 1200, standing_tokens: 1200, lines: 40, changed: '2026-11-12T10:00:00Z', changed_by: 'git', generated: false, loads_today: 3, cost_today: 3600, hints: 1, stale: 2, exists: true },
    { id: 'b2', path: 'C:/h/.claude/agents/implementer.md', name: 'implementer.md', where: 'home', harness: ['claude'], kind: 'agent', load: 'role', role: 'implementer', tokens: 900, standing_tokens: 900, lines: 30, changed: null, generated: true, drift: 'stale', source: 'C:/p/agents/implementer.md', loads_today: 2, cost_today: 1800, hints: 0, exists: true, machine_only: true },
  ],
  standing: [{ key: 'worker:claude:implementer', label: 'worker implementer (claude)', sessions: 2, tokens: 2100 }],
  hints: [{ id: 'a1', path: 'C:/r/CLAUDE.md', kind: 'missing-path', line: 3, text: 'engine/missing.mjs does not exist' }],
  measured: { method: 'standing context = the first API call', window_days: 7,
    roles: [{ key: 'checkin', role: 'checkin', family: 'claude', runs: 204, measured: 204, median_turn1: 32990, median_create1: 14100, median_turns: 12, cache_read: 133000000 },
      { key: 'worker', role: 'worker', family: 'claude', runs: 170, measured: 170, median_turn1: 21500, median_create1: 11400, median_turns: 26, cache_read: 687000000 }],
    parts: { worker: { run: 'RUN-640', method: 'request', total: 22269, parts: [{ key: 'base', label: 'harness base prompt + tool schemas', ours: false, tokens: 9106 }, { key: 'skills', label: 'skills list', ours: true, tokens: 4251 }, { key: 'plugins', label: 'plugins (their skills)', ours: true, tokens: 4946 }] } } },
  suggest: [{ id: 'S-1', class: 'stale', path: 'C:/r/CLAUDE.md', file: 'CLAUDE.md', anchor: 'p12345678', line: 3, head: 'Old rule', tokens: 600, loads_per_day: 3, saved_per_day: 1800, why: 'older than 30 d', action: 'delete it', patch: '--- a/C:/r/CLAUDE.md\n+++ b/C:/r/CLAUDE.md\n@@ -3,2 +2,0 @@\n-Old rule\n-\n', owner_file: false }],
};
test('Context: in Health next to Usage (UX review 2), a one-project tab; rows with load class, ~size, daily cost, drift and hints', async () => {
  assert.ok(TABS.some(([k, l]) => k === 'context' && l === 'Context'));   // META-UX-BUILD S4 (owner DIR-65)
  assert.ok(SERVER_TABS.includes('context'));
  assert.deepEqual(MORE.find(g => g[0] === 'Health')[1], ['spend', 'slop', 'tests', 'context']);   // stage NAV: More, Health
  assert.ok(renderTab('context', { one: true }).includes('Choose one project'));
  const html = ['role', 'file', 'growing', 'checkins', 'checks'].map(sub => renderTab('context', { ...VIEW, sub, limit: 1000 }, {})).join('');
  assert.match(html, /id="panel-context"/);
  assert.match(html, /data-ins="a1"/); assert.match(html, /~1\.2k/); assert.match(html, /every session/); assert.match(html, /stale/);
  assert.match(html, /worker implementer \(claude\)/);
  // META-UX-BUILD S5: the lint's hints are rows in Slop › To fix (moved, not gone); Context links there
  assert.match(html, /data-go="slop" data-gosub="fix"/);
  assert.ok(guardRows({ ins: VIEW }).some(r => r.id.startsWith('H-') && r.why === 'engine/missing.mjs does not exist'), 'the hint is a Slop row');
  assert.match(html, /chars \/ 4/);
  const open = renderTab('docs', { groups: [], files: 0, file: 'a1', doc: { ...VIEW.rows[0], text: '# Title\n\nbody' } });   // META-UX-BUILD S3: a file opens in the Docs reader
  assert.match(open, /<h1 id="title">Title<\/h1>/); assert.match(open, /id="doc-body"/);
  // META-STANDING-CONTEXT R1: the measured header (turn 1 per role + the parts), the stale chip, the suggest list, an age badge per paragraph
  assert.match(html, /id="ctx-roles"/); assert.match(html, /check-ins/); assert.match(html, /~33\.0k/); assert.match(html, /skills list ~4\.3k/); assert.match(html, /\(fixed\)/);
  assert.match(html, /2 stale/);
  // META-UX-BUILD S5: the tightening candidates are Slop rows (moved, not gone): the row keeps its patch and its apply command
  const sv = { ...guardView(guardRows({ ins: VIEW })), project: 'kestrel', pending: false, slop: true, voice: {}, errors: [] };
  const slop = renderTab('slop', { ...guardSummary(sv), sub: 'fix', ...guardPart(sv, 'fix'), parts_loading: false }, {});
  assert.match(slop, /id="slop-T-S-1"[^]*norn instructions apply S-1/); assert.match(slop, /~1800 tokens \/ day/, 'the tokens it saves a day'); assert.match(slop, /engine\/missing\.mjs does not exist/);
  const aged = renderTab('docs', { groups: [], files: 0, file: 'a1', doc: { ...VIEW.rows[0], text: '# Title\n\nold body', paras: [{ anchor: 'p00000001', line: 1, end: 1, age_days: 2, stale: false }, { anchor: 'p00000002', line: 3, end: 3, age_days: 70, stale: true, why: 'older than 30 d' }] } });
  // d97d2c0a: the age badge became the paragraph's gutter line number, coloured by age, its title the age and STALE
  assert.match(aged, /id="ins-p00000002"><div class="dgut"><span class="dln gage-[a-z]+" title="70 d old[^"]*STALE[^"]*">3<\/span>/); assert.match(aged, /old body/);
  const calls = [];
  const d = await loadTab('context', 'kestrel', async u => { calls.push(u); return VIEW; }, { ins: 'a1' });
  assert.deepEqual(calls, ['/api/instructions?project=kestrel'], 'META-UX-BUILD S3: the tab no longer opens a file (the Docs reader does)');
  assert.equal(d.file, undefined);
});

test('the dashboard API: /api/instructions (the summary) + ?part=files lists the rows; the Docs reader opens only a listed file', async () => {
  const f = fx();
  const app = createDashboard({ projects: [f.p], machine: f.machine, budgetFile: path.join(f.base, 'budget.json'), platform: {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  try {
    let l = await (await fetch(`${url}/api/instructions?project=kestrel`)).json();   // META-UX-BUILD S1: the scan runs in a worker, pending first
    for (let i = 0; l.pending && i < 600; i++) { await new Promise(r => setTimeout(r, 100)); l = await (await fetch(`${url}/api/instructions?project=kestrel`)).json(); }
    const row = byName((await (await fetch(`${url}/api/instructions?project=kestrel&part=files`)).json()).rows, 'repo/CLAUDE.md');
    assert.ok(row && l.method === TOKEN_METHOD);
    const one = await fetch(`${url}/api/docs?project=kestrel&part=file&file=${row.id}`);
    assert.equal(one.status, 200); assert.match((await one.json()).doc.text, /Repo rules/);
    assert.equal((await fetch(`${url}/api/docs?project=kestrel&part=file&file=nope`)).status, 404);
  } finally { await app.close(); }
});

test('the MCP read: norn_status view instructions (the controller profile stays at <= 16 tools)', async () => {
  const f = fx();
  const { context, handle, TOOLS } = await import('../engine/lib/mcp.mjs');
  const { main } = await import('../engine/bin/norn.mjs');
  assert.ok(TOOLS.filter(t => t.profiles.includes('controller')).length <= 16);
  const env = { ...process.env, HOME: f.home, USERPROFILE: f.home, META_ROOT: f.base, META_NO_TICK: '1' };
  for (const k of ['META_STATE', 'META_PROJECT', 'META_ROLE', 'META_RUN_ID']) delete env[k];
  const ctx = context({ state: f.p.state, project: { ...f.p, file: path.join(f.pd, 'project.json') }, profile: 'checkin', client: 't', env, cli: main });
  const r = handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'norn_status', arguments: { view: 'instructions' } } }, ctx);
  assert.ok(!r.result.isError, JSON.stringify(r));
  assert.match(r.result.content[0].text, /Standing context per role/);
  assert.ok(byName(r.result.structuredContent.instructions.rows, 'home/.claude/CLAUDE.md'), 'the fixture home');
});

// ---------- the phone width (scrollWidth == width at 390), desktop 1440 ----------
let shotLib = null;
try { shotLib = await import('../engine/lib/shot.mjs'); } catch { /* norn shot not on this branch */ }
const browser = shotLib?.findBrowser?.() ?? null;
test('Context at 390 x 844 (phone): document scrollWidth == the viewport width, rows (Per file) and hints (the checks) shown; a row opens the file', {
  skip: !shotLib ? 'engine/lib/shot.mjs is not on this branch' : !browser ? 'no Edge / Chrome / Chromium installed' : false, timeout: 240000 }, async () => {   // the scan wait (<= 120 s) + the browser
  const { launchBrowser, killTree, killProfileProcs, removeProfile } = shotLib;
  const f = fx();
  w(path.join(f.repo, 'deep', 'a-very-long-folder-name-for-the-phone-width-test', 'another-long-folder-name-that-does-not-break', 'CLAUDE.md'), '# deep\n');
  const app = createDashboard({ projects: [f.p], machine: f.machine, budgetFile: path.join(f.base, 'budget.json'), platform: {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  // the instruction-file scan runs in a worker (META-UX-BUILD S1): until it lands, Slop has no H- / T- rows and Per file no rows,
  // and the page's own 20 s wait below raced it (red on a clean main, "the instruction-file scan is running"). Wait for the scan.
  let l = await (await fetch(`${url}/api/instructions?project=kestrel`)).json();
  for (let i = 0; l.pending && i < 1200; i++) { await new Promise(r => setTimeout(r, 100)); l = await (await fetch(`${url}/api/instructions?project=kestrel`)).json(); }
  assert.equal(l.pending, false, `the instruction-file scan landed (${JSON.stringify(l.error ?? null)})`);
  const profile = mkTmp('meta-shot-');
  const child = launchBrowser({ browser, profile, size: [390, 844] });
  let ws;
  try {
    const port = await shotLib.waitDevToolsPort({ browser, profile, child });
    let page = null;
    for (let i = 0; i < 100 && !page; i++) { try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); } catch { /* not yet */ } if (!page) await new Promise(r => setTimeout(r, 100)); }
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const pend = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
    const wait = sel => ev(`new Promise(r => { const t0 = Date.now(); const go = () => document.querySelector(${JSON.stringify(sel)}) || Date.now() - t0 > 20000 ? setTimeout(() => r({
      sw: document.documentElement.scrollWidth, w: innerWidth, rows: document.querySelectorAll('#ins-table tbody tr').length, hints: document.querySelectorAll('#slop-rows [id^="slop-H-"]').length,
      body: !!document.querySelector('#doc-body'), sug: document.querySelectorAll('#slop-rows [id^="slop-T-"]').length, badges: document.querySelectorAll('#doc-body .dgut .dln[title]').length }), 300) : setTimeout(go, 100); go(); })`);
    await send('Page.enable'); await send('Runtime.enable');
    for (const [wd, h, mobile] of [[390, 844, true], [1440, 900, false]]) {
      await send('Emulation.setDeviceMetricsOverride', { width: wd, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
      for (const sub of ['slop', 'file']) {   // META-UX-BUILD S4: the files in Per file. S5: the hints and Tighten are rows in Slop › To fix
        await send('Page.navigate', { url: sub === 'file' ? `${url}/?project=kestrel&tab=context&sub=file` : `${url}/?project=kestrel&tab=slop&sub=fix` });
        // META-CI-WORKCLASS R4 (DEC-336): this private CDP wait gets pg.go's loop report (slow -> stderr; a miss -> the assertion)
        const step = mark(), m = await wait(sub === 'file' ? '#ins-table' : '#slop-rows [id^="slop-T-"]'), slow = await slowStep(step, `wait(${sub} at ${wd})`);
        if (!(sub === 'file' ? m.rows >= 15 : m.hints >= 3 && m.sug >= 1)) assert.fail(`${JSON.stringify(m)}
${slow ?? await loopReport(step)}`);
        if (mobile) assert.equal(m.sw, m.w, `no sideways scroll at ${wd} (${JSON.stringify(m)})`); else assert.ok(m.sw <= m.w, `no sideways scroll at ${wd} (a desktop scrollbar takes its width) ${JSON.stringify(m)}`);
        assert.equal(m.w, wd);
      }
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await ev(`document.querySelector('#ins-table button[data-ins]:not([disabled])').click()`);
    const step = mark(), o = await wait('#doc-body'), slow = await slowStep(step, 'wait(#doc-body)');   // META-UX-BUILD S3: the row opens the file in the Docs reader
    if (!(o.body && o.badges >= 1)) assert.fail(`the file opened rendered, an age-coloured line number per paragraph (d97d2c0a: the gutter replaced the badge): ${JSON.stringify(o)}
${slow ?? await loopReport(step)}`); assert.equal(o.sw, o.w, `open file at 390 (${JSON.stringify(o)})`);
  } finally {
    try { ws?.close(); } catch { /* closed */ }
    await killTree(child); await killProfileProcs(profile); await removeProfile(profile); await app.close();
  }
});
