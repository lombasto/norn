// Live $ of a RUNNING Claude run (gap #9: spend showed only after a run ended). A Norn run calls `claude -p --output-format json`:
// its stdout is ONE result object written at exit (total_cost_usd), and its log carries no running total - so while it runs the only
// record of what it spent is its session transcript (<projects_dir>/<any>/<session_id>.jsonl + <sid>/subagents/agent-*.jsonl), whose
// assistant lines carry each model call's usage and model. Live $ = those tokens x the list price of the model
// (engine/presets/prices/claude.json): an ESTIMATE, always labelled so; the run's end record replaces it with the CLI's own figure.
// Tail-read: each transcript is read from the byte offset of the last read (a shrunk file starts over), never parsed whole again.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PRICES_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'presets', 'prices', 'claude.json');
export const PRICES = JSON.parse(fs.readFileSync(PRICES_FILE, 'utf8').replace(/^﻿/, ''));
const BY_LEN = Object.keys(PRICES.models).sort((a, b) => b.length - a.length);

/** a model id or alias -> { model (the table row used), input, output, cache_read } in $ per million tokens */
export function priceOf(model, fallback = null) {
  const id = String(model ?? '').toLowerCase().replace(/\[.*\]$/, '').trim();
  const hit = BY_LEN.find(k => id.startsWith(k)) ?? (PRICES.aliases[id] ? PRICES.aliases[id] : null);
  if (hit) return { model: hit, ...PRICES.models[hit] };
  return fallback ? priceOf(fallback) : { model: PRICES.default, ...PRICES.models[PRICES.default] };
}

const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
/** one API usage object (transcript message) at a model's price -> $ */
export function usageUsd(u = {}, model, fallback = null) {
  const p = priceOf(model, fallback), M = 1e6, cw = n(u.cache_creation_input_tokens);
  const c5 = Math.min(cw, n(u.cache_creation?.ephemeral_5m_input_tokens)), c1 = cw - c5;   // no split = 1 h (the CLI's default)
  return (n(u.input_tokens) * p.input + n(u.output_tokens) * p.output + n(u.cache_read_input_tokens) * p.cache_read
    + c5 * p.input * PRICES.cache_write_5m_x + c1 * p.input * PRICES.cache_write_1h_x) / M;
}

// ---------- the tail cache: key = file + the run's start (a resumed session's file holds the earlier run's lines: those are its own $) ----------
const tails = new Map();
const IDLE_DROP_MS = 3600000;
function tailUsd(file, fromMs, fallback, now) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const k = `${file}|${fromMs}|${fallback ?? ''}`;
  let c = tails.get(k);
  if (!c || st.size < c.offset) { c = { offset: 0, seen: new Map(), usd: 0, mtime: 0 }; tails.set(k, c); }
  c.used = now; c.mtime = st.mtimeMs;
  if (st.size > c.offset) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - c.offset), got = fs.readSync(fd, buf, 0, buf.length, c.offset), nl = buf.subarray(0, got).lastIndexOf(10);
      if (nl >= 0) {
        for (const line of buf.subarray(0, nl).toString('utf8').split('\n')) {
          if (!line.includes('"usage"')) continue;
          let j; try { j = JSON.parse(line); } catch { continue; }
          const m = j.message;
          if (j.type !== 'assistant' || !m?.usage || m.model === '<synthetic>') continue;
          if (fromMs && Date.parse(j.timestamp ?? '') < fromMs) continue;
          // a message's usage repeats on each of its content blocks: count it once, at its largest (the last block's)
          const key = (m.id || '') + ':' + (j.requestId || ''), usd = usageUsd(m.usage, m.model, fallback), was = c.seen.get(key) ?? 0;
          if (usd > was) { c.usd += usd - was; c.seen.set(key, usd); }
        }
        c.offset += nl + 1;
      }
    } finally { fs.closeSync(fd); }
  }
  return c;
}
function sweep(now) { for (const [k, c] of tails) if (now - (c.used ?? 0) > IDLE_DROP_MS) tails.delete(k); }

// <projects_dir>/<any>/<sid>.jsonl, remembered once found (a miss is re-looked for at most every 30 s: the CLI writes it after a turn)
const found = new Map(), missed = new Map();
export function transcriptFor(projectsDir, sid, now = Date.now()) {
  if (!projectsDir || !sid) return null;
  const k = projectsDir + '|' + sid, f = found.get(k);
  if (f && fs.existsSync(f)) return f;
  if (now - (missed.get(k) ?? -Infinity) < 30000) return null;
  let dirs = []; try { dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { /* none */ }
  for (const d of dirs) { const t = path.join(projectsDir, d.name, sid + '.jsonl'); if (fs.existsSync(t)) { found.set(k, t); missed.delete(k); return t; } }
  missed.set(k, now);
  return null;
}

/**
 * The live $ of one running Claude run. run: { session_id, started (ms), model?, transcript? } o: { projectsDir, now }
 * -> { usd, estimate: true, mtime (latest transcript write, ms), files } or null (no transcript yet: nothing spent that can be seen).
 */
export function liveRunCost(run, { projectsDir, now = Date.now() } = {}) {
  sweep(now);
  const file = run.transcript || transcriptFor(projectsDir, run.session_id, now);
  if (!file) return null;
  const main = tailUsd(file, run.started, run.model, now);
  if (!main) return null;
  let usd = main.usd, mtime = main.mtime, files = 1;
  const dir = path.join(file.replace(/\.jsonl$/, ''), 'subagents');
  let names = []; try { names = fs.readdirSync(dir).filter(x => /^agent-.+\.jsonl$/.test(x)); } catch { /* no subagents */ }
  for (const x of names) { const s = tailUsd(path.join(dir, x), run.started, run.model, now); if (s) { usd += s.usd; mtime = Math.max(mtime, s.mtime); files++; } }
  return { usd, estimate: true, mtime, files };
}
