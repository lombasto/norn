// SloppaChoppa stage F (RM-43, takes in RM-38 S2; audit REPORT sec. 5-6): the second voice - the `model` rule kind. ONE call per check
// for every model rule the branch asks, no tools (or read-only in an empty folder), a lean launch (no standing context), by the reader
// policy.slop.voice_reader chose: by default the author's own family at another model of the policy table, never another vendor. The input is capped and ranked (sec. 5 budget); every finding must quote an added line
// verbatim or it is dropped (no invented findings), so its fingerprint (rule + file + quote) keeps new-only and waivers unchanged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { norm } from './scan.mjs';
import { classExecutor } from '../critique.mjs';
import { allowedClasses } from '../policy.mjs';
import { resolveShim } from '../paths.mjs';
import { harnessOf, adapterFor } from '../harness/index.mjs';
import { providersOf, typedExe, providerEnv, isOpenAI, cliMode } from '../executors.mjs';
import { presetExe } from '../presets.mjs';
import { withDefaults } from '../policy.mjs';

// the sec. 5 budget: about 3.3 bytes a token for this dense code (an estimate); the diff, the rest of the input (questions, rule hits,
// brief lines, project quality lines), the answer; at most 10 findings kept. timeout_ms: one read waits this long, then it is skipped.
export const VOICE = { bytes_per_token: 3.3, diff_tokens: 40000, input_tokens: 5000, output_tokens: 2000, max_findings: 10, timeout_ms: 600000 };
const bytes = tokens => Math.floor(tokens * VOICE.bytes_per_token);
// what a branch is, by its files: docs only (no read), tests (+ docs) only (the rules `on` tests: question 3), else code
const DOCS = ['**/*.md', 'docs/**', '**/*.txt'], TESTS = ['tests/**', '**/*.test.*', '**/*.spec.*'];
export function branchClass(paths, match) {
  if (paths.every(p => match(DOCS, p))) return 'docs';
  return paths.every(p => match(DOCS, p) || match(TESTS, p)) ? 'tests' : 'code';
}

/** the hunks of a unified diff: [{ file (head path), text (the hunk with its header), added: [{ line, text }] }] */
export function parseHunks(diff) {
  const out = [];
  let file = null, cur = null, at = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git ')) { file = null; cur = null; continue; }
    if (l.startsWith('+++ ')) { file = l === '+++ /dev/null' ? null : l.slice(6); cur = null; continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h && file) { cur = { file, text: l, added: [] }; out.push(cur); at = Number(h[1]); continue; }
    if (!cur || l.startsWith('--- ') || l.startsWith('\\')) continue;
    cur.text += '\n' + l;
    if (l.startsWith('+')) cur.added.push({ line: at++, text: l.slice(1) });
    else if (!l.startsWith('-')) at++;
  }
  return out;
}

/** the brief lines a read sends: its Scope / Tests / Done lines and its numbered items */
export const briefLines = text => String(text || '').split(/\r?\n/).filter(l => /^\s*(?:Scope|Tests|Done):/.test(l) || /^\s*\d+[.)]\s/.test(l));

/**
 * The ranked, capped input of one read (sec. 5): hunks with a rule hit first, then code, then tests, then the rest, up to the diff cap;
 * a file none of whose hunks fit is listed by name. rules: the asked model rules; hits: the check's new findings so far.
 * -> { prompt, shown (files shown), listed (files only named) }
 */
