# Vendored browser libraries (Docs tab, META-UX-R1 addendum A)

Served by the dashboard itself from this folder (`/vendor/<file>`, allowlist in server.mjs) - no CDN (local webapp, DIR-8).
Pinned: tests/docs.test.mjs checks each file's sha256 below. Files are copied unmodified from the npm tarball (`npm pack`).
To update: `npm pack <pkg>@<version>`, copy the same file, update version + sha256 here, run `node --test tests/docs.test.mjs`.

| file | package | version | source path in the tarball | license |
|---|---|---|---|---|
| `marked.esm.js` | marked | 18.1.3 | package/lib/marked.esm.js | MIT (LICENSE.marked) |
| `purify.es.mjs` | dompurify | 3.4.17 | package/dist/purify.es.mjs | Apache-2.0 or MPL-2.0 (LICENSE.dompurify) |
| `highlight.min.js` | @highlightjs/cdn-assets | 11.12.0 | package/es/highlight.min.js (common languages) | BSD-3-Clause (LICENSE.highlightjs) |

- `marked.esm.js` sha256 `e76f3b37046a5d294159872002e5f6fcda8ed232e1be45ff76b3863f2919dae3`
- `purify.es.mjs` sha256 `60c5d5ccbb466de3de3ba863461a92bf134f8c156cef7992da43e0f659bc5cbd`
- `highlight.min.js` sha256 `1ed8fc5256b738b8875b74e4d3f0754f60d6411fb034d618dfbc4e6e6c9999d7`

Sanitising: docs.mjs escapes raw HTML, allows only http(s) / mailto / #anchor links and loads no images (safe by construction,
tested in node); in the browser the result additionally passes DOMPurify (ctx.sanitize in index.html).

## Norn look (META-VISUAL-B; same pins as META-VISUAL-A2 norn-projects norn/design/visual-v2/vendor + norn/fonts, branch feat/dash-visual)
Silkscreen is the heading pixel font
(body text stays the system UI font), set at 8 art px so each font pixel lands on whole device pixels.

| file | package | version | source path in the tarball | license |
|---|---|---|---|---|
| `silkscreen-latin-400-normal.woff2` | @fontsource/silkscreen | 5.3.0 | package/files/silkscreen-latin-400-normal.woff2 | SIL OFL 1.1 (LICENSE.silkscreen) |
| `silkscreen-latin-700-normal.woff2` | @fontsource/silkscreen | 5.3.0 | package/files/silkscreen-latin-700-normal.woff2 | SIL OFL 1.1 (LICENSE.silkscreen) |

- `silkscreen-latin-400-normal.woff2` sha256 `e6c72ea4702249202bcdd79d3343057e4e25ef1f04e3fcffd8602ab53b40b4cc`
- `silkscreen-latin-700-normal.woff2` sha256 `5741b7f01a127f40ed70281fa2f686e8fc2cfe241930a120e4d1a1cebe78f995`
- tarball `npm pack @fontsource/silkscreen@5.3.0` sha256 `c925ca04bd53cad84aca9f279f7e6aacb686322955a8a45f9c692338acc4e4bd`
