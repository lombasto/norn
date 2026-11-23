// lane-outputs: what a lane's runs wrote and what they ask of the owner, read from the lane's notes folder (state/<project>/notes/<lane>/).
// An audit or design lane's output is files (a report .md, stage briefs, NOTES.md, shots/*.png, data/), not a PR: this module lists them
// grouped (report / stage briefs / images / data) with the run that wrote each (by its time against the runs' windows), takes the
// run's 'Summary for the owner' section verbatim (the Findings card), finds every ruling the notes ask of the owner (an 'Open for the
// owner' / 'Decisions for you' / 'your rulings' / 'owner to decide' section, a STOPPED heading, a 'not queued' brief list - runasks.mjs
// posts one Inbox question each), reads the CLI's "Background tasks still running ... stopping them" line, and says in words what
// happens next on a lane whose last run ended (laneNext: one state vocabulary, NEXT_STATES). Pure but for listOutputs (fs.promises).
import fs from 'node:fs';
import path from 'node:path';
import { fwd } from './config.mjs';
import { idNum as num } from './records.mjs';
import { isLanded } from './deliverables.mjs';

const HEAD = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;

// ---------- the files ----------
export const GROUPS = [['report', 'Report'], ['briefs', 'Stage briefs'], ['images', 'Images'], ['data', 'Data']];
const IMG = /\.(?:png|jpe?g|gif|webp|svg)$/i, NOTESY = /^(?:NOTES|MERGE-NOTES|HANDOFF)[\w.-]*\.md$/i, BRIEF = /^brief-[\w.-]+\.md$/i;
/** a file's group by its path in the notes folder: images anywhere, brief-*.md at the top, other top-level .md = the report, the rest data */
export function groupOf(rel) {
  const r = fwd(rel), base = path.posix.basename(r), top = !r.includes('/');
  return IMG.test(r) ? 'images' : top && BRIEF.test(base) ? 'briefs' : top && /\.(?:md|markdown)$/i.test(base) ? 'report' : 'data';
}
const MAX_FILES = 400, MAX_DEPTH = 3;
/** every file under dir (depth 3, at most 400): [{ rel, path, size, mtime }]; a missing folder = [] */
export async function walkOutputs(dir, { fsp = fs.promises } = {}) {
  const out = [];
  async function walk(d, rel, depth) {
    let es; try { es = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of es.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_FILES) return;
      const p = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (depth < MAX_DEPTH) await walk(p, r, depth + 1); continue; }
      if (!e.isFile()) continue;
      const s = await fsp.stat(p).catch(() => null);
      if (s) out.push({ rel: r, path: fwd(p), size: s.size, mtime: new Date(s.mtimeMs).toISOString() });
    }
  }
  await walk(dir, '', 1);
  return out;
}
const startOf = r => Date.parse(r.created ?? '');
const endAt = r => { const h = (r.history || []).findLast(x => ['end', 'lost', 'kill'].includes(x.ev)); return h ? Date.parse(h.ts) : Infinity; };
/** the run that wrote a file at mtime: the newest of the lane's runs whose window [start, end + 2 min] holds it; null = none */
export function writerOf(mtime, runs) {
  const t = Date.parse(mtime);
  return [...runs].sort((a, b) => num(b.id) - num(a.id)).find(r => startOf(r) - 60e3 <= t && t <= endAt(r) + 120e3)?.id ?? null;
}
/** the lane's runs (helpers aside), from a loadState fold's items */
export const laneRuns = (lane, items) => Object.values(items || {}).filter(r => r.kind === 'run' && r.data?.lane === lane && r.data.role !== 'helper');
/** files -> [{ group, label, files [{ ..., group, run }] }] in GROUPS order, empty groups dropped; the report's notes files after the plan */
export function groupOutputs(files, runs = []) {
  const fs2 = files.map(f => ({ ...f, group: groupOf(f.rel), run: writerOf(f.mtime, runs) }));
  const order = f => (f.group === 'report' && NOTESY.test(f.rel) ? 1 : 0);
  return GROUPS.map(([g, label]) => ({ group: g, label, files: fs2.filter(f => f.group === g).sort((a, b) => order(a) - order(b) || a.rel.localeCompare(b.rel)) })).filter(x => x.files.length);
}
/** the lane's notes folder: its newest run's NOTES folder, else <state>/notes/<lane> */
export function notesDirOf(state, lane, items) {
  const n = laneRuns(lane, items).filter(r => r.data.notes).sort((a, b) => num(b.id) - num(a.id))[0]?.data.notes;
  return path.resolve(n ? (/\.md$/i.test(n) ? path.dirname(n) : n) : path.join(state, 'notes', lane));
}

