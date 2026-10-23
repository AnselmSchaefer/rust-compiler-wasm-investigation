# Compiling Rust in the Browser: State of the Art (Oct 2026) and What WASI / Components Could Add

*Investigation date: 2026-10-23*

---

## 1. TL;DR

- **It works today.** Real `rustc` (LLVM backend) plus `wasm-ld` compiled to WebAssembly runs in a browser tab. You download roughly 56 MB of assets, and a small program builds in about 1–3 s at `opt-level=0` (rust-wasm-serve, rubrc). One project, on Cloudflare Workers, also handles crates.io dependencies, build scripts and proc macros, with a warm round trip of about 2 s.
- **None of the existing projects use the Component Model or WASI 0.2/0.3.** All of them use the legacy `wasip1` ABI, or Emscripten. They get around the missing OS features with one-off hacks: patched rustc, in-process linking, custom VFS layers, `posix_spawn` shims, and JSPI-based RPC.
- **What has changed in 2026:** WASI 0.3 was ratified on 2026-06-11, bringing native async, `stream<T>` and `future<T>`. `wasm32-wasip3` is now Tier 2 and is listed as stable from Rust 1.100. Jco supports P3. Exception handling and JSPI now ship in all three engines (Safari 27 added JSPI). Memory64 is in Chrome and Firefox; Safari has it only in Technology Preview.
- **Where the new features help most.** Ranked by payoff:
  1. **Proc macros as portable, sandboxed Wasm components.** This is the biggest gap in browser toolchains and the best fit for components.
  2. **Build scripts as capability-scoped WASI P3 components.**
  3. **Each tool as a component, with "process spawn" replaced by component instantiation.** The tools are rustc, the linker, a cargo resolver and rust-analyzer. This replaces today's ad-hoc glue.
  4. **WASI 0.3 async plus JSPI** for crate fetching, OPFS persistence and cross-worker RPC.
  5. **Content-addressed, globally shared build caches.** These work well because a compiler running in Wasm is deterministic and platform-independent.
- **Where they don't help yet.** The Component Model has no *parallel* threads. P3's threads are cooperative, which gives concurrency but not parallelism. A fast compiler needs real parallelism: the parallel front end, codegen units and parallel crate builds. So **the compiler's core should stay a core-Wasm `wasip1-threads` module for now**, wrapped in component interfaces at the edges. Components should take over fully once shared-everything threads arrive.

---

## 2. Landscape: existing in-browser and near-browser Rust toolchains

| Project | What runs | Host ABI | Output target | Deps / proc macros | Notable tricks | Status |
|---|---|---|---|---|---|---|
| **bjorn3 / wasm-rustc** + **browser_wasi_shim** | Patched rustc built for `wasm32-wasip1-threads` | WASI p1 (JS shim) | wasm | none | Long-running `compile_rustc_for_wasm` branch; lld linked in as a library | The foundation the other projects build on |
| **oligamiq / rust_wasm** (prebuilt toolchain) | rustc (LLVM), LLVM/clang (from YoWASP), wasm-ld | `wasm32-wasip1-threads` | wasm32-wasip1, x86_64-linux-musl | — | Two builds, `panic=abort` and `panic=unwind` (`rustc_unwind.wasm`); Brotli-compressed assets | v3.0.0, rustc 1.83-dev |
| **rubrc** (oligamiq) | rustc, cargo, clang/LLVM, **rust-analyzer**, shell | WASI p1 + `wasi_virt_layer` (merges several p1 modules over one VFS, virtualizes threads) | wasm32-wasip1, x86_64-musl | Basic cargo; **no external deps, no proc macros** | Monaco + embedded RA LSP; xterm shell with pipes; tools dispatched as Wasm modules, not processes | v2 pre-release, "commands occasionally throw errors" |
| **rust-wasm-serve** | rustc + LLVM + lld (from oligamiq) | `wasm32-wasip1-threads` | `wasm32-wasip1-threads` | std only | ~56 MB assets (31 MB rustc + 25 MB sysroot); ~1 s load when cached; **1–3 s compile at O0**; needs Wasm EH (`panic=unwind`) and COOP/COEP | Demo |
| **Rubri** (LyonSyonII) | **Miri** (interpreter) compiled to Wasm | WASI p1 shim | none: interprets MIR | none | No linker or codegen at all | Experimental. Slow: 2000 prints take 2–3 s |
| **danlapid / rust-playground** (Cloudflare Workers, Oct 2026) | rustc 1.98.1 + lld built with **Emscripten**; Cargo resolver reimplemented in TS | Emscripten | `wasm32-unknown-emscripten` | **crates.io deps, build scripts and proc macros all work** | 7 rustc patches; **proc macros run in separate sandboxed isolates via rustc's own bridge protocol over RPC, paused with JSPI**; build scripts' `rustc` probes go through `posix_spawn` + JSPI; metadata read a page at a time (std metadata is 75 MiB) so rustc fits in 128 MB; content-addressed R2/edge cache ("compiled once, for everyone"); warm round trip ~2 s | Brand new. Runs on the edge rather than in the tab, but uses the same techniques |
| **ink! playground** and others | rust-analyzer compiled to Wasm | wasm-bindgen | — | — | IDE features only, no compilation | — |
| **play.rust-lang.org**, Godbolt, Replit | Native rustc on a server | — | native | full | — | Server-side |
| **StackBlitz WebContainers** | Node.js only | — | — | — | **No Rust support** | — |

