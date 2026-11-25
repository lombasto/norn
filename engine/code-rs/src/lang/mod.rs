// The languages of the code graph (SPEC code-graph 3.3: a fourth one is a grammar crate, one file here and one LANGS row).
// Two passes: extract() runs per blob (in parallel, its output stored content-addressed in blobs/), resolve() runs once over the
// whole tree (manifests + every first-party file's stored facts) and writes edges with their `kind` and `how`.
use crate::limits::SPEC_MAX;
use serde_json::{json, Map, Value};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use streaming_iterator::StreamingIterator;
use tree_sitter::{Language, Node, Parser, Query, QueryCursor, Tree};

pub mod js;
pub mod py;
pub mod rs;

pub trait Lang: Sync {
    fn name(&self) -> &'static str;
    fn exts(&self) -> &'static [&'static str];
    /// (grammar key, grammar) for a file extension: one language may hold several grammars (JS, TS, TSX)
    fn grammar(&self, ext: &str) -> (&'static str, Language);
    fn import_query(&self) -> &'static str;
    /// this blob's facts from the import query's matches: { imports: [...], ... }
    fn extract(&self, q: &Query, tree: &Tree, src: &[u8]) -> Map<String, Value>;
    /// every edge and unresolved import of this language's files in the tree
    fn resolve(&self, ctx: &Ctx, out: &mut Out);
}

pub static LANGS: [&dyn Lang; 3] = [&js::Js, &py::Py, &rs::Rs];

/// the manifests resolution reads (by file name), next to the language files
pub const MANIFESTS: [&str; 5] = [
    "package.json",
    "tsconfig.json",
    "jsconfig.json",
    "pyproject.toml",
    "Cargo.toml",
];

pub fn lang_of(path: &str) -> Option<&'static dyn Lang> {
    let e = crate::paths::ext(path);
    LANGS.iter().copied().find(|l| l.exts().contains(&e))
}

thread_local! {
    // compiled once per thread, never per rayon split (SPEC section 6: per split made the same parse 3.0 s instead of 1.1 s)
    static TOOLS: RefCell<HashMap<&'static str, (Parser, Query)>> = RefCell::new(HashMap::new());
}

/// parse one blob -> its stored facts { lang, generated, parse_error, imports, ... }
pub fn parse(l: &dyn Lang, path: &str, src: &[u8]) -> Value {
    let (key, lang) = l.grammar(crate::paths::ext(path));
    let mut facts = TOOLS.with(|t| {
        let mut t = t.borrow_mut();
        let (p, q) = t.entry(key).or_insert_with(|| {
            let mut p = Parser::new();
            p.set_language(&lang).expect("grammar ABI");
            (
                p,
                Query::new(&lang, l.import_query()).expect("import query"),
            )
        });
        match p.parse(src, None) {
            Some(tree) => {
                let mut f = l.extract(q, &tree, src);
                f.insert("parse_error".into(), json!(tree.root_node().has_error()));
                f
            }
            None => Map::from_iter([
                ("imports".to_string(), json!([])),
                ("parse_failed".to_string(), json!(true)),
            ]),
        }
    });
    facts.insert("lang".into(), json!(l.name()));
    facts.insert("generated".into(), json!(crate::exclude::generated(src)));
    Value::Object(facts)
}

/// each match of `q` over the tree as (pattern index, [(capture name, node)])
pub fn matches<'q, 't>(
    q: &'q Query,
    tree: &'t Tree,
    src: &[u8],
) -> Vec<(usize, Vec<(&'q str, Node<'t>)>)> {
    let names: Vec<&'q str> = q.capture_names().to_vec();
    let mut c = QueryCursor::new();
    let mut it = c.matches(q, tree.root_node(), src);
    let mut out = vec![];
    while let Some(m) = it.next() {
        out.push((
            m.pattern_index,
            m.captures()
                .iter()
                .map(|c| (names[c.index as usize], c.node))
                .collect(),
        ));
    }
    out
}
pub fn text<'s>(n: Node, src: &'s [u8]) -> &'s str {
    n.utf8_text(src).unwrap_or("")
}
/// 1-based (line, col) of a node
pub fn pos(n: Node) -> (usize, usize) {
    let p = n.start_position();
    (p.row + 1, p.column + 1)
}

