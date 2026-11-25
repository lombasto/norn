// Definitions and name occurrences of one blob (SPEC code-graph 4.2, stage S2). The grammars' TAGS_QUERY plus our own patterns
// (each language's `tags()`) find the definition nodes; the node kind and its ancestors give the Def kind, the in-file path
// (`Class.method`, `<Type as Trait>::fmt`), the bounds and the exported flag; a normalised token hash of the node lets a consumer
// (slop K9, copied helpers) compare bodies with no other read. `names` are the distinct identifiers of the blob: the tree's inverted
// name index (name -> files) is built from them, so references are found by parsing only the files that hold a name.
use crate::lang::{pos, text};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet};
use streaming_iterator::StreamingIterator;
use tree_sitter::{Node, Query, QueryCursor, Tree};

/// one definition found in a blob, before the tree gives it its module
pub struct Found<'t> {
    pub node: Node<'t>,
    pub name: String,
    pub name_at: (usize, usize),
    pub kind: &'static str,
    pub path: String,
    pub exported: bool,
}

/// the separator of an in-file path's segments
fn sep(lang: &str) -> &'static str {
    if lang == "rs" {
        "::"
    } else {
        "."
    }
}

/// a Rust type's bare name: `Foo<T>` -> Foo, `&'a mut a::Foo` -> Foo, `dyn Tr` -> Tr
fn type_name(s: &str) -> String {
    let s = s.split('<').next().unwrap_or(s);
    let s = s
        .split_whitespace()
        .last()
        .unwrap_or(s)
        .trim_start_matches('&');
    s.rsplit("::").next().unwrap_or(s).to_string()
}

fn parent_skipping<'t>(n: Node<'t>, skip: &[&str]) -> Option<Node<'t>> {
    let mut p = n.parent();
    while let Some(x) = p {
        if !skip.contains(&x.kind()) {
            return Some(x);
        }
        p = x.parent();
    }
    None
}

/// the Def kind of a definition node from its tag (`definition.<tag>`), or None (a macro, a type alias: not a Def kind)
fn kind_of(lang: &str, tag: &str, n: Node) -> Option<&'static str> {
    Some(match (tag, n.kind()) {
        ("macro", _) | (_, "type_item") => return None,
        (_, "struct_item" | "union_item") => "struct",
        (_, "enum_item" | "enum_declaration") => "enum",
        ("interface", _) => "trait",
        ("module", _) => "module",
        ("constant", _) => "const",
        ("impl", _) => "impl",
        ("class", _) => "class",
        ("method", _) if lang != "rs" => "method",
        ("method" | "function", _) => {
            let p = match lang {
                "py" => parent_skipping(n, &["decorated_definition"])
                    .filter(|b| b.kind() == "block")
                    .and_then(|b| b.parent()),
                "rs" => n
                    .parent()
                    .filter(|d| d.kind() == "declaration_list")
                    .and_then(|d| d.parent()),
                _ => None,
            };
            match p.map(|p| p.kind()) {
                Some("class_definition" | "impl_item" | "trait_item") => "method",
                _ => "function",
            }
        }
        _ => return None,
    })
}

/// a JS def that is only the inner node of another def (`const f = function g() {}`): the outer one stands for it
fn inner_js(n: Node, at: &HashSet<usize>) -> bool {
    matches!(n.kind(), "function_expression" | "class" | "arrow_function")
        && n.parent().is_some_and(|p| at.contains(&p.id()))
}

/// a `const` declarator (not let / var): a JS constant
fn js_const(n: Node, src: &[u8]) -> bool {
    n.parent()
        .is_some_and(|d| d.kind() == "lexical_declaration" && text(d, src).starts_with("const"))
}

