// norn-hook (hook-fast S1, owner 2026-11-20): the per-tool-call hooks of a claude run Norn launches, as one small binary. A Node
// hook paid ~1 s of start-up plus the norn.mjs import graph on every tool call to answer "nothing to do" almost every time; this
// answers that case alone and starts Node (`norn mail check --inject`, `norn scope check`) only when Node has something to do.
//   norn-hook mail  --state S --node N --norn B   PostToolUse: no flag file <S>/mail/flag/<run> = exit 0, no output (Q-b-46:
//                                                         a mail or a context order for the run raises it, mail.mjs raiseFlag);
//                                                         RM-a-67: a first edit of a file in <S>/code/warn.json also gets its line
//                                                         (codewarn.mjs; read only while that table exists, never through Node)
//   norn-hook scope --state S --node N --norn B   PreToolUse: the payload on stdin. The calls scope.mjs surely allows (read
//                                                         from <S>/runs/<run>.scope.json, written at launch) exit 0 here; every
//                                                         other call goes to `norn scope check` unchanged. This binary never
//                                                         refuses on its own: a refusal, its reason and its record stay Node's.
//   norn-hook version                             { crate, store_schema: null, source }: source = the hash of the sources it was
//                                                         built from (build.rs, NORN-PART-PROOF; rustbin.mjs partProblem checks it
//                                                         against its store name). store_schema null: norn-hook keeps no store, and
//                                                         every part answers the one shape
// std only (Cargo.toml). Exit code and stdout of a delegated call are Node's, passed through.
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;
use std::process::{exit, Command, Stdio};
use std::time::UNIX_EPOCH;

