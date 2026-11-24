// SloppaChoppa 2 S1c (SPEC 3.5): a fix by code instead of a resume round. Only what a rule file's `fix` list names is fixed: K1's
// whitespace (git names the added lines) and the allow-listed ESLint edits of LJ (a real `fix` object, or a suggestion by its
// messageId; `in: import` = only inside an import declaration - an unused local's initialiser may have an effect). The ESLint edits
// come from the tool's own JSON output of the head side, captured through slopCheck's tool hook (one more LJ run, only when an LJ
// finding is fixable). A file the worktree changed since HEAD is never edited. `norn slop fix` applies and commits nothing; the run
// end (supervisor) commits the fix as one `style(slop)` commit and checks the new head. Writes no state: the host writes the outcomes.
import fs from 'node:fs';
import path from 'node:path';
import { gitRun, slopCheck } from './check.mjs';
import { makeTool } from './tools.mjs';

/** the rule file's fix entry that covers a finding, or null. f.rule: `K1` or `LJ/<sub>` */
export function fixEntry(rules, f) {
  const [id, sub] = f.rule.split('/'), r = rules.find(x => x.id === id);
  return (r?.fix || []).find(e => (e.msg ? e.msg === f.msg : e.sub === sub && r.kind === 'lint' && r.tool === 'eslint')) || null;
}
const lineStart = (text, n) => text.split('\n').slice(0, n - 1).reduce((a, l) => a + l.length + 1, 0);
// K1: the edit git's whitespace message asks for, on the head text (null: nothing to strip there)
function wsEdit(text, f) {
  if (f.msg === 'new blank line at EOF') { const m = /\n(?:[ \t\r]*\n)+$/.exec(text); return m ? { a: m.index + 1, b: text.length, text: '' } : null; }
  const a = lineStart(text, f.line), end = text.indexOf('\n', a), line = text.slice(a, end < 0 ? text.length : end), m = /[ \t]+(?=\r?$)/.exec(line);
  return m ? { a: a + m.index, b: a + m.index + m[0].length, text: '' } : null;
}
// `in: import`: the edit lies inside one import declaration (from `import` at a line start to its module string)
function inImport(text, a, b) {
  const at = text.lastIndexOf('import', a), m = at >= 0 && (at === 0 || text[at - 1] === '\n') && /^import\b[^'"]*(['"])[^'"\n]*\1\s*;?/.exec(text.slice(at));
  return !!m && b <= at + m[0].length;
}
// an ESLint message's allow-listed edit, the whole line when it empties one
function eslintEdit(text, m, e) {
  const fx = e.suggestion ? (m.suggestions || []).find(s => s.messageId === e.suggestion)?.fix : m.fix;
  if (!fx || (e.in === 'import' && !inImport(text, fx.range[0], fx.range[1]))) return null;
  let [a, b] = fx.range;
  if (fx.text === '' && (a === 0 || text[a - 1] === '\n') && text[b] === '\n') b++;
  return { a, b, text: fx.text };
}

/**
 * The fixes for a check's open findings -> { edits: Map(file -> [{ a, b, text, f }]), fixed: [finding], left: [{ f, why }] }.
 * off: the classes (finding rules) switched off (host fixOff); tool: the real tool runner (the LJ capture run).
 */