/// what resolution reads: the tree's files, the stored facts of its first-party language files, the manifest texts
pub struct Ctx<'a> {
    pub files: &'a HashMap<String, String>,
    pub dirs: HashSet<String>,
    pub facts: &'a HashMap<String, Value>,
    pub text: &'a HashMap<String, String>,
    pub python_roots: &'a [String],
}
impl<'a> Ctx<'a> {
    pub fn new(
        files: &'a HashMap<String, String>,
        facts: &'a HashMap<String, Value>,
        text: &'a HashMap<String, String>,
        python_roots: &'a [String],
    ) -> Ctx<'a> {
        let mut dirs = HashSet::new();
        dirs.insert(String::new());
        for p in files.keys() {
            let mut d = crate::paths::dirname(p);
            while !d.is_empty() && dirs.insert(d.to_string()) {
                d = crate::paths::dirname(d);
            }
        }
        Ctx {
            files,
            dirs,
            facts,
            text,
            python_roots,
        }
    }
    pub fn is_file(&self, p: &str) -> bool {
        self.files.contains_key(p)
    }
    pub fn is_dir(&self, p: &str) -> bool {
        self.dirs.contains(p)
    }
    /// the files of language `l` that have facts (first-party, parsed), sorted
    pub fn sources(&self, l: &str) -> Vec<(&'a String, &'a Value)> {
        let mut v: Vec<_> = self
            .facts
            .iter()
            .filter(|(_, f)| f["lang"] == json!(l))
            .collect();
        v.sort_by(|a, b| a.0.cmp(b.0));
        v
    }
    /// manifests with this file name, sorted by path
    pub fn manifests(&self, name: &str) -> Vec<(&'a String, &'a String)> {
        let mut v: Vec<_> = self
            .text
            .iter()
            .filter(|(p, _)| crate::paths::basename(p) == name)
            .collect();
        v.sort();
        v
    }
}

/// a resolution's output: edges, unresolved imports, per-file info (crate, module, orphan)
#[derive(Default)]
pub struct Out {
    pub edges: Vec<Value>,
    pub unresolved: Vec<Value>,
    pub info: HashMap<String, Map<String, Value>>,
    seen: HashSet<(String, String, String)>,
}
pub fn clip(s: &str) -> String {
    s.chars().take(SPEC_MAX).collect()
}
impl Out {
    /// one edge per (from, to, kind): the first occurrence keeps its line; no edge from a file to itself
    #[allow(
        clippy::too_many_arguments,
        reason = "an edge record is these eight fields; a struct built at every call site would only restate them"
    )]
    pub fn edge(
        &mut self,
        from: &str,
        to: &str,
        line: usize,
        col: usize,
        kind: &str,
        how: &str,
        spec: &str,
        alts: &[String],
    ) {
        if from == to || !self.seen.insert((from.into(), to.into(), kind.into())) {
            return;
        }
        let mut e = json!({ "from": from, "to": to, "line": line, "col": col, "kind": kind, "how": how, "spec": clip(spec) });
        if !alts.is_empty() {
            e["alts"] = json!(alts);
        }
        self.edges.push(e);
    }
    /// an import kept unresolved: how external (with its package) or unresolved (with why)
    pub fn unres(
        &mut self,
        from: &str,
        line: usize,
        kind: &str,
        how: &str,
        spec: &str,
        extra: (&str, &str),
    ) {
        self.unresolved.push(json!({ "from": from, "line": line, "kind": kind, "how": how, "spec": clip(spec), extra.0: extra.1 }));
    }
    pub fn external(&mut self, from: &str, line: usize, kind: &str, spec: &str, package: &str) {
        self.unres(from, line, kind, "external", spec, ("package", package));
    }
    pub fn missing(&mut self, from: &str, line: usize, kind: &str, spec: &str, why: &str) {
        self.unres(from, line, kind, "unresolved", spec, ("why", why));
    }
}

/// a raw import's (line, col)
pub fn lc(i: &Value) -> (usize, usize) {
    (
        i["line"].as_u64().unwrap_or(0) as usize,
        i["col"].as_u64().unwrap_or(0) as usize,
    )
}
