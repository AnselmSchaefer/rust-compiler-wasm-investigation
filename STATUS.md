# Status

*Update at the end of every session (see PLAN.md §0).*

## Current
- **Active WP:** WP-04 (in-progress, LLVM build running) and **WP-11** in parallel (PLAN allows this while Phase B waits on builds).
- **Current session (2026-10-24, session 6) goals:**
  - Sparse-fetch rust-lang/llvm-project @ 1b9c0d5ff9 and rebase the YoWASP WASI patch onto it (`toolchain/patches/llvm/0001`).
  - Write `toolchain/build-llvm.sh` (resumable: native tblgen, then a wasm32-wasip1-threads cross build with lld).
  - Run the build in the background (≤ 2 h chunks), smoke-test llc.wasm and wasm-ld.wasm, record sizes, write `scripts/verify/wp-04.sh`.
- **Last session:** 2026-10-24 (session 5). WP-03 done: `docs/patches.md` (21 concerns, planned series), base tag **1.99.1** recorded in `docs/decisions.md`.
- **Scope (user, 2026-10-24):** only Chromium-based browsers must work. Firefox is best-effort, Safari is out of scope.
- **Next step:** WP-04.
  1. Sparse-fetch rust-lang/llvm-project @ `1b9c0d5ff9` (`llvm lld cmake third-party`) into `build/llvm-project`.
  2. Rebase YoWASP `97196c8eeb` (fetched by `scripts/fetch-patch-sources.sh`) onto it and save it as `toolchain/patches/llvm/0001-*.patch`.
  3. Write a resumable `toolchain/build-llvm.sh`: native tblgen, then a wasm32-wasip1-threads build with wasi-sdk-34, YoWASP flags, lld, ninja, sccache, `-j10`, `LLVM_PARALLEL_LINK_JOBS=1`. Run it in the background (≤ 2 h chunks) with logs in `build-logs/wp-04/`.
- **Running background jobs:** LLVM wasm build (`ninja -C build/llvm-wasm -k 0`), log `build-logs/wp-04/build-2.log`. Resume with `toolchain/build-llvm.sh build install`.

## Human actions needed
- [x] Plan confirmed; commits at end of each session approved (2026-10-23).
- [x] WP-00: cmake and ninja installed by the user.
- [ ] Optional [H]: approve reporting the `path_rename` no-op bug upstream to bjorn3/browser_wasi_shim (threads). The fix is in `patches/`.

## Work packages

| WP | Title | Status | Sessions used | Notes |
|---|---|---|---|---|
| 00 | Repository bootstrap and tooling | done | 1 | `scripts/verify/wp-00.sh` passes. wasi-threads needs wasmtime v46 (`wasmtime-threads`) |
| 01 | Reproduce existing baseline | done | 1 | `scripts/verify/wp-01.sh` passes. Notes in `docs/baseline-notes.md` |
| 02 | Benchmark harness | done | 1 | `scripts/verify/wp-02.sh` passes. Numbers in `bench/baseline.md` |
| 03 | Patch inventory and base version | done | 1 | `scripts/verify/wp-03.sh` passes. Base 1.99.1; series in `docs/patches.md` |
| 04 | Build LLVM for a Wasm host | in-progress | 1 | |
| 05 | rustc for a Wasm host: front end | blocked | 0 | |
| 06 | In-process linking | blocked | 0 | |
| 07 | Unwinding build and error recovery | blocked | 0 | |
| 08 | Sysroots and lazy metadata | blocked | 0 | |
| 09 | Compile-server mode | blocked | 0 | |
| 10 | Toolchain release packaging | blocked | 0 | |
| 11 | Virtual filesystem | in-progress | 1 | |
| 12 | Orchestrator and worker pool | blocked | 0 | |
| 13 | Run sandbox | blocked | 0 | |
| 14 | Minimal UI (M1a) | blocked | 0 | |
| 15 | Cargo resolver | blocked | 0 | |
| 16 | Index and crate download | blocked | 0 | |
| 17 | Build planner | blocked | 0 | |
| 18 | Content-addressed cache | blocked | 0 | |
| 19 | Proc-macro bridge prototype | blocked | 0 | |
| 20 | Proc macros inside rustc.wasm | blocked | 0 | |
| 21 | Build scripts | blocked | 0 | |
| 22 | Ecosystem matrix (M1) | blocked | 0 | |
| 23 | rust-analyzer in Wasm | blocked | 0 | |
| 24 | Editor integration | blocked | 0 | |
| 25 | Projects, persistence, offline | blocked | 0 | |
| 26 | Tests, Clippy, rustfmt | blocked | 0 | |
| 27 | Incremental + check-on-idle | blocked | 0 | |
| 28 | First-visit performance | blocked | 0 | |
| 29 | Deploy v1 (M2) | blocked | 0 | |
| 30–35 | v2 features | deferred | 0 | |
| 36 | Upstream proposals | blocked | 0 | |
| 37 | Release-train rebase | blocked | 0 | recurring |

