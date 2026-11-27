// S5 status + tick + scheduler (META-GENERAL-DESIGN D13, 3.6, 12-S5): temp dirs only, FAKE claude only, no live scheduler.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cacheRSince, jsonCacheRSince } from '../engine/lib/usage.mjs';
import { buildStatus, ciMainLine, weeklyEstimate } from '../engine/lib/status.mjs';
import { renderCheckin, tick } from '../engine/lib/tick.mjs';
import { ADAPTERS, adapterFor } from '../engine/lib/sched/index.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { STALE_MS } from '../engine/lib/runs.mjs';
import { settled } from './helpers/settled.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'status');
const GOLD = path.join(HERE, 'golden', 'sched');
const META = path.join(HERE, '..', 'engine', 'bin', 'norn.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
// the deadline runs on the monotonic clock: a wall-clock step (the WSL runner's clock steps ~16 s) never expires it early
async function waitFor(fn, ms = 20000) {
  const t0 = performance.now();
  for (;;) { const v = fn(); if (v) return v; if (performance.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(50); }
}
const tmp = p => mkTmp(p);
const readBudget = () => JSON.parse(fs.readFileSync(path.join(FIX, 'BUDGET.json'), 'utf8').replace(/^\uFEFF/, ''));
const LINES = fs.readFileSync(path.join(FIX, 'transcript.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

// fixture transcript re-timed so its last record is `endAgoMin` before now; `tag` renames ids (a distinct session)
function transcript(file, endAgoMin, tag = '', mtime = new Date()) {
  const last = Date.parse(LINES.at(-1).timestamp), shift = Date.now() - endAgoMin * 60000 - last;
  const out = LINES.map(j => JSON.stringify({ ...j, timestamp: new Date(Date.parse(j.timestamp) + shift).toISOString(), requestId: j.requestId + tag, message: { ...j.message, id: j.message.id + tag } }));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.join('\n') + '\n{"type":"user","message":{"content":"no usage"}}\nnot json "usage"\n');
  fs.utimesSync(file, mtime, mtime);
}
function jsonAt(file, src, agoMin) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(src, file);
  const t = new Date(Date.now() - agoMin * 60000);
  fs.utimesSync(file, t, t);
}

// fixed totals land inside 0.01 - deterministic, the transcripts are fixed data). 1e-9: float noise at the 0.01 edge
const near = (a, b) => Math.abs(a - b) <= 0.01 + 1e-9;
const grab = (txt, re) => { const m = txt.match(re); assert.ok(m, `no ${re} in\n${txt}`); return m; };
const num = s => Number(s.replace(/,/g, ''));

test('usage: offset-cached transcript reader = tokens.js semantics, re-reads only appended bytes', () => {
  const t = tmp('meta-usage-');
  const f = path.join(t, 'p', 'C--x', 'a.jsonl');
  transcript(f, 10);
  const since = Date.now() - 3600000, cacheFile = path.join(t, 'usage-cache.json');
  const dedup = new Map(); for (const j of LINES) dedup.set(j.message.id + ':' + j.requestId, j.message.usage.cache_read_input_tokens);
  const want = [...dedup.values()].reduce((a, b) => a + b, 0);
  const r1 = cacheRSince(path.join(t, 'p'), since, { cacheFile });
  assert.equal(r1.cr, want);
  assert.equal(r1.bytesRead, fs.statSync(f).size);
  const extra = JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), requestId: 'r-new', message: { id: 'm-new', usage: { cache_read_input_tokens: 1000 } } }) + '\n';
  fs.appendFileSync(f, extra + '{"partial": "usage"');      // a torn last line is not consumed yet
  const r2 = cacheRSince(path.join(t, 'p'), since, { cacheFile });
  assert.equal(r2.cr, want + 1000);
  assert.equal(r2.bytesRead, Buffer.byteLength(extra));
  assert.equal(cacheRSince(path.join(t, 'p'), Date.now() - 60000, { cacheFile }).cr, 1000, 'window filter by record timestamp');
  fs.writeFileSync(f, extra);                                  // rewritten (smaller) file -> read from 0
  assert.equal(cacheRSince(path.join(t, 'p'), since, { cacheFile }).cr, 1000);
  assert.equal(jsonCacheRSince([path.join(t, 'none', '*.json')], 0), 0);
});


