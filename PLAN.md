# Execution Plan: Browser Rust IDE, delivered as Work Packages

*Created 2026-10-23 · Companion to `REPORT.md` (research) and `PROPOSAL.md` (design) · Progress lives in `STATUS.md`*

*Re-scoped 2026-10-24 (user decision): v1 targets **agentic development**: an AI agent writes, builds, tests and fixes Rust through a tool API (WP-38). Everything useful only to humans editing in the browser moved to the **Appendix: some day later** (§4, end). PROPOSAL.md still describes the full human IDE; where it disagrees, this plan wins.*

Claude is the sole developer, and work happens in separate sessions, not continuously. The project is therefore cut into **work packages (WPs)** that run one after another. Each WP:

- fits in **1–4 sessions**
- has a **verifiable "Done when"** check, backed by a script in `scripts/verify/`
- leaves the repository in a working, committed state
- records everything the next session needs in `STATUS.md`

---

## 0. How every session runs (session protocol)

1. **Orient** (≤ 5 min).
   - Read `CLAUDE.md` and `STATUS.md`.
   - Pick the **lowest-numbered WP marked `ready`** whose dependencies are `done`. If a WP is `in-progress`, continue it.
   - WPs in the **Appendix** are `deferred`: never pick them unless the user moves them back.
2. **Plan the session.** Write 3–6 bullet goals under "Current session" in `STATUS.md`.
3. **Work.**
   - Long builds run in the background with logs in `build-logs/<wp>/`.
   - A single background command may run **at most 2 h**, so every build script must be **resumable** (ninja/cargo incremental, stage markers in `build/.stamps/`).
4. **Verify.** Run `scripts/verify/wp-XX.sh`. A WP is `done` only when it passes.
5. **Hand off.** Update `STATUS.md` with:
   - WP status
   - what was finished
   - exact next step
   - blockers
   - human actions needed
   - measured numbers

   Then commit on branch `main`, with message `WP-XX: <summary>`.
6. **Stop cleanly.** Leave no half-applied patch or dangling background process. If a build is still running, note its PID, log path and resume command in `STATUS.md`.

**Status values:** `blocked` · `ready` · `in-progress` · `done` · `deferred`

**Scope rule:** if a WP grows beyond 4 sessions, split it into `WP-XXa` / `WP-XXb` in this file before continuing.

**Human checkpoints** are marked **[H]**. Claude prepares everything and then stops, so the user can:
- run a `sudo` install
- create an account or approve spending
- approve publishing anything to the internet
- approve posting to upstream Rust forums

---

## 1. Fixed decisions (from PROPOSAL §10)

These are taken as defaults so work can start. Changing one later only affects the WPs named.

| Decision | Choice | Affects |
|---|---|---|
| Primary user (2026-10-24) | AI agents on this machine, through a tool API in the browser page, reached via a local Python relay (MCP on stdio ⇄ WebSocket). Human-only IDE features are in the Appendix | WP-25–27, WP-38 |
| Editor | CodeMirror 6 | WP-14, WP-24 (Appendix) |
| Compiler host ABI | `wasm32-wasip1-threads` (WASI) | WP-04–WP-10 |
| User program target | `wasm32-wasip1` first (WP-13), `wasm32-wasip3` components later (WP-30) | WP-13, WP-30 |
| Hosting | v1: local, the relay serves the app and proxies the index (WP-38). Optional public deploy later: static CDN (Cloudflare Pages + R2 or GitHub Pages), no server-side compiling | WP-16, WP-29, WP-38 |
| Base rustc version | Latest stable at WP-03; rebased every 6 weeks (WP-37) | all toolchain WPs |
| Language for host glue | TypeScript (workers, UI); Rust → Wasm for VFS, resolver, cache, planner | — |
| Target browsers | **Chromium-based only** (user decision 2026-10-24). Firefox runs where it's free but is never a gate. Safari/WebKit are out of scope | all browser WPs |
| Browser test automation | Playwright. Chromium is the required project, Firefox is best-effort | all browser WPs |

---

## 2. Repository layout (created in WP-00)

```
/toolchain/      rustc + LLVM + lld build scripts, patches/, sysroot builds, release packaging
/crates/         Rust crates compiled to Wasm: vfs, resolver, planner, cache, pm-bridge, build-host
/web/            TypeScript: orchestrator worker, tool workers, UI (CodeMirror, xterm), service worker
/tests/e2e/      Playwright tests      /tests/ecosystem/  crate compile matrix
/bench/          benchmark harness + results/*.json + baseline.md
/scripts/        doctor.sh, verify/wp-XX.sh, dev server (COOP/COEP)
/docs/           patches.md, rebase.md, architecture.md, decisions.md
/build/ /build-logs/   (git-ignored)
```