export function planFixes({ repo, base, head = 'HEAD', open, rules, tool = makeTool(), off = new Set() }) {
  const edits = new Map(), fixed = [], left = [], texts = new Map(), lj = new Map();
  const headText = file => {
    if (texts.has(file)) return texts.get(file);
    let t = null;   // the head blob (the text git and ESLint read); crlf: the worktree holds it with CRLF line ends (core.autocrlf)
    try { const blob = gitRun(repo, ['show', `${head}:${file}`]), wt = fs.readFileSync(path.join(repo, file), 'utf8'); t = wt === blob ? { blob } : !blob.includes('\r') && wt === blob.replace(/\n/g, '\r\n') ? { blob, crlf: true } : null; } catch { /* gone or unreadable */ }
    texts.set(file, t); return t;
  };
  const eslintOf = rid => {   // the head side's raw ESLint report of rule rid, keyed file -> messages
    if (lj.has(rid)) return lj.get(rid);
    let raw = null;
    const capture = (r, side, o) => { const out = tool(r, side, o); if (r.tool === 'eslint' && side === 'head') raw = out; return out; };
    slopCheck({ repo, base, head, rules: rules.filter(r => r.id === rid), tool: capture });
    const by = new Map(raw ? JSON.parse(raw).map(x => [x.filePath.replace(/\\/g, '/'), x.messages]) : []);
    lj.set(rid, by); return by;
  };
  for (const f of open) {
    const e = fixEntry(rules, f), text = e && !off.has(f.rule) ? headText(f.file)?.blob ?? null : null;
    if (!e) continue;
    if (off.has(f.rule)) { left.push({ f, why: 'autofix off for this class' }); continue; }
    if (text === null) { left.push({ f, why: 'the file differs from HEAD in the worktree' }); continue; }
    const m = e.msg ? null : (eslintOf(f.rule.split('/')[0]).get(f.file) || []).find(x => x.ruleId === e.sub && x.line === f.line && x.message === f.msg);
    const ed = e.msg ? wsEdit(text, f) : m ? eslintEdit(text, m, e) : null;
    const mine = edits.get(f.file) || [];
    if (!ed || mine.some(x => ed.a < x.b && x.a < ed.b)) { left.push({ f, why: ed ? 'overlaps another fix' : 'no edit for it' }); continue; }
    edits.set(f.file, [...mine, { ...ed, f }]); fixed.push(f);
  }
  return { edits, fixed, left, texts };
}
/** write the planned edits into the worktree (the last edit first) -> the files written */
export function applyFixes(repo, plan) {
  for (const [file, es] of plan.edits) {
    const h = plan.texts.get(file);
    let t = h.blob;
    for (const e of [...es].sort((x, y) => y.a - x.a)) t = t.slice(0, e.a) + e.text + t.slice(e.b);
    fs.writeFileSync(path.join(repo, file), h.crlf ? t.replace(/\n/g, '\r\n') : t);
  }
  return [...plan.edits.keys()];
}
/** per class (the finding's rule), most first: "LJ/no-unused-vars 3, K1 2" */
export const fixCounts = fixed => Object.entries(fixed.reduce((a, f) => ({ ...a, [f.rule]: (a[f.rule] || 0) + 1 }), {})).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ${n}`).join(', ');
export const fixSubject = fixed => `style(slop): autofix ${fixed.length} finding${fixed.length === 1 ? '' : 's'} (${fixCounts(fixed)})`;

/**
 * The run end's fix (SPEC 3.5 "Where it runs" 2): plan, apply and commit only the files it wrote -> null (nothing fixable) |
 * { from (the unfixed head), to (the fix commit), fixed, files, subject }. A failed commit puts the files back and throws.
 */
export function autofixCommit({ repo, base, open, rules, tool, off }) {
  const plan = planFixes({ repo, base, open, rules, tool, off });
  if (!plan.fixed.length) return null;
  const from = gitRun(repo, ['rev-parse', 'HEAD']).trim(), files = applyFixes(repo, plan), subject = fixSubject(plan.fixed);
  try { gitRun(repo, ['add', '--', ...files]); gitRun(repo, ['commit', '-q', '-m', subject, '--', ...files]); }
  catch (e) { gitRun(repo, ['checkout', from, '--', ...files], { ok: [0, 1, 128] }); gitRun(repo, ['reset', '-q', '--', ...files], { ok: [0, 1, 128] }); throw e; }
  return { from, to: gitRun(repo, ['rev-parse', 'HEAD']).trim(), fixed: plan.fixed, files, subject };
}
