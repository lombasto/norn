// META-PRACTICE-P1: the free static checks over the instruction files (REPORT meta-practice sec. 3.2, checks 1-19 + 21-23; check 20
// is P5). Pure text / file / git reads - never a model call. Each finding is ONE advisory record (advisory.mjs, META-TEND DEC-278):
// key instr-c<check>, severity high | medium | low | count, surface = the check's title, why = the finding, fix.action = the one-line
// fix, row = the Instructions row id, other (check 6: the repo file the memory line restates - the second side of the conflict); its
// id is stable across scans (the subject = the finding with its numbers masked), so "fixed since the last scan" diffs ids.
// Hooks and settings: event names, types and whether a script exists - never a value (settings can hold secrets).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { POLICY_MODELS } from './policy.mjs';
import { advisory } from './advisory.mjs';
import { realPath } from './config.mjs';
import { subdirOf } from './monorepo.mjs';

const fwd = p => String(p).replace(/\\/g, '/');
const lc = p => (process.platform === 'win32' ? fwd(p).toLowerCase() : fwd(p));
const under = (p, dir) => !!dir && (lc(path.resolve(p)) + '/').startsWith(lc(path.resolve(dir)).replace(/\/+$/, '') + '/');
const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const isFile = f => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const gitOut = (cwd, args) => { const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 64 * 1024 * 1024 }); return r.status === 0 ? r.stdout : null; };
const tok = s => Math.ceil(String(s).length / 4);

/** id -> { family, title, fix, info? } (REPORT sec. 3.2). META-UX-BUILD S5: fix = the kind of fix the check's findings need (advisory.mjs
 * FIX_KINDS: none of these carries a patch, so drafts or your call with its two ways); info = the kind of its count-level rows */
export const CHECKS = {
  1: { family: 'memory', title: 'MEMORY.md over 200 lines or 25 KB', fix: { kind: 'drafts' } }, 2: { family: 'encoding', title: 'encoding damage (mojibake)', fix: { kind: 'drafts' } },
  3: { family: 'memory', title: 'index entry over one line / ~150 chars', fix: { kind: 'drafts' } }, 4: { family: 'memory', title: 'index pointers and names', fix: { kind: 'call', ways: ['Fix the link or name', 'Delete the entry'] } },
  5: { family: 'memory', title: 'topic frontmatter', fix: { kind: 'drafts' }, info: 'count' }, 6: { family: 'memory', title: 'memory restates a repo rule', fix: { kind: 'drafts' } },
  7: { family: 'local', title: 'CLAUDE.local.md', fix: { kind: 'drafts' } }, 8: { family: 'rules', title: '.claude/rules frontmatter and paths', fix: { kind: 'call', ways: ['Fix the paths', 'Delete the rule'] }, info: 'count' },
  9: { family: 'imports', title: '@imports', fix: { kind: 'call', ways: ['Fix the import', 'Delete the line'] }, info: 'count' }, 10: { family: 'codex', title: 'Codex AGENTS.md chain over 32 KiB', fix: { kind: 'drafts' } },
  11: { family: 'parity', title: 'twin AGENTS.md / CLAUDE.md', fix: { kind: 'drafts' } }, 12: { family: 'parity', title: 'Claude-only root, no AGENTS.md', fix: { kind: 'drafts' } },
  13: { family: 'pointers', title: 'pointer to a Moved: stub or a renamed file', fix: { kind: 'drafts' } }, 14: { family: 'prose', title: 'emphasis density', fix: { kind: 'drafts' } },
  15: { family: 'prose', title: 'dated-model phrases', fix: { kind: 'drafts' } }, 16: { family: 'prose', title: 'history in an always-loaded file', fix: { kind: 'drafts' } },
  17: { family: 'prose', title: 'names a closed lane', fix: { kind: 'call', ways: ['Delete the line', 'Move it to the lane notes'] } }, 18: { family: 'prose', title: 'retired or non-policy model name', fix: { kind: 'drafts' } },
  19: { family: 'prose', title: '"never" with no named enforcement (a count)', fix: { kind: 'call', ways: ['Bind it with a hook or gate', 'Accept it as prose'] } }, 21: { family: 'agents', title: 'agent model / effort vs policy; descriptions size', fix: { kind: 'call', ways: ['Let policy pick', 'Align the agent file'] } },
  22: { family: 'hooks', title: 'hooks: events, scripts, deterministic', fix: { kind: 'call', ways: ['Fix the hook', 'Delete the hook'] }, info: 'count' }, 23: { family: 'harness', title: 'harness rules carry a version', fix: { kind: 'drafts' } },
};

