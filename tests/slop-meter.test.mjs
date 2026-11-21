// slop-meter S1: the slop meter (engine/lib/slop/meter.mjs) on in-memory texts, no git - a hit / miss pair per signal, the log anchor
// math, the same input giving the same score, the band edges and their hysteresis; the strip field and the Slop page's gauge render, and the server reads the meter from the daily series.
import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorScore, bandOf, meterOf, meterDelta, loadMeter, nearDups, functionsOf, prep } from '../engine/lib/slop/meter.mjs';
import { loadRules } from '../engine/lib/slop/check.mjs';
import { renderStatus } from '../engine/dash/shell.mjs';
import { slopPage } from '../engine/dash/pages/slop.mjs';
import { hostWrite } from '../engine/lib/slop/host.mjs';
import { fixture } from './helpers/dash-fixture.mjs';

const cfg = loadMeter(), rules = loadRules();
const run = (texts, git = {}) => meterOf(texts, git, cfg, { rules });
const sig = (texts, id, git) => run(texts, git).signals.find(s => s.id === id);
const lines = (n, f = i => `export const v${i} = ${i};`) => Array.from({ length: n }, (_, i) => f(i)).join('\n') + '\n';
// a body long enough for MinHash (30+ shape tokens); rename changes every identifier, keeping the shape
const long = (name, a = 'items', b = 'total') => `export function ${name}(${a}) {\n  let ${b} = 0;\n  for (const x of ${a}) { if (x.ok && x.n > 2) ${b} += x.n * 3; else if (x.skip) continue; else ${b} -= 1; }\n  const out = { ${b}, n: ${a}.length, mean: ${b} / Math.max(1, ${a}.length) };\n  return out;\n}\n`;

test('the anchor math: good scores 0, bad 100, the geometric mean 50, either direction; nothing measured is null', () => {
  const a = { good: 2, bad: 40 };
  assert.equal(anchorScore(2, a), 0); assert.equal(anchorScore(40, a), 100); assert.equal(anchorScore(1, a), 0); assert.equal(anchorScore(400, a), 100);
  assert.ok(Math.abs(anchorScore(Math.sqrt(80), a) - 50) < 1e-9);
  const up = { good: 0.8, bad: 0.2 };   // higher is better (S1: deleted per added line)
  assert.equal(anchorScore(0.8, up), 0); assert.equal(anchorScore(0.2, up), 100); assert.ok(Math.abs(anchorScore(0.4, up) - 50) < 1e-9);
  assert.equal(anchorScore(0, a), 0); assert.equal(anchorScore(0, up), 100); assert.equal(anchorScore(null, a), null);
});

test('the bands: the edges, and a band that holds until the score passes its edge by 2', () => {
  assert.deepEqual([0, 19.9, 20, 39.9, 40, 60, 80, 100].map(s => bandOf(s, cfg)), ['Tended', 'Tended', 'Weedy', 'Weedy', 'Sloppy', 'Slopified', 'Full slop', 'Full slop']);
  assert.equal(bandOf(41, cfg, 'Weedy'), 'Weedy'); assert.equal(bandOf(42, cfg, 'Weedy'), 'Sloppy');
  assert.equal(bandOf(18.5, cfg, 'Weedy'), 'Weedy'); assert.equal(bandOf(18, cfg, 'Weedy'), 'Tended');
  assert.equal(bandOf(90, cfg, 'Weedy'), 'Full slop', 'a jump past the edge goes straight to its band');
  assert.equal(meterDelta([{ day: '2026-11-01', score: 30 }, { day: '2026-11-05', score: 33 }], '2026-11-10', 35), 5, 'the newest point 7+ days old');
  assert.equal(meterDelta([{ day: '2026-11-08', score: 33 }], '2026-11-10', 35), 2, 'the first week: the oldest point');
  assert.equal(meterDelta([], '2026-11-10', 35), null);
});

test('functions: declarations, arrows (one parameter too), methods; one statement and its parameters', () => {
  const f = functionsOf(prep('a.mjs', 'export function a(x, y) { return b(x, y); }\nconst c = z => d(z);\nclass K {\n  m(q) {\n    return q;\n  }\n}\nexport const e = async ({ p }) => { await p; q(); };\n'));
  assert.deepEqual(f.map(x => [x.name, x.kind, x.top, x.exported, x.params, x.stmts]),
    [['a', 'function', true, true, ['x', 'y'], 1], ['c', 'arrow', true, false, ['z'], 1], ['e', 'arrow', true, true, null, 2], ['m', 'method', false, false, ['q'], 1]]);
});

