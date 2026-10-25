//! pm-rewrite (WP-19): turn a proc-macro crate into a guest of the `rust:proc-macro` world.
//!
//!   pm-rewrite <crate dir> <out dir> <pm_guest dir>
//!
//! rustc drops the `proc-macro` crate type on wasm targets (they're `only_cdylib`), and the
//! `#[proc_macro*]` attributes are only allowed in proc-macro crates. So the crate becomes a
//! cdylib: the attributes on the crate root's functions are blanked out (spaces, so lines and
//! columns stay the same), and `pm_guest::export_proc_macros!` is appended with the macros in
//! declaration order. Cargo.toml: `proc-macro = true` → `crate-type = ["cdylib"]`, plus the
//! `pm_guest` dependency and an empty `[workspace]`; dev-dependencies and a packaged Cargo.lock
//! are dropped. Compile with `--extern proc_macro`, as cargo does for proc-macro crates
//! (`cargo rustc ... -- --extern proc_macro`).
//! Prints the macros (JSON) on stdout.

use std::fs;
use std::path::{Path, PathBuf};

use proc_macro2::LineColumn;
use serde_json::json;
use syn::{Attribute, Item, Meta};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        eprintln!("usage: pm-rewrite <crate dir> <out dir> <pm_guest dir>");
        std::process::exit(2);
    }
    let (src, out, guest) = (Path::new(&args[1]), Path::new(&args[2]), fs::canonicalize(&args[3]).unwrap());
    if out.exists() {
        fs::remove_dir_all(out).unwrap();
    }
    copy_dir(src, out);
    // A packaged Cargo.lock pins the crate's own dev setup; the guest resolves like a dependency.
    let _ = fs::remove_file(out.join("Cargo.lock"));
    let manifest = fs::read_to_string(out.join("Cargo.toml")).unwrap();
    let lib = lib_path(&manifest);
    let (cargo, macros) = (rewrite_manifest(&manifest, &guest), rewrite_lib(&out.join(&lib)));
    fs::write(out.join("Cargo.toml"), cargo).unwrap();
    println!("{}", serde_json::to_string(&macros).unwrap());
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for e in fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let p: PathBuf = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            if e.file_name() != "target" {
                copy_dir(&e.path(), &p);
            }
        } else {
            fs::copy(e.path(), p).unwrap();
        }
    }
}

/// `[lib] path`, else src/lib.rs.
fn lib_path(manifest: &str) -> String {
    let mut in_lib = false;
    for line in manifest.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            in_lib = t == "[lib]";
        } else if in_lib {
            if let Some(v) = t.strip_prefix("path").map(str::trim_start).and_then(|v| v.strip_prefix('=')) {
                return v.trim().trim_matches('"').to_string();
            }
        }
    }
    "src/lib.rs".into()
}

fn rewrite_manifest(manifest: &str, guest: &Path) -> String {
    let mut out = String::new();
    let mut has_lib = false;
    let mut dev = false;
    for line in manifest.lines() {
        let t = line.trim().replace(' ', "");
        if t.starts_with('[') {
            // Dev-dependencies aren't needed to build the guest, and would only widen the lockfile.
            dev = t.starts_with("[dev-dependencies") || (t.starts_with("[target.") && t.contains(".dev-dependencies"));
        }
        if dev || t == "proc-macro=true" || t == "proc_macro=true" {
            continue;
        }
        out.push_str(line);
        out.push('\n');
        if line.trim() == "[lib]" {
            has_lib = true;
            out.push_str("crate-type = [\"cdylib\"]\n");
        }
    }
    if !has_lib {
        out.push_str("\n[lib]\ncrate-type = [\"cdylib\"]\n");
    }
    out.push_str(&format!("\n[dependencies.pm_guest]\npath = {:?}\n\n[workspace]\n", guest.display().to_string()));
    out
}

/// Blank the `#[proc_macro*]` attributes of the root's functions; append the export.
fn rewrite_lib(path: &Path) -> serde_json::Value {
    let text = fs::read_to_string(path).unwrap();
    let file = syn::parse_file(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let lines: Vec<usize> = std::iter::once(0).chain(text.match_indices('\n').map(|(i, _)| i + 1)).collect();
    // LineColumn: 1-based line, column in chars.
    let offset = |lc: LineColumn| {
        let start = lines[lc.line - 1];
        start + text[start..].chars().take(lc.column).map(char::len_utf8).sum::<usize>()
    };
    let mut blank = Vec::new();
    let mut macros = Vec::new();
    let mut exports = Vec::new();
    for item in &file.items {
        let Item::Fn(f) = item else { continue };
        for attr in &f.attrs {
            let Some((kind, name, attributes)) = proc_macro_attr(attr, &f.sig.ident.to_string()) else { continue };
            blank.push((offset(attr.pound_token.span.start()), offset(attr.bracket_token.span.close().end())));
            macros.push(json!({ "kind": kind, "name": name, "attributes": attributes }));
            exports.push(format!("{} {}", if kind == "attr" { "expand2" } else { "expand1" }, f.sig.ident));
        }
    }
    let mut bytes = text.into_bytes();
    for (a, b) in blank {
        for c in &mut bytes[a..b] {
            if *c != b'\n' {
                *c = b' ';
            }
        }
    }
    let mut text = String::from_utf8(bytes).expect("attributes are ASCII");
    let list = serde_json::Value::Array(macros);
    text.push_str(&format!(
        "\n// Added by pm-rewrite (WP-19): the proc macros above, as a rust:proc-macro guest.\n::pm_guest::export_proc_macros!({:?}; {});\n",
        list.to_string(),
        exports.join(", ")
    ));
    fs::write(path, text).unwrap();
    list
}

/// `#[proc_macro]`, `#[proc_macro_attribute]`, `#[proc_macro_derive(Name, attributes(a, b))]`.
fn proc_macro_attr(attr: &Attribute, fn_name: &str) -> Option<(&'static str, String, Vec<String>)> {
    let path = attr.path();
    if path.is_ident("proc_macro") {
        return Some(("bang", fn_name.into(), vec![]));
    }
    if path.is_ident("proc_macro_attribute") {
        return Some(("attr", fn_name.into(), vec![]));
    }
    if !path.is_ident("proc_macro_derive") {
        return None;
    }
    let Meta::List(list) = &attr.meta else { panic!("#[proc_macro_derive] without a name") };
    let mut name = None;
    let mut attributes = vec![];
    list.parse_nested_meta(|m| {
        if m.path.is_ident("attributes") {
            m.parse_nested_meta(|a| {
                attributes.push(a.path.get_ident().expect("helper attribute name").to_string());
                Ok(())
            })
        } else {
            name = Some(m.path.get_ident().expect("derive name").to_string());
            Ok(())
        }
    })
    .unwrap();
    Some(("derive", name.expect("derive name"), attributes))
}
