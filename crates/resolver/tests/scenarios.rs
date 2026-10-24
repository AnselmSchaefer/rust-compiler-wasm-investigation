//! Resolver behaviours on a small synthetic index, for the cases the golden corpus may not hit:
//! backtracking, MSRV fallback, a missing feature, `links`, optional and weak dependencies,
//! renames, and yanked versions. With SCENARIO_DUMP=<dir>, each case is also written out
//! (<dir>/<case>/{index/,Cargo.toml,src/lib.rs,ours.lock}) so tests/resolver/check-scenarios.sh can
//! run native cargo on it and compare.

use resolver::{Registry, generate_lockfile, index::index_path};
use std::collections::HashMap;

struct MemRegistry(HashMap<String, Vec<String>>);

impl Registry for MemRegistry {
    fn index_file(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        Ok(self.0.get(name).map(|lines| lines.join("\n").into_bytes()))
    }
}

/// `pkg(name, vers, deps, extra)`: one index line; `deps` are `(name, req, extra-json)`.
fn pkg(name: &str, vers: &str, deps: &[(&str, &str, &str)], extra: &str) -> (String, String) {
    let deps: Vec<String> = deps
        .iter()
        .map(|(n, r, x)| {
            let optional = if x.contains("optional") { "" } else { r#""optional":false,"# };
            format!(r#"{{"name":"{n}","req":"{r}","features":[],{optional}"default_features":true,"target":null,"kind":"normal"{}{x}}}"#, if x.is_empty() { "" } else { "," })
        })
        .collect();
    let features = if extra.contains(r#""features":"#) { "" } else { r#""features":{},"# };
    let extra = if extra.is_empty() { String::new() } else { format!(",{extra}") };
    (name.to_string(), format!(r#"{{"name":"{name}","vers":"{vers}","deps":[{}],{features}"cksum":"{name}-{vers}","yanked":false{extra}}}"#, deps.join(",")))
}

fn registry(lines: Vec<(String, String)>) -> MemRegistry {
    let mut m: HashMap<String, Vec<String>> = HashMap::new();
    for (n, l) in lines {
        m.entry(n).or_default().push(l);
    }
    MemRegistry(m)
}

/// Our lockfile for `manifest`; dumps the case for check-scenarios.sh when SCENARIO_DUMP is set.
fn lock(case: &str, manifest: &str, r: &MemRegistry) -> Result<String, String> {
    let out = generate_lockfile(manifest, r);
    if let Some(dump) = std::env::var_os("SCENARIO_DUMP") {
        let dir = std::path::Path::new(&dump).join(case);
        for (name, lines) in &r.0 {
            let f = dir.join("index").join(index_path(name));
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, lines.join("\n") + "\n").unwrap();
        }
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/lib.rs"), "").unwrap();
        std::fs::write(dir.join("Cargo.toml"), manifest).unwrap();
        std::fs::write(dir.join("ours.lock"), out.as_deref().unwrap_or("error\n")).unwrap();
    }
    out
}

fn root(edition_etc: &str, deps: &str) -> String {
    format!("[package]\nname = \"root\"\nversion = \"0.1.0\"\n{edition_etc}\n{deps}")
}

/// The `name version` pairs in a lockfile, root excluded.
fn locked(lock: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut name = String::new();
    for line in lock.lines() {
        if let Some(n) = line.strip_prefix("name = ") {
            name = n.trim_matches('"').into();
        } else if let Some(v) = line.strip_prefix("version = \"") {
            if name != "root" {
                out.push(format!("{name} {}", v.trim_end_matches('"')));
            }
        }
    }
    out
}

#[test]
fn backtracks_on_semver_conflict() {
    // b (one candidate) goes first and pins c 1.0.0; a 1.1.0 needs c =1.1.0, so a falls back to 1.0.0.
    let r = registry(vec![
        pkg("a", "1.0.0", &[("c", "=1.0.0", "")], ""),
        pkg("a", "1.1.0", &[("c", "=1.1.0", "")], ""),
        pkg("b", "1.0.0", &[("c", "=1.0.0", "")], ""),
        pkg("c", "1.0.0", &[], ""),
        pkg("c", "1.1.0", &[], ""),
    ]);
    let lock = lock("backtrack", &root("", "[dependencies]\na = \"1\"\nb = \"1\""), &r).unwrap();
    assert_eq!(locked(&lock), ["a 1.0.0", "b 1.0.0", "c 1.0.0"]);
}

#[test]
fn semver_incompatible_versions_coexist() {
    let r = registry(vec![
        pkg("a", "1.0.0", &[("c", "^0.1", "")], ""),
        pkg("c", "0.1.5", &[], ""),
        pkg("c", "0.2.0", &[], ""),
    ]);
    let lock = lock("coexist", &root("", "[dependencies]\na = \"1\"\nc = \"0.2\""), &r).unwrap();
    assert_eq!(locked(&lock), ["a 1.0.0", "c 0.1.5", "c 0.2.0"]);
    assert!(lock.contains(" \"c 0.1.5\",\n"), "two versions of c, so entries carry the version:\n{lock}");
}

#[test]
fn msrv_fallback_only_with_resolver_v3() {
    let r = registry(vec![
        pkg("x", "1.1.0", &[], r#""rust_version":"1.65""#),
        pkg("x", "1.2.0", &[], r#""rust_version":"1.80""#),
    ]);
    let deps = "[dependencies]\nx = \"1\"";
    let v3 = lock("msrv-v3", &root("edition = \"2021\"\nresolver = \"3\"\nrust-version = \"1.70\"", deps), &r).unwrap();
    assert_eq!(locked(&v3), ["x 1.1.0"]);
    let v2 = lock("msrv-v2", &root("edition = \"2021\"\nrust-version = \"1.70\"", deps), &r).unwrap();
    assert_eq!(locked(&v2), ["x 1.2.0"]);
    // Nothing compatible: the highest version after all.
    let old = lock("msrv-none-compatible", &root("edition = \"2021\"\nresolver = \"3\"\nrust-version = \"1.60\"", deps), &r).unwrap();
    assert_eq!(locked(&old), ["x 1.2.0"]);
    // rust-version 1.70 picks lockfile v3, none picks v4.
    assert!(v3.contains("\nversion = 3\n"));
    assert!(lock("msrv-none", &root("edition = \"2024\"", deps), &r).unwrap().contains("\nversion = 4\n"));
}

#[test]
fn missing_feature_falls_back_to_older_version() {
    let r = registry(vec![pkg("x", "1.1.0", &[], r#""features2":{"f":[]}"#), pkg("x", "1.2.0", &[], "")]);
    let lock = lock("missing-feature", &root("", "[dependencies]\nx = { version = \"1\", features = [\"f\"] }"), &r).unwrap();
    assert_eq!(locked(&lock), ["x 1.1.0"]);
}

#[test]
fn links_are_unique() {
    let r = registry(vec![
        pkg("a", "1.0.0", &[], r#""links":"z""#),
        pkg("b", "1.0.0", &[], ""),
        pkg("b", "1.1.0", &[], r#""links":"z""#),
    ]);
    let lock = lock("links", &root("", "[dependencies]\na = \"=1.0.0\"\nb = \"1\""), &r).unwrap();
    assert_eq!(locked(&lock), ["a 1.0.0", "b 1.0.0"]);
}

#[test]
fn optional_and_weak_dependencies() {
    let opt = r#""optional":true"#;
    // x: `y` only through feature "extra"; `w` named only weakly ("w?/foo"), which the
    // dependency resolver still activates (cargo puts it in the lockfile too).
    let r = registry(vec![
        pkg("x", "1.0.0", &[("y", "1", opt), ("w", "1", opt)], r#""features":{"extra":["dep:y"],"default":["w?/foo"],"w":["dep:w"]}"#),
        pkg("y", "1.0.0", &[], ""),
        pkg("w", "1.0.0", &[], r#""features2":{"foo":[]}"#),
    ]);
    let plain = lock("weak-plain", &root("", "[dependencies]\nx = \"1\""), &r).unwrap();
    assert_eq!(locked(&plain), ["w 1.0.0", "x 1.0.0"]);
    let extra = lock("weak-extra", &root("", "[dependencies]\nx = { version = \"1\", features = [\"extra\"] }"), &r).unwrap();
    assert_eq!(locked(&extra), ["w 1.0.0", "x 1.0.0", "y 1.0.0"]);
    let no_default = lock("weak-no-default", &root("", "[dependencies]\nx = { version = \"1\", default-features = false }"), &r).unwrap();
    assert_eq!(locked(&no_default), ["x 1.0.0"]);
}

#[test]
fn renamed_and_yanked() {
    let r = registry(vec![
        pkg("real", "1.0.0", &[], ""),
        ("real".into(), pkg("real", "1.1.0", &[], "").1.replace(r#""yanked":false"#, r#""yanked":true"#)),
    ]);
    let lock = lock("renamed-yanked", &root("", "[dependencies]\nalias = { version = \"1\", package = \"real\" }"), &r).unwrap();
    assert_eq!(locked(&lock), ["real 1.0.0"]);
    assert!(lock.contains("dependencies = [\n \"real\",\n]"), "{lock}");
}

#[test]
fn unsatisfiable_is_an_error() {
    let r = registry(vec![pkg("a", "1.0.0", &[], "")]);
    assert!(lock("unsatisfiable", &root("", "[dependencies]\na = \"2\""), &r).is_err());
}
