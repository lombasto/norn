// Python (SPEC code-graph 4.1). Roots per pyproject.toml ([tool.maturin] python-source, [tool.setuptools.packages.find] where,
// else src/ when it holds a package, else the pyproject folder), then the repo root, then --python-root; a folder holding
// conftest.py is a root for its own loose modules. The importing file's own project's roots come first. `import a.b.c` is
// PathFinder's rule per root: one hit `probed`, several `ambiguous` (nearest first, the rest in alts), plus a `package-init` edge
// to each ancestor __init__.py; relative imports are `exact`. A Rust extension module resolves through maturin `module-name`
// (`native`, `config`) or a `#[pymodule] fn` of that name (`native`, `name`). Anything else is `external` with its top name.
use super::{lc, matches, pos, text, Ctx, Lang, Out};
use crate::paths::{basename, dirname, join, under};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use tree_sitter::{Language, Node, Query, Tree};

pub struct Py;

const QUERY: &str = "(import_statement) @imp (import_from_statement) @from";
const SOURCES: [&str; 2] = ["py", "pyi"];

/// inside a function body or an `if TYPE_CHECKING:` block: not run when the module loads
fn local(mut n: Node, src: &[u8]) -> bool {
    while let Some(p) = n.parent() {
        match p.kind() {
            "function_definition" => return true,
            "if_statement"
                if p.child_by_field_name("condition")
                    .is_some_and(|c| text(c, src).contains("TYPE_CHECKING")) =>
            {
                return true
            }
            _ => {}
        }
        n = p;
    }
    false
}
fn dotted(n: Node, src: &[u8]) -> Option<String> {
    match n.kind() {
        "dotted_name" => Some(text(n, src).split_whitespace().collect()),
        "aliased_import" => n.child_by_field_name("name").and_then(|d| dotted(d, src)),
        _ => None,
    }
}

/// a Python file's dotted module name under the longest of its roots that holds it (`src/fx/core.py` under `src` -> fx.core;
/// a package's `__init__.py` is the package)
fn module_of(file: &str, roots: &[String]) -> String {
    let root = roots
        .iter()
        .filter(|r| r.is_empty() || under(file, r))
        .max_by_key(|r| r.len())
        .map_or("", |r| r.as_str());
    let rel = if root.is_empty() {
        file
    } else {
        &file[root.len() + 1..]
    };
    let rel = rel.rsplit_once('.').map_or(rel, |(a, _)| a);
    let rel = rel
        .strip_suffix("/__init__")
        .unwrap_or(if rel == "__init__" { "" } else { rel });
    rel.replace('/', ".")
}

