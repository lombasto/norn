// META-UX-BUILD S7 (REPORT meta-ux-plan s.3 "End to end" 3-5, DIR-65 Q2 A): the fixer run of a Fix all directive. An ACTIVE directive a
// Send wrote (data.fixall = its decision) with no fixer run gets ONE queued docs-class run, started by code (the tick spawns
// `norn fix start DIR-n --queue`, the merge queue's pattern) through the normal queue: caps, slots, the weekly stop and the rate cap.
// The run is the audit's kind of run (read-only, its final message = its notes file) with a GENERATED brief: the ids, each finding's
// fix sentence / patch / picked way, its file + line. It answers in the audit format (audit.mjs parseAudit: hunks) plus one line per
// finding: drafted, or skipped and why. A run takes at most policy.fixer.batch findings; a Send approves ceil(n / batch) runs, never
// more (decision.data.runs; a decision without it approved ONE run). Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseAudit } from './audit.mjs';

export const FIX_LANE = 'fixall';
export const fixerDir = state => path.join(state, 'fixer');
const fwd = p => String(p ?? '').replace(/\\/g, '/');
const readOrNull = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const byCreated = (a, b) => String(a.created).localeCompare(String(b.created));

/** the batch size of one fixer run (policy.fixer.batch, defaults in policy.mjs) */
export const fixBatch = pol => Math.max(1, Number(pol?.fixer?.batch) || 40);
/** the runs a send of n findings needs */
export const runsFor = (n, batch) => Math.max(1, Math.ceil(n / batch));

/** the fixer runs of directive id (oldest first): lane fixall, the brief named <DIR>-<stamp>.brief.md */
// a queued run that the fill started is 'filled' (the started run is its own record) and a withdrawn one never ran: neither counts
export const fixRuns = (items, id) => Object.values(items).filter(i => i.kind === 'run' && i.data?.lane === FIX_LANE && !['filled', 'withdrawn'].includes(i.state) && path.basename(fwd(i.data.brief)).startsWith(`${id}-`)).sort(byCreated);

/** the decisions on directive id's results (lane fixall-result: apply / skip / discard), oldest first */
const verdicts = (items, id) => Object.values(items).filter(i => i.kind === 'decision' && i.data?.lane === 'fixall-result' && i.data.directive === id).sort(byCreated);

/** a run's batch: the ids its brief names (the brief is the record of what ran) */
export const briefIds = text => [...String(text ?? '').matchAll(/^- id: (\S+)/gm)].map(m => m[1]);

/**
 * the plan of one fixall directive: { id, dec, ids, approved, runs, live, done (ids a run took), resolved (applied / skipped /
 * discarded), left (no run took them yet), next (the next run's batch, null = start nothing), more (runs the rest needs) }
 * readBrief(run) -> the brief text of a run (its batch)
 */
export function fixPlan(dir, items, { batch = 40, readBrief = () => '' } = {}) {
  const ids = dir.data.findings || [], dec = items[dir.data.fixall];
  const extra = Object.values(items).filter(i => i.kind === 'decision' && i.data?.lane === FIX_LANE && i.data.rest_of === dir.id && i.state === 'in-force');
  const approved = (Number(dec?.data?.runs) || 1) + extra.reduce((n, d) => n + (Number(d.data.runs) || 1), 0);
  const runs = fixRuns(items, dir.id), live = runs.find(r => ['queued', 'claimed', 'running'].includes(r.state)) ?? null;
  // a verdict's open ids (hunks that did not apply) go back to the rest: a later batch can take them
  const vs = verdicts(items, dir.id), reopen = r => new Set(vs.filter(v => v.data.run === r.id).flatMap(v => v.data.open || []));
  const took = new Set(runs.filter(r => r.end?.outcome !== 'crash' && r.state !== 'cancelled').flatMap(r => { const o = reopen(r); return briefIds(readBrief(r)).filter(x => !o.has(x)); }));
  const resolved = new Set(vs.flatMap(v => v.data.ids || []));
  const left = ids.filter(x => !took.has(x) && !resolved.has(x));
  const counted = runs.filter(r => r.end?.outcome !== 'crash' && r.state !== 'cancelled').length;
  const next = !live && dir.state === 'active' && left.length && counted < approved ? left.slice(0, batch) : null;
  return { id: dir.id, dec: dec?.id ?? null, ids, approved, runs: runs.map(r => r.id), live: live?.id ?? null, done: [...took], resolved: [...resolved], left, next, more: left.length ? runsFor(left.length, batch) : 0 };
}

