// META-TEND P5 (REPORT 3.3): the model-assisted audit - a run of kind `audit` whose prompt is Claude Code's own vendor audit
// (`/doctor prompt-audit <scope>`: it runs headless under claude -p, tested 2026-11-14 on 2.1.314) over ONE project's steering
// files, launched read-only (no shell, no edit tools). Its report + proposed diff (the run's final message, kept as the run's notes
// file) become advisory records, one per hunk, and approval cards: accept = a decision + a directive asking the check-in to apply
// the hunk; decline = a decision. Nothing edits a steering file by itself.
// Triggers are events, never a calendar: never audited, a model change in policy, a harness update, a repeated correction naming a
// written rule (P3), a steering file past its budget or grown by a third since the last audit. Watch after apply: the next runs
// after an accepted hunk are watched for the failure it might cause. Stop rule (REPORT 6): the triggers stay manual unless the
// first two audits each yielded 3+ accepted hunks. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import { readJsonS, readText as readTextS } from './fsnap.mjs';
import { createHash } from 'node:crypto';
import { advisory } from './advisory.mjs';

export const AUDIT_CMD = '/doctor prompt-audit';
export const AUDIT_MODEL = 'claude-opus-5-5', AUDIT_EFFORT = 'high';   // REPORT 3.3: Opus at high, not xhigh
export const AUDIT_BUDGET_TOKENS = 3000;   // a file every session (or a role) loads, past this = a trigger
export const WATCH_RUNS = 5;
export const STOP_RULE_MIN = 3;
const SOURCE = 'REPORT meta-practice s.3.3 (the vendor prompt audit: /doctor prompt-audit)';
const fwd = p => String(p ?? '').replace(/\\/g, '/');
const under = (f, d) => !!d && (fwd(f).toLowerCase() + '/').startsWith(fwd(d).replace(/\/+$/, '').toLowerCase() + '/');
// META-DASH-ASYNC R1: snapshot-aware reads (lib/fsnap.mjs) - the dash primes auditFiles() on fs.promises, the CLI reads sync
const readJson = readJsonS;
const readText = f => { try { return readTextS(f); } catch { return null; } };
export const auditsDir = state => path.join(state, 'audits');

/** the audit's scope: the project's own steering files (in its repo, its project folder, or its memory) - never user-level files */
export function auditScope(rows, p) {
  return rows.filter(r => r.exists && !r.generated && r.load !== 'source' && (under(r.path, p.root) || under(r.path, p.project_dir) || r.kind === 'memory' || r.kind === 'memory-topic'))
    .map(r => fwd(r.path));
}
/** the run's prompt: the vendor command, the scope named (a request that names files = the scope, Step 0) */
export const auditPrompt = files => [AUDIT_CMD, ...files.map(f => (/\s/.test(f) ? `"${f}"` : f))].join(' ');

