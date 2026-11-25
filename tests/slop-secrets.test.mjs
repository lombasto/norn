// RM-a-69 (secrets-rule): the built-in BLOCK rule LS - the pinned secrets scanner (tools/gitleaks: a manifest and a lock with a sha256
// per OS archive, installed into Norn's tool cache) runs over the branch's ADDED lines only, and its SARIF is read by the lint kind's
// tool `sarif`. A scanner that cannot install (no network, a wrong checksum) or run is the fail-closed "could not run". A found key is
// never printed: the finding names the file, the line and the scanner's rule. Every test key here is built at test time from harmless
// parts (a committed key, even a fake one, trips the host's push protection), and no assertion message ever carries one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadRules, slopCheck, explainOf } from '../engine/lib/slop/check.mjs';
import { makeTool, binHome, SCANNERS } from '../engine/lib/slop/tools.mjs';
import { lintersView } from '../engine/lib/slop/linters.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const NORN = path.join(import.meta.dirname, '..', 'engine', 'bin', 'norn.mjs');
const TOOLS = path.join(import.meta.dirname, '..', 'tools', 'gitleaks');
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const put = (dir, files) => { for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); } };
/** a repo: main = base files, feat/x = head files */
function repoOf(base, head) {
  const dir = mkTmp('meta-slop-secrets-');
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'core.autocrlf', 'false');
  put(dir, base); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feat/x'); put(dir, head); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--allow-empty', '-m', 'head');
  return dir;
}
// a token in the shape of a personal access token, joined here so no file of the repo holds one; a second one for the old line
const KEY = ['g', 'hp', '_', 'Zq8Lm2Rt', '7VxKp4Nw', '9BsHd3Fj', '6GcTy1Ue', '5IoAa0'].join('');
const OLD = ['g', 'hp', '_', 'Wc4Hs8Pd', '2KfMy6Qt', '0RbXn3Lv', '7JeGz5Ua', '9DkYi1'].join('');
/** true when s carries the key, or any 8 characters of its body (a partly redacted print is a print too) */
const leaks = (s, k = KEY) => { for (let i = 4; i + 8 <= k.length; i++) if (s.includes(k.slice(i, i + 8))) return true; return false; };
const LS = loadRules().find(r => r.id === 'LS');
const META = mkTmp('meta-slop-secrets-cache-');   // one tool cache for the real-scanner tests: the scanner downloads once
const env = { ...process.env, META_ROOT: META };
const lock = JSON.parse(fs.readFileSync(path.join(TOOLS, 'lock.json'), 'utf8'));

test('LS: a built-in BLOCK lint rule of tool sarif, run by the pinned scanner; its explain says to rotate the key first', () => {
  assert.ok(LS, 'LS loads');
  assert.deepEqual([LS.level, LS.kind, LS.tool, LS.scan, LS.quote], ['BLOCK', 'lint', 'sarif', 'gitleaks', false]);
  assert.equal(LS.levels['*'], 'BLOCK');
  assert.ok(!LS.machine, 'LS runs in `norn slop check --ci` too');
  const ex = explainOf('LS');
  assert.match(ex.fix, /rotate/i); assert.match(ex.fix, /first/i); assert.match(ex.fix, /not enough/i);
  for (const k of ['what', 'why', 'fix']) assert.ok(ex[k].trim(), k);
  // the rule file's fixture holds the key in harmless parts; loadRules joins them
  const raw = fs.readFileSync(path.join(import.meta.dirname, '..', 'engine', 'lib', 'slop', 'rules', 'LS.json'), 'utf8');
  assert.ok(Array.isArray(JSON.parse(raw).fixture.hit.head['src/conf.py']), 'the hit text is parts in the file');
  assert.equal(typeof LS.fixture.hit.head['src/conf.py'], 'string', 'loadRules joins them');
});

test('the pin: a manifest and a lock with a sha256 per OS archive, a permissive licence, the same version in both', () => {
  const man = JSON.parse(fs.readFileSync(path.join(TOOLS, 'manifest.json'), 'utf8'));
  assert.equal(man.licence, 'MIT');
  assert.equal(man.version, lock.version);
  for (const k of ['win32-x64', 'linux-x64', 'darwin-x64', 'darwin-arm64', 'linux-arm64']) {
    assert.match(lock.assets[k]?.sha256 ?? '', /^[0-9a-f]{64}$/, k);
    assert.ok(lock.assets[k].file.includes(lock.version), k);
  }
  assert.deepEqual(Object.keys(SCANNERS), ['gitleaks']);
});

test('a scanner that cannot install is could not run (BLOCK): no network, and a download whose sha256 is not the lock\'s', () => {
  const repo = repoOf({ 'src/conf.py': 'HOST = "example.test"\n' }, { 'src/conf.py': `HOST = "example.test"\nTOKEN = "${KEY}"\n` });
  const cases = [[() => { throw new Error('getaddrinfo ENOTFOUND github.com'); }, /could not run: .*ENOTFOUND/],
    [(url, dest) => fs.writeFileSync(dest, 'not the archive'), /could not run: .*sha256 [0-9a-f]{12}, the lock pins [0-9a-f]{12}/]];
  for (const [download, want] of cases) {
    const cold = { ...process.env, META_ROOT: mkTmp('meta-slop-secrets-cold-') };
    const r = slopCheck({ repo, base: 'main', rules: [LS], tool: makeTool({ env: cold, download }) });
    assert.deepEqual(r.blocks.map(b => [b.rule, b.file, b.level]), [['LS', '*', 'BLOCK']]);
    assert.match(r.blocks[0].msg, want);
    assert.ok(!leaks(JSON.stringify(r)), 'no key in the result');
    const set = path.join(cold.META_ROOT, 'state', 'tools', 'gitleaks');
    assert.deepEqual(fs.existsSync(set) ? fs.readdirSync(set).filter(d => fs.readdirSync(path.join(set, d)).length) : [], [], 'nothing installed, no half install left');
  }
});

