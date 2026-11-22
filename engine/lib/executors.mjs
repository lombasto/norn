// Configurable executors (META-EXEC-S1, META-AGNOSTIC-EXEC). Built-ins (claude, fake, codex-sol, codex-astra) keep their own code
// paths; every other executor is DATA: project.json executors.<name> with a `type` (DIR-66, DEC-622):
//  - "claude-compatible": runs through the Claude Code CLI with ANTHROPIC_* vars from the entry (base_url, api_key_env, model, ...)
//  - "openai-compatible": runs through the Codex CLI as a custom model provider (-c model_provider=<name> -c model_providers.<name>.*;
//    base_url, api_key_env, model, wire_api? only "responses" - codex-cli 0.162.1 refuses "chat")
//  - "cli": any headless CLI - exe, model, effort, turns?, brief "file" | "stdin", output "plain", common `args` with {cwd} {brief}
//    {model} {effort} {turns} placeholders ("{mode}" = where the mode's args go), NAMED modes { access, args }, exit_after_s? (the exit watch, harness/cli.mjs).
// Keys are read by NAME (api_key_env) from the env at spawn time, never written. Every typed executor has its own machine cap
// max_<name> (default: the entry's `cap`, else 1). No per-provider code anywhere: every view / cap / doctor line takes the configured names.
import fs from 'node:fs';
import path from 'node:path';
import { CAP_KEYS, HOOKS, RESUME_STYLES, CHATS } from './harness/common.mjs';

export const BUILTIN = {
  claude: { kind: 'worker', harness: 'claude', caps: ['max_claude_workers'] },
  fake: { kind: 'fake', harness: 'fake', caps: ['max_claude_workers'] },
  'codex-sol': { kind: 'codex', harness: 'codex', caps: ['max_codex', 'max_sol'] },
  'codex-astra': { kind: 'codex', harness: 'codex', caps: ['max_codex', 'max_astra'] },
};
export const PROVIDER_TYPE = 'claude-compatible';
export const OPENAI_TYPE = 'openai-compatible';
export const CLI_TYPE = 'cli';
export const API_TYPES = [PROVIDER_TYPE, OPENAI_TYPE];
export const TYPES = [...API_TYPES, CLI_TYPE];
export const PROVIDER_KIND = 'provider';                  // RUN kind of an API-typed executor
export const CLI_KIND = 'cli';                            // RUN kind of a cli-typed executor
export const PROVIDER_CLASSES = ['chores', 'passfail'];   // default rank of every typed executor
export const PROVIDER_CAP_DEFAULT = 1;                    // max_<name> when the machine budget and the entry have none
export const ACCESS = ['write', 'read-only', 'no-tools'];
export const WIRE_APIS = ['responses'];                 // codex-cli 0.162.1 refuses wire_api = "chat"
export const NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
export const KEY_ENV_RE = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_VARS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];
const SECRET_FIELDS = ['api_key', 'auth_token', 'key', 'token'];
const PLACEHOLDERS = ['cwd', 'brief', 'model', 'effort', 'turns'];
const NEW_CAPS = ['fork', 'hooks', 'resume_style', 'noninteractive'];

/**
 * Problems with a cli entry's (or preset's) caps (META-GTP-HARNESS): every key a known cap (harness/common CAP_KEYS), each new flag
 * typed, and every named mode's access listed in caps.modes (a mode its caps lack). required: the new flags + modes must be there.
 */