impl Lang for Py {
    fn name(&self) -> &'static str {
        "py"
    }
    fn exts(&self) -> &'static [&'static str] {
        &SOURCES
    }
    fn grammar(&self, _: &str) -> (&'static str, Language) {
        ("py", tree_sitter_python::LANGUAGE.into())
    }
    fn import_query(&self) -> &'static str {
        QUERY
    }
    fn tags(&self, _: &str) -> String {
        tree_sitter_python::TAGS_QUERY.to_string()
    }
    fn extract(&self, q: &Query, tree: &Tree, src: &[u8]) -> Map<String, Value> {
        let mut imports = vec![];
        for (pat, caps) in matches(q, tree, src) {
            let n = caps[0].1;
            let (line, col) = pos(n);
            let kind = if local(n, src) {
                "import-local"
            } else {
                "import"
            };
            let stmt: String = text(n, src)
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            let mut c = n.walk();
            let names: Vec<String> = n
                .children_by_field_name("name", &mut c)
                .filter_map(|x| dotted(x, src))
                .collect();
            if pat == 0 {
                for m in names {
                    imports.push(json!({ "kind": kind, "module": m, "level": 0, "names": [], "text": stmt, "line": line, "col": col }));
                }
                continue;
            }
            let Some(m) = n.child_by_field_name("module_name") else {
                continue;
            };
            let (level, module) = if m.kind() == "relative_import" {
                let mut c = m.walk();
                let prefix = m
                    .children(&mut c)
                    .find(|x| x.kind() == "import_prefix")
                    .map_or(0, |x| text(x, src).matches('.').count());
                let mut c = m.walk();
                let module = m
                    .children(&mut c)
                    .find(|x| x.kind() == "dotted_name")
                    .and_then(|d| dotted(d, src))
                    .unwrap_or_default();
                (prefix, module)
            } else {
                (0, dotted(m, src).unwrap_or_default())
            };
            imports.push(json!({ "kind": kind, "module": module, "level": level, "names": names, "text": stmt, "line": line, "col": col }));
        }
        Map::from_iter([("imports".to_string(), Value::Array(imports))])
    }
    fn resolve(&self, ctx: &Ctx, out: &mut Out) {
        let r = Resolver::new(ctx);
        for (from, facts) in ctx.sources("py") {
            let roots = r.roots_for(from);
            out.info
                .entry(from.clone())
                .or_default()
                .insert("module".into(), json!(module_of(from, &roots)));
            for i in facts["imports"].as_array().into_iter().flatten() {
                let (line, col) = lc(i);
                let kind = i["kind"].as_str().unwrap_or("import");
                let module = i["module"].as_str().unwrap_or("");
                let level = i["level"].as_u64().unwrap_or(0) as usize;
                let names: Vec<&str> = i["names"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect();
                let spec = i["text"].as_str().unwrap_or(module).to_string();
                if level > 0 {
                    r.relative(
                        from,
                        &roots,
                        level,
                        module,
                        &names,
                        (line, col, kind, &spec),
                        out,
                    );
                    continue;
                }
                // `from a import b, c`: each name that is a submodule is its own edge, the rest is one edge to `a`
                let mut targets: Vec<String> = names
                    .iter()
                    .map(|n| format!("{module}.{n}"))
                    .filter(|m| !matches!(r.find(&roots, m), Find::None))
                    .collect();
                if targets.len() < names.len() || names.is_empty() {
                    targets.push(module.to_string());
                }
                for m in targets {
                    r.emit(from, &roots, &m, (line, col, kind, &spec), out);
                }
            }
        }
    }
}

enum Find {
    /// regular modules / packages: (file, root), nearest root first
    Regular(Vec<(String, String)>),
    Namespace(String),
    Native(&'static str, Vec<String>),
    None,
}

struct Resolver<'a> {
    ctx: &'a Ctx<'a>,
    /// pyproject dir -> its roots
    projects: Vec<(String, Vec<String>)>,
    global: Vec<String>,
    conftest_dirs: Vec<String>,
    /// maturin module-name -> its crate's lib file
    maturin: HashMap<String, String>,
    /// #[pymodule] fn name -> the Rust files defining it
    pymodules: HashMap<String, Vec<String>>,
}

