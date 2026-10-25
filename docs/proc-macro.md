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

# WP-20: proc macros inside rustc.wasm

*2026-10-25. Status: done. `scripts/verify/wp-20.sh` passes.*

**Result:** `cargo build` of `tests/planner/cases/derive` (serde with `derive`, serde_json, thiserror; 28 units, including proc-macro2's host-side build script) works in Chromium. The program prints what the native build prints. Cold build: ~20 s on 4 workers; serde_derive's own compile takes ~6 s.

## How it fits together

| Layer | What | Who |
|---|---|---|
| rustc (`build/rust`, uncommitted working-tree changes) | rust-lang/rust#160981 by bjorn3 (merged upstream after 1.99): the `proc-macro` crate type for the wasm proc-macro target and the fallback lookup of proc macros for it, behind `-Zwasm-proc-macros`; its tuple set to `wasm32-wasip1` (as bjorn3's draft #157709 does). A registered loader for `.wasm` proc macros in `rustc_metadata::host_dylib` (`register_wasm_proc_macro_loader`). | the user (#160981 applied from `toolchain/patches/rust/available/`; the loader written by the user) |
| `toolchain/rustc-multi/pm.rs` | Turns `wasm_proc_macros` on in the driver's config (no `-Z`, no RUSTC_BOOTSTRAP). The registered loader: asks the JS host for a module's macro count, hands out const-generic **slot** trampolines (`slot::<N>`, 512 per process; `SLOTS[N]` = module path, version, macro index), cached per (path, content version). A slot copies the bridge input into a scratch buffer and calls `rust_pm.expand`; the host calls back through **rustc's function table** (exported by a link argument; exported functions of a command module would re-run constructors) into `host_call`, which reserves scratch space or sends a request through the `BridgeConfig`'s dispatch closure, i.e. rustc's own proc-macro server. A failure becomes `Err(PanicMessage::String(..))` on the wire. | Claude |
| `web/wasi/proc-macro.ts` | The `rust_pm` imports, per rustc thread worker: reads the module from the VFS, compiles it synchronously (cached by FNV hash), instantiates it with minimal WASI, and drives its stock proc_macro client exactly like `crates/pm-bridge/host/src/raw.rs` (BridgeConfig built in guest memory, `Client.run` through the guest's table, host `reserve`/`drop`/`dispatch` placed in the guest's table through a tiny hand-assembled helper module, since a funcref table only takes wasm functions). Everything is synchronous: rustc sits in the import call while the macro runs and is re-entered for each request. A trapped instance is dropped and recreated on next use. | Claude |
| Planner (`crates/resolver/src/plan`) | Proc-macro units as cargo builds them (golden case `derive`: identical): `--crate-type proc-macro --emit=dep-info,link -C prefer-dynamic`, dependencies as rlibs, `--extern proc_macro`, output `<dll_prefix><name>-<hash><dll_suffix>` (`.wasm` on wasm32-wasip1), consumers `--extern name=<that file>`. Plus `PlanInput.proc_macro_args` (browser only, `web/build/cargo.ts`): `crt1-reactor.o` (rustc links no crt into this crate type), `--export=_initialize`, `--export-table`, `--growable-table`, `--export=malloc,free,realloc`, `-C save-temps` (the module links rustc's metadata object from a temp dir; the orchestrator links after rustc returned). `-C prefer-dynamic` is harmless on wasm (std links statically). | Claude |
| wasmtime | The wasmtime CLI gives a spawned thread a linker without `--preload` modules or unknown-import stubs, so a rustc with `rust_pm` imports can't run its compile threads there. `build-rustc-multi.sh` therefore also builds `rustc-multi-wasmtime.wasm` from the same source with `--cfg rust_pm_stub` (pm.rs left out); the release ships it as `rustcWasmtime` and `tools/prebuild` uses it. Crates that use Wasm proc macros can't be prebuilt yet. WP-18's bit-identical browser/wasmtime check still covers both binaries' outputs. | Claude |

## Files and checks

- Driver: `toolchain/rustc-multi/main.rs` (config, `pm::register`), `pm.rs`, `pm_slots.rs` (the 512 slot functions, generated; regenerate for more), built by `toolchain/build-rustc-multi.sh` (both variants); `toolchain/release.sh` ships both.
- Host: `web/wasi/proc-macro.ts`, hooked into each rustc thread worker by `web/wasi/process-worker.ts` (only for modules that import `rust_pm`).
- Planner: `crates/resolver/src/plan/mod.rs`, `cfg.rs` (`docs/planner.md`, "Proc macros"); `web/build/cargo.ts` (`PROC_MACRO_ARGS`).
- Groundwork before the rustc changes: `crates/pm-bridge/host/src/raw.rs` (drives a stock proc-macro module under wasmtime) with `pm-rewrite --raw` / `scripts/build-pm-guest.sh --raw`; `docs/wp20-rustc-changes.md` (the spec for the rustc side, and how it was verified).
- Checks: `scripts/verify/wp-20-crate-type.sh` (rustc.wasm builds a proc-macro crate for wasm32-wasip1 with readable proc_macro_data; `tests/proc-macro/hello_pm.rs`), golden case `tests/planner/cases/derive`, `tests/e2e/proc-macro.spec.ts` (cold build + run, then reload + edit with the macro modules from L1); all run by `scripts/verify/wp-20.sh`.

## Notes

- The guest needs no glue: the module is exactly what rustc emits for the crate type plus link arguments, and its `proc_macro` is rustup's stock wasm32-wasip1 one.
- A 2018-edition `use macro_crate::…` hides loader errors behind E0463 (`creader.rs` `maybe_process_path_extern` discards them); `extern crate` shows them.
- Not done yet: proc macros in L2/prebuild (wasmtime needs a host for them: a Node host, or wasmtime's API instead of its CLI), a browser cache of compiled macro modules across page loads (`WebAssembly.Module` in IndexedDB), and a strict mode with macros in a separate worker.
