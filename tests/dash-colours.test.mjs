// UX review 3: the status colours are distinct and conventional in every look and ground - ok green, warn amber, bad red, run blue
// (Norn: blue-grey), accent (= needs you) never the bad red - and each chip's text on its own background is WCAG AA (>= 4.5:1).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dashCss } from './helpers/dash-css.mjs';

const D = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'dash');
const html = dashCss(), norn = fs.readFileSync(path.join(D, 'norn', 'norn.css'), 'utf8');
const vars = block => Object.fromEntries([...block.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\b/g)].map(m => [m[1], m[2].toLowerCase()]));
const grab = (src, re) => { const m = src.match(re); assert.ok(m, String(re)); return vars(m[1]); };
const THEMES = {
  'classic light': grab(html, /:root\.light\{([^}]*)\}/),
  'classic dark': grab(html, /:root\.dark\{([^}]*)\}/),
  'classic system light': grab(html, /^[^]*?\n:root\{([^}]*)\}/),
  'classic system dark': grab(html, /@media \(prefers-color-scheme:dark\)\{:root\{([^}]*)\}/),
  'norn dark': grab(norn, /:root\.norn\[data-ground=dark\] \{([^}]*)\}/),
  'norn light': grab(norn, /:root\.norn\[data-ground=light\] \{([^}]*)\}/),
};
const rgb = h => (h.length === 4 ? [1, 2, 3].map(i => parseInt(h[i] + h[i], 16)) : [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)));
const lum = h => { const [r, g, b] = rgb(h).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const hue = h => { const [r, g, b] = rgb(h).map(v => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (!d) return null;
  const x = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (x * 60 + 360) % 360; };
const inHue = (h, lo, hi) => { const x = hue(h); return x !== null && (lo <= hi ? x >= lo && x <= hi : x >= lo || x <= hi); };

test('every look and ground: chip text on its background is WCAG AA (ok, warn, bad, accent / needs, run) and the accent fill carries its text', () => {
  for (const [name, t] of Object.entries(THEMES)) {
    for (const k of ['ok', 'warn', 'bad', 'accent', 'run']) {
      assert.ok(t[`--${k}`] && t[`--${k}-bg`], `${name}: --${k} / --${k}-bg defined`);
      const c = contrast(t[`--${k}`], t[`--${k}-bg`]);
      assert.ok(c >= 4.5, `${name}: --${k} ${t[`--${k}`]} on --${k}-bg ${t[`--${k}-bg`]} is ${c.toFixed(2)}:1 (< 4.5)`);
    }
    const c = contrast(t['--on-accent'], t['--accent']);
    assert.ok(c >= 4.5, `${name}: --on-accent on --accent (the count badge, the primary button) is ${c.toFixed(2)}:1`);
  }
});

test('stage NAV item 5: the codex chip is ink text + a purple marker (AA in every ground); --field-line is >= 3:1 on every field ground', () => {
  assert.match(html, /\.chip\.codex\{background:var\(--codex-bg\);color:var\(--ink\)\}/, 'codex chip text is ink (A-04)');
  assert.match(html, /\.chip\.codex::before\{[^}]*background:var\(--codex\)/, 'the purple lives in the marker');
  assert.ok(!/\.chip\.codex\s*\{[^}]*color:\s*var\(--codex\)/.test(norn), 'the norn look keeps the ink text');
  for (const [name, t] of Object.entries(THEMES)) {
    const c = contrast(t['--ink'], t['--codex-bg']), m = contrast(t['--codex'], t['--codex-bg']);
    assert.ok(c >= 4.5, `${name}: codex chip ink on --codex-bg is ${c.toFixed(2)}:1 (< 4.5)`);
    assert.ok(m >= 3, `${name}: the codex marker on --codex-bg is ${m.toFixed(2)}:1 (< 3, WCAG 1.4.11)`);
    for (const g of ['--bg', '--panel', '--soft'].filter(k => t[k])) {
      const f = contrast(t['--field-line'] ?? '#000', t[g]);
      assert.ok(t['--field-line'] && f >= 3, `${name}: --field-line ${t['--field-line']} on ${g} ${t[g]} is ${f.toFixed(2)}:1 (< 3, A-12)`);
    }
  }
  assert.match(html, /select,button,input\{[^}]*border:1px solid var\(--field-line\)/, 'fields draw their border with --field-line');
});

test('stage NAV item 5: a pressed filter chip is outlined in the run hue with ink text in both looks, never amber', () => {
  const rules = [...`${html}\n${norn}`.matchAll(/\.hf\[aria-pressed=true\]\s*\{([^}]*)\}/g)].map(m => m[1]);
  assert.ok(rules.length >= 1, 'a pressed .hf rule');
  for (const r of rules) { assert.match(r, /border-color:\s*var\(--run\)/); assert.match(r, /color:\s*var\(--ink\)/); assert.ok(!/--gold|--warn/.test(r), `amber in ${r}`); }
});

test('every look and ground: ok / warn / bad / accent / run are five different colours with the conventional hues', () => {
  for (const [name, t] of Object.entries(THEMES)) {
    const set = ['ok', 'warn', 'bad', 'accent', 'run'].map(k => t[`--${k}`]);
    assert.equal(new Set(set).size, 5, `${name}: ${set.join(' ')} not distinct`);
    assert.notEqual(t['--accent'], t['--bad'], `${name}: an error must not look like a highlight`);
    assert.ok(inHue(t['--bad'], 345, 20), `${name}: bad ${t['--bad']} is red (hue ${hue(t['--bad'])?.toFixed(0)})`);
    assert.ok(inHue(t['--warn'], 25, 60), `${name}: warn ${t['--warn']} is amber (hue ${hue(t['--warn'])?.toFixed(0)})`);
    assert.ok(inHue(t['--ok'], 70, 160), `${name}: ok ${t['--ok']} is green (hue ${hue(t['--ok'])?.toFixed(0)})`);
    assert.ok(!inHue(t['--accent'], 345, 60), `${name}: accent ${t['--accent']} is not in the red / amber range (hue ${hue(t['--accent'])?.toFixed(0)})`);
  }
});

test('chips: warn / bad / ok / needs chip classes use their own token pair; the own-account executor chip is neutral (not a warning)', () => {
  assert.match(html, /\.chip\.open,\.chip\.needs\{background:var\(--accent-bg\);color:var\(--accent\)\}/);
  assert.match(html, /\.chip\.handoff,\.chip\.answered,\.chip\.parked,\.chip\.warn\{background:var\(--warn-bg\);color:var\(--warn\)\}/);
  assert.match(html, /\.chip\.stopped,[^{]*\.chip\.bad[^{]*\{background:var\(--bad-bg\);color:var\(--bad\)\}/);
  assert.ok(!/\.chip\.prov\{[^}]*--warn/.test(html), 'prov is a kind of executor, not a warning');
});

// D-28: CSS that silently does nothing - a var() nothing sets (page code sets some inline), a bare rule a later page re-declares for
// the whole dashboard, a phone rule a later sheet always resets
const classic = fs.readdirSync(path.join(D, 'css')).map(f => fs.readFileSync(path.join(D, 'css', f), 'utf8')).join('\n'), all = `${classic}\n${norn}`.replace(/\/\*[\s\S]*?\*\//g, '');
const pageCode = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.name === 'vendor' ? [] : e.isDirectory() ? pageCode(path.join(dir, e.name)) : /\.(mjs|html)$/.test(e.name) ? [fs.readFileSync(path.join(dir, e.name), 'utf8')] : []);
test('D-28: every var() a classic sheet reads without a fallback is set somewhere; one bare .tag; no phone rule reset by a later sheet', () => {
  const set = new Set([...[all, ...pageCode(D)].join('\n').matchAll(/(--[\w-]+)\s*:|setProperty\('(--[\w-]+)'/g)].map(m => m[1] ?? m[2]));
  assert.deepEqual([...new Set([...classic.matchAll(/var\((--[\w-]+)\)/g)].map(m => m[1]))].filter(v => !set.has(v)), [], 'undefined custom properties');
  assert.equal([...all.matchAll(/(?:^|[}\n])\s*\.tag\s*\{/g)].length, 1, 'a second bare .tag re-styles every tag'); assert.match(all, /\.home \.tag\s*\{/, 'the Talk tag is scoped');
  assert.doesNotMatch(all, /\.docsrc tr td:last-child\{grid-column/, 'set in base.css only to be reset in context.css');
});