export function voicePrompt({ rules, hunks, hits = [], brief = '', context = [], match }) {
  const want = new Set(rules.flatMap(r => r.hits || []));
  const mine = hits.filter(h => want.has(h.rule));
  const hit = h => mine.some(f => f.file === h.file && h.added.some(a => a.line === f.line));
  const rank = h => (hit(h) ? 0 : match(TESTS, h.file) ? 2 : match(DOCS, h.file) ? 3 : 1);
  const order = hunks.map((h, i) => ({ h, i, r: rank(h) })).sort((a, b) => a.r - b.r || a.i - b.i);
  let left = bytes(VOICE.diff_tokens);
  const keep = new Set();
  for (const { h, i } of order) if (h.text.length + 1 <= left) { keep.add(i); left -= h.text.length + 1; }
  // the shown files in rank order: the model reads the leads first
  const shown = [...new Set(order.filter(o => keep.has(o.i)).map(o => o.h.file))], listed = [...new Set(hunks.map(h => h.file))].filter(f => !shown.includes(f));
  const diff = shown.map(f => `--- ${f}\n${hunks.filter((h, i) => keep.has(i) && h.file === f).map(h => h.text).join('\n')}`).join('\n');
  // the rest of the input, capped as one: the questions first (never cut), then the rule hits, the brief, the quality lines
  let room = bytes(VOICE.input_tokens);
  const part = (title, lines) => { if (!lines.length || room <= 0) return ''; const t = lines.join('\n').slice(0, room); room -= t.length; return `\n# ${title}\n${t}\n`; };
  const qs = rules.map(r => `${r.id}: ${r.question}${r.hits?.length ? ` (the rule hits of ${r.hits.join(', ')} below are its leads)` : ''}`);
  room -= qs.join('\n').length;
  const rest = part('Rule hits (the deterministic checks of this branch)', mine.map(f => `- ${f.rule} ${f.file}:${f.line} ${f.msg} | ${f.snippet}`))
    + part('The brief this branch answers (its Scope and numbered items)', briefLines(brief))
    + context.map(c => part(`Project quality lines (${c.file})`, c.text.split(/\r?\n/))).join('');
  const prompt = [
    "You are SloppaChoppa's second voice: a reviewer reading ONE branch diff. You have NO tools: answer from the text below only.",
    'Answer each question about the lines this diff ADDS (the + lines). Every finding quotes ONE added line verbatim (copied exactly, without',
    `the leading +): a finding whose quote is not an added line is dropped. At most ${VOICE.max_findings} findings, the surest first; no finding is a fine answer.`,
    '', '# Questions', ...qs, rest,
    '# The diff', diff || '(no hunk fits the budget)', ...(listed.length ? ['', `Changed but not shown (over the budget): ${listed.join(', ')}`] : []),
    '', '# Your answer',
    'ONE JSON object in a ```json fence and nothing after it:',
    '{"findings": [{"rule": "<question id>", "file": "<path as in the diff>", "quote": "<the added line, verbatim>", "why": "<one sentence>"}]}',
  ].join('\n');
  return { prompt, shown, listed };
}

/** the answer's findings: [{ rule, file, quote, why }]; throws when the answer holds no such JSON object */
export function parseVoice(text) {
  const t = String(text ?? ''), fences = [...t.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)], raw = fences.length ? fences[fences.length - 1][1] : t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1);
  let j;
  try { j = JSON.parse(raw); } catch { throw new Error(`the voice's answer is not the JSON form: ${norm(t).slice(0, 120)}`); }
  if (!Array.isArray(j?.findings)) throw new Error('the voice\'s answer has no "findings" list');
  return j.findings.filter(f => f && typeof f === 'object').map(f => ({ rule: String(f.rule ?? ''), file: String(f.file ?? ''), quote: String(f.quote ?? ''), why: String(f.why ?? '') }));
}

/**
 * The quote check: a finding is kept only when its rule was asked, its file is in the diff and its quote is an added line of that file
 * (whitespace-normalised: a model drops indentation); at most VOICE.max_findings kept. -> { kept: [finding], dropped: n }
 */
export function quoteCheck(found, { asked, hunks }) {
  const kept = [];
  for (const f of found) {
    if (kept.length >= VOICE.max_findings) break;
    const q = norm(f.quote), a = q && asked.includes(f.rule) && hunks.filter(h => h.file === f.file).flatMap(h => h.added).find(x => norm(x.text) === q);
    if (a) kept.push({ ...f, line: a.line, quote: a.text });
  }
  return { kept, dropped: found.length - kept.length };
}

