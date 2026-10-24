# Rebasing the toolchain onto a new rustc release

*Written 2026-10-24 (WP-10) for 1.99.1. The recurring rebase is WP-37 (every 6 weeks).*

The browser toolchain is built from a **stable rustc tag** plus a small set of rust-tree changes, against **the LLVM that tag uses**, and reuses **rustup's prebuilt `wasm32-wasip1` std** for user programs. The pinned versions live in one file, `toolchain/versions.env`.

## Rules that shape the procedure

- **rust-tree changes are human-written** (`build/rust/AGENTS.md`, rust-lang's LLM policy). An agent may re-run builds, check whether patches apply, and explain conflicts. It may not resolve a conflict by editing rustc source. A conflict in `toolchain/patches/rust/*.diff` goes to the project owner. Patches by others (bjorn3, oligamiq) may be re-taken from their newer branches if they exist. LLM-generated patches (danlapid 0005–0007) don't qualify.
- **The rust tree's changes stay uncommitted** (`git apply`, not `git am`). HEAD then stays at the release commit, the version string equals stable's exactly, and rustc.wasm accepts rustup's std (`toolchain/build-rustc.sh` refuses to build otherwise).

## Steps

1. **Pick the tag.** The newest stable `N` that rustup ships with `rust-std-wasm32-wasip1` and `wasm32-wasip1-threads`. Read its LLVM commit: `git -C <rust checkout at N> ls-tree N src/llvm-project`.
2. **Update `toolchain/versions.env`:** `RUST_TAG=N`, `LLVM_SHA=<that commit>` (plus `WASI_SDK_VERSION` if wasi-sdk changes, see step 9).
3. **Fresh checkouts.** Move `build/rust` and `build/llvm-project` aside (don't delete them until the new build verifies). The scripts clone again at the new pins.
4. **LLVM** (`toolchain/build-llvm.sh`, 1–2 h, in the background, resumable). Apply `toolchain/patches/llvm/0001` (the YoWASP WASI port). If it doesn't apply, port it. It's not rust-tree code, so Claude may do this, but check whether YoWASP has rebased it first. Then check `scripts/verify/wp-04.sh`.
5. **rust-tree changes.** In the new `build/rust`: `git apply --check` for each file in `toolchain/patches/rust/` (`wasm-host.diff`, `bjorn3-get-linker-path.diff`, and any from `available/` that were adopted). If one applies, apply it (the owner runs it). If one doesn't, report the conflict to the owner, who updates the diff, and save the new version under the same name. Also re-check whether each change is still needed: upstream may have fixed it. For example, a real WASI `join_paths` in std would make the `get_linker` hunk unnecessary.
6. **Host std and compiler** (`toolchain/build-rustc.sh`, ~30–60 min from scratch). It builds the panic=unwind host std (`toolchain/build-host-std.sh`), the stage-0 toolchain and rustc. New build errors in other crates (`cc`, `libc`, ...) are usually WASI host gaps. Fix them in our wrappers (`toolchain/bin/`), shims (`toolchain/host-shims/`) or bootstrap config, never in the rust tree.
7. **Driver** (`toolchain/build-rustc-multi.sh`, seconds). If `rustc_driver`'s API changed, adapt `toolchain/rustc-multi/main.rs` (ours, outside the rust tree).
8. **Verify, in order:** `scripts/verify/wp-05.sh` (version identical to stable), `wp-06.sh` (linking), `wp-07.sh` (unwinding, errors and ICEs), `wp-08.sh` (sysroot, memory), `wp-09.sh` (server). Compare the numbers with `bench/` and record the new ones.
9. **wasi-sdk** only needs to change if LLVM's minimum does, or if a fix in wasi-libc is needed. A change means rebuilding LLVM too. `toolchain/host-shims/wasi-stat-mode.c` exists because of wasi-libc's `stat`; drop it if wasi-libc starts reporting permission bits.
10. **Release:** `toolchain/release.sh` → `build/release/<N>-<hash>/`, then `scripts/verify/wp-10.sh`.

## Reproducibility (checked 2026-10-24)

Two independent builds of the same inputs, in different directories (`build/rustc-wasm` and `build/rustc-wasm-repro`, via `RUSTC_WASM_OUT`), give:

- **`rustc-multi.wasm` (what we ship as `rustc.wasm`): bit-identical** (sha256 `f501aa64fd28…`, 142,738,119 bytes).
- **`release.sh` output: bit-identical** when both builds are packaged (`build/release` and `build/release-repro`, compared by `scripts/verify/wp-10.sh`). Tars are sorted with mtime 0 and uid/gid 0, and brotli is deterministic.
- **Bootstrap's own stage-1 `rustc.wasm`** (not shipped) differs in 16 bytes: its wasm name section records cargo's output file name `rustc_main-<hash>.wasm`, and that hash differs between the two build directories. The code is identical. `rustc-multi.wasm` is linked with a fixed `-o` name, so it doesn't have this difference.

Not covered: builds on another machine or with other host tools. rustup's toolchain and wasi-sdk are pinned by version; the host clang, cmake and ninja are not. Remap absolute paths if a cross-machine check shows them in the output.

To repeat the check: `RUSTC_WASM_OUT=$PWD/build/rustc-wasm-repro toolchain/build-rustc.sh && RUSTC_WASM_OUT=$PWD/build/rustc-wasm-repro toolchain/build-rustc-multi.sh`, then `RUSTC_WASM_OUT=$PWD/build/rustc-wasm-repro toolchain/release.sh build/release-repro`, then `scripts/verify/wp-10.sh`.
