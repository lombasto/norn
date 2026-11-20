// META-STANDING-CONTEXT R1: the standing context every session pays for - measured from the transcripts (turn-1 context, cache
// create, cache reads, turns; per role and per day), split into its parts (harness base, CLAUDE.md chain, memory, hooks, skills,
// agents, MCP, plugins) and the lean launch profiles (policy data -> adapter flags, never --bare). Synthetic transcripts only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { record } from '../engine/lib/records.mjs';
import { transcriptHead, splitParts, measureRun, roleOfRun, standingRuns, standingSummary, PARTS, STANDING_METHOD,
  profileDrops } from '../engine/lib/standing.mjs';
import { profileOf, PROFILE_DEFAULTS } from '../engine/lib/launchpolicy.mjs';
import { ADAPTERS } from '../engine/lib/harness/index.mjs';
import { buildCommand } from '../engine/lib/runs.mjs';

after(cleanTmp);
const w = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); return f; };
const L = o => JSON.stringify(o);

// the parts of one first request, as Claude Code 2.1.3xx records it (api-request-shape + api-request-blob + api-request)
const HOOK = 'SessionStart hook additional context: <EXTREMELY_IMPORTANT>' + 'h'.repeat(400) + '</EXTREMELY_IMPORTANT>';
const ENV = '\n# Environment\nYou have been invoked in the following environment: \n - Primary working directory: C:/x\n' + 'e'.repeat(200);
const MCP = '\nThe following MCP servers have provided instructions for how to use their tools and resources:\n\n## claude.ai Docs\n' + 'm'.repeat(300);
const SKILLS = '\nThe following skills are available for use with the Skill tool:\n\n- kestrel-tests: Use before running any test' + 's'.repeat(300)
  + '\n- superpowers:brainstorming: You MUST use this before any creative work' + 'p'.repeat(200) + '\n';
const CLAUDEMD = '<system-reminder>\nCodebase and user instructions are shown below.\n\nContents of C:\\r\\CLAUDE.md (project instructions, checked into the codebase):\n\n'
  + 'c'.repeat(500) + '\n\nContents of C:\\' + 'Users\\o\\.claude\\projects\\x\\memory\\MEMORY.md (user\'s auto-memory, persists across conversations):\n\n' + 'y'.repeat(100) + '\n</system-reminder>\n';
const CTX = '<system-reminder>\nAs you answer the user\'s questions, you can use the following context:\n# userEmail\n' + 'u'.repeat(60) + '\n</system-reminder>\n';
const PROMPT = 'Read the brief C:/b/brief.md and execute it exactly.';
const HEADLESS = 'You run headless: nobody answers questions and your process ends with your turn.';
function firstRequest({ agent = 'kestrel-implementer', ts = '2026-11-13T10:00:00.000Z' } = {}) {
  const system = [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }, { type: 'text', text: 'You are an implementer.' + 'a'.repeat(600) + '\n\n' + HEADLESS }];
  const tools = [{ name: 'Bash', description: 'b'.repeat(1000), input_schema: {} }, { name: 'Read', description: 'r'.repeat(400), input_schema: {} },
    { name: 'Skill', description: 'Execute a skill', input_schema: {} }, { name: 'Agent', description: 'Available agent types: kestrel-runner ...' + 'g'.repeat(200), input_schema: {} },
    { name: 'mcp__norn__norn_status', description: 'n'.repeat(150), input_schema: {} }];
  const u = { role: 'user', content: [{ type: 'text', text: CLAUDEMD }, { type: 'text', text: CTX }, { type: 'text', text: PROMPT }] };
  const s = { role: 'system', content: [{ type: 'text', text: HOOK + ENV + MCP + SKILLS }] };
  return [...(agent ? [L({ type: 'agent-setting', agentSetting: agent, sessionId: 's1' })] : []),
    L({ type: 'attachment', attachment: { type: 'hook_additional_context', content: [HOOK] }, timestamp: ts }),
    L({ type: 'api-request-shape', version: '2.1.314', timestamp: ts, shape: { system, tools } }),
    L({ type: 'api-request-blob', hash: 'h1', message: u }), L({ type: 'api-request-blob', hash: 'h2', message: s }),
    L({ type: 'api-request', timestamp: ts, version: '2.1.314', tail: ['h1', 'h2'] })];
}
const asst = (id, ts, cr, cc = 0, input = 2) => L({ type: 'assistant', timestamp: ts, requestId: 'q' + id, message: { id: 'm' + id, model: 'claude-opus-5-5', usage: { input_tokens: input, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, output_tokens: 10 } } });

