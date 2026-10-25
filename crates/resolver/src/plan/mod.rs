//! The build planner (WP-17): a resolved graph plus each package's Cargo.toml → the units that
//! `cargo build --target <triple>` builds, with their rustc arguments and environment, in
//! dependency order. Follows cargo 0.100 (`unit_dependencies.rs`, `compiler/mod.rs`,
//! `custom_build.rs`); `tests/plan_golden.rs` compares it with `cargo build -vv`.
//!
//! Units: a package's lib, the roots' bins (workspace members, WP-25), a build script's compile and its run. Hashes (`-C
//! metadata`, file names) are our own: stable over the unit's inputs and its dependencies' hashes,
//! but not cargo's values. Paths follow cargo's layout under `target_dir`: target units in
//! `<triple>/<profile>/`, host units (build scripts and what they use) in `<profile>/`.
//!
//! Build-script output can only be applied once the script ran: `finish` adds it to a unit.
//! A run unit gets `DEP_<LINKS>_*` from its `links` dependencies' scripts, and a compile unit the
//! `-L` paths of every script in its linkable closure (WP-21).
//! With `test` (`cargo test`, WP-26): the roots' dev-dependencies, examples, and a test harness
//! (`--test`) per lib, bin and integration test; `Plan.tests` lists the harnesses to run.
//! Not covered yet: doc tests (no rustdoc for the wasm host yet), benches, `[lints]` check-cfg,
//! `[profile]` sections.

pub mod build_output;
pub mod cfg;
pub mod features;
pub mod package;

use crate::summary::{DepKind, Source};
use build_output::BuildOutput;
use cfg::TargetInfo;
use features::{Edges, Features, FeatureResolver, FeaturesFor, Platforms};
use package::{Package, Target, parse_package};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

#[derive(Deserialize)]
pub struct PlanInput {
    pub packages: Vec<InputPackage>,
    /// The packages to build (workspace members); `root` is the one-package form.
    #[serde(default)]
    pub roots: Vec<usize>,
    #[serde(default)]
    pub root: Option<usize>,
    /// The workspace's `resolver` setting (workspace.rs); default: the first root's.
    #[serde(default)]
    pub resolver: Option<u32>,
    pub target: String,
    /// Where build scripts run: wasm32-wasip1 in the browser.
    pub host: String,
    pub target_dir: String,
    #[serde(default)]
    pub features: Vec<String>,
    #[serde(default = "yes")]
    pub default_features: bool,
    #[serde(default)]
    pub profile: Profile,
    /// The compiler's identity (a release's RUSTC_ID); part of every hash.
    pub rustc_id: String,
    /// Also pass `--target` to host units. The browser's rustc runs on wasm32-wasip1-threads,
    /// but build scripts must be wasm32-wasip1 programs.
    #[serde(default)]
    pub target_flag_for_host: bool,
    #[serde(default)]
    pub tools: Tools,
    /// Extra rustc arguments for proc-macro units. In the browser, proc macros are wasm32-wasip1
    /// modules that the host drives (WP-20): reactor crt, exported table and allocator,
    /// `-C save-temps` (the orchestrator links after rustc exits).
    #[serde(default)]
    pub proc_macro_args: Vec<String>,
    /// Appended to every host-side compile (WP-21: `--extern std=` the build-script std).
    #[serde(default)]
    pub host_args: Vec<String>,
    /// Appended to build-script compiles (WP-21: its link arguments).
    #[serde(default)]
    pub build_script_args: Vec<String>,
    /// Plan `cargo test` instead of `cargo build` (WP-26).
    #[serde(default)]
    pub test: bool,
}

fn yes() -> bool {
    true
}

#[derive(Deserialize)]
pub struct InputPackage {
    pub name: String,
    pub version: String,
    /// None: not downloaded (cargo, too, skips packages for other platforms). An error only if
    /// a unit needs it.
    pub manifest: Option<String>,
    /// Absolute path of the package's sources.
    pub dir: String,
    /// "path" or "registry".
    pub source: String,
    /// Every file, relative to `dir`.
    pub files: Vec<String>,
    /// Indices of the resolved dependencies (the resolver's `deps`).
    pub deps: Vec<usize>,
}

/// Cargo's `dev` profile by default.
#[derive(Deserialize, Serialize, Clone, Debug, Hash)]
#[serde(default)]
pub struct Profile {
    pub name: String,
    pub opt_level: String,
    pub debuginfo: u32,
    pub debug_assertions: bool,
    pub overflow_checks: bool,
    /// `-C incremental` for path packages' units.
    pub incremental: bool,
}

