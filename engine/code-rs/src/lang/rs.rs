// Rust (SPEC code-graph 4.1, plus DEC-a-576: literal include! / include_str! / include_bytes! are `embed` edges to a plain file).
// Crates come from every Cargo.toml: package and lib names, `package =` renames, path and workspace dependencies, and the targets
// (src/lib.rs, src/main.rs, src/bin/*, tests/, examples/, benches/, build.rs, explicit `path =`). The mod tree runs from each
// target root (`mod x;` -> x.rs | x/mod.rs, nested inline mods, `#[path]`: `exact`; a `cfg` is kept as text, never evaluated);
// every reached file gets { crate, module }, a file no target reaches is an orphan. `use` trees are expanded; the longest module
// prefix gives the file (`exact` when the whole path is a module, `probed` when the tail names items); a dependency's lib name
// reaches that crate (`config`); anything else is `external`. Limits: modules that macros generate are invisible.
use super::{lc, matches, pos, text, Ctx, Lang, Out};
use crate::paths::{basename, dirname, join};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use tree_sitter::{Language, Node, Query, Tree};

pub struct Rs;

const QUERY: &str = r#"
(mod_item) @mod
(use_declaration) @use
(extern_crate_declaration) @ext
(function_item) @fn
(macro_invocation macro: (identifier) @m (#match? @m "^include(_str|_bytes)?$")) @inc
"#;
/// our definition patterns (SPEC 4.2): impl blocks, const / static items, trait method signatures
const DEFS: &str = r#"
(impl_item) @definition.impl
(const_item name: (identifier) @name) @definition.constant
(static_item name: (identifier) @name) @definition.constant
(function_signature_item name: (identifier) @name) @definition.method
"#;
const DEP_TABLES: [&str; 3] = ["dependencies", "dev-dependencies", "build-dependencies"];

/// the attribute items right before an item
fn attrs<'s>(n: Node, src: &'s [u8]) -> Vec<&'s str> {
    let mut v = vec![];
    let mut p = n.prev_sibling();
    while let Some(a) = p {
        match a.kind() {
            "attribute_item" => v.push(text(a, src)),
            "line_comment" | "block_comment" => {}
            _ => break,
        }
        p = a.prev_sibling();
    }
    v
}
/// the inline `mod a { ... }` blocks around a node, outermost first
fn inline_path(n: Node, src: &[u8]) -> Vec<String> {
    let mut v = vec![];
    let mut p = n.parent();
    while let Some(x) = p {
        if x.kind() == "mod_item" {
            if let Some(nm) = x.child_by_field_name("name") {
                v.push(text(nm, src).to_string());
            }
        }
        p = x.parent();
    }
    v.reverse();
    v
}
fn unquote(s: &str) -> Option<String> {
    let s = s.trim();
    let s = s
        .strip_prefix('r')
        .map(|r| r.trim_matches('#'))
        .unwrap_or(s);
    (s.len() >= 2 && s.starts_with('"') && s.ends_with('"')).then(|| s[1..s.len() - 1].to_string())
}
/// `#[path = "x"]`
fn path_attr(a: &[&str]) -> Option<String> {
    a.iter().find_map(|t| {
        let t = t.trim_start_matches("#[").trim_end_matches(']').trim();
        let v = t.strip_prefix("path")?.trim_start().strip_prefix('=')?;
        unquote(v)
    })
}

/// a use tree's text -> its full paths: groups and `self` expanded, `as` renames dropped
pub fn expand(s: &str) -> Vec<String> {
    let s: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let s = s
        .replace(" ::", "::")
        .replace(":: ", "::")
        .replace("{ ", "{")
        .replace(" }", "}");
    fn go(s: &str) -> Vec<String> {
        let s = s.trim();
        let Some(i) = s.find('{') else {
            return vec![s.split(" as ").next().unwrap_or(s).trim().to_string()];
        };
        let prefix = s[..i].trim_end_matches("::");
        let inner = &s[i + 1..s.rfind('}').unwrap_or(s.len())];
        let (mut parts, mut depth, mut st) = (vec![], 0, 0);
        for (j, c) in inner.char_indices() {
            match c {
                '{' => depth += 1,
                '}' => depth -= 1,
                ',' if depth == 0 => {
                    parts.push(&inner[st..j]);
                    st = j + 1;
                }
                _ => {}
            }
        }
        parts.push(&inner[st..]);
        let mut out = vec![];
        for p in parts.into_iter().map(str::trim).filter(|p| !p.is_empty()) {
            for x in go(p) {
                out.push(match (prefix.is_empty(), x.as_str()) {
                    (true, _) => x,
                    (false, "self") => prefix.to_string(),
                    _ => format!("{prefix}::{x}"),
                });
            }
        }
        out
    }
    go(&s)
}

