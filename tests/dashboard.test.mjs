// S6 engine dashboard server (META-GENERAL-DESIGN 5-7, 12-S6): port of meta/dash/tests/dashboard.test.mjs onto fixture state
// dirs (records / runs / transcripts). Temp dirs only; the server binds 127.0.0.1 on a random port; no real claude / codex.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStatus } from '../engine/dash/server.mjs';
import { parseReset } from '../engine/lib/cost.mjs';
import { loadProject } from '../engine/lib/config.mjs';
import { record, loadState } from '../engine/lib/records.mjs';

import { HERE, ENGINE, FIX, SID, CSID, budget0, walkFiles, projectFile, fixture } from './helpers/dash-fixture.mjs';
import { GROK } from './helpers/command-matrix.mjs';


test('status and reset use file values and local calendar time', () => {
  const s = parseStatus('- since CALIB x: 0.61 % over 0.3 h = 1.98 %/h vs cap 0.43 -> OVER CAP\n- estimated weekly now ~54.6 %\nRATE_OK=0');
  assert.equal(s.rate, 1.98); assert.equal(s.cap, 0.43); assert.equal(s.weekly, 54.6); assert.equal(s.rateOK, false);
  assert.equal(new Date(parseReset(budget0.reset)).getHours(), 8);
  assert.equal(parseReset('nonsense'), null);
});