// ---------- a minimal JSON reader (the hook payload, the scope file) ----------
enum J {
    Null,
    Bool(bool),
    Num,
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(String, J)>),
}
impl J {
    fn get(&self, k: &str) -> Option<&J> {
        if let J::Obj(v) = self {
            v.iter().rev().find(|(n, _)| n == k).map(|(_, x)| x)
        } else {
            None
        }
    } // last key wins, as JSON.parse
    fn str(&self) -> Option<&str> {
        if let J::Str(s) = self {
            Some(s)
        } else {
            None
        }
    }
    fn strs(&self) -> Option<Vec<String>> {
        if let J::Arr(v) = self {
            v.iter().map(|x| x.str().map(String::from)).collect()
        } else {
            None
        }
    }
    fn nullish(&self) -> bool {
        matches!(self, J::Null)
    }
}
struct P<'a> {
    b: &'a [u8],
    i: usize,
}
impl<'a> P<'a> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }
    fn lit(&mut self, w: &str, v: J) -> Option<J> {
        if self.b[self.i..].starts_with(w.as_bytes()) {
            self.i += w.len();
            Some(v)
        } else {
            None
        }
    }
    fn val(&mut self, depth: u32) -> Option<J> {
        if depth > 200 {
            return None;
        }
        self.ws();
        match *self.b.get(self.i)? {
            b'{' => {
                self.i += 1;
                let mut v = Vec::new();
                self.ws();
                if self.b.get(self.i) == Some(&b'}') {
                    self.i += 1;
                    return Some(J::Obj(v));
                }
                loop {
                    self.ws();
                    let k = self.string()?;
                    self.ws();
                    if self.b.get(self.i) != Some(&b':') {
                        return None;
                    }
                    self.i += 1;
                    let x = self.val(depth + 1)?;
                    v.push((k, x));
                    self.ws();
                    match self.b.get(self.i)? {
                        b',' => self.i += 1,
                        b'}' => {
                            self.i += 1;
                            return Some(J::Obj(v));
                        }
                        _ => return None,
                    }
                }
            }
            b'[' => {
                self.i += 1;
                let mut v = Vec::new();
                self.ws();
                if self.b.get(self.i) == Some(&b']') {
                    self.i += 1;
                    return Some(J::Arr(v));
                }
                loop {
                    v.push(self.val(depth + 1)?);
                    self.ws();
                    match self.b.get(self.i)? {
                        b',' => self.i += 1,
                        b']' => {
                            self.i += 1;
                            return Some(J::Arr(v));
                        }
                        _ => return None,
                    }
                }
            }
            b'"' => self.string().map(J::Str),
            b't' => self.lit("true", J::Bool(true)),
            b'f' => self.lit("false", J::Bool(false)),
            b'n' => self.lit("null", J::Null),
            b'-' | b'0'..=b'9' => {
                while self.i < self.b.len()
                    && matches!(
                        self.b[self.i],
                        b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9'
                    )
                {
                    self.i += 1;
                }
                Some(J::Num)
            }
            _ => None,
        }
    }
    fn hex4(&mut self) -> Option<u32> {
        let h = std::str::from_utf8(self.b.get(self.i..self.i + 4)?).ok()?;
        self.i += 4;
        u32::from_str_radix(h, 16).ok()
    }
    fn string(&mut self) -> Option<String> {
        if self.b.get(self.i) != Some(&b'"') {
            return None;
        }
        self.i += 1;
        let mut out: Vec<u8> = Vec::new();
        loop {
            let c = *self.b.get(self.i)?;
            self.i += 1;
            match c {
                b'"' => return String::from_utf8(out).ok(),
                b'\\' => {
                    let e = *self.b.get(self.i)?;
                    self.i += 1;
                    let ch = match e {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            let mut u = self.hex4()?;
                            if (0xD800..0xDC00).contains(&u)
                                && self.b.get(self.i..self.i + 2) == Some(b"\\u")
                            {
                                let save = self.i;
                                self.i += 2;
                                let lo = self.hex4()?;
                                if (0xDC00..0xE000).contains(&lo) {
                                    u = 0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00);
                                } else {
                                    self.i = save;
                                }
                            }
                            char::from_u32(u).unwrap_or('\u{FFFD}') // a lone surrogate: JSON.parse keeps it, a Rust String cannot - the path checks hand such text to Node (non-BMP / U+FFFD below)
                        }
                        _ => return None,
                    };
                    let mut buf = [0u8; 4];
                    out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                }
                _ => out.push(c),
            }
        }
    }
}
fn parse(b: &[u8]) -> Option<J> {
    let b = b.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(b);
    let mut p = P { b, i: 0 };
    let v = p.val(0)?;
    p.ws();
    if p.i == b.len() {
        Some(v)
    } else {
        None
    }
}

// ---------- the arguments, the run, Node ----------
struct Args {
    sub: String,
    state: String,
    node: String,
    norn: String,
}
fn args() -> Args {
    let a: Vec<String> = env::args().skip(1).collect();
    let usage = || -> ! {
        eprintln!("usage: norn-hook mail|scope --state D --node <node> --norn <norn.mjs>    (the run: META_RUN_ID)  |  norn-hook version");
        exit(2)
    };
    if a.is_empty() || (a[0] != "mail" && a[0] != "scope") {
        usage();
    }
    let (mut state, mut node, mut norn) = (None, None, None);
    let mut i = 1;
    while i < a.len() {
        let v = a.get(i + 1).cloned().unwrap_or_else(|| usage());
        match a[i].as_str() {
            "--state" => state = Some(v),
            "--node" => node = Some(v),
            "--norn" => norn = Some(v),
            _ => usage(),
        }
        i += 2;
    }
    match (state, node, norn) {
        (Some(state), Some(node), Some(norn)) => Args {
            sub: a[0].clone(),
            state,
            node,
            norn,
        },
        _ => usage(),
    }
}
// RUN-n / RUN-<home>-n (norn.mjs: /^RUN-(?:[a-z][a-z0-9]{0,15}-)?\d+$/)
fn run_id(s: &str) -> bool {
    let Some(r) = s.strip_prefix("RUN-") else {
        return false;
    };
    let digits = |x: &str| !x.is_empty() && x.bytes().all(|c| c.is_ascii_digit());
    if digits(r) {
        return true;
    }
    match r.split_once('-') {
        Some((h, n)) => {
            h.len() <= 16
                && h.as_bytes()[0].is_ascii_lowercase()
                && h.bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                && digits(n)
        }
        None => false,
    }
}
// the run the hook speaks for: META_RUN_ID, the env the launcher gives the run (Claude Code passes it to its hooks)
fn the_run() -> Option<String> {
    env::var("META_RUN_ID").ok().filter(|r| run_id(r))
}
// run Node's own hook (`norn <words> --run <run> --state S`; no run: Node says why), stdin = `input` (None: inherited), its stdout / stderr / exit code passed through
fn node(a: &Args, words: &[&str], run: Option<&str>, input: Option<&[u8]>) -> ! {
    let mut c = Command::new(&a.node);
    c.arg(&a.norn).args(words);
    if let Some(r) = run {
        c.args(["--run", r]);
    }
    c.args(["--state", &a.state])
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::inherit()
        });
    let mut ch = match c.spawn() {
        Ok(ch) => ch,
        Err(e) => {
            eprintln!("norn-hook: cannot start {} ({e})", a.node);
            exit(1)
        }
    };
    if let (Some(b), Some(mut si)) = (input, ch.stdin.take()) {
        let _ = si.write_all(b);
    } // dropped here: Node sees EOF
    exit(ch.wait().ok().and_then(|s| s.code()).unwrap_or(1))
}

