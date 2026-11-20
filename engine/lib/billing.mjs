// Billing modes: how the Claude account Norn runs on is paid for, and so which usage guard applies (engine/presets/profiles/billing.json).
// - a plan (pro, max-5x, max-20x, ultra): a weekly limit. The weekly guard (weekly_stop_pct against the calibrated weekly %) and
//   the hourly rate cap hold new Claude work, as before. A plan mode also suggests the caps that fit the plan (Settings fills them).
// - api: pay per token, no weekly limit. The weekly guard and the rate cap are off (no calibration is asked for); the optional
//   api_usd_per_day cap holds new Claude work once the last 24 h of Claude spend on this machine costs that much.
// No billing key = a plan (the behaviour before billing modes existed).
// Spend = each ended Claude run's cost_usd, the Claude CLI's own figure (harness/claude.mjs), + each RUNNING Claude run's live estimate
// (livecost.mjs: its transcript's tokens x list price) + the dashboard chats (their turns' cost), summed over every project under the
// state root (gap #9). Own-account executors are not counted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveRunCost } from './livecost.mjs';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'presets', 'profiles', 'billing.json');
const DATA = JSON.parse(fs.readFileSync(FILE, 'utf8').replace(/^﻿/, ''));
export const BILLING_MODES = Object.entries(DATA.modes).sort((a, b) => a[1].order - b[1].order).map(([name, m]) => ({ name, ...m }));
export const BILLING_NAMES = BILLING_MODES.map(m => m.name);
export const BILLING_DEFAULT = DATA.default;
export const DAY_MS = 24 * 3600000;

/** the mode entry of a budget (null = no billing key: treated as a plan) */
export const billingOf = B => BILLING_MODES.find(m => m.name === B?.billing) ?? null;
export const isApi = B => billingOf(B)?.type === 'api';
/** the daily $ cap of an API budget, or null (no cap) */
export const usdCap = B => { const n = Number(B?.api_usd_per_day); return B?.api_usd_per_day !== undefined && B?.api_usd_per_day !== null && B?.api_usd_per_day !== '' && Number.isFinite(n) && n > 0 ? n : null; };

export function billingMode(name) {
  const m = BILLING_MODES.find(x => x.name === name);
  if (!m) throw new Error(`unknown billing mode ${name} (known: ${BILLING_NAMES.join(', ')})`);
  return m;
}
/** the budget keys a mode sets: billing + its suggested caps (+ api_usd_per_day when given; 0 / 'off' = no cap) */
export function billingChanges(name, { usdPerDay } = {}) {
  const m = billingMode(name), ch = { billing: m.name, ...m.budget };
  if (usdPerDay !== undefined) {
    if (m.type !== 'api') throw new Error('a daily $ cap is for the api billing mode only');
    const off = usdPerDay === null || usdPerDay === 'off' || Number(usdPerDay) === 0;
    if (!off && !(Number(usdPerDay) > 0)) throw new Error(`--usd-per-day must be a number of dollars > 0, or off (got ${usdPerDay})`);
    ch.api_usd_per_day = off ? 0 : Number(usdPerDay);
  }
  return ch;
}
/** the dashboard's billing list: name, label, summary, type and the Settings changes it fills */
export const billingChoices = () => BILLING_MODES.map(m => ({ name: m.name, label: m.label, summary: m.summary, type: m.type, default: m.name === BILLING_DEFAULT, changes: billingChanges(m.name) }));

