// RM-a-58 decision-links: a DERIVED index tying each in-force decision (DEC) and active directive (DIR) to the repo paths it governs.
// Records stay append-only: nothing here writes one. A record's links come from ONE source, the first that yields a path:
//   stated   - the paths given when it was recorded (`norn rec add decision|directive --paths a,b`)        measured (the recorder said so)
//   runs     - the files the runs it names (--on-runs) changed: first-parent commits on the run's head in its start..end window   inferred
//   landings - the files its lane's landings changed on main (a DIR: its scope lanes), within LINKS.landing_before_h before to
//              LINKS.landing_after_h after the record; a landing = a first-parent merge on main whose subject names norn/[<home>/]<lane>   inferred
// A source that cannot be read says why in `na` (a run not on this machine, a head git no longer has) - never a guess.
// Stale: only a link whose source is in LINKS.stale_sources (stated, runs - the two measured or near it: S1 measured 2 of 2 runs links
// right, 7 of 18 landings links) is ever marked stale; a landings link pulls in its lane's hot files, so it stays a link (`norn code why`
// prints it as inferred) but never makes a record stale nor a digest row. A link is stale when a governed path changed on main
// (first-parent, diffed against the first parent) after the record, by a commit that is not one of its own sources (the named runs'
// commits and their landing merge; its lane's landings in the window - the lane carrying the ruling out is not undoing it).
// <state>/code/declinks.json holds the index with the main sha and stale_sources it was built at; `norn code links`
// (and the tick, when main or the records moved) refreshes it, `norn code why <file>` answers from it, the digest reads it only.
// Thresholds: LINKS below (the ONE place) - landing window -48 h / +168 h, why cap 10, digest cap 10, stale sources stated + runs;
// the digest window is the digest's own WINDOW_H, passed in.
import fs from 'node:fs';
import path from 'node:path';
import { loadState } from './records.mjs';
import { makeGit } from './dlvgit.mjs';
import { atomicWrite } from './policy.mjs';

export const LINKS = { landing_before_h: 48, landing_after_h: 168, why_cap: 10, digest_cap: 10, stale_sources: ['stated', 'runs'] };
export const LINKS_FILE = 'declinks.json';
const H = 3600e3, SHA = 12, short = s => s.slice(0, SHA);
const fileOf = state => path.join(state, 'code', LINKS_FILE);
/** a path as the index keys it: forward slashes, no leading ./ */
export const normPath = p => String(p).trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '');
/** RM-a-58 decision-paths: the repo paths a ruling's text names, in text order - a token counts only when it IS a tracked file (`files`
 *  = git ls-files at HEAD) or a folder holding one (it has a /); never a guess from the look of a word (x.md, a/b, n/a are none) */
export function namedPaths(text, files) {
  const set = new Set(files), dirs = new Set(files.flatMap(f => f.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/')))), got = [];
  for (const raw of String(text ?? '').split(/[^A-Za-z0-9_./\\-]+/)) {
    const p = normPath(raw).replace(/[./]+$/, '');   // a sentence's full stop, a folder's trailing /
    if (p && !got.includes(p) && (set.has(p) || (p.includes('/') && dirs.has(p)))) got.push(p);
  }
  return got;
}
/** `norn rec add decision|directive`: the one warning line when its text names tracked repo paths and it states none (no --paths; a
 *  decision: no --on-runs either, whose runs' files link it), else null. Read-only and advisory: a repo git cannot list = no line */
export function pathsWarning(id, data, repo, git = makeGit()) {
  if (data.paths?.length || data.on_runs?.length) return null;
  const text = [data.question, data.choice, data.why, data.text].filter(Boolean).join('\n');
  const out = repo && git(repo, ['ls-files', '-z'], { allowFail: true }), got = out ? namedPaths(text, out.split('\0').filter(Boolean)) : [];
  return got.length ? `warning: ${id} names repo paths ${got.join(', ')} but states none: if it governs them, record it with --paths ${got.join(',')} (a process ruling takes none)` : null;
}
const LANDING_RE = /\bnorn\/(?:[a-z][a-z0-9]{0,15}\/)?([A-Za-z0-9][A-Za-z0-9_.-]*)'?\s*$/;
const laneOf = l => String(l ?? '').replace(/^L:/, '').split('/').pop();
const governs = i => (i.kind === 'decision' && i.state === 'in-force') || (i.kind === 'directive' && i.state === 'active');
const titleOf = i => (i.kind === 'decision' ? `${i.data.question} -> ${i.data.choice}` : String(i.data.text)).replace(/\s+/g, ' ').slice(0, 160);
// the records' half of the freshness key: which rulings govern, and when any last moved
const sigOf = items => { const g = items.filter(i => i.kind === 'decision' || i.kind === 'directive'); return `${g.filter(governs).length}/${g.length}|${g.reduce((m, i) => (i.updated > m ? i.updated : m), '')}`; };

// main's first-parent history, oldest first: [{ sha, t (ms), subject, files }]; merges diffed against their first parent
function mainLog(git, repo, main) {
  const out = git(repo, ['log', '--first-parent', '--diff-merges=first-parent', '--name-only', '--reverse', '--format=%x01%H %ct %s', main]), rows = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('\x01')) { const [sha, ct, ...s] = line.slice(1).split(' '); rows.push({ sha, t: Number(ct) * 1000, subject: s.join(' '), files: [] }); }
    else if (line.trim() && rows.length) rows.at(-1).files.push(normPath(line));
  }
  for (const r of rows) r.lane = r.subject.match(LANDING_RE)?.[1] ?? null;
  return rows;
}