/// the names a JS module exports by a clause, a default identifier or CommonJS (`module.exports = { a }`, `exports.a = a`)
fn js_exports(root: Node, src: &[u8]) -> HashSet<String> {
    let mut out = HashSet::new();
    let mut c = root.walk();
    for s in root.children(&mut c) {
        match s.kind() {
            "export_statement" if s.child_by_field_name("source").is_none() => {
                let mut c2 = s.walk();
                for k in s.children(&mut c2) {
                    if k.kind() == "export_clause" {
                        let mut c3 = k.walk();
                        for sp in k
                            .children(&mut c3)
                            .filter(|x| x.kind() == "export_specifier")
                        {
                            if let Some(n) = sp.child_by_field_name("name") {
                                out.insert(text(n, src).to_string());
                            }
                        }
                    }
                }
                if let Some(v) = s
                    .child_by_field_name("value")
                    .filter(|v| v.kind() == "identifier")
                {
                    out.insert(text(v, src).to_string());
                }
            }
            "expression_statement" => {
                let Some(a) = s
                    .named_child(0)
                    .filter(|a| a.kind() == "assignment_expression")
                else {
                    continue;
                };
                let (Some(l), Some(r)) = (
                    a.child_by_field_name("left"),
                    a.child_by_field_name("right"),
                ) else {
                    continue;
                };
                let l = text(l, src);
                if !(l == "module.exports"
                    || l.starts_with("module.exports.")
                    || l.starts_with("exports."))
                {
                    continue;
                }
                match r.kind() {
                    "identifier" => {
                        out.insert(text(r, src).to_string());
                    }
                    "object" => {
                        let mut c2 = r.walk();
                        for p in r.named_children(&mut c2) {
                            let v = match p.kind() {
                                "shorthand_property_identifier" => Some(p),
                                "pair" => p
                                    .child_by_field_name("value")
                                    .filter(|v| v.kind() == "identifier"),
                                _ => None,
                            };
                            if let Some(v) = v {
                                out.insert(text(v, src).to_string());
                            }
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    out
}

/// Python's `__all__ = [...]` at module level, when the file has one
fn py_all(root: Node, src: &[u8]) -> Option<HashSet<String>> {
    let mut c = root.walk();
    for s in root
        .children(&mut c)
        .filter(|s| s.kind() == "expression_statement")
    {
        let Some(a) = s.named_child(0).filter(|a| a.kind() == "assignment") else {
            continue;
        };
        if a.child_by_field_name("left").map(|l| text(l, src)) != Some("__all__") {
            continue;
        }
        let r = a.child_by_field_name("right")?;
        let mut c2 = r.walk();
        let names = r
            .named_children(&mut c2)
            .filter(|x| x.kind() == "string")
            .map(|x| {
                text(x, src)
                    .trim_matches(|ch| ch == '"' || ch == '\'')
                    .to_string()
            })
            .collect();
        return Some(names);
    }
    None
}

/// a Rust item with the plain `pub` visibility (not pub(crate) / pub(super))
fn is_pub(n: Node, src: &[u8]) -> bool {
    let mut c = n.walk();
    let v = n
        .children(&mut c)
        .any(|k| k.kind() == "visibility_modifier" && text(k, src) == "pub");
    v
}

fn py_public(name: &str) -> bool {
    !name.starts_with('_') || (name.starts_with("__") && name.ends_with("__") && name.len() > 4)
}

/// every definition of the blob, in source order (outer before inner)
pub fn find<'t>(lang: &str, q: &Query, tree: &'t Tree, src: &[u8]) -> Vec<Found<'t>> {
    let names: Vec<&str> = q.capture_names().to_vec();
    let mut cur = QueryCursor::new();
    let mut it = cur.matches(q, tree.root_node(), src);
    // node id -> (node, name node, tag); a node matched twice keeps the first tag, except that a constant gives way to a function
    let mut by: HashMap<usize, (Node<'t>, Option<Node<'t>>, String)> = HashMap::new();
    while let Some(m) = it.next() {
        let mut def = None;
        let mut name = None;
        for c in m.captures() {
            let cn = names[c.index as usize];
            if let Some(tag) = cn.strip_prefix("definition.") {
                def = Some((c.node, tag.to_string()));
            } else if cn == "name" {
                name = Some(c.node);
            }
        }
        let Some((n, tag)) = def else { continue };
        match by.get(&n.id()) {
            Some((_, _, t)) if t != "constant" => {}
            _ => {
                by.insert(n.id(), (n, name, tag));
            }
        }
    }
    let mut v: Vec<(Node<'t>, Option<Node<'t>>, String)> = by.into_values().collect();
    v.sort_by_key(|(n, _, _)| (n.start_byte(), std::cmp::Reverse(n.end_byte())));
    let ids: HashSet<usize> = v.iter().map(|x| x.0.id()).collect();
    let root = tree.root_node();
    let (js_ex, py_ex) = match lang {
        "js" => (js_exports(root, src), None),
        "py" => (HashSet::new(), py_all(root, src)),
        _ => (HashSet::new(), None),
    };
    let mut out: Vec<Found<'t>> = vec![];
    let mut index: HashMap<usize, usize> = HashMap::new();
    for (n, name_node, tag) in v {
        if lang == "js"
            && (inner_js(n, &ids)
                || (tag == "constant" && n.kind() == "variable_declarator" && !js_const(n, src)))
        {
            continue;
        }
        let Some(kind) = kind_of(lang, &tag, n) else {
            continue;
        };
        let (name, seg, name_at) = if kind == "impl" {
            let ty = n
                .child_by_field_name("type")
                .map(|t| type_name(text(t, src)))
                .unwrap_or_default();
            let seg = match n.child_by_field_name("trait") {
                Some(t) => format!("<{ty} as {}>", type_name(text(t, src))),
                None => ty.clone(),
            };
            (ty, seg, pos(n))
        } else {
            let Some(nn) = name_node else { continue };
            let t = text(nn, src).to_string();
            (t.clone(), t, pos(nn))
        };
        // the nearest enclosing definition that was kept
        let mut p = n.parent();
        let parent = loop {
            match p {
                Some(x) => match index.get(&x.id()) {
                    Some(&i) => break Some(i),
                    None => p = x.parent(),
                },
                None => break None,
            }
        };
        let path = match parent {
            Some(i) => format!("{}{}{seg}", out[i].path, sep(lang)),
            None => seg,
        };
        let exported = match lang {
            "rs" => is_pub(n, src),
            "py" => match parent {
                None => py_ex
                    .as_ref()
                    .map_or(py_public(&name), |a| a.contains(&name)),
                Some(i) => out[i].kind == "class" && out[i].exported && py_public(&name),
            },
            _ => match parent {
                None => {
                    let mut top = n;
                    while let Some(x) = top.parent().filter(|x| x.id() != root.id()) {
                        top = x;
                    }
                    let left = n.child_by_field_name("left").map(|l| text(l, src));
                    top.kind() == "export_statement"
                        || js_ex.contains(&name)
                        || left.is_some_and(|l| {
                            l.starts_with("module.exports") || l.starts_with("exports.")
                        })
                }
                Some(i) => {
                    kind == "method"
                        && matches!(out[i].kind, "class" | "trait")
                        && out[i].exported
                        && !name.starts_with('#')
                }
            },
        };
        index.insert(n.id(), out.len());
        out.push(Found {
            node: n,
            name,
            name_at,
            kind,
            path,
            exported,
        });
    }
    out
}

/// 1-based inclusive line bounds of a node (a node ending at column 0 ends on the line before)
pub fn bounds(n: Node) -> (usize, usize) {
    let (s, e) = (n.start_position(), n.end_position());
    let end = if e.column == 0 && e.row > s.row {
        e.row
    } else {
        e.row + 1
    };
    (s.row + 1, end)
}

/// each leaf token of a node in order, comments left out
fn leaves<'t>(n: Node<'t>, f: &mut impl FnMut(Node<'t>)) {
    let mut stack = vec![n];
    while let Some(x) = stack.pop() {
        if x.kind().contains("comment") {
            continue;
        }
        if x.child_count() == 0 {
            f(x);
            continue;
        }
        let mut c = x.walk();
        let kids: Vec<Node<'t>> = x.children(&mut c).collect();
        stack.extend(kids.into_iter().rev());
    }
}

/// the normalised body hash (FNV-1a 64 over the leaf tokens, comments and whitespace left out, the def's own name read as `$`)
/// and the token count
pub fn body_hash(d: &Found, src: &[u8]) -> (String, usize) {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut n = 0;
    leaves(d.node, &mut |x| {
        let t = if pos(x) == d.name_at && text(x, src) == d.name {
            "$"
        } else {
            text(x, src)
        };
        for b in t.bytes().chain([0u8]) {
            h ^= b as u64;
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
        n += 1;
    });
    (format!("{h:016x}"), n)
}

fn is_name(kind: &str) -> bool {
    kind.ends_with("identifier")
}

/// each identifier leaf of the tree
fn idents<'t>(tree: &'t Tree, f: &mut impl FnMut(Node<'t>)) {
    leaves(tree.root_node(), &mut |x| {
        if is_name(x.kind()) {
            f(x)
        }
    });
}

/// a blob's stored symbol facts: ({ defs: [...] with a class's `bases`, names: [distinct identifiers, sorted] }, its call facts)
pub fn facts(
    lang: &str,
    q: &Query,
    tree: &Tree,
    src: &[u8],
) -> (Value, Value, crate::calls::Extracted) {
    let found = find(lang, q, tree, src);
    let ex = crate::calls::extract(lang, tree, src, &found);
    let defs: Vec<Value> = found
        .iter()
        .enumerate()
        .map(|(i, d)| {
            let (line, end_line) = bounds(d.node);
            let (hash, tokens) = body_hash(d, src);
            let mut v = json!({ "name": d.name, "path": d.path, "kind": d.kind, "line": line, "end_line": end_line, "col": d.node.start_position().column + 1,
                "exported": d.exported, "hash": hash, "tokens": tokens });
            if let Some(b) = ex.bases.get(&i) {
                v["bases"] = json!(b);
            }
            v
        })
        .collect();
    let mut names = BTreeSet::new();
    idents(tree, &mut |x| {
        names.insert(text(x, src).to_string());
    });
    (Value::Array(defs), json!(names), ex)
}

/// the (line, col) of each occurrence of identifier `name` in the tree that is not a definition's own name
pub fn occurrences(
    lang: &str,
    q: &Query,
    tree: &Tree,
    src: &[u8],
    name: &str,
) -> Vec<(usize, usize)> {
    let own: HashSet<(usize, usize)> = find(lang, q, tree, src)
        .iter()
        .filter(|d| d.name == name)
        .map(|d| d.name_at)
        .collect();
    let mut v = vec![];
    idents(tree, &mut |x| {
        if text(x, src) == name && !own.contains(&pos(x)) {
            v.push(pos(x));
        }
    });
    v
}

#[cfg(test)]
mod tests {
    use crate::lang::{lang_of, parse};
    use serde_json::Value;

    fn defs(path: &str, src: &str) -> Vec<(String, String, u64, u64, bool)> {
        let f = parse(lang_of(path).unwrap(), path, src.as_bytes());
        f["defs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| {
                (
                    d["path"].as_str().unwrap().to_string(),
                    d["kind"].as_str().unwrap().to_string(),
                    d["line"].as_u64().unwrap(),
                    d["end_line"].as_u64().unwrap(),
                    d["exported"] == Value::Bool(true),
                )
            })
            .collect()
    }
    fn s(p: &str, k: &str, l: u64, e: u64, x: bool) -> (String, String, u64, u64, bool) {
        (p.into(), k.into(), l, e, x)
    }

    #[test]
    fn python_classes_methods_and_bounds() {
        let src = "__all__ = ['A']\n\nclass A:\n    @staticmethod\n    def m(x):\n        return x\n\n    def _p(self):\n        pass\n\n\ndef f():\n    def g():\n        pass\n";
        assert_eq!(
            defs("m.py", src),
            vec![
                s("__all__", "const", 1, 1, false),
                s("A", "class", 3, 9, true),
                s("A.m", "method", 5, 6, true),
                s("A._p", "method", 8, 9, false),
                s("f", "function", 12, 14, false),
                s("f.g", "function", 13, 14, false),
            ]
        );
    }

    #[test]
    fn rust_impls_with_self_type_and_trait() {
        let src = "pub struct S<T>(T);\nimpl<T> S<T> {\n    pub fn new() {}\n}\nimpl std::fmt::Display for S<u8> {\n    fn fmt(&self) {}\n}\nmod inner {\n    pub(crate) const K: u8 = 1;\n}\n";
        assert_eq!(
            defs("a.rs", src),
            vec![
                s("S", "struct", 1, 1, true),
                s("S", "impl", 2, 4, false),
                s("S::new", "method", 3, 3, true),
                s("<S as Display>", "impl", 5, 7, false),
                s("<S as Display>::fmt", "method", 6, 6, false),
                s("inner", "module", 8, 10, false),
                s("inner::K", "const", 9, 9, false),
            ]
        );
    }

    #[test]
    fn js_functions_arrows_classes_and_exports() {
        let src = "export function a() {}\nconst b = () => 1;\nlet c = 2;\nclass K {\n  m() {}\n}\nmodule.exports = { b };\n";
        assert_eq!(
            defs("x.js", src),
            vec![
                s("a", "function", 1, 1, true),
                s("b", "function", 2, 2, true),
                s("K", "class", 4, 6, false),
                s("K.m", "method", 5, 5, false)
            ]
        );
        let ts = "export interface I { x(): void }\nexport enum E { A }\nexport class C { f = () => 1; }\n";
        assert_eq!(
            defs("x.ts", ts),
            vec![
                s("I", "trait", 1, 1, true),
                s("I.x", "method", 1, 1, true),
                s("E", "enum", 2, 2, true),
                s("C", "class", 3, 3, true),
                s("C.f", "method", 3, 3, true)
            ]
        );
    }

    #[test]
    fn a_copied_body_under_another_name_hashes_the_same() {
        let f = parse(lang_of("h.py").unwrap(), "h.py", b"def one(x):\n    # a\n    return x + 1\n\ndef two(x):\n    return x  +  1\n\ndef three(x):\n    return x + 2\n");
        let h: Vec<&str> = f["defs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["hash"].as_str().unwrap())
            .collect();
        assert_eq!(h[0], h[1]);
        assert_ne!(h[0], h[2]);
    }
}