// ---------- mail (+ the warn line) ----------
fn mail(a: &Args) -> ! {
    let run = the_run();
    let flag = run.as_ref().is_none_or(|r| {
        Path::new(&a.state)
            .join("mail")
            .join("flag")
            .join(r)
            .exists()
    }); // no run: Node says why on stderr
    let table = Path::new(&a.state).join("code").join("warn.json");
    let Some(r) = run.as_deref().filter(|_| table.exists()) else {
        if flag {
            node(a, &["mail", "check", "--inject"], run.as_deref(), None)
        } else {
            exit(0)
        }
    };
    let mut input = Vec::new();
    let due = if io::stdin().read_to_end(&mut input).is_ok() {
        parse(&input).and_then(|p| warn_due(a, r, &p, &table))
    } else {
        None
    };
    if !flag {
        if let Some(d) = due {
            d.show(&d.line);
        }
        exit(0);
    }
    // the flag is up: Node delivers the mail; a due line goes first in the same additionalContext (one JSON answer per hook call)
    let mut c = Command::new(&a.node);
    c.arg(&a.norn)
        .args(["mail", "check", "--inject", "--run", r, "--state", &a.state])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let o = match c.output() {
        Ok(o) => o,
        Err(e) => {
            eprintln!("norn-hook: cannot start {} ({e})", a.node);
            exit(1)
        }
    };
    let code = o.status.code().unwrap_or(1);
    let said = String::from_utf8_lossy(&o.stdout);
    let ctx = if said.trim().is_empty() {
        Some(String::new())
    } else {
        parse(said.trim().as_bytes()).and_then(|j| {
            j.get("hookSpecificOutput")?
                .get("additionalContext")?
                .str()
                .map(String::from)
        })
    };
    match (due, ctx) {
        (Some(d), Some(m)) if code == 0 => d.show(&if m.is_empty() {
            d.line.clone()
        } else {
            format!("{}\n\n{m}", d.line)
        }),
        _ => {
            let _ = io::stdout().write_all(&o.stdout);
        } // Node's answer as it is (a due line waits for the next edit of its file)
    }
    exit(code)
}

