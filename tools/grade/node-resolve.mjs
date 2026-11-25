// The JavaScript / TypeScript file-edge grader of the code graph (SPEC code-graph section 5, stage S4a): Node's own resolver, run from
// each importing file. `norn-code grade files` starts it as `node --experimental-import-meta-resolve node-resolve.mjs <in> <out>`
// (the flag makes import.meta.resolve take a parent URL). In: { root, sites: [{ id, from, spec, kind }] }; out: { results: [{ id,
// targets: [repo-relative file] } | { id, na }] }, targets empty when the import loads nothing inside the repo (a builtin, a
// registry package, a missing file).
// - ESM (`import`, `reexport`): import.meta.resolve(spec, the file's URL), the result kept only when it is a file on disk.
// - CommonJS (`require`): createRequire(file).resolve(spec).
// - TypeScript (an importing .ts / .tsx / .mts / .cts file, `type` imports, and the TS-only specifiers Node cannot load: an
//   extensionless or folder path): ts.resolveModuleName from the pinned typescript (tools/grade/package.json), the nearest
//   tsconfig.json / jsconfig.json's options, else moduleResolution Bundler with allowJs.
// - Workspace packages: npm links them under node_modules on install; a git checkout has none, so a bare name of a workspace
//   package resolves from a scratch folder whose node_modules links each one (what `npm install` would make).
// It lives in tools/, not engine/: the engine never imports it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const [inFile, outFile] = process.argv.slice(2);
const { root, sites } = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const TS_FILE = /\.(?:ts|tsx|mts|cts)$/i, isFile = f => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const abs = rel => path.join(root, rel);
/** an absolute path -> repo-relative with '/' (null outside the repo) */
const relOf = f => { const r = path.relative(fs.realpathSync.native(root), fs.realpathSync.native(f)).split(path.sep).join('/'); return r.startsWith('..') || path.isAbsolute(r) ? null : r; };
const inRepo = f => (f && isFile(f) ? [relOf(f)].filter(Boolean) : []);
const bare = s => !/^(?:\.{1,2}(?:\/|$)|\/|#|[a-z]+:)/i.test(s);
const pkgName = s => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]);

let ts = null, tsWhy = null;
/** the pinned typescript, installed into Norn's tool cache on first use (engine/lib/slop/tools.mjs toolHome) */
async function typescript() {
  if (ts || tsWhy) return ts;
  try {
    const { toolHome } = await import(pathToFileURL(path.join(import.meta.dirname, '..', '..', 'engine', 'lib', 'slop', 'tools.mjs')).href);
    ts = createRequire(path.join(toolHome('grade'), 'package.json'))('typescript');
  } catch (e) { tsWhy = `typescript (tools/grade) not installed: ${String(e.message).split('\n')[0]}`; }
  return ts;
}
const tsOptions = new Map();
function optionsFor(file) {
  const dir = path.dirname(file);
  if (tsOptions.has(dir)) return tsOptions.get(dir);
  const cfg = ts.findConfigFile(dir, ts.sys.fileExists, 'tsconfig.json') || ts.findConfigFile(dir, ts.sys.fileExists, 'jsconfig.json');
  let o = { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, allowJs: true, resolveJsonModule: true };
  if (cfg && relOf(cfg) !== null) {
    const j = ts.readConfigFile(cfg, ts.sys.readFile);
    if (!j.error) o = { allowJs: true, ...ts.parseJsonConfigFileContent(j.config, ts.sys, path.dirname(cfg)).options };
  }
  tsOptions.set(dir, o);
  return o;
}
async function viaTs(spec, file) {
  if (!(await typescript())) return { na: tsWhy };
  const r = ts.resolveModuleName(spec, file, optionsFor(file), ts.sys).resolvedModule;
  return { targets: r && !r.isExternalLibraryImport ? inRepo(r.resolvedFileName) : [] };
}

// the workspace packages (every package.json `workspaces` glob in the repo) linked under a scratch node_modules
const workspaces = new Map();
for (const pj of fs.globSync('**/package.json', { cwd: root, exclude: d => path.basename(d) === 'node_modules' || path.basename(d) === '.git' })) {
  let ws; try { ws = JSON.parse(fs.readFileSync(abs(pj), 'utf8')).workspaces; } catch { continue; }
  const globs = Array.isArray(ws) ? ws : ws?.packages || [];
  for (const g of globs) for (const d of fs.globSync(path.posix.join(path.posix.dirname(pj), g), { cwd: root })) {
    try { const name = JSON.parse(fs.readFileSync(path.join(abs(d), 'package.json'), 'utf8')).name; if (name) workspaces.set(name, abs(d)); } catch { /* not a package */ }
  }
}
let shadow = null;
function shadowDir() {
  if (shadow) return shadow;
  shadow = fs.mkdtempSync(path.join(os.tmpdir(), 'norn-grade-ws-'));
  for (const [name, dir] of workspaces) { const l = path.join(shadow, 'node_modules', name); fs.mkdirSync(path.dirname(l), { recursive: true }); fs.symlinkSync(dir, l, 'junction'); }
  return shadow;
}

function viaNode(spec, file, kind) {
  try {
    if (kind === 'require') return inRepo(createRequire(file).resolve(spec));
    const u = import.meta.resolve(spec, pathToFileURL(file).href);
    return u.startsWith('file:') ? inRepo(fileURLToPath(u)) : [];
  } catch { return []; }
}

async function grade({ id, from, spec, kind }) {
  const file = abs(from);
  if (TS_FILE.test(from) || kind === 'type') {
    const r = await viaTs(spec, file);
    if (r.na || r.targets.length || !bare(spec) || !workspaces.has(pkgName(spec))) return { id, ...r };
    return { id, ...(await viaTs(spec, path.join(shadowDir(), 'x.ts'))) };
  }
  let t = viaNode(spec, file, kind);
  if (!t.length && bare(spec) && workspaces.has(pkgName(spec))) t = viaNode(spec, path.join(shadowDir(), 'x.mjs'), kind);
  if (!t.length && !bare(spec) && !spec.startsWith('#') && !path.extname(spec)) return { id, ...(await viaTs(spec, file)) };
  return { id, targets: t };
}

const results = [];
for (const s of sites) results.push(await grade(s));
fs.writeFileSync(outFile, JSON.stringify({ results }));
if (shadow) fs.rmSync(shadow, { recursive: true, force: true });
