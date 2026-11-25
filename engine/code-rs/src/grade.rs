// `norn-code grade files` (SPEC code-graph section 5, stage S4a): the file-level edges of a commit graded against each language's own
// toolchain. Every edge and unresolved import of the snapshot is a row; per language, a seeded random draw stratified by `how`
// (GRADE_PER_LANG rows, each stratum an equal share, what a small stratum leaves going to the larger ones; a smaller population is
// graded whole) is handed to the language's grader, which says which repo files the import loads:
// - JavaScript / TypeScript: Node's resolver (tools/grade/node-resolve.mjs, TS-only specifiers through the pinned typescript);
// - Python: the stdlib PathFinder over the roots norn-code declares for the file (tools/grade/py_find.py, uv's pinned Python);
// - Rust (here): rustc's dep-info of every crate target (`rustc --emit=dep-info`, the exact source files of the crate; no build,
//   no build script, no dependency fetched) and `cargo metadata --no-deps` for the crates and their path dependencies.
// An edge is right when its target is among the grader's; a row the grader loads an in-repo file for is a recall unit, hit when our
// edge names it. Precision per (language, how) class and recall per class and per language (the strata weighted back to the
// population), each with its Wilson 95 % interval, go to <state>/code/grade/<commit>.json. Dynamic imports are counted, not graded.
use crate::limits::{FILE_PRECISION_BAR, FILE_RECALL_BAR, GRADE_PER_LANG, GRADE_SEED, WILSON_Z};
use crate::paths::{basename, dirname, join};
use crate::{git, lang, store, Args};
use rayon::prelude::*;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;

pub struct Opts {
    pub seed: u64,
    pub per_lang: usize,
    pub graders: Option<PathBuf>,
}

/// `grade files` own flags, the rest left for the index arguments
pub fn opts(v: &[String]) -> Result<(Opts, Vec<String>), String> {
    let mut o = Opts {
        seed: GRADE_SEED,
        per_lang: GRADE_PER_LANG,
        graders: None,
    };
    let (mut rest, mut it) = (vec![], v.iter());
    while let Some(a) = it.next() {
        let mut val = || it.next().cloned().ok_or(format!("{a} needs a value"));
        match a.as_str() {
            "--seed" => o.seed = val()?.parse().map_err(|_| "--seed needs a whole number")?,
            "--per-lang" => {
                o.per_lang = val()?
                    .parse()
                    .map_err(|_| "--per-lang needs a whole number")?
            }
            "--graders" => o.graders = Some(PathBuf::from(val()?)),
            _ => rest.push(a.clone()),
        }
    }
    Ok((o, rest))
}

#[derive(Clone)]
struct Row {
    lang: &'static str,
    how: String,
    kind: String,
    from: String,
    line: u64,
    spec: String,
    to: Option<String>,
    cfg: bool,
}

/// what a grader says of one row: the repo files its import loads (empty: nothing in the repo), or why it cannot say
enum Truth {
    Set(Vec<String>),
    Na(String),
}

fn lang_of_row(files: &Map<String, Value>, from: &str) -> Option<&'static str> {
    match files.get(from).and_then(|r| r["lang"].as_str()) {
        Some("js") if matches!(crate::paths::ext(from), "ts" | "tsx" | "mts" | "cts") => {
            Some("typescript")
        }
        Some("js") => Some("javascript"),
        Some("py") => Some("python"),
        Some("rs") => Some("rust"),
        _ => match basename(from) {
            "Cargo.toml" => Some("rust"),
            "pyproject.toml" => Some("python"),
            "package.json" | "tsconfig.json" | "jsconfig.json" => Some("javascript"),
            _ => None,
        },
    }
}

/// splitmix64: the draw's generator (a seed gives the same sample on every machine)
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
}
fn fnv(s: &str) -> u64 {
    s.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| {
        (h ^ b as u64).wrapping_mul(0x100_0000_01b3)
    })
}

/// each stratum's share of `n`: equal, a stratum smaller than its share taken whole and the rest spread over the others
fn allocate(sizes: &BTreeMap<String, usize>, n: usize) -> BTreeMap<String, usize> {
    let mut by: Vec<(&String, usize)> = sizes.iter().map(|(k, v)| (k, *v)).collect();
    by.sort_by_key(|(k, v)| (*v, (*k).clone()));
    let (mut left, mut out) = (n, BTreeMap::new());
    for (i, (k, size)) in by.iter().enumerate() {
        let take = (*size).min(left / (by.len() - i));
        out.insert((*k).clone(), take);
        left -= take;
    }
    out
}