export function capsProblems(at, x, { required = false } = {}) {
  const errs = [], c = x.caps;
  if (c === undefined) return required ? [`${at}.caps is required`] : [];
  if (!c || typeof c !== 'object' || Array.isArray(c)) return [`${at}.caps must be an object`];
  for (const k of Object.keys(c)) if (!CAP_KEYS.includes(k)) errs.push(`${at}.caps.${k} is not a known cap (${CAP_KEYS.join(' | ')})`);
  if (required) for (const k of ['modes', ...NEW_CAPS]) if (!Object.hasOwn(c, k)) errs.push(`${at}.caps.${k} is required`);
  if (c.fork !== undefined && typeof c.fork !== 'boolean') errs.push(`${at}.caps.fork must be true | false`);
  if (c.hooks !== undefined && !HOOKS.includes(c.hooks)) errs.push(`${at}.caps.hooks must be ${HOOKS.join(' | ')}`);
  if (c.resume_style !== undefined && !RESUME_STYLES.includes(c.resume_style)) errs.push(`${at}.caps.resume_style must be ${RESUME_STYLES.join(' | ')}`);
  if (c.chat !== undefined && !CHATS.includes(c.chat)) errs.push(`${at}.caps.chat must be ${CHATS.join(' | ')}`);
  if (c.noninteractive !== undefined && c.noninteractive !== null && (typeof c.noninteractive !== 'string' || !c.noninteractive)) errs.push(`${at}.caps.noninteractive must be the headless flag (a string) or null`);
  if (c.modes !== undefined) {
    if (!Array.isArray(c.modes) || !c.modes.every(m => ACCESS.includes(m))) errs.push(`${at}.caps.modes must list access levels (${ACCESS.join(' | ')})`);
    else for (const [m, d] of Object.entries(x.modes || {})) if (ACCESS.includes(d?.access) && !c.modes.includes(d.access)) errs.push(`${at}.modes.${m} is ${d.access} but caps.modes lacks it (${c.modes.join(' | ')})`);
  }
  return errs;
}

/** A claude-compatible entry (the Claude CLI path with ANTHROPIC_* vars). */
export const isProvider = x => !!x && x.type === PROVIDER_TYPE;
export const isOpenAI = x => !!x && x.type === OPENAI_TYPE;
export const isApi = x => !!x && API_TYPES.includes(x.type);
export const isCli = x => !!x && x.type === CLI_TYPE;
export const isTyped = x => !!x && TYPES.includes(x.type);
/** { name: entry } of the project's typed executors (every type; enabled or not). */
export function providersOf(project) {
  return Object.fromEntries(Object.entries(project?.executors || {}).filter(([, x]) => isTyped(x)));
}
export const capKey = name => `max_${name}`;
/** max_<name> when the machine budget has none: the entry's `cap`, else 1. */
export const capDefault = entry => (Number.isInteger(entry?.cap) ? entry.cap : PROVIDER_CAP_DEFAULT);
// META-OOTB F-2: the role agents a project's policy may route work to = its own agent files (install.agents/*.md: `project new`
// installs the engine's generic implementer / planner / runner there) + any other agent name its policy already routes to (a
// project using another project's agents, e.g. norn on a product project's). Sorted; never a built-in, typed executor or fallback keyword.
const NOT_AGENTS = ['auto', 'fable', 'opus-xhigh', 'wait', 'claude', 'fake'];
export function roleAgents(project) {
  const names = new Set(), pv = providersOf(project), dir = project?.install?.agents;
  try { if (dir) for (const f of fs.readdirSync(dir)) if (f.endsWith('.md') && fs.statSync(path.join(dir, f)).isFile()) names.add(f.slice(0, -3)); } catch { /* no dir */ }
  const pol = project?.policy || {};
  for (const n of [...Object.values(pol.executors || {}).map(e => e?.executor), ...Object.values(pol.fallbacks || {})])
    if (typeof n === 'string' && n && !NOT_AGENTS.includes(n) && !Object.hasOwn(BUILTIN, n) && !Object.hasOwn(pv, n)) names.add(n);
  return [...names].sort();
}

/** The settings / generated-text extra of a project: typed names, their cap defaults, the enabled ones, its role agents. */
export const executorExtra = project => {
  const pv = providersOf(project);
  return { providers: Object.keys(pv), caps: Object.fromEntries(Object.entries(pv).map(([n, x]) => [n, capDefault(x)])),
    enabled: Object.entries(pv).filter(([, x]) => x.enabled !== false).map(([n]) => n), agents: roleAgents(project) };
};