impl Default for Profile {
    fn default() -> Profile {
        Profile { name: "dev".into(), opt_level: "0".into(), debuginfo: 2, debug_assertions: true, overflow_checks: true, incremental: true }
    }
}

impl Profile {
    fn dir(&self) -> &str {
        if self.name == "dev" { "debug" } else { &self.name }
    }
}

/// What build scripts see as CARGO, RUSTC, RUSTDOC, NUM_JOBS.
#[derive(Deserialize, Clone)]
#[serde(default)]
pub struct Tools {
    pub cargo: String,
    pub rustc: String,
    pub rustdoc: String,
    pub jobs: u32,
}

impl Default for Tools {
    fn default() -> Tools {
        Tools { cargo: "cargo".into(), rustc: "rustc".into(), rustdoc: "rustdoc".into(), jobs: 1 }
    }
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum UnitKind {
    Lib,
    Bin,
    /// Compiling a build script.
    CustomBuild,
    /// A test harness: a lib, bin or integration test compiled with `--test` (WP-26).
    Test,
    /// An example (`cargo test` builds them).
    Example,
    /// Running it.
    RunCustomBuild,
}

#[derive(Serialize, Debug)]
pub struct Unit {
    pub id: usize,
    pub pkg: usize,
    pub name: String,
    pub version: String,
    pub kind: UnitKind,
    /// The crate name rustc gets (compile units).
    pub crate_name: String,
    /// Built for (or run on) the host.
    pub host: bool,
    pub features: Vec<String>,
    pub hash: String,
    /// Units that must finish first.
    pub deps: Vec<usize>,
    /// Compile units: rustc's arguments (no argv[0]). Run units: empty.
    pub args: Vec<String>,
    /// Compile units: rustc's environment. Run units: the build script's.
    pub env: BTreeMap<String, String>,
    /// Compile units: the run unit whose output `finish` adds.
    pub build_output: Option<usize>,
    /// Files the unit writes (rlib + rmeta, an executable).
    pub outputs: Vec<String>,
    /// Run units: the build script executable, OUT_DIR and the working directory.
    pub program: Option<String>,
    pub out_dir: Option<String>,
    pub cwd: Option<String>,
    /// Run units: the package's `links` value.
    pub links: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct Plan {
    pub units: Vec<Unit>,
    /// The roots' executables: (bin name, unit id).
    pub bins: Vec<(String, usize)>,
    /// `test` plans: the harnesses to run, in cargo's order (lib, bins, integration tests).
    pub tests: Vec<TestExe>,
}

#[derive(Serialize, Debug)]
pub struct TestExe {
    /// The package and what cargo prints: `unittests src/lib.rs`, `tests/x.rs`.
    pub package: String,
    pub name: String,
    pub unit: usize,
    /// lib, bin or test.
    pub target: &'static str,
    /// The package dir: tests run there, as under cargo.
    pub cwd: String,
}

/// Which target of a package a test harness is built from.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum TestOf {
    Lib,
    Bin(usize),
    Integration(usize),
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Key {
    Lib(usize, bool, FeaturesFor),
    Bin(usize, usize),
    CustomBuild(usize, FeaturesFor),
    Run(usize, bool, FeaturesFor),
    Test(usize, TestOf),
    Example(usize, usize),
}

struct Builder<'a> {
    input: &'a PlanInput,
    roots: Vec<usize>,
    pkgs: Vec<Package>,
    edges: Edges,
    features: Features,
    target: TargetInfo,
    host: TargetInfo,
    decouple_host: bool,
    units: Vec<Unit>,
    memo: HashMap<Key, usize>,
}

pub fn plan(input: &PlanInput) -> Result<Plan, String> {
    let mut pkgs = Vec::new();
    for p in &input.packages {
        let source = match p.source.as_str() {
            "path" => Source::Path,
            "registry" => Source::Registry,
            s => return Err(format!("unknown source `{s}`")),
        };
        pkgs.push(match &p.manifest {
            Some(m) => parse_package(m, source, &p.dir, &p.files)?,
            None => Package::missing(&p.name, &p.version, source, &p.dir)?,
        });
    }
    let roots: Vec<usize> = if input.roots.is_empty() { input.root.into_iter().collect() } else { input.roots.clone() };
    // cargo test: the roots' dev-dependencies count, for edges and for feature unification.
    let edges = resolve_edges(&pkgs, input, if input.test { &roots } else { &[] })?;
    let target = TargetInfo::new(&input.target)?;
    let host = TargetInfo::new(&input.host)?;
    let &first = roots.first().ok_or("nothing to build: no root package")?;
    let resolver = match input.resolver {
        Some(r) => r,
        None => {
            let manifest = input.packages[first].manifest.as_deref().ok_or("the root package has no manifest")?;
            root_resolver(manifest, &pkgs[first].edition)?
        }
    };
    let decouple_host = resolver != 1;
    let features = FeatureResolver::resolve(
        &pkgs,
        &edges,
        Platforms { target: &target, host: &host },
        decouple_host,
        &roots,
        &input.features,
        input.default_features,
    )?;
    let mut b = Builder { input, roots: roots.clone(), pkgs, edges, features, target, host, decouple_host, units: Vec::new(), memo: HashMap::new() };
    let mut bins = Vec::new();
    let mut tests = Vec::new();
    for &r in &roots {
        if b.pkgs[r].lib.is_some() {
            b.unit(Key::Lib(r, false, FeaturesFor::Normal))?;
        }
        let enabled = b.features.of(r, FeaturesFor::Normal);
        let has = |t: &Target| t.required_features.iter().all(|f| enabled.contains(f));
        let p = &b.pkgs[r];
        let (lib, pbins, examples, itests) = (p.lib.clone(), p.bins.clone(), p.examples.clone(), p.tests.clone());
        // cargo test builds the bins only for integration tests (CARGO_BIN_EXE_<name>).
        let build_bins = !input.test || itests.iter().any(|t| t.test && has(t));
        for (i, bin) in pbins.iter().enumerate() {
            if has(bin) && build_bins {
                bins.push((bin.name.clone(), b.unit(Key::Bin(r, i))?));
            }
        }
        if !input.test {
            continue;
        }
        for (i, e) in examples.iter().enumerate() {
            if has(e) {
                b.unit(Key::Example(r, i))?;
            }
        }
        let name = b.pkgs[r].name().to_string();
        let cwd = b.pkgs[r].dir.clone();
        let mut add = |b: &mut Builder, of: TestOf, t: &Target, kind: &'static str| -> Result<(), String> {
            let unit = b.unit(Key::Test(r, of))?;
            let label = if kind == "test" { t.path.clone() } else { format!("unittests {}", t.path) };
            tests.push(TestExe { package: name.clone(), name: label, unit, target: kind, cwd: cwd.clone() });
            Ok(())
        };
        if let Some(l) = lib.filter(|l| l.test) {
            add(&mut b, TestOf::Lib, &l, "lib")?;
        }
        for (i, t) in pbins.iter().enumerate().filter(|(_, t)| t.test && has(t)) {
            add(&mut b, TestOf::Bin(i), t, "bin")?;
        }
        for (i, t) in itests.iter().enumerate().filter(|(_, t)| t.test && has(t)) {
            add(&mut b, TestOf::Integration(i), t, "test")?;
        }
    }
    Ok(Plan { units: b.units, bins, tests })
}

