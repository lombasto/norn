// Repo-relative path helpers: every path is '/'-separated and relative to the repo root ("" = the root).

pub fn dirname(p: &str) -> &str {
    p.rfind('/').map_or("", |i| &p[..i])
}
pub fn basename(p: &str) -> &str {
    p.rfind('/').map_or(p, |i| &p[i + 1..])
}
pub fn ext(p: &str) -> &str {
    let b = basename(p);
    b.rfind('.').filter(|&i| i > 0).map_or("", |i| &b[i + 1..])
}
/// join a relative path onto a dir and fold `.` / `..`; None when it climbs above the root
pub fn join(dir: &str, rel: &str) -> Option<String> {
    let mut out: Vec<&str> = if dir.is_empty() {
        vec![]
    } else {
        dir.split('/').collect()
    };
    for s in rel.split('/') {
        match s {
            "" | "." => {}
            ".." => {
                out.pop()?;
            }
            s => out.push(s),
        }
    }
    Some(out.join("/"))
}
/// is `p` inside dir `d` (or `d` itself)
pub fn under(p: &str, d: &str) -> bool {
    d.is_empty()
        || p == d
        || (p.len() > d.len() && p.starts_with(d) && p.as_bytes()[d.len()] == b'/')
}

/// glob match: `*` and `?` stay inside a segment, `**` crosses them
pub fn glob(pat: &str, s: &str) -> bool {
    fn m(p: &[u8], s: &[u8]) -> bool {
        if p.is_empty() {
            return s.is_empty();
        }
        if p.starts_with(b"**") {
            if p.len() == 2 {
                return true;
            }
            let rest = if p[2] == b'/' { &p[3..] } else { &p[2..] };
            return (0..=s.len()).any(|i| (i == 0 || s[i - 1] == b'/') && m(rest, &s[i..]));
        }
        match p[0] {
            b'*' => (0..=s.len())
                .take_while(|&i| i == 0 || s[i - 1] != b'/')
                .any(|i| m(&p[1..], &s[i..])),
            b'?' => !s.is_empty() && s[0] != b'/' && m(&p[1..], &s[1..]),
            c => !s.is_empty() && s[0] == c && m(&p[1..], &s[1..]),
        }
    }
    m(pat.as_bytes(), s.as_bytes())
}
/// a gitattributes-style pattern relative to dir `base`: one without '/' matches any path segment below `base` (a file
/// name or a folder holding the file), one with '/' matches from `base`, a folder match taking everything under it
pub fn pattern_hits(pat: &str, base: &str, p: &str) -> bool {
    if !under(p, base) || p == base {
        return false;
    }
    let rel = if base.is_empty() {
        p
    } else {
        &p[base.len() + 1..]
    };
    let pat = pat.trim_end_matches('/');
    if pat.contains('/') {
        let pat = pat.trim_start_matches('/');
        glob(pat, rel) || glob(&format!("{pat}/**"), rel)
    } else {
        rel.split('/').any(|seg| glob(pat, seg))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn joins_and_globs() {
        assert_eq!(join("a/b", "../c/./d").as_deref(), Some("a/c/d"));
        assert_eq!(join("", "../x"), None);
        assert!(
            glob("src/**/*.rs", "src/a/b.rs")
                && glob("src/**/*.rs", "src/b.rs")
                && !glob("*.rs", "a/b.rs")
        );
        assert!(
            pattern_hits("*.gen.js", "", "a/b/x.gen.js")
                && pattern_hits("gen/", "pkg", "pkg/gen/x.py")
        );
        assert!(!pattern_hits("gen", "pkg", "other/gen/x.py"));
        assert_eq!(ext("a/.eslintrc"), "");
        assert_eq!(ext("a/b.test.mjs"), "mjs");
    }
}
