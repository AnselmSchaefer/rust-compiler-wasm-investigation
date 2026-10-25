# WP-20: the rustc changes (spec for the user)

*2026-10-25. Under the rustc policy (`build/rust/AGENTS.md`), the user writes these changes. This file says what they must do, where, and how they will be tested. It contains no code for the rust tree. Everything else in WP-20 (the loader behind the hook, trampolines, the JS host, the planner, the cache) is Claude's, outside `build/rust`.*

## The plan in one paragraph

rustc.wasm compiles a proc-macro crate for wasm like any other proc-macro crate (change 1). The output is a wasm module with the usual decls static exported and the crate's metadata in a `.rustc` section. When a crate uses the macro, rustc.wasm finds that module (change 3), reads the metadata as for any proc-macro dylib, and asks a loader that the driver (`rustc-multi`) registered for the `&'static [Client]` table instead of `dlopen` (change 2). Each `Client` there is one of the driver's trampolines. Its `run` hands the bridge buffers to the JS host, which runs the macro module synchronously and calls back into rustc for every bridge request. Metadata ordering, `SyntaxExtension` registration and `rustc_expand` stay as they are.

## Change 1: allow the `proc-macro` crate type on wasm targets

- **Where:** `compiler/rustc_session/src/output.rs`, `invalid_output_for_target` (line ~131). It returns "invalid" for `ProcMacro` when the target is `only_cdylib`, which all wasm targets are (`rustc_target/src/spec/base/wasm.rs:53`).
- **What:** `ProcMacro` is no longer invalid on wasm targets (`is_like_wasm`). Keep `Dylib` invalid there. Whether to gate it (on wasm targets only, or also behind a `-Z` flag) is your choice. The tests only need it for `wasm32-wasip1` (and `wasm32-wasip1-threads` if you pick option 3a below).
- **Size:** a few lines.
- **Expected effect, which the tests check:** `rustc --crate-type proc-macro --target wasm32-wasip1` produces a wasm module (named like a dylib for the target) that
  - exports the decls static `__rustc_proc_macro_decls_<stable crate id>__` as an i32 global (the address of the `&[Client]`),
  - contains the crate's metadata in a custom section `.rustc`. `create_compressed_metadata_file` already handles wasm (`rustc_codegen_ssa/src/back/metadata.rs:584`), and reading uses the same section search as rlibs on wasm.
- **Not needed in rustc:** `_initialize`, the function table, `malloc`/`free`/`realloc`. The planner passes those as link arguments (`crt1-reactor.o` from the self-contained sysroot, `--export=_initialize`, `--export-table`, `--growable-table`, `--export=malloc,free,realloc`). Claude has checked that a module built this way works (below).
- **Possible follow-up:** if the link step for this crate type on wasm misses something (for example the decls export), the fix is in `rustc_codegen_ssa/src/back/linker.rs` (`WasmLd`) or in the exported-symbols logic. The first build will show it.

## Change 2: a registration point for proc-macro loading on a wasm host

- **Where:** `compiler/rustc_metadata/src/host_dylib.rs`, `dlsym_proc_macros` (line ~141), next to your existing A2 change (the `cfg(not(any(unix, windows)))` stub of `load_symbol_from_dylib`). Re-exported from `compiler/rustc_metadata/src/lib.rs`, as `DylibError` and `load_symbol_from_dylib` already are (line 29).
- **What:**
  - On a wasm host (`target_family = "wasm"`), `rustc_metadata` offers a public, settable-once loader: a function of type `fn(&Path, &str) -> Result<&'static [Client], String>`. Here `Client` is `rustc_proc_macro::bridge::client::Client`, the type `dlsym_proc_macros` already returns, and the `&str` is the decls symbol name it already computes with `generate_proc_macro_decls_symbol`.
  - If a loader is registered, `dlsym_proc_macros` calls it with the path and the symbol name. `Ok(table)` is returned as is, and `Err(message)` becomes the `DylibError::DlOpen(path, message)` the callers already handle.
  - If none is registered, behaviour stays as today: the "not supported on this platform" error.
