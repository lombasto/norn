// The ONE Norn asset map (META-VISUAL-B S1). The owner's art pick (NORN-ART round 2, RUN-1681: logo, favicons, wordmark,
// 7 state tokens, 4 empty states; the hero left with RM-18 S2) drops into engine/dash/norn/art/ under these file names and sizes with
// NO code change: the server lists which files exist (GET /norn/assets.json), the page uses a present file and falls back
// to a palette-drawn placeholder otherwise. Sizes are art px; `k` = device px per art px when shown (1 = native, 'ui' =
// the UI art scale --px). Every final PNG is palette-indexed (palette.hex) with binary alpha (art brief).
import { glyphPixels } from './pixel.mjs';
export const TOKENS = ['running', 'done', 'handoff', 'stopped', 'parked', 'needs', 'idle'];
export const EMPTIES = ['no-runs', 'nothing-needs-you', 'no-questions', 'all-delivered'];
// SloppaChoppa's 96 strips -> frame count (orc.mjs STRIPS holds the per-frame times)
export const ORC_STRIPS = { appear: 6, idle: 6, speak: 6, 'fidget-axe': 6, 'fidget-look': 7, chop: 8, warn: 6, exit: 6 };

export const ASSETS = {
  'logo-128': { file: 'logo-128.png', w: 128, h: 128, k: 1, use: 'README / about' },
  'logo-64': { file: 'logo-64.png', w: 64, h: 64, k: 1, use: 'empty overview' },
  'favicon-32': { file: 'favicon-32.png', w: 32, h: 32, k: 1, use: 'header mark + tab icon' },
  'favicon-16': { file: 'favicon-16.png', w: 16, h: 16, k: 1, use: 'tab icon' },
  wordmark: { file: 'wordmark.png', w: 160, h: 40, k: 1, use: 'header' },
  ...Object.fromEntries(TOKENS.flatMap(t => [
    [`token-${t}-24`, { file: `token-${t}-24.png`, w: 24, h: 24, k: 1, use: `state token ${t} (cards)` }],
    [`token-${t}-16`, { file: `token-${t}-16.png`, w: 16, h: 16, k: 1, use: `state token ${t} (chips)` }]])),
  ...Object.fromEntries(EMPTIES.map(e => [`empty-${e}`, { file: `empty-${e}.png`, w: 96, h: 64, k: 1, use: `empty state ${e}` }])),
  // META-TEND P6: SloppaChoppa (ORC-1 round 5 + 6; the 96 strips = round 8, owner pick 11-17): the header bust, the phone's axe, the 96 strips of the stage
  'orc-32': { file: 'orc-32.png', w: 32, h: 32, k: 1, use: 'header: call SloppaChoppa up' },
  'orc-16': { file: 'orc-16.png', w: 16, h: 16, k: 'ui', use: 'phone header: call SloppaChoppa up (UI scale: fills the 44 px touch target)' },
  'icon-close-16': { file: 'icon-close-16.png', w: 16, h: 16, k: 'ui', use: 'the close button of every drawer (closeBtn)' },
  ...Object.fromEntries(Object.entries(ORC_STRIPS).map(([s, n]) => [`orc-96-${s}`, { file: `orc-96-${s}.png`, w: 96 * n, h: 96, k: 2, use: `SloppaChoppa ${s} strip, ${n} frames` }])),
};
export const ART_FILES = Object.values(ASSETS).map(a => a.file);

// chip / state class (ui.mjs chip()) -> state token; classes with no state (executor chips) get none
export const CHIP_TOKEN = {
  running: 'running', done: 'done', applied: 'done', 'in-force': 'done', active: 'idle', ok: 'done',
  handoff: 'handoff', answered: 'handoff', warn: 'handoff', parked: 'parked',
  stopped: 'stopped', lost: 'stopped', 'no-result': 'stopped', bad: 'stopped', overruled: 'stopped',
  open: 'needs', needs: 'needs', superseded: 'idle', archived: 'idle', revoked: 'idle', withdrawn: 'idle', idle: 'idle',
};
// placeholder drawing for each asset (browser): which glyph, on what
export const PLACEHOLDER = name => {
  if (name.startsWith('icon-')) return { glyph: name.slice(5).replace(/-\d+$/, '') };
  if (name.startsWith('token-')) return { glyph: name.slice(6).replace(/-\d+$/, '') };
  if (name.startsWith('empty-')) return { glyph: { 'no-runs': 'idle', 'nothing-needs-you': 'done', 'no-questions': 'handoff', 'all-delivered': 'done' }[name.slice(6)] ?? 'idle', frame: true };
  if (name === 'wordmark') return { glyph: 'running', word: 'NORN' };
  return { glyph: 'running', frame: name.startsWith('logo') };
};

// The drawers' close button (owner 2026-11-23): one universal X, themed by frame and palette only. The Norn look shows the asset
// icon-close-16 (its first src is the close glyph as a palette-only SVG, so a page painted after look.mjs ran still shows it; a look
// or theme paint swaps in the art PNG once it lands, else the canvas placeholder); the classic look shows the inline SVG X in the
// --bad colour. norn.css (loaded in both looks) shows one per look. attrs = the button's own attributes (data-act ...).
const CLOSE_SRC = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 9 9" shape-rendering="crispEdges">${glyphPixels('close', 'dark').map(([x, y, c]) => `<rect x="${x}" y="${y}" width="1" height="1" fill="${c}"/>`).join('')}</svg>`);
export const closeBtn = (attrs = '') => `<button class="xclose" aria-label="Close (Esc)" title="Close (Esc)"${attrs ? ' ' + attrs : ''}><img class="art xc-art" alt="" data-asset="icon-close-16" src="${CLOSE_SRC}" style="width:calc(16 * var(--px));height:calc(16 * var(--px))"><svg class="xc-svg" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke-width="2" stroke-linecap="round" style="stroke:var(--bad)"/></svg></button>`;
