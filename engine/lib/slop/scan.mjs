// SloppaChoppa stage C (RM-45): text scanning shared by the rule kinds. Pure functions over one file's text: no git, no fs.
// classify() tells code from comment from string per character (a light JS lexer: comments, quotes, templates with ${},
// regex literals by the previous token), so a pattern can look at comments only, or at strings only, and a "quoted" span
// inside a comment or a string (a cited user message) is its own class that no rule reads unless it asks for it.
export const CODE = 0, COMMENT = 1, STRING = 2, QUOTE = 3;
export const CLASSES = { code: CODE, comment: COMMENT, string: STRING, quote: QUOTE };
export const isJs = f => /\.(?:mjs|cjs|js|jsx|ts|tsx|mts|cts)$/.test(f);

export const norm = s => String(s).replace(/\s+/g, ' ').trim();
export const lineAt = (text, i) => text.slice(0, i).split('\n').length;
export const lineText = (text, n) => (text.split('\n')[n - 1] ?? '');

// a `/` starts a regex literal after an operator, an opening bracket, a comma or one of these keywords (else it divides)
const REGEX_AFTER = /^(?:return|typeof|case|do|else|in|of|void|yield|await|delete|new|throw|instanceof)$/;
function regexStart(t, i) {
  let p = i - 1;
  while (p >= 0 && /\s/.test(t[p])) p--;
  if (p < 0 || '(,=:[!&|?{};+-*%<>~^'.includes(t[p])) return true;
  const w = /[\w$]+$/.exec(t.slice(Math.max(0, p - 12), p + 1));
  return !!w && REGEX_AFTER.test(w[0]);
}

/** one class per character (CODE, COMMENT, STRING, QUOTE); a string's quote marks and a template's ${ } are code */
export function classify(t) {
  const cls = new Uint8Array(t.length), tpl = [];
  const quoted = (a, b) => { for (const m of t.slice(a, b).matchAll(/"[^"\n]*"|“[^”\n]*”/g)) cls.fill(QUOTE, a + m.index, a + m.index + m[0].length); };
  let depth = 0;
  for (let i = 0; i < t.length;) {
    const ch = t[i], nx = t[i + 1];
    if (ch === '/' && nx === '/') { let e = t.indexOf('\n', i); if (e < 0) e = t.length; cls.fill(COMMENT, i, e); quoted(i, e); i = e; continue; }
    if (ch === '/' && nx === '*') { let e = t.indexOf('*/', i + 2); e = e < 0 ? t.length : e + 2; cls.fill(COMMENT, i, e); quoted(i, e); i = e; continue; }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < t.length && t[j] !== ch && t[j] !== '\n') j += t[j] === '\\' ? 2 : 1;
      cls.fill(STRING, i + 1, Math.min(j, t.length)); if (ch === "'") quoted(i + 1, j);
      i = j + 1; continue;
    }
    if (ch === '`' || (ch === '}' && tpl.length && tpl[tpl.length - 1] === depth)) {
      if (ch === '}') tpl.pop();
      let j = i + 1;
      while (j < t.length && t[j] !== '`' && !(t[j] === '$' && t[j + 1] === '{')) j += t[j] === '\\' ? 2 : 1;
      cls.fill(STRING, i + 1, Math.min(j, t.length)); quoted(i + 1, j);
      if (t[j] === '$') { tpl.push(depth); i = j + 2; } else i = j + 1;
      continue;
    }
    if (ch === '/' && regexStart(t, i)) {   // a regex literal stays code; skip it whole so its quotes open no string
      let j = i + 1, klass = false;
      for (; j < t.length && t[j] !== '\n' && (klass || t[j] !== '/'); j++) { if (t[j] === '\\') j++; else if (t[j] === '[') klass = true; else if (t[j] === ']') klass = false; }
      i = j + 1; continue;
    }
    if (ch === '{') depth++; else if (ch === '}') depth--;
    i++;
  }
  return cls;
}

/** the text with every character outside the wanted classes blanked (newlines kept: line numbers and offsets stay) */
export function masked(text, want, file = '') {
  if (!isJs(file)) return text;   // a doc or a data file is all prose
  const keep = new Set(want.map(w => CLASSES[w])), cls = classify(text);
  let out = '';
  for (let i = 0; i < text.length; i++) out += text[i] === '\n' || keep.has(cls[i]) ? text[i] : ' ';
  return out;
}

/** the TOML tables whose name passes keep (`tool.ruff`, `lints`), headers and bodies, joined; null = none */
export function tomlTables(text, keep) {
  let on = false; const out = [];
  for (const l of text.split(/\r?\n/)) { const h = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(l); if (h) on = keep(h[1]); if (on) out.push(l); }
  return out.length ? out.join('\n') : null;
}

/** K2's reason test: a comment explains when it has two words or more and does not start with a deny-list word */
export function isReason(comment, deny) {
  const why = norm(comment).toLowerCase().replace(/^[\s*:.-]+|[\s.!]+$/g, '');
  const denied = deny.map(d => d.toLowerCase()).some(d => why === d || why.startsWith(d + ' ') || why.startsWith(d + ',') || why.startsWith(d + ':'));
  return { why, ok: why.split(/\s+/).filter(Boolean).length >= 2 && !denied };
}
/** the comment text of a line range (1-based, inclusive) of a JS text */
export function commentsIn(text, from, to) {
  const lines = masked(text, ['comment', 'quote'], 'x.mjs').split('\n').slice(Math.max(0, from - 1), to);
  return norm(lines.join(' ').replace(/\/\/|\/\*|\*\//g, ' '));
}

// ---------- one-statement helpers (K9) and exports (K4) ----------
const canon = (params, body) => norm(`${params.trim().replace(/^\(\s*([\w$]+)\s*\)$/, '$1')} => ${body}`).replace(/;$/, '');
/** the top-level one-line, one-statement functions of a text: [{ name, body (normalised: `params => expr`), line }] */
export function helpers(text) {
  const out = [];
  for (const m of text.matchAll(/^(?:export\s+)?const\s+([\w$]+)\s*=\s*((?:async\s*)?(?:\([^)\n]*\)|[\w$]+))\s*=>\s*([^\n]{12,300}?);?\s*(?:\/\/.*)?$/gm))
    out.push({ name: m[1], body: canon(m[2], m[3]), line: lineAt(text, m.index) });
  for (const m of text.matchAll(/^(?:export\s+)?(async\s+)?function\s+([\w$]+)\s*(\([^)\n]*\))\s*\{\s*return\s+([^\n]+?);?\s*\}\s*(?:\/\/.*)?$/gm))
    out.push({ name: m[2], body: canon((m[1] ? 'async ' : '') + m[3], m[4]), line: lineAt(text, m.index) });
  return out;
}
/** the names a text exports by declaration: [{ name, line }] */
export const exportsOf = text => [...text.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([\w$]+)/gm)].map(m => ({ name: m[1], line: lineAt(text, m.index) }));
/** the uses of a name in a text, by word (a `$` in the name is literal) */
export const usesOf = (text, name) => (text.match(new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g')) || []).length;