- **Why a registered function and not an `extern` symbol:** bootstrap also links its own `rustc-main` binary for the wasm host, and an undefined symbol would break that link. A static that the driver fills in before running the compiler needs no link tricks and no `unsafe`.
- **Size:** about 15–25 lines. It's safe code (a `OnceLock` or similar).
- **Who calls it:** `rustc-multi` (Claude's) registers its loader at startup. The loader allocates the trampolines and asks the JS host to load the module.

## Change 3: which target a proc macro must be built for, on a wasm host

rustc loads proc macros as *host* crates. `CrateLocator::for_proc_macro` (`compiler/rustc_metadata/src/locator.rs:347`) sets the tuple to `config::host_tuple()`, which is `wasm32-wasip1-threads` for rustc.wasm, and a crate whose recorded target differs is rejected. We build for `wasm32-wasip1`. Two options:

- **3a: no rustc change.** Build proc macros for `wasm32-wasip1-threads`. Costs: the release ships a second std (rustup's `wasm32-wasip1-threads`, roughly the size of the current sysroot: ~25 MB brotli, loaded only for projects with proc macros). Each macro module then imports a shared memory, which the host must create.
- **3b: a small locator change** (recommended): on a wasm host, look proc macros up as **target** crates. `creader.rs` `load_proc_macro` (line ~671) calls `for_proc_macro` in its non-`dual_proc_macros` branch, and on a wasm host it would call `for_target_proc_macro` (`locator.rs:355`) instead. That's correct for us because on a wasm host a proc macro isn't host code that gets `dlopen`ed: it's a module the registered loader runs, built for the same wasm target as everything else. A few lines.

## Total

Changes 1 + 2 + 3b come to roughly **30–50 lines** in 3–4 files. That's about the size of A1/A2 (45 inserted lines). The work and risk are in rebuild time (`rustc_session` is near the bottom of the crate graph, so it's nearly a full compiler rebuild) and in whether the link step needs a follow-up (change 1).

## What Claude has checked already (no rustc change)

`crates/pm-bridge`, `scripts/build-pm-guest.sh --raw`. serde_derive is built as a wasm module that contains **only** what rustc would emit for a proc-macro crate (the harness's `&[Client]` decls static, exported) plus the link arguments above. No pm_guest, no glue. pm_host's raw mode (`crates/pm-bridge/host/src/raw.rs`) drives the stock `proc_macro` client directly:

- It reads the decls slice from guest memory.
- It adds its `reserve`, `drop` and `dispatch` functions to the guest's function table.
- It builds the `BridgeConfig` in guest memory and calls `Client.run` through the table (wasm32 C ABI: structs by pointer, struct results through a return pointer).

Result on the WP-19 demo: `-Zunpretty=expanded` is byte-identical to native serde_derive, `,hygiene` is identical up to symbol numbers, and the output is the same. It runs at the same speed as the pm_guest module (2.15× per call vs native on this run; ~1.7× estimated without the prototype's proxy server).

## How the changes will be tested (step 3)

1. **Build:** `toolchain/build-rustc.sh` with the changes (long, in the background), then `toolchain/release.sh`.
2. **Change 1, under wasmtime:** the new rustc.wasm compiles serde_derive with `--crate-type proc-macro --target wasm32-wasip1` and the planner's link arguments. The module must export the decls global, `_initialize`, the table and the allocator, and have a `.rustc` section. pm_host's raw mode, given that module (the macro list taken from its metadata order), must reproduce the byte-identical demo expansion.
3. **Changes 2 + 3, in Chromium:** `cargo build` of a crate with `#[derive(Serialize, Deserialize)]` in the browser. rustc.wasm finds the macro (change 3), asks the driver's loader (change 2), and expansions go through the JS host. The program must print the same as the native build. A second macro crate (thiserror) is WP-20's done-when.
