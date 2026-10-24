# Status

*Update at the end of every session (see PLAN.md §0).*

## Current
- **Active WP:** WP-02 (in-progress).
- **Current session (2026-10-24, session 4) goals:**
  - Turn the baseline page into a harness API with phases: load, module compile, rustc runs, and running the output.
  - Write `bench/programs/` (hello plus a ~500-line std-only program).
  - Write `bench/run.ts` (`pnpm bench`): Chromium is required, Firefox optional. Add wasmtime and native rustc 1.83 reference numbers. Results go to `bench/results/<date>-<commit>.json`.
  - Write `bench/compare.ts`, `bench/baseline.md` and `scripts/verify/wp-02.sh`.
- **Scope change (user, 2026-10-24):** only Chromium-based browsers must work. Firefox is best-effort.
- **Running background jobs:** none

## Human actions needed
- [x] Plan confirmed; commits at end of each session approved (2026-10-23).
- [x] WP-00: cmake and ninja installed by the user.

## Work packages

| WP | Title | Status | Sessions used | Notes |
|---|---|---|---|---|
| 00 | Repository bootstrap and tooling | done | 1 | `scripts/verify/wp-00.sh` passes. wasi-threads needs wasmtime v46 (`wasmtime-threads`) |
| 01 | Reproduce existing baseline | done | 1 | `scripts/verify/wp-01.sh` passes. Notes in `docs/baseline-notes.md` |
| 02 | Benchmark harness | in-progress | 1 | |
| 03 | Patch inventory and base version | ready | 0 | |
| 04 | Build LLVM for a Wasm host | blocked | 0 | |
| 05 | rustc for a Wasm host: front end | blocked | 0 | |
| 06 | In-process linking | blocked | 0 | |
| 07 | Unwinding build and error recovery | blocked | 0 | |
| 08 | Sysroots and lazy metadata | blocked | 0 | |
| 09 | Compile-server mode | blocked | 0 | |
| 10 | Toolchain release packaging | blocked | 0 | |
| 11 | Virtual filesystem | ready | 0 | |
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
- Smoke: hello world runs on wasip1, wasip2, wasip3 (wasmtime 50) and wasip1-threads with a real thread (wasmtime 46.0.3).

## Session log
- 2026-10-24 (session 3): WP-01. Fetch script, threaded browser harness using browser_wasi_shim-threads, `baseline.spec.ts`, and verify script. Found 11 issues (see `docs/baseline-notes.md`), the main ones being: errors trap the abort build, the unwind build uses legacy EH, and the temp dir is hard-wired to `/`.
- 2026-10-23 (session 2): WP-00. Installed nightly + Wasm targets, pnpm, jco, wasmtime 50 + 46, wasm-tools, sccache, wasi-sdk-34, Playwright. Found wasi-threads removed in wasmtime 47. WebKit can't run on Arch, so it's opt-in.
- 2026-10-23 (session 1): planning only, no code yet.