---

## 3. Phase overview

| Phase | WPs | Outcome | Est. sessions |
|---|---|---|---|
| A. Foundation | 00–02 | Tooling, baseline reproduced, benchmark harness | 4–6 |
| B. Own toolchain | 03–10 | Our own rustc.wasm + lld + sysroot, compile-server mode, packaged releases | 14–22 |
| C. Browser runtime | 11–14 | VFS, workers, run sandbox, minimal UI → **Milestone M1a: offline single-file playground** | 7–10 |
| D. Dependencies | 15–22 | crates.io, cache, proc macros, build scripts, ecosystem matrix → **M1: playground with crates** | 18–28 |
| E. Agent-ready v1 | 25–27, 38 | Workspaces, tests/Clippy/rustfmt, incremental check, **agent tool API + local relay (MCP)** → **M2: v1 for agentic development** | 8–9 |
| (optional) Public deploy | 29 | Only to share beyond this machine | 1–2 |
| F. v2 features | 30, 32, 34 | wasip3 components, clang for `cc` build scripts, HTTP handler runs | 6–9 |
| Appendix: some day later | 23, 24, 28, 31, 33, 35 + parts of 25–27 | Human-only browser IDE: rust-analyzer + editor UI, first-visit perf, web preview, debugger UI, collaboration | — |
| G. Upstream & upkeep | 36–37 | Upstream proposals; recurring rebase | ongoing |
| **Total to v1** | | | **~51–75 sessions** (was ~60–90 with the human IDE) |

---

## 4. Work packages

### Phase A: Foundation

#### WP-00 Repository bootstrap and tooling
- **Depends:** none · **Est.:** 1 session
- **Tasks**
  - `git init`, the layout from §2, `.gitignore`, `CLAUDE.md`, `STATUS.md`, `docs/decisions.md` (copy of §1).
  - `scripts/doctor.sh` checks for:
    - cmake, ninja, clang, python3, node ≥ 22, pnpm
    - rustup with stable + nightly and targets `wasm32-wasip1`, `wasm32-wasip1-threads`, `wasm32-wasip2`, `wasm32-wasip3`
    - wasm-tools, wasmtime, jco, wasi-sdk-34 at `~/opt/wasi-sdk`
    - Playwright browsers, brotli, sccache
  - Install everything that doesn't need sudo.
  - **[H]** `sudo pacman -S cmake ninja brotli` (missing on this machine as of 2026-10-23).
- **Done when:** `scripts/doctor.sh` prints all green.

#### WP-01 Reproduce the existing baseline
- **Depends:** WP-00 · **Est.:** 1–2 sessions
- **Tasks**
  - Download the oligamiq `rust_wasm` v3 prebuilt rustc.wasm + sysroot and `browser_wasi_shim`.
  - Compile and run `hello.rs` in **wasmtime**.
  - Do the same in **headless Chromium via Playwright**, with a COOP/COEP static server.
  - Write down every problem found in `docs/baseline-notes.md`.
- **Done when:** `tests/e2e/baseline.spec.ts` compiles and runs hello world in Chromium and Firefox, and prints `Hello`.

#### WP-02 Benchmark harness
- **Depends:** WP-01 · **Est.:** 1–2 sessions
- **Tasks**
  - Playwright-driven benchmarks for:
    - cold asset load
    - instantiate
    - compile hello (`check` / `build`)
    - compile a 500-line program
    - run
    - peak memory (`performance.measureUserAgentSpecificMemory` where available)
  - Store results in `bench/results/<date>-<commit>.json`, with `bench/compare.ts` to diff two runs.
  - Native rustc numbers as a reference.
  - Write `bench/baseline.md` with the oligamiq toolchain numbers.
- **Done when:** `pnpm bench` produces a JSON result and `baseline.md` exists with Chromium numbers (Firefox numbers where available).

### Phase B: Our own toolchain

#### WP-03 Patch inventory and base version
- **Depends:** WP-01 · **Est.:** 1–2 sessions
- **Tasks**
  - Read and catalogue the patches in:
    - bjorn3's `compile_rustc_for_wasm*` branch
    - oligamiq's toolchain repos
    - danlapid/rust-playground `toolchain/rustc-patches` (7 patches)
  - Write `docs/patches.md`: one row per concern (threads, codegen backend loading, linking, proc macros, mmap/metadata, sysroot detection, current_exe/env), with the source patch, size, and a keep/rewrite decision.
  - Choose the base rustc tag.
