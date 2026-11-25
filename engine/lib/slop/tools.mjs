// META-SLOP-A + SloppaChoppa 2 S1b (SPEC 3.3 Q1 A): the pinned tools of the rules. Each is a LOCKED tool set in the repo's
// tools/<set>/ (lint: ESLint; ast: ast-grep, slop-langs SPEC 3.4) (package.json + package-lock.json, a hash for every package), installed with `npm ci --ignore-scripts` once per lock
// into Norn's own cache (<meta root>/state/tools/<set>/<lock hash>; never a worktree, never imported by the engine) and run from
// there. The main test suite reads RECORDED tool output (each rule's fixture); `norn slop fixtures` runs the real tools on them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { which, resolveShim } from '../paths.mjs';
import { metaRoot } from '../config.mjs';
import { askVoice } from './voice.mjs';
import { RUFF } from './lang/py.mjs';
import { CLIPPY } from './lang/rs.mjs';   // not lang/index.mjs: lang/js.mjs imports this module (a cycle)
import { SARIF } from './lang/sarif.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_SETS = path.join(HERE, '..', '..', '..', 'tools');
/** the project's own lint tools (S3): each pack runs it (ruff in the project's venv) or reads its log (clippy, a SARIF file); never pinned here */
const PROJECT_TOOLS = { ruff: RUFF, clippy: CLIPPY, sarif: SARIF };
export const TOOLS = { eslint: { set: 'lint', bin: ['node_modules', 'eslint', 'bin', 'eslint.js'] }, 'ast-grep': { set: 'ast' } };
const JS_FILES = ['**/*.mjs', '**/*.js', '**/*.cjs'];
/**
 * The flat config of one ESLint run, as module text: the lint rules' own core rules first (Choppa's data), then the repo's config
 * of the MERGE BASE (repo: true -> ./repo.eslint.config.mjs beside it; a branch's own edit never reaches the gate, SPEC 3.1), then
 * inline config comments off - last, so no repo block can switch them.
 */
export function eslintConfig({ rules = {}, repo = false }) {
  const head = { files: JS_FILES, languageOptions: { ecmaVersion: 'latest', sourceType: 'module' }, rules };
  const tail = { files: JS_FILES, linterOptions: { noInlineConfig: true } };
  return `${repo ? "import repo from './repo.eslint.config.mjs';\n" : ''}export default [${JSON.stringify(head)}, ...${repo ? 'repo' : '[]'}, ${JSON.stringify(tail)}];\n`;
}
export const NORN = path.join(HERE, '..', '..', 'bin', 'norn.mjs');
export const toolCache = (env = process.env) => path.join(metaRoot(env), 'state', 'tools');

/**
 * The home of a tool set, installed on first use: <cache>/<set>/<first 12 of the lock's sha256>. npm ci runs in a fresh folder
 * renamed into place when it is done, so a half install, or a second check installing at the same time, never shows as a home.
 * A cold cache with no network fails here: the rule could not run (a BLOCK, SPEC 3.4), never a pass.
 */
