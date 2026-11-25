// `norn-code grade calls` (SPEC code-graph section 5, stage S4b): the definitions and call edges of a commit graded against each
// language's compiler-grade indexer (tools/grade, pinned; never imported by the engine):
// - JavaScript / TypeScript: scip-typescript 0.6.2 over a copy of the commit's JS / TS files (tools/grade/scip-ts.mjs);
// - Python: jedi 0.20.1 on uv's pinned Python (tools/grade/py_jedi.py): `goto(follow_imports=True)` per sampled call site, and the
//   definitions of the files holding a sampled definition;
// - Rust: rust-analyzer `scip` of the pinned release, once per cargo workspace (tools/grade/scip-rust.mjs), its own target dir.
// The SCIP indexes are decoded here (scip.rs). Per language, two seeded draws of `--per-lang` rows (grade.rs's draw): our definitions
// stratified by kind, our call sites stratified by how.
// - A definition is right when the grader's definition of that name, inside our bounds, has exactly our `line..end_line` (its start
//   taken past leading attribute / decorator / comment lines: rust-analyzer's range holds them, the definition node does not). Recall: a
//   seeded draw of the grader's own function / method / class / type definitions, each found when one of ours of that name holds it.
// - A grader target (file, name line, name) maps onto our definition of that name whose bounds hold the line (a JS constructor: its
//   class). Precision of a how class: among its sites the grader resolves inside the repo, the share whose one target is the
//   grader's. Recall: among sampled sites whose grader target maps onto one of our definitions, the share we answer with a
//   chosen target (`local`, `import`, `qualified`, `self`, `method-unique`) that is it; `ambiguous` and `external` sites are
//   misses, and `ambiguous` reports how often its list holds the grader's target.
// Each with its Wilson 95 % interval (recall weighted back to the strata's populations); bars in limits.rs. The grade goes to
// <state>/code/grade/<commit>.calls.json (the file level's is <commit>.json).
use crate::grade::{allocate, fnv, iso, lang_of_row, on_path, run_script, wilson, Opts, Rng};
use crate::limits::{
    CALL_PRECISION_BAR, CALL_PRECISION_BAR_RUST, CALL_RECALL_BAR, CALL_RECALL_BAR_RUST,
    DEF_PRECISION_BAR, DEF_RECALL_BAR, WILSON_Z,
};
use crate::paths::{basename, dirname, ext};
use crate::{calls, git, lang, scip, store, Args};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

/// the call classes that choose one target: the bars apply to them
const CHOSEN: [&str; 5] = ["local", "import", "qualified", "self", "method-unique"];
/// the SCIP symbol kinds of the definitions the graph indexes (a recall unit); type aliases, fields, variables are not
const DEF_KINDS: [&str; 15] = [
    "Function",
    "Method",
    "Class",
    "Struct",
    "Enum",
    "Trait",
    "Interface",
    "Union",
    "StaticMethod",
    "AbstractMethod",
    "TraitMethod",
    "ProtocolMethod",
    "PureVirtualMethod",
    "SingletonMethod",
    "Namespace",
];
const JS_EXT: [&str; 8] = ["js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts"];

#[derive(Clone)]
struct Site {
    file: String,
    line: u64,
    col: u64,
    name: String,
    how: String,
    cands: Vec<String>,
}
#[derive(Clone)]
struct DefRow {
    id: String,
    file: String,
    name: String,
    kind: String,
    line: u64,
    end: u64,
}
/// a definition as a grader sees it: its name line, its bounds (1-based, inclusive) when given, and whether it is a recall unit
#[derive(Clone)]
struct GDef {
    file: String,
    name: String,
    line: u64,
    span: Option<(u64, u64)>,
    counted: bool,
}
/// a grader's target: (file, name line, name)
type Target = (String, u64, String);
/// what a grader says of a call site: the in-repo targets and how many answers lie outside the repo
enum SiteT {
    At(Vec<Target>, usize),
    Na(String),
}
#[derive(Default)]
struct Truth {
    sites: HashMap<u64, SiteT>,
    defs: HashMap<String, Vec<GDef>>,
    /// the files the grader read (a definition of another file is n/a, not a miss)
    covered: HashSet<String>,
    na: Option<String>,
    cost: Map<String, Value>,
}