function transcriptFile(dir, sid, { agent, day = '2026-11-13', cr = [10000, 22000, 23000], create = 12000 } = {}) {
  const ts = i => `${day}T10:0${i}:00.000Z`;
  const lines = [...firstRequest({ agent, ts: ts(0) }), asst(1, ts(1), cr[0], create)];
  for (let i = 1; i < cr.length; i++) lines.push(asst(i + 1, ts(i + 1), cr[i], 300));
  if (cr.length > 1) lines.push(asst(2, ts(2), cr[1], 300));   // the CLI writes one message in several lines: counted once (message id + request id)
  return w(path.join(dir, 'proj-x', sid + '.jsonl'), lines.join('\n') + '\n');
}

test('measure: turn-1 context, its cache create, total cache reads and turns of one run - each API message once, a resumed run from its own start', () => {
  const st = mkTmp('meta-sc-'), pdir = path.join(path.dirname(st), 'projects');
  const f = transcriptFile(pdir, 'sid-1');
  const h = transcriptHead(f);
  assert.equal(h.version, '2.1.314'); assert.equal(h.agent, 'kestrel-implementer');
  assert.deepEqual(h.usage, { input: 2, cache_create: 12000, cache_read: 10000, context: 22002 });
  const live = measureRun({ id: 'RUN-1', state: 'running', created: '2026-11-13T09:59:59Z', updated: 'x', data: { kind: 'worker', executor: 'claude', session_id: 'sid-1', lane: 'water' } }, { projectsDir: pdir });
  assert.equal(live.turn1, 22002); assert.equal(live.create1, 12000);
  assert.equal(live.cache_read, 10000 + 22000 + 23000, 'the duplicated message line is counted once');
  assert.equal(live.turns, 3); assert.equal(live.role, 'worker'); assert.equal(live.day, '2026-11-13'); assert.equal(live.src, 'transcript');
  // an ended run: the CLI final's usage (= the transcript sum of that process) and its num_turns
  const fin = w(path.join(st, 'final.json'), L({ num_turns: 7, usage: { cache_read_input_tokens: 99999 } }));
  const ended = measureRun({ id: 'RUN-2', state: 'exited', created: '2026-11-13T09:59:59Z', updated: 'y', data: { kind: 'worker', executor: 'claude', session_id: 'sid-1', final: fin, lane: 'merge-c5' },
    end: { usage: { cache_read_input_tokens: 99999, cache_creation_input_tokens: 5 }, transcript: f } }, { projectsDir: pdir });
  assert.equal(ended.cache_read, 99999); assert.equal(ended.turns, 7); assert.equal(ended.turn1, 22002); assert.equal(ended.role, 'merge'); assert.equal(ended.src, 'end');
  // a resume of the same session: its turn 1 is the first API call at / after its own start
  const resumed = measureRun({ id: 'RUN-3', state: 'running', created: '2026-11-13T10:01:30Z', updated: 'z', data: { kind: 'worker', executor: 'claude', session_id: 'sid-1' } }, { projectsDir: pdir });
  assert.equal(resumed.turn1, 2 + 300 + 22000);
  assert.equal(roleOfRun({ data: { kind: 'checkin' } }), 'checkin'); assert.equal(roleOfRun({ data: { kind: 'worker', lane: 'door-32' } }), 'merge');
  assert.equal(roleOfRun({ data: { kind: 'worker', lane: 'water' } }), 'worker');
});