// RM-a-67 (codewarn.mjs): the line of an edited file over a threshold, read from <S>/code/warn.json - once per file per run, recorded in
// <S>/code/warn/<run>.txt (`<mode> <group>`, then `shown <file>`). The switch policy.code.warn (off | on | ab) is read from the project
// file whose current policy binds the run (the spec's ctx_from); ab: an even run number sees lines, an odd one is the control group.
struct Due {
    line: String,
    file: String,
    mark: std::path::PathBuf,
}
impl Due {
    fn show(&self, ctx: &str) {
        let ok = fs::OpenOptions::new()
            .append(true)
            .open(&self.mark)
            .and_then(|mut f| f.write_all(format!("shown {}\n", self.file).as_bytes()))
            .is_ok();
        if ok {
            println!("{{\"hookSpecificOutput\":{{\"hookEventName\":\"PostToolUse\",\"additionalContext\":{}}}}}", jstr(ctx));
        }
    }
}
fn jstr(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}
fn read_json(p: &Path) -> Option<J> {
    fs::read(p).ok().and_then(|b| parse(&b))
}
fn warn_due(a: &Args, run: &str, p: &J, table: &Path) -> Option<Due> {
    if !matches!(
        p.get("tool_name")?.str()?,
        "Edit" | "Write" | "NotebookEdit"
    ) {
        return None;
    }
    let i = p.get("tool_input")?;
    let file = i
        .get("file_path")
        .and_then(J::str)
        .or_else(|| i.get("notebook_path").and_then(J::str))
        .filter(|f| !f.is_empty())?;
    let spec = read_json(
        &Path::new(&a.state)
            .join("runs")
            .join(format!("{run}.spec.json")),
    )?;
    let mode = read_json(Path::new(spec.get("ctx_from")?.str()?))?
        .get("policy")?
        .get("code")?
        .get("warn")?
        .str()?
        .to_string();
    if mode != "on" && mode != "ab" {
        return None;
    }
    let n: u64 = run.rsplit('-').next()?.parse().ok()?;
    let dir = Path::new(&a.state).join("code").join("warn");
    let mark = dir.join(format!("{run}.txt"));
    let rec = match fs::read_to_string(&mark) {
        Ok(t) => t,
        Err(_) => {
            // the run's group, decided once at its first edit (a later switch change keeps it)
            let head = format!(
                "{mode} {}\n",
                if mode == "ab" && n % 2 == 1 {
                    "control"
                } else {
                    "warn"
                }
            );
            fs::create_dir_all(&dir).ok()?;
            fs::write(&mark, &head).ok()?;
            head
        }
    };
    if rec.lines().next()?.split(' ').nth(1)? != "warn" {
        return None;
    }
    // the edited file relative to the indexed folder: the run's worktree, plus a monorepo project's subdir
    let wt = spec.get("worktree")?.str()?;
    let root = match spec
        .get("subdir")
        .and_then(J::str)
        .filter(|s| !s.is_empty())
    {
        Some(s) => resolve(wt, s)?,
        None => resolve(wt, ".")?,
    };
    let abs = resolve(
        p.get("cwd")
            .and_then(J::str)
            .filter(|x| !x.is_empty())
            .unwrap_or(wt),
        file,
    )?;
    if abs == root || !under(&abs, &root) {
        return None;
    }
    let rel = &abs[root.len() + 1..];
    let t = read_json(table)?;
    let Some(J::Obj(files)) = t.get("files") else {
        return None;
    };
    let (key, line) = files.iter().find(|(k, _)| fold(k) == rel)?;
    if rec
        .lines()
        .skip(1)
        .any(|l| l.strip_prefix("shown ").is_some_and(|f| fold(f) == rel))
    {
        return None;
    }
    Some(Due {
        line: line.str()?.to_string(),
        file: key.clone(),
        mark,
    })
}

// ---------- scope: the calls scope.mjs checkTool + suiteCheck surely allow ----------
const WIN: bool = cfg!(windows);
fn fold(s: &str) -> String {
    if WIN {
        s.to_lowercase()
    } else {
        s.to_string()
    }
}
fn under(p: &str, root: &str) -> bool {
    p == root || (p.starts_with(root) && p.as_bytes().get(root.len()) == Some(&b'/'))
}

