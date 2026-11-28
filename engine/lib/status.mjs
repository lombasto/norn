// `norn status` (META-GENERAL-DESIGN 9 status.ps1 row, 3.6, 12-S5): the cheap (no LLM) snapshot a check-in reads -> state/STATUS.md.
// Port of meta/status.ps1: Steering + Usage (trailing 2 h gate, since-CALIB, weekly estimate, RATE_OK) are kept line for line;
// the lanes / Codex process probes become runs.jsonl + heartbeats of every project (D7, D11); a `## Records` block is added (3.6).
import fs from 'node:fs';
import path from 'node:path';
import { loadState } from './records.mjs';
import { renderDigest } from './views.mjs';
import { threadStatus } from './qthread.mjs';
import { liveRuns, sweepLost, STALE_MS } from './runs.mjs';
import { cacheRSince, jsonCacheRSince } from './usage.mjs';
import { capKey, capDefault, capsOfRun } from './executors.mjs';
import { capText } from './policy.mjs';
import { weekStart, nextReset, parseReset } from './cost.mjs';
import { ciMain } from './ciwatch.mjs';
import { limitLines } from './limitgate.mjs';
import { isApi, billingLine } from './billing.mjs';
import { readPause, PAUSE_MODES, pauseFiles } from './pausemode.mjs';