- **Done when:** `docs/patches.md` covers every concern, and a base tag is recorded in `docs/decisions.md`.

#### WP-04 Build LLVM for a Wasm host
- **Depends:** WP-00, WP-03 · **Est.:** 2–3 sessions (build time dominated)
- **Tasks**
  - Source: rust-lang/llvm-project `rustc/23.1-2026-07-22` @ `1b9c0d5ff9` (the LLVM of rustc 1.99.1) plus `toolchain/patches/llvm/0001`, YoWASP's WASI patch rebased from `llvmorg-22.1.0+wasm` (see `docs/patches.md` #11).
  - Write `toolchain/build-llvm.sh`, staged and resumable:
    - wasi-sdk-34 sysroot, `wasm32-wasip1-threads`
    - YoWASP-style flags: `-D_WASI_EMULATED_MMAN`/`-lwasi-emulated-mman`, `--max-memory=4 GiB`, `-z stack-size`, `--stack-first`
    - an `llvm-config` that bootstrap can use (`[target.wasm32-wasip1-threads] llvm-config`), so no bootstrap `llvm.rs` patch is needed
    - `LLVM_TARGETS_TO_BUILD=WebAssembly`
    - lld enabled
    - `LLVM_PARALLEL_LINK_JOBS=1` (15 GB RAM)
    - sccache
  - Each background chunk is ≤ 2 h; ninja resumes from where it stopped.
  - Smoke test: `llc.wasm` compiles a `.ll` file to Wasm under wasmtime.
- **Done when:** `scripts/verify/wp-04.sh` runs llc.wasm and wasm-ld.wasm in wasmtime successfully. The size of each artifact is recorded.

#### WP-05 rustc for a Wasm host: front end
- **Depends:** WP-04 · **Est.:** 2–4 sessions
- **Tasks**
  - Apply or port the patches (series in `docs/patches.md`): `0001` threads (danlapid 0001), `0003` rustc_driver rlib, `0004` WASI sysroot + dlopen stub + misc host fixes. Static LLVM backend and host link flags are build config.
  - Build rustc 1.99.1 for `wasm32-wasip1-threads` with `x.py` and a custom `bootstrap.toml`: `local-rebuild` from stable 1.99.1 with the version string pinned to stable's (danlapid's `build-rustc.sh` technique), so rustup's std is accepted.
- **Done when:** under wasmtime, `rustc.wasm --version` works, and `rustc.wasm --emit=metadata hello.rs` produces an `.rmeta` file.

