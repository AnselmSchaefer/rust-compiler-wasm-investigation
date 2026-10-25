//! Workspaces (WP-25): every Cargo.toml of a project → its members, their manifests with
//! workspace inheritance applied, and the other path packages they depend on. Follows cargo's
//! `core/workspace.rs` and `util/toml/mod.rs` (inheritance) for what projects commonly use:
//!
//! - `[workspace] members` (globs: `*`, `?` within a path segment), `exclude`, `default-members`,
//!   `resolver`; the root package, if any, is a member. Path dependencies inside the workspace
//!   directory become members too, unless excluded. Other path dependencies are plain path
//!   packages: built, but not members (no inheritance, not primary).
//! - `field.workspace = true` for `[package]` fields from `[workspace.package]` (`readme` and
//!   `license-file` re-rooted to the member), `dep.workspace = true` from
//!   `[workspace.dependencies]` (features added, `optional` from the member), and
//!   `[lints] workspace = true` from `[workspace.lints]`.
//! - Every `path` of a dependency becomes absolute, so manifests can be read on their own.
//!
//! Directories are absolute, '/'-separated strings (VFS paths, or `$ROOT/...` in tests). No
//! `[patch]`, `[replace]`, git dependencies, or nested workspaces.

use crate::manifest::{ResolveBehavior, parse_manifest_at};
use crate::resolve::{IndexCache, Resolve, Roots, resolve_roots};
use crate::index::Registry;
use std::collections::BTreeMap;
use toml::{Table, Value};

pub struct WsPackage {
    pub dir: String,
    /// Cargo.toml after inheritance, with absolute dependency paths.
    pub manifest: String,
    pub member: bool,
}

pub struct Workspace {
    pub root: String,
    /// Members first (cargo's order: listed members, then path dependencies found from them),
    /// then other path packages.
    pub packages: Vec<WsPackage>,
    /// What `cargo build` in the root builds: `default-members`, else the root package, else
    /// (a virtual manifest) every member.
    pub default_members: Vec<usize>,
    /// The `resolver` setting: 1, 2 or 3.
    pub resolver: u32,
}

/// `dir` + `path` (relative or absolute), with `.` and `..` resolved.
pub fn join(dir: &str, path: &str) -> String {
    let full = if path.starts_with('/') || path.starts_with('$') || dir.is_empty() { path.to_string() } else { format!("{dir}/{path}") };
    let mut out: Vec<&str> = Vec::new();
    for seg in full.split('/') {
        match seg {
            "" | "." if !out.is_empty() => {}
            ".." if out.len() > 1 => {
                out.pop();
            }
            _ => out.push(seg),
        }
    }
    let s = out.join("/");
    if s.is_empty() { "/".into() } else { s }
}

/// The relative path from directory `from` to `to` (both absolute and normalized).
fn relative(from: &str, to: &str) -> String {
    let (f, t): (Vec<&str>, Vec<&str>) = (from.split('/').collect(), to.split('/').collect());
    let common = f.iter().zip(&t).take_while(|(a, b)| a == b).count();
    let mut parts: Vec<&str> = vec![".."; f.len() - common];
    parts.extend(&t[common..]);
    if parts.is_empty() { ".".into() } else { parts.join("/") }
}

fn under(dir: &str, root: &str) -> bool {
    dir == root || dir.starts_with(&format!("{root}/"))
}

/// One path segment against a glob segment (`*`, `?`).
fn seg_matches(pat: &[u8], s: &[u8]) -> bool {
    match (pat.first(), s.first()) {
        (None, None) => true,
        (Some(b'*'), _) => seg_matches(&pat[1..], s) || (!s.is_empty() && seg_matches(pat, &s[1..])),
        (Some(b'?'), Some(_)) => seg_matches(&pat[1..], &s[1..]),
        (Some(p), Some(c)) if p == c => seg_matches(&pat[1..], &s[1..]),
        _ => false,
    }
}

fn glob_matches(pattern: &str, path: &str) -> bool {
    let (p, s): (Vec<&str>, Vec<&str>) = (pattern.split('/').collect(), path.split('/').collect());
    p.len() == s.len() && p.iter().zip(&s).all(|(a, b)| seg_matches(a.as_bytes(), b.as_bytes()))
}

