// The JavaScript / TypeScript definition and call-edge grader of the code graph (SPEC code-graph section 5, stage S4b): scip-typescript
// 0.6.2 (tools/grade/package.json, installed into Norn's tool cache by toolHome('grade')) indexes a copy of the commit's JS / TS files.
// `norn-code grade calls` starts it as `node scip-ts.mjs <in> <out>`; norn-code decodes the SCIP index itself (the `scip` crate).
// In: { root, files: [repo-relative paths: the JS / TS sources and the package.json / tsconfig / jsconfig files], manifests:
// [the tree's package.json files], copy: an empty scratch folder, scip: the index file to write }. Out: { scip, ms } | { na }.
// - The files are copied (scip-typescript writes nothing into the repo, and only the commit's files are indexed).
// - Workspace packages are linked under the copy's node_modules, as npm install would (a bare name of one resolves in the repo).
// - With no tsconfig.json at the root, one is written: allowJs (scip-typescript's own --infer-tsconfig leaves JS out as soon as one
//   .ts file exists, and never looks at .mjs / .cjs), moduleResolution Bundler (S4a's default for TS-only specifiers).
// It lives in tools/, not engine/: the engine never imports it.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [inFile, outFile] = process.argv.slice(2);
const { root, files, manifests, copy, scip } = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const done = o => fs.writeFileSync(outFile, JSON.stringify(o));
const TSCONFIG = { compilerOptions: { allowJs: true, checkJs: false, noEmit: true, target: 'esnext', module: 'preserve', moduleResolution: 'bundler', resolveJsonModule: true, skipLibCheck: true }, include: ['**/*'], exclude: ['node_modules'] };

let home;
try {
  const { toolHome } = await import(pathToFileURL(path.join(import.meta.dirname, '..', '..', 'engine', 'lib', 'slop', 'tools.mjs')).href);
  home = toolHome('grade');
} catch (e) { done({ na: `scip-typescript (tools/grade) not installed: ${String(e.message).split('\n')[0]}` }); process.exit(0); }
for (const f of files) { const d = path.join(copy, f); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(path.join(root, f), d); }
// the workspace packages: each package.json's `workspaces` globs over the tracked package.json folders
for (const pj of manifests) {
  let ws; try { ws = JSON.parse(fs.readFileSync(path.join(copy, pj), 'utf8')).workspaces; } catch { continue; }
  for (const g of Array.isArray(ws) ? ws : ws?.packages || []) for (const d of manifests.map(m => path.posix.dirname(m)).filter(d => path.matchesGlob(d, path.posix.join(path.posix.dirname(pj), g)))) {
    let name; try { name = JSON.parse(fs.readFileSync(path.join(copy, d, 'package.json'), 'utf8')).name; } catch { continue; }
    const l = path.join(copy, 'node_modules', name);
    if (name && !fs.existsSync(l)) { fs.mkdirSync(path.dirname(l), { recursive: true }); fs.symlinkSync(path.join(copy, d), l, 'junction'); }
  }
}
if (!fs.existsSync(path.join(copy, 'tsconfig.json'))) fs.writeFileSync(path.join(copy, 'tsconfig.json'), JSON.stringify(TSCONFIG));
const t0 = Date.now(), main = path.join(home, 'node_modules', '@sourcegraph', 'scip-typescript', 'dist', 'src', 'main.js');
const r = spawnSync(process.execPath, ['--max-old-space-size=8192', main, 'index', '--cwd', copy, '--output', scip, '--no-progress-bar'], { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 28, timeout: 1800000 });
if (r.status !== 0 || !fs.existsSync(scip)) done({ na: `scip-typescript failed (${r.error?.message || `exit ${r.status}`}): ${String(r.stderr || '').trim().split('\n').slice(-1)[0]}` });
else done({ scip, ms: Date.now() - t0 });
