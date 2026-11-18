// Gap #5: a directive that restates an ACTIVE one. Every check-in re-reads both and the digest lists both, so a restatement is
// caught when it is written (norn rec add directive, the dashboard's directive POST, the chat's norn_directive: refused unless
// --new / new: true) and an existing pair is a digest row the check-in folds (supersede the older by the newer).
// Pure: no I/O. Norn's own directives (Fix all: data.fixall, and the dashboard's card taps, which never call this) are never matched.

// words that carry no subject; a word of one or two letters is dropped too
const STOP = new Set(('the and for with from that this these those then than into onto over under while when what which who whom whose '
  + 'not now more most less all any each every some only also just still yet but nor are was were been being has have had does did done '
  + 'can could should would will shall may might must its their there here them they you your our out off per via about after before '
  + 'first again keep make made get got let lets use used using one two new old way ask asks wait waits owner owners norn').split(' '));
const REF_RE = /\b(RM|DIR)-(\d+)(?!\d)/g;

/** the RM-n / DIR-n ids a text names */
export function refsOf(text) {
  const rm = new Set(), dir = new Set();
  for (const m of String(text || '').matchAll(REF_RE)) (m[1] === 'RM' ? rm : dir).add(`${m[1]}-${m[2]}`);
  return { rm, dir };
}
/** the normalized word set: lower case, ids out, split on anything not a letter / digit, stop words and 1-2 letter words out, a plural s off */
export function wordsOf(text) {
  const s = new Set();
  for (let w of String(text || '').replace(REF_RE, ' ').toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    s.add(w);
  }
  return s;
}
const shared = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };
export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  const n = shared(a, b);
  return n / (a.size + b.size - n);
}

// Thresholds (tests/dupdirs.test.mjs pins them on the two real pairs and on unrelated directives):
// plain word overlap alone >= 0.5; the same roadmap item (RM-n) + >= 0.25; the text names the other directive (DIR-n) + >= 0.2 -
// and always at least MIN_SHARED words in common (two one-line caps, "cap 4" / "cap 2", are not a restatement by this measure).
export const JACCARD_ALONE = 0.5, JACCARD_SAME_RM = 0.25, JACCARD_CITES = 0.2, MIN_SHARED = 3;

/** a = the newer text, b = { id, text } of the older directive -> { score, why } when a looks like a restatement of b, else null */
export function dupMatch(aText, b) {
  const wa = wordsOf(aText), wb = wordsOf(b.text);
  if (shared(wa, wb) < MIN_SHARED) return null;
  const score = jaccard(wa, wb);
  const ra = refsOf(aText), rb = refsOf(b.text);
  const sameRm = [...ra.rm].filter(x => rb.rm.has(x));
  const r = +score.toFixed(2);
  if (ra.dir.has(b.id) && score >= JACCARD_CITES) return { score: r, why: `names ${b.id}, word overlap ${r}` };
  if (sameRm.length && score >= JACCARD_SAME_RM) return { score: r, why: `same roadmap item ${sameRm.join(', ')}, word overlap ${r}` };
  if (score >= JACCARD_ALONE) return { score: r, why: `word overlap ${r}` };
  return null;
}

const firstLine = t => String(t || '').split('\n')[0].trim().slice(0, 200);
// an active directive the owner (or a chat for the owner) wrote; Norn's own (Fix all) never counts
const isOwnerActive = i => i && i.kind === 'directive' && i.state === 'active' && !i.data?.fixall;
const idNum = id => Number(String(id).match(/(\d+)$/)?.[1] ?? 0);

/**
 * dupOf(items, text) -> { id, line, score, why } of the active directive `text` most likely restates, or null.
 * items = the folded records ({ id: item } or a list). The best score wins; ties go to the newest.
 */
export function dupOf(items, text) {
  let best = null;
  for (const i of Object.values(items || {})) {
    if (!isOwnerActive(i)) continue;
    const m = dupMatch(text, { id: i.id, text: i.data.text });
    if (m && (!best || m.score > best.score || (m.score === best.score && idNum(i.id) > idNum(best.id)))) best = { id: i.id, line: firstLine(i.data.text), ...m };
  }
  return best;
}

/** the refusal text of every surface (CLI / dashboard / chat); `flag` = how that surface creates anyway */
export const dupMessage = (d, flag = '--new') => `looks like a duplicate of ${d.id}: ${d.line} (${d.why}); update ${d.id} instead `
  + `(a directive has no edit: create the new wording with ${flag}, then norn rec supersede ${d.id} --by <the new DIR> --why "restated"), `
  + `or pass ${flag} to create anyway`;

/**
 * The digest's pairs: every two active owner directives where the newer looks like a restatement of the older, oldest pair first.
 * A pair the owner kept on purpose (the newer was created with --new against the older: data.distinct_from) is not listed.
 * -> [{ id: 'DIR-2~DIR-6', older, newer, why, line }]
 */
export function dupPairs(items) {
  const dirs = Object.values(items || {}).filter(isOwnerActive).sort((a, b) => idNum(a.id) - idNum(b.id));
  const rows = [];
  for (let j = 1; j < dirs.length; j++) for (let i = 0; i < j; i++) {
    const older = dirs[i], newer = dirs[j];
    if ((newer.data.distinct_from || []).includes(older.id)) continue;
    const m = dupMatch(newer.data.text, { id: older.id, text: older.data.text });
    if (m) rows.push({ id: `${older.id}~${newer.id}`, older: older.id, newer: newer.id, why: m.why, line: firstLine(newer.data.text) });
  }
  return rows;
}
