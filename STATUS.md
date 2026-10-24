# Status

*Update at the end of every session (see PLAN.md §0).*

## Current
- **Active WP:** WP-05 (blocked on A1/A2, which the user writes; see Follow-ups). Preparation that needs no rustc changes is done: `toolchain/build-rustc.sh` (config and build dir outside the checkout), an `llvm-config` for the wasm LLVM, and VFS symlinks for sysroot detection (B1). The first build stops at A1, as expected.
- **Last session:** 2026-10-24 (session 6). WP-04 and WP-11 done. LLVM 23.1.1 + lld for a Wasm host is installed in `build/llvm-wasm-install` (rebuild: `toolchain/build-llvm.sh`, ~1.5 h of compute).
- **Next step:** WP-05.
  1. Bootstrap needs an `llvm-config` describing the *wasm* build, and the cross build doesn't produce one that runs natively. Write a small script `toolchain/llvm-config-wasm` that answers bootstrap's/rustc_llvm's queries (`--version`, `--libs`, `--system-libs`, `--libdir`, `--includedir`, `--cxxflags`, `--ldflags`, `--components`, `--link-static`, `--shared-mode`, `--host-target`) from `build/llvm-wasm-install`, using the native `build/llvm-native` build's answers as a template.
  2. Clone rust 1.99.1 into `build/rust` and apply danlapid patches 0001, 0002, 0004 plus our WASI 0005 rewrite (see `docs/patches.md`).
  3. Write `bootstrap.toml`: `local-rebuild`, stable 1.99.1 as stage0, host `wasm32-wasip1-threads`, `[target.wasm32-wasip1-threads] llvm-config`, `cc`/`cxx` = wasi-sdk clang with `-pthread`.
  4. Run `x build --stage 1 compiler/rustc` under `systemd-inhibit`, in ≤ 2 h chunks.
- **Running background jobs:** none

## Follow-ups (check these at the start of every session)
- [ ] **browser_wasi_shim bug report** (user posting, 2026-10-24): `path_rename` no-op in the threads package. Draft: `~/Projects/browser_wasi_shim-path_rename-issue.md`. Check https://github.com/bjorn3/browser_wasi_shim/issues for a reply. If the fix is released upstream, drop `patches/@oligami__browser_wasi_shim-threads@0.5.0.patch`.
- [ ] **#llm-mentoring Zulip post** (user to write): ask about reviewing A1/A2 and whether "rustc as a Wasm host" is welcome upstream; mention bjorn3. Points to cover: see the 2026-10-24 conversation summary in `~/Projects/rustc-wasm-host-source-changes.md` §5.
- [ ] **A1/A2 rustc changes** (user to write, Claude reviews and builds): see `~/Projects/rustc-wasm-host-source-changes.md` §3. Unblocks WP-05.

## Human actions needed
- [ ] **WP-05 decision (2026-10-24):** the rust checkout's AGENTS.md forbids AI-authored rustc changes without a named reviewer, and bans them in codegen/metadata. The minimum changes (A1 driver `lib`, A2 dlopen guards) need to be written by the user or reviewed. B1/B2 can avoid rustc changes (VFS symlink, external wasm-ld). Details: `~/Projects/rustc-wasm-host-source-changes.md`.
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
| 04 | Build LLVM for a Wasm host | done | 1 | `scripts/verify/wp-04.sh` passes. llc.wasm 53 MiB (10.1 br), wasm-ld.wasm 63 MiB (11.7 br), 117 static libs (130 MB) |
| 05 | rustc for a Wasm host: front end | blocked | 1 | rust-lang AGENTS.md: AI may not edit rustc without a named reviewer; codegen/metadata changes banned. Needed changes: `~/Projects/rustc-wasm-host-source-changes.md` |
| 06 | In-process linking | blocked | 0 | |
| 07 | Unwinding build and error recovery | blocked | 0 | |
| 08 | Sysroots and lazy metadata | blocked | 0 | |
| 09 | Compile-server mode | blocked | 0 | |
| 10 | Toolchain release packaging | blocked | 0 | |
| 11 | Virtual filesystem | done | 2 | `scripts/verify/wp-11.sh` passes. Shared-memory VFS + OPFS + WASI p1 adapter; design in `docs/vfs.md` |
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
- 2026-10-24 WP-04: LLVM 23.1.1 (+lld) for wasm32-wasip1-threads, Release -O3: llc.wasm 53.3 MiB (brotli-9 10.1 MiB), wasm-ld.wasm 63.3 MiB (11.7 MiB); smoke test compiles + links (multithreaded lld) + runs under wasmtime-threads 46.
- 2026-10-24 WP-11: rustc.wasm on our VFS+WASI vs the shim (Chromium, under `-j10` build load): `-V` 39 vs 93 ms, check-hello 277 vs 447 ms, build-hello 673 vs 1010 ms, build-medium 1849 vs 1935 ms. VFS: 64 MiB written in 29 ms, read in 27 ms (one copy).
- Smoke: hello world runs on wasip1, wasip2, wasip3 (wasmtime 50) and wasip1-threads with a real thread (wasmtime 46.0.3).

