// META-AUTH AUTH-1: ONE home for "is the executor CLI's login down" - a circuit breaker per harness (closed / open / half-open).
// Incident 2026-11-12 20:21-20:28Z: the claude OAuth session expired machine-wide; 14 runs died as `crash` (fresh launches in
// 59-174 ms), nothing told the owner. Now: an exit matching executors.AUTH_PATTERNS marks the harness DOWN (supervisor.mjs);
// while down every new launch on it holds (the queue fill, a queued or direct start, the tick's check-in - like RATE_OK); a cheap
// probe (the CLI's own status command, executors AUTH_PATTERNS .probe) runs when due, with exponential backoff (bounded); a passing
// probe lets ONE launch through (the canary: `claude auth status` is local and cannot prove the server takes the token); the gate
// closes once the canary has lived CANARY_MS (a dead login kills a launch in < 0.2 s, MEASURED) - a canary that dies on auth again
// reopens the same episode. One owner notice per episode once it is AUTH_NOTICE_MIN old.
// The record is machine-wide: <state home>/auth-down.json (the CLI login is per machine; the state home holds every project + locks).
import fs from 'node:fs';
import path from 'node:path';
import { readJsonS } from './fsnap.mjs';
import { spawnSync } from 'node:child_process';
import { authPatterns, executorInfo } from './executors.mjs';
import { resolveShim } from './paths.mjs';
import { vendorIncident } from './vendorstatus.mjs';

export const AUTH_NOTICE_MIN = 10;
export const CANARY_MS = 120000;
export const AUTH_REQUEUE_MAX = 3;
const PROBE_BASE_MS = 60000, PROBE_MAX_MS = 15 * 60000;
/** The wait after the n-th failed probe (n = 0 before the first): 1, 2, 4, 8 min, capped at 15 min. */
export const probeBackoffMs = n => Math.min(PROBE_BASE_MS * 2 ** Math.min(n, 20), PROBE_MAX_MS);
export const AUTH_RESUME_PROMPT = 'Your previous turn was cut off by an authentication error (the CLI login had expired or the vendor refused calls; it works again now). '
  + 'Continue the task exactly where you left off: check what is already done (git log, your notes) and do not redo finished steps.';

