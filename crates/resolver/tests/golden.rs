//! WP-15 golden test: resolve each corpus crate (tests/resolver/manifests/<name>.toml) against
//! the pinned index snapshot and compare with native cargo's lockfile (tests/resolver/golden/).
//! The snapshot must be unpacked first (scripts/verify/wp-15.sh does it):
//!   zstd -dc tests/resolver/index-snapshot.tar.zst | tar -x -C build/wp-15
//! Our lockfiles go to build/wp-15/out/ for diffing. Set GOLDEN_ONLY=name to run one crate.

use resolver::{DirRegistry, generate_lockfile};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Instant;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap()
}

/// `name version` of every [[package]] in a lockfile.
fn packages(lock: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut name = None;
    for line in lock.lines() {
        if let Some(n) = line.strip_prefix("name = ") {
            name = Some(n.trim_matches('"').to_string());
        } else if let Some(v) = line.strip_prefix("version = \"") {
            if let Some(n) = name.take() {
                out.insert(format!("{n} {}", v.trim_end_matches('"')));
            }
        }
    }
    out
}

#[test]
fn golden_lockfiles() {
    let root = repo();
    let index = std::env::var_os("RESOLVER_INDEX").map(PathBuf::from).unwrap_or_else(|| root.join("build/wp-15/index"));
    assert!(index.is_dir(), "index snapshot not unpacked at {}", index.display());
    let registry = DirRegistry(index);
    let out_dir = root.join("build/wp-15/out");
    std::fs::create_dir_all(&out_dir).unwrap();
    let only = std::env::var("GOLDEN_ONLY").ok();

    let corpus = std::fs::read_to_string(root.join("tests/resolver/corpus.txt")).unwrap();
    let names: Vec<&str> = corpus
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter(|n| only.as_deref().is_none_or(|o| o == *n))
        .collect();
    let (mut matched, mut failed) = (0, Vec::new());
    let start = Instant::now();
    for name in &names {
        let manifest = std::fs::read_to_string(root.join(format!("tests/resolver/manifests/{name}.toml"))).unwrap();
        let expected = std::fs::read_to_string(root.join(format!("tests/resolver/golden/{name}.lock"))).unwrap();
        let t = Instant::now();
        let ours = generate_lockfile(&manifest, &registry);
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        match ours {
            Ok(lock) if lock == expected => {
                matched += 1;
                println!("  ok    {name} ({} packages, {ms:.0} ms)", packages(&lock).len());
            }
            Ok(lock) => {
                std::fs::write(out_dir.join(format!("{name}.lock")), &lock).unwrap();
                let (ours, theirs) = (packages(&lock), packages(&expected));
                let extra: Vec<_> = ours.difference(&theirs).collect();
                let missing: Vec<_> = theirs.difference(&ours).collect();
                println!("  DIFF  {name}: extra {extra:?}, missing {missing:?}");
                failed.push(*name);
            }
            Err(e) => {
                println!("  ERROR {name}: {e}");
                failed.push(*name);
            }
        }
    }
    println!("golden: {matched}/{} identical in {:.1} s; mismatches: {failed:?}", names.len(), start.elapsed().as_secs_f64());
    if only.is_none() {
        assert!(matched >= 48, "{matched}/50 lockfiles identical (need ≥ 48)");
    } else {
        assert!(failed.is_empty());
    }
}

/// The browser's protocol: index files arrive only between resolves (as JS fetches what the
/// last round reported pending). Must end at the same lockfile, in about graph-depth rounds.
#[test]
fn fetch_rounds() {
    use resolver::index::IndexFile;
    use resolver::resolve::{IndexCache, resolve_cached};
    use std::cell::RefCell;
    use std::collections::HashSet;

    struct Rounds<'a> {
        dir: &'a DirRegistry,
        fetched: HashSet<String>,
        pending: RefCell<HashSet<String>>,
    }
    impl resolver::Registry for Rounds<'_> {
        fn index_file(&self, name: &str) -> Result<IndexFile, String> {
            if self.fetched.contains(name) {
                self.dir.index_file(name)
            } else {
                self.pending.borrow_mut().insert(name.to_string());
                Ok(IndexFile::Pending)
            }
        }
    }

    let root = repo();
    let dir = DirRegistry(std::env::var_os("RESOLVER_INDEX").map(PathBuf::from).unwrap_or_else(|| root.join("build/wp-15/index")));
    for name in ["serde_json", "tokio", "reqwest", "bevy", "nu"] {
        let manifest = std::fs::read_to_string(root.join(format!("tests/resolver/manifests/{name}.toml"))).unwrap();
        let expected = std::fs::read_to_string(root.join(format!("tests/resolver/golden/{name}.lock"))).unwrap();
        let mut reg = Rounds { dir: &dir, fetched: HashSet::new(), pending: RefCell::default() };
        let mut cache = IndexCache::default();
        let t = Instant::now();
        let mut rounds = 0;
        let resolve = loop {
            rounds += 1;
            let root_manifest = resolver::parse_manifest(&manifest).unwrap();
            if let Some(r) = resolve_cached(root_manifest, &reg, &mut cache).unwrap() {
                break r;
            }
            let p = std::mem::take(&mut *reg.pending.borrow_mut());
            assert!(!p.is_empty());
            reg.fetched.extend(p);
        };
        assert_eq!(resolver::write_lockfile(&resolve), expected, "{name}");
        println!("  rounds {name}: {rounds} rounds, {} index files, {:.0} ms", reg.fetched.len(), t.elapsed().as_secs_f64() * 1000.0);
    }
}
