// JavaScript / TypeScript (SPEC code-graph 4.1). Sources: ESM import / export-from, import('literal'), require('literal') with
// the callee the identifier `require`. Resolution: a relative path with its extension is `exact` (Node's ESM rule); without one
// the extension probe and then /index.* is `probed` (a TS `./x.js` meaning x.ts too); `#name` through the nearest package.json
// `imports`, a workspace or self-referenced package name through its package.json, and tsconfig / jsconfig `paths` are `config`;
// any other bare name is `external`; a non-literal import() is unresolved/dynamic.
use super::{lc, matches, pos, text, Ctx, Lang, Out};
use crate::paths::{dirname, ext, glob, join};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use tree_sitter::{Language, Query, Tree};

pub struct Js;

const PROBE: [&str; 8] = ["ts", "tsx", "mts", "cts", "js", "mjs", "cjs", "jsx"];
/// the TS sources a JS-extension specifier may mean (TS's own rule: `./x.js` names x.ts after compilation)
const TS_FOR: [(&str, &[&str]); 4] = [
    ("js", &["ts", "tsx"]),
    ("mjs", &["mts"]),
    ("cjs", &["cts"]),
    ("jsx", &["tsx"]),
];
/// the package.json conditions read, in Node's order of the object (the first key of these that the object has wins)
const CONDITIONS: [&str; 5] = ["import", "require", "node", "module", "default"];

const QUERY: &str = r#"
(import_statement source: (string) @src) @imp
(export_statement source: (string) @src) @exp
(call_expression function: (import) arguments: (arguments) @args) @dyn
(call_expression function: (identifier) @fn arguments: (arguments . (string) @src) (#eq? @fn "require")) @req
"#;

fn literal(s: &str) -> Option<String> {
    let b = s.as_bytes();
    if b.len() >= 2
        && (b[0] == b'\'' || b[0] == b'"' || (b[0] == b'`' && !s.contains("${")))
        && b[b.len() - 1] == b[0]
    {
        Some(s[1..s.len() - 1].to_string())
    } else {
        None
    }
}

impl Lang for Js {
    fn name(&self) -> &'static str {
        "js"
    }
    fn exts(&self) -> &'static [&'static str] {
        &["js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx"]
    }
    fn grammar(&self, ext: &str) -> (&'static str, Language) {
        match ext {
            "ts" | "mts" | "cts" => ("ts", tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
            "tsx" => ("tsx", tree_sitter_typescript::LANGUAGE_TSX.into()),
            _ => ("js", tree_sitter_javascript::LANGUAGE.into()),
        }
    }
    fn import_query(&self) -> &'static str {
        QUERY
    }
    fn extract(&self, q: &Query, tree: &Tree, src: &[u8]) -> Map<String, Value> {
        let mut imports = vec![];
        for (pat, caps) in matches(q, tree, src) {
            let node = caps
                .iter()
                .find(|(n, _)| matches!(*n, "imp" | "exp" | "dyn" | "req"))
                .map(|c| c.1);
            let Some(node) = node else { continue };
            let (line, col) = pos(node);
            let head = text(node, src);
            let typed = head.starts_with("import type") || head.starts_with("export type");
            let (kind, spec) = match pat {
                0 => (
                    if typed { "type" } else { "import" },
                    caps.iter()
                        .find(|c| c.0 == "src")
                        .and_then(|c| literal(text(c.1, src))),
                ),
                1 => (
                    if typed { "type" } else { "reexport" },
                    caps.iter()
                        .find(|c| c.0 == "src")
                        .and_then(|c| literal(text(c.1, src))),
                ),
                2 => (
                    "dynamic",
                    caps.iter()
                        .find(|c| c.0 == "args")
                        .and_then(|c| c.1.named_child(0))
                        .and_then(|a| literal(text(a, src))),
                ),
                _ => (
                    "require",
                    caps.iter()
                        .find(|c| c.0 == "src")
                        .and_then(|c| literal(text(c.1, src))),
                ),
            };
            if pat != 2 && spec.is_none() {
                continue;
            }
            let raw = if pat == 2 && spec.is_none() {
                clip_text(text(node, src))
            } else {
                String::new()
            };
            imports
                .push(json!({ "kind": kind, "spec": spec, "raw": raw, "line": line, "col": col }));
        }
        Map::from_iter([("imports".to_string(), Value::Array(imports))])
    }
    fn resolve(&self, ctx: &Ctx, out: &mut Out) {
        let r = Resolver::new(ctx);
        for (from, facts) in ctx.sources("js") {
            for i in facts["imports"].as_array().into_iter().flatten() {
                let (line, col) = lc(i);
                let kind = i["kind"].as_str().unwrap_or("import");
                let Some(spec) = i["spec"].as_str() else {
                    out.missing(from, line, kind, i["raw"].as_str().unwrap_or(""), "dynamic");
                    continue;
                };
                match r.resolve(from, spec) {
                    Res::Hit(how, hits) => out.edge(
                        from,
                        &hits[0],
                        line,
                        col,
                        kind,
                        if hits.len() > 1 { "ambiguous" } else { how },
                        spec,
                        &hits[1..],
                    ),
                    Res::External(p) => out.external(from, line, kind, spec, &p),
                    Res::Missing => out.missing(from, line, kind, spec, "missing"),
                }
            }
        }
    }
}

