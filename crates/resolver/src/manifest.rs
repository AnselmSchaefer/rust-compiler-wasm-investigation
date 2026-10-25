//! The root package's Cargo.toml → a summary, plus the settings that steer the resolve
//! (edition and `resolver` → resolver behaviour, `rust-version` → MSRV fallback and lockfile
//! version). Dependencies are gathered in cargo's order: `[dependencies]`, `[dev-dependencies]`,
//! `[build-dependencies]`, then each `[target.*]` table (sorted) with normal, build, dev.

use crate::summary::{DepKind, Dependency, Source, Summary};
use cargo_util_schemas::manifest::{InheritableDependency, PackageName, RustVersion, TomlDependency, TomlManifest};
use semver::{Version, VersionReq};
use std::collections::BTreeMap;
use std::rc::Rc;

#[derive(Clone, Copy, PartialEq, Eq, Debug, PartialOrd, Ord)]
pub enum ResolveBehavior {
    V1,
    V2,
    /// Prefers versions compatible with the workspace's rust-version.
    V3,
}

pub struct RootManifest {
    pub summary: Summary,
    pub behavior: ResolveBehavior,
    pub rust_version: Option<RustVersion>,
}

pub fn parse_manifest(text: &str) -> Result<RootManifest, String> {
    parse_manifest_at(text, "")
}

/// A package's Cargo.toml in `dir`, after workspace inheritance (`workspace.rs`); `path`
/// dependencies are resolved against `dir`.
pub fn parse_manifest_at(text: &str, dir: &str) -> Result<RootManifest, String> {
    let toml: TomlManifest = toml::from_str(text).map_err(|e| format!("parsing Cargo.toml: {e}"))?;
    let pkg = toml.package.as_ref().or(toml.project.as_ref()).ok_or("Cargo.toml has no [package]")?;
    let name: Rc<str> = pkg.normalized_name().map_err(|e| e.to_string())?.as_str().into();
    let version = match pkg.normalized_version().map_err(|e| e.to_string())? {
        Some(v) => v.clone(),
        None => Version::new(0, 0, 0),
    };
    let edition = pkg.normalized_edition().map_err(|e| e.to_string())?.cloned().unwrap_or_else(|| "2015".into());
    let rust_version = pkg.normalized_rust_version().map_err(|e| e.to_string())?.cloned();
    let behavior = match pkg.resolver.as_deref() {
        Some("1") => ResolveBehavior::V1,
        Some("2") => ResolveBehavior::V2,
        Some("3") => ResolveBehavior::V3,
        Some(r) => return Err(format!("`resolver` setting `{r}` is not valid")),
        None => match edition.as_str() {
            "2015" | "2018" => ResolveBehavior::V1,
            "2021" => ResolveBehavior::V2,
            _ => ResolveBehavior::V3,
        },
    };

    let mut deps = Vec::new();
    gather(&mut deps, toml.dependencies.as_ref(), DepKind::Normal, None, dir)?;
    gather(&mut deps, toml.dev_dependencies(), DepKind::Development, None, dir)?;
    gather(&mut deps, toml.build_dependencies(), DepKind::Build, None, dir)?;
    for (target, platform) in toml.target.iter().flatten() {
        gather(&mut deps, platform.dependencies.as_ref(), DepKind::Normal, Some(target), dir)?;
        gather(&mut deps, platform.build_dependencies(), DepKind::Build, Some(target), dir)?;
        gather(&mut deps, platform.dev_dependencies(), DepKind::Development, Some(target), dir)?;
    }

    let features: BTreeMap<Rc<str>, Vec<Rc<str>>> = toml
        .features
        .iter()
        .flatten()
        .map(|(k, v)| (k.as_str().into(), v.iter().map(|s| s.as_str().into()).collect()))
        .collect();
    let mut summary = Summary::new(name, version, Source::Path, deps, &features, pkg.links.as_deref().map(Into::into), rust_version.clone())?;
    summary.dir = Some(dir.into());
    Ok(RootManifest { summary, behavior, rust_version })
}

pub(crate) fn gather(
    out: &mut Vec<Rc<Dependency>>,
    table: Option<&BTreeMap<PackageName, InheritableDependency>>,
    kind: DepKind,
    target: Option<&String>,
    dir: &str,
) -> Result<(), String> {
    for (key, dep) in table.into_iter().flatten() {
        let InheritableDependency::Value(dep) = dep else {
            return Err(format!("dependency `{key}` inherits from a workspace that wasn't applied (workspace.rs)"));
        };
        let mut path = None;
        let (req, package, optional, default_features, features) = match dep {
            TomlDependency::Simple(v) => (Some(v.as_str()), None, false, true, Vec::new()),
            TomlDependency::Detailed(d) => {
                if d.git.is_some() || d.registry.is_some() || d.registry_index.is_some() {
                    return Err(format!("dependency `{key}`: only crates.io and path dependencies are supported"));
                }
                path = d.path.as_deref().map(|p| Rc::from(crate::workspace::join(dir, p)));
                (
                    d.version.as_deref(),
                    d.package.as_ref().map(|p| p.as_str()),
                    d.optional.unwrap_or(false),
                    d.default_features().unwrap_or(true),
                    d.features.clone().unwrap_or_default(),
                )
            }
        };
        let req = match req {
            Some(r) => VersionReq::parse(r).map_err(|e| format!("dependency `{key}`: version `{r}`: {e}"))?,
            None => VersionReq::STAR,
        };
        let name_in_toml: Rc<str> = key.as_str().into();
        out.push(Rc::new(Dependency {
            path,
            package: package.map(Into::into).unwrap_or_else(|| name_in_toml.clone()),
            name_in_toml,
            req,
            kind,
            optional,
            default_features,
            features: features.iter().filter(|f| !f.is_empty()).map(|f| f.as_str().into()).collect(),
            target: target.cloned(),
        }));
    }
    Ok(())
}
