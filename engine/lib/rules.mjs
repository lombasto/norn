// META-TEND P3 (REPORT s.5.0, s.3.6, s.5.3 view 6): the rule ledger. Every "must" / "never" line of the instruction files (repo files,
// rules folders, skills, agents, prompts, memory) and of the active owner directives is a rule with an id, ONE declared home (other
// copies = a "several homes" finding), its enforcement (hook, deny rule, test, lint, gate, or prose only - by choice when the line
// says `<!-- prose-only -->`) linked to the real file, and when that enforcement last fired where a record of it exists (CI runs, the
// slop / tests check reports; null = unknown, said plainly). The repeat detector clusters the same correction said 2-3+ times
// (directives, overruled decisions, feedback memories) into ONE ranked approval card with a drafted enforcement; Norn never installs
// a hook, test or gate itself. Drift: a rule that names a hook none of which exists, a policy-generated line the policy now
// contradicts, a rule pointing at a path that is gone. State per rule: prose -> repeated (n) -> enforced -> retired (gone from the
// files since a remembered scan: <state>/instructions/rules.json, a cache, not a record). Every finding is an advisory record.
// Pure text / file reads; Node built-ins only.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { advisory } from './advisory.mjs';
import { frontOf } from './instrchecks.mjs';
import { generatedLines, withDefaults } from './policy.mjs';
import { readText, readTextA } from './fsnap.mjs';

