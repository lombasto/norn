// Call edges (SPEC code-graph 4.2 "Call edges", stage S3). Extraction runs per blob, beside the definitions: each call site
// `[line, col, name, form, recv, in, parse_error]` (the callee's name node; form plain `f()` | member `x.f()` | path `a::f()`; recv the
// receiver or path text when it is a plain name chain; `in` the index of the innermost enclosing def), the import bindings
// (`binds`: local name -> what it names), the bases of each class and the JS default export. Resolution runs at query time over the
// whole tree (every first-party blob's facts plus the snapshot's rows and import edges) and gives each site one `how` of the call
// table: local | import | qualified | self | method-unique | ambiguous | external, or unresolved with its why. Several candidates
// are never narrowed to one: they are `ambiguous`, all of them kept.
use crate::lang::{pos, text};
use crate::symbols::Found;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use tree_sitter::{Node, Tree};

/// a follow of re-exports / use paths stops after this many hops (a cycle of re-exports ends here)
const FOLLOW_MAX: usize = 8;
/// an answer lists at most this many candidates; the rest is counted in `more` (SPEC 4.2)
pub const CANDIDATES_MAX: usize = 20;

const PY_BUILTINS: &[&str] = &[
    "abs",
    "aiter",
    "all",
    "anext",
    "any",
    "ascii",
    "bin",
    "bool",
    "breakpoint",
    "bytearray",
    "bytes",
    "callable",
    "chr",
    "classmethod",
    "compile",
    "complex",
    "delattr",
    "dict",
    "dir",
    "divmod",
    "enumerate",
    "eval",
    "exec",
    "exit",
    "filter",
    "float",
    "format",
    "frozenset",
    "getattr",
    "globals",
    "hasattr",
    "hash",
    "help",
    "hex",
    "id",
    "input",
    "int",
    "isinstance",
    "issubclass",
    "iter",
    "len",
    "list",
    "locals",
    "map",
    "max",
    "memoryview",
    "min",
    "next",
    "object",
    "oct",
    "open",
    "ord",
    "pow",
    "print",
    "property",
    "quit",
    "range",
    "repr",
    "reversed",
    "round",
    "set",
    "setattr",
    "slice",
    "sorted",
    "staticmethod",
    "str",
    "sum",
    "super",
    "tuple",
    "type",
    "vars",
    "zip",
    "__import__",
    "BaseException",
    "Exception",
    "ArithmeticError",
    "AssertionError",
    "AttributeError",
    "BlockingIOError",
    "BrokenPipeError",
    "BufferError",
    "ConnectionError",
    "DeprecationWarning",
    "EOFError",
    "EnvironmentError",
    "FileExistsError",
    "FileNotFoundError",
    "FloatingPointError",
    "FutureWarning",
    "GeneratorExit",
    "ImportError",
    "IndexError",
    "InterruptedError",
    "IsADirectoryError",
    "KeyError",
    "KeyboardInterrupt",
    "LookupError",
    "MemoryError",
    "ModuleNotFoundError",
    "NameError",
    "NotADirectoryError",
    "NotImplementedError",
    "OSError",
    "OverflowError",
    "PermissionError",
    "ProcessLookupError",
    "RecursionError",
    "ReferenceError",
    "RuntimeError",
    "RuntimeWarning",
    "StopAsyncIteration",
    "StopIteration",
    "SyntaxError",
    "SystemError",
    "SystemExit",
    "TimeoutError",
    "TypeError",
    "UnboundLocalError",
    "UnicodeDecodeError",
    "UnicodeEncodeError",
    "UnicodeError",
    "UserWarning",
    "ValueError",
    "Warning",
    "ZeroDivisionError",
];
const JS_GLOBALS: &[&str] = &[
    "AbortController",
    "AggregateError",
    "Array",
    "ArrayBuffer",
    "BigInt",
    "Blob",
    "Boolean",
    "Buffer",
    "DataView",
    "Date",
    "Error",
    "EvalError",
    "Event",
    "EventTarget",
    "Float32Array",
    "Float64Array",
    "FormData",
    "Function",
    "Headers",
    "Int16Array",
    "Int32Array",
    "Int8Array",
    "Intl",
    "JSON",
    "Map",
    "Math",
    "Number",
    "Object",
    "Promise",
    "Proxy",
    "RangeError",
    "ReferenceError",
    "Reflect",
    "RegExp",
    "Request",
    "Response",
    "Set",
    "String",
    "Symbol",
    "SyntaxError",
    "TextDecoder",
    "TextEncoder",
    "TypeError",
    "URIError",
    "URL",
    "URLSearchParams",
    "Uint16Array",
    "Uint32Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "WeakMap",
    "WeakRef",
    "WeakSet",
    "Worker",
    "atob",
    "btoa",
    "clearInterval",
    "clearImmediate",
    "clearTimeout",
    "console",
    "decodeURI",
    "decodeURIComponent",
    "document",
    "encodeURI",
    "encodeURIComponent",
    "eval",
    "fetch",
    "globalThis",
    "isFinite",
    "isNaN",
    "navigator",
    "parseFloat",
    "parseInt",
    "process",
    "queueMicrotask",
    "require",
    "requestAnimationFrame",
    "setImmediate",
    "setInterval",
    "setTimeout",
    "structuredClone",
    "window",
];
/// the Rust prelude's callables and types (a path head or plain callee of these is the standard library)
const RS_PRELUDE: &[&str] = &[
    "Some",
    "None",
    "Ok",
    "Err",
    "Box",
    "Vec",
    "String",
    "Option",
    "Result",
    "drop",
    "Default",
    "Clone",
    "Iterator",
    "IntoIterator",
    "From",
    "Into",
    "ToString",
    "ToOwned",
    "PartialEq",
    "Eq",
    "Ord",
    "PartialOrd",
    "AsRef",
    "AsMut",
    "Fn",
    "FnMut",
    "FnOnce",
    "Send",
    "Sync",
    "Sized",
    "Drop",
    "Extend",
    "DoubleEndedIterator",
    "ExactSizeIterator",
    "TryFrom",
    "TryInto",
    "FromIterator",
    "char",
    "str",
    "u8",
    "u16",
    "u32",
    "u64",
    "u128",
    "usize",
    "i8",
    "i16",
    "i32",
    "i64",
    "i128",
    "isize",
    "f32",
    "f64",
    "bool",
];

/// what extraction adds to a blob's facts
pub struct Extracted {
    pub calls: Value,
    pub binds: Value,
    /// def index -> the names of its bases (Python superclasses, JS `extends`)
    pub bases: HashMap<usize, Vec<String>>,
    pub default: Option<String>,
}

/// a receiver / path that is a plain chain of names (`a`, `a.b`, `self.x`, `this`), else None (a call result, an index, ...)
fn chain(n: Node, src: &[u8]) -> Option<String> {
    match n.kind() {
        "identifier"
        | "this"
        | "self"
        | "super"
        | "property_identifier"
        | "field_identifier"
        | "type_identifier" => Some(text(n, src).to_string()),
        "member_expression" | "attribute" | "field_expression" => {
            let (o, p) = match n.kind() {
                "member_expression" => ("object", "property"),
                "attribute" => ("object", "attribute"),
                _ => ("value", "field"),
            };
            let o = chain(n.child_by_field_name(o)?, src)?;
            let p = n.child_by_field_name(p)?;
            (p.kind().ends_with("identifier")).then(|| format!("{o}.{}", text(p, src)))
        }
        _ => None,
    }
}

/// `Vec::<u8>::new` -> `Vec::new`, `HashMap<K, V>` -> `HashMap`: generic arguments left out of a Rust path
fn strip_generics(s: &str) -> String {
    let (mut out, mut depth) = (String::new(), 0);
    for c in s.chars() {
        match c {
            '<' => depth += 1,
            '>' if depth > 0 => depth -= 1,
            c if depth == 0 && !c.is_whitespace() => out.push(c),
            _ => {}
        }
    }
    out.replace("::::", "::").trim_end_matches("::").to_string()
}