fn parse(dir: &str, text: &str) -> Result<Table, String> {
    toml::from_str(text).map_err(|e| format!("{dir}/Cargo.toml: {e}"))
}

const DEP_TABLES: [&str; 5] = ["dependencies", "dev-dependencies", "dev_dependencies", "build-dependencies", "build_dependencies"];

/// The dependency tables of a manifest: top level and per `[target.*]`.
fn dep_tables(t: &mut Table) -> Vec<(&String, &mut Table)> {
    let mut out = Vec::new();
    let mut targets = None;
    for (k, v) in t.iter_mut() {
        if DEP_TABLES.contains(&k.as_str()) {
            if let Value::Table(d) = v {
                out.push((k, d));
            }
        } else if k == "target" {
            targets = Some(v);
        }
    }
    if let Some(Value::Table(targets)) = targets {
        for (_, platform) in targets.iter_mut() {
            if let Value::Table(p) = platform {
                for (k, v) in p.iter_mut() {
                    if DEP_TABLES.contains(&k.as_str()) {
                        if let Value::Table(d) = v {
                            out.push((k, d));
                        }
                    }
                }
            }
        }
    }
    out
}

fn is_inherit(v: &Value) -> bool {
    v.as_table().and_then(|t| t.get("workspace")).and_then(Value::as_bool) == Some(true)
}

/// Apply `[workspace]` inheritance to a member's manifest (`ws`: the root's `[workspace]`).
fn inherit(dir: &str, mut t: Table, root: &str, ws: &Table) -> Result<Table, String> {
    let empty = Table::new();
    let wpkg = ws.get("package").and_then(Value::as_table).unwrap_or(&empty);
    if let Some(Value::Table(pkg)) = t.get_mut("package") {
        for (k, v) in pkg.iter_mut() {
            if !is_inherit(v) {
                continue;
            }
            let mut w = wpkg.get(k).cloned().ok_or_else(|| format!("{dir}/Cargo.toml: `package.{k}` inherits from `[workspace.package]`, which doesn't define it"))?;
            if k == "readme" || k == "license-file" {
                if let Value::String(p) = &w {
                    w = Value::String(relative(dir, &join(root, p)));
                }
            }
            *v = w;
        }
    }
    let wdeps = ws.get("dependencies").and_then(Value::as_table).unwrap_or(&empty);
    for (_, deps) in dep_tables(&mut t) {
        for (name, v) in deps.iter_mut() {
            if !is_inherit(v) {
                continue;
            }
            let member = v.as_table().unwrap().clone();
            let base = wdeps.get(name).ok_or_else(|| format!("{dir}/Cargo.toml: dependency `{name}` inherits from `[workspace.dependencies]`, which doesn't define it"))?;
            let mut d = match base {
                Value::String(req) => Table::from_iter([("version".to_string(), Value::String(req.clone()))]),
                Value::Table(b) => b.clone(),
                _ => return Err(format!("[workspace.dependencies] `{name}`: expected a string or table")),
            };
            if let Some(Value::String(p)) = d.get("path") {
                d.insert("path".into(), Value::String(join(root, p)));
            }
            if let Some(Value::Array(extra)) = member.get("features") {
                let mut f = d.get("features").and_then(Value::as_array).cloned().unwrap_or_default();
                f.extend(extra.iter().cloned());
                d.insert("features".into(), Value::Array(f));
            }
            for k in ["optional", "public"] {
                if let Some(x) = member.get(k) {
                    d.insert(k.into(), x.clone());
                }
            }
            if !d.contains_key("default-features") && !d.contains_key("default_features") {
                if let Some(x) = member.get("default-features").or_else(|| member.get("default_features")) {
                    d.insert("default-features".into(), x.clone());
                }
            }
            *v = Value::Table(d);
        }
    }
    if t.get("lints").is_some_and(is_inherit) {
        let l = ws.get("lints").cloned().ok_or_else(|| format!("{dir}/Cargo.toml: `[lints]` inherits from `[workspace.lints]`, which doesn't exist"))?;
        t.insert("lints".into(), l);
    }
    Ok(t)
}

