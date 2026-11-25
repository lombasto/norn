// norn-code: the code graph's indexer (SPEC code-graph, docs/code-graph.md). `norn-code index --repo D --state S [--at REV]
// [--worktree] [--exclude GLOB]... [--python-root DIR]...` parses each blob of the commit's tree that the store does not hold yet
// (tree-sitter, in parallel), resolves imports over the whole tree, and writes the tree's snapshot; it prints one JSON line with
// the commit, the tree, what it parsed and reused and where the time went. `--worktree` resolves uncommitted work over HEAD's tree
// in memory and prints the snapshot instead of storing it. `norn-code query` answers symbols, refs, calls and callers over a commit
// (calls.rs resolves the call sites). `norn-code version` prints { crate, store_schema }.
mod calls;
mod exclude;
mod git;
mod lang;
mod limits;
mod paths;
mod store;
mod symbols;

use lang::{lang_of, Ctx, Out, LANGS, MANIFESTS};
use rayon::prelude::*;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::time::Instant;
use store::Store;

struct Args {
    repo: PathBuf,
    state: PathBuf,
    at: Option<String>,
    worktree: bool,
    exclude: Vec<String>,
    python_roots: Vec<String>,
}

fn args(v: &[String]) -> Result<Args, String> {
    let (mut repo, mut state, mut at, mut worktree, mut exclude, mut python_roots) =
        (None, None, None, false, vec![], vec![]);
    let mut it = v.iter();
    while let Some(a) = it.next() {
        let mut val = || it.next().cloned().ok_or(format!("{a} needs a value"));
        match a.as_str() {
            "--repo" => repo = Some(PathBuf::from(val()?)),
            "--state" => state = Some(PathBuf::from(val()?)),
            "--at" => at = Some(val()?),
            "--worktree" => worktree = true,
            "--exclude" => exclude.push(val()?),
            "--python-root" => python_roots.push(val()?.trim_matches('/').to_string()),
            x => return Err(format!("unknown argument {x}")),
        }
    }
    if worktree && at.is_some() {
        return Err("--worktree resolves the working tree over HEAD: no --at".into());
    }
    Ok(Args {
        repo: repo.ok_or("--repo D is required")?,
        state: state.ok_or("--state S is required")?,
        at,
        worktree,
        exclude,
        python_roots,
    })
}

fn ms(t: Instant) -> u64 {
    t.elapsed().as_millis() as u64
}

/// what one index run gives: its JSON line, the snapshot, and (when it listed the tree) each path's blob sha and the worktree
/// files whose bytes are on disk only (sha -> path)
struct Built {
    out: Value,
    snap: Value,
    files: Option<HashMap<String, String>>,
    on_disk: HashMap<String, String>,
}

