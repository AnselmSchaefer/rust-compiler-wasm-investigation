// Metadata for dependents (DEP_LINKA_*) and a link-search path for their compiles.
use std::{env, fs, path::Path};

fn main() {
    let out = env::var("OUT_DIR").unwrap();
    fs::create_dir_all(Path::new(&out).join("lib")).unwrap();
    // A relative path read from the package dir: build scripts run there.
    let note = fs::read_to_string("note.txt").unwrap();
    println!("cargo:rustc-link-search=native={out}/lib");
    println!("cargo:greeting={}", note.trim());
    println!("cargo:include={out}/include");
    println!("cargo:rustc-env=LINKA_CWD={}", env::current_dir().unwrap().display().to_string().rsplit('/').next().unwrap());
}
