//! Cargo's dependency resolution, ported from cargo 0.100.0 (`src/resolver/{mod,context,types,
//! dep_cache,version_prefs}.rs`) so that it finds the *same* graph, not just a valid one:
//!
//! - The work list holds one frame per activated package; the frame whose next dependency has
//!   the fewest candidates goes first (ties: the older frame).
//! - A package's dependencies are tried in order of their candidate count (stable, so manifest
//!   or index order breaks ties). Candidates: matching, non-yanked versions, MSRV-compatible
//!   first (resolver v3), then highest first.
//! - One version per semver-compatible range (`1.x`, `0.y`, `0.0.z`), one package per `links`.
//! - On a dead end it backtracks to the newest saved choice point, skipping the ones that can't
//!   change the conflict (cargo's `find_candidate`).
//!
//! Left out because they only make cargo faster or its errors better, not change the answer:
//! the global conflict cache, conflict generalization, and the "just for error messages" mode.
//! Also left out: `[patch]`, `[replace]`, lockfile preferences, minimal versions, publish age.

use crate::index::{IndexEntry, IndexFile, Registry, parse_index_file};
use crate::manifest::{ResolveBehavior, RootManifest};
use crate::summary::{Dependency, FeatureValue, Source, Summary};
use cargo_util_schemas::core::PartialVersion;
use semver::Version;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::rc::Rc;

pub type PkgId = u32;
type FeaturesSet = Rc<BTreeSet<Rc<str>>>;
type DepInfo = (Rc<Dependency>, Rc<Vec<PkgId>>, FeaturesSet);
type ConflictMap = BTreeMap<PkgId, ConflictReason>;

/// The rustc version cargo falls back to for MSRV-aware resolution when the root has no
/// `rust-version` (cargo uses the running rustc; the golden files come from 1.99.1).
pub const DEFAULT_RUSTC: (u64, u64, u64) = (1, 99, 1);

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum ConflictReason {
    Semver,
    Links,
    MissingFeature,
    RequiredDependencyAsFeature,
    NonImplicitDependencyAsFeature,
}

enum ActivateError {
    Fatal(String),
    Conflict(PkgId, ConflictReason),
}

#[derive(Clone, PartialEq, Eq, Hash)]
enum RequestedFeatures {
    /// The root: `cargo generate-lockfile` resolves with all features.
    Cli { all_features: bool, uses_default_features: bool },
    Dep { features: FeaturesSet, uses_default_features: bool },
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct ResolveOpts {
    dev_deps: bool,
    features: RequestedFeatures,
}

/// cargo's `SemverCompatibility`: versions are compatible if their left-most non-zero part is equal.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
enum Compat {
    Major(u64),
    Minor(u64),
    Patch(u64),
}

impl From<&Version> for Compat {
    fn from(v: &Version) -> Compat {
        if v.major != 0 {
            Compat::Major(v.major)
        } else if v.minor != 0 {
            Compat::Minor(v.minor)
        } else {
            Compat::Patch(v.patch)
        }
    }
}

type ActivationsKey = (Rc<str>, Compat, Source);

/// Parsed index files, kept across resolves (the browser re-runs the resolve after fetching
/// missing files, and parsing is most of the work).
#[derive(Default)]
pub struct IndexCache(HashMap<Rc<str>, Rc<Vec<IndexEntry>>>);

/// Every summary the resolve has seen: the root, then each index entry as its file is loaded.
struct Pool {
    summaries: Vec<Rc<Summary>>,
    yanked: Vec<bool>,
    by_name: HashMap<Rc<str>, Vec<PkgId>>,
}

impl Pool {
    fn get(&self, id: PkgId) -> &Summary {
        &self.summaries[id as usize]
    }
    fn key(&self, id: PkgId) -> ActivationsKey {
        let s = self.get(id);
        (s.name.clone(), Compat::from(&s.version), s.source)
    }
}

#[derive(Clone)]
struct ResolverContext {
    age: usize,
    activations: im_rc::HashMap<ActivationsKey, (PkgId, usize)>,
    resolve_features: im_rc::HashMap<PkgId, FeaturesSet>,
    links: im_rc::HashMap<Rc<str>, PkgId>,
    /// parent → the packages it depends on (cargo keeps the reverse; same edges).
    edges: im_rc::HashMap<PkgId, im_rc::HashSet<PkgId>>,
}

impl ResolverContext {
    fn new() -> Self {
        ResolverContext {
            age: 0,
            activations: Default::default(),
            resolve_features: Default::default(),
            links: Default::default(),
            edges: Default::default(),
        }
    }

