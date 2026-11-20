// Activity view (RM-36): what a worker is doing, derived from its live feed events (harness/claude.mjs transcriptEvents, the
// /api/feed `ev` stream) - the open tool call as one sentence, its plan, the files it touched, its commands and test counts, its
// commits. Pure (no DOM, no fs): the same module in the browser (/activity.mjs) and in node --test, and a fold over events, so a
// live run and a replayed finished run give the same view. activityInit() -> state; activityAdd(state, ev); activityView(state, o).
// The fields read are Claude Code's tool inputs (file_path, offset, limit, old_string, new_string, content, command, pattern, ...);
// a harness without them (codex: shell reads, apply_patch edits) still gets the commands, commits and words.

import { isTest } from '../lib/testcmd.mjs';   // the browser gets it at /lib/testcmd.mjs (server.mjs)
const MAX_CMDS = 200, MAX_DIFFS = 30, MAX_COMMITS = 100, MAX_OPEN = 50;
const fwd = s => String(s ?? '').replace(/\\/g, '/');
const cut = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const line1 = s => String(s ?? '').split(/\r?\n/).map(x => x.trim()).find(Boolean) || '';
const secsOf = (a, b) => { const s = (Date.parse(b ?? '') - Date.parse(a ?? '')) / 1000; return Number.isFinite(s) && s >= 0 ? s : null; };

export function activityInit() { return { open: new Map(), files: new Map(), cmds: [], commits: [], todos: null, words: null, idleSince: null, lastTs: null }; }

/** Fold one feed event into the state (mutates it, returns it). Only a call whose result arrived counts as done work. */
export function activityAdd(s, e) {
  if (!e || typeof e !== 'object') return s;
  if (e.ts) s.lastTs = e.ts;
  if (e.done) {
    s.idleSince = e.ts ?? s.idleSince;
    const call = s.open.get(e.id);
    if (call) { s.open.delete(e.id); finish(s, call, e); }
    return s;
  }
  if (e.kind === 'text') { s.words = { text: e.text ?? e.summary ?? '', ts: e.ts ?? null }; s.idleSince = e.ts ?? s.idleSince; }
  else if (e.kind === 'step' && Array.isArray(e.todos)) s.todos = e.todos;
  else if (e.kind === 'tool' && e.id) {
    s.open.set(e.id, { id: e.id, name: e.name ?? 'tool', input: e.input || {}, summary: e.summary ?? '', ts: e.ts ?? null });
    if (s.open.size > MAX_OPEN) s.open.delete(s.open.keys().next().value);
  }
  return s;
}

function touch(s, p, how, ts) {
  const key = fwd(p).toLowerCase();
  let f = s.files.get(key);
  if (!f) { f = { path: fwd(p), reads: 0, edits: 0, writes: 0, created: false, first: ts, last: ts, diffs: [] }; s.files.set(key, f); }
  f[how]++; f.last = ts ?? f.last;
  return f;
}
function finish(s, call, res) {
  const ok = res.kind !== 'error', inp = call.input, text = String(res.text ?? res.summary ?? ''), ts = res.ts ?? call.ts;
  const name = call.name;
  if (name === 'Read' && ok && inp.file_path) touch(s, inp.file_path, 'reads', ts);
  else if ((name === 'Edit' || name === 'Write') && ok && inp.file_path) {
    const known = s.files.has(fwd(inp.file_path).toLowerCase()), f = touch(s, inp.file_path, name === 'Edit' ? 'edits' : 'writes', ts);
    if (name === 'Write' && (/^File created/i.test(text) || (!known && !/updated/i.test(text)))) f.created = true;
    f.diffs.push(name === 'Edit' ? { ts, old: inp.old_string ?? '', new: inp.new_string ?? '', all: !!inp.replace_all }
      : { ts, old: '', new: inp.content ?? '', lines: inp.content_lines ?? null, write: true });
    if (f.diffs.length > MAX_DIFFS) f.diffs.shift();
  } else if (name === 'Bash' || name === 'PowerShell') {
    const cmd = String(inp.command ?? ''), sh = shell(cmd), bg = /running in background with ID|moved to the background/i.test(text) || inp.run_in_background === true;
    const exit = text.match(/^Exit code (\d+)/m);
    s.cmds.push({ id: call.id, cmd: cut(stripCd(cmd), 400), desc: inp.description ?? null, kind: sh.kind, ts: call.ts, end: res.ts ?? null, secs: secsOf(call.ts, res.ts),
      outcome: bg ? 'background' : ok ? 'ok' : 'error', exit: exit ? Number(exit[1]) : null, tests: sh.kind === 'test' && !bg ? parseTests(text) : null });
    if (s.cmds.length > MAX_CMDS) s.cmds.shift();
    if (sh.kind === 'read' && ok && !bg) touch(s, sh.file, 'reads', ts);
    if (sh.kind === 'commit' && ok && !bg) {
      const made = [...text.matchAll(/^\[([^\]\s]+)(?: \([^)]*\))? ([0-9a-f]{7,40})\] (.+)$/gm)].map(m => ({ branch: m[1], sha: m[2], subject: m[3].trim(), ts }));
      if (made.length) s.commits.push(...made);
      else if (sh.msg && !/nothing to commit|no changes added/i.test(text)) s.commits.push({ branch: null, sha: null, subject: sh.msg, ts });
      if (s.commits.length > MAX_COMMITS) s.commits.splice(0, s.commits.length - MAX_COMMITS);
    }
  }
}

