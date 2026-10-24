# Baseline benchmark: oligamiq rust_wasm v3 (WP-02)

Reference numbers for the existing prebuilt toolchain. Our own toolchain (WP-04 onwards) has to beat these.
Source: `bench/results/2026-10-24-c029d0d.json` (`pnpm bench --iters 5 --firefox`).

- **Toolchain:** oligamiq rust_wasm v3.0.0 `rustc_opt.wasm` (rustc 1.83.0-dev, panic=abort host, LLVM + lld in-process), `wasm32-wasip1` sysroot.
- **Browser host:** `@oligami/browser_wasi_shim-threads` 0.5.0 (patched, see below), with a fresh rustc instance for every invocation.
- **Browsers:** Chromium 156.0.8078.4 (required target) and Firefox 157.0 (best-effort), both Playwright 1.64.1 headless.
- **References:** wasmtime 46.0.3 (`wasmtime-threads`) running the same rustc.wasm, and native rustc 1.83.0 (same version).
- **Machine:** i5-11400H (12 threads), 15 GB RAM, Linux 7.2.8. Assets served from localhost.

## Cold load (Chromium)
| Metric | Value |
|---|---|
| Bytes on the wire (brotli: rustc.wasm + 30 sysroot files) | 41.9 MB (rustc 19.8 MB, sysroot 22.1 MB) |
| Uncompressed rustc.wasm | 95.4 MB |
| Fetch + decode, localhost | 1.02 s |
| `WebAssembly.compile(rustc.wasm)` | 0.11 s (Firefox: 0.55 s) |
| Total load, localhost | 1.15 s |
| Estimated download alone at 100 Mbit/s | 3.4 s |

Chromium's module compile is fast because it compiles lazily (Liftoff first). The cost moves into the first rustc runs, which is why `first` is up to 2× the median below.

## Compile steps
Median of 5 runs. Each run is a fresh rustc instance in the same page. "first" is the first run after load.
`check` = `--emit=metadata`; `build` = full compile + in-process link; `-O` = opt-level 3. `medium` is `bench/programs/medium.rs` (563 lines, std only).

| Step | Chromium median (first) | ×native | Firefox median | wasmtime median | native 1.83.0 median |
|---|---|---|---|---|---|
| version (`-V`) | 93 ms (98) | 4.2× | 101 ms | 664 ms | 22 ms |
| check-hello | 447 ms (910) | 12.1× | 452 ms | 733 ms | 37 ms |
| build-hello | 1010 ms (1196) | 6.4× | 938 ms | 857 ms | 157 ms |
| check-medium | 732 ms (1017) | 5.1× | 768 ms | 938 ms | 144 ms |
| build-medium | 1935 ms (1910) | 5.9× | 2206 ms | 1529 ms | 329 ms |
| build-medium-O | 4038 ms (4246) | 4.8× | 4281 ms | 3704 ms | 843 ms |
| run-hello | 1 ms (5) | — | 5 ms | 11 ms* | 8 ms* |
| run-medium | 6 ms (27) | — | 13 ms | 17 ms* | 18 ms* |

\* wasmtime and native "run" both execute the output with the `wasmtime` CLI, so process start dominates. Not comparable to the in-page numbers.
wasmtime's ~0.65 s floor is process start plus loading its cached compiled rustc (~730 MB RSS).

## Memory
| Step | Chromium wasm linear memory | Chromium browser peak RSS (all processes) | Firefox wasm memory | native max RSS |
|---|---|---|---|---|
| version | 25 MiB | 847 MiB | 25 MiB | 55 MiB |
| check-hello | 108 MiB | 1333 MiB | 108 MiB | 138 MiB |
| build-hello | 128 MiB | 1532 MiB | 127 MiB | 178 MiB |
| check-medium | 116 MiB | 1595 MiB | 116 MiB | 166 MiB |
| build-medium | 202 MiB | 1763 MiB | 203 MiB | 270 MiB |
| build-medium-O | 360 MiB | 2028 MiB | 374 MiB | 268 MiB |

`performance.measureUserAgentSpecificMemory` isn't exposed in Playwright's headless Chromium, so browser memory is the peak RSS of the browser process tree, sampled from `/proc` every 50 ms.

## What the numbers say
1. **Fixed overhead dominates small compiles.** `-V` takes 93 ms, but `check-hello` takes 447 ms (12× native). Loading the sysroot metadata (libstd/libcore, a 32 MB rlib) through the shim's bounce buffer into each fresh instance costs about 350 ms per invocation. Targets: lazy metadata (WP-08) and a persistent compile server that keeps metadata loaded (WP-09).
2. **Steady-state codegen is ~5–6× native** (build-medium, build-medium-O). That's in line with REPORT.md's expectations for Wasm with threads.
3. **The first compile after load is up to 2× slower in Chromium** (Liftoff → TurboFan tier-up). WP-28 should look at compile hints, a warm-up compile, or code caching (`compileStreaming` from the HTTP cache).
4. **Browser RSS keeps rising across runs** (847 MiB → 2 GiB), even though each rustc instance gets fresh memory. Old instances and their thread workers aren't released promptly (shim teardown or GC). A long-lived compile server (WP-09) avoids the churn, but WP-12 needs a memory soak test.
5. **Chromium and Firefox are within ~10% of each other** on compile steps. Firefox is no longer a target (2026-10-24) and is kept as a free data point only.
6. **At 100 Mbit/s, the download alone (3.4 s) costs more than a compile.** Size work in WP-10 and WP-28 matters as much as compile speed.

## Harness bugs found and fixed
- **`browser_wasi_shim-threads` 0.5.0: `path_rename` is a no-op when both paths share a directory fd.** rustc writes metadata to a temp dir and renames it into the output dir, so `--emit=metadata` and every `--crate-type lib` build failed with "failed to create encoded metadata from file". Fixed in `patches/@oligami__browser_wasi_shim-threads@0.5.0.patch`. Worth reporting upstream ([H]: posting upstream needs approval).

## Reproduce
```
pnpm bench [--iters N] [--firefox] [--no-native] [--rustc rustc_unwind_opt.wasm]
node bench/compare.ts bench/results/<old>.json bench/results/<new>.json
```