const home = state => path.dirname(path.resolve(state));
export const authFile = state => path.join(home(state), 'auth-down.json');
export function readAuth(state) { return readJsonS(authFile(state)) || {}; }   // META-DASH-ASYNC R1: snapshot-aware (the dash primes authFile)
function writeAuth(state, all) {
  const f = authFile(state), t = `${f}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(t, JSON.stringify(all, null, 1));
  fs.renameSync(t, f);
}
const iso = ms => new Date(ms).toISOString();
const claim = f => { try { fs.writeFileSync(f, '', { flag: 'wx' }); return true; } catch { return false; } };   // once, across processes

/**
 * META-AUTH-VENDOR item 4: the matched text of `hit` (a RegExp match on `text`) with a little context, inside its line - not the line
 * start (a claude final is ONE huge JSON line; its first 200 chars never showed the match). A short line comes back whole.
 */
export function matchExcerpt(text, hit, { before = 60, max = 200 } = {}) {
  const a = text.lastIndexOf('\n', hit.index) + 1, e = text.indexOf('\n', hit.index), b = e < 0 ? text.length : e;
  const s = Math.max(a, hit.index - before), t = Math.min(b, s + max);
  return `${s > a ? '…' : ''}${text.slice(s, t).trim()}${t < b ? '…' : ''}`;
}

/**
 * { cls, line } when `text` (a log tail + final) carries an auth-failure signature of `pats`, else null. Class 'login' (pats.match:
 * the CLI's login is gone) is tried first, then 'vendor' (pats.vendor: the vendor's edge / servers refuse - META-AUTH-VENDOR).
 */
export function classifyAuth(text, pats) {
  if (!text) return null;
  text = String(text);
  for (const [cls, list] of [['login', pats?.match], ['vendor', pats?.vendor]]) {
    const hit = (list || []).map(p => text.match(new RegExp(p, 'i'))).find(Boolean);
    if (hit) return { cls, line: matchExcerpt(text, hit) };
  }
  return null;
}

/** An auth exit of `run` on `harness` (cls login | vendor): open the breaker (a new episode, or the running one: same since, one more try). */
export function markAuthDown(state, { harness, line, cls = 'login', run, now = Date.now() }) {
  const all = readAuth(state), old = all[harness];
  const tries = old ? (old.tries || 0) + (old.ok_at ? 1 : 0) : 0;
  all[harness] = { since: old?.since ?? iso(now), cls, line, run, tries, next_probe: iso(now + probeBackoffMs(tries)) };
  writeAuth(state, all);
  return all[harness];
}

/** The real probe: the CLI's own status command (local, no model turn); never prints its output (it names the account). */
export function probeAuth(spec) {
  const pr = authPatterns(spec?.executor, spec?.provider || (spec?.auth ? { auth: spec.auth } : undefined)).probe;
  if (!pr || !spec?.exe) return true;   // nothing to ask: the canary decides
  try {
    const sp = resolveShim(spec.exe, pr.args);
    const r = spawnSync(sp.exe, sp.args, { encoding: 'utf8', timeout: 20000, windowsHide: true });
    if (!pr.json) return r.status === 0;
    try { return JSON.parse(r.stdout || '')?.[pr.json] === true; } catch { return false; }
  } catch { return false; }
}

/**
 * null = a launch on `harness` may go now; else the reason it holds ("auth: ..."). o: { now, spec (the run's, for the probe),
 * probe (spec) -> bool (default probeAuth), dry (norn ready / a view: never probes, never takes the canary) }.
 */
export function authRefusal(state, harness, { now = Date.now(), spec, probe = probeAuth, dry = false } = {}) {
  const all = readAuth(state), e = all[harness];
  if (!e) return null;
  const down = `auth: ${harness} ${e.cls === 'vendor' ? 'vendor outage' : 'login down'} since ${e.since} (${e.line})`;
  if (!e.ok_at) {
    if (now < Date.parse(e.next_probe)) return `${down}; next probe ${e.next_probe}`;
    if (dry) return `${down}; probe due`;
    if (!probe(spec)) {
      e.tries = (e.tries || 0) + 1;
      e.next_probe = iso(now + probeBackoffMs(e.tries));
      writeAuth(state, all);
      return `${down}; probe failed (${e.tries}), next ${e.next_probe}`;
    }
    e.ok_at = iso(now);
    writeAuth(state, all);
  }
  if (e.canary_at) {
    if (now - Date.parse(e.canary_at) < CANARY_MS) return `auth: ${harness} probe passed ${e.ok_at}; one canary launch since ${e.canary_at}, the rest wait for it`;
    delete all[harness];   // the canary lived: closed
    writeAuth(state, all);
    return null;
  }
  if (dry) return null;
  if (!claim(path.join(home(state), `auth-canary-${harness}-${Date.parse(e.ok_at)}`))) return `auth: ${harness} probe passed ${e.ok_at}; a canary launch is starting`;
  e.canary_at = iso(now);
  writeAuth(state, all);
  return null;
}

/** OOTB-R2 N-5: the command the owner runs to log executor `name` in again (entry: its project.json executors entry, for a typed one) */
export const loginCommand = (name, entry) => authPatterns(name, entry).login || `${name} login`;
const harnessOf = (name, entry) => executorInfo(name, entry)?.harness ?? name;
export const hhmm = t => (t ? String(t).slice(11, 16) + 'Z' : '?');
const plural = n => `${n} run${n === 1 ? '' : 's'}`;
const vendorOf = h => authPatterns(h)?.status?.vendor || 'The vendor';
const lookup = (incident, state, h, o) => { try { return (incident || (x => vendorIncident(state, x, o)))(h) ?? null; } catch { return null; } };
/**
 * META-AUTH-VENDOR: the owner's sentence for a vendor-class episode `e` of harness `h` (incident: { name, since } | null, from the
 * vendor's status page): what the vendor reports, that Norn holds `n` runs (null = not counted here) and that no login is needed.
 */
export function vendorSentence(h, e, incident, n) {
  const what = incident ? `${vendorOf(h)} reports an incident: ${incident.name} (since ${hhmm(incident.since)})`
    : `${vendorOf(h)} refuses ${h} calls since ${hhmm(e.since)} ("${e.line}") - an outage on their side; their status page names no incident (yet)`;
  return `${what}. Norn holds ${n == null ? 'the waiting runs' : plural(n)} and resumes them when it clears. You do NOT need to log in.`;
}
/**
 * OOTB-R2 N-5: the auth holds - one per harness whose gate is down (no passing probe yet) while queued runs of `runs` (loadState run
 * items) wait on it -> [{ harness, cls, since, line, command, runs: [RUN-n], incident, title }]. entryOf(executor) = its executors
 * entry; incident(harness) as authNoticeDue (default here: the cached status answer only - a view never sends a request).
 */
export function loginHolds(state, runs, { entryOf = () => undefined, incident } = {}) {
  const all = readAuth(state), out = [];
  for (const [h, e] of Object.entries(all)) {
    if (e.ok_at) continue;
    const held = runs.filter(r => r.kind === 'run' && r.state === 'queued' && harnessOf(r.data?.executor, entryOf(r.data?.executor)) === h);
    if (!held.length) continue;
    const command = loginCommand(h), base = { harness: h, since: e.since, line: e.line, command, runs: held.map(r => r.id) };
    if (e.cls === 'vendor') {
      const inc = lookup(incident, state, h, { cacheOnly: true });
      out.push({ ...base, cls: 'vendor', incident: inc, title: vendorSentence(h, e, inc, held.length) });
    } else out.push({ ...base, cls: 'login', incident: null, title: `Log in to ${h} again: run ${command} (${plural(held.length)} held)` });
  }
  return out;
}

/**
 * The one owner notice of an episode still open after AUTH_NOTICE_MIN ({ harness, cls, title, body }), claimed across processes;
 * else null. o: { now, incident (harness -> { name, since } | null; default the vendor's status page, cached), held (harness -> the
 * number of runs held) }. A login episode never asks the status page.
 */
export function authNoticeDue(state, { now = Date.now(), incident, held } = {}) {
  for (const [h, e] of Object.entries(readAuth(state))) {
    if (e.ok_at || now - Date.parse(e.since) < AUTH_NOTICE_MIN * 60000) continue;
    if (!claim(path.join(home(state), `auth-notice-${h}-${Date.parse(e.since)}`))) continue;
    if (e.cls === 'vendor') {
      let n = null;
      try { n = held ? held(h) : null; } catch { /* not counted */ }
      return { harness: h, cls: 'vendor', title: `Norn: ${vendorOf(h)} outage - ${h} runs held, no login needed`,
        body: vendorSentence(h, e, lookup(incident, state, h, { now }), n) };
    }
    const login = loginCommand(h), at = hhmm(e.since), min = Math.floor((now - Date.parse(e.since)) / 60000);
    return { harness: h, cls: 'login', title: `Norn: the ${h} login has expired - run ${login}`,
      body: `Every ${h} run has failed to log in since ${at} (${min} min): "${e.line}". Open a terminal and run: ${login}. `
        + 'Held and cut-off runs then resume by themselves; nothing else to do.' };
  }
  return null;
}

/**
 * META-AUTH-VENDOR: what `norn doctor` says about the open auth episodes of the state home of `state` -> [{ level, text }]: a login
 * episode is a problem (the owner runs the login command), a vendor one a note (Norn waits; no login). o.incident as authNoticeDue.
 */
export function authDoctorLines(state, { incident } = {}) {
  const out = [];
  for (const [h, e] of Object.entries(readAuth(state))) {
    const gate = e.ok_at ? `probe passed ${hhmm(e.ok_at)}, a canary run decides` : `held since ${hhmm(e.since)}`;
    if (e.cls === 'vendor') out.push({ level: 'note', text: `${h} auth: vendor outage (${gate}): ${vendorSentence(h, e, lookup(incident, state, h, {}), null)}` });
    else out.push({ level: e.ok_at ? 'note' : 'bad', text: `${h} auth: the login is down (${gate}: "${e.line}") - run: ${loginCommand(h)}` });
  }
  return out;
}
