// RM-a-63 (sarif-source): SARIF 2.1.0 as a lint tool, so any analyzer that writes SARIF plugs into the kind `lint` with no parser of
// its own. Like clippy it is never run: a rule with `tool: sarif` reads the file a project tool wrote for each side's commit (the
// `log` path templates, lang/logs.mjs; the base side reads them with `{head}` = the merge base). Each failing result on a touched
// file is a finding <id>/<ruleId>, its line the first physical location's startLine, its SARIF level the key of the rule's `levels`.
// A file that is not SARIF 2.1.0 throws: the check's fail-closed "could not run". Fields as the OASIS SARIF 2.1.0 schema and spec
// name them (sarifLog, run, result, reportingDescriptor, artifactLocation, region); in-file suppressions are not honoured (a waiver is).
import { logFiles } from './logs.mjs';

const LEVELS = ['none', 'note', 'warning', 'error'], KINDS = ['pass', 'open', 'informational', 'review', 'fail', 'notApplicable'];
const bad = why => { throw new Error(`not SARIF 2.1.0: ${why}`); };
const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const ABS = /^[a-z][\w+.-]*:/i;

/** a parsed log -> itself, or throws naming the first thing SARIF 2.1.0 requires that it lacks */
function valid(log) {
  if (!isObj(log)) bad('not a JSON object');
  if (log.version !== '2.1.0') bad(`version is ${JSON.stringify(log.version)}`);
  if (!Array.isArray(log.runs)) bad('runs is not an array (null: the tool could not tell its runs)');
  log.runs.forEach((r, i) => {
    if (!isObj(r) || !isObj(r.tool) || typeof r.tool.driver?.name !== 'string') bad(`runs[${i}] has no tool.driver.name`);
    // results absent defaults to null: the tool's results are unknown (a run that found nothing writes [])
    if (!Array.isArray(r.results)) bad(`runs[${i}].results is ${r.results == null ? 'null' : 'not an array'}: the tool's results are unknown`);
    r.results.forEach((x, k) => {
      const at = `runs[${i}].results[${k}]`;
      if (!isObj(x) || !isObj(x.message) || (typeof x.message.text !== 'string' && typeof x.message.id !== 'string')) bad(`${at} has no message text or id`);
      if (x.level !== undefined && !LEVELS.includes(x.level)) bad(`${at}.level is ${JSON.stringify(x.level)}`);
      if (x.kind !== undefined && !KINDS.includes(x.kind)) bad(`${at}.kind is ${JSON.stringify(x.kind)}`);
      if (x.locations !== undefined && !Array.isArray(x.locations)) bad(`${at}.locations is not an array`);
      for (const l of x.locations || []) { const s = l?.physicalLocation?.region?.startLine; if (s !== undefined && !(Number.isInteger(s) && s >= 1)) bad(`${at}: startLine ${JSON.stringify(s)} (an integer from 1)`); }
    });
  });
  return log;
}
const read = (text, where) => { let j; try { j = JSON.parse(text); } catch (e) { bad(`${where}: ${e.message}`); } return valid(j); };

