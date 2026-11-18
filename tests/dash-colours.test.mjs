// UX review 3: the status colours are distinct and conventional in every look and ground - ok green, warn amber, bad red, run blue
// (Norn: blue-grey), accent (= needs you) never the bad red - and each chip's text on its own background is WCAG AA (>= 4.5:1).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const D = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'dash');
const html = fs.readFileSync(path.join(D, 'index.html'), 'utf8'), norn = fs.readFileSync(path.join(D, 'norn', 'norn.css'), 'utf8');
const vars = block => Object.fromEntries([...block.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\b/g)].map(m => [m[1], m[2].toLowerCase()]));
const grab = (src, re) => { const m = src.match(re); assert.ok(m, String(re)); return vars(m[1]); };
const THEMES = {
  'classic light': grab(html, /:root\.light\{([^}]*)\}/),
  'classic dark': grab(html, /:root\.dark\{([^}]*)\}/),
  'classic system light': grab(html, /<style>[^]*?\n:root\{([^}]*)\}/),
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
