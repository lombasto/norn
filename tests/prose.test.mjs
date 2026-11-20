// RM-30 S1: one renderer for Norn's prose (engine/dash/prose.mjs, on docs.mjs's vendored marked): a question body reads as structure -
// ids and lanes as chips, paths shortened with the full path a title + copy away, measurements as values, before -> after pairs, ranges,
// math symbols - and stays safe (raw HTML escaped, nothing inside code / paths touched, long tokens wrap at 390 px). The Inbox uses it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderProse, pathsIn, shortPath } from '../engine/dash/prose.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { record } from '../engine/lib/records.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

// the real solve-shack Q-4 body (one paragraph, \r\n, four brief names, measurements, a run id, a lane, a long absolute path)
const Q4 = 'RUN-146 (perf-audit) is done and measured the slow paths. It queued nothing; four ranked briefs sit in D:/work/norn-public/state/solve-shack/notes/perf-audit/: brief-worker-gil.md (one-line GIL switch interval, UI stalls 2.4 s -> ~0.5 s for every worker), brief-inspect-fast.md (Inspect on New job 10.1 s -> ~5.5 s, instant on repeat), brief-long-run-ui.md (5 160-iteration runs stall 0.6-1.9 s per open; rests on synthetic sizes), brief-residual-rust.md (residual file parse 2.7-4.3 s; needs the mesh Rust lane on main; synthetic sizes). Which to queue, and in what order? Check-ins queue none of them without your pick.\r\n';
const CTX = { project: 'solve-shack', lanes: ['perf-audit', 'mesh', 'main'], repo: 'acme/solve', docs: {} };
const text = h => h.replace(/<[^>]+>/g, '');

test('the Q-4 body: run + lane chips, the long path shortened (full path in the title and the copy button), pairs, ranges', () => {
  const h = renderProse(Q4, CTX);
  assert.match(h, /<a class="rid r-run" href="#" data-rid="RUN-146" data-project="solve-shack">RUN-146<\/a>/);
  assert.match(h, /data-rid="L:perf-audit"[^>]*>perf-audit<\/a>/, 'a known lane named bare is a lane chip');
  assert.match(h, /<code class="pp" title="D:\/work\/norn-public\/state\/solve-shack\/notes\/perf-audit\/">…\/notes\/perf-audit<\/code>/);
  assert.match(h, /data-act="copy-path" data-copy="D:\/work\/[^"]*perf-audit\/"/);
  for (const f of ['brief-worker-gil.md', 'brief-inspect-fast.md', 'brief-long-run-ui.md', 'brief-residual-rust.md']) assert.match(h, new RegExp(`class="pp" title="${f}">${f}<`), f);
  assert.match(h, /<span class="pba" title="before → after"><span class="pv">2.4\u00a0s<\/span><span class="parr">→<\/span><span class="pv">≈0.5\u00a0s<\/span><\/span>/);
  assert.match(h, /<span class="pv">10.1\u00a0s<\/span><span class="parr">→<\/span><span class="pv">≈5.5\u00a0s<\/span>/);
  assert.match(h, /<span class="pv prange">0.6–1.9\u00a0s<\/span>/);
  assert.match(h, /<span class="pv prange">2.7–4.3\u00a0s<\/span>/);
  assert.doesNotMatch(h, /data-rid="L:mesh"|data-rid="L:main"/, 'a plain-word lane (mesh, main) is a chip only right after "lane"');
  assert.match(text(h), /5 160-iteration runs/, 'a count beside a word is left alone');
  assert.doesNotMatch(h, /\r/);
  assert.deepEqual(pathsIn(Q4), ['D:/work/norn-public/state/solve-shack/notes/perf-audit/', 'brief-worker-gil.md', 'brief-inspect-fast.md', 'brief-long-run-ui.md', 'brief-residual-rust.md']);
});