test('explain: the standing context split into its parts from the first request, ~tokens shared out by characters of the measured turn 1', () => {
  const st = mkTmp('meta-sc-'), f = transcriptFile(path.join(path.dirname(st), 'projects'), 'sid-2');
  const h = transcriptHead(f), s = splitParts(h);
  const by = Object.fromEntries(s.parts.map(p => [p.key, p]));
  for (const k of ['base', 'agent', 'norn', 'claude_md', 'memory', 'hooks', 'skills', 'plugins', 'agents', 'mcp', 'prompt']) assert.ok(by[k]?.chars > 0, `part ${k}: ${JSON.stringify(by[k])}`);
  assert.equal(by.base.ours, false, 'the harness base prompt + tool schemas: shown, not ours to trim');
  assert.ok(by.skills.items.some(i => i.name === 'kestrel-tests')); assert.ok(by.plugins.items.some(i => i.name === 'superpowers:brainstorming'));
  assert.ok(by.memory.items.some(i => /MEMORY\.md$/.test(i.name))); assert.ok(by.claude_md.items.some(i => /CLAUDE\.md$/.test(i.name)));
  assert.ok(by.mcp.items.some(i => i.name === 'mcp__norn__norn_status'));
  assert.equal(s.parts.reduce((n, p) => n + p.tokens, 0), 22002, 'the parts add up to the measured turn 1 (rounding aside)');
  assert.equal(s.method, 'request'); assert.match(STANDING_METHOD, /first API call/); assert.ok(PARTS.every(p => p.key && p.label));
  // no request shape (an older CLI): the parts from the attachments, the rest is the harness base
  const old = w(path.join(path.dirname(st), 'old.jsonl'), [L({ type: 'attachment', attachment: { type: 'skill_listing', content: '- a: b\n- p:q: r\n' } }),
    L({ type: 'attachment', attachment: { type: 'hook_additional_context', content: ['x'.repeat(400)] } }), asst(1, '2026-11-13T10:00:00Z', 1000, 1000)].join('\n') + '\n');
  const o = splitParts(transcriptHead(old));
  assert.equal(o.method, 'attachments'); assert.ok(o.parts.find(p => p.key === 'hooks').tokens === 100);
  assert.equal(o.parts.reduce((n, p) => n + p.tokens, 0), 2002);
});

