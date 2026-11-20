// META-TEND P6 (REPORT s.5.0-5.1): the "Guard" overview - a QUERY over the advisory records every phase already makes (Instructions
// P1 / P3 / P5, Tests, the model advice of P4) and SloppaChoppa's open BLOCK findings. It owns no data: counts per type, the trend
// (the open findings by the day each was first seen, advisory.mjs crossings), the rule ledger summary, and per row the tab that fixes it.
// Pure: the server hands in the views it already builds. Node built-ins only.
import { createHash } from 'node:crypto';
import { CHECKS } from './instrchecks.mjs';
import { HINT_FIX, TIGHTEN_FIX } from './instructions.mjs';
import { ADVICE_FIX } from './advice.mjs';

/** [type, label, the tab that owns it] in display order */
export const GUARD_TYPES = [['code', 'code', 'runs'], ['tests', 'tests', 'tests'], ['instructions', 'instruction files', 'context'],
  ['memory', 'memory', 'context'], ['rules', 'rules', 'context'], ['docs', 'docs', 'docs'], ['models', 'models', 'usage']];
const SEV_RANK = { high: 0, medium: 1, low: 2, count: 3 };
/** warn level or above: only these warn (the badge, a pop-up); low and count rows are listed, never announced */
export const WARNS = s => s === 'high' || s === 'medium';
const hash = s => createHash('sha1').update(s).digest('hex').slice(0, 10);
const fwd = p => String(p ?? '').replace(/\\/g, '/').toLowerCase();
const RULE_KEY = /^(rule-|enforcement-)/;
// META-UX-BUILD S5 (REPORT s.3): every row carries the kind of fix its check DECLARED (advisory fix.kind, HINT_FIX, TIGHTEN_FIX,
// ADVICE_FIX, SLOP_FIX), its two ways for "your call", and its batch = check + kind; the batch's title is the check's name.
/** SloppaChoppa's open BLOCK findings (norn slop check): fixed on the branch or waived - the owner's call */
export const SLOP_FIX = { kind: 'call', ways: ['Fix it on the branch', 'Waive it (norn rec add waiver)'], title: 'Code checks hold a branch' };
/** META-DOD 2: a refused call - the brief was too narrow (widen Scope) or the guard did its job (leave it) - the owner's call */
export const SCOPE_FIX = { kind: 'call', ways: ['Widen the brief Scope and resume', 'Leave it refused'], title: 'Norn refused a call outside the run scope' };
/** the batch title of the advisory checks that are not instruction-file checks (those use CHECKS' title) */
const BATCH_TITLE = { 'rule-several-homes': 'A rule with several homes', 'rule-drift-claim': 'Says it is enforced, nothing enforces it', 'rule-drift-policy': 'A policy line differs from Settings',
  'rule-path-unknown': 'A rule names a path git never had', 'rule-drift-path': 'A rule points at code that is gone', 'enforcement-unexplained': 'Hooks and gates no rule explains',
  'rule-repeated': 'Said again: a repeated correction', 'tests-no-new-coverage': 'A test file adds no coverage', 'tests-copy-paste': 'Copy-pasted tests',
  'tests-suite-slower': 'The suite got slower', 'audit-hunk': 'An audit hunk to accept', 'audit-watch': 'After an applied audit hunk', 'never-read': 'Files no session reads' };
const fixOf = (key, f, title) => ({ kind: f.kind, ...(f.kind === 'call' ? { ways: [...f.ways] } : {}), batch: `${key}|${f.kind}`, title });

/** the type of one Instructions advisory: memory (checks 1, 3-6), rules (P3), else instruction files */
export function insType(a) {
  if (a.phase === 'P3' || RULE_KEY.test(a.key)) return 'rules';
  return CHECKS[a.check]?.family === 'memory' ? 'memory' : 'instructions';
}

/**
 * guardRows({ ins, tests, advice, holds, docs }) -> rows [{ id, type, severity, surface, path, line, why, source, action, go }]
 * ins = instructionsView (findings + rules.advisories), tests = testsView, advice = adviceOf (cards), holds = [{ branch, run, lane,
 * blocks }] (slop holds with their OPEN blocks), refusals = scope.mjs refusals (META-DOD 2), docs = the project's docs list [{ i, path }]. go = where it is fixed: { tab, ins?,
 * line?, doc?, jump? }. A finding on a file the Docs tab lists is a docs row (fixed there).
 */
