//! WP-17 golden test: for each case in tests/planner/cases/ (recorded by tests/planner/record.sh
//! from native `cargo build -vv --target wasm32-wasip1`), load the case as a workspace (WP-25), resolve it against
//! the index snapshot, plan it, add the recorded build-script outputs, and compare every rustc
//! invocation and build-script run with cargo's: same units, same arguments in the same order,
//! same environment. Hashes (16 hex digits) are ours, not cargo's, so both sides compare them as
//! `H`; LD_LIBRARY_PATH is native-only. Needs build/wp-15/index (scripts/verify/wp-15.sh).

use resolver::plan::{InputPackage, PlanInput, Profile, Tools, UnitKind, finish, plan};
use resolver::summary::Source;
use resolver::{DirRegistry, workspace, write_lockfile};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap()
}

/// 16 hex digits → H (our hashes and cargo's differ by design).
fn unhash(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < b.len() {
        let run = b[i..].iter().take_while(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()).count();
        if run == 16 && (i == 0 || !b[i - 1].is_ascii_alphanumeric()) {
            out.push('H');
            i += 16;
        } else {
            out.push(b[i] as char);
            i += 1;
        }
    }
    out
}

#[derive(Debug, PartialEq)]
struct Invocation {
    args: Vec<String>,
    env: BTreeMap<String, String>,
}

/// Unit key: "rustc <pkg> <crate-name> <crate-type>" or "run <pkg>".
fn cargo_invocations(case: &Path) -> BTreeMap<String, Invocation> {
    let mut out = BTreeMap::new();
    for line in std::fs::read_to_string(case.join("cargo-vv.jsonl")).unwrap().lines() {
        let v: Value = serde_json::from_str(line).unwrap();
        let mut env: BTreeMap<String, String> =
            v["env"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), unhash(v.as_str().unwrap()))).collect();
        env.remove("LD_LIBRARY_PATH");
        let pkg = env["CARGO_PKG_NAME"].clone();
        let args: Vec<String> = v["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.as_str().unwrap())
            // The root's sources are relative to the workspace (cargo's working directory).
            .map(|a| if a.ends_with(".rs") && !a.starts_with('$') { format!("$ROOT/{a}") } else { a.to_string() })
            .map(|a| unhash(&a))
            .collect();
        // -vv makes cargo show dependencies' warnings (--cap-lints warn); a plain build allows.
        let args = args.into_iter().map(|a| if a == "warn" { "allow".to_string() } else { a }).collect::<Vec<_>>();
        let key = if v["program"] == "rustc" {
            rustc_key(&pkg, &args)
        } else {
            format!("run {pkg}")
        };
        assert!(out.insert(key.clone(), Invocation { args, env }).is_none(), "{key} twice");
    }
    out
}

/// A compile's identity: package, crate, crate type (or `--test`, WP-26), and the source file,
/// since a lib and a bin's harnesses can share a crate name.
fn rustc_key(pkg: &str, args: &[String]) -> String {
    let at = |f: &str| args.iter().position(|a| a == f).map(|i| args[i + 1].clone());
    let kind = at("--crate-type").unwrap_or_else(|| "--test".into());
    let src = args.iter().find(|a| a.ends_with(".rs")).cloned().unwrap_or_default();
    format!("rustc {pkg} {} {kind} {}", at("--crate-name").unwrap(), src.rsplit('/').take(2).collect::<Vec<_>>().join("<"))
}

/// The case's own files below `dir` (relative), without the recordings and without the
/// directories of other packages (each package's file list is its own, as in cargo).
fn case_files(case: &Path, dir: &Path, packages: &[PathBuf]) -> Vec<String> {
    let mut files = Vec::new();
    for e in walk(dir) {
        let rel_case = e.strip_prefix(case).unwrap().to_string_lossy().into_owned();
        if ["crates/", "build-output/", "cargo-vv.jsonl"].iter().any(|p| rel_case.starts_with(p)) {
            continue;
        }
        if packages.iter().any(|p| p != dir && p.starts_with(dir) && e.starts_with(p)) {
            continue;
        }
        files.push(e.strip_prefix(dir).unwrap().to_string_lossy().into_owned());
    }
    files.sort();
    files
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() { out.extend(walk(&p)) } else { out.push(p) }
    }
    out
}

