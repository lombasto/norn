// RM-39: how far a run is in its own brief, its pace, why it is slow and what its usage alarms mean - in plain words, from evidence.
// Owner: "i really can't see how far along in its own task it is, or why it is taking so long / runaway".
// Pure (no fs, no DOM): the caller hands in the brief and notes text, the lane's mails, the run records, the guard chips, a CPU sample
// and the transcript fold (workInit / onWork: the dash tails it with agents.mjs tailA, so only appended lines are parsed again).
//   checklist  the brief's first numbered list (its items 1..N) + the mails sent to the lane after the run's first session started;
//              done = a commit whose subject names it (its words, "item N" or the mail id), a NOTES line that says it is done, or a
//              passing test file named like it; doing = the files edited in the last STALE_MIN minutes are named like it
//   pace       elapsed (every session of the lane's stage) vs the brief's time budget and vs the median of similar ended runs (the
//              lane's own first, else the same agent's); stalled = no commit, edit or test change for stall_min minutes
//   why slow   the share of the last hour in test runs, the same test re-run k times, the machine's CPU, hand-offs, mails that added scope
//   alarms     guard.mjs's runaway / over-handoff / tool-spam flags as what they mean, their numbers and what the owner can do
// Lane feed-activity (RM-36, engine/dash/activity.mjs) folds the same transcript for the feed drawer's activity view; when both are on
// main the tool-call fold here can be its activityAdd (NOTES of lane run-progress).
import { classify, isTest } from './testcmd.mjs';

const STALE_MIN = 30, MAX_CALLS = 4000;
const fwd = s => String(s ?? '').replace(/\\/g, '/');
const base = s => fwd(s).split('/').pop();
const mins = ms => Math.max(0, Math.round(ms / 60000));
const median = xs => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const num = id => Number(String(id).match(/(\d+)$/)?.[1] ?? 0);
export const fmtMin = m => !Number.isFinite(m) ? '-' : m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')} min`;

// ---------- words: an item, a commit subject, a NOTES line and a file are compared by their word stems (3+ letters, a plural s off,
// the first 5 letters) ----------
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'each', 'every', 'its', 'their', 'them', 'they', 'what', 'when',
  'which', 'where', 'while', 'than', 'then', 'also', 'only', 'more', 'most', 'some', 'show', 'shows', 'shown', 'add', 'adds', 'added', 'make',
  'item', 'items', 'test', 'tests', 'mjs', 'feat', 'fix', 'docs', 'refactor', 'chore', 'style', 'engine', 'lib', 'dash', 'index', 'html',
  'one', 'two', 'per', 'not', 'all', 'own', 'new', 'old', 'now', 'has', 'have', 'are', 'was', 'can', 'get', 'gets', 'use', 'uses', 'its',
  'you', 'your', 'out', 'off', 'any', 'how', 'why', 'who', 'but', 'via', 'see', 'set', 'yet', 'else', 'does', 'did', 'done', 'just', 'there']);
const stem = w => (w.length >= 4 && /[^s]s$/.test(w) ? w.slice(0, -1) : w).slice(0, 5);
const stems = s => [...new Set(String(s ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/)
  .filter(w => w.length >= 3 && !STOP.has(w)).map(stem))];
const hits = (a, b) => { const B = new Set(b); return a.filter(x => B.has(x)).length; };
/**
 * the items a piece of evidence (a commit subject, a NOTES line) names: "item N" / "items 2 and 3", a mail id, else by words - every
 * item whose text shares 3+ stems with it and is within one of the best match (one commit often finishes two items)
 */
function named(s, its) {
  const t = String(s ?? ''), byNo = its.filter(it => it.mail ? t.includes(it.mail) : new RegExp(`\\bitems?\\s+(?:\\d+\\s*(?:,|and|&)\\s*)*${it.n}\\b`, 'i').test(t));
  if (byNo.length) return byNo;
  const w = stems(t), h = its.map(it => hits(w, it.words)), best = Math.max(0, ...h);
  return best < 3 ? [] : its.filter((_, i) => h[i] >= best - 1 && h[i] >= 3);
}
/** the ONE item a file (an edited path, a test file) is named like: every word of its base name is in that item's title (none or two = none) */
const fileItem = (f, its) => { const w = stems(base(f).replace(/\.(test\.)?[a-z]+$/i, '')), m = w.length ? its.filter(it => hits(w, it.tw) === w.length) : []; return m.length === 1 ? m[0] : null; };