#### WP-06 In-process linking
- **Depends:** WP-05 · **Est.:** 1–2 sessions
- **Tasks**
  - **Re-scoped 2026-10-24:** an in-process lld call would be an AI-authored change in `rustc_codegen_ssa`, which rust-lang's agent policy bans. Instead, link **outside rustc**: run rustc with `--emit=obj`/`-C save-temps` (or capture the failed linker spawn and its link line, e.g. `--print link-args`), then have the host run `wasm-ld.wasm` with that link line on the same filesystem (wasmtime first, the browser VFS in WP-12). In-process linking stays possible later as a human-authored patch.
  - Check that no temp dirs or `.o` files are left behind (WP-01 finding #4).
  - *Done 2026-10-24:* `toolchain/rustc-wasm.ts` + `web/link/link-args.ts`. It also needed a wasi-libc stat-mode shim (`toolchain/host-shims/`) and bjorn3's `get_linker` PATH fix (applied by the user).
- **Done when:** under wasmtime, `rustc.wasm hello.rs --target wasm32-wasip1 -o hello.wasm` builds a binary, and `wasmtime hello.wasm` prints `Hello`.

#### WP-07 Unwinding build and error recovery
- **Depends:** WP-06 · **Est.:** 1–2 sessions
- **Tasks**
  - Build the rustc host with `panic=unwind` using Wasm exception handling (exnref).
  - Make sure a compile error, or an internal compiler error, returns to the driver and leaves the instance usable.
- **Done when:** a test runs, in one instance: a compile with an error, then a successful compile. Both give correct results in wasmtime and in Chromium.
  - *Done 2026-10-24:* config only (unwind host std as bootstrap's stage 0, `toolchain/build-host-std.sh`). "One instance" uses the out-of-tree `toolchain/rustc-multi` driver, which also catches ICEs; WP-09 grows it into the compile server.

#### WP-08 Sysroots and lazy metadata
- **Depends:** WP-06 · **Est.:** 2–3 sessions
- **Tasks**
  - Use rustup's 1.99.1 `rust-std-wasm32-wasip1` as the `wasm32-wasip1` sysroot (it matches our version-pinned rustc and already has separate `.rmeta` files). Build std ourselves only for `wasm32-wasip3` (later).
  - Package the sysroots as brotli assets.
  - Port Cloudflare's patch that reads metadata a page at a time (series `0005`, danlapid 0007). On wasm32, rustc reads every `.rmeta` fully into memory, and 1.99.1's libcore.rmeta alone is 45 MB (~350 ms per invocation in WP-02).
  - Measure peak memory before and after.
- **Done when:** compiling hello in Chromium peaks below 300 MB (target to confirm), and the numbers are in `bench/`.
  - *Done 2026-10-24:* `toolchain/package-sysroot.mjs` (meta/link groups, brotli, sha256 manifest). hello peaks at 102/139 MiB (check/codegen) without paged metadata, so danlapid 0007 isn't used (it's also LLM-generated, see `docs/patches.md`). Numbers in `bench/sysroot.md`.

#### WP-09 Compile-server mode
- **Depends:** WP-07, WP-08 · **Est.:** 2–3 sessions
- **Tasks**
  - Add a rustc driver entry point that serves many compile requests from one long-lived instance, keeping the sysroot and dependency metadata loaded.
  - Message protocol: JSON in/out over a WASI fd, or a host import. Later it gets the WIT facade.
  - Measure cold vs warm.
- **Done when:** 10 sequential compiles in one instance work, and the warm `check` of hello is at least 3× faster than cold. The numbers are recorded.
  - *Done 2026-10-24, re-scoped by the user to ≥ 2.5×:* measured 3.0× (cold 67 ms, warm 22 ms). The rest is rustc reloading std metadata per session, which only a rustc change could cache (`bench/compile-server.md`). Server: `rustc-multi --server` (JSON on stdin/stdout); `web/wasi` reuses thread workers and notifies on stdout writes.

#### WP-10 Toolchain release packaging and rebase procedure
- **Depends:** WP-09 · **Est.:** 1–2 sessions
- **Tasks**
  - `toolchain/release.sh` produces:
    - `rustc.wasm.br`, `lld.wasm.br`, `sysroot-*.tar.br`
    - `manifest.json` with SHA-256 hashes and `RUSTC_ID`
  - Write `docs/rebase.md`, a step-by-step rebase onto a new rustc version.
  - Make the build reproducible: two builds give identical hashes, or the differences are documented.
- **Done when:** `release.sh` output passes `scripts/verify/wp-10.sh` (manifest hashes match, and WP-06/07 tests pass with the packaged artifacts).
  - *Done 2026-10-24:* `rustc.wasm.br` is `rustc-multi.wasm` (a drop-in rustc, plus `--next` and `--server`); the sysroot ships as two tars (meta/link). Pins are in `toolchain/versions.env`. An independent second build is bit-identical (`docs/rebase.md`).

### Phase C: Browser runtime

#### WP-11 Virtual filesystem
- **Depends:** WP-01 · **Est.:** 2–3 sessions (can run in parallel with Phase B when B is waiting on builds)
- **Tasks**
  - `crates/vfs`: an in-memory tree plus OPFS persistence, using sync access handles in workers, with a shared view across workers via SharedArrayBuffer.
  - A WASI preview-1 adapter for rustc, integrated with or forked from browser_wasi_shim.
  - Unit tests natively, e2e tests in Chromium.
- **Done when:** two workers see each other's writes, and files survive a page reload (Playwright test).

#### WP-12 Orchestrator and worker pool
- **Depends:** WP-10, WP-11 · **Est.:** 2 sessions
- **Tasks**
  - `web/orchestrator`: manages the rustc compile-server worker, the linker worker and the job queue.
  - Typed message protocol.
  - Dev server with COOP/COEP headers.
  - Load the toolchain from the `manifest.json` assets and cache the compiled `WebAssembly.Module`s.
- **Done when:** an e2e test compiles hello through the orchestrator, entirely using our own toolchain.
  - *Done 2026-10-24:* `web/orchestrator` (`Release` loader with sha256 + Cache Storage, ustar reader, `Orchestrator` with compile server + wasm-ld process + job queue, worker + typed protocol + client). `tests/e2e/orchestrator.spec.ts` compiles, links and runs hello and medium.

#### WP-13 Run sandbox
- **Depends:** WP-12 · **Est.:** 1 session
- **Tasks**
  - A sandbox worker runs the `wasm32-wasip1` output: stdin/stdout/args/env, files, exit codes, panics, a kill button, no network.
- **Done when:** e2e tests cover a program that reads stdin, panics with a non-zero exit, and gets killed after a timeout.
  - *Done 2026-10-24:* `web/sandbox` (a worker and its own VFS per run, SharedArrayBuffer stdin pipe for interactive input, streamed stdout/stderr, exit/trap/kill/timeout). The orchestrator's `run` op uses it. `tests/e2e/sandbox.spec.ts`.

#### WP-14 Minimal UI → **M1a**
- **Depends:** WP-13 · **Est.:** 2 sessions
- **Tasks**
  - CodeMirror 6 editor, xterm.js terminal, Run/Check buttons, inline diagnostics parsed from rustc's JSON output.
  - The editor loads first and the toolchain streams in afterwards.
- **Done when:**
  - the e2e test passes
  - editor is interactive in < 2 s on cold load (bench)
  - **[H]** the user tries the local demo and gives feedback
  - *2026-10-24:* e2e test and bench done (`app/`, `tests/e2e/app.spec.ts`, `scripts/verify/wp-14.sh`): editor interactive at ~200 ms cold. Waiting on the **[H]** user trial (`pnpm demo`).

### Phase D: Dependencies

#### WP-15 Cargo resolver
- **Depends:** WP-11 · **Est.:** 3–4 sessions
- **Tasks**
  - Spike (≤ 1 session): can Cargo's resolver be compiled to `wasm32-wasip1` with network, git and curl removed?
  - If not, write `crates/resolver` on `cargo-util-schemas`, `semver` and the sparse-index format. It must cover features, optional, renamed, `cfg(target)` dependencies, dev-dependencies, and reading and writing `Cargo.lock`.
  - Golden tests: for 50 real projects, compare against `Cargo.lock` from native cargo.
- **Done when:** ≥ 48/50 golden lockfiles match, and every mismatch is documented.

#### WP-16 Index and crate download
- **Depends:** WP-15 · **Est.:** 1–2 sessions
- **Tasks**
  - Fetch the sparse index, download `.crate` files, check them, and unpack tar.gz inside Wasm into the VFS.
  - Check CORS on `index.crates.io` and `static.crates.io`. If it's missing, write a minimal CORS mirror Worker, but **[H]** the account and deploy need user approval.
  - Cache in OPFS.
  - Respect crates.io's crawler policy (proper User-Agent, no bulk scraping).
- **Done when:** in the browser, `serde` and `serde_json` resolve and download into the VFS, and a second load works offline.

#### WP-17 Build planner
- **Depends:** WP-15, WP-12 · **Est.:** 2–3 sessions
- **Tasks**
  - Build the unit graph and the rustc invocations: `--extern`, `-L`, `--cfg feature=…`, edition, crate types, metadata hashes, `-C metadata`.
  - Schedule work in parallel across N rustc workers.
  - Golden test against the invocations in native `cargo build -v` output.
- **Done when:** a pure-Rust crate graph (`serde_json`, `itoa`, `memchr`, `ryu`) builds in the browser, and the resulting program runs.
  - *2026-10-25 (done, session 19):* serde_json 1.0.154 now uses `zmij` instead of `ryu`, and zmij, serde_core and serde_json have build scripts, so WP-21's basic path (compile `build.rs` to wasm32-wasip1, run it in the sandbox with cargo's env and OUT_DIR, parse `cargo:` lines) moved here. Planner golden-identical to `cargo build -vv` on 2 cases (34 units); see `docs/planner.md`, `bench/build.md`.