/** a path as the brief lists it: relative to the project root when it lies under it (the diff headers use it), else as it is */
const relTo = (root, p) => { const a = fwd(p), r = fwd(root).replace(/\/$/, ''); return r && a.toLowerCase().startsWith(r.toLowerCase() + '/') ? a.slice(r.length + 1) : a; };
/** a file's text with LF endings and no BOM, or null */
const plain = t => (t == null ? null : String(t).replace(/^﻿/, '').replace(/\r\n/g, '\n'));
/** the exact current lines around a finding (the fixer quotes its context from them): `<n>| <line>` */
const linesNow = (text, line, pad = 4) => {
  const ls = plain(text)?.replace(/\n$/, '').split('\n');
  if (!ls || !line) return null;
  const a = Math.max(1, line - pad), b = Math.min(ls.length, line + pad);
  return a > b ? null : ls.slice(a - 1, b).map((l, i) => `    ${a + i}| ${cut(l, a + i, a + i === line ? FIND_MAX : LINE_MAX)}`).join('\n');
};
// a long context line is cut (memory files hold 2000-char lines: 40 findings x 9 whole lines made a 329 kB brief) and says so;
// the finding's own line stays whole up to FIND_MAX (cut, the fixer skipped it: "the line is cut, so I cannot quote it")
const LINE_MAX = 300, FIND_MAX = 6000;
const cut = (l, n, max) => (l.length > max ? `${l.slice(0, max)}… [cut: ${l.length - max} more chars: Read line ${n} in the file to quote it whole]` : l);
/** the fixer run's prompt: a pointer to its brief file (a Windows command line holds ~32k chars; the brief can be far longer) */
export const fixerPrompt = brief => `Read ${fwd(brief)} (your brief: the findings, their lines now and the answer format) and do exactly that. You are READ-ONLY; your FINAL message is the answer.`;

/** the generated brief of one fixer run: the findings (id, file:line, fix sentence, patch, picked way, the exact lines now) and the answer format */
export function fixerBrief({ project, dir, dec, rows, picks = [], root = '', readFile = readOrNull }) {
  const way = r => picks.find(q => r.key && (q.key === r.key || q.key.split('|')[0] === r.key))?.way ?? null;
  const items = rows.map(r => {
    const now = r.path && r.line ? linesNow(readFile(r.path), Number(r.line)) : null;
    return [`- id: ${r.id}`, `  file: ${relTo(root, r.path)}${r.line ? `:${r.line}` : ''}`, `  finding: ${String(r.why ?? r.title ?? '').replace(/\s+/g, ' ').slice(0, 400)}`,
      r.action ? `  fix: ${String(r.action).replace(/\s+/g, ' ').slice(0, 300)}` : null, way(r) ? `  the owner picked: ${way(r)}` : null,
      r.patch ? `  patch (ready):\n${String(r.patch).split('\n').map(l => `    ${l}`).join('\n')}` : null,
      now ? `  lines now (the file as it is; quote context exactly from here):\n${now}` : null].filter(Boolean).join('\n');
  });
  return [`# Fixer run - ${project}, ${dir} (approved by ${dec}): ${rows.length} finding(s)`, '',
    'You are READ-ONLY: draft every change, edit nothing. The owner applies your hunks on one result card (nothing lands before he taps Apply).',
    'Read each named file around its line, then write, as your FINAL message:',
    '1. For each file you change, one heading `### `path/to/file:line` - medium - rewrite` and a ```diff block (unified: --- a/<path>, +++ b/<path>, @@ -l,n +l,m @@ hunks) with the exact new text; <path> = the file as the list names it.',
    '   EXACT CONTEXT: every hunk carries 2-3 unchanged context lines before and after the change (fewer only at the start or end of the file); each context line and each `-` line is copied byte for byte from the file (its "lines now" below: same spelling, spaces, punctuation, never shortened); l = the number of the first context line, n = context + `-` lines, m = context + `+` lines. Every hunk is checked against the file as it is: one that does not apply as written shows as "does not apply" and its finding stays open. A line shown cut: Read it in the file and quote it whole; never skip a finding because a line is cut.',
    '2. A list `## Findings` with ONE line per finding below: `- <id>: drafted` or `- <id>: skipped: <why>` (a your-call finding without a picked way, a fix you cannot make safely).',
    'Keep every unrelated line as it is. Never touch a file the list does not name.', '', '## The findings', '', ...items, ''].join('\n');
}