impl Lang for Rs {
    fn name(&self) -> &'static str {
        "rs"
    }
    fn exts(&self) -> &'static [&'static str] {
        &["rs"]
    }
    fn grammar(&self, _: &str) -> (&'static str, Language) {
        ("rs", tree_sitter_rust::LANGUAGE.into())
    }
    fn import_query(&self) -> &'static str {
        QUERY
    }
    fn tags(&self, _: &str) -> String {
        format!(
            "{}
{DEFS}",
            tree_sitter_rust::TAGS_QUERY
        )
    }
    fn extract(&self, q: &Query, tree: &Tree, src: &[u8]) -> Map<String, Value> {
        let (mut imports, mut pymodules) = (vec![], vec![]);
        for (pat, caps) in matches(q, tree, src) {
            let n = caps.iter().find(|c| c.0 != "m").map_or(caps[0].1, |c| c.1);
            let (line, col) = pos(n);
            let name = n
                .child_by_field_name("name")
                .map(|x| text(x, src).to_string());
            match pat {
                0 => {
                    let a = attrs(n, src);
                    if a.iter().any(|t| t.contains("pymodule")) {
                        pymodules.extend(name.clone());
                    }
                    let cfg = a.iter().find(|t| t.starts_with("#[cfg")).map(|t| t.to_string());
                    imports.push(json!({ "kind": "mod", "name": name, "inline": inline_path(n, src), "body": n.child_by_field_name("body").is_some(),
                        "path": path_attr(&a), "cfg": cfg, "line": line, "col": col }));
                }
                1 => {
                    let arg = n.child_by_field_name("argument").map_or("", |a| text(a, src));
                    imports.push(json!({ "kind": "use", "paths": expand(arg), "inline": inline_path(n, src), "line": line, "col": col }));
                }
                2 => imports.push(json!({ "kind": "extern-crate", "name": name, "inline": inline_path(n, src), "line": line, "col": col })),
                3 => {
                    if attrs(n, src).iter().any(|t| t.contains("pymodule")) {
                        pymodules.extend(name);
                    }
                }
                _ => {
                    let tt = n.named_children(&mut n.walk()).find(|c| c.kind() == "token_tree");
                    let lits: Vec<Node> = tt.map(|t| t.named_children(&mut t.walk()).collect()).unwrap_or_default();
                    let path = match lits.as_slice() {
                        [l] if l.kind() == "string_literal" || l.kind() == "raw_string_literal" => unquote(text(*l, src)),
                        _ => None,
                    };
                    imports.push(json!({ "kind": "embed", "path": path, "raw": text(n, src).split_whitespace().collect::<Vec<_>>().join(" "), "line": line, "col": col }));
                }
            }
        }
        Map::from_iter([
            ("imports".to_string(), Value::Array(imports)),
            ("pymodules".to_string(), json!(pymodules)),
        ])
    }
    fn resolve(&self, ctx: &Ctx, out: &mut Out) {
        Resolver::new(ctx).run(out);
    }
}

struct Pkg {
    manifest: String,
    dir: String,
    name: String,
    lib_name: String,
    lib: Option<String>,
    /// target root files, the lib first
    targets: Vec<String>,
    /// the name code uses -> the dependency's manifest (path and workspace deps)
    deps: HashMap<String, String>,
}

struct Resolver<'a> {
    ctx: &'a Ctx<'a>,
    pkgs: Vec<Pkg>,
    by_manifest: HashMap<String, usize>,
    /// target root -> (module path -> file)
    trees: HashMap<String, HashMap<String, String>>,
    /// file -> (package, target root, module path)
    home: HashMap<String, (usize, String, String)>,
}

fn table<'t>(t: &'t toml::Table, k: &str) -> Option<&'t toml::Table> {
    t.get(k).and_then(|v| v.as_table())
}
/// the line a dependency key sits on in its Cargo.toml
fn dep_line(text: &str, key: &str) -> usize {
    text.lines()
        .position(|l| {
            let l = l.trim();
            l.strip_prefix(key)
                .is_some_and(|r| r.trim_start().starts_with('=') || r.starts_with('.'))
                || (l.starts_with('[') && l.trim_end_matches(']').ends_with(&format!(".{key}")))
        })
        .map_or(1, |i| i + 1)
}