/** what a trigger compares: every policy key that names a model, the harness version, the size of each scoped file */
export function policyModels(policy, pre = '', out = {}) {
  for (const [k, v] of Object.entries(policy || {})) {
    const key = pre ? `${pre}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) policyModels(v, key, out);
    else if (/model$/i.test(k) && typeof v === 'string' && v) out[key] = v;
  }
  return out;
}
export function auditStamp(p, rows, { machine = null, now = Date.now(), run = null } = {}) {
  return { at: new Date(now).toISOString(), run, models: policyModels(p.policy), harness: machine?.claude?.version ?? null,
    sizes: Object.fromEntries(rows.filter(r => r.exists).map(r => [fwd(r.path).toLowerCase(), r.tokens])) };
}
export function writeStamp(state, stamp) {
  const f = path.join(auditsDir(state), 'stamp.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(stamp, null, 1)); fs.renameSync(tmp, f);
}
/** META-DASH-ASYNC R1: the files auditsView reads (the stamp + each audit run's notes), for the dash to prime */
export const auditFiles = (p, items) => [path.join(auditsDir(p.state), 'stamp.json'), ...Object.values(items).filter(i => i.kind === 'run' && i.data?.kind === 'audit' && i.data?.lane !== 'fixall' && i.data?.notes).map(r => r.data.notes)];
export const readStamp = state => (state ? readJson(path.join(auditsDir(state), 'stamp.json')) : null);

/** -> [{ key, why }]: the events that call for an audit now (empty = none) */
export function auditTriggers(p, { rows = [], cards = [], machine = null, stamp = null } = {}) {
  const out = [];
  if (!stamp) out.push({ key: 'never', why: 'this project was never audited (an adopted project gets one)' });
  else {
    const now = policyModels(p.policy), was = stamp.models || {};
    const moved = [...new Set([...Object.keys(now), ...Object.keys(was)])].filter(k => now[k] !== was[k]).sort();
    if (moved.length) out.push({ key: 'model', why: `a model changed in policy: ${moved.map(k => `${k} ${was[k] ?? '(none)'} -> ${now[k] ?? '(none)'}`).join(', ')}` });
    const v = machine?.claude?.version;
    if (v && stamp.harness && v !== stamp.harness) out.push({ key: 'harness', why: `the harness was updated: Claude Code ${stamp.harness} -> ${v}` });
  }
  for (const c of cards.filter(x => x.rule)) out.push({ key: 'repeat', why: `a repeated correction names a rule already written (${c.id}): ${c.why}`.slice(0, 300) });
  for (const r of rows.filter(x => x.exists && !x.generated && ['session', 'checkin', 'chat', 'role'].includes(x.load))) {
    const was = stamp?.sizes?.[fwd(r.path).toLowerCase()];
    if (r.tokens > AUDIT_BUDGET_TOKENS) out.push({ key: 'budget', why: `${path.posix.basename(fwd(r.path))} loads ${r.load === 'session' ? 'every session' : `per ${r.load}`} at ~${r.tokens} tokens (budget ${AUDIT_BUDGET_TOKENS})` });
    else if (was && r.tokens > was * 4 / 3) out.push({ key: 'grown', why: `${path.posix.basename(fwd(r.path))} grew by more than a third since the last audit (~${was} -> ~${r.tokens} tokens)` });
  }
  return out;
}

// ---------- the vendor report -> findings + hunks ----------
const FIND_RE = /^#{2,5}\s*(?:(\d+)\.\s*)?`([^`]+?)(?::(\d+)(?:-(\d+))?)?`\s*[-–—:]+\s*(high|medium|low)\b[^\n]*?(?:[-–—:]+\s*`?(remove|rewrite|move|replace-with-api-feature|add|flag)`?)?\s*$/i;
const ACTIONS = /\b(remove|rewrite|move|replace-with-api-feature|add|flag)\b/i;
/** findings as a table (a header with Location + Conf columns): row # = n; the file from a backticked path in the cell, else from the
 *  heading "file is `X` unless noted"; line = the cell's first number, end = its last */
function tableFindings(t) {
  const out = [], ls = t.split('\n'), cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  for (let i = 0; i < ls.length; i++) {
    if (!/^\s*\|/.test(ls[i])) continue;
    const hd = cells(ls[i]).map(c => c.toLowerCase()), loc = hd.findIndex(c => c.startsWith('location')), conf = hd.findIndex(c => c.startsWith('conf'));
    if (loc < 0 || conf < 0) continue;
    const act = hd.findIndex(c => c.startsWith('action')), pat = hd.findIndex(c => c.startsWith('pattern')), num = hd.findIndex(c => c === '#' || c === 'n' || c === 'no.');
    const def = ls.slice(0, i).reverse().find(l => /^#{1,6}\s/.test(l))?.match(/file is `([^`]+)`/i)?.[1] ?? null;
    for (i += 2; i < ls.length && /^\s*\|/.test(ls[i]); i++) {
      const c = cells(ls[i]), cf = String(c[conf] ?? '').match(/\b(high|medium|low)\b/i);
      if (!cf) continue;
      const cell = String(c[loc] ?? ''), bt = cell.match(/`([^`:]+)(:[^`]*)?`/), nums = (bt ? bt[2] ?? '' : cell).match(/\d+/g) || [];
      const file = bt ? fwd(bt[1]) : def ? fwd(def) : null, n = num >= 0 ? Number(String(c[num]).match(/\d+/)?.[0]) || null : null;
      const line = nums.length ? Number(nums[0]) : null, end = nums.length ? Number(nums[nums.length - 1]) : null;
      const where = `${file ?? '?'}${line ? `:${line}${end !== line ? `-${end}` : ''}` : ''}`;
      out.push({ n, file, line, end, confidence: cf[1].toLowerCase(), action: act >= 0 ? String(c[act]).match(ACTIONS)?.[1].toLowerCase() ?? null : null,
        title: `${n ? `${n}. ` : ''}${where} - ${pat >= 0 ? c[pat].replace(/\*\*/g, '') : ''} - ${cf[1]}` });
    }
    i--;
  }
  return out;
}
/** the report's Step 5 findings ([{ file, line, end, confidence, action, title }]) and the Step 6 diff split into hunks */
export function parseAudit(text) {
  const t = String(text ?? '').replace(/\r\n/g, '\n'), findings = [], hunks = [];
  for (const l of t.split('\n')) {
    const m = l.match(FIND_RE);
    if (m) findings.push({ n: m[1] ? Number(m[1]) : null, file: fwd(m[2]), line: m[3] ? Number(m[3]) : null, end: m[4] ? Number(m[4]) : m[3] ? Number(m[3]) : null, confidence: m[5].toLowerCase(), action: m[6]?.toLowerCase() ?? null, title: l.replace(/^#+\s*/, '').trim() });
  }
  findings.push(...tableFindings(t));
  for (const blk of t.matchAll(/```(?:diff|patch)\n([\s\S]*?)```/g)) {
    // a block with no ---/+++ lines: its file is the backticked path in the nearest heading before it
    const body = blk[1], hf = [...t.slice(0, blk.index).matchAll(/^#{1,6}[^\n]*$/gm)].pop()?.[0].match(/`([^`]+)`/)?.[1];
    let head = hf ? { from: `--- a/${fwd(hf)}`, to: `+++ b/${fwd(hf)}`, file: fwd(hf) } : null, cur = null;
    const flush = () => {
      if (cur && head) {
        if (cur.loose) { // "@@ F<n> :<a>-<b>" -> a unified header, the counts from the lines
          const c = re => cur.lines.slice(1).filter(x => re.test(x)).length;
          cur.count = c(/^[- ]/); cur.lines[0] = `@@ -${cur.line},${cur.count} +${cur.line},${c(/^[+ ]/)} @@ F${cur.fn}`; delete cur.loose;
        }
        hunks.push({ ...cur, patch: [head.from, head.to, ...cur.lines].join('\n') + '\n' });
      }
      cur = null;
    };
    const ls = body.replace(/\n$/, '').split('\n');
    for (let i = 0; i < ls.length; i++) {
      const l = ls[i];
      if (l.startsWith('--- ') && ls[i + 1]?.startsWith('+++ ')) { flush(); const to = ls[++i]; head = { from: l, to, file: fwd(to.slice(4).replace(/^b\//, '').trim() === '/dev/null' ? l.slice(4).replace(/^a\//, '') : to.slice(4).replace(/^b\//, '')).trim() }; continue; }
      const h = l.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/);
      if (h && head) { flush(); cur = { file: head.file, line: Number(h[1]), count: h[2] === undefined ? 1 : Number(h[2]), fn: Number(l.match(/@@\s+F(\d+)\b/)?.[1]) || null, lines: [l] }; continue; }
      const lh = l.match(/^@@\s*F(\d+)\s*:(\d+)/);
      if (lh && head) { flush(); cur = { file: head.file, line: Number(lh[2]), count: 1, fn: Number(lh[1]), loose: true, lines: [l] }; continue; }
      if (cur) cur.lines.push(l);
    }
    flush();
  }
  const base = f => f.toLowerCase().split('/').pop();
  for (const h of hunks) {
    const cand = findings.filter(f => f.file && (f.file.toLowerCase() === h.file.toLowerCase() || f.file.toLowerCase().endsWith('/' + h.file.toLowerCase()) || h.file.toLowerCase().endsWith('/' + f.file.toLowerCase()) || base(f.file) === base(h.file)));
    const dist = f => (f.line ? Math.max(0, f.line - (h.line + Math.max(h.count, 1) - 1), h.line - (f.end ?? f.line)) : Infinity);
    h.finding = (h.fn && findings.find(f => f.n === h.fn)) || cand.filter(f => dist(f) <= 2).sort((x, y) => dist(x) - dist(y))[0] || (cand.length === 1 ? cand[0] : null);
    h.removed = h.lines.filter(x => x.startsWith('-')).map(x => x.slice(1)).join('\n');
  }
  return { findings, hunks };
}

// ---------- the audit runs, their hunks as advisories + cards, the stop rule, the watch ----------
const WORDS = s => new Set(String(s ?? '').toLowerCase().match(/[a-z][a-z0-9-]{4,}/g) || []);
const overlap = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };
const resolveIn = (f, p) => (/^[a-z]:\/|^\//i.test(f) ? f : fwd(path.join(p.root || '.', f)));
/** the approval card's directive (accept): the check-in applies the hunk; Norn edits nothing */
export const acceptText = a => `Apply audit hunk (advisory ${a.id}, audit ${a.run}) to ${a.path}: ${a.why} Patch:\n${String(a.fix.patch).slice(0, 3000)}\n- apply it as one commit; the next ${WATCH_RUNS} runs are watched for the failure it might cause.`;

/** one audit run (a records fold item) -> its hunks as advisories with status open | accepted | declined (+ decided, decision) */
export function auditHunks(run, p, items) {
  const text = run.data?.notes ? readText(run.data.notes) : null;
  if (!text) return [];
  const dec = Object.values(items).filter(i => i.kind === 'decision' && i.data?.lane === 'audit' && i.data?.advisory);
  return parseAudit(text).hunks.map(h => {
    const f = h.finding, sev = f && f.confidence !== 'low' ? f.confidence : 'medium';
    const a = advisory({ phase: 'P5', check: '3.3', key: 'audit-hunk', severity: sev, surface: 'audit hunk', path: resolveIn(h.file, p), line: h.line,
      subject: createHash('sha1').update(h.patch).digest('hex').slice(0, 12),
      why: `${f ? f.title : `a hunk at ${h.file}:${h.line}`}`.replace(/\s+/g, ' ').slice(0, 290), source: `${SOURCE}, audit ${run.id}`,
      fix: { tier: 'card', action: 'accept = a decision + a directive: the check-in applies this hunk; decline = keep the text', patch: h.patch, kind: 'ready' } });
    const d = dec.filter(x => x.data.advisory === a.id).sort((x, y) => String(y.created).localeCompare(String(x.created)))[0];
    const status = !d ? 'open' : /^accepted/.test(String(d.data.choice ?? '')) ? 'accepted' : 'declined';
    return { ...a, run: run.id, removed: h.removed, status, decided: d?.created ?? null, decision: d?.id ?? null };
  });
}
/** after an accepted hunk: the next WATCH_RUNS runs - one that stopped / crashed, or a correction that names the removed text = an alarm */
export function watchAfter(hunk, items) {
  if (hunk.status !== 'accepted' || !hunk.decided) return null;
  const t = hunk.decided, gone = WORDS(hunk.removed);
  const next = Object.values(items).filter(i => i.kind === 'run' && String(i.created) > t && !['audit', 'checkin'].includes(i.data?.kind)).sort((a, b) => String(a.created).localeCompare(String(b.created))).slice(0, WATCH_RUNS);
  const alarms = [];
  for (const r of next) if (['stopped', 'crash'].includes(r.end?.outcome)) alarms.push({ id: r.id, why: `${r.id} ${r.end.outcome}${r.end.why ? `: ${r.end.why}` : ''}` });
  for (const c of Object.values(items).filter(i => (i.kind === 'directive' || (i.kind === 'decision' && i.state === 'overruled')) && String(i.created) > t)) {
    const txt = c.kind === 'directive' ? c.data?.text : c.overrule?.text ?? c.data?.why;
    if (c.kind === 'directive' && String(txt ?? '').includes(hunk.id)) continue;   // the accept directive itself
    if (gone.size && overlap(WORDS(txt), gone) >= 3) alarms.push({ id: c.id, why: `${c.id} names the removed text: "${String(txt).replace(/\s+/g, ' ').slice(0, 120)}"` });
  }
  return { seen: next.length, of: WATCH_RUNS, alarms, done: next.length >= WATCH_RUNS };
}
/** the stop rule over the audits (oldest first): manual until the first two audits are fully decided with 3+ accepted hunks each */
export function stopRule(audits) {
  const first = audits.filter(a => a.outcome === 'done').slice(0, 2);
  const decided = first.filter(a => a.hunks.length > 0 ? a.hunks.every(h => h.status !== 'open') : true);
  if (first.length < 2 || decided.length < 2) return { mode: 'manual', why: `triggers stay manual: ${first.length < 2 ? `${first.length} of the first 2 audits ran` : 'the first 2 audits still have open hunks'} (stop rule: 3+ accepted hunks each)` };
  const acc = first.map(a => a.hunks.filter(h => h.status === 'accepted').length);
  return acc.every(n => n >= STOP_RULE_MIN) ? { mode: 'auto', why: `the first 2 audits yielded ${acc.join(' and ')} accepted hunks: the triggers may start audits` }
    : { mode: 'manual', why: `triggers stay manual: the first 2 audits yielded ${acc.join(' and ')} accepted hunks (stop rule: 3+ each)` };
}
/** the Audits view: { runs [{ id, created, state, outcome, scope, hunks, accepted, declined, open, watch }], cards (open hunks), advisories (watch alarms), triggers, rule, command } */
export function auditsView(p, items, { rows = [], cards = [], machine = null } = {}) {
  const runs = Object.values(items).filter(i => i.kind === 'run' && i.data?.kind === 'audit' && i.data?.lane !== 'fixall').sort((a, b) => String(a.created).localeCompare(String(b.created)));
  const audits = runs.map(r => {
    const hunks = auditHunks(r, p, items).map(h => ({ ...h, watch: watchAfter(h, items) }));
    const n = s => hunks.filter(h => h.status === s).length;
    return { id: r.id, created: r.created, state: r.state, outcome: r.end?.outcome ?? null, notes: r.data.notes ?? null, hunks, accepted: n('accepted'), declined: n('declined'), open: n('open') };
  });
  const advisories = audits.flatMap(a => a.hunks.filter(h => h.watch?.alarms.length).map(h => advisory({ phase: 'P5', check: '3.3', key: 'audit-watch', severity: 'medium', surface: 'audit hunk', path: h.path, line: h.line, subject: h.id,
    why: `after hunk ${h.id} (${h.decision}): ${h.watch.alarms.map(x => x.why).join('; ')}`.slice(0, 300), source: `${SOURCE}, watch after apply`, fix: { tier: 'card', action: 'read the run / correction; if the hunk caused it, revert the hunk', kind: 'call', ways: ['Revert the hunk', 'Keep it'] } })));
  return { runs: audits.map(({ hunks, ...a }) => ({ ...a, watch: hunks.filter(h => h.watch).map(h => ({ id: h.id, ...h.watch })) })),
    cards: audits.flatMap(a => a.hunks.filter(h => h.status === 'open')), advisories,
    triggers: auditTriggers(p, { rows, cards, machine, stamp: readStamp(p.state) }), rule: stopRule(audits),
    command: `norn audit start --project ${p.name}` };
}