export function guardRows({ ins = null, tests = null, advice = null, holds = [], refusals = [], docs = [] } = {}) {
  const out = [], docAt = new Map(docs.map(d => [fwd(d.path), d.i]));
  const rowOf = a => a.row || (ins?.rows || []).find(r => fwd(r.path) === fwd(a.path))?.id || null;
  // META-UX-BUILD S6 (REPORT s.7): a row on one of the owner's own files (the scan's machine_only rows) says so - Fix all never ticks it for him
  // Norn's own prompts (norn_file: the engine's, shared by every project) are offered the same way: never ticked by a project's Fix all
  const own = new Set((ins?.rows || []).filter(r => r.machine_only || r.norn_file).map(r => fwd(r.path).toLowerCase()));
  const ownerOf = x => (x.owner_file === true || (x.path && own.has(fwd(x.path).toLowerCase())) ? { owner_file: true } : {});
  const seen = new Set();
  for (const a of [...(ins?.findings || []), ...(ins?.rules?.advisories || [])]) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    const doc = a.path ? docAt.get(fwd(a.path)) : undefined, row = rowOf(a);
    const type = doc !== undefined ? 'docs' : insType(a);
    const check = /^instr-c\d+$/.test(a.key) ? CHECKS[a.check] : null;
    out.push({ id: a.id, type, severity: a.severity, surface: a.surface, path: a.path, line: a.line, why: a.why, source: a.source, action: a.fix?.action ?? null,
      ...fixOf(a.key, a.fix, check?.title ?? BATCH_TITLE[a.key] ?? a.surface), ...(a.fix?.patch ? { patch: true } : {}), ...ownerOf(a),
      go: doc !== undefined ? { tab: 'docs', doc } : row ? { tab: 'docs', ins: row, ...(a.line ? { line: a.line } : {}) } : { tab: 'context', sub: 'checks' } });
  }
  // the lint's hints and the tightening candidates of the same scan (META-UX-BUILD S5: they moved here from Context's checks page)
  for (const h of ins?.hints || []) {
    const f = HINT_FIX[h.kind];
    out.push({ id: 'H-' + hash(`${h.kind}|${fwd(h.path)}|${h.line}|${h.text}`), type: 'instructions', severity: 'low', surface: `hint: ${h.kind}`, path: h.path, line: h.line, why: String(h.text).slice(0, 300),
      source: 'norn instructions (lint, read-only)', action: null, ...fixOf(`hint-${h.kind}`, f, f.title), ...ownerOf(h), go: { tab: 'docs', ins: h.id, ...(h.line ? { line: h.line } : {}) } });
  }
  for (const x of ins?.suggest || []) {
    const f = TIGHTEN_FIX[x.class], row = x.path ? rowOf({ path: x.path }) : null;
    out.push({ id: 'T-' + x.id, type: 'instructions', severity: 'low', surface: `tighten: ${x.class} · ~${x.saved_per_day} tokens / day`, path: x.path, line: x.line, why: `${x.why}: "${String(x.head ?? '').slice(0, 120)}"`.slice(0, 300),
      source: 'norn instructions suggest (read-only)', action: x.action, ...fixOf(`tighten-${x.class}`, f, f.title), ...(x.patch ? { patch: String(x.patch), apply: x.id } : {}), ...ownerOf(x),   // the patch + its apply id (Context's Tighten card showed both)
      go: row ? { tab: 'docs', ins: row, ...(x.line ? { line: x.line } : {}) } : { tab: 'context', sub: 'role' } });
  }
  for (const a of tests?.advisories?.list || [])
    out.push({ id: a.id, type: 'tests', severity: a.severity, surface: a.surface, path: a.path, line: a.line, why: a.why, source: a.source, action: a.fix?.action ?? null,
      ...fixOf(a.key, a.fix, BATCH_TITLE[a.key] ?? a.surface), go: { tab: 'tests', sub: 'costs' } });
  for (const c of (advice?.cards || []).filter(x => !x.decided))
    out.push({ id: 'M-' + c.key, type: 'models', severity: c.severity, surface: `class ${c.id}`, path: null, line: null, why: c.title, source: c.source?.ref ?? c.source ?? null,
      action: c.fix ?? null, cls: c.id, ...fixOf('model-advice', ADVICE_FIX, 'Model advice for a class of work'), go: { tab: 'usage', jump: 'usage-advice' } });
  for (const h of holds) for (const b of h.blocks || [])
    out.push({ id: 'S-' + b.fp, type: 'code', severity: 'high', surface: `branch ${h.branch}`, path: b.file, line: b.line ?? null, why: `${b.rule}: ${b.msg}`,
      source: 'SloppaChoppa (norn slop check)', action: 'fix it on the branch, or waive it (norn rec add waiver)', run: h.run ?? null, ...fixOf('slop-block', SLOP_FIX, SLOP_FIX.title),
      go: { tab: 'slop', jump: 'slop-S-' + b.fp } });   // its own Slop row (an ended run is on no live Runs view)
  // META-DOD 2: a call Norn's scope hook refused (scope.mjs refusals: the run, its tool, the target, the plain reason)
  for (const r of refusals)
    out.push({ id: 'R-' + hash(`${r.run}|${r.tool}|${r.target}|${r.why}`), type: 'code', severity: 'medium', surface: `run ${r.run}${r.lane ? ' · ' + r.lane : ''} · ${r.tool}`, path: null, line: null,
      why: `refused: ${r.why}`.slice(0, 300), source: 'Norn scope hook (norn scope check)', action: 'widen the brief Scope and resume the run, or leave it refused', run: r.run,
      ...fixOf('scope-refusal', SCOPE_FIX, SCOPE_FIX.title), go: { tab: 'slop', jump: 'slop-R-' + hash(`${r.run}|${r.tool}|${r.target}|${r.why}`) } });
  return out;
}