    /// Returns whether `id` is already active with (at least) the requested features.
    fn flag_activated(&mut self, pool: &Pool, id: PkgId, opts: &ResolveOpts) -> Result<bool, ActivateError> {
        let key = pool.key(id);
        if !self.activations.contains_key(&key) {
            let s = pool.get(id);
            if let Some(link) = &s.links {
                if self.links.insert(link.clone(), id).is_some() {
                    return Err(ActivateError::Fatal(format!(
                        "Attempting to resolve a dependency with more than one crate with links={link}"
                    )));
                }
            }
            self.activations.insert(key, (id, self.age));
            return Ok(false);
        }
        match &opts.features {
            RequestedFeatures::Cli { .. } => Ok(false),
            RequestedFeatures::Dep { features, uses_default_features } => {
                let has_default = pool.get(id).features.contains_key("default");
                let empty = BTreeSet::new();
                let prev = self.resolve_features.get(&id).map(|f| &**f).unwrap_or(&empty);
                Ok(features.is_subset(prev) && (!uses_default_features || prev.contains("default") || !has_default))
            }
        }
    }

    /// The age at which `id` was activated, if it (and not another version in its range) is active.
    fn is_active(&self, pool: &Pool, id: PkgId) -> Option<usize> {
        self.activations.get(&pool.key(id)).and_then(|&(a, age)| (a == id).then_some(age))
    }

    /// If `parent` and every package in `conflicts` are still active, the age of the newest.
    fn is_conflicting(&self, pool: &Pool, parent: Option<PkgId>, conflicts: &ConflictMap) -> Option<usize> {
        let mut max = 0;
        if let Some(p) = parent {
            max = max.max(self.is_active(pool, p)?);
        }
        for &id in conflicts.keys() {
            max = max.max(self.is_active(pool, id)?);
        }
        Some(max)
    }
}

#[derive(Clone)]
struct RcVecIter<T> {
    vec: Rc<Vec<T>>,
    offset: usize,
}

impl<T> RcVecIter<T> {
    fn new(vec: Rc<Vec<T>>) -> Self {
        RcVecIter { vec, offset: 0 }
    }
    fn peek(&self) -> Option<&T> {
        self.vec.get(self.offset)
    }
    fn next(&mut self) -> Option<&T> {
        let r = self.vec.get(self.offset);
        if r.is_some() {
            self.offset += 1;
        }
        r
    }
}

#[derive(Clone)]
struct DepsFrame {
    parent: PkgId,
    remaining_siblings: RcVecIter<DepInfo>,
}

impl DepsFrame {
    fn min_candidates(&self) -> usize {
        self.remaining_siblings.peek().map(|(_, c, _)| c.len()).unwrap_or(0)
    }
}

/// A work-list entry, ordered by (fewest candidates for its next dependency, insertion time).
#[derive(Clone)]
struct QueuedFrame {
    min_candidates: usize,
    time: u32,
    frame: DepsFrame,
}

impl PartialEq for QueuedFrame {
    fn eq(&self, o: &Self) -> bool {
        self.cmp(o) == Ordering::Equal
    }
}
impl Eq for QueuedFrame {}
impl PartialOrd for QueuedFrame {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for QueuedFrame {
    fn cmp(&self, o: &Self) -> Ordering {
        (self.min_candidates, self.time).cmp(&(o.min_candidates, o.time))
    }
}

#[derive(Clone)]
struct RemainingDeps {
    time: u32,
    data: im_rc::OrdSet<QueuedFrame>,
}

impl RemainingDeps {
    fn new() -> Self {
        RemainingDeps { time: 0, data: im_rc::OrdSet::new() }
    }
    fn push(&mut self, frame: DepsFrame) {
        self.data.insert(QueuedFrame { min_candidates: frame.min_candidates(), time: self.time, frame });
        self.time += 1;
    }
    fn pop_most_constrained(&mut self) -> Option<(PkgId, DepInfo)> {
        while let Some(QueuedFrame { time, mut frame, .. }) = self.data.remove_min() {
            if let Some(sibling) = frame.remaining_siblings.next().cloned() {
                let parent = frame.parent;
                self.data.insert(QueuedFrame { min_candidates: frame.min_candidates(), time, frame });
                return Some((parent, sibling));
            }
        }
        None
    }
}

#[derive(Clone)]
struct RemainingCandidates {
    remaining: RcVecIter<PkgId>,
    has_another: Option<PkgId>,
}

impl RemainingCandidates {
    fn new(c: &Rc<Vec<PkgId>>) -> Self {
        RemainingCandidates { remaining: RcVecIter::new(c.clone()), has_another: None }
    }

