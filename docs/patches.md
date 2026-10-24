# Patch inventory: rustc + LLVM as a Wasm host (WP-03)

*2026-10-24. Sources are fetched at pinned commits by `scripts/fetch-patch-sources.sh` into `build/wp-03/src/`.*

We need **one small, documented series** that turns rustc **1.99.1** (LLVM 23.1) into a `wasm32-wasip1-threads` module, with LLVM + lld linked in, that compiles user code to `wasm32-wasip1`. This file lists every concern, what each existing project did about it, and what we'll do.

## Sources reviewed

| Key | Source | Base | Target host | Size (excl. Cargo.lock) |
|---|---|---|---|---|
| **B** | [bjorn3/rust `compile_rustc_for_wasm20`](https://github.com/bjorn3/rust/tree/compile_rustc_for_wasm20): 3 commits (1a0d591a9c, a8da5c9fe0, 3b6974e6ee) | rust-lang/rust e6b64a2f4c (2026-04-02) | `wasm32-wasip1`, **Cranelift** backend, no threads, output x86_64 | +177/−78, wild linker +474/−27, bootstrap +3 |
| **O** | [oligamiq/rust `compile_rustc_for_wasm17` @ cf327c2068](https://github.com/oligamiq/rust/tree/compile_rustc_for_wasm17): 6 commits. This is the build behind rust_wasm v3, our WP-01/02 baseline | rust-lang/rust 39cb3386dd (2024-11-27, 1.83-dev) | `wasm32-wasip1-threads`, **LLVM** + in-process lld | +159/−36 (B's older base patch), LLVM build +269/−10, lld +43/−2, target +11/−8, bootstrap +3 |
| **Y** | [YoWASP/llvm-project](https://github.com/YoWASP/llvm-project) "Conditionalize use of POSIX features missing on WASI/WebAssembly" (69bd8547e9 on LLVM main 2024-07; rebased as 97196c8eeb on `llvmorg-22.1.0`) | LLVM 22.1.0 | WASI | 18–23 files, +159/−22. **Not upstream** (LLVM main has no `__wasi__` guards in those files as of 2026-10) |
| **D** | [danlapid/rust-playground `toolchain/rustc-patches` @ 2e3887adc6](https://github.com/danlapid/rust-playground/tree/main/toolchain/rustc-patches): 7 patches (the Cloudflare playground) | **rust 1.98.1** | `wasm32-unknown-emscripten`, no threads, LLVM + in-process wasm-ld | 0001 +118/−27, 0002 +80/−2, 0003 +9/−1, 0004 +3/−1, 0005 +8/−1, 0006 +142, 0007 +362/−74 |

D is by far the most current and the cleanest: each patch has one concern, a commit message explaining it, and errors are returned instead of calling `exit`. Most of D's patches are already gated on `target_family = "wasm"` or on a runtime switch, not on Emscripten, so they port to a WASI host with small cfg changes. **D is the primary base for our series**, with O/B covering the WASI- and LLVM-host-specific parts.

## Concerns

Decision legend: **keep** = apply nearly as-is · **rewrite** = same idea, our own code or cfgs · **config** = solved by build configuration, no source patch · **drop** = not needed for our design.

| # | Concern | B (bjorn3) | O (oligamiq) | D (danlapid) | Decision | Lands in |
|---|---|---|---|---|---|---|
| 1 | **Threads**: compiler thread, codegen coordinator, work items, jobserver helper | Runs on main thread (comments out `spawn_scoped`); jobserver helper disabled on `wasi`; cg_clif threads made sync | Same as B (older) | 0001: `sync::no_threads()` = `wasm && !atomics` **or `RUSTC_NO_THREADS`**; deferred coordinator (`MaybeThread`), inline work items, no jobserver helper | **keep D-0001** (on `wasip1-threads` it's off by default, so we keep real threads; the env switch is a tested fallback and a benchmark knob). **rewrite** B's jobserver change as part of it: the helper thread must also be skipped on WASI with threads if the `jobserver` crate can't run one there (verify in WP-05) | WP-05 |
| 2 | **Codegen backend loading** (no dlopen) | Statically links cg_clif via a `cranelift` feature | Uses built-in `llvm` (already static upstream) | Built-in `llvm` | **config**: `codegen-backends = ["llvm"]` is linked statically by default. **drop** B's Cranelift (it can't emit Wasm, and our output target is Wasm) | WP-05 |
| 3 | **rustc_driver as rlib** (no dylibs on Wasm) | `crate-type = ["lib","dylib"]` | same | 0004 same, with a comment | **keep D-0004** | WP-05 |
| 4 | **dlopen of proc macros / backends** must compile on WASI | `creader.rs`: `cfg(any(unix, windows))` on libloading code + stub `load_symbol_from_dylib` returning an error | same | 0006 replaces it with its own Emscripten `dlsym_proc_macros` | **rewrite**: B's stub for WP-05 (so it builds), replaced by the proc-macro bridge in WP-19/20 | WP-05, WP-19 |
| 5 | **Proc macros** | — | — | 0006: proc-macro crate compiled to an object + rmeta; dependents load metadata; the `proc_macro` bridge calls `__rustc_proc_macro_host_*` imports, so the host runs the macro in a separate Wasm module | **rewrite** D-0006 for WASI imports and our bridge design (PROPOSAL §5); the trampoline/slot scheme is the starting point | WP-19, WP-20 |
| 6 | **Linking in-process** | wild (ELF only), `println!` + `exit(0)` | `RustRunLld` via `lld::lldMain`, `println!("Linking using …")` + **`std::process::exit(ret)`** (cause of WP-01 findings #4, #5: leftovers and linker line on stdout) | 0002: `LLVMRustRunLld` captures stdout/stderr into an `Output` and **returns**, so normal error reporting and cleanup work. Only for `WasmLld(Cc::No)` | **keep D-0002**; add the lld static libs + `LLVM_ENABLE_PROJECTS=lld` to our LLVM build (WP-04) | WP-04, WP-06 |
| 7 | **Linker flavor for the output target** | `link_self_contained = False` | `True` (upstream default) + `-Clink-self-contained=no` while building rustc itself | 0003: wasm-ld for Emscripten targets | **drop**: `wasm32-wasip1` already uses `rust-lld`/WasmLld with self-contained crt, which D-0002 intercepts | — |
| 8 | **Sysroot / `current_exe` detection** | `default_sysroot()` returns `"dist"` on WASI | same | 0005: `current_dll_path()` returns `/lib/librustc_driver.so` on Emscripten, so the sysroot is `/` | **rewrite** D-0005 for `target_os = "wasi"`: upstream 1.99.1 has a WASI `current_dll_path` that returns `Err("dll_path is not supported on WASI")`. Return a fixed path instead so `--sysroot` is optional | WP-05 |
| 9 | **Metadata loading (mmap)** | — | — | 0007: `.rmeta` read through `MemDecoder::new_paged` in 16 KiB pages, loaded on demand. Needs metadata in separate `.rmeta` files (`-Zno-embed-metadata`) | **rewrite** D-0007 with `cfg(target_family = "wasm")`. Upstream reads the **whole file into a `Vec`** on wasm32 (`rustc_data_structures::memmap`): libcore.rmeta is **45 MB** in 1.99.1. rustup's 1.99.1 `wasm32-wasip1` std already ships separate `.rmeta` files, so this works with the stock sysroot. WP-02 measured ~350 ms/invocation for this | WP-08 |
| 10 | **Error exit / unwinding**: errors must exit, not trap | panic=abort | panic=abort (+ an `unwind` build with **legacy** EH) | Emscripten `-fwasm-exceptions` (SJLJ as Wasm EH) | **config**: build the host with `panic=unwind` using **exnref** Wasm EH. rustc reports fatal errors by unwinding (`FatalError`), so with panic=abort every compile error aborts (WP-01 #1). The LLVM C++ side uses setjmp/longjmp (`CrashRecoveryContext`), which Y guards on WASI | WP-07 |
| 11 | **LLVM builds for a WASI host** | `download-ci-llvm` (x86 LLVM, n/a) | Y's LLVM fork as submodule + ~180 lines in bootstrap `llvm.rs` (WASI cmake toolchain, `-D_WASI_EMULATED_MMAN`, `-pthread`, tools off) + `rustc_llvm/build.rs` uses wasi clang++, static libc++ | Emscripten build of upstream rust-lang LLVM, **no LLVM source patch**, via `llvm-config` of a separate cmake build | **keep Y** (rebased onto rust-lang/llvm-project `rustc/23.1-2026-07-22`). **rewrite** the build: standalone resumable `toolchain/build-llvm.sh` (YoWASP `build.sh` flags, ninja, sccache, `-j10`, `LLVM_PARALLEL_LINK_JOBS=1`), then point bootstrap at it with `[target.wasm32-wasip1-threads] llvm-config` like D does. That avoids carrying O's bootstrap `llvm.rs` patch | WP-04 |
| 12 | **`rustc_llvm` C++ wrapper for a WASI target** | — | `build.rs`: wasi `clang++`, `-pthread`, `-D_WASI_EMULATED_MMAN`, `c++` stdlib, `LLVM_STATIC_STDCPP=libc++.a` | via emcc config | **rewrite** O's `build.rs` hunk (small) or set `CXX_wasm32_wasip1_threads`/`CXXFLAGS_…` env in bootstrap config. Prefer config | WP-05 |
| 13 | **Host link flags** (memory, stack, mman) | — | `-lwasi-emulated-mman`, `--max-memory=1 GiB` in the *target spec* (affects user programs too!) | Emscripten settings in `emcc-link.sh` | **config**: pass via `[target.wasm32-wasip1-threads] rustflags`/linker args when building rustc only (`-lwasi-emulated-mman`, `--max-memory=4 GiB`, stack size). Never change the target spec user programs see | WP-05 |
| 14 | **Temp dirs and cleanup** | — | — (1.83 created `/rustcXXXX` regardless of output dir: WP-01 #3) | — | **verify only**: 1.99.1 creates link temp dirs next to the output (`tempdir_in(output.parent())`, metadata likewise). Leftovers came from O's `exit()` (#6) | WP-06 |
| 15 | **`std::process::id()` in ICE file path** | `pid = 1` on wasm | same | — | **keep B** (one line) if WASI's `process::id` panics; verify in WP-05 | WP-05 |
| 16 | **`check_file_is_writeable`** | disabled (`return;`) | disabled | — | **verify, probably drop**: only needed if WASI `metadata().permissions()` misbehaves | WP-05 |
| 17 | **`PATH` env for linker command** | skipped on wasm | — | not needed (linker never spawned) | **drop** (D-0002 never spawns) | — |
| 18 | **lld rpath when building lld for host** | `CMAKE_SKIP_RPATH` (bootstrap) | same | — | **drop** with our standalone LLVM build (#11) | — |
| 19 | **crates.io deps needing fixes** | — | — | `libc` (Emscripten consts), `object` (wasm32 `NativeFile`) | **drop** D's (Emscripten-specific). WASI needs are found in WP-05 and get the same `[patch.crates-io]` mechanism | WP-05 |
| 20 | **Version string = stable**, so rustup's std works unchanged | — | ships its own sysroots | `local-rebuild` with stable 1.98.1 as stage0 + `git-commit-info` pinning the stable hash. rustc.wasm then accepts rustup's prebuilt std | **keep (build-script technique)**: we can use rustup's `rust-std-wasm32-wasip1` 1.99.1 (with `.rmeta` files) as the user-program sysroot and skip building std | WP-05, WP-08 |
| 21 | **Max memory of the host** | — | 1 GiB (16384 pages) | Emscripten growth | **config**: 4 GiB wasm32 max (`--max-memory=4294967296`, as Y uses for clang). memory64 later only if the 4 GB risk trigger fires (PLAN §7) | WP-05 |

## Our series (planned)

`toolchain/patches/rust/` (against `1.99.1`):
1. `0001` threads: D-0001 (+ WASI jobserver fix if needed)
2. `0002` in-process wasm-ld: D-0002
3. `0003` rustc_driver rlib: D-0004
4. `0004` WASI host sysroot + misc host fixes: D-0005 rewritten for WASI, B's dlopen stub, optionally the B pid line
5. `0005` paged metadata: D-0007 for `target_family = "wasm"` (WP-08)
6. `0006` proc-macro bridge: from D-0006 (WP-19/20)

`toolchain/patches/llvm/` (against rust-lang/llvm-project `rustc/23.1-2026-07-22` @ 1b9c0d5ff9):
1. `0001` Y's WASI conditionals, rebased from `llvmorg-22.1.0+wasm`

Everything else is build configuration (`bootstrap.toml`, `build-llvm.sh`, link flags) and no source patch. Expected total is about 700 lines of Rust patches (most of them metadata paging and proc macros) plus ~180 lines in LLVM. That's small enough to rebase every 6 weeks (WP-37) and to propose upstream piece by piece (WP-36).

## Alternative kept open: Emscripten host
D shows a full, current (1.98.1) rustc with LLVM as an Emscripten module, with **no LLVM patch** and working proc macros. Our fixed decision (PLAN §1) is the WASI `wasip1-threads` host, because of a smaller JS surface, our own VFS/WASI layer, and native testing. If WP-05 runs past 4 sessions (PLAN §7 risk trigger), switching to D's Emscripten build (with pthreads enabled for Chromium) is the ready fallback, and patches 0001–0006 above would apply almost unchanged.