/// Every dependency `path` → absolute (from `dir`).
fn absolute_paths(dir: &str, t: &mut Table) {
    for (_, deps) in dep_tables(t) {
        for (_, v) in deps.iter_mut() {
            if let Some(Value::String(p)) = v.as_table_mut().and_then(|d| d.get_mut("path")) {
                *p = join(dir, p);
            }
        }
    }
}

/// The path dependencies of a (normalized) manifest.
fn path_deps(t: &Table) -> Vec<String> {
    let mut t = t.clone();
    let mut out = Vec::new();
    for (_, deps) in dep_tables(&mut t) {
        for (_, v) in deps.iter() {
            if let Some(p) = v.as_table().and_then(|d| d.get("path")).and_then(Value::as_str) {
                out.push(p.to_string());
            }
        }
    }
    out
}

/// `manifests`: directory → Cargo.toml text, for every package of the project (at least the
/// root's). `root`: the directory `cargo build` runs in.
pub fn load(root: &str, manifests: &BTreeMap<String, String>) -> Result<Workspace, String> {
    let root = join(root, "");
    let get = |dir: &str| manifests.get(dir).ok_or_else(|| format!("no Cargo.toml in {dir}"));
    let root_table = parse(&root, get(&root)?)?;
    let empty = Table::new();
    let ws = root_table.get("workspace").and_then(Value::as_table).cloned();
    let wst = ws.as_ref().unwrap_or(&empty);
    let strings = |k: &str| -> Vec<String> {
        wst.get(k).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(String::from).collect()
    };
    let excluded: Vec<String> = strings("exclude").iter().map(|e| join(&root, e)).collect();
    let is_excluded = |d: &str| excluded.iter().any(|e| under(d, e));
    let has_package = root_table.contains_key("package");
    if !has_package && ws.is_none() {
        return Err(format!("{root}/Cargo.toml has neither [package] nor [workspace]"));
    }

    // Members: the listed ones (globs expanded against the project's manifests, sorted), the
    // root package, then path dependencies inside the workspace, found depth-first.
    let mut member_dirs: Vec<String> = Vec::new();
    let add = |d: String, list: &mut Vec<String>| {
        if !list.contains(&d) {
            list.push(d);
        }
    };
    for m in strings("members") {
        let pat = join(&root, &m);
        if m.contains(['*', '?', '[']) {
            let mut found: Vec<&String> = manifests.keys().filter(|d| glob_matches(&pat, d) && !is_excluded(d)).collect();
            found.sort();
            for d in found {
                add(d.clone(), &mut member_dirs);
            }
        } else {
            get(&pat)?;
            add(pat, &mut member_dirs);
        }
    }
    if has_package {
        add(root.clone(), &mut member_dirs);
    }
    let mut normalized: BTreeMap<String, Table> = BTreeMap::new();
    let mut others: Vec<String> = Vec::new();
    let mut i = 0;
    while i < member_dirs.len() {
        let dir = member_dirs[i].clone();
        let mut t = parse(&dir, get(&dir)?)?;
        if !t.contains_key("package") {
            return Err(format!("{dir}/Cargo.toml is a member but has no [package]"));
        }
        if dir != root && t.contains_key("workspace") {
            return Err(format!("{dir}/Cargo.toml: nested workspaces aren't supported"));
        }
        t.remove("workspace");
        t = inherit(&dir, t, &root, wst)?;
        absolute_paths(&dir, &mut t);
        for p in path_deps(&t) {
            if ws.is_some() && under(&p, &root) && !is_excluded(&p) {
                add(p, &mut member_dirs);
            } else if !others.contains(&p) {
                others.push(p);
            }
        }
        normalized.insert(dir, t);
        i += 1;
    }
    // Non-member path packages and their own path dependencies.
    let mut j = 0;
    while j < others.len() {
        let dir = others[j].clone();
        if member_dirs.contains(&dir) {
            others.remove(j);
            continue;
        }
        let mut t = parse(&dir, get(&dir)?)?;
        absolute_paths(&dir, &mut t);
        for p in path_deps(&t) {
            if !others.contains(&p) && !member_dirs.contains(&p) {
                others.push(p);
            }
        }
        normalized.insert(dir, t);
        j += 1;
    }

    let mut packages = Vec::new();
    for (dirs, member) in [(&member_dirs, true), (&others, false)] {
        for d in dirs {
            let manifest = toml::to_string(&normalized[d]).map_err(|e| e.to_string())?;
            packages.push(WsPackage { dir: d.clone(), manifest, member });
        }
    }
    let default_members = match ws.as_ref().and_then(|w| w.get("default-members")) {
        Some(_) => strings("default-members")
            .iter()
            .map(|m| {
                let d = join(&root, m);
                member_dirs.iter().position(|x| *x == d).ok_or_else(|| format!("default-members: {m} is not a member"))
            })
            .collect::<Result<_, _>>()?,
        // cargo: the root package if there is one, else (a virtual manifest) every member.
        None if has_package => vec![member_dirs.iter().position(|d| *d == root).unwrap()],
        None => (0..member_dirs.len()).collect(),
    };
    let resolver = match wst.get("resolver").and_then(Value::as_str) {
        Some(r) => r.parse().map_err(|_| format!("`resolver` setting `{r}` is not valid"))?,
        None if has_package => {
            let pkg = normalized[&root]["package"].as_table().unwrap();
            match pkg.get("resolver").and_then(Value::as_str) {
                Some(r) => r.parse().map_err(|_| format!("`resolver` setting `{r}` is not valid"))?,
                None => match pkg.get("edition").and_then(Value::as_str).unwrap_or("2015") {
                    "2015" | "2018" => 1,
                    "2021" => 2,
                    _ => 3,
                },
            }
        }
        // A virtual manifest without `resolver` gets the original resolver (cargo warns).
        None => 1,
    };
    Ok(Workspace { root, packages, default_members, resolver })
}

