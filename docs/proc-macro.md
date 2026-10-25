# Proc macros in Wasm: the bridge (WP-19)

*2026-10-25. Status: done (native prototype). `scripts/verify/wp-19.sh` passes.*

## Result

serde_derive 1.0.229, compiled to wasm32-wasip1 and run under wasmtime, expands `#[derive(Serialize, Deserialize)]` exactly as the native `.so` does. On `tests/proc-macro/serde-demo`, `-Zunpretty=expanded` is byte-identical (1962 lines). `-Zunpretty=expanded,hygiene` is identical up to interned symbol numbers, so all 86 syntax contexts match. Both programs print the same. Per-call overhead with proc macros optimized: **~2.0–2.1× measured end to end**, and **~1.7× estimated without the prototype's proxy hop**. See `bench/proc-macro.md`.

No rustc source is touched. The guest uses the sysroot's own `proc_macro` (rustup's 1.99.1 wasm32-wasip1 std, the one the browser release ships) as its bridge client.

## Pieces (`crates/pm-bridge/`, its own workspace)

| Piece | What |
|---|---|
| `wit/proc-macro.wit` | World `rust:proc-macro`: the guest exports `client.macros() -> string` and `client.expand(index, input: list<u8>, force-show-panics) -> list<u8>`; it imports `server.dispatch(request: list<u8>) -> list<u8>`. Bytes-level: the lists are `proc_macro::bridge` buffers. |
| `guest/` (`pm_guest`, wasm only) | The guest's glue. `export_proc_macros!` builds the decls array rustc's proc-macro harness would build (`Client::expand1`/`expand2` per macro, in declaration order). It is a `macro_rules!` with `allow_internal_unstable(proc_macro_internals)`, so the macro crate needs no unstable flags (only pm_guest is built with `RUSTC_BOOTSTRAP=pm_guest`). The world's exports are written by hand in the canonical-ABI lowering, plus `_initialize`. |
| `rewrite/` (`pm-rewrite`) | Proc-macro crate → guest crate (see below). |
| `host/` (`pm_host`, native) | wasmtime runtime for a guest, and a bridge server for the prototype (`proxy.rs`). |
| `shim-serde/` | A native proc macro with serde_derive's two derives, forwarding to the guest. Used by the demo and the benchmark. |
| `scripts/build-pm-guest.sh` | rewrite → pin versions to a reference Cargo.lock → `cargo rustc --target wasm32-wasip1 --release` (fat LTO, 1 CGU) `-- --extern proc_macro`. |

### Why a cdylib, and the rewrite

rustc drops crate type `proc-macro` on wasm targets, because they are `only_cdylib` ("dropping unsupported crate type"). Then `#[proc_macro_derive]` is an error, since those attributes are only allowed in proc-macro crates. So `pm-rewrite`:

- blanks the `#[proc_macro]`, `#[proc_macro_derive(...)]` and `#[proc_macro_attribute]` attributes on the crate root's functions, writing spaces so that lines and columns (`line!()`, diagnostics) stay the same. It parses with `syn` and edits by byte offsets, not by reprinting.
- appends `::pm_guest::export_proc_macros!("<macros JSON>"; expand1 derive_serialize, ...)`.
- edits Cargo.toml: `proc-macro = true` → `crate-type = ["cdylib"]`, adds the `pm_guest` path dependency and an empty `[workspace]`, drops dev-dependencies and a packaged Cargo.lock.

It is compiled with `--extern proc_macro`, as cargo does for proc-macro crates. proc-macro2 has no wasm special case (1.0.107: `wrap_proc_macro` stays on), and at run time `proc_macro::is_available()` is true inside `expand`. So the guest's syn/quote use the real bridge, as natively.

### Guest ABI details

