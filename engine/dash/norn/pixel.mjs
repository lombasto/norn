// Norn pixel kit (ported from META-VISUAL-A2 design/visual-v2/norn/pixel.mjs of the Norn project, RUN-1613): integer device-pixel scale,
// 9-slice panel art, 9 x 9 state glyphs, dithered bars, the woven rule. Every image is drawn at 1x (one art px = one canvas
// px) from the fixed 32-colour palette and shown with image-rendering: pixelated at k WHOLE device px per art px
// (CSS size = k / devicePixelRatio). The pure parts (scale, palette, glyph rows) run in node for the tests.
import { PALETTE } from './palette.mjs';

export const P = Object.fromEntries(PALETTE.map(([n, h]) => [n, '#' + h]));
export const HEX = PALETTE.map(([, h]) => '#' + h);

// ---------- scale ----------
// k device px per art px: 2 at 100 %, 3 at 125 % (round(2 * 1.25) = 3 -> 2.4 CSS px), 3 at 150 %, 4 at 200 %. d1 = one device px.
export function artScale(dpr = 1, base = 2) { const d = dpr > 0 ? dpr : 1, k = Math.max(1, Math.round(base * d)); return { k, css: k / d, d1: 1 / d, dpr: d }; }
export function applyScale(root, onChange) {
  const set = () => { const s = artScale(globalThis.devicePixelRatio || 1); root.style.setProperty('--px', s.css + 'px'); root.style.setProperty('--d1', s.d1 + 'px'); root.dataset.k = s.k; return s; };
  let s = set();
  const watch = () => matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => { s = set(); onChange?.(s); watch(); }, { once: true });
  watch(); return () => s;
}

// ---------- 1x canvases ----------
export const cv = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; };
export const dot = (x, c, px, py, w = 1, h = 1) => { x.fillStyle = c; x.fillRect(px, py, w, h); };
export const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

// ---------- 9-slice panels (24 x 24 art, slice 8) ----------
// style: 'carved' (rune-notched wood + stone inlay, the Well), 'woven' (over-under border, the Tapestry's dense panels).
export function panelArt(style, ground, accent = false) {
  const dark = ground === 'dark', [c, x] = cv(24, 24);
  const fill = dark ? P.night : P.vellum, edge = dark ? P.void : P.ink;
  const t = {
    carved: dark ? [P['bark-deep'], P.wood, P.oak, P.gold] : [P.wood, P.oak, P.linen, P.gold],
    woven: dark ? [P.deep, P.teal, P.aqua, P.thread] : [P.ink, P.teal, P.linen, P.gold],
  }[style];
  const [d0, d1, d2, hi] = accent ? (dark ? [P.blood, P.rune, P.ember, P.spark] : [P.rune, P.ember, P.parchment, P.spark]) : t;
  dot(x, fill, 0, 0, 24, 24);
  for (let i = 0; i < 24; i++) for (let j = 0; j < 24; j++) {
    const b = Math.min(i, j, 23 - i, 23 - j); // distance to the outer edge
    if (b > 4) continue;
    const along = (b === i || b === 23 - i) ? j : i;
    let col;
    if (b === 0) col = edge;
    else if (style === 'woven') { const over = ((along >> 1) + b) % 2 === 0; col = b === 1 || b === 4 ? d0 : over ? d2 : d1; }
    else { col = b === 1 ? d1 : b === 2 ? d2 : b === 3 ? d1 : d0; if (b === 2 && along % 6 === 3) col = hi; } // bevel + gilt notches
    dot(x, col, i, j);
  }
  for (const [ci, cj] of [[2, 2], [21, 2], [2, 21], [21, 21]]) dot(x, hi, ci - 1, cj - 1, 2, 2); // corner studs
  return c.toDataURL();
}