/** RUN kind + harness family + machine caps of executor `name` (entry = its project.json executors.<name>); null = unknown. */
export function executorInfo(name, entry) {
  if (Object.hasOwn(BUILTIN, name ?? '')) return BUILTIN[name];
  if (!isTyped(entry)) return null;
  const harness = entry.runner === 'fake' ? 'fake' : isProvider(entry) ? 'claude' : isOpenAI(entry) ? 'codex' : 'cli';
  return { kind: isCli(entry) ? CLI_KIND : PROVIDER_KIND, harness, caps: [capKey(name)] };
}

/** The named mode of a cli entry: `want` = a mode name, else an access level (first mode with that access, in entry order). */
export function cliMode(entry, want) {
  const modes = entry?.modes || {};
  if (want && Object.hasOwn(modes, want)) return [want, modes[want]];
  const access = want || 'write';
  if (!ACCESS.includes(access)) throw new Error(`no mode ${JSON.stringify(want)} (${Object.keys(modes).join(' | ')})`);
  const hit = Object.entries(modes).find(([, m]) => m.access === access);
  if (!hit) throw new Error(`no ${access} mode (${Object.keys(modes).join(' | ')})`);
  return hit;
}

function apiProblems(at, x) {
  const errs = [];
  for (const k of ['base_url', 'api_key_env', 'model']) if (typeof x[k] !== 'string' || !x[k]) errs.push(`${at}.${k} is required`);
  if (typeof x.base_url === 'string' && !/^https?:\/\/\S+$/.test(x.base_url)) errs.push(`${at}.base_url must be an http(s) URL`);
  if (typeof x.api_key_env === 'string' && !KEY_ENV_RE.test(x.api_key_env)) errs.push(`${at}.api_key_env must be an env var NAME (${KEY_ENV_RE.source}), never the key`);
  for (const k of SECRET_VARS) if (Object.hasOwn(x.env || {}, k)) errs.push(`${at}.env.${k}: keys never live in a file - set api_key_env to the env var NAME`);
  if (isOpenAI(x) && x.wire_api !== undefined && !WIRE_APIS.includes(x.wire_api))
    errs.push(`${at}.wire_api ${JSON.stringify(x.wire_api)}: the installed codex-cli runs only ${WIRE_APIS.map(w => JSON.stringify(w)).join(' | ')}`);
  return errs;
}
const badPlaceholder = (a, extra = []) => [...String(a).matchAll(/\{([a-z_]+)\}/g)].map(m => m[1]).find(p => ![...PLACEHOLDERS, ...extra].includes(p));
export function cliProblems(at, x) {
  const errs = [];
  for (const k of ['exe', 'model']) if (typeof x[k] !== 'string' || !x[k]) errs.push(`${at}.${k} is required`);
  if (x.brief !== undefined && !['file', 'stdin'].includes(x.brief)) errs.push(`${at}.brief must be file | stdin`);
  if (x.output !== undefined && x.output !== 'plain') errs.push(`${at}.output must be plain`);
  if (x.turns !== undefined && !Number.isInteger(x.turns)) errs.push(`${at}.turns must be an integer`);
  if (!Array.isArray(x.args) || !x.args.every(a => typeof a === 'string')) errs.push(`${at}.args must be a list of strings`);
  else for (const a of x.args) { const p = badPlaceholder(a, ['mode']); if (p) errs.push(`${at}.args: unknown placeholder {${p}}`); }
  if (x.exit_after_s !== undefined && !(typeof x.exit_after_s === 'number' && x.exit_after_s > 0)) errs.push(`${at}.exit_after_s must be a number > 0 (seconds)`);
  const modes = Object.entries(x.modes || {});
  if (!modes.length) errs.push(`${at}.modes needs at least one named mode { access, args }`);
  for (const [m, d] of modes) {
    if (!ACCESS.includes(d?.access)) errs.push(`${at}.modes.${m}.access must be ${ACCESS.join(' | ')}`);
    if (!Array.isArray(d?.args) || !d.args.every(a => typeof a === 'string')) errs.push(`${at}.modes.${m}.args must be a list of strings`);
    else for (const a of d.args) { const p = badPlaceholder(a); if (p) errs.push(`${at}.modes.${m}.args: unknown placeholder {${p}}`); }
  }
  if (x.mcp_add !== undefined) {
    const t = x.mcp_add;
    if (!Array.isArray(t?.args) || !t.args.every(a => typeof a === 'string')) errs.push(`${at}.mcp_add.args must be a list of strings`);
    if (t?.scopes !== undefined && (!Array.isArray(t.scopes) || !t.scopes.length)) errs.push(`${at}.mcp_add.scopes must be a non-empty list`);
  }
  errs.push(...capsProblems(at, x));
  return errs;
}