test('the real scanner: a key on an added line is LS/<scanner rule> BLOCK at its file and line; an old key on an untouched line is not; the key is never printed', () => {
  const repo = repoOf({ 'src/conf.py': `HOST = "example.test"\nOLD = "${OLD}"\n`, 'docs/a.md': '# a\n' },
    { 'src/conf.py': `HOST = "example.test"\nOLD = "${OLD}"\nPORT = 8080\nTOKEN = "${KEY}"\n`, 'docs/a.md': '# a\n\nNothing secret here.\n' });
  const r = slopCheck({ repo, base: 'main', rules: [LS], tool: makeTool({ env }) });
  assert.ok(!r.findings.some(f => f.unrun), JSON.stringify(r.findings.map(f => f.msg)));
  const at = [...new Set(r.blocks.map(b => `${b.file}:${b.line}`))];
  assert.deepEqual(at, ['src/conf.py:4'], 'only the added line with the key');
  assert.ok(r.blocks.some(b => b.rule === 'LS/github-pat'), r.blocks.map(b => b.rule).join(' '));
  assert.ok(r.blocks.every(b => b.level === 'BLOCK' && b.new && /^LS\/[\w-]+$/.test(b.rule)));
  assert.ok(!leaks(JSON.stringify(r)) && !leaks(JSON.stringify(r), OLD), 'no key in the result: message, snippet, fingerprint');
  assert.ok(r.blocks.every(b => !b.msg.includes(META) && !/[\\/]s[\\/]r[\\/]/.test(b.msg)), 'no scan folder in the message');
  // the install is checksum-verified and kept: the binary sits under the lock's hash, one folder per OS
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(TOOLS, 'lock.json'))).digest('hex').slice(0, 12);
  const bin = binHome('gitleaks', env);
  assert.ok(bin.startsWith(path.join(META, 'state', 'tools', 'gitleaks', hash, `${process.platform}-${process.arch}`)), bin);
  // the same key again on a moved line in a later commit keeps its fingerprint (the line's hash, never its text)
  const fp = r.blocks.find(b => b.rule === 'LS/github-pat').fp;
  put(repo, { 'src/conf.py': `# moved\nHOST = "example.test"\nOLD = "${OLD}"\nPORT = 8080\nTOKEN = "${KEY}"\n` }); git(repo, 'commit', '-qam', 'move');
  const r2 = slopCheck({ repo, base: 'main', rules: [LS], tool: makeTool({ env }) });
  assert.equal(r2.blocks.find(b => b.rule === 'LS/github-pat')?.fp, fp);
});

test('the scanner reads no ignore file, config or inline allow of the branch: a waiver is the way', () => {
  const repo = repoOf({ 'a.txt': 'a\n' }, { 'a.txt': 'a\n', '.gitleaksignore': 'src/conf.py:github-pat:2\n*\n', '.gitleaks.toml': '[allowlist]\npaths = [".*"]\n',
    'src/conf.py': `X = 1\nTOKEN = "${KEY}" # gitleaks:allow\n` });
  const r = slopCheck({ repo, base: 'main', rules: [LS], tool: makeTool({ env }) });
  assert.ok(!r.findings.some(f => f.unrun), JSON.stringify(r.findings.map(f => f.msg)));
  assert.ok(r.blocks.some(b => b.rule === 'LS/github-pat' && b.file === 'src/conf.py' && b.line === 2), r.blocks.map(b => `${b.rule} ${b.file}:${b.line}`).join(' '));
  assert.ok(!leaks(JSON.stringify(r)));
});

test('`norn slop check --ci` runs LS: BLOCK with file and line, exit 1, and prints no key', () => {
  const repo = repoOf({ 'src/conf.py': 'X = 1\n' }, { 'src/conf.py': `X = 1\nTOKEN = "${KEY}"\n` });
  const r = spawnSync(process.execPath, [NORN, 'slop', 'check', '--ci', '--diff', 'main..HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 300000, env });
  assert.equal(r.status, 1, 'exit 1: a BLOCK holds');
  assert.match(r.stdout, /^BLOCK LS\/github-pat `src\/conf\.py:2`/m, r.stdout.split('\n').filter(l => /LS/.test(l) && !leaks(l)).join('\n'));
  assert.ok(!leaks(r.stdout + r.stderr), 'no key printed');
});

test('Slop > Rules\' Linters lists the pinned scanner with its version, lock hash and its rule', () => {
  const v = lintersView([], { rules: loadRules() }), g = v.tools.find(t => t.tool === 'gitleaks');
  assert.ok(g, v.tools.map(t => t.tool).join(' '));
  assert.equal(g.version, lock.version);
  assert.match(g.lock, /^[0-9a-f]{12}$/);
  assert.deepEqual(g.rules, ['LS']);
  assert.deepEqual(g.levels.BLOCK, ['*']);
});