/// a draw: the sampled (key, language, stratum, row) and each (language, stratum)'s population
type Drawn<T> = (
    Vec<(u64, &'static str, String, T)>,
    BTreeMap<(&'static str, String), usize>,
);

/// the seeded stratified draw of grade.rs over (language, stratum, row)
fn draw<T: Clone>(
    rows: Vec<(&'static str, String, T)>,
    per_lang: usize,
    seed: u64,
    level: &str,
) -> Drawn<T> {
    let mut by: BTreeMap<&'static str, BTreeMap<String, Vec<T>>> = BTreeMap::new();
    for (l, s, t) in rows {
        by.entry(l).or_default().entry(s).or_default().push(t);
    }
    let (mut out, mut pops) = (vec![], BTreeMap::new());
    for (l, strata) in by {
        let sizes = strata.iter().map(|(k, v)| (k.clone(), v.len())).collect();
        for (s, n) in allocate(&sizes, per_lang) {
            let v = &strata[&s];
            pops.insert((l, s.clone()), v.len());
            let mut rng = Rng(seed ^ fnv(&format!("{l}/{level}/{s}")));
            let mut idx: Vec<usize> = (0..v.len()).collect();
            for i in 0..n {
                let j = i + (rng.next() % (v.len() - i) as u64) as usize;
                idx.swap(i, j);
            }
            for i in &idx[..n] {
                out.push((out.len() as u64, l, s.clone(), v[*i].clone()));
            }
        }
    }
    (out, pops)
}

/// the lines of repo files, read once
struct Texts<'r> {
    root: &'r str,
    lines: HashMap<String, Vec<String>>,
}
impl Texts<'_> {
    fn line(&mut self, file: &str, l1: u64) -> String {
        let root = self.root;
        let ls = self.lines.entry(file.to_string()).or_insert_with(|| {
            std::fs::read(Path::new(root).join(file))
                .map(|b| {
                    String::from_utf8_lossy(&b)
                        .lines()
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default()
        });
        ls.get(l1.saturating_sub(1) as usize)
            .cloned()
            .unwrap_or_default()
    }
}

/// the decoded SCIP documents -> the grader's definitions and its answer at each sampled call site
fn scip_truth(docs: &[scip::Doc], sites: &[(u64, &Site)], texts: &mut Texts) -> Truth {
    let mut t = Truth::default();
    // a global symbol -> its definitions: rust-analyzer gives two same-named items nested in sibling fns one symbol, two places
    let mut global: HashMap<&str, Vec<Target>> = HashMap::new();
    let mut local: HashMap<(&str, &str), Target> = HashMap::new();
    for d in docs {
        t.covered.insert(d.path.clone());
        for o in d.occs.iter().filter(|o| o.def) {
            let name = scip::slice(&texts.line(&d.path, o.line as u64 + 1), o.c0, o.c1, d.utf8);
            let counted = name != "constructor"
                && match d.kinds.get(&o.sym) {
                    Some(k) => DEF_KINDS.contains(&k.as_str()),
                    None => {
                        !scip::is_local(&o.sym) && matches!(scip::suffix(&o.sym), "method" | "type")
                    }
                };
            let at = (d.path.clone(), o.line as u64 + 1, name.clone());
            if scip::is_local(&o.sym) {
                local.entry((d.path.as_str(), o.sym.as_str())).or_insert(at);
            } else {
                let v = global.entry(o.sym.as_str()).or_default();
                if !v.contains(&at) {
                    v.push(at);
                }
            }
            t.defs.entry(d.path.clone()).or_default().push(GDef {
                file: d.path.clone(),
                name,
                line: o.line as u64 + 1,
                span: o.encl.map(|(a, b)| (a as u64 + 1, b as u64 + 1)),
                counted,
            });
        }
    }
    let by_path: HashMap<&str, &scip::Doc> = docs.iter().map(|d| (d.path.as_str(), d)).collect();
    for (id, s) in sites {
        let Some(d) = by_path.get(s.file.as_str()) else {
            t.sites
                .insert(*id, SiteT::Na("the grader did not index the file".into()));
            continue;
        };
        let u = scip::to_unit(&texts.line(&s.file, s.line), s.col, d.utf8);
        let on_line = d
            .occs
            .iter()
            .filter(|o| o.line as u64 + 1 == s.line && !o.def);
        let occ = on_line
            .clone()
            .find(|o| o.c0 == u)
            .or_else(|| on_line.clone().find(|o| o.c0 <= u && u < o.c1));
        let ans = match occ {
            None => SiteT::Na("the grader has no occurrence at the call site".into()),
            Some(o) => {
                let to = if scip::is_local(&o.sym) {
                    local
                        .get(&(d.path.as_str(), o.sym.as_str()))
                        .map(|x| vec![x.clone()])
                } else {
                    global.get(o.sym.as_str()).cloned()
                };
                match to {
                    Some(x) if x.len() > 1 => SiteT::Na(
                        "the grader's symbol has several definitions (same-named items in sibling fns): no one target".into(),
                    ),
                    Some(x) => SiteT::At(x, 0),
                    None => SiteT::At(vec![], 1),
                }
            }
        };
        t.sites.insert(*id, ans);
    }
    t
}

/// a definition's first line past its leading attribute, decorator and comment lines: rust-analyzer's range (and a TS
/// decorator's) starts at them, the definition node's at the item (`fn`, `def`, `class`); the end line is compared as given
fn item_start(texts: &mut Texts, file: &str, (a, b): (u64, u64)) -> u64 {
    const TRIVIA: [&str; 6] = ["#[", "///", "//", "/*", "*", "@"];
    // an attribute or decorator runs until its brackets close (a `#[allow(` on one line, its `)]` lines later)
    let mut depth = 0i64;
    for l in a..=b {
        let line = texts.line(file, l);
        let t = line.trim_start();
        let opens = depth > 0 || t.starts_with("#[") || t.starts_with('@');
        if opens {
            depth += t.matches(['[', '(']).count() as i64 - t.matches([']', ')']).count() as i64;
            depth = depth.max(0);
            continue;
        }
        if !t.is_empty() && !TRIVIA.iter().any(|p| t.starts_with(p)) {
            return l;
        }
    }
    a
}

/// our definition a grader target names: the one of that name whose bounds hold its line, the innermost (a JS constructor: its class)
fn ours_at(g: &calls::Graph, file: &str, line: u64, name: &str) -> Option<String> {
    let f = g.files.get(file)?;
    let n = |d: &Value, k: &str| d[k].as_u64().unwrap_or(0);
    f.defs
        .iter()
        .filter(|d| n(d, "line") <= line && line <= n(d, "end_line") && d["kind"] != json!("impl"))
        .filter(|d| {
            d["name"] == json!(name) || (name == "constructor" && d["kind"] == json!("class"))
        })
        .min_by_key(|d| n(d, "end_line") - n(d, "line"))
        .map(|d| d["id"].as_str().unwrap_or("").to_string())
}

/// the cargo workspaces of the tree: each Cargo.toml with [workspace], and each package Cargo.toml outside all of them
fn workspaces(root: &str, manifests: &[String]) -> Vec<String> {
    let mut ws: Vec<String> = vec![];
    let mut ms = manifests.to_vec();
    ms.sort_by_key(|m| (m.matches('/').count(), m.clone()));
    for m in &ms {
        let dir = dirname(m).to_string();
        let inside = ws
            .iter()
            .any(|w| w.is_empty() || dir == *w || dir.starts_with(&format!("{w}/")));
        let text = std::fs::read_to_string(Path::new(root).join(m)).unwrap_or_default();
        let v: toml::Table = text.parse().unwrap_or_default();
        if (v.contains_key("workspace") || (v.contains_key("package") && !inside))
            && !ws.contains(&dir)
        {
            if inside && !v.contains_key("workspace") {
                continue;
            }
            ws.push(dir);
        }
    }
    ws
}

fn ms(t: Instant) -> u64 {
    t.elapsed().as_millis() as u64
}

fn grade_js(
    sites: &[(u64, &Site)],
    root: &str,
    g: &Path,
    tmp: &Path,
    tree: &[String],
    texts: &mut Texts,
) -> Truth {
    let files: Vec<&String> = tree
        .iter()
        .filter(|p| {
            JS_EXT.contains(&ext(p))
                || matches!(
                    basename(p),
                    "package.json" | "tsconfig.json" | "jsconfig.json"
                )
        })
        .collect();
    let manifests: Vec<&String> = tree
        .iter()
        .filter(|p| basename(p) == "package.json")
        .collect();
    let (copy, out) = (tmp.join("js-copy"), tmp.join("js.scip"));
    let t0 = Instant::now();
    let mut cmd = Command::new("node");
    cmd.arg(g.join("scip-ts.mjs"));
    let r = run_script(
        &mut cmd,
        tmp,
        "scip-typescript",
        json!({ "root": root, "files": files, "manifests": manifests, "copy": copy, "scip": out }),
    );
    let fail = |why: String| Truth {
        na: Some(why),
        ..Default::default()
    };
    let r = match r {
        Err(e) => return fail(e),
        Ok(r) if r["na"].is_string() => return fail(r["na"].as_str().unwrap_or("").into()),
        Ok(r) => r,
    };
    let t1 = Instant::now();
    let docs = match scip::read(&out, "") {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let mut t = scip_truth(&docs, sites, texts);
    t.cost
        .insert("grader".into(), json!("scip-typescript 0.6.2"));
    t.cost.insert("index_ms".into(), r["ms"].clone());
    t.cost.insert("wall_ms".into(), json!(ms(t0)));
    t.cost.insert("decode_ms".into(), json!(ms(t1)));
    t.cost.insert(
        "scip_bytes".into(),
        json!(std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0)),
    );
    t.cost.insert("files_copied".into(), json!(files.len()));
    t
}

fn grade_rs(
    sites: &[(u64, &Site)],
    root: &str,
    g: &Path,
    tmp: &Path,
    tree: &[String],
    texts: &mut Texts,
) -> Truth {
    let manifests: Vec<String> = tree
        .iter()
        .filter(|p| basename(p) == "Cargo.toml")
        .cloned()
        .collect();
    let ws = workspaces(root, &manifests);
    let t0 = Instant::now();
    // rust-analyzer runs cargo, which writes a Cargo.lock into every lockless workspace: it indexes a copy of the commit's files
    // under each package folder (a path dependency is a package too), never the checkout
    let copy = tmp.join("rs-copy");
    let dirs: Vec<&str> = manifests
        .iter()
        .map(|m| &m[..m.len() - "Cargo.toml".len()])
        .collect();
    for f in tree
        .iter()
        .filter(|f| dirs.iter().any(|d| f.starts_with(d)))
    {
        let to = copy.join(f);
        let made = to.parent().map_or(Ok(()), std::fs::create_dir_all);
        if let Err(e) = made.and_then(|_| std::fs::copy(Path::new(root).join(f), &to)) {
            return Truth {
                na: Some(format!("copying {f} for rust-analyzer: {e}")),
                ..Default::default()
            };
        }
    }
    let copied_ms = ms(t0);
    let abs: Vec<String> = ws
        .iter()
        .map(|w| copy.join(w).to_string_lossy().replace('\\', "/"))
        .collect();
    let mut cmd = Command::new("node");
    cmd.arg(g.join("scip-rust.mjs"));
    let fail = |why: String| Truth {
        na: Some(why),
        ..Default::default()
    };
    let r = match run_script(
        &mut cmd,
        tmp,
        "rust-analyzer",
        json!({ "workspaces": abs, "target": tmp.join("ra-target"), "out": tmp.join("ra") }),
    ) {
        Err(e) => return fail(e),
        Ok(r) if r["na"].is_string() => return fail(r["na"].as_str().unwrap_or("").into()),
        Ok(r) => r,
    };
    let (mut docs, mut runs, mut nas) = (vec![], vec![], vec![]);
    for (i, x) in r["indexes"].as_array().into_iter().flatten().enumerate() {
        let w = ws.get(i).cloned().unwrap_or_default();
        match x["scip"].as_str() {
            Some(f) => {
                let bytes = std::fs::metadata(f).map(|m| m.len()).unwrap_or(0);
                match scip::read(Path::new(f), &w) {
                    Ok(d) => docs.extend(d),
                    Err(e) => nas.push(format!("{w}: {e}")),
                }
                runs.push(json!({ "workspace": w, "ms": x["ms"], "scip_bytes": bytes }));
            }
            None => nas.push(format!("{w}: {}", x["na"].as_str().unwrap_or(""))),
        }
    }
    if docs.is_empty() {
        return fail(if nas.is_empty() {
            "no cargo workspace in the tree".into()
        } else {
            nas.join("; ")
        });
    }
    let mut t = scip_truth(&docs, sites, texts);
    t.cost.insert(
        "grader".into(),
        json!(format!(
            "rust-analyzer {}",
            r["version"].as_str().unwrap_or("")
        )),
    );
    t.cost.insert("wall_ms".into(), json!(ms(t0)));
    t.cost.insert("copy_ms".into(), json!(copied_ms));
    t.cost.insert("workspaces".into(), json!(runs));
    if !nas.is_empty() {
        t.cost.insert("failed".into(), json!(nas));
    }
    t
}

fn grade_py(
    sites: &[(u64, &Site)],
    def_files: &[String],
    root: &str,
    g: &Path,
    tmp: &Path,
    roots: &HashMap<String, Vec<String>>,
) -> Truth {
    let fail = |why: String| Truth {
        na: Some(why),
        ..Default::default()
    };
    if !on_path("uv") {
        return fail("uv not found on PATH: the Python grader runs on uv's pinned Python".into());
    }
    let pin = std::fs::read(g.join("manifest.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    let Some(py) = pin.as_ref().and_then(|m| m["python"].as_str()) else {
        return fail("tools/grade/manifest.json names no python".into());
    };
    let rf = |f: &str| roots.get(f).cloned().unwrap_or_default();
    let ask: Vec<Value> = sites.iter().map(|(id, s)| json!({ "id": id, "file": s.file, "line": s.line, "col": s.col, "roots": rf(&s.file) })).collect();
    let dfs: Vec<Value> = def_files
        .iter()
        .map(|f| json!({ "file": f, "roots": rf(f) }))
        .collect();
    let t0 = Instant::now();
    let mut cmd = Command::new("uv");
    cmd.args([
        "run",
        "--no-project",
        "--quiet",
        "--python",
        py,
        "--with-requirements",
    ])
    .arg(g.join("jedi.lock.txt"))
    .arg("python")
    .arg(g.join("py_jedi.py"));
    let out = match run_script(
        &mut cmd,
        tmp,
        "jedi",
        json!({ "root": root, "sites": ask, "def_files": dfs }),
    ) {
        Err(e) => return fail(e),
        Ok(o) => o,
    };
    let mut t = Truth::default();
    for r in out["results"].as_array().into_iter().flatten() {
        let Some(id) = r["id"].as_u64() else { continue };
        let a = if let Some(w) = r["na"].as_str() {
            SiteT::Na(w.into())
        } else {
            let ts = r["targets"].as_array().into_iter().flatten();
            SiteT::At(
                ts.map(|x| {
                    (
                        x["file"].as_str().unwrap_or("").to_string(),
                        x["line"].as_u64().unwrap_or(0),
                        x["name"].as_str().unwrap_or("").to_string(),
                    )
                })
                .collect(),
                r["outside"].as_u64().unwrap_or(0) as usize,
            )
        };
        t.sites.insert(id, a);
    }
    for (f, rows) in out["defs"].as_object().into_iter().flatten() {
        let Some(rows) = rows.as_array() else {
            continue;
        };
        t.covered.insert(f.clone());
        t.defs.insert(
            f.clone(),
            rows.iter()
                .map(|x| GDef {
                    file: f.clone(),
                    name: x["name"].as_str().unwrap_or("").to_string(),
                    line: x["line"].as_u64().unwrap_or(0),
                    span: x["start"].as_u64().zip(x["end"].as_u64()),
                    counted: true,
                })
                .collect(),
        );
    }
    t.cost.insert(
        "grader".into(),
        json!(format!(
            "jedi {}",
            pin.as_ref().and_then(|m| m["jedi"].as_str()).unwrap_or("")
        )),
    );
    t.cost.insert("wall_ms".into(), json!(ms(t0)));
    t.cost.insert("sites".into(), json!(ask.len()));
    t.cost.insert("def_files".into(), json!(dfs.len()));
    t
}

#[derive(Default)]
struct Cls {
    population: usize,
    sampled: usize,
    na: BTreeMap<String, usize>,
    tp: usize,
    fp: usize,
    outside: usize,
    contains: usize,
    /// exact once the grader's leading attribute / comment lines are left out (item_start)
    trivia: usize,
    units: usize,
    hits: usize,
}

fn lang_name(files: &Map<String, Value>, f: &str) -> Option<&'static str> {
    lang_of_row(files, f).filter(|_| files.get(f).is_some_and(|r| r["lang"].is_string()))
}

/// grade the definitions and call edges of the asked commit (the files on disk must be that commit's) -> the grade, also written to
/// <state>/code/grade/<commit>.calls.json
pub fn calls(a: &Args, o: &Opts) -> Result<Value, String> {
    if a.worktree {
        return Err("grade calls grades a commit: no --worktree".into());
    }
    let (stamp, g) = crate::graph_of(a)?;
    let commit = stamp["commit"].as_str().unwrap_or("").to_string();
    let head = String::from_utf8_lossy(&git::git(&a.repo, &["rev-parse", "HEAD"])?)
        .trim()
        .to_string();
    if head != commit {
        return Err(format!(
            "grade calls reads the files on disk: check out {commit} first (HEAD is {head})"
        ));
    }
    let root = String::from_utf8_lossy(&git::git(&a.repo, &["rev-parse", "--show-toplevel"])?)
        .trim()
        .to_string();
    let Some(graders) = o.graders.clone() else {
        return Err("grade calls needs the grader folder: --graders <norn>/tools/grade".into());
    };
    let tree_files = git::ls_tree(&a.repo, "HEAD")?;
    let tree: Vec<String> = tree_files.keys().cloned().collect();
    let rows: Map<String, Value> = g
        .files
        .iter()
        .map(|(p, f)| (p.clone(), f.row.clone()))
        .collect();

    // the populations: every first-party definition (by kind) and call site (by how), per language
    let (mut defs, mut sites) = (vec![], vec![]);
    let mut paths: Vec<&String> = g.files.keys().collect();
    paths.sort();
    for p in paths {
        let Some(l) = lang_name(&rows, p) else {
            continue;
        };
        for d in &g.files[p].defs {
            let s = |k: &str| d[k].as_str().unwrap_or("").to_string();
            let r = DefRow {
                id: s("id"),
                file: p.clone(),
                name: s("name"),
                kind: s("kind"),
                line: d["line"].as_u64().unwrap_or(0),
                end: d["end_line"].as_u64().unwrap_or(0),
            };
            defs.push((l, r.kind.clone(), r));
        }
        for (row, ds) in g.sites(p) {
            let site = Site {
                file: p.clone(),
                line: row["line"].as_u64().unwrap_or(0),
                col: row["col"].as_u64().unwrap_or(0),
                name: row["name"].as_str().unwrap_or("").to_string(),
                how: row["how"].as_str().unwrap_or("").to_string(),
                cands: ds
                    .iter()
                    .map(|d| g.def_value(d)["id"].as_str().unwrap_or("").to_string())
                    .collect(),
            };
            sites.push((l, site.how.clone(), site));
        }
    }
    let (dsample, dpops) = draw(defs, o.per_lang, o.seed, "def");
    let (ssample, spops) = draw(sites, o.per_lang, o.seed, "call");
    let langs: Vec<&'static str> = dpops
        .keys()
        .chain(spops.keys())
        .map(|(l, _)| *l)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();

    let tmp: PathBuf =
        std::env::temp_dir().join(format!("norn-grade-calls-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
    let mut texts = Texts {
        root: &root,
        lines: HashMap::new(),
    };
    let mut truth: HashMap<&str, std::rc::Rc<Truth>> = HashMap::new();
    let of = |ls: &[&str]| -> Vec<(u64, &Site)> {
        ssample
            .iter()
            .filter(|x| ls.contains(&x.1))
            .map(|x| (x.0, &x.3))
            .collect()
    };
    if langs
        .iter()
        .any(|l| matches!(*l, "javascript" | "typescript"))
    {
        let t = std::rc::Rc::new(grade_js(
            &of(&["javascript", "typescript"]),
            &root,
            &graders,
            &tmp,
            &tree,
            &mut texts,
        ));
        truth.insert("javascript", t.clone());
        truth.insert("typescript", t);
    }
    if langs.contains(&"python") {
        let mut df: Vec<String> = dsample
            .iter()
            .filter(|x| x.1 == "python")
            .map(|x| x.3.file.clone())
            .collect();
        df.sort();
        df.dedup();
        let text: HashMap<String, String> = tree
            .iter()
            .filter(|p| matches!(basename(p), "pyproject.toml" | "Cargo.toml"))
            .map(|p| {
                (
                    p.clone(),
                    std::fs::read_to_string(Path::new(&root).join(p)).unwrap_or_default(),
                )
            })
            .collect();
        let empty = HashMap::new();
        let ctx = lang::Ctx::new(&tree_files, &empty, &text, &a.python_roots);
        let py = of(&["python"]);
        let mut froms: Vec<&str> = py
            .iter()
            .map(|(_, s)| s.file.as_str())
            .chain(df.iter().map(String::as_str))
            .collect();
        froms.sort();
        froms.dedup();
        truth.insert(
            "python",
            std::rc::Rc::new(grade_py(
                &py,
                &df,
                &root,
                &graders,
                &tmp,
                &lang::py::roots_of(&ctx, &froms),
            )),
        );
    }
    if langs.contains(&"rust") {
        truth.insert(
            "rust",
            std::rc::Rc::new(grade_rs(
                &of(&["rust"]),
                &root,
                &graders,
                &tmp,
                &tree,
                &mut texts,
            )),
        );
    }
    let _ = std::fs::remove_dir_all(&tmp);

    let mut out_langs = Map::new();
    let mut below = vec![];
    for l in &langs {
        let t = truth.get(l).cloned().unwrap_or_default();
        let (pbar, rbar) = if *l == "rust" {
            (CALL_PRECISION_BAR_RUST, CALL_RECALL_BAR_RUST)
        } else {
            (CALL_PRECISION_BAR, CALL_RECALL_BAR)
        };
        let mut lbelow = vec![];
        // --- definitions: bounds per kind ---
        let mut dcls: BTreeMap<String, Cls> = BTreeMap::new();
        for ((x, k), n) in &dpops {
            if x == l {
                dcls.entry(k.clone()).or_default().population = *n;
            }
        }
        let mut dwrong = vec![];
        for (_, _, k, d) in dsample.iter().filter(|x| x.1 == *l) {
            let c = dcls.entry(k.clone()).or_default();
            c.sampled += 1;
            if let Some(w) = &t.na {
                *c.na.entry(w.clone()).or_default() += 1;
                continue;
            }
            if d.kind == "impl" {
                *c.na
                    .entry("an impl block: the grader has no definition for it".into())
                    .or_default() += 1;
                continue;
            }
            let gd = t
                .defs
                .get(&d.file)
                .into_iter()
                .flatten()
                .filter(|x| x.name == d.name && d.line <= x.line && x.line <= d.end)
                .min_by_key(|x| x.line);
            match gd {
                None if !t.covered.contains(&d.file) => {
                    *c.na
                        .entry("the grader did not index the file".into())
                        .or_default() += 1
                }
                None => {
                    *c.na
                        .entry("the grader has no definition of the name inside its bounds".into())
                        .or_default() += 1
                }
                Some(x) => match x.span {
                    None => *c.na.entry("the grader gives no bounds".into()).or_default() += 1,
                    Some(sp) if sp == (d.line, d.end) => c.tp += 1,
                    Some(sp) if (item_start(&mut texts, &d.file, sp), sp.1) == (d.line, d.end) => {
                        c.tp += 1;
                        c.trivia += 1;
                    }
                    Some(sp) => {
                        c.fp += 1;
                        if dwrong.len() < 30 {
                            dwrong.push(json!({ "id": d.id, "kind": d.kind, "ours": [d.line, d.end], "grader": [sp.0, sp.1] }));
                        }
                    }
                },
            }
        }
        // recall: a seeded draw of the grader's own counted definitions in first-party files of this language
        let mut pool: Vec<&GDef> = t
            .defs
            .values()
            .flatten()
            .filter(|x| {
                x.counted && lang_name(&rows, &x.file) == Some(*l) && g.files.contains_key(&x.file)
            })
            .collect();
        pool.sort_by(|a, b| (&a.file, a.line, &a.name).cmp(&(&b.file, b.line, &b.name)));
        let mut rng = Rng(o.seed ^ fnv(&format!("{l}/def recall")));
        let n = pool.len().min(o.per_lang);
        for i in 0..n {
            let j = i + (rng.next() % (pool.len() - i) as u64) as usize;
            pool.swap(i, j);
        }
        let (mut dunits, mut dhits, mut dmissed) = (0, 0, vec![]);
        for x in &pool[..n] {
            dunits += 1;
            let found = g.files[&x.file].defs.iter().any(|d| {
                d["name"] == json!(x.name)
                    && d["line"].as_u64().unwrap_or(0) <= x.line
                    && x.line <= d["end_line"].as_u64().unwrap_or(0)
            });
            if found {
                dhits += 1;
            } else if dmissed.len() < 30 {
                dmissed.push(json!({ "file": x.file, "line": x.line, "name": x.name }));
            }
        }
        let mut dclasses = Map::new();
        let (mut dtp, mut dgr) = (0, 0);
        for (k, c) in &dcls {
            let graded = c.tp + c.fp;
            dtp += c.tp;
            dgr += graded;
            let bb = graded > 0 && (c.tp as f64) < DEF_PRECISION_BAR * graded as f64;
            if bb {
                lbelow.push(format!("{l}/def/{k}"));
            }
            dclasses.insert(k.clone(), json!({ "population": c.population, "sampled": c.sampled, "graded": graded, "na": c.na, "exact": c.tp, "exact_past_attributes": c.trivia, "wrong": c.fp, "precision": wilson(c.tp as f64, graded as f64, graded), "below_bar": bb }));
        }
        if dunits > 0 && (dhits as f64) < DEF_RECALL_BAR * dunits as f64 {
            lbelow.push(format!("{l}/def recall"));
        }
        // --- call edges: per how ---
        let mut ccls: BTreeMap<String, Cls> = BTreeMap::new();
        for ((x, h), n) in &spops {
            if x == l {
                ccls.entry(h.clone()).or_default().population = *n;
            }
        }
        let mut cwrong = vec![];
        for (id, _, h, s) in ssample.iter().filter(|x| x.1 == *l) {
            let c = ccls.entry(h.clone()).or_default();
            c.sampled += 1;
            let ans = match (&t.na, t.sites.get(id)) {
                (Some(w), _) => SiteT::Na(w.clone()),
                (None, None) => SiteT::Na("the grader gave no answer".into()),
                (None, Some(SiteT::Na(w))) => SiteT::Na(w.clone()),
                (None, Some(SiteT::At(v, n))) => SiteT::At(v.clone(), *n),
            };
            let SiteT::At(targets, _) = ans else {
                if let SiteT::Na(w) = ans {
                    *c.na.entry(w).or_default() += 1;
                }
                continue;
            };
            let mapped: Vec<String> = targets
                .iter()
                .filter_map(|(f, ln, nm)| ours_at(&g, f, *ln, nm))
                .collect();
            let chosen = CHOSEN.contains(&h.as_str());
            let ours = if chosen { s.cands.first() } else { None };
            if !mapped.is_empty() {
                c.units += 1;
                c.hits += usize::from(ours.is_some_and(|x| mapped.contains(x)));
                c.contains +=
                    usize::from(h == "ambiguous" && s.cands.iter().any(|x| mapped.contains(x)));
            }
            if chosen {
                if targets.is_empty() {
                    c.outside += 1;
                } else if ours.is_some_and(|x| mapped.contains(x)) {
                    c.tp += 1;
                } else {
                    c.fp += 1;
                }
            }
            let wrong =
                (chosen && !targets.is_empty() && !ours.is_some_and(|x| mapped.contains(x)))
                    || (!mapped.is_empty()
                        && !ours.is_some_and(|x| mapped.contains(x))
                        && h != "ambiguous");
            if wrong && cwrong.len() < 40 {
                cwrong.push(json!({ "file": s.file, "line": s.line, "col": s.col, "name": s.name, "how": h, "ours": s.cands.iter().take(3).collect::<Vec<_>>(), "grader": targets.iter().map(|(f, ln, nm)| format!("{f}:{ln} {nm}")).collect::<Vec<_>>(), "grader_def": mapped }));
            }
        }
        let mut cclasses = Map::new();
        let (mut wtp, mut wpr, mut whit, mut wun, mut npr, mut nun) = (0.0, 0.0, 0.0, 0.0, 0, 0);
        for (h, c) in &ccls {
            let w = if c.sampled > 0 {
                c.population as f64 / c.sampled as f64
            } else {
                0.0
            };
            let graded = c.tp + c.fp;
            let chosen = CHOSEN.contains(&h.as_str());
            whit += w * c.hits as f64;
            wun += w * c.units as f64;
            nun += c.units;
            if chosen {
                wtp += w * c.tp as f64;
                wpr += w * graded as f64;
                npr += graded;
            }
            let bb = chosen && graded > 0 && (c.tp as f64) < pbar * graded as f64;
            if bb {
                lbelow.push(format!("{l}/call/{h}"));
            }
            let mut v = json!({ "population": c.population, "sampled": c.sampled, "na": c.na, "recall_units": c.units, "recall_hits": c.hits, "below_bar": bb });
            if chosen {
                v["graded"] = json!(graded);
                v["tp"] = json!(c.tp);
                v["fp"] = json!(c.fp);
                v["outside"] = json!(c.outside);
                v["precision"] = wilson(c.tp as f64, graded as f64, graded);
            } else {
                v["missed"] = json!(c.units - c.hits);
            }
            if h == "ambiguous" {
                v["contains"] = json!(c.contains);
            }
            cclasses.insert(h.clone(), v);
        }
        if wun > 0.0 && whit < rbar * wun {
            lbelow.push(format!("{l}/call recall"));
        }
        below.extend(lbelow.iter().cloned());
        out_langs.insert(
            l.to_string(),
            json!({
                "grader": t.cost.get("grader").cloned().unwrap_or(Value::Null), "na": t.na, "cost": t.cost, "below_bar": lbelow,
                "defs": { "population": dpops.iter().filter(|((x, _), _)| x == l).map(|(_, n)| n).sum::<usize>(), "precision": wilson(dtp as f64, dgr as f64, dgr),
                          "recall": wilson(dhits as f64, dunits as f64, dunits), "recall_pool": pool.len(), "classes": dclasses, "disagreements": dwrong, "missed": dmissed },
                "calls": { "population": spops.iter().filter(|((x, _), _)| x == l).map(|(_, n)| n).sum::<usize>(), "precision": wilson(wtp, wpr, npr), "recall": wilson(whit, wun, nun),
                           "bars": { "precision": pbar, "recall": rbar }, "classes": cclasses, "disagreements": cwrong },
            }),
        );
    }
    let out = json!({
        "ok": true, "level": "calls", "commit": commit, "tree": stamp["tree"], "graded_at": iso(store::now_s()),
        "seed": o.seed, "per_lang": o.per_lang, "bars": { "def_precision": DEF_PRECISION_BAR, "def_recall": DEF_RECALL_BAR, "z": WILSON_Z },
        "below_bar": below, "langs": out_langs,
    });
    let f = a
        .state
        .join("code")
        .join("grade")
        .join(format!("{commit}.calls.json"));
    store::write_atomic(
        &f,
        serde_json::to_string_pretty(&out)
            .unwrap_or_default()
            .as_bytes(),
    )?;
    let mut o2 = out;
    o2["file"] = json!(f.to_string_lossy().replace('\\', "/"));
    Ok(o2)
}

#[cfg(test)]
mod tests {
    use super::workspaces;

    #[test]
    fn workspaces_are_the_workspace_roots_and_the_packages_outside_them() {
        let d = std::env::temp_dir().join(format!("cg-ws-{}", std::process::id()));
        let w = |p: &str, t: &str| {
            std::fs::create_dir_all(d.join(p).parent().unwrap()).unwrap();
            std::fs::write(d.join(p), t).unwrap();
        };
        w("a/Cargo.toml", "[workspace]\nmembers = [\"x\"]\n");
        w("a/x/Cargo.toml", "[package]\nname = \"x\"\n");
        w("b/Cargo.toml", "[package]\nname = \"b\"\n");
        let m = ["a/Cargo.toml", "a/x/Cargo.toml", "b/Cargo.toml"].map(String::from);
        assert_eq!(workspaces(&d.to_string_lossy(), &m), ["a", "b"]);
        let _ = std::fs::remove_dir_all(&d);
    }
}
