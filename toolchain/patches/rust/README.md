# rustc source changes for the wasm32-wasip1-threads host

`wasm-host.diff`: written by the project owner (Anselm Benedikt Schaefer), not by an AI. rust-lang's
agent policy (`build/rust/AGENTS.md`) does not allow AI-authored changes to rustc without a named
reviewer; see `~/Projects/rustc-wasm-host-source-changes.md`.

- A1: `rustc_driver` also builds as `lib` (no dylibs on Wasm).
- A2: code that uses `libloading` (`rustc_metadata/src/host_dylib.rs`,
  `rustc_codegen_llvm/src/llvm/{offload_ffi,enzyme_ffi}.rs`) only on unix/windows; elsewhere the
  loading functions return an error.

`bjorn3-get-linker-path.diff`: written by bjorn3, taken unchanged from his `compile_rustc_for_wasm20`
branch (commit 1a0d591a9c, `[WIP] Support compiling rustc to WebAssembly`; fetched by
`scripts/fetch-patch-sources.sh`). Applied by the project owner on 2026-10-24.

- B: `get_linker` sets the linker's `PATH` only on non-wasm hosts. On WASI, std's `env::join_paths`
  is unsupported (always `Err`), and the `unwrap()` panicked before any link command was built.

Apply both as **uncommitted** working-tree changes (`git -C build/rust apply toolchain/patches/rust/{wasm-host,bjorn3-get-linker-path}.diff`),
so `build/rust` HEAD stays at the 1.99.1 release commit and the compiler's version string matches
stable exactly (see `toolchain/build-rustc.sh`).