/** Problems with the project's typed executor entries (empty = fine). */
export function providerProblems(project) {
  const errs = [];
  for (const [name, x] of Object.entries(project?.executors || {})) {
    const at = `executors.${name}`;
    if (x?.type !== undefined && !isTyped(x)) { errs.push(`${at}.type must be ${TYPES.join(' | ')}`); continue; }
    if (!isTyped(x)) continue;
    if (Object.hasOwn(BUILTIN, name)) errs.push(`${at}: "${name}" is a built-in executor name`);
    if (!NAME_RE.test(name)) errs.push(`${at}: name must match ${NAME_RE.source}`);
    errs.push(...(isCli(x) ? cliProblems(at, x) : apiProblems(at, x)));
    for (const k of SECRET_FIELDS) if (Object.hasOwn(x, k)) errs.push(`${at}.${k}: keys never live in a file - set api_key_env to the env var NAME`);
    if (x.runner !== undefined && !['claude', 'fake'].includes(x.runner)) errs.push(`${at}.runner must be claude or fake`);
    if (x.cap !== undefined && !(Number.isInteger(x.cap) && x.cap >= 0)) errs.push(`${at}.cap must be an integer >= 0`);
  }
  return errs;
}

/** Caps a recorded run counts against (run data: { kind, executor }): a built-in its own; every other executor max_<its name>,
 *  whatever its kind and whether or not it is still configured (a legacy kind-grok run counts against max_grok). */
export function capsOfRun(data) {
  if (Object.hasOwn(BUILTIN, data?.executor ?? '')) return BUILTIN[data.executor].caps;
  return data?.executor ? [capKey(data.executor)] : [];
}

/**
 * The child env of an API-typed run. vars: name -> value (null = delete). The token is read from `env` at spawn time only:
 * it is never written to a spec, record or log. missing = the api_key_env name when that var is unset / empty.
 * claude-compatible: ANTHROPIC_* from the entry; openai-compatible: none (the Codex CLI reads the key var by its env_key name).
 */
export function providerEnv(entry, env = process.env) {
  const token = env[entry.api_key_env];
  if (!isProvider(entry)) return { vars: {}, missing: token ? null : entry.api_key_env };
  const small = entry.small_model || entry.model;
  const vars = {
    ANTHROPIC_BASE_URL: entry.base_url, ANTHROPIC_AUTH_TOKEN: token || null, ANTHROPIC_API_KEY: null,
    ANTHROPIC_MODEL: entry.model, ANTHROPIC_DEFAULT_OPUS_MODEL: entry.model, ANTHROPIC_DEFAULT_SONNET_MODEL: entry.model,
    ANTHROPIC_DEFAULT_FABLE_MODEL: entry.model, CLAUDE_CODE_SUBAGENT_MODEL: entry.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: small, ANTHROPIC_SMALL_FAST_MODEL: small,
  };
  return { vars, missing: token ? null : entry.api_key_env };
}
export const keySet = (entry, env = process.env) => !!env[entry.api_key_env];
/** The executable of a typed run: a cli entry names its own; an API type runs the machine's claude / codex CLI; runner fake: none. */
export const typedExe = (entry, machine) => (entry.runner === 'fake' ? undefined : isCli(entry) ? entry.exe : isOpenAI(entry) ? machine?.codex?.exe : machine?.claude?.exe);