// path.resolve(base, file) folded as scope.mjs norm does; None = a spelling Node resolves in a way this does not copy (Node decides)
fn resolve(base: &str, file: &str) -> Option<String> {
    let f = if WIN {
        file.replace('\\', "/")
    } else {
        file.to_string()
    };
    let abs = |s: &str| {
        if WIN {
            s.len() >= 3 && s.as_bytes()[0].is_ascii_alphabetic() && &s[1..3] == ":/"
        } else {
            s.starts_with('/')
        }
    };
    if WIN && (f.starts_with('/') || (f.as_bytes().get(1) == Some(&b':') && !abs(&f))) {
        return None;
    } // \x (drive root), C:x (drive-relative), UNC
    let joined = if abs(&f) {
        f
    } else {
        let b = if WIN {
            base.replace('\\', "/")
        } else {
            base.to_string()
        };
        if !abs(&b) {
            return None;
        }
        format!("{b}/{f}")
    };
    let (root, rest) = if WIN {
        (joined[..2].to_string(), &joined[2..])
    } else {
        (String::new(), joined.as_str())
    };
    let mut parts: Vec<&str> = Vec::new();
    for s in rest.split('/') {
        match s {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            x => parts.push(x),
        }
    }
    let p = format!("{root}/{}", parts.join("/"));
    Some(fold(if p.len() > 1 && p.ends_with('/') {
        p.trim_end_matches('/')
    } else {
        &p
    }))
}

enum G {
    Lit(char),
    Q,
    Star,
    DStar,
    DStarSlash,
}
// ready.mjs globRe: `**/` = (?:.*/)?, `**` = .*, `*` = [^/]*, `?` = [^/], the rest literal; anchored
fn glob(g: &str, s: &str) -> bool {
    let (gc, mut t, mut i): (Vec<char>, Vec<G>, usize) = (g.chars().collect(), Vec::new(), 0);
    while i < gc.len() {
        if gc[i] == '*' && gc.get(i + 1) == Some(&'*') {
            if gc.get(i + 2) == Some(&'/') {
                t.push(G::DStarSlash);
                i += 3;
            } else {
                t.push(G::DStar);
                i += 2;
            }
        } else if gc[i] == '*' {
            t.push(G::Star);
            i += 1;
        } else if gc[i] == '?' {
            t.push(G::Q);
            i += 1;
        } else {
            t.push(G::Lit(gc[i]));
            i += 1;
        }
    }
    fn m(t: &[G], s: &[char]) -> bool {
        let Some(h) = t.first() else {
            return s.is_empty();
        };
        match h {
            G::Lit(c) => s.first() == Some(c) && m(&t[1..], &s[1..]),
            G::Q => s.first().is_some_and(|c| *c != '/') && m(&t[1..], &s[1..]),
            G::Star => (0..=s.len())
                .take_while(|k| *k == 0 || s[k - 1] != '/')
                .any(|k| m(&t[1..], &s[k..])),
            G::DStar => (0..=s.len()).any(|k| m(&t[1..], &s[k..])),
            G::DStarSlash => {
                m(&t[1..], s) || (1..=s.len()).any(|k| s[k - 1] == '/' && m(&t[1..], &s[k..]))
            }
        }
    }
    let sc: Vec<char> = s.chars().collect();
    m(&t, &sc)
}
// ready.mjs inScope over the scope file's entries (already folded, ./ and trailing / dropped at launch)
fn in_scope(rel: &str, scope: &[String]) -> bool {
    scope.iter().any(|g| {
        if g.contains(['*', '?']) {
            glob(g, rel)
        } else {
            rel == g || under(rel, g)
        }
    })
}

