// META-TEND P4 (REPORT 4.4): model advice as dated DATA + the advice rules over the class cost table; the digest's ONE line.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { advise, loadAdviceData, sourcesOf, settingKeys, rowOf, decidedKeys, writeAdviceCache, adviceDigestRow } from '../engine/lib/advice.mjs';
import { withDefaults, merged, applySettings } from '../engine/lib/policy.mjs';

after(cleanTmp);
const DATA = loadAdviceData();
const NOW = Date.parse('2026-11-14T12:00:00Z');
const row = (o) => ({ project: 'p', src: 'stamped', executor: 'x', stages: 4, done: 4, done_rate: 1, cost_per_done: 10e6, ...o });
const S = (pol = {}, top = {}) => withDefaults(merged(top, pol));

test('vendor data: every row names a source with a URL / file and the day it was read; a row past stale_days is stale', () => {
  assert.ok(DATA.rows.length >= 4);
  for (const r of DATA.rows) {
    assert.ok(r.sources?.length, r.id);
    for (const s of r.sources) { assert.ok(s.url && s.ref, r.id); assert.match(s.read, /^\d{4}-\d{2}-\d{2}$/, r.id); }
  }
  assert.equal(rowOf(DATA, 'claude-opus-5-5').id, 'opus-5-5');
  assert.equal(rowOf(DATA, 'fable').tier, Math.max(...DATA.rows.map(r => r.tier ?? 0)));
  assert.ok(sourcesOf(DATA, NOW).every(s => !s.stale && s.age_d === 0));
  const later = sourcesOf(DATA, NOW + (DATA.stale_days + 1) * 86400000);
  assert.ok(later.every(s => s.stale));
  assert.equal(advise({ rows: [] }, S(), { data: DATA, now: NOW + (DATA.stale_days + 1) * 86400000 }).stale.length, later.length);
});

test('settingKeys: every card change is a real Settings key the save path accepts', () => {
  const base = S();
  for (const cls of ['implementation', 'planning', 'chores', 'docs', 'merge', 'checkin_major', 'checkin_minor', 'chat']) {
    const k = settingKeys(cls);
    assert.doesNotThrow(() => applySettings(base, { [k.effort]: 'medium' }), cls);
  }
  assert.equal(settingKeys('audit'), null);
});

test('mechanical class on a top model at xhigh -> one medium card that moves it to Sonnet medium; Sonnet merges stay quiet', () => {
  const a = advise({ rows: [row({ class: 'chores', model: 'claude-opus-5-5', effort: 'xhigh' }), row({ class: 'merge', model: 'claude-sonnet-5-5', effort: 'medium' })] },
    S({ executors: { chores: { executor: 'implementer', model: 'claude-opus-5-5', effort: 'xhigh' } } }), { project: 'p', data: DATA, now: NOW });
  const c = a.cards.filter(x => x.check === 'mechanical-top-xhigh');
  assert.equal(c.length, 1);
  assert.equal(c[0].id, 'chores');
  assert.deepEqual(c[0].change, { 'policy.executors.chores.model': 'claude-sonnet-5-5', 'policy.executors.chores.effort': 'medium' });
  assert.match(c[0].text, /claude-opus-5-5 xhigh: 4 stages, 100 % done, 10\.0M per finished task/);
  assert.equal(c[0].source.read, '2026-11-14');
  assert.match(c[0].trial, /test for 5 runs, then keep or revert/);
  for (const k of ['key', 'check', 'title', 'severity', 'path', 'line', 'id', 'text', 'fix']) assert.ok(Object.hasOwn(c[0], k), k);   // the P1 finding shape
});

test('effort above the vendor start: fires with no measured gain, stays quiet when a lower effort finished less often', () => {
  const pol = { executors: { planning: { executor: 'planner', model: 'claude-opus-5-5', effort: 'xhigh' } } };
  const none = advise({ rows: [row({ class: 'planning', model: 'claude-opus-5-5', effort: 'xhigh' })] }, S(pol), { project: 'p', data: DATA, now: NOW });
  const c = none.cards.find(x => x.check === 'effort-above-start' && x.id === 'planning');
  assert.deepEqual(c.change, { 'policy.executors.planning.effort': 'high' });
  const gain = advise({ rows: [row({ class: 'planning', model: 'claude-opus-5-5', effort: 'xhigh', done_rate: 1 }), row({ class: 'planning', model: 'claude-opus-5-5', effort: 'high', done: 2, done_rate: 0.5 })] },
    S(pol), { project: 'p', data: DATA, now: NOW });
  assert.equal(gain.cards.filter(x => x.check === 'effort-above-start' && x.id === 'planning').length, 0);
  const atStart = advise({ rows: [] }, S({ executors: { planning: { executor: 'planner', model: 'claude-opus-5-5', effort: 'high' } } }), { project: 'p', data: DATA, now: NOW });
  assert.equal(atStart.cards.filter(x => x.id === 'planning').length, 0);
});