fn check_case(case: &Path, index: &Path) -> Vec<String> {
    // Every Cargo.toml of the case (not the recorded registry crates) → the workspace.
    let dirs: Vec<PathBuf> = walk(case)
        .into_iter()
        .filter(|p| p.file_name().is_some_and(|n| n == "Cargo.toml") && !p.strip_prefix(case).unwrap().starts_with("crates"))
        .map(|p| p.parent().unwrap().to_path_buf())
        .collect();
    let virt = |d: &Path| {
        let rel = d.strip_prefix(case).unwrap().to_string_lossy().into_owned();
        if rel.is_empty() { "$ROOT".to_string() } else { format!("$ROOT/{rel}") }
    };
    let manifests: BTreeMap<String, String> = dirs.iter().map(|d| (virt(d), std::fs::read_to_string(d.join("Cargo.toml")).unwrap())).collect();
    let ws = workspace::load("$ROOT", &manifests).unwrap_or_else(|e| panic!("{}: {e}", case.display()));
    let r = ws.resolve(&DirRegistry(index.into())).unwrap();
    let mut problems = Vec::new();
    if let Ok(expected) = std::fs::read_to_string(case.join("Cargo.lock")) {
        if write_lockfile(&r) != expected {
            problems.push(format!("Cargo.lock differs from cargo's:\n{}", write_lockfile(&r)));
        }
    }
    let ws_pkg = |dir: &str| ws.packages.iter().position(|p| p.dir == dir).unwrap();
    let roots: Vec<usize> = ws.default_members.iter().map(|&m| r.packages.iter().position(|p| p.dir.as_deref() == Some(ws.packages[m].dir.as_str())).unwrap()).collect();
    let packages = r
        .packages
        .iter()
        .map(|p| {
            let nv = format!("{}-{}", p.name, p.version);
            let (manifest, dir, files) = if let Some(dir) = &p.dir {
                let real = dirs.iter().find(|d| virt(d) == **dir).unwrap();
                (Some(ws.packages[ws_pkg(dir)].manifest.clone()), dir.to_string(), case_files(case, real, &dirs))
            } else {
                let d = case.join("crates").join(&nv);
                let files = std::fs::read_to_string(d.join("files.txt")).map(|f| f.lines().map(String::from).collect()).unwrap_or_default();
                (std::fs::read_to_string(d.join("Cargo.toml")).ok(), format!("$REG/{nv}"), files)
            };
            InputPackage {
                name: p.name.to_string(),
                version: p.version.to_string(),
                manifest,
                dir,
                source: if p.source == Source::Path { "path" } else { "registry" }.into(),
                files,
                deps: p.deps.clone(),
            }
        })
        .collect();
    let input = PlanInput {
        packages,
        roots,
        root: None,
        resolver: Some(ws.resolver),
        target: "wasm32-wasip1".into(),
        host: "x86_64-unknown-linux-gnu".into(),
        target_dir: "$TARGET".into(),
        features: Vec::new(),
        default_features: true,
        profile: Profile::default(),
        rustc_id: "test".into(),
        target_flag_for_host: false,
        tools: Tools { jobs: 12, ..Tools::default() },
        proc_macro_args: Vec::new(),
        host_args: Vec::new(),
        build_script_args: Vec::new(),
        // record.sh's command for the case: `cargo test --no-run` plans test units (WP-26).
        test: std::fs::read_to_string(case.join("record.cmd")).is_ok_and(|c| c.starts_with("test")),
    };
    let p = plan(&input).unwrap_or_else(|e| panic!("{}: {e}", case.display()));

    // Recorded build-script outputs, as if each run unit had just run.
    let mut outputs = HashMap::new();
    for u in &p.units {
        if u.kind == UnitKind::RunCustomBuild {
            let side = if u.host { ".host" } else { "" };
            let f = case.join("build-output").join(format!("{}-{}{side}.txt", u.name, u.version));
            outputs.insert(u.id, std::fs::read_to_string(&f).unwrap_or_else(|_| panic!("no {}", f.display())));
        }
    }
    let mut ours = BTreeMap::new();
    for u in &p.units {
        let f = finish(&p, u.id, &outputs).unwrap();
        let env: BTreeMap<String, String> = f.env.iter().map(|(k, v)| (k.clone(), unhash(v))).collect();
        let key = match u.kind {
            UnitKind::RunCustomBuild => format!("run {}", u.name),
            _ => rustc_key(&u.name, &f.args),
        };
        let args = f.args.iter().map(|a| unhash(a)).collect();
        assert!(ours.insert(key.clone(), Invocation { args, env }).is_none(), "{key} twice in our plan");
    }

    let theirs = cargo_invocations(case);
    for k in theirs.keys().filter(|k| !ours.contains_key(*k)) {
        problems.push(format!("missing unit: {k}"));
    }
    for k in ours.keys().filter(|k| !theirs.contains_key(*k)) {
        problems.push(format!("extra unit: {k}"));
    }
    for (k, t) in &theirs {
        let Some(o) = ours.get(k) else { continue };
        if o.args != t.args {
            problems.push(format!("{k}: args differ\n  cargo: {}\n  ours:  {}", t.args.join(" "), o.args.join(" ")));
        }
        for (name, v) in &t.env {
            match o.env.get(name) {
                Some(ov) if ov == v => {}
                ov => problems.push(format!("{k}: env {name}: cargo {v:?}, ours {ov:?}")),
            }
        }
        for name in o.env.keys().filter(|n| !t.env.contains_key(*n)) {
            problems.push(format!("{k}: env {name} is extra"));
        }
    }
    println!("{}: {} units, {} invocations in cargo's build, {} problems", case.file_name().unwrap().to_string_lossy(), p.units.len(), theirs.len(), problems.len());
    problems
}

#[test]
fn golden_plans() {
    let root = repo();
    let index = root.join("build/wp-15/index");
    assert!(index.is_dir(), "index snapshot not unpacked at {}", index.display());
    let mut cases: Vec<PathBuf> = std::fs::read_dir(root.join("tests/planner/cases")).unwrap().map(|e| e.unwrap().path()).collect();
    cases.sort();
    let mut all = Vec::new();
    for c in &cases {
        all.extend(check_case(c, &index).into_iter().map(|p| format!("[{}] {p}", c.file_name().unwrap().to_string_lossy())));
    }
    assert!(all.is_empty(), "{} differences:\n{}", all.len(), all.join("\n"));
}