/// one index run: the snapshot of the asked commit's tree (stored, or built and stored; in memory for --worktree)
fn index(a: &Args) -> Result<Built, String> {
    let t0 = Instant::now();
    let st = Store::new(&a.state);
    let rev = a.at.clone().unwrap_or("HEAD".into());
    let (commit, tree) = git::rev(&a.repo, &rev)?;
    let entry = |parsed: usize, reused: usize, counts: Value| json!({ "tree": tree, "indexed_at": store::now_s(), "ms": ms(t0), "parsed": parsed, "reused": reused, "counts": counts });
    let mut _lock = None;
    if !a.worktree {
        if let Some(s) = Store::read(&st.tree_path(&tree)) {
            let e = entry(
                0,
                s["files"].as_object().map_or(0, |f| f.len()),
                s["counts"].clone(),
            );
            st.record(&commit, e.clone(), a.at.is_none())?;
            let out = json!({ "ok": true, "commit": commit, "tree": tree, "cached": true, "parsed": 0, "ms": ms(t0), "counts": s["counts"] });
            return Ok(Built {
                out,
                snap: s,
                files: None,
                on_disk: HashMap::new(),
            });
        }
        _lock = st.lock(&tree)?;
        if _lock.is_none() {
            let s = Store::read(&st.tree_path(&tree)).ok_or(format!(
                "tree {tree}: another indexer held the lock past the wait and wrote no snapshot"
            ))?;
            let out = json!({ "ok": true, "commit": commit, "tree": tree, "cached": true, "parsed": 0, "ms": ms(t0), "counts": s["counts"] });
            return Ok(Built {
                out,
                snap: s,
                files: None,
                on_disk: HashMap::new(),
            });
        }
    }
    let mut phases = Map::new();
    let t = Instant::now();
    let mut files = git::ls_tree(&a.repo, &rev)?;
    // --worktree: changed and untracked files are hashed as they are on disk; their bytes come from disk, not the object store
    let mut on_disk: HashMap<String, String> = HashMap::new();
    let mut changed = vec![];
    if a.worktree {
        let (ch, del) = git::status(&a.repo)?;
        for d in &del {
            files.remove(d);
        }
        let ch: Vec<String> = ch
            .into_iter()
            .filter(|p| a.repo.join(p).is_file())
            .collect();
        for (p, sha) in ch.iter().zip(git::hash_paths(&a.repo, &ch)?) {
            files.insert(p.clone(), sha.clone());
            on_disk.insert(sha, p.clone());
        }
        changed = ch;
        changed.extend(del);
    }
    phases.insert("ls_tree_ms".into(), json!(ms(t)));

    let attrs: Vec<String> = files
        .keys()
        .filter(|p| paths::basename(p) == ".gitattributes")
        .cloned()
        .collect();
    let manifests: Vec<String> = files
        .keys()
        .filter(|p| MANIFESTS.contains(&paths::basename(p)))
        .cloned()
        .collect();
    let mut excluded: HashMap<String, String> = HashMap::new();
    let mut sources: Vec<(String, String)> = vec![];
    let t = Instant::now();
    let read = |shas: &[String]| -> Result<HashMap<String, Vec<u8>>, String> {
        let (disk, odb): (Vec<&String>, Vec<&String>) =
            shas.iter().partition(|s| on_disk.contains_key(*s));
        let mut m = git::cat_blobs(&a.repo, &odb.into_iter().cloned().collect::<Vec<_>>())?;
        for s in disk {
            m.insert(
                s.clone(),
                std::fs::read(a.repo.join(&on_disk[s]))
                    .map_err(|e| format!("{}: {e}", on_disk[s]))?,
            );
        }
        Ok(m)
    };
    let meta_shas: Vec<String> = attrs
        .iter()
        .chain(&manifests)
        .map(|p| files[p].clone())
        .collect();
    let meta = read(&meta_shas)?;
    let text_of = |p: &String| {
        String::from_utf8_lossy(&meta[&files[p]])
            .trim_start_matches('\u{feff}')
            .to_string()
    };
    let ex = exclude::Exclude::new(
        &attrs
            .iter()
            .map(|p| (p.clone(), text_of(p)))
            .collect::<Vec<_>>(),
        &a.exclude,
    );
    for p in files.keys() {
        if let Some(w) = ex.why(p) {
            excluded.insert(p.clone(), w);
        } else if lang_of(p).is_some() {
            sources.push((p.clone(), files[p].clone()));
        }
    }
    let text: HashMap<String, String> = manifests.iter().map(|p| (p.clone(), text_of(p))).collect();

    // blobs: the stored facts are reused; the rest is read in one cat-file batch and parsed in parallel
    type Pairs = Vec<(String, String)>;
    let (have, need): (Pairs, Pairs) = sources
        .par_iter()
        .cloned()
        .partition(|(_, sha)| st.blob_path(sha).is_file());
    let mut facts: HashMap<String, Value> = have
        .par_iter()
        .filter_map(|(p, sha)| Store::read(&st.blob_path(sha)).map(|f| (p.clone(), f)))
        .collect();
    let need: Vec<(String, String)> = need
        .into_iter()
        .chain(have.into_iter().filter(|(p, _)| !facts.contains_key(p)))
        .collect();
    let mut uniq: Vec<String> = need.iter().map(|(_, s)| s.clone()).collect();
    uniq.sort();
    uniq.dedup();
    let bytes = read(&uniq)?;
    phases.insert("read_ms".into(), json!(ms(t)));
    let t = Instant::now();
    let parsed: Vec<(String, String, Value)> = need
        .par_iter()
        .map(|(p, sha)| {
            let l = lang_of(p).expect("a source file has a language");
            (p.clone(), sha.clone(), lang::parse(l, p, &bytes[sha]))
        })
        .collect();
    phases.insert("parse_ms".into(), json!(ms(t)));
    let t = Instant::now();
    // in parallel: one file per blob, and file creation is the slow part on Windows
    let mut first: HashMap<&String, &Value> = HashMap::new();
    for (_, sha, f) in &parsed {
        first.entry(sha).or_insert(f);
    }
    first
        .par_iter()
        .map(|(sha, f)| Store::write(&st.blob_path(sha), f))
        .collect::<Result<Vec<()>, String>>()?;
    for (p, _, f) in parsed {
        facts.insert(p, f);
    }
    phases.insert("blob_write_ms".into(), json!(ms(t)));
    for (p, f) in &facts {
        if f["generated"] == json!(true) {
            excluded.insert(p.clone(), "generated header".into());
        }
    }
    let first_party: HashMap<String, Value> = facts
        .into_iter()
        .filter(|(p, _)| !excluded.contains_key(p))
        .collect();

    let t = Instant::now();
    let ctx = Ctx::new(&files, &first_party, &text, &a.python_roots);
    let mut out = Out::default();
    for l in LANGS {
        l.resolve(&ctx, &mut out);
    }
    let mut fm = Map::new();
    let mut paths_all: Vec<&String> = files
        .keys()
        .filter(|p| {
            lang_of(p).is_some()
                || MANIFESTS.contains(&paths::basename(p))
                || excluded.contains_key(*p)
        })
        .collect();
    paths_all.sort();
    for p in paths_all {
        let mut e = out.info.remove(p).unwrap_or_default();
        e.insert(
            "lang".into(),
            json!(lang_of(p).map_or("manifest", |l| l.name())),
        );
        if lang_of(p).is_none() && !MANIFESTS.contains(&paths::basename(p)) {
            e.insert("lang".into(), Value::Null);
        }
        if let Some(w) = excluded.get(p) {
            e.insert("excluded".into(), json!(w));
        }
        if first_party
            .get(p)
            .is_some_and(|f| f["parse_error"] == json!(true))
        {
            e.insert("parse_error".into(), json!(true));
        }
        fm.insert(p.clone(), Value::Object(e));
    }
    for e in &mut out.edges {
        let to = e["to"].as_str().unwrap_or("").to_string();
        if excluded.contains_key(&to) {
            e["to_kind"] = json!("excluded");
        } else if ctx.is_dir(&to) && !ctx.is_file(&to) {
            e["to_kind"] = json!("namespace");
        } else if !fm.contains_key(&to) {
            fm.insert(to.clone(), json!({ "lang": Value::Null }));
        }
    }
    let key = |e: &Value| {
        (
            e["from"].as_str().unwrap_or("").to_string(),
            e["line"].as_u64(),
            e["to"].as_str().unwrap_or("").to_string(),
            e["kind"].as_str().unwrap_or("").to_string(),
            e["spec"].as_str().unwrap_or("").to_string(),
        )
    };
    out.edges.sort_by_key(key);
    out.unresolved.sort_by_key(key);
    // the inverted name index: each name a first-party definition has -> the first-party files whose identifiers hold it, each file
    // as its number in `name_files` (sorted), which keeps the snapshot small
    let mut fp: Vec<(&String, &Value)> = first_party.iter().collect();
    fp.sort_by(|x, y| x.0.cmp(y.0));
    fn list<'v>(f: &'v Value, k: &str) -> &'v [Value] {
        f[k].as_array().map_or(&[], |v| v.as_slice())
    }
    let n_defs: usize = fp.iter().map(|(_, f)| list(f, "defs").len()).sum();
    let def_names: HashSet<&str> = fp
        .iter()
        .flat_map(|(_, f)| list(f, "defs"))
        .filter_map(|d| d["name"].as_str())
        .collect();
    let mut names: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (i, (_, f)) in fp.iter().enumerate() {
        for n in list(f, "names").iter().filter_map(Value::as_str) {
            if def_names.contains(n) {
                names.entry(n.to_string()).or_default().push(i);
            }
        }
    }
    let name_files: Vec<&String> = fp.iter().map(|(p, _)| *p).collect();
    phases.insert("resolve_ms".into(), json!(ms(t)));
    let counts = json!({ "files": fm.len(), "sources": sources.len(), "excluded": excluded.len(), "edges": out.edges.len(), "unresolved": out.unresolved.len(), "defs": n_defs });
    let reused = sources.len() - need.len();
    let snap = json!({ "schema": limits::STORE_SCHEMA, "commit": commit, "tree": tree, "worktree": a.worktree, "files": fm, "edges": out.edges, "unresolved": out.unresolved, "name_files": name_files, "names": names, "counts": counts });
    if a.worktree {
        let out = json!({ "ok": true, "commit": commit, "tree": tree, "worktree": true, "changed": changed, "parsed": need.len(), "reused": reused, "ms": ms(t0), "phases": phases });
        return Ok(Built {
            out,
            snap,
            files: Some(files),
            on_disk,
        });
    }
    let t = Instant::now();
    Store::write(&st.tree_path(&tree), &snap)?;
    st.record(
        &commit,
        entry(need.len(), reused, counts.clone()),
        a.at.is_none(),
    )?;
    phases.insert("write_ms".into(), json!(ms(t)));
    let out = json!({ "ok": true, "commit": commit, "tree": tree, "cached": false, "parsed": need.len(), "reused": reused, "ms": ms(t0), "phases": phases, "counts": counts });
    Ok(Built {
        out,
        snap,
        files: Some(files),
        on_disk,
    })
}

