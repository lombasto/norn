// Every threshold of norn-code in one place (SPEC code-graph section 6); docs/code-graph.md lists them.

/// the store's extractor schema: a blob fact or tree snapshot of another schema is never read
pub const STORE_SCHEMA: u32 = 5;
/// an edge's `spec` keeps at most this many characters of the source text
pub const SPEC_MAX: usize = 120;
/// a file whose first lines carry `@generated` or `DO NOT EDIT` is excluded (section 4.0 c)
pub const GENERATED_LINES: usize = 5;
/// a second writer of the same tree waits this long for the first one's lock, then reads its snapshot
pub const LOCK_WAIT_MS: u64 = 30_000;
/// commits.json keeps the newest this many indexed commits
pub const COMMITS_KEPT: usize = 200;
/// `grade files` (grade.rs, SPEC section 5): the sampled rows per language, stratified by `how`
pub const GRADE_PER_LANG: usize = 400;
/// `grade files`: the seed of the draw when none is given (the grade file records the one used)
pub const GRADE_SEED: u64 = 1;
/// the file-edge bars of SPEC section 5: precision per (language, how) class, recall per language (static imports)
pub const FILE_PRECISION_BAR: f64 = 0.99;
pub const FILE_RECALL_BAR: f64 = 0.98;
/// the Wilson score interval's z (95 %)
pub const WILSON_Z: f64 = 1.96;
/// `grade calls` (S4b): the definition-bounds bars of SPEC section 5, exact `line..end_line` per (language, kind) class, recall per language
pub const DEF_PRECISION_BAR: f64 = 0.99;
pub const DEF_RECALL_BAR: f64 = 0.99;
/// the call-edge bars of SPEC section 5, JavaScript / TypeScript / Python: precision per (language, how) class, recall per language
pub const CALL_PRECISION_BAR: f64 = 0.90;
pub const CALL_RECALL_BAR: f64 = 0.70;
/// the call-edge bars for Rust (traits, generics and macros)
pub const CALL_PRECISION_BAR_RUST: f64 = 0.85;
pub const CALL_RECALL_BAR_RUST: f64 = 0.60;