// ---------- spend (cached per file on size + mtime; transcripts and chat threads tail-read) ----------
// Three parts, each its own line where it shows: ENDED Claude runs (the CLI's own cost_usd at the end), RUNNING Claude runs (live: their
// transcript's tokens x list price - an ESTIMATE, livecost.mjs; the run's end record replaces it) and the DASHBOARD CHATS (the chat
// thread's turn lines: the CLI's per-process running total_cost_usd taken as deltas, as chat.mjs chatCost). The daily cap counts all
// three, so a long run cannot pass the cap unseen until it ends. Own-account executors (kind provider) and Codex are never counted.
const cache = new Map();
const notClaude = s => s.kind === 'provider' || s.kind === 'codex' || String(s.executor ?? '').startsWith('codex') || s.executor === 'grok' || s.executor === 'fake';
function runLog(file) {
  let st; try { st = fs.statSync(file); } catch { return { rows: [], running: [] }; }
  const c = cache.get(file);
  if (c && c.size === st.size && c.mtime === st.mtimeMs) return c.val;
  const starts = new Map(), rows = [], open = new Map(), born = new Map();
  let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch { return { rows: [], running: [] }; }
  for (const line of text.split('\n')) {
    if (!line.includes('"kind":"run"')) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.ev === 'start' || r.ev === 'create') {
      const d = r.data || {};
      starts.set(r.id, d);
      if (r.ev === 'start' && !notClaude(d) && d.session_id) { born.set(r.id, { id: r.id, lane: d.lane ?? null, session_id: d.session_id, model: d.model ?? null, started: Date.parse(r.ts), transcript: d.transcript }); open.set(r.id, born.get(r.id)); }
    } else if (r.ev === 'alive') {   // MAIL-22: a lost run whose beat came back is running again
      if (born.has(r.id)) open.set(r.id, born.get(r.id));
    } else if (r.ev === 'end' || r.ev === 'kill' || r.ev === 'lost') {
      open.delete(r.id);
      if (r.ev !== 'end' || typeof r.data?.cost_usd !== 'number') continue;
      const s = starts.get(r.id) || {};
      if (s.kind === 'provider') continue;   // an own-account executor: not billed to this Claude account
      rows.push({ id: r.id, lane: s.lane ?? null, at: Date.parse(r.ts), usd: r.data.cost_usd });
    }
  }
  const val = { rows, running: [...open.values()] };
  cache.set(file, { size: st.size, mtime: st.mtimeMs, val });
  return val;
}
// the chat thread: [{ at, usd }] per turn (delta of the per-process running total; a start line resets it), read on from the last offset
const chats = new Map();
function chatTurns(file) {
  let st; try { st = fs.statSync(file); } catch { return []; }
  let c = chats.get(file);
  if (!c || st.size < c.offset) { c = { offset: 0, prev: 0, turns: [] }; chats.set(file, c); }
  if (st.size > c.offset) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - c.offset), got = fs.readSync(fd, buf, 0, buf.length, c.offset), nl = buf.subarray(0, got).lastIndexOf(10);
      if (nl >= 0) {
        for (const line of buf.subarray(0, nl).toString('utf8').split('\n')) {
          if (!line.includes('"kind":"turn"') && !line.includes('"kind":"start"')) continue;
          let l; try { l = JSON.parse(line); } catch { continue; }
          if (l.kind === 'start') { c.prev = 0; continue; }
          if (l.kind !== 'turn' || !Number.isFinite(l.cost_usd)) continue;
          const d = l.cost_usd >= c.prev ? l.cost_usd - c.prev : l.cost_usd;
          c.prev = l.cost_usd;
          if (d > 0) c.turns.push({ at: Date.parse(l.ts ?? ''), usd: d });
        }
        c.offset += nl + 1;
      }
    } finally { fs.closeSync(fd); }
  }
  return c.turns;
}
/** the Claude transcripts root when none is given (every caller that has machine.json claude.projects_dir passes it) */
export const defaultProjectsDir = (env = process.env) => path.join(env.CLAUDE_CONFIG_DIR || path.join(env.USERPROFILE || env.HOME || '', '.claude'), 'projects');
const projectDirs = stateRoot => { try { return fs.readdirSync(stateRoot, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => ({ project: d.name, dir: path.join(stateRoot, d.name) })); } catch { return []; } };
/** one project's spend rows: ended + live runs ({ id, lane, at, usd, live }) and chat turns ({ at, usd }); a live row's `at` = its transcript's last write */
export function projectSpend(dir, { projectsDir, now = Date.now() } = {}) {
  const log = runLog(path.join(dir, 'runs.jsonl')), rows = log.rows.map(r => ({ ...r, live: false }));
  for (const r of log.running) {
    const c = liveRunCost(r, { projectsDir: projectsDir || defaultProjectsDir(), now });
    if (c) rows.push({ id: r.id, lane: r.lane, at: c.mtime, usd: c.usd, live: true });
  }
  return { rows, chats: chatTurns(path.join(dir, 'chat', 'thread.jsonl')) };
}
const cents = v => Math.round(v * 100) / 100;
/**
 * The spend in [since, now] of every project under stateRoot -> { usd (the total the cap counts), runs (ended runs), ended_usd,
 * live_usd + live_runs (running runs: an estimate), chat_usd + chat_turns, live [{ project, id, lane, usd }] }. A running run counts
 * whole (from its start) while its transcript was written in the window.
 */
