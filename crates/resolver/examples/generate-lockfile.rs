//! `generate-lockfile <Cargo.toml> <index dir>`: prints the Cargo.lock our resolver writes.
//! Used by scripts/verify/wp-15.sh to run the resolver as wasm32-wasip1 under wasmtime.

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let [_, manifest, index] = &args[..] else {
        eprintln!("usage: generate-lockfile <Cargo.toml> <index dir>");
        std::process::exit(2);
    };
    let manifest = std::fs::read_to_string(manifest).expect("reading the manifest");
    match resolver::generate_lockfile(&manifest, &resolver::DirRegistry(index.into())) {
        Ok(lock) => print!("{lock}"),
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    }
}
