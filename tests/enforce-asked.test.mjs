// RM-30 S1 owner bug (2026-11-18): the repeat detector's "Approve: ask for a brief" card. The owner approved a card (solve-shack DIR-22,
// "Enforce (advisory A-bf673feaf3 ...)"); the cluster then grew (DIR-23), its id moved (A-7e1ba66d76), the card never closed, offered
// Approve again, and the duplicate check refused it in CLI words. Now: a card its directive already asks for reads "Asked as DIR-n" with
// no Approve, Approve is one tap and records the card id, and a dashboard duplicate refusal says which directive it matches in plain
// words with Open DIR-n / Replace it with this wording (a recorded supersede).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { askedBy, enforceCards, openCards } from '../engine/lib/rules.mjs';
import { renderTab, dupRefusal } from '../engine/dash/ui.mjs';
import { needsYou } from '../engine/dash/terms.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { fixture, ENGINE } from './helpers/dash-fixture.mjs';

const NEW_ID = 'A-7e1ba66d76', OLD_ID = 'A-bf673feaf3';
const card = (id = NEW_ID, members = ['DIR-8', 'DIR-11', 'DIR-20', 'DIR-23']) => ({ id, phase: 'P3', key: 'rule-repeated', severity: 'medium', surface: 'repeated correction',
  why: `said ${members.length} times (${members.join(', ')}); it is line 16 of CHECKIN.md, and still broken. Make it a repo test?`,
  items: members.map(m => ({ text: `${m}: Fix all (DEC-1): start the fixer` })), fix: { tier: 'card', action: 'approve = a directive asks the check-in for a task brief', kind: 'call', ways: ['Make it enforced', 'Leave it as prose'], patch: "test('rule: x', () => {});" },
  approve: `Enforce (advisory ${id}, the repeat detector): said ${members.length} times (${members.join(', ')}). Draft: test - write a task brief that adds it.` });
const DIR22 = `Enforce (advisory ${OLD_ID}, the repeat detector): said 3 times (DIR-8, DIR-11, DIR-20); it is line 17 of idea-source-repo.md, and still broken. Make it a repo test? Draft: test('rule: ...') - write a task brief that adds it, red-first, and retire the prose line once it lands.`;
const writeCards = (state, cards) => { fs.mkdirSync(path.join(state, 'instructions'), { recursive: true }); fs.writeFileSync(path.join(state, 'instructions', 'rules.json'), JSON.stringify({ at: new Date().toISOString(), rules: {}, retired: {}, cards })); };

test('askedBy: the card id in the text, data.card, or the same corrections after the id moved; an unrelated Enforce is not it', () => {
  const items = { 'DIR-22': { id: 'DIR-22', kind: 'directive', state: 'active', created: '2026-11-18T01:15:11Z', data: { text: DIR22 } } };
  assert.deepEqual(askedBy(card(), items), { id: 'DIR-22', state: 'active', at: '2026-11-18T01:15:11Z' }, 'the DIR-22 shape: same corrections, moved id');
  assert.equal(askedBy(card(NEW_ID, ['DIR-30', 'DIR-31', 'DIR-8']), items), null, 'one shared correction is another cluster');
  assert.equal(askedBy(card(), { 'DIR-5': { id: 'DIR-5', kind: 'directive', state: 'active', data: { text: 'said 3 times (DIR-8, DIR-11, DIR-20) but not an approval' } } }), null);
  assert.equal(askedBy(card(), { 'DIR-6': { id: 'DIR-6', kind: 'directive', state: 'revoked', created: 'x', data: { text: 'anything', card: NEW_ID } } })?.id, 'DIR-6', 'data.card');
  assert.equal(askedBy(card(), { 'DIR-7': { id: 'DIR-7', kind: 'directive', state: 'active', created: 'x', data: { text: `Enforce (advisory ${NEW_ID}, ...)` } } })?.id, 'DIR-7', 'the id in the text');
});