// ---------- usage-limit signatures (META-GT12): DATA per executor; the supervisor's classifier (runs.classifyLimit) is the code ----------
// { match: [regex source, case-insensitive], reset: [regex source with a named group `epoch` (unix s) or `clock` (h[:mm] am/pm, local; + mon / day / year)] }.
// A project.json executors.<name>.limit of the same shape replaces the row. Lookup: entry.limit > row of the name > row of the harness.
//
// The `claude` match list is copied from Gas Town internal/daemon/usage_limit.go (claudeUsageLimitPatterns), under its licence:
//   MIT License. Copyright (c) 2025 Steve Yegge. Permission is hereby granted, free of charge, to any person obtaining a copy of this
//   software and associated documentation files (the "Software"), to deal in the Software without restriction, including without
//   limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
//   permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and
//   this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
//   WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
//   PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE
//   OR OTHER DEALINGS IN THE SOFTWARE.
// Their `(?i)` prefix is our `i` flag. The reset rows, the codex rows (RUN-1614's log) and the grok row are ours.
// META-LIMIT-GATE: an optional date before the clock ("Nov 15th, 2026 " / "Nov 15, " / "Nov 15 "): groups mon, day, year - RUN-562's
// "try again at Nov 15th, 2026 5:01 PM" was read as tonight while the date was dropped. The time stays the machine's local time.
const DATE = String.raw`(?<mon>[A-Za-z]{3,9})\.? (?<day>\d{1,2})(?:st|nd|rd|th)?,? (?:(?<year>\d{4}),? )?`;
const CLAUDE_LIMIT = {
  match: [
    String.raw`Claude (AI )?usage limit reached`,
    String.raw`You've hit your .*limit`,
    String.raw`limit\s*·\s*resets \d`,
    String.raw`Stop and wait for limit to reset`,
    String.raw`API Error:\s*Rate limit reached`,
    String.raw`\b429\b.*Too Many Requests`,
    String.raw`"type"\s*:\s*"rate_limit_error"`,
  ],
  reset: [String.raw`usage limit reached\|(?<epoch>\d{9,11})`, String.raw`resets (?:at )?(?:${DATE}(?:at )?)?(?<clock>\d{1,2}(?::\d\d)?\s*[ap]m)`],
};
export const LIMIT_PATTERNS = {
  claude: CLAUDE_LIMIT,
  fake: CLAUDE_LIMIT,   // the fake executor stands in for claude
  // codex-cli 0.162: "ERROR: You’ve hit your usage limit. ... or try again at 6:14 PM." (curly or straight apostrophe)
  codex: { match: [String.raw`You[’']ve hit your usage limit`], reset: [String.raw`try again at (?:${DATE})?(?<clock>\d{1,2}:\d\d\s*[ap]m)`, String.raw`try again at [^\n]*?(?<clock>\d{1,2}:\d\d\s*[ap]m)`] },
  // GUESS (no grok limit seen in our logs yet): an HTTP 429 / "rate limit" / "usage limit" error line; replace once one is seen
  grok: { match: [String.raw`\b429\b.*(Too Many Requests|rate limit)`, String.raw`\b(usage|rate) limit (reached|exceeded)`], reset: [] },
};
/** The limit patterns of executor `name` (entry = its project.json executors.<name>, built-in or typed). */
export function limitPatterns(name, entry) {
  if (entry?.limit) return entry.limit;
  if (Object.hasOwn(LIMIT_PATTERNS, name ?? '')) return LIMIT_PATTERNS[name];
  const h = executorInfo(name, isTyped(entry) ? entry : undefined)?.harness;
  return LIMIT_PATTERNS[h] ?? { match: [], reset: [] };
}

