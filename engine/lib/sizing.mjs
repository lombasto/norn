// WORK-SIZING S1 (RM-25): does a lane stage's context mark fit its work. sizeOfRun measures one claude session from its transcript
// trace (standing.mjs transcriptTrace: tailed + cached, so a dashboard poll never reads a transcript twice): the context of its first
// request (floor), of its first real edit, its peak and end, its requests and its `git commit` calls. stageSizes lists the sessions of
// a lane stage with that size (the end record's ctx, else measured live), the marks recorded on the run at launch (ctx_marks) and the
// orders sent; verdict judges them (WORK-SIZING.md 4.1). Readers: the supervisor's end write (end.ctx), `norn size`; the pages from S2.
import fs from 'node:fs';
import path from 'node:path';
import { loadState } from './records.mjs';
import { transcriptTrace, runTranscript } from './standing.mjs';
import { POLICY_DEFAULTS, withDefaults, merged } from './policy.mjs';

const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
const COMMIT = /\bgit\s+(?:-[cC]\s+\S+\s+)*commit\b/;
const norm = p => { const r = path.resolve(String(p)).replace(/\\/g, '/'); return process.platform === 'win32' ? r.toLowerCase() : r; };
const inside = (dir, p) => { const d = norm(dir).replace(/\/$/, '') + '/'; return norm(p).startsWith(d); };
const isCommit = (name, arg) => (name === 'Bash' || name === 'PowerShell') && COMMIT.test(String(arg ?? ''));
/** an edit that is the work itself: not the run's own notes folder, not a hand-off file (writing those is the end of a session, not work) */
const isWorkEdit = (name, arg, notesDir) => EDIT_TOOLS.includes(name) && !!arg && !(notesDir && inside(notesDir, arg)) && !/hand-?off/i.test(path.basename(String(arg)));

/** one transcript -> { floor, first_edit, peak, end, requests, commits } (tokens; first_edit null = no edit) | null (no request yet) */
export function sizeOfRun(transcriptFile, { notesDir = null, cache = new Map() } = {}) {
  const t = transcriptFile ? transcriptTrace(transcriptFile, cache) : null;
  if (!t?.reqs?.length) return null;
  const ix = t.uses.find(([, n, a]) => isWorkEdit(n, a, notesDir) || isCommit(n, a))?.[0];
  return { floor: t.reqs[0], first_edit: ix === undefined ? null : t.reqs[Math.max(0, ix)], peak: Math.max(...t.reqs), end: t.reqs[t.reqs.length - 1],
    requests: t.reqs.length, commits: t.uses.filter(([, n, a]) => isCommit(n, a)).length };
}
const notesDirOf = d => (d.notes ? path.dirname(String(d.notes)) : null);
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/**
 * The sessions of lane `lane` stage `stage` of `state` in start order (stage absent = the stage of the lane's last run) -> { lane, stage,
 * sessions: [{ run, created, live, outcome, size, marks, orders }] }. size = the end record's ctx, else measured now from the transcript;
 * marks = the run's start record ctx_marks (null for a run started before WORK-SIZING S1: never today's policy). o: { projectsDir, cache }
 */
export function stageSizes(state, { lane, stage } = {}, o = {}) {
  const started = r => r.history?.some(h => h.ev === 'start');   // a queue record that was filled is no session (its fill is)
  const runs = Object.values(loadState(state).items).filter(r => r.kind === 'run' && r.data?.lane === lane && started(r)).sort((a, b) => String(a.created).localeCompare(String(b.created)));
  const st = stage ?? runs.at(-1)?.data.stage ?? null, cache = o.cache || new Map();
  const sessions = runs.filter(r => (r.data.stage ?? null) === st).map(r => {
    const d = r.data, end = r.end || null, live = r.state === 'running';
    let size = end?.ctx ?? null;
    if (!size) { const f = runTranscript(r, o); size = f ? sizeOfRun(f, { notesDir: notesDirOf(d), cache }) : null; }
    return { run: r.id, created: r.created, live, outcome: end?.outcome ?? (live ? 'running' : null), size, marks: d.ctx_marks ?? null,
      orders: readJson(path.join(state, 'ctx', `${r.id}.json`))?.sent ?? [] };
  });
  return { lane, stage: st, sessions };
}