**What this tells us**

1. rustc's code base has been shown to run under Wasm, with the patches kept fairly small. The CF project needed only seven.
2. Every project hits the same five host problems: **process spawning** (linker, build-script probes), **dynamic loading** (proc macros as `.so`), **mmap** (metadata, incremental cache), **threads**, and **memory**.
3. Each project solves them differently. This is exactly the integration work that the Component Model and WASI P2/P3 were designed to standardize, and nobody has used them for it yet.
4. Proc macros and dependencies are the difference between a toy and a real development environment. Only the CF project solves them, and only because Workers can spin up sandboxed isolates and pause with JSPI.

---

## 3. Anatomy of the problem

```
 user code ─► cargo (resolve, fetch, plan)
               │
               ├─► build.rs  ── compile → run (needs: env, OUT_DIR fs, often spawns `rustc -vV`)
               ├─► proc-macro crates ── compile → dlopen() into rustc  ← biggest blocker
               └─► rustc ── parse/expand/typeck/borrowck (parallelizable front end)
                           └─► codegen (LLVM; CGUs in parallel threads)
                                └─► linker (separate process: wasm-ld / lld)
                                     └─► run output (needs a runtime: WASI shim / jco)
 rust-analyzer ── same crate graph, same proc macros (proc-macro-srv is a separate process!)
```

**Browser constraints, and the standard feature that addresses each one**

| Constraint | Today's workaround | Standard 2026 feature |
|---|---|---|
| No processes | In-process lld; tool dispatch tables (rubrc); `posix_spawn` → host (CF) | **Component instantiation** as "exec"; WIT `run(args, env, fs) -> exit-code` |
| No `dlopen` for proc macros | Unsupported (most projects), or isolate + RPC (CF) | **Proc macro = Wasm component** with a WIT version of `proc_macro::bridge` |
| Sync code needs async browser APIs (fetch, OPFS, cross-worker RPC) | SharedArrayBuffer + `Atomics.wait` spin; JSPI (CF) | **JSPI** (all engines as of Safari 27 / Firefox 153), **WASI 0.3 async** at component boundaries |
| No mmap; limited memory | Read metadata a page at a time (CF) | `wasi:filesystem` streams; memory64 if needed |
| Threads | `wasm32-wasip1-threads` + SAB + COOP/COEP | Same for now. Components get cooperative threads first; shared-everything threads later |
| Panics and fatal errors in rustc | `panic=unwind` build using Wasm EH | **Exception handling (exnref)**, part of Wasm 3.0 and now in every engine |
| 4 GB address space | Fits most crates (CF: worst case `zerocopy` ≈ 300 MiB) | **Memory64**: Chrome 133+, Firefox 134+, Safari TP only. Costs 10–100% |

---

## 4. Platform status in October 2026

### Engine features relevant to a compiler host
(Source: the webassembly.org `features.json`, pulled today)

