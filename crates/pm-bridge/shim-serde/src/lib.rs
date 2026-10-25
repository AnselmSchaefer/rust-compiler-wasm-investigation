//! `#[derive(Serialize, Deserialize)]` as serde_derive's, but expanded by serde_derive compiled to
//! wasm32-wasip1 (pm-rewrite + pm_guest), run by pm_host under wasmtime with the proxy server.
//! The module: `$PM_SERDE_DERIVE_WASM` at run time, else the same variable at build time.
//! `$PM_STATS=<file>`: append one line of timings per expansion.

extern crate proc_macro;

use std::path::PathBuf;

use proc_macro::TokenStream;

fn guest() -> PathBuf {
    std::env::var_os("PM_SERDE_DERIVE_WASM")
        .map(PathBuf::from)
        .or(option_env!("PM_SERDE_DERIVE_WASM").map(PathBuf::from))
        .expect("PM_SERDE_DERIVE_WASM: the serde_derive guest module")
}

fn derive(name: &str, input: TokenStream) -> TokenStream {
    let out = pm_host::expand(&guest(), "derive", name, input, None);
    if let Some(f) = std::env::var_os("PM_STATS") {
        use std::io::Write;
        let s = pm_host::STATS.with_borrow(|s| *s);
        let methods: Vec<String> = s.methods.iter().zip(pm_host::METHODS).filter(|(m, _)| m.0 > 0)
            .map(|((n, t), name)| format!("\"{name}\":[{n},{}]", t.as_micros())).collect();
        let line = format!(
            "{{\"macro\":\"{name}\",\"calls\":{},\"dispatches\":{},\"total_us\":{},\"server_us\":{},\"native_us\":{},\"load_us\":{},\"methods\":{{{}}}}}\n",
            s.calls, s.dispatches, s.total.as_micros(), s.server.as_micros(), s.native.as_micros(), s.load.as_micros(), methods.join(",")
        );
        let _ = std::fs::OpenOptions::new().create(true).append(true).open(f).and_then(|mut f| f.write_all(line.as_bytes()));
    }
    out
}

#[proc_macro_derive(Serialize, attributes(serde))]
pub fn derive_serialize(input: TokenStream) -> TokenStream {
    derive("Serialize", input)
}

#[proc_macro_derive(Deserialize, attributes(serde))]
pub fn derive_deserialize(input: TokenStream) -> TokenStream {
    derive("Deserialize", input)
}
