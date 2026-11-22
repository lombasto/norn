// META-TEND P1: the ONE advisory record - every finding of every TEND phase (instruction files, memory, usage, tests, rules) has this
// shape, and every fix is an approval card (REPORT s.3.7, s.5.0-5.1): nothing edits a steering file, memory, test or hook by itself.
//
// { id 'A-<sha10>' (stable: the same finding keeps its id), phase, check (the REPORT 3.2 number, or a phase's own key), key (a short
//   machine name), severity high | medium | low | count, surface (what it is about: "memory index", "CLAUDE.local.md", ...),
//   path | null, line | null, why (ONE plain-English line), source (where the rule comes from), items? [{ line?, text, path? }] (the
//   lines of an aggregated finding), fix { tier, action, kind, ways?, patch? }, row? (the id of the row it sits on in its tab), other? (the path of the
//   second side of a conflict) }. The id hashes phase, key, path and subject - or the line when there is no subject (a finding with a
//   subject keeps its id when lines move above it).
// fix.tier: tap = an exact mechanical patch (one tap applies it); card = a hunk to read (judgment); flag = flag only (risky: a
// prohibition, a user-level file, anything outside the project). first_seen / new: crossings() - only a NEW crossing warns.
// Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const SEVERITIES = ['high', 'medium', 'low', 'count'];
export const TIERS = ['tap', 'card', 'flag'];
// META-UX-BUILD S5 (REPORT s.3): the kind of fix, DECLARED by the check that writes the finding (never guessed from its text):
// ready = the exact new text is known (it carries its patch); drafts = a one-sentence fix, a worker writes the text; call = the owner
// picks one of its two ways (fix.ways); count = the row only counts something, nothing to fix.
export const FIX_KINDS = ['ready', 'drafts', 'call', 'count'];
/** throws unless f declares a kind of fix (and its two ways for "call"); where = the check, for the message */
export function checkFixKind(f, where) {
  if (!FIX_KINDS.includes(f?.kind)) throw new Error(`${where}: no kind of fix (${FIX_KINDS.join(' | ')}) - the check declares it`);
  if (f.kind === 'call' && !(Array.isArray(f.ways) && f.ways.length === 2 && f.ways.every(w => typeof w === 'string' && w))) throw new Error(`${where}: your call names its two ways`);
}
const NEW_MS = 24 * 3600000;

/** one advisory record (validated; throws on a bad shape - a check bug, never data) */
export function advisory({ phase = 'P1', check, key, severity, surface, path: file = null, line = null, why, source, items, fix, subject = '', row, other }) {
  if (!key || !/^[a-z][a-z0-9-]*$/.test(key)) throw new Error(`advisory: key ${JSON.stringify(key)} is not a short machine name`);
  if (!SEVERITIES.includes(severity)) throw new Error(`advisory ${key}: severity ${JSON.stringify(severity)} (${SEVERITIES.join(' | ')})`);
  if (!why || /\n/.test(why) || why.length > 300) throw new Error(`advisory ${key}: why must be one line of at most 300 characters`);
  if (!source) throw new Error(`advisory ${key}: no source`);
  if (!fix || !TIERS.includes(fix.tier) || !fix.action) throw new Error(`advisory ${key}: fix needs a tier (${TIERS.join(' | ')}) and an action`);
  if (fix.tier === 'tap' && !fix.patch) throw new Error(`advisory ${key}: a one-tap fix carries its exact patch`);
  checkFixKind(fix, `advisory ${key}`);
  if (fix.kind === 'ready' && !fix.patch) throw new Error(`advisory ${key}: a ready fix carries its exact patch`);
  const id = 'A-' + createHash('sha1').update([phase, key, String(file ?? '').toLowerCase(), subject ? '' : line ?? '', subject].join('|')).digest('hex').slice(0, 10);
  return { id, phase, check: check ?? null, key, severity, surface, path: file, line, why, source, ...(items?.length ? { items } : {}),
    fix: { tier: fix.tier, action: fix.action, kind: fix.kind, ...(fix.kind === 'call' ? { ways: [...fix.ways] } : {}), ...(fix.patch ? { patch: fix.patch } : {}) }, ...(row ? { row } : {}), ...(other ? { other } : {}) };
}

/**
 * first_seen per advisory id (<state>/advisory/seen.json) -> the list with first_seen and new (first seen in the last 24 h): only a
 * new crossing warns. Without a state nothing is stored and nothing is new.
 */
const seenFile = state => path.join(state, 'advisory', 'seen.json');
// a missing store is empty; a corrupt one throws: read as {} it would make every finding new and be written over its history
const missing = e => { if (e.code === 'ENOENT') return '{}'; throw e; };
/** the pure core: first_seen / new for each of list, seen updated in place; dirty = a new id was stored */
function markSeen(seen, list, now) {
  let dirty = false;
  const iso = new Date(now).toISOString();
  const out = list.map(a => { if (!seen[a.id]) { seen[a.id] = iso; dirty = true; } return { ...a, first_seen: seen[a.id], new: now - Date.parse(seen[a.id]) < NEW_MS }; });
  return { out, dirty };
}
export function crossings(state, list, now = Date.now()) {
  if (!state) return list.map(a => ({ ...a, first_seen: null, new: false }));
  const f = seenFile(state);
  let t; try { t = fs.readFileSync(f, 'utf8'); } catch (e) { t = missing(e); }
  const seen = JSON.parse(t);
  const { out, dirty } = markSeen(seen, list, now);
  if (dirty) { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(seen)); fs.renameSync(tmp, f); }
  return out;
}
/** META-DASH-ASYNC R1: crossings on fs.promises (the dash Guard GET): the same core, the seen store read and written without blocking */
export async function crossingsAsync(state, list, now = Date.now()) {
  if (!state) return list.map(a => ({ ...a, first_seen: null, new: false }));
  const f = seenFile(state);
  const seen = JSON.parse(await fs.promises.readFile(f, 'utf8').catch(missing));
  const { out, dirty } = markSeen(seen, list, now);
  if (dirty) {
    await fs.promises.mkdir(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(seen)); await fs.promises.rename(tmp, f);
  }
  return out;
}
