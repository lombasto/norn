// A SCIP index (scip-typescript, rust-analyzer `scip`) decoded for `grade calls` (S4b, grade_calls.rs) with the `scip` crate: per
// document, its repo-relative path, its position encoding and the occurrences it holds (0-based lines and columns in that encoding,
// the symbol, whether it is the symbol's definition, the definition's enclosing range), and the kind of each symbol it describes.
use protobuf::Message;
use scip::types::{symbol_information, Index, PositionEncoding, SymbolRole};
use std::collections::HashMap;
use std::path::Path;

pub struct Occ {
    pub line: u32,
    pub c0: u32,
    pub c1: u32,
    pub sym: String,
    pub def: bool,
    /// the definition node's lines (0-based, inclusive), when the indexer gives them
    pub encl: Option<(u32, u32)>,
}

pub struct Doc {
    /// repo-relative, '/' separators
    pub path: String,
    /// columns count UTF-8 bytes (else UTF-16 code units: scip-typescript, and SCIP's unspecified default)
    pub utf8: bool,
    pub occs: Vec<Occ>,
    /// symbol -> its SymbolInformation kind ("Function", "Method", "Class", ...), when given
    pub kinds: HashMap<String, String>,
}

/// [startLine, startChar, endLine, endChar] or [startLine, startChar, endChar] -> (start line, start char, end line, end char)
fn range(r: &[i32]) -> Option<(u32, u32, u32, u32)> {
    let u = |i: usize| r.get(i).map(|x| (*x).max(0) as u32);
    match r.len() {
        3 => Some((u(0)?, u(1)?, u(0)?, u(2)?)),
        4 => Some((u(0)?, u(1)?, u(2)?, u(3)?)),
        _ => None,
    }
}

/// decode one index; `prefix`: the repo-relative folder its documents' paths are relative to ('' the repo root)
pub fn read(file: &Path, prefix: &str) -> Result<Vec<Doc>, String> {
    let bytes = std::fs::read(file).map_err(|e| format!("{}: {e}", file.display()))?;
    let ix = Index::parse_from_bytes(&bytes)
        .map_err(|e| format!("{}: not a SCIP index: {e}", file.display()))?;
    let def_role = SymbolRole::Definition as i32;
    Ok(ix
        .documents
        .into_iter()
        .map(|d| {
            let occs = d
                .occurrences
                .iter()
                .filter_map(|o| {
                    let (l, c0, l1, c1) = range(&o.range)?;
                    Some(Occ {
                        line: l,
                        c0,
                        c1: if l1 == l { c1 } else { c0 },
                        sym: o.symbol.clone(),
                        def: o.symbol_roles & def_role != 0,
                        encl: range(&o.enclosing_range).map(|(a, _, b, _)| (a, b)),
                    })
                })
                .collect();
            let kinds = d
                .symbols
                .iter()
                .filter_map(|s| {
                    let k = s.kind.enum_value().ok()?;
                    (k != symbol_information::Kind::UnspecifiedKind)
                        .then(|| (s.symbol.clone(), format!("{k:?}")))
                })
                .collect();
            let rel = d.relative_path.replace('\\', "/");
            Doc {
                path: if prefix.is_empty() {
                    rel
                } else {
                    format!("{}/{rel}", prefix.trim_end_matches('/'))
                },
                utf8: d.position_encoding.enum_value()
                    == Ok(PositionEncoding::UTF8CodeUnitOffsetFromLineStart),
                occs,
                kinds,
            }
        })
        .collect())
}

/// a local symbol ("local 12") names a definition of its own document only
pub fn is_local(sym: &str) -> bool {
    sym.starts_with("local ")
}

/// the last descriptor's suffix of a global symbol: '().' a method or function, '#' a type, '.' a term, '/' a namespace ...
pub fn suffix(sym: &str) -> &'static str {
    let s = sym.trim_end();
    if s.ends_with(").") {
        "method"
    } else if s.ends_with('#') {
        "type"
    } else if s.ends_with('/') {
        "namespace"
    } else if s.ends_with('.') {
        "term"
    } else {
        "other"
    }
}

/// a 1-based UTF-8 byte column of `text` -> the 0-based column in the document's encoding
pub fn to_unit(text: &str, col: u64, utf8: bool) -> u32 {
    let b = (col.saturating_sub(1) as usize).min(text.len());
    if utf8 {
        return b as u32;
    }
    let mut cut = b;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text[..cut].encode_utf16().count() as u32
}

/// the text of `line` between two columns of the document's encoding
pub fn slice(text: &str, c0: u32, c1: u32, utf8: bool) -> String {
    if utf8 {
        let (a, b) = ((c0 as usize).min(text.len()), (c1 as usize).min(text.len()));
        return text.get(a..b.max(a)).unwrap_or("").to_string();
    }
    let u: Vec<u16> = text.encode_utf16().collect();
    let (a, b) = ((c0 as usize).min(u.len()), (c1 as usize).min(u.len()));
    String::from_utf16_lossy(&u[a..b.max(a)])
}

#[cfg(test)]
mod tests {
    use super::{slice, suffix, to_unit};

    #[test]
    fn columns_convert_between_utf8_bytes_and_utf16_units() {
        let t = "é = f(\"😀\", g())";
        // g sits after a 2-byte é and a 4-byte emoji: byte 15 (0-based) is UTF-16 unit 12
        assert_eq!(to_unit(t, 16, true), 15);
        assert_eq!(to_unit(t, 16, false), 12);
        assert_eq!(slice(t, 12, 13, false), "g");
        assert_eq!(slice(t, 15, 16, true), "g");
    }

    #[test]
    fn a_symbols_suffix_names_its_kind() {
        assert_eq!(
            suffix("scip-typescript npm p 1 src/`a.mjs`/Shape#area()."),
            "method"
        );
        assert_eq!(suffix("rust-analyzer cargo c 0.1.0 shapes/Square#"), "type");
        assert_eq!(suffix("scip-typescript npm p 1 src/`a.mjs`/K."), "term");
    }
}