// a named run: its first-parent, non-merge commits on its head inside its start..end window, and the main commit that landed the head
function runFiles(git, repo, main, run, mainShas) {
  if (!run || run.kind !== 'run') return { na: 'no such run on this machine' };
  const end = run.history.find(h => h.ev === 'end'), head = end?.data?.head;
  if (!head) return { na: 'no recorded head (the run has no end with a head)' };
  const s = Math.floor(Date.parse(run.created) / 1000), e = Math.ceil(Date.parse(end.ts) / 1000);
  const out = git(repo, ['log', '--first-parent', '--no-merges', `--since=@${s}`, `--until=@${e}`, '--name-only', '--format=%x01%H', head], { allowFail: true });
  if (out === null) return { na: `head ${short(head)} is not in this repo` };
  const shas = [], files = new Set();
  for (const line of out.split('\n')) { if (line.startsWith('\x01')) shas.push(line.slice(1)); else if (line.trim()) files.add(normPath(line)); }
  if (!mainShas.has(head)) { const l = git(repo, ['rev-list', '--first-parent', '--ancestry-path', `${head}..${main}`], { allowFail: true })?.trim().split('\n').filter(Boolean).at(-1); if (l) shas.push(l); }
  return files.size ? { files: [...files], shas } : { na: `no commits in its ${run.created}..${end.ts} window`, shas };
}

/** { state, repo, main = 'main', now, git } -> the index { at, main, sha, sig, window, records: [{ id, kind, title, created, lanes, na, links, stale_at }] } */
export function buildLinks({ state, repo, main = 'main', now = Date.now(), git = makeGit() }) {
  const items = loadState(state).items, all = Object.values(items), log = mainLog(git, repo, main), mainShas = new Set(log.map(c => c.sha));
  const landings = (lanes, t) => log.filter(c => c.lane && lanes.includes(c.lane) && c.t >= t - LINKS.landing_before_h * H && c.t <= t + LINKS.landing_after_h * H);
  const records = all.filter(governs).sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id)).map(i => {
    const t = Date.parse(i.created), lanes = (i.kind === 'decision' ? [i.data.lane] : i.data.scope || []).map(laneOf).filter(Boolean), na = [];
    const own = landings(lanes, t), exclude = new Set(own.map(c => c.sha));
    let source = null, paths = [], from = [];
    if (Array.isArray(i.data.paths) && i.data.paths.length) { source = 'stated'; paths = i.data.paths.map(normPath); }
    if (!source && (i.data.on_runs || []).length) {
      const got = new Set(), used = [];
      for (const id of i.data.on_runs) { const r = runFiles(git, repo, main, items[id], mainShas); for (const s of r.shas || []) exclude.add(s); if (r.na) na.push(`${id}: ${r.na}`); else { r.files.forEach(f => got.add(f)); used.push(id); } }
      if (got.size) { source = 'runs'; paths = [...got]; from = used; }
    }
    if (!source) {
      const got = new Set(own.flatMap(c => c.files));
      if (got.size) { source = 'landings'; paths = [...got]; from = own.map(c => short(c.sha)); }
      else na.push(lanes.length ? `lane ${lanes.join(', ')}: no landing on ${main} from -${LINKS.landing_before_h} h to +${LINKS.landing_after_h} h` : 'no lane to follow');
    }
    const links = [...new Set(paths)].sort().map(p => {
      const c = LINKS.stale_sources.includes(source) ? log.find(x => x.t > t && !exclude.has(x.sha) && x.files.includes(p)) : null;
      return { path: p, source, inferred: source !== 'stated', from, stale: c ? { sha: short(c.sha), at: new Date(c.t).toISOString().replace('.000Z', 'Z') } : null };
    });
    const st = links.map(l => l.stale?.at).filter(Boolean).sort()[0] ?? null;
    return { id: i.id, kind: i.kind, title: titleOf(i), created: i.created, lanes, na, links, stale_at: st };
  });
  return { at: new Date(now).toISOString(), main, sha: log.length ? short(log.at(-1).sha) : null, sig: sigOf(all), stale_sources: LINKS.stale_sources, window: { before_h: LINKS.landing_before_h, after_h: LINKS.landing_after_h }, records };
}

