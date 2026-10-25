//! One package's Cargo.toml and file list → what the planner needs: its dependencies and
//! feature map (as the resolver sees them), its targets (lib, bins, build script) with cargo's
//! auto-detection, and the metadata cargo hands to rustc and build scripts as `CARGO_PKG_*`.

use crate::manifest::gather;
use crate::summary::{DepKind, Source, Summary};
use cargo_util_schemas::manifest::{TomlLintLevel, TomlManifest, TomlPackageBuild, TomlTarget};
use semver::Version;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

#[derive(Debug, Clone)]
pub struct Target {
    pub name: String,
    /// `name` with `-` → `_`.
    pub crate_name: String,
    /// Relative to the package directory.
    pub path: String,
    pub crate_types: Vec<String>,
    pub edition: String,
    pub required_features: Vec<String>,
}

#[derive(Debug, Default)]
pub struct Meta {
    pub authors: Vec<String>,
    pub description: String,
    pub homepage: String,
    pub repository: String,
    pub license: String,
    pub license_file: String,
    pub readme: String,
    pub rust_version: String,
}

#[derive(Debug)]
pub struct Package {
    pub summary: Summary,
    /// Absolute directory of the sources (in the VFS, or on disk in tests).
    pub dir: String,
    pub edition: String,
    pub links: Option<String>,
    pub lib: Option<Target>,
    pub bins: Vec<Target>,
    /// The build script, relative to `dir`.
    pub build: Option<String>,
    pub meta: Meta,
    /// rustc arguments from `[lints]`: `--<level>=<lint>`, then `unexpected_cfgs`' check-cfg list.
    pub lint_args: Vec<String>,
    /// A placeholder for a package whose sources aren't there.
    pub missing: bool,
}

impl Package {
    pub fn missing(name: &str, version: &str, source: Source, dir: &str) -> Result<Package, String> {
        let version = Version::parse(version).map_err(|e| format!("{name} {version}: {e}"))?;
        let summary = Summary::new(name.into(), version, source, Vec::new(), &BTreeMap::new(), None, None)?;
        let meta = Meta::default();
        Ok(Package { summary, dir: dir.into(), edition: "2015".into(), links: None, lib: None, bins: Vec::new(), build: None, meta, lint_args: Vec::new(), missing: true })
    }

    pub fn name(&self) -> &str {
        &self.summary.name
    }

    pub fn version(&self) -> &Version {
        &self.summary.version
    }

    pub fn is_proc_macro(&self) -> bool {
        self.lib.as_ref().is_some_and(|l| l.crate_types.iter().any(|t| t == "proc-macro"))
    }

    pub fn manifest_path(&self) -> String {
        format!("{}/Cargo.toml", self.dir)
    }
}