    /// The next candidate that can be activated next to what's active, and whether another follows.
    fn next(&mut self, pool: &Pool, conflicts: &mut ConflictMap, cx: &ResolverContext) -> Option<(PkgId, bool)> {
        while let Some(&b) = self.remaining.next() {
            if let Some(&(a, _)) = cx.activations.get(&pool.key(b)) {
                if a != b {
                    conflicts.entry(a).or_insert(ConflictReason::Semver);
                    continue;
                }
            }
            if let Some(link) = &pool.get(b).links {
                if let Some(&a) = cx.links.get(link) {
                    if a != b {
                        conflicts.entry(a).or_insert(ConflictReason::Links);
                        continue;
                    }
                }
            }
            if let Some(r) = self.has_another.replace(b) {
                return Some((r, true));
            }
        }
        self.has_another.take().map(|r| (r, false))
    }
}

struct BacktrackFrame {
    context: ResolverContext,
    remaining_deps: RemainingDeps,
    remaining_candidates: RemainingCandidates,
    parent: PkgId,
    dep: Rc<Dependency>,
    features: FeaturesSet,
    conflicting_activations: ConflictMap,
}

type BuiltDeps = Rc<(HashSet<Rc<str>>, Rc<Vec<DepInfo>>)>;

/// The registry side: loads index files on demand, answers "which versions can satisfy this
/// dependency" (sorted by preference), and caches each package's dependency list per feature set.
struct Queryer<'a> {
    registry: &'a dyn Registry,
    cache: &'a mut IndexCache,
    pool: Pool,
    rust_versions: Vec<PartialVersion>,
    query_cache: HashMap<(Rc<str>, semver::VersionReq), Rc<Vec<PkgId>>>,
    deps_cache: HashMap<(Option<PkgId>, PkgId, ResolveOpts), BuiltDeps>,
    /// Some index file was pending: this resolve is incomplete.
    pending: bool,
}

impl Queryer<'_> {
    /// Loads `name`'s index entries into the pool; `false` if its file is still pending.
    fn load(&mut self, name: &Rc<str>) -> Result<bool, String> {
        if self.pool.by_name.contains_key(name) {
            return Ok(true);
        }
        let entries = match self.cache.0.get(name) {
            Some(e) => e.clone(),
            None => {
                let parsed = match self.registry.index_file(name)? {
                    IndexFile::Found(data) => parse_index_file(&data),
                    IndexFile::NotFound => Vec::new(),
                    IndexFile::Pending => {
                        self.pending = true;
                        return Ok(false);
                    }
                };
                let e = Rc::new(parsed);
                self.cache.0.insert(name.clone(), e.clone());
                e
            }
        };
        let mut ids = Vec::new();
        for e in entries.iter() {
            ids.push(self.pool.summaries.len() as PkgId);
            self.pool.summaries.push(e.summary.clone());
            self.pool.yanked.push(e.yanked);
        }
        self.pool.by_name.insert(name.clone(), ids);
        Ok(true)
    }