/** the order rows are read in (and the one best action is picked from): warn level first (a low row never outranks a warning, new or
 * not), then new first, then severity, then type order */
export function rankRows(rows) {
  const t = Object.fromEntries(GUARD_TYPES.map(([k], i) => [k, i]));
  return [...rows].sort((a, b) => WARNS(b.severity) - WARNS(a.severity) || (b.new === true) - (a.new === true) || SEV_RANK[a.severity] - SEV_RANK[b.severity] || t[a.type] - t[b.type] || String(a.id).localeCompare(String(b.id)));
}

const DAY = 86400000, dayOf = ms => new Date(ms).toISOString().slice(0, 10);
/**
 * guardView(rows with first_seen / new (crossings), { rules (the rule ledger counts), now, days = 30 }) ->
 * { types: [{ type, label, tab, open, warn, new }], rows (ranked), trend: { days, series: [{ key, label, points }] }, ledger, total, new }
 * The trend counts, per type and day, the findings open now that were first seen on or before that day: how the open pile grew.
 */
export function guardView(rows, { rules = null, now = Date.now(), days = 30, slop = true } = {}) {
  const ranked = rankRows(rows);
  // META-BETA-PREP (DIR-52): the project's SloppaChoppa switch off = no code (slop) type in the counts
  const types = GUARD_TYPES.filter(([type]) => slop || type !== 'code').map(([type, label, tab]) => {
    const r = rows.filter(x => x.type === type);
    return { type, label, tab, open: r.length, warn: r.filter(x => WARNS(x.severity)).length, new: r.filter(x => x.new && WARNS(x.severity)).length };
  });
  const axis = Array.from({ length: days }, (_, i) => dayOf(now - (days - 1 - i) * DAY));
  const series = GUARD_TYPES.filter(([type]) => rows.some(x => x.type === type)).map(([type, label]) => {
    const firsts = rows.filter(x => x.type === type).map(x => (x.first_seen ? x.first_seen.slice(0, 10) : axis.at(-1)));
    return { key: type, label, points: axis.map(d => ({ x: d, y: firsts.filter(f => f <= d).length })) };
  });
  return { types, rows: ranked, trend: { days: axis, series }, ledger: rules ? { ...rules } : null, total: rows.length, new: types.reduce((n, t) => n + t.new, 0) };
}
