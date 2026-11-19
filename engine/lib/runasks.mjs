// lane-outputs items 7, 9, 10a: every ruling a finished run's notes ask of the owner reaches the Inbox by code, whatever the run's exit
// (DONE, STOPPED, HANDOFF, no-result, crash, lost). The supervisor calls postRunAsks at its run's end; the tick's sweepAsks covers the
// runs no supervisor ended (lost, killed) and any end the supervisor's post missed. Each ask (laneout.mjs ownerAsks) becomes ONE
// question on the lane - the default the notes name as the recommended option, the notes file + section + line as its origin - and
// an ask already posted (same lane + same title, any state) is skipped. applyRulings writes an answered ruling into the stage brief
// that needs it (brief-S<n>.md beside the notes), once (its Q id marks it). `norn asks scan` posts a lane's asks by hand.
import fs from 'node:fs';
import path from 'node:path';
import { loadState, record, RecordError } from './records.mjs';
import { ownerAsks, laneRuns } from './laneout.mjs';

const fwd = p => String(p ?? '').replace(/\\/g, '/');
const mtimeOf = f => { try { return fs.statSync(f).mtimeMs; } catch { return null; } };
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const listMd = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && /\.(?:md|markdown)$/i.test(e.name)).map(e => e.name); } catch { return []; } };
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '~' : s);
const endEv = r => (r.history || []).findLast(h => ['end', 'lost', 'kill'].includes(h.ev)) ?? null;
/** a run whose notes may ask the owner something: a lane's worker / audit / merge run (a check-in or a helper never) */
export const asksOf = r => r?.kind === 'run' && !!r.data?.lane && r.data.role !== 'helper' && r.data.kind !== 'checkin';

/** the brief files a run proposed that nothing launched: brief-*.md in its folder that no run took and no lane is named after */
export function unqueued(briefs, dir, items) {
  const runs = Object.values(items).filter(i => i.kind === 'run' && i.data?.brief), lanes = new Set(Object.values(items).filter(i => i.kind === 'lane').map(l => l.id.replace(/^L:(?:[^/]+\/)?/, '')));
  return briefs.filter(b => fs.existsSync(path.join(dir, b)) && !lanes.has(b.replace(/^brief-|\.md$/gi, '')) && !runs.some(r => path.basename(String(r.data.brief)).toLowerCase() === b.toLowerCase()));
}

/**
 * questionsFor(run, items, { files }) -> the question create data of every ask in the run's notes folder's Markdown files that the run
 * wrote (changed since its start; NOTES / MERGE-NOTES always). files = { name: text } (tests), else read from the folder.
 */
export function questionsFor(r, items, { dir = null, files = null } = {}) {
  const lane = r.data.lane, d = dir ?? (r.data.notes ? path.dirname(r.data.notes) : null);
  if (!d) return [];
  const since = Date.parse(r.created ?? '') - 60e3;
  const texts = files ?? Object.fromEntries(listMd(d).filter(n => /^(?:MERGE-)?NOTES/i.test(n) || !(mtimeOf(path.join(d, n)) < since)).map(n => [n, read(path.join(d, n))]).filter(([, t]) => t !== null));
  const outcome = endEv(r)?.ev === 'end' ? r.end?.outcome ?? 'ended' : endEv(r)?.ev ?? 'ended', out = [];
  for (const [name, text] of Object.entries(texts)) {
    const file = fwd(path.join(d, name));
    for (const a of ownerAsks(text)) {
      const at = `${name}#${a.section} (line ${a.line})`, origin = { file, section: cut(a.section, 200), line: a.line };
      const body = `${a.text}\n\nAsked in ${at}, written by ${r.id} (${outcome}).`;
      if (a.kind === 'not-queued') {
        const left = unqueued(a.briefs, d, items);
        if (!left.length) continue;
        out.push({ title: cut(`${lane}: queue which of the briefs it proposed? (not queued)`, 120), lane, body, origin, source: `${r.id} ${name}:${a.line}`, blocks: [], ask: { run: r.id, kind: a.kind, briefs: left },
          options: [...left.map((b, i) => ({ key: `q${i + 1}`, text: `Queue ${b}${i === 0 ? ' (ranked first)' : ''}` })), { key: 'none', text: 'Queue none of them now' }],
          recommend: { key: 'q1', why: 'the notes rank the briefs; the first is first', from: 'source' } });
        continue;
      }
      if (a.kind === 'stopped') {
        out.push({ title: cut(`${lane}: stopped - ${a.text}`, 120), lane, body, origin, source: `${r.id} ${name}:${a.line}`, blocks: [], ask: { run: r.id, kind: a.kind },
          options: [{ key: 'resume', text: 'Resume the lane: a run continues from its notes with your ruling' }, { key: 'accept', text: 'Accept where it stopped: nothing more on this lane' }] });
        continue;
      }
      const stageBrief = /^brief-/i.test(name) ? file : a.stage && fs.existsSync(path.join(d, `brief-${a.stage}.md`)) ? fwd(path.join(d, `brief-${a.stage}.md`)) : null;
      const opts = a.options?.length ? a.options : a.default ? [{ key: 'default', text: a.default, rec: true }, ...a.alts.map((t, i) => ({ key: `alt${i + 1}`, text: t }))] : [];
      const rec = opts.find(o => o.rec);
      out.push({ title: cut(`${lane}: ${a.words}`, 120), lane, body, origin, source: `${r.id} ${name}:${a.line}`, blocks: [], ask: { run: r.id, kind: a.kind },
        options: opts.map(o => ({ key: o.key, text: cut(o.text, 600) })), ...(rec ? { recommend: { key: rec.key, why: 'the default the notes name', from: 'source' } } : {}),
        ...(stageBrief ? { brief: stageBrief } : {}) });
    }
  }
  return out;
}