    /// The candidates for `dep`, best first; `None` while its index file is pending.
    fn query(&mut self, dep: &Dependency) -> Result<Option<Rc<Vec<PkgId>>>, String> {
        let key = (dep.package.clone(), dep.req.clone());
        if let Some(c) = self.query_cache.get(&key) {
            return Ok(Some(c.clone()));
        }
        if !self.load(&dep.package)? {
            return Ok(None);
        }
        let pool = &self.pool;
        let mut c: Vec<PkgId> = pool.by_name[&dep.package]
            .iter()
            .copied()
            .filter(|&id| {
                let s = pool.get(id);
                !pool.yanked[id as usize] && *s.name == *dep.package && dep.req.matches(&s.version)
            })
            .collect();
        // version_prefs.rs `sort_summaries`: MSRV-compatible first (v3), then highest version.
        let rv = &self.rust_versions;
        let compat = |id: PkgId| match &pool.get(id).rust_version {
            None => rv.len(),
            Some(r) => rv.iter().filter(|max| r.is_compatible_with(max)).count(),
        };
        c.sort_unstable_by(|&a, &b| compat(b).cmp(&compat(a)).then_with(|| pool.get(b).version.cmp(&pool.get(a).version)));
        let c = Rc::new(c);
        self.query_cache.insert(key, c.clone());
        Ok(Some(c))
    }

    fn build_deps(&mut self, parent: Option<PkgId>, candidate: PkgId, opts: &ResolveOpts) -> Result<BuiltDeps, ActivateError> {
        let key = (parent, candidate, opts.clone());
        if let Some(out) = self.deps_cache.get(&key) {
            return Ok(out.clone());
        }
        let summary = self.pool.summaries[candidate as usize].clone();
        let (used_features, deps) = resolve_features(parent, candidate, &summary, opts)?;
        // Pending dependencies are left out for now (dep_cache.rs does the same); such a result
        // isn't cached, so the next, complete resolve recomputes it.
        let mut all_ready = true;
        let mut ready = Vec::with_capacity(deps.len());
        for (dep, features) in deps {
            match self.query(&dep).map_err(ActivateError::Fatal)? {
                Some(c) => ready.push((dep, c, features)),
                None => all_ready = false,
            }
        }
        ready.sort_by_key(|(_, c, _)| c.len());
        let out = Rc::new((used_features, Rc::new(ready)));
        if all_ready {
            self.deps_cache.insert(key, out.clone());
        }
        Ok(out)
    }
}

/// The features `s` ends up with and each enabled dependency with the features it asks of it.
fn resolve_features(
    parent: Option<PkgId>,
    id: PkgId,
    s: &Summary,
    opts: &ResolveOpts,
) -> Result<(HashSet<Rc<str>>, Vec<(Rc<Dependency>, FeaturesSet)>), ActivateError> {
    let reqs = build_requirements(parent, s, opts)?;
    let mut ret = Vec::new();
    let mut valid = HashSet::new();
    for dep in s.deps.iter().filter(|d| d.is_transitive() || opts.dev_deps) {
        if dep.optional && !reqs.deps.contains_key(&dep.name_in_toml) {
            continue;
        }
        valid.insert(dep.name_in_toml.clone());
        let mut base = reqs.deps.get(&dep.name_in_toml).cloned().unwrap_or_default();
        base.extend(dep.features.iter().cloned());
        ret.push((dep.clone(), Rc::new(base)));
    }
    if parent.is_none() {
        if let Some(d) = reqs.deps.keys().find(|d| !valid.contains(*d)) {
            return Err(ActivateError::Fatal(format!("package `{} v{}` (id {id}) does not have a dependency named `{d}`", s.name, s.version)));
        }
    }
    Ok((reqs.features, ret))
}