// ---------- the auto-memory folder (Claude Code: <config>/projects/<the repo's main root, non-alphanumerics -> '-'>/memory) ----------
/** the memory folder of the git repository at root (every worktree of it shares one), matched case-insensitively on disk */
export function memoryDir(root, claudeConfig) {
  if (!root || !claudeConfig) return null;
  // the common dir relative to root, resolved against root: the main root in the caller's spelling (an 8.3 short name stays short,
  // as Claude Code saw it as its cwd); its canonical spelling (git's absolute answer) is the second candidate (CI-RED-7E52345)
  const common = gitOut(root, ['rev-parse', '--path-format=relative', '--git-common-dir'])?.trim();
  const abs = common && path.resolve(root, common);
  const main = abs && /\/\.git\/?$/.test(fwd(abs)) ? path.dirname(abs) : root;
  const slugOf = p => fwd(path.resolve(p)).replace(/[^A-Za-z0-9]/g, '-'), slug = slugOf(main), base = path.join(claudeConfig, 'projects');
  const want = [slug, slugOf(realPath(main))].map(s => s.toLowerCase());
  let hit = null;
  try { const names = fs.readdirSync(base); hit = want.map(w => names.find(n => n.toLowerCase() === w)).find(Boolean); } catch { /* no projects folder yet: fall back to the computed slug */ }
  return path.join(base, hit || slug, 'memory');
}