/** does a unified hunk (--- / +++ / one @@ -l,n +l,m @@ and its lines) apply to the file's text as it is now? null = it applies, else why not */
export function hunkMisfit(patch, text) {
  const t = plain(text);
  if (t == null) return 'the file is not there';
  const ls = String(patch ?? '').replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'), at = ls.findIndex(l => l.startsWith('@@'));
  const h = ls[at]?.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
  if (!h) return 'no @@ -l,n +l,m @@ header';
  const body = ls.slice(at + 1).filter(l => !l.startsWith('\\')), bad = body.find(l => l !== '' && !/^[ +-]/.test(l));
  if (bad !== undefined) return `a line without a " ", "-" or "+" mark: ${bad.slice(0, 60)}`;
  const isOld = l => l === '' || l[0] === ' ' || l[0] === '-', isNew = l => l === '' || l[0] === ' ' || l[0] === '+';
  const old = body.filter(isOld).map(l => l.slice(1)), nw = body.filter(isNew).length, ctx = body.filter(l => l === '' || l[0] === ' ').length;
  const n = h[2] === undefined ? 1 : Number(h[2]), m = h[3] === undefined ? 1 : Number(h[3]), l = Number(h[1]);
  if (old.length !== n || nw !== m) return `the @@ header counts ${n} old and ${m} new line(s), the hunk has ${old.length} and ${nw}`;
  if (!ctx && n) return 'no context line (git apply refuses a zero-context hunk)';
  const fl = t.replace(/\n$/, '').split('\n'), fits = s => old.every((x, i) => fl[s + i] === x);
  if (!n) return l <= fl.length ? null : `line ${l} is past the end of the file (${fl.length} lines)`;
  if (fits(l - 1)) return null;
  for (let s = 0; s + n <= fl.length; s++) if (fits(s)) return `the old lines are at line ${s + 1}, not ${l}`;
  const miss = old.findIndex((x, i) => fl[l - 1 + i] !== x);
  return `line ${l + miss} is not as the hunk quotes it (the file: "${String(fl[l - 1 + miss] ?? '(end of file)').slice(0, 80)}")`;
}

/** a brief's rows back: [{ id, file, line }] (its `- id:` + `  file: path:line` lines) */
export const briefRows = text => [...String(text ?? '').replace(/\r\n/g, '\n').matchAll(/^- id: (\S+)\n {2}file: (.+?)(?::(\d+))?$/gm)].map(m => ({ id: m[1], file: m[2], line: m[3] ? Number(m[3]) : null }));

/** a fixer run's final message -> { hunks (parseAudit's, id = a hash of the patch; applies + why = checked against the file as it is now),
 *  status [{ id, state drafted|skipped|missing, why }], open (drafted ids whose hunk does not apply: they stay open), failed, fail (why) }
 *  readFile(file) -> its text or null; rows (briefRows) tie a finding to the hunks of its file */