fn clip_text(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

enum Res {
    Hit(&'static str, Vec<String>),
    External(String),
    Missing,
}

/// JSONC (tsconfig): comments and trailing commas out, strings kept
fn jsonc(s: &str) -> Option<Value> {
    let (b, mut o, mut i) = (s.as_bytes(), Vec::with_capacity(s.len()), 0);
    while i < b.len() {
        match b[i] {
            b'"' => {
                let st = i;
                i += 1;
                while i < b.len() && b[i] != b'"' {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
                i = (i + 1).min(b.len());
                o.extend_from_slice(&b[st..i]);
                continue;
            }
            b'/' if b.get(i + 1) == Some(&b'/') => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
                continue;
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                    i += 1;
                }
                i += 2;
                continue;
            }
            b',' => {
                let mut j = i + 1;
                while j < b.len() && b[j].is_ascii_whitespace() {
                    j += 1;
                }
                if j < b.len() && (b[j] == b'}' || b[j] == b']') {
                    i += 1;
                    continue;
                }
            }
            _ => {}
        }
        o.push(b[i]);
        i += 1;
    }
    serde_json::from_slice(&o).ok()
}

/// match a package.json / tsconfig key with at most one `*` -> the text the star took
fn star(key: &str, s: &str) -> Option<String> {
    match key.split_once('*') {
        None => (key == s).then(String::new),
        Some((a, b)) => (s.len() >= a.len() + b.len() && s.starts_with(a) && s.ends_with(b))
            .then(|| s[a.len()..s.len() - b.len()].to_string()),
    }
}
/// a conditions value -> its target string
fn pick(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Array(a) => a.iter().find_map(pick),
        Value::Object(o) => o
            .iter()
            .find(|(k, _)| CONDITIONS.contains(&k.as_str()))
            .and_then(|(_, v)| pick(v)),
        _ => None,
    }
}
/// a subpath map (package.json imports / exports): exact key first, then the longest star key
fn lookup(map: &Map<String, Value>, s: &str) -> Option<String> {
    if let Some(v) = map.get(s) {
        return pick(v);
    }
    let mut best: Option<(&String, String)> = None;
    for k in map.keys().filter(|k| k.contains('*')) {
        if let Some(t) = star(k, s) {
            if best.as_ref().is_none_or(|(b, _)| k.len() > b.len()) {
                best = Some((k, t));
            }
        }
    }
    let (k, t) = best?;
    pick(&map[k]).map(|v| v.replace('*', &t))
}

struct Resolver<'a> {
    ctx: &'a Ctx<'a>,
    pkgs: HashMap<String, Value>,
    tsconfigs: HashMap<String, Value>,
    /// package name -> dir, for the workspace members and every package's own name (self-reference)
    names: HashMap<String, String>,
}

