// META-SLOP-A (DIR-27; SPEC 9.3.3 classes; REVIEW-FABLE L1 / L2): lines of code by git alone - non-blank lines of text files
// (git grep -I -c), no new tool. Classes code / tests / docs / config; generated, vendored and fixtures are counted apart and
// never in the totals. Per area (folder depth 2) and per language; one point per day along main's first-parent line; churn per
// landing (git diff --numstat from its first parent) and the "big landing" flag (over BIG_LANDING changed code lines).
import { gitRun, matchAny } from './check.mjs';

export const BIG_LANDING = 1500;
export const CLASSES = ['code', 'tests', 'docs', 'config'];
export const APART = ['generated', 'vendored', 'fixtures'];
// first match wins: the apart classes before the counted ones
export const CLASS_RULES = [
  ['vendored', ['**/vendor/**', '**/third_party/**', '**/node_modules/**']],
  ['generated', ['**/package-lock.json', '**/*.lock', '**/*.min.js', '**/*.generated.*']],
  ['fixtures', ['tests/fixtures/**', 'tests/golden/**', '**/testdata/**', '**/__snapshots__/**', '**/snapshots/**']],
  ['tests', ['tests/**', '**/*.test.*', '**/*.spec.*', '**/test_*.py', '**/*_test.py', '**/*_test.rs']],
  ['docs', ['**/*.md', '**/*.rst', '**/*.txt', 'docs/**', '**/LICENSE']],
  ['config', ['**/*.json', '**/*.toml', '**/*.yaml', '**/*.yml', '**/*.ini', '**/.gitignore', '**/.gitattributes']],
];
export const classOf = f => CLASS_RULES.find(([, globs]) => matchAny(globs, f))?.[0] || 'code';
const LANG = { mjs: 'JavaScript', js: 'JavaScript', cjs: 'JavaScript', ts: 'TypeScript', py: 'Python', rs: 'Rust', md: 'Markdown', json: 'JSON', html: 'HTML',
  css: 'CSS', ps1: 'PowerShell', cs: 'C#', sh: 'Shell', toml: 'TOML', yml: 'YAML', yaml: 'YAML', txt: 'Text', wgsl: 'WGSL' };
export const langOf = f => { const m = /\.([^./]+)$/.exec(f); return m ? LANG[m[1].toLowerCase()] || m[1].toLowerCase() : '(none)'; };
export const areaOf = f => { const d = f.split('/').slice(0, -1); return d.length ? d.slice(0, 2).join('/') : '.'; };
const add = (o, k, n) => { o[k] = (o[k] || 0) + n; };

/** non-blank line counts of every text file at a revision: [[path, n]] (one git grep) */
export function countAt(repo, rev) {
  const out = gitRun(repo, ['grep', '-I', '-c', '-v', '-e', '^[[:space:]]*$', rev, '--'], { ok: [0, 1] });
  return out.split('\n').filter(Boolean).map(l => { const m = /^[^:]+:(.+):(\d+)$/.exec(l); return [m[1], Number(m[2])]; });
}
/** one snapshot: { totals, apart, areas: { area: { class: n } }, languages: { lang: { class: n } } } */
export function snapshot(repo, rev) {
  const s = { totals: Object.fromEntries(CLASSES.map(c => [c, 0])), apart: Object.fromEntries(APART.map(c => [c, 0])), areas: {}, languages: {} };
  for (const [f, n] of countAt(repo, rev)) {
    const c = classOf(f);
    if (APART.includes(c)) { s.apart[c] += n; continue; }
    s.totals[c] += n;
    add(s.areas[areaOf(f)] ||= {}, c, n);
    add(s.languages[langOf(f)] ||= {}, c, n);
  }
  return s;
}
/** main's ref: the remote's first (fresher), else the local branch */
export function mainRef(repo, { main = 'main', remote = 'origin' } = {}) {
  for (const ref of [`refs/remotes/${remote}/${main}`, `refs/heads/${main}`]) if (gitRun(repo, ['rev-parse', '--verify', '--quiet', ref], { ok: [0, 1] }).trim()) return ref;
  throw new Error(`no ${main} branch (local or ${remote}/${main}) in ${repo}`);
}
const dayOf = t => new Date(t).toISOString().slice(0, 10);

/** churn of each first-parent commit since a day: [{ sha, day, subject, added: { class: n }, deleted, code_changed, big }].
 * repo = a folder below the top (a monorepo project's subdir): only the changes inside it count, paths relative to it, and a commit
 * that changes nothing there is another project's landing (left out). */
