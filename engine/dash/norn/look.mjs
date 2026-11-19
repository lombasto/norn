// Look manager (browser; META-VISUAL-B S1): Norn (default) or the classic look, the ground (dark / light, from the theme
// switch or the system), the integer art scale, the 9-slice panel / rule art and the asset map's images (a present file
// under /norn/art/ or a palette-drawn placeholder) as CSS variables. Everything is drawn once per change of look, ground or
// scale - never per frame. The "motion" class (motion.mjs) is set from QUIET, reduced motion and visibility.
import { P, applyScale, panelArt, weaveRule, glyphCanvas, cv, dot } from './pixel.mjs';
import { ASSETS, TOKENS, PLACEHOLDER } from './assets.mjs';
import { motionAllowed } from './motion.mjs';

export const LOOKS = ['norn', 'classic'];
const root = document.documentElement;
const L = { look: 'norn', theme: 'system', present: new Set(), quiet: false, onChange: null };
const reducedQ = matchMedia('(prefers-reduced-motion: reduce)'), darkQ = matchMedia('(prefers-color-scheme: dark)');
export const ground = () => L.theme === 'light' || (L.theme === 'system' && !darkQ.matches) ? 'light' : 'dark';

// a placeholder for one asset at its exact art size (palette only)
function placeholder(name, g) {
  const a = ASSETS[name], ph = PLACEHOLDER(name), [c, x] = cv(a.w, a.h), dark = g === 'dark';
  if (ph.frame) {
    dot(x, dark ? P.night : P.vellum, 0, 0, a.w, a.h);
    for (let i = 0; i < a.w; i++) { dot(x, (i >> 1) % 2 ? P.teal : (dark ? P.thread : P.gold), i, 0); dot(x, (i >> 1) % 2 ? P.teal : (dark ? P.thread : P.gold), i, a.h - 1); }
    for (let j = 0; j < a.h; j++) { dot(x, P.teal, 0, j); dot(x, P.teal, a.w - 1, j); }
  }
  const box = Math.min(a.w, a.h, ph.word ? a.h : Math.max(9, Math.floor(Math.min(a.w, a.h) * 0.6)));
  const g9 = glyphCanvas(ph.glyph, g, box, box);
  x.drawImage(g9, ph.word ? 0 : (a.w - box) >> 1, (a.h - box) >> 1);
  if (ph.word) { x.fillStyle = dark ? P.thread : P.gold; x.fillRect(box + 4, (a.h >> 1) - 1, a.w - box - 8, 2); }
  return c.toDataURL();
}
export const assetUrl = (name, g = ground()) => L.present.has(name) ? `/norn/art/${ASSETS[name].file}` : placeholder(name, g);
// <img> for an asset at whole device px: k 1 = native size, 'ui' = the UI art scale
export function assetImg(name, cls = '') {
  const a = ASSETS[name], u = a.k === 'ui' ? 'var(--px)' : 'var(--d1)';
  return `<img class="art ${cls}" alt="" data-asset="${name}" src="${assetUrl(name)}" style="width:calc(${a.w} * ${u});height:calc(${a.h} * ${u})">`;
}

function paint() {
  const norn = L.look === 'norn';
  root.classList.toggle('norn', norn);
  root.classList.toggle('classic', !norn);
  if (!norn) return;
  const g = ground();
  root.dataset.ground = g;
  const s = root.style;
  s.setProperty('--pn', `url(${panelArt('carved', g)})`);
  s.setProperty('--pn-acc', `url(${panelArt('carved', g, true)})`);
  s.setProperty('--pn-woven', `url(${panelArt('woven', g)})`);
  s.setProperty('--rule', `url(${weaveRule(g)})`);
  for (const t of TOKENS) s.setProperty(`--tk-${t}`, `url(${assetUrl(`token-${t}-16`, g)})`);
  for (const b of document.querySelectorAll('.brand')) b.style.backgroundImage = `url(${assetUrl('favicon-32', g)})`;
  for (const i of document.querySelectorAll('img[data-asset]')) i.src = assetUrl(i.dataset.asset, g);
  let icon = document.querySelector('link[rel=icon]');
  if (!icon) { icon = document.createElement('link'); icon.rel = 'icon'; document.head.append(icon); }
  icon.href = assetUrl('favicon-32', g);
}
export function setMotion() { root.classList.toggle('motion', motionAllowed({ quiet: L.quiet, reduced: reducedQ.matches, hidden: document.hidden })); }
export const motion = () => root.classList.contains('motion');

export function setLook(look) { L.look = LOOKS.includes(look) ? look : 'norn'; try { localStorage.setItem('meta-look', L.look); } catch { /* private mode */ } paint(); L.onChange?.(L.look); return L.look; }
export function setTheme(theme) { L.theme = theme; paint(); }
export function setQuiet(q) { if (L.quiet === !!q) return; L.quiet = !!q; setMotion(); }
export const look = () => L.look;

export async function initLook({ look: want, theme = 'system', onChange } = {}) {
  L.onChange = onChange ?? null; L.theme = theme;
  let saved = null; try { saved = localStorage.getItem('meta-look'); } catch { /* private mode */ }
  L.look = LOOKS.includes(want) ? want : LOOKS.includes(saved) ? saved : 'norn';
  applyScale(root, () => paint());
  darkQ.addEventListener('change', () => { if (L.theme === 'system') paint(); });
  reducedQ.addEventListener('change', setMotion);
  document.addEventListener('visibilitychange', setMotion);
  paint(); setMotion();
  try { const r = await fetch('/norn/assets.json'); if (r.ok) { L.present = new Set((await r.json()).present || []); if (L.present.size) paint(); } } catch { /* placeholders */ }
  return L.look;
}