- **Reactor:** rustc links no crt1 object into a wasm cdylib. Without an `_initialize`, wasm-ld treats the module as a command and wraps *every* export in `__wasm_call_ctors`/`__wasm_call_dtors`, including `cabi_realloc` while the host is inside `dispatch`. pm_guest exports `_initialize` (calls the ctors), so the host calls it once.
- **Bridge types:** `Buffer`, `Closure` and `BridgeConfig` are private but `#[repr(C)]` by design (the bridge joins two `proc_macro` copies from different compilers). pm_guest and pm_host mirror them as in 1.99.1 `library/proc_macro/src/bridge/{buffer,closure,mod}.rs`, and `Client` is `repr(C) { run: extern "C" fn(BridgeConfig) -> Buffer }`. **They must be re-checked on every toolchain bump (WP-37).** The rpc layer pads `usize` to 8 bytes on 32-bit targets (rpc.rs), so a 64-bit server and a wasm32 client agree on the wire.
- **`expand`:** pm_guest calls the macro's `Client.run` with a `BridgeConfig` whose input is the host's bytes and whose `dispatch` closure calls the import. Each round trip allocates nothing. During `dispatch`, `cabi_realloc` lends the request's own buffer for the reply when it fits, and the client keeps the buffer it gets back. This stays within the canonical ABI.
- **Panics:** the wasm32-wasip1 std is `panic=abort`, so a panicking macro traps. The host turns the trap into a compile error, "the Wasm proc macro trapped", with the guest's stderr. serde_derive reports its errors with `compile_error!`, not with panics.
- **Environment:** the guest's WASI env is empty. `proc_macro::tracked::env_var` asks the server (`injected_env_var`), which answers from the compiler's process. Plain `std::env::var` in a macro sees nothing.

## Host side (prototype)

`pm_host::expand(path, kind, name, input)` loads the guest once per process. The module is compiled by Cranelift once (465 ms for serde_derive) and cached next to the `.wasm` as `<name>.<hash>.cwasm`. Loading it from there plus instantiating takes ~4 ms. Then it runs the macro against a bridge server:

- **Driving the bridge:** `proc_macro::bridge::server::ExecutionStrategy` is public (its comment even mentions "wasm proc-macros"), but it can't be implemented outside `proc_macro`, because its signature names the private `Buffer`. So pm_host calls `Client::run1` with the stock `SAME_THREAD` strategy, on a `Client` whose `run` is pm_host's `extern "C"` trampoline (transmuted from the fn pointer). The strategy builds the real `BridgeConfig` (encoded input, closure over its `Dispatcher`) and calls the trampoline, which forwards both to the guest. One buffer goes back and forth for all requests of an expansion.
- **The server (`proxy.rs`):** a full `bridge::server::Server` implemented on the **public** `proc_macro` API, used *inside* a native proc macro (`pm-shim-serde`). Native rustc runs the shim, the shim's Proxy serves the guest, and every guest request becomes public-API calls that go to native rustc over its own bridge. Token streams pass through as they are, so the output tokens are rustc's. Approximations (only spans, not tokens): span handles aren't deduplicated (the public `Span` has no `Hash`); a group the guest builds gets one span for delimiters and whole (as `Group::set_span`); `span_subspan` is `None`. Literals become native via constructors for plain strings and decimal integers, and via `Literal::from_str` otherwise (a classifier, unit-tested, splits text into kind/symbol/suffix).

This proxy is a test harness, not the product. In rustc.wasm (WP-20) the server is rustc's own (`rustc_expand`'s), so the proxy's decode → public API → re-encode hop (~340 µs per serde derive) disappears.

## For WP-20 (proc macros inside rustc.wasm)

- **Loading needs a rustc change.** `rustc_metadata::host_dylib::dlsym_proc_macros(path)` dlopens; on our wasm host that's guarded off (A2). There is no driver callback for it. A wasm path needs code there: given a `.wasm` proc-macro artifact, ask the JS host to instantiate it, and return `&'static [Client]` whose `run` fns are trampolines in rustc.wasm. Each trampoline calls a host import `expand(instance, index, input)` and exports a `dispatch` entry the host calls back with the guest's requests (rustc's real `Dispatcher` via the closure in `BridgeConfig`). `Client` carries no data, so the trampolines need the macro index from elsewhere (a table of N fns, or TLS set before `run`). **Per the rustc policy, the user writes this, or applies an existing human-written patch.** pm_guest/pm_host show the protocol works and what the code has to do.
- **The ABI stays:** the guest side (pm_guest, the rewrite) is final as far as this prototype can tell. The browser host only copies bytes between two instances' memories, synchronously, in the same worker (or a second worker with JSPI, the strict mode).
- **Building guests in the browser:** the rewrite must run there too (pm-rewrite is plain Rust + syn and builds for wasm32-wasip1), and the planner must emit the guest unit: `--crate-type cdylib --extern proc_macro`, `RUSTC_BOOTSTRAP=pm_guest` for the pm_guest unit, LTO optional. The release's sysroot has `libproc_macro` for wasm32-wasip1.
- **Cache:** guest `.wasm` files are ordinary units for WP-18's cache. The `.cwasm` equivalent in the browser is `WebAssembly.Module` caching (IndexedDB or Cache Storage).