impl<'a> Resolver<'a> {
    fn new(ctx: &'a Ctx<'a>) -> Resolver<'a> {
        let pkgs: HashMap<String, Value> = ctx
            .manifests("package.json")
            .into_iter()
            .filter_map(|(p, t)| Some((dirname(p).to_string(), serde_json::from_str(t).ok()?)))
            .collect();
        let mut tsconfigs = HashMap::new();
        for n in ["jsconfig.json", "tsconfig.json"] {
            for (p, t) in ctx.manifests(n) {
                if let Some(v) = jsonc(t) {
                    tsconfigs.insert(dirname(p).to_string(), v);
                }
            }
        }
        let mut names = HashMap::new();
        let mut dirs: Vec<&String> = pkgs.keys().collect();
        dirs.sort();
        for root in &dirs {
            let ws = &pkgs[*root]["workspaces"];
            let globs: Vec<&str> = ws
                .as_array()
                .or(ws["packages"].as_array())
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            for d in &dirs {
                let rel = if root.is_empty() {
                    d.as_str()
                } else {
                    d.strip_prefix(&format!("{root}/")).unwrap_or("")
                };
                if !rel.is_empty()
                    && globs
                        .iter()
                        .any(|g| glob(g.trim_start_matches("./").trim_end_matches('/'), rel))
                {
                    if let Some(n) = pkgs[*d]["name"].as_str() {
                        names.entry(n.to_string()).or_insert(d.to_string());
                    }
                }
            }
        }
        Resolver {
            ctx,
            pkgs,
            tsconfigs,
            names,
        }
    }

    /// the nearest dir at or above `d` holding an entry of `m`
    fn nearest<'m, T>(m: &'m HashMap<String, T>, mut d: &str) -> Option<(&'m String, &'m T)> {
        loop {
            if let Some(kv) = m.get_key_value(d) {
                return Some(kv);
            }
            if d.is_empty() {
                return None;
            }
            d = dirname(d);
        }
    }

    /// a path the way Node + TS probe it -> (how, hits)
    fn probe(&self, p: &str) -> Option<(&'static str, Vec<String>)> {
        if self.ctx.is_file(p) {
            return Some(("exact", vec![p.to_string()]));
        }
        if let Some((_, ts)) = TS_FOR.iter().find(|(e, _)| *e == ext(p)) {
            let stem = &p[..p.len() - ext(p).len() - 1];
            let hits: Vec<String> = ts
                .iter()
                .map(|e| format!("{stem}.{e}"))
                .filter(|c| self.ctx.is_file(c))
                .collect();
            if !hits.is_empty() {
                return Some(("probed", hits));
            }
        }
        let hits: Vec<String> = PROBE
            .iter()
            .map(|e| format!("{p}.{e}"))
            .filter(|c| self.ctx.is_file(c))
            .collect();
        if !hits.is_empty() {
            return Some(("probed", hits));
        }
        let idx = join(p, "index").unwrap_or_default();
        let hits: Vec<String> = PROBE
            .iter()
            .map(|e| format!("{idx}.{e}"))
            .filter(|c| self.ctx.is_file(c))
            .collect();
        (!hits.is_empty()).then_some(("probed", hits))
    }
    fn config(&self, p: Option<String>) -> Res {
        match p.and_then(|p| self.probe(&p)) {
            Some((_, hits)) => Res::Hit("config", hits),
            None => Res::Missing,
        }
    }

    /// a package dir + subpath ("." or "./x") through its exports, else main / the file itself
    fn package(&self, dir: &str, sub: &str) -> Res {
        let pj = &self.pkgs[dir];
        let target = match &pj["exports"] {
            Value::Null => match sub {
                "." => Some(pj["main"].as_str().unwrap_or("index").to_string()),
                s => Some(s.to_string()),
            },
            Value::Object(o) if o.keys().any(|k| k.starts_with('.')) => lookup(o, sub),
            v if sub == "." => pick(v),
            _ => None,
        };
        self.config(target.and_then(|t| join(dir, &t)))
    }

    fn resolve(&self, from: &str, spec: &str) -> Res {
        let dir = dirname(from);
        if spec.starts_with("./") || spec.starts_with("../") || spec == "." || spec == ".." {
            return match join(dir, spec).and_then(|p| self.probe(&p)) {
                Some((how, hits)) => Res::Hit(how, hits),
                None => Res::Missing,
            };
        }
        if spec.starts_with('#') {
            let Some((d, pj)) = Self::nearest(&self.pkgs, dir) else {
                return Res::Missing;
            };
            return self.config(
                pj["imports"]
                    .as_object()
                    .and_then(|m| lookup(m, spec))
                    .and_then(|t| join(d, &t)),
            );
        }
        let bare = spec.strip_prefix("node:").unwrap_or(spec);
        let mut segs = bare.splitn(if bare.starts_with('@') { 3 } else { 2 }, '/');
        let name = if bare.starts_with('@') {
            format!(
                "{}/{}",
                segs.next().unwrap_or(""),
                segs.next().unwrap_or("")
            )
        } else {
            segs.next().unwrap_or("").to_string()
        };
        let sub = segs.next().map_or(".".to_string(), |s| format!("./{s}"));
        let own = Self::nearest(&self.pkgs, dir)
            .filter(|(_, pj)| pj["name"].as_str() == Some(&name))
            .map(|(d, _)| d.clone());
        if let Some(d) = own.or_else(|| self.names.get(&name).cloned()) {
            return self.package(&d, &sub);
        }
        if let Some((d, ts)) = Self::nearest(&self.tsconfigs, dir) {
            let co = &ts["compilerOptions"];
            let base = co["baseUrl"]
                .as_str()
                .and_then(|b| join(d, b))
                .unwrap_or(d.clone());
            if let Some(paths) = co["paths"].as_object() {
                for (k, v) in paths {
                    if let Some(t) = star(k, spec) {
                        for tgt in v.as_array().into_iter().flatten().filter_map(Value::as_str) {
                            if let Some((_, hits)) =
                                join(&base, &tgt.replace('*', &t)).and_then(|p| self.probe(&p))
                            {
                                return Res::Hit("config", hits);
                            }
                        }
                    }
                }
            }
            if co["baseUrl"].is_string() {
                if let Some((_, hits)) = join(&base, spec).and_then(|p| self.probe(&p)) {
                    return Res::Hit("config", hits);
                }
            }
        }
        Res::External(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn jsonc_and_stars() {
        assert_eq!(
            jsonc("{ // c\n \"a\": [1, 2,], /* x */ \"b\": \"//no\", }").unwrap(),
            json!({ "a": [1, 2], "b": "//no" })
        );
        assert_eq!(star("#lib/*", "#lib/x/y").as_deref(), Some("x/y"));
        let m =
            json!({ "#a": { "import": "./a.mjs", "default": "./a.cjs" }, "#lib/*": "./lib/*.js" });
        assert_eq!(
            lookup(m.as_object().unwrap(), "#a").as_deref(),
            Some("./a.mjs")
        );
        assert_eq!(
            lookup(m.as_object().unwrap(), "#lib/q").as_deref(),
            Some("./lib/q.js")
        );
    }
}