enum RequirementError {
    MissingFeature(Rc<str>),
    Cycle(Rc<str>),
}

struct Requirements<'a> {
    summary: &'a Summary,
    deps: HashMap<Rc<str>, BTreeSet<Rc<str>>>,
    features: HashSet<Rc<str>>,
}

impl Requirements<'_> {
    fn require_dep_feature(&mut self, package: &Rc<str>, feat: &Rc<str>, weak: bool) -> Result<(), RequirementError> {
        if !weak && self.summary.deps.iter().any(|d| d.name_in_toml == *package && d.optional) && self.summary.features.contains_key(package) {
            self.require_feature(package)?;
        }
        self.deps.entry(package.clone()).or_default().insert(feat.clone());
        Ok(())
    }

    fn require_feature(&mut self, feat: &Rc<str>) -> Result<(), RequirementError> {
        if !self.features.insert(feat.clone()) {
            return Ok(());
        }
        let summary = self.summary;
        let Some(fvs) = summary.features.get(feat) else {
            return Err(RequirementError::MissingFeature(feat.clone()));
        };
        for fv in fvs {
            if let FeatureValue::Feature(f) = fv {
                if f == feat {
                    return Err(RequirementError::Cycle(feat.clone()));
                }
            }
            self.require_value(fv)?;
        }
        Ok(())
    }

    fn require_value(&mut self, fv: &FeatureValue) -> Result<(), RequirementError> {
        match fv {
            FeatureValue::Feature(f) => self.require_feature(f),
            FeatureValue::Dep(d) => {
                self.deps.entry(d.clone()).or_default();
                Ok(())
            }
            // Weak features always activate in the dependency resolver; the feature resolver
            // narrows them later (dep_cache.rs).
            FeatureValue::DepFeature { dep_name, dep_feature, weak } => self.require_dep_feature(dep_name, dep_feature, *weak),
        }
    }
}

fn build_requirements<'a>(parent: Option<PkgId>, s: &'a Summary, opts: &ResolveOpts) -> Result<Requirements<'a>, ActivateError> {
    let mut reqs = Requirements { summary: s, deps: HashMap::new(), features: HashSet::new() };
    let to_err = |e: RequirementError| match e {
        RequirementError::Cycle(f) => ActivateError::Fatal(format!("cyclic feature dependency: feature `{f}` depends on itself")),
        RequirementError::MissingFeature(f) => {
            let deps: Vec<_> = s.deps.iter().filter(|d| d.name_in_toml == f).collect();
            let reason = if deps.is_empty() {
                ConflictReason::MissingFeature
            } else if deps.iter().any(|d| d.optional) {
                ConflictReason::NonImplicitDependencyAsFeature
            } else {
                ConflictReason::RequiredDependencyAsFeature
            };
            match parent {
                Some(p) => ActivateError::Conflict(p, reason),
                None => ActivateError::Fatal(format!("package `{} v{}` does not have the feature `{f}`", s.name, s.version)),
            }
        }
    };
    let default: Rc<str> = "default".into();
    let uses_default = match &opts.features {
        RequestedFeatures::Cli { all_features, uses_default_features } => {
            if *all_features {
                for key in s.features.keys() {
                    reqs.require_feature(key).map_err(to_err)?;
                }
            }
            *uses_default_features
        }
        RequestedFeatures::Dep { features, uses_default_features } => {
            for f in features.iter() {
                reqs.require_feature(f).map_err(to_err)?;
            }
            *uses_default_features
        }
    };
    if uses_default && s.features.contains_key("default") {
        reqs.require_feature(&default).map_err(to_err)?;
    }
    Ok(reqs)
}

/// One package of the result.
pub struct ResolvedPackage {
    pub name: Rc<str>,
    pub version: Version,
    pub source: Source,
    pub checksum: Option<String>,
    /// Indices into `Resolve::packages`.
    pub deps: Vec<usize>,
    /// The features the dependency resolver enabled (unified across the graph).
    pub features: BTreeSet<Rc<str>>,
}