function project(t, extra = {}) {
  const root = path.join(t, 'root'), state = path.join(t, 'state', 'demo');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(state, { recursive: true });
  const rules = path.join(t, 'RULES.md'); fs.writeFileSync(rules, 'rule 1\n');
  const extraF = path.join(t, 'CHECKIN-demo.md'); fs.writeFileSync(extraF, '## demo extra\n- ledger {{ledger}}\n');
  return { name: 'demo', root, state, file: path.join(t, 'project.json'), ledger: path.join(t, 'progress.md'), briefs_dir: t,
    rules_read_whole: [rules], checkin_extra: extraF, checkin: { cwd: root, add_dirs: [t] }, views: {}, ...extra };
}

test('status: runs of all projects vs caps, NEW since the last tick, Records block, lost sweep', async () => {
  const t = tmp('meta-st2-');
  const p = project(t);
  const other = path.join(t, 'state', 'other'); fs.mkdirSync(other, { recursive: true });
  const live = record(other, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'x', worktree: t, brief: 'b' } });
  fs.mkdirSync(path.join(other, 'hb'), { recursive: true }); fs.writeFileSync(path.join(other, 'hb', live.id + '.hb'), '{}');
  const ended = record(p.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'codex', executor: 'codex-sol', lane: 'y', worktree: t, brief: 'b', notes: path.join(t, 'N.md') } });
  fs.writeFileSync(path.join(t, 'N.md'), '## S\nx\n## DONE\n');
  record(p.state, { kind: 'run', ev: 'end', id: ended.id, by: 'launcher', data: { exit: 0, outcome: 'done' } });
  const dead = record(p.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'z', worktree: t, brief: 'b' } }, { now: () => new Date(Date.now() - 600000) });
  record(p.state, { kind: 'question', ev: 'create', by: 'checkin', data: { title: 'pick one', lane: 'y', options: [], blocks: [] } });
  fs.writeFileSync(path.join(p.state, 'last-tick.txt'), new Date(Date.now() - 3600000).toISOString());
  const s = buildStatus({ state: p.state, project: 'demo', budget: { ...readBudget(), max_claude_workers: 3 }, projectsDir: path.join(t, 'none'), usageJson: {}, cacheFile: path.join(t, 'uc.json') });
  assert.match(s.text, /^- claude workers alive: 1 \/ cap 3$/m);
  assert.match(s.text, /^- codex exec runs: 0 \/ cap 2$/m);
  assert.match(s.text, new RegExp(`^- NEW \\*\\*${ended.id}\\*\\* y codex-sol: EXITED outcome=done exit=0`, 'm'));
  assert.match(s.text, /^  - NOTES L3: ## DONE$/m);
  assert.equal(loadState(p.state).items[dead.id].state, 'lost');
  assert.match(s.text, /^## Records$/m);
  assert.match(s.text, /^- Q-1 open .*pick one/m);
  assert.match(s.text, new RegExp(`^- ${ended.id} exited unreviewed`, 'm'));
  // DEC-a-679: a reviewed run that is not NEW is one line; paths are relative to STATE; no NOTES file = no NOTES line; a directive shows 80 chars
  const old = record(p.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'w', worktree: t, brief: path.join(p.state, 'briefs', 'b.md'), log: path.join(p.state, 'logs', 'w.log') } }, { now: () => new Date(Date.now() - 7200000) });
  record(p.state, { kind: 'run', ev: 'end', id: old.id, by: 'launcher', data: { exit: 0, outcome: 'done' } }, { now: () => new Date(Date.now() - 7100000) });
  record(p.state, { kind: 'run', ev: 'review', id: old.id, by: 'checkin', data: { refs: ['DEC-1'] } }, { now: () => new Date(Date.now() - 7000000) });
  const fresh = record(p.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'v', worktree: t, brief: path.join(p.state, 'briefs', 'v.md'), log: path.join(p.state, 'logs', 'v.log'), notes: path.join(t, 'none.md') } });
  fs.mkdirSync(path.join(p.state, 'hb'), { recursive: true }); fs.writeFileSync(path.join(p.state, 'hb', fresh.id + '.hb'), '{}');
  record(p.state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'x'.repeat(200) + '\nsecond line', via: 'cli' } });
  const s2 = buildStatus({ state: p.state, project: 'demo', budget: { ...readBudget(), max_claude_workers: 3 }, projectsDir: path.join(t, 'none'), usageJson: {}, cacheFile: path.join(t, 'uc.json') });
  assert.match(s2.text, new RegExp(`^- ${old.id} w exited/done\\r?$`, 'm'));
  assert.doesNotMatch(s2.text, new RegExp(`\\*\\*${old.id}\\*\\*`));
  assert.match(s2.text, new RegExp(`^- \\*\\*${fresh.id}\\*\\* v claude: RUNNING since .* \\| brief briefs/v\\.md\\r?$`, 'm'));
  assert.match(s2.text, /^  - log logs\/v\.log\r?$/m);
  assert.doesNotMatch(s2.text, /no NOTES/);
  assert.match(s2.text, new RegExp(`^- DIR-\\d+ active: ${'x'.repeat(80)}\\r?$`, 'm'));
});