const pad = n => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const utcMin = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
const localMd = d => `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
// .NET "N<d>" (en-US): grouped thousands, d decimals
const N = (x, d) => Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const ps = v => (v === undefined || v === null ? '' : String(v));   // PowerShell renders $null as ''
const cs = capText;   // a cap: unset = no limit, said so (META-OOTB F-3: never an empty cap)
const dash = v => v ?? '-';   // a run field the run never set

// a run's last NOTES marker; null = no NOTES file (its line is left out: DEC-a-679)
function lastMarker(notes) {
  if (!notes || !fs.existsSync(notes)) return null;
  const lines = fs.readFileSync(notes, 'utf8').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].startsWith('## ')) return `L${i + 1}: ${lines[i].slice(0, 140)}`;
  return '(no ## marker)';
}

// One line on the project's CI (WASTE-CI-SIGNAL; project.json `ci: {repo, workflow?, branch?}`): the newest main run from ciwatch.mjs
// ciMain (META-CIWATCH: one cache file shared with the gate fact and the digest row, so a tick costs at most one gh list per
// 10 min); any gh failure (absent, not logged in, timeout, no run) reads 'CI <branch>: unknown'. gh is injectable for tests.
const age = ms => {
  const m = Math.max(0, Math.floor(ms / 60000)), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d ? `${d}d${h % 24}h` : h ? `${h}h${m % 60}m` : `${m}m`;
};
export function ciMainLine({ repo, workflow = 'ci.yml', branch = 'main', cacheFile, now = new Date(), gh } = {}) {
  const label = `CI ${branch}:`;
  let r = null;
  try { r = ciMain({ repo, workflow, branch, cacheFile, now, gh }).latest; } catch { r = null; }
  if (!r || !r.headSha || !Date.parse(r.createdAt)) return `${label} unknown`;
  return `${label} ${r.conclusion || r.status || 'unknown'} ${r.headSha.slice(0, 9)} ${age(now - Date.parse(r.createdAt))}`;
}

// fedCacheR stays until tests/status.test.mjs (outside the d-fed lane's Scope) drops its fed-cache case: nothing writes fed-cache.json now
/** the cache_read of the node runs in the fed-cache.json of every project under stateRoot whose end is at or after sinceMs. One key per
 * project / node / run: each cache file is rewritten whole by its fill, so a re-import never counts a run twice. */
function fedCacheR(stateRoot, sinceMs) {
  if (!stateRoot) return 0;
  let dirs = [];
  try { dirs = fs.readdirSync(stateRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return 0; }
  const seen = new Map();
  for (const p of dirs) {
    let c;
    try { c = JSON.parse(fs.readFileSync(path.join(stateRoot, p, 'fed-cache.json'), 'utf8')); } catch { continue; }
    for (const [node, runs] of Object.entries(c?.nodes || {})) for (const r of runs || []) {
      const e = (r?.history || []).find(h => h.ev === 'end'), ms = Date.parse(e?.ts ?? '');
      if (!(ms >= sinceMs)) continue;
      seen.set(`${p}/${node}/${r.id}`, Number(e.data?.node_usage?.cache_read) || 0);
    }
  }
  let sum = 0;
  for (const v of seen.values()) sum += v;
  return sum;
}
/** the account's cacheR since sinceMs, by source: transcripts, check-in and dashboard chat result jsons, and (META-GTP-FED-2 piece 2) the
 * node runs the home fills imported into every project's fed-cache.json under the state root (o.stateRoot, else the parent of o.state) */
export function accountCacheR(o, sinceMs, { transcripts = true } = {}) {
  const root = o.stateRoot ?? (o.state ? path.dirname(path.resolve(o.state)) : null);
  return { tr: transcripts ? cacheRSince(o.projectsDir, sinceMs, { cacheFile: o.cacheFile }).cr : 0, ck: jsonCacheRSince(o.usageJson?.checkin, sinceMs), chat: jsonCacheRSince(o.usageJson?.chat, sinceMs),
    nodes: fedCacheR(root, sinceMs) };
}
export const crTotal = c => c.tr + c.ck + c.chat + (c.nodes || 0);
/** META-USAGE-WEEK: the ONE weekly estimator. The anchor is the calibration while it lies inside the current week (base calib_pct),
 * else the start of the current week (base 0: the weekly reset zeroed the account). No valid budget reset = the calibration as before.
 * Returns { weekly, pct, all, per, anchor, inWeek, weekStartMs, next (ISO of the next reset | null) }. */
export function weeklyEstimate(o, now = new Date(), { transcripts = true } = {}) {
  const B = o.budget || {}, resetIso = parseReset(B.reset), resetMs = Date.parse(resetIso ?? '');
  const weekStartMs = Number.isFinite(resetMs) ? weekStart(resetMs, now.getTime()) : null;
  const calib = new Date(B.calib_time_utc), inWeek = weekStartMs === null || !(calib.getTime() < weekStartMs);
  const anchor = inWeek ? calib : new Date(weekStartMs);
  const all = accountCacheR(o, anchor.getTime(), { transcripts }), per = Number(B.cacheR_per_pct), pct = crTotal(all) / per;
  return { weekly: (inWeek ? Number(B.calib_pct) : 0) + pct, pct, all, per, anchor, inWeek, weekStartMs, next: resetIso ? nextReset(resetIso, now.getTime()) : null };
}

// DEC-a-679 (oh-checkin-diet S7): the ## Runs lines - running / NEW / unreviewed runs in full, the rest one line each; paths relative to STATE
function runLines(items, state, now, lastCk) {
  const rel = p => { if (!p) return '-'; const r = path.relative(state, p); return (r.startsWith('..') || path.isAbsolute(r) ? p : r).replace(/\\/g, '/'); };
  const cut = now.getTime() - 12 * 3600000;
  const mine = items.filter(i => i.kind === 'run' && i.data.kind !== 'interactive' && i.data.role !== 'helper' && (i.state === 'running' || Date.parse(i.updated) >= cut));
  return mine.length ? mine.sort((a, b) => a.created.localeCompare(b.created)).flatMap(r => runLine(r, lastCk, rel)) : ['- (none)'];
}

// one run: a single line when it is settled (ended before the last tick and reviewed), else the full entry with NOTES and log
function runLine(r, lastCk, rel) {
  const d = r.data, last = r.history.at(-1);
  const end = r.history.find(h => ['end', 'lost', 'kill'].includes(h.ev)), ed = end?.data || {};
  const isNew = end && Date.parse(end.ts) > lastCk.getTime() ? 'NEW ' : '';
  const unrev = ['exited', 'lost', 'killed'].includes(r.state) && !r.review;   // the Records block's "unreviewed"
  if (r.state !== 'running' && !isNew && !unrev) return [`- ${r.id} ${dash(d.lane)} ${r.state}/${ed.outcome ?? r.state}`];
  const what = r.state === 'running' ? `RUNNING since ${r.created}` : r.state === 'exited'
    ? `EXITED outcome=${ed.outcome} exit=${dash(ed.exit)} end=${end.ts}` : `${r.state.toUpperCase()} ${last.ts}${ed.why ? ' (' + ed.why + ')' : ''}`;
  const out = [`- ${isNew}**${r.id}** ${dash(d.lane)} ${d.executor ?? d.kind}: ${what} | ${dash(d.model)} ${dash(d.effort)} | brief ${rel(d.brief)}`];
  const mk = d.kind !== 'checkin' && lastMarker(d.notes);
  if (mk) out.push(`  - NOTES ${mk}`);
  out.push(`  - log ${rel(d.log)}${r.state !== 'running' && d.final ? ' | final ' + rel(d.final) : ''}`);
  return out;
}

/**
 * o: { state, project, providers? {name: claude-compatible entry}, budget, now?, projectsDir, usageJson {checkin: [globs], chat: [globs]}, cacheFile?, paused? [files], staleMs?,
 *      ci? {repo, workflow?, branch?, gh?, cacheFile?, now?} (project.json `ci`; prints the `CI <branch>:` line) }
 * returns { text, rate, rateOk, weekly, alive, codex }
 */
export function buildStatus(o) {
  const B = o.budget || {}, now = o.now || new Date(), staleMs = o.staleMs ?? STALE_MS;
  const paused = o.paused || pauseFiles(o.state);
  const lastTickF = path.join(o.state, 'last-tick.txt');
  const lastCk = fs.existsSync(lastTickF) ? new Date(fs.readFileSync(lastTickF, 'utf8').trim()) : new Date(now.getTime() - 12 * 3600000);
  sweepLost(o.state, { staleMs, by: 'status' });
  const st = loadState(o.state);
  const L = [`# META STATUS ${utcMin(now)} (local ${DAYS[now.getDay()]} ${pad(now.getHours())}:${pad(now.getMinutes())})`, ''];
  if (o.ci) L.push(ciMainLine({ now, cacheFile: path.join(o.state, 'ci-main.json'), ...o.ci }), '');

  const astraCap = B.max_astra ?? B.max_codex, solCap = B.max_sol ?? B.max_codex;
  L.push('## Steering (BUDGET; future dispatch only)');
  L.push(`- caps: max_claude_workers=${cs(B.max_claude_workers)}; max_codex=${cs(B.max_codex)}; max_astra=${cs(astraCap)}; max_sol=${cs(solCap)}; usage_rate_cap_pct_per_h=${cs(B.usage_rate_cap_pct_per_h)}`);
  L.push(`- defaults: claude_model=${B.claude_model || 'claude-opus-5-5'}; claude_effort=${B.claude_effort || 'medium'}; checkin_model=${ps(B.checkin_model)}; checkin_effort=${ps(B.checkin_effort)}; codex_astra_effort=${B.codex_astra_effort || 'xhigh'}; codex_sol_effort=${B.codex_sol_effort || 'medium'}`);
  const pz = readPause(paused);   // RM-37: the mode in force, who set it and why (pausemode.mjs)
  L.push(`- pause: ${pz ? `${pz.label}${pz.by ? ` by ${pz.by}` : ''}${pz.at ? ` since ${pz.at.slice(0, 16)}Z` : ''}${pz.why ? ` (${pz.why})` : ''} - ${PAUSE_MODES[pz.mode].says}` : 'none'}`);
  const items = Object.values(st.items);
  const dirs = items.filter(i => i.kind === 'directive' && i.state === 'active');
  L.push(`- directive count: ${dirs.length} active (listed under ## Records; below DECISION-RULES stops and owner-only asks)`);
  const lanes = Object.entries(B.lanes || {});
  if (lanes.length) for (const [k, v] of lanes) L.push(`- lane override ${k}: executor=${ps(v.executor)}; effort=${v.effort || '(executor default)'}`);
  else L.push('- lane overrides: none (auto)');
  // META-LIMIT-GATE: a closed executor family (norn run refuses it, exit 4; the fill holds it) - dispatch an open one instead
  for (const l of limitLines(o.state, { now: now.getTime() })) L.push(`- limit: ${l} - closed: dispatch an open executor`);
  L.push('');

  // ---- runs: this project's in full; caps count every project's live runs (D11)
  const live = liveRuns(o.state, { staleMs }).filter(r => r.data.kind !== 'checkin');
  const isClaude = r => r.data.executor === 'claude' || r.data.executor === 'fake';
  const alive = live.filter(isClaude).length;
  const cx = live.filter(r => String(r.data.executor).startsWith('codex'));
  const sol = cx.filter(r => r.data.executor === 'codex-sol').length, astra = cx.filter(r => r.data.executor === 'codex-astra').length;
  // DEC-a-679 (oh-checkin-diet S7): only running / NEW / unreviewed runs in full, the rest one line each; paths relative to STATE
  L.push(`## Runs (NEW = ended since the last tick ${localMd(lastCk)}; full: running, NEW, unreviewed; paths relative to STATE; caps count the live runs of every project)`);
  L.push(...runLines(items, o.state, now, lastCk));
  L.push(`- claude workers alive: ${alive} / cap ${cs(B.max_claude_workers)}`);
  L.push(`- codex exec runs: ${cx.length} / cap ${cs(B.max_codex)}`);
  L.push(`- codex split: astra=${astra} / cap ${cs(astraCap)}; sol=${sol} / cap ${cs(solCap)}`);
  // typed executors (META-EXEC-S1, META-AGNOSTIC-EXEC): own accounts, own caps max_<name> (default the entry's cap, else 1), never Claude usage
  const pv = Object.entries(o.providers || {});
  if (pv.length) L.push(`- own-account executors (not Claude usage): ${pv.map(([n, x]) => `${n}=${live.filter(r => capsOfRun(r.data).includes(capKey(n))).length} / cap ${B[capKey(n)] ?? capDefault(x)}${x.enabled === false ? ' (disabled)' : ''}`).join('; ')}`);
  L.push('');

  // ---- records (3.6): what a controller must act on
  L.push('## Records');
  const day = 24 * 3600000;
  const recs = [
    ...items.filter(i => i.kind === 'question' && ['open', 'answered'].includes(i.state)).flatMap(i => [`- ${i.id} ${i.state}${i.state === 'open' && now - Date.parse(i.created) > day ? ' STALE' : ''} ${i.data.lane ?? '-'}: ${i.data.title}`, ...threadStatus(i)]),   // INBOX-REPLIES: + its thread's wait
    ...dirs.map(i => `- ${i.id} active: ${String(i.data.text).split('\n')[0].slice(0, 80)}`),   // the full text: norn rec show DIR-n (DEC-a-679)
    ...items.filter(i => i.kind === 'lane' && i.state === 'parked').map(i => `- ${i.id} parked: ${i.history.at(-1).data.why ?? ''}`),
    ...items.filter(i => i.kind === 'run' && ['exited', 'lost', 'killed'].includes(i.state) && !i.review && i.data.kind !== 'interactive' && i.data.role !== 'helper')
      .map(i => `- ${i.id} ${i.state} unreviewed ${i.data.lane ?? '-'} ${i.end?.outcome ?? i.state}`),
  ];
  L.push(...(recs.length ? recs : ['- (nothing open)']), '');
  // the level-triggered resume digest (digest.mjs) when the caller computed one, or the error that stopped it
  if (o.digest) L.push(...(o.digest.error ? ['## Digest', `- could not be built: ${o.digest.error}`] : renderDigest(o.digest).trimEnd().split('\n')), '');

  // ---- usage: cacheR since the anchor (META-USAGE-WEEK: the calibration, or the week start once the weekly reset passed it) and over
  // the trailing 2 h (always now - 2 h, never shrunk to a fresh calibration)
  L.push('## Usage');
  // no calibration (a fresh project: budget cacheR_per_pct unset) = no estimate, said so - never NaN (OOTB F-10) - and no transcript
  // read for it: a cold usage cache would parse every transcript since the epoch for a figure nobody sees (META-CONTROLLER C1)
  const per = Number(B.cacheR_per_pct), measured = per > 0 && Number.isFinite(per);
  const est = weeklyEstimate(o, now, { transcripts: measured });
  const { all } = est;
  const winStart = new Date(now.getTime() - 2 * 3600000);
  const winCr = measured ? crTotal(accountCacheR(o, winStart.getTime())) : 0;
  const hours = Math.max(0.1, (now - winStart) / 3600000);
  const rate = measured ? winCr / per / hours : null, cap = Number(B.usage_rate_cap_pct_per_h);
  const api = isApi(B), over = !api && measured && rate > cap;   // API billing: no rate cap (billing.mjs)
  const weekly = measured && !api ? est.weekly : null;
  L.push(`- ${billingLine(B, o.state, { now: now.getTime(), stateRoot: o.stateRoot, projectsDir: o.projectsDir })}`);
  if (api) { /* no weekly limit: no calibration asked for */ } else if (!measured) L.push(`- usage not estimated: no usage calibration yet (Settings > Usage calibration, or norn calib --pct N once the week shows >= 10 %); rate cap ${cs(B.usage_rate_cap_pct_per_h)}`);
  else L.push(`- trailing 2 h since ${utcMin(winStart)}: cache reads ${N(winCr / 1e6, 1)}M over ${N(hours, 1)} h = ${N(rate, 2)} %/h vs cap ${cs(B.usage_rate_cap_pct_per_h)} -> ${over ? 'OVER CAP -> no new Claude dispatch' : 'within cap'}`);
  if (measured && !api) L.push(`- since ${est.inWeek ? `calibration ${ps(B.calib_time_utc)}` : `week start ${utcMin(est.anchor)} (calibration ${ps(B.calib_time_utc)} predates it)`}: cache reads ${N(all.tr / 1e6, 1)}M (+ check-ins ${N(all.ck / 1e6, 1)}M) (+ nodes ${N(all.nodes / 1e6, 1)}M, as of the last fill's ledger import: one push of lag) = ${N(est.pct, 2)} %`);
  if (measured && !api) L.push(`- estimated weekly now ~${N(weekly, 1)} % (${est.inWeek ? `calib ${ps(B.calib_pct)} %` : 'new week: base 0 %'}); reset ${est.next ? utcMin(new Date(est.next)) : ps(B.reset)}`);
  L.push(`- dashboard chat cache reads included: ${N(all.chat / 1e6, 2)}M`);
  L.push(`RATE_OK=${over ? 0 : 1}`);
  return { text: L.join('\r\n') + '\r\n', rate, rateOk: over ? 0 : 1, weekly, alive, codex: cx.length };
}

/** write STATUS.md (UTF-8, no BOM, CRLF as status.ps1) atomically; returns the buildStatus result + out path */
export function writeStatus(o, out = path.join(o.state, 'STATUS.md')) {
  const s = buildStatus(o);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, s.text);
  fs.renameSync(tmp, out);
  if (o.digest && !o.digest.error) {   // <state>/DIGEST.md: the generated view of the same digest
    const df = path.join(o.state, 'DIGEST.md'), dt = `${df}.${process.pid}.tmp`;
    fs.writeFileSync(dt, '<!-- GENERATED by norn digest (NORN-WATCH S1) from the records + git; never edit -->\n' + renderDigest(o.digest));
    fs.renameSync(dt, df);
  }
  return { ...s, out, line: `status -> ${out} (rate ${s.rate === null ? 'n/a' : Math.round(s.rate * 100) / 100 + ' %/h'}, claude alive ${s.alive}, codex ${s.codex})` };
}