pub struct Resolve {
    /// Sorted like cargo's `PackageId`: name, version, source.
    pub packages: Vec<ResolvedPackage>,
    /// The root's `rust-version`, which picks the lockfile format.
    pub rust_version: Option<cargo_util_schemas::manifest::RustVersion>,
}

pub fn resolve(root: RootManifest, registry: &dyn Registry) -> Result<Resolve, String> {
    resolve_cached(root, registry, &mut IndexCache::default())?.ok_or_else(|| "the registry left index files pending".into())
}

/// Like `resolve`, reusing parsed index files from `cache`. `Ok(None)`: some index file was
/// pending (the registry knows which); supply them and resolve again.
pub fn resolve_cached(root: RootManifest, registry: &dyn Registry, cache: &mut IndexCache) -> Result<Option<Resolve>, String> {
    let RootManifest { summary, behavior, rust_version } = root;
    let rust_versions = if behavior >= ResolveBehavior::V3 {
        vec![match &rust_version {
            Some(r) => r.to_partial(),
            None => {
                let (major, minor, patch) = DEFAULT_RUSTC;
                PartialVersion::from(Version::new(major, minor, patch))
            }
        }]
    } else {
        Vec::new()
    };
    let mut q = Queryer {
        registry,
        cache,
        pool: Pool { summaries: vec![Rc::new(summary)], yanked: vec![false], by_name: HashMap::new() },
        rust_versions,
        query_cache: HashMap::new(),
        deps_cache: HashMap::new(),
        pending: false,
    };
    let cx = activate_deps_loop(&mut q);
    if q.pending {
        // An error may just be the missing constraints' fault; either way, fetch and retry.
        return Ok(None);
    }
    let cx = cx?;

    let pool = &q.pool;
    let mut ids: Vec<PkgId> = cx.activations.values().map(|&(id, _)| id).collect();
    ids.sort_by(|&a, &b| {
        let (x, y) = (pool.get(a), pool.get(b));
        x.name.cmp(&y.name).then_with(|| x.version.cmp(&y.version)).then_with(|| x.source.cmp(&y.source))
    });
    let index: HashMap<PkgId, usize> = ids.iter().enumerate().map(|(i, &id)| (id, i)).collect();
    let packages = ids
        .iter()
        .map(|&id| {
            let s = pool.get(id);
            let mut deps: Vec<usize> = cx.edges.get(&id).into_iter().flatten().map(|c| index[c]).collect();
            deps.sort_unstable();
            ResolvedPackage {
                name: s.name.clone(),
                version: s.version.clone(),
                source: s.source,
                checksum: s.checksum.clone(),
                deps,
                features: cx.resolve_features.get(&id).map(|f| (**f).clone()).unwrap_or_default(),
            }
        })
        .collect();
    Ok(Some(Resolve { packages, rust_version }))
}

fn activate(
    cx: &mut ResolverContext,
    q: &mut Queryer<'_>,
    parent: Option<PkgId>,
    candidate: PkgId,
    opts: &ResolveOpts,
) -> Result<Option<DepsFrame>, ActivateError> {
    cx.age += 1;
    if let Some(p) = parent {
        let mut children = cx.edges.get(&p).cloned().unwrap_or_default();
        children.insert(candidate);
        cx.edges.insert(p, children);
    }
    if cx.flag_activated(&q.pool, candidate, opts)? {
        return Ok(None);
    }
    let built = q.build_deps(parent, candidate, opts)?;
    let (used_features, deps) = &*built;
    if !used_features.is_empty() {
        let mut f = cx.resolve_features.get(&candidate).map(|f| (**f).clone()).unwrap_or_default();
        f.extend(used_features.iter().cloned());
        cx.resolve_features.insert(candidate, Rc::new(f));
    }
    Ok(Some(DepsFrame { parent: candidate, remaining_siblings: RcVecIter::new(deps.clone()) }))
}

