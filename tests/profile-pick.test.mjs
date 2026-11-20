// META-PROFILE-BUG R1 (owner DIR-60): a profile saved from Settings is recorded (the "caps profile" decision), shown at the top of
// Settings (the caps row a Lanes setup gap until one is on record), and Save writes only the keys the owner changed; Review lists each change in plain words and flags one that
// names a recorded ruling or picks a retired executor. Temp dirs only (dash fixture), no real claude / codex.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture, budget0 } from './helpers/dash-fixture.mjs';
import { renderTab, loadTab, stripCards } from '../engine/dash/ui.mjs';
import { record } from '../engine/lib/records.mjs';
import { getProfile, profileBudget } from '../engine/lib/profiles.mjs';

// Codex is installed (machine.codex.exe), Codex is open (max_codex 2) and codex-astra is retired (max_astra 0): the norn machine
const RETIRED = { ...budget0, max_codex: 2, max_sol: 2, max_astra: 0 };
const fx = async (budget = RETIRED) => {
  const f = await fixture({ dash: { machine: { home: 'unused', codex: { exe: 'codex.cmd' } } } });
  fs.writeFileSync(f.budgetFile, JSON.stringify(budget, null, 2) + '\n');
  return f;
};
const heavy = (g, cost = 'balanced') => g.profiles.find(p => p.name === 'heavy').changes[cost];
const getUi = f => async r => (await f.get(r)).data;