/// a stored definition of `file` with the tree's qualification: qual = `<file>#<path>` (JS / TS), `<module>.<path>` (Python),
/// `<module>::<path>` (Rust; a file no crate reaches has no module: its path alone); id = file#qual#n, n counting that qual
fn defs_of(file: &str, row: &Value, facts: &Value) -> Vec<Value> {
    let module = row["module"].as_str().unwrap_or("");
    let mut seen: HashMap<String, usize> = HashMap::new();
    facts["defs"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|d| {
            let p = d["path"].as_str().unwrap_or("");
            let qual = match facts["lang"].as_str() {
                Some("js") => format!("{file}#{p}"),
                Some("py") if !module.is_empty() => format!("{module}.{p}"),
                Some("rs") if !module.is_empty() => format!("{module}::{p}"),
                _ => p.to_string(),
            };
            let n = seen.entry(qual.clone()).or_insert(0);
            let id = format!("{file}#{qual}#{n}");
            *n += 1;
            json!({ "id": id, "file": file, "name": d["name"], "qual": qual, "kind": d["kind"], "line": d["line"], "end_line": d["end_line"], "col": d["col"],
                "exported": d["exported"], "hash": d["hash"], "tokens": d["tokens"] })
        })
        .collect()
}

/// `norn-code query symbols --file F` (the file's definitions) | `query refs --name N` (the definitions named N and every other
/// occurrence of the name, found through the tree's name index), both over the asked commit's tree (indexed first when needed)
fn query(verb: &str, a: &Args, target: &str) -> Result<Value, String> {
    let b = index(a)?;
    let st = Store::new(&a.state);
    let files = match b.files {
        Some(f) => f,
        None => git::ls_tree(&a.repo, a.at.as_deref().unwrap_or("HEAD"))?,
    };
    let rows = &b.snap["files"];
    let facts_of = |f: &str| -> Result<Value, String> {
        let sha = files.get(f).ok_or(format!("unknown file {f}"))?;
        Store::read(&st.blob_path(sha)).ok_or(format!("{f}: its blob facts are not in the store"))
    };
    let mut res = json!({ "ok": true, "commit": b.out["commit"], "tree": b.out["tree"], "worktree": a.worktree });
    if a.worktree {
        res["changed"] = b.out["changed"].clone();
    }
    if verb == "symbols" {
        let row = rows.get(target).ok_or(format!(
            "unknown file {target} (not in the graph; paths are relative to the repo root)"
        ))?;
        if let Some(w) = row["excluded"].as_str() {
            return Err(format!(
                "{target} is excluded ({w}): the graph holds no symbols of it"
            ));
        }
        if lang_of(target).is_none() {
            return Err(format!("{target}: not a graph language"));
        }
        res["file"] = json!(target);
        res["defs"] = json!(defs_of(target, row, &facts_of(target)?));
        return Ok(res);
    }
    let holders: Vec<String> = b.snap["names"][target]
        .as_array()
        .ok_or(format!("no definition in the tree is named {target}"))?
        .iter()
        .filter_map(|v| {
            b.snap["name_files"][v.as_u64().unwrap_or(u64::MAX) as usize]
                .as_str()
                .map(str::to_string)
        })
        .collect();
    let mut defs = vec![];
    for f in &holders {
        defs.extend(
            defs_of(f, &rows[f], &facts_of(f)?)
                .into_iter()
                .filter(|d| d["name"] == json!(target)),
        );
    }
    let shas: Vec<String> = holders
        .iter()
        .map(|f| files[f].clone())
        .filter(|s| !b.on_disk.contains_key(s))
        .collect();
    let mut bytes = git::cat_blobs(&a.repo, &shas)?;
    for (sha, p) in &b.on_disk {
        if holders.contains(p) {
            bytes.insert(
                sha.clone(),
                std::fs::read(a.repo.join(p)).map_err(|e| format!("{p}: {e}"))?,
            );
        }
    }
    let unique = if defs.len() == 1 {
        Some(defs[0]["id"].clone())
    } else {
        None
    };
    let refs: Vec<Value> = holders
        .par_iter()
        .flat_map_iter(|f| {
            let l = lang_of(f).expect("a holder is a source file");
            let src = &bytes[&files[f]];
            lang::with_tree(l, f, src, |_, tq, tree| {
                symbols::occurrences(l.name(), tq, tree, src, target)
            })
            .unwrap_or_default()
            .into_iter()
            .map(|(line, col)| {
                let mut r = json!({ "file": f, "line": line, "col": col, "name": target });
                if let Some(id) = &unique {
                    r["def_ids"] = json!([id]);
                    r["how"] = json!("unique");
                }
                r
            })
            .collect::<Vec<_>>()
        })
        .collect();
    res["name"] = json!(target);
    res["defs"] = json!(defs);
    res["refs"] = json!(refs);
    Ok(res)
}