#### WP-18 Content-addressed cache (L1 OPFS, L2 CDN) and prebuild tool
- **Depends:** WP-17 · **Est.:** 2–3 sessions
- **Tasks**
  - Cache key: `hash(RUSTC_ID, source hash, features, flags, target, dependency keys)`.
  - L1 in OPFS; a read-only L2 client.
  - `tools/prebuild`: a native CLI that drives the **same rustc.wasm under wasmtime** to fill L2.
  - Determinism test: the browser build and the wasmtime build hash the same.
- **Done when:**
  - hashes match for 20 crates
  - a second build of the WP-17 graph is entirely cache hits
  - edit → run is measured
  - *2026-10-25 (done, session 20):* 51 units of 3 cases (30 registry crates) have the same keys and bit-identical outputs in Chromium and under wasmtime. Second build after a reload: 83–219 ms, all L1. Edit → run: 278 ms in session, 575 ms after a reload. One shared target dir `/target`, because paths are embedded in outputs. See `docs/cache.md`, `bench/cache.md`.

#### WP-19 Proc-macro bridge: design and native prototype
- **Depends:** WP-06 · **Est.:** 2–3 sessions
- **Tasks**
  - Compile a proc-macro crate (`serde_derive`) for Wasm as a cdylib that exports rustc's proc-macro declarations. Its bridge client comes from the `proc_macro` crate in the sysroot.
  - Write a host that acts as the bridge server and passes bridge buffers in and out.
  - Wrap it in a WIT world `rust:proc-macro` (bytes-level first; typed resources are an optional later step).
  - Measure expansion time against the native `.so`.