struct Scope {
    worktree: String,
    free: Vec<String>,
    scope: Vec<String>,
    brief_same: bool,
    tests_free: bool,
}
fn file_ok(file: &str, cwd: Option<&str>, c: &Scope) -> bool {
    if !c.brief_same {
        return false;
    } // scopeOf reads the brief at every call: an edited brief may carry another Scope
    if file
        .chars()
        .any(|ch| ch as u32 > 0xFFFF || ch == '\u{FFFD}')
    {
        return false;
    } // UTF-16 vs chars: Node decides
    let Some(p) = resolve(cwd.filter(|x| !x.is_empty()).unwrap_or(&c.worktree), file) else {
        return false;
    };
    if c.free.iter().any(|r| under(&p, r)) {
        return true;
    }
    if p == c.worktree || !under(&p, &c.worktree) {
        return false;
    }
    c.scope.is_empty() || in_scope(&p[c.worktree.len() + 1..], &c.scope)
}

// Could scope.mjs (checkShell) or testpolicy.mjs (testsCheck: policy.tests) act on this command? Both act only on a shell word
// whose base name (lowercased, .exe / .cmd dropped) is one of a few commands; every such word is a token here, in one of two
// readings: split at every char outside [a-z0-9_-], once as written and once with quotes and backslashes removed (`g"i"t`, g\it).
// More tokens than words = more calls for Node, never fewer. git and gh count only beside the subcommands their checks read; the test
// words (a test runner, `norn tests run`) only while the run's policy.tests has something to check (the scope file's tests_free).
fn shell_may_act(cmd: &str, tests_free: bool) -> bool {
    let lower = cmd.to_lowercase();
    let bare: String = lower
        .chars()
        .filter(|c| !matches!(c, '"' | '\'' | '\\'))
        .collect();
    let mut toks: Vec<&str> = Vec::new();
    for s in [lower.as_str(), bare.as_str()] {
        toks.extend(
            s.split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '-'))
                .filter(|t| !t.is_empty()),
        );
    }
    let has = |w: &[&str]| toks.iter().any(|t| w.contains(t));
    let tests = !tests_free
        && (has(&["--test", "ci-suite", "pytest", "npm", "yarn", "pnpm"])
            || (has(&["norn", "meta"]) && has(&["tests"]) && has(&["run"])));
    tests
        || has(&["rm", "remove-item", "ri", "del", "erase", "rmdir", "rd"])
        || (has(&["git"]) && has(&["push", "reset", "clean", "branch", "worktree"]))
        || (has(&["gh"]) && has(&["repo", "api"]))
}

fn surely_allowed(p: &J, c: &Scope) -> bool {
    let Some(t) = p.get("tool_name").and_then(J::str) else {
        return false;
    };
    let i = p.get("tool_input");
    let field = |k: &str| i.and_then(|i| i.get(k)).filter(|v| !v.nullish());
    match t {
        "Bash" | "PowerShell" => match field("command") {
            None => true,
            Some(J::Str(cmd)) => !shell_may_act(cmd, c.tests_free),
            Some(_) => true,
        }, // not a string: checkTool / testsHook pass it
        "Edit" | "Write" | "NotebookEdit" => {
            match field("file_path").or_else(|| field("notebook_path")) {
                None => true,
                Some(J::Str(f)) if f.is_empty() => true,
                Some(J::Str(f)) => file_ok(f, p.get("cwd").and_then(J::str), c),
                Some(_) => false,
            }
        }
        _ => true,
    }
}

// the brief's mtime (whole ms, as a string) still the one the scope file was written under; no brief named = nothing to compare
fn brief_same(j: &J) -> bool {
    let Some(b) = j.get("brief").and_then(J::str) else {
        return true;
    };
    let now = fs::metadata(b)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis().to_string());
    now.as_deref() == j.get("brief_ms").and_then(J::str)
}

