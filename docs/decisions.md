# Decisions log

Fixed defaults (PLAN.md §1), plus decisions and findings recorded during work packages, newest first.

## 2026-10-24 · WP-03: base version and patch strategy (details: docs/patches.md)
- **Base rustc tag: `1.99.1`** (latest stable, released 2026-10-13, commit 58cf8f9c3). Bundled LLVM: rust-lang/llvm-project `rustc/23.1-2026-07-22` @ `1b9c0d5ff9`. wasi-sdk-34 (clang 23.1) matches that LLVM major version.
- **Build rustc as a `local-rebuild` from stable 1.99.1, with the version string pinned to stable's** (danlapid's technique). rustc.wasm then accepts rustup's prebuilt `rust-std-wasm32-wasip1` 1.99.1, which already ships separate `.rmeta` files. We don't build std for user programs.
- **Patch base:** the danlapid/Cloudflare series (rust 1.98.1) is the primary base: one concern per patch, gated on `target_family = "wasm"`/runtime. oligamiq/bjorn3 supply the WASI-host specifics. LLVM carries YoWASP's single WASI patch, rebased to 23.1.
- **LLVM is built standalone** (`toolchain/build-llvm.sh`, YoWASP flags) and bootstrap uses it via `llvm-config`, instead of carrying oligamiq's ~180-line bootstrap `llvm.rs` patch.
- **The host must be `panic=unwind` with exnref EH.** This isn't optional: rustc reports fatal errors by unwinding, so an abort host traps on every compile error.
- **The Emscripten host stays the documented fallback** (danlapid proves 1.98.1 works) if WP-05 trips the PLAN §7 risk trigger.

## 2026-10-24 · WP-02 findings (details: bench/baseline.md)
- Baseline in Chromium: check-hello 447 ms (12× native), build-medium 1.9 s (5.9×), build-medium-O 4.0 s (4.8×). Load is 41.9 MB brotli (3.4 s at 100 Mbit).
- **Most of the cost for small crates is per-invocation sysroot metadata loading** (~350 ms). This confirms the priority of WP-08 (lazy metadata) and WP-09 (compile server).
- **Chromium's first compile after load is up to 2× slower** (tier-up). This goes to WP-28.
- **Browser RSS rises across fresh-instance runs** (0.85 → 2 GiB). WP-12 needs a memory soak test.
- Patched `@oligami/browser_wasi_shim-threads` (`path_rename` no-op bug) with `pnpm patch`. It's a candidate for an upstream report ([H]).
- Benchmarks use native rustc 1.83.0 (installed via rustup) as the same-version reference.

## 2026-10-24 · Scope: Chromium only (user decision)
- Only Chromium-based browsers have to work. Firefox is best-effort: we keep it in tests while it passes for free, but it never blocks a WP. Safari/WebKit are out of scope.
- This lets us depend on Chromium-only or Chromium-first features where they help, e.g. JSPI, memory64, `measureUserAgentSpecificMemory`, and Liftoff/TurboFan tiering controls.

## 2026-10-24 · WP-01 findings (details: docs/baseline-notes.md)
- oligamiq rust_wasm v3 (rustc 1.83-dev) compiles and runs hello in wasmtime-threads, Chromium and Firefox. Browser compile is about 1.5 s; native is 0.16 s.
- **Our host build must use exnref EH.** The oligamiq unwind build uses legacy EH, which wasmtime 46 can't load and Firefox flags as deprecated (affects WP-07).
- **Patch needed: temp dir and cleanup.** rustc puts its temp dir at `/` regardless of `TMPDIR`, and leaves `.rcgu.o` files and temp dirs behind (affects WP-05).
- **Don't reuse `browser_wasi_shim-threads` for WP-11.** It copies every read through a fixed-size SAB bounce buffer (10 MB by default; libcore.rlib is 32 MB) and needs manual memory sizing. It stays only as the baseline harness.

## 2026-10-23 · WP-00 findings
- **wasi-threads removed from wasmtime in v47** ([RFC](https://github.com/bytecodealliance/rfcs/blob/main/accepted/wasmtime-remove-wasi-threads.md)). Current wasmtime (v50) cannot run `wasm32-wasip1-threads` binaries.
  **Decision:** keep wasmtime v50 for wasip1/p2/p3 work, and install **v46.0.3 as `wasmtime-threads`** for native testing of the threaded rustc host (WP-04–WP-10, WP-18 prebuild).
  **Consequence:** this is a dead end long term. By WP-18 at the latest, the native prebuild tool needs its own thread-capable host: Node with our worker-based thread shim (the same code as the browser), or WAMR. Tracked as a risk in PLAN.md §7.
- **Engine probe (Playwright 1.64.1: Chromium and Firefox builds):** cross-origin isolation, SharedArrayBuffer, shared memory, exception handling (exnref), JSPI, memory64 and OPFS all available in **both** engines.
- **WebKit under Playwright does not run on this Arch host** (needs Ubuntu libs libicu74/libflite). WebKit is opt-in via `PW_WEBKIT=1`; Safari stays a manual [H] check.
- Toolchain versions: rustc stable 1.99.1, nightly 1.101.0 (2026-10-22), wasi-sdk-34 (clang 23.1), wasmtime 50.0.0, wasm-tools 1.262.0, jco 1.39.0, sccache 0.18.0, cmake 4.4.4, ninja 1.13.2.

## Fixed defaults (from PLAN.md §1)
| Decision | Choice |
|---|---|
| Editor | CodeMirror 6 |
| Compiler host ABI | `wasm32-wasip1-threads` |
| User program target | `wasm32-wasip1` first, `wasm32-wasip3` components later |
| Hosting | Static CDN, no server-side compiling |
| Base rustc version | **1.99.1** (chosen in WP-03); rebased every 6 weeks |
| Host glue | TypeScript; Rust → Wasm for VFS, resolver, cache, planner |
| Browser automation | Playwright: Chromium required, Firefox best-effort |