export function fixResult(text, ids, { readFile = readOrNull, rows = [] } = {}) {
  const { hunks } = parseAudit(text), t = String(text ?? '').replace(/\r\n/g, '\n');
  const status = ids.map(id => {
    const m = t.match(new RegExp(`^\\s*[-*]\\s*\`?${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\`?\\s*:\\s*(drafted|skipped)\\b:?[ \\t]*(.*)$`, 'mi'));
    return { id, state: m ? m[1].toLowerCase() : 'missing', why: m?.[2]?.trim() || null };
  });
  const texts = new Map(), read = f => { if (!texts.has(f)) texts.set(f, readFile(f)); return texts.get(f); };
  const hs = hunks.map(h => {
    const why = hunkMisfit(h.patch, read(h.file));
    return { id: createHash('sha1').update(h.patch).digest('hex').slice(0, 12), file: h.file, line: h.line, count: h.count, patch: h.patch, applies: !why, why };
  });
  // a drafted finding stays open when its file has a hunk that does not apply and no applying hunk covers its line
  const same = (a, b) => { const x = fwd(a).toLowerCase(), y = fwd(b).toLowerCase(); return x === y || x.endsWith('/' + y) || y.endsWith('/' + x); };
  const covers = (h, line) => line && h.line <= line && line < h.line + Math.max(1, h.count);
  const open = status.filter(s => s.state === 'drafted').map(s => s.id).filter(id => {
    const r = rows.find(x => x.id === id), mine = r ? hs.filter(h => same(h.file, r.file)) : [];
    return mine.some(h => !h.applies) && !mine.some(h => h.applies && covers(h, r.line));
  });
  const n = hs.filter(h => h.applies).length;
  return { hunks: hs, status, open, failed: n === 0, fail: !hs.length ? 'no parsable hunk' : n ? null : 'no hunk applies' };
}

/** the rows of a fixer brief, kept by the dash when it sees the directive (the guard rows live only there: never a second scan) */
export const findingsFile = (state, id) => path.join(fixerDir(state), `${id}.findings.json`);
export const fixerRows = (rows, ids) => {
  const want = new Set(ids);
  return rows.filter(r => want.has(r.id)).map(r => ({ id: r.id, key: r.batch ?? `${r.type}|${r.kind ?? 'drafts'}`, path: r.path ?? null, line: r.line ?? null,
    why: r.why ?? r.title ?? null, action: r.action ?? null, ...(typeof r.patch === 'string' ? { patch: r.patch } : {}) }));
};
/** write the findings file of every active fixall directive that has none yet (the dash's guard view calls it); returns the ids written */
export function keepFindings(state, items, rows) {
  const wrote = [];
  for (const d of Object.values(items).filter(i => i.kind === 'directive' && i.state === 'active' && i.data?.fixall && Array.isArray(i.data.findings))) {
    const f = findingsFile(state, d.id);
    if (fs.existsSync(f)) continue;
    const x = fixerRows(rows, d.data.findings);
    if (!x.length) continue;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ directive: d.id, at: new Date().toISOString(), rows: x }));
    wrote.push(d.id);
  }
  return wrote;
}
const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
export const readRunBrief = r => readText(r?.data?.brief);

/** the tick (beside the merge queue): a detached `norn fix start DIR-n --queue` for each active fixall directive whose plan has a next
 *  batch and whose findings file exists; a start stamp (5 min) keeps two ticks from spawning twice before the queued run is recorded */
// One fixer run per lane + stage (runs.mjs duplicateCheck): while any directive's fixer is queued / running, a start for another one is
// refused - the tick spawned that doomed start every pass, each leaving an orphan <DIR>-<stamp>.brief.md (solve-shack DIR-11: 6 briefs
// while DIR-8's RUN-32 waited in the queue). It waits for the lane instead and says so.
export function tickFix(p, state, { metaCmd, spawnFn, items, now = Date.now() } = {}) {
  const out = [];
  const holder = Object.values(items).find(i => i.kind === 'run' && i.data?.lane === FIX_LANE && i.data?.stage === 'fixer' && ['queued', 'claimed', 'running'].includes(i.state));
  for (const d of Object.values(items).filter(i => i.kind === 'directive' && i.state === 'active' && i.data?.fixall)) {
    if (!fs.existsSync(findingsFile(state, d.id)) || !fixPlan(d, items, { readBrief: readRunBrief }).next) continue;
    if (holder) { out.push(`fix: ${d.id} waits: fixer ${holder.id} is ${holder.state} (one fixer run at a time)`); continue; }
    const stamp = path.join(fixerDir(state), `${d.id}.starting`);
    try { if (now - fs.statSync(stamp).mtimeMs < 5 * 60000) continue; } catch { /* no stamp */ }
    fs.writeFileSync(stamp, new Date(now).toISOString());
    const r = spawnFn(process.execPath, [metaCmd, 'fix', 'start', d.id, '--queue', ...(p.file ? ['--project', p.file] : []), '--state', state]);
    out.push(`fix: ${d.id} -> norn fix start (pid ${r?.pid ?? '?'})`);
  }
  return out;
}