// the words of a title, for "already asked": a hand-posted "Ruling 1 (UI S1): where does the Landed list live?" holds most of the
// ask's words ("S1: where the landed list lives") in other order
const words = s => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 2 && !/^\d$/.test(w)).map(w => w.replace(/(?<=..)s$/, '')));
/** has the lane asked this already? the same title, or a title holding 60 % of the ask's words */
export function askedAlready(titles, title, lane) {
  const w = words(String(title).slice(lane.length + 1));
  return titles.some(t => { if (t === title) return true; const h = words(t); return w.size >= 3 && [...w].filter(x => h.has(x)).length / w.size >= 0.6; });
}
/** post the asks of run `id` (one question each; an ask the lane already asked is skipped) -> [{ id, title }] */
export function postRunAsks(state, id, { by = 'launcher', views = {}, dry = false, files = null, dir = null } = {}) {
  const items = loadState(state).items, r = items[id];
  if (!asksOf(r)) return [];
  const asked = Object.values(items).filter(q => q.kind === 'question' && q.data?.lane === r.data.lane).map(q => q.data.title);
  const out = [];
  for (const data of questionsFor(r, items, { files, dir })) {
    if (askedAlready(asked, data.title, r.data.lane)) continue;
    asked.push(data.title);
    if (dry) { out.push({ id: null, title: data.title }); continue; }
    try { const e = record(state, { kind: 'question', ev: 'create', by, data }, { views }); out.push({ id: e.id, title: data.title }); }
    catch (e) { if (!(e instanceof RecordError)) throw e; out.push({ id: null, title: data.title, refused: e.message }); }
  }
  return out;
}

// the sweep's mark: the first sweep starts the clock (runs that ended before this module existed are posted by `norn asks scan`, not
// all at once), then each ended run is read once
const sweptFile = state => path.join(state, 'asks', 'swept.json');
/** the tick: every lane run that ended since the mark and was not swept yet -> postRunAsks; returns [{ run, posted }] */
export function sweepAsks(state, { now = Date.now(), views = {} } = {}) {
  const f = sweptFile(state);
  let m = null; try { m = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { m = null; }
  const save = v => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); };
  if (!m?.since) { save({ since: new Date(Math.floor(now / 1000) * 1000).toISOString(), done: [] }); return []; }   // records keep whole seconds
  const since = Date.parse(m.since), done = new Set(m.done || []), out = [];
  const ended = Object.values(loadState(state).items).filter(r => asksOf(r) && !done.has(r.id)).map(r => [r, endEv(r)]).filter(([, e]) => e && Date.parse(e.ts) >= since);
  for (const [r] of ended) { const posted = postRunAsks(state, r.id, { by: 'checkin', views }); done.add(r.id); if (posted.length) out.push({ run: r.id, posted }); }
  if (ended.length) save({ since: m.since, done: [...done] });
  return out;
}

/** the ruling of an answered question in words: the chosen option's text, else the owner's text */
const rulingText = q => { const a = q.answer ?? {}, o = (q.data.options || []).find(x => x.key === a.choice); return o ? `(${o.key}) ${o.text}` : a.text ?? a.choice ?? '?'; };
/** an answered ask that names a stage brief: its ruling appended to the brief once ("Owner ruling (Q-n)") -> [{ q, brief }] */
export function applyRulings(state) {
  const out = [];
  for (const q of Object.values(loadState(state).items).filter(i => i.kind === 'question' && i.data?.ask && i.data.brief && ['answered', 'applied'].includes(i.state))) {
    const t = read(q.data.brief);
    if (t === null || t.includes(`Owner ruling (${q.id})`)) continue;
    const who = q.history?.findLast(h => h.ev === 'answer');
    fs.appendFileSync(q.data.brief, `${t.endsWith('\n') ? '' : '\n'}\n## Owner ruling (${q.id})\n${q.data.title}\n\n${rulingText(q)}\n\n(answered ${who?.ts ?? '?'} by ${who?.by ?? '?'}; this overrides the default above)\n`);
    out.push({ q: q.id, brief: q.data.brief });
  }
  return out;
}

/** `norn asks scan`: the asks of a lane's runs (newest first) or of one run -> [{ run, posted }] */
export function scanAsks(state, { lane = null, run = null, dry = false, by = 'checkin' } = {}) {
  const items = loadState(state).items, rs = run ? [items[run]].filter(Boolean) : laneRuns(lane, items).filter(r => endEv(r));
  return rs.map(r => ({ run: r.id, posted: postRunAsks(state, r.id, { by, dry }) })).filter(x => x.posted.length);
}