impl<'a> Resolver<'a> {
    fn new(ctx: &'a Ctx<'a>) -> Resolver<'a> {
        let (mut projects, mut maturin) = (vec![], HashMap::new());
        for (p, t) in ctx.manifests("pyproject.toml") {
            let d = dirname(p).to_string();
            let Ok(toml) = t.parse::<toml::Table>() else {
                continue;
            };
            let tool = toml.get("tool");
            let mat = tool.and_then(|t| t.get("maturin"));
            let roots: Vec<String> = if let Some(ps) = mat
                .and_then(|m| m.get("python-source"))
                .and_then(|v| v.as_str())
            {
                join(&d, ps).into_iter().collect()
            } else if let Some(w) = tool
                .and_then(|t| t.get("setuptools"))
                .and_then(|s| s.get("packages"))
                .and_then(|s| s.get("find"))
                .and_then(|f| f.get("where"))
                .and_then(|w| w.as_array())
            {
                w.iter()
                    .filter_map(|x| x.as_str())
                    .filter_map(|x| join(&d, x))
                    .collect()
            } else {
                let src = join(&d, "src").unwrap_or_default();
                let pkg = ctx.files.keys().any(|f| {
                    dirname(f).len() > src.len()
                        && dirname(dirname(f)) == src
                        && basename(f) == "__init__.py"
                        || (dirname(f) == src && f.ends_with(".py"))
                });
                vec![if pkg { src } else { d.clone() }]
            };
            if let Some(name) = mat
                .and_then(|m| m.get("module-name"))
                .and_then(|v| v.as_str())
            {
                let manifest = mat
                    .and_then(|m| m.get("manifest-path"))
                    .and_then(|v| v.as_str())
                    .and_then(|m| join(&d, m))
                    .unwrap_or(join(&d, "Cargo.toml").unwrap_or_default());
                let lib = ctx
                    .text
                    .get(&manifest)
                    .and_then(|t| t.parse::<toml::Table>().ok())
                    .and_then(|c| {
                        c.get("lib")
                            .and_then(|l| l.get("path"))
                            .and_then(|p| p.as_str())
                            .map(str::to_string)
                    });
                if let Some(f) = join(dirname(&manifest), lib.as_deref().unwrap_or("src/lib.rs"))
                    .filter(|f| ctx.is_file(f))
                {
                    maturin.insert(name.to_string(), f);
                }
            }
            projects.push((d, roots));
        }
        let mut global: Vec<String> = projects.iter().flat_map(|(_, r)| r.clone()).collect();
        global.push(String::new());
        global.extend(ctx.python_roots.iter().cloned());
        let conftest_dirs = ctx
            .files
            .keys()
            .filter(|f| basename(f) == "conftest.py")
            .map(|f| dirname(f).to_string())
            .collect();
        let mut pymodules: HashMap<String, Vec<String>> = HashMap::new();
        for (f, facts) in ctx.sources("rs") {
            for n in facts["pymodules"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                pymodules.entry(n.to_string()).or_default().push(f.clone());
            }
        }
        Resolver {
            ctx,
            projects,
            global,
            conftest_dirs,
            maturin,
            pymodules,
        }
    }

    /// the root order for one importing file: its own project's roots, its conftest folders (nearest first), then the rest
    fn roots_for(&self, from: &str) -> Vec<String> {
        let own = self
            .projects
            .iter()
            .filter(|(d, _)| under(from, d))
            .max_by_key(|(d, _)| d.len());
        let mut conf: Vec<&String> = self
            .conftest_dirs
            .iter()
            .filter(|d| under(from, d))
            .collect();
        conf.sort_by_key(|d| std::cmp::Reverse(d.len()));
        let mut v: Vec<String> = vec![];
        for r in own
            .into_iter()
            .flat_map(|(_, r)| r.iter())
            .chain(conf)
            .chain(self.global.iter())
        {
            if !v.contains(r) {
                v.push(r.clone());
            }
        }
        v
    }

    /// a module file of path `base` (a/b/c under a root): c.py, c.pyi, c/__init__.py, c/__init__.pyi
    fn module_file(&self, base: &str) -> Option<String> {
        [
            format!("{base}.py"),
            format!("{base}.pyi"),
            format!("{base}/__init__.py"),
            format!("{base}/__init__.pyi"),
        ]
        .into_iter()
        .find(|f| self.ctx.is_file(f))
    }

    fn find(&self, roots: &[String], module: &str) -> Find {
        if let Some(f) = self.maturin.get(module) {
            return Find::Native("config", vec![f.clone()]);
        }
        let rel = module.replace('.', "/");
        let mut hits: Vec<(String, String)> = vec![];
        let mut ns = None;
        for r in roots {
            let Some(base) = join(r, &rel) else { continue };
            if let Some(f) = self.module_file(&base) {
                if !hits.iter().any(|(h, _)| *h == f) {
                    hits.push((f, r.clone()));
                }
            } else if ns.is_none() && self.ctx.is_dir(&base) {
                ns = Some(base);
            }
        }
        if !hits.is_empty() {
            return Find::Regular(hits);
        }
        if let Some(fs) = module
            .rsplit('.')
            .next()
            .and_then(|n| self.pymodules.get(n))
        {
            return Find::Native("name", fs.clone());
        }
        ns.map_or(Find::None, Find::Namespace)
    }

    fn emit(
        &self,
        from: &str,
        roots: &[String],
        module: &str,
        (line, col, kind, spec): (usize, usize, &str, &str),
        out: &mut Out,
    ) {
        match self.find(roots, module) {
            Find::Regular(hits) => {
                let (to, root) = &hits[0];
                let how = if hits.len() > 1 {
                    "ambiguous"
                } else {
                    "probed"
                };
                let alts: Vec<String> = hits[1..].iter().map(|h| h.0.clone()).collect();
                out.edge(from, to, line, col, kind, how, spec, &alts);
                // Python runs each ancestor package's __init__ on import
                let segs: Vec<&str> = module.split('.').collect();
                for k in 1..segs.len() {
                    if let Some(init) = join(root, &segs[..k].join("/"))
                        .and_then(|b| self.module_file(&b))
                        .filter(|f| basename(f).starts_with("__init__."))
                    {
                        out.edge(from, &init, line, col, "package-init", how, spec, &[]);
                    }
                }
            }
            Find::Namespace(d) => out.edge(from, &d, line, col, kind, "probed", spec, &[]),
            Find::Native(how, fs) => out.edge(
                from,
                &fs[0],
                line,
                col,
                "native",
                if fs.len() > 1 { "ambiguous" } else { how },
                spec,
                &fs[1..],
            ),
            Find::None => {
                let top = module.split('.').next().unwrap_or(module);
                if matches!(self.find(roots, top), Find::None) {
                    out.external(from, line, kind, spec, top);
                } else {
                    out.missing(from, line, kind, spec, "missing");
                }
            }
        }
    }

    /// a relative import's target file `base` (a/b/c): the Python module, else a native module of that dotted name under a root
    fn rel_target(
        &self,
        roots: &[String],
        base: &str,
    ) -> Option<(String, &'static str, &'static str)> {
        if let Some(f) = self.module_file(base) {
            return Some((f, "", "exact"));
        }
        let r = roots
            .iter()
            .filter(|r| under(base, r) && base != r.as_str())
            .max_by_key(|r| r.len())?;
        let dotted = (if r.is_empty() {
            base
        } else {
            &base[r.len() + 1..]
        })
        .replace('/', ".");
        match self.find(roots, &dotted) {
            Find::Native(how, fs) if fs.len() == 1 => Some((fs[0].clone(), "native", how)),
            _ => None,
        }
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "a relative import needs its level, module and names apart from the shared site tuple"
    )]
    fn relative(
        &self,
        from: &str,
        roots: &[String],
        level: usize,
        module: &str,
        names: &[&str],
        (line, col, kind, spec): (usize, usize, &str, &str),
        out: &mut Out,
    ) {
        let mut base = Some(dirname(from).to_string());
        for _ in 1..level {
            base = base
                .filter(|b| !b.is_empty())
                .map(|b| dirname(&b).to_string());
        }
        let Some(base) = base.and_then(|b| join(&b, &module.replace('.', "/"))) else {
            out.missing(from, line, kind, spec, "missing");
            return;
        };
        // `from .a import b, c`: each name that is a submodule is its own edge, the rest is one edge to `.a`
        let subs: Vec<_> = names
            .iter()
            .filter_map(|n| join(&base, n).and_then(|b| self.rel_target(roots, &b)))
            .collect();
        let all_sub = !names.is_empty() && subs.len() == names.len();
        for (f, k, how) in &subs {
            out.edge(
                from,
                f,
                line,
                col,
                if k.is_empty() { kind } else { k },
                how,
                spec,
                &[],
            );
        }
        if !all_sub {
            match self.rel_target(roots, &base) {
                Some((f, k, how)) => out.edge(
                    from,
                    &f,
                    line,
                    col,
                    if k.is_empty() { kind } else { k },
                    how,
                    spec,
                    &[],
                ),
                None if self.ctx.is_dir(&base) && (!subs.is_empty() || names.is_empty()) => {}
                None => out.missing(from, line, kind, spec, "missing"),
            }
        }
    }
}

/// the import roots of each Python file, in its search order (grade.rs hands them to the PathFinder grader as the declared roots)
pub fn roots_of(ctx: &Ctx, files: &[&str]) -> HashMap<String, Vec<String>> {
    let r = Resolver::new(ctx);
    files
        .iter()
        .map(|f| (f.to_string(), r.roots_for(f)))
        .collect()
}
