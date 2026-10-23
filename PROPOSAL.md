# Proposal: A Full-Featured Rust IDE That Runs in the Browser

*2026-10-23 · builds on `REPORT.md`*

---

## 1. Summary

We propose a **local-first Rust IDE that runs entirely in a browser tab**. It would offer real rustc, real crates.io dependencies, proc macros, rust-analyzer, tests and debugging, with **no build server**. The only server is a static CDN that hosts the toolchain and a shared cache of prebuilt crates.

**Why now**
- **Proof of feasibility.** rustc plus wasm-ld already run in a tab (rubrc, rust-wasm-serve), and dependencies plus proc macros already work on Cloudflare Workers (danlapid/rust-playground).
- **Standard plumbing.** WASI 0.3 (ratified 2026-06-11), the `wasm32-wasip3` target, JSPI and Wasm exception handling now ship in all major engines. They let us replace each project's one-off hacks with standard interfaces.
- **Upstream alignment.** Rust's 2026 goals push the same way: Wasm components, the parallel front end, Relink-Don't-Rebuild, and sandboxed proc macros and build scripts.

**Headline targets.** These are design goals to validate in Milestone 0, not measured results.

| Target | Goal |
|---|---|
| Editor usable on first visit | < 2 s |
| Full IDE features ready, first visit | < 15 s (streamed in the background) |
| Diagnostics after a keystroke | < 300 ms (rust-analyzer) |
| `cargo check` on the user's crate, warm | < 1 s |
| Edit → run for a small binary, warm | < 2 s |
| Typical project memory | < 1.5 GB in total |
| Top 500 crates build or load from cache | > 95% |

---

## 2. Goals, non-goals and principles

**Goals**
- Real `rustc` and Cargo semantics: workspaces, features, dev-dependencies, editions, `check/build/run/test`.
- crates.io dependencies, proc macros and most build scripts working out of the box.
- Full rust-analyzer: completion, go-to-definition, inlay hints, macro expansion, refactors.
- Works offline after the first visit, and the project survives reloads.

**Non-goals for v1**
- Native targets as runnable output. We compile to Wasm only; cross-compiling to native for download is a later stretch.
- Crates that need system libraries (OpenSSL, GTK) or a C toolchain beyond clang-in-Wasm.
- Fast release builds of large applications. They will work, just slowly.

