//! Build features, ported from cargo's `FeatureResolver` (`src/core/resolver/features.rs`).
//!
//! The dependency resolver unifies features across the whole graph, but `cargo build` with
//! resolver 2 or later computes them again: per package *and* per side (target, or host for
//! build dependencies and proc macros and everything below them), only through dependencies that
//! are active on that platform, and without dev dependencies. Resolver 1 keeps one side.

use super::cfg::TargetInfo;
use super::package::Package;
use crate::summary::{DepKind, Dependency, FeatureValue};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::rc::Rc;

#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
pub enum FeaturesFor {
    Normal,
    Host,
}

/// One dependency edge: (dependency package, the manifest entry). A package can depend on the
/// same package through several entries (e.g. normal and build).
pub type Edges = Vec<Vec<(usize, Rc<Dependency>)>>;

pub struct Platforms<'a> {
    pub target: &'a TargetInfo,
    pub host: &'a TargetInfo,
}

#[derive(Default)]
pub struct Features {
    pub features: HashMap<(usize, FeaturesFor), BTreeSet<Rc<str>>>,
    /// Optional dependencies (by name in the manifest) that features turned on.
    pub activated_deps: HashMap<(usize, FeaturesFor), HashSet<Rc<str>>>,
}

impl Features {
    pub fn of(&self, pkg: usize, fk: FeaturesFor) -> Vec<String> {
        self.features.get(&(pkg, fk)).map(|s| s.iter().map(|f| f.to_string()).collect()).unwrap_or_default()
    }
}

pub struct FeatureResolver<'a> {
    pkgs: &'a [Package],
    edges: &'a Edges,
    platforms: Platforms<'a>,
    /// Resolver 2+: host dependencies get features of their own.
    decouple_host: bool,
    out: Features,
    processed: HashSet<(usize, FeaturesFor)>,
    deferred_weak: HashMap<(usize, FeaturesFor, Rc<str>), BTreeSet<Rc<str>>>,
}

impl<'a> FeatureResolver<'a> {
    pub fn resolve(
        pkgs: &'a [Package],
        edges: &'a Edges,
        platforms: Platforms<'a>,
        decouple_host: bool,
        roots: &[usize],
        requested: &[String],
        default_features: bool,
    ) -> Result<Features, String> {
        let mut r = FeatureResolver {
            pkgs,
            edges,
            platforms,
            decouple_host,
            out: Features::default(),
            processed: HashSet::new(),
            deferred_weak: HashMap::new(),
        };
        // `--features` names features of the one package being built (cargo needs `-p` otherwise).
        let requested: Vec<&str> = requested.iter().flat_map(|f| f.split([' ', ','])).filter(|f| !f.is_empty()).collect();
        if roots.len() > 1 && !requested.is_empty() {
            return Err("features can only be given when building one package".into());
        }
        for &root in roots {
            let map = &pkgs[root].summary.features;
            let mut fvs = Vec::new();
            for f in &requested {
                let fv = FeatureValue::new(f);
                if let FeatureValue::Feature(name) = &fv {
                    if !map.contains_key(name) {
                        return Err(format!("the package `{}` does not have the feature `{name}`", pkgs[root].name()));
                    }
                }
                fvs.push(fv);
            }
            if default_features && map.contains_key("default") {
                fvs.push(FeatureValue::Feature("default".into()));
            }
            r.activate_pkg(root, FeaturesFor::Normal, &fvs)?;
        }
        Ok(r.out)
    }

    /// The edges of `pkg` that count on side `fk`, each with the side of the dependency.
    pub fn deps(
        pkgs: &[Package],
        edges: &Edges,
        platforms: &Platforms,
        decouple_host: bool,
        pkg: usize,
        fk: FeaturesFor,
    ) -> Result<Vec<(usize, Rc<Dependency>, FeaturesFor)>, String> {
        let mut out = Vec::new();
        for (dep_pkg, dep) in &edges[pkg] {
            // Dev-dependency edges exist only for `cargo test`'s roots (mod.rs), and count there.
            if let Some(t) = &dep.target {
                let info = if dep.kind == DepKind::Build || fk == FeaturesFor::Host { platforms.host } else { platforms.target };
                if !info.matches(t)? {
                    continue;
                }
            }
            let dep_fk = if decouple_host && (dep.kind == DepKind::Build || pkgs[*dep_pkg].is_proc_macro()) { FeaturesFor::Host } else { fk };
            out.push((*dep_pkg, dep.clone(), dep_fk));
        }
        Ok(out)
    }

