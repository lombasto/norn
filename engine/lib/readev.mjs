// META-TEND P5 (REPORT 3.2 check 20, s.5.4): read evidence - which steering files (memory, docs, rules, skills) the agents actually
// opened, from the transcripts of the project's runs + chat sessions (Read file_path with its offset / limit, a Skill call, a shell
// command naming the file), and which a decision cited (its text names the file, maybe its line). An on-demand file never read in
// the window and never cited = a prune candidate: an advisory only, never an automatic delete. Reads only. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import { advisory } from './advisory.mjs';
import { runTranscript } from './standing.mjs';
import { findTranscript } from './harness/claude.mjs';
import { threadFile } from './chatact.mjs';

export const READ_DAYS = 30;
const DAY = 86400000;
const fwd = p => String(p ?? '').replace(/\\/g, '/');
const lc = p => fwd(p).toLowerCase();
const GENERIC = new Set(['claude.md', 'agents.md', 'memory.md', 'readme.md', 'skill.md', 'claude.local.md', 'notes.md']);
const scanCache = new Map();   // transcript -> { size, offset, e: [[ts, kind, value, offset?, limit?]] } (only appended bytes are read again)

/** the read events of one transcript (and its subagents): [ts, 'read', path, offset, limit] | [ts, 'skill', name] | [ts, 'cmd', text] */
export function transcriptReads(file, cache = scanCache) {
  let st; try { st = fs.statSync(file); } catch { return []; }
  let c = cache.get(file);
  if (!c || st.size < c.size) c = { size: 0, offset: 0, e: [] };
  if (st.size > c.offset) {
    const buf = Buffer.alloc(st.size - c.offset), fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, c.offset); } finally { fs.closeSync(fd); }
    const text = buf.toString('utf8'), end = text.lastIndexOf('\n');
    if (end >= 0) {
      for (const l of text.slice(0, end).split('\n')) {
        if (!l.includes('"tool_use"') || !(l.includes('"file_path"') || l.includes('"Skill"') || /\.(?:md|txt)\b/i.test(l))) continue;   // the cheap filter first
        let j; try { j = JSON.parse(l); } catch { continue; }
        const ts = j.timestamp;
        for (const b of Array.isArray(j.message?.content) ? j.message.content : []) {
          if (b?.type !== 'tool_use') continue;
          const i = b.input || {};
          if (b.name === 'Read' && i.file_path) c.e.push([ts, 'read', fwd(i.file_path), Number.isFinite(i.offset) ? i.offset : null, Number.isFinite(i.limit) ? i.limit : null]);
          else if (b.name === 'Skill' && i.skill) c.e.push([ts, 'skill', String(i.skill)]);
          else if ((b.name === 'Bash' || b.name === 'PowerShell') && /\.(?:md|txt)\b/i.test(String(i.command ?? ''))) c.e.push([ts, 'cmd', String(i.command).slice(0, 2000)]);
        }
      }
      c.offset += Buffer.byteLength(text.slice(0, end + 1));
    }
    c.size = st.size;
    cache.set(file, c);
  }
  let subs = [];
  const dir = path.join(file.replace(/\.jsonl$/, ''), 'subagents');
  try { subs = fs.readdirSync(dir).filter(n => /^agent-.+\.jsonl$/.test(n)); } catch { /* no subagents folder: the session spawned none, its own reads stand alone */ }
  return subs.length ? [...c.e, ...subs.flatMap(n => transcriptReads(path.join(dir, n), cache))] : c.e;
}

/** the transcripts of project p's sessions in the window: its runs (claude family) + the chat's segments */
export function sessionTranscripts(state, items, { projectsDir, now = Date.now(), days = READ_DAYS } = {}) {
  const since = now - days * DAY, out = new Set();
  for (const it of Object.values(items)) {
    if (it.kind !== 'run' || it.history?.[0]?.ev !== 'start' || !(Date.parse(it.updated ?? it.created) >= since)) continue;
    if (it.data?.executor && /codex|grok|astra|sol/.test(it.data.executor)) continue;
    const f = runTranscript(it, { projectsDir });
    if (f) out.add(f);
  }
  let lines = [];
  try { lines = fs.readFileSync(threadFile(state), 'utf8').split('\n'); } catch { /* no chat */ }
  for (const l of lines) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j?.kind !== 'segment' || !j.session_id || !(Date.parse(j.ts) >= since)) continue;
    const f = findTranscript(projectsDir, j.session_id);
    if (f) out.add(f);
  }
  return [...out];
}