// the one read of a check, shared by its model rules (as lint's one ESLint run): { [rule id]: [finding] } | null (no answer), an Error
function voiceRead(ctx) {
  if (ctx.voiceRead) { if (ctx.voiceRead instanceof Error) throw ctx.voiceRead; return ctx.voiceRead; }
  try {
    const cls = branchClass(ctx.entries.map(e => e.path), ctx.match);
    const asked = ctx.modelRules.filter(r => (r.on || ['code']).includes(cls));
    if (!asked.length) return (ctx.voiceRead = {});   // docs only, or a test-only branch with no tests question: no call
    const hunks = parseHunks(ctx.diff(asked.flatMap(r => r.files || ['**']), asked.flatMap(r => r.exclude || [])));
    const context = [...new Set(asked.flatMap(r => r.context || []))].map(f => ({ file: f, text: ctx.text('head', f) })).filter(c => c.text);
    const { prompt } = voicePrompt({ rules: asked, hunks, hits: ctx.found.filter(f => f.new), brief: ctx.brief, context, match: ctx.match });
    const raw = ctx.tool({ id: asked.map(r => r.id).join('+'), kind: 'model', prompt }, 'head', { dir: ctx.repo });
    if (raw === null) return (ctx.voiceRead = null);
    const { kept } = quoteCheck(parseVoice(raw), { asked: asked.map(r => r.id), hunks }), by = {};
    for (const f of kept) (by[f.rule] ||= []).push(f);
    return (ctx.voiceRead = by);
  } catch (e) { ctx.voiceRead = e; throw e; }
}
/** the `model` kind: (rule, ctx) -> { head, base: null } - a kept finding quotes an added line, so it is new by itself */
export function model(rule, ctx) {
  const by = voiceRead(ctx);
  return { head: by === null ? null : (by[rule.id] || []).map(f => ({ file: f.file, line: f.line, msg: `${rule.title}: ${f.why}`, snippet: f.quote })), base: null };
}

/**
 * The route of the second voice and the mode it is called in. policy.slop.voice_reader 'default': the author's own harness family
 * without tools, at the first model of the policy table (the review class first, then the others) other than authorModel, else its
 * same model, else the author executor at authorModel - never another family. A named reader ('<executor>[ <model>]'): only when it is
 * allowed to do review work (allowedClasses; the Settings save refuses it too), no tools when its family has the mode, else read-only
 * (in the voice's own empty folder: voiceCall). cap: policy.slop.voice_reads_per_day (the run end counts the day's reads).
 * -> { executor, family, mode, cap, model, effort, exe, entry } | null (no route can read)
 */
export function voiceRoute({ project, machine = null, author = 'claude', authorModel = null, env = process.env }) {
  const provs = providersOf(project), fam = ex => harnessOf(ex, provs[ex]), pol = withDefaults({ policy: project?.policy }).policy, classes = Object.keys(pol.executors);
  const routes = ['review', ...classes.filter(c => c !== 'review')].map(c => classExecutor(project, c)).filter(r => r.executor === 'fake' || r.model || provs[r.executor]?.model);
  // a family that has the mode; a cli entry must declare it too (its own modes)
  const can = (x, m) => { try { const e = provs[x.executor]; return adapterFor(fam(x.executor)).caps.modes.includes(m) && (e?.type !== 'cli' || cliMode(e, m)[1].access === m); } catch { return false; } };
  const modelOf = x => x.model || provs[x.executor]?.model || (x.executor === 'fake' ? 'fake' : null);
  const [name, named] = String(pol.slop.voice_reader || 'default').split(' ');
  let r, mode = 'no-tools';
  if (name === 'default') {
    const own = routes.filter(x => fam(x.executor) && fam(x.executor) === fam(author) && can(x, 'no-tools'));
    r = (authorModel && own.find(x => modelOf(x) !== authorModel)) || own[0] || (authorModel && can({ executor: author }, 'no-tools') ? { executor: author, model: authorModel } : null);
  } else {
    if (!allowedClasses(pol, name, Object.keys(provs)).includes('review')) return null;
    const x = classExecutor({ ...project, policy: { ...project?.policy, executors: { ...project?.policy?.executors, review: { executor: name, model: named || '', effort: '' } } } }, 'review'), row = routes.find(y => y.executor === x.executor);
    mode = can(x, 'no-tools') ? 'no-tools' : can(x, 'read-only') ? 'read-only' : null;
    r = mode && { ...x, model: named || modelOf(row || x), effort: row?.effort };
  }
  if (!r?.model && !modelOf(r || {})) return null;
  const entry = provs[r.executor] || null;
  const exe = entry?.preset ? presetExe(entry, env) : entry ? typedExe(entry, machine) : { claude: machine?.claude?.exe, 'codex-sol': machine?.codex?.exe, 'codex-astra': machine?.codex?.exe }[r.executor];
  return { executor: r.executor, family: fam(r.executor), mode, cap: pol.slop.voice_reads_per_day, model: r.model || modelOf(r), effort: r.effort || entry?.effort || 'medium', exe, entry };
}

