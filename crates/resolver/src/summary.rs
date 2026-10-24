//! Package summaries: what the resolver knows about one version of a package.
//! The same shape comes from a sparse-index line (`index.rs`) and from the root's Cargo.toml
//! (`manifest.rs`). Mirrors cargo's `Summary`, `Dependency` and `FeatureValue`.

use cargo_util_schemas::manifest::RustVersion;
use semver::{Version, VersionReq};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::rc::Rc;

/// Where a package comes from. Only the root is a path package; everything else is crates.io.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub enum Source {
    Path,
    Registry,
}

/// The source string cargo writes into Cargo.lock for crates.io (v3 and v4 alike).
pub const CRATES_IO_SOURCE: &str = "registry+https://github.com/rust-lang/crates.io-index";

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum DepKind {
    Normal,
    Build,
    Development,
}

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct Dependency {
    /// The package's name in the registry (`package = "..."` for a renamed dependency).
    pub package: Rc<str>,
    /// The key in the manifest's dependency table; what features refer to.
    pub name_in_toml: Rc<str>,
    pub req: VersionReq,
    pub kind: DepKind,
    pub optional: bool,
    pub default_features: bool,
    pub features: Vec<Rc<str>>,
    /// `cfg(...)` or a target triple. The resolver ignores it (the lockfile is platform-independent).
    pub target: Option<String>,
}

impl Dependency {
    /// Dev dependencies only count for the root.
    pub fn is_transitive(&self) -> bool {
        self.kind != DepKind::Development
    }
}

#[derive(Clone, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub enum FeatureValue {
    /// `"feat"`: another feature of this package (or an implicit optional-dependency feature).
    Feature(Rc<str>),
    /// `"dep:name"`: an optional dependency, without creating an implicit feature.
    Dep(Rc<str>),
    /// `"name/feat"` or, weak, `"name?/feat"`.
    DepFeature { dep_name: Rc<str>, dep_feature: Rc<str>, weak: bool },
}

impl FeatureValue {
    pub fn new(s: &str) -> FeatureValue {
        match s.split_once('/') {
            Some((dep, feat)) => {
                let stripped = dep.strip_suffix('?');
                FeatureValue::DepFeature {
                    dep_name: stripped.unwrap_or(dep).into(),
                    dep_feature: feat.into(),
                    weak: stripped.is_some(),
                }
            }
            None => match s.strip_prefix("dep:") {
                Some(d) => FeatureValue::Dep(d.into()),
                None => FeatureValue::Feature(s.into()),
            },
        }
    }

    fn feature_or_dep_name(&self) -> &Rc<str> {
        match self {
            FeatureValue::Feature(n) | FeatureValue::Dep(n) => n,
            FeatureValue::DepFeature { dep_name, .. } => dep_name,
        }
    }
}

impl fmt::Display for FeatureValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FeatureValue::Feature(n) => write!(f, "{n}"),
            FeatureValue::Dep(n) => write!(f, "dep:{n}"),
            FeatureValue::DepFeature { dep_name, dep_feature, weak } => {
                write!(f, "{dep_name}{}/{dep_feature}", if *weak { "?" } else { "" })
            }
        }
    }
}

pub type FeatureMap = BTreeMap<Rc<str>, Vec<FeatureValue>>;

#[derive(Debug)]
pub struct Summary {
    pub name: Rc<str>,
    pub version: Version,
    pub source: Source,
    pub deps: Vec<Rc<Dependency>>,
    /// Includes the implicit features of optional dependencies.
    pub features: FeatureMap,
    pub links: Option<Rc<str>>,
    pub rust_version: Option<RustVersion>,
    pub checksum: Option<String>,
}