## Measurements
- 2026-10-23 engine probe: Chromium and Firefox (Playwright 1.64.1) both have COI, SAB, shared memory, exnref EH, JSPI, memory64, OPFS.
- 2026-10-24 WP-01 baseline (oligamiq v3, rustc 1.83-dev, hello, wasm32-wasip1, debug). Native: 0.16 s. wasmtime-threads, warm: 0.85 s (19 s on the first run because of Cranelift). Chromium: rustc 1.25–1.47 s, module compile 0.2 s, end-to-end 1.7 s. Firefox: rustc 0.59–0.78 s, module compile 0.65–0.8 s, end-to-end 1.9 s. Unwind build works in both browsers but not in wasmtime 46.
- 2026-10-24 WP-02 baseline (`bench/results/2026-10-24-c029d0d.json`). Chromium 156 medians: check-hello 447 ms (12.1× native), build-hello 1010 ms (6.4×), check-medium 732 ms (5.1×), build-medium 1935 ms (5.9×), build-medium-O 4038 ms (4.8×). First compile after load up to 2× slower. Load: 41.9 MB brotli, 1.15 s on localhost, 3.4 s download at 100 Mbit. Wasm memory 108–360 MiB per step; browser RSS 0.85–2.0 GiB.
- Smoke: hello world runs on wasip1, wasip2, wasip3 (wasmtime 50) and wasip1-threads with a real thread (wasmtime 46.0.3).

## Session log
- 2026-10-24 (session 5): WP-03. Reviewed bjorn3 (wasm20, Cranelift), oligamiq (wasm17, the v3 build), YoWASP LLVM WASI patch (not upstream), and danlapid/Cloudflare (7 patches, rust 1.98.1). Chose danlapid as the primary base and rustc 1.99.1, version-pinned so rustup's std can be reused. Pinned sources are fetched by `scripts/fetch-patch-sources.sh`.
- 2026-10-24 (session 4): WP-02. Turned the baseline page into a harness API. Added `bench/run.ts`/`compare.ts`/`measure.py`, a 563-line benchmark program, native rustc 1.83.0, and browser RSS sampling. Fixed the shim `path_rename` bug (pnpm patch). Scope is now Chromium only.
- 2026-10-24 (session 3): WP-01. Fetch script, threaded browser harness using browser_wasi_shim-threads, `baseline.spec.ts`, and verify script. Found 11 issues (see `docs/baseline-notes.md`), the main ones being: errors trap the abort build, the unwind build uses legacy EH, and the temp dir is hard-wired to `/`.
- 2026-10-23 (session 2): WP-00. Installed nightly + Wasm targets, pnpm, jco, wasmtime 50 + 46, wasm-tools, sccache, wasi-sdk-34, Playwright. Found wasi-threads removed in wasmtime 47. WebKit can't run on Arch, so it's opt-in.
- 2026-10-23 (session 1): planning only, no code yet.