/// The manifest's `resolver` setting, or the edition's default.
fn root_resolver(manifest: &str, edition: &str) -> Result<u32, String> {
    let t: toml::Table = toml::from_str(manifest).map_err(|e| e.to_string())?;
    let set = t.get("package").and_then(|p| p.get("resolver")).and_then(|r| r.as_str());
    Ok(match set {
        Some(r) => r.parse().map_err(|_| format!("`resolver` setting `{r}` is not valid"))?,
        None if edition == "2015" || edition == "2018" => 1,
        None => 2,
    })
}

/// Matches each manifest dependency to the resolved package it stands for (same name, version
/// in range). Optional dependencies the resolve didn't enable have no package and no edge.
/// `dev`: the packages whose dev-dependencies count (`cargo test`'s roots).
fn resolve_edges(pkgs: &[Package], input: &PlanInput, dev: &[usize]) -> Result<Edges, String> {
    let mut edges = Vec::new();
    for (i, p) in pkgs.iter().enumerate() {
        let mut e = Vec::new();
        for dep in p.summary.deps.iter().filter(|d| d.kind != DepKind::Development || dev.contains(&i)) {
            let found = input.packages[i].deps.iter().copied().find(|&d| {
                let q = &pkgs[d].summary;
                *q.name == *dep.package && dep.req.matches(&q.version)
            });
            match found {
                Some(d) => e.push((d, dep.clone())),
                None if dep.optional || dep.target.is_some() => {}
                None => return Err(format!("{} {}: dependency `{}` is not in the resolve", p.name(), p.version(), dep.name_in_toml)),
            }
        }
        edges.push(e);
    }
    Ok(edges)
}