/// the callee of a call node -> (name node, form, receiver / path text)
fn callee<'t>(lang: &str, n: Node<'t>, src: &[u8]) -> Option<(Node<'t>, u8, Option<String>)> {
    let f = match (lang, n.kind()) {
        ("js", "call_expression") | ("py", "call") | ("rs", "call_expression") => {
            n.child_by_field_name("function")?
        }
        ("js", "new_expression") => n.child_by_field_name("constructor")?,
        _ => return None,
    };
    let f = if f.kind() == "generic_function" {
        f.child_by_field_name("function")?
    } else {
        f
    };
    match f.kind() {
        "identifier" => Some((f, 0, None)),
        "member_expression" | "attribute" | "field_expression" => {
            let (o, p) = match f.kind() {
                "member_expression" => ("object", "property"),
                "attribute" => ("object", "attribute"),
                _ => ("value", "field"),
            };
            let p = f.child_by_field_name(p)?;
            if !p.kind().ends_with("identifier") {
                return None;
            }
            Some((p, 1, f.child_by_field_name(o).and_then(|o| chain(o, src))))
        }
        "scoped_identifier" => {
            let name = f.child_by_field_name("name")?;
            let path = f
                .child_by_field_name("path")
                .map(|p| strip_generics(text(p, src)));
            Some((name, 2, path))
        }
        _ => None,
    }
}

/// `use a::{b as c, d::*}` -> [(a::b, c), (a::d, *)]: each path with the name it binds
pub fn use_binds(s: &str) -> Vec<(String, String)> {
    let s = strip_generics(
        &s.split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .replace(" as ", "\u{1}"),
    );
    fn go(s: &str, out: &mut Vec<(String, String)>, prefix: &str) {
        let join = |x: &str| {
            if prefix.is_empty() {
                x.to_string()
            } else {
                format!("{prefix}::{x}")
            }
        };
        let s = s.trim();
        let Some(i) = s.find('{') else {
            let (p, alias) = s
                .split_once('\u{1}')
                .map_or((s, None), |(p, a)| (p, Some(a)));
            let (full, last) = match p {
                "self" => (
                    prefix.to_string(),
                    prefix.rsplit("::").next().unwrap_or("").to_string(),
                ),
                _ => (join(p), p.rsplit("::").next().unwrap_or(p).to_string()),
            };
            if last == "*" {
                out.push((full.trim_end_matches("::*").to_string(), "*".into()));
            } else {
                out.push((full, alias.map_or(last, str::to_string)));
            }
            return;
        };
        let pre = join(s[..i].trim_end_matches("::"));
        let pre = pre.trim_end_matches("::");
        let inner = &s[i + 1..s.rfind('}').unwrap_or(s.len())];
        let (mut depth, mut st) = (0, 0);
        for (j, c) in inner.char_indices() {
            match c {
                '{' => depth += 1,
                '}' => depth -= 1,
                ',' if depth == 0 => {
                    go(&inner[st..j], out, pre);
                    st = j + 1;
                }
                _ => {}
            }
        }
        if !inner[st..].trim().is_empty() {
            go(&inner[st..], out, pre);
        }
    }
    let mut out = vec![];
    go(&s, &mut out, "");
    out
}