test('a profile saved from Settings is recorded as the caps profile decision; the Lanes caps row goes away', async () => {
  const f = await fx({ ...RETIRED, ...profileBudget(getProfile('try-it')) });   // the starter caps norn setup writes: nobody chose them yet
  try {
    const before = (await f.get('/api/strip?project=kestrel')).data;
    assert.equal(before.setup.caps_chosen, false);
    const html0 = stripCards('lanes', before);
    assert.match(html0, /Nobody chose them/);
    assert.doesNotMatch(html0, /scheduler stays off/i, 'the scheduler is not held off by the caps row');
    const g = (await f.get('/api/settings?project=kestrel')).data;
    const r = await f.post('/api/settings', { project: 'kestrel', version: g.version, changes: heavy(g), profile: { name: 'heavy', cost: 'balanced' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const recs = (await f.get('/api/records?project=kestrel&kind=decision')).data;
    const d = recs.decisions.find(x => /caps profile$/.test(x.data.question));
    assert.ok(d, 'a caps profile decision');
    assert.equal(d.by, 'dashboard'); assert.equal(d.data.profile, 'heavy'); assert.equal(d.data.cost, 'balanced');
    assert.match(d.data.choice, /Heavy \(overnight\)/);
    const after = (await f.get('/api/strip?project=kestrel')).data;
    assert.equal(after.setup.caps_chosen, true);
    const html = stripCards('lanes', after);
    assert.doesNotMatch(html, /Nobody chose them/);
  } finally { await f.done(); }
});

test('the current profile shows at the top of Settings: saved / + own changes / no profile', async () => {
  const f = await fx();
  try {
    const se = async () => renderTab('settings', await loadTab('settings', 'kestrel', getUi(f)), { now: Date.now(), project: 'kestrel' });
    const line = (h, id) => (h.match(new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)</(p|div)>`)) || [])[1] ?? '';
    assert.match(line(await se(), 'set-profile-now'), /your own settings \(no profile\)/);
    let g = (await f.get('/api/settings?project=kestrel')).data;
    assert.equal((await f.post('/api/settings', { project: 'kestrel', version: g.version, changes: heavy(g), profile: { name: 'heavy', cost: 'balanced' } })).status, 200);
    assert.match(line(await se(), 'set-profile-now'), /Heavy \(overnight\), saved /);
    g = (await f.get('/api/settings?project=kestrel')).data;   // one of the profile's keys changed by hand afterwards
    assert.equal((await f.post('/api/settings', { project: 'kestrel', version: g.version, changes: { max_claude_workers: 1 } })).status, 200);
    assert.match(line(await se(), 'set-profile-now'), /Heavy \(overnight\) \+ 1 of your own changes/);
  } finally { await f.done(); }
});

test('a profile never re-enables a retired executor (cap 0 while Codex is open) and routes to the Codex the machine has', async () => {
  const f = await fx();
  try {
    const ch = heavy((await f.get('/api/settings?project=kestrel')).data, 'quality');
    assert.equal(ch.max_astra, 0, 'codex-astra stays retired');
    assert.equal(ch.max_sol, 5); assert.equal(ch.max_codex, 5);
    for (const [k, v] of Object.entries(ch)) if (/^policy\.(executors\.[a-z_]+\.executor|fallbacks\.)/.test(k)) assert.notEqual(v, 'codex-astra', k);
    assert.equal(ch['policy.executors.review.executor'], 'codex-sol', 'codex-sol is installed and open: the profile keeps it');
    assert.equal(ch['policy.fallbacks.claude_over_guard'], 'wait');
  } finally { await f.done(); }
  const off = await fx({ ...budget0, max_codex: 0, max_sol: 0, max_astra: 0 });   // Codex not on yet (the starter caps): a profile turns it on
  try { assert.equal(heavy((await off.get('/api/settings?project=kestrel')).data).max_astra, 5); } finally { await off.done(); }
});

test('Save writes only the keys the owner changed: no defaults, no unchanged value written over the project', async () => {
  const f = await fx();
  try {
    const pol0 = JSON.parse(fs.readFileSync(f.pa.file, 'utf8')).policy;
    let g = (await f.get('/api/settings?project=kestrel')).data;
    const r = await f.post('/api/settings', { project: 'kestrel', version: g.version, changes: { 'policy.cadence.checkin_interval_min': 20, 'policy.speed_mode.A': true } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(JSON.parse(fs.readFileSync(f.pa.file, 'utf8')).policy, { ...pol0, cadence: { checkin_interval_min: 20 } });
    g = (await f.get('/api/settings?project=kestrel')).data;
    assert.equal((await f.post('/api/settings', { project: 'kestrel', version: g.version, changes: heavy(g), profile: { name: 'heavy', cost: 'balanced' } })).status, 200);
    const pol = JSON.parse(fs.readFileSync(f.pa.file, 'utf8')).policy;
    for (const k of ['guard', 'speed_mode', 'voice', 'slop', 'delegate', 'ask', 'mail', 'instructions', 'launch', 'context', 'iteration'])
      assert.equal(pol[k], undefined, `policy.${k}: a default is never written out`);
    // what is written = the profile's keys whose value differs from the one in force (here the heavy fallbacks), nothing else
    const flat = (o, at = 'policy', r = {}) => { for (const [k, v] of Object.entries(o)) v && typeof v === 'object' && !Array.isArray(v) ? flat(v, `${at}.${k}`, r) : (r[`${at}.${k}`] = v); return r; };
    const inForce = Object.fromEntries(g.settings.map(s => [s.key, s.value])), wrote = flat(pol);
    delete wrote['policy.cadence.checkin_interval_min'];
    assert.ok(Object.keys(wrote).length > 0, 'the profile changed something');
    for (const [k, v] of Object.entries(wrote)) { assert.equal(v, heavy(g)[k], k); assert.notDeepEqual(v, inForce[k], `${k} was already ${v}`); }
  } finally { await f.done(); }
});

test('Review changes lists each change in plain words and flags a recorded ruling on the key and a retired executor', async () => {
  const f = await fx();
  try {
    record(f.pa.state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'keep max_codex at 2 while the Codex plan is small', via: 'chat' } });
    const dir = Object.values(JSON.parse(JSON.stringify((await f.get('/api/records?project=kestrel&kind=directive')).data.directives))).find(x => /max_codex/.test(x.data.text));
    const g = (await f.get('/api/settings?project=kestrel')).data;
    const r = await f.post('/api/settings/review', { project: 'kestrel', version: g.version,
      changes: { max_codex: 4, max_astra: 1, 'policy.fallbacks.claude_over_guard': 'codex-astra', max_claude_workers: 1 } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const by = Object.fromEntries(r.data.lines.map(l => [l.key, l]));
    assert.equal(by.max_codex.text, 'Max Codex total: 2 -> 4');
    assert.ok(by.max_codex.flags.some(x => x.includes(dir.id)), JSON.stringify(by.max_codex.flags));
    assert.ok(by.max_astra.flags.some(x => /retired/.test(x) && /codex-astra/.test(x)), JSON.stringify(by.max_astra.flags));
    assert.ok(by['policy.fallbacks.claude_over_guard'].flags.some(x => /retired/.test(x)));
    assert.deepEqual(by.max_claude_workers.flags, []);
    // the check-in floor: a check-in model / effort below it is flagged (a warning, not a refusal); one at or above it is not
    const ck = await f.post('/api/settings/review', { project: 'kestrel', version: g.version, changes: { checkin_model: 'claude-sonnet-5-5', checkin_effort: 'low' } });
    assert.equal(ck.status, 200, JSON.stringify(ck.data));
    for (const l of ck.data.lines) assert.ok(l.flags.some(x => /below the check-in floor \(claude-opus-5-5, effort medium\)/.test(x)), JSON.stringify(l));
    const ok = await f.post('/api/settings/review', { project: 'kestrel', version: g.version, changes: { checkin_model: 'claude-opus-5-5', checkin_effort: 'high' } });
    for (const l of ok.data.lines) assert.deepEqual(l.flags, [], JSON.stringify(l));
    assert.equal(fs.readFileSync(f.budgetFile, 'utf8'), JSON.stringify(RETIRED, null, 2) + '\n', 'review writes nothing');
  } finally { await f.done(); }
});