test('a coordinator on the priciest model -> back to Opus 5.5; check-ins on Opus are quiet', () => {
  const a = advise({ rows: [row({ class: 'checkin_major', model: 'fable', effort: 'high' })] }, S({}, { checkin_model: 'fable' }), { project: 'p', data: DATA, now: NOW });
  const c = a.cards.find(x => x.check === 'coordinator-priciest');
  assert.equal(c.id, 'checkin_major');
  assert.deepEqual(c.change, { checkin_model: 'claude-opus-5-5' });
  const q = advise({ rows: [row({ class: 'checkin_major', model: 'claude-opus-5-5', effort: 'medium' })] }, S({}, { checkin_model: 'claude-opus-5-5' }), { project: 'p', data: DATA, now: NOW });
  assert.equal(q.cards.filter(x => x.check === 'coordinator-priciest').length, 0);
});

test('effort spread > 1.5x with no better done rate -> the cheaper effort; a dearer level that finishes more often is kept', () => {
  const pol = { executors: { implementation: { executor: 'implementer', model: 'claude-opus-5-5', effort: 'high' } } };
  const rs = (rate) => [row({ class: 'implementation', model: 'claude-opus-5-5', effort: 'high', cost_per_done: 40e6, done: 4, stages: 4 / rate, done_rate: rate }),
    row({ class: 'implementation', model: 'claude-opus-5-5', effort: 'medium', cost_per_done: 10e6, done: 4, stages: 5, done_rate: 0.8 })];
  const a = advise({ rows: rs(0.8) }, S(pol), { project: 'p', data: DATA, now: NOW });
  const c = a.cards.find(x => x.check === 'effort-spread');
  assert.deepEqual(c.change, { 'policy.executors.implementation.effort': 'medium' });
  assert.match(c.title, /high costs 4\.0x medium/);
  assert.equal(advise({ rows: rs(1) }, S(pol), { project: 'p', data: DATA, now: NOW }).cards.filter(x => x.check === 'effort-spread').length, 0);
});