| Feature | Chrome | Firefox | Safari | Why it matters |
|---|---|---|---|---|
| Threads + atomics | 74 | 79 | 14.1 | Parallel rustc and LLVM (needs COOP/COEP) |
| Exception handling (exnref) | 137 | 131 | 18.4 | rustc built with `panic=unwind`; `catch_unwind` in the driver; user programs with unwinding |
| **JSPI** | 137 | 153 | **27** | Sync rustc ↔ async browser (OPFS, fetch, proc-macro RPC) |
| Memory64 | 133 | 134 | flag (TP 251) | Compiling huge crates or LTO beyond 4 GB |
| Multi-memory | 120 | 125 | ✗ | Lowering multi-module components into one core module |
| Tail calls | 112 | 121 | 18.2 | Minor |
| GC | 119 | 120 | 18.2 | Not needed for Rust |
| Stack switching | flag | ✗ | ✗ | Future replacement for JSPI and Asyncify; coroutine-style tool hand-off |
| Native Component Model | ✗ (V8 evaluating) | ✗ (Mozilla prototyping) | ✗ | Today you need `jco transpile`. Native support would remove the JS glue |

### WASI and Component Model
- **WASI 0.3.0, ratified 2026-06-11.** Async, `stream<T>`, `future<T>` and cancellation are now built into the Component Model, and the host runs a single event loop for all components. Wasmtime 46 enables it by default. Jco supports it.
- **Component Model 1.0 roadmap (2026-06-08).** Key items:
  - A lazy-lowering ABI: callees return handles instead of eagerly calling `cabi_realloc`, which matters for large token streams and file buffers.
  - Near-zero-cost synchronous cross-component calls.
  - A `lower-components` tool that uses multi-memory to flatten a component into one core module.
  - **Cooperative threads in P3 follow-up releases.**
  - Browser vendors are being shown evidence of ~2× gains on DOM-heavy work from direct Web API calls.