- **Done when:** a wasmtime-hosted expansion of `#[derive(Serialize)]` matches native output token for token, and the overhead is recorded (target ≤ 2× per call).
  - *2026-10-25 (done, session 21):* serde_derive compiled to wasm32-wasip1 (as a cdylib: rustc drops `proc-macro` on wasm targets) expands byte-identically to the native `.so` (`-Zunpretty=expanded`; hygiene contexts identical too). Overhead with proc macros optimized: ~2.0–2.1× measured end to end in the native prototype, ~1.7× estimated without its proxy server hop, which rustc.wasm won't have. No rustc change. WP-20 needs one (proc-macro loading in `rustc_metadata`; the user writes it). See `docs/proc-macro.md`, `bench/proc-macro.md`.

#### WP-20 Proc macros inside rustc.wasm
- **Depends:** WP-19, WP-18 · **Est.:** 2–3 sessions
- **Tasks**
  - Patch rustc's proc-macro loader to load the Wasm macro through a host import.
  - The JS host instantiates it in the same worker and calls it synchronously.
  - Optional strict mode: a separate worker, with JSPI pausing rustc.
  - Cache macro artifacts in L1/L2.
- **Done when:** in the browser, a program using `#[derive(Serialize, Deserialize)]` compiles and runs, and so does a second macro crate (`thiserror`).

#### WP-21 Build scripts
- **Depends:** WP-20 · **Est.:** 2–3 sessions
- **Tasks**
  - Compile `build.rs` to Wasm and run it in the sandbox:
    - read-only crate dir
    - read/write `OUT_DIR`
    - Cargo environment variables
  - Parse `cargo:` directives.
  - Route `rustc` process spawns to the compile server.
  - Override list for known-unsupportable scripts.
- **Done when:** crates with `autocfg`, `rustversion`, `libc` and `proc-macro2`-style build scripts build in the browser.
  - *2026-10-25:* the first three tasks and the parser are done in WP-17 (`web/build/cargo.ts`, `crates/resolver/src/plan/build_output.rs`). Left: routing `rustc` spawns (scripts now see `Command` fail), the working directory (now `/`, not the package dir), `DEP_<links>_*` and `-L` from dependencies' scripts (planned, untested), and the override list.

#### WP-22 Ecosystem matrix → **M1** (repeatable WP)
- **Depends:** WP-21 · **Est.:** 3–5 sessions (repeat until the target is met)
- **Tasks**
  - `tests/ecosystem`: build the top 100 (then top 500) crates by downloads, in default features, under wasmtime (fast) and a sample in Chromium.
  - Results in a table: pass/fail + reason class.
  - Each session fixes the largest failure class.
- **Done when:** ≥ 90% of the top 100 pass (M1). The ≥ 95% top-500 target is tracked through Phase E.

### Phase E: Agent-ready v1

#### WP-25 Projects and workspaces
- **Depends:** WP-17, WP-16 · **Est.:** 2 sessions
- **Tasks**
  - Workspaces (members, path dependencies between them) in the build planner and resolver.
  - `Cargo.toml` edits with resolver feedback as structured results (what changed in the lockfile, or the error).
  - Zip import/export; import of a public GitHub repo (archive download).
  - Projects persisted in OPFS (the WP-11 persister).
- **Done when:** an imported workspace with ≥ 2 members survives a reload and builds.

#### WP-26 Tests, Clippy, rustfmt
- **Depends:** WP-25 · **Est.:** 2–3 sessions
- **Tasks**
  - `cargo test`: build the test harnesses, run them in the sandbox, parse libtest's JSON output into per-test results (status, output, duration); run one test by name; doc tests.
  - Build Clippy (a rustc driver, so it uses the same patches) and rustfmt for Wasm; JSON diagnostics.
- **Done when:** an e2e test runs a crate's tests, reruns a single failing test by name with structured results, and Clippy lints and rustfmt formats a file.

#### WP-27 Incremental compilation
- **Depends:** WP-25 · **Est.:** 2 sessions
- **Tasks**
  - Persist rustc's incremental directory in OPFS.
  - Profile pass against the PROPOSAL §6 budgets. An agent iterates edit → check many times, so warm latency matters most.