impl Workspace {
    pub fn members(&self) -> impl Iterator<Item = &WsPackage> {
        self.packages.iter().filter(|p| p.member)
    }

    /// The resolve inputs: each member a root, the other path packages available to them.
    pub fn roots(&self) -> Result<Roots, String> {
        let behavior = match self.resolver {
            1 => ResolveBehavior::V1,
            2 => ResolveBehavior::V2,
            _ => ResolveBehavior::V3,
        };
        let (mut members, mut paths, mut rust_version) = (Vec::new(), Vec::new(), None);
        for p in &self.packages {
            let m = parse_manifest_at(&p.manifest, &p.dir)?;
            if p.member {
                // The lowest rust-version picks MSRV-aware candidates and the lockfile version.
                if let Some(r) = &m.rust_version {
                    if rust_version.as_ref().is_none_or(|x| r < x) {
                        rust_version = Some(r.clone());
                    }
                }
                members.push(m.summary);
            } else {
                paths.push(m.summary);
            }
        }
        Ok(Roots { members, paths, behavior, rust_version })
    }

    pub fn resolve_cached(&self, registry: &dyn Registry, cache: &mut IndexCache) -> Result<Option<Resolve>, String> {
        resolve_roots(self.roots()?, registry, cache)
    }

    pub fn resolve(&self, registry: &dyn Registry) -> Result<Resolve, String> {
        self.resolve_cached(registry, &mut IndexCache::default())?.ok_or_else(|| "the registry left index files pending".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        assert_eq!(join("/p/app", "../libs/core"), "/p/libs/core");
        assert_eq!(join("$ROOT/a", "./b/../c"), "$ROOT/a/c");
        assert_eq!(join("/p", "/abs"), "/abs");
        assert_eq!(relative("/p/a/b", "/p/README.md"), "../../README.md");
        assert!(glob_matches("/p/libs/*", "/p/libs/core"));
        assert!(!glob_matches("/p/libs/*", "/p/libs/core/x"));
        assert!(glob_matches("/p/c?re", "/p/core"));
    }
}
