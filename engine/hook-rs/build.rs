// The hash of the sources this binary is built from (NORN-PART-PROOF, docs/code-graph.md "The norn-code binary"), given to the crate as
// NORN_SOURCE; its `version` prints it, and Norn (engine/lib/rustbin.mjs partProblem) refuses a store entry whose answer is not the
// hash in its name. The rule is rustbin.mjs sourceHash's, byte for byte: every file under the crate dir but any entry named `target`,
// as relative posix paths sorted by UTF-16 unit (JavaScript's sort), each hashed as path + NUL + bytes + NUL; sha256, the first 12 hex.
// It hashes the files cargo builds from, so a developer's or CI's own `cargo build` prints the true hash too. This file is the same in
// engine/hook-rs and engine/code-rs, and tests/rustbin.test.mjs holds it to the JavaScript rule on one file set. std only: norn-hook
// builds with nothing but cargo (no registry fetch), so sha256 (FIPS 180-4) is written out below. No rerun-if line: cargo then reruns
// this script when any file of the package changes, and Norn's `cargo clean -p` before each build reruns it anyway.
use std::env;
use std::fs;
use std::path::Path;

fn files(root: &Path, rel: &str, out: &mut Vec<String>) {
    let dir = if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    };
    for e in fs::read_dir(&dir).unwrap_or_else(|e| panic!("cannot list {}: {e}", dir.display())) {
        let e = e.expect("a directory entry");
        let name = e.file_name().to_string_lossy().into_owned();
        if name == "target" {
            continue;
        }
        let p = if rel.is_empty() {
            name
        } else {
            format!("{rel}/{name}")
        };
        if e.file_type().expect("a file type").is_dir() {
            files(root, &p, out);
        } else {
            out.push(p);
        }
    }
}

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

fn sha256(m: &[u8]) -> [u32; 8] {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut d = m.to_vec();
    d.push(0x80);
    while d.len() % 64 != 56 {
        d.push(0);
    }
    d.extend_from_slice(&((m.len() as u64) * 8).to_be_bytes());
    for block in d.chunks(64) {
        let mut w = [0u32; 64];
        for (x, b) in w.iter_mut().zip(block.chunks(4)) {
            *x = u32::from_be_bytes([b[0], b[1], b[2], b[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let mut v = h;
        for (k, x) in K.iter().zip(w.iter()) {
            let [a, b, c, dd, e, f, g, hh] = v;
            let t1 = hh
                .wrapping_add(e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25))
                .wrapping_add((e & f) ^ (!e & g))
                .wrapping_add(*k)
                .wrapping_add(*x);
            let t2 = (a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22))
                .wrapping_add((a & b) ^ (a & c) ^ (b & c));
            v = [t1.wrapping_add(t2), a, b, c, dd.wrapping_add(t1), e, f, g];
        }
        for (x, y) in h.iter_mut().zip(v) {
            *x = x.wrapping_add(y);
        }
    }
    h
}

fn main() {
    let root = env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
    let root = Path::new(&root);
    let mut list = Vec::new();
    files(root, "", &mut list);
    list.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let mut all = Vec::new();
    for f in &list {
        all.extend_from_slice(f.as_bytes());
        all.push(0);
        all.extend(fs::read(root.join(f)).unwrap_or_else(|e| panic!("cannot read {f}: {e}")));
        all.push(0);
    }
    let hex: String = sha256(&all).iter().map(|x| format!("{x:08x}")).collect();
    println!("cargo:rustc-env=NORN_SOURCE={}", &hex[..12]);
}