// ---------- the brief ----------
const plain = s => String(s ?? '').replace(/\*\*/g, '').replace(/`/g, '').trim();
/**
 * briefPlan(text) -> { items [{ n, title, text }], budget_min | null, done: the Done line | null }. The items are the brief's FIRST
 * numbered list (1., 2., ... in order; a later list that starts at 1 again is not read); the title is the bold lead ("**Pace**: ...")
 * or the words up to the first colon / dash.
 */
export function briefPlan(text) {
  const items = [], lines = String(text ?? '').split(/\r?\n/);
  for (const l of lines) {
    const m = l.match(/^ {0,2}(\d+)[.)]\s+(.+)$/);
    if (!m) continue;
    const n = Number(m[1]);
    if (n === 1 && items.length) break;
    if (n !== items.length + 1) continue;
    const t = m[2], bold = t.match(/^\*\*(.+?)\*\*/);
    const title = plain(bold ? bold[1] : t.split(/:\s|\s[-–]\s/)[0]).replace(/[:.]$/, '').slice(0, 80);
    items.push({ n, title, text: plain(t) });
  }
  const budget = String(text ?? '').match(/time budget[:\s]*(\d+)\s*min/i), done = lines.find(l => /^Done:\s*/i.test(l));
  return { items, budget_min: budget ? Number(budget[1]) : null, done: done ? done.replace(/^Done:\s*/i, '').trim() : null };
}

// ---------- the transcript fold: the tool calls with their time, the commits, the tests ----------
const COMMIT_RE = /\bgit\s+(?:-C\s+\S+\s+)?commit\b/;
const resultText = b => typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map(x => x?.text ?? '').join('\n') : '';
/** pass / fail counts of a test run's output (node --test spec and TAP summaries, summed; pytest's line; ci-suite's red line) | null */
export function testCounts(text) {
  const t = String(text ?? ''), sum = re => { let n = null; for (const m of t.matchAll(re)) n = (n ?? 0) + Number(m[1]); return n; };
  const ci = t.match(/ci-suite: (\d+) listed red\(s\), (\d+) new, (\d+) leak\(s\), (\d+) hang\(s\)/);
  if (ci) return { pass: null, fail: Number(ci[2]) + Number(ci[3]) + Number(ci[4]) };
  const py = t.match(/=+ (?:(\d+) failed, )?(\d+) passed/);
  if (py) return { pass: Number(py[2]), fail: Number(py[1] ?? 0) };
  const pass = sum(/^\s*ℹ pass (\d+)/gm) ?? sum(/^# pass (\d+)/gm), fail = sum(/^\s*ℹ fail (\d+)/gm) ?? sum(/^# fail (\d+)/gm);
  return pass === null && fail === null ? null : { pass: pass ?? 0, fail: fail ?? 0 };
}
export const workInit = () => ({ open: {}, calls: [], commits: [], seen: new Set(), first: null, last: null });
/** fold one transcript record (a parsed JSONL line) into the work state; a call counts once its result is there */
export function onWork(c, j) {
  const ts = j.timestamp ?? null, m = j.message;
  if (ts) { if (!c.first || ts < c.first) c.first = ts; if (!c.last || ts > c.last) c.last = ts; }
  if (!m || !Array.isArray(m.content)) return;
  if (j.type === 'assistant') {
    for (const b of m.content) if (b?.type === 'tool_use' && b.id) c.open[b.id] = { name: String(b.name ?? 'tool'), ts, cmd: b.input?.command ?? null, file: b.input?.file_path ?? b.input?.notebook_path ?? null };
    return;
  }
  if (j.type !== 'user') return;
  for (const b of m.content) {
    if (b?.type !== 'tool_result' || !c.open[b.tool_use_id]) continue;
    const u = c.open[b.tool_use_id], text = resultText(b), ok = !b.is_error;
    delete c.open[b.tool_use_id];
    const shell = u.name === 'Bash' || u.name === 'PowerShell', cmd = shell ? String(u.cmd ?? '') : '';
    const tc = shell ? classify(cmd) : null, kind = /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(u.name) ? 'edit' : tc && (tc.kind === 'test' || tc.kind === 'full') ? 'test' : shell && COMMIT_RE.test(cmd) ? 'commit' : 'other';
    const files = kind === 'test' ? tc.files : kind === 'edit' && u.file ? [fwd(u.file)] : [];
    const bg = /running in background with ID|moved to the background/i.test(text);
    const call = { kind, name: u.name, ts: u.ts, end: ts, ok, files };
    if (kind === 'test') { call.key = files.length ? files.slice().sort().join(' ') : cmd.replace(/^cd\s+\S+\s*&&\s*/, '').slice(0, 120); call.counts = bg ? null : testCounts(text); if (bg) call.bg = true; }
    c.calls.push(call);
    if (c.calls.length > MAX_CALLS) c.calls.splice(0, c.calls.length - MAX_CALLS);
    // a commit's sha + subject: git's "[branch sha] subject" line, else (a quiet `commit -q && git log --oneline -n`) the log's lines
    // from the top that the run had not printed before (newest first: they stop at the first older commit it had seen); every sha a
    // result prints is remembered, so a base commit listed earlier never counts as the run's
    const shas = [...text.matchAll(/^(?:\[[^\]\s]+(?: \([^)]*\))? ([0-9a-f]{7,40})\]|([0-9a-f]{7,40})) (\S.*)$/gm)].map(x => [(x[1] ?? x[2]).slice(0, 7), x[3].trim(), !!x[1]]);
    if (shell && ok && COMMIT_RE.test(cmd)) {   // a test-then-commit line is a test call that also commits
      const mine = sha => c.commits.some(x => x.sha === sha), made = shas.filter(x => x[2]);
      if (made.length) for (const [sha, subject] of made) { if (!mine(sha)) c.commits.push({ sha, subject, ts }); }
      else for (const [sha, subject] of shas) { if (mine(sha)) continue; if (c.seen.has(sha)) break; c.commits.push({ sha, subject, ts }); }
    }
    for (const [sha] of shas) c.seen.add(sha);
  }
}

// ---------- the checklist ----------
const DONE_LINE = /\b(done|finished|complete[d]?|landed|passes|green)\b|✓|✔|\[x\]/i, DONE_HEAD = /\b(built|done|shipped|landed|finished|complete[d]?)\b/i;
/** the NOTES lines that say something is done: a line with a done word, or any bullet under a "What was built" / "Done" heading */
export function doneLines(notes) {
  const out = []; let under = false;
  for (const l of String(notes ?? '').split(/\r?\n/)) {
    const h = l.match(/^#+\s*(.*)$/);
    if (h) { under = DONE_HEAD.test(h[1]) && !/^(DONE|HANDOFF|STOPPED)\b/.test(h[1].trim()); continue; }
    if ((under && /^\s*[-*]\s+\S/.test(l)) || (DONE_LINE.test(l) && l.trim())) out.push(l.trim());
  }
  return out;
}
/**
 * checklist({ plan, mails, work, notes, now }) -> [{ n, title, mail?, state: done | doing | todo, evidence }]. mails: the lane's mail
 * records sent after the stage's first session started (a mail added scope). notes: the run's NOTES text.
 */
export function checklist({ plan, mails = [], work = workInit(), notes = '', now = Date.now() } = {}) {
  const its = [...(plan?.items || []).map(x => ({ n: x.n, title: x.title, words: stems(x.text), tw: stems(x.title) })),
    ...mails.map((m, i) => ({ n: (plan?.items?.length || 0) + i + 1, mail: m.id, title: `${m.id}: ${m.data?.subject ?? ''}`, words: stems(m.data?.subject), tw: stems(m.data?.subject) }))];
  const ev = new Map(), put = (it, e) => { if (!ev.has(it.n)) ev.set(it.n, e); };
  for (const c of work.commits) for (const it of named(c.subject, its)) put(it, ['done', `commit ${c.sha.slice(0, 7)} "${c.subject.slice(0, 70)}"`]);
  for (const l of doneLines(notes)) for (const it of named(l, its)) put(it, ['done', `NOTES: "${l.replace(/^[-*]\s+/, '').slice(0, 70)}"`]);
  for (const x of work.calls) if (x.kind === 'test' && x.ok && x.counts && x.counts.fail === 0 && x.counts.pass > 0)
    for (const f of x.files) { const it = fileItem(f, its); if (it) put(it, ['done', `passing ${f}`]); }
  const edits = work.calls.filter(x => x.kind === 'edit' && x.ok && Date.parse(x.end) >= now - STALE_MIN * 60000).reverse();
  for (const x of edits) for (const it of x.files.map(f => fileItem(f, its)).filter(Boolean)) put(it, ['doing', `editing ${base(x.files[0])} ${fmtMin(mins(now - Date.parse(x.end)))} ago`]);
  return its.map(it => { const [state, evidence] = ev.get(it.n) ?? ['todo', null]; return out(it, state, evidence); });
}
const out = (it, state, evidence) => ({ n: it.n, title: it.title, ...(it.mail ? { mail: it.mail } : {}), state, evidence });

/** what the run is doing now: its newest call (the open one if it has one) -> 'testing' | 'editing' | 'committing' | null, + its files */
function nowDoing(work, now) {
  const open = Object.values(work.open).filter(x => x.ts).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
  if (open) {
    const sh = open.name === 'Bash' || open.name === 'PowerShell', cmd = String(open.cmd ?? '');
    if (sh && isTest(cmd)) return { verb: 'testing', files: classify(cmd).files };
    if (/^(Edit|Write|MultiEdit)$/.test(open.name)) return { verb: 'editing', files: open.file ? [open.file] : [] };
  }
  const last = work.calls.filter(x => x.kind === 'test' || x.kind === 'edit').at(-1);
  if (!last || Date.parse(last.end) < now - 10 * 60000) return null;
  return { verb: last.kind === 'test' ? 'testing' : 'editing', files: last.files };
}

// ---------- pace ----------
const endOf = r => (r.history || []).find(h => h.ev === 'end')?.ts ?? (r.state === 'running' || r.state === 'queued' ? null : r.updated);
const isLanding = d => /^(merge\d*|resolve)$/i.test(String(d?.stage ?? '')) || d?.kind === 'merge';
// the run index of one records fold, built once (NORN-UI-PERF: the per-run scans of every run were O(tree x done x runs), 75 % of a
// big project's /api/agents). Keyed on the runs object itself: a records change folds a NEW object, so an index never outlives its fold.
const IDX = new WeakMap();
function indexOf(runs) {
  let x = IDX.get(runs); if (x) return x;
  const all = Object.values(runs).filter(r => r.kind === 'run').map(r => [num(r.id), r]).sort((a, b) => a[0] - b[0]);
  const lanes = new Map(), stages = new Map(), at = (m, k, mk) => m.get(k) ?? (m.set(k, mk()), m.get(k));
  for (const [n, r] of all) if (r.data?.lane && r.data.role !== 'helper') { at(lanes, r.data.lane, () => []).push(r); at(at(stages, r.data.lane, () => new Map()), r.data.stage, () => []).push([n, r]); }
  const done = all.map(([, r]) => r).filter(r => r.state === 'exited' && r.end?.outcome === 'done' && !isLanding(r.data) && r.data?.role !== 'helper');
  IDX.set(runs, x = { lanes, stages, done, whole: new Map() });
  return x;
}
/** the sessions of this run's lane + stage up to it (a hand-off resumes the same stage in a new run), oldest first */
export const sessionsOf = (run, runs) => { if (!run.data?.lane) return []; const n = num(run.id);
  return (indexOf(runs).stages.get(run.data.lane)?.get(run.data.stage) ?? []).filter(([k]) => k <= n).map(([, r]) => r); };
/** the median minutes of finished work like it: the lane's own ended stages (2 at least), else the same agent's done runs */
function estimate(run, runs) {
  const ix = indexOf(runs), done = ix.done.filter(r => r.data?.kind === run.data?.kind && r.id !== run.id);
  // a stage's whole time = its sessions (the hand-offs before the done run); one sum per run and fold
  const whole = r => ix.whole.get(r.id) ?? ix.whole.set(r.id, sessionsOf(r, runs).reduce((s, x) => s + (Date.parse(endOf(x) ?? '') - Date.parse(x.created) || 0), 0) / 60000).get(r.id);
  const lane = done.filter(r => r.data?.lane === run.data?.lane), similar = done.filter(r => (r.data?.agent ?? null) === (run.data?.agent ?? null));
  const pick = lane.length >= 2 ? ['the lane\'s own stages', lane] : similar.length >= 2 ? [`similar runs (${run.data?.agent ?? 'no agent'})`, similar] : null;
  if (!pick) return null;
  const m = median(pick[1].map(whole).filter(x => x > 0));
  return m === null ? null : { min: Math.round(m), n: pick[1].length, from: pick[0] };
}

/** the last time the run moved: a commit, an edit, or a test whose counts differ from that test's previous run */
function lastMove(work) {
  let t = null; const prev = new Map(), at = x => { const v = x.end ?? x.ts; if (v && (!t || v > t)) t = v; };
  for (const c of work.commits) at(c);
  for (const x of work.calls) {
    if (x.kind === 'edit' && x.ok) at(x);
    if (x.kind === 'test' && x.counts) { const k = JSON.stringify(x.counts); if (prev.get(x.key) !== k) at(x); prev.set(x.key, k); }
  }
  return t;
}

// ---------- why slow ----------
export const pctOf = x => `${Math.round(x * 100)} %`;
/** share of [from, to] (ms) covered by the calls of a kind (overlaps counted once) */
function share(calls, from, to) {
  const iv = calls.map(x => [Math.max(from, Date.parse(x.ts)), Math.min(to, Date.parse(x.end))]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let tot = 0, cur = null;
  for (const [a, b] of iv) { if (!cur || a > cur[1]) { if (cur) tot += cur[1] - cur[0]; cur = [a, b]; } else cur[1] = Math.max(cur[1], b); }
  if (cur) tot += cur[1] - cur[0];
  return to > from ? tot / (to - from) : 0;
}

// ---------- alarms ----------
const M = x => !Number.isFinite(x) ? '-' : x >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : Math.round(x / 1e3) + 'k';
const ACT = { 'let-run': 'nothing needed - let it run', mail: 'mail it (norn mail send --to run:<id>)', stop: 'stop it (the Stop button)' };
/**
 * alarmWords(chip, { test_share, ctx, moving }) -> { cls, words, numbers, act: [the owner's moves, the suggested one first], ruled }.
 * chip: guardChips' { id, cls, why, state, action, ratio?, cache_read?, turns? }; the numbers come from the alarm's own why.
 */
export function alarmWords(g, { test_share = null, ctx = null, moving = false } = {}) {
  const why = String(g.why ?? ''), ratio = g.ratio ?? Number(why.match(/= ([\d.]+)x the median/)?.[1] ?? NaN);
  const ruled = g.action ? `ruled: ${ACT[g.action] ?? g.action}` : null;
  if (g.cls === 'runaway') {
    const med = why.match(/the median ([\d.]+[kM]) of (\d+) peers/), cr = why.match(/^([\d.]+[kM]) cache reads/);
    const cause = test_share !== null && test_share >= 0.4 ? ' - most of it re-reading a long context while waiting on tests'
      : ctx && ctx >= 100000 ? ` - most of it re-reading a ${M(ctx)} context on every call` : '';
    return { cls: g.cls, ruled, words: `uses ${Number.isFinite(ratio) ? ratio.toFixed(1) + 'x' : 'far more than'} the tokens of similar runs${cause}`,
      numbers: `${cr ? cr[1] : M(g.cache_read)} cache reads vs a median ${med ? `${med[1]} of ${med[2]} ended runs` : 'of its peers'} of the same kind, agent and effort (usage guard: runaway)`,
      act: moving ? [ACT['let-run'], ACT.mail, ACT.stop] : [ACT.mail, ACT.stop, ACT['let-run']] };
  }
  if (g.cls === 'over-handoff') {
    const m = why.match(/context ([\d.]+[kM]) above the hand-off line \((\d+)k\) for the last (\d+) calls/);
    return { cls: g.cls, ruled, words: `its context is past the size where it should hand off${m ? ` (${m[1]} vs ${m[2]}k, ${m[3]} calls)` : ''} and it has not handed off yet`,
      numbers: why, act: [ACT.mail, ACT['let-run'], ACT.stop] };
  }
  if (g.cls === 'tool-spam') return { cls: g.cls, ruled, words: `tool output fills most of what it re-reads every call${why.match(/^(\d+ %)/) ? ` (${why.match(/^(\d+ %)/)[1]})` : ''}`, numbers: why, act: [ACT.mail, ACT['let-run'], ACT.stop] };
  return { cls: g.cls, ruled, words: why, numbers: '', act: [ACT['let-run'], ACT.stop] };
}

/**
 * runProgress(run, { runs, brief, notes, mails, work, guard, cpu, ctx, now, stall_min }) -> { line, items, done, total, now, pace, slow, alarms }.
 * runs = loadState().items; brief / notes = their text | null; mails = the lane's mail records; work = the transcript fold; guard = the
 * run's guard chips; cpu = the machine's CPU busy % now | null; ctx = the run's context now (tokens) | null.
 */
export function runProgress(run, { runs = {}, brief = null, notes = null, mails = [], work = workInit(), guard = [], cpu = null, ctx = null, now = Date.now(), stall_min = STALE_MIN } = {}) {
  const sess = sessionsOf(run, runs), first = sess[0] ?? run, live = run.state === 'running';
  const plan = briefPlan(brief), added = mails.filter(m => Date.parse(m.created) >= Date.parse(first.created)).sort((a, b) => num(a.id) - num(b.id));
  const end = live ? now : Date.parse(endOf(run) ?? '') || now;
  const items = checklist({ plan, mails: added, work, notes, now: end }), done = items.filter(x => x.state === 'done').length;
  const doing = live ? nowDoing(work, now) : null;
  const tw = items.map(it => ({ ...it, tw: stems(it.title) })), which = doing && doing.files.map(f => fileItem(f, tw)).find(it => it && it.state !== 'done');
  const line = (items.length ? `${done} of ${items.length} items done` : 'no numbered items in the brief')
    + (doing ? `, ${doing.verb}${which ? ` item ${which.n}` : ''}` : !live && run.end?.outcome ? ` · ${run.end.outcome}` : '');
  // pace: every session of the stage counts; the budget is the brief's (else the run's own)
  const elapsed = sess.reduce((s, x) => s + ((x.id === run.id ? end : Date.parse(endOf(x) ?? '') || end) - Date.parse(x.created)), 0) / 60000;
  const budget = plan.budget_min ?? run.data?.budget_min ?? null, est = estimate(run, runs), moved = lastMove(work);
  const still = live && mins(now - Date.parse(moved ?? run.created)) >= stall_min ? mins(now - Date.parse(moved ?? run.created)) : null;
  const over = (budget && elapsed > budget) || (est && elapsed > est.min * 1.5);
  const state = still !== null ? 'stalled' : over ? 'slow' : 'on track';
  const handoffs = sess.filter(x => x.id !== run.id && x.end?.outcome === 'handoff').length;
  const pace = { state, elapsed_min: Math.round(elapsed), budget_min: budget, sessions: sess.length, handoffs, estimate: est, last_move: moved, still_min: still,
    words: [state === 'stalled' ? `stalled: no commit, edit or test change for ${fmtMin(still)}` : state,
      `${fmtMin(elapsed)}${budget ? ` of a ${fmtMin(budget)} budget` : ''}`, sess.length > 1 ? `session ${sess.length} (${handoffs} hand-off${handoffs === 1 ? '' : 's'})` : null,
      est ? `similar work took ${fmtMin(est.min)} (median of ${est.n}, ${est.from})` : null].filter(Boolean).join(' · ') };
  // why slow: the last hour (or the run, if shorter) of this session
  const from = Math.max(Date.parse(run.created), end - 3600000), tests = work.calls.filter(x => x.kind === 'test');
  const ts = share(tests, from, end), runsOf = new Map();
  for (const x of tests) runsOf.set(x.key, (runsOf.get(x.key) || 0) + 1);
  const [rk, rn] = [...runsOf].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  const span = end - from >= 3300000 ? 'the last hour' : `its ${fmtMin(mins(end - from))}`;
  const why = [ts >= 0.2 ? `${pctOf(ts)} of ${span} in test runs` : null, Number.isFinite(cpu) && cpu >= 85 ? `the machine is at ${Math.round(cpu)} % CPU` : null,
    rn >= 3 ? `the same ${/\.test\.|test_|_test\./.test(rk) ? (rk.includes(' ') ? 'test files' : 'file') : 'test'} re-run ${rn} times (${String(rk).slice(0, 60)})` : null,
    handoffs ? `${handoffs} hand-off${handoffs === 1 ? '' : 's'} (each new session re-reads the brief and the code)` : null,
    added.length ? `${added.length} mail${added.length === 1 ? '' : 's'} added scope (${added.map(m => m.id).join(', ')})` : null].filter(Boolean);
  const slow = { test_share: ts, repeats: rn >= 3 ? { key: rk, n: rn } : null, cpu: Number.isFinite(cpu) ? Math.round(cpu) : null, reasons: why,
    line: why.length ? `${state === 'on track' ? 'time goes to' : state}: ${why.join('; ')}` : null };
  const moving = !!moved && Date.parse(moved) >= now - stall_min * 60000;
  const alarms = guard.map(g => ({ id: g.id, state: g.state, ...alarmWords(g, { test_share: ts, ctx, moving }) }));
  return { run: run.id, line, items, done, total: items.length, now: doing ? { verb: doing.verb, item: which?.n ?? null } : null, pace, slow, alarms, done_when: plan.done };
}

/** the folds of a stage's sessions (oldest first) as one: a commit of session 1 still counts in session 2; the open calls are the last's.
 *  Linear (NORN-UI-PERF: the pairwise sha check and the re-spread arrays were 22 % of a warm big-project GET); a single fold is
 *  returned as a shallow copy, its seen set shared (read-only here: only onWork adds to a fold's own set) */
export function mergeWork(ws) {
  const xs = ws.filter(Boolean);
  if (xs.length === 1) return { ...xs[0], calls: [...xs[0].calls], commits: [...xs[0].commits] };
  const out = workInit(), shas = new Set();
  for (const w of xs) {
    const add = [];   // a commit dedupes against the earlier sessions only, as the stage's history reads
    for (const c of w.commits) if (!shas.has(c.sha)) { out.commits.push(c); add.push(c.sha); }
    for (const x of add) shas.add(x);
    for (const c of w.calls) out.calls.push(c);
    for (const k of w.seen) out.seen.add(k);
    out.open = w.open; out.first ??= w.first; out.last = w.last ?? out.last;
  }
  return out;
}

/**
 * laneSteps(name, items, now) -> { last: "S1 done 2 h ago (RUN-148)" | null, next: "MERGE queued" | null }: the newest finished stage of
 * the lane and the run queued on it (a queued MERGE reads "merge queued"); the PR state is laneOutput's (purpose.mjs)
 */
export function laneSteps(name, items = {}, now = Date.now()) {
  const runs = [...(indexOf(items).lanes.get(name) ?? [])].sort((a, b) => num(b.id) - num(a.id));
  const fin = runs.find(r => r.state === 'exited' && r.end?.outcome === 'done'), q = runs.filter(r => r.state === 'queued').at(-1);
  const ago = r => { const t = Date.parse(endOf(r) ?? ''); return Number.isFinite(t) ? ` ${fmtMin(mins(now - t))} ago` : ''; };
  return { last: fin ? `${fin.data.stage ?? 'a run'} done${ago(fin)} (${fin.id})` : null,
    next: q ? (isLanding(q.data) ? `merge queued (${q.id})` : `${q.data.stage ?? 'a run'} queued (${q.id})`) : null };
}