/// the call graph of the asked commit's tree: every first-party source file's facts and defs, read from the store
fn graph_of(a: &Args) -> Result<(Value, calls::Graph), String> {
    let b = index(a)?;
    let st = Store::new(&a.state);
    let files = match b.files {
        Some(f) => f,
        None => git::ls_tree(&a.repo, a.at.as_deref().unwrap_or("HEAD"))?,
    };
    let rows = b.snap["files"].as_object().cloned().unwrap_or_default();
    let srcs: Vec<(&String, &Value)> = rows
        .iter()
        .filter(|(p, r)| lang_of(p).is_some() && r["excluded"].is_null() && files.contains_key(*p))
        .collect();
    let facts: HashMap<String, (Value, Vec<Value>)> = srcs
        .par_iter()
        .map(|(p, r)| {
            let f = Store::read(&st.blob_path(&files[*p]))
                .ok_or(format!("{p}: its blob facts are not in the store"))?;
            let d = defs_of(p, r, &f);
            Ok(((*p).clone(), (f, d)))
        })
        .collect::<Result<_, String>>()?;
    let mut stamp = json!({ "ok": true, "commit": b.out["commit"], "tree": b.out["tree"], "worktree": a.worktree });
    if a.worktree {
        stamp["changed"] = b.out["changed"].clone();
    }
    Ok((stamp, calls::Graph::new(&b.snap, facts)))
}

