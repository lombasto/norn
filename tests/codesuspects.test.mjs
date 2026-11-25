// RM-a-61 (docs/code-signals.md, "norn code suspects"): lib/codesuspects.mjs over a synthetic repo - the window's first-parent landings as
// candidates, a batch merge (an integration branch merging member branches, or an octopus) expanded into one candidate per member branch (a
// merge of main into a branch is no member), ranked by trace files, then the signals' partners of those, then symptom words, each row with
// its score and its reasons; a word in most landings dropped with the reason; nothing matched = no suspect found. Sandbox only (mkTmp).
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { suspects, symptomWords, SUSPECT_LIMITS } from '../engine/lib/codesuspects.mjs';
import { codeCmd } from '../engine/lib/codecli.mjs';

test.after(cleanTmp);
const NOW = Date.parse('2026-11-20T12:00:00Z');
// The fixture repo is built ONCE for the file (before) and only read by every test: suspects() runs git read-only. It is one
// `git fast-import` stream, not ~40 porcelain calls per test (S2: the file took 180-270 s, the whole run's test budget). The history
// is the one a hand-built repo has: the same commits, parents, dates, messages and files; a merge's tree is the union of its parents'
// (no fixture merge conflicts; the newer write of a file wins, as git's merge of main into the batch takes main's tokens.mjs).
function build() {
  const d = mkTmp('meta-sus-'), repo = path.join(d, 'repo'), state = path.join(d, 'state', 'kestrel');
  const ts = at => Math.floor(Date.parse(at) / 1000);
  let k = 0, m = 0, out = '';
  const tip = {}, tree = {}, data = s => `data ${Buffer.byteLength(s)}\n${s}\n`;
  let on = 'main';
  // a commit on branch `on`: its parents' merged file map plus the new writes, listed in full (deleteall + M) so no tree is implied
  const emit = (parents, writes, msg, at) => {
    const files = {};
    for (const p of parents) for (const [f, v] of Object.entries(tree[p])) if (!files[f] || files[f].n < v.n) files[f] = v;
    for (const f of writes) { const blob = ++m; out += `blob\nmark :${blob}\n${data(`// ${f}\nexport const v${k++} = 1;\n`)}`; files[f] = { mark: blob, n: blob }; }
    const c = ++m, who = `t <t@t> ${ts(at)} +0000`;
    out += `commit refs/heads/${on}\nmark :${c}\nauthor ${who}\ncommitter ${who}\n${data(msg + '\n')}`;
    if (parents.length) out += `from :${parents[0]}\n` + parents.slice(1).map(p => `merge :${p}\n`).join('');
    out += 'deleteall\n' + Object.entries(files).map(([f, v]) => `M 100644 :${v.mark} ${f}\n`).join('');
    tree[c] = files; tip[on] = c; return c;
  };
  const commit = (files, msg, at) => emit(tip[on] ? [tip[on]] : [], files, msg, at);
  const merge = (branches, msg, at) => emit([tip[on], ...branches.map(b => tip[b])], [], msg, at);
  const co = (args) => { if (args[0] === '-b') tip[args[1]] = tip[on]; on = args.at(-1); };
  const L = {};
  L.old = commit(['src/old.mjs', 'src/tokens.mjs'], 'feat(old): the first parser', '2026-09-01T10:00:00Z');   // past the 30-day window
  co(['-b', 'feat/parser']); commit(['src/parser.mjs'], 'feat(parser): read the grammar', '2026-10-25T10:00:00Z'); commit(['src/lexer.mjs'], 'feat(parser): split the input', '2026-10-25T11:00:00Z');
  co(['main']); L.parser = merge(['feat/parser'], "Merge branch 'feat/parser'", '2026-10-26T10:00:00Z');
  L.sky = commit(['src/render.mjs', 'src/sky.mjs'], 'feat(render): draw the sky', '2026-10-28T10:00:00Z');
  // the batch: an integration branch merges two member branches, catches up with main once, and carries one commit of its own
  co(['-b', 'mq/batch-1']); co(['-b', 'feat/audio']); L.audioTip = commit(['src/audio.mjs'], 'feat(audio): play the wind', '2026-11-01T10:00:00Z');
  co(['mq/batch-1']); co(['-b', 'fix/save']); commit(['src/save.mjs'], 'fix(save): keep the slot', '2026-11-01T11:00:00Z');
  co(['main']); L.tokens = commit(['src/tokens.mjs'], 'refactor(core): rename the table', '2026-11-02T10:00:00Z');
  co(['mq/batch-1']); merge(['feat/audio'], "Merge branch 'feat/audio' into mq/batch-1", '2026-11-03T10:00:00Z');
  merge(['main'], "Merge branch 'main' into mq/batch-1", '2026-11-03T10:30:00Z');
  merge(['fix/save'], "Merge branch 'fix/save' into mq/batch-1", '2026-11-03T11:00:00Z');
  commit(['docs/notes.md'], 'docs: the batch notes', '2026-11-03T12:00:00Z');
  co(['main']); L.batch = merge(['mq/batch-1'], "Merge branch 'mq/batch-1'", '2026-11-04T10:00:00Z');
  // an octopus: two branches in one merge
  co(['-b', 'feat/x']); commit(['src/x.mjs'], 'feat(x): the compass', '2026-11-05T10:00:00Z');
  co(['main']); co(['-b', 'feat/y']); commit(['src/y.mjs'], 'feat(y): the weather vane', '2026-11-05T11:00:00Z');
  co(['main']); L.octo = merge(['feat/x', 'feat/y'], "Merge branches 'feat/x' and 'feat/y'", '2026-11-06T10:00:00Z');
  const g = (args, input) => execFileSync('git', ['-C', repo, '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8', windowsHide: true, input }).trim();
  fs.mkdirSync(repo, { recursive: true }); g(['init', '-q', '-b', 'main']);
  const marks = path.join(d, 'marks');
  g(['fast-import', '--quiet', `--export-marks=${marks}`], out + 'done\n');
  const sha = Object.fromEntries(fs.readFileSync(marks, 'utf8').trim().split('\n').map(l => l.slice(1).split(' ')));
  g(['reset', '-q', '--hard', 'main']);   // the index and work tree of main: suspects reads `git ls-files`
  for (const n of Object.keys(L)) L[n] = sha[L[n]].slice(0, 12);
  return { repo, state, L, head: L.octo };
}
let fixture;
before(() => { fixture = build(); });
const world = () => fixture;
/** the stored signals as docs/code-signals.md defines them: only what a consumer reads */
function storeSignals(state, sha, files) {
  fs.mkdirSync(path.join(state, 'code'), { recursive: true });
  fs.writeFileSync(path.join(state, 'code', 'signals.json'), JSON.stringify({ at: '2026-11-20T12:00:00Z', sha, basis: 'measured', window: { days: 365, from: '2025-11-20', to: '2026-11-20' },
    limits: {}, landings: 8, batches_skipped: 0, fixes: { status: 'measured', typed: 10, commits: 10 }, files }));
}
const sig = (partners = []) => ({ landings: 4, partners, fixes: null, fix_first: null, importance: 0, churn_90d: 0, fan_in: null });

test('symptomWords: lower case, camelCase and paths split, short words, numbers, stop words and commit types dropped', () => {
  assert.deepEqual(symptomWords('fix(saveSlot): The SAVE slot is lost on src/save.mjs after 3 loads'), ['save', 'slot', 'lost', 'src', 'mjs', 'loads']);
});

test('symptom words: the matching landings ranked with score and reasons; landings past the window are no candidates', () => {
  const { repo, state, L, head } = world(), r = suspects({ dir: repo, state, words: 'the lexer splits the grammar wrongly', now: NOW });
  assert.equal(r.sha, head); assert.equal(r.basis, 'measured'); assert.equal(r.found, true);
  assert.deepEqual([r.since.days, r.since.from, r.landings], [SUSPECT_LIMITS.since_days, '2026-10-21', 5]);
  assert.equal(r.suspects.length, 1); const s = r.suspects[0];
  assert.deepEqual([s.landing, s.branch, s.score], [L.parser, 'feat/parser', { trace: 0, partners: 0, words: 3 }]);
  assert.ok(s.reasons.some(x => /"lexer" in src\/lexer\.mjs/.test(x)), s.reasons.join(' | '));
  assert.ok(s.reasons.some(x => /"splits" in the subject "feat\(parser\): split the input"/.test(x)), s.reasons.join(' | '));
  assert.equal(suspects({ dir: repo, state, words: 'the first parser', now: NOW }).suspects.every(x => x.landing !== L.old), true, 'L.old is past the window');
});

test('a batch merge is expanded into its member branches; a merge of main into the batch is no member; an octopus into its branches', () => {
  const { repo, state, L } = world(), r = suspects({ dir: repo, state, words: 'audio save notes compass vane', now: NOW, top: 10 });
  const by = Object.fromEntries(r.suspects.map(s => [s.branch, s]));
  assert.deepEqual(Object.keys(by).sort(), ['feat/audio', 'feat/x', 'feat/y', 'fix/save', 'mq/batch-1'].sort());
  assert.deepEqual([by['feat/audio'].landing, by['feat/audio'].files, by['fix/save'].files, by['mq/batch-1'].files], [L.batch, ['src/audio.mjs'], ['src/save.mjs'], ['docs/notes.md']]);
  assert.equal(by['mq/batch-1'].member, 'own commits', 'the batch branch\'s own commit is a member of its own');
  assert.deepEqual([by['feat/x'].landing, by['feat/y'].landing, by['feat/x'].files], [L.octo, L.octo, ['src/x.mjs']]);
  assert.equal(r.batches, 2); assert.equal(r.candidates, 3 + 3 + 2, 'parser, sky, tokens; three batch members; two octopus branches');
  assert.ok(!r.suspects.some(s => s.files.includes('src/tokens.mjs')), 'main caught up into the batch: tokens is not the batch\'s');
});

test('--trace: the files a trace names first, then the signals\' partners of those, then words; reasons in words', () => {
  // the stored signals and the trace are this test's own writes: a state dir of its own, the shared repo only read
  const { repo, L, head } = world(), t = mkTmp('meta-sus-trace-'), state = path.join(t, 'state', 'kestrel'), tr = path.join(t, 'trace.txt');
  fs.writeFileSync(tr, 'TypeError: cannot read properties of undefined\n    at lex (C:\\work\\kestrel\\src\\lexer.mjs:12:3)\n    at file:///home/u/kestrel/src/missing.mjs:4:1\n');
  storeSignals(state, head, { 'src/lexer.mjs': sig([{ file: 'src/tokens.mjs', shared: 3, share: 0.75, landings: 4 }]) });
  const r = suspects({ dir: repo, state, trace: tr, words: 'sky', now: NOW });
  assert.deepEqual(r.trace.files, ['src/lexer.mjs']); assert.deepEqual(r.trace.unmatched, ['/home/u/kestrel/src/missing.mjs']);
  assert.deepEqual(r.suspects.map(s => s.landing), [L.parser, L.tokens, L.sky]);
  assert.deepEqual(r.suspects.map(s => s.score), [{ trace: 1, partners: 0, words: 0 }, { trace: 0, partners: 1, words: 0 }, { trace: 0, partners: 0, words: 1 }]);
  assert.match(r.suspects[0].reasons[0], /changed src\/lexer\.mjs, named in the trace/);
  assert.match(r.suspects[1].reasons[0], /changed src\/tokens\.mjs, which changes together with src\/lexer\.mjs \(3 shared landings, 75 %\)/);
  assert.deepEqual(r.partners, { sha: head });
  const bare = suspects({ dir: repo, state: path.join(path.dirname(state), 'none'), trace: tr, now: NOW });
  assert.match(bare.partners.na, /no signals stored/); assert.deepEqual(bare.suspects.map(s => s.landing), [L.parser]);
});

test('a word in most landings says nothing and is dropped with the reason; nothing left = no suspect found, never a filler ranking', () => {
  const { repo, state } = world(), r = suspects({ dir: repo, state, words: 'src feat', now: NOW });
  assert.equal(r.found, false); assert.deepEqual(r.suspects, []);
  assert.ok(r.words.dropped.some(x => x.word === 'src' && /in 7 of 8 candidates/.test(x.why)), JSON.stringify(r.words));
  assert.ok(r.words.dropped.some(x => x.word === 'feat' && /a commit type/.test(x.why)), JSON.stringify(r.words));
  assert.equal(suspects({ dir: repo, state, words: 'zebra quantum', now: NOW }).found, false);
});

test('--since a sha or Nd, --top N', () => {
  const { repo, state, L } = world();
  assert.deepEqual(suspects({ dir: repo, state, words: 'parser sky audio', since: L.sky, now: NOW, top: 10 }).suspects.map(s => s.branch), ['feat/audio'], 'only landings after the sha');
  assert.equal(suspects({ dir: repo, state, words: 'parser', since: '90d', now: NOW, top: 10 }).suspects.some(s => s.landing === L.old), true);
  assert.equal(suspects({ dir: repo, state, words: 'audio save notes compass vane', now: NOW, top: 2 }).suspects.length, 2);
  assert.throws(() => suspects({ dir: repo, state, words: 'x', since: 'nope', now: NOW }), /--since/);
});

test('`norn code suspects` prints score and reasons per row, says no suspect found (exit 1), --json; usage errors exit 2', () => {
  const { repo, state, L } = world(), out = [], err = [], where = f => ({ project: null, state: f.state });
  const run = argv => { out.length = 0; err.length = 0; return codeCmd(argv, { out: s => out.push(s), err: s => err.push(s), where, now: NOW }); };
  assert.equal(run(['suspects', 'lexer grammar', '--repo', repo, '--state', state]), 0, err.join('\n'));
  const txt = out.join('\n');
  assert.match(txt, new RegExp(`^ 1\\. score 0 · 0 · 2 +${L.parser.slice(0, 8)} 2026-10-26 feat/parser`, 'm'));
  assert.match(txt, /"lexer" in src\/lexer\.mjs/); assert.match(txt, /score = trace files · partner files · symptom words/); assert.match(txt, /measured from git at [0-9a-f]{12}/);
  assert.equal(run(['suspects', 'zebra', '--repo', repo, '--state', state]), 1); assert.match(out.join('\n'), /no suspect found/);
  assert.equal(run(['suspects', 'audio', '--json', '--top', '1', '--since', '30d', '--repo', repo, '--state', state]), 0);
  const j = JSON.parse(out.join('')); assert.deepEqual([j.found, j.suspects.length, j.suspects[0].branch], [true, 1, 'feat/audio']);
  assert.equal(run(['suspects', '--repo', repo, '--state', state]), 2, 'words or --trace'); assert.match(err.join('\n'), /usage: norn code suspects/);
  assert.equal(run(['suspects', 'x', '--top', '0', '--repo', repo, '--state', state]), 2);
  assert.equal(run(['suspects', 'x', '--since', 'yesterday', '--repo', repo, '--state', state]), 2);
});
