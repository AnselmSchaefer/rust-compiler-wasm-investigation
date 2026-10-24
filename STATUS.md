# Status

*Update at the end of every session (see PLAN.md §0).*

## Current
- **Active WP:** **WP-09** (in-progress, 1 session used, **waiting on a user decision**, see Blocker).
- **Last session:** 2026-10-24 (session 11). The compile server works (`rustc-multi --server`): 10 sequential requests in one Chromium instance, all correct. Warm check-hello 21.9–22.5 ms vs cold (new instance per compile) 65–68 ms = 2.9–3.0×, right at the 3× target, so `tests/e2e/compile-server.spec.ts` passes or fails by chance.
- **Rule for rustc source:** rust-lang's agent policy (`build/rust/AGENTS.md`) applies. Claude does not write or edit rustc source, and does not draft rust-lang issues, PRs or Zulip posts. The user writes those, or applies existing **human-written** patches (bjorn3/oligamiq), which the user prefers whenever one exists. **danlapid 0005–0007 are LLM-generated** (Claude co-author trailers), so they don't qualify even if the user applies them; design reference only (`docs/patches.md`). Claude reviews, builds and explains. Everything outside `build/rust` is Claude's, including out-of-tree drivers using `rustc_driver` (`toolchain/rustc-multi`).
- **Blocker (WP-09):** the ~20 ms of a warm request is mostly rustc reloading std's metadata per session (`-Ztime-passes`: expand_crate 14–15 ms, which is where `std` and its deps get loaded). `.rmeta` files are read by `get_rmeta_metadata_section` → `Mmap::map`, which on wasm32 is `read_to_end`; it bypasses the codegen backend's `MetadataLoader`, so an out-of-tree driver can't cache them. No human-written cache exists in bjorn3/oligamiq (checked). Options: (A) keep the 3× goal: the user writes a change that keeps metadata blobs across sessions (rustc_metadata, user-authored only); (B) re-scope: accept ~3× (e.g. check 2.5×, record the numbers), since the server's other gains (no re-instantiation, worker reuse) are in; (C) other ideas from the user.
- **Next step:** after the decision: set the spec's threshold (or rebuild with the user's change), write `scripts/verify/wp-09.sh` (wasmtime: 10 requests via stdin; Chromium: the spec), record numbers in `bench/`.
- **Running background jobs:** none

## Current session (2026-10-24, session 11)
- `toolchain/rustc-multi/main.rs`: `--server [--follow]` mode, with JSON requests on stdin, answers on stdout, and a `\x1e<id>` marker on stderr; uses the compiler's own `serde_json`. Under wasmtime: 10 checks of hello at ~21 ms each after the first.
- `web/wasi/process.ts` + `process-worker.ts`: a worker whose thread has finished keeps its instance and runs the next thread (rustc spawns a thread per compile). Plus `OUT_SEQ` stdout-write notification (`onStdout` callback) so hosts wait instead of polling. `web/vfs/vfs.ts`: `appendFile`.
- `tests/e2e/rustc-host/main.ts`: `startServer()`; `tests/e2e/compile-server.spec.ts`. WP-07/08/11 specs still pass with the worker pool.

## Current session (2026-10-24, session 10): done
- Baseline before any change: hello peaks at 102 MiB (check) / 139 MiB (codegen) of rustc memory in Chromium, so the 300 MB target is met without paged metadata.
- danlapid 0005/0006/0007 carry `Co-Authored-By: Claude` trailers. They're LLM-generated, so not usable under the policy; recorded in `docs/patches.md`. 0007 isn't needed anyway.
- `toolchain/package-sysroot.mjs`: rustup's 1.99.1 wasm32-wasip1 std → hard links + `.br` + `manifest.json` (sha256, sizes, group meta/link). meta 80.5 MiB → 21.7 MiB brotli; link 23.5 → 6.5 MiB. Check and codegen work with only the meta group.
- The `tests/e2e/rustc-host` page loads from the manifest (`loadSysroot(group)`, `vfsBytes()`); `tests/e2e/sysroot-memory.spec.ts` writes `bench/results/*-sysroot-memory.json`; `bench/sysroot.md`. `scripts/verify/wp-08.sh` passes; WP-07's spec still passes.