test('signals: a hit and a near miss each', () => {
  // S6 pass-through vs a real wrapper
  assert.equal(sig({ 'a.mjs': 'export const a = (x, y) => b(x, y);\nexport function c(s) { return new URL(s); }\n' }, 'S6').n, 2);
  assert.equal(sig({ 'a.mjs': 'export const a = (x, y) => b(y, x * 2);\nexport function c(s) { return new URL(s, base); }\n' }, 'S6').n, 0);
  // S3 a god file vs the same lines split in three
  assert.ok(sig({ 'god.mjs': lines(900) }, 'S3').parts.god.value > 0.9);
  assert.equal(sig({ 'a.mjs': lines(300), 'b.mjs': lines(300), 'c.mjs': lines(300) }, 'S3').parts.god.value, 0);
  // S9 near-duplicates (renamed) vs two different bodies
  assert.equal(sig({ 'a.mjs': long('sumA'), 'b.mjs': long('sumB', 'rows', 'acc') }, 'S9').n, 2);
  assert.equal(sig({ 'a.mjs': long('sumA'), 'b.mjs': 'export function other(t) {\n  const parts = String(t).split(/,/).map(s => s.trim()).filter(Boolean);\n  while (parts.length > 3) parts.pop();\n  return parts.join(" + ") || null;\n}\n' }, 'S9').n, 0);
  // S12 an empty catch and a default return vs a reasoned catch and one that reads the error
  assert.equal(sig({ 'a.mjs': 'try { f(); } catch {}\nfunction g() { try { return f(); } catch (e) { return null; } }\np.catch(() => null);\n' }, 'S12').n, 3);
  assert.equal(sig({ 'a.mjs': 'try { f(); } catch { /* the file may be gone: start empty */ }\nfunction g() { try { return f(); } catch (e) { return e.code; } }\n' }, 'S12').n, 0);
  // S13 a lint silencer vs a plain comment
  assert.equal(sig({ 'a.mjs': '// eslint-disable-next-line no-console\nconsole.log(1);\n' }, 'S13').n, 1);
  assert.equal(sig({ 'a.mjs': '// the log line the owner reads\nconsole.log(1);\n' }, 'S13').n, 0);
  // S14 a comment that repeats the code vs one that says why; S14T a stage tag (counted apart, weight 0)
  assert.equal(sig({ 'a.mjs': '// read the config\nconst c = readConfig();\n' }, 'S14').n, 1);
  assert.equal(sig({ 'a.mjs': '// a missing file means a fresh state\nconst c = readConfig();\n' }, 'S14').n, 0);
  const t = run({ 'a.mjs': '// META-X S1: the count\nconst c = 1;\n' }).signals.find(s => s.id === 'S14T');
  assert.equal(t.n, 1); assert.equal(t.w, 0);
  // S7 an abstraction name vs a plain one (a lowercase "inBase" is no abstraction)
  assert.equal(sig({ 'a.mjs': 'export class UserFactory {}\n' }, 'S7').n, 1);
  assert.equal(sig({ 'a.mjs': 'export class User {}\nexport const inBase = x => x;\n' }, 'S7').n, 0);
  // S8 a private helper called once vs one called twice
  assert.equal(sig({ 'a.mjs': 'const pad = s => s.trim();\nexport const f = x => pad(x) + 1;\n' }, 'S8').n, 1);
  assert.equal(sig({ 'a.mjs': 'const pad = s => s.trim();\nexport const f = x => pad(x) + pad(x);\n' }, 'S8').n, 0);
  // S10 one top-level name declared in two modules of a group vs one
  assert.equal(sig({ 'engine/lib/a.mjs': 'export const num = n => String(n);\n', 'engine/lib/b.mjs': 'const num = n => String(n);\nexport const b = num(1);\n' }, 'S10').n, 1);
  assert.equal(sig({ 'engine/lib/a.mjs': 'export const num = n => String(n);\n', 'engine/lib/b.mjs': 'export const b = 1;\n' }, 'S10').n, 0);
  // S15 a module nothing names and a versioned name vs an imported module
  assert.equal(sig({ 'lib/a.mjs': 'export const parse_v2 = x => x;\n', 'lib/b.mjs': 'export const b = 1;\n' }, 'S15').n, 3);
  assert.equal(sig({ 'lib/a.mjs': "import { b } from './b.mjs';\nexport const a = b;\n", 'lib/b.mjs': 'export const b = 1;\n' }, 'S15').n, 1, 'a.mjs itself is named by nothing');
  // S16 a deferral with no record (K22's own pattern) vs a plain comment
  assert.equal(sig({ 'engine/a.mjs': '// for now the retry is off\nexport const a = 1;\n' }, 'S16').n, 1);
  assert.equal(sig({ 'engine/a.mjs': '// the retry is off: the queue retries\nexport const a = 1;\n' }, 'S16').n, 0);
  // S1 net growth from the landings: deleted per added code line, big landings per week
  const s1 = sig({ 'a.mjs': 'export const a = 1;\n' }, 'S1', { landings: [{ added: { code: 100 }, deleted: { code: 80 }, big: false }, { added: { code: 1900 }, deleted: { code: 20 }, big: true }] });
  assert.equal(s1.parts.kept.value, 0.05); assert.equal(s1.parts.big.value, 0.233);
});

