// META-UX-R1 Settings information architecture: categories live in the settings schema (policy.mjs SECTIONS + SECTION_RULES),
// every setting resolves to exactly one existing section (no orphan), search filters rows, and the regrouped UI saves every
// key unchanged (same key, same file, same semantics; DIR-7). Temp dirs only (dash fixture), no real claude / codex.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SECTIONS, sectionOf, settingsFor, settingsView, applySettings, withDefaults, getPath, split } from '../engine/lib/policy.mjs';
import { renderTab, loadTab, settingsMatch } from '../engine/dash/ui.mjs';
import { fixture } from './helpers/dash-fixture.mjs';

const PV = ['glm', 'kimi'], PROJECTS = ['norn', 'solve-shack'];   // the registered projects: one Capacity row pair each (fair-slots item 8)
const find = (path) => { const [c, s, x] = path; const cat = SECTIONS.find(k => k.id === c); const sub = cat?.subs.find(k => k.id === s);
  return { cat, sub, sub3: x === undefined ? null : sub?.subs?.find(k => k.id === x) }; };

test('grouping is complete: every setting (with and without providers) has one existing category / sub-category home', () => {
  for (const pv of [[], PV]) {
    const rows = settingsFor({ providers: pv, projects: PROJECTS }), keys = new Set();
    for (const s of rows) {
      assert.ok(!keys.has(s.key), 'duplicate key ' + s.key); keys.add(s.key);
      const at = sectionOf(s); assert.ok(Array.isArray(at) && at.length >= 2, 'orphan setting ' + s.key);
      const { cat, sub, sub3 } = find(at);
      assert.ok(cat, `${s.key}: unknown category ${at[0]}`); assert.ok(sub, `${s.key}: unknown sub-category ${at.join('/')}`);
      if (sub.subs) assert.ok(sub3, `${s.key}: sub-category ${at.join('/')} needs a known sub-sub-category`);
      else assert.equal(at.length, 2, `${s.key}: ${at.join('/')} has no sub-sub-categories`);
    }
  }
  // every declared section is used (no empty nav entry), labels + one-line help everywhere
  const used = new Set(settingsFor({ providers: PV, projects: PROJECTS }).map(s => sectionOf(s).slice(0, 2).join('/')));
  for (const c of SECTIONS) {
    assert.ok(c.label && c.help, c.id + ' label / help');
    for (const s of c.subs) { assert.ok(s.label, `${c.id}/${s.id} label`); if (!c.info) assert.ok(used.has(`${c.id}/${s.id}`), `empty section ${c.id}/${s.id}`); }
  }
});

test('settingsView rows carry their section and the machinery default (modified-from-default marker)', () => {
  const rows = settingsView({ max_codex: 3, policy: { context: { implementer: { no_new_step_k: 170, handoff_k: 200, hard_max_k: 220 } } } }, { providers: PV });
  const by = Object.fromEntries(rows.map(s => [s.key, s]));
  assert.deepEqual(by['policy.context.implementer.handoff_k'].section, ['agents', 'context', 'implementer']);
  assert.equal(by['policy.context.implementer.handoff_k'].default, 110); assert.equal(by['policy.context.implementer.handoff_k'].modified, true);
  assert.equal(by['policy.context.planner.handoff_k'].modified, false);
  assert.equal(by['max_codex'].default, undefined, 'machine key without a machinery default'); assert.equal(by['max_codex'].modified, false);
  assert.equal(by['desired_burn_pct_per_h'].default, 0.4);
  assert.equal(by['max_glm'].default, 1);
});

test('search filters rows by label, key, help, value and @modified; empty query matches all', () => {
  const rows = settingsView({ max_codex: 3, policy: { critical_effort: 'medium' } }, { providers: PV });
  const hits = q => rows.filter(s => settingsMatch(s, q)).map(s => s.key);
  assert.equal(hits('').length, rows.length);
  assert.deepEqual(hits('max_codex'), ['max_codex']);
  assert.ok(hits('hand-off').every(k => k.startsWith('policy.context.')) && hits('hand-off').length >= 4);
  assert.ok(hits('HAND-OFF').length === hits('hand-off').length, 'case-insensitive');
  assert.deepEqual(hits('@modified'), ['policy.critical_effort']);
  assert.deepEqual(hits('@modified critical'), ['policy.critical_effort']);
  assert.deepEqual(hits('no such setting zzz'), []);
  assert.ok(hits('fallback codex').includes('policy.fallbacks.codex_down'), 'all words must match');
});