/// `query calls --file F` (each call site of F, resolved) | `query calls --all` (the count of call sites per language and how)
fn query_calls(a: &Args, target: &str) -> Result<Value, String> {
    let (mut res, g) = graph_of(a)?;
    if target != "--all" {
        if !g.files.contains_key(target) {
            return Err(format!(
                "unknown file {target} (not a first-party source of the graph)"
            ));
        }
        res["file"] = json!(target);
        res["calls"] = json!(g.sites(target).into_iter().map(|x| x.0).collect::<Vec<_>>());
        return Ok(res);
    }
    let mut counts: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();
    let all: Vec<(String, Vec<String>)> = g
        .files
        .par_iter()
        .map(|(p, f)| {
            (
                f.lang.clone(),
                g.sites(p)
                    .into_iter()
                    .map(|x| x.0["how"].as_str().unwrap_or("").to_string())
                    .collect(),
            )
        })
        .collect();
    for (l, hows) in all {
        for h in hows {
            *counts.entry(l.clone()).or_default().entry(h).or_default() += 1;
        }
    }
    res["counts"] = json!(counts);
    Ok(res)
}

/// `query callers --symbol <id | file:name> [--depth N]`: every call site whose candidates hold the def; depth > 1 walks on to the
/// callers of each calling def (each row once, at its first depth)
fn query_callers(a: &Args, symbol: &str, depth: usize) -> Result<Value, String> {
    let (mut res, g) = graph_of(a)?;
    let d = if symbol.contains('#') {
        g.def_by_id(symbol)
            .ok_or(format!("no definition has the id {symbol}"))?
    } else {
        let (file, name) = symbol
            .rsplit_once(':')
            .ok_or(format!("{symbol}: name a symbol id or file:name"))?;
        let f = g.files.get(file).ok_or(format!(
            "unknown file {file} (not a first-party source of the graph)"
        ))?;
        let hits: Vec<usize> = (0..f.defs.len())
            .filter(|&i| f.defs[i]["name"] == json!(name))
            .collect();
        match hits.as_slice() {
            [i] => (file.to_string(), *i),
            [] => return Err(format!("{file} defines no {name}")),
            _ => {
                let ids: Vec<&str> = hits
                    .iter()
                    .filter_map(|&i| f.defs[i]["id"].as_str())
                    .collect();
                return Err(format!(
                    "{file} defines {} named {name}; name one by id: {}",
                    hits.len(),
                    ids.join(", ")
                ));
            }
        }
    };
    let mut paths: Vec<&String> = g.files.keys().collect();
    paths.sort();
    let sites: Vec<(Value, Vec<(String, usize)>)> =
        paths.par_iter().flat_map_iter(|p| g.sites(p)).collect();
    let (mut rows, mut seen, mut frontier) = (vec![], HashSet::new(), vec![d.clone()]);
    for level in 1..=depth.max(1) {
        let mut next = vec![];
        for (row, targets) in &sites {
            if !targets.iter().any(|t| frontier.contains(t))
                || !seen.insert((row["file"].clone(), row["line"].clone(), row["col"].clone()))
            {
                continue;
            }
            let mut r = row.clone();
            let caller = row["caller"].as_str().and_then(|id| g.def_by_id(id));
            r["caller"] = caller.as_ref().map_or(Value::Null, |c| g.def_value(c));
            r["depth"] = json!(level);
            if let Some(c) = caller {
                next.push(c);
            }
            rows.push(r);
        }
        frontier = next;
        if frontier.is_empty() {
            break;
        }
    }
    res["symbol"] = g.def_value(&d);
    res["callers"] = json!(rows);
    Ok(res)
}

