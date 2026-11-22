// project.json / machine.json loading (META-GENERAL-DESIGN 4.2 / 4.3): schema check, then ${var} expansion with cycle detection.
// Builtins: home, norn (engine root), name, root, state (= ${norn}/state/<name>), dev (default: parent of root; a project var may set it),
// project_dir (the directory of the project.json: a project's own files, wherever it lives - META-ONBOARD 3.2).
// ${lane} is late-bound (lane_defaults): it survives loading and is filled by expandLate at use.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerProblems } from './executors.mjs';
import { expandPresets } from './presets.mjs';
import { readText } from './fsnap.mjs';
import { normSubdir } from './monorepo.mjs';

export class ConfigError extends Error {}

const ENGINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSchema = n => JSON.parse(fs.readFileSync(path.join(ENGINE, 'schema', n), 'utf8'));
export const PROJECT_SCHEMA = readSchema('project.schema.json');
export const MACHINE_SCHEMA = readSchema('machine.schema.json');
export const fwd = p => String(p).replace(/\\/g, '/');
// The canonical path: realpath of the deepest existing ancestor + the rest (a path need not exist yet). A path as given may name the
// same place as git's / the OS's answer in another spelling - a Windows 8.3 short name (the hosted runners' TEMP is
// under the user dir's short name RUNNER~1), a junction, a symlink (macOS /var -> /private/var): compare paths by this, never raw (CI-RED-7E52345).
export function realPath(p) {
  const abs = path.resolve(String(p)), rest = [];
  for (let cur = abs; ;) {
    try { return path.join(fs.realpathSync.native(cur), ...rest); } catch { /* not there yet: try its parent */ }
    const up = path.dirname(cur);
    if (up === cur) return abs;
    rest.unshift(path.basename(cur)); cur = up;
  }
}
/** a path's identity for comparing / keying: canonical, forward slashes, no trailing slash, case-folded on Windows */
export const pathKey = p => { const a = fwd(realPath(p)).replace(/(.)\/+$/, '$1'); return process.platform === 'win32' ? a.toLowerCase() : a; };
export const metaRoot = (env = process.env) => fwd(env.META_ROOT || path.resolve(ENGINE, '..'));
export const homeDir = () => fwd(os.homedir());
const BUILTINS = ['home', 'norn', 'state', 'name', 'root', 'lane', 'project_dir'];
const LATE = ['lane'];
const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// JSON-schema subset: type (incl. lists, "integer"), enum, required, properties, additionalProperties (bool | schema), items, minimum, pattern.
export function validate(schema, v, at = '$') {
  const errs = [];
  const typeOf = x => (x === null ? 'null' : Array.isArray(x) ? 'array' : Number.isInteger(x) ? 'integer' : typeof x);
  if (schema.enum && !schema.enum.some(e => e === v)) return [`${at} must be one of ${schema.enum.join(', ')}`];
  if (schema.type) {
    const want = [].concat(schema.type), t = typeOf(v);
    if (!want.some(w => w === t || (w === 'number' && t === 'integer'))) return [`${at} must be ${want.join(' or ')}`];
  }
  if (typeof v === 'number' && schema.minimum !== undefined && v < schema.minimum) errs.push(`${at} must be >= ${schema.minimum}`);
  if (typeof v === 'string' && schema.pattern && !new RegExp(schema.pattern).test(v)) errs.push(`${at} must match ${schema.pattern}`);
  if (Array.isArray(v) && schema.items) v.forEach((x, i) => errs.push(...validate(schema.items, x, `${at}[${i}]`)));
  if (v && typeOf(v) === 'object') {
    for (const r of schema.required || []) if (!(r in v)) errs.push(`${at}.${r} is required`);
    for (const [k, x] of Object.entries(v)) {
      const ps = schema.properties?.[k];
      if (ps) errs.push(...validate(ps, x, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}.${k} is not allowed`);
      else if (typeof schema.additionalProperties === 'object') errs.push(...validate(schema.additionalProperties, x, `${at}.${k}`));
    }
  }
  return errs;
}

// vars: name -> template string (or a function returning one). Resolution is memoised; a revisit on the stack is a cycle.
function resolver(vars, late) {
  const done = new Map();
  const get = (name, stack) => {
    if (done.has(name)) return done.get(name);
    if (stack.includes(name)) throw new ConfigError(`cycle: ${[...stack.slice(stack.indexOf(name)), name].join(' -> ')}`);
    if (!Object.hasOwn(vars, name)) throw new ConfigError(`unknown variable \${${name}}`);
    const raw = typeof vars[name] === 'function' ? vars[name](n => get(n, [...stack, name])) : vars[name];
    const v = sub(raw, [...stack, name]);
    done.set(name, v);
    return v;
  };
  const sub = (s, stack) => String(s).replace(VAR, (m, n) => (late.includes(n) && !Object.hasOwn(vars, n) ? m : get(n, stack)));
  return s => sub(s, []);
}

export function expandVars(str, vars, { late = [] } = {}) { return resolver(vars, late)(str); }

export function expandLate(str, vars) {
  return String(str).replace(VAR, (m, n) => { if (!Object.hasOwn(vars, n)) throw new ConfigError(`unknown variable \${${n}}`); return String(vars[n]); });
}

function walk(v, f, at = '$') {
  if (typeof v === 'string') { try { return f(v); } catch (e) { throw new ConfigError(`${at}: ${e.message}`); } }
  if (Array.isArray(v)) return v.map((x, i) => walk(x, f, `${at}[${i}]`));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, f, `${at}.${k}`)]));
  return v;
}

function readJson(file) {
  const label = path.basename(file);
  let obj;
  try {   // META-DASH-ASYNC R1: snapshot-aware (lib/fsnap.mjs; BOM stripped): a lookup inside a primed dash request
    const t = readText(file); if (t === null) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    obj = JSON.parse(t);
  } catch (e) { throw new ConfigError(`${label}: ${e.code === 'ENOENT' ? 'not found: ' + fwd(file) : e.message}`); }
  return { label, obj };
}

/** The project with its preset-based executors expanded (presets.mjs); an unknown preset is a ConfigError. */
export function withPresets(obj, label = 'project.json') {
  try { return expandPresets(obj); } catch (e) { throw new ConfigError(`${label}: ${e.message}`); }
}

export function checkProject(obj, label = 'project.json') {
  obj = withPresets(obj, label);
  const errs = validate(PROJECT_SCHEMA, obj);
  if (errs.length) throw new ConfigError(`${label}: ${errs.join('; ')}`);
  for (const k of Object.keys(obj.vars || {})) if (BUILTINS.includes(k)) throw new ConfigError(`${label}: vars.${k} shadows a builtin`);
  const pe = providerProblems(obj);
  if (pe.length) throw new ConfigError(`${label}: ${pe.join('; ')}`);
  try { normSubdir(obj.subdir); } catch (e) { throw new ConfigError(`${label}: ${e.message}`); }
}

export function loadProject(file, { home = homeDir(), meta = metaRoot() } = {}) {
  const { label, obj: raw } = readJson(file);
  const obj = withPresets(raw, label);
  checkProject(obj, label);
  const vars = { ...obj.vars, home: fwd(home), norn: fwd(meta), name: obj.name, root: obj.root, state: '${norn}/state/${name}', project_dir: fwd(path.dirname(path.resolve(file))) };
  if (!Object.hasOwn(vars, 'dev')) vars.dev = get => get('root').replace(/\/+$/, '').replace(/\/[^/]*$/, '');
  const exp = resolver(vars, LATE);
  let out;
  try { out = walk(obj, exp); } catch (e) { throw new ConfigError(`${label}: ${e.message}`); }
  return { ...out, state: exp('${state}'), dev: exp('${dev}'), meta: fwd(meta), file: fwd(path.resolve(file)), project_dir: exp('${project_dir}') };
}

// machine.json slots that moved out (META-AGNOSTIC-EXEC: grok -> the project's executors.grok); `norn migrate` drops them
export const MOVED_SLOTS = ['grok'];
export function loadMachine(file, { home = homeDir(), meta = metaRoot() } = {}) {
  const { label, obj } = readJson(file);
  const errs = validate(MACHINE_SCHEMA, obj).map(e => (MOVED_SLOTS.some(k => e === `$.${k} is not allowed`) ? `${e} - run \`norn migrate\`` : e));
  if (errs.length) throw new ConfigError(`${label}: ${errs.join('; ')}`);
  const exp = resolver({ home: fwd(obj.home || home), norn: fwd(meta) }, []);
  try { return walk(obj, exp); } catch (e) { throw new ConfigError(`${label}: ${e.message}`); }
}

// issue #104: THE write path of local/machine.json, a read-modify-write. edit(raw) gets the stored file (unexpanded, BOM stripped; {} when
// there is none) and returns the top-level keys its writer owns; a key returned as undefined is dropped on purpose; every other key (ledger
// with its doorbell secret, usage, fed, any unknown one) is carried over unchanged, in its place. An unreadable file throws (never replaced
// blind). Atomic: a pid tmp file + rename. -> the object written.
export function updateMachine(file, edit) {
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {};
  const next = { ...raw, ...edit(structuredClone(raw)) };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(next, null, 1) + '\n'); fs.renameSync(tmp, file);
  return next;
}

// the stored (unexpanded) form of a path: ${norn}/... when under the engine root, else absolute with forward slashes
export function portable(p, { meta = metaRoot() } = {}) {
  const a = fwd(path.resolve(p)), m = fwd(meta).replace(/\/+$/, '');
  const same = process.platform === 'win32' ? a.toLowerCase().startsWith(m.toLowerCase() + '/') : a.startsWith(m + '/');
  return same ? '${norn}' + a.slice(m.length) : a;
}
