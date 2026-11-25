// The Rust definition and call-edge grader of the code graph (SPEC code-graph section 5, stage S4b): `rust-analyzer scip` of the
// release pinned in tools/grade/rust-analyzer.lock.json (a sha256 per platform's archive), installed on first use into Norn's tool
// cache (<cache>/grade/rust-analyzer/<lock hash 12>/<platform>-<arch>/), the archive's sha256 checked before it is opened.
// `norn-code grade calls` starts it as `node scip-rust.mjs <in> <out>` and decodes the SCIP indexes itself (the `scip` crate).
// In: { workspaces: [absolute folders, one per cargo workspace], target: a scratch CARGO_TARGET_DIR, out: a folder for the indexes }.
// Out: { version, indexes: [{ ws, scip, ms } | { ws, na }] } | { na }.
// rust-analyzer runs cargo metadata and the build scripts (a cargo-build class run): its own target dir, never the repo's.
// It lives in tools/, not engine/: the engine never imports it.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [inFile, outFile] = process.argv.slice(2);
const { workspaces, target, out } = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const done = o => fs.writeFileSync(outFile, JSON.stringify(o));
const raw = fs.readFileSync(path.join(import.meta.dirname, 'rust-analyzer.lock.json')), lock = JSON.parse(raw);

/** the pinned binary, installed on first use; throws when it cannot be had (no pin for this OS, no network, a wrong checksum) */
async function install() {
  const { toolCache, fetchFile } = await import(pathToFileURL(path.join(import.meta.dirname, '..', '..', 'engine', 'lib', 'slop', 'tools.mjs')).href);
  const key = `${process.platform}-${process.arch}`, a = lock.assets[key];
  if (!a) throw new Error(`rust-analyzer ${lock.version} has no pinned archive for ${key}`);
  const home = path.join(toolCache(), 'grade', 'rust-analyzer', crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12), key), bin = path.join(home, a.bin);
  if (fs.existsSync(bin)) return bin;
  const tmp = `${home}.${process.pid}-${Date.now()}`, arc = path.join(tmp, a.file);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    fetchFile(lock.url.split('{version}').join(lock.version).split('{file}').join(a.file), arc);
    const got = crypto.createHash('sha256').update(fs.readFileSync(arc)).digest('hex');
    if (got !== a.sha256) throw new Error(`${a.file}: sha256 ${got.slice(0, 12)}, the lock pins ${a.sha256.slice(0, 12)}: not installed`);
    if (a.file.endsWith('.gz')) fs.writeFileSync(path.join(tmp, a.bin), zlib.gunzipSync(fs.readFileSync(arc)));
    else {
      // a zip: Windows' own bsdtar reads it (Git's GNU tar on PATH cannot)
      const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
      const r = spawnSync(tar, ['-xf', a.file, a.bin], { cwd: tmp, encoding: 'utf8', windowsHide: true, timeout: 120000 });
      if (r.status !== 0) throw new Error(`${a.file}: tar could not extract ${a.bin}: ${String(r.stderr).trim().split('\n').slice(-1)[0]}`);
    }
    fs.rmSync(arc); fs.chmodSync(path.join(tmp, a.bin), 0o755);
    try { fs.renameSync(tmp, home); } catch (e) { if (!fs.existsSync(bin)) throw e; }   // another run won the race: the same lock
    return bin;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

let bin;
try { bin = await install(); } catch (e) { done({ na: `rust-analyzer (tools/grade) not installed: ${String(e.message).split('\n')[0]}` }); process.exit(0); }
fs.mkdirSync(out, { recursive: true });
const indexes = workspaces.map((ws, i) => {
  const scip = path.join(out, `ra-${i}.scip`), t0 = Date.now();
  const r = spawnSync(bin, ['scip', ws, '--output', scip], { env: { ...process.env, CARGO_TARGET_DIR: target }, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 28, timeout: 3600000 });
  if (r.status !== 0 || !fs.existsSync(scip)) return { ws, na: `rust-analyzer scip failed (${r.error?.message || `exit ${r.status}`}): ${String(r.stderr || '').trim().split('\n').slice(-1)[0]}` };
  return { ws, scip, ms: Date.now() - t0 };
});
done({ version: lock.version, indexes });
