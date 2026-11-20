// RM-37 the pause MODES, read side: what a PAUSED file says and what each mode holds. One PAUSED file per level (<state root>/PAUSED,
// <state>/PAUSED); its JSON record { mode, by, why, at } says which: checkins (no check-in; the fill, the sweep, merges and hand-off
// resumes go on), queue (nothing new starts: a dispatch and a hand-off resume wait QUEUED, never refused, and start in fill order on
// release), all (both). A PAUSED file that is not a pause record (an empty file made by hand) is `all`, the safe reading.
// A leaf below runs.mjs (its fill and startRun read the pause here); setting a pause and the pause / resume actions are pause.mjs (K10).
import fs from 'node:fs';
import path from 'node:path';
import { isMergeStage } from './usageguard.mjs';

const fwd = p => String(p).replace(/\\/g, '/');
// label = the one name of a mode (the menu, the status line, the hold row); says = its one-line effect (the menu)
export const PAUSE_MODES = {
  checkins: { label: 'Pause check-ins', says: 'Check-ins do not run. The queue fill, the status sweep, merges and hand-off resumes go on.' },
  queue: { label: 'Hold the queue', says: 'Nothing new starts: new work and hand-off resumes wait queued and start in order on release. Running work and check-ins go on.' },
  all: { label: 'Pause everything', says: 'No check-in, no status sweep, nothing new starts (hand-off resumes wait queued). Running work goes on.' },
};
export const MODE_NAMES = Object.keys(PAUSE_MODES);
/** the PAUSED files of a state dir: the machine level (beside every project's state dir) first, then the project's own */
export const pauseFiles = state => [path.join(path.dirname(path.resolve(state)), 'PAUSED'), path.join(state, 'PAUSED')];
/** the pause of the first PAUSED file that exists -> { mode, by, why, at, file, label } | null (not a pause record = all) */
export function readPause(files = []) {
  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    return parsePause(raw, f);
  }
  return null;
}
/** one PAUSED file's text -> its pause (pure: the dashboard reads the file through its snapshot) */
export function parsePause(raw, f) {
  let r = null; try { r = JSON.parse(raw); } catch { /* a hand-made file */ }
  const mode = MODE_NAMES.includes(r?.mode) ? r.mode : 'all';
  return { mode, label: PAUSE_MODES[mode].label, by: r?.by ?? null, why: r?.why ?? null, at: r?.at ?? null, file: fwd(f) };
}
export const holdsStarts = p => p?.mode === 'queue' || p?.mode === 'all';   // nothing new starts
export const stopsCheckins = p => p?.mode === 'checkins' || p?.mode === 'all';
export const stopsTick = p => p?.mode === 'all';   // the tick exits before the sweep and the status
/** the fill walk's term of a pause that holds starts (holds.mjs reads it back): `PAUSED <mode> (<file>)` */
export const pauseTerm = p => `PAUSED ${p.mode} (${p.file})`;
// a hand-off resume held by a pause starts before new work on release, merges first (the run's own priority if it is higher)
export const heldPriority = o => (isMergeStage(o.stage) || o.priority === 'P0' ? 'P0' : 'P1');