/// `files`: every file of the package, relative to `dir` (for target auto-detection).
pub fn parse_package(text: &str, source: Source, dir: &str, files: &[String]) -> Result<Package, String> {
    let toml: TomlManifest = toml::from_str(text).map_err(|e| format!("{dir}/Cargo.toml: {e}"))?;
    let err = |e: cargo_util_schemas::manifest::UnresolvedError| format!("{dir}/Cargo.toml: {e}");
    let pkg = toml.package.as_ref().or(toml.project.as_ref()).ok_or_else(|| format!("{dir}/Cargo.toml has no [package]"))?;
    let name: Rc<str> = pkg.normalized_name().map_err(err)?.as_str().into();
    let version = pkg.normalized_version().map_err(err)?.cloned().unwrap_or_else(|| Version::new(0, 0, 0));
    let edition = pkg.normalized_edition().map_err(err)?.cloned().unwrap_or_else(|| "2015".into());
    let files: BTreeSet<&str> = files.iter().map(String::as_str).collect();

    let mut deps = Vec::new();
    // Dev dependencies never take part in `cargo build` (the planner gives them no edges), but
    // features may name them, so the feature map needs them.
    gather(&mut deps, toml.dependencies.as_ref(), DepKind::Normal, None)?;
    gather(&mut deps, toml.dev_dependencies(), DepKind::Development, None)?;
    gather(&mut deps, toml.build_dependencies(), DepKind::Build, None)?;
    for (target, platform) in toml.target.iter().flatten() {
        gather(&mut deps, platform.dependencies.as_ref(), DepKind::Normal, Some(target))?;
        gather(&mut deps, platform.build_dependencies(), DepKind::Build, Some(target))?;
        gather(&mut deps, platform.dev_dependencies(), DepKind::Development, Some(target))?;
    }
    let features: BTreeMap<Rc<str>, Vec<Rc<str>>> = toml
        .features
        .iter()
        .flatten()
        .map(|(k, v)| (k.as_str().into(), v.iter().map(|s| s.as_str().into()).collect()))
        .collect();
    let rust_version = pkg.normalized_rust_version().map_err(err)?.cloned();
    let links = pkg.links.clone();
    let summary = Summary::new(name.clone(), version, source, deps, &features, links.as_deref().map(Into::into), rust_version.clone())?;

    let target = |t: &TomlTarget, default_name: &str, default_path: Option<String>, kind: &str| -> Result<Target, String> {
        let name = t.name.clone().unwrap_or_else(|| default_name.to_string());
        let path = match &t.path {
            Some(p) => p.0.to_string_lossy().into_owned(),
            None => default_path.ok_or_else(|| format!("{dir}/Cargo.toml: can't find the source of {kind} target `{name}`"))?,
        };
        let crate_types = if t.proc_macro() == Some(true) {
            vec!["proc-macro".to_string()]
        } else {
            t.crate_types().cloned().unwrap_or_else(|| vec![if kind == "lib" { "lib" } else { "bin" }.to_string()])
        };
        Ok(Target {
            crate_name: name.replace('-', "_"),
            name,
            path,
            crate_types,
            edition: t.edition.clone().unwrap_or_else(|| edition.clone()),
            required_features: t.required_features.clone().unwrap_or_default(),
        })
    };

    let lib = match &toml.lib {
        Some(l) => Some(target(l, &name, files.contains("src/lib.rs").then(|| "src/lib.rs".into()), "lib")?),
        None if pkg.autolib != Some(false) && files.contains("src/lib.rs") => {
            Some(target(&TomlTarget::new(), &name, Some("src/lib.rs".into()), "lib")?)
        }
        None => None,
    };

    // Bins: the declared ones, then (unless `autobins = false`) the inferred ones not declared:
    // src/main.rs as the package's name, src/bin/<name>.rs and src/bin/<name>/main.rs.
    let mut bins = Vec::new();
    for b in toml.bin.iter().flatten() {
        let n = b.name.clone().ok_or_else(|| format!("{dir}/Cargo.toml: a [[bin]] needs a name"))?;
        let guess = [format!("src/bin/{n}.rs"), format!("src/bin/{n}/main.rs")]
            .into_iter()
            .chain((n == *name).then(|| "src/main.rs".to_string()))
            .find(|p| files.contains(p.as_str()));
        bins.push(target(b, &n, guess, "bin")?);
    }
    if pkg.autobins != Some(false) {
        let mut inferred: Vec<(String, String)> = Vec::new();
        if files.contains("src/main.rs") {
            inferred.push((name.to_string(), "src/main.rs".into()));
        }
        for f in &files {
            let Some(rest) = f.strip_prefix("src/bin/") else { continue };
            if let Some(stem) = rest.strip_suffix(".rs").filter(|s| !s.contains('/')) {
                inferred.push((stem.into(), f.to_string()));
            } else if let Some(d) = rest.strip_suffix("/main.rs").filter(|s| !s.contains('/')) {
                inferred.push((d.into(), f.to_string()));
            }
        }
        for (n, path) in inferred {
            if !bins.iter().any(|b| b.name == n || b.path == path) {
                bins.push(target(&TomlTarget::new(), &n, Some(path), "bin")?);
            }
        }
    }

    let build = match &pkg.build {
        None => files.contains("build.rs").then(|| "build.rs".to_string()),
        Some(TomlPackageBuild::Auto(false)) => None,
        Some(TomlPackageBuild::Auto(true)) => Some("build.rs".into()),
        Some(TomlPackageBuild::SingleScript(p)) => Some(p.clone()),
        Some(TomlPackageBuild::MultipleScript(_)) => return Err(format!("{dir}/Cargo.toml: several build scripts aren't supported")),
    };

    // cargo infers a readme when none is set: README.md, README.txt, README.
    let readme = match pkg.readme {
        Some(_) => pkg.normalized_readme().map_err(err)?.cloned().unwrap_or_default(),
        None => ["README.md", "README.txt", "README"].into_iter().find(|f| files.contains(f)).unwrap_or_default().to_string(),
    };
    let s = |v: Result<Option<&String>, _>| v.ok().flatten().cloned().unwrap_or_default();
    let meta = Meta {
        authors: pkg.normalized_authors().ok().flatten().cloned().unwrap_or_default(),
        description: s(pkg.normalized_description()),
        homepage: s(pkg.normalized_homepage()),
        repository: s(pkg.normalized_repository()),
        license: s(pkg.normalized_license()),
        license_file: s(pkg.normalized_license_file()),
        readme,
        rust_version: rust_version.map(|r| r.to_string()).unwrap_or_default(),
    };
    let lint_args = lint_args(toml.normalized_lints().map_err(err)?);
    Ok(Package { summary, dir: dir.to_string(), edition, links, lib, bins, build, meta, lint_args, missing: false })
}

/// cargo's `lints_to_rustflags` plus `check_cfg_args`' lint part: by priority, then by the
/// lint's name without its tool, descending.
fn lint_args(lints: Option<&cargo_util_schemas::manifest::TomlLints>) -> Vec<String> {
    let mut levels = Vec::new();
    let mut check_cfg = Vec::new();
    for (tool, table) in lints.into_iter().flatten() {
        for (bare, lint) in table {
            let name = if tool == "rust" { bare.clone() } else { format!("{tool}::{bare}") };
            let level = match lint.level() {
                TomlLintLevel::Forbid => "forbid",
                TomlLintLevel::Deny => "deny",
                TomlLintLevel::Warn => "warn",
                TomlLintLevel::Allow => "allow",
            };
            levels.push((lint.priority(), std::cmp::Reverse(bare.clone()), name.clone(), level));
            if name == "unexpected_cfgs" {
                let list = lint.config().and_then(|c| c.get("check-cfg")).and_then(|v| v.as_array());
                check_cfg.extend(list.into_iter().flatten().filter_map(|v| v.as_str()).map(|s| s.to_string()));
            }
        }
    }
    levels.sort();
    let mut out: Vec<String> = levels.into_iter().map(|(_, _, name, level)| format!("--{level}={name}")).collect();
    for c in check_cfg {
        out.extend(["--check-cfg".to_string(), c]);
    }
    out
}