const fwd = p => String(p).replace(/\\/g, '/');
const lc = p => (process.platform === 'win32' ? fwd(p).toLowerCase() : fwd(p));
// a missing file is none; a corrupt one throws (rules.json read as none would be written over, the retired list lost)
const readJson = f => { const t = readText(f); return t === null ? null : JSON.parse(t); };
const sha = s => createHash('sha1').update(s).digest('hex');
const RULE_RE = /\b(?:must|never)\b/i;
const MARK_RE = /<!--\s*policy:([a-z_.]+)\s*-->/;
const PROSE_RE = /<!--\s*prose-only\s*-->/i;
const CLAIM_RE = /\b(?:enforced|a hook|the hook|hooks? (?:blocks?|stops?|refuses?)|deny rule|pre-commit|commit-msg)\b/i;
const REPEAT_RE = /\b(?:again|still|already|twice|i said|i told|once more|repeat(?:ed|edly)?)\b/i;
const STOP = new Set('the and for with that this from into onto your their there them they have has had are was were will would should could than then when what which while been being only also each every never must always not dont does done just more most less such some same other over under about after before very like into here where make made using used use can its our out per via any all one two'.split(' '));
const words = s => String(s).toLowerCase().match(/[a-z0-9]+/g) || [];
const content = s => new Set(words(s).filter(x => x.length >= 4 && !STOP.has(x)).map(x => x.replace(/(?:ing|ed|es|s)$/, '')));
const jac = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return { n, j: n / ((a.size + b.size - n) || 1) }; };
const clean = l => l.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();
const proseLines = text => { let fence = false; const out = []; String(text).split(/\r?\n/).forEach((t, i) => { if (/^\s*(```|~~~)/.test(t)) { fence = !fence; return; } if (!fence) out.push({ n: i + 1, text: t }); }); return out; };
// the declared home: the root instruction files first, then rules, prompts, skills / agents, user files, memory, directives last
const HOME_RANK = { repo: 0, import: 1, rule: 2, rules: 2, checkin_extra: 3, prompt: 3, agent: 4, skill: 4, user: 5, memory: 6, 'memory-topic': 7, directive: 8 };
const rank = h => (HOME_RANK[h.kind] ?? (String(h.kind).endsWith('-source') ? 3 : 5));
export const STATES = ['prose', 'repeated', 'enforced', 'retired'];
const SOURCE = 'REPORT meta-practice s.5.0 (the rule ledger)';

/** the rule lines of the hand-written rows + active directives: [{ path, row, kind, line, raw, text }] */
export function ruleLines(rows, items = {}) {
  const out = [];
  for (const r of rows.filter(x => x.exists !== false && !x.generated && x.chars <= 2_000_000 && /\.(md|txt)$/i.test(x.path))) {
    const t = readText(r.path);
    if (t == null) continue;
    const skip = r.kind === 'memory-topic' || r.kind === 'agent' || r.kind === 'rule' ? frontOf(t).end : 0;
    for (const { n, text: l } of proseLines(t)) {
      if (n <= skip || /^\s*#/.test(l) || !(RULE_RE.test(l) || MARK_RE.test(l))) continue;
      // a long line (a status paragraph, a memory note) holds its rule in a sentence: each must / never sentence is a rule
      const parts = l.length > 300 && !MARK_RE.test(l) ? l.split(/(?<=[.!?;])\s+/).filter(x => RULE_RE.test(x)) : [l];
      for (const x of parts) out.push({ path: fwd(r.path), row: r.id ?? null, kind: r.kind, line: n, raw: x, text: clean(x) });
    }
  }
  for (const d of Object.values(items).filter(i => i.kind === 'directive' && i.state === 'active' && RULE_RE.test(i.data?.text || '')))
    out.push({ path: `records:${d.id}`, row: null, kind: 'directive', line: null, raw: d.data.text, text: clean(d.data.text).slice(0, 400) });
  return out.filter(x => x.text.length >= 8);
}

/** the same rule in several lines: a shared 6-word run, or >= 70 % of the content words (>= 4 each) -> groups of line indexes */
function groups(lines) {
  const parent = lines.map((_, i) => i), find = i => (parent[i] === i ? i : (parent[i] = find(parent[i]))), join = (a, b) => { parent[find(a)] = find(b); };
  const sh = new Map(), cs = lines.map(l => content(l.text));
  lines.forEach((l, i) => { const ws = words(l.text); for (let k = 0; k + 6 <= ws.length; k++) { const key = ws.slice(k, k + 6).join(' '); if (sh.has(key)) join(i, sh.get(key)); else sh.set(key, i); } });
  const byWord = new Map();
  cs.forEach((c, i) => { if (c.size >= 4) for (const x of c) { if (!byWord.has(x)) byWord.set(x, []); byWord.get(x).push(i); } });
  cs.forEach((c, i) => { if (c.size < 4) return; const seen = new Set(); for (const x of c) for (const k of byWord.get(x)) if (k > i && !seen.has(k)) { seen.add(k); if (find(k) !== find(i) && jac(c, cs[k]).j >= 0.7) join(i, k); } });
  const g = new Map();
  lines.forEach((_, i) => { const r = find(i); if (!g.has(r)) g.set(r, []); g.get(r).push(i); });
  return [...g.values()];
}

// ---------- what can enforce a rule ----------
const testFile = f => /(?:^|\/)tests?\/|\.test\.|_test\.|(?:^|\/)test_/.test(f);
const LINT_TOOLS = ['clippy', 'eslint', 'ruff', 'markdownlint', 'rustfmt', 'prettier', 'fmt --check'];
/** { hooks, deny, githooks, tests, ci (workflow text), gates } of a project (hook / deny values are matched, never shown) */
export function enforcers(p, { home = '', files = null } = {}) {
  const root = p.root, out = { hooks: [], deny: [], githooks: [], tests: [], ci: '', gates: [] };
  for (const f of [root && path.join(root, '.claude', 'settings.json'), root && path.join(root, '.claude', 'settings.local.json'), home && path.join(home, '.claude', 'settings.json')].filter(Boolean)) {
    const j = readJson(f); if (!j) continue;
    for (const [ev, gs] of Object.entries(j.hooks || {})) (Array.isArray(gs) ? gs : []).forEach(g => (g?.hooks || []).forEach(h => { if (h?.command) out.hooks.push({ kind: 'hook', name: `${ev} hook`, match: String(h.command).toLowerCase(), path: fwd(f) }); }));
    for (const d of j.permissions?.deny || []) { const inner = String(d).replace(/^\w+\((.*)\)$/, '$1').replace(/:?\*+$/, '').trim(); if (inner.length >= 3) out.deny.push({ kind: 'deny', name: `deny ${d}`, match: inner.toLowerCase(), path: fwd(f) }); }
  }
  for (const d of [root && path.join(root, '.githooks'), root && path.join(root, '.git', 'hooks')].filter(Boolean)) {
    let es = []; try { es = fs.readdirSync(d); } catch { /* no hooks folder: nothing enforced from it */ }
    for (const n of es.filter(n => !n.endsWith('.sample'))) out.githooks.push({ kind: 'git-hook', name: `git ${n} hook`, match: n.toLowerCase(), path: fwd(path.join(d, n)) });
  }
  const ls = files ?? [];
  out.tests = ls.filter(x => testFile(x) && /test/i.test(path.posix.basename(x))).map(f => ({ kind: 'test', name: f, match: f.toLowerCase(), base: path.posix.basename(f).toLowerCase(), path: fwd(path.join(root, f)) }));
  out.ci = ls.filter(f => /^\.github\/workflows\/.+\.ya?ml$/.test(f)).map(f => readText(path.join(root, f)) || '').join('\n').toLowerCase();
  // Norn's own gates: a record of each run exists in the state
  const st = p.state;
  out.gates.push({ kind: 'gate', name: 'norn slop check', re: /\bslop[- ]check\b|\bnorn slop\b/i, path: st ? fwd(path.join(st, 'slop', 'report.json')) : null, fired: () => { const j = st && readJson(path.join(st, 'slop', 'report.json')); return j?.at ? { at: j.at, what: 'the daily slop check' } : null; } });
  out.gates.push({ kind: 'gate', name: 'norn tests check', re: /\btests check\b/i, path: st ? fwd(path.join(st, 'tests', 'advisories.json')) : null, fired: () => { const j = st && readJson(path.join(st, 'tests', 'advisories.json')); return j?.at ? { at: j.at, what: 'the last merge tests check' } : null; } });
  return out;
}
/** the newest finished CI run of main (<state>/ci-main.json) -> { at, what } | null */
function ciFired(state) {
  const j = state && readJson(path.join(state, 'ci-main.json'));
  const r = (j?.runs || []).filter(x => x.status === 'completed' && x.createdAt).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  return r ? { at: r.createdAt, what: `the suite in CI: ${r.conclusion}` } : null;
}
/** a rule's text -> its enforcement { kind, target, path, by_choice?, policy? } and fired { at, what } | null */
function enforcementOf(lines, E, p) {
  const raws = lines.map(l => l.raw), low = raws.join('\n').toLowerCase(), ticks = [...low.matchAll(/`([^`\n]{3,})`/g)].map(m => m[1].trim());
  const mark = raws.map(r => r.match(MARK_RE)?.[1]).find(Boolean);
  if (mark) return { e: { kind: 'gate', target: `policy ${mark}`, path: p.project_dir ? fwd(path.join(p.project_dir, 'project.json')) : null, policy: mark }, fired: null };
  const deny = E.deny.find(d => low.includes(d.match));
  if (deny) return { e: { kind: 'deny', target: deny.name, path: deny.path }, fired: null };
  const hook = E.hooks.find(h => ticks.some(t => t.length >= 6 && /[./]/.test(t) && h.match.includes(t)) || (h.match.match(/[\w.-]+\.(?:mjs|js|cjs|ps1|sh|py)\b/g) || []).some(s => low.includes(s)));
  if (hook) return { e: { kind: 'hook', target: hook.name, path: hook.path }, fired: null };
  const gh = E.githooks.find(h => new RegExp(`\\b${h.match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(low));
  if (gh) return { e: { kind: 'git-hook', target: gh.name, path: gh.path }, fired: null };
  const t = E.tests.find(x => ticks.some(k => k.replace(/\\/g, '/').endsWith(x.match) || (x.base.length >= 8 && k.endsWith(x.base))));
  if (t) return { e: { kind: 'test', target: t.name, path: t.path }, fired: ciFired(p.state) };
  const lint = LINT_TOOLS.find(x => low.includes(x) && E.ci.includes(x));
  if (lint) return { e: { kind: 'lint', target: `${lint} in CI`, path: p.root ? fwd(path.join(p.root, '.github', 'workflows')) : null }, fired: ciFired(p.state) };
  const g = E.gates.find(x => x.re.test(low));
  if (g) return { e: { kind: 'gate', target: g.name, path: g.path }, fired: g.fired() };
  return { e: { kind: 'prose', target: null, path: null, ...(raws.some(r => PROSE_RE.test(r)) ? { by_choice: true } : {}) }, fired: null };
}

// ---------- the repeat detector (REPORT 3.6) ----------
/**
 * texts [{ id, text, date? }] -> clusters [{ members, terms, repeat_words }] ranked (size, then repeat words): two texts join when they
 * share >= 3 content words and >= 30 % of them; a cluster counts at 3 members, or at 2 when one of them says again / still / I said.
 */
export function repeats(texts) {
  const cs = texts.map(t => content(t.text)), parent = texts.map((_, i) => i), find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < texts.length; i++) for (let k = i + 1; k < texts.length; k++) { const s = jac(cs[i], cs[k]); if (s.n >= 3 && s.j >= 0.3) parent[find(i)] = find(k); }
  const g = new Map();
  texts.forEach((t, i) => { const r = find(i); if (!g.has(r)) g.set(r, []); g.get(r).push(i); });
  return [...g.values()].map(ix => {
    const members = ix.map(i => texts[i]), rep = members.filter(m => REPEAT_RE.test(m.text)).length;
    const count = new Map(); for (const i of ix) for (const x of cs[i]) count.set(x, (count.get(x) || 0) + 1);
    return { members, repeat_words: rep, terms: new Set([...count].filter(([, n]) => n >= Math.min(2, ix.length)).map(([x]) => x)) };
  }).filter(c => c.members.length >= 3 || (c.members.length >= 2 && c.repeat_words > 0))
    .sort((a, b) => b.members.length - a.members.length || b.repeat_words - a.repeat_words);
}
/** the corrections: owner directives, overruled decisions (the overrule text), feedback memory files */
function corrections(items, rows) {
  const out = [];
  for (const i of Object.values(items)) {
    // an approval of a card (data.card / "Enforce (advisory A-...") is the answer, not one more correction: it never grows a cluster
    if (i.kind === 'directive' && i.data?.text && !i.data.card && !/^Enforce \(advisory A-/.test(i.data.text)) out.push({ id: i.id, text: String(i.data.text).slice(0, 600), date: i.created });
    if (i.kind === 'decision' && i.state === 'overruled') { const h = [...(i.history || [])].reverse().find(x => x.ev === 'overrule'); out.push({ id: i.id, text: `${i.data?.question || ''} ${h?.data?.text || ''}`.slice(0, 600), date: h?.ts || i.updated }); }
  }
  for (const r of rows.filter(x => x.kind === 'memory-topic' && x.exists !== false)) {
    const t = readText(r.path) || '', f = frontOf(t);
    if (f.meta.type === 'feedback') out.push({ id: path.basename(r.path), text: t.split(/\r?\n/).slice(f.end).join(' ').slice(0, 600), date: f.meta.modified || null, path: fwd(r.path), row: r.id });
  }
  return out;
}
// the mechanism, in REPORT 3.6's order (a Norn gate first: it binds every executor; a deny rule for a command; else a test)
const COMMIT_RE = /\b(?:commit|trailer|attribution|co-authored|push|force-push)\b/i;
function draft(text, root) {
  if (COMMIT_RE.test(text)) return { mech: 'a Norn merge gate', patch: [`# merge gate step (the check-in's merge brief, before the merge commit): fail on the corrected commit text`,
    `git -C "${root || '<repo>'}" log --format=%B "$BASE..$HEAD" | grep -qiE 'co-authored-by|generated with' && { echo "merge gate: attribution trailer in a commit"; exit 1; } || true`].join('\n') };
  const cmd = text.match(/`((?:uv|cargo|git|npm|pip|python|sleep|rm|norn)\b[^`]{0,40})`/i)?.[1];
  if (cmd) return { mech: 'a Claude deny rule', patch: JSON.stringify({ permissions: { deny: [`Bash(${cmd.trim()}:*)`] } }, null, 1) + '\n(.claude/settings.json of the repo; Claude only - other executors need a gate)' };
  return { mech: 'a repo test', patch: [`test('rule: ${clean(text).slice(0, 80).replace(/'/g, "\\'")}', () => {`, `  // assert the corrected behaviour on the real code path (the brief names the file + the red case)`, '});'].join('\n') };
}