## Current session (2026-10-24, session 9): done
- **No rust-tree change needed:** exnref is already rustc's wasm default, and std supports `wasi` + `panic=unwind` via libunwind. Bootstrap links the stage-1 compiler against *stage 0's* std, though, and rustup's is panic=abort, so `toolchain/build-host-std.sh` builds an unwind `wasm32-wasip1-threads` std with `-Zbuild-std` (danlapid's technique). It installs it into a hard-linked copy of rustup 1.99.1 (`build/rustc-wasm/stage0`), which is bootstrap's `rustc`. `-lunwind` comes from wasi-sdk's eh multilib (only libunwind.a, via `host-shims/eh-lib`).
- `toolchain/rustc-multi/main.rs` + `build-rustc-multi.sh`: out-of-tree driver (like clippy-driver). It runs `--next`-separated rustc invocations in one instance and catches ICEs (`catch_with_exit_code` re-raises them). It links like bootstrap's rustc-main: deps from `.librustc-stamp`, native paths from the newest build-script runs, rustflags from `bootstrap.toml`.
- Found: with `RUSTC_BOOTSTRAP=1` (nightly mode), `ice_path` calls `std::process::id()`, which panics on WASI, inside the panic hook, and the instance hangs. That's why `-Zno-link` "hung" in session 8. Workaround: `RUSTC_ICE=0`. bjorn3's one-line fix is saved as `toolchain/patches/rust/available/bjorn3-ice-path-pid.diff` (see Follow-ups); stable mode (no RUSTC_BOOTSTRAP) never reaches it.
- Chromium page `tests/e2e/rustc-host/` + `rustc-host.spec.ts` (assets: `scripts/prep-rustc-host-page.sh`). `scripts/verify/wp-07.sh` passes; WP-05/06 verify still pass on the unwind build.

## Current session (2026-10-24, session 8): done
- `--emit=obj` works. Fixed wasi-libc's `stat` returning no permission bits, which made rustc see every existing file as read-only: `toolchain/host-shims/wasi-stat-mode.c`, linked with `--wrap` (in the `build-rustc.sh` rustflags).
- On WASI, std's `env::join_paths` always fails, and `get_linker` unwrapped it. The user applied bjorn3's existing one-line fix (`toolchain/patches/rust/bjorn3-get-linker-path.diff`). With it, rustc gets to `--print link-args=FILE` and then fails to spawn the linker, as expected.
- Host side: `web/link/link-args.ts` parses the printed command into a wasm-ld argv (no Node APIs, for WP-12). `toolchain/rustc-wasm.ts` drives wasmtime: scratch output dir, wasm-ld.wasm, moves the results into place, strips the abort traps. `scripts/verify/wp-06.sh` passes.
- `-Zno-link` (with RUSTC_BOOTSTRAP=1) hangs idle in rustc.wasm. Not needed now; note it for WP-09/WP-17 if `.rlink` is ever wanted.