/** the result cards of a project: ONE per ended fixer run with no verdict yet. { run, directive, dec, notes, state ready|failed, files
 *  [{ file, hunks [{ id, line, patch }] }], n (hunks), status (drafted / skipped / missing per id), ids, left, more (the rest: runs) } */
export function fixCards(items, { batch = 40, readNotes = readText, readBrief = readRunBrief, root = '', readFile = readOrNull } = {}) {
  const out = [], all = Object.values(items);
  for (const d of all.filter(i => i.kind === 'directive' && i.data?.fixall)) {
    const plan = fixPlan(d, items, { batch, readBrief }), judged = new Set(verdicts(items, d.id).map(v => v.data.run));
    for (const r of fixRuns(items, d.id).filter(x => x.end && !judged.has(x.id) && x.state !== 'cancelled')) {
      const bt = readBrief(r), ids = briefIds(bt), rows = briefRows(bt), files = new Map();
      const at = f => (path.isAbsolute(f) || /^[A-Za-z]:[\\/]/.test(f) ? f : root ? path.join(root, f) : f);   // a hunk's file: the brief lists it relative to the root
      const res = fixResult(r.data.notes ? readNotes(r.data.notes) : '', ids, { rows, readFile: f => readFile(at(f)) });
      for (const h of res.hunks) { if (!files.has(h.file)) files.set(h.file, []); files.get(h.file).push({ id: h.id, line: h.line, patch: h.patch, applies: h.applies, why: h.why }); }
      out.push({ run: r.id, directive: d.id, dec: d.data.fixall, created: r.end?.at ?? r.updated ?? r.created, outcome: r.end?.outcome ?? null, notes: r.data.notes ?? null,
        state: res.failed ? 'failed' : 'ready', fail: res.fail, files: [...files].map(([file, hunks]) => ({ file, hunks, n: hunks.filter(h => h.applies).length })),
        n: res.hunks.filter(h => h.applies).length, bad: res.hunks.filter(h => !h.applies).length, open: res.open, status: res.status, ids,
        left: plan.left.filter(x => !ids.includes(x)).length, more: plan.next || plan.live ? 0 : plan.more });
    }
  }
  return out.sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

/** a verdict's ids: { ids (resolved by it), open (back to the rest: a later batch) }; a failed card resolves nothing */
export const verdictIds = card => {
  const open = card.state === 'failed' ? [...card.ids] : card.open || [];
  return { ids: card.ids.filter(x => !open.includes(x)), open };
};

/** the text of a verdict's directive (the audit accept path: the check-in applies the hunks; Norn edits nothing), or null */
export function verdictText(card, { choice, skip = [], close = null }) {
  const files = card.files.filter(f => !skip.includes(f.file)).map(f => ({ ...f, hunks: f.hunks.filter(h => h.applies !== false) })).filter(f => f.hunks.length);
  const n = files.reduce((a, f) => a + f.hunks.length, 0), bad = card.files.flatMap(f => f.hunks.filter(h => h.applies === false).map(h => `${f.file}:${h.line}`));
  const closing = close ? ` Then close ${card.directive} (every finding applied, skipped or discarded): \`norn rec done ${card.directive} --refs ${close}\`.` : '';
  if (choice === 'apply' && n) return `Apply the fixer hunks of ${card.run} (Fix all ${card.directive}, ${card.dec}): ${n} hunk(s) in ${files.map(f => f.file).join(', ')}. The diffs are the \`### file:line\` blocks of ${fwd(card.notes)}${skip.length ? `; leave ${skip.join(', ')} as it is` : ''}${bad.length ? `; leave the block(s) that do not apply (${bad.join(', ')})` : ''}. Apply the ${n} as written, one commit; edit nothing else. The next scan drops the fixed findings.${closing}`;
  return close ? closing.trim() : null;
}
