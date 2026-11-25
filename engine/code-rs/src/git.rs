// The git CLI is the only route into the repo (no libgit2): ls-tree for the file set, cat-file --batch for blob bytes, status +
// hash-object for --worktree. Every blob is read by sha, so every worktree of the repo shares one store.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};

pub fn git(repo: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let o = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| format!("git: {e}"))?;
    if !o.status.success() {
        return Err(format!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&o.stderr).trim()
        ));
    }
    Ok(o.stdout)
}
fn line(repo: &Path, args: &[&str]) -> Result<String, String> {
    Ok(String::from_utf8_lossy(&git(repo, args)?)
        .trim()
        .to_string())
}

/// REV -> (commit sha, root tree sha)
pub fn rev(repo: &Path, rev: &str) -> Result<(String, String), String> {
    Ok((
        line(
            repo,
            &["rev-parse", "--verify", &format!("{rev}^{{commit}}")],
        )?,
        line(repo, &["rev-parse", "--verify", &format!("{rev}^{{tree}}")])?,
    ))
}

/// the tracked blobs at REV: path -> blob sha (submodules and symlinks are not files of this repo)
pub fn ls_tree(repo: &Path, rev: &str) -> Result<HashMap<String, String>, String> {
    let out = git(repo, &["ls-tree", "-r", "-z", "--full-tree", rev])?;
    let mut m = HashMap::new();
    for rec in out.split(|&b| b == 0).filter(|r| !r.is_empty()) {
        let s = String::from_utf8_lossy(rec);
        let Some((meta, path)) = s.split_once('\t') else {
            continue;
        };
        let f: Vec<&str> = meta.split(' ').collect();
        if f.len() == 3 && f[1] == "blob" && f[0] != "120000" {
            m.insert(path.to_string(), f[2].to_string());
        }
    }
    Ok(m)
}

/// blob bytes by sha through one `git cat-file --batch` (a writer thread feeds stdin, so a full pipe never deadlocks)
pub fn cat_blobs(repo: &Path, shas: &[String]) -> Result<HashMap<String, Vec<u8>>, String> {
    let mut out = HashMap::new();
    if shas.is_empty() {
        return Ok(out);
    }
    let mut ch = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["cat-file", "--batch"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("git cat-file: {e}"))?;
    let mut stdin = ch.stdin.take().ok_or("git cat-file: no stdin")?;
    let input: String = shas.iter().map(|s| format!("{s}\n")).collect();
    let w = std::thread::spawn(move || stdin.write_all(input.as_bytes()));
    let mut r =
        BufReader::with_capacity(1 << 20, ch.stdout.take().ok_or("git cat-file: no stdout")?);
    for sha in shas {
        let mut head = String::new();
        r.read_line(&mut head).map_err(|e| e.to_string())?;
        let f: Vec<&str> = head.trim_end().split(' ').collect();
        if f.len() != 3 {
            return Err(format!("git cat-file: {sha}: {}", head.trim_end()));
        }
        let n: usize = f[2]
            .parse()
            .map_err(|_| format!("git cat-file: bad size {head}"))?;
        let mut buf = vec![0u8; n + 1];
        r.read_exact(&mut buf).map_err(|e| e.to_string())?;
        buf.truncate(n);
        out.insert(sha.clone(), buf);
    }
    let _ = w.join();
    let _ = ch.wait();
    Ok(out)
}

/// uncommitted work: (changed or untracked-not-ignored paths, deleted paths), from `git status --porcelain=v2 -z`
pub fn status(repo: &Path) -> Result<(Vec<String>, Vec<String>), String> {
    let out = git(
        repo,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--no-renames",
        ],
    )?;
    let (mut changed, mut deleted) = (vec![], vec![]);
    for rec in out.split(|&b| b == 0).filter(|r| !r.is_empty()) {
        let s = String::from_utf8_lossy(rec).to_string();
        if let Some(p) = s.strip_prefix("? ") {
            changed.push(p.to_string());
            continue;
        }
        // "1 XY sub mH mI mW hH hI path" and "u XY sub m1 m2 m3 mW h1 h2 h3 path"
        let n = match s.as_bytes().first() {
            Some(b'1') => 8,
            Some(b'u') => 10,
            _ => continue,
        };
        let f: Vec<&str> = s.splitn(n + 1, ' ').collect();
        if f.len() == n + 1 {
            if f[1].contains('D') {
                deleted.push(f[n].to_string())
            } else {
                changed.push(f[n].to_string())
            }
        }
    }
    Ok((changed, deleted))
}

/// `git hash-object --stdin-paths`: the blob sha each working-tree file would get
pub fn hash_paths(repo: &Path, paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Ok(vec![]);
    }
    let mut ch = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["hash-object", "--stdin-paths"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| format!("git hash-object: {e}"))?;
    let mut stdin = ch.stdin.take().ok_or("git hash-object: no stdin")?;
    let input: String = paths.iter().map(|s| format!("{s}\n")).collect();
    let w = std::thread::spawn(move || stdin.write_all(input.as_bytes()));
    let mut s = String::new();
    ch.stdout
        .take()
        .ok_or("git hash-object: no stdout")?
        .read_to_string(&mut s)
        .map_err(|e| e.to_string())?;
    let _ = w.join();
    let _ = ch.wait();
    let v: Vec<String> = s.lines().map(str::to_string).collect();
    if v.len() != paths.len() {
        return Err("git hash-object: short output".into());
    }
    Ok(v)
}
