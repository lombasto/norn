// Helpers shared by the Map looks (ported from VISUAL-A2 norn/weave.mjs): state colours, materials, the label set, cloth.
// The lane / knot ordering itself is pure and lives in live.mjs (weave), re-exported here for the looks.
import { THREE } from './stage.mjs';
import { P } from './pixel.mjs';
import { knotCands } from './live.mjs';
import { hoChip } from '../widgets.mjs';   // the live hand-off chip (lanes.mjs handoffOf) on stake and knot labels
export { weave } from './live.mjs';

export const ST = { running: 'thread', handoff: 'aqua', waiting: 'aqua', parked: 'aqua', stopped: 'weird', bad: 'rune', done: 'leaf', shipped: 'leaf', 'no-result': 'frost', idle: 'mist' };
export const stCol = cls => P[ST[cls] || 'mist'];
const LOUD = new Set(['handoff', 'stopped', 'bad']);   // finished but worth a label (A2 RANK 1)

export function knotMat(cls, faded, { flat = false } = {}) {
  const c = new THREE.Color(stCol(cls));
  const M = flat ? THREE.MeshLambertMaterial : THREE.MeshStandardMaterial;
  return new M({ color: c, emissive: c, emissiveIntensity: cls === 'running' ? 0.55 : faded ? 0.04 : 0.14, flatShading: true, ...(flat ? {} : { roughness: 0.55, metalness: 0.1 }) });
}
export function threadMat(lane, theme) {
  const c = new THREE.Color(lane.live ? P.thread : stCol(lane.cls));
  if (!lane.live) c.lerp(new THREE.Color(theme === 'dark' ? P.mist : P.ink), 0.4);
  return new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: lane.live ? 0.5 : 0.02, roughness: 0.8, flatShading: true });
}
export const tube = (pts, r, mat, seg = 24) => new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), seg, r, 5, false), mat);
export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// the label set: a stake label per lane (name + state word + questions), the live / loud knots, the controller's knots.
// stakeCands(l) -> the stake label's candidate offsets (the look knows which way is "outward").
export function labelSet(W, pos, stakePos, { stakeCands = () => [[6, 0, 'left']], knotDx = 10 } = {}) {
  const out = [];
  for (const l of W.lanes) {
    const word = l.node.word ?? l.cls,   // RM-21 S1: the lane's state (laneState), from the map payload
      q = l.questions ? ` · <b class="nd">${l.questions} needs you</b>` : '';
    out.push({ id: l.node.id, pos: stakePos(l), html: `${esc(l.name)}<small>${esc(word)}${q}</small>${hoChip(l.node.handoff, null, { short: true })}`, cls: `lane st-${l.cls}${l.live ? ' live' : ''}`,
      prio: l.live ? 2 : l.questions ? 3 : 6, cands: stakeCands(l) });
    for (const k of l.knots) if (k.cls === 'running' || k.handoff || (!k.faded && LOUD.has(k.cls)))
      out.push({ id: k.id, pos: pos(k.id), html: `${esc(k.label)}<small>${esc(k.id)}</small>${hoChip(k.handoff, k.id, { short: true })}`, cls: k.cls === 'running' ? 'live' : '', prio: k.cls === 'running' ? 1 : 4, cands: knotCands(knotDx) });
  }
  for (const k of W.checkins) out.push({ id: k.id, pos: pos(k.id), html: `${esc(k.label)}<small>${esc(k.id)} · check-in</small>`, prio: k.faded ? 5 : 3, cands: knotCands(knotDx) });
  return out;
}
export function mkKnot(n, r, flat) {
  const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), knotMat(n.cls, n.faded, { flat }));
  m.userData.id = n.id; m.castShadow = true; return m;
}

// woven cloth texture (over-under twill, 8 x 8 art px repeated, nearest) - the tapestry ground
export function clothTexture(warp, weft, shade, repeat = [8, 8]) {
  const c = document.createElement('canvas'); c.width = c.height = 8; const x = c.getContext('2d');
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) { const over = ((i + j) >> 1) % 2 === 0; x.fillStyle = over ? warp : (j % 4 === 3 ? shade : weft); x.fillRect(i, j, 1, 1); }
  const t = new THREE.CanvasTexture(c); t.magFilter = t.minFilter = THREE.NearestFilter; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); t.generateMipmaps = false; return t;
}
// a straight-segment path through points (sparks that follow warp / weft threads)
export function polyPath(pts) { const p = new THREE.CurvePath(); for (let i = 1; i < pts.length; i++) p.add(new THREE.LineCurve3(pts[i - 1], pts[i])); return p; }