export function landings(repo, ref, since) {
  const below = gitRun(repo, ['rev-parse', '--show-prefix']).trim() !== '';
  const log = gitRun(repo, ['log', '--first-parent', '--format=%H%x09%cI%x09%P%x09%s', `--since=${since}T00:00:00Z`, ref]).split('\n').filter(Boolean);
  return log.map(l => {
    const [sha, at, parents, subject] = l.split('\t');
    const added = {}, deleted = {};
    const p1 = parents.split(' ')[0];   // none = the root commit: everything it adds
    const ns = gitRun(repo, p1 ? ['diff', '--numstat', '-z', '--no-renames', '--relative', p1, sha] : ['diff-tree', '-r', '--root', '--no-commit-id', '--numstat', '-z', '--no-renames', '--relative', sha]).split('\0').filter(Boolean);
    if (below && !ns.length) return null;
    for (const x of ns) {
      const [a, d, f] = x.split('\t');
      if (a === '-') continue;   // binary
      const c = classOf(f);
      add(added, c, Number(a)); add(deleted, c, Number(d));
    }
    const code_changed = (added.code || 0) + (deleted.code || 0);
    return { sha, day: dayOf(at), subject, added, deleted, code_changed, big: code_changed > BIG_LANDING };
  }).filter(Boolean);
}

/**
 * repo = the repo's top level, or a monorepo project's folder in it: git grep then counts only that folder (paths relative to it)
 * and the landings only its changes.
 * locReport(repo, { since (YYYY-MM-DD; default the first commit's day), until (default today, UTC), ref (default main) }) ->
 * { ref, head, ...snapshot(head), series: [{ day, sha, totals, areas }], landings }
 */
export function locReport(repo, { since = null, until = null, ref = null } = {}) {
  ref ||= mainRef(repo);
  const log = gitRun(repo, ['log', '--first-parent', '--format=%H %cI', ref]).split('\n').filter(Boolean).map(l => { const [sha, at] = l.split(' '); return { sha, t: Date.parse(at) }; });
  const first = dayOf(log[log.length - 1].t), last = until || dayOf(Date.now());
  since ||= first;
  const series = [], snaps = new Map();
  for (let d = Date.parse(since + 'T00:00:00Z'); d <= Date.parse(last + 'T00:00:00Z'); d += 86400e3) {
    const at = log.find(c => c.t < d + 86400e3);   // the last commit of the day (newest first)
    if (!at) continue;
    if (!snaps.has(at.sha)) snaps.set(at.sha, snapshot(repo, at.sha));
    const s = snaps.get(at.sha);
    series.push({ day: dayOf(d), sha: at.sha, totals: s.totals, areas: s.areas });
  }
  const head = log[0].sha;
  return { ref, head, ...(snaps.get(head) || snapshot(repo, head)), series, landings: landings(repo, ref, since) };
}

const num = n => n.toLocaleString('en-US');
export function formatLoc(r) {
  const L = [`lines of code (non-blank, git) at ${r.ref} ${r.head.slice(0, 7)}: ${CLASSES.map(c => `${c} ${num(r.totals[c])}`).join(', ')}; apart: ${APART.map(c => `${c} ${num(r.apart[c])}`).join(', ')}`];
  L.push('', 'area                      ' + CLASSES.map(c => c.padStart(8)).join(''));
  for (const [a, v] of Object.entries(r.areas).sort((x, y) => (y[1].code || 0) - (x[1].code || 0))) L.push(a.padEnd(26) + CLASSES.map(c => num(v[c] || 0).padStart(8)).join(''));
  L.push('', 'language                  ' + CLASSES.map(c => c.padStart(8)).join(''));
  for (const [a, v] of Object.entries(r.languages).sort((x, y) => (y[1].code || 0) - (x[1].code || 0))) L.push(a.padEnd(26) + CLASSES.map(c => num(v[c] || 0).padStart(8)).join(''));
  L.push('', 'day         code    tests');
  for (const p of r.series) L.push(`${p.day} ${num(p.totals.code).padStart(7)} ${num(p.totals.tests).padStart(8)}`);
  const big = r.landings.filter(l => l.big);
  L.push('', `landings since ${r.series[0]?.day ?? '-'}: ${r.landings.length}; big (> ${num(BIG_LANDING)} changed code lines): ${big.length}`);
  for (const l of big) L.push(`  ${l.day} ${l.sha.slice(0, 7)} +${num(l.added.code || 0)} -${num(l.deleted.code || 0)} ${l.subject.slice(0, 80)}`);
  return L.join('\n');
}