/// the Wilson score interval of k successes in n -> { p, lo, hi, n } (null p at n = 0)
pub fn wilson(k: f64, n: f64, n_obs: usize) -> Value {
    if n <= 0.0 {
        return json!({ "p": null, "lo": null, "hi": null, "n": 0 });
    }
    let (p, z, m) = (k / n, WILSON_Z, n_obs.max(1) as f64);
    let d = 1.0 + z * z / m;
    let c = (p + z * z / (2.0 * m)) / d;
    let h = z * ((p * (1.0 - p) / m) + z * z / (4.0 * m * m)).sqrt() / d;
    let r = |x: f64| (x * 10000.0).round() / 10000.0;
    json!({ "p": r(p), "lo": r((c - h).max(0.0)), "hi": r((c + h).min(1.0)), "n": n_obs })
}

/// unix seconds -> ISO 8601 UTC (days to civil date: Howard Hinnant's algorithm)
fn iso(s: u64) -> String {
    let (days, rem) = ((s / 86400) as i64, s % 86400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem / 60 % 60,
        rem % 60
    )
}

/// run a grader script: write its input, run it, read its { results: [{ id, ... }] } -> id -> result
fn run_grader(
    cmd: &mut Command,
    tmp: &Path,
    name: &str,
    input: Value,
) -> Result<HashMap<u64, Value>, String> {
    let (i, o) = (
        tmp.join(format!("{name}-in.json")),
        tmp.join(format!("{name}-out.json")),
    );
    std::fs::write(&i, input.to_string()).map_err(|e| format!("{}: {e}", i.display()))?;
    let r = cmd
        .arg(&i)
        .arg(&o)
        .output()
        .map_err(|e| format!("could not start the {name} grader: {e}"))?;
    if !r.status.success() {
        let err = String::from_utf8_lossy(&r.stderr);
        // the error's own line (a stack trace ends with the runtime's version, which says nothing)
        let line = err
            .lines()
            .find(|l| l.contains("Error"))
            .or(err.trim().lines().last())
            .unwrap_or("");
        return Err(format!(
            "the {name} grader failed ({}): {}",
            r.status,
            line.trim()
        ));
    }
    let out: Value = serde_json::from_slice(
        &std::fs::read(&o).map_err(|e| format!("{name} grader wrote no output: {e}"))?,
    )
    .map_err(|e| format!("{name} grader output: {e}"))?;
    Ok(out["results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| r["id"].as_u64().map(|id| (id, r.clone())))
        .collect())
}

fn on_path(exe: &str) -> bool {
    Command::new(exe)
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success())
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|x| x.as_str().map(str::to_string))
        .collect()
}

fn grade_js(
    rows: &[(u64, &Row)],
    root: &str,
    graders: Option<&Path>,
    tmp: &Path,
    manifests: &[&String],
) -> HashMap<u64, Truth> {
    let na = |why: String| {
        rows.iter()
            .map(|(id, _)| (*id, Truth::Na(why.clone())))
            .collect()
    };
    let Some(g) = graders else {
        return na("no grader folder given (--graders <norn>/tools/grade)".into());
    };
    let sites: Vec<Value> = rows
        .iter()
        .map(|(id, r)| json!({ "id": id, "from": r.from, "spec": r.spec, "kind": r.kind }))
        .collect();
    let mut cmd = Command::new("node");
    cmd.arg("--experimental-import-meta-resolve")
        .arg(g.join("node-resolve.mjs"));
    match run_grader(
        &mut cmd,
        tmp,
        "node",
        json!({ "root": root, "sites": sites, "manifests": manifests }),
    ) {
        Err(e) => na(e),
        Ok(m) => rows
            .iter()
            .map(|(id, _)| {
                let t = match m.get(id) {
                    None => Truth::Na("the grader gave no answer".into()),
                    Some(r) if r["na"].is_string() => {
                        Truth::Na(r["na"].as_str().unwrap_or("").into())
                    }
                    Some(r) => Truth::Set(strings(&r["targets"])),
                };
                (*id, t)
            })
            .collect(),
    }
}