fn scope(a: &Args) -> ! {
    let mut input = Vec::new();
    let run = the_run();
    if io::stdin().read_to_end(&mut input).is_err() {
        node(a, &["scope", "check"], run.as_deref(), Some(&input));
    }
    let sc = run
        .as_ref()
        .and_then(|r| {
            fs::read(
                Path::new(&a.state)
                    .join("runs")
                    .join(format!("{r}.scope.json")),
            )
            .ok()
        })
        .and_then(|b| parse(&b));
    let c = sc.as_ref().and_then(|j| {
        Some(Scope {
            worktree: j.get("worktree")?.str()?.to_string(),
            free: j.get("free")?.strs()?,
            scope: j.get("scope")?.strs()?,
            brief_same: brief_same(j),
            tests_free: matches!(j.get("tests_free"), Some(J::Bool(true))), // absent (a file from before test-diet) = Node judges every test command
        })
    });
    match (c, parse(&input)) {
        (Some(c), Some(p)) if surely_allowed(&p, &c) => exit(0),
        _ => node(a, &["scope", "check"], run.as_deref(), Some(&input)), // no scope file (Node fails closed on a missing spec), a payload it cannot read, or a call Node must judge
    }
}

fn main() {
    if env::args().nth(1).as_deref() == Some("version") {
        println!(
            "{{\"crate\":\"{}\",\"store_schema\":null,\"source\":\"{}\"}}",
            env!("CARGO_PKG_VERSION"),
            env!("NORN_SOURCE")
        );
        return;
    }
    let a = args();
    if a.sub == "mail" {
        mail(&a)
    } else {
        scope(&a)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn globs() {
        assert!(glob("engine/lib/**", "engine/lib/a/b.mjs"));
        assert!(glob("tests/**/*.mjs", "tests/x.mjs"));
        assert!(glob("tests/**/*.mjs", "tests/a/x.mjs"));
        assert!(!glob("engine/*.mjs", "engine/lib/x.mjs"));
        assert!(glob("a?c", "abc"));
        assert!(!glob("a?c", "a/c"));
        assert!(glob("eng**.md", "engine/x.md"));
    }
    #[test]
    fn shell() {
        for c in [
            "grep -n x a.mjs",
            "git status",
            "git diff --stat",
            "node engine/bin/norn.mjs done",
            "git status --branch",
            "sed -n 1,5p f",
            "norn tests for engine/lib/x.mjs",
        ] {
            assert!(!shell_may_act(c, false), "{c}");
        }
        for c in [
            "git push",
            "C:/Git/bin/git.exe push",
            "g\"i\"t push",
            "rm -rf x",
            "Remove-Item x",
            "node --test tests/a.test.mjs",
            "npm test",
            "bash -c 'gh repo delete x'",
            "node engine/bin/ci-suite.mjs",
            "norn tests run --changed",
            "node engine/bin/norn.mjs tests run tests/a.test.mjs",
        ] {
            assert!(shell_may_act(c, false), "{c}");
        }
        // test-diet S1: a run whose policy.tests checks nothing passes its test commands here; the other checks stay
        for c in [
            "node --test tests/a.test.mjs",
            "npm test",
            "node engine/bin/ci-suite.mjs",
            "norn tests run --changed",
        ] {
            assert!(!shell_may_act(c, true), "{c}");
        }
        for c in [
            "git push",
            "rm -rf x",
            "node --test tests/a.test.mjs && git push",
        ] {
            assert!(shell_may_act(c, true), "{c}");
        }
    }
    #[test]
    fn bools() {
        assert!(matches!(
            parse(b"{\"tests_free\":true}").unwrap().get("tests_free"),
            Some(J::Bool(true))
        ));
        assert!(matches!(
            parse(b"{\"a\":false}").unwrap().get("a"),
            Some(J::Bool(false))
        ));
    }
    #[test]
    fn ids() {
        assert!(run_id("RUN-12"));
        assert!(run_id("RUN-b-553"));
        assert!(!run_id("$META_RUN_ID"));
        assert!(!run_id("RUN-B-1"));
        assert!(!run_id("RUN-"));
    }
    #[test]
    fn json() {
        let j = parse(br#"{"tool_name":"Bash","tool_input":{"command":"a \"b\" \u00e9 \ud83d\ude00"},"n":[1,-2.5e3,true,null]}"#).unwrap();
        assert_eq!(
            j.get("tool_input").unwrap().get("command").unwrap().str(),
            Some("a \"b\" \u{e9} \u{1F600}")
        );
    }
}
