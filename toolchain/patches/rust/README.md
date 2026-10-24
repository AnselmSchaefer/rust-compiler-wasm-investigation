# rustc source changes for the wasm32-wasip1-threads host

`wasm-host.diff`: written by the project owner (Anselm Benedikt Schaefer), not by an AI. rust-lang's
agent policy (`build/rust/AGENTS.md`) does not allow AI-authored changes to rustc without a named
reviewer; see `~/Projects/rustc-wasm-host-source-changes.md`.

- A1: `rustc_driver` also builds as `lib` (no dylibs on Wasm).
- A2: code that uses `libloading` (`rustc_metadata/src/host_dylib.rs`,
  `rustc_codegen_llvm/src/llvm/{offload_ffi,enzyme_ffi}.rs`) only on unix/windows; elsewhere the
  loading functions return an error.

Apply as **uncommitted** working-tree changes (`git -C build/rust apply toolchain/patches/rust/wasm-host.diff`),
so `build/rust` HEAD stays at the 1.99.1 release commit and the compiler's version string matches
stable exactly (see `toolchain/build-rustc.sh`).