fn grade_py(
    rows: &[(u64, &Row)],
    root: &str,
    graders: Option<&Path>,
    tmp: &Path,
    roots: &HashMap<String, Vec<String>>,
) -> HashMap<u64, Truth> {
    let na = |why: String| {
        rows.iter()
            .map(|(id, _)| (*id, Truth::Na(why.clone())))
            .collect()
    };
    let Some(g) = graders else {
        return na("no grader folder given (--graders <norn>/tools/grade)".into());
    };
    if !on_path("uv") {
        return na("uv not found on PATH: the Python grader runs on uv's pinned Python".into());
    }
    let pin = std::fs::read(g.join("manifest.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|m| m["python"].as_str().map(str::to_string));
    let Some(pin) = pin else {
        return na("tools/grade/manifest.json names no python".into());
    };
    let (mut out, mut ask) = (HashMap::new(), vec![]);
    for (id, r) in rows {
        if r.kind == "native" {
            out.insert(
                *id,
                Truth::Na("a Rust extension module: PathFinder has no source file for it".into()),
            );
        } else {
            ask.push(json!({ "id": id, "from": r.from, "line": r.line, "roots": roots.get(&r.from).cloned().unwrap_or_default() }));
        }
    }
    let mut cmd = Command::new("uv");
    cmd.args(["run", "--no-project", "--quiet", "--python", &pin, "python"])
        .arg(g.join("py_find.py"));
    let res = if ask.is_empty() {
        Ok(HashMap::new())
    } else {
        run_grader(
            &mut cmd,
            tmp,
            "python",
            json!({ "root": root, "sites": ask }),
        )
    };
    for (id, r) in rows {
        if out.contains_key(id) {
            continue;
        }
        let t = match &res {
            Err(e) => Truth::Na(e.clone()),
            Ok(m) => match m.get(id) {
                None => Truth::Na("the grader gave no answer".into()),
                Some(x) if x["na"].is_string() => Truth::Na(x["na"].as_str().unwrap_or("").into()),
                Some(x) => Truth::Set(strings(
                    &x[if r.kind == "package-init" {
                        "inits"
                    } else {
                        "modules"
                    }],
                )),
            },
        };
        out.insert(*id, t);
    }
    out
}

/// a dep-info path -> repo-relative with '/' (None outside the repo)
fn norm(p: &str, root: &str) -> Option<String> {
    let p = p.replace('\\', "/");
    let lower = |s: &str| s.to_lowercase();
    let rel = if p.len() > 1 && (p.starts_with('/') || p.as_bytes()[1] == b':') {
        let r = root.trim_end_matches('/');
        if lower(&p).starts_with(&(lower(r) + "/")) {
            p[r.len() + 1..].to_string()
        } else {
            return None;
        }
    } else {
        p
    };
    let mut out: Vec<&str> = vec![];
    for s in rel.split('/') {
        match s {
            "" | "." => {}
            ".." => {
                out.pop()?;
            }
            x => out.push(x),
        }
    }
    Some(out.join("/"))
}

/// a dep-info file's sources: the first rule's prerequisites (`out: a b\ c`)
fn dep_info(text: &str, root: &str) -> HashSet<String> {
    let first = text.lines().next().unwrap_or("");
    let deps = first.split_once(": ").map_or("", |(_, d)| d);
    let (mut out, mut cur, mut esc) = (HashSet::new(), String::new(), false);
    for ch in deps.chars().chain(std::iter::once(' ')) {
        match (esc, ch) {
            (true, ' ') => {
                cur.push(' ');
                esc = false;
            }
            (true, c) => {
                cur.push('\\');
                cur.push(c);
                esc = false;
            }
            (false, '\\') => esc = true,
            (false, ' ') => {
                if !cur.is_empty() {
                    out.extend(norm(&cur, root));
                }
                cur.clear();
            }
            (false, c) => cur.push(c),
        }
    }
    out
}

struct Pkg {
    manifest: String,
    lib: Option<String>,
    lib_src: Option<String>,
    /// dependency crate name (as written in code) -> the dependency's manifest when it is a path dependency
    deps: HashMap<String, Option<String>>,
    /// a dependency key as written in Cargo.toml -> its path manifest (None: a registry / git dependency)
    keys: HashMap<String, Option<String>>,
}

/// what rustc and cargo say of the repo's crates: per file, the dep-info sets holding it; the packages
struct RustTruth {
    sets: Vec<HashSet<String>>,
    of: HashMap<String, Vec<usize>>,
    set_pkg: Vec<usize>,
    pkgs: Vec<Pkg>,
    why: Option<String>,
}

fn rust_truth(root: &str, manifests: &[String], tmp: &Path) -> RustTruth {
    let mut t = RustTruth {
        sets: vec![],
        of: HashMap::new(),
        set_pkg: vec![],
        pkgs: vec![],
        why: None,
    };
    let (mut seen, mut targets, mut errs) = (HashSet::new(), vec![], vec![]);
    let rel = |p: &str| norm(p, root);
    for m in manifests {
        if seen.contains(m) {
            continue;
        }
        let r = Command::new("cargo")
            .args([
                "metadata",
                "--no-deps",
                "--offline",
                "--format-version",
                "1",
                "--manifest-path",
            ])
            .arg(Path::new(root).join(m))
            .output();
        let j: Option<Value> = r
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| serde_json::from_slice(&o.stdout).ok());
        let Some(j) = j else {
            errs.push(m.clone());
            continue;
        };
        if let Some(w) = j["workspace_root"].as_str().and_then(rel) {
            seen.insert(join(&w, "Cargo.toml").unwrap_or("Cargo.toml".into()));
        }
        for p in j["packages"].as_array().into_iter().flatten() {
            let Some(manifest) = p["manifest_path"].as_str().and_then(rel) else {
                continue;
            };
            if !seen.insert(manifest.clone()) && t.pkgs.iter().any(|x| x.manifest == manifest) {
                continue;
            }
            let features: Vec<String> = p["features"]
                .as_object()
                .map(|f| f.keys().cloned().collect())
                .unwrap_or_default();
            let lib = p["targets"].as_array().into_iter().flatten().find(|x| {
                strings(&x["kind"]).iter().any(|k| {
                    matches!(
                        k.as_str(),
                        "lib" | "rlib" | "dylib" | "cdylib" | "staticlib" | "proc-macro"
                    )
                })
            });
            let mut pkg = Pkg {
                manifest: manifest.clone(),
                lib: lib
                    .and_then(|l| l["name"].as_str())
                    .map(|n| n.replace('-', "_")),
                lib_src: lib.and_then(|l| l["src_path"].as_str()).and_then(rel),
                deps: HashMap::new(),
                keys: HashMap::new(),
            };
            for d in p["dependencies"].as_array().into_iter().flatten() {
                let name = d["name"].as_str().unwrap_or("");
                let key = d["rename"].as_str().unwrap_or(name);
                let path = d["path"]
                    .as_str()
                    .and_then(rel)
                    .map(|p| join(&p, "Cargo.toml").unwrap_or(p));
                pkg.keys.insert(key.to_string(), path.clone());
                pkg.deps.insert(key.replace('-', "_"), path);
            }
            let pi = t.pkgs.len();
            t.pkgs.push(pkg);
            for x in p["targets"].as_array().into_iter().flatten() {
                let (Some(src), Some(name)) =
                    (x["src_path"].as_str().and_then(rel), x["name"].as_str())
                else {
                    continue;
                };
                let ed = x["edition"]
                    .as_str()
                    .or(p["edition"].as_str())
                    .unwrap_or("2015")
                    .to_string();
                targets.push((pi, src, name.replace('-', "_"), ed, features.clone()));
            }
        }
    }
    let sets: Vec<(usize, Option<HashSet<String>>)> = targets
        .par_iter()
        .enumerate()
        .map(|(i, (pi, src, name, ed, feats))| {
            // twice: as a library (cfg(not(test)) code) and as its test harness (`--test` keeps the #[test] functions, whose
            // bodies' include_str! / mod are then expanded); the union is what the crate compiles under either
            let mut set: Option<HashSet<String>> = None;
            for (k, mode) in [&["--crate-type", "lib"][..], &["--test"][..]]
                .iter()
                .enumerate()
            {
                let d = tmp.join(format!("rs-{i}-{k}.d"));
                let mut c = Command::new("rustc");
                c.current_dir(root)
                    .args(["--edition", ed, "--crate-name", name])
                    .args(*mode)
                    .arg(format!("--emit=dep-info={}", d.display()));
                for f in feats {
                    c.arg("--cfg").arg(format!("feature=\"{f}\""));
                }
                let _ = c.arg(src).output();
                if let Ok(t) = std::fs::read_to_string(&d) {
                    set.get_or_insert_with(HashSet::new)
                        .extend(dep_info(&t, root));
                }
            }
            (*pi, set)
        })
        .collect();
    for (pi, s) in sets {
        let Some(s) = s.filter(|s| !s.is_empty()) else {
            continue;
        };
        let k = t.sets.len();
        for f in &s {
            t.of.entry(f.clone()).or_default().push(k);
        }
        t.sets.push(s);
        t.set_pkg.push(pi);
    }
    if t.sets.is_empty() {
        t.why = Some(if errs.is_empty() {
            "rustc wrote no dep-info".into()
        } else {
            format!("cargo metadata failed for {}", errs.join(", "))
        });
    }
    t
}

fn grade_rs(
    rows: &[(u64, &Row)],
    t: &RustTruth,
    mod_targets: &HashSet<String>,
) -> HashMap<u64, Truth> {
    rows.iter()
        .map(|(id, r)| (*id, rust_row(r, t, mod_targets)))
        .collect()
}

fn rust_row(r: &Row, t: &RustTruth, mod_targets: &HashSet<String>) -> Truth {
    if let Some(w) = &t.why {
        return Truth::Na(w.clone());
    }
    let member = |set: &HashSet<String>| {
        Truth::Set(r.to.iter().filter(|x| set.contains(*x)).cloned().collect())
    };
    if r.kind == "cargo-dep" {
        let Some(p) = t.pkgs.iter().find(|p| p.manifest == r.from) else {
            return Truth::Na("cargo metadata knows no package for this manifest".into());
        };
        return match p.keys.get(&r.spec) {
            None => Truth::Na("cargo metadata lists no such dependency".into()),
            Some(path) => Truth::Set(path.iter().cloned().collect()),
        };
    }
    let ks = t.of.get(&r.from).cloned().unwrap_or_default();
    if ks.is_empty() {
        return Truth::Na(
            "no crate target compiles the file (an orphan, or cfg off on this host)".into(),
        );
    }
    let d: HashSet<String> = ks.iter().flat_map(|k| t.sets[*k].iter().cloned()).collect();
    match r.kind.as_str() {
        "mod" | "embed" if r.to.is_some() => {
            if r.to.as_ref().is_some_and(|x| !d.contains(x)) && r.cfg {
                return Truth::Na("cfg-gated, not compiled on this host".into());
            }
            member(&d)
        }
        "mod" => {
            let x = r.spec.trim_start_matches("mod ").trim();
            let (a, b) = (format!("/{x}.rs"), format!("/{x}/mod.rs"));
            let dir = dirname(&r.from);
            Truth::Set(
                d.iter()
                    .filter(|f| {
                        (f.ends_with(&a) || f.ends_with(&b))
                            && crate::paths::under(f, dir)
                            && !mod_targets.contains(*f)
                    })
                    .cloned()
                    .collect(),
            )
        }
        "embed" => Truth::Set(
            join(dirname(&r.from), &r.spec)
                .filter(|f| d.contains(f))
                .into_iter()
                .collect(),
        ),
        _ => {
            let spec = r
                .spec
                .trim_start_matches("extern crate ")
                .trim_start_matches("::");
            let head = spec.split([':', ' ', ';', '{']).next().unwrap_or("");
            if matches!(head, "crate" | "self" | "super") {
                return if r.to.is_some() {
                    member(&d)
                } else {
                    Truth::Na("a path inside the crate: dep-info names no file for it".into())
                };
            }
            if matches!(head, "std" | "core" | "alloc" | "proc_macro" | "test") {
                return Truth::Set(vec![]);
            }
            let pkgs: Vec<&Pkg> = ks.iter().map(|k| &t.pkgs[t.set_pkg[*k]]).collect();
            let lib_of = |m: &str| t.pkgs.iter().find(|p| p.manifest == m);
            let dep = pkgs.iter().find_map(|p| p.deps.get(head));
            let own = pkgs
                .iter()
                .find(|p| p.lib.as_deref() == Some(head) && p.lib_src.as_deref() != Some(&r.from));
            let target: Option<&Pkg> = match (dep, own) {
                (Some(Some(m)), _) => lib_of(m),
                (Some(None), _) => return Truth::Set(vec![]),
                (None, Some(p)) => Some(p),
                (None, None) => None,
            };
            match target {
                Some(p) => {
                    let lib: HashSet<String> = p
                        .lib_src
                        .as_ref()
                        .and_then(|s| t.of.get(s))
                        .into_iter()
                        .flatten()
                        .filter(|k| {
                            t.set_pkg[**k]
                                == t.pkgs
                                    .iter()
                                    .position(|x| x.manifest == p.manifest)
                                    .unwrap_or(usize::MAX)
                        })
                        .flat_map(|k| t.sets[*k].iter().cloned())
                        .collect();
                    if r.to.is_some() {
                        member(&lib)
                    } else {
                        Truth::Set(p.lib_src.iter().cloned().collect())
                    }
                }
                None if r.to.is_some() => member(&d),
                None => {
                    Truth::Na("not a crate cargo metadata names: a path inside the crate".into())
                }
            }
        }
    }
}

#[derive(Default)]
struct Cls {
    population: usize,
    sampled: usize,
    na: BTreeMap<String, usize>,
    tp: usize,
    fp: usize,
    units: usize,
    hits: usize,
}

/// grade the file-level edges of the asked commit (the files on disk must be that commit's) -> the grade, also written to
/// <state>/code/grade/<commit>.json
pub fn files(a: &Args, o: &Opts) -> Result<Value, String> {
    if a.worktree {
        return Err("grade files grades a commit: no --worktree".into());
    }
    let b = crate::index(a)?;
    let commit = b.out["commit"].as_str().unwrap_or("").to_string();
    let head = String::from_utf8_lossy(&git::git(&a.repo, &["rev-parse", "HEAD"])?)
        .trim()
        .to_string();
    if head != commit {
        return Err(format!(
            "grade files reads the files on disk: check out {commit} first (HEAD is {head})"
        ));
    }
    let root = String::from_utf8_lossy(&git::git(&a.repo, &["rev-parse", "--show-toplevel"])?)
        .trim()
        .to_string();
    let snap = &b.snap;
    let files = snap["files"].as_object().cloned().unwrap_or_default();
    let mut rows: BTreeMap<&'static str, Vec<Row>> = BTreeMap::new();
    let mut dynamic: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut at_site: HashMap<(String, u64), Vec<String>> = HashMap::new();
    let mut mod_targets = HashSet::new();
    for (e, edge) in snap["edges"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|e| (e, true))
        .chain(
            snap["unresolved"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|e| (e, false)),
        )
    {
        let from = e["from"].as_str().unwrap_or("").to_string();
        let Some(l) = lang_of_row(&files, &from) else {
            continue;
        };
        let (kind, line) = (
            e["kind"].as_str().unwrap_or("").to_string(),
            e["line"].as_u64().unwrap_or(0),
        );
        let to = e["to"].as_str().filter(|_| edge).map(str::to_string);
        if let Some(t) = &to {
            if kind != "package-init" {
                at_site
                    .entry((from.clone(), line))
                    .or_default()
                    .push(t.clone());
            }
            if kind == "mod" {
                mod_targets.insert(t.clone());
            }
        }
        if kind == "dynamic" || e["why"] == json!("dynamic") {
            *dynamic.entry(l).or_default() += 1;
            continue;
        }
        rows.entry(l).or_default().push(Row {
            lang: l,
            how: e["how"].as_str().unwrap_or("").to_string(),
            kind,
            from,
            line,
            spec: e["spec"].as_str().unwrap_or("").to_string(),
            to,
            cfg: e["cfg"].is_string(),
        });
    }
    // the draw: per language, per stratum (how), rows in snapshot order, a partial Fisher-Yates with a seed of (seed, lang, how)
    let mut sample: Vec<(u64, Row)> = vec![];
    let mut pops: BTreeMap<(&str, String), usize> = BTreeMap::new();
    for (l, rs) in &rows {
        let mut strata: BTreeMap<String, Vec<&Row>> = BTreeMap::new();
        for r in rs {
            strata.entry(r.how.clone()).or_default().push(r);
        }
        let sizes = strata.iter().map(|(k, v)| (k.clone(), v.len())).collect();
        for (how, n) in allocate(&sizes, o.per_lang) {
            let v = &strata[&how];
            pops.insert((l, how.clone()), v.len());
            let mut rng = Rng(o.seed ^ fnv(&format!("{l}/{how}")));
            let mut idx: Vec<usize> = (0..v.len()).collect();
            for i in 0..n {
                let j = i + (rng.next() % (v.len() - i) as u64) as usize;
                idx.swap(i, j);
            }
            for i in &idx[..n] {
                sample.push((sample.len() as u64, v[*i].clone()));
            }
        }
    }
    let tmp = a
        .state
        .join("code")
        .join("grade")
        .join(format!("tmp-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
    let by = |ls: &[&str]| -> Vec<(u64, &Row)> {
        sample
            .iter()
            .filter(|(_, r)| ls.contains(&r.lang))
            .map(|(i, r)| (*i, r))
            .collect()
    };
    let g = o.graders.as_deref();
    let pjs: Vec<&String> = files
        .keys()
        .filter(|p| basename(p) == "package.json")
        .collect();
    let mut truth = grade_js(&by(&["javascript", "typescript"]), &root, g, &tmp, &pjs);
    let py = by(&["python"]);
    if !py.is_empty() {
        let tree_files = git::ls_tree(&a.repo, "HEAD")?;
        let text: HashMap<String, String> = tree_files
            .keys()
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
        let froms: Vec<&str> = py.iter().map(|(_, r)| r.from.as_str()).collect();
        truth.extend(grade_py(
            &py,
            &root,
            g,
            &tmp,
            &lang::py::roots_of(&ctx, &froms),
        ));
    }
    let rs = by(&["rust"]);
    if !rs.is_empty() {
        let mut manifests: Vec<String> = files
            .keys()
            .filter(|p| basename(p) == "Cargo.toml")
            .cloned()
            .collect();
        manifests.sort_by_key(|m| (m.matches('/').count(), m.clone()));
        let t = rust_truth(&root, &manifests, &tmp);
        truth.extend(grade_rs(&rs, &t, &mod_targets));
    }
    let _ = std::fs::remove_dir_all(&tmp);

    // the counts per class, then the estimates
    let mut cls: BTreeMap<(&str, String), Cls> = BTreeMap::new();
    let mut wrong: BTreeMap<&str, Vec<Value>> = BTreeMap::new();
    for ((l, how), n) in &pops {
        cls.entry((l, how.clone())).or_default().population = *n;
    }
    for (id, r) in &sample {
        let c = cls.entry((r.lang, r.how.clone())).or_default();
        c.sampled += 1;
        let set = match truth.get(id) {
            Some(Truth::Set(s)) => s,
            Some(Truth::Na(w)) => {
                *c.na.entry(w.clone()).or_default() += 1;
                continue;
            }
            None => {
                *c.na.entry("no grader for the language".into()).or_default() += 1;
                continue;
            }
        };
        let ok = match &r.to {
            Some(to) => {
                let hit = set.contains(to);
                if hit {
                    c.tp += 1
                } else {
                    c.fp += 1
                }
                if !set.is_empty() {
                    c.units += 1;
                    c.hits += usize::from(hit);
                }
                hit
            }
            None => {
                let ours = at_site
                    .get(&(r.from.clone(), r.line))
                    .cloned()
                    .unwrap_or_default();
                let missed = set.iter().any(|f| !ours.contains(f));
                c.units += usize::from(missed);
                !missed
            }
        };
        if !ok {
            let w = wrong.entry(r.lang).or_default();
            if w.len() < 30 {
                w.push(json!({ "from": r.from, "line": r.line, "kind": r.kind, "how": r.how, "spec": r.spec, "ours": r.to, "grader": set }));
            }
        }
    }
    let mut langs = Map::new();
    let mut below = vec![];
    for l in rows.keys() {
        let mut classes = Map::new();
        let (mut wtp, mut wpr, mut whit, mut wun, mut npr, mut nun) = (0.0, 0.0, 0.0, 0.0, 0, 0);
        let mut lbelow = vec![];
        for ((_, how), c) in cls.iter().filter(|((x, _), _)| x == l) {
            let w = if c.sampled > 0 {
                c.population as f64 / c.sampled as f64
            } else {
                0.0
            };
            let graded = c.tp + c.fp;
            let edge = !matches!(how.as_str(), "external" | "unresolved");
            wtp += w * c.tp as f64;
            wpr += w * graded as f64;
            whit += w * c.hits as f64;
            wun += w * c.units as f64;
            npr += graded;
            nun += c.units;
            let prec = wilson(c.tp as f64, graded as f64, graded);
            let rec = wilson(c.hits as f64, c.units as f64, c.units);
            let mut bb = vec![];
            if edge && graded > 0 && (c.tp as f64) < FILE_PRECISION_BAR * graded as f64 {
                bb.push("precision");
            }
            if c.units > 0 && (c.hits as f64) < FILE_RECALL_BAR * c.units as f64 {
                bb.push("recall");
            }
            if edge && !bb.is_empty() {
                lbelow.push(format!("{l}/file/{how}"));
            }
            let mut v = json!({ "population": c.population, "sampled": c.sampled, "graded": graded, "na": c.na, "tp": c.tp, "fp": c.fp, "recall_units": c.units, "recall_hits": c.hits, "precision": if edge { prec } else { Value::Null }, "recall": rec, "below_bar": bb });
            if !edge {
                v["missed"] = json!(c.units - c.hits);
            }
            classes.insert(how.clone(), v);
        }
        let prec = wilson(wtp, wpr, npr);
        let rec = wilson(whit, wun, nun);
        let rec_below = wun > 0.0 && whit < FILE_RECALL_BAR * wun;
        if rec_below {
            lbelow.push(format!("{l}/file recall"));
        }
        below.extend(lbelow.iter().cloned());
        langs.insert(
            l.to_string(),
            json!({ "population": rows[l].len(), "dynamic": dynamic.get(l).copied().unwrap_or(0), "sampled": sample.iter().filter(|(_, r)| r.lang == *l).count(), "precision": prec, "recall": rec, "below_bar": lbelow, "classes": classes, "disagreements": wrong.get(l).cloned().unwrap_or_default() }),
        );
    }
    let out = json!({
        "ok": true, "level": "file", "commit": commit, "tree": b.out["tree"], "graded_at": iso(store::now_s()),
        "seed": o.seed, "per_lang": o.per_lang, "bars": { "precision": FILE_PRECISION_BAR, "recall": FILE_RECALL_BAR, "z": WILSON_Z },
        "below_bar": below, "langs": langs,
    });
    let f = a
        .state
        .join("code")
        .join("grade")
        .join(format!("{commit}.json"));
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
    use super::*;

    #[test]
    fn wilson_interval_and_allocation() {
        // n = 400 at p = 0.9: about +-3 pp (SPEC section 5)
        let w = wilson(360.0, 400.0, 400);
        assert_eq!(
            (w["lo"].as_f64(), w["hi"].as_f64()),
            (Some(0.8667), Some(0.9257))
        );
        assert_eq!(wilson(0.0, 0.0, 0)["p"], Value::Null);
        let sizes: BTreeMap<String, usize> = [("a", 1), ("b", 50), ("c", 3)]
            .iter()
            .map(|(k, v)| (k.to_string(), *v))
            .collect();
        let got: Vec<usize> = allocate(&sizes, 12).into_values().collect();
        assert_eq!(got, vec![1, 8, 3]);
    }

    #[test]
    fn dep_info_sources_repo_relative() {
        let root = "C:/w/repo";
        let d = r"C:/t/x.d: src/lib.rs src\a.rs src/my\ dir/b.rs src\../assets/s.wgsl C:/w/repo/src/c.rs C:/other/d.rs
src/lib.rs:";
        let mut got: Vec<String> = dep_info(d, root).into_iter().collect();
        got.sort();
        assert_eq!(
            got,
            [
                "assets/s.wgsl",
                "src/a.rs",
                "src/c.rs",
                "src/lib.rs",
                "src/my dir/b.rs"
            ]
        );
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso(1_795_651_200), "2026-11-26T00:00:00Z");
    }
}