/// 64-bit FNV-1a, as 16 hex digits.
fn hash_hex(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

impl Builder<'_> {
    fn layout(&self, host: bool) -> String {
        let p = self.input.profile.dir();
        if host { format!("{}/{p}", self.input.target_dir) } else { format!("{}/{}/{p}", self.input.target_dir, self.target.triple) }
    }

    fn info(&self, host: bool) -> &TargetInfo {
        if host { &self.host } else { &self.target }
    }

    /// The lib dependencies of `pkg` on side `fk` of the given kind: (extern name, unit key).
    fn lib_deps(&self, pkg: usize, host: bool, fk: FeaturesFor, kind: DepKind) -> Result<Vec<(String, Key)>, String> {
        let platforms = Platforms { target: &self.target, host: &self.host };
        let active = self.features.activated_deps.get(&(pkg, fk));
        let mut out: Vec<(String, Key)> = Vec::new();
        for (dep_pkg, dep, dep_fk) in FeatureResolver::deps(&self.pkgs, &self.edges, &platforms, self.decouple_host, pkg, fk)? {
            if dep.kind != kind || (dep.optional && !active.is_some_and(|a| a.contains(&dep.name_in_toml))) {
                continue;
            }
            let d = &self.pkgs[dep_pkg];
            if d.missing {
                return Err(format!("{} {} is needed but was not downloaded", d.name(), d.version()));
            }
            let Some(lib) = &d.lib else { continue };
            let name = if dep.name_in_toml != dep.package { dep.name_in_toml.replace('-', "_") } else { lib.crate_name.clone() };
            let dep_host = host || kind == DepKind::Build || self.pkgs[dep_pkg].is_proc_macro();
            let key = Key::Lib(dep_pkg, dep_host, dep_fk);
            if !out.iter().any(|(n, k)| *n == name && *k == key) {
                out.push((name, key));
            }
        }
        Ok(out)
    }

    /// Builds the unit for `key` (after its dependencies) and returns its id.
    fn unit(&mut self, key: Key) -> Result<usize, String> {
        if let Some(&id) = self.memo.get(&key) {
            return Ok(id);
        }
        let unit = match key {
            Key::Lib(pkg, host, fk) => {
                let mut externs = Vec::new();
                for (name, k) in self.lib_deps(pkg, host, fk, DepKind::Normal)? {
                    externs.push((name, self.unit(k)?));
                }
                let run = self.run_for(pkg, host, fk)?;
                let target = self.pkgs[pkg].lib.clone().unwrap();
                self.compile(pkg, host, fk, UnitKind::Lib, &target, externs, run)
            }
            Key::Bin(pkg, i) => {
                let fk = FeaturesFor::Normal;
                let mut externs = Vec::new();
                for (name, k) in self.lib_deps(pkg, false, fk, DepKind::Normal)? {
                    externs.push((name, self.unit(k)?));
                }
                if let Some(lib) = &self.pkgs[pkg].lib {
                    let name = lib.crate_name.clone();
                    externs.push((name, self.unit(Key::Lib(pkg, false, fk))?));
                }
                let run = self.run_for(pkg, false, fk)?;
                let target = self.pkgs[pkg].bins[i].clone();
                self.compile(pkg, false, fk, UnitKind::Bin, &target, externs, run)
            }
            Key::CustomBuild(pkg, fk) => {
                let mut externs = Vec::new();
                for (name, k) in self.lib_deps(pkg, true, fk, DepKind::Build)? {
                    externs.push((name, self.unit(k)?));
                }
                let p = &self.pkgs[pkg];
                let target = Target {
                    name: "build-script-build".into(),
                    crate_name: "build_script_build".into(),
                    path: p.build.clone().unwrap(),
                    crate_types: vec!["bin".into()],
                    edition: p.edition.clone(),
                    required_features: Vec::new(),
                    test: false,
                    harness: false,
                };
                self.compile(pkg, true, fk, UnitKind::CustomBuild, &target, externs, None)
            }
            Key::Example(pkg, i) => {
                let externs = self.test_externs(pkg)?;
                let target = self.pkgs[pkg].examples[i].clone();
                let run = self.run_for(pkg, false, FeaturesFor::Normal)?;
                self.compile(pkg, false, FeaturesFor::Normal, UnitKind::Example, &target, externs, run)
            }
            Key::Test(pkg, of) => {
                let mut externs = self.test_externs(pkg)?;
                let p = &self.pkgs[pkg];
                let target = match of {
                    TestOf::Lib => {
                        // A lib's harness is the lib itself, so not its own dependency.
                        let own = p.lib.as_ref().unwrap().crate_name.clone();
                        externs.retain(|(n, _)| *n != own);
                        p.lib.clone().unwrap()
                    }
                    TestOf::Bin(i) => p.bins[i].clone(),
                    TestOf::Integration(i) => p.tests[i].clone(),
                };
                let run = self.run_for(pkg, false, FeaturesFor::Normal)?;
                let mut unit = self.compile(pkg, false, FeaturesFor::Normal, UnitKind::Test, &target, externs, run);
                if let TestOf::Integration(_) = of {
                    // The package's bins, as CARGO_BIN_EXE_<name>: built first, at their uplifted paths.
                    let enabled = self.features.of(pkg, FeaturesFor::Normal);
                    for (i, b) in self.pkgs[pkg].bins.clone().iter().enumerate() {
                        if b.required_features.iter().all(|f| enabled.contains(f)) {
                            let id = self.unit(Key::Bin(pkg, i))?;
                            unit.deps.push(id);
                            let exe = format!("{}/{}{}", self.layout(false), b.name, self.target.exe_suffix);
                            unit.env.insert(format!("CARGO_BIN_EXE_{}", b.name), exe);
                        }
                    }
                    unit.deps.sort();
                    unit.deps.dedup();
                    unit.env.insert("CARGO_TARGET_TMPDIR".into(), format!("{}/{}/tmp", self.input.target_dir, self.target.triple));
                }
                unit
            }
            Key::Run(pkg, host, fk) => {
                let script = self.unit(Key::CustomBuild(pkg, fk))?;
                let mut deps = vec![script];
                // Scripts of `links` dependencies run first: their metadata becomes DEP_* here.
                for (_, k) in self.lib_deps(pkg, host, fk, DepKind::Normal)? {
                    let Key::Lib(d, dh, dfk) = k else { unreachable!() };
                    if self.pkgs[d].links.is_some() && self.pkgs[d].build.is_some() {
                        deps.push(self.unit(Key::Run(d, dh, dfk))?);
                    }
                }
                self.run(pkg, host, fk, deps)
            }
        };
        let id = self.units.len();
        self.units.push(Unit { id, ..unit });
        self.memo.insert(key, id);
        Ok(id)
    }

    /// What a test harness or example links: the package's lib, its dependencies and its
    /// dev-dependencies.
    fn test_externs(&mut self, pkg: usize) -> Result<Vec<(String, usize)>, String> {
        let mut externs = Vec::new();
        for kind in [DepKind::Normal, DepKind::Development] {
            for (name, k) in self.lib_deps(pkg, false, FeaturesFor::Normal, kind)? {
                let id = self.unit(k)?;
                if !externs.iter().any(|(n, d)| *n == name && *d == id) {
                    externs.push((name, id));
                }
            }
        }
        if let Some(lib) = &self.pkgs[pkg].lib {
            let name = lib.crate_name.clone();
            externs.push((name, self.unit(Key::Lib(pkg, false, FeaturesFor::Normal))?));
        }
        Ok(externs)
    }

    fn run_for(&mut self, pkg: usize, host: bool, fk: FeaturesFor) -> Result<Option<usize>, String> {
        if self.pkgs[pkg].build.is_none() {
            return Ok(None);
        }
        Ok(Some(self.unit(Key::Run(pkg, host, fk))?))
    }

    fn pkg_env(&self, pkg: usize) -> BTreeMap<String, String> {
        let p = &self.pkgs[pkg];
        let v = p.version();
        let m = &p.meta;
        let mut env = BTreeMap::new();
        let mut set = |k: &str, v: String| {
            env.insert(k.to_string(), v);
        };
        set("CARGO", self.input.tools.cargo.clone());
        set("CARGO_MANIFEST_DIR", p.dir.clone());
        set("CARGO_MANIFEST_PATH", p.manifest_path());
        set("CARGO_PKG_AUTHORS", m.authors.join(":"));
        set("CARGO_PKG_DESCRIPTION", m.description.clone());
        set("CARGO_PKG_HOMEPAGE", m.homepage.clone());
        set("CARGO_PKG_LICENSE", m.license.clone());
        set("CARGO_PKG_LICENSE_FILE", m.license_file.clone());
        set("CARGO_PKG_NAME", p.name().to_string());
        set("CARGO_PKG_README", m.readme.clone());
        set("CARGO_PKG_REPOSITORY", m.repository.clone());
        set("CARGO_PKG_RUST_VERSION", m.rust_version.clone());
        set("CARGO_PKG_VERSION", v.to_string());
        set("CARGO_PKG_VERSION_MAJOR", v.major.to_string());
        set("CARGO_PKG_VERSION_MINOR", v.minor.to_string());
        set("CARGO_PKG_VERSION_PATCH", v.patch.to_string());
        set("CARGO_PKG_VERSION_PRE", v.pre.to_string());
        env
    }

    fn hash(&self, pkg: usize, host: bool, kind: UnitKind, target: &str, features: &[String], deps: &[usize]) -> String {
        let p = &self.pkgs[pkg];
        let mut dep_hashes: Vec<&str> = deps.iter().map(|&d| self.units[d].hash.as_str()).collect();
        dep_hashes.sort();
        hash_hex(&format!(
            "{}|{}|{}|{:?}|{kind:?}|{target}|{}|{features:?}|{:?}|{}|{dep_hashes:?}",
            self.input.rustc_id,
            p.name(),
            p.version(),
            p.summary.source,
            self.info(host).triple,
            self.input.profile,
            self.input.target_flag_for_host,
        ))
    }

    #[allow(clippy::too_many_arguments)]
    fn compile(
        &self,
        pkg: usize,
        host: bool,
        fk: FeaturesFor,
        kind: UnitKind,
        target: &Target,
        mut externs: Vec<(String, usize)>,
        run: Option<usize>,
    ) -> Unit {
        let p = &self.pkgs[pkg];
        let prof = &self.input.profile;
        let features = self.features.of(pkg, fk);
        let mut deps: Vec<usize> = externs.iter().map(|e| e.1).chain(run).collect();
        deps.sort();
        deps.dedup();
        // A lib and a bin can share a name; their harnesses can't share a hash.
        let hash_name = if kind == UnitKind::Test { format!("{}:{}", target.path, target.name) } else { target.name.clone() };
        let hash = self.hash(pkg, host, kind, &hash_name, &features, &deps);
        let proc_macro = kind == UnitKind::Lib && target.crate_types.iter().any(|t| t == "proc-macro");
        // A lib's dependents only need its metadata (pipelining); a proc macro is linked.
        let is_lib = kind == UnitKind::Lib && !proc_macro;
        let layout = self.layout(host);
        let out_dir = match kind {
            UnitKind::CustomBuild => format!("{layout}/build/{}-{hash}", p.name()),
            UnitKind::Example => format!("{layout}/examples"),
            _ => format!("{layout}/deps"),
        };

        let mut a: Vec<String> = Vec::new();
        let mut push = |s: &[&str]| a.extend(s.iter().map(|x| x.to_string()));
        push(&["--crate-name", &target.crate_name, &format!("--edition={}", target.edition)]);
        push(&[&format!("{}/{}", p.dir, target.path)]);
        push(&["--error-format=json", "--json=diagnostic-rendered-ansi,artifacts,future-incompat"]);
        if kind != UnitKind::Test {
            for t in &target.crate_types {
                push(&["--crate-type", t]);
            }
        }
        push(&[if is_lib { "--emit=dep-info,metadata,link" } else { "--emit=dep-info,link" }]);
        if proc_macro {
            push(&["-C", "prefer-dynamic"]);
        }
        if prof.opt_level != "0" {
            push(&["-C", &format!("opt-level={}", prof.opt_level)]);
        }
        push(&["-C", "embed-bitcode=no"]);
        if prof.debuginfo != 0 {
            push(&["-C", &format!("debuginfo={}", prof.debuginfo)]);
        }
        let opt0 = prof.opt_level == "0";
        if prof.debug_assertions != opt0 {
            push(&["-C", if prof.debug_assertions { "debug-assertions=on" } else { "debug-assertions=off" }]);
        }
        if prof.overflow_checks != opt0 {
            push(&["-C", if prof.overflow_checks { "overflow-checks=on" } else { "overflow-checks=off" }]);
        }
        if kind == UnitKind::Test {
            push(&["--test"]);
        }
        a.extend(p.lint_args.iter().cloned());
        let mut push = |s: &[&str]| a.extend(s.iter().map(|x| x.to_string()));
        for f in &features {
            push(&["--cfg", &format!("feature=\"{f}\"")]);
        }
        let values: Vec<String> = p.summary.features.keys().map(|f| format!("\"{f}\"")).collect();
        push(&["--check-cfg", "cfg(docsrs,test)", "--check-cfg", &format!("cfg(feature, values({}))", values.join(", "))]);
        push(&["-C", &format!("metadata={hash}"), "-C", &format!("extra-filename=-{hash}"), "--out-dir", &out_dir]);
        if !host || self.input.target_flag_for_host {
            push(&["--target", &self.info(host).triple]);
        }
        // cargo: incremental for local (path) packages; primary for the packages being built.
        let is_root = self.roots.contains(&pkg) && kind != UnitKind::CustomBuild;
        if p.summary.source == Source::Path && prof.incremental {
            push(&["-C", &format!("incremental={layout}/incremental")]);
        }
        push(&["-L", &format!("dependency={layout}/deps")]);
        if !host {
            push(&["-L", &format!("dependency={}/deps", self.layout(true))]);
        }
        // cargo's order: dependency units sorted by package id (name, version).
        externs.sort_by(|x, y| {
            let (px, py) = (&self.pkgs[self.units[x.1].pkg], &self.pkgs[self.units[y.1].pkg]);
            (px.name(), px.version(), &x.0).cmp(&(py.name(), py.version(), &y.0))
        });
        for (name, d) in &externs {
            let dep = &self.units[*d];
            // A lib only needs its dependencies' metadata (pipelining); executables link them.
            // A proc macro has only its dylib; other libs offer their rmeta to libs.
            let file = if is_lib && dep.outputs.len() > 1 { &dep.outputs[1] } else { &dep.outputs[0] };
            push(&["--extern", &format!("{name}={file}")]);
        }
        if proc_macro {
            push(&["--extern", "proc_macro"]);
        }
        if p.summary.source != Source::Path {
            push(&["--cap-lints", "allow"]);
        }
        if proc_macro {
            a.extend(self.input.proc_macro_args.iter().cloned());
        }
        if host {
            a.extend(self.input.host_args.iter().cloned());
        }
        if kind == UnitKind::CustomBuild {
            a.extend(self.input.build_script_args.iter().cloned());
        }

        let mut env = self.pkg_env(pkg);
        env.insert("CARGO_CRATE_NAME".into(), target.crate_name.clone());
        if kind != UnitKind::CustomBuild {
            if let Some(r) = run {
                env.insert("OUT_DIR".into(), self.units[r].out_dir.clone().unwrap());
            }
        }
        // Bins, examples and a bin's harness (not a lib's, nor an integration test's).
        let is_bin_target = p.bins.iter().any(|b| b.path == target.path) || kind == UnitKind::Example;
        if kind == UnitKind::Bin || kind == UnitKind::Example || (kind == UnitKind::Test && is_bin_target) {
            env.insert("CARGO_BIN_NAME".into(), target.name.clone());
        }
        if is_root {
            env.insert("CARGO_PRIMARY_PACKAGE".into(), "1".into());
        }

        let info = self.info(host);
        let outputs = match kind {
            UnitKind::Lib if proc_macro => vec![format!("{out_dir}/{}{}-{hash}{}", info.dll_prefix, target.crate_name, info.dll_suffix)],
            UnitKind::Lib => vec![format!("{out_dir}/lib{}-{hash}.rlib", target.crate_name), format!("{out_dir}/lib{}-{hash}.rmeta", target.crate_name)],
            _ => vec![format!("{out_dir}/{}-{hash}{}", target.crate_name, info.exe_suffix)],
        };
        Unit {
            id: 0,
            pkg,
            name: p.name().to_string(),
            version: p.version().to_string(),
            kind,
            crate_name: target.crate_name.clone(),
            host,
            features,
            hash,
            deps,
            args: a,
            env,
            build_output: run,
            outputs,
            program: None,
            out_dir: None,
            cwd: None,
            links: None,
        }
    }

    fn run(&self, pkg: usize, host: bool, fk: FeaturesFor, deps: Vec<usize>) -> Unit {
        let p = &self.pkgs[pkg];
        let prof = &self.input.profile;
        let features = self.features.of(pkg, fk);
        let hash = self.hash(pkg, host, UnitKind::RunCustomBuild, "build-script-build", &features, &deps);
        let out_dir = format!("{}/build/{}-{hash}/out", self.layout(host), p.name());
        let info = self.info(host);
        let mut env = self.pkg_env(pkg);
        env.extend(info.cargo_cfg_env(prof.debug_assertions, &features));
        for f in &features {
            env.insert(format!("CARGO_FEATURE_{}", f.to_uppercase().replace('-', "_")), "1".into());
        }
        if let Some(l) = &p.links {
            env.insert("CARGO_MANIFEST_LINKS".into(), l.clone());
        }
        let tools = &self.input.tools;
        for (k, v) in [
            ("CARGO_ENCODED_RUSTFLAGS", String::new()),
            ("DEBUG", (prof.debuginfo != 0).to_string()),
            ("HOST", self.host.triple.clone()),
            ("NUM_JOBS", tools.jobs.to_string()),
            ("OPT_LEVEL", prof.opt_level.clone()),
            ("OUT_DIR", out_dir.clone()),
            ("PROFILE", if prof.name == "dev" { "debug" } else { "release" }.to_string()),
            ("RUSTC", tools.rustc.clone()),
            ("RUSTDOC", tools.rustdoc.clone()),
            ("TARGET", info.triple.clone()),
        ] {
            env.insert(k.into(), v);
        }
        Unit {
            id: 0,
            pkg,
            name: p.name().to_string(),
            version: p.version().to_string(),
            kind: UnitKind::RunCustomBuild,
            crate_name: "build_script_build".into(),
            host,
            features,
            hash,
            program: Some(self.units[deps[0]].outputs[0].clone()),
            deps,
            args: Vec::new(),
            env,
            build_output: None,
            outputs: Vec::new(),
            out_dir: Some(out_dir),
            cwd: Some(p.dir.clone()),
            links: p.links.clone(),
        }
    }
}

