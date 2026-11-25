// The content-addressed store under <state>/code/graph/ (SPEC code-graph section 6): blobs/v<S>/<aa>/<sha>.json (per-blob facts,
// a pure function of blob + schema), trees/v<S>/<tree>.json (one resolved snapshot per root tree), commits.json (the newest
// COMMITS_KEPT), HEAD. Every file is written tmp-then-rename, so a reader never sees half a file and two writers of one blob
// write the same bytes; a tree has an O_EXCL lock so two indexers of one tree resolve it once.
use crate::limits::{COMMITS_KEPT, LOCK_WAIT_MS, STORE_SCHEMA};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub struct Store {
    root: PathBuf,
}

pub fn now_s() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

pub fn write_atomic(p: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(d) = p.parent() {
        fs::create_dir_all(d).map_err(|e| format!("{}: {e}", d.display()))?;
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    let tmp = p.with_extension(format!("{}.{nanos}.tmp", std::process::id()));
    fs::write(&tmp, bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
    fs::rename(&tmp, p).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("{}: {e}", p.display())
    })
}

/// the tree lock; dropping it removes the lock file
pub struct Lock(PathBuf);
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

impl Store {
    pub fn new(state: &Path) -> Store {
        Store {
            root: state.join("code").join("graph"),
        }
    }
    pub fn blob_path(&self, sha: &str) -> PathBuf {
        self.root
            .join("blobs")
            .join(format!("v{STORE_SCHEMA}"))
            .join(&sha[..2])
            .join(format!("{sha}.json"))
    }
    pub fn tree_path(&self, tree: &str) -> PathBuf {
        self.root
            .join("trees")
            .join(format!("v{STORE_SCHEMA}"))
            .join(format!("{tree}.json"))
    }
    pub fn read(p: &Path) -> Option<Value> {
        serde_json::from_slice(&fs::read(p).ok()?).ok()
    }
    pub fn write(p: &Path, v: &Value) -> Result<(), String> {
        write_atomic(p, &serde_json::to_vec(v).map_err(|e| e.to_string())?)
    }

    /// take the tree's lock; when another process holds it, wait up to LOCK_WAIT_MS for it to go (then None: read its snapshot)
    pub fn lock(&self, tree: &str) -> Result<Option<Lock>, String> {
        let p = self
            .root
            .join("trees")
            .join(format!("v{STORE_SCHEMA}"))
            .join(format!("{tree}.lock"));
        fs::create_dir_all(p.parent().unwrap_or(&self.root)).map_err(|e| e.to_string())?;
        let t0 = Instant::now();
        loop {
            match fs::OpenOptions::new().write(true).create_new(true).open(&p) {
                Ok(_) => return Ok(Some(Lock(p))),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    if t0.elapsed() > Duration::from_millis(LOCK_WAIT_MS) {
                        return Ok(None);
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => return Err(format!("{}: {e}", p.display())),
            }
        }
    }

    /// commits.json gets this commit first (an older entry of it goes), cut to COMMITS_KEPT; HEAD when `head`
    pub fn record(&self, commit: &str, entry: Value, head: bool) -> Result<(), String> {
        let p = self.root.join("commits.json");
        let mut list: Vec<Value> = Store::read(&p)
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
        list.retain(|e| e["commit"] != json!(commit));
        let mut e = entry;
        e["commit"] = json!(commit);
        list.insert(0, e);
        list.truncate(COMMITS_KEPT);
        Store::write(&p, &Value::Array(list))?;
        if head {
            write_atomic(&self.root.join("HEAD"), format!("{commit}\n").as_bytes())?;
        }
        Ok(())
    }
}
