// Every threshold of norn-code in one place (SPEC code-graph section 6); docs/code-graph.md lists them.

/// the store's extractor schema: a blob fact or tree snapshot of another schema is never read
pub const STORE_SCHEMA: u32 = 3;
/// an edge's `spec` keeps at most this many characters of the source text
pub const SPEC_MAX: usize = 120;
/// a file whose first lines carry `@generated` or `DO NOT EDIT` is excluded (section 4.0 c)
pub const GENERATED_LINES: usize = 5;
/// a second writer of the same tree waits this long for the first one's lock, then reads its snapshot
pub const LOCK_WAIT_MS: u64 = 30_000;
/// commits.json keeps the newest this many indexed commits
pub const COMMITS_KEPT: usize = 200;