/// The unit's final rustc arguments and environment: for a compile unit, with what its build
/// script printed (`outputs`: run unit id → stdout) and the `-L` paths of the scripts it links
/// with; a run unit gets `DEP_<LINKS>_<KEY>` from the scripts of its `links` dependencies.
pub fn finish(plan: &Plan, id: usize, outputs: &HashMap<usize, String>) -> Result<Finished, String> {
    let u = &plan.units[id];
    let (mut args, mut env) = (u.args.clone(), u.env.clone());
    let mut warnings = Vec::new();
    let parse = |r: usize| BuildOutput::parse(outputs.get(&r).map(String::as_str).unwrap_or(""), &plan.units[r].name);
    match u.kind {
        UnitKind::RunCustomBuild => {
            for &d in &u.deps[1..] {
                let dep = &plan.units[d];
                let links = dep.links.as_deref().unwrap_or_default().to_uppercase().replace('-', "_");
                for (k, v) in parse(d)?.metadata {
                    env.insert(format!("DEP_{links}_{}", k.to_uppercase().replace('-', "_")), v);
                }
            }
        }
        _ => {
            let mut out = match u.build_output {
                Some(r) => parse(r)?,
                None => BuildOutput::default(),
            };
            if !out.errors.is_empty() {
                return Err(format!("build script of {} {} failed: {}", u.name, u.version, out.errors.join("; ")));
            }
            // cargo's `to_link`: link-search paths come from the unit's own script, then from
            // those of the target-side libs it links with, transitively.
            let mut search = std::mem::take(&mut out.link_search);
            for r in to_link(plan, id).into_iter().filter(|&r| Some(r) != u.build_output) {
                search.extend(parse(r)?.link_search);
            }
            out.link_search = search;
            out.apply(&mut args, &mut env, u.kind == UnitKind::Bin);
            warnings = out.warnings;
        }
    }
    Ok(Finished { args, env, warnings })
}

/// The run units whose `-L` paths a compile unit gets, in cargo's order, without repeats.
fn to_link(plan: &Plan, id: usize) -> Vec<usize> {
    fn walk(plan: &Plan, id: usize, out: &mut Vec<usize>) {
        let u = &plan.units[id];
        if let Some(r) = u.build_output {
            if !out.contains(&r) {
                out.push(r);
            }
        }
        for &d in &u.deps {
            let dep = &plan.units[d];
            // Proc macros and host-side libs aren't linked into the unit.
            if dep.kind == UnitKind::Lib && !dep.host {
                walk(plan, d, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(plan, id, &mut out);
    out
}

#[derive(Serialize, Debug)]
pub struct Finished {
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub warnings: Vec<String>,
}