test('the DIR-22 shape: card + its existing directive -> "Asked as DIR-n (active)", a link, no Approve, not counted as needs-you', async () => {
  const f = await fixture();
  try {
    const S = f.pa.state;
    const d = record(S, { kind: 'directive', ev: 'create', by: 'owner', data: { text: DIR22, via: 'dashboard' } });
    writeCards(S, [card(), card('A-0123456789', ['DIR-40', 'DIR-41', 'DIR-42'])]);
    const items = loadState(S).items;
    assert.deepEqual(enforceCards(S, items).map(c => [c.id, c.asked?.id ?? null]), [[NEW_ID, d.id], ['A-0123456789', null]]);
    assert.deepEqual(openCards(S, items).map(c => c.id), ['A-0123456789'], 'the CLI audit view lists only the open card');
    const ib = (await f.get('/api/inbox?project=kestrel')).data, enf = ib.items.filter(i => i.type === 'enforce');
    assert.deepEqual(enf.map(i => [i.id, i.asked?.id ?? null]), [[NEW_ID, d.id], ['A-0123456789', null]]);
    assert.equal(ib.needs_you, needsYou(ib.items.filter(i => i.id !== NEW_ID)), 'an asked card is for information');
    const h = renderTab('inbox', ib, { project: 'kestrel', now: Date.now() });
    const cardOf = id => { const a = h.indexOf(`id="enf-${id}"`), b = h.indexOf('<li class="insfind', a + 1); return h.slice(a, b < 0 ? h.indexOf('</section>', a) : b); }, li = cardOf(NEW_ID);
    assert.match(li, new RegExp(`Asked as <a class="rid r-dir" href="#" data-rid="${d.id}" data-project="kestrel">${d.id}</a> \\(active\\) - \\w{3} \\d{2}-\\d{2} \\d{2}:\\d{2}`), 'its date, local');
    assert.doesNotMatch(li, /adv-approve|Approve/, 'no Approve on an asked card');
    const open = cardOf('A-0123456789');
    assert.match(open, /data-act="adv-approve" data-project="kestrel" data-id="A-0123456789"/);
  } finally { await f.done(); }
});

test('Approve is one tap and records the card; a dashboard duplicate refusal names the match, Open / Replace it with this wording', async () => {
  const html = fs.readFileSync(path.join(ENGINE, 'dash', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /adv-approve' && confirm/, 'no confirm() before Approve');
  assert.match(html, /d\.act === 'adv-approve'\) \{ dirSend\(\{ project: d\.project \|\| p, text: d\.text, card: d\.id \}\)/);
  const f = await fixture();
  try {
    const S = f.pa.state;
    const own = record(S, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'Never run the full test suite in a loop; run one test file at a time with META_ROOT set.', via: 'chat' } });
    const ok = await f.post('/api/directive', { project: 'kestrel', text: card('A-0123456789', ['DIR-40', 'DIR-41', 'DIR-42']).approve, card: 'A-0123456789' });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(loadState(S).items[ok.data.id].data.card, 'A-0123456789', 'the directive keeps the card it approves');
    const text = 'Never run the full test suite in a loop: run one test file at a time, with META_ROOT set.';
    const no = await f.post('/api/directive', { project: 'kestrel', text });
    assert.equal(no.status, 409);
    assert.equal(no.data.dup.id, own.id);
    assert.match(no.data.dup.line, /Never run the full test suite/);
    const h = dupRefusal({ project: 'kestrel', text, dup: no.data.dup });
    assert.match(h, new RegExp(`Not written: this says the same as ${own.id}, an active directive\\.`));
    assert.match(h, new RegExp(`<button data-act="dup-open" data-id="${own.id}">Open ${own.id}</button>`));
    assert.match(h, new RegExp(`<button class="primary" data-act="dup-replace" data-id="${own.id}">Replace it with this wording</button>`));
    assert.doesNotMatch(h, /norn rec|new: true|supersede DIR/, 'plain words, not the CLI text');
    assert.equal(dupRefusal(null), '');
    const rep = await f.post('/api/directive', { project: 'kestrel', text, replace: own.id });
    assert.equal(rep.status, 200, JSON.stringify(rep.data));
    const it = loadState(S).items;
    assert.equal(it[own.id].state, 'superseded', 'Replace = a recorded supersede');
    assert.equal(it[rep.data.id].state, 'active');
    assert.equal((await f.post('/api/directive', { project: 'kestrel', text: 'x y z', replace: own.id })).status, 400, 'only an active directive can be replaced');
  } finally { await f.done(); }
});