// the read sees the prompt and nothing else: the adapter's lean launch (harness profileArgs) - no MCP server, no user setup (its memory,
// hooks, plugins), no skills, no dynamic system-prompt sections; an adapter without lean flags ignores it (its profileGap)
export const VOICE_PROFILE = { name: 'voice', mcp: 'none', user_setup: false, skills: false, dynamic_prompt: false };

/** the command of one read in dir: the brief and answer files in dir, the voice's working folder an empty one under it (a read-only
 *  voice reads nothing but stdin: the precedent is the check-in replay) -> { cmd, cwd, brief, final } */
export function voiceCall(route, dir) {
  const a = adapterFor(route.family), brief = path.join(dir, 'voice.md'), final = path.join(dir, 'final.md'), cwd = fs.mkdtempSync(path.join(dir, 'cwd-'));
  const cmd = a.command({ exe: route.exe, mode: route.mode, model: route.model, effort: route.effort, brief, final, worktree: cwd, addDirs: [], session_id: crypto.randomUUID(),
    remote: false, lane: 'slop', project: 'slop', executor: route.executor, profile: VOICE_PROFILE, ...(isOpenAI(route.entry) || route.entry?.type === 'cli' ? { provider: route.entry } : {}),
    promptText: 'The diff and the questions are on stdin. Answer with the JSON object only.' });
  return { cmd, cwd, brief, final };
}

/** one call on a route, in its mode: the prompt on stdin (and in the brief file) -> the answer text. Throws on a failed call. */
export function askVoice(route, prompt, { env = process.env } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-voice-'));
  try {
    const { cmd, cwd, brief, final } = voiceCall(route, dir);
    fs.writeFileSync(brief, prompt);
    const e = { ...env };
    if (route.entry && !isOpenAI(route.entry)) for (const [k, v] of Object.entries(providerEnv(route.entry, env).vars)) { if (v === null) delete e[k]; else e[k] = v; }
    const sp = resolveShim(cmd.exe, cmd.args);   // a Windows npm .cmd shim: node + its entry (spawnSync of a .cmd throws EINVAL), as the runs launch
    const r = spawnSync(sp.exe, sp.args, { cwd, env: e, input: prompt, encoding: 'utf8', windowsHide: true, timeout: VOICE.timeout_ms, maxBuffer: 1 << 26 });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`the voice (${route.executor} ${route.model}) exited ${r.status}: ${String(r.stderr || '').trim().split('\n').slice(-2).join(' ')}`);
    if (cmd.parse === 'claude') { try { return JSON.parse(r.stdout).result ?? ''; } catch { throw new Error(`the voice (${route.executor}) printed no result: ${norm(r.stdout).slice(0, 120)}`); } }
    return cmd.stdout === 'final' ? r.stdout : fs.readFileSync(final, 'utf8');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