export function spendUsd(stateRoot, { since, now = Date.now(), projectsDir } = {}) {
  let ended = 0, runs = 0, live = 0, liveRuns = 0, chat = 0, turns = 0;
  const liveRows = [];
  for (const p of projectDirs(stateRoot)) {
    const s = projectSpend(p.dir, { projectsDir, now });
    for (const r of s.rows) {
      if (r.live) { if (r.at >= since) { live += r.usd; liveRuns++; liveRows.push({ project: p.project, id: r.id, lane: r.lane, usd: cents(r.usd) }); } }
      else if (r.at >= since && r.at <= now) { ended += r.usd; runs++; }
    }
    for (const t of s.chats) if (t.at >= since && t.at <= now) { chat += t.usd; turns++; }
  }
  return { usd: cents(ended + live + chat), runs, ended_usd: cents(ended), live_usd: cents(live), live_runs: liveRuns, chat_usd: cents(chat), chat_turns: turns, live: liveRows };
}
export const spendDay = (stateRoot, now = Date.now(), o = {}) => spendUsd(stateRoot, { since: now - DAY_MS, now, ...o });
/**
 * The dashboard breakdown: per project, per lane $ today (since local midnight) and in the last 7 days, the chats on their own line,
 * and each lane's $ to date (every run it had, the running ones live) -> [{ project, chats { today, week }, lanes [{ lane, today, week, total, runs, live }] }]
 */
export function spendBreakdown(stateRoot, { now = Date.now(), projectsDir, projects = null } = {}) {
  const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
  const today = d0.getTime(), week = now - 7 * DAY_MS;
  return projectDirs(stateRoot).filter(p => !projects || projects.includes(p.project)).map(p => {
    const s = projectSpend(p.dir, { projectsDir, now }), by = new Map();
    for (const r of s.rows) {
      const k = r.lane ?? '-', g = by.get(k) ?? { lane: k, today: 0, week: 0, total: 0, runs: 0, live: 0 };
      by.set(k, g);
      g.total += r.usd; g.runs++; if (r.live) g.live++;
      if (r.at >= week) g.week += r.usd;
      if (r.at >= today) g.today += r.usd;
    }
    const sum = f => cents(s.chats.filter(t => t.at >= f).reduce((a, t) => a + t.usd, 0));
    const lanes = [...by.values()].map(g => ({ ...g, today: cents(g.today), week: cents(g.week), total: cents(g.total) })).sort((a, b) => b.week - a.week || b.total - a.total);
    return { project: p.project, chats: { today: sum(today), week: sum(week) }, lanes };
  });
}

/** null = may start; else why not (an API budget whose daily $ cap is reached: ended + running + chats). state: one project's state dir (its parent = the root) */
export function apiRefusal(B, state, { now = Date.now(), stateRoot, projectsDir } = {}) {
  const cap = usdCap(B);
  if (!isApi(B) || cap === null) return null;
  const s = spendDay(stateRoot ?? path.dirname(state), now, { projectsDir });
  return s.usd >= cap ? `api spend $${s.usd.toFixed(2)} in 24 h >= cap $${cap.toFixed(2)}` : null;
}

/**
 * one line in words: the mode and, for API billing, the last 24 h of spend against the cap - ended runs + running runs (an estimate)
 * [+ chats] = the total the cap counts (plan.mjs forecastOf reads the total)
 */
export function billingLine(B, state, { now = Date.now(), stateRoot, projectsDir } = {}) {
  const m = billingOf(B);
  if (!m) return 'billing: not set (treated as a plan: the weekly guard applies)';
  if (m.type !== 'api') return `billing: ${m.label} (plan: the weekly guard applies)`;
  const s = spendDay(stateRoot ?? path.dirname(state), now, { projectsDir }), cap = usdCap(B), $ = v => `$${v.toFixed(2)}`, runs = k => `${k} run${k === 1 ? '' : 's'}`;
  const parts = `api spend last 24 h ${$(s.ended_usd)} (${runs(s.runs)}) + ${$(s.live_usd)} running${s.live_runs ? ` (${runs(s.live_runs)}, estimate)` : ''}${s.chat_turns ? ` + ${$(s.chat_usd)} chats` : ''} = ${$(s.usd)}`;
  return `billing: API (pay per token, no weekly limit); ${parts}${cap === null ? '; no daily cap' : ` of the ${$(cap)} daily cap${s.usd >= cap ? ' -> CAP REACHED: no new Claude work' : ''}`}`;
}