export function toolHome(set, env = process.env) {
  const src = path.join(TOOL_SETS, set), lock = fs.readFileSync(path.join(src, 'package-lock.json'));
  const hash = crypto.createHash('sha256').update(lock).digest('hex').slice(0, 12), home = path.join(toolCache(env), set, hash);
  if (fs.existsSync(path.join(home, 'node_modules'))) return home;
  const npm = which('npm', { env }), tmp = `${home}.${process.pid}-${Date.now()}`;
  if (!npm) throw new Error(`npm not found on PATH (Node.js ships it): the ${set} tool set cannot be installed`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(src, f), path.join(tmp, f));
    const { exe, args } = resolveShim(npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error']);
    const r = spawnSync(exe, args, { cwd: tmp, env: { ...env, npm_config_cache: path.join(toolCache(env), 'npm'), npm_config_update_notifier: 'false' }, encoding: 'utf8', windowsHide: true, timeout: 600000 });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`npm ci failed (lock ${hash}): ${String(r.stderr).trim().split('\n').slice(-2).join(' ')}`);
    try { fs.renameSync(tmp, home); } catch (e) { if (!fs.existsSync(path.join(home, 'node_modules'))) throw e; }   // another check won the race: the same lock
    return home;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** ESLint `-f json` output (paths relative to the run) -> [{ file, rule (PARSE: the file does not parse, SPEC 1.3 F6), line, column, endLine, endColumn, msg }] */
export const PARSE = 'parse';
export function parseEslint(raw) {
  return JSON.parse(raw).flatMap(r => r.messages.filter(m => m.ruleId || m.fatal).map(m => ({
    file: r.filePath.replace(/\\/g, '/'), rule: m.ruleId || PARSE, line: m.line, column: m.column, endLine: m.endLine ?? m.line, endColumn: m.endColumn ?? m.column, msg: m.message,
  })));
}
/** one ESLint run in a fresh folder inside the tool set's home (so the repo config's imports resolve there) -> raw JSON, paths relative */
function eslintRun(t, run, texts, env) {
  const home = toolHome(t.set, env), dir = fs.mkdtempSync(path.join(home, 'run-'));
  try {
    for (const [f, text] of texts) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); }
    const repo = typeof run.config === 'string';
    if (repo) fs.writeFileSync(path.join(dir, 'repo.eslint.config.mjs'), run.config);
    fs.writeFileSync(path.join(dir, 'eslint.config.mjs'), eslintConfig({ ...run, repo }));
    const r = spawnSync(process.execPath, [path.join(home, ...t.bin), '-f', 'json', '--no-warn-ignored', ...texts.keys()], { cwd: dir, env, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 });
    if (r.error) throw r.error;
    if ((r.status !== 0 && r.status !== 1) || !r.stdout.trim()) throw new Error(`eslint exited ${r.status}${r.stdout.trim() ? '' : ' with no report'}: ${String(r.stderr).trim().split('\n').slice(-2).join(' ')}`);
    return JSON.stringify(JSON.parse(r.stdout).map(x => ({ ...x, filePath: path.relative(dir, x.filePath) })));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/**
 * slop-langs SPEC 3.4: ONE ast-grep scan in a fresh folder inside the tool set's home - the texts under t/, every rule in ONE file
 * (JSON documents joined by ---) - with no ignore file honoured, so a dot folder or a .gitignore cannot hide a file. The binary is
 * the one @ast-grep/cli-<platform> package npm installed (never the node wrapper). Fail-closed: an exit other than 0 (8: a rule that
 * does not parse), an ERROR: line on stderr (exit 0 on a missing file) or a line that is not JSON throws - each ast rule could not
 * run. -> JSON [{ file (relative), ruleId, line, column, endLine (1-based), text }], sorted (ast-grep's order is not stable).
 */
function astGrepRun(t, run, texts, env) {
  const home = toolHome(t.set, env), at = path.join(home, 'node_modules', '@ast-grep'), pkg = fs.readdirSync(at).filter(d => d.startsWith('cli-'));
  if (pkg.length !== 1) throw new Error(`ast-grep: ${pkg.length} platform binaries installed in ${at} (one expected)`);
  const bin = path.join(at, pkg[0], process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep'), dir = fs.mkdtempSync(path.join(home, 'run-')), src = path.join(dir, 't');
  try {
    for (const [f, text] of texts) { fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true }); fs.writeFileSync(path.join(src, f), text); }
    fs.writeFileSync(path.join(dir, 'rules.yml'), run.rules.map(r => JSON.stringify(r)).join('\n---\n') + '\n');
    const r = spawnSync(bin, ['scan', '--rule', 'rules.yml', '--json=stream', ...['hidden', 'dot', 'exclude', 'global', 'parent', 'vcs'].flatMap(k => ['--no-ignore', k]), 't'],
      { cwd: dir, env, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 });
    return astGrepOut(r, dir, src);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
/** one ast-grep scan's spawn result (cwd dir, files under src) -> the sorted JSON report, or a throw (fail-closed, as above) */
export function astGrepOut(r, dir, src) {
  if (r.error) throw r.error;
  const lines = String(r.stderr).split('\n').map(l => l.trim()).filter(Boolean), err = lines.find(l => /^ERROR:/.test(l));
  if (r.status !== 0 || err) throw new Error(`ast-grep exited ${r.status}: ${err || [...new Set([lines[0], lines.at(-1)])].filter(Boolean).join(' ... ')}`);   // exit 8: "Cannot parse rule" first, the cause last
  const out = String(r.stdout).split('\n').filter(l => l.trim()).map(l => {
    let m; try { m = JSON.parse(l); } catch { throw new Error(`ast-grep output is not JSON: ${l.slice(0, 120)}`); }   // fail-closed: an unread report is no pass
    return { file: path.relative(src, path.resolve(dir, m.file)).replace(/\\/g, '/'), ruleId: m.ruleId, line: m.range.start.line + 1, column: m.range.start.column + 1, endLine: m.range.end.line + 1, text: m.text };
  });
  const key = x => [x.file, String(x.line).padStart(9), String(x.column).padStart(9), x.ruleId].join(' ');
  return JSON.stringify(out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)));
}

/**
 * The real tool runner: tool(rule, side, { dir, texts }) -> raw output | null (no output for that side). A tool rule here is the
 * ONE ESLint run of a check: { tool: 'eslint', rules, config (the merge base's repo config text, or null) } over texts,
 * Map(path -> that side's text), or the ONE ast-grep scan of a check: { tool: 'ast-grep', rules: [ast-grep rule data] } over texts;
 * a ruff / clippy rule goes to its language pack's run. A command rule runs once, at check time in dir (its output is the machine's, not a side's: the
 * check keeps only the lines whose source the diff touches). A model read (kind `model`: { id, prompt }) is one call on o.voice in
 * its mode, the route voiceRoute picked at the launch; with no route (a door, `norn slop check`) it throws: each model rule is a
 * WARN "could not run" (the voice holds nothing) and reads at the run end. o.used: the project's reads today; at the route's cap it
 * throws too (no call). tool.reads: the calls this tool made (the check record counts them). o.env.
 */
export function makeTool({ env = process.env, voice = null, used = 0 } = {}) {
  const tool = (rule, side, { dir, texts } = {}) => {
    if (rule.kind === 'model') {
      if (!voice) throw new Error('no second voice routed here: the model rules read at the run end');
      if (voice.cap != null && used + tool.reads >= voice.cap) throw new Error(`daily cap ${voice.cap} reached`);
      tool.reads++;   // a call made is a read of the quota, answered or not
      return askVoice(voice, rule.prompt, { env });
    }
    if (rule.kind === 'command') {
      const r = spawnSync(process.execPath, [NORN, ...rule.argv], { cwd: dir, env, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 });
      if (r.error) throw r.error;
      return r.stdout;
    }
    if (PROJECT_TOOLS[rule.tool]) return PROJECT_TOOLS[rule.tool].run(rule, side, { dir, texts, env });
    const t = TOOLS[rule.tool];
    if (!t) throw new Error(`${rule.id}: unknown tool ${rule.tool}`);
    return rule.tool === 'ast-grep' ? astGrepRun(t, rule, texts, env) : eslintRun(t, rule, texts, env);
  };
  tool.reads = 0;
  return tool;
}
export const runTool = makeTool();