const QUERY_USAGE: &str = "usage: norn-code query symbols --file F | refs --name N | calls --file F | calls --all | callers --symbol <id | file:name> [--depth N], then the index arguments";

fn main() {
    let v: Vec<String> = std::env::args().skip(1).collect();
    let r = match v.first().map(String::as_str) {
        Some("version") => Ok(json!({ "crate": env!("CARGO_PKG_VERSION"), "store_schema": limits::STORE_SCHEMA })),
        Some("index") => args(&v[1..]).and_then(|a| index(&a)).map(|b| {
            let mut o = b.out;
            if o["worktree"] == json!(true) {
                o["snapshot"] = b.snap;
            }
            o
        }),
        Some("query") => match (v.get(1).map(String::as_str), v.get(2).map(String::as_str), v.get(3)) {
            (Some("symbols"), Some("--file"), Some(t)) => args(&v[4..]).and_then(|a| query("symbols", &a, t)),
            (Some("refs"), Some("--name"), Some(t)) => args(&v[4..]).and_then(|a| query("refs", &a, t)),
            (Some("calls"), Some("--file"), Some(t)) => args(&v[4..]).and_then(|a| query_calls(&a, t)),
            (Some("calls"), Some("--all"), _) => args(&v[3..]).and_then(|a| query_calls(&a, "--all")),
            (Some("callers"), Some("--symbol"), Some(t)) => {
                let (depth, rest) = match v.get(4).map(String::as_str) {
                    Some("--depth") => match v.get(5).and_then(|n| n.parse::<usize>().ok()) {
                        Some(n) if n >= 1 => (Ok(n), &v[6..]),
                        _ => (Err("--depth needs a whole number >= 1".to_string()), &v[6.min(v.len())..]),
                    },
                    _ => (Ok(1), &v[4..]),
                };
                depth.and_then(|d| args(rest).and_then(|a| query_callers(&a, t, d)))
            }
            _ => Err(QUERY_USAGE.into()),
        },
        _ => Err(format!("usage: norn-code index --repo D --state S [--at REV] [--worktree] [--exclude GLOB]... [--python-root DIR]...  |  {QUERY_USAGE}  |  norn-code version")),
    };
    match r {
        Ok(j) => println!("{j}"),
        Err(e) => {
            println!("{}", json!({ "ok": false, "why": e }));
            std::process::exit(1);
        }
    }
}
