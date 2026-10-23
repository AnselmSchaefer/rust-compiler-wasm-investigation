# Decisions log

Fixed defaults (PLAN.md §1), plus decisions and findings recorded during work packages, newest first.

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
| Base rustc version | Chosen in WP-03; rebased every 6 weeks |
| Host glue | TypeScript; Rust → Wasm for VFS, resolver, cache, planner |
| Browser automation | Playwright (Chromium, Firefox; WebKit opt-in) |