/** a result's rule: { id, d (its reportingDescriptor, or null), comp (the tool component holding it) } */
function ruleOf(run, x, at) {
  const ref = isObj(x.rule) ? x.rule : {}, tc = ref.toolComponent, ext = run.tool.extensions || [];
  const comp = !tc ? run.tool.driver : (Number.isInteger(tc.index) && tc.index >= 0 ? ext[tc.index] : ext.find(e => e?.name === tc.name));
  if (!comp) bad(`${at} names a tool component the run does not have`);
  const idx = ref.index ?? x.ruleIndex ?? -1, d = idx >= 0 ? comp.rules?.[idx] : (comp.rules || []).find(r => r?.id === (x.ruleId ?? ref.id));
  if (idx >= 0 && !d) bad(`${at} names rule index ${idx}, which its tool component does not have`);
  const id = x.ruleId ?? ref.id ?? d?.id;
  if (typeof id !== 'string' || !id) bad(`${at} names no rule (ruleId, rule.id)`);
  return { id, idx, d: d || null, comp };
}
/** SARIF 3.27.10: the level, else "none" for a kind other than fail, else the invocation's override, the rule's default, "warning" */
function levelOf(run, x, { id, idx, d }) {
  if (x.level) return x.level;
  if ((x.kind ?? 'fail') !== 'fail') return 'none';
  const inv = run.invocations?.[x.provenance?.invocationIndex ?? -1];
  const o = (inv?.ruleConfigurationOverrides || []).find(c => c?.descriptor && (c.descriptor.id === id || (idx >= 0 && c.descriptor.index === idx)));
  return o?.configuration?.level ?? d?.defaultConfiguration?.level ?? 'warning';
}
/** the message's text: its own, else the rule's messageStrings[id], else the component's globalMessageStrings[id]; {n} = arguments[n] */
function msgOf(x, { d, comp }, at) {
  const m = x.message, t = m.text ?? (d?.messageStrings?.[m.id] ?? comp.globalMessageStrings?.[m.id])?.text;
  if (typeof t !== 'string') bad(`${at}: message id ${JSON.stringify(m.id)} is in no messageStrings`);
  return t.replace(/\{(\d+)\}/g, (s, n) => m.arguments?.[n] ?? s).replace(/\s+/g, ' ').trim();
}
/** an artifactLocation -> { path (decoded, `/`), rooted (an absolute URI: a touched file is its tail) } through originalUriBaseIds (3.14.14) */
function pathOf(run, al, at) {
  if (al.uri === undefined && Number.isInteger(al.index) && al.index >= 0) al = run.artifacts?.[al.index]?.location || {};
  if (typeof al.uri !== 'string') return null;
  let uri = al.uri, base = al.uriBaseId;
  for (const seen = new Set(); !ABS.test(uri) && base !== undefined && run.originalUriBaseIds?.[base] && !seen.has(base); ) { seen.add(base); const b = run.originalUriBaseIds[base]; uri = (b.uri || '') + uri; base = b.uriBaseId; }
  let p = uri.replace(/^file:\/\/[^/]*/i, '').replace(/^\/(?=[A-Za-z]:)/, '');
  try { p = decodeURIComponent(p); } catch { bad(`${at}: uri ${JSON.stringify(al.uri)} is no URI`); }
  return { path: p.replace(/\\/g, '/').replace(/^(?:\.\/)+/, ''), rooted: ABS.test(uri) };
}

/** the SARIF files of one side's commit (rule.head, or rule.base for the base side), all their runs in one log -> text | null (none) */
function run(rule, side) {
  const files = logFiles(rule.log, rule.git, side === 'head' ? rule.head : rule.base);
  return files.length ? JSON.stringify({ version: '2.1.0', runs: files.flatMap(f => read(f.text, f.path).runs) }) : null;
}
/**
 * a SARIF log -> [{ file (a touched file the location names: equal, its tail, or - a relative uri of an unknown root - its head), rule
 * (ruleId), line (startLine; 0 with no region), msg, level (the SARIF level) }]; only results of kind fail with a physical location
 */
function parse(raw, touched = []) {
  return read(raw, 'the log').runs.flatMap((r, i) => r.results.flatMap((x, k) => findingsOf(r, x, `runs[${i}].results[${k}]`, touched)));
}
/** one result -> its findings: none for a kind other than fail (pass, open, review, informational, notApplicable) or no file */
function findingsOf(r, x, at, touched) {
  const rule = ruleOf(r, x, at), pl = (x.locations || []).find(l => isObj(l?.physicalLocation))?.physicalLocation;
  const p = (x.kind ?? 'fail') === 'fail' && isObj(pl?.artifactLocation) && pathOf(r, pl.artifactLocation, at);
  if (!p) return [];
  const line = pl.region?.startLine ?? 0, msg = msgOf(x, rule, at), level = levelOf(r, x, rule);
  return touched.filter(f => p.path === f || p.path.endsWith('/' + f) || (!p.rooted && f.endsWith('/' + p.path))).map(f => ({ file: f, rule: rule.id, line, msg, level }));
}
/** SARIF has no config of its own (the project tool's is the project's); fromFile: each rule reads its own file at head and at the merge base */
export const SARIF = { run, parse, fromFile: true, configOf: () => null };