export const readLinks = state => { try { return JSON.parse(fs.readFileSync(fileOf(state), 'utf8')); } catch { return null; } };
/** is the stored index at main's tip, the records' current state and today's LINKS.stale_sources? -> { fresh, head, governing } (head null: no git / no main; governing = rulings to link) */
export function linksFresh({ state, repo, main = 'main', git = makeGit() }) {
  const head = git(repo, ['rev-parse', main], { allowFail: true })?.trim() ?? null, ix = readLinks(state), items = Object.values(loadState(state).items);
  return { fresh: Boolean(ix && head && ix.sha === short(head) && ix.sig === sigOf(items) && String(ix.stale_sources) === String(LINKS.stale_sources)), head, governing: items.filter(governs).length };
}
/** rebuild <state>/code/declinks.json when main or the records moved -> { built, ix, file } */
export function refreshLinks(o) {
  const git = o.git || makeGit(), f = fileOf(o.state);
  if (linksFresh({ ...o, git }).fresh) return { built: false, ix: readLinks(o.state), file: f };
  const ix = buildLinks({ ...o, git });
  fs.mkdirSync(path.dirname(f), { recursive: true }); atomicWrite(f, JSON.stringify(ix));
  return { built: true, ix, file: f };
}

/** the records governing one file, newest first, capped -> { file, sha, matched, rows: [{ id, kind, title, created, age_d, source, inferred, from, stale, status }] }
 *  status: 'inferred' (a source outside LINKS.stale_sources: never marked stale), else 'stale' / 'current' */
export function whyOf(ix, file, now = Date.now(), { cap = LINKS.why_cap } = {}) {
  const p = normPath(file), hit = ix.records.flatMap(r => r.links.filter(l => l.path === p).map(l => ({ id: r.id, kind: r.kind, title: r.title, created: r.created,
    age_d: +((now - Date.parse(r.created)) / (24 * H)).toFixed(1), source: l.source, inferred: l.inferred, from: l.from, stale: l.stale,
    status: LINKS.stale_sources.includes(l.source) ? (l.stale ? 'stale' : 'current') : 'inferred' })))
    .sort((a, b) => b.created.localeCompare(a.created) || b.id.localeCompare(a.id));
  return { file: p, sha: ix.sha, main: ix.main, matched: hit.length, rows: hit.slice(0, cap) };
}

/** the digest's rows: decisions whose first stale change (stale_sources links only: buildLinks marks no other) is inside the window, newest first, capped (level-triggered: they leave with the window) */
export function staleRows(ix, now = Date.now(), { window_h, cap = LINKS.digest_cap }) {
  return ix.records.filter(r => r.kind === 'decision' && r.stale_at && now - Date.parse(r.stale_at) <= window_h * H && Date.parse(r.stale_at) <= now)
    .sort((a, b) => b.stale_at.localeCompare(a.stale_at) || b.id.localeCompare(a.id)).slice(0, cap).map(r => {
      const l = r.links.filter(x => x.stale?.at === r.stale_at)[0];
      return { id: r.id, title: r.title, lane: r.lanes[0] ?? null, stale_at: r.stale_at, age_h: +((now - Date.parse(r.stale_at)) / H).toFixed(1), path: l.path, sha: l.stale.sha };
    });
}

/** coverage: how many records got at least one path, by source */
export function linksSummary(ix) {
  const by = { stated: 0, runs: 0, landings: 0 };
  for (const r of ix.records) if (r.links.length) by[r.links[0].source]++;
  const linked = by.stated + by.runs + by.landings;
  return { records: ix.records.length, linked, by_source: by, unlinked: ix.records.length - linked, links: ix.records.reduce((n, r) => n + r.links.length, 0) };
}
