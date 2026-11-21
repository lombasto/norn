// META-UX-R1 addendum A: the Docs tab renders markdown (headings, tables, lists, highlighted code, links, contents sidebar) with a
// vendored, pinned renderer + highlighter served locally (no CDN, DIR-8); raw HTML / script links are neutralised; record
// conventions get colour cues (DEC- / DIR- / RUN- / Q- ids as clickable chips, DONE / STOPPED / HANDOFF, PROPOSED / GUESS ... tags).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { renderMarkdown } from '../engine/dash/docs.mjs';
import { renderTab, loadTab, loadParts } from '../engine/dash/ui.mjs';
import { fixture, ENGINE } from './helpers/dash-fixture.mjs';

const MD = `# Door plan
Intro with DEC-12, DIR-5 and RUN-301 and lane L:seabed; status PROPOSED, then MEASURED (GUESS before).

## Steps
- one
- two with \`DEC-99 in code\`

| id | state |
|---|---|
| DEC-1 | DONE |

\`\`\`rust
fn main() { let x = 1; }
\`\`\`

\`\`\`json
{"a": 1}
\`\`\`

[docs](https://example.com/x) [bad](javascript:alert(1)) [rel](../other.md) [about DEC-7](https://example.com/dec)
<script>alert(1)</script> <img src=x onerror=alert(1)>
![pic](https://evil.example/p.png)

## DONE
### STOPPED: red test
`;

test('markdown: headings with ids + contents, lists, tables, highlighted code', () => {
  const { html, toc } = renderMarkdown(MD);
  assert.match(html, /<h1 id="door-plan"/); assert.match(html, /<h2 id="steps"/);
  assert.deepEqual(toc.map(t => [t.depth, t.id]), [[1, 'door-plan'], [2, 'steps'], [2, 'done'], [3, 'stopped-red-test']]);
  assert.match(html, /<ul>\s*<li>one<\/li>/); assert.match(html, /<table>/); assert.match(html, /<th>id<\/th>/);
  assert.match(html, /<code class="hljs language-rust">[\s\S]*class="hljs-keyword">fn</, 'rust highlighted');
  assert.match(html, /<code class="hljs language-json">[\s\S]*hljs-/, 'json highlighted');
});

test('sanitised: raw HTML escaped, script / relative links neutralised, no external images', () => {
  const { html } = renderMarkdown(MD);
  assert.ok(!/<script|<img|onerror=|javascript:/i.test(html.replace(/&lt;[^&]*&gt;/g, '')), 'no live script / img / js link');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<a href="https:\/\/example\.com\/x" rel="noopener noreferrer" target="_blank">docs<\/a>/);
  assert.ok(!html.includes('href="../other.md"'), 'relative link not followed'); assert.match(html, /title="\.\.\/other\.md"/);
  assert.ok(!html.includes('evil.example/p.png"'), 'external image not loaded'); assert.match(html, /image: pic/);
});

test('record conventions: id chips (not in code / links), DONE / STOPPED / HANDOFF markers, PROPOSED / MEASURED / GUESS tags', () => {
  const { html } = renderMarkdown(MD);
  for (const id of ['DEC-12', 'DIR-5', 'RUN-301', 'L:seabed', 'DEC-1']) assert.ok(html.includes(`data-rid="${id}"`), 'chip ' + id);
  assert.ok(!html.includes('data-rid="DEC-99"'), 'no chip inside inline code');
  assert.ok(!html.includes('data-rid="DEC-7"'), 'no chip nested inside a link');
  assert.match(html, /<span class="tg tg-proposed">PROPOSED<\/span>/); assert.match(html, /tg-measured/); assert.match(html, /tg-guess/);
  assert.match(html, /<h2 id="done" class="mk mk-done"/); assert.match(html, /<h3 id="stopped-red-test" class="mk mk-stopped"/);
  assert.match(html, /<span class="chip done">DONE<\/span>/);
});

test('vendored renderer files are pinned (VENDOR.md sha256) and served locally; nothing else under /vendor', async () => {
  const V = path.join(ENGINE, 'dash', 'vendor'), pins = [...fs.readFileSync(path.join(V, 'VENDOR.md'), 'utf8').matchAll(/`([a-z.]+\.m?js)`[^\n]*sha256 `([0-9a-f]{64})`/g)];
  assert.deepEqual(pins.map(p => p[1]).sort(), ['highlight.min.js', 'marked.esm.js', 'purify.es.mjs']);   // fonts: norn-look.test
  for (const [, f, sha] of pins) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(V, f))).digest('hex'), sha, f + ' pinned');
  const f = await fixture();
  try {
    for (const p of ['/vendor/marked.esm.js', '/vendor/purify.es.mjs', '/vendor/highlight.min.js', '/docs.mjs']) {
      const r = await fetch(f.url + p); assert.equal(r.status, 200, p); assert.match(r.headers.get('content-type'), /javascript/); }
    for (const p of ['/vendor/VENDOR.md', '/vendor/..%2Fserver.mjs', '/vendor/LICENSE.marked']) assert.equal((await fetch(f.url + p)).status, 404, p);
    const html = await (await fetch(f.url + '/')).text();
    assert.ok(!/https?:\/\/(?!127\.0\.0\.1)[^"'\s]+\.(js|mjs|css)/.test(html), 'no CDN');
  } finally { await f.done(); }
});

test('Docs tab: rendered body + contents sidebar from the project doc', async () => {
  const f = await fixture();
  try {
    const get = async r => (await f.get(r)).data, t = await loadTab('docs', 'kestrel', get, { doc: 'doc-0' });   // META-UX-BUILD S3: the file is its own part
    const d = { ...t, ...(await loadParts('docs', 'kestrel', t, get)), parts_loading: false };
    const html = renderTab('docs', d, { project: 'kestrel' });
    assert.match(html, /id="doc-body"/); assert.match(html, /<h1 id="plan"/); assert.match(html, /<li>step one<\/li>/);
    assert.match(html, /id="doc-toc"[\s\S]*href="#plan"/);
    const s = renderTab('docs', d, { project: 'kestrel', sanitize: h => h.replace('step one', 'SANITISED') });
    assert.match(s, /SANITISED/, 'the browser passes DOMPurify as ctx.sanitize');
  } finally { await f.done(); }
});