// ---------- auth-failure signatures (META-AUTH AUTH-1): DATA per executor, the same shape and lookup as the limit rows ----------
// { match: [regex source, case-insensitive] = class login (the CLI's own login is gone: the owner logs in again), vendor?: [regex
// source] = class vendor (META-AUTH-VENDOR: the vendor's edge / servers refuse - an outage, the login is fine; tried after match),
// login: the command the owner runs (named in the one notice), probe?: { args, json? } - the cheap local status check of the CLI
// (json: the field that must be true; none = exit 0), status?: { vendor, url } - the vendor's public status page (vendorstatus.mjs,
// Statuspage JSON, read without credentials) }. project.json executors.<name>.auth replaces the row. An exit whose log tail matches
// either class is outcome `auth` (supervisor.mjs), never `crash`: both hold new launches and resume the cut-off run.
const CLAUDE_AUTH = {
  match: [
    String.raw`OAuth (session|token) (has )?(expired|revoked)`,   // MEASURED: the 2026-11-12 incident (14 finals, "Failed to authenticate: OAuth session expired ...")
    String.raw`Invalid API key\s*·\s*Please run /login`,
    String.raw`Please run /login`,
    String.raw`"type"\s*:\s*"authentication_error"`,           // the Anthropic API's 401 error body
    String.raw`API Error:\s*401\b`,
  ],
  vendor: [
    String.raw`Attention Required! \| Cloudflare`,              // MEASURED: 2026-11-13 09:47-10:19Z, 10 finals "Failed to authenticate. API Error: 403 ..."
    String.raw`API Error:\s*5\d\d\b`,                          // 5xx / 529 overloaded
    String.raw`"api_error_status"\s*:\s*5\d\d\b`,
    String.raw`"type"\s*:\s*"overloaded_error"`,
    String.raw`Failed to authenticate`,                        // without a login signature (match is tried first): the vendor side
  ],
  login: 'claude auth login',   // the CLI subcommand (beside the probe's `claude auth status`; norn doctor names the same)
  probe: { args: ['auth', 'status', '--json'], json: 'loggedIn' },   // OOTB F-14 (norn doctor): local, no turn
  status: { vendor: 'Anthropic', url: 'https://status.claude.com/api/v2/incidents/unresolved.json' },   // MEASURED 11-13: Statuspage
};
export const AUTH_PATTERNS = {
  claude: CLAUDE_AUTH,
  fake: { ...CLAUDE_AUTH, probe: undefined, status: undefined },   // the fake stands in for claude (tests inject the probe + status)
  // codex-cli: the refresh-token failure (codex-rs login: "Your access token could not be refreshed ...") and a 401 on the stream
  codex: { match: [String.raw`access token could not be refreshed`, String.raw`Please log out and sign in again`, String.raw`\b401 Unauthorized\b`,
    String.raw`"code"\s*:\s*"token_expired"`], login: 'codex login', probe: { args: ['login', 'status'] },
    // GUESS (no codex edge block / 5xx exit seen in our logs yet): the stream's 5xx status and a Cloudflare edge page
    vendor: [String.raw`unexpected status 5\d\d\b`, String.raw`Attention Required! \| Cloudflare`],
    // MEASURED 11-13: OpenAI's page (incident.io) answers the Statuspage incidents.json (resolved ones included: vendorstatus filters)
    status: { vendor: 'OpenAI', url: 'https://status.openai.com/api/v2/incidents.json' } },
  // GUESS (no grok auth failure seen in our logs yet): an HTTP 401 / invalid key line; replace once one is seen
  grok: { match: [String.raw`\b401\b.*Unauthorized`, String.raw`invalid api key`], login: 'grok login' },
};
/** The auth-failure patterns of executor `name` (entry as limitPatterns). */
export function authPatterns(name, entry) {
  if (entry?.auth) return entry.auth;
  if (Object.hasOwn(AUTH_PATTERNS, name ?? '')) return AUTH_PATTERNS[name];
  const h = executorInfo(name, isTyped(entry) ? entry : undefined)?.harness;
  return AUTH_PATTERNS[h] ?? { match: [] };
}