## Session log
- 2026-10-24 (session 7, cont.): The user wrote A1. The build now compiles 241 crates (no A3 dependency failures so far) and stops at the expected A2 errors in `rustc_metadata/src/host_dylib.rs`. Fixed on our side: the `cc` crate passes the old `--target=wasm32-wasi`, so `toolchain/bin/wasi-threads-clang{,++}` rewrite it.
- 2026-10-24 (session 7): WP-05 prep without touching rustc. `build-rustc.sh` (pinned rustup 1.99.1 as stage 0, per-target rustflags because `RUSTFLAGS_BOOTSTRAP` leaks into bootstrap.py's native build), native `llvm-config` installed into the wasm LLVM prefix, VFS + WASI symlinks with an e2e test. Discovery build: bootstrap + std OK, stops at A1 (rustc_driver dylib-only). Drafted and verified the browser_wasi_shim bug report.
- 2026-10-24 (session 6, interrupted by a system suspend/hibernate crash at 11:11, resumed): WP-04: LLVM 23.1.1 source + ported WASI patch + `build-llvm.sh`; build now runs under `systemd-inhibit`. WP-11 done in parallel: `crates/vfs` (shared-memory FS, fd tables), `web/vfs` (wrapper, OPFS persister), `web/wasi` (WASI p1 + thread spawning). The oligamiq rustc.wasm builds and links on it, faster than on browser_wasi_shim.
- 2026-10-24 (session 5): WP-03. Reviewed bjorn3 (wasm20, Cranelift), oligamiq (wasm17, the v3 build), YoWASP LLVM WASI patch (not upstream), and danlapid/Cloudflare (7 patches, rust 1.98.1). Chose danlapid as the primary base and rustc 1.99.1, version-pinned so rustup's std can be reused. Pinned sources are fetched by `scripts/fetch-patch-sources.sh`.
- 2026-10-24 (session 4): WP-02. Turned the baseline page into a harness API. Added `bench/run.ts`/`compare.ts`/`measure.py`, a 563-line benchmark program, native rustc 1.83.0, and browser RSS sampling. Fixed the shim `path_rename` bug (pnpm patch). Scope is now Chromium only.
- 2026-10-24 (session 3): WP-01. Fetch script, threaded browser harness using browser_wasi_shim-threads, `baseline.spec.ts`, and verify script. Found 11 issues (see `docs/baseline-notes.md`), the main ones being: errors trap the abort build, the unwind build uses legacy EH, and the temp dir is hard-wired to `/`.
- 2026-10-23 (session 2): WP-00. Installed nightly + Wasm targets, pnpm, jco, wasmtime 50 + 46, wasm-tools, sccache, wasi-sdk-34, Playwright. Found wasi-threads removed in wasmtime 47. WebKit can't run on Arch, so it's opt-in.
- 2026-10-23 (session 1): planning only, no code yet.