impl<'a> Resolver<'a> {
    fn new(ctx: &'a Ctx<'a>) -> Resolver<'a> {
        let manifests: Vec<(&String, toml::Table)> = ctx
            .manifests("Cargo.toml")
            .into_iter()
            .filter_map(|(p, t)| Some((p, t.parse::<toml::Table>().ok()?)))
            .collect();
        let mut pkgs = vec![];
        for (m, t) in &manifests {
            let Some(pk) = table(t, "package") else {
                continue;
            };
            let d = dirname(m).to_string();
            let name = pk
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let lt = table(t, "lib");
            let lib_name = lt
                .and_then(|l| l.get("name"))
                .and_then(|v| v.as_str())
                .map_or(name.replace('-', "_"), str::to_string);
            let f = |rel: &str| join(&d, rel).filter(|p| ctx.is_file(p));
            let lib = f(lt
                .and_then(|l| l.get("path"))
                .and_then(|v| v.as_str())
                .unwrap_or("src/lib.rs"));
            let mut targets: Vec<String> = lib.iter().cloned().collect();
            for k in ["bin", "test", "example", "bench"] {
                for x in t.get(k).and_then(|v| v.as_array()).into_iter().flatten() {
                    targets.extend(x.get("path").and_then(|p| p.as_str()).and_then(f));
                }
            }
            let mut auto: Vec<String> = ctx
                .files
                .keys()
                .filter(|p| {
                    let Some(rel) = p
                        .strip_prefix(&if d.is_empty() {
                            String::new()
                        } else {
                            format!("{d}/")
                        })
                        .map(str::to_string)
                    else {
                        return false;
                    };
                    let segs: Vec<&str> = rel.split('/').collect();
                    rel.ends_with(".rs")
                        && matches!(
                            segs.as_slice(),
                            ["src", "main.rs"]
                                | ["build.rs"]
                                | ["src", "bin", _]
                                | ["tests", _]
                                | ["examples", _]
                                | ["benches", _]
                                | ["src", "bin", _, "main.rs"]
                                | ["examples", _, "main.rs"]
                        )
                })
                .cloned()
                .collect();
            auto.sort();
            if let Some(b) = pk.get("build").and_then(|v| v.as_str()).and_then(f) {
                auto.push(b);
            }
            for a in auto {
                if !targets.contains(&a) {
                    targets.push(a);
                }
            }
            pkgs.push(Pkg {
                manifest: m.to_string(),
                dir: d,
                name,
                lib_name,
                lib,
                targets,
                deps: HashMap::new(),
            });
        }
        let by_manifest: HashMap<String, usize> = pkgs
            .iter()
            .enumerate()
            .map(|(i, p)| (p.manifest.clone(), i))
            .collect();
        let mut r = Resolver {
            ctx,
            pkgs,
            by_manifest,
            trees: HashMap::new(),
            home: HashMap::new(),
        };
        r.deps(&manifests);
        r
    }

    /// path and workspace dependencies of each package, by the name its code uses
    fn deps(&mut self, manifests: &[(&String, toml::Table)]) {
        let ws_roots: Vec<(String, &toml::Table)> = manifests
            .iter()
            .filter_map(|(m, t)| table(t, "workspace").map(|w| (dirname(m).to_string(), w)))
            .collect();
        for (m, t) in manifests {
            let Some(&i) = self.by_manifest.get(*m) else {
                continue;
            };
            let d = dirname(m).to_string();
            let ws = ws_roots
                .iter()
                .filter(|(w, _)| crate::paths::under(&d, w))
                .max_by_key(|(w, _)| w.len());
            let mut tables: Vec<&toml::Table> =
                DEP_TABLES.iter().filter_map(|k| table(t, k)).collect();
            for tg in table(t, "target")
                .into_iter()
                .flat_map(|x| x.values())
                .filter_map(|v| v.as_table())
            {
                tables.extend(DEP_TABLES.iter().filter_map(|k| table(tg, k)));
            }
            for tb in tables {
                for (k, v) in tb {
                    let code = k.replace('-', "_");
                    let path = match v.get("path").and_then(|p| p.as_str()) {
                        Some(p) => join(&d, p),
                        None if v.get("workspace").and_then(|w| w.as_bool()) == Some(true) => ws
                            .and_then(|(wd, w)| {
                                let wdep = table(w, "dependencies")?.get(k)?;
                                join(wd, wdep.get("path")?.as_str()?)
                            }),
                        None => None,
                    };
                    if let Some(dm) = path
                        .and_then(|p| join(&p, "Cargo.toml"))
                        .filter(|dm| self.by_manifest.contains_key(dm))
                    {
                        let lib_name = self.pkgs[self.by_manifest[&dm]].lib_name.clone();
                        // a `package =` rename: the code uses the key; an unrenamed dep is used by its lib name
                        let code = if v.get("package").is_some() {
                            code
                        } else {
                            lib_name
                        };
                        self.pkgs[i].deps.insert(code, dm);
                    }
                }
            }
        }
    }

    fn cargo_edges(&self, out: &mut Out) {
        for (m, t) in self.ctx.manifests("Cargo.toml") {
            let Ok(tb) = t.parse::<toml::Table>() else {
                continue;
            };
            let d = dirname(m);
            let mut tables: Vec<&toml::Table> =
                DEP_TABLES.iter().filter_map(|k| table(&tb, k)).collect();
            for tg in table(&tb, "target")
                .into_iter()
                .flat_map(|x| x.values())
                .filter_map(|v| v.as_table())
            {
                tables.extend(DEP_TABLES.iter().filter_map(|k| table(tg, k)));
            }
            for (k, v) in tables.into_iter().flatten() {
                let line = dep_line(t, k);
                let target = v
                    .get("path")
                    .and_then(|p| p.as_str())
                    .and_then(|p| join(d, p))
                    .and_then(|p| join(&p, "Cargo.toml"));
                match target {
                    Some(tm) if self.ctx.is_file(&tm) => {
                        out.edge(m, &tm, line, 1, "cargo-dep", "config", k, &[])
                    }
                    Some(_) => out.missing(m, line, "cargo-dep", k, "missing"),
                    None if v.get("workspace").and_then(|w| w.as_bool()) == Some(true) => {
                        match self.by_manifest.get(m.as_str()).and_then(|&i| {
                            self.pkgs[i].deps.values().find(|dm| {
                                self.pkgs[self.by_manifest[*dm]].name == *k
                                    || basename(dirname(dm)) == k
                            })
                        }) {
                            Some(dm) => out.edge(m, dm, line, 1, "cargo-dep", "config", k, &[]),
                            None => out.external(
                                m,
                                line,
                                "cargo-dep",
                                k,
                                v.get("package").and_then(|p| p.as_str()).unwrap_or(k),
                            ),
                        }
                    }
                    None => out.external(
                        m,
                        line,
                        "cargo-dep",
                        k,
                        v.get("package").and_then(|p| p.as_str()).unwrap_or(k),
                    ),
                }
            }
        }
    }

    /// the folder a file's out-of-line child modules live in
    fn child_dir(f: &str, mod_rs: bool) -> String {
        if mod_rs {
            dirname(f).to_string()
        } else {
            join(dirname(f), basename(f).trim_end_matches(".rs")).unwrap_or_default()
        }
    }

    /// one `mod` item of file `f` -> Some((child file, how)) | None (missing); inline modules give no file
    fn child(&self, f: &str, mod_rs: bool, i: &Value) -> Result<(String, &'static str), ()> {
        let inline: Vec<&str> = i["inline"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        let name = i["name"].as_str().unwrap_or("");
        let base = join(&Self::child_dir(f, mod_rs), &inline.join("/")).unwrap_or_default();
        if let Some(p) = i["path"].as_str() {
            let t = if inline.is_empty() {
                join(dirname(f), p)
            } else {
                join(&base, p)
            };
            return t
                .filter(|t| self.ctx.is_file(t))
                .map(|t| (t, "exact"))
                .ok_or(());
        }
        let c: Vec<String> = [format!("{name}.rs"), format!("{name}/mod.rs")]
            .iter()
            .filter_map(|c| join(&base, c))
            .filter(|c| self.ctx.is_file(c))
            .collect();
        match c.len() {
            0 => Err(()),
            1 => Ok((c[0].clone(), "exact")),
            _ => Ok((c[0].clone(), "ambiguous")),
        }
    }

    fn facts(&self, f: &str) -> Vec<&'a Value> {
        self.ctx
            .facts
            .get(f)
            .and_then(|x| x["imports"].as_array())
            .map(|a| a.iter().collect())
            .unwrap_or_default()
    }

    /// walk every target's mod tree: mod edges, the module maps, each reached file's home
    fn walk(&mut self, out: &mut Out) {
        for pi in 0..self.pkgs.len() {
            for root in self.pkgs[pi].targets.clone() {
                let mut tree = HashMap::new();
                let mut q = VecDeque::from([(root.clone(), "crate".to_string(), true)]);
                let mut seen = HashSet::new();
                while let Some((f, m, mod_rs)) = q.pop_front() {
                    if !seen.insert(f.clone()) || !self.ctx.facts.contains_key(&f) {
                        continue;
                    }
                    tree.insert(m.clone(), f.clone());
                    self.home
                        .entry(f.clone())
                        .or_insert((pi, root.clone(), m.clone()));
                    for i in self.facts(&f).into_iter().filter(|i| i["kind"] == "mod") {
                        let inline: Vec<&str> = i["inline"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .collect();
                        let name = i["name"].as_str().unwrap_or("");
                        let mp = [m.as_str()]
                            .into_iter()
                            .chain(inline.iter().copied())
                            .chain([name])
                            .collect::<Vec<_>>()
                            .join("::");
                        if i["body"] == json!(true) {
                            tree.insert(mp, f.clone());
                            continue;
                        }
                        let (line, col) = lc(i);
                        match self.child(&f, mod_rs, i) {
                            Ok((c, how)) => {
                                out.edge(
                                    &f,
                                    &c,
                                    line,
                                    col,
                                    "mod",
                                    how,
                                    &format!("mod {name}"),
                                    &[],
                                );
                                if let (Some(cfg), Some(e)) =
                                    (i["cfg"].as_str(), out.edges.last_mut())
                                {
                                    if e["to"] == json!(c) && e["from"] == json!(f) {
                                        e["cfg"] = json!(cfg);
                                    }
                                }
                                let child_mod_rs =
                                    basename(&c) == "mod.rs" || i["path"].is_string();
                                q.push_back((c, mp, child_mod_rs));
                            }
                            Err(()) => {
                                out.missing(&f, line, "mod", &format!("mod {name}"), "missing")
                            }
                        }
                    }
                }
                self.trees.insert(root, tree);
            }
        }
    }

    /// a use path in file `f` -> Ok((file, how)) | Err(Some(package)) external | Err(None) missing
    fn use_target(
        &self,
        f: &str,
        path: &str,
        inline: &[&str],
    ) -> Result<(String, &'static str), Option<String>> {
        let home = self.home.get(f);
        let mut segs: Vec<&str> = path.split("::").filter(|s| !s.is_empty()).collect();
        if segs.last() == Some(&"*") {
            segs.pop();
        }
        let Some(&first) = segs.first() else {
            return Err(None);
        };
        let pkg = home.map(|h| h.0).or_else(|| {
            self.pkgs
                .iter()
                .enumerate()
                .filter(|(_, p)| crate::paths::under(f, &p.dir))
                .max_by_key(|(_, p)| p.dir.len())
                .map(|(i, _)| i)
        });
        let here = home.map(|h| {
            [h.2.as_str()]
                .into_iter()
                .chain(inline.iter().copied())
                .collect::<Vec<_>>()
                .join("::")
        });
        let (tree_root, base, rest, cross): (Option<String>, Vec<String>, &[&str], bool) =
            match first {
                "crate" => (
                    home.map(|h| h.1.clone()),
                    vec!["crate".into()],
                    &segs[1..],
                    false,
                ),
                "self" | "super" => {
                    let Some(here) = &here else { return Err(None) };
                    let mut b: Vec<String> = here.split("::").map(str::to_string).collect();
                    let mut k = 0;
                    while segs.get(k) == Some(&"super") {
                        if b.len() <= 1 {
                            return Err(None);
                        }
                        b.pop();
                        k += 1;
                    }
                    if k == 0 {
                        k = 1;
                    }
                    (home.map(|h| h.1.clone()), b, &segs[k..], false)
                }
                "Self" => return Err(None),
                n => {
                    let dep = pkg.and_then(|p| {
                        let pk = &self.pkgs[p];
                        let d = pk.deps.get(n).map(|m| &self.pkgs[self.by_manifest[m]]);
                        let own = (pk.lib_name == n
                            && home.is_some_and(|h| Some(&h.1) != pk.lib.as_ref()))
                        .then_some(pk);
                        d.or(own).and_then(|d| d.lib.clone())
                    });
                    if let Some(lib) = dep {
                        (Some(lib), vec!["crate".into()], &segs[1..], true)
                    } else if let (Some(h), Some(here)) = (home, &here) {
                        if self
                            .trees
                            .get(&h.1)
                            .is_some_and(|t| t.contains_key(&format!("{here}::{n}")))
                        {
                            (
                                Some(h.1.clone()),
                                here.split("::").map(str::to_string).collect(),
                                &segs[..],
                                false,
                            )
                        } else {
                            return Err(Some(n.to_string()));
                        }
                    } else {
                        return Err(Some(n.to_string()));
                    }
                }
            };
        let tree = tree_root.and_then(|r| self.trees.get(&r)).ok_or(None)?;
        for k in (0..=rest.len()).rev() {
            let key = base
                .iter()
                .map(String::as_str)
                .chain(rest[..k].iter().copied())
                .collect::<Vec<_>>()
                .join("::");
            if let Some(file) = tree.get(&key) {
                return Ok((
                    file.clone(),
                    if cross {
                        "config"
                    } else if k == rest.len() {
                        "exact"
                    } else {
                        "probed"
                    },
                ));
            }
        }
        Err(None)
    }

    fn run(mut self, out: &mut Out) {
        self.cargo_edges(out);
        self.walk(out);
        for (f, _) in self.ctx.sources("rs") {
            match self.home.get(f) {
                Some((pi, root, m)) => {
                    let info = out.info.entry(f.clone()).or_default();
                    info.insert("crate".into(), json!(self.pkgs[*pi].name));
                    info.insert("module".into(), json!(m));
                    info.insert("target".into(), json!(root));
                }
                None => {
                    out.info
                        .entry(f.clone())
                        .or_default()
                        .insert("orphan".into(), json!(true));
                }
            }
            for i in self.facts(f) {
                let (line, col) = lc(i);
                let inline: Vec<&str> = i["inline"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect();
                match i["kind"].as_str() {
                    Some("use") => {
                        for p in i["paths"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                        {
                            match self.use_target(f, p, &inline) {
                                Ok((to, how)) => out.edge(f, &to, line, col, "use", how, p, &[]),
                                Err(Some(pk)) => out.external(f, line, "use", p, &pk),
                                Err(None) => out.missing(f, line, "use", p, "missing"),
                            }
                        }
                    }
                    Some("extern-crate") => {
                        let n = i["name"].as_str().unwrap_or("");
                        match self.use_target(f, n, &[]) {
                            Ok((to, _)) => out.edge(
                                f,
                                &to,
                                line,
                                col,
                                "extern-crate",
                                "config",
                                &format!("extern crate {n}"),
                                &[],
                            ),
                            Err(_) => out.external(
                                f,
                                line,
                                "extern-crate",
                                &format!("extern crate {n}"),
                                n,
                            ),
                        }
                    }
                    Some("embed") => match i["path"].as_str() {
                        Some(p) => match join(dirname(f), p).filter(|t| self.ctx.is_file(t)) {
                            Some(t) => out.edge(f, &t, line, col, "embed", "exact", p, &[]),
                            None => out.missing(f, line, "embed", p, "missing"),
                        },
                        None => out.missing(
                            f,
                            line,
                            "embed",
                            i["raw"].as_str().unwrap_or(""),
                            "dynamic",
                        ),
                    },
                    Some("mod") if !self.home.contains_key(f) && i["body"] != json!(true) => {
                        let mod_rs = matches!(basename(f), "lib.rs" | "main.rs" | "mod.rs");
                        let name = i["name"].as_str().unwrap_or("");
                        match self.child(f, mod_rs, i) {
                            Ok((c, how)) => {
                                out.edge(f, &c, line, col, "mod", how, &format!("mod {name}"), &[])
                            }
                            Err(()) => {
                                out.missing(f, line, "mod", &format!("mod {name}"), "missing")
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn use_trees_expand() {
        assert_eq!(
            expand("a::b::{c, d::{e as f, self}, *}"),
            vec!["a::b::c", "a::b::d::e", "a::b::d", "a::b::*"]
        );
        assert_eq!(expand("crate::x as y"), vec!["crate::x"]);
        assert_eq!(expand("{std::fs, super::q}"), vec!["std::fs", "super::q"]);
    }
}