/** the sizing thresholds of a project policy (defaults filled in) */
export const sizingThresholds = policy => ({ ...POLICY_DEFAULTS.sizing, ...withDefaults(merged({}, policy || {})).policy.sizing });
const kTok = n => `${Math.round(n / 1000)}k`;
const pc = x => `${Math.round(x * 100)} %`;
const median = xs => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };

/**
 * The verdict on the ended sessions of one lane stage (WORK-SIZING.md 4.1; `too-big` is S5's) -> { code, words, numbers }.
 * The start-up share is measured against no_new_step_k (the order that ended the sessions, 2.2), fits / loose against handoff_k; each
 * session against the marks it RAN under. A hand-off that is not thrashing reads `tight` (the table leaves two early-editing hand-offs
 * and a late single one open: both are work that outgrew one session, not a start-up that ate it).
 */
export function verdict(sessions, thresholds = POLICY_DEFAULTS.sizing) {
  const th = { ...POLICY_DEFAULTS.sizing, ...thresholds }, ended = sessions.filter(s => !s.live && s.outcome && s.size);
  if (!ended.length) return { code: 'none', words: 'not measured yet', numbers: { sessions: 0 } };
  const judged = ended.filter(s => s.marks), unmarked = ended.length - judged.length;
  if (!judged.length) return { code: 'none', words: 'marks not recorded', numbers: { sessions: ended.length, unmarked } };
  const hand = judged.filter(s => s.outcome === 'handoff'), base = { sessions: judged.length, unmarked, handoffs: hand.length };
  if (hand.length) {
    const nns = s => s.marks.no_new_step_k * 1000, fe = s => s.size.first_edit ?? s.size.peak;   // no edit at all: its whole context went before one
    const share = median(hand.map(s => fe(s) / nns(s))), floor = median(hand.map(s => s.size.floor)), first = median(hand.map(fe)), mark = median(hand.map(nns));
    const bare = hand.filter(s => !s.size.commits).length;
    if (hand.length >= 2 && (share * 100 >= th.thrash_startup_pct || bare)) {
      return { code: 'thrashing', numbers: { ...base, share, floor, first_edit: first, mark, no_commit: bare },
        words: `thrashing: ${hand.length} hand-offs, ${pc(share)} of the no-new-step mark used before the first edit (floor ${kTok(floor)}, first edit ${kTok(first)}, mark ${kTok(mark)})`
          + `${bare ? `, ${bare} without a commit` : ''} - raise the mark or trim the start-up` };
    }
    const last = hand.at(-1), commits = hand.reduce((n, s) => n + s.size.commits, 0);
    return { code: 'tight', numbers: { ...base, share, peak: last.size.peak, commits },
      words: `tight: ${hand.length === 1 ? 'one hand-off' : `${hand.length} hand-offs`} at ${kTok(last.size.peak)} after ${commits} commit${commits === 1 ? '' : 's'}` };
  }
  const shares = judged.map(s => s.size.peak / (s.marks.handoff_k * 1000)), top = judged[shares.indexOf(Math.max(...shares))], max = Math.max(...shares);
  if (max * 100 < th.loose_pct) return { code: 'loose', numbers: { ...base, share: max }, words: `never above ${pc(max)}: the mark could be lower` };
  return { code: 'fits', numbers: { ...base, share: max, peak: top.size.peak, handoff_k: top.marks.handoff_k }, words: `limit fits: peak ${kTok(top.size.peak)} of ${top.marks.handoff_k}k` };
}