test('the same input gives the same score; another sha with the same texts too (no sampled signal changes)', () => {
  const texts = { 'engine/lib/a.mjs': long('sumA') + 'try { f(); } catch {}\n', 'engine/lib/b.mjs': long('sumB', 'rows', 'acc') + "import { sumA } from './a.mjs';\n", 'engine/lib/god.mjs': lines(900) };
  const a = run(texts, { sha: 'a'.repeat(40) }), b = run(texts, { sha: 'a'.repeat(40) }), c = run(texts, { sha: 'b'.repeat(40) });
  assert.deepEqual(a, b);
  assert.equal(c.score, a.score); assert.deepEqual(c.signals, a.signals); assert.equal(c.hash, a.hash);
  assert.ok(a.score > 0 && a.top.length > 0 && a.top.every(o => o.pts > 0));
  const fns = Object.entries(texts).flatMap(([f, t]) => functionsOf(prep(f, t)));
  assert.deepEqual(nearDups(fns, cfg.minhash, cfg.seed), nearDups(fns, cfg.minhash, cfg.seed));
});

test('the server: /api/strip and the Slop summary read the meter from the daily series (no scan)', async () => {
  const f = await fixture();
  try {
    const S = f.pa.state, top = [{ signal: 'S3', file: 'engine/bin/norn.mjs', line: 1, what: 'god file', pts: 1.8 }];
    hostWrite(S, { type: 'daily', day: '2026-11-12', report: '#\n', line: 'l', point: { meter: { score: 35.1, band: 'Weedy', groups: { Structure: 60 }, top, hash: 'h' } } });
    hostWrite(S, { type: 'daily', day: '2026-11-20', report: '#\n', line: 'l', point: { meter: { score: 37.4, band: 'Weedy', groups: { Structure: 61 }, top, hash: 'h' } } });
    assert.deepEqual((await f.get('/api/strip?project=kestrel')).data.slop, { day: '2026-11-20', score: 37.4, band: 'Weedy', delta: 2.3 });
    const m = (await f.get('/api/guard?project=kestrel&part=summary')).data.meter;
    assert.equal(m.score, 37.4); assert.deepEqual(m.trend.map(p => p.score), [35.1, 37.4]); assert.equal(m.bands.length, 5);
    assert.match(m.top[0].abs, /\/engine\/bin\/norn\.mjs$/);
  } finally { await f.done(); }
});

test('the strip field and the Slop gauge show the meter', () => {
  const html = renderStatus({ running: {}, usage: {}, checkin: {}, needs_you: 0, slop: { score: 37.4, band: 'Weedy', delta: 2.2 } }, { look: 'classic', project: 'p' });
  assert.match(html.replace(/<[^>]+>/g, ''), /slop 37 Weedy ↑2/);
  assert.match(html, /id="strip-slop"[^>]*>|data-tab="slop" id="strip-slop"/);
  const page = slopPage({ sub: 'fix', meter: { score: 37.4, band: 'Weedy', delta: -3, bands: cfg.bands, groups: { Structure: 61, Noise: 9 }, trend: [{ day: '2026-11-19', score: 40 }, { day: '2026-11-20', score: 37.4 }],
    top: [{ signal: 'S3', file: 'engine/bin/norn.mjs', line: 1, what: 'god file', pts: 1.8, abs: 'C:/r/engine/bin/norn.mjs' }] } });
  assert.match(page, /<details class="smeter" id="slop-meter">/);
  assert.match(page, /smnum">37<\/b> <b class="smband">Weedy<\/b> <span class="smturn down">↓3/);
  assert.match(page, /data-ins="path:C:\/r\/engine\/bin\/norn\.mjs" data-line="1"/);
  assert.equal((page.match(/class="smseg /g) || []).length, 5);
  assert.ok(page.indexOf('id="slop-meter"') < page.indexOf('id="slop-sub"'), 'the gauge sits above the views');
});