test('a decided card (decision record data.advice = key) is hidden; the digest line reads the cache, none when nothing is open', () => {
  const cls = { rows: [row({ class: 'checkin_major', model: 'fable', effort: 'high' })] };
  const a = advise(cls, S({}, { checkin_model: 'fable' }), { project: 'p', data: DATA, now: NOW });
  const key = a.cards[0].key;
  const b = advise(cls, S({}, { checkin_model: 'fable' }), { project: 'p', data: DATA, now: NOW, decided: decidedKeys([{ kind: 'decision', data: { advice: key } }]) });
  assert.ok(!b.cards.some(c => c.key === key));
  assert.equal(b.decided, 1);
  const st = mkTmp('advice-');
  assert.equal(adviceDigestRow(st), null);
  writeAdviceCache(st, a);
  assert.match(adviceDigestRow(st).line, /^advice: \d+ open on the Spend page \(first: /);
  writeAdviceCache(st, advise({ rows: [] }, S({ executors: { planning: { executor: 'planner', model: 'claude-opus-5-5', effort: 'high' } } }), { project: 'p', data: DATA, now: NOW }));
  assert.equal(adviceDigestRow(st), null);
  assert.ok(fs.existsSync(path.join(st, 'advice.json')));
});

test('the digest carries the advice line as ONE row (section 10) only while a card is open', async () => {
  const { digest } = await import('../engine/lib/digest.mjs');
  const { renderDigest } = await import('../engine/lib/views.mjs');
  const st = mkTmp('advice-dg-'), now = NOW;
  assert.equal(digest(st, { name: 'kestrel' }, { now, dlv: [] }).sections.advice, undefined);
  writeAdviceCache(st, advise({ rows: [row({ class: 'checkin_major', model: 'fable', effort: 'high' })] }, S({}, { checkin_model: 'fable' }), { project: 'p', data: DATA, now }));
  const d = digest(st, { name: 'kestrel' }, { now, dlv: [] });
  assert.equal(d.sections.advice.length, 1);
  assert.match(d.sections.advice[0].line, /^advice: \d+ open on the Spend page/);
  assert.ok(renderDigest(d).includes(`## 10 Model advice (1)\n- ${d.sections.advice[0].line}\n`));
});

test('dash: Usage has the Advice strip + the replay table; Inbox has the card; one tap applies the change, records a decision, hides it', async () => {
  const { fixture } = await import('./helpers/dash-fixture.mjs');
  const { replayReportFile } = await import('../engine/lib/eval/report.mjs');
  const { renderTab } = await import('../engine/dash/ui.mjs');
  const { loadState } = await import('../engine/lib/records.mjs');
  const f = await fixture();
  try {
    const rep = { project: 'kestrel', at: '2026-11-14T12:00:00Z', arms: ['claude:claude-sonnet-5-5:medium'], arms_total: [{ arm: 'claude:claude-sonnet-5-5:medium', ticks: 1, agree: 0, harmless: 0, recoverable: 1, harmful: 0, errors: 0, tokens: 14000 }],
      classes: [{ arm: 'claude:claude-sonnet-5-5:medium', cls: 'dispatch', recorded: 1, agree: 0, rate: 0 }], disagreements: [], choices: [],
      ticks: [{ tick: 'RUN-9', ts: '2026-11-12T01:00:00Z', stratum: 'dispatch', recorded: ['dispatch river S1 claude medium'], arms: { 'claude:claude-sonnet-5-5:medium': { verdict: 'recoverable', cand: ['nothing'], why: ['missing dispatch:river: lane idles until the next tick'] } } }] };
    fs.mkdirSync(path.dirname(replayReportFile(f.pa.state)), { recursive: true });
    fs.writeFileSync(replayReportFile(f.pa.state), JSON.stringify(rep));
    const u = await f.get('/api/usage?project=kestrel');
    assert.equal(u.status, 200);
    const part = u.data.parts[0], card = part.advice.cards.find(c => c.id === 'planning');
    assert.equal(card.check, 'effort-above-start', 'the engine default planning xhigh is above the vendor start (high)');
    assert.equal(part.replay.ticks[0].tick, 'RUN-9');
    const html = ['advice', 'checkins'].map(sub => renderTab('spend', { ...u.data, sub }, { project: 'kestrel', now: Date.now() })).join('');
    assert.match(renderTab('spend', u.data, { project: 'kestrel' }), /id="spend-adv"[^>]*data-sub="advice"[^]*?<span class="obadge( hot)?">1<\/span>/, 'the advice icon counts the open cards');
    assert.match(html, /id="spend-advice-clear" data-act="advice-clear" data-project="kestrel" data-keys="[^"]+"/, 'Clear all keeps every open card');
    assert.match(html, /id="spend-advice"[\s\S]*Planning above the vendor&#39;s starting effort[\s\S]*read <span class="mono">2026-11-14[\s\S]*data-act="advice-apply"/);
    assert.match(html, /id="spend-advice-sources"[\s\S]*MM 2026-11-14/);
    assert.match(html, /id="spend-replay-class"[\s\S]*dispatch[\s\S]*0 of 1/);
    assert.match(html, /id="spend-replay-side"[\s\S]*RUN-9[\s\S]*dispatch river S1 claude medium[\s\S]*recoverable[\s\S]*nothing/);
    // a phone stacks the side-by-side rows (each cell labelled by its column): 4 columns clipped the cheaper models at 390 px
    assert.match(html, /<td data-label="recorded"[^>]*>dispatch river S1[\s\S]*<td data-label="sonnet-5-5 medium">/);
    assert.ok(fs.existsSync(path.join(f.pa.state, 'advice.json')), 'the digest cache');
    // the card lives on the usage page only (UI redesign 2026-11-20: the Inbox holds only what the owner must answer)
    const item = { id: card.key, change: card.change };
    assert.deepEqual(item.change, { 'policy.executors.planning.effort': 'high' });
    assert.ok(!(await f.get('/api/inbox?project=kestrel')).data.items.some(i => i.id === item.id), 'advice is no Inbox row');
    assert.equal((await f.post('/api/advice', { project: 'kestrel', key: item.id, verdict: 'maybe' })).status, 400);
    const r = await f.post('/api/advice', { project: 'kestrel', key: item.id, verdict: 'apply' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(JSON.parse(fs.readFileSync(f.pa.file, 'utf8')).policy.executors.planning.effort, 'high', 'the Settings save path wrote the project policy');
    const dec = Object.values(loadState(f.pa.state).items).find(i => i.kind === 'decision' && i.data.advice === item.id);
    assert.equal(dec.by, 'dashboard');
    assert.match(dec.data.choice, /^applied: policy\.executors\.planning\.effort = high/);
    assert.match(dec.data.why, /test for 5 runs, then keep or revert/);
    assert.ok(!(await f.get('/api/usage?project=kestrel')).data.parts[0].advice.cards.some(c => c.key === item.id), 'decided: gone');
    assert.equal((await f.post('/api/advice', { project: 'kestrel', key: item.id, verdict: 'apply' })).status, 409);
  } finally { await f.done(); }
});