test('markdown and line breaks: \\r\\n kept as a break, lists, emphasis, code, tables', () => {
  const h = renderProse('Lead line\r\nsecond line\r\n\r\n- one **bold**\r\n- two `x = 1`\r\n\r\n| a | b |\r\n|---|---|\r\n| 1 s | 2 |\r\n', CTX);
  assert.match(h, /<p>Lead line<br>second line<\/p>/);
  assert.match(h, /<li>one <strong>bold<\/strong><\/li>/);
  assert.match(h, /<code>x = 1<\/code>/);
  assert.match(h, /<td><span class="pv">1\u00a0s<\/span><\/td>/);
  assert.equal(renderProse('', CTX), '');
  assert.equal(renderProse(null, CTX), '');
});

test('every reference kind goes where the dashboard shows it; PR and commit link to the repo', () => {
  const h = renderProse('Q-4 DEC-2 DIR-22 RM-30 RUN-9 DLV-3 WVR-1 MAIL-14 L:perf-audit, PR #17 and commit 1a2b3c4d5e; `c863183ab`', CTX);
  for (const [id, k] of [['Q-4', 'q'], ['DEC-2', 'dec'], ['DIR-22', 'dir'], ['RM-30', 'rm'], ['RUN-9', 'run'], ['L:perf-audit', 'l']]) assert.match(h, new RegExp(`<a class="rid r-${k}" href="#" data-rid="${id}"`), id);
  assert.match(h, /<a class="rid r-dlv" href="#" data-dlv="DLV-3" data-project="solve-shack">/, 'a deliverable opens its drawer');
  assert.match(h, /<span class="rid r-wvr" title="norn rec show WVR-1">WVR-1<\/span>/, 'no page lists waivers: a chip, not a link');
  assert.match(h, /<span class="rid r-mail"[^>]*>MAIL-14<\/span>/);
  assert.match(h, /<a class="rid r-pr" href="https:\/\/github.com\/acme\/solve\/pull\/17" target="_blank" rel="noopener noreferrer">PR #17<\/a>/);
  assert.match(h, /commit <a class="rid r-sha" href="https:\/\/github.com\/acme\/solve\/commit\/1a2b3c4d5e"[^>]*>1a2b3c4<\/a>/);
  assert.match(h, /href="https:\/\/github.com\/acme\/solve\/commit\/c863183ab"/, 'a sha alone in backticks');
  const bare = renderProse('PR #17 and commit 1a2b3c4d5e', { ...CTX, repo: null });
  assert.match(bare, /<span class="rid r-pr">PR #17<\/span>/);
  assert.match(bare, /<span class="rid r-sha" title="1a2b3c4d5e">1a2b3c4<\/span>/);
  assert.doesNotMatch(renderProse('the total was 1234567 and deadbee is a word', CTX), /r-sha/, 'hex with no git word is not a sha');
});

test('math: >= <= != ~ x as symbols, values with units, $...$ monospace, money stays money', () => {
  const h = renderProse('rate >= 0.43 %/h, a <= b, x != y, ~4 s, 3x faster, 2 x 3; $a_1 + b^2$ costs $3 and 50% in 5-10 min', CTX);
  assert.match(h, /rate <span class="pv">≥ 0.43\u00a0%\/h<\/span>/, 'a bound on a value is part of the value');
  assert.match(h, /a <span class="pop">≤<\/span> b/);
  assert.match(h, /x <span class="pop">≠<\/span> y/);
  assert.match(h, /<span class="pv">≈4\u00a0s<\/span>/);
  assert.match(h, /<span class="pv">3×<\/span> faster/);
  assert.match(h, /2 <span class="pop">×<\/span> 3/);
  assert.match(h, /<code class="pmath">a_1 \+ b\^2<\/code>/);
  assert.match(h, /costs <span class="pv">\$3<\/span>/);
  assert.match(h, /<span class="pv">50%<\/span>/);
  assert.match(h, /<span class="pv prange">5–10\u00a0min<\/span>/);
  assert.doesNotMatch(renderProse('on 2026-11-18 at 10:15', CTX), /pv|prange/, 'a date is not a range');
});

test('adversarial: HTML injection, a path containing ->, a lane that is an ordinary word, ids inside code, very long tokens', () => {
  const inj = renderProse('<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1)) "quoted" & <b>', CTX);
  assert.doesNotMatch(inj, /<script|<img|<b>|href="javascript/i);
  assert.match(inj, /&lt;script&gt;/);
  const arrow = renderProse('moved /tmp/a->b/c.txt then queued -> running', CTX);
  assert.match(arrow, /title="\/tmp\/a-&gt;b\/c.txt">…\/a-&gt;b\/c.txt<\/code>/, 'the arrow inside a path stays the path');
  assert.match(arrow, /queued <span class="parr">→<\/span> running/, 'a word arrow outside it is drawn');
  const word = renderProse('the main thing is the main lane; then lane main', { ...CTX, lanes: ['main'] });
  assert.equal((word.match(/data-rid="L:main"/g) || []).length, 1, 'only "lane main" is a chip');
  const code = renderProse('run `norn rec show Q-4 --full` (Q-4) and\n```\nRUN-146 -> 2.4 s C:\\x\\y.md\n```', CTX);
  assert.match(code, /<code>norn rec show Q-4 --full<\/code>/, 'an id inside a code span is code');
  assert.match(code, /<pre class="code"><code class="hljs">RUN-146 -&gt; 2.4 s C:\\x\\y.md<\/code><\/pre>/, 'nothing inside a fenced block is touched');
  assert.equal((code.match(/data-rid="Q-4"/g) || []).length, 1);
  const win = renderProse('see D:\\cfg\\x\\.claude\\settings.json.', CTX);
  assert.match(win, /title="D:\\cfg\\x\\.claude\\settings.json">…\/.claude\/settings.json<\/code>/, 'markdown never eats a backslash in a path; the full stop stays outside');
  assert.match(win, /<\/span>\.<\/p>/);
  const ph = renderProse('a \uE000\uE100\uE001 b', CTX);
  assert.doesNotMatch(ph, /[\uE000-\uF8FF]/, 'a placeholder smuggled into the text is dropped');
  const longTok = 'x'.repeat(300);
  assert.match(renderProse(longTok, CTX), new RegExp(`<p>${longTok}</p>`), 'a long token renders whole (CSS overflow-wrap:anywhere wraps it)');
});

test('long text clamps behind "more" only when asked; sanitize runs last; shortPath keeps the tail', () => {
  const long = renderProse(Q4, { ...CTX, clamp: true, key: 'solve-shack:Q-4' });
  assert.match(long, /^<div class="prose pclamp" data-key="solve-shack:Q-4">/);
  assert.match(long, /<button type="button" class="ghost pmore" data-act="prose-more" aria-expanded="false">more<\/button>$/);
  assert.doesNotMatch(renderProse('short', { ...CTX, clamp: true, key: 'k' }), /pclamp|pmore/);
  assert.equal(renderProse('x', { sanitize: () => 'CLEAN' }), 'CLEAN');
  // inline: text inside a line (a <p>, an <li>) is one <span> - no <div> or <p> a browser would hoist out of the line; never clamped
  const inl = renderProse(Q4, { ...CTX, inline: true, clamp: true, key: 'k' });
  assert.match(inl, /^<span class="prose pinline">[\s\S]*<\/span>$/); assert.doesNotMatch(inl, /<(div|p)\b|pmore/);
  assert.match(inl, /data-rid="RUN-146"/);
  assert.equal(renderProse('no **context** line', { inline: true }), '<span class="prose pinline">no <strong>context</strong> line</span>');
  assert.equal(shortPath('engine/dash/ui.mjs'), '…/dash/ui.mjs');
  assert.equal(shortPath('dash/ui.mjs'), 'dash/ui.mjs');
  const doc = renderProse('read `engine/prompts/CHECKIN.md`', { ...CTX, docs: { 'engine/prompts/CHECKIN.md': 'ins-7' } });
  assert.match(doc, /<button type="button" class="pp lnk" data-act="open-doc" data-doc="ins-7" data-project="solve-shack" title="engine\/prompts\/CHECKIN.md - open in Docs">…\/prompts\/CHECKIN.md<\/button>/);
});

test('the Inbox: a Q-4-like body shows chips, a shortened path, a before→after pair; options are cards; 390 px never scrolls sideways', async t => {
  const f = await fixture();
  try {
    const S = f.pa.state, deep = `${f.pa.root.replace(/\\/g, '/')}/notes/perf-audit/a-very-long-folder-name-that-would-push-a-phone-sideways-if-it-did-not-wrap/`;
    record(S, { kind: 'lane', ev: 'create', by: 'controller', data: { name: 'perf-audit' } });
    record(S, { kind: 'question', ev: 'create', by: 'controller', data: { title: 'Which perf-audit briefs to queue?', lane: 'perf-audit',
      body: Q4.replace('D:/work/norn-public/state/solve-shack/notes/perf-audit/', deep),
      options: [{ key: 'A', text: 'Queue worker-gil and inspect-fast now; hold the other two', cost: 'two Claude runs' }, { key: 'B', text: 'Queue all four in listed order', cost: 'four runs, last two on synthetic evidence' }, { key: 'C', text: 'Queue none yet', cost: 'none' }],
      recommend: { key: 'A', why: 'the first two are measured on the real PF2 files (RUN-146); the last two rest on synthetic sizes' } } });
    const ib = (await f.get('/api/inbox?project=kestrel')).data;
    assert.ok(ib.prose?.kestrel?.lanes.includes('perf-audit'), 'the prose context carries the project lanes');
    const h = renderTab('inbox', ib, { project: 'kestrel', now: Date.now() });
    const q = h.slice(h.indexOf('<article class="q openq" id="q-Q-2"'), h.indexOf('</article>', h.indexOf('id="q-Q-2"')));
    assert.match(q, /<div class="qbody"><div class="prose pclamp" data-key="kestrel:Q-2">/);
    assert.match(q, /data-rid="RUN-146"/);
    assert.match(q, /data-rid="L:perf-audit"/);
    assert.match(q, />…\/a-very-long-folder-name-that-would-push-a-phone-sideways-if-it-did-not-wrap\/? ?<|>…\/perf-audit\/a-very-long-folder-name-that-would-push-a-phone-sideways-if-it-did-not-wrap</);
    assert.match(q, /<span class="pba" title="before → after">/);
    assert.match(q, /<div class="opt rec" data-key="A"><div class="ohead"><b class="okey">A<\/b> <span class="chip needs">recommended<\/span><\/div>/);
    assert.match(q, /<div class="ocost"><span class="olab">cost<\/span><div class="prose"><p>two Claude runs<\/p>/);
    assert.match(q, /<div class="owhy"><span class="olab">why<\/span><div class="prose"><p>the first two are measured on the real PF2 files \(<a class="rid r-run"/);
    assert.equal((q.match(/class="owhy"/g) || []).length, 1, 'only the recommended card carries the why');
    assert.match(q, /<div class="opt" data-key="B">/);
    if (skipWhy) { t.diagnostic(`browser part skipped: ${skipWhy}`); return; }
    const pg = await openPage([390, 844]);
    try {
      await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await pg.go(`${f.url}/?project=kestrel&tab=inbox`);
      assert.ok(await pg.until(`document.querySelector('#q-Q-2 .qbody .prose')`, 60000), 'the question shows');
      assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on a phone');
      assert.ok(await pg.ev(`(() => { const r = document.querySelector('#q-Q-2 .qbody .prose').getBoundingClientRect(); return r.height < 120 && r.right <= 390; })()`), 'a 3-line preview');
      assert.ok(await pg.ev(`getComputedStyle(document.querySelector('#q-Q-2 .pmore')).display !== 'none'`), '"more" on the phone');
      await pg.ev(`document.querySelector('#q-Q-2 .pmore').click()`);
      assert.ok(await pg.ev(`document.querySelector('#q-Q-2 .qbody .prose').classList.contains('open') && document.querySelector('#q-Q-2 .qbody .prose').getBoundingClientRect().height > 120`), 'more opens it');
      assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'the opened body wraps its long path');
      assert.ok(await pg.ev(`[...document.querySelectorAll('#q-Q-2 .opt')].every(o => { const r = o.getBoundingClientRect(); return r.left >= 0 && r.right <= 390; })`), 'the option cards fit');
    } finally { await pg.close(); }
  } finally { await f.done(); }
});