fn js_binds(n: Node, src: &[u8], out: &mut Vec<Value>) {
    let spec_of = |s: Node| {
        text(s, src)
            .trim_matches(|c| c == '"' || c == '\'' || c == '`')
            .to_string()
    };
    match n.kind() {
        "import_statement" => {
            let Some(spec) = n.child_by_field_name("source").map(spec_of) else {
                return;
            };
            let mut c = n.walk();
            for cl in n.children(&mut c).filter(|x| x.kind() == "import_clause") {
                let mut c2 = cl.walk();
                for k in cl.named_children(&mut c2) {
                    match k.kind() {
                        "identifier" => out.push(
                            json!({ "local": text(k, src), "name": "default", "spec": spec }),
                        ),
                        "namespace_import" => {
                            if let Some(id) = k.named_child(0) {
                                out.push(
                                    json!({ "local": text(id, src), "name": "*", "spec": spec }),
                                );
                            }
                        }
                        "named_imports" => {
                            let mut c3 = k.walk();
                            for sp in k
                                .named_children(&mut c3)
                                .filter(|x| x.kind() == "import_specifier")
                            {
                                let Some(name) = sp.child_by_field_name("name") else {
                                    continue;
                                };
                                let local = sp.child_by_field_name("alias").unwrap_or(name);
                                out.push(json!({ "local": text(local, src), "name": text(name, src), "spec": spec }));
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        "export_statement" => {
            let Some(spec) = n.child_by_field_name("source").map(spec_of) else {
                return;
            };
            let mut c = n.walk();
            let kids: Vec<Node> = n.children(&mut c).collect();
            if let Some(cl) = kids.iter().find(|x| x.kind() == "export_clause") {
                let mut c2 = cl.walk();
                for sp in cl
                    .named_children(&mut c2)
                    .filter(|x| x.kind() == "export_specifier")
                {
                    let Some(name) = sp.child_by_field_name("name") else {
                        continue;
                    };
                    let local = sp.child_by_field_name("alias").unwrap_or(name);
                    out.push(
                        json!({ "local": text(local, src), "name": text(name, src), "spec": spec }),
                    );
                }
            } else if let Some(ns) = kids.iter().find(|x| x.kind() == "namespace_export") {
                if let Some(id) = ns.named_child(0) {
                    out.push(json!({ "local": text(id, src), "name": "*", "spec": spec }));
                }
            } else if kids.iter().any(|x| x.kind() == "*") {
                out.push(json!({ "local": "*", "name": "*", "spec": spec }));
            }
        }
        "variable_declarator" => {
            let (Some(name), Some(v)) = (
                n.child_by_field_name("name"),
                n.child_by_field_name("value"),
            ) else {
                return;
            };
            let v = if v.kind() == "await_expression" {
                v.named_child(0).unwrap_or(v)
            } else {
                v
            };
            if v.kind() != "call_expression"
                || v.child_by_field_name("function").map(|f| text(f, src)) != Some("require")
            {
                return;
            }
            let Some(arg) = v
                .child_by_field_name("arguments")
                .and_then(|a| a.named_child(0))
                .filter(|a| a.kind() == "string")
            else {
                return;
            };
            let spec = spec_of(arg);
            match name.kind() {
                "identifier" => {
                    out.push(json!({ "local": text(name, src), "name": "*", "spec": spec }))
                }
                "object_pattern" => {
                    let mut c = name.walk();
                    for p in name.named_children(&mut c) {
                        match p.kind() {
                            "shorthand_property_identifier_pattern" => {
                                out.push(json!({ "local": text(p, src), "name": text(p, src), "spec": spec }))
                            }
                            "pair_pattern" => {
                                if let (Some(k), Some(l)) = (p.child_by_field_name("key"), p.child_by_field_name("value")) {
                                    if l.kind() == "identifier" {
                                        out.push(json!({ "local": text(l, src), "name": text(k, src), "spec": spec }));
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }
        _ => {}
    }
}

fn py_binds(n: Node, src: &[u8], out: &mut Vec<Value>) {
    let line = pos(n).0;
    let name_alias = |x: Node| -> Option<(String, String)> {
        match x.kind() {
            "dotted_name" => Some((text(x, src).to_string(), text(x, src).to_string())),
            "aliased_import" => {
                let nm = text(x.child_by_field_name("name")?, src).to_string();
                Some((nm, text(x.child_by_field_name("alias")?, src).to_string()))
            }
            _ => None,
        }
    };
    match n.kind() {
        "import_statement" => {
            let mut c = n.walk();
            for x in n.children_by_field_name("name", &mut c) {
                if let Some((m, local)) = name_alias(x) {
                    out.push(json!({ "local": local, "name": "", "module": m, "level": 0, "line": line }));
                }
            }
        }
        "import_from_statement" => {
            let Some(m) = n.child_by_field_name("module_name") else {
                return;
            };
            let (level, module) = if m.kind() == "relative_import" {
                let mut c = m.walk();
                let kids: Vec<Node> = m.children(&mut c).collect();
                let level = kids
                    .iter()
                    .find(|x| x.kind() == "import_prefix")
                    .map_or(0, |x| text(*x, src).matches('.').count());
                let module = kids
                    .iter()
                    .find(|x| x.kind() == "dotted_name")
                    .map_or("", |d| text(*d, src));
                (level, module.to_string())
            } else {
                (0, text(m, src).to_string())
            };
            let mut c = n.walk();
            let mut any = false;
            for x in n.children_by_field_name("name", &mut c) {
                if let Some((nm, local)) = name_alias(x) {
                    any = true;
                    out.push(json!({ "local": local, "name": nm, "module": module, "level": level, "line": line }));
                }
            }
            let mut c = n.walk();
            if !any && n.children(&mut c).any(|x| x.kind() == "wildcard_import") {
                out.push(json!({ "local": "*", "name": "*", "module": module, "level": level, "line": line }));
            }
        }
        _ => {}
    }
}

/// a blob's call sites, import bindings, class bases and JS default export (`defs` as find() gave them, in the stored order)
/// the identifiers a pattern binds (a path in a pattern - `Some`, `E::V`, a type - binds nothing)
fn binds_name(p: Node, name: &str, src: &[u8]) -> bool {
    match p.kind() {
        "identifier" | "shorthand_property_identifier_pattern" | "shorthand_field_identifier" => {
            text(p, src) == name
        }
        "scoped_identifier" | "type_identifier" | "type_annotation" | "predefined_type" => false,
        _ => {
            let mut c = p.walk();
            let kids: Vec<(Option<&str>, Node)> = p
                .children(&mut c)
                .enumerate()
                .map(|(i, k)| (p.field_name_for_child(i as u32), k))
                .collect();
            // a `{ key: target }` pattern binds its value; elsewhere a value, default or guard is an expression
            let pair = p.kind() == "pair_pattern";
            kids.into_iter().any(|(f, k)| match f {
                Some("value") => pair && binds_name(k, name, src),
                Some("type" | "right" | "key" | "default" | "condition") => false,
                _ => binds_name(k, name, src),
            })
        }
    }
}

/// Rust: a call `name()` whose name is a local variable (a `let`, a fn / closure parameter, a `for` / `match` / `if let` pattern of
/// an enclosing block, before the call) - a closure or fn pointer, never an item: it shadows every def and import of the name. The
/// climb ends at the enclosing fn item (a nested fn sees no local of the fn around it).
fn rs_var(n: Node, name: &str, src: &[u8]) -> bool {
    let (at, mut p) = (n.start_byte(), n.parent());
    while let Some(x) = p {
        let hit = match x.kind() {
            "block" => {
                let mut c = x.walk();
                let kids: Vec<Node> = x.named_children(&mut c).collect();
                kids.into_iter().any(|k| {
                    k.kind() == "let_declaration"
                        && k.end_byte() <= at
                        && k.child_by_field_name("pattern")
                            .is_some_and(|q| binds_name(q, name, src))
                })
            }
            "function_item" | "closure_expression" => x
                .child_by_field_name("parameters")
                .is_some_and(|q| binds_name(q, name, src)),
            "for_expression" | "match_arm" | "let_condition" => x
                .child_by_field_name("pattern")
                .is_some_and(|q| binds_name(q, name, src)),
            _ => false,
        };
        if hit {
            return true;
        }
        if matches!(
            x.kind(),
            "function_item" | "impl_item" | "trait_item" | "mod_item"
        ) {
            return false;
        }
        p = x.parent();
    }
    false
}

/// JS / TS: what a member call's receiver `recv` is bound to locally, the nearest enclosing declaration first: `["lit"]` (a literal,
/// a function or class expression, an operator's result), `["new", C]`, `["call", F]`, `["ref", X]` (another name), `["type", T]`
/// (a TS annotation); None when no local binding is found or its value is unknown (an untyped parameter, a destructured name).
/// `let x;` with no value takes the first `x = ...` assignment of its scope.
fn js_bound(n: Node, recv: &str, src: &[u8]) -> Option<Value> {
    fn value(e: Node, src: &[u8]) -> Option<Value> {
        match e.kind() {
            "await_expression"
            | "parenthesized_expression"
            | "as_expression"
            | "satisfies_expression"
            | "non_null_expression" => {
                let mut c = e.walk();
                let k = e.named_children(&mut c).next()?;
                value(k, src)
            }
            "object"
            | "array"
            | "string"
            | "template_string"
            | "number"
            | "regex"
            | "true"
            | "false"
            | "null"
            | "undefined"
            | "arrow_function"
            | "function_expression"
            | "function"
            | "class"
            | "binary_expression"
            | "unary_expression" => Some(json!(["lit"])),
            "new_expression" => {
                chain(e.child_by_field_name("constructor")?, src).map(|c| json!(["new", c]))
            }
            "call_expression" => {
                chain(e.child_by_field_name("function")?, src).map(|f| json!(["call", f]))
            }
            "identifier" | "member_expression" => chain(e, src).map(|x| json!(["ref", x])),
            _ => None,
        }
    }
    fn typed(t: Node, src: &[u8]) -> Option<Value> {
        let mut c = t.walk();
        let k = t.named_children(&mut c).next()?;
        match k.kind() {
            "type_identifier" | "nested_type_identifier" => Some(json!(["type", text(k, src)])),
            "generic_type" => Some(json!(["type", text(k.child_by_field_name("name")?, src)])),
            "predefined_type" | "literal_type" | "array_type" | "tuple_type" | "object_type"
            | "function_type" => Some(json!(["lit"])),
            _ => None,
        }
    }
    /// the first `recv = ...` assignment under node x
    fn assigned<'t>(x: Node<'t>, recv: &str, src: &[u8]) -> Option<Node<'t>> {
        let mut stack = vec![x];
        let mut best: Option<Node> = None;
        while let Some(y) = stack.pop() {
            if y.kind() == "assignment_expression"
                && y.child_by_field_name("left")
                    .is_some_and(|l| l.kind() == "identifier" && text(l, src) == recv)
                && best.is_none_or(|b| y.start_byte() < b.start_byte())
            {
                best = Some(y);
            }
            let mut c = y.walk();
            stack.extend(y.named_children(&mut c));
        }
        best.and_then(|b| b.child_by_field_name("right"))
    }
    let mut p = n.parent();
    while let Some(x) = p {
        match x.kind() {
            "statement_block" | "program" | "class_static_block" | "switch_case" => {
                let mut c = x.walk();
                let mut decls: Vec<Node> = vec![];
                for k in x.named_children(&mut c) {
                    let k = if k.kind() == "export_statement" {
                        k.child_by_field_name("declaration").unwrap_or(k)
                    } else {
                        k
                    };
                    if matches!(k.kind(), "lexical_declaration" | "variable_declaration") {
                        let mut c2 = k.walk();
                        decls.extend(
                            k.named_children(&mut c2)
                                .filter(|d| d.kind() == "variable_declarator"),
                        );
                    }
                }
                for d in decls {
                    let Some(nm) = d.child_by_field_name("name") else {
                        continue;
                    };
                    if nm.kind() == "identifier" && text(nm, src) == recv {
                        return match d
                            .child_by_field_name("value")
                            .or_else(|| assigned(x, recv, src))
                        {
                            Some(v) => value(v, src),
                            None => d.child_by_field_name("type").and_then(|t| typed(t, src)),
                        };
                    }
                    if binds_name(nm, recv, src) {
                        return None;
                    }
                }
            }
            "function_declaration"
            | "function_expression"
            | "function"
            | "arrow_function"
            | "method_definition"
            | "generator_function_declaration"
            | "generator_function" => {
                if let Some(q) = x.child_by_field_name("parameter") {
                    if text(q, src) == recv {
                        return None;
                    }
                }
                if let Some(ps) = x.child_by_field_name("parameters") {
                    let mut c = ps.walk();
                    for q in ps.named_children(&mut c) {
                        let pat = q.child_by_field_name("pattern").unwrap_or(q);
                        if pat.kind() == "identifier" && text(pat, src) == recv {
                            return q.child_by_field_name("type").and_then(|t| typed(t, src));
                        }
                        if binds_name(pat, recv, src) {
                            return None;
                        }
                    }
                }
            }
            "catch_clause" | "for_in_statement" | "for_statement" => {
                let f = if x.kind() == "catch_clause" {
                    "parameter"
                } else if x.kind() == "for_in_statement" {
                    "left"
                } else {
                    "initializer"
                };
                if x.child_by_field_name(f)
                    .is_some_and(|q| binds_name(q, recv, src))
                {
                    return None;
                }
            }
            _ => {}
        }
        p = x.parent();
    }
    None
}

pub fn extract(lang: &str, tree: &Tree, src: &[u8], defs: &[Found]) -> Extracted {
    let at: HashMap<usize, usize> = defs
        .iter()
        .enumerate()
        .map(|(i, d)| (d.node.id(), i))
        .collect();
    let (mut calls, mut binds, mut bases, mut default) = (vec![], vec![], HashMap::new(), None);
    let mut stack = vec![tree.root_node()];
    while let Some(n) = stack.pop() {
        let mut c = n.walk();
        let kids: Vec<Node> = n.children(&mut c).collect();
        stack.extend(kids.into_iter().rev());
        match lang {
            "js" => js_binds(n, src, &mut binds),
            "py" => py_binds(n, src, &mut binds),
            _ => {
                if n.kind() == "use_declaration" {
                    if let Some(a) = n.child_by_field_name("argument") {
                        for (path, local) in use_binds(text(a, src)) {
                            binds.push(json!({ "local": local, "path": path }));
                        }
                    }
                }
            }
        }
        if lang == "js"
            && n.kind() == "export_statement"
            && n.child_by_field_name("source").is_none()
        {
            let mut c = n.walk();
            if n.children(&mut c).any(|k| k.kind() == "default") {
                let d = n
                    .child_by_field_name("declaration")
                    .and_then(|d| d.child_by_field_name("name"));
                let v = n
                    .child_by_field_name("value")
                    .filter(|v| v.kind() == "identifier");
                default = d.or(v).map(|x| text(x, src).to_string());
            }
        }
        if let Some(&i) = at.get(&n.id()) {
            let heritage = match lang {
                "py" => n.child_by_field_name("superclasses"),
                "js" => {
                    let mut c = n.walk();
                    let h = n.children(&mut c).find(|k| k.kind() == "class_heritage");
                    h.map(|h| {
                        let mut c2 = h.walk();
                        let e = h
                            .named_children(&mut c2)
                            .find(|k| k.kind() == "extends_clause");
                        e.unwrap_or(h)
                    })
                }
                _ => None,
            };
            if let Some(h) = heritage {
                let mut c = h.walk();
                let b: Vec<String> = h
                    .named_children(&mut c)
                    .filter_map(|x| chain(x, src))
                    .collect();
                if !b.is_empty() {
                    bases.insert(i, b);
                }
            }
        }
        let Some((name, form, recv)) = callee(lang, n, src) else {
            continue;
        };
        let (mut inn, mut err, mut p) = (None, false, n.parent());
        while let Some(x) = p {
            if inn.is_none() {
                inn = at.get(&x.id()).copied();
            }
            err |= x.is_error();
            p = x.parent();
        }
        let (line, col) = pos(name);
        let mut row = vec![
            json!(line),
            json!(col),
            json!(text(name, src)),
            json!(form),
            json!(recv),
            json!(inn),
            json!(err),
        ];
        let bound = match (lang, form, recv.as_deref()) {
            ("rs", 0, _) => rs_var(n, text(name, src), src).then(|| json!(["var"])),
            ("js", 1, Some(r)) if !r.contains('.') && !matches!(r, "this" | "super") => {
                js_bound(n, r, src)
            }
            _ => None,
        };
        row.extend(bound);
        calls.push(Value::Array(row));
    }
    Extracted {
        calls: Value::Array(calls),
        binds: Value::Array(binds),
        bases,
        default,
    }
}

// ---- resolution --------------------------------------------------------------------------------------------------------------

/// a definition: (file, index in that file's defs)
type D = (String, usize);

pub enum Res {
    /// candidates and the class that found them (more than one is `ambiguous`)
    Hit(&'static str, Vec<D>),
    /// a binding that names a module file (usable as a receiver, not as a callee)
    Module(Vec<String>),
    External(String),
    Unresolved(String),
    /// a by-name candidate (`method-unique`) the receiver's local binding argues against: `ambiguous`, its list kept, the why said
    Demoted(Vec<D>, String),
}

fn sep(lang: &str) -> &'static str {
    if lang == "rs" {
        "::"
    } else {
        "."
    }
}
/// an in-file path's parent (`A.m` -> A, `a::<S as T>::f` -> a::<S as T>, `f` -> "")
fn parent_of(path: &str, lang: &str) -> String {
    path.rsplit_once(sep(lang))
        .map_or(String::new(), |(a, _)| a.to_string())
}
fn s<'v>(v: &'v Value, k: &str) -> &'v str {
    v[k].as_str().unwrap_or("")
}

/// one file of the graph: its language, row, facts and qualified defs
pub struct File {
    pub lang: String,
    pub row: Value,
    pub facts: Value,
    pub defs: Vec<Value>,
    by_name: HashMap<String, Vec<usize>>,
    by_path: HashMap<String, Vec<usize>>,
}

impl File {
    /// the defs at an in-file path (a Rust type and its impl blocks share one)
    fn at<'a>(&'a self, path: &str) -> impl Iterator<Item = usize> + 'a {
        self.by_path.get(path).into_iter().flatten().copied()
    }
}

/// the whole tree, ready for resolving call sites
pub struct Graph {
    pub files: HashMap<String, File>,
    py_mod: HashMap<String, Vec<String>>,
    rs_mod: HashMap<(String, String), String>,
    rs_qual: HashMap<(String, String), Vec<D>>,
    rs_crates: HashMap<String, String>,
    js_to: HashMap<(String, String), Vec<String>>,
    js_ext: HashSet<(String, String)>,
    methods: HashMap<(String, String), Vec<D>>,
}

impl Graph {
    /// `facts`: path -> (stored blob facts, defs as defs_of gives them) of every first-party source file
    pub fn new(snap: &Value, facts: HashMap<String, (Value, Vec<Value>)>) -> Graph {
        let mut g = Graph {
            files: HashMap::new(),
            py_mod: HashMap::new(),
            rs_mod: HashMap::new(),
            rs_qual: HashMap::new(),
            rs_crates: HashMap::new(),
            js_to: HashMap::new(),
            js_ext: HashSet::new(),
            methods: HashMap::new(),
        };
        for e in snap["edges"].as_array().into_iter().flatten() {
            let tos = std::iter::once(&e["to"]).chain(e["alts"].as_array().into_iter().flatten());
            let v = g
                .js_to
                .entry((s(e, "from").into(), s(e, "spec").into()))
                .or_default();
            v.extend(tos.filter_map(Value::as_str).map(str::to_string));
        }
        for u in snap["unresolved"].as_array().into_iter().flatten() {
            g.js_ext.insert((s(u, "from").into(), s(u, "spec").into()));
        }
        let mut targets: HashMap<String, HashSet<String>> = HashMap::new();
        for (p, (f, defs)) in facts {
            let lang = s(&f, "lang").to_string();
            let row = snap["files"][&p].clone();
            let (mut by_name, mut by_path): (
                HashMap<String, Vec<usize>>,
                HashMap<String, Vec<usize>>,
            ) = Default::default();
            for (i, d) in f["defs"].as_array().into_iter().flatten().enumerate() {
                by_name.entry(s(d, "name").into()).or_default().push(i);
                by_path.entry(s(d, "path").into()).or_default().push(i);
                if s(d, "kind") == "method" {
                    g.methods
                        .entry((lang.clone(), s(d, "name").into()))
                        .or_default()
                        .push((p.clone(), i));
                }
            }
            match lang.as_str() {
                "py" => g
                    .py_mod
                    .entry(s(&row, "module").into())
                    .or_default()
                    .push(p.clone()),
                "rs" if row["target"].is_string() => {
                    let t = s(&row, "target").to_string();
                    g.rs_mod
                        .insert((t.clone(), s(&row, "module").into()), p.clone());
                    for (i, d) in defs.iter().enumerate() {
                        g.rs_qual
                            .entry((t.clone(), s(d, "qual").into()))
                            .or_default()
                            .push((p.clone(), i));
                    }
                    targets
                        .entry(s(&row, "crate").into())
                        .or_default()
                        .insert(t);
                }
                _ => {}
            }
            g.files.insert(
                p,
                File {
                    lang,
                    row,
                    facts: f,
                    defs,
                    by_name,
                    by_path,
                },
            );
        }
        for v in g.py_mod.values_mut() {
            v.sort();
        }
        for v in g.methods.values_mut() {
            v.sort();
        }
        // a workspace crate's library: its target named lib.rs, else its only target
        for (c, ts) in targets {
            let mut ts: Vec<String> = ts.into_iter().collect();
            ts.sort();
            let lib = ts
                .iter()
                .find(|t| t.ends_with("/lib.rs") || *t == "lib.rs")
                .cloned();
            if let Some(t) = lib.or_else(|| (ts.len() == 1).then(|| ts[0].clone())) {
                g.rs_crates.insert(c.replace('-', "_"), t);
            }
        }
        g
    }

    fn def(&self, d: &D) -> &Value {
        &self.files[&d.0].defs[d.1]
    }
    fn fact_def(&self, d: &D) -> &Value {
        &self.files[&d.0].facts["defs"][d.1]
    }
    fn binds<'a>(&'a self, file: &str, local: &'a str) -> impl Iterator<Item = &'a Value> + 'a {
        self.files[file].facts["binds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(move |b| s(b, "local") == local)
    }

    /// the enclosing scopes' in-file paths of a call in def `inn`, innermost first, ending with the file's top level ("")
    fn scopes(&self, file: &str, inn: Option<usize>) -> Vec<String> {
        let f = &self.files[file];
        let mut out = vec![];
        let Some(i) = inn else {
            return vec![String::new()];
        };
        let mut p = s(&f.facts["defs"][i], "path").to_string();
        let mut first = true;
        loop {
            let kinds: Vec<&str> = f.at(&p).map(|j| s(&f.facts["defs"][j], "kind")).collect();
            // a class or impl body is no scope of the methods inside it; a Rust module ends the climb
            if first
                || !kinds
                    .iter()
                    .any(|k| matches!(*k, "class" | "impl" | "trait"))
            {
                out.push(p.clone());
            }
            if kinds.contains(&"module") && f.lang == "rs" && !first {
                return out;
            }
            first = false;
            if p.is_empty() {
                return out;
            }
            p = parent_of(&p, &f.lang);
        }
    }

    /// `local`: a def named `name` in an enclosing scope of the same file (no method: a method is reached through its class)
    fn local(&self, file: &str, inn: Option<usize>, name: &str) -> Vec<D> {
        let f = &self.files[file];
        let Some(idx) = f.by_name.get(name) else {
            return vec![];
        };
        for sc in self.scopes(file, inn) {
            let hit: Vec<D> = idx
                .iter()
                .filter(|&&j| {
                    let d = &f.facts["defs"][j];
                    !matches!(s(d, "kind"), "method" | "impl")
                        && parent_of(s(d, "path"), &f.lang) == sc
                })
                .map(|&j| (file.to_string(), j))
                .collect();
            if !hit.is_empty() {
                return hit;
            }
        }
        vec![]
    }

    /// the top-level def `name` of a module file, through its imports and re-exports (`__init__`, `export {..} from`, `pub use`)
    fn top(&self, file: &str, name: &str, depth: usize) -> Res {
        if depth > FOLLOW_MAX {
            return Res::Unresolved(format!("re-export chain past {FOLLOW_MAX} hops"));
        }
        let Some(f) = self.files.get(file) else {
            return Res::Unresolved(format!("{file} is not in the graph"));
        };
        let hit: Vec<D> = f
            .by_name
            .get(name)
            .into_iter()
            .flatten()
            .filter(|&&j| s(&f.facts["defs"][j], "path") == name)
            .map(|&j| (file.to_string(), j))
            .collect();
        if !hit.is_empty() {
            return Res::Hit("import", hit);
        }
        if let Some(b) = self.binds(file, name).next() {
            return self.follow(file, b, depth + 1);
        }
        let mut found = vec![];
        for b in self.binds(file, "*") {
            for m in self.module_of(file, b, depth + 1) {
                if let Res::Hit(_, h) = self.top(&m, name, depth + 1) {
                    found.extend(h);
                }
            }
        }
        if !found.is_empty() {
            return Res::Hit("import", found);
        }
        Res::Unresolved(format!("{file} defines no {name}"))
    }

    /// the module files a star / namespace binding names
    fn module_of(&self, file: &str, b: &Value, depth: usize) -> Vec<String> {
        match self.follow(file, &json!({ "local": "*", "name": "*", "spec": b["spec"], "module": b["module"], "level": b["level"], "path": b["path"] }), depth) {
            Res::Module(m) => m,
            _ => vec![],
        }
    }

    /// what an import binding names: defs (`import`), a module, external, or unresolved
    fn follow(&self, file: &str, b: &Value, depth: usize) -> Res {
        if depth > FOLLOW_MAX {
            return Res::Unresolved(format!("re-export chain past {FOLLOW_MAX} hops"));
        }
        let name = s(b, "name");
        match self.files[file].lang.as_str() {
            "js" => {
                let key = (file.to_string(), s(b, "spec").to_string());
                let Some(tos) = self.js_to.get(&key) else {
                    return if self.js_ext.contains(&key) && !s(b, "spec").starts_with('.') {
                        Res::External(format!("package {}", s(b, "spec")))
                    } else {
                        Res::Unresolved(format!("import {} not resolved", s(b, "spec")))
                    };
                };
                if name == "*" {
                    return Res::Module(tos.clone());
                }
                self.union(tos.iter().map(|t| {
                    let n = if name == "default" {
                        match self.files.get(t).and_then(|f| f.facts["default"].as_str()) {
                            Some(n) => n,
                            None => {
                                return Res::Unresolved(format!("{t} has no named default export"))
                            }
                        }
                    } else {
                        name
                    };
                    self.top(t, n, depth + 1)
                }))
            }
            "py" => {
                let module = s(b, "module");
                let level = b["level"].as_u64().unwrap_or(0) as usize;
                let abs = if level == 0 {
                    module.to_string()
                } else {
                    let mut pkg: Vec<&str> = s(&self.files[file].row, "module")
                        .split('.')
                        .filter(|x| !x.is_empty())
                        .collect();
                    let up = if file.ends_with("__init__.py") {
                        level - 1
                    } else {
                        level
                    };
                    if up > pkg.len() {
                        return Res::Unresolved(format!(
                            "relative import above the root ({level} dots)"
                        ));
                    }
                    pkg.truncate(pkg.len() - up);
                    let mut v = pkg.join(".");
                    if !module.is_empty() {
                        v = if v.is_empty() {
                            module.to_string()
                        } else {
                            format!("{v}.{module}")
                        };
                    }
                    v
                };
                let missing = || {
                    if level == 0 {
                        Res::External(format!("module {}", abs.split('.').next().unwrap_or("")))
                    } else {
                        Res::Unresolved(format!("module {abs} not in the graph"))
                    }
                };
                if name.is_empty() || name == "*" {
                    return self
                        .py_mod
                        .get(&abs)
                        .map_or_else(missing, |m| Res::Module(m.clone()));
                }
                if let Some(m) = self.py_mod.get(&format!("{abs}.{name}")) {
                    return Res::Module(m.clone());
                }
                match self.py_mod.get(&abs) {
                    Some(ms) => self.union(ms.iter().map(|m| self.top(m, name, depth + 1))),
                    None => missing(),
                }
            }
            _ => {
                let segs: Vec<String> = s(b, "path").split("::").map(str::to_string).collect();
                if name == "*" {
                    return match self.rs_abs(file, &segs, depth + 1) {
                        Ok((t, abs)) => self
                            .rs_mod
                            .get(&(t, abs.join("::")))
                            .map_or(Res::Unresolved("glob of no module file".into()), |m| {
                                Res::Module(vec![m.clone()])
                            }),
                        Err(r) => r,
                    };
                }
                self.rs_path(file, &segs, depth + 1)
            }
        }
    }

    /// the results of several targets as one: all their candidates (ambiguous when more than one)
    fn union(&self, rs: impl Iterator<Item = Res>) -> Res {
        let (mut hits, mut mods, mut first_other) = (vec![], vec![], None);
        for r in rs {
            match r {
                Res::Hit(_, h) => hits.extend(h),
                Res::Module(m) => mods.extend(m),
                x => {
                    first_other.get_or_insert(x);
                }
            }
        }
        if !hits.is_empty() {
            hits.sort();
            hits.dedup();
            Res::Hit("import", hits)
        } else if !mods.is_empty() {
            Res::Module(mods)
        } else {
            first_other.unwrap_or(Res::Unresolved("no target".into()))
        }
    }

    /// method `name` of class def `c`, then of its bases by name (Python / JS)
    fn method_in(&self, c: &D, name: &str, depth: usize) -> Vec<D> {
        let f = &self.files[&c.0];
        let want = format!("{}{}{name}", s(self.fact_def(c), "path"), sep(&f.lang));
        let own: Vec<D> = f.at(&want).map(|j| (c.0.clone(), j)).collect();
        if !own.is_empty() {
            return own;
        }
        if depth > FOLLOW_MAX {
            return vec![];
        }
        let mut out = vec![];
        for b in self.fact_def(c)["bases"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            for k in self.classes(&c.0, None, b, depth + 1) {
                out.extend(self.method_in(&k, name, depth + 1));
            }
        }
        out
    }

    /// the class defs a name (or `mod.Name` chain) means in a file: local, then by its import binding
    fn classes(&self, file: &str, inn: Option<usize>, name: &str, depth: usize) -> Vec<D> {
        let is_class = |d: &D| {
            matches!(
                s(self.fact_def(d), "kind"),
                "class" | "struct" | "enum" | "trait"
            )
        };
        if let Some((recv, n)) = name.rsplit_once('.') {
            return match self.receiver(file, inn, recv, depth) {
                Some(Res::Module(ms)) => ms
                    .iter()
                    .filter_map(|m| match self.top(m, n, depth + 1) {
                        Res::Hit(_, h) => Some(h),
                        _ => None,
                    })
                    .flatten()
                    .filter(is_class)
                    .collect(),
                _ => vec![],
            };
        }
        let l = self.local(file, inn, name);
        if !l.is_empty() {
            return l.into_iter().filter(is_class).collect();
        }
        match self
            .binds(file, name)
            .next()
            .map(|b| self.follow(file, b, depth + 1))
        {
            Some(Res::Hit(_, h)) => h.into_iter().filter(is_class).collect(),
            _ => vec![],
        }
    }

    /// what a receiver chain names in a file (Python / JS): a module, a class (as Hit), external, or None (a value)
    fn receiver(&self, file: &str, inn: Option<usize>, recv: &str, depth: usize) -> Option<Res> {
        if let Some(b) = self.binds(file, recv).next() {
            return Some(self.follow(file, b, depth + 1));
        }
        if let Some((head, rest)) = recv.split_once('.') {
            // `pkg.mod` through `import pkg` / a namespace binding: the submodule, else the name in the module
            if let Some(Res::Module(ms)) = self.receiver(file, inn, head, depth + 1) {
                let mut cur = ms;
                for seg in rest.split('.') {
                    let sub: Vec<String> = cur
                        .iter()
                        .filter_map(|m| {
                            self.py_mod
                                .get(&format!("{}.{seg}", s(&self.files[m].row, "module")))
                        })
                        .flatten()
                        .cloned()
                        .collect();
                    if sub.is_empty() {
                        return None;
                    }
                    cur = sub;
                }
                return Some(Res::Module(cur));
            }
            return None;
        }
        let l = self.local(file, inn, recv);
        if !l.is_empty() {
            return Some(Res::Hit("qualified", l));
        }
        let lang = self.files[file].lang.as_str();
        if (lang == "js" && JS_GLOBALS.contains(&recv))
            || (lang == "py" && PY_BUILTINS.contains(&recv))
        {
            return Some(Res::External(format!("builtin {recv}")));
        }
        None
    }

    // ---- Rust paths ----

    fn rs_at(&self, file: &str) -> Option<(String, Vec<String>)> {
        let r = &self.files[file].row;
        let t = r["target"].as_str()?;
        Some((
            t.to_string(),
            s(r, "module").split("::").map(str::to_string).collect(),
        ))
    }

    /// a path written in `file` -> (crate target, absolute segments starting with `crate`)
    fn rs_abs(
        &self,
        file: &str,
        segs: &[String],
        depth: usize,
    ) -> Result<(String, Vec<String>), Res> {
        if depth > FOLLOW_MAX {
            return Err(Res::Unresolved(format!("use chain past {FOLLOW_MAX} hops")));
        }
        let (t, module) = self
            .rs_at(file)
            .ok_or(Res::Unresolved(format!("{file} is in no crate")))?;
        let head = segs[0].as_str();
        let rest = &segs[1..];
        let join =
            |base: &[String], rest: &[String]| base.iter().chain(rest).cloned().collect::<Vec<_>>();
        match head {
            "crate" => return Ok((t, segs.to_vec())),
            "self" => return Ok((t, join(&module, rest))),
            "super" => {
                let mut m = module.clone();
                let mut r = segs;
                while r.first().map(String::as_str) == Some("super") {
                    if m.len() <= 1 {
                        return Err(Res::Unresolved("super above the crate root".into()));
                    }
                    m.pop();
                    r = &r[1..];
                }
                return Ok((t, join(&m, r)));
            }
            "std" | "core" | "alloc" => return Err(Res::External(format!("crate {head}"))),
            _ => {}
        }
        if let Some(b) = self.binds(file, head).next() {
            let bs: Vec<String> = s(b, "path").split("::").map(str::to_string).collect();
            if bs.first().map(String::as_str) != Some(head) || bs.len() > 1 {
                return self.rs_abs(file, &join(&bs, rest), depth + 1);
            }
        }
        let mut here = module.clone();
        here.push(head.to_string());
        if self.rs_mod.contains_key(&(t.clone(), here.join("::")))
            || self.files[file].by_path.contains_key(head)
        {
            return Ok((t, join(&module, segs)));
        }
        if let Some(lib) = self.rs_crates.get(head) {
            return Ok((lib.clone(), join(&["crate".to_string()], rest)));
        }
        if RS_PRELUDE.contains(&head) {
            return Err(Res::External(format!("prelude {head}")));
        }
        if head.starts_with(|c: char| c.is_lowercase()) {
            return Err(Res::External(format!("crate {head}")));
        }
        Err(Res::Unresolved(format!("{head} is not in scope")))
    }

    /// methods named `name` of type `ty` in a crate target: inherent `Ty::name` and trait impls `<Ty as Tr>::name`
    fn rs_methods(&self, target: &str, ty: &str, name: &str) -> Vec<D> {
        let inherent = format!("{ty}::{name}");
        let tr = format!("<{ty} as ");
        let mut v: Vec<D> = self
            .methods
            .get(&("rs".to_string(), name.to_string()))
            .into_iter()
            .flatten()
            .filter(|d| {
                let p = s(self.fact_def(d), "path");
                let tail = p.rsplit_once("::").map_or("", |x| x.0);
                let tail = tail.rsplit("::").next().unwrap_or(tail);
                s(&self.files[&d.0].row, "target") == target
                    && (p.ends_with(&inherent) && tail == ty || tail.starts_with(&tr))
            })
            .cloned()
            .collect();
        v.sort();
        v
    }

    /// a full path written in `file` (last segment the callee) -> its definitions
    fn rs_path(&self, file: &str, segs: &[String], depth: usize) -> Res {
        let (t, abs) = match self.rs_abs(file, segs, depth) {
            Ok(x) => x,
            Err(r) => return r,
        };
        if let Some(h) = self.rs_qual.get(&(t.clone(), abs.join("::"))) {
            return Res::Hit("qualified", h.clone());
        }
        let (pre, name) = abs.split_at(abs.len() - 1);
        let name = &name[0];
        if let Some(ty) = self.rs_qual.get(&(t.clone(), pre.join("::"))) {
            if ty.iter().any(|d| s(self.fact_def(d), "kind") == "enum") {
                return Res::Unresolved(format!("{name}: an enum variant"));
            }
            let m = self.rs_methods(&t, pre.last().map_or("", String::as_str), name);
            if !m.is_empty() {
                return Res::Hit("qualified", m);
            }
        }
        // a `pub use` re-export in the module file of the prefix
        if let Some(mf) = self.rs_mod.get(&(t.clone(), pre.join("::"))) {
            if let Some(b) = self.binds(mf, name).next() {
                if depth <= FOLLOW_MAX {
                    let bs: Vec<String> = s(b, "path").split("::").map(str::to_string).collect();
                    return self.rs_path(mf, &bs, depth + 1);
                }
            }
            for b in self.binds(mf, "*") {
                let mut bs: Vec<String> = s(b, "path").split("::").map(str::to_string).collect();
                bs.push(name.clone());
                if let Res::Hit(h, d) = self.rs_path(mf, &bs, depth + 1) {
                    return Res::Hit(h, d);
                }
            }
        }
        Res::Unresolved(format!("no definition at {}", abs.join("::")))
    }

    /// the type of the impl enclosing def `inn` (Rust)
    fn impl_type(&self, file: &str, inn: Option<usize>) -> Option<String> {
        let f = &self.files[file];
        let mut p = s(&f.facts["defs"][inn?], "path").to_string();
        loop {
            if let Some(j) = f
                .at(&p)
                .find(|&j| matches!(s(&f.facts["defs"][j], "kind"), "impl" | "trait"))
            {
                return Some(s(&f.facts["defs"][j], "name").to_string());
            }
            if p.is_empty() {
                return None;
            }
            p = parent_of(&p, "rs");
        }
    }

    /// the class def enclosing def `inn` (Python / JS)
    fn class_of(&self, file: &str, inn: Option<usize>) -> Option<D> {
        let f = &self.files[file];
        let mut p = s(&f.facts["defs"][inn?], "path").to_string();
        loop {
            if let Some(j) = f
                .at(&p)
                .find(|&j| s(&f.facts["defs"][j], "kind") == "class")
            {
                return Some((file.to_string(), j));
            }
            if p.is_empty() {
                return None;
            }
            p = parent_of(&p, &f.lang);
        }
    }

    /// `method-unique` / `ambiguous` / `external`: `x.f()` on a receiver of unknown type, by the repo's methods named f
    fn by_method_name(&self, lang: &str, name: &str) -> Res {
        match self.methods.get(&(lang.to_string(), name.to_string())) {
            Some(v) if v.len() == 1 => Res::Hit("method-unique", v.clone()),
            Some(v) => Res::Hit("ambiguous", v.clone()),
            None => Res::External(format!("no repo method named {name}")),
        }
    }

    /// JS `x.f()` matched by name to the one repo method f: kept `method-unique` unless the receiver's local binding (extraction's
    /// `bound`) says its value is something else - a literal, a `new` / typed value whose class has no such method, the result of a
    /// call that is not the method's owner (the class or the function whose object holds it), or a package / builtin value.
    /// Then `ambiguous` with the one candidate and the why: a guess the binding contradicts is never an edge (S4b grade, S6).
    fn vet(
        &self,
        file: &str,
        inn: Option<usize>,
        r: &str,
        name: &str,
        b: &Value,
        v: Vec<D>,
    ) -> Res {
        let d = &v[0];
        let f = &self.files[&d.0];
        let op = parent_of(s(self.fact_def(d), "path"), &f.lang);
        let owner: Vec<D> = f.at(&op).map(|j| (d.0.clone(), j)).collect();
        let (k, x) = (b[0].as_str().unwrap_or(""), b[1].as_str().unwrap_or(""));
        // the receiver names the owner itself (`const o = { f() {} }; o.f()`): the binding agrees
        let named = self.local(file, inn, r).iter().any(|l| owner.contains(l));
        let why = match k {
            _ if named => None,
            "lit" => Some(format!(
                "receiver {r} holds a literal, not an object of {op}"
            )),
            "new" | "type" => {
                let cls = self.classes(file, inn, x, 0);
                (!cls.iter().any(|c| self.method_in(c, name, 0).contains(d))).then(|| {
                    format!(
                        "receiver {r} is {} {x}, not an object of {op}",
                        if k == "new" { "a new" } else { "typed" }
                    )
                })
            }
            "call" => {
                let (recv, last, form) = match x.rsplit_once('.') {
                    Some((a, l)) => (json!(a), l, 1),
                    None => (Value::Null, x, 0),
                };
                match self.resolve(file, &json!([0, 0, last, form, recv, inn, false])) {
                    Res::Hit(_, h) if h.iter().any(|t| owner.contains(t)) => None,
                    _ => Some(format!("receiver {r} is the result of {x}, not of {op}")),
                }
            }
            "ref" => match self.receiver(file, inn, x, 0) {
                Some(Res::External(w)) => Some(format!("receiver {r} is {x}: {w}")),
                _ => None,
            },
            _ => None,
        };
        match why {
            None => Res::Hit("method-unique", v),
            Some(w) => Res::Demoted(v, w),
        }
    }

    /// one call site of `file` -> its class and candidates
    pub fn resolve(&self, file: &str, c: &Value) -> Res {
        let name = c[2].as_str().unwrap_or("");
        let form = c[3].as_u64().unwrap_or(0);
        let recv = c[4].as_str();
        let inn = c[5].as_u64().map(|i| i as usize);
        if c[6] == json!(true) {
            return Res::Unresolved("parse-error".into());
        }
        let lang = self.files[file].lang.clone();
        let lang = lang.as_str();
        let plain = || -> Res {
            if lang == "rs" && c[7] == json!(["var"]) {
                return Res::Unresolved(format!(
                    "{name} is a local variable (a closure or fn pointer), not a definition"
                ));
            }
            let l = self.local(file, inn, name);
            if !l.is_empty() {
                return Res::Hit("local", l);
            }
            if let Some(b) = self.binds(file, name).next() {
                return match self.follow(file, b, 0) {
                    Res::Hit(_, h) => Res::Hit("import", h),
                    Res::Module(_) => Res::Unresolved(format!("{name} is a module")),
                    x => x,
                };
            }
            let builtin = match lang {
                "py" => PY_BUILTINS.contains(&name),
                "js" => JS_GLOBALS.contains(&name),
                _ => RS_PRELUDE.contains(&name),
            };
            if builtin {
                return Res::External(format!("builtin {name}"));
            }
            for b in self.binds(file, "*") {
                let hit = if lang == "rs" {
                    let mut bs: Vec<String> =
                        s(b, "path").split("::").map(str::to_string).collect();
                    bs.push(name.to_string());
                    self.rs_path(file, &bs, 1)
                } else {
                    self.union(
                        self.module_of(file, b, 1)
                            .iter()
                            .map(|m| self.top(m, name, 1)),
                    )
                };
                if let Res::Hit(_, h) = hit {
                    return Res::Hit("import", h);
                }
            }
            Res::Unresolved(format!("{name} is not bound in the file"))
        };
        match (lang, form) {
            (_, 0) => plain(),
            ("rs", 2) => {
                let mut segs: Vec<String> = recv
                    .unwrap_or("")
                    .split("::")
                    .filter(|x| !x.is_empty())
                    .map(str::to_string)
                    .collect();
                if segs.first().map(String::as_str) == Some("Self") && segs.len() == 1 {
                    let (Some(ty), Some((t, _))) = (self.impl_type(file, inn), self.rs_at(file))
                    else {
                        return Res::Unresolved("Self outside an impl".into());
                    };
                    let m = self.rs_methods(&t, &ty, name);
                    return if m.is_empty() {
                        Res::Unresolved(format!("no method {ty}::{name}"))
                    } else {
                        Res::Hit("self", m)
                    };
                }
                segs.push(name.to_string());
                self.rs_path(file, &segs, 0)
            }
            ("rs", _) => {
                if recv == Some("self") {
                    let (Some(ty), Some((t, _))) = (self.impl_type(file, inn), self.rs_at(file))
                    else {
                        return Res::Unresolved("self outside an impl".into());
                    };
                    let m = self.rs_methods(&t, &ty, name);
                    return if m.is_empty() {
                        self.by_method_name(lang, name)
                    } else {
                        Res::Hit("self", m)
                    };
                }
                self.by_method_name(lang, name)
            }
            _ => {
                let Some(r) = recv else {
                    return self.by_method_name(lang, name);
                };
                // the receiver words per language: a JS `self` / `cls` or a Python `this` is an ordinary name
                if matches!((lang, r), ("js", "this") | ("py", "self" | "cls")) {
                    let Some(c) = self.class_of(file, inn) else {
                        return Res::Unresolved(format!("{r} outside a class"));
                    };
                    let m = self.method_in(&c, name, 0);
                    return if m.is_empty() {
                        Res::Unresolved(format!("no method {name} on the class or its bases"))
                    } else {
                        Res::Hit("self", m)
                    };
                }
                match self.receiver(file, inn, r, 0) {
                    Some(Res::Module(ms)) => {
                        match self.union(ms.iter().map(|m| self.top(m, name, 1))) {
                            Res::Hit(_, h) => Res::Hit("qualified", h),
                            x => x,
                        }
                    }
                    Some(Res::Hit(_, cls)) => {
                        let cls: Vec<D> = cls
                            .into_iter()
                            .filter(|d| s(self.fact_def(d), "kind") == "class")
                            .collect();
                        let m: Vec<D> = cls
                            .iter()
                            .flat_map(|c| self.method_in(c, name, 0))
                            .collect();
                        if m.is_empty() {
                            self.by_method_name(lang, name)
                        } else {
                            Res::Hit("qualified", m)
                        }
                    }
                    Some(Res::External(w)) => Res::External(w),
                    _ => match (self.by_method_name(lang, name), c.get(7)) {
                        (Res::Hit("method-unique", v), Some(b)) => {
                            self.vet(file, inn, r, name, b, v)
                        }
                        (x, _) => x,
                    },
                }
            }
        }
    }

    /// every call site of a file, resolved: { file, line, col, name, how, candidates, targets (<= CANDIDATES_MAX), more?, why?, caller }
    pub fn sites(&self, file: &str) -> Vec<(Value, Vec<D>)> {
        let f = &self.files[file];
        f.facts["calls"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|c| {
                let (how, targets, why) = match self.resolve(file, c) {
                    Res::Hit(how, mut h) => {
                        h.sort();
                        h.dedup();
                        (if h.len() > 1 { "ambiguous" } else { how }, h, None)
                    }
                    Res::External(w) => ("external", vec![], Some(w)),
                    Res::Unresolved(w) => ("unresolved", vec![], Some(w)),
                    Res::Module(_) => ("unresolved", vec![], Some("a module, not a callable".to_string())),
                    Res::Demoted(h, w) => ("ambiguous", h, Some(w)),
                };
                let ids: Vec<&Value> = targets.iter().take(CANDIDATES_MAX).map(|d| &self.def(d)["id"]).collect();
                let caller = c[5].as_u64().map_or(Value::Null, |i| f.defs[i as usize]["id"].clone());
                let mut row = json!({ "file": file, "line": c[0], "col": c[1], "name": c[2], "how": how, "candidates": targets.len(), "targets": ids, "caller": caller });
                if targets.len() > CANDIDATES_MAX {
                    row["more"] = json!(targets.len() - CANDIDATES_MAX);
                }
                if let Some(w) = why {
                    row["why"] = json!(w);
                }
                (row, targets)
            })
            .collect()
    }

    /// a def's full record by id
    pub fn def_by_id(&self, id: &str) -> Option<D> {
        let file = id.split('#').next()?;
        let f = self.files.get(file)?;
        f.defs
            .iter()
            .position(|d| s(d, "id") == id)
            .map(|i| (file.to_string(), i))
    }
    pub fn def_value(&self, d: &D) -> Value {
        let v = self.def(d);
        json!({ "id": v["id"], "file": v["file"], "name": v["name"], "qual": v["qual"], "kind": v["kind"], "line": v["line"], "end_line": v["end_line"], "col": v["col"] })
    }
}

#[cfg(test)]
mod tests {
    use super::{strip_generics, use_binds};

    #[test]
    fn use_trees_bind_their_last_segment_or_alias() {
        let b = |s: &str| {
            use_binds(s)
                .into_iter()
                .map(|(p, l)| format!("{p}={l}"))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            b("crate::a::{b as c, d::*, self}"),
            vec!["crate::a::b=c", "crate::a::d=*", "crate::a=a"]
        );
        assert_eq!(
            b("std::collections::HashMap"),
            vec!["std::collections::HashMap=HashMap"]
        );
        assert_eq!(strip_generics("Vec::<u8>::new"), "Vec::new");
    }

    #[test]
    fn call_sites_carry_form_receiver_and_enclosing_def() {
        use crate::lang::{lang_of, parse};
        let f = parse(lang_of("m.py").unwrap(), "m.py", b"import os.path as p\nfrom . import x as y\n\nclass A(B):\n    def m(self):\n        self.n()\n        p.join(1)\n\nf()\n");
        assert_eq!(
            f["calls"],
            serde_json::json!([
                [6, 14, "n", 1, "self", 1, false],
                [7, 11, "join", 1, "p", 1, false],
                [9, 1, "f", 0, null, null, false]
            ])
        );
        assert_eq!(f["defs"][0]["bases"], serde_json::json!(["B"]));
        assert_eq!(f["binds"][0]["local"], "p");
        assert_eq!(
            f["binds"][1],
            serde_json::json!({ "local": "y", "name": "x", "module": "", "level": 1, "line": 2 })
        );
        let r = parse(
            lang_of("a.rs").unwrap(),
            "a.rs",
            b"fn g() { a::b::<u8>::c(); x.y.z(); h(); }\n",
        );
        assert_eq!(
            r["calls"],
            serde_json::json!([
                [1, 22, "c", 2, "a::b", 0, false],
                [1, 31, "z", 1, "x.y", 0, false],
                [1, 36, "h", 0, null, 0, false]
            ])
        );
    }
}