// ---------- the sections ----------
const headsOf = lines => lines.map((l, i) => { const m = HEAD.exec(l); return m ? { i, level: m[1].length, text: m[2].replace(/[*_`]/g, '').trim() } : null; }).filter(Boolean);
const sectionEnd = (lines, heads, h) => heads.find(x => x.i > h.i && x.level <= h.level)?.i ?? lines.length;
// 'Summary for the owner', 'For the owner, in ten lines', 'Summary for the owner (10 lines)' - never 'Open for the owner'
const SUMMARY = /^(?:summary\s+)?for\s+the\s+owner\b|^summary\s+for\s+the\s+owner\b/i;
/** the Findings card: the LAST 'Summary for the owner' / 'For the owner' section of a NOTES text (the newest run's), verbatim; null = none */
export function ownerSummary(text) {
  const lines = String(text ?? '').split(/\r?\n/), heads = headsOf(lines), h = heads.filter(x => SUMMARY.test(x.text)).at(-1);
  if (!h) return null;
  const body = lines.slice(h.i + 1, sectionEnd(lines, heads, h)).join('\n').replace(/^\s*\n|\s+$/g, '');
  return body ? { heading: h.text, line: h.i + 1, text: body } : null;
}
/** the run's own last summary line: the summary section's last non-empty line, else null */
export const summaryLine = text => ownerSummary(text)?.text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1)?.replace(/^(?:[-*+]|\d+[.)])\s+/, '') ?? null;

// an owner ask, as a heading or as a lead-in line before a list
export const ASK_RE = /open\s+for\s+the\s+owner|decisions?\s+for\s+(?:you|the\s+owner)|\byour\s+rulings?\b|owner\s+rulings?|rulings?\s+for\s+the\s+owner|owner\s+to\s+decide|questions?\s+for\s+the\s+owner/i;
// a heading IS an ask when the phrase leads it ("Open for the owner", "test-governance: owner rulings"), not when it is an aside
// ("Classify (code, then owner rulings)")
const ASK_HEAD = new RegExp(`^(?:[\\w.-]+\\s*[:/]\\s*)?(?:\\d+[.)]\\s*)?(?:${ASK_RE.source})`, 'i');
// rulings already given are no ask: "Owner rulings (binding)" in a brief, "Owner ruling (Q-12)" (runasks.mjs applyRulings writes it)
const RULED = /\bbinding\b|\banswered\b|\bapplied\b|\(Q-[\w-]+\)/i;
const STOPPED = /^STOPPED\b/i, OUTCOME = /^(?:DONE|STOPPED|HANDOFF)\b/i, NOT_QUEUED = /\bnot\s+queued\b/i;
const BRIEF_NAME = /\bbrief-[\w.-]+\.md\b/g;
const QBLOCK = /^\*{0,2}Q\d+[.:)]\*{0,2}\s+(.*)$/;
/** the top-level items of lines[from, end): a list item, or a "Q1. ..." paragraph (QUESTIONS.md) - [{ text, line, subs [text] }]: its
 *  continuation lines joined into text, its nested list items kept apart (they are the ask's alternatives) */
function listItems(lines, from, end) {
  const items = []; let indent = null, cur = null;
  for (let i = from; i < end; i++) {
    const l = lines[i], m = ITEM.exec(l), q = QBLOCK.exec(l);
    if (q) { indent = -1; cur = { text: q[1].trim(), line: i + 1, subs: [] }; items.push(cur); continue; }
    if (m && (indent === null || m[1].length <= indent)) { indent = m[1].length; cur = { text: m[2].trim(), line: i + 1, subs: [] }; items.push(cur); continue; }
    if (!l.trim()) continue;
    if (cur && m) { cur.subs.push(m[2].trim()); continue; }
    if (cur && /^\s/.test(l)) { if (cur.subs.length) cur.subs[cur.subs.length - 1] += ' ' + l.trim(); else cur.text += ' ' + l.trim(); continue; }
    if (HEAD.test(l) || (items.length && indent !== -1)) break;   // prose after a list ends it; between Q blocks it is their body
  }
  return items;
}
const clean = s => String(s).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
// 'Default: X. Alternative: Y.' / '(recommended: X)' / 'I recommend X' - the default and the alternatives an ask names
const DEF_RE = /(?:\bdefault\s*[:=-]\s*|\brecommended\s*[:=-]\s*|\bI\s+recommend\s+)(.+?)(?:(?<!\b(?:e\.g|i\.e|vs|etc))\.(?:\s|$)|\)|$)/i;
const ALT_RE = /\balternatives?\s*[:=-]\s*(.+?)(?:\.(?:\s|$)|$)/gi;
/** an ask's item text -> { title words, default, alts, stage } */
export function askParts(text) {
  const t = clean(text), d = t.match(DEF_RE)?.[1]?.trim() ?? null, alts = [...t.matchAll(ALT_RE)].map(m => m[1].trim()).filter(Boolean);
  const cut = t.search(/\b(?:default|alternatives?)\s*[:=-]/i), head = (cut > 0 ? t.slice(0, cut) : t).replace(/[\s.:;,-]+$/, '');
  const first = head.match(/^(.+?(?<!\b(?:e\.g|i\.e|vs|etc|cf))[?.!])(?:\s|$)/)?.[1] ?? head;
  return { words: first.replace(/[.]$/, ''), default: d ? d.replace(/[\s.]+$/, '') : null, alts, stage: t.match(/\b(S\d+)\b/)?.[1] ?? null };
}
const KEY_RE = [/^\(([A-Za-z0-9]{1,3})\)\s*/, /^option\s+([A-Za-z0-9]{1,3})\s*[:.)-]\s*/i, /^([A-Za-z0-9]{1,2})\)\s+/];
const REC_RE = /\brecommended\b|\(default\)|\bthe default\b/i;
/** an ask's nested alternatives -> [{ key, text, rec }] (a key the text writes - "(a)", "Option B:" - kept, else a, b, c ...) */
export function altsOf(subs) {
  const out = subs.map((t, i) => { const k = KEY_RE.map(r => t.match(r)).find(Boolean), text = clean(k ? t.slice(k[0].length) : t);
    return { key: (k?.[1] ?? String.fromCharCode(97 + i)).toLowerCase(), text, rec: REC_RE.test(text) }; });
  return new Set(out.map(o => o.key)).size === out.length ? out : out.map((o, i) => ({ ...o, key: String.fromCharCode(97 + i) }));
}
const ruling = (section, it) => ({ kind: 'ruling', section, line: it.line, text: clean(it.text), ...askParts(it.text), ...(it.subs?.length ? { options: altsOf(it.subs) } : {}) });
/**
 * ownerAsks(text) -> [{ kind: 'ruling' | 'stopped' | 'not-queued', section, line, text, words?, default?, alts?, stage?, briefs? }]
 * Every ask a NOTES / MERGE-NOTES / plan text makes of the owner: each top-level item of an ask section (or of the list after an ask
 * lead-in line; a section with no list = one ask), the last outcome heading when it is STOPPED, and each 'not queued' line or section
 * with the brief-*.md files it names.
 */
export function ownerAsks(text) {
  const lines = String(text ?? '').split(/\r?\n/), heads = headsOf(lines), out = [], seen = new Set();
  const push = (a) => { const k = `${a.kind}|${a.line}`; if (!seen.has(k)) { seen.add(k); out.push(a); } };
  for (const h of heads) {
    const end = sectionEnd(lines, heads, h);
    if (NOT_QUEUED.test(h.text)) {
      const briefs = [...new Set(lines.slice(h.i, end).join('\n').match(BRIEF_NAME) || [])];
      if (briefs.length) push({ kind: 'not-queued', section: h.text, line: h.i + 1, text: h.text, briefs });
      continue;
    }
    if (OUTCOME.test(h.text) || !ASK_HEAD.test(h.text) || RULED.test(h.text)) continue;   // a STOPPED heading's ask is the outcome's (below)
    const items = listItems(lines, h.i + 1, end);
    if (items.length) for (const it of items) push(ruling(h.text, it));
    else { const body = clean(lines.slice(h.i + 1, end).join(' ')); if (body) push({ kind: 'ruling', section: h.text, line: h.i + 1, text: body, ...askParts(body) }); }
  }
  const outcome = heads.filter(h => OUTCOME.test(h.text)).at(-1);   // a STOPPED a later DONE / HANDOFF heading answered is no ask
  if (outcome && STOPPED.test(outcome.text)) {
    const body = clean(lines.slice(outcome.i + 1, sectionEnd(lines, heads, outcome)).join(' '));
    push({ kind: 'stopped', section: outcome.text, line: outcome.i + 1, text: clean([outcome.text.replace(STOPPED, '').replace(/^[\s:-]+/, ''), body].filter(Boolean).join(' ')) || 'stopped' });
  }
  lines.forEach((l, i) => {   // lead-in lines: 'Owner rulings the briefs wait on (each brief has a default):' then a list; 'Ranked briefs, not queued: `a.md`, `b.md`'
    if (HEAD.test(l)) return;
    const own = l.replace(ITEM, '$2');
    if (NOT_QUEUED.test(own)) { const briefs = [...new Set(own.match(BRIEF_NAME) || [])]; if (briefs.length) push({ kind: 'not-queued', section: clean(own).slice(0, 80), line: i + 1, text: clean(own), briefs }); return; }
    if (ITEM.test(l) || !ASK_RE.test(l) || !/:\s*$/.test(l)) return;
    const h = heads.filter(x => x.i < i).at(-1), end = h ? sectionEnd(lines, heads, h) : lines.length;
    for (const it of listItems(lines, i + 1, end)) push(ruling(clean(l).replace(/:\s*$/, '').slice(0, 120), it));
  });
  return out.sort((a, b) => a.line - b.line);
}

// ---------- the run's end ----------
/** the CLI's "Background tasks still running 10m after the last turn (subagent "A", shell "B"); stopping them." -> ['A', 'B'] | null */
export function cutoffOf(log) {
  const m = String(log ?? '').match(/Background tasks still running[^\n]*?\(([^\n]*?)\)[^\n]*stopping them/i);
  if (!m) return /Background tasks still running[^\n]*stopping them/i.test(String(log ?? '')) ? ['(unnamed)'] : null;
  const names = [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]);
  return names.length ? names : [m[1].trim()];
}

// ---------- what happens next ----------
/**
 * The lane states after its last run ended, in words - ONE vocabulary (the queue side, fair-slots' "awaiting merge", reads the same
 * keys). A bare DONE never shows on its own: a lane whose last run ended always says one of these.
 */
export const NEXT_STATES = {
  input: 'needs your input', approval: 'awaiting your approval', merge: 'awaiting merge', roadmap: 'stages on the roadmap', notqueued: 'not queued',
  shipped: 'shipped', noresult: 'ended without a result', stopped: 'stopped', handoff: 'handed off', closed: 'PR closed', done: 'done',
};
const day = iso => (iso ? String(iso).slice(0, 10) : '?');
/**
 * laneNext({ outcome, asks, prs, stages, notQueued, written, deliverable, shipped, why }) -> { key, words, cls } | null (the last run has not ended).
 *   outcome   the last run's end outcome (done, stopped, handoff, no-result, crash, lost ...)
 *   asks      the lane's open owner questions [{ id, title }]
 *   prs       the lane's PRs, newest first [{ number, state open | approved | merged | closed, merged_at? }]
 *   stages    the plan's stages [{ key, state open | queue | later | drop | launched, ref?, horizon? }]
 *   notQueued brief files a run proposed and nothing queued
 *   written   files the last run wrote in the notes folder (a no-result run's evidence)
 *   deliverable the lane's newest deliverable state (done | merged | installed) when it has no PR yet
 *   shipped   LANE-TRUTH: why the lane's work is on main (dlvmerge.mjs laneShipped) | null - it decides first: a shipped lane never reads
 *             'awaiting your approval' or 'needs your input' (rm26 read 'PR #28 awaiting your approval' long after #28 merged)
 *   why       that deliverable's why_not (dlvwhy.mjs whyNotMerged: the merge queue's skip in words - not pushed, slop BLOCK, conflict and
 *             its MERGE, ...): a done lane waiting to merge says why, never only "no PR yet" (land-push)
 */
export function laneNext({ outcome = null, asks = [], prs = [], stages = [], notQueued = [], written = [], deliverable = null, shipped = null, why = null } = {}) {
  if (!outcome) return null;
  const S = NEXT_STATES, n = (k, s) => `${k} ${s}${k === 1 ? '' : 's'}`;
  if (shipped) return { key: 'shipped', words: prs[0]?.state === 'merged' ? `${S.shipped}: PR #${prs[0].number} merged${prs[0].merged_at ? ` ${day(prs[0].merged_at)}` : ''}` : `${S.shipped}: ${shipped}`, cls: 'ok' };
  if (asks.length) return { key: 'input', words: `${S.input}: ${n(asks.length, 'ruling')}`, cls: 'needs' };
  if (['no-result', 'crash', 'lost', 'killed'].includes(outcome) && written.length) return { key: 'noresult', words: `${S.noresult}: ${n(written.length, 'file')} written; review`, cls: 'warn' };
  const pr = prs[0];
  if (pr?.state === 'approved') return { key: 'merge', words: `${S.merge}: PR #${pr.number} approved`, cls: 'idle' };
  if (pr?.state === 'open') return { key: 'approval', words: `PR #${pr.number} ${S.approval}`, cls: 'needs' };
  if (pr?.state === 'merged') return { key: 'shipped', words: `${S.shipped}: PR #${pr.number} merged ${day(pr.merged_at)}`, cls: 'ok' };
  if (deliverable === 'merged' || deliverable === 'installed') return { key: 'shipped', words: `${S.shipped}: on main`, cls: 'ok' };
  if (deliverable === 'done') return { key: 'merge', words: `${S.merge}: ${why?.text ?? 'no PR yet'}`, cls: why?.warn ? 'warn' : 'idle' };
  const queued = stages.filter(s => s.state === 'queue' || s.state === 'launched'), later = stages.filter(s => s.state === 'later');
  if (later.length) return { key: 'roadmap', words: `${S.roadmap} (${later.map(s => `${s.ref ?? s.key}${s.horizon ? `, horizon ${s.horizon}` : ''}`).join('; ')}), ${queued.length ? `${queued.length} queued` : 'none queued'}`, cls: 'idle' };
  if (notQueued.length) return { key: 'notqueued', words: `${S.notqueued}: ${notQueued.join(', ')}`, cls: 'warn' };
  if (pr?.state === 'closed') return { key: 'closed', words: `${S.closed}: PR #${pr.number} not merged`, cls: 'warn' };
  if (outcome === 'stopped') return { key: 'stopped', words: `${S.stopped}: read its notes`, cls: 'warn' };
  if (outcome === 'handoff') return { key: 'handoff', words: `${S.handoff}: the next run continues`, cls: 'idle' };
  if (outcome !== 'done') return { key: 'noresult', words: `${S.noresult} (${outcome})`, cls: 'bad' };
  return { key: 'done', words: `${S.done}: nothing waits on you`, cls: 'ok' };
}

// ---------- one lane, assembled (the dash's Lanes row and its details) ----------
const endEv = r => (r?.history || []).findLast(h => ['end', 'lost', 'kill'].includes(h.ev)) ?? null;
/** a run's outcome once it ended: its end's outcome (done, stopped, handoff, no-result, crash ...), lost or killed; null = not ended */
export const outcomeOf = r => { const e = endEv(r); return !e ? null : e.ev === 'end' ? r.end?.outcome ?? 'done' : e.ev === 'lost' ? 'lost' : 'killed'; };
/** the lane's newest run (helpers aside) */
export const lastRun = (lane, items) => laneRuns(lane, items).sort((a, b) => num(b.id) - num(a.id))[0] ?? null;
/** the owner questions on the lane, newest first: [{ id, title, state, open, ask (posted from the notes), origin, answer { choice, text, by, at } }] */
export function laneAsks(items, lane) {
  return Object.values(items).filter(q => q.kind === 'question' && q.data?.lane === lane).sort((a, b) => num(b.id) - num(a.id)).map(q => {
    const a = (q.history || []).findLast(h => h.ev === 'answer'), o = a && (q.data.options || []).find(x => x.key === a.data?.choice);
    return { id: q.id, title: q.data.title, state: q.state, open: q.state === 'open', ask: !!q.data.ask, origin: q.data.origin ?? null, brief: q.data.brief ?? null,
      ...(a ? { answer: { choice: a.data?.choice ?? null, text: o?.text ?? a.data?.text ?? null, by: a.by, at: a.ts } } : {}) };
  });
}
/** every PR of the lane's deliverables, newest first (deliverables rows' prs): [{ number, url, state, merged_at, dlv, branch }] */
export function lanePrs(rows, lane) {
  return rows.filter(r => r.lane === lane).flatMap(r => (r.prs ?? []).map(x => ({ ...x, dlv: r.id, branch: r.branch })))
    .sort((a, b) => (b.number ?? 0) - (a.number ?? 0));
}
/** where a proposed stage is now: waiting for the pick, queued / building / built as RUN-n, merged, on the roadmap as RM-n (horizon), dropped */
export function stageWhere(s, { items = {}, R = { items: {} }, rows = [] } = {}) {
  if (s.state === 'open') return { ...s, where: 'waiting for your pick' };
  if (s.state === 'drop') return { ...s, where: 'dropped' };
  if (s.state === 'later') { const it = R.items?.[s.ref]; return { ...s, horizon: it?.horizon ?? null, where: `on the roadmap as ${s.ref ?? '?'}${it?.horizon ? `, horizon ${it.horizon}` : ''}` }; }
  const r = items[s.ref];
  if (!r) return { ...s, where: `queued as ${s.ref ?? '?'}` };
  const o = outcomeOf(r), lane = r.data?.lane, merged = o === 'done' && rows.some(d => d.lane === lane && d.state !== 'done' && d.run && num(d.run) >= num(r.id));
  return { ...s, where: r.state === 'queued' ? `queued as ${r.id}` : r.state === 'running' ? `building (${r.id})` : merged ? `merged (${r.id})` : o === 'done' ? `built (${r.id})` : `${r.id} ended ${o}` };
}
/** the plan's decision: the 'Decide: <lane> plan' card's stages with who picked each and when (the decision records) and where each is now */
export function lanePlan(prop, { items = {}, R = { items: {} }, rows = [] } = {}) {
  if (!prop) return null;
  return { run: prop.run, title: `Decide: ${prop.lane} plan`, item: prop.item ?? null, plans: prop.plans || [], open: prop.open,
    stages: prop.stages.map(s => { const d = s.dec ? items[s.dec] : null; return { ...stageWhere(s, { items, R, rows }), ...(d ? { by: d.by, at: d.created } : {}) }; }) };
}
/**
 * laneNow({ lane, items, R, rows, prop, written, notes, shipped }) -> { next, status_line, asks_open, cutoff, not_queued }: the Lanes row's
 * state after its last run (laneNext) and the run's own last summary line (its `norn done` summary, else NOTES.md's summary section)
 */
export function laneNow({ lane, items = {}, R = { items: {} }, rows = [], prop = null, written = [], notes = null, shipped = null }) {
  const r = lastRun(lane, items), outcome = outcomeOf(r), asks = laneAsks(items, lane), open = asks.filter(a => a.open);
  const notQueued = [...new Set(Object.values(items).filter(q => q.kind === 'question' && q.data?.lane === lane && q.data.ask?.kind === 'not-queued' && q.state === 'open').flatMap(q => q.data.ask.briefs || []))];
  const plan = lanePlan(prop, { items, R, rows }), dl = rows.filter(d => d.lane === lane).sort((a, b) => num(b.id) - num(a.id))[0];
  const next = laneNext({ outcome, asks: open, prs: lanePrs(rows, lane), stages: plan?.stages ?? [], notQueued, written, deliverable: isLanded(dl) && dl.state === 'done' ? 'merged' : dl?.state ?? null, shipped, why: dl?.why_not ?? null });
  return { next, status_line: outcome ? r.end?.summary ?? summaryLine(notes) : null, asks_open: open.length, cutoff: r?.end?.cutoff ?? null, not_queued: notQueued };
}