- **Done when:** a warm `check` of the user crate takes < 1 s and warm edit → run < 2 s on the 500-line benchmark, in Chromium.

#### WP-38 Agent tool API and local relay → **M2**
*Decided 2026-10-24: the agent runs on this machine and reaches the browser through a local relay. Shape: agent ⇄ MCP (stdio) ⇄ Python relay ⇄ WebSocket ⇄ the IDE page in Chromium, which does the work with the toolchain it already has.*
- **Depends:** WP-22, WP-26, WP-27 · **Est.:** 2 sessions
- **Tasks**
  - **Page side:** a tool layer over the orchestrator: list/read/write/delete files; resolve dependencies; check; build; run (stdin, timeout, exit code, output); test (all or one, structured results); Clippy; rustfmt. Every result is JSON, with rustc diagnostics in their JSON form. The IDE shows what the agent does (file changes, terminal output), so a human can watch.
  - **Python relay** (`tools/relay/`, Python 3, as few dependencies as possible):
    - an MCP server on stdio for the agent, with the tools above, forwarded over a WebSocket to the page
    - serves the app itself with COOP/COEP (it replaces `pnpm demo` for agent use) and proxies `/index/` to index.crates.io (same origin, so no CORS problem and no deploy)
    - opens the page, or starts Chromium through Playwright, headed (to watch) or headless (unattended)
    - security: listens on 127.0.0.1 only; the page connects with a per-run token and the relay checks the `Origin`, because any website could otherwise talk to a localhost WebSocket
  - Robustness: one request at a time per project, cancellation, reconnect after a page reload. Keep the page in its own window (Chromium throttles background tabs).
  - Guardrails: per-call time and memory limits; user programs run only in the sandbox (WP-13), without network.
- **Done when:** Claude Code, connected to the relay's MCP server and through it alone, creates a project with a `serde` dependency, fixes a seeded compile error from the diagnostics, makes a failing test pass, and passes Clippy and rustfmt. Run once headed and once headless.

#### WP-29 Public deploy (optional, after M2)
*With a local relay serving the app and proxying the index, v1 needs no public hosting. This WP is for sharing the environment beyond this machine.*
- **Depends:** WP-38 · **Est.:** 1–2 sessions
- **Tasks**
  - **[H]** The user approves hosting, domain and accounts.
  - Static deploy with COOP/COEP headers, an index proxy or CORS mirror (`docs/deps.md`), and a CDN for L2.
  - Prebuild the top ~2,000 crates.
- **Done when:** the public URL passes the e2e smoke suite in Chromium, and the user signs off.

### Phase F: v2 features (in order; each can be deferred; all useful to agents too)

| WP | Package | Depends | Est. | Done when |
|---|---|---|---|---|
| WP-30 | `wasm32-wasip3` component output. `wasm-component-ld` and jco run in the browser | WP-38 | 2–3 | async `wasip3` program runs in the sandbox via jco |
| WP-32 | clang-in-Wasm (YoWASP/oligamiq builds) for `cc`-crate build scripts | WP-21 | 2–3 | Crates with small C parts (e.g. `zstd-sys` vendored) build |
| WP-34 | HTTP handler apps: `wasi:http` incoming-handler apps (axum-style) run in the sandbox and take requests through the tool API (a browser preview pane for humans stays in the Appendix) | WP-30, WP-38 | 2–3 | `GET /hello` sent through the tool API hits the user's Rust handler |

### Phase G: Upstream and upkeep

#### WP-36 Upstream proposals
- **Depends:** WP-22 · **Est.:** 2 sessions to draft
- **Tasks**
  - Draft an MCP for "rustc as a Wasm host" (Tier 3).
  - Draft a pre-RFC for Wasm proc macros, based on WP-19/20 results.
  - **[H]** The user reviews, and posts or approves posting on Zulip/GitHub.
- **Done when:** the drafts are in `docs/upstream/` and the user has decided.

#### WP-37 Release-train rebase (recurring, every 6 weeks)
- **Depends:** WP-10 · **Est.:** 1–2 sessions each time
- **Tasks**
  - Follow `docs/rebase.md`, rebuild, then run every `scripts/verify/*` and the ecosystem sample.
- **Done when:** all verify scripts pass on the new rustc version, and `RUSTC_ID` is bumped (which invalidates the cache).

### Appendix: some day later (only for humans developing in the browser)

*Moved here 2026-10-24 when v1 was re-scoped to agentic development. Status `deferred`; the session protocol never picks these. Kept as written, so they can be moved back unchanged. Dependencies on Phase E WPs still hold.*