## Follow-ups (check these at the start of every session)
- [ ] **Saved for later (user applies, optional):** bjorn3's `ice_path` pid fix, extracted as `toolchain/patches/rust/available/bjorn3-ice-path-pid.diff` (applies cleanly to 1.99.1; problem, workaround and apply command in `toolchain/patches/rust/README.md`). Needed only if nightly-mode (`RUSTC_BOOTSTRAP=1`) runs should write ICE files; until then hosts set `RUSTC_ICE=0`. Re-check before WP-09.
- [ ] **browser_wasi_shim bug report** (user posting, 2026-10-24): `path_rename` no-op in the threads package. Draft: `~/Projects/browser_wasi_shim-path_rename-issue.md`. Check https://github.com/bjorn3/browser_wasi_shim/issues for a reply. If the fix is released upstream, drop `patches/@oligami__browser_wasi_shim-threads@0.5.0.patch`.
- [ ] **#llm-mentoring Zulip post** (user to write): ask about reviewing A1/A2 and whether "rustc as a Wasm host" is welcome upstream; mention bjorn3. Points to cover: see the 2026-10-24 conversation summary in `~/Projects/rustc-wasm-host-source-changes.md` §5.
- [x] **A1/A2 rustc changes**: written by the user 2026-10-24 and saved as `toolchain/patches/rust/wasm-host.diff`. WP-05 done.
- [ ] **Possible upstream rustc bug** (user to report, if wanted): `filesearch.rs` `from_env_args_next` checks `lib/rustlib` relative to the *working directory*, not next to argv[0] (see `~/Projects/rustc-wasm-host-source-changes.md` §6).

## Human actions needed
- [ ] **WP-09 decision:** (A) the user writes a metadata cache in rustc, (B) re-scope the 3× target, or (C) something else. See Blocker.
- [x] **WP-06:** resolved 2026-10-24: the user applied bjorn3's existing `get_linker` fix instead of writing a std change. A proper std `join_paths`/`split_paths` for WASI is still an optional upstream fix the user could write.
- [x] **WP-05 decision (2026-10-24):** resolved: the user wrote A1/A2. the rust checkout's AGENTS.md forbids AI-authored rustc changes without a named reviewer, and bans them in codegen/metadata. The minimum changes (A1 driver `lib`, A2 dlopen guards) need to be written by the user or reviewed. B1/B2 can avoid rustc changes (VFS symlink, external wasm-ld). Details: `~/Projects/rustc-wasm-host-source-changes.md`.
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
| 05 | rustc for a Wasm host: front end | done | 2 | `scripts/verify/wp-05.sh` passes. rustc 1.99.1 for wasm32-wasip1-threads (126.7 MiB), version identical to stable; A1/A2 written by the user (`toolchain/patches/rust/`) |
| 06 | In-process linking | done | 1 | `scripts/verify/wp-06.sh` passes. Linked outside rustc by wasm-ld.wasm (`toolchain/rustc-wasm.ts`); stat shim; bjorn3's `get_linker` fix applied by the user |
| 07 | Unwinding build and error recovery | done | 1 | `scripts/verify/wp-07.sh` passes. panic=unwind + exnref via config (unwind host std as stage 0); `rustc-multi` driver; no rust-tree change |
| 08 | Sysroots and lazy metadata | done | 1 | `scripts/verify/wp-08.sh` passes. Packaged sysroot (meta/link groups); hello peaks 139 MiB, no metadata patch needed (D-0007 is LLM-generated anyway) |
| 09 | Compile-server mode | in-progress | 1 | server works; warm/cold = 2.9–3.0× (target 3×): needs a decision, see Blocker |
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
- 2026-10-24 WP-08 (Chromium, unwind host, packaged sysroot): peak rustc memory check-hello 102 MiB, codegen hello 139 MiB, check-medium 111, codegen medium 189, `-O` 168. Warm: check-hello 65–73 ms (WP-02 baseline 447 ms), obj-hello 157–211 ms. Sysroot brotli: meta 21.7 MiB, link 6.5 MiB; VFS 113/137 MiB. Details: `bench/sysroot.md`.
- 2026-10-24 WP-07, unwind vs abort host: rustc.wasm 136.1 MiB (brotli-9 22.2 MiB) vs 126.7 MiB (21.1 MiB), +7%. Chromium medians of 4 warm runs: check medium (lib) 219 vs 215 ms, codegen medium (obj) 632 vs 620 ms, so about the same. wasmtime 46 is ~25–30% slower with EH: check-medium 1030 vs 789 ms, obj-medium 1430 vs 1168 ms, build-medium end-to-end 1.90 vs 1.63 s. Chromium compile error: exit 1 in 237–262 ms. rustc-multi runs ICE + error + check + codegen in one instance in 0.74 s (Chromium), 0.93–1.03 s (wasmtime).
- 2026-10-24 WP-06 (wasmtime-threads 46, warm cache): build-hello 1.03–1.06 s end-to-end (rustc.wasm + wasm-ld.wasm, 2 wasmtime starts, Node driver); build-medium 1.52 s (2.77 MB binary, debug); native rustc 1.99.1 build-hello 67 ms. First run after a rebuild ~17 s (Cranelift compiling both modules).
- 2026-10-23 engine probe: Chromium and Firefox (Playwright 1.64.1) both have COI, SAB, shared memory, exnref EH, JSPI, memory64, OPFS.
- 2026-10-24 WP-01 baseline (oligamiq v3, rustc 1.83-dev, hello, wasm32-wasip1, debug). Native: 0.16 s. wasmtime-threads, warm: 0.85 s (19 s on the first run because of Cranelift). Chromium: rustc 1.25–1.47 s, module compile 0.2 s, end-to-end 1.7 s. Firefox: rustc 0.59–0.78 s, module compile 0.65–0.8 s, end-to-end 1.9 s. Unwind build works in both browsers but not in wasmtime 46.
- 2026-10-24 WP-02 baseline (`bench/results/2026-10-24-c029d0d.json`). Chromium 156 medians: check-hello 447 ms (12.1× native), build-hello 1010 ms (6.4×), check-medium 732 ms (5.1×), build-medium 1935 ms (5.9×), build-medium-O 4038 ms (4.8×). First compile after load up to 2× slower. Load: 41.9 MB brotli, 1.15 s on localhost, 3.4 s download at 100 Mbit. Wasm memory 108–360 MiB per step; browser RSS 0.85–2.0 GiB.
- 2026-10-24 WP-05: rustc.wasm 1.99.1 (Release, panic=abort, no LTO) 126.7 MiB. Under wasmtime-threads 46 (warm cache): `--emit=metadata` of medium.rs as a lib 690 ms (WP-01 baseline toolchain: 938 ms for check-medium); first run ~18 s (Cranelift compiling the module).
- 2026-10-24 WP-04: LLVM 23.1.1 (+lld) for wasm32-wasip1-threads, Release -O3: llc.wasm 53.3 MiB (brotli-9 10.1 MiB), wasm-ld.wasm 63.3 MiB (11.7 MiB); smoke test compiles + links (multithreaded lld) + runs under wasmtime-threads 46.
- 2026-10-24 WP-11: rustc.wasm on our VFS+WASI vs the shim (Chromium, under `-j10` build load): `-V` 39 vs 93 ms, check-hello 277 vs 447 ms, build-hello 673 vs 1010 ms, build-medium 1849 vs 1935 ms. VFS: 64 MiB written in 29 ms, read in 27 ms (one copy).
- Smoke: hello world runs on wasip1, wasip2, wasip3 (wasmtime 50) and wasip1-threads with a real thread (wasmtime 46.0.3).

