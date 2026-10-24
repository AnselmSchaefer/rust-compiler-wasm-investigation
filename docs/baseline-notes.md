# Baseline notes (WP-01)

Reproduction of the existing prebuilt toolchain **oligamiq/rust_wasm v3.0.0-release** (rustc 1.83.0-dev, LLVM + lld linked in).
Measured 2026-10-24 on the dev machine (15 GB RAM, Linux). Reproduce with `scripts/verify/wp-01.sh`. Full benchmark numbers are in `bench/baseline.md`.

## What was used
| Item | Source | Size (raw / brotli) |
|---|---|---|
| `rustc_opt.wasm` (panic=abort host) | release asset `rustc_opt.wasm.br` | 95.4 MB / 19.8 MB |
| `rustc_unwind_opt.wasm` (panic=unwind host) | `rustc_unwind_opt.wasm.br` | 101.5 MB / 20.5 MB |
| `llvm_opt.wasm` (clang/llvm multicall, YoWASP) | `llvm_opt.wasm.br` | 98.0 MB / 20.8 MB (not needed for hello) |
| `wasm32-wasip1` sysroot | `wasm32-wasip1.tar.br` | 71 MB / 18.9 MB (libcore.rlib alone is 32 MB) |
| WASI shim | npm `@bjorn3/browser_wasi_shim@0.4.2` + `@oligami/browser_wasi_shim-threads@0.5.0` | |

Module shape: imports `wasi_snapshot_preview1.*`, `wasi.thread-spawn`, and `env.memory` (shared, min 399 / max 16384 pages = 1 GiB cap). Exports `_start`, `wasi_thread_start`.

## Results: hello world (`fn main() { println!(..) }`, `--target wasm32-wasip1`, debug)
| Host | rustc compile+link | Notes |
|---|---|---|
| native nightly rustc (x86_64) | 0.16 s | reference |
| wasmtime 46.0.3 (`wasmtime-threads`), `rustc_opt` | 0.85 s warm (19 s first run: Cranelift compile, then cached) | ~5× native |
| Chromium (Playwright 1.64.1), `rustc_opt` | 1.25–1.47 s run + 0.2 s module compile | sysroot load 0.22 s (localhost) |
| Firefox (Playwright 1.64.1), `rustc_opt` | 0.59–0.78 s run + 0.65–0.80 s module compile | sysroot load 0.42 s |
| Chromium, `rustc_unwind_opt` | 1.28 s run | works |
| Firefox, `rustc_unwind_opt` | 0.83 s run | works, warns about legacy EH |

Full end-to-end (sysroot fetch → compile → run output) is 1.7–2.1 s in both browsers with assets on localhost. rustc spawns 4–5 threads (workers) for the compile.
Firefox runs rustc itself faster but compiles the module more slowly; Chromium probably starts on Liftoff code. WP-02 measures this properly.

## Problems found
1. **Any rustc error kills the instance (abort build).** A type error prints correct diagnostics, then traps with `unreachable` (exit 134) instead of exiting with code 1. Even `rustc -- --version` traps. So after every failed compile, `rustc_opt.wasm` has to be re-instantiated. → WP-07 (unwind host, catch at driver).
2. **The unwind build uses legacy Wasm EH (`try`/`catch`), not exnref (`try_table`).** Firefox logs a deprecation warning. wasmtime 46 refuses to compile it ("WebAssembly translation error", even with `-W exceptions=y`), so it can only be tested in browsers. → our build (WP-07) must use the exnref encoding (LLVM's non-legacy Wasm EH mode).
3. **Temp dir location is hard-wired to `/`.** rustc creates `/rustcXXXXXX` and fails with "couldn't create a temp dir" if `/` is not a writable preopen. It ignores `TMPDIR` and the output dir. Workaround: preopen the work dir as `/`. → WP-05 sysroot/env patch.
4. **Leftovers after a successful build.** `*.rcgu.o` files and `rustcXXXXXX` temp dirs stay in the work dir (cleanup fails silently on WASI). Harmless now, but a VFS (WP-11) would accumulate garbage.
5. **The linker command line goes to stdout.** In-process `rust-lld` prints `Linking using ... "rust-lld" "-flavor" "wasm" ...` on every build. It's debug output from the fork and would need filtering in the UI.
6. **Shim: shared memory too small by default.** `browser_wasi_shim-threads` creates a 256-page shared memory; rustc needs ≥ 399, so instantiation fails with the opaque `worker request failed: WasmInstantiation`. Fix: pass `share_memory` sized from the module's import (400/16384).
7. **Shim: reads go through a fixed bounce buffer.** The farm's default `allocator_size` is 10 MB; reading the 32 MB libcore.rlib throws "size is bigger than memory". We used 128 MB. Every file read is copied page FS → SAB → Wasm memory. That's a design cost to avoid in our VFS (WP-11): map rlibs straight into the guest or use lazy metadata (WP-08).
8. **Shim: stdin must be provided** to `WASIFarm`, or the animal throws "stdin is not found".
9. **Firefox works** with the threads shim (the shim README says the demo failed on Firefox; that's out of date as of Firefox in Playwright 1.64.1). Warnings `notify number is 0. ref is late?` / `invoke_func_loop is late` appear but are harmless.
10. **Memory cap 1 GiB.** The module declares max 16384 pages. Larger crates may hit this (PLAN §7 risk trigger at 4 GB applies to our own build).
11. **Shim: `path_rename` within one directory fd is a no-op** (found in WP-02). This broke `--emit=metadata` and every library build ("failed to create encoded metadata from file"). Patched via `pnpm patch` (`patches/`).
12. **Old compiler.** 1.83.0-dev (2024). Fine as a baseline only. Edition 2024 and newer std APIs are unavailable.

## Harness layout
- `scripts/fetch-baseline.sh`: downloads and unpacks into `build/vendor/rust_wasm-v3/`, re-roots the flat sysroot tarball to `sysroot/lib/rustlib/wasm32-wasip1/lib/`, and writes `sysroot.json` (file list for the browser).
- `tests/e2e/baseline/`: `main.ts` (page: WASIFarm owning an in-memory FS, runs the output with plain `WASI`), `rustc-worker.ts` (WASIFarmAnimal + `block_start_on_thread`), `thread-spawn.ts`. `?rustc=rustc_unwind_opt.wasm` switches builds.
- `scripts/build-baseline.mjs`: esbuild bundle into `build/www/baseline/`. `scripts/serve.mjs` now takes extra mounts (`/www=build/www /vendor=build/vendor`).