impl Summary {
    /// Builds a summary and its feature map, with the checks of cargo's `Summary::new` /
    /// `build_feature_map`. An index entry that fails them is invalid and never a candidate.
    pub fn new(
        name: Rc<str>,
        version: Version,
        source: Source,
        deps: Vec<Rc<Dependency>>,
        features: &BTreeMap<Rc<str>, Vec<Rc<str>>>,
        links: Option<Rc<str>>,
        rust_version: Option<RustVersion>,
    ) -> Result<Summary, String> {
        for dep in &deps {
            if dep.optional && !dep.is_transitive() {
                return Err(format!("dev-dependencies are not allowed to be optional: `{}`", dep.name_in_toml));
            }
        }
        let features = build_feature_map(features, &deps)?;
        Ok(Summary { name, version, source, deps, features, links, rust_version, checksum: None })
    }
}

fn build_feature_map(
    features: &BTreeMap<Rc<str>, Vec<Rc<str>>>,
    deps: &[Rc<Dependency>],
) -> Result<FeatureMap, String> {
    // Dependency name → whether any dependency of that name is optional.
    let mut dep_map: HashMap<&str, bool> = HashMap::new();
    for dep in deps {
        *dep_map.entry(&dep.name_in_toml).or_insert(false) |= dep.optional;
    }
    let mut map: FeatureMap = features
        .iter()
        .map(|(f, list)| (f.clone(), list.iter().map(|v| FeatureValue::new(v)).collect()))
        .collect();

    // Implicit features for optional dependencies that no `dep:` names.
    let explicitly_listed: HashSet<Rc<str>> = map
        .values()
        .flatten()
        .filter_map(|fv| match fv {
            FeatureValue::Dep(n) => Some(n.clone()),
            _ => None,
        })
        .collect();
    for dep in deps {
        if !dep.optional {
            continue;
        }
        let n = &dep.name_in_toml;
        if features.contains_key(n) || explicitly_listed.contains(n) {
            continue;
        }
        map.insert(n.clone(), vec![FeatureValue::Dep(n.clone())]);
    }

    for (feature, fvs) in &map {
        for fv in fvs {
            let dep_data = dep_map.get(&**fv.feature_or_dep_name());
            let is_any_dep = dep_data.is_some();
            let is_optional_dep = dep_data.is_some_and(|&o| o);
            match fv {
                FeatureValue::Feature(f) => {
                    if !features.contains_key(f) {
                        if !is_any_dep {
                            return Err(format!("feature `{feature}` includes `{fv}` which is neither a dependency nor another feature"));
                        }
                        if !is_optional_dep || !map.contains_key(f) {
                            return Err(format!("feature `{feature}` includes `{fv}`, which is not an implicit feature"));
                        }
                    }
                }
                FeatureValue::Dep(d) => {
                    if !is_optional_dep {
                        return Err(format!("feature `{feature}` includes `{fv}`, but `{d}` is not an optional dependency"));
                    }
                }
                FeatureValue::DepFeature { dep_name, dep_feature, weak } => {
                    if dep_feature.contains('/') {
                        return Err(format!("multiple slashes in feature `{fv}`"));
                    }
                    if dep_name.starts_with("dep:") {
                        return Err(format!("feature `{feature}` includes `{fv}` with both `dep:` and `/`"));
                    }
                    if !is_any_dep {
                        return Err(format!("feature `{feature}` includes `{fv}`, but `{dep_name}` is not a dependency"));
                    }
                    if *weak && !is_optional_dep {
                        return Err(format!("feature `{feature}` includes `{fv}` with a `?`, but `{dep_name}` is not optional"));
                    }
                }
            }
        }
    }

    // Every optional dependency must be reachable from some feature.
    let used: HashSet<&str> = map
        .values()
        .flatten()
        .filter_map(|fv| match fv {
            FeatureValue::Dep(n) | FeatureValue::DepFeature { dep_name: n, .. } => Some(&**n),
            _ => None,
        })
        .collect();
    if let Some((dep, _)) = dep_map.iter().find(|&(d, &opt)| opt && !used.contains(d)) {
        return Err(format!("optional dependency `{dep}` is not included in any feature"));
    }
    Ok(map)
}