/** was this absolute path ever tracked in its git repo (any branch)? -> bool; asked from its nearest existing folder, cached. --full-history:
 * the default history simplification drops a merged-in side (a subtree import) where the file lived (git-log "History Simplification") */
const trackedSeen = new Map();
export function onceTracked(abs) {
  const f = fwd(abs);
  if (trackedSeen.has(f)) return trackedSeen.get(f);
  let d = path.dirname(f);
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  const r = spawnSync('git', ['-C', d, 'log', '--all', '--full-history', '-1', '--format=%H', '--', f], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const yes = r.status === 0 && !!r.stdout.trim();
  trackedSeen.set(f, yes);
  return yes;
}

// ---------- the ledger ----------
/**
 * rows (instructions discover, with ids) -> { rules, counts, advisories, cards }. o: { project, items, hints (lint: missing-path /
 * unknown-command), home, files (git ls-files of the repo, relative), remember (store the ids for "retired"), now, tracked (a path ->
 * was it ever in git history; default onceTracked) }
 */
export function ruleLedger(rows, { project: p = {}, items = {}, hints = [], home = '', files = [], remember = false, now = Date.now(), tracked = onceTracked } = {}) {
  const lines = ruleLines(rows, items), E = enforcers(p, { home, files }), iso = new Date(now).toISOString();
  const rules = [], adv = [];
  const gens = generatedLines(withDefaults({ policy: p.policy || {} }));
  for (const ix of groups(lines)) {
    const ls = ix.map(i => lines[i]).sort((a, b) => rank(a) - rank(b) || a.path.length - b.path.length || (a.line ?? 0) - (b.line ?? 0));
    const home0 = ls[0], { e, fired } = enforcementOf(ls, E, p);
    const homes = [...new Map(ls.map(l => [lc(l.path), l])).values()].map(l => ({ path: l.path, line: l.line, row: l.row, kind: l.kind }));
    // a policy-marked placeholder line ({{policy}}) shows the line the policy generates
    const id = 'R-' + sha(words(home0.text).join(' ')).slice(0, 8), shown = e.policy && gens[e.policy] && !/[a-z]{3}/i.test(home0.text.replace(/\{\{[^}]*\}\}/g, '')) ? gens[e.policy] : home0.text;
    rules.push({ id, text: shown.length > 300 ? shown.slice(0, 297) + '...' : shown, home: homes[0], homes, enforcement: e, fired, repeats: 0, cluster: null,
      state: e.kind === 'prose' ? 'prose' : 'enforced' });
    const name = f => (f.startsWith('records:') ? f.slice(8) : path.posix.basename(f));
    if (homes.length > 1 && !e.policy) adv.push(advisory({ phase: 'P3', check: '5.0-5', key: 'rule-several-homes', severity: 'medium', surface: 'rule', path: homes[0].path, line: homes[0].line, subject: id,
      why: `the same rule in ${homes.length} places, home ${name(homes[0].path)}:${homes[0].line ?? '-'}: "${home0.text.slice(0, 120)}"`, source: SOURCE + ', hole 5',
      items: homes.slice(1).map(h => ({ path: h.path, line: h.line ?? undefined, text: 'a copy' })), fix: { tier: 'card', action: `keep it in ${name(homes[0].path)}; replace each copy by a one-line pointer`, kind: 'drafts' } }));
    for (const l of ls) {
      if (e.kind === 'prose' && CLAIM_RE.test(l.raw) && l.line) adv.push(advisory({ phase: 'P3', check: '5.0-3', key: 'rule-drift-claim', severity: 'medium', surface: 'rule', path: l.path, line: l.line,
        why: `says it is enforced (a hook / deny rule / gate) but no hook, deny rule, test or gate for it exists: "${l.text.slice(0, 120)}"`, source: SOURCE + ', hole 3', fix: { tier: 'card', action: 'add the enforcement it names, or drop the claim', kind: 'call', ways: ['Add the enforcement', 'Drop the claim'] } }));
      const k = l.raw.match(MARK_RE)?.[1];
      if (k && ['speed_mode', 'iteration'].concat(Object.keys(gens).filter(x => x.startsWith('context.'))).includes(k) && gens[k] && clean(l.raw) !== clean(gens[k])) adv.push(advisory({ phase: 'P3', check: '5.0-3', key: 'rule-drift-policy', severity: 'medium', surface: 'policy line', path: l.path, line: l.line,
        why: `the line says "${clean(l.raw).slice(0, 110)}" but the policy ${k} says otherwise`, source: SOURCE + ', hole 3; policy.mjs generatedLines', fix: { tier: 'card', action: 'Save the policy in Settings (it rewrites every marked line)', patch: `${gens[k]} <!-- policy:${k} -->`, kind: 'ready' } }));
    }
  }
  // hole 4: a rule line pointing at a path / command that is gone (the lint's hints, on rule lines only). "Gone" = git history says the
  // path was tracked once and is deleted now; a path git never had (a runtime flag file, a typo) is its own, lower kind.
  const at = new Map(lines.filter(l => l.line).map(l => [`${lc(l.path)}:${l.line}`, l]));
  for (const h of hints.filter(x => ['missing-path', 'unknown-command'].includes(x.kind))) {
    const l = at.get(`${lc(h.path)}:${h.line}`);
    if (l && h.kind === 'missing-path' && !(h.cands || []).some(tracked)) adv.push(advisory({ phase: 'P3', check: '5.0-4', key: 'rule-path-unknown', severity: 'low', surface: 'rule', path: l.path, line: l.line, subject: h.text,
      why: `a rule names a path git never had (a runtime file or a typo): ${h.text}`, source: SOURCE + ', hole 4', fix: { tier: 'card', action: 'fix the typo; a file made only at run time is fine - say so in the line', kind: 'drafts' } }));
    else if (l) adv.push(advisory({ phase: 'P3', check: '5.0-4', key: 'rule-drift-path', severity: 'medium', surface: 'rule', path: l.path, line: l.line, subject: h.text,
      why: `a rule points at code that is gone: ${h.text}`, source: SOURCE + ', hole 4', fix: { tier: 'card', action: 'point the rule at the code that replaced it, or retire the rule', kind: 'call', ways: ['Point it at the new code', 'Retire the rule'] } }));
  }
  // hole 2: a hook / deny rule / git hook no rule line explains
  const all = lines.map(l => l.raw.toLowerCase()).join('\n');
  for (const x of [...E.deny, ...E.githooks, ...E.hooks]) {
    const used = rules.some(r => r.enforcement.target === x.name && r.enforcement.path === x.path) || (x.kind !== 'deny' && all.includes(x.match));
    if (!used) adv.push(advisory({ phase: 'P3', check: '5.0-2', key: 'enforcement-unexplained', severity: 'low', surface: x.kind, path: x.path, subject: x.name,
      why: `${x.kind === 'hook' ? x.name : x.name} has no rule line that says why`, source: SOURCE + ', hole 2', fix: { tier: 'card', action: 'add the rule it enforces (one line, its home file), or remove it', kind: 'call', ways: ['Write the rule line', 'Remove it'] } }));
  }
  // hole 6: repeated corrections -> one card per cluster, ranked; a match with a rule line = written, and still broken
  const cards = [];
  const rc = rules.map(r => content(r.text));
  for (const c of repeats(corrections(items, rows))) {
    let best = null;
    rules.forEach((r, i) => { if (r.home.kind === 'directive') return; const s = jac(c.terms, rc[i]); if (s.n >= 3 && (!best || s.j > best.j)) best = { r, j: s.j }; });
    const r = best?.r, n = c.members.length, ids = c.members.map(m => m.id);
    if (r) { r.repeats = Math.max(r.repeats, n); if (r.state === 'prose') r.state = 'repeated'; }
    const text = [r?.text, ...c.members.map(m => m.text)].filter(Boolean).join(' '), d = draft(text, p.root);
    const a = advisory({ phase: 'P3', check: '3.6', key: 'rule-repeated', severity: r ? 'medium' : 'low', surface: 'repeated correction', path: r?.home.path ?? null, line: r?.home.line ?? null,
      subject: [...ids].sort()[0], why: `said ${n} times (${ids.slice(0, 6).join(', ')}${n > 6 ? ', ...' : ''}); ${r ? `it is line ${r.home.line ?? '-'} of ${path.posix.basename(r.home.path)}, and still broken` : 'no rule line says it yet'}. Make it ${d.mech}?`,
      source: 'REPORT meta-practice s.3.6', items: c.members.map(m => ({ text: `${m.id}: ${clean(m.text).slice(0, 160)}` })),
      fix: { tier: 'card', action: `approve = a directive asks the check-in for a task brief that adds ${d.mech}; Norn installs nothing`, patch: d.patch, kind: 'call', ways: ['Make it enforced', 'Leave it as prose'] } });
    if (r) { r.cluster = a.id; a.rule = r.id; }
    a.approve = approvalText(a); a.asked = askedBy(a, items);
    cards.push(a);
  }
  // retired: in the last remembered scan, gone now (<state>/instructions/rules.json, a cache)
  const file = p.state ? path.join(p.state, 'instructions', 'rules.json') : null, last = file ? readJson(file) : null;
  const ids = new Set(rules.map(r => r.id)), retired = { ...(last?.retired || {}) };
  for (const [id, r] of Object.entries(last?.rules || {})) if (!ids.has(id) && !retired[id]) retired[id] = { ...r, retired_at: iso };
  for (const id of ids) delete retired[id];
  for (const [id, r] of Object.entries(retired)) rules.push({ id, text: r.text, home: r.home, homes: [r.home], enforcement: r.enforcement || { kind: 'prose', target: null, path: null }, fired: null, repeats: 0, cluster: null, state: 'retired', retired_at: r.retired_at });
  if (remember && file) {
    const keep = Object.fromEntries(rules.filter(r => r.state !== 'retired').map(r => [r.id, { text: r.text, home: r.home, enforcement: r.enforcement, first_seen: last?.rules?.[r.id]?.first_seen || iso }]));
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify({ at: iso, rules: keep, retired, cards })); fs.renameSync(tmp, file); } catch { /* a read-only state: the ledger still shows, retired waits for a writable scan */ }
  }
  const counts = Object.fromEntries(STATES.map(s => [s, rules.filter(r => r.state === s).length]));
  return { rules, counts, advisories: adv, cards };
}
/**
 * the directive that asked for a card (its approval) -> { id, state, at } or null. A card's id is a hash of its cluster's first
 * correction and rule line, so it moves when the cluster grows or the line moves; the approval still counts when the directive records
 * the card (data.card), cites its id, or is an "Enforce (advisory A-...)" approval naming the same corrections (more than half of the
 * ids it lists are in the card, at least 2). Newest first, an active directive before any other.
 */
