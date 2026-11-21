// META-CIWATCH: the project's CI on main, read through gh (project.json `ci: {repo, workflow?, branch?}`, the WASTE-CI-SIGNAL key).
// One cache file per state dir (<state>/ci-main.json) serves the STATUS line (status.mjs ciMainLine), the gate fact (ciProbe) and
// the digest row (digest.mjs sec. 6): each call makes AT MOST ONE gh call - the run list once per CI_TTL_MS, or (inside the TTL)
// the failed log of the current red run, once per red run. gh absent / logged out / timed out never throws: the last runs stay, with `error`.
// RED = the newest run that concluded failure (or timed_out / startup_failure) with no success created after it: level-triggered,
// it stays red while later runs are in progress or cancelled and leaves only when a LATER run on main is green.
import fs from 'node:fs';
import path from 'node:path';
import { boundedSync } from './bounded.mjs';

export const CI_TTL_MS = 10 * 60000;
const FIELDS = 'databaseId,conclusion,status,headSha,createdAt';
const LIST_N = 10;
const RED = ['failure', 'timed_out', 'startup_failure'];
// proc-hygiene: gh starts git; its timeout kills the tree (an orphaned 'git config --get-regexp ...gh-resolved' was gh's)
const ghCli = args => { const r = boundedSync('gh', args, { timeout: 20000, maxBuffer: 64 * 2 ** 20 }); if (r.error || r.status !== 0) throw r.error || new Error(`gh exited ${r.status}`); return r.stdout; };
export const ciCacheFile = state => path.join(state, 'ci-main.json');

/** the red run of a run list (any order), or null */
export function redRun(runs = []) {
  const by = [...runs].filter(r => r && Date.parse(r.createdAt)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  for (const r of by) {
    if (r.conclusion === 'success') return null;
    if (RED.includes(r.conclusion)) return r;
  }
  return null;
}

/** failing test names from `gh run view --log-failed`: ci-suite's `NEW RED: <file> :: <name>` lines, else node's `✖ failing tests:` list */
export function failedTests(log = '') {
  const lines = String(log).split(/\r?\n/).map(l => l.split('\t').pop().replace(/^\d[\d\-T:.]*Z ?/, ''));
  const uniq = xs => [...new Set(xs)];
  const red = uniq(lines.map(l => l.match(/^NEW RED: (.+?)\s*$/)?.[1]).filter(Boolean));
  if (red.length) return red;
  const out = [];
  let on = false;
  for (const l of lines) {
    if (/^✖ failing tests:/.test(l)) { on = true; continue; }
    const m = on && l.match(/^✖ (.+?) \([\d.]+m?s\)\s*$/);
    if (m) out.push(m[1]);
  }
  return uniq(out);
}

/**
 * { repo, workflow, branch, cacheFile, now (Date), gh (args -> stdout; default the gh CLI) } ->
 * { runs (newest first as gh lists them), latest, red: null | { ...run, seen (ISO: when this cache first read it red), failing: [names] | null } }
 */
export function ciMain({ repo, workflow = 'ci.yml', branch = 'main', cacheFile, now = new Date(), gh } = {}) {
  gh = gh || ghCli;
  const t = now.getTime();
  let c = null;
  try { c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { c = null; }
  if (!c || !Array.isArray(c.runs)) c = { ts: -Infinity, runs: [], seen: {}, failed: {} };
  const save = () => { try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(c)); } catch { /* still answers */ } };
  if (!(t - c.ts >= 0 && t - c.ts < CI_TTL_MS)) {
    c.ts = t;
    try {   // gh down: the last runs and their facts stay (a red main stays red, its first-seen time stays) and the answer carries the error
      const runs = JSON.parse(gh(['run', 'list', '--repo', repo, '--workflow', workflow, '--branch', branch, '-L', String(LIST_N), '--json', FIELDS]));
      if (!Array.isArray(runs)) throw new Error('gh run list: not a list');
      const r = redRun(runs);
      // keep only the current red run's facts (a new red run starts its own; a green drops them)
      c = { ts: t, runs, seen: r ? { [r.databaseId]: c.seen?.[r.databaseId] || now.toISOString() } : {}, failed: r && c.failed?.[r.databaseId] ? { [r.databaseId]: c.failed[r.databaseId] } : {} };
    } catch (e) { c.error = e.message; }
    save();
  } else {
    const r = redRun(c.runs), f = r && c.failed?.[r.databaseId];
    if (r && r.databaseId && (!f || (f.names === null && !(t - f.ts >= 0 && t - f.ts < CI_TTL_MS)))) {
      let names = null;
      try { names = failedTests(gh(['run', 'view', String(r.databaseId), '--repo', repo, '--log-failed'])); } catch { names = null; }
      c.failed = { [r.databaseId]: { ts: t, names } };
      save();
    }
  }
  const r = redRun(c.runs);
  return { runs: c.runs, latest: c.runs[0] || null, ...(c.error ? { error: c.error } : {}),
    red: r ? { ...r, seen: c.seen?.[r.databaseId] || null, failing: c.failed?.[r.databaseId]?.names ?? null } : null };
}

/** project p (with `ci` and `state`) -> its ciMain answer; p.ci.gh injects gh (tests) */
export const projectCi = (p, now = new Date()) => (p?.ci?.repo && p.state ? ciMain({ ...p.ci, cacheFile: ciCacheFile(p.state), now }) : null);

/** the gate probe: `ci:red:<run id>` once the red run was first read at or before `at` (what a check-in started then could see) */
export function ciProbe(p, { now } = {}) {
  return ({ at }) => {
    let c = null;
    try { c = projectCi(p, now || new Date()); } catch { c = null; }
    const r = c?.red;
    return r && r.seen && Date.parse(r.seen) <= at ? [`ci:red:${r.databaseId}`] : [];
  };
}