const relOf = (r, p) => { for (const d of [p.root, p.project_dir].filter(Boolean)) { const D = lc(d).replace(/\/+$/, '') + '/'; if (lc(r.path).startsWith(D)) return lc(r.path).slice(D.length); } return null; };
const skillOf = r => fwd(r.path).match(/\/skills\/([^/]+)\/SKILL\.md$/i)?.[1]?.toLowerCase() ?? null;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * rows (instructions.mjs discover) -> { window_days, transcripts, files: { [row id]: { reads, last, ranges [[from, to] | null = whole], cites [{ id, line }] } }, advisories }
 * o: { items (records fold), files (transcript paths; else found from the runs), projectsDir, now, days }
 */
export function readEvidence(rows, p, { items = {}, files = null, projectsDir = null, now = Date.now(), days = READ_DAYS, cache = scanCache } = {}) {
  const since = now - days * DAY, ts = files ?? sessionTranscripts(p.state, items, { projectsDir, now, days });
  let first = null;   // the oldest read the transcripts hold: the span the evidence really covers (the records may be younger than the window)
  const base = r => path.posix.basename(lc(r.path)), count = new Map();
  for (const r of rows) count.set(base(r), (count.get(base(r)) || 0) + 1);
  const needles = rows.map(r => { const rel = relOf(r, p), b = base(r); return [rel, ...(!GENERIC.has(b) && count.get(b) === 1 ? [b] : [])].filter(Boolean); });
  const byPath = new Map(rows.map((r, i) => [lc(r.path), i])), bySkill = new Map(rows.map((r, i) => [skillOf(r), i]).filter(([k]) => k));
  const ev = rows.map(() => ({ reads: 0, last: null, ranges: [], cites: [] }));
  const hit = (i, t, range) => { const e = ev[i]; e.reads++; if (!e.last || t > e.last) e.last = t; if (e.ranges.length < 200) e.ranges.push(range); };
  for (const f of ts) for (const [t, kind, v, off, lim] of transcriptReads(f, cache)) {
    if (!(Date.parse(t) >= since && Date.parse(t) <= now)) continue;
    if (!first || t < first) first = t;
    if (kind === 'read') { const i = byPath.get(lc(v)); if (i !== undefined) hit(i, t, off || lim ? [off || 1, lim ? (off || 1) + lim - 1 : Infinity] : null); }
    else if (kind === 'skill') { const i = bySkill.get(v.toLowerCase().split(':').pop()); if (i !== undefined) hit(i, t, null); }
    else { const s = lc(v); rows.forEach((r, i) => { if (s.includes(lc(r.path)) || needles[i].some(n => n.includes('/') && s.includes(n))) hit(i, t, null); }); }
  }
  for (const d of Object.values(items).filter(i => i.kind === 'decision' && Date.parse(i.created) >= since)) {
    const text = lc([d.data?.question, d.data?.choice, d.data?.why, d.data?.text].filter(Boolean).join(' \n '));
    rows.forEach((r, i) => {
      for (const n of needles[i]) {
        if (!text.includes(n)) continue;
        const m = text.match(new RegExp(`${esc(n)}(?::|,?\\s+l\\.?\\s*|\\s+lines?\\s+)(\\d+)`));
        ev[i].cites.push({ id: d.id, line: m ? Number(m[1]) : null });
        break;
      }
    });
  }
  const advisories = [], span = first ? Math.max(1, Math.ceil((now - Date.parse(first)) / DAY)) : 0;
  if (ts.length) for (const [i, r] of rows.entries()) {
    if (!r.exists || r.generated || !['on-demand'].includes(r.load) || ev[i].reads || ev[i].cites.length) continue;
    advisories.push(advisory({ phase: 'P5', check: 20, key: 'never-read', severity: 'low', surface: r.kind === 'memory-topic' ? 'memory topic' : r.kind === 'skill' ? 'skill' : 'on-demand file', path: fwd(r.path), row: r.id,
      why: `never read in ${span < days ? `the ${span} days the transcripts cover` : `${days} days`} (${ts.length} session transcripts) and never cited by a decision: a prune candidate`, source: 'REPORT meta-practice s.3.2 check 20 (read evidence)',
      fix: { tier: 'card', action: 'prune it, or fold what is still true into the file that points at it - an advisory: Norn deletes nothing', kind: 'call', ways: ['Prune it', 'Fold it into the file that points at it'] } }));
  }
  return { window_days: days, covered_days: Math.min(span, days), transcripts: ts.length, files: Object.fromEntries(rows.map((r, i) => [r.id, ev[i]])), advisories };
}
/** a paragraph's marks from its file's evidence: read (a whole-file read, or a range over its lines), cited (a cite on its lines; a file-level cite marks none) */
export function paraMarks(par, e) {
  if (!e) return { read: 0, cited: [] };
  const read = e.ranges.filter(x => x === null || (x[0] <= par.end && x[1] >= par.line)).length;
  return { read, cited: e.cites.filter(c => c.line && c.line >= par.line && c.line <= par.end).map(c => c.id) };
}
