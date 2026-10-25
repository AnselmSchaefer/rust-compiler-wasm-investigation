use std::env;

fn main() {
    let g = env::var("DEP_LINKA_GREETING").expect("DEP_LINKA_GREETING");
    let inc = env::var("DEP_LINKA_INCLUDE").expect("DEP_LINKA_INCLUDE");
    println!("cargo:rustc-env=LINKB_GREETING={g}");
    println!("cargo:rustc-env=LINKB_INCLUDE_DIR={}", inc.ends_with("/include"));
}