test('per role and per day: median standing context, cache create, the day\'s cache-read total (runs.jsonl + the chat\'s segments; codex rows from the rollout)', () => {
  const st = mkTmp('meta-sc-'), base = path.dirname(st), pdir = path.join(base, 'projects'), cdir = path.join(base, 'codex');
  transcriptFile(pdir, 'w1', { cr: [10000, 20000] }); transcriptFile(pdir, 'w2', { cr: [14000, 20000], create: 8000 }); transcriptFile(pdir, 'c1', { agent: null, cr: [30000], day: '2026-11-12' });
  transcriptFile(pdir, 'chat1', { agent: null, cr: [40000, 41000] });
  w(path.join(cdir, '2026', '11', '13', 'rollout-2026-11-13T10-00-00-cx1.jsonl'), [L({ type: 'event_msg', timestamp: '2026-11-13T10:00:01Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 9000, cached_input_tokens: 2000, total_tokens: 9100 }, total_token_usage: { input_tokens: 9000, cached_input_tokens: 2000, total_tokens: 9100 } } } }),
    L({ type: 'event_msg', timestamp: '2026-11-13T10:00:05Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 9500, cached_input_tokens: 9000 }, total_token_usage: { input_tokens: 18500, cached_input_tokens: 11000, total_tokens: 18700 } } } })].join('\n') + '\n');
  const start = (sid, at, data) => record(st, { kind: 'run', ev: 'start', by: 'launcher', data: { executor: 'claude', lane: 'water', session_id: sid, ...data } }, { now: () => new Date(at), run: null });
  start('w1', '2026-11-13T09:00:00Z', { kind: 'worker' }); start('w2', '2026-11-13T09:30:00Z', { kind: 'worker' }); start('c1', '2026-11-12T09:00:00Z', { kind: 'checkin', lane: 'checkin' });
  start('cx1', '2026-11-13T09:00:00Z', { kind: 'codex', executor: 'codex-sol' });
  w(path.join(st, 'chat', 'thread.jsonl'), L({ kind: 'segment', ts: '2026-11-13T09:00:00Z', n: 1, session_id: 'chat1', why: 'first' }) + '\n');
  const runs = standingRuns(st, { executors: {} }, { projectsDir: pdir, codexDir: cdir, now: Date.parse('2026-11-13T12:00:00Z'), days: 7 });
  assert.equal(runs.length, 5);
  const cx = runs.find(r => r.family === 'codex');
  assert.deepEqual([cx.turn1, cx.cache_read, cx.turns], [9000, 11000, 2]);
  const s = standingSummary(runs);
  const role = k => s.roles.find(r => r.key === k);
  assert.equal(role('worker').runs, 2); assert.equal(role('worker').median_turn1, 22002);
  assert.equal(role('worker').median_create1, (12000 + 8000) / 2);
  assert.equal(role('checkin').runs, 1); assert.equal(role('chat').runs, 1); assert.equal(role('worker (codex)').median_turn1, 9000);
  const d13 = s.days.filter(d => d.day === '2026-11-13'), w13 = d13.find(d => d.role === 'worker');
  assert.equal(w13.cache_read, 30000 + 34000); assert.equal(s.days.find(d => d.day === '2026-11-12' && d.role === 'checkin').cache_read, 30000);
  assert.ok(s.parts.worker?.parts?.length > 5, 'the latest worker run with a request shape explains the split');
  assert.equal(s.method, STANDING_METHOD);
});

// ---------- lean launch profiles: data in policy, flags in the adapters ----------
test('profiles: "full" (default) adds no flag but a worker\'s strict MCP - the command stays byte-same otherwise; "lean" maps to the adapter\'s flags and never --bare', () => {
  assert.deepEqual(profileOf({}, 'checkin'), { name: 'full', ...PROFILE_DEFAULTS.full });
  assert.deepEqual(profileOf({}, 'worker'), { name: 'full', mcp: 'none', ...PROFILE_DEFAULTS.full }, 'proc-hygiene (4): a worker loads no MCP server of the owner\'s setup');
  assert.deepEqual(profileOf({}, 'merge').mcp, 'none');
  assert.deepEqual(profileOf({ launch: { profiles: { full: { mcp: 'all' } } } }, 'worker').mcp, 'all', 'a profile that sets mcp wins');
  const pol = { launch: { roles: { worker: 'lean' }, profiles: { lean: { skills: true } } } };
  const lean = profileOf(pol, 'worker');
  assert.equal(lean.name, 'lean'); assert.equal(lean.skills, true, 'a project override keeps the skills'); assert.equal(profileOf(pol, 'checkin').name, 'full');
  const C = ADAPTERS.claude;
  assert.deepEqual(C.profileArgs(profileOf({}, 'checkin')), []);
  assert.deepEqual(C.profileArgs(profileOf({}, 'worker')), ['--strict-mcp-config']);
  const all = C.profileArgs({ name: 'lean', ...PROFILE_DEFAULTS.lean });
  assert.deepEqual(all, ['--strict-mcp-config', '--setting-sources', 'project,local', '--exclude-dynamic-system-prompt-sections', '--disallowedTools', 'Artifact,Workflow,ScheduleWakeup,ReportFindings'],
    'lean = the calibration (NOTES): skills kept, the unused harness tools dropped');
  assert.ok(C.profileArgs({ name: 'x', skills: false }).includes('--disable-slash-commands'));
  assert.ok(!all.includes('--bare'));
  assert.ok(!C.profileArgs(lean).includes('--disable-slash-commands'));
  assert.ok(C.profileArgs({ name: 'x', tools: ['Read', 'Edit'], disallowed_tools: ['WebFetch'] }).join(' ').includes('--tools Read,Edit --disallowedTools WebFetch'));
  assert.throws(() => C.profileArgs({ name: 'x', bare: true }), /never --bare/);
  // codex / cli: no profile flags known - a stated gap, the command unchanged
  assert.deepEqual(ADAPTERS.codex.profileArgs({ name: 'lean', ...PROFILE_DEFAULTS.lean }), []);
  assert.match(ADAPTERS.codex.profileGap, /no/i);
  const spec = { executor: 'claude', exe: 'claude', lane: 'l', model: 'm', effort: 'e', session_id: 's', worktree: 'C:/w', brief: 'C:/b.md', notes: 'C:/n.md' };
  const a = buildCommand(spec).args, b = buildCommand({ ...spec, profile: profileOf({}, 'checkin') }).args;
  assert.deepEqual(a, b, 'full = today\'s launch');
  assert.deepEqual(buildCommand({ ...spec, profile: profileOf({}, 'worker') }).args, [...a, '--strict-mcp-config'], 'a worker: today\'s launch + strict MCP');
  const l = buildCommand({ ...spec, profile: { name: 'lean', ...PROFILE_DEFAULTS.lean }, mcp: { name: 'norn', command: 'node', args: [] } }).args;
  assert.equal(l.filter(x => x === '--strict-mcp-config').length, 1); assert.ok(l.includes('--exclude-dynamic-system-prompt-sections'));
  const ro = buildCommand({ ...spec, readonly: true, profile: { name: 'lean', ...PROFILE_DEFAULTS.lean } }).args;
  assert.equal(ro.filter(x => x === '--disallowedTools').length, 1, 'one --disallowedTools list');
  assert.match(ro[ro.indexOf('--disallowedTools') + 1], /^Bash,.*Artifact,Workflow/);
  const chat = ADAPTERS.claude.chatCommand({ exe: 'claude', model: 'm', effort: 'e', session_id: 's', profile: { name: 'lean', ...PROFILE_DEFAULTS.lean } }).args;
  assert.equal(chat.filter(x => x === '--disallowedTools').length, 1); assert.equal(chat.filter(x => x === '--strict-mcp-config').length, 1);
  assert.deepEqual(ADAPTERS.claude.chatCommand({ exe: 'claude', model: 'm', effort: 'e', session_id: 's', profile: { name: 'full' } }).args, ADAPTERS.claude.chatCommand({ exe: 'claude', model: 'm', effort: 'e', session_id: 's' }).args);
});

// proc-hygiene (4): every worker loaded the owner's Ansys / agentmemory MCP servers. Strict by default; a server the project or lane
// names comes from the owner's config into the one --mcp-config, beside Norn's own
test('worker MCP: none by default; launch.mcp_servers + lane_mcp_servers name the servers, read from the owner\'s .claude.json / the worktree\'s .mcp.json', async () => {
  const { launchParts, mcpServersOf } = await import('../engine/lib/launchpolicy.mjs');
  const t = mkTmp('meta-mcp-'), claudeDir = path.join(t, '.claude'), wt = path.join(t, 'wt');
  fs.mkdirSync(claudeDir, { recursive: true }); fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(t, '.claude.json'), JSON.stringify({ mcpServers: { ansys: { command: 'ansys.exe', args: [] }, memory: { command: 'npx', args: ['m'] } } }));
  fs.writeFileSync(path.join(wt, '.mcp.json'), JSON.stringify({ mcpServers: { local: { command: 'l', args: [] } } }));
  const policy = { launch: { mcp_servers: ['local'], lane_mcp_servers: { 'fea-*': ['ansys', 'gone'] } } };
  assert.deepEqual(mcpServersOf(policy, 'fea-1'), ['local', 'ansys', 'gone']);
  assert.deepEqual(mcpServersOf(policy, 'docs'), ['local']);
  assert.deepEqual(mcpServersOf({}, 'x'), []);
  const p = launchParts({ project: { policy }, executor: 'claude', lane: 'fea-1', claudeDir, worktree: wt }).profile;
  assert.equal(p.mcp, 'none');
  assert.deepEqual(Object.keys(p.mcp_servers), ['local', 'ansys']); assert.deepEqual(p.mcp_missing, ['gone']);
  const spec = { executor: 'claude', exe: 'claude', lane: 'fea-1', model: 'm', effort: 'e', session_id: 's', worktree: wt, brief: 'C:/b.md', notes: 'C:/n.md' };
  const args = buildCommand({ ...spec, profile: p, mcp: { name: 'norn', command: 'node', args: ['n'] } }).args;
  assert.equal(args.filter(x => x === '--mcp-config').length, 1); assert.equal(args.filter(x => x === '--strict-mcp-config').length, 1);
  assert.deepEqual(Object.keys(JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers), ['local', 'ansys', 'norn']);
  const none = buildCommand({ ...spec, profile: launchParts({ project: {}, executor: 'claude', lane: 'x', claudeDir, worktree: wt }).profile }).args;
  assert.ok(none.includes('--strict-mcp-config') && !none.includes('--mcp-config'), 'no server named: strict, none loaded');
});

test('profile drops: a lean profile that drops the skills / user setup a brief or agent file names is a doctor row', () => {
  const st = mkTmp('meta-sc-'), base = path.dirname(st);
  const agent = w(path.join(base, 'agents', 'kestrel-implementer.md'), '---\nname: kestrel-implementer\n---\nCovering tests only (skill kestrel-tests). Use mcp__claude_ai_Docs when asked; show it as an Artifact.\n');
  const drops = profileDrops({ name: 'lean', ...PROFILE_DEFAULTS.lean, skills: false }, { role: 'worker', files: [agent], skills: ['kestrel-tests', 'kestrel-capture'] });
  assert.ok(drops.some(d => d.what === 'skill' && d.name === 'kestrel-tests' && d.file === agent), JSON.stringify(drops));
  assert.ok(drops.some(d => d.what === 'mcp')); assert.ok(drops.some(d => d.what === 'tool' && d.name === 'Artifact'));
  assert.ok(!profileDrops({ name: 'lean', ...PROFILE_DEFAULTS.lean }, { role: 'worker', files: [agent], skills: ['kestrel-tests'] }).some(d => d.what === 'skill'), 'lean keeps the skills');
  assert.deepEqual(profileDrops({ name: 'full', ...PROFILE_DEFAULTS.full }, { role: 'worker', files: [agent], skills: ['kestrel-tests'] }), []);
});

test('norn doctor rows: a project whose worker profile is lean names the skills and MCP servers its agent files / briefs need', async () => {
  const { profileDoctorLines } = await import('../engine/lib/standing.mjs');
  const st = mkTmp('meta-sc-'), base = path.dirname(st), home = path.join(base, 'home');
  w(path.join(base, 'p', 'agents', 'kestrel-implementer.md'), 'Covering tests only (skill kestrel-tests).\n');
  w(path.join(base, 'p', 'skills', 'kestrel-tests', 'SKILL.md'), '---\nname: kestrel-tests\n---\n');
  w(path.join(base, 'briefs', 'task-x.md'), 'Use mcp__claude_ai_Docs__create.\n');
  const p = { name: 'kestrel', install: { agents: path.join(base, 'p', 'agents'), skills: path.join(base, 'p', 'skills') }, briefs_dir: path.join(base, 'briefs'), policy: {} };
  assert.deepEqual(profileDoctorLines(p, { home }), [], 'full (default): nothing dropped');
  const lines = profileDoctorLines({ ...p, policy: { launch: { roles: { worker: 'lean' }, profiles: { lean: { skills: false } } } } }, { home });
  assert.ok(lines.some(l => /kestrel-tests/.test(l) && /kestrel-implementer\.md/.test(l)), lines.join('\n'));
  assert.ok(lines.some(l => /mcp__claude_ai_Docs/.test(l) && /task-x\.md/.test(l)), lines.join('\n'));
});

test('lean without the user setup: a user-level agent goes inline (--agents), a project agent stays on its own; full is untouched', async () => {
  const { inlineAgent, agentDef } = await import('../engine/lib/launchpolicy.mjs');
  const st = mkTmp('meta-sc-'), base = path.dirname(st), cfg = path.join(base, 'home', '.claude'), wt = path.join(base, 'wt');
  w(path.join(cfg, 'agents', 'kestrel-runner.md'), '---\nname: kestrel-runner\ndescription: Cheap mechanical work\nmodel: sonnet\ntools: Bash, Read, Skill\n---\n\nYou are a runner.\n');
  w(path.join(wt, '.claude', 'agents', 'local-one.md'), '---\nname: local-one\n---\nx\n');
  assert.deepEqual(agentDef(path.join(cfg, 'agents', 'kestrel-runner.md')), { description: 'Cheap mechanical work', prompt: '\nYou are a runner.\n', tools: ['Bash', 'Read', 'Skill'], model: 'sonnet' });
  const lean = { name: 'lean', ...PROFILE_DEFAULTS.lean };
  const p = inlineAgent(lean, 'kestrel-runner', { claudeDir: cfg, worktree: wt });
  assert.equal(p.agents['kestrel-runner'].prompt, '\nYou are a runner.\n');
  const args = ADAPTERS.claude.profileArgs(p), i = args.indexOf('--agents');
  assert.ok(i > 0 && JSON.parse(args[i + 1])['kestrel-runner'].tools.includes('Skill'));
  assert.equal(inlineAgent(lean, 'local-one', { claudeDir: cfg, worktree: wt }).agents, undefined, 'a project agent loads with the project source');
  assert.equal(inlineAgent({ name: 'full' }, 'kestrel-runner', { claudeDir: cfg }).agents, undefined);
  const spec = { executor: 'claude', exe: 'claude', lane: 'l', model: 'm', effort: 'e', session_id: 's', worktree: wt, brief: 'C:/b.md', notes: 'C:/n.md', agent: 'kestrel-runner' };
  const a = buildCommand({ ...spec, profile: p }).args;
  assert.ok(a.includes('--agent') && a.includes('--agents'));
});