// ---------- glyphs (9 x 9, one char = one art pixel; o = outline, a..c = the glyph's ramp, '.' = clear) ----------
export const GLYPHS = {
  running: ['....o....', '...oao...', '..oabao..', '.oabbbao.', 'oaabcbaao', '.oabbbao.', '..oabao..', '...oao...', '....o....'], // spindle whorl, lit
  handoff: ['.........', '..ooo....', '.oaaao...', 'oab.bao..', 'oa...aooo', 'oab.bacco', '.oaaao.oo', '..ooo....', '.........'], // knot passing on
  stopped: ['.........', 'oo.....oo', 'oao...oao', '.oao.oao.', '..ooooo..', '.oao.oao.', 'oao...oao', 'oo.....oo', '.........'], // cut thread (shears)
  bad: ['..ooooo..', '.oaaaaao.', 'oab.a.bao', 'oa.bab.ao', 'oaab.baao', 'oa.bab.ao', 'oab.a.bao', '.oaaaaao.', '..ooooo..'], // snarl
  done: ['.........', '.oo...oo.', 'oaao.oaao', 'oabaoabao', '.oaabaao.', '..oacao..', '.oao.oao.', 'oao...oao', 'oo.....oo'], // tied bow
  parked: ['.........', '..ooooo..', '.oaaaaao.', '.oaoaoao.', '.oaoaoao.', '.oaoaoao.', '.oaaaaao.', '..ooooo..', '.........'], // bead held on two pins
  'no-result': ['..ooooo..', '.oaaaaao.', '.oa...ao.', '.....oao.', '....oao..', '...oao...', '...ooo...', '...oao...', '...ooo...'], // loose end ?
  idle: ['.........', '...ooo...', '..oaaao..', '.oab.bao.', '.oa...ao.', '.oab.bao.', '..oaaao..', '...ooo...', '.........'], // hollow bead
  needs: ['...ooo...', '..oaaao..', '..oaaao..', '..oaaao..', '..oaaao..', '...oao...', '...ooo...', '...oao...', '...ooo...'], // "!" rune
  urd: ['oo.....oo', 'oao...oao', 'oao...oao', 'oao...oao', 'oaao.oaao', 'oabaoabao', 'oabbabbao', '.oaabaao.', '..ooooo..'], // U - what was
  verdandi: ['o.......o', 'ao.....oa', 'bao.o.oab', '.baoaoab.', '.oabobao.', '..oabao..', '..oaoao..', '...o.o...', '.........'], // W - what is
  skuld: ['...oooo..', '..oaaao..', '.oao.....', '.oaoo....', '..oaaao..', '....ooao.', '.....oao.', '..oaaao..', '..oooo...'], // S - what shall be
};
export const RAMP = {
  running: ['thread', 'spark', 'gold'], handoff: ['aqua', 'wellglow', 'teal'], stopped: ['weird', 'frost', 'weird'], bad: ['rune', 'ember', 'blood'],
  done: ['leaf', 'moss', 'spark'], parked: ['frost', 'mist', 'snow'], 'no-result': ['frost', 'mist', 'snow'], idle: ['mist', 'dusk', 'frost'],
  needs: ['ember', 'spark', 'rune'], urd: ['aqua', 'wellglow', 'teal'], verdandi: ['thread', 'spark', 'gold'], skuld: ['frost', 'snow', 'mist'],
};
// the glyph's pixels as [x, y, '#rrggbb'] (pure: the tests check every colour is a palette entry)
export function glyphPixels(name, ground) {
  const rows = GLYPHS[name] || GLYPHS.idle, r = RAMP[name] || RAMP.idle;
  const map = { o: ground === 'dark' ? P.void : P['bark-deep'], a: P[r[0]], b: P[r[1]], c: P[r[2]] };
  const out = [];
  rows.forEach((row, j) => [...row].forEach((ch, i) => { if (map[ch]) out.push([i, j, map[ch]]); }));
  return out;
}
// draw a glyph into a w x h canvas at the largest whole scale that fits, centred (placeholder tokens use this)
export function glyphCanvas(name, ground, w = 9, h = 9) {
  const [c, x] = cv(w, h), s = Math.max(1, Math.floor(Math.min(w, h) / 9)), ox = (w - 9 * s) >> 1, oy = (h - 9 * s) >> 1;
  for (const [i, j, col] of glyphPixels(name, ground)) dot(x, col, ox + i * s, oy + j * s, s, s);
  return c;
}

// ---------- dithered bar: frac of w art px filled, the last 6 px an ordered-dither ramp into the track; tick = budget mark ----------
export function ditherBar(frac, ground, { w = 64, h = 6, tone = 'ok', tick = null } = {}) {
  const dark = ground === 'dark', [c, x] = cv(w, h);
  const track = dark ? P.void : P.linen, rim = dark ? P.slate : P.ink;
  const fill = { ok: dark ? P.aqua : P.teal, warm: dark ? P.thread : P.gold, hot: P.ember, live: dark ? P.thread : P.gold, mute: dark ? P.mist : P.ink }[tone];
  const lite = { ok: P.wellglow, warm: P.spark, hot: P.spark, live: P.spark, mute: P.frost }[tone];
  dot(x, rim, 0, 0, w, h); dot(x, track, 1, 1, w - 2, h - 2);
  const inner = w - 2, f = Math.max(0, Math.min(1, frac || 0)) * inner, ramp = 6;
  for (let i = 0; i < inner; i++) for (let j = 0; j < h - 2; j++) {
    const solid = i < f - ramp, inRamp = !solid && i < f;
    if (solid || (inRamp && (f - i) / ramp * 16 > BAYER4[(i % 4) + 4 * (j % 4)])) dot(x, j === 0 ? lite : fill, i + 1, j + 1);
  }
  if (tick != null) { const ti = 1 + Math.round(Math.min(1, tick) * (inner - 1)); dot(x, dark ? P.snow : P['bark-deep'], ti, 0, 1, h); }
  return c.toDataURL();
}

// a woven rule (divider under headings)
export function weaveRule(ground, w = 96) {
  const [c, x] = cv(w, 3), dark = ground === 'dark';
  for (let i = 0; i < w; i++) { dot(x, (i >> 1) % 2 ? (dark ? P.teal : P.ink) : (dark ? P.thread : P.gold), i, 1); if (i % 8 === 0) dot(x, dark ? P.aqua : P.teal, i, 0, 1, 3); }
  return c.toDataURL();
}