test('CHECKIN rendering: generic prompt + project extra, every placeholder filled', () => {
  const t = tmp('meta-ck-');
  const p = project(t);
  const out = renderCheckin(p, { budgetFile: path.join(t, 'budget.json') });
  const txt = fs.readFileSync(out, 'utf8');
  assert.equal(out, path.join(p.state, 'CHECKIN.rendered.md'));
  assert.doesNotMatch(txt, /\{\{/);
  assert.match(txt, /norn status/);
  assert.match(txt, /## demo extra\n- ledger .*progress\.md/);
  assert.ok(txt.includes(path.join(t, 'RULES.md').replace(/\\/g, '/')) || txt.includes(path.join(t, 'RULES.md')));
  // kestrel's CHECKIN-kestrel.md content: norn-projects tests/owner-config.test.mjs (META-ONBOARD S6)
  const gen = fs.readFileSync(path.join(HERE, '..', 'engine', 'prompts', 'CHECKIN.md'), 'utf8');
  for (const s of ['OVERNIGHT', 'Fable', 'kestrel', 'worker.ps1', 'codex-impl.sh', 'OWNER-QUESTIONS.md']) assert.ok(!gen.includes(s), `generic CHECKIN.md mentions ${s}`);
  // a pass with every lane done must still start the roadmap's `now` stages and the directives with no action (it said "no queued work")
  assert.match(txt, /^## 2i\. New work from the roadmap and the directives/m);
  assert.match(txt, /Directives with no action/); assert.match(txt, /horizon `now`/); assert.match(txt, /--queue/);
  assert.match(txt, /The critical path = .*policy\.critical_lanes/);
});

test('tick: PAUSED exits first; dry tick launches the check-in as RUN kind checkin (FAKE claude); second tick sees it running', async () => {
  const t = tmp('meta-tick-');
  const p = project(t);
  const budget = { ...readBudget(), calib_time_utc: new Date().toISOString() };
  const machine = { claude: { exe: 'never-used', projects_dir: path.join(t, 'none') } };
  // staleness is not under test here: the production threshold (a 3 s one made a 16 s wall-clock step on the WSL runner read the
  // live check-in as lost, and the second tick launched RUN-2)
  const base = { project: p, machine, budget, budgetFile: path.join(t, 'budget.json'), reason: 'test', dry: true, hbMs: 150, staleMs: STALE_MS };
  fs.writeFileSync(path.join(p.state, 'PAUSED'), '');
  let r = tick(base);
  assert.equal(r.code, 0); assert.match(r.msg, /PAUSED/);
  assert.ok(!fs.existsSync(path.join(p.state, 'STATUS.md')), 'PAUSED exits before status');
  fs.unlinkSync(path.join(p.state, 'PAUSED'));
  r = tick({ ...base, fakeMs: 1500 });
  assert.equal(r.code, 0, r.msg); assert.match(r.msg, /RUN-1/);
  assert.ok(fs.existsSync(path.join(p.state, 'STATUS.md')));
  assert.ok(fs.existsSync(path.join(p.state, 'last-tick.txt')));
  const run = loadState(p.state).items['RUN-1'];
  assert.equal(run.data.kind, 'checkin'); assert.equal(run.data.executor, 'fake'); assert.equal(run.data.lane, 'checkin');
  assert.equal(run.data.worktree, p.root);
  const r2 = tick(base);
  assert.equal(r2.code, 0); assert.match(r2.msg, /check-in RUN-1 running/);
  const end = await waitFor(() => { const i = loadState(p.state).items['RUN-1']; return i.state === 'exited' && settled(i) && i; });
  assert.equal(end.history.at(-1).data.outcome, 'done');
  assert.equal(Object.values(loadState(p.state).items).filter(i => i.kind === 'run').length, 1, 'check-in exit triggers no tick, no resume');
  fs.writeFileSync(path.join(p.state, 'tick.lock'), 'held');
  assert.match(tick(base).msg, /lock held/);
});

test('norn tick / norn status CLI on a project (dry), norn runs --unreviewed + review', async () => {
  const t = tmp('meta-tickcli-');
  const root = path.join(t, 'root'); fs.mkdirSync(root);
  const pj = path.join(t, 'project.json');
  fs.writeFileSync(pj, JSON.stringify({ schema: 1, name: 'demo', title: 'demo', root: root.replace(/\\/g, '/'), ledger: '${root}/progress.md', briefs_dir: '${root}', checkin: { cwd: '${root}' } }));
  const env = { ...process.env, META_ROOT: t, META_HB_MS: '150' };
  fs.mkdirSync(path.join(t, 'local')); fs.writeFileSync(path.join(t, 'local', 'budget.json'), JSON.stringify(readBudget()));
  let r = spawnSync(process.execPath, [META, 'status', '--project', pj], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /^status -> .*STATUS\.md \(rate [\d.]+ %\/h, claude alive 0, codex 0\)/);
  r = spawnSync(process.execPath, [META, 'tick', '--project', pj, '--dry', '--reason', 'cli'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /check-in RUN-1/);
  const state = path.join(t, 'state', 'demo');
  await waitFor(() => loadState(state).items['RUN-1']?.state === 'exited' && settled(loadState(state).items['RUN-1']));
  r = spawnSync(process.execPath, [META, 'runs', '--unreviewed', '--project', pj], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /RUN-1 +exited +done +checkin/);
  r = spawnSync(process.execPath, [META, 'runs', 'review', 'RUN-1', '--refs', 'Q-1', '--as', 'checkin', '--project', pj], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  r = spawnSync(process.execPath, [META, 'runs', '--unreviewed', '--project', pj], { env, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '');
});

const SCHED = { name: 'norn-tick', interval_min: 15, node: '/opt/node/bin/node', meta: '/srv/norn', home: '/srv/hm' };
test('scheduler goldens per OS (dry render: nothing installed)', () => {
  assert.deepEqual(Object.keys(ADAPTERS).sort(), ['cron', 'launchd', 'systemd', 'windows-task']);
  for (const kind of Object.keys(ADAPTERS)) {
    const o = kind === 'windows-task' ? { ...SCHED, node: 'C:/Program Files/nodejs/node.exe', meta: 'C:/norn', home: 'C:/home', user: 'HOST\\owner' } : SCHED;
    const plan = adapterFor(kind).plan(o);
    const flat = plan.files.map(f => `=== ${f.path}\n${f.content}`).join('') + plan.install.map(c => '$ ' + c.join(' ')).join('\n') + '\n--- remove\n' + plan.remove.map(c => '$ ' + c.join(' ')).join('\n') + '\n';
    const g = path.join(GOLD, kind + '.txt');
    if (process.env.META_UPDATE_GOLDEN) { fs.mkdirSync(GOLD, { recursive: true }); fs.writeFileSync(g, flat); }
    assert.equal(flat, fs.readFileSync(g, 'utf8'), kind);
  }
  const x = adapterFor('windows-task').plan({ ...SCHED, user: 'H\\o' }).files.find(f => f.path.endsWith('.task.xml')).content;
  for (const s of ['<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>', '<Hidden>true</Hidden>', '<ExecutionTimeLimit>PT55M</ExecutionTimeLimit>',
    '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>', '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>', '<Interval>PT15M</Interval>']) assert.ok(x.includes(s), s);
});

// proc-hygiene (8): the PowerShell action opened an empty Terminal window for every tick. The task runs wscript //B on a generated
// .vbs whose Run passes 0 (no window) and True (wait: IgnoreNew + the 55 min limit hold); doctor warns on a task still on PowerShell.
test('windows task: the action is wscript //B on local/<task>.vbs; the vbs runs the tick hidden (0) and waits (True); old action detected', async () => {
  const { oldAction } = await import('../engine/lib/sched/win.mjs');
  const { windowedSchedLines } = await import('../engine/lib/setup.mjs');
  const o = { ...SCHED, node: 'C:/Program Files/nodejs/node.exe', meta: 'C:/my norn', user: 'H\\o' };
  const p = adapterFor('windows-task').plan(o);
  const vbs = p.files.find(f => f.path === 'C:/my norn/local/norn-tick.vbs'), xml = p.files.find(f => f.path.endsWith('.task.xml')).content;
  assert.ok(vbs && vbs.encoding === 'utf16le', 'the vbs is generated (UTF-16: any path)');
  assert.match(xml, /<Command>wscript\.exe<\/Command><Arguments>\/\/B \/\/NoLogo &quot;C:\\my norn\\local\\norn-tick\.vbs&quot;<\/Arguments>/);
  assert.doesNotMatch(xml, /powershell/i);
  assert.equal(vbs.content.split('\n')[1], 'CreateObject("WScript.Shell").Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\my norn\\engine\\bin\\norn.mjs"" tick --reason schedule", 0, True');
  assert.ok(p.remove.some(c => c[0] === 'rm' && c[1] === vbs.path), 'remove deletes the vbs too');
  assert.equal(oldAction(xml), false);
  const oldXml = '<Exec><Command>powershell.exe</Command><Arguments>-WindowStyle Hidden -Command "&amp; node norn.mjs tick"</Arguments></Exec>';
  assert.equal(oldAction(oldXml), true);
  const io = xmlOut => ({ run: () => ({ status: 0, stdout: xmlOut }) });
  const machine = { scheduler: { kind: 'windows-task', name: 'norn-tick-1', interval_min: 15 }, node: o.node, home: 'C:/h' };
  assert.match(windowedSchedLines({ machine, meta: o.meta, io: io(oldXml) })[0], /task 'norn-tick-1' still starts the tick through powershell\.exe.*norn sched install/);
  assert.deepEqual(windowedSchedLines({ machine, meta: o.meta, io: io(xml) }), []);
});

test('scheduler install / remove go through the injected runner (cron keeps foreign lines)', () => {
  const calls = [], files = {};
  let tab = '0 1 * * * /usr/bin/backup\n';
  const io = { run: (cmd, args, input) => { calls.push([cmd, ...args].join(' ')); if (cmd === 'crontab' && args[0] === '-l') return { status: 0, stdout: tab }; if (cmd === 'crontab' && args[0] === '-') tab = input; return { status: 0, stdout: '' }; },
    write: (f, c) => { files[f] = c; }, rm: f => { delete files[f]; } };
  const cron = adapterFor('cron');
  cron.install(SCHED, io);
  assert.match(tab, /^0 1 \* \* \* \/usr\/bin\/backup\n\*\/15 \* \* \* \* .*tick --reason schedule .*# norn:norn-tick\n$/);
  cron.install(SCHED, io);
  assert.equal(tab.split('\n').filter(l => l.includes('# norn:')).length, 1, 'idempotent');
  cron.remove(SCHED, io);
  assert.equal(tab, '0 1 * * * /usr/bin/backup\n');
  const sd = adapterFor('systemd');
  sd.install(SCHED, io);
  assert.deepEqual(Object.keys(files).sort(), ['/srv/hm/.config/systemd/user/norn-tick.service', '/srv/hm/.config/systemd/user/norn-tick.timer']);
  sd.remove(SCHED, io);
  assert.deepEqual(files, {});
  assert.ok(calls.includes('systemctl --user enable --now norn-tick.timer') && calls.includes('systemctl --user disable --now norn-tick.timer'));
});

test('status: CI main line from gh run list, cached 10 min, a gh failure reads unknown', () => {
  const t = tmp('meta-ci-');
  const now = new Date('2026-11-08T12:00:00Z');
  const cacheFile = path.join(t, 'ci-main.json');
  let calls = 0;
  const run = [{ conclusion: 'failure', status: 'completed', headSha: 'cf2b2ce63aaaaaaaa', createdAt: '2026-11-07T06:47:35Z' }];
  const gh = args => { calls++; assert.deepEqual(args, ['run', 'list', '--repo', 'o/r', '--workflow', 'ci.yml', '--branch', 'main', '-L', '10', '--json', 'databaseId,conclusion,status,headSha,createdAt']); return JSON.stringify(run); };
  assert.equal(ciMainLine({ repo: 'o/r', gh, cacheFile, now }), 'CI main: failure cf2b2ce63 1d5h');
  assert.equal(ciMainLine({ repo: 'o/r', gh, cacheFile, now: new Date(now.getTime() + 9 * 60000) }), 'CI main: failure cf2b2ce63 1d5h', 'cached');
  assert.equal(calls, 1);
  run[0] = { conclusion: '', status: 'in_progress', headSha: '66f342153bbbb', createdAt: '2026-11-08T11:15:00Z' };
  assert.equal(ciMainLine({ repo: 'o/r', gh, cacheFile, now: new Date(now.getTime() + 11 * 60000) }), 'CI main: in_progress 66f342153 56m', 'refetched after 10 min');
  assert.equal(calls, 2);
  const broken = () => { throw new Error('gh: not logged in'); };
  assert.equal(ciMainLine({ repo: 'o/r', gh: broken, cacheFile: path.join(t, 'other.json'), now }), 'CI main: unknown');
  assert.equal(ciMainLine({ repo: 'o/r', gh: () => '[]', cacheFile: path.join(t, 'empty.json'), now }), 'CI main: unknown');
  const p = project(t);
  const s = buildStatus({ state: p.state, project: 'demo', budget: readBudget(), projectsDir: path.join(t, 'none'), usageJson: {}, cacheFile: path.join(t, 'uc.json'),
    ci: { repo: 'o/r', gh, cacheFile, now: new Date(now.getTime() + 11 * 60000) } });
  assert.match(s.text, /^CI main: in_progress 66f342153 56m\r$/m);
});

// META-USAGE-WEEK: the weekly estimate rolls at the weekly reset; the rate window is always the trailing 2 h (fixed clock)
import { parseReset, nextReset } from '../engine/lib/cost.mjs';
import { usageRefusal } from '../engine/lib/usageguard.mjs';
function weekFixture(recs) {   // recs: [[ms, cacheR]] -> one transcript under a temp projects dir (mtime = the last record)
  const t = tmp('meta-week-'), f = path.join(t, 'p', 'C--w', 'w.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, recs.map(([ms, cr], i) => JSON.stringify({ type: 'assistant', timestamp: new Date(ms).toISOString(), requestId: 'r' + i, message: { id: 'm' + i, usage: { cache_read_input_tokens: cr } } })).join('\n') + '\n');
  const last = new Date(Math.max(...recs.map(r => r[0]))); fs.utimesSync(f, last, last);
  const state = path.join(t, 'state', 'demo'); fs.mkdirSync(state, { recursive: true });
  return { t, state, projectsDir: path.join(t, 'p') };
}
const H = 3600000, R = Date.parse(parseReset('2026-11-04T08:00 local'));   // a reset instant; the week starts at R + k * 7 d
const wkBudget = calibMs => ({ reset: '2026-11-04T08:00 local', calib_time_utc: new Date(calibMs).toISOString().replace(/:\d\d\.\d+Z$/, 'Z'), calib_pct: 90,
  cacheR_per_pct: 10000000, usage_rate_cap_pct_per_h: 0.43, weekly_stop_pct: 98 });
const wkStatus = (fx, budget, now) => buildStatus({ state: fx.state, project: 'demo', budget, projectsDir: fx.projectsDir, usageJson: {}, now: new Date(now) });
const weeklyOf = s => num(grab(s.text, /^- estimated weekly now ~([\d.,]+) %/m)[1]);

test('usage week (a): a calibration inside the current week -> calib_pct + cacheR since it; the line names the NEXT reset', () => {
  const calib = R + 7 * 24 * H + 5 * 24 * H, now = calib + 3 * H;      // week 2026-11-11.., calib on day 5
  const fx = weekFixture([[calib - H, 500e6], [calib + H, 50e6]]);
  const s = wkStatus(fx, wkBudget(calib), now);
  assert.equal(weeklyOf(s), 95);
  assert.match(grab(s.text, /^- estimated weekly now .*$/m)[0], new RegExp(`reset ${new Date(R + 14 * 24 * H).toISOString().slice(0, 16)}Z$`));
});

test('usage week (b): the same budget one minute after the weekly reset -> 0 + cacheR since the reset, the guard allows', () => {
  const calib = R + 5 * 24 * H, reset2 = R + 7 * 24 * H;
  const old = [[calib + H, 90e6], [reset2 - 30 * 60000, 40e6]];
  const before = wkStatus(weekFixture(old), wkBudget(calib), reset2 - 60000);
  const fx = weekFixture([...old, [reset2 + 30000, 20e6]]), after = wkStatus(fx, wkBudget(calib), reset2 + 60000);
  assert.equal(weeklyOf(before), 103, 'old week: 90 + 13');
  assert.equal(weeklyOf(after), 2, 'new week: 0 + 20M / 10M');
  const sf = path.join(fx.t, 'STATUS.md'), spec = { budget: { weekly_stop_pct: 98 }, statusFile: sf };
  fs.writeFileSync(sf, before.text); assert.match(usageRefusal(spec, fx.state, { rate: false }), /weekly 103.0 % >= guard 98/);
  fs.writeFileSync(sf, after.text); assert.equal(usageRefusal(spec, fx.state, { rate: false }), null);
  assert.match(after.text, /^- since week start .*: cache reads 20\.0M/m);
});

test('usage week (c): the rate window is the trailing 2 h even right after a calibration', () => {
  const calib = R + 2 * 24 * H, now = calib + 10 * 60000;
  const fx = weekFixture([[now - 90 * 60000, 2e6], [now - 5 * 60000, 2e6]]);
  const s = wkStatus(fx, wkBudget(calib), now);
  const m = grab(s.text, /^- trailing 2 h since (\S+): cache reads ([\d.]+)M over ([\d.]+) h = ([\d.]+) %\/h/m);
  assert.equal(m[1], new Date(now - 2 * H).toISOString().slice(0, 16) + 'Z');
  assert.deepEqual([m[2], m[3], m[4]], ['4.0', '2.0', '0.20']);
  assert.equal(s.rateOk, 1);
});

// META-GTP-FED-2 piece 2: node runs' Claude usage counts in the home guard. The home fill imports node runs into <state>/fed-cache.json
// (a full rewrite per import); every node run's end carries node_usage { tokens, cache_read }. Kill criterion: the estimate moves by
// EXACTLY a node run's cache_read / cacheR_per_pct - never 0, never twice.
function fedCache(state, nodes) {   // nodes: { node: [[id, endMs, cache_read | undefined]] } -> fed-cache.json (folded run items, as importForeign)
  const runs = rs => rs.map(([id, ms, cr]) => {
    const end = { ev: 'end', ts: new Date(ms).toISOString(), by: 'launcher', data: { exit: 0, outcome: 'done', ...(cr === undefined ? {} : { node_usage: { tokens: cr + 45, cache_read: cr } }) } };
    return { id, kind: 'run', state: 'exited', data: { kind: 'worker', executor: 'claude' }, history: [{ ev: 'start', ts: new Date(ms - H).toISOString(), data: {} }, end], end: end.data, updated: end.ts };
  });
  fs.writeFileSync(path.join(state, 'fed-cache.json'), JSON.stringify({ at: new Date().toISOString(), nodes: Object.fromEntries(Object.entries(nodes).map(([n, rs]) => [n, runs(rs)])) }));
}
test('usage + nodes: the weekly estimate and the 2 h rate add the cache_read of node runs ended since the anchor - exactly once, every project', () => {
  const calib = R + 7 * 24 * H + 5 * 24 * H, now = calib + 3 * H;
  const fx = weekFixture([[calib + H, 50e6]]);
  const o = { state: fx.state, project: 'demo', budget: wkBudget(calib), projectsDir: fx.projectsDir, usageJson: {}, now: new Date(now) };
  const before = weeklyEstimate(o, new Date(now)), sBefore = buildStatus(o);
  assert.equal(before.weekly, 95);
  fedCache(fx.state, { nodew: [['RUN-wsl-1', now - 30 * 60000, 7e6], ['RUN-wsl-0', calib - H, 900e6], ['RUN-wsl-2', now - 20 * 60000, undefined]] });
  const other = path.join(path.dirname(fx.state), 'other'); fs.mkdirSync(other);
  fedCache(other, { nodew: [['RUN-wsl-1', calib + 30 * 60000, 3e6]] });   // another project's node run (its own id space)
  const after = weeklyEstimate(o, new Date(now));
  assert.equal(after.all.nodes, 10e6, 'ended since the anchor: 7M + 3M; the run before the calibration and a run without usage add 0');
  assert.equal(after.weekly - before.weekly, 10e6 / 1e7, 'exactly the node cache_read / cacheR_per_pct');
  const s = buildStatus(o);
  assert.equal(weeklyOf(s), 96);
  assert.match(grab(s.text, /^- since calibration .*$/m)[0], /\(\+ nodes 10\.0M/);
  const rate = t => num(grab(t, /^- trailing 2 h since \S+: cache reads ([\d.]+)M/m)[1]);
  assert.equal(rate(s.text) - rate(sBefore.text), 7, 'the 2 h window: only the node run that ended inside it (7M)');
  fedCache(fx.state, { nodew: [['RUN-wsl-1', now - 30 * 60000, 7e6], ['RUN-wsl-0', calib - H, 900e6], ['RUN-wsl-2', now - 20 * 60000, undefined]] });   // the next fill re-imports
  assert.equal(weeklyEstimate(o, new Date(now)).weekly, after.weekly, 're-import = the same estimate (idempotent, never twice)');
});

// META-CONTROLLER C1 (C0 finding: norn_status took ~58 s on an empty state): with no usage calibration the status shows no usage
// figure, so it reads no transcript - a cold state (no usage-cache.json) used to parse every transcript under projects_dir since the
// epoch (the anchor of an unset calibration is no date), ~5.5 GB on the owner's machine, for a number it then did not print.
test('status: no usage calibration = no transcript read (no usage-cache written), the chat cache-read line still there', () => {
  const t = tmp('meta-status-uncal-'), state = path.join(t, 'state', 'p'), projects = path.join(t, 'projects');
  transcript(path.join(projects, 'C--x', 'a.jsonl'), 10);
  fs.mkdirSync(state, { recursive: true });
  const cacheFile = path.join(state, 'usage-cache.json');
  const r = buildStatus({ state, project: 'p', budget: { usage_rate_cap_pct_per_h: 1 }, projectsDir: projects, usageJson: {}, cacheFile });
  assert.match(r.text, /usage not estimated: no usage calibration yet/);
  assert.match(r.text, /dashboard chat cache reads included: 0\.00M/);
  assert.equal(r.weekly, null);
  assert.ok(!fs.existsSync(cacheFile), 'no transcript scan: the usage cache is not even created');
});
