// The Norn look (META-VISUAL-B S1): palette lock on every tab, integer art scale, render on change only, QUIET static,
// reduced motion honoured, the classic look still selectable, the one asset map (art drops in with no code change), pins.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { ENGINE, fixture } from './helpers/dash-fixture.mjs';
import { PALETTE } from '../engine/dash/norn/palette.mjs';
import { HEX, artScale, glyphPixels, GLYPHS, RAMP } from '../engine/dash/norn/pixel.mjs';
import { ASSETS, ART_FILES, TOKENS, EMPTIES, CHIP_TOKEN } from '../engine/dash/norn/assets.mjs';
import { createScheduler, motionAllowed } from '../engine/dash/norn/motion.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { dashCss } from './helpers/dash-css.mjs';

const N = path.join(ENGINE, 'dash', 'norn'), DASH = path.join(ENGINE, 'dash');
const css = fs.readFileSync(path.join(N, 'norn.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const html = fs.readFileSync(path.join(DASH, 'index.html'), 'utf8');
const classic = dashCss().replace(/\/\*[\s\S]*?\*\//g, '');
const rules = text => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] }));
const PAL = new Set(HEX);

test('palette lock: palette.mjs = palette.hex (32 colours); every Norn CSS colour and glyph pixel is a palette entry', () => {
  const hex = fs.readFileSync(path.join(N, 'palette.hex'), 'utf8').trim().split(/\r?\n/);
  assert.equal(hex.length, 32); assert.deepEqual(PALETTE.map(p => p[1]), hex);
  const values = rules(css).flatMap(r => r.body.split(';').map(d => d.split(':').slice(1).join(':')));   // declaration values only (not #id selectors)
  const lits = values.flatMap(v => [...v.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0].toLowerCase()));
  assert.ok(lits.length > 40);
  assert.deepEqual(lits.filter(h => !PAL.has(h)), [], 'off-palette hex in norn.css');
  assert.ok(!/rgba?\(|hsla?\(|color-mix\(|\b(white|black|gray|grey|red|blue|green)\b/i.test(css), 'no rgba / hsl / color-mix / named colour');
  for (const m of css.matchAll(/opacity\s*:\s*([\d.]+)/g)) assert.equal(Number(m[1]), 1, 'no translucency');
  for (const g of Object.keys(GLYPHS)) for (const ground of ['dark', 'light']) for (const [, , c] of glyphPixels(g, ground)) assert.ok(PAL.has(c), `${g} ${ground} ${c}`);
  for (const r of Object.values(RAMP)) for (const n of r) assert.ok(PAL.has(PALETTE.find(p => p[0] === n) && '#' + PALETTE.find(p => p[0] === n)[1]), n);
  for (const g of Object.values(GLYPHS)) for (const row of g) assert.equal(row.length, 9);
});

test('palette lock on all tabs: every classic colour variable is redefined on both Norn grounds; the classic rules use only variables', () => {
  const vars = new Set([...classic.matchAll(/(--[a-z-]+)\s*:/g)].map(m => m[1]));
  assert.ok(vars.size >= 22);
  for (const g of ['dark', 'light']) {
    const block = css.match(new RegExp(`:root\\.norn\\[data-ground=${g}\\]\\s*\\{([^}]*)\\}`))[1];
    const def = Object.fromEntries([...block.matchAll(/(--[a-z-]+)\s*:\s*([^;]+);?/g)].map(m => [m[1], m[2].trim()]));
    for (const v of vars) { assert.ok(def[v], `${g}: ${v} missing`); assert.ok(PAL.has(def[v].toLowerCase()), `${g}: ${v} = ${def[v]}`); }
  }
  // colour literals in the classic sheet live only in custom-property declarations (the theme blocks)
  for (const r of rules(classic.replace(/@media[^{]*\{/g, ''))) {
    const decls = r.body.split(';').filter(d => d.trim() && !d.trim().startsWith('--'));
    for (const d of decls) assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(|color-mix\(/.test(d), `${r.sel}: ${d.trim()}`);
  }
  // every classic fade (opacity < 1) is redrawn solid under the Norn look
  const fades = rules(classic).filter(r => /opacity\s*:\s*\.?\d*\.?\d+/.test(r.body) && Number(r.body.match(/opacity\s*:\s*([\d.]+)/)[1]) < 1);
  assert.ok(fades.length >= 4);   // the old lane table's and the Map's fades left with them (stage LANES)
  const nr = rules(css);
  for (const f of fades) for (const sel of f.sel.split(',').map(x => x.trim())) {
    assert.ok(nr.some(r => r.sel.split(',').map(x => x.trim()).includes(`:root.norn ${sel}`) && /opacity\s*:\s*1\b/.test(r.body)), `fade ${sel} not redrawn`);
  }
});

test('render on change: no poke -> no render; a burst -> one render; hidden defers to one catch-up render; a poke mid-render queues one more', async () => {
  const timers = []; let hidden = false, renders = 0, release = null;
  const s = createScheduler({ render: async () => { renders++; if (release === 'hold') await new Promise(r => { release = r; }); }, hidden: () => hidden,
    setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
  const flush = async () => { while (timers.length) { await timers.shift()(); } };
  await flush(); assert.equal(renders, 0, 'idle: nothing scheduled');
  for (let i = 0; i < 20; i++) s.poke('rec');
  assert.equal(timers.length, 1, 'a burst coalesces into one timer'); await flush(); assert.equal(renders, 1);
  hidden = true; for (let i = 0; i < 5; i++) s.poke('rec'); await flush();
  assert.equal(renders, 1, 'hidden: no render'); assert.equal(timers.length, 0, 'hidden: no timer either');
  hidden = false; s.visible(); await flush(); assert.equal(renders, 2, 'one catch-up render when shown');
  s.visible(); await flush(); assert.equal(renders, 2, 'shown again with nothing new: nothing');
  release = 'hold'; s.poke('a'); const t = timers.shift(); const p = t(); await new Promise(r => setImmediate(r));
  s.poke('b'); s.poke('c'); if (timers.length) await timers.shift()();
  const r = release; release = null; r(); await p; await flush();
  assert.equal(renders, 4, 'the pokes during a render give exactly one more');
});

test('QUIET holds a static frame and reduced motion is honoured: motion only when visible, not QUIET, not reduced; every animation is scoped under .motion', () => {
  assert.equal(motionAllowed({}), true);
  assert.equal(motionAllowed({ quiet: true }), false);
  assert.equal(motionAllowed({ reduced: true }), false);
  assert.equal(motionAllowed({ hidden: true }), false);
  for (const r of rules(css)) if (/animation|transition/.test(r.body)) assert.ok(r.sel.split(',').every(x => x.includes('.motion')), r.sel);
  assert.ok(!/@keyframes/.test(css) || /\.motion/.test(css));
  const look = fs.readFileSync(path.join(N, 'look.mjs'), 'utf8');
  assert.match(look, /prefers-reduced-motion: reduce/); assert.match(look, /visibilitychange/); assert.match(look, /motionAllowed\(/);
  assert.ok(!/requestAnimationFrame|setInterval/.test(look + fs.readFileSync(path.join(N, 'pixel.mjs'), 'utf8')), 'no loop in the look kit');
  assert.match(html, /setQuiet\(/, 'the stream QUIET flag drives the motion class');
});

test('served: the Norn modules + sheet by allowlist, the font pinned, three.js gone, fonts / styles allowed by the CSP, art drops in with no code change', async () => {
  const V = path.join(DASH, 'vendor'), md = fs.readFileSync(path.join(V, 'VENDOR.md'), 'utf8');
  for (const f of ['silkscreen-latin-400-normal.woff2', 'silkscreen-latin-700-normal.woff2']) {
    const sha = md.match(new RegExp('`' + f.replace(/\./g, '\\.') + '` sha256 `([0-9a-f]{64})`'))[1];
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(V, f))).digest('hex'), sha, f);
  }
  const artDir = mkTmp('norn-art-'), f = await fixture({ dash: { artDir } }), art = path.join(artDir, 'token-running-16.png');
  try {
    const csp = (await fetch(f.url + '/')).headers.get('content-security-policy');
    assert.match(csp, /font-src 'self'/); assert.match(csp, /style-src 'self'/);
    for (const [p, ty] of [['/norn/norn.css', /text\/css/], ['/norn/look.mjs', /javascript/], ['/norn/pixel.mjs', /javascript/], ['/norn/palette.mjs', /javascript/],
      ['/norn/assets.mjs', /javascript/], ['/norn/motion.mjs', /javascript/],
      ['/vendor/silkscreen-latin-400-normal.woff2', /font\/woff2/]]) {
      const r = await fetch(f.url + p); assert.equal(r.status, 200, p); assert.match(r.headers.get('content-type'), ty, p);
    }
    const w = Buffer.from(await (await fetch(f.url + '/vendor/silkscreen-latin-400-normal.woff2')).arrayBuffer());
    assert.ok(w.equals(fs.readFileSync(path.join(DASH, 'vendor', 'silkscreen-latin-400-normal.woff2'))), 'binary served intact');
    for (const p of ['/norn/make-palette.mjs', '/norn/palette.hex', '/norn/art/evil.png', '/norn/art/token-running-16.png', '/vendor/LICENSE.three', '/vendor/three.module.js', '/vendor/three.core.js', '/norn/../server.mjs']) assert.equal((await fetch(f.url + p)).status, 404, p);
    assert.deepEqual((await f.get('/norn/assets.json')).data.present, []);
    fs.mkdirSync(path.dirname(art), { recursive: true }); fs.writeFileSync(art, Buffer.from('89504e470d0a1a0a', 'hex'));
    assert.deepEqual((await f.get('/norn/assets.json')).data.present, ['token-running-16'], 'a dropped-in file is listed');
    const r = await fetch(f.url + '/norn/art/token-running-16.png'); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /image\/png/);
    assert.match(html, /href="\/norn\/norn\.css"/); assert.match(await (await fetch(f.url + '/pages/settings.mjs')).text(), /data-act="look"/, 'the classic look stays selectable (Settings > Look)');
  } finally { fs.rmSync(artDir, { recursive: true, force: true }); await f.done(); }
});

// the owner's pick (Q-43 = b; state tokens round 4, norn Q-3) vendored from norn-art-r2/out under the asset map's names: every
// file present, its exact size, palette-indexed (PNG colour type 3) with the palette.hex colours, no other file in art/
// the palette indices an 8-bit indexed PNG's pixels use (IDAT inflated + unfiltered, PNG spec 9)
function pngIndices(b) {
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20), parts = [];
  for (let i = 8; i < b.length;) { const n = b.readUInt32BE(i); if (b.toString('latin1', i + 4, i + 8) === 'IDAT') parts.push(b.subarray(i + 8, i + 8 + n)); i += 12 + n; }
  const raw = inflateSync(Buffer.concat(parts)), out = new Set(), prev = new Uint8Array(w), cur = new Uint8Array(w);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (w + 1)];
    for (let x = 0; x < w; x++) {
      const v = raw[y * (w + 1) + 1 + x], a = x ? cur[x - 1] : 0, u = prev[x], c = x ? prev[x - 1] : 0, pa = Math.abs(u - c), pb = Math.abs(a - c), pc = Math.abs(a + u - 2 * c);
      cur[x] = (v + [0, a, u, (a + u) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? u : c][f]) & 255; out.add(cur[x]);
    }
    prev.set(cur);
  }
  return out;
}

test('the Norn page bar (stage NAV): one row of 4 links + More, the open one filled with the accent in inverse ink, hover / focus distinct; no switch left', async () => {
  const { renderBar } = await import('../engine/dash/shell.mjs');
  assert.ok(!/navgroups/.test(html), 'the R1 ?navgroups switch is gone'); assert.ok(!/data-navgroups/.test(css), 'the R1 variant blocks are gone');
  const nav = renderBar('records', {});
  assert.ok(!/class="ng /.test(nav) && !/class="pages/.test(nav), 'one row: no group frames, no pages row');
  assert.match(nav, /id="tab-more"[^>]*aria-current="page"/, 'a More page marks More');
  const nr = rules(css.replace(/@media[^{]*\{/g, '')), body = sel => nr.filter(r => r.sel.split(',').map(s => s.trim()).includes(sel)).map(r => r.body).join(';');
  const n = (s, v) => assert.match(body(s), v, s);
  for (const g of ['dark', 'light']) for (const v of ['--nv', '--nu', '--ns', '--ninv']) assert.match(body(`:root.norn[data-ground=${g}]`), new RegExp(`${v}\\s*:\\s*#`), `${g} ${v}`);
  const act = ':root.norn .pagebar>[aria-current=page]';
  n(act, /background\s*:\s*var\(--accent\)/); n(act, /color\s*:\s*var\(--ninv\)/);
  n(':root.norn .pagebar>a:hover', /background\s*:\s*var\(--soft\)/); assert.ok(!/accent/.test(body(':root.norn .pagebar>a:hover')), 'hover is not the active fill');
  n(':root.norn .pagebar>button', /border\s*:\s*0/);   // More reads as one of the bar's items, not a framed button (the norn button rule)
  n(':root.norn .pagebar>a:focus-visible', /outline\s*:[^;]*solid var\(--ink\)/); n(`${act}:focus-visible`, /outline-color\s*:\s*var\(--ninv\)/);
  // the tones stay the three time colours (the status strip's parts) and the More dot's two Health states
  for (const [k, v] of [['urd', 'rm-past'], ['verd', 'rm-now'], ['skuld', 'rm-fut'], ['warn', 'warn'], ['bad', 'bad']]) n(`.tone-${k}`, new RegExp(`--t\\s*:\\s*var\\(--${v}\\)`));
});

// META-TEND P6: SloppaChoppa's vendored art (norn-art-orc/out, ORC-1 round 5 + 6) under the asset map's names: each file its exact
// size, palette-indexed (colour type 3), binary alpha, and every colour its pixels use on palette.hex
test('the orc art: every orc asset present at its size, indexed, binary alpha, on the palette', () => {
  const orc = Object.values(ASSETS).filter(a => a.file.startsWith('orc-'));
  assert.equal(orc.length, 10);
  for (const a of orc) {
    const b = fs.readFileSync(path.join(N, 'art', a.file));
    assert.deepEqual([b.readUInt32BE(16), b.readUInt32BE(20), b[24], b[25]], [a.w, a.h, 8, 3], a.file);
    const chunk = t => { for (let i = 8; i < b.length;) { const n = b.readUInt32BE(i); if (b.toString('latin1', i + 4, i + 8) === t) return b.subarray(i + 8, i + 8 + n); i += 12 + n; } return null; };
    const plte = chunk('PLTE'), trns = chunk('tRNS') ?? Buffer.alloc(0);
    assert.ok([...trns].every(v => v === 0 || v === 255), `${a.file}: binary alpha`);
    for (const i of pngIndices(b)) {
      if (trns[i] === 0) continue;
      const hex = plte.subarray(3 * i, 3 * i + 3).toString('hex');
      assert.ok(PAL.has('#' + hex), `${a.file}: #${hex} is not on palette.hex`);
    }
  }
});

// META-TEND P6 shots: the phone header's 16 axe sits in a 44 px touch target - on the UI scale (--px, whole device pixels, ~2x),
// not at 16 device pixels (a speck at 8 css px on a 2x phone)
// (look.mjs assetImg: k 'ui' = calc(w * var(--px)), else var(--d1))
test('the phone header orc-16 is drawn on the UI scale', () => {
  assert.equal(ASSETS['orc-16'].k, 'ui');
  assert.equal(ASSETS['orc-32'].k, 1, 'the desktop 32 stays at its native size');
});