const html2controls = html => [...html.matchAll(/<(input|select)\b([^>]*)>/g)].map(m => Object.fromEntries([...m[2].matchAll(/([a-z-]+)="([^"]*)"/g)].map(a => [a[1], a[2]])))
  .filter(a => a['data-key']);
const unesc = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function alternatives(s, cur) {
  if (s.type === 'int' || s.type === 'num') { const st = s.type === 'int' ? 1 : 0.01, c = typeof cur === 'number' ? cur : s.min;
    return [c + st, c - st, s.min, s.max, Math.round((s.min + s.max) / 2)].map(v => Math.round(v * 100) / 100).filter(v => v >= s.min && v <= s.max && v !== cur); }
  if (s.type === 'bool') return [!cur];
  if (s.type === 'enum') return s.options.filter(o => o !== cur);
  if (s.type === 'list') return [['some-lane']];
  if (s.type === 'classes') return [cur.slice(0, -1), cur.slice(1), s.options].filter(v => v.length && JSON.stringify(v) !== JSON.stringify(cur));
  if (s.key === 'reset') return ['2026-11-11T08:00 local'];
  if (s.key === 'calib_time_utc') return ['2026-11-08T10:00:00Z'];
  if (s.key === 'policy.checkin.merge_agent') return ['runner'];
  if (s.key === 'policy.dod.critique_filter') return ['review-filter.txt'];
  return [];
}

test('save round-trip: every rendered control keeps its key; changing it writes that key, in its own file, and nothing else', async () => {
  const f = await fixture();
  try {
    const d = await loadTab('settings', 'kestrel', async r => (await f.get(r)).data);
    const html = renderTab('settings', d, { project: 'kestrel' });
    const controls = html2controls(html), byKey = Object.fromEntries(controls.map(c => [c['data-key'], c]));
    assert.equal(controls.length, Object.keys(byKey).length, 'one control per key');
    const editable = d.settings.filter(s => !s.readonly && s.scope !== 'file');
    for (const s of d.settings) {
      if (s.scope === 'file') continue;
      const c = byKey[s.key]; assert.ok(c, 'rendered control for ' + s.key);
      assert.deepEqual(JSON.parse(unesc(c['data-orig'])), s.value ?? null, s.key + ' data-orig = value'); assert.equal(c['data-type'], s.type, s.key + ' type');
    }
    // each editable key: the first accepted alternative is written to exactly that key path in exactly its scope's file
    let saved = 0;
    for (const s of editable) {
      const g = (await f.get('/api/settings')).data, now = g.settings.find(x => x.key === s.key), cur = now.value;
      const before = { b: JSON.parse(fs.readFileSync(f.budgetFile, 'utf8')), p: JSON.parse(fs.readFileSync(f.pa.file, 'utf8')).policy };
      if (now.type === 'enum' && now.options.length < 2) continue; // one-option enum (checkin / chat executor = claude): nothing to change to
      let r = null, v;
      for (v of alternatives(now, cur)) { r = await f.post('/api/settings', { version: g.version, changes: { [s.key]: v } }); if (r.status === 200) break; }
      assert.equal(r?.status, 200, `${s.key}: no alternative value saved (${r?.data?.error})`);
      const after = { b: JSON.parse(fs.readFileSync(f.budgetFile, 'utf8')), p: JSON.parse(fs.readFileSync(f.pa.file, 'utf8')).policy };
      const full = x => withDefaults({ ...x.b, policy: x.p });
      assert.deepEqual(getPath(full(after), s.key), v, s.key + ' written');
      // drop the key (and parents it leaves empty) so the rest of the merged view can be compared
      const strip = (o, k) => { const c = structuredClone(o), ps = k.split('.'), chain = [c]; for (const p of ps.slice(0, -1)) { const n = chain.at(-1)?.[p]; if (!n) return c; chain.push(n); }
        delete chain.at(-1)[ps.at(-1)]; for (let i = chain.length - 1; i > 0 && !Object.keys(chain[i]).length; i--) delete chain[i - 1][ps[i - 1]]; return c; };
      assert.deepEqual(strip(full(after), s.key), strip(full(before), s.key), s.key + ': nothing else changed');
      const pol = x => withDefaults({ policy: x.p }).policy; // a save may expand the policy defaults into project.json (unchanged semantics)
      if (s.scope === 'machine') assert.deepEqual(pol(after), pol(before), s.key + ': project policy unchanged');
      else assert.deepEqual(after.b, before.b, s.key + ': machine file untouched');
      saved++;
    }
    assert.ok(saved >= 80, 'saved ' + saved);
  } finally { await f.done(); }
});

test('the Settings tab renders categories from the schema: left nav, search box, help per row, modified marker + reset, danger zone', async () => {
  const f = await fixture({ project: { policy: { lanes: {}, critical_effort: 'medium' } } });
  try {
    const d = await loadTab('settings', 'kestrel', async r => (await f.get(r)).data);
    assert.deepEqual(d.sections.map(c => c.id), SECTIONS.map(c => c.id), 'sections served from the schema');
    const html = renderTab('settings', d, { project: 'kestrel' });
    assert.match(html, /id="set-search"/);
    for (const c of SECTIONS) { assert.ok(html.includes(`id="nav-${c.id}"`), 'nav ' + c.id); assert.ok(html.includes(`id="cat-${c.id}"`), 'pane ' + c.id); }
    const row = html.match(/<div class="srow[^"]*"[^>]*id="set-policy\.critical_effort"[\s\S]*?<\/div><\/div>/)?.[0] ?? '';
    assert.match(row, /modified/); assert.match(row, /data-act="set-reset"/); assert.match(row, /data-default="&quot;high&quot;"/);
    assert.match(html, /class="ssub danger"/);
    for (const s of d.settings) assert.ok(html.includes(`id="set-${s.key}"`) || html.includes(`data-key="${s.key}"`), 'row for ' + s.key);
    assert.ok(!html.includes('class="primary"'), 'one accent colour = needs you');
  } finally { await f.done(); }
});