fn activate_deps_loop(q: &mut Queryer<'_>) -> Result<ResolverContext, String> {
    const ROOT: PkgId = 0;
    let mut cx = ResolverContext::new();
    let mut backtrack_stack: Vec<BacktrackFrame> = Vec::new();
    let mut remaining_deps = RemainingDeps::new();

    let root_opts = ResolveOpts {
        dev_deps: true,
        features: RequestedFeatures::Cli { all_features: true, uses_default_features: true },
    };
    match activate(&mut cx, q, None, ROOT, &root_opts) {
        Ok(Some(frame)) => remaining_deps.push(frame),
        Ok(None) => {}
        Err(ActivateError::Fatal(e)) => return Err(e),
        Err(ActivateError::Conflict(..)) => unreachable!("the root has no parent to conflict with"),
    }

    while let Some((mut parent, (mut dep, candidates, mut features))) = remaining_deps.pop_most_constrained() {
        let mut remaining_candidates = RemainingCandidates::new(&candidates);
        let mut conflicting_activations = ConflictMap::new();
        let mut backtracked = false;

        loop {
            let next = remaining_candidates.next(&q.pool, &mut conflicting_activations, &cx);
            let (candidate, has_another) = match next {
                Some(c) => c,
                None => match find_candidate(&q.pool, &cx, &mut backtrack_stack, parent, backtracked, &conflicting_activations) {
                    Some((candidate, has_another, frame)) => {
                        cx = frame.context;
                        remaining_deps = frame.remaining_deps;
                        remaining_candidates = frame.remaining_candidates;
                        parent = frame.parent;
                        dep = frame.dep;
                        features = frame.features;
                        conflicting_activations = frame.conflicting_activations;
                        backtracked = true;
                        (candidate, has_another)
                    }
                    None => {
                        let p = q.pool.get(parent);
                        return Err(format!(
                            "failed to select a version for `{}` (required by `{} v{}`, version requirement `{}`)",
                            dep.package, p.name, p.version, dep.req
                        ));
                    }
                },
            };

            let backtrack = has_another.then(|| BacktrackFrame {
                context: cx.clone(),
                remaining_deps: remaining_deps.clone(),
                remaining_candidates: remaining_candidates.clone(),
                parent,
                dep: dep.clone(),
                features: features.clone(),
                conflicting_activations: conflicting_activations.clone(),
            });

            let opts = ResolveOpts {
                dev_deps: false,
                features: RequestedFeatures::Dep { features: features.clone(), uses_default_features: dep.default_features },
            };
            let ok = match activate(&mut cx, q, Some(parent), candidate, &opts) {
                Ok(Some(frame)) => {
                    remaining_deps.push(frame);
                    true
                }
                Ok(None) => true,
                Err(ActivateError::Fatal(e)) => return Err(e),
                Err(ActivateError::Conflict(id, reason)) => {
                    conflicting_activations.insert(id, reason);
                    false
                }
            };
            if ok {
                backtrack_stack.extend(backtrack);
                break;
            }
            if let Some(b) = backtrack {
                cx = b.context;
            }
        }
    }
    Ok(cx)
}

/// Pops saved choice points until one could change the outcome (cargo's `find_candidate`):
/// a frame newer than the newest of `parent` and the conflicting packages can't help.
fn find_candidate(
    pool: &Pool,
    cx: &ResolverContext,
    stack: &mut Vec<BacktrackFrame>,
    parent: PkgId,
    backtracked: bool,
    conflicts: &ConflictMap,
) -> Option<(PkgId, bool, BacktrackFrame)> {
    let age = if !backtracked { cx.is_conflicting(pool, Some(parent), conflicts) } else { None };
    let frame = match age {
        Some(age) => loop {
            let f = stack.pop()?;
            if f.context.age < age {
                break f;
            }
        },
        None => stack.pop()?,
    };
    let mut frame = frame;
    let (candidate, has_another) = frame
        .remaining_candidates
        .next(pool, &mut frame.conflicting_activations, &frame.context)
        .expect("a saved frame always has another candidate");
    Some((candidate, has_another, frame))
}