// ---------- frontmatter of a rule / topic / agent file (a small YAML subset: key: value, list items, [a, b]) ----------
/** text -> { has, ok, meta { key: string | [strings] }, end (the line after the closing ---) } */
export function frontOf(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { has: false, ok: true, meta: {}, end: 0 };
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (close < 0) return { has: true, ok: false, meta: {}, end: 0 };
  const meta = {};
  let cur = null, ok = true;
  for (const l of lines.slice(1, close)) {
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const kv = l.match(/^([\w-]+):\s*(.*)$/), item = l.match(/^\s+-\s+(.*)$/);
    const unq = s => s.trim().replace(/^["']|["']$/g, '');
    if (kv) {
      const v = kv[2].trim();
      if (v.startsWith('[')) { if (!v.endsWith(']')) { ok = false; continue; } meta[kv[1]] = v.slice(1, -1).split(',').map(unq).filter(Boolean); cur = null; }
      else if (!v) { meta[kv[1]] = []; cur = kv[1]; } else { meta[kv[1]] = unq(v); cur = null; }
    } else if (item && cur) meta[cur].push(unq(item[1]));
    else ok = false;
  }
  return { has: true, ok, meta, end: close + 1 };
}
export const rulePaths = text => { const f = frontOf(text); const p = f.ok ? f.meta.paths : null; return Array.isArray(p) ? p : typeof p === 'string' ? [p] : []; };

// ---------- shared ----------
const proseLines = text => { let fence = false; const out = []; String(text).split(/\r?\n/).forEach((t, i) => { if (/^\s*(```|~~~)/.test(t)) { fence = !fence; return; } if (!fence) out.push({ n: i + 1, text: t }); }); return out; };
/** `@path` references of a file: [{ line, target, abs, exists }] (outside fenced code; a token with a file extension) */
export function importRefs(text, file, home) {
  const out = [];
  for (const { n, text: l } of proseLines(text)) for (const m of l.matchAll(/(?:^|\s)@([^\s`'"()<>]+)/g)) {
    const t = m[1].replace(/[.,;:]+$/, '');
    if (!/\.[A-Za-z0-9]{1,8}$/.test(t) || /@/.test(t)) continue;
    const abs = t.startsWith('~/') ? path.join(home || '', t.slice(2)) : path.isAbsolute(t) ? t : path.join(path.dirname(file), t);
    out.push({ line: n, target: t, abs, exists: isFile(abs) });
  }
  return out;
}
const always = r => r.loads?.some(s => ['session', 'checkin', 'chat'].includes(s.class) && s.part !== 'description');
const words = s => String(s).toLowerCase().match(/[a-z0-9]+/g) || [];
const SHINGLE = 7;
const MOJIBAKE = /â€|Ã[\u0080-¿]|Â[ -¿]|�/;
const DATED = [[/\bthink (?:step[- ]by[- ]step|harder|deeply)\b/i, 'think step by step / harder'], [/\bdouble[- ]check\b/i, 'double-check'], [/\bbe thorough\b/i, 'be thorough'],
  [/\bevery \d+ (?:minutes|turns|steps|tool calls)\b/i, 'a fixed update cadence'], [/\b(?:under|at most|max(?:imum)?|no more than|<=?)\s*\d+\s+words\b/i, 'a word cap'],
  [/(?:past|over|above|at|under) ~?\d+k\b(?! ?(?:rows|lines|files|chars|bytes))/i, 'a token budget shown to the model'], [/\b(?:use (?:sub-?agents|parallel agents)|delegate (?:more|aggressively|often)\b(?! decision))/i, 'a push to delegate']];
const HISTORY = /\b20\d\d-\d\d-\d\d\b|\b(?:0?[1-9]|1[0-2])-(?:[0-2]\d|3[01])\b(?=[\s:),;Z])|\bRUN-(?:[a-z][a-z0-9]{0,15}-)?\d+\b|\bwas \d+\b|\bwas (?:renamed|removed|retired|moved|replaced)\b|\bno longer\b|\brenamed\b|\bused to\b|\bpreviously\b|\bformerly\b/i;
const MODEL_RE = /\b(claude-(?:\d[\w.-]*[a-z0-9]|[a-z]+-\d[\w.-]*\d)|gpt-\d[\w.-]*|(?:opus|sonnet|haiku|fable)[ -]\d(?:\.\d)?)\b/gi;
const normModel = m => { const x = m.toLowerCase(), f = x.match(/^(opus|sonnet|haiku)[ -](\d)(?:\.(\d))?$/); return f ? `claude-${f[1]}-${f[2]}${f[3] ? '-' + f[3] : ''}` : x.replace(/^fable[ -].*/, 'fable'); };

/**
 * rows (discover) -> findings. o: { project, home, items (records), harness (adapter rows), versions { family: installed CLI version },
 * worktrees (test seam) }.
 */
export function staticChecks(rows, { project: p = {}, home = '', items = {}, harness = [], versions = {} } = {}) {
  const out = [], text = new Map(), root = p.root;
  const T = r => { if (!text.has(r.path)) text.set(r.path, r.exists !== false && r.chars <= 2_000_000 ? readText(r.path) : null); return text.get(r.path); };
  const add = (check, severity, r, line, msg, fix) => { const file = fwd(r?.path ?? r), f = advisory({ phase: 'P1', check, key: `instr-c${check}`, severity: severity === 'info' ? 'count' : severity,
    surface: CHECKS[check].title, path: file, line: Math.max(1, line || 1), why: msg.length > 300 ? `${msg.slice(0, 297)}...` : msg, source: `REPORT meta-practice s.3.2, check ${check}`,
    subject: `${lc(file)}|${msg.replace(/\d+/g, '#')}`, row: r?.id ?? undefined, fix: { tier: !root || under(file, root) ? 'card' : 'flag', action: fix, kind: severity === 'info' ? CHECKS[check].info ?? CHECKS[check].fix.kind : CHECKS[check].fix.kind, ways: CHECKS[check].fix.ways } }); out.push(f); return f; };
  const hand = rows.filter(r => r.exists !== false && !r.generated && T(r) != null);
  const byPath = new Map(rows.map(r => [lc(r.path), r]));

  // ---- memory: 1-6 ----
  const idx = hand.find(r => r.kind === 'memory'), topics = hand.filter(r => r.kind === 'memory-topic');
  if (idx) {
    const t = T(idx), lines = t.split(/\r?\n/), n = lines.length - (t.endsWith('\n') ? 1 : 0), bytes = Buffer.byteLength(t);
    if (n > 200 || bytes > 25 * 1024) add(1, 'high', idx, Math.min(n, 201), `${n} lines, ${(bytes / 1024).toFixed(1)} KB: past 200 lines / 25 KB the rest is silently not loaded`, 'move entries into topic files until the index is under 200 lines and 25 KB');
    const dir = path.dirname(idx.path), linked = new Set();
    lines.forEach((l, i) => {
      if (l.length > 150 && /^\s*[-*]/.test(l)) add(3, 'medium', idx, i + 1, `index entry of ${l.length} chars holds rule text, not a pointer`, 'move the text into the topic file; keep a one-line pointer of ~150 chars');
      for (const m of l.matchAll(/\[([^\]]+)\]\(([^)\s]+\.md)\)/g)) {
        const f = path.join(dir, m[2]); linked.add(lc(f));
        if (!isFile(f)) { add(4, 'high', idx, i + 1, `links ${m[2]}, which does not exist`, 'fix the link or delete the entry'); continue; }
        const tw = new Set(words(m[1]).filter(x => x.length >= 4)), fw = new Set(words(path.basename(m[2], '.md')).filter(x => x.length >= 4));
        const td = m[1].match(/\b(\d\d)-(\d\d)\b/), fd = m[2].match(/\d{4}-(\d\d)-(\d\d)/);
        if ((td && fd && `${td[1]}-${td[2]}` !== `${fd[1]}-${fd[2]}`) || (tw.size && fw.size && ![...tw].some(x => fw.has(x))))
          add(4, 'medium', idx, i + 1, `title "${m[1]}" and file ${m[2]} disagree`, 'rename the file or retitle the entry so both say the same thing');
      }
    });
    for (const r of topics) for (const m of (T(r) || '').matchAll(/\]\(([^)\s]+\.md)\)/g)) linked.add(lc(path.join(dir, m[1])));   // a legacy index counts
    const orphans = topics.filter(r => !linked.has(lc(r.path)));
    for (const r of orphans) add(4, 'low', idx, 1, `topic file ${r.name} is in no index`, `link ${r.name} from MEMORY.md or a legacy index, or delete it`);
    const noFm = topics.filter(r => { const f = frontOf(T(r)); return !f.ok || !f.meta.type || !f.meta.modified; });
    if (noFm.length) add(5, 'low', idx, 1, `${noFm.length} topic file(s) lack \`type\` or \`modified\`: ${noFm.slice(0, 5).map(r => r.name).join(', ')}${noFm.length > 5 ? ', ...' : ''}`, 'add `type` and `modified` to each topic file\'s frontmatter');
    const fb = topics.filter(r => frontOf(T(r)).meta.type === 'feedback').length;
    if (fb) add(5, 'info', idx, 1, `${fb} feedback topic file(s) of ${topics.length}`, 'feedback that became a rule moves to a repo file');
    // 6: a memory line that shares a 7-word run with a repo file (two sources drift)
    const shingles = new Map();
    for (const r of hand.filter(x => ['repo', 'import', 'rule', 'rules', 'checkin_extra'].includes(x.kind)))
      for (const { n: ln, text: l } of proseLines(T(r))) { const w = words(l); for (let i = 0; i + SHINGLE <= w.length; i++) { const k = w.slice(i, i + SHINGLE).join(' '); if (!shingles.has(k)) shingles.set(k, { r, ln }); } }
    for (const r of [idx, ...topics.filter(x => x.chars <= 64 * 1024)]) {
      for (const { n: ln, text: l } of proseLines(T(r))) {
        const w = words(l);
        for (let i = 0; i + SHINGLE <= w.length; i++) { const hit = shingles.get(w.slice(i, i + SHINGLE).join(' ')); if (hit) { add(6, 'medium', r, ln, `restates ${hit.r.name}:${hit.ln} (${fwd(hit.r.path)})`, `keep the rule in ${hit.r.name}; let the memory line point to it`).other = fwd(hit.r.path); break; } }
      }
    }
  }
  // ---- 2: encoding damage (every file) ----
  for (const r of hand) {
    const bad = T(r).split(/\r?\n/).map((l, i) => (MOJIBAKE.test(l) ? i + 1 : 0)).filter(Boolean);
    if (bad.length) add(2, 'high', r, bad[0], `encoding damage on ${bad.length} line(s) (e.g. "â€”" for a dash)`, 're-encode the file as UTF-8 (the text was decoded as cp1252 once)');
  }
  // ---- 7: CLAUDE.local.md ----
  const locals = hand.filter(r => r.name === 'CLAUDE.local.md' && under(r.path, root));
  for (const r of locals) {
    const rel = fwd(path.relative(root, r.path));
    if (spawnSync('git', ['-C', root, 'check-ignore', '-q', '--', rel], { windowsHide: true, timeout: 10000 }).status !== 0) add(7, 'medium', r, 1, 'CLAUDE.local.md is not git-ignored: a private file can be committed', 'add CLAUDE.local.md to .gitignore');
    if (isFile(path.join(path.dirname(r.path), 'AGENTS.md'))) add(7, 'low', r, 1, 'CLAUDE.local.md shadows AGENTS.md for Claude only: Codex and other harnesses never see it', 'move shared lines into AGENTS.md; keep only personal ones here');
    const wts = (gitOut(root, ['worktree', 'list', '--porcelain']) || '').split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9).trim());
    const have = wts.filter(d => isFile(path.join(d, rel))).length;
    if (wts.length > 1 && have < wts.length) add(7, 'medium', r, 1, `present in ${have} of ${wts.length} worktrees: sessions differ by checkout`, 'keep personal rules in ~/.claude/CLAUDE.md, or the same CLAUDE.local.md in every worktree');
  }
  // ---- 8: .claude/rules ----
  let tracked = null;
  const files = () => (tracked ??= (root ? (gitOut(root, ['ls-files', '--cached', '--others', '--exclude-standard']) || '').split('\n').filter(Boolean) : []));
  for (const r of hand.filter(x => x.kind === 'rule')) {
    const f = frontOf(T(r));
    if (!f.ok) { add(8, 'medium', r, 1, 'frontmatter does not parse: the rule loads in every session', 'fix the frontmatter (`paths:` as a list of quoted globs)'); continue; }
    const ps = rulePaths(T(r));
    if (!ps.length) { add(8, 'info', r, 1, 'no `paths`: loads in every session', 'add `paths:` globs if the rule is only for some files'); continue; }
    for (const g of ps) if (!files().some(x => path.posix.matchesGlob(x, g))) add(8, 'medium', r, 1, `paths glob "${g}" matches 0 files: the rule never loads`, 'fix the glob or delete the rule');
  }
  // ---- 9: imports ----
  for (const r of hand.filter(x => ['repo', 'user', 'import', 'rule'].includes(x.kind) && x.harness?.includes('claude'))) {
    const depth = r.import_depth || 0;
    for (const ref of importRefs(T(r), r.path, home)) {
      if (!ref.exists) { add(9, 'high', r, ref.line, `imports @${ref.target}, which does not exist`, 'fix the import path or delete the line'); continue; }
      const t = byPath.get(lc(ref.abs));
      if (depth + 1 > 4) add(9, 'medium', r, ref.line, `@${ref.target} is ${depth + 1} hops deep (Claude Code stops at 5)`, 'import the file straight from the root file');
      if (root && !under(ref.abs, root) && !under(ref.abs, home)) add(9, 'low', r, ref.line, `@${ref.target} points outside the repo`, 'keep imported files inside the repository');
      if (t?.tokens) add(9, 'info', r, ref.line, `@${ref.target} adds ~${t.tokens} tokens to every session that loads ${r.name}`, 'counted on the importer');
    }
  }
  // ---- 10-12: Codex chain, twins, Claude-only root ----
  if (root && fs.existsSync(root)) {
    const userCodex = [path.join(home, '.codex', 'AGENTS.override.md'), path.join(home, '.codex', 'AGENTS.md')].find(isFile);
    const base = userCodex ? fs.statSync(userCodex).size : 0;
    for (const r of rows.filter(x => x.exists !== false && x.name === 'AGENTS.md' && under(x.path, root))) {
      let d = path.dirname(r.path), sum = base;
      for (;;) { const f = path.join(d, 'AGENTS.md'); if (isFile(f)) sum += fs.statSync(f).size; if (lc(d) === lc(root) || !under(d, root)) break; d = path.dirname(d); }
      if (sum > 32 * 1024) add(10, 'high', r, 1, `the Codex chain for a launch here is ${(sum / 1024).toFixed(1)} KiB: past 32 KiB the tail is dropped silently`, 'cut the chain under 32 KiB (move long parts to on-demand files)');
      const c = path.join(path.dirname(r.path), 'CLAUDE.md');
      if (isFile(c) && !importRefs(readText(c), c, home).some(x => lc(x.abs) === lc(r.path)) && !importRefs(T(r) || '', r.path, home).some(x => lc(x.abs) === lc(c)))
        add(11, 'medium', byPath.get(lc(c)) || c, 1, 'CLAUDE.md beside AGENTS.md, both hand-written, no import: two sources', 'make CLAUDE.md `@AGENTS.md` plus Claude-only lines');
    }
    const claudeRoot = [path.join(root, 'CLAUDE.md'), path.join(root, '.claude', 'CLAUDE.md')].find(isFile);
    if (claudeRoot && !isFile(path.join(root, 'AGENTS.md'))) add(12, 'medium', byPath.get(lc(claudeRoot)) || claudeRoot, 1, 'a Claude-only root file and no AGENTS.md: other harnesses get none of it', 'move the shared rules to AGENTS.md; CLAUDE.md = `@AGENTS.md`');
  }
  // ---- 13-19: prose (13-15 + 18 on every hand-written file but memory topics; 16, 17, 19 on always-loaded files) ----
  let renames = null;
  const renamed = rel => { renames ??= new Map(root ? (gitOut(root, ['log', '--diff-filter=R', '-M', '--name-status', '--format=']) || '').split('\n').map(l => l.split('\t')).filter(x => x.length === 3).map(x => [x[1], x[2]]) : []); return renames.get(rel); };
  const lanes = Object.values(items).filter(i => i.kind === 'lane' && ['done', 'archived'].includes(i.state)).map(i => String(i.data?.name || '')).filter(n => n.length >= 4 && /[-_\d]/.test(n));
  const policyModels = new Set([...POLICY_MODELS.filter(Boolean), ...Object.values(p.policy?.executors || {}).map(e => e?.model), ...Object.values(p.executors || {}).map(e => e?.model)].filter(Boolean).map(m => m.toLowerCase()));
  const enforce = enforcementText(root, home, subdirOf(p));
  for (const r of hand.filter(x => x.kind !== 'memory-topic' && /\.(md|txt)$/i.test(x.path))) {
    const pl = proseLines(T(r)), every = always(r);
    let shout = 0, hist = [], never = [];
    for (const { n, text: l } of pl) {
      shout += (l.match(/\b(?:MUST|NEVER|ALWAYS|CRITICAL|IMPORTANT)\b/g) || []).length;
      for (const tk of [...l.matchAll(/`([^`\s]+)`/g)].map(m => m[1])) {
        const t = tk.replace(/\\/g, '/').replace(/[.,:;)]+$/, '');
        if (!t.includes('/') || !/\.[A-Za-z0-9]{1,8}$/.test(t) || /[*?<>{}$]/.test(t)) continue;
        const f = [path.dirname(r.path), root, p.project_dir].filter(Boolean).map(b => path.join(b, t)).find(isFile);
        const first = f ? (readText(f) || '').split(/\r?\n/).find(x => x.trim()) || '' : '';
        const mv = first.match(/^\s*#*\s*Moved\b:?\s*(\S+)/i);
        if (mv) add(13, 'high', r, n, `points to ${t}, a "Moved:" stub`, `point to ${mv[1]}`);
        else if (!f && root && renamed(t)) add(13, 'high', r, n, `points to ${t}, which git shows as renamed`, `point to ${renamed(t)}`);
      }
      for (const [re, what] of DATED) if (re.test(l)) { add(15, 'low', r, n, `dated-model phrase (${what}): "${l.trim().slice(0, 80)}"`, 'test the line without it; current models need no push here'); break; }
      for (const m of l.matchAll(MODEL_RE)) { const nm = normModel(m[1]); if (!policyModels.has(nm) && !(nm === 'fable' && policyModels.has('fable'))) add(18, 'low', r, n, `model name ${m[1]} is not in the policy's models`, 'name a policy model, or the role and let policy pick'); }
      if (every && HISTORY.test(l)) hist.push(n);
      if (every) for (const ln of lanes) if (new RegExp(`(?<![\\w-])${ln.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(l)) add(17, 'medium', r, n, `names lane ${ln}, which the records show closed`, 'delete the line, or move it to the lane\'s notes');
      if (every && /\bnever\b/i.test(l) && !enforced(l, enforce)) never.push(n);
    }
    const t1k = tok(T(r)) / 1000;
    if (shout >= 3 && shout / Math.max(t1k, 0.1) > 5) add(14, 'low', r, pl.find(x => /\b(?:MUST|NEVER|ALWAYS|CRITICAL|IMPORTANT)\b/.test(x.text))?.n, `${shout} shouted words (~${(shout / Math.max(t1k, 0.1)).toFixed(0)} per 1k tokens)`, 'state the rule and its reason in plain case');
    if (hist.length) add(16, 'medium', r, hist[0], `${hist.length} history line(s) in an always-loaded file (dates, run ids, "was X", "no longer"): l.${hist.slice(0, 8).join(', ')}${hist.length > 8 ? ', ...' : ''}`, 'move the history to a dated note; keep one rule line');
    if (never.length) add(19, 'info', r, never[0], `${never.length} "never" line(s) name no hook, deny rule, test or gate: l.${never.slice(0, 8).join(', ')}`, 'bind the rule with a hook / deny rule / gate, or accept it as prose');
  }
  // ---- 21: agents ----
  const agents = rows.filter(r => r.kind === 'agent' && r.exists !== false);
  let desc = 0;
  for (const r of agents) {
    const t = T(r) ?? '', fm = frontOf(t).meta, pol = p.policy?.executors?.[path.basename(r.path, '.md')] || {};
    desc += tok(`${fm.name || ''}: ${fm.description || ''}`);
    const ln = k => t.split(/\r?\n/).findIndex(l => l.startsWith(`${k}:`)) + 1;
    if (fm.model && pol.model && !String(pol.model).toLowerCase().includes(String(fm.model).toLowerCase()) && String(fm.model) !== String(pol.model)) add(21, 'medium', r, ln('model'), `agent model ${fm.model} differs from policy ${pol.model}`, 'drop `model` from the agent file and let policy pick, or align it');
    if (fm.effort && pol.effort && fm.effort !== pol.effort) add(21, 'medium', r, ln('effort'), `agent effort ${fm.effort} differs from policy ${pol.effort}`, 'drop `effort` from the agent file or align it');
  }
  if (desc > 15000 && agents[0]) add(21, 'medium', agents[0], 1, `agent descriptions total ~${desc} tokens (over 15,000)`, 'shorten the descriptions: each one costs every session');
  // ---- 22: hooks (keys only) ----
  for (const f of [root && path.join(root, '.claude', 'settings.json'), root && path.join(root, '.claude', 'settings.local.json'), home && path.join(home, '.claude', 'settings.json')].filter(Boolean)) {
    const t = readText(f); if (t == null) continue;
    let j; try { j = JSON.parse(t); } catch { add(22, 'medium', f, 1, 'settings file does not parse', 'fix the JSON'); continue; }
    const hooks = j?.hooks || {}, evs = Object.keys(hooks), lines = t.split(/\r?\n/), at = k => lines.findIndex(l => l.includes(`"${k}"`)) + 1;
    if (evs.length) add(22, 'info', f, at(evs[0]), `hook events set: ${evs.join(', ')}`, 'keep each hook a deterministic command with a script in the repo');
    for (const ev of evs) (Array.isArray(hooks[ev]) ? hooks[ev] : []).forEach((g, gi) => (g?.hooks || []).forEach((h, hi) => {
      const where = `${ev}[${gi}].hooks[${hi}]`;
      if (h?.type && h.type !== 'command') add(22, 'medium', f, at(ev), `${where} is type ${h.type}: not deterministic`, 'use a command hook for anything that must always hold');
      const script = String(h?.command || '').split(/\s+/).map(s => s.replace(/^["']|["']$/g, '')).find(s => /\.(mjs|js|cjs|ps1|sh|py|cmd|bat)$/i.test(s));
      if (script && !/\$|%/.test(script) && ![path.dirname(path.dirname(f)), root, path.dirname(f)].filter(Boolean).some(b => isFile(path.isAbsolute(script) ? script : path.join(b, script)))) add(22, 'high', f, at(ev), `${where}: its script does not exist`, 'restore the script or delete the hook');
    }));
  }
  // ---- 23: harness rules carry a version + date; an installed CLI past it = re-check ----
  // the finding sits on the adapter that holds the rules (h.src, its `family:` line), never on a project file the rules are about (bug 3:
  // it sat on AGENTS.md L1); an adapter row with no src (a test seam) names the family
  const srcLine = h => { const t = h.src ? readText(h.src) : null, i = t ? t.split(/\r?\n/).findIndex(l => l.includes(`family: '${h.family}'`)) : -1; return i + 1 || 1; };
  for (const h of harness) {
    const at = h.src || h.family, file = h.src ? path.basename(h.src) : `harness/${h.family}.mjs`;
    if (!h.verified?.version) { add(23, 'low', at, srcLine(h), `the ${h.label} load rules carry no version or date`, `stamp the ${h.label} entry's instructions.verified { version, date } in ${file} after reading its docs`); continue; }
    const v = versions[h.family];
    if (v && v !== h.verified.version) add(23, 'medium', at, srcLine(h), `${h.label} ${v} is installed; its load rules were checked on ${h.verified.version} (${h.verified.date}): re-check`, `re-read the ${h.label} docs and re-stamp instructions.verified in ${file}`);
  }
  const SEV = { high: 0, medium: 1, low: 2, count: 3 };
  return out.sort((a, b) => SEV[a.severity] - SEV[b.severity] || a.check - b.check || a.path.localeCompare(b.path) || a.line - b.line);
}

// what can enforce a "never" line: hook commands + deny rules (read, never shown), test file names, git hooks
// a monorepo project (sub): its own tests/ folder too (the root's tests/ is the shared one); never another project's
function enforcementText(root, home, sub = '') {
  const parts = [];
  for (const f of [root && path.join(root, '.claude', 'settings.json'), root && path.join(root, '.claude', 'settings.local.json'), home && path.join(home, '.claude', 'settings.json')].filter(Boolean)) {
    try { const j = JSON.parse(readText(f) || 'null'); parts.push(JSON.stringify(j?.hooks || {}), JSON.stringify(j?.permissions?.deny || [])); } catch { /* missing or unparsable settings: this file adds no enforcement, the next one is read */ }
  }
  for (const d of [root && path.join(root, 'tests'), root && sub && path.join(root, sub, 'tests'), root && path.join(root, '.githooks'), root && path.join(root, '.git', 'hooks')].filter(Boolean)) { try { parts.push(fs.readdirSync(d).filter(n => !n.endsWith('.sample')).join(' ')); } catch { /* folder absent: it enforces nothing, move on to the next */ } }
  return parts.join(' ').toLowerCase();
}
const enforced = (line, corpus) => /\b(?:hook|gate|deny|enforced|lint(?:ed)?)\b/i.test(line) || [...line.matchAll(/`([^`]{3,})`/g)].some(m => corpus.includes(m[1].toLowerCase()));

// ---------- META-TEND P1-VISUAL (REPORT 5.3 view 5): the memory map - MEMORY.md -> topic files, entries in no index, broken links ----------
export const MEMORY_MAX = { lines: 200, kb: 25 };   // Claude Code loads the first 200 lines / 25 KB of MEMORY.md (check 1)
const openCache = new Map();   // transcript -> { size, offset, opened { lc path: iso } } (only appended bytes are read again)
/** when each memory file was last opened: the Read / Edit tool calls (tool_use file_path) in the transcripts of the memory folder's own
 * project (the repo's main tree - where memory loads), changed in the last `days` days. -> Map lc(path) -> ISO time */
export function memoryOpened(memDir, { days = 30, now = Date.now() } = {}) {
  const out = new Map(), dir = path.dirname(memDir), want = lc(memDir) + '/';
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')); } catch { return out; }   // no transcripts: nothing was opened
  for (const n of names) {
    const f = path.join(dir, n);
    let st; try { st = fs.statSync(f); } catch { continue; }   // removed between list and stat: skip it
    if (now - st.mtimeMs > days * 86400000) continue;
    let c = openCache.get(f);
    if (!c || st.size < c.size) c = { size: 0, offset: 0, opened: {} };
    if (st.size > c.offset) {
      const buf = Buffer.alloc(st.size - c.offset), fd = fs.openSync(f, 'r');
      try { fs.readSync(fd, buf, 0, buf.length, c.offset); } finally { fs.closeSync(fd); }
      const text = buf.toString('utf8'), end = text.lastIndexOf('\n');
      if (end >= 0) {
        for (const l of text.slice(0, end).split('\n')) {
          if (!l.includes('"file_path"') || !l.includes('"tool_use"') || !/memory/i.test(l)) continue;
          const ts = l.match(/"timestamp":"([^"]+)"/)?.[1];
          if (!ts) continue;
          for (const m of l.matchAll(/"file_path":\s*"((?:[^"\\]|\\.)*)"/g)) {
            let p2; try { p2 = lc(JSON.parse(`"${m[1]}"`)); } catch { continue; }   // a malformed escape: not a path
            if (p2.startsWith(want) && !(c.opened[p2] >= ts)) c.opened[p2] = ts;
          }
        }
        c.offset += Buffer.byteLength(text.slice(0, end + 1));
      }
      c.size = st.size; openCache.set(f, c);
    }
    for (const [k, t] of Object.entries(c.opened)) if (!(out.get(k) >= t)) out.set(k, t);
  }
  return out;
}
/** rows (discover) -> { path, id, lines, kb, max_lines, max_kb, entries [{ line, title, file, id, exists }], broken [...entries],
 * topics [{ id, name, linked, changed, opened }], orphans [{ id, name }], opened_method } | null (no memory folder) */
export function memoryMap(rows, { opened = new Map() } = {}) {
  const idx = rows.find(r => r.kind === 'memory' && r.exists !== false);
  if (!idx) return null;
  const t = readText(idx.path) ?? '', dir = path.dirname(idx.path), topics = rows.filter(r => r.kind === 'memory-topic');
  const byPath = new Map(topics.map(r => [lc(r.path), r])), linked = new Map(), entries = [];
  t.split(/\r?\n/).forEach((l, i) => {
    for (const m of l.matchAll(/\[([^\]]+)\]\(([^)\s]+\.md)\)/g)) {
      const k = lc(path.join(dir, m[2])), r = byPath.get(k);
      entries.push({ line: i + 1, title: m[1], file: m[2], id: r?.id ?? null, exists: !!r || isFile(path.join(dir, m[2])) });
      linked.set(k, (linked.get(k) || 0) + 1);
    }
  });
  for (const r of topics) for (const m of (readText(r.path) || '').matchAll(/\]\(([^)\s]+\.md)\)/g)) { const k = lc(path.join(dir, m[1])); if (k !== lc(r.path)) linked.set(k, (linked.get(k) || 0) + 1); }   // a legacy index counts
  const lines = t.split(/\r?\n/).length - (t.endsWith('\n') ? 1 : 0);
  const tops = topics.map(r => ({ id: r.id, name: r.name, linked: linked.get(lc(r.path)) || 0, changed: r.changed ?? null, opened: opened.get(lc(r.path)) ?? null }));
  return { path: fwd(idx.path), id: idx.id, lines, kb: Math.round(Buffer.byteLength(t) / 102.4) / 10, max_lines: MEMORY_MAX.lines, max_kb: MEMORY_MAX.kb,
    index_opened: opened.get(lc(idx.path)) ?? null, entries, broken: entries.filter(e => !e.exists), topics: tops, orphans: tops.filter(x => !x.linked).map(({ id, name }) => ({ id, name })),
    opened_method: 'last opened = the newest Read / Edit tool call on the file in the transcripts of the main tree (where memory loads), last 30 days' };
}