// a shell line without its `cd <dir> &&` / env / timeout prefixes - what the worker actually ran
export function stripCd(cmd) {
  let c = String(cmd ?? '').trim(), prev;
  do {
    prev = c;
    c = c.replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, '').replace(/^mkdir\s+-p\s+(?:"[^"]*"|\S+)\s*(?:&&|;)\s*/, '')
      .replace(/^(?:export\s+)?[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/, '').replace(/^(?:time|timeout\s+\d+[smh]?)\s+/, '');
  } while (c !== prev);
  return c;
}
const unq = s => String(s ?? '').replace(/^(["'])(.*)\1$/, '$2');
const pathy = s => /^[\w./~:-]+\.[A-Za-z0-9]{1,8}$/.test(s);
/** A shell command -> { kind: test | commit | git | read | search | run, ... } (the first segment for read / search / git). */
export function shell(cmd) {
  const c = stripCd(cmd), first = c.split(/\s*(?:&&|\|\||;|\|)\s*/)[0];
  if (isTest(c)) return { kind: 'test' };
  if (/\bgit\s+(?:-C\s+\S+\s+)?commit\b/.test(c)) {
    const m = c.match(/\bgit\s+(?:-C\s+\S+\s+)?commit\b[^\n]*?\s-[a-zA-Z]*m\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/);
    return { kind: 'commit', msg: m ? line1((m[1] ?? m[2]).replace(/^\$\(cat <<-?'?\w+'?[ \t]*\n/, '').replace(/\\"/g, '"')) || null : null };   // -m "$(cat <<'EOF' ...": the line after
  }
  let m = first.match(/^sed\s+-n\s+['"]?(\d+)(?:,(\d+))?p['"]?\s+(\S+)$/);
  if (m && pathy(unq(m[3]))) return { kind: 'read', file: unq(m[3]), from: Number(m[1]), to: Number(m[2] ?? m[1]) };
  m = first.match(/^(?:cat|head|tail|less|wc\s+-l)(?:\s+-n\s*\d+|\s+-\d+)?\s+(\S+)$/);
  if (m && pathy(unq(m[1]))) return { kind: 'read', file: unq(m[1]) };
  m = first.match(/^(?:grep|rg)\b((?:\s+-[\w-]+(?:=\S+)?)*)\s+("[^"]*"|'[^']*'|\S+)(?:\s+(\S+))?/);
  if (m) return { kind: 'search', pattern: unq(m[2]), path: m[3] ? unq(m[3]) : null };
  m = first.match(/^git\s+(?:-C\s+\S+\s+)?([\w-]+)/);
  if (m) return { kind: 'git', sub: m[1] };
  return { kind: 'run' };
}

/**
 * Pass / fail counts of a test run's output: node --test (spec ℹ and TAP # summaries, summed over the files a loop ran), pytest's
 * summary line, ci-suite's red line; failed: the failing test names (5 at most). null = no counts in the text.
 */
export function parseTests(text) {
  const t = String(text ?? ''), sum = re => { let n = null; for (const m of t.matchAll(re)) n = (n ?? 0) + Number(m[1]); return n; };
  const names = new Set(), add = s => { s = s.trim(); if (s && !/^failing tests:?$/i.test(s)) names.add(s); };
  const ci = t.match(/ci-suite: (\d+) listed red\(s\), (\d+) new, (\d+) leak\(s\), (\d+) hang\(s\)/);
  if (ci) {
    for (const m of t.matchAll(/^(?:NEW|LEAK|HANG) RED: (.+)$/gm)) add(m[1]);
    return { pass: null, fail: Number(ci[2]) + Number(ci[3]) + Number(ci[4]), listed: Number(ci[1]), failed: [...names].slice(0, 5) };
  }
  const py = [...t.matchAll(/^=+ (.*\b(?:passed|failed|errors?|no tests ran)\b.*?) in [\d.]+s(?: \([^)]*\))? =+\s*$/gm)].at(-1);
  if (py) {
    const n = w => Number(py[1].match(new RegExp(`(\\d+) ${w}`))?.[1] ?? 0);
    for (const m of t.matchAll(/^(?:FAILED|ERROR) (\S+)/gm)) add(m[1]);
    return { pass: n('passed'), fail: n('failed') + n('errors?'), failed: [...names].slice(0, 5) };
  }
  const pass = sum(/^\s*ℹ pass (\d+)/gm) ?? sum(/^# pass (\d+)/gm), fail = sum(/^\s*ℹ fail (\d+)/gm) ?? sum(/^# fail (\d+)/gm);
  if (pass === null && fail === null) return null;
  for (const m of t.matchAll(/^\s*✖ (.+?)(?: \([\d.]+m?s\))?\s*$/gm)) add(m[1]);
  for (const m of t.matchAll(/^\s*not ok \d+ - (.+?)(?: # .*)?$/gm)) add(m[1]);
  return { pass: pass ?? 0, fail: fail ?? 0, failed: fail ? [...names].slice(0, 5) : [] };
}

/** Seconds -> "12 s" / "4 min" / "1 h 05". */
export function fmtDur(secs) {
  if (!Number.isFinite(secs)) return '';
  if (secs < 60) return `${Math.round(secs)} s`;
  if (secs < 3600) return `${Math.round(secs / 60)} min`;
  const h = Math.floor(secs / 3600); return `${h} h ${String(Math.round((secs - h * 3600) / 60)).padStart(2, '0')}`;
}
/** A path relative to the worktree root when inside it (forward slashes). */
export function relPath(p, root) {
  const a = fwd(p), r = fwd(root).replace(/\/+$/, '');
  return r && a.toLowerCase().startsWith(r.toLowerCase() + '/') ? a.slice(r.length + 1) : a;
}
const linesOf = (from, n) => (Number.isFinite(from) || Number.isFinite(n) ? `, lines ${from ?? 1}-${(from ?? 1) + (n ?? 2000) - 1}` : '');
/** The open tool call as one plain sentence ("Reading engine/lib/views.mjs, lines 100-150"). */
export function sentence(call, root) {
  const i = call.input || {}, rel = p => relPath(p, root), q = s => `'${cut(s, 60)}'`;
  switch (call.name) {
    case 'Read': return `Reading ${rel(i.file_path)}${linesOf(i.offset, i.limit)}`;
    case 'Edit': case 'MultiEdit': return `Editing ${rel(i.file_path)}`;
    case 'Write': return `Writing ${rel(i.file_path)}`;
    case 'NotebookEdit': return `Editing ${rel(i.notebook_path ?? i.file_path)}`;
    case 'Grep': return `Searching ${i.path ? rel(i.path) : 'the worktree'} for ${q(i.pattern)}${i.glob ? ` in ${i.glob}` : ''}`;
    case 'Glob': return `Looking for files ${i.pattern ?? ''}${i.path ? ` in ${rel(i.path)}` : ''}`;
    case 'TodoWrite': return 'Updating its plan';
    case 'Agent': case 'Task': return `Delegating: ${line1(i.description ?? i.prompt)}`;
    case 'Monitor': return `Watching: ${line1(i.description ?? i.command ?? call.summary)}`;
    case 'TaskStop': return 'Stopping a background job';
    case 'ToolSearch': return 'Loading tool definitions';
    case 'WebFetch': return `Reading ${i.url ?? 'a web page'}`;
    case 'WebSearch': return `Searching the web for ${q(i.query)}`;
    case 'Bash': case 'PowerShell': {
      const c = String(i.command ?? ''), sh = shell(c), short = cut(line1(stripCd(c)), 100);
      if (sh.kind === 'test') return `Running tests: ${short}`;
      if (sh.kind === 'commit') return `Committing${sh.msg ? `: ${cut(sh.msg, 100)}` : ''}`;
      if (sh.kind === 'read') return `Reading ${rel(sh.file)}${sh.from ? `, lines ${sh.from}-${sh.to}` : ''}`;
      if (sh.kind === 'search') return `Searching ${sh.path ? rel(sh.path) : 'the worktree'} for ${q(sh.pattern)}`;
      if (sh.kind === 'git') return `Running git ${sh.sub}: ${short}`;
      return `Running ${short}`;
    }
    default: return `${call.name}${call.summary ? `: ${call.summary}` : ''}`;
  }
}

// ---- the plan without a todo list: the brief's numbered items, done when the NOTES or a commit name them ----
/** The brief's first top-level numbered list -> [{ n, title }] (the bold lead when there is one, else the first words). */
export function briefItems(text) {
  const out = [];
  for (const l of String(text ?? '').split(/\r?\n/)) {
    const m = l.match(/^(\d+)\.\s+(.+)$/);
    if (!m) continue;
    const n = Number(m[1]);
    if (n !== out.length + 1) { if (out.length) break; continue; }
    const b = m[2].match(/\*\*(.+?)\*\*/);
    out.push({ n, title: (b ? b[1] : cut(m[2].replace(/[*_`]/g, ''), 70)).replace(/[:,.]\s*$/, '').trim() });
  }
  return out;
}
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DONE_WORD = /\b(?:done|landed|built|finished|complete[d]?|works)\b|✓|\[x\]/i;
/**
 * The numbers of the items a text names: a line with the item's title (whole words) or "item / step / part N"; with doneWord
 * (the NOTES: a log, not a claim) the line must also say done / landed / built / finished / complete / works (or ✓, [x]).
 */
export function namedDone(items, text, { doneWord = false } = {}) {
  const lines = String(text ?? '').split(/\r?\n/).filter(l => !doneWord || DONE_WORD.test(l)), out = [];
  for (const it of items || []) {
    const re = new RegExp(`(?:^|[^\\w])(?:${reEsc(it.title)}|(?:item|step|part)\\s*#?${it.n})(?![\\w])`, 'i');
    if (it.title && lines.some(l => re.test(l))) out.push(it.n);
  }
  return out;
}

/**
 * The view. o: { now (ms), root (the worktree: paths shown relative), brief ([{ n, title }]), notesDone ([n]), ended (the run is over) } ->
 * { now { text, since, secs, busy } | null, words { text, ts } | null, plan { source, items [{ text, state done | current | next }] },
 *   files { read, edited, created } (rows newest first), cmds (newest first), commits (newest first) }
 */
export function activityView(s, o = {}) {
  const now = o.now ?? Date.now(), root = o.root ?? null, iso = new Date(now).toISOString();
  const open = [...s.open.values()].sort((a, b) => String(a.ts).localeCompare(String(b.ts))).at(-1);
  const nowLine = o.ended ? { text: 'The run has ended', since: s.lastTs, secs: null, busy: false }
    : open ? { text: sentence(open, root), since: open.ts, secs: secsOf(open.ts, iso), busy: true, tool: open.name, more: s.open.size - 1 }
      : s.idleSince || s.lastTs ? { text: 'Thinking / writing', since: s.idleSince ?? s.lastTs, secs: secsOf(s.idleSince ?? s.lastTs, iso), busy: false } : null;
  let plan;
  if (s.todos?.length) {
    plan = { source: 'todos', items: s.todos.map(t => ({ text: t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content, state: t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'current' : 'next' })) };
  } else if (o.brief?.length) {
    const done = new Set([...(o.notesDone || []), ...namedDone(o.brief, s.commits.map(c => c.subject).join('\n'))]);
    const cur = o.brief.find(it => !done.has(it.n))?.n;
    plan = { source: 'brief', items: o.brief.map(it => ({ n: it.n, text: it.title, state: done.has(it.n) ? 'done' : it.n === cur ? 'current' : 'next' })) };
  } else plan = { source: null, items: [] };
  const rows = [...s.files.values()].map(f => ({ ...f, rel: relPath(f.path, root), group: f.created ? 'created' : f.edits || f.writes ? 'edited' : 'read' }))
    .sort((a, b) => String(b.last).localeCompare(String(a.last)));
  const files = { read: rows.filter(r => r.group === 'read'), edited: rows.filter(r => r.group === 'edited'), created: rows.filter(r => r.group === 'created') };
  return { now: nowLine, words: s.words, plan, files, cmds: [...s.cmds].reverse(), commits: [...s.commits].reverse() };
}

/** Events -> the view in one call (a replay; the tests). */
export const activityOf = (events, o) => activityView((events || []).reduce(activityAdd, activityInit()), o);