## Session log
- 2026-10-24 (session 11): WP-09 started. Compile server mode, worker reuse for threads, stdout wake-up. Warm/cold 3.0× at best; the remaining cost is rustc reloading std metadata per session (not cacheable out of tree).
- 2026-10-24 (session 10): **WP-08 done.** Hello peaks well under 300 MB without paged metadata. danlapid 0005–0007 found to be LLM-generated (not usable). Sysroot packaging with meta/link groups and a sha256 manifest; page and spec load from it; numbers in `bench/sysroot.md`.
- 2026-10-24 (session 9): **WP-07 done.** panic=unwind host via build config only: an unwind host std built with -Zbuild-std as bootstrap's stage 0 (bootstrap links stage 1 against stage 0's std). Out-of-tree `rustc-multi` driver catches errors and ICEs; error, ICE and success work in one instance in wasmtime and Chromium. Found the `process::id()` panic in `ice_path` under RUSTC_BOOTSTRAP (hangs the instance; RUSTC_ICE=0 avoids it). Chromium sees no EH overhead; wasmtime ~25%.
- 2026-10-24 (session 8): **WP-06 done.** Object emission works. Fixed wasi-libc's stat modes with a link-time shim. Host-side linker driver + link-args parser. The `get_linker` `join_paths().unwrap()` panic (std's WASI paths are unsupported) is fixed by bjorn3's existing hunk, applied by the user. Verify passes: hello/medium build and run, rebuild over an existing output, E0308 reported, no leftovers.
- 2026-10-24 (session 7, cont.): **WP-05 done.** With the user's A1/A2 changes, rustc 1.99.1 builds for wasm32-wasip1-threads. Fixed on our side: `-lc++abi` and `-ldl` (wasi-libc stubs) on the host link. `rustc.wasm -V` is identical to stable; type-checking hello and a library works with rustup's wasm32-wasip1 std (medium.rs as a lib: 690 ms in wasmtime). Sysroot detection works without a rustc change (argv[0] symlink + `lib/rustlib` visible from the cwd, because of an apparent upstream bug).
- 2026-10-24 (session 7, cont.): The user wrote A1. The build now compiles 241 crates (no A3 dependency failures so far) and stops at the expected A2 errors in `rustc_metadata/src/host_dylib.rs`. Fixed on our side: the `cc` crate passes the old `--target=wasm32-wasi`, so `toolchain/bin/wasi-threads-clang{,++}` rewrite it.
- 2026-10-24 (session 7): WP-05 prep without touching rustc. `build-rustc.sh` (pinned rustup 1.99.1 as stage 0, per-target rustflags because `RUSTFLAGS_BOOTSTRAP` leaks into bootstrap.py's native build), native `llvm-config` installed into the wasm LLVM prefix, VFS + WASI symlinks with an e2e test. Discovery build: bootstrap + std OK, stops at A1 (rustc_driver dylib-only). Drafted and verified the browser_wasi_shim bug report.
- 2026-10-24 (session 6, interrupted by a system suspend/hibernate crash at 11:11, resumed): WP-04: LLVM 23.1.1 source + ported WASI patch + `build-llvm.sh`; build now runs under `systemd-inhibit`. WP-11 done in parallel: `crates/vfs` (shared-memory FS, fd tables), `web/vfs` (wrapper, OPFS persister), `web/wasi` (WASI p1 + thread spawning). The oligamiq rustc.wasm builds and links on it, faster than on browser_wasi_shim.
- 2026-10-24 (session 5): WP-03. Reviewed bjorn3 (wasm20, Cranelift), oligamiq (wasm17, the v3 build), YoWASP LLVM WASI patch (not upstream), and danlapid/Cloudflare (7 patches, rust 1.98.1). Chose danlapid as the primary base and rustc 1.99.1, version-pinned so rustup's std can be reused. Pinned sources are fetched by `scripts/fetch-patch-sources.sh`.
- 2026-10-24 (session 4): WP-02. Turned the baseline page into a harness API. Added `bench/run.ts`/`compare.ts`/`measure.py`, a 563-line benchmark program, native rustc 1.83.0, and browser RSS sampling. Fixed the shim `path_rename` bug (pnpm patch). Scope is now Chromium only.
- 2026-10-24 (session 3): WP-01. Fetch script, threaded browser harness using browser_wasi_shim-threads, `baseline.spec.ts`, and verify script. Found 11 issues (see `docs/baseline-notes.md`), the main ones being: errors trap the abort build, the unwind build uses legacy EH, and the temp dir is hard-wired to `/`.
- 2026-10-23 (session 2): WP-00. Installed nightly + Wasm targets, pnpm, jco, wasmtime 50 + 46, wasm-tools, sccache, wasi-sdk-34, Playwright. Found wasi-threads removed in wasmtime 47. WebKit can't run on Arch, so it's opt-in.
- 2026-10-23 (session 1): planning only, no code yet.