export function askedBy(card, items = {}) {
  const mine = new Set((card.items || []).map(x => String(x.text).match(/^([A-Z]+-\d+):/)?.[1]).filter(Boolean));
  const hit = d => {
    const t = String(d.data?.text || '');
    if (d.data?.card === card.id || t.includes(card.id)) return true;
    const said = /^Enforce \(advisory A-[0-9a-f]+/.test(t) ? t.match(/said \d+ times \(([^)]*)\)/)?.[1] : null;
    const ids = said ? said.split(/,\s*/).filter(x => /^[A-Z]+-\d+$/.test(x)) : [], n = ids.filter(x => mine.has(x)).length;
    return n >= 2 && n * 2 > ids.length;
  };
  const ds = Object.values(items).filter(i => i.kind === 'directive' && hit(i))
    .sort((a, b) => (b.state === 'active') - (a.state === 'active') || String(b.created).localeCompare(String(a.created)));
  return ds.length ? { id: ds[0].id, state: ds[0].state, at: ds[0].created ?? null } : null;
}
/** the approval cards of the last remembered scan, each with asked (askedBy); open = not asked yet */
export function enforceCards(state, items = {}) {
  return cardsOf(state ? readJson(rulesJson(state)) : null, items);
}
/** the open ones (the CLI's audit view) */
export const openCards = (state, items = {}) => enforceCards(state, items).filter(c => !c.asked);
const rulesJson = state => path.join(state, 'instructions', 'rules.json');
const cardsOf = (j, items) => (j?.cards || []).map(c => ({ ...c, asked: askedBy(c, items) }));
/** enforceCards on fs.promises (the dash Inbox) */
export async function enforceCardsAsync(state, items = {}) {
  const t = state ? await readTextA(rulesJson(state)) : null;
  return cardsOf(t === null ? null : JSON.parse(t), items);
}
/** the directive an approval writes: the check-in turns it into a task brief (Norn installs nothing itself) */
export const approvalText = c => `Enforce (advisory ${c.id}, the repeat detector): ${c.why} Draft: ${String(c.fix?.patch || '').slice(0, 1500)} - write a task brief that adds it, red-first, and retire the prose line once it lands.`;
/** per row id: { total, prose, repeated, enforced } (the chips on the Instructions rows; a rule counts on every row it sits in) */
export function rowCounts(rules) {
  const m = new Map();
  for (const r of rules.filter(x => x.state !== 'retired')) for (const h of r.homes) if (h.row) {
    const c = m.get(h.row) || { total: 0, prose: 0, repeated: 0, enforced: 0 }; c.total++; c[r.state]++; m.set(h.row, c);
  }
  return m;
}