    fn my_deps(&self, pkg: usize, fk: FeaturesFor) -> Result<Vec<(usize, Rc<Dependency>, FeaturesFor)>, String> {
        Self::deps(self.pkgs, self.edges, &self.platforms, self.decouple_host, pkg, fk)
    }

    fn activate_pkg(&mut self, pkg: usize, fk: FeaturesFor, fvs: &[FeatureValue]) -> Result<(), String> {
        for fv in fvs {
            self.activate_fv(pkg, fk, fv)?;
        }
        if !self.processed.insert((pkg, fk)) {
            return Ok(());
        }
        // Make sure the package has an entry even without features.
        self.out.features.entry((pkg, fk)).or_default();
        for (dep_pkg, dep, dep_fk) in self.my_deps(pkg, fk)? {
            if dep.optional {
                continue; // features turn these on
            }
            let fvs = self.fvs_from_dependency(dep_pkg, &dep);
            self.activate_pkg(dep_pkg, dep_fk, &fvs)?;
        }
        Ok(())
    }

    fn activate_fv(&mut self, pkg: usize, fk: FeaturesFor, fv: &FeatureValue) -> Result<(), String> {
        match fv {
            FeatureValue::Feature(f) => self.activate_rec(pkg, fk, f),
            FeatureValue::Dep(d) => self.activate_dependency(pkg, fk, d),
            FeatureValue::DepFeature { dep_name, dep_feature, weak } => self.activate_dep_feature(pkg, fk, dep_name, dep_feature, *weak),
        }
    }

    fn activate_rec(&mut self, pkg: usize, fk: FeaturesFor, feature: &Rc<str>) -> Result<(), String> {
        if !self.out.features.entry((pkg, fk)).or_default().insert(feature.clone()) {
            return Ok(());
        }
        let Some(fvs) = self.pkgs[pkg].summary.features.get(feature) else {
            return Ok(());
        };
        for fv in fvs.clone() {
            self.activate_fv(pkg, fk, &fv)?;
        }
        Ok(())
    }

    fn activate_dependency(&mut self, pkg: usize, fk: FeaturesFor, dep_name: &Rc<str>) -> Result<(), String> {
        self.out.activated_deps.entry((pkg, fk)).or_default().insert(dep_name.clone());
        let deferred = self.deferred_weak.remove(&(pkg, fk, dep_name.clone()));
        for (dep_pkg, dep, dep_fk) in self.my_deps(pkg, fk)? {
            if dep.name_in_toml != *dep_name {
                continue;
            }
            for f in deferred.iter().flatten() {
                self.activate_fv(dep_pkg, dep_fk, &FeatureValue::new(f))?;
            }
            let fvs = self.fvs_from_dependency(dep_pkg, &dep);
            self.activate_pkg(dep_pkg, dep_fk, &fvs)?;
        }
        Ok(())
    }

    fn activate_dep_feature(&mut self, pkg: usize, fk: FeaturesFor, dep_name: &Rc<str>, dep_feature: &Rc<str>, weak: bool) -> Result<(), String> {
        for (dep_pkg, dep, dep_fk) in self.my_deps(pkg, fk)? {
            if dep.name_in_toml != *dep_name {
                continue;
            }
            if dep.optional {
                let active = self.out.activated_deps.get(&(pkg, fk)).is_some_and(|d| d.contains(dep_name));
                if weak && !active {
                    self.deferred_weak.entry((pkg, fk, dep_name.clone())).or_default().insert(dep_feature.clone());
                    continue;
                }
                self.activate_fv(pkg, fk, &FeatureValue::Dep(dep_name.clone()))?;
                // `dep/feat` also turns on the feature named like the dependency, if there is one
                // (there isn't when `dep:` hides it).
                if !weak && self.pkgs[pkg].summary.features.contains_key(dep_name) {
                    self.activate_fv(pkg, fk, &FeatureValue::Feature(dep_name.clone()))?;
                }
            }
            self.activate_fv(dep_pkg, dep_fk, &FeatureValue::new(dep_feature))?;
        }
        Ok(())
    }

    fn fvs_from_dependency(&self, dep_pkg: usize, dep: &Dependency) -> Vec<FeatureValue> {
        let mut out: Vec<FeatureValue> = dep.features.iter().map(|f| FeatureValue::new(f)).collect();
        if dep.default_features && self.pkgs[dep_pkg].summary.features.contains_key("default") {
            out.push(FeatureValue::Feature("default".into()));
        }
        out
    }
}