### Rust targets
- `wasm32-wasip3`: **Tier 2**, listed as stable from 1.100. Needs LLVM 23+ and wasi-sdk-34. `std::thread` is "WIP, expected by end of 2026".
- `wasm32-wasip2`: Tier 2.
- `wasm32-wasip1-threads`: Tier 2. The only target with working `std::thread` today.
- `wasm32-component` was approved as Tier 3 via MCP (compiler-team#948): a bare component target, `core` + `alloc`, no WASI. `wasm32-component-web` is planned as Tier 3 too. Both are part of the accepted 2026 "Wasm Components" project goal.

### rustc performance work that changes the picture
The 2026 "Fast Builds" goals include:
- Parallel front end stabilization
- **Relink-Don't-Rebuild**: avoid rebuilding downstream crates when only function bodies change
- A rethought incremental system that shares bases across invocations
- A 2× faster cg_clif backend
- The Wild linker

All of these are native-first, but several of them map onto a browser environment very well (see §5.7).

---

## 5. How WASI and components could improve a browser Rust environment

Ideas are ordered by expected payoff. Each one states what's new, why components or WASI are the right tool, and the caveats.

### 5.1 Proc macros as portable, sandboxed Wasm components (highest payoff)

**Problem.** Natively, rustc `dlopen`s a proc-macro `.so` built for the host. In a browser there is no `dlopen`, and the "host" is Wasm.

**Design.**
- Compile every proc-macro crate to a component (`wasm32-wasip3`, or later `wasm32-component`: the no-WASI target fits well, since a macro needs no I/O).
- Define a WIT world that mirrors `proc_macro::bridge`. The bridge is already a client/server protocol built on handles (`TokenStream`, `Span`, `Group`, `Ident`, `Literal`, `SourceFile`). Those handles map one-to-one onto **WIT `resource`s**. The CF playground shows the existing protocol works across an isolation boundary: "the protocol between rustc and the macro is rustc's own; only its bytes cross".
- rustc's patched proc-macro loader instantiates the component, either in the same worker (fast path) or in a sibling worker (isolation path). Then:

```wit
package rust:proc-macro@0.1.0;

interface bridge {
  resource token-stream { /* ... */ }
  resource span { source-file: func() -> string; /* ... */ }
  // host-provided callbacks that the macro calls back into rustc with
}

world proc-macro {
  import bridge;                     // rustc implements spans, symbol interning, diagnostics
  export expand: func(kind: macro-kind, name: string,
                      attr: option<token-stream>, item: token-stream)
                      -> result<token-stream, panic-message>;
  export list-macros: func() -> list<macro-decl>;
}
```

**Why this is a big win**
- **Built once, runs anywhere.** A proc macro component is target-independent, so `serde_derive@1.0.x` compiled once can be served from a CDN to every user and every browser. That avoids a large share of first-build time. The CF playground already gets much of this benefit from its global cache.
- **Sandboxed by construction.** No WASI imports means no I/O, matching the upstream pre-RFC ("Sandboxed, deterministic, reproducible, efficient Wasm compilation of proc macros"), dtolnay's `watt`, and the 2024 GSoC work.
- **rust-analyzer can reuse the same components.** RA's `proc-macro-srv` is normally a separate process, which doesn't exist in a browser. rubrc lists "no proc macros" as a limitation for exactly this reason.
- **Not browser-specific.** The same artifact could feed native sandboxed proc macros, so the work aligns with upstream instead of being a fork.

**Caveats**
- **Call overhead.** Token streams cross the boundary many times per expansion. Mitigations: batch the bridge calls (rustc already buffers them), and use the 0.3.x lazy-lowering ABI so the macro pulls data on demand.
- **Macros that read files** (`include_str!`-style crates, sqlx-style macros that talk to a DB) need explicit capability imports. That's a feature, not a bug.
- **Jco transpilation in the browser** adds JS glue on every call. Same-worker core-Wasm instantiation with a hand-written binding may be faster until browsers support components natively. Benchmark both (§7).

### 5.2 Build scripts as capability-scoped WASI P3 components

- Compile `build.rs` to `wasm32-wasip3`. Run it under a jco host that grants only:
  - read-only access to the crate source
  - read/write access to `OUT_DIR`
  - Cargo's env vars
  - an import that **runs a toolchain component** instead of `std::process::Command`
- This standardizes CF's `posix_spawn` → host → JSPI hack as a typed interface. The common `rustc -vV`/version probe (`autocfg`, `rustversion`, …) becomes a call into the already-loaded rustc component.
- With WASI 0.3, these calls are natively async, so the build script doesn't have to block a worker. JSPI is only needed inside code written synchronously.
- This matches the Cargo "sandboxed build scripts" project goal, which explicitly looked at WASI.
- **Limitation:** build scripts that compile C code (`cc` crate) would need clang as another component. rubrc already ships clang and LLVM in Wasm, and YoWASP builds clang.

### 5.3 Each tool as a component: replace "processes" with instantiation

Today rubrc and others use `wasi_virt_layer` to merge several p1 modules over a shared VFS and virtualize thread spawning. CF uses three Workers plus an RPC layer. The Component Model offers a standard version of the same thing:

```
┌───────────────────────────── Browser (cross-origin isolated) ─────────────────────────────┐
│ UI thread: editor (Monaco/CodeMirror), terminal (xterm)                                   │
│                                                                                            │
│ ┌─ Orchestrator worker (JS host / jco runtime, WASI 0.3 event loop) ─────────────────────┐ │
│ │  cargo-resolver.component   (index fetch via wasi:http → fetch(); async, streaming)     │ │
│ │  vfs.component              (wasi:filesystem impl; OPFS-backed, content-addressed)      │ │
│ │  cache.component            (CAS: rlibs, .rmeta, proc-macro .wasm; CDN + OPFS)          │ │
│ └───────────┬──────────────────────────────┬─────────────────────────────┬──────────────┘ │
│             │ WIT: compile(args, vfs) →     │ WIT: link(objs) → wasm       │ WIT: LSP msgs │
│ ┌───────────▼───────────────┐  ┌───────────▼───────────┐  ┌─────────────▼─────────────┐  │
│ │ rustc core (core wasm,    │  │ wasm-ld (component or │  │ rust-analyzer (own worker, │  │
│ │ wasip1-threads, N workers │  │ core module)          │  │ shares VFS + proc macros)  │  │
│ │ sharing SAB memory)       │  └───────────────────────┘  └───────────────────────────┘  │
│ │  └─ loads proc-macro components (5.1) in-worker                                       │ │
│ └───────────────────────────┘                                                            │
│ Run sandbox worker: user program as wasm32-wasip3 component (jco), stdout → terminal     │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

**What you gain**
- **Typed, versioned boundaries** instead of argv strings and shared fake filesystems.
- **Composition at build time or run time** (`wac plug`), and **WASI virtualization** with `wasi-virt` to embed a sysroot read-only into the rustc component.
- **One VFS component** that every tool imports. This removes the "who owns the filesystem" problem, and it can be backed by OPFS for persistence across reloads.
- **Swappable parts.** The codegen backend, the linker and the resolver can each be replaced without touching the others.

**Main caveat: threads.** Parallel rustc and LLVM need shared memory across workers today. Components don't support that yet (wasi-threads was never brought into the Component Model, and P3 threads are cooperative). So:
- Keep the rustc+LLVM core as a **core Wasm `wasip1-threads` module**.
- Give it **a thin component facade at the orchestrator boundary**. The orchestrator talks WIT; the core keeps its threads.
- Move it fully into a component when shared-everything threads land.

### 5.4 WASI 0.3 async plus JSPI: removing blocking hacks

- **Crate download and index resolution** become natively async streams (`wasi:http` → `fetch`). You can resolve, download and start compiling leaf crates in an overlapping pipeline instead of in serial phases.
- **OPFS persistence.** `FileSystemSyncAccessHandle` is synchronous in workers, so it fits rustc's sync I/O. For async paths (IndexedDB, cache API, fetch), JSPI lets the unchanged sync rustc code suspend. JSPI now ships everywhere (Firefox 153, Safari 27), so the SAB-plus-`Atomics.wait` spin-loop bridges are no longer needed.
- **Streaming diagnostics.** A `stream<diagnostic>` export from the compile interface means the editor gets errors while codegen is still running, not just when the process exits.

### 5.5 Running the output: target components, not raw p1

- Build user programs for `wasm32-wasip3` (or `wasip2`) and run them through jco in a sandbox worker. You get standard stdin/stdout/args/fs and clean exit codes without custom shims. CF instead gets "a real std" from Emscripten.
- Later, `wasm32-component-web` would let user programs call Web APIs directly without wasm-bindgen glue. That's useful for a browser IDE that previews web apps.
- **Mixed-mode execution.** For tiny snippets, offer Miri (as Rubri does): no codegen or link, instant start, UB detection. Switch to the real codegen path for anything compute-heavy.

### 5.6 Memory and robustness features of the Wasm engines

- **Exception handling.** Build the rustc host with `panic=unwind`. A compiler ICE or fatal error then unwinds to the driver, so the instance can be reused instead of re-downloaded and re-instantiated. It's now available everywhere. rust-wasm-serve and oligamiq already ship unwind builds.
- **Memory64.** Ship it as an *optional* second build, used only when a crate overflows 4 GB. Spidermonkey measured a 10–100% slowdown, Safari lacks it, and the JS API caps memories at 16 GB. Most crates fit easily: CF compiles typical examples in under 64 MiB, and its worst case is about 300 MiB.
- **Lazy metadata.** Adopt CF's page-at-a-time metadata reading in place of mmap. It makes a large difference to browser memory pressure and isn't tied to any particular Wasm feature.

### 5.7 Caching and incremental builds suited to the browser

- **Content-addressed artifacts.** The compiler is itself a fixed Wasm binary and its target is fixed, so the cache key is `hash(rustc.wasm, crate source, features, flags)`. Results are identical for every user on every OS, which makes a public CDN cache of rlibs and proc-macro components possible (CF already does this at the edge). Combine it with OPFS for a local L1 cache.
- **Prebuilt sysroot and popular crates.** Ship them as `.rlib` plus `.rmeta` for the dev profile, so a typical edit compiles only the user's crate.
- **Incremental compilation.** Persist rustc's incremental directory in OPFS through the VFS component. The 2026 Relink-Don't-Rebuild and incremental-redesign goals would directly cut browser rebuild times, because there the edit loop is dominated by compiling a single crate.
- **Skip the full link when developing (speculative).** Wasm already has a dynamic-linking convention (`dylink.0`, `-shared -fPIC` in wasm-ld/clang). Dependencies could stay pre-instantiated, with only the user crate's module rebuilt and relinked, much like `subsecond`-style hot patching. This needs an experiment: Rust has no stable ABI, but one fixed compiler version avoids that issue. Components are the wrong tool here, because WIT boundaries don't carry Rust's internal ABI.

### 5.8 Codegen backend choices

- **LLVM is the only rustc backend that emits Wasm.** Cranelift doesn't have a Wasm *output* target. cg_clif can run *inside* Wasm, but it would generate x86 or aarch64 code that the browser can't run.
- **Speculative:** Cranelift has a **Pulley** (portable bytecode interpreter) target, and Wasmtime uses it on unsupported hosts. A pipeline of cg_clif → Pulley bytecode → Pulley interpreter compiled to Wasm could give very fast "debug" builds with slower execution, sitting between Miri and LLVM. It hasn't been tried and would need cg_clif support for that target, so treat it as a research idea.
- **Pragmatic choice:**
  - LLVM at `-O0` with few codegen units, for interactive builds.
  - The browser's own baseline Wasm compiler (Liftoff or similar) then acts as your JIT. Nothing else is needed.
  - Rely on cached optimized dependencies.

---

## 6. Recommended architecture (summary)

1. **Core compiler.** Patched rustc+LLVM+lld as a **core Wasm `wasm32-wasip1-threads`** module: real parallelism, `panic=unwind` with EH, lazy metadata. Start from oligamiq's or bjorn3's work.
2. **Component shell around it.** An orchestrator that speaks WIT. A shared **VFS component** backed by OPFS. A **cargo resolver component** using async `wasi:http`. A **CAS cache component**.
3. **Proc macros and build scripts as components** with a standard WIT world. Prebuilt and CDN-cached where possible. Shared with an in-browser rust-analyzer.
4. **Output** as `wasm32-wasip3` components run through jco in a sandbox worker, with Miri as an instant-start alternative.
5. **Upgrade path.** Move the core into a component when shared-everything threads ship. Drop jco glue when browsers support components natively.

---

## 7. Experiments worth running (measurable and fairly cheap)

| # | Experiment | Measure | Expected insight |
|---|---|---|---|
| 1 | Compile `serde_derive` to `wasm32-wasip2/p3` against a minimal WIT proc-macro bridge, and call it from native rustc (wasmtime host) | Expansion time vs native `.so` on `serde_json` tests | Is bridge-call overhead acceptable? |
| 2 | Same component, transpiled with jco and called from a browser worker, compared with hand-written core-Wasm bindings | ms per expansion | Is jco glue fast enough, or is a custom binding needed? |
| 3 | Run `rust-wasm-serve`'s rustc with sysroot and incremental dir on OPFS vs in-memory | Cold/warm compile, memory | Value of persistent incremental compilation |
| 4 | Build a crate graph (e.g. `rand` + `serde`) in-browser: serial vs N workers vs prebuilt rlibs from a CAS | Time to first run | How much threads vs caching each contribute |
| 5 | Memory64 build of rustc vs wasm32 build | Compile time for a medium crate | Size of the memory64 cost for this workload |
| 6 | Build scripts (`autocfg`, `rustversion`, `libc`) as wasip3 components, with a `run-rustc` import | Success rate across the top 100 crates with build.rs | How much of the ecosystem works sandboxed |

All of these can be prototyped on this machine: rustc 1.98, Node 26 and the `wasm32-unknown-unknown` target are installed. You would still need to add `wasm32-wasip2`/`wasip3`, `wasm-tools`, `wasmtime` and `jco`.

---

## 8. Risks and open questions

- **Upstreaming.** Every working project carries rustc patches (bjorn3's branch, oligamiq, CF's 7 patches). Keeping up with rustc's six-week release train is the main maintenance cost. Getting "rustc as a Wasm host" upstreamed, even at Tier 3, would matter more than any one feature.
- **Download size.** ~56 MB compressed is fine after caching but hurts the first visit. Ways to cut it: strip LLVM down to the WebAssembly target only, use streaming compilation, and lazy-load rust-analyzer and clang.
- **Cross-origin isolation** (COOP/COEP) is required for threads, and it restricts embedding third-party content in the IDE page.
- **Component Model cost in browsers** without native support is unmeasured for chatty interfaces like proc-macro bridges. That's why experiments 1 and 2 come first.
- **Safari** lacks memory64 and multi-memory. JSPI only arrived in Safari 27.

---

## 9. Sources

Projects
- [bjorn3/browser_wasi_shim](https://github.com/bjorn3/browser_wasi_shim) · [bjorn3/wasm-rustc](https://github.com/bjorn3/wasm-rustc) · [rust-lang/miri#722: compiling rustc/Miri to Wasm (history and status)](https://github.com/rust-lang/miri/issues/722)
- [oligamiq/rubrc](https://github.com/oligamiq/rubrc) · [oligamiq/rust_wasm](https://github.com/oligamiq/rust_wasm) · [wasi_virt_layer](https://docs.rs/wasi_virt_layer)
- [rntz-llm/rust-wasm-serve](https://github.com/rntz-llm/rust-wasm-serve) · [LuvHakii/rust-wasm](https://github.com/LuvHakii/rust-wasm)
- [LyonSyonII/rubri (Miri in browser)](https://github.com/LyonSyonII/rubri) · [demo](https://garriga.dev/rubri/)
- [danlapid/rust-playground (rustc on Cloudflare Workers)](https://github.com/danlapid/rust-playground)
- [ink! playground architecture (rust-analyzer in Wasm)](https://github.com/use-ink/ink-playground/blob/main/ARCHITECTURE.md)
- [Wasmer: Running Clang in the browser](https://wasmer.io/posts/clang-in-browser)

Standards and platform
- [WASI 0.3 launched (Bytecode Alliance)](https://bytecodealliance.org/articles/WASI-0.3) · [WASI 0.3 release notes](https://wasi.dev/releases/wasi-p3)
- [The Road to Component Model 1.0](https://bytecodealliance.org/articles/the-road-to-component-model-1-0)
- [jco transpiling docs](https://bytecodealliance.github.io/jco/transpiling.html) · [wasi-virt](https://github.com/bytecodealliance/wasi-virt)
- [WebAssembly feature status](https://webassembly.org/features/) (raw `features.json` from the WebAssembly/website repo)
- [Is Memory64 actually worth using? (SpiderMonkey)](https://spidermonkey.dev/blog/2025/01/15/is-memory64-actually-worth-using.html)
- [JSPI Intent to Ship (Chromium)](https://groups.google.com/a/chromium.org/g/blink-dev/c/w_jCD4gf7Bc)
- [Wasm dynamic linking conventions](https://WebAssembly.org/docs/dynamic-linking)
- [Wasmtime: Using Pulley](https://docs.wasmtime.dev/examples-pulley.html)

Rust
- [wasm32-wasip3 target docs](https://doc.rust-lang.org/nightly/rustc/platform-support/wasm32-wasip3.html) · [wasm32-wasip1-threads](https://doc.rust-lang.org/nightly/rustc/platform-support/wasm32-wasip1-threads.html)
- [compiler-team#948: wasm32-component MCP](https://github.com/rust-lang/compiler-team/issues/948)
- [2026 project goal: Wasm Components](https://goals.rust-lang.org/2026/wasm-components.html) · [2026 Fast Builds roadmap](https://goals.rust-lang.org/2026/roadmap-fast-builds.html)
- [cg_clif progress report (June 2025)](https://lobste.rs/s/mbyz63/progress_report_on_rustc_codegen) · [Production-ready cranelift goal](https://goals.rust-lang.org/2025h2/production-ready-cranelift.html)
- [Sandboxed build scripts goal](https://rust-lang.github.io/rust-project-goals/2024h2/sandboxed-build-script.html) · [Pre-RFC: sandboxed Wasm proc macros](https://internals.rust-lang.org/t/pre-rfc-sandboxed-deterministic-reproducible-efficient-wasm-compilation-of-proc-macros/19359?page=3) · [watt](https://lib.rs/crates/watt)