**Design principles**
1. **Never block the UI thread.** Every tool runs in a worker, and the editor stays at 60 fps during a cold build.
2. **Cache everything, share what is deterministic.** The compiler is one fixed Wasm binary, so a built crate is identical for every user. Artifacts are keyed by content hash and served from a CDN.
3. **Do the least work per keystroke.** Prefer rust-analyzer, then `check`, then `build`, then run. Only the user's own crates are compiled interactively.
4. **Load lazily.** The editor comes first. rust-analyzer, rustc, LLVM, the linker, clang and the debugger stream in by priority and are cached in OPFS (the browser's private file storage).
5. **Use standard interfaces at the seams.** Tools meet through WIT interfaces (the component model's interface language) and WASI. No ad-hoc argv and fake-filesystem glue.
6. **Stay close to upstream.** Keep rustc patches small. Getting rustc accepted upstream as a Tier 3 Wasm host is itself a project goal.

---

## 3. Feature scope

| Area | v1 | v2 | v3 |
|---|---|---|---|
| Editor | Monaco or CodeMirror 6, file tree, tabs, search, diff, Vim/Emacs keymaps | Split panes, multi-cursor refactors | Plugin API (Wasm components) |
| Code intelligence | rust-analyzer: completion, hover, go-to, inlay hints, diagnostics, rename, assists, proc-macro expansion | Call hierarchy, "expand macro" view | Live Clippy, `cargo fix` quick fixes |
| Projects | Workspaces, features, `Cargo.lock`, import from GitHub or zip | Git clone/commit/push via the GitHub API | Private registries, git dependencies |
| Dependencies | crates.io, prebuilt cache, proc macros, sandboxed build scripts | Build scripts that compile C via clang-in-Wasm | `-sys` crates with vendored C |
| Build | `check`, `build` (dev), `clippy`, rustfmt | Release profile, LTO | Cross-compile to native targets for download |
| Run | xterm.js terminal with stdin, args, env, files; Miri mode | Web app preview pane with hot reload | Threaded programs, simulated networking |
| Test | `cargo test` with a test explorer, doc tests | Benchmarks with charts | Coverage overlays |
| Debug | Symbolized panic backtraces | Breakpoints and stepping via DWARF (DevTools extension or a DAP adapter) | Record/replay (time-travel) debugging |
| Collaboration | Read-only snapshot links | Live multi-user editing (CRDT), shared terminals | Classroom mode, embeddable playgrounds |
| Docs | Hover docs | Offline rustdoc for dependencies | — |

---

## 4. Architecture

```
┌──────────────────────────── Browser tab (cross-origin isolated: COOP/COEP) ───────────────────────────┐
│ UI thread: editor · file tree · terminal (xterm) · test explorer · preview pane     (never blocks)     │
│      │ LSP                       │ build/run requests                     │ stdout/stdin               │
│ ┌────▼──────────────┐   ┌────────▼───────────────────────────────────┐   ┌▼──────────────────────────┐ │
│ │ rust-analyzer     │   │ Orchestrator worker  (jco host, WASI 0.3)  │   │ Run sandbox worker        │ │
│ │ worker (Wasm)     │   │  • cargo resolver + build planner          │   │ user program as a         │ │
│ │ in-memory DB      │   │  • vfs component (OPFS-backed)             │   │ wasip3 component, no net  │ │
│ └────┬──────────────┘   │  • cache component (OPFS L1 ↔ CDN L2)      │   │ or Miri for snippets      │ │
│      │                  │  • build-script host (capability-scoped)   │   └───────────────────────────┘ │
│      │                  └──┬───────────────────┬────────────────┬───┘                                 │
│      │      WIT compile()  │      WIT link()   │                │ WIT run()                           │
│      │       ┌─────────────▼───────────┐  ┌────▼───────────┐ ┌──▼───────────────────────┐             │
│      │       │ rustc compile server    │  │ wasm-ld worker │ │ build.rs components      │             │
│      │       │ core Wasm, wasip1-threads│  └────────────────┘ │ (OUT_DIR only)           │             │
│      │       │ N workers share memory  │                      └──────────────────────────┘             │
│      │       │  └─ proc-macro components (in-worker, no I/O)                                           │
│      └──────►│ shared: VFS · .rmeta · proc-macro .wasm                                                 │
│              └─────────────────────────┘                                                              │
└───────────────────────────────────────────────┬───────────────────────────────────────────────────────┘
                                                │ fetch (only static assets)
               ┌────────────────────────────────▼──────────────────────────────────┐
               │ CDN: toolchain .wasm (brotli) · sysroot · prebuilt rlib/rmeta     │
               │      · proc-macro components · crates.io mirror (CORS)            │
               └───────────────────────────────────────────────────────────────────┘
```

**Why this split**
- **rustc stays core Wasm.** The component model doesn't support parallel threads yet, and rustc needs them. It is wrapped in a WIT facade, so it can become a component later without touching the rest.
- **Proc macros and build scripts are components.** They are the parts where sandboxing, portability and CDN-sharing pay off most.
- **rust-analyzer and rustc share one VFS** plus the same `.rmeta` files and proc-macro artifacts. Nothing is parsed or built twice.

---

## 5. Key subsystems

### 5.1 Compiler core
- rustc with the LLVM backend and lld/wasm-ld. We build it for `wasm32-wasip1-threads`, so it gets real threads via SharedArrayBuffer. It is built with `panic=unwind` and Wasm exception handling, so a compiler error or crash never forces a reload.
- We start from the existing patch sets: bjorn3's `compile_rustc_for_wasm` branch, oligamiq's `rust_wasm` builds, and Cloudflare's 7 patches. We merge them into one small, documented series. It covers three things:
  - in-process linking
  - proc macros loaded as Wasm
  - metadata read a page at a time instead of mmap (std's metadata alone is 75 MiB)
- LLVM is built with only the WebAssembly target, which reduces download size.
- rustc runs as a long-lived **compile server**: one instance handles many requests, keeping sysroot metadata and query caches warm.

### 5.2 Cargo and dependencies
- A resolver built from Cargo's resolver crates where practical, otherwise a port that keeps Cargo's semantics. It handles semver, features, optional and renamed dependencies, `cfg` targets and `Cargo.lock`.
- Index and crate downloads use async `wasi:http`, mapped to `fetch`, with a CORS mirror if needed. Resolution, downloads and leaf compiles overlap in a pipeline.
- **Two-level cache keyed by content hash.** L1 lives in OPFS on the device; L2 is a CDN cache shared by everyone. The key covers `rustc.wasm`, the source, features, flags and dependency hashes. We prebuild the top ~2,000 crates in common feature combinations.

### 5.3 Proc macros as Wasm components
- Each proc-macro crate compiles to a component (`wasm32-wasip3` now, `wasm32-component` later). It exports a WIT world that mirrors `proc_macro::bridge`: token streams and spans become WIT resources.
- It runs in the compiler's worker as a direct synchronous call, for speed. In strict mode it runs in a separate worker, with JSPI pausing rustc while it waits.
- Macros get no WASI imports by default. File access (for `include_str!`-style macros) must be granted per crate.
- The same artifact serves rust-analyzer's proc-macro server, and the CDN cache stores it as a target-independent file.

### 5.4 Build scripts
- `build.rs` compiles to `wasm32-wasip3` and runs with tightly limited access:
  - read-only access to its crate
  - read/write access to `OUT_DIR`
  - Cargo's environment variables
  - a `toolchain.run` import in place of `std::process::Command`
- `rustc -vV` style probes (`autocfg`, `rustversion`, `libc`) are answered by the warm compile server.
- `cc` builds route to clang-in-Wasm (v2). Scripts that fail in the sandbox fall back to a curated override list of prebuilt outputs for known crates.

### 5.5 rust-analyzer
- Compiled to Wasm in its own worker and speaking LSP to the editor. rubrc and ink! playground show this works.
- It reads the same VFS, `.rmeta` files and proc-macro components as the compiler, and keeps its database for the whole session.

### 5.6 Run, test and debug
- User binaries compile to `wasm32-wasip3` components and run under jco in a sandbox worker with no network. The terminal is wired to stdin and stdout.
- `cargo test` runs the same way, and its JSON output feeds the test explorer.
- **Miri mode**: instant start for snippets, and it detects undefined behaviour.
- Debugging (v2): DWARF in Wasm. The first path is Chrome DevTools' DWARF support; a DAP adapter on top of it powers our own breakpoint UI.

---

## 6. Performance strategy and budgets

These numbers are targets to validate in M0.

| Stage | Budget | How |
|---|---|---|
| Editor interactive (cold) | < 2 s | Editor bundle only (~2–3 MB); everything else loads later |
| rust-analyzer ready | < 6 s cold, < 1 s warm | Streaming compile of the `.wasm` (`WebAssembly.compileStreaming`); compiled module cached; prebuilt sysroot metadata |
| Toolchain ready | < 15 s cold, < 1 s warm | rustc + LLVM (wasm target only) + lld, brotli; fetched while the user reads code; OPFS cache |
| Keystroke → diagnostics | < 300 ms | rust-analyzer incremental DB; `check` debounced to idle |
| `cargo check`, user crate (warm) | < 1 s | Warm compile server; dependencies as cached `.rmeta`; incremental dir in OPFS |
| Edit → run, small binary (warm) | < 2 s | Dev profile, `-O0`; dependencies prebuilt; link in a separate worker. Cloudflare reports ~2 s round trips with server-side caching |
| First build, 10 common deps | < 10 s | CDN hits for prebuilt crates; only misses compile locally, in parallel workers |
| Memory | < 1.5 GB total | wasm32 (≤ 4 GB per instance); page-at-a-time metadata; memory64 build only as fallback (costs 10–100%) |

**Main levers, in order of impact**
1. **Never compile what someone else already compiled.** The global content-addressed cache covers dependencies, proc macros and the sysroot.
2. **Keep everything warm.** One long-lived rustc, rust-analyzer and linker instance each; compiled Wasm modules cached; no re-instantiation per command.
3. **Parallelism.** Parallel crate builds across workers, plus codegen units and later the parallel front end inside rustc. SharedArrayBuffer is the reason for cross-origin isolation.
4. **Do less per edit.** Incremental compilation persisted in OPFS. Adopt upstream Relink-Don't-Rebuild when it lands.
5. **Avoid copies at the seams.** VFS buffers shared between workers. The component model's lazy-lowering ABI for token streams.

**Overall budget:** ~60–80 MB brotli for the full toolchain on first visit, against rust-wasm-serve's ~56 MB for rustc plus sysroot. It is fetched in priority order and cached forever.

---

## 7. Platform requirements

| Requirement | Chrome | Firefox | Safari | Used for |
|---|---|---|---|---|
| Threads + SharedArrayBuffer (COOP/COEP) | 74 | 79 | 14.1 | Parallel rustc, LLVM, crate builds |
| Exception handling (exnref) | 137 | 131 | 18.4 | rustc `panic=unwind`; user panics |
| JSPI | 137 | 153 | 27 | Sync rustc ↔ async I/O; out-of-worker proc macros |
| OPFS sync access handles | yes | yes | yes | Fast persistent VFS in workers |
| Memory64 | 133 | 134 | TP only | Fallback build for huge crates |
| Native components | ✗ | ✗ | ✗ | Not required; jco transpiles |

The minimum is the current release of each engine. Safari needs 27 or later for JSPI; without it, proc macros fall back to in-worker mode only.

---

## 8. Roadmap

| Milestone | Duration | Scope | Exit criteria |
|---|---|---|---|
| **M0: Feasibility spikes** | 6 weeks | Merged rustc patch series; proc-macro WIT bridge prototype (`serde_derive` native + browser); OPFS VFS; size/latency baseline | `serde` derive expands in-browser; ≤ 2× native expansion time per macro call; measured budgets for §6 |
| **M1: Playground+** | 3 months | Single crate + crates.io deps, prebuilt cache, proc macros, run in terminal, rust-analyzer | Top-100 crates compile or load from cache; warm edit→run < 3 s |
| **M2: Real projects (v1)** | 4 months | Workspaces, build scripts as components, `cargo test` explorer, Clippy/rustfmt, offline mode, GitHub import | Top-500 crates > 95%; v1 budgets met on a mid-range laptop |
| **M3: Debug & preview (v2)** | 4 months | DWARF debugging, web preview with hot reload, clang-in-Wasm, collaboration | Breakpoints work; Leptos/Yew app previews live |
| **M4: Upstream & ecosystem** | ongoing | Upstream rustc-as-Wasm-host (Tier 3), proc-macro WIT world as an RFC, move rustc to a component when shared-everything threads ship | Patches upstream; no fork per release |

A team of 3–4 engineers plus part-time infrastructure is enough to reach M2 in about 9 months. The biggest single task is the rustc patch series and keeping it current with the six-week release train.

---

## 9. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| rustc patches drift every 6 weeks | High: blocks upgrades | Small patch series, CI against nightly, push upstream Tier 3 early |
| Proc-macro calls across the Wasm boundary are slow | Medium | Batch bridge calls; in-worker direct calls; lazy-lowering ABI; measured in M0 |
| Some crates exceed memory (e.g. `zerocopy` ≈ 300 MiB is fine; large generated crates may not) | Medium | Always serve these from the prebuilt cache; memory64 fallback build |
| First-visit download (60–80 MB) | Medium | Editor first, toolchain streamed while the user reads; service worker cache |
| COOP/COEP breaks embedding third-party content | Low–medium | Preview pane served from a separate isolated origin |
| crates.io CORS or rate limits | Medium | Our own mirror and CDN; respect crates.io's crawler policy |
| Build scripts that need a C toolchain or network | Medium | clang-in-Wasm (v2); override list; clear error with the failing capability named |
| Safari lags (memory64, multi-memory) | Low | Not required for v1 |

---

## 10. Open decisions and next steps

**Decisions needed**
1. **Editor:** Monaco (VS Code parity, heavier) or CodeMirror 6 (lighter, faster on mobile). Recommendation: **CodeMirror 6**, for the load-time budget.
2. **Compiler host ABI:** stay on `wasip1-threads`, as recommended (proven, gives threads), or Emscripten, which Cloudflare uses and gives a fuller libc.
3. **Output target for user programs:** `wasm32-wasip3` components (standard, async) or Emscripten (a fuller std today).
4. **Hosting model:** pure static CDN, or also an optional server-side warm cache like Cloudflare's for cache misses.

**Next steps (M0, the first two weeks)**
- [ ] Reproduce rust-wasm-serve locally and record cold/warm timings in Chrome, Firefox and Safari.
- [ ] Compile `serde_derive` to `wasm32-wasip3` and implement a minimal WIT proc-macro bridge with a wasmtime host.
- [ ] Same component called from a browser worker, jco vs hand-written bindings: ms per expansion.
- [ ] Prototype the OPFS-backed VFS shared between two workers.
- [ ] List the build scripts of the top 100 crates and classify them: pure Rust / runs rustc / needs C / needs network.
