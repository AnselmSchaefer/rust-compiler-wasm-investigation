//! The sparse index: one file per package, one JSON line per version
//! (https://doc.rust-lang.org/cargo/reference/registry-index.html). Parsing follows cargo's
//! `IndexSummary::parse`: entries it can't turn into a summary, or with a schema version above 2,
//! are kept out of the candidates, and yanked entries are never chosen for a fresh resolve.

use crate::summary::{DepKind, Dependency, Source, Summary};
use cargo_util_schemas::index::IndexPackage;
use semver::VersionReq;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::rc::Rc;

/// The index schema version cargo 1.99 understands (without `-Zbindeps`).
const INDEX_V_MAX: u32 = 2;

/// Where the resolver gets index files from: the snapshot directory in tests, files fetched by
/// JS in the browser (WP-16).
pub trait Registry {
    fn index_file(&self, name: &str) -> Result<IndexFile, String>;
}

pub enum IndexFile {
    Found(Vec<u8>),
    /// The package doesn't exist.
    NotFound,
    /// Not loaded yet. The resolve goes on without it (as cargo does while its index requests are
    /// in flight) and reports itself incomplete; the caller fetches the file and resolves again.
    Pending,
}

/// The path of a package's file in the index, e.g. `se/rd/serde`, `3/s/syn`, `2/cc`.
pub fn index_path(name: &str) -> String {
    let n = name.to_lowercase();
    match n.len() {
        1 => format!("1/{n}"),
        2 => format!("2/{n}"),
        3 => format!("3/{}/{n}", &n[..1]),
        _ => format!("{}/{}/{n}", &n[..2], &n[2..4]),
    }
}

/// An index laid out on disk the way the sparse protocol serves it.
pub struct DirRegistry(pub PathBuf);

impl Registry for DirRegistry {
    fn index_file(&self, name: &str) -> Result<IndexFile, String> {
        match std::fs::read(self.0.join(index_path(name))) {
            Ok(b) => Ok(IndexFile::Found(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(IndexFile::NotFound),
            Err(e) => Err(format!("reading the index file of `{name}`: {e}")),
        }
    }
}

/// One index line.
pub struct IndexEntry {
    pub summary: std::rc::Rc<Summary>,
    pub yanked: bool,
}

/// Parses an index file. Lines that aren't usable candidates (unparsable, invalid, newer schema)
/// are dropped, as cargo never offers them for a fresh resolve.
pub fn parse_index_file(data: &[u8]) -> Vec<IndexEntry> {
    data.split(|&b| b == b'\n')
        .filter(|l| !l.is_empty())
        .filter_map(parse_line)
        .collect()
}

fn parse_line(line: &[u8]) -> Option<IndexEntry> {
    let pkg: IndexPackage<'_> = serde_json::from_slice(line).ok()?;
    if pkg.v.unwrap_or(1) > INDEX_V_MAX {
        return None;
    }
    let yanked = pkg.yanked.unwrap_or(false);
    let mut deps = Vec::with_capacity(pkg.deps.len());
    for d in pkg.deps {
        if d.registry.is_some() {
            // A dependency on another registry: not something crates.io accepts any more, and
            // nothing we can fetch. Treat the entry as unusable.
            return None;
        }
        let req = VersionReq::parse(&d.req).ok()?;
        if let Some(t) = &d.target {
            t.parse::<cargo_platform::Platform>().ok()?;
        }
        let package: Rc<str> = d.package.as_deref().unwrap_or(&d.name).into();
        let name_in_toml: Rc<str> = if d.package.is_some() { d.name.as_ref().into() } else { package.clone() };
        let kind = match d.kind.as_deref().unwrap_or("") {
            "dev" => DepKind::Development,
            "build" => DepKind::Build,
            _ => DepKind::Normal,
        };
        deps.push(Rc::new(Dependency {
            package,
            name_in_toml,
            req,
            kind,
            optional: d.optional,
            default_features: d.default_features,
            // Old entries carry "" in their feature lists; cargo drops it.
            features: d.features.iter().filter(|f| !f.is_empty()).map(|f| f.as_ref().into()).collect(),
            target: d.target.map(|t| t.into_owned()),
        }));
    }
    let mut features: BTreeMap<Rc<str>, Vec<Rc<str>>> = BTreeMap::new();
    for (k, v) in pkg.features.into_iter().chain(pkg.features2.into_iter().flatten()) {
        features.entry(k.as_ref().into()).or_default().extend(v.iter().map(|s| s.as_ref().into()));
    }
    let mut summary = Summary::new(
        pkg.name.as_ref().into(),
        pkg.vers,
        Source::Registry,
        deps,
        &features,
        pkg.links.map(|l| l.as_ref().into()),
        pkg.rust_version,
    )
    .ok()?;
    summary.checksum = Some(pkg.cksum);
    Some(IndexEntry { summary: Rc::new(summary), yanked })
}