test('HTTP actions are authenticated, bounded and conflict-aware; buttons go through the records lib', async () => {
  const f = await fixture();
  try {
    const q = (await f.get('/api/inbox')).data.items.find(i => i.type === 'question');
    assert.equal(q.id, 'Q-1'); assert.equal(q.recommend.key, 'a');
    assert.equal((await f.post('/api/pause', { mode: 'checkins' })).status, 200);
    assert.equal((await f.post('/api/checkin', {})).status, 409);
    assert.equal((await f.post('/api/pause', { resume: 'all' })).status, 200);
    fs.writeFileSync(path.join(f.pa.state, 'tick.lock'), 'busy');
    assert.equal((await f.post('/api/checkin', {})).status, 409);
    assert.equal(f.counts.ticks, 0);
    fs.utimesSync(path.join(f.pa.state, 'tick.lock'), new Date(Date.now() - 51 * 60000), new Date(Date.now() - 51 * 60000));
    assert.equal((await f.post('/api/checkin', {})).status, 200, 'a tick.lock older than 50 min is stale');
    assert.equal(f.counts.ticks, 1);
    assert.equal((await f.post('/api/answer', { id: 'Q-1', text: 'yes\nnext', choice: 'a' })).status, 200);
    const it = loadState(f.pa.state).items['Q-1'];
    assert.equal(it.state, 'answered'); assert.equal(it.answer.text, 'yes next'); assert.equal(it.answer.via, 'dashboard'); assert.equal(it.history.at(-1).by, 'dashboard');
    assert.match(fs.readFileSync(path.join(f.pa.state, 'views', 'OWNER-QUESTIONS.md'), 'utf8'), /yes next/, 'views regenerated');
    assert.equal((await f.post('/api/answer', { id: 'Q-1', text: 'twice' })).status, 409);
    assert.equal((await f.post('/api/answer', { id: 'Q-1', text: '' })).status, 400);
    assert.equal((await f.post('/api/directive', { text: 'hold gen' })).status, 200);
    assert.equal((await f.post('/api/directive/revoke', { id: 'DIR-1' })).status, 200);
    assert.equal((await f.post('/api/directive/revoke', { id: 'DIR-1' })).status, 409);
    assert.equal((await f.post('/api/decision/overrule', { id: 'DEC-1', text: 'no', rework_lane: 'render' })).status, 200);
    assert.equal((await f.post('/api/lane/archive', { lane: 'seabed' })).status, 200);
    assert.equal((await f.post('/api/stop', { run: 'RUN-2' })).status, 400, 'confirm required');
    assert.equal((await f.post('/api/stop', { run: 'RUN-2', confirm: true })).status, 200);
    assert.equal(loadState(f.pa.state).items['RUN-2'].state, 'killed');
    assert.equal((await f.post('/api/stop', { run: 'RUN-2', confirm: true })).status, 409);
    assert.equal((await f.post('/api/pause', { mode: 'checkins' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await f.post('/api/pause', { mode: 'checkins' }, { 'x-dash-token': 'wrong' })).status, 403);
    assert.equal((await f.post('/api/pause', { mode: 'checkins' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  } finally { await f.done(); }
});

test('each tab has a data endpoint from records / runs / transcripts', async () => {
  const f = await fixture();
  try {
    const lanes = (await f.get('/api/lanes')).data.lanes, by = Object.fromEntries(lanes.map(l => [l.name, l]));
    assert.deepEqual(Object.keys(by).sort(), ['gen', 'render', 'seabed'], 'only LANE records');
    assert.equal(by.render.executor, 'codex-sol'); assert.match(by.render.text, /^running codex-sol .*\/ budget 90$/);
    assert.equal(by.gen.text, 'parked by Q-1'); assert.equal(by.seabed.text, 'exited: STOPPED: red test');
    const inbox = (await f.get('/api/inbox')).data.items;
    // UI redesign 2026-11-20: only what the owner must answer - the parked lane and the unreviewed run show on Lanes, the advice on Usage
    assert.deepEqual(inbox.map(i => `${i.type} ${i.id}`).sort(), ['question Q-1']);
    const tree = (await f.get('/api/agents')).data.tree;
    const w = tree.find(n => n.id === 'RUN-1'), c = tree.find(n => n.id === 'RUN-2');
    assert.equal(w.ctx, 4 + 33810 + 31513); assert.equal(w.children[0].agentType, 'kestrel-implementer'); assert.equal(w.ctx_limit, 300000);
    assert.equal(c.model, 'gpt-5.4'); assert.equal(c.tokens, 60559); assert.equal(c.tokens_src, 'live');
    const o = (await f.get('/api/strip')).data;
    assert.equal(o.needs_you, 1); assert.equal(o.running.codex.n, 1); assert.equal(o.running.codex.cap, 5);
    assert.equal(o.usage.source, 'live'); assert.equal(o.usage.weeklyUsed, 96); assert.equal(o.usage.guard, 'STOP'); assert.equal(o.usage.estimate.weekly, 60);
    const r = (await f.get('/api/records')).data;
    assert.equal(r.decisions[0].id, 'DEC-1'); assert.equal(r.directives[0].history.length, 1);
    assert.equal((await f.get('/api/records?kind=directive')).data.decisions.length, 0);
    const docs = (await f.get('/api/docs')).data.groups.find(g => g.id === 'project').rows;   // META-UX-BUILD S3: the grouped list
    assert.deepEqual(docs.map(d => [d.name, d.exists]), [['Plan', true], ['Missing', false]]);
    assert.match((await f.get('/api/docs?part=file&file=doc-0')).data.doc.text, /step one/);
    assert.equal((await f.get('/api/docs?part=file&file=doc-7')).status, 404);
    const led = (await f.get('/api/ledger')).data.ledger; assert.equal(led.length, 30, 'default 100 lines (LEDGER-UX R1)'); assert.equal(led.at(-1), 'p30');
    const l25 = (await f.get('/api/ledger?count=25')).data.ledger; assert.equal(l25.length, 25); assert.equal(l25.at(-1), 'p30');
    assert.equal((await f.get('/api/nope')).status, 404);
    assert.equal((await f.get('/api/doorplan')).status, 404, 'doorplan -> /api/docs');
    assert.equal((await f.get('/api/phone')).status, 404, 'phone access dropped (OWNER a14)');
  } finally { await f.done(); }
});

test('usage falls back to the STATUS.md estimate when live usage is stale', async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.root, 'live-usage.json'), JSON.stringify({ seven_day_pct: 10, at_utc: '2026-01-01T00:00:00Z' }));
    const u = (await f.get('/api/strip')).data.usage;
    assert.equal(u.source, 'estimate'); assert.equal(u.weeklyUsed, 60); assert.equal(u.guard, 'ok');
  } finally { await f.done(); }
});

test('project switcher: two projects, ?project= scopes every tab, all sums the strip', async () => {
  const f = await fixture();
  try {
    assert.deepEqual((await f.get('/api/projects')).data.projects, [{ name: 'kestrel', title: 'KESTREL', needs: 1 }, { name: 'other', title: 'OTHER', needs: 1 }]);
    const b = (await f.get('/api/inbox?project=other')).data.items;
    assert.deepEqual(b.map(i => i.title), ['other project question']);
    assert.equal((await f.get('/api/lanes?project=other')).data.lanes.length, 0);
    const all = (await f.get('/api/strip?project=all')).data;
    assert.equal(all.needs_you, 2); assert.deepEqual(all.projects, ['kestrel', 'other']);
    assert.ok((await f.get('/api/inbox?project=all')).data.items.some(i => i.project === 'other'));
    assert.equal((await f.get('/api/records?project=all')).status, 400);
    assert.equal((await f.get('/api/inbox?project=nope')).status, 404);
    assert.equal((await f.post('/api/answer', { project: 'other', id: 'Q-1', text: 'ok' })).status, 200);
    assert.equal(loadState(f.pb.state).items['Q-1'].history.at(-1).ev, 'say', 'typed words on a Q with no options: a message in its thread (INBOX-REPLIES)');
    assert.equal(loadState(f.pa.state).items['Q-1'].history.at(-1).ev, 'create', 'the other project is untouched');
  } finally { await f.done(); }
});

test('GET / serves the UI shell and injects the token (tab / panel ids: tests/ui.test.mjs)', async () => {
  const f = await fixture();
  try {
    const r = await fetch(f.url + '/'), html = await r.text(); assert.equal(r.status, 200);
    for (const id of ['tabs', 'main', 'project', 'ckbox', 'pool', 'tab-settings', 'setview']) assert.ok(html.includes(`id="${id}"`), id);
    assert.ok(html.includes(f.app.token)); assert.ok(!/api\/phone|qrSvg/.test(html));
  } finally { await f.done(); }
});

test('settings: machine vs project split; POST saves each file atomically (409 / 400), regenerates marked lines, moves the schedule', async () => {
  const f = await fixture({ project: { executors: { grok: GROK } } });
  try {
    const g = (await f.get('/api/settings')).data;
    const s = Object.fromEntries(g.settings.map(x => [x.key, x]));
    assert.equal(s['policy.cadence.checkin_interval_min'].value, 15); assert.equal(s['max_codex'].scope, 'machine');
    assert.equal(s['policy.cadence.checkin_interval_min'].scope, 'project');
    assert.equal(s['rules.quiet_gpu'].value, 'QUIET: no GPU while the owner plays');
    assert.deepEqual(g.files, { machine: f.budgetFile, project: f.pa.file });
    assert.deepEqual(g.targets.map(t => [path.basename(t.file), t.exists, t.markers]), [['kestrel-implementer.md', true, ['context.implementer']], ['DECISION-RULES.md', true, ['iteration']], ['missing.md', false, []]]);
    assert.equal((await f.post('/api/settings', { version: 'stale', changes: { max_codex: 4 } })).status, 409);
    assert.equal((await f.post('/api/settings', { version: g.version, changes: { max_codex: 99 } })).status, 400);
    assert.equal((await f.post('/api/settings', { version: g.version, changes: { 'policy.agents.max_lane_writers': 2 } })).status, 400);
    const rank = await f.post('/api/settings', { version: g.version, changes: { 'policy.executors.review.executor': 'grok' } });
    assert.equal(rank.status, 400); assert.match(JSON.stringify(rank.data), /grok is not allowed to do review work/);
    assert.ok(!s['policy.executors.review.executor'].options.includes('grok')); assert.deepEqual(s['policy.allowed_classes.grok'].value, ['chores', 'passfail']);
    const ok = await f.post('/api/settings', { version: g.version, changes: { 'policy.context.implementer.handoff_k': 280, 'policy.iteration.escalation_multiplier': 3, 'policy.cadence.checkin_interval_min': 20 } });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.deepEqual(ok.data.written, [f.pa.file], 'a policy-only change leaves the machine budget alone');
    assert.deepEqual(ok.data.regenerated.map(r => path.basename(r)), ['kestrel-implementer.md', 'DECISION-RULES.md']);
    assert.deepEqual(f.counts.intervals, [20]); assert.equal(ok.data.schedule.interval, 'PT20M');
    const proj = JSON.parse(fs.readFileSync(f.pa.file, 'utf8'));
    assert.equal(proj.policy.context.implementer.handoff_k, 280); assert.equal(proj.ledger, '${root}/progress.md', 'unexpanded project keys kept');
    assert.deepEqual(Object.keys(proj).slice(0, 4), ['schema', 'name', 'title', 'root'], 'key order kept');
    assert.match(fs.readFileSync(f.target, 'utf8'), /^a\nHANDOFF: start NO new step past ~270k; at ~280k .*<!-- policy:context\.implementer -->\nb\n$/);
    assert.match(fs.readFileSync(f.rules, 'utf8'), /~3x its round estimate/);
    assert.equal((await f.post('/api/settings', { version: g.version, changes: { max_codex: 4 } })).status, 409, 'old version after a save');
    const again = (await f.get('/api/settings')).data;
    const m = await f.post('/api/settings', { version: again.version, changes: { max_sol: 4 } });
    assert.deepEqual(m.data.written, [f.budgetFile]); assert.equal(m.data.schedule, null, 'no scheduler call when the interval is unchanged');
    const b = JSON.parse(fs.readFileSync(f.budgetFile, 'utf8'));
    assert.equal(b.max_sol, 4); assert.equal(b.calib_pct, 54); assert.equal(b.policy, undefined, 'no policy in the machine budget');
    assert.deepEqual(Object.keys(b), Object.keys(budget0), 'machine key order kept');
  } finally { await f.done(); }
});

// META-ROADMAP S2: /api/roadmap = the derived tree (`norn road show --json` in a child: git never blocks a poll), cached on the
// records files, rebuilt on an append (awaited: the next fetch shows it), unknown project 404
test('roadmap endpoint: the derived tree from roadmap records; cached while nothing changed; an append shows on the next fetch', async () => {
  const f = await fixture();
  try {
    const S = f.pa.state, it = (ev, data, id) => record(S, { kind: 'item', ev, id, by: 'controller', data }, { views: false });
    const t = it('create', { title: 'Core', kind: 'theme' }).id;
    it('create', { title: 'Gen lane work', kind: 'item', parent: t, links: ['lane:gen'] });
    const a = (await f.get('/api/roadmap?project=kestrel')).data;
    assert.equal(a.project, 'kestrel'); assert.deepEqual(a.themes.map(x => [x.id, x.title]), [[t, 'Core']]);
    const i = a.themes[0].children[0];
    assert.equal(i.title, 'Gen lane work'); assert.ok(i.status && i.phase, 'derived status + phase'); assert.ok(Array.isArray(i.spans), 'time-line stretches');
    assert.equal(a.counts.items, 1);
    const b = (await f.get('/api/roadmap?project=kestrel')).data;
    assert.equal(b.generated, a.generated, 'nothing changed -> the cached tree');
    it('create', { title: 'Later idea', kind: 'item', parent: t });
    const c = (await f.get('/api/roadmap?project=kestrel')).data;
    assert.deepEqual(c.themes[0].children.map(x => x.title), ['Gen lane work', 'Later idea'], 'the append is in the next fetch');
    assert.equal(c.counts.future, a.counts.future + 1);
    assert.equal((await f.get('/api/roadmap?project=nope')).status, 404);
    const e = (await f.get('/api/roadmap?project=other')).data;
    assert.deepEqual([e.themes, e.counts.items], [[], 0], 'a project with no roadmap: an empty tree, not an error');
  } finally { await f.done(); }
});

// dash-latency: a run / lane / directive append (runs.jsonl, records.jsonl churn while workers run) never makes the Roadmap wait on
// `norn road show` (3 s idle, 4-13 s with workers): the last tree at once, one rebuild behind it, the new tree on a later fetch
test('roadmap endpoint: a non-roadmap record append serves the last tree at once and rebuilds behind it', async () => {
  const f = await fixture();
  try {
    const S = f.pa.state;
    record(S, { kind: 'item', ev: 'create', by: 'controller', data: { title: 'Core', kind: 'theme' } }, { views: false });
    const a = (await f.get('/api/roadmap?project=kestrel')).data;
    await new Promise(r => setTimeout(r, 5));   // a rebuild's `generated` is a later ms
    record(S, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'gen' } });
    record(S, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'churn', via: 'chat' } });
    const t0 = performance.now(), b = (await f.get('/api/roadmap?project=kestrel')).data, ms = performance.now() - t0;
    assert.equal(b.generated, a.generated, 'the last tree, not a fresh build awaited');
    assert.ok(ms < 500, `served from the cache in ${Math.round(ms)} ms`);
    let c = b;
    for (let i = 0; i < 300 && c.generated === a.generated; i++) { await new Promise(r => setTimeout(r, 100)); c = (await f.get('/api/roadmap?project=kestrel')).data; }
    assert.notEqual(c.generated, a.generated, 'rebuilt behind the served tree');
  } finally { await f.done(); }
});
