// NORN-DASH-1123 item 8 (SPEC 8): Slop > Rules' Linters section as data. Per tool of TOOLS (tools.mjs): its pinned version and lock hash
// (tools/<set>/package.json + package-lock.json, the hash toolHome installs under), the lint rules (kind: lint) that run it, their ESLint
// rules by level (levels + shadow_rules; '*' = every other rule), the open findings of those rules (rule <id> or <id>/<sub>) and the
// could-not-run findings with their why. Built from what the code already holds: nothing new is stored. Node built-ins only.
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TOOLS } from './tools.mjs';
import { loadRules } from './check.mjs';
import { readText } from '../fsnap.mjs';

const TOOL_SETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tools');
const CNR = 'could not run: ';
const LEVELS = ['BLOCK', 'WARN', 'shadow'];
const json = f => { try { return JSON.parse(readText(f) ?? 'null'); } catch { return null; } };
// '*' (every other rule) last, the named rules by name
const order = xs => [...new Set(xs)].sort((a, b) => (a === '*') - (b === '*') || a.localeCompare(b));

/** lintersView(guard rows, { rules }) -> { tools: [{ tool, set, version, lock, rules: [id], levels: { BLOCK, WARN, shadow }, open: { n, by: { sub: n }, ids }, could_not_run: [{ id, rule, why, branch }] }] } */
export function lintersView(rows = [], { rules = loadRules() } = {}) {
  const tools = Object.entries(TOOLS).map(([tool, t]) => {
    const mine = rules.filter(r => r.kind === 'lint' && r.tool === tool), ids = mine.map(r => r.id);
    const lock = readText(path.join(TOOL_SETS, t.set, 'package-lock.json'));
    const levels = Object.fromEntries(LEVELS.map(l => [l, order(mine.flatMap(r => (l === 'shadow' ? r.shadow_rules || [] : Object.entries(r.levels || {}).filter(([, v]) => v === l).map(([k]) => k))))]));
    const ofTool = rows.filter(r => r.rule && ids.some(id => r.rule === id || r.rule.startsWith(id + '/')));
    const cnr = ofTool.filter(r => String(r.msg ?? '').startsWith(CNR)), open = ofTool.filter(r => !cnr.includes(r)), by = {};
    for (const r of open) { const sub = r.rule.split('/').slice(1).join('/') || r.rule; by[sub] = (by[sub] || 0) + 1; }
    return { tool, set: t.set, version: json(path.join(TOOL_SETS, t.set, 'package.json'))?.dependencies?.[tool] ?? null,
      lock: lock === null ? null : crypto.createHash('sha256').update(lock).digest('hex').slice(0, 12), rules: ids, levels,
      open: { n: open.length, by, ids: open.map(r => r.id) }, could_not_run: cnr.map(r => ({ id: r.id, rule: r.rule, why: r.msg.slice(CNR.length), branch: r.branch ?? null })) };
  });
  return { tools };
}
