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

## Available, not applied (`available/`)

Existing human-written fixes we know about but don't need yet. The project owner applies them if and
when they're wanted (`git -C build/rust apply "$PWD/toolchain/patches/rust/available/<file>"`, then
move the file up a directory and rebuild with `toolchain/build-rustc.sh`, ~3 min).

- `bjorn3-ice-path-pid.diff`: by bjorn3, unchanged from `compile_rustc_for_wasm20` commit 1a0d591a9c
  (the `rustc_driver_impl/src/lib.rs` hunk). Checked on 2026-10-24: applies cleanly to 1.99.1.
  - Problem: in nightly mode (`RUSTC_BOOTSTRAP=1`, e.g. for `-Z` flags), `ice_path_with_config`
    names the ICE report file with `std::process::id()`, which panics on WASI ("no pids on this
    platform"). This happens inside the panic hook, and the Wasm instance hangs at 0% CPU. Stable
    mode returns before that line.
  - Current workaround: hosts set `RUSTC_ICE=0` (no ICE file) whenever they set `RUSTC_BOOTSTRAP=1`
    (`scripts/verify/wp-07.sh`, `tests/e2e/rustc-host.spec.ts`).
  - The fix uses pid 1 on wasm hosts, so ICE files can be written. Worth applying before anything
    runs rustc.wasm in nightly mode without `RUSTC_ICE=0` (e.g. WP-09's compile server, if it uses
    `-Z` flags).

## available/bjorn3-160981-wasm-proc-macro-locating.diff (WP-20)

rust-lang/rust#160981 "Partially support building and locating wasm proc-macros" by bjorn3,
merged upstream 2026-08-21 (after 1.99), human-written (no AI trailers). Unmodified `gh pr diff`.
It allows `--crate-type proc-macro` on the wasm proc-macro target behind `-Zwasm-proc-macros`
(rustc_session/output.rs) and, when the host lookup of a proc macro fails, looks it up for that
target (creader.rs, locator.rs, session.rs), plus `--print wasm-proc-macro-tuple`. It covers
changes 1 and 3 of docs/wp20-rustc-changes.md. Applies cleanly to an unmodified 1.99.1 tree
(checked with `git apply --check --cached`); it conflicts with a hand-made change 1 in output.rs.
Upstream hardcodes the tuple `wasm32-wasip2`; we build for `wasm32-wasip1`, as bjorn3's draft
rust-lang/rust#157709 does (one string in `build_session`, compiler/rustc_session/src/session.rs).
Apply (the user):

    git -C build/rust checkout compiler/rustc_session/src/output.rs   # drop the hand-made change 1
    git -C build/rust apply ../../toolchain/patches/rust/available/bjorn3-160981-wasm-proc-macro-locating.diff
    # then in compiler/rustc_session/src/session.rs: "wasm32-wasip2" → "wasm32-wasip1"