Parts taken out of kept WPs:
- From WP-25: service worker for offline use; the project list UI.
- From WP-26: the test explorer UI (the structured test results it would show stay in WP-26).
- From WP-27: running `check` automatically when the editor goes idle.
- From WP-34: serving the handler to a browser preview pane through a Service Worker.
- From WP-14 (done): nothing; the minimal UI stays as the demo and test bed.

#### WP-23 rust-analyzer in Wasm
- **Depends:** WP-11, WP-20 · **Est.:** 2–3 sessions
- **Tasks**
  - Build rust-analyzer for `wasm32-wasip1-threads`. Patch it to:
    - use the in-process proc-macro components instead of the `proc-macro-srv` process
    - drop file watching, using VFS change events instead
  - LSP over a worker message channel.
- **Done when:** in a headless test, hover, completion and go-to-definition work on a project with serde, and derive output is expanded.

#### WP-24 Editor integration
- **Depends:** WP-23, WP-14 · **Est.:** 2–3 sessions
- **Tasks**
  - CodeMirror LSP client: diagnostics, inlay hints, completion, rename, code actions, semantic tokens.
  - File tree, tabs, multi-file editing, search.
- **Done when:** e2e tests cover rename across files and a code action, and keystroke → diagnostics takes < 300 ms (bench).

#### WP-28 First-visit performance
- **Depends:** WP-27 · **Est.:** 1–2 sessions
- **Tasks**
  - Load assets by priority, using streaming compilation and cached compiled modules.
  - Trim the asset size (LLVM WebAssembly target only, strip, brotli level 11).
- **Done when:** the full toolchain is under ~80 MB brotli and full IDE features are ready in < 15 s cold on a 100 Mbit link (throttled bench).

| WP | Package | Depends | Est. | Done when |
|---|---|---|---|---|
| WP-31 | Web preview pane: `wasm-bindgen` CLI compiled to Wasm, iframe preview from a separate origin, hot reload | WP-30 | 3–4 | A Leptos counter app previews and reloads on edit |
| WP-33 | Debugging: DWARF in Wasm, a DAP adapter, breakpoint UI | WP-29 | 3–4 | Breakpoint, step, inspect locals on a test program |
| WP-35 | Collaboration: Yjs CRDT, shared terminal, read-only share links | WP-29 | 3–4 | Two browsers edit the same file live |

---

## 5. Critical path and parallelism

```
WP-00 → 01 → 02
          └→ 03 → 04 → 05 → 06 → 07 ─┐
                          │     └→ 08 ┴→ 09 → 10 ─┐
          └→ 11 (fill-in while builds run) ───────┴→ 12 → 13 → 14 (M1a)
             11 → 15 → 16                12 ─┐
                   15 ───────────────────────┴→ 17 → 18 ─┐
                          06 → 19 ───────────────────────┴→ 20 → 21 → 22 (M1) ─┐
                                 17 + 16 → 25 → 26 ┬────────────────────────────┴→ 38 (agent API + relay, M2) → 29 (optional deploy)
                                            25 → 27 ┘
```

Because sessions run one at a time, "parallel" here means **switching to a WP whose dependencies are met while a long build runs in the background**. The best candidates are WP-11, WP-15 and WP-19.

## 6. Known resource constraints (this machine, 2026-10-23)

- 12 cores, **15 GB RAM**: LLVM/rustc builds use `-j10` and `LLVM_PARALLEL_LINK_JOBS=1`. Expect the first LLVM + rustc build to take 3–6 h in total, split across sessions.
- 409 GB of free disk is enough. Budget about 80 GB for build trees.
- A background command is limited to 2 h, so every build must be resumable.
- **wasmtime ≥ 47 has no wasi-threads** (found in WP-00). Native runs of the threaded rustc host use `wasmtime-threads` (v46.0.3); see `docs/decisions.md`.

## 7. Risk triggers (stop and re-plan)

- **WP-05 needs > 4 sessions:** consider the Emscripten host instead (proven by Cloudflare), and update §1.
- **WP-19 overhead is > 5× native:** move to the batched or typed-resource bridge before WP-20.
- **WP-22 is stuck below 80% after 3 sessions:** re-scope v1 to curated crates.
- **Peak memory exceeds 4 GB on common crates:** add a memory64 build (new WP) or rely on the L2 cache only.
- **wasmtime v46 (`wasmtime-threads`) stops working with our rustc.wasm, or a newer wasmtime is needed:** add a WP before WP-18 to build a Node-based threaded host that reuses the browser's worker thread shim (or adopt WAMR).
