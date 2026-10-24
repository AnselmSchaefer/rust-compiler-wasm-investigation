# IDE footprint: download size and memory (2026-10-24)

*The IDE from `app/` (WP-14) with toolchain release `1.99.1-f501aa64fd28`, in Chromium, on localhost.*

## 1. Download size

Measured on the built files (`build/www/app/`, `build/release/1.99.1-f501aa64fd28/`), brotli quality 11 (what a CDN would send):

| What | When it loads | Brotli (over the wire) | Uncompressed |
|---|---|---|---|
| App: page, CSS, `main.js`, 3 workers, `vfs.wasm` | first paint | **~0.26 MB** | 1.0 MB |
| rustc (`rustc.wasm`) | right after the editor appears | 19.0 MiB | 136.1 MiB |
| Sysroot metadata (`.rmeta`, tar) | with rustc | 18.8 MiB | 80.5 MiB |
| Linker (`lld.wasm`) | first Run | 10.1 MiB | 63.3 MiB |
| Sysroot link files (`.rlib`, crt, libc, tar) | first Run | 5.6 MiB | 23.6 MiB |

- **Editor:** ~0.26 MB, so it appears quickly even on a slow connection (interactive at ~200 ms cold on localhost, `tests/e2e/app.spec.ts`).
- **Ready for Check:** ~38 MiB. **First Run:** ~16 MiB more, **~54 MiB in all**.
- **Later visits:** the toolchain comes from Cache Storage, keyed by RUSTC_ID (0.84 s instead of 2.6 s to load, WP-12).
- For comparison, the WP-02 baseline (oligamiq) shipped 41.9 MiB, without a linker.

App files, measured one by one (KB = 1024 bytes):

| File | Raw | gzip -9 | brotli -11 |
|---|---|---|---|
| `index.html` | 737 B | 404 B | 257 B |
| `main.css` | 6.3 KB | 2.4 KB | 1.8 KB |
| `main.js` (CodeMirror + Rust grammar + xterm.js, minified) | 837 KB | 250 KB | 211 KB |
| `orchestrator-worker.js` | 19.1 KB | 7.4 KB | 6.8 KB |
| `process-worker.js` | 14.8 KB | 4.9 KB | 4.5 KB |
| `sandbox-worker.js` | 16.1 KB | 5.4 KB | 5.0 KB |
| `vfs.wasm` | 93.3 KB | 32.7 KB | 27.2 KB |

**Open issue:** `scripts/build-app.mjs` doesn't write `.br` copies of the app files, so the dev server (`pnpm demo`) sends them uncompressed (1.0 MB instead of ~0.26 MB). The toolchain files are compressed. A CDN usually compresses on its own; locally it's a one-line fix in `build-app.mjs`. A further option: load xterm.js only after the editor is up, to shrink `main.js` (not needed at ~200 ms to an interactive editor).

## 2. Memory while working

*Chromium (Playwright 1.64.1, headless, new context), the IDE from `app/` with release `1.99.1-f501aa64fd28`, localhost. Browser memory = **PSS** summed over all Chromium processes (shared pages counted once). Raw data: `bench/results/2026-10-24-1bb5871-app-memory.json`. Reproduce: `PW_PORT=8790 pnpm exec playwright test tests/e2e/app-memory.spec.ts --project=chromium`.*

| Step | Browser PSS | Peak during the step | VFS | rustc instance |
|---|---|---|---|---|
| Blank page (Chromium itself) | 161 MiB | | | |
| Editor up, toolchain still loading | 345 MiB | | | |
| Toolchain ready | 836 MiB | 892 MiB | 113 MiB | 15 MiB |
| Check hello | 951 MiB | 952 MiB | 113 MiB | 102 MiB |
| Run hello (first link: lld + link sysroot) | 1163 MiB | 1204 MiB | 138 MiB | 139 MiB |
| Program running, waiting for input | 1240 MiB | | 141 MiB | 139 MiB |
| Check medium (560 lines) | 1257 MiB | 1284 MiB | 141 MiB | 139 MiB |
| Run medium | 1304 MiB | 1321 MiB | 143 MiB | 160 MiB |
| After 20 edit + check cycles | 1158 MiB | 1354 MiB | 143 MiB | 160 MiB |
| After 5 edit + run cycles | 1214 MiB | 1368 MiB | 146 MiB | 160 MiB |

**Working set: about 1.2–1.3 GiB, peak 1.37 GiB**, about 1.05–1.2 GiB above an empty page. It levels off: 20 checks and 5 runs on top don't grow it (the drop after the checks is V8 garbage-collecting).

Where it goes (estimated; Chromium's `measureUserAgentSpecificMemory` isn't available here):
- **VFS: 113 → 146 MiB.** The sysroot (80.5 MiB of `.rmeta`, then 23.6 MiB of `.rlib`/libc for linking), sources and outputs. It only grows (a WebAssembly memory can't shrink).
- **rustc's instance: 15 → 160 MiB.** The compile server's memory, also grow-only, reused by every compile. This is the "peak per compile" of WP-08, kept.
- **Compiled machine code** of rustc.wasm (136 MiB of Wasm) and, after the first link, lld.wasm (63 MiB). This is most of the rest, roughly 400–600 MiB together (V8 keeps both a baseline and an optimized tier for hot functions).
- **Transient:** lld's own instance during a link and the sandbox's instance while a program runs (small for these programs), plus downloaded bytes until V8 collects them. Peaks are 20–200 MiB above the settled values.

For comparison, WP-02's baseline (oligamiq rustc 1.83, no linker, RSS rather than PSS) used 0.85–2.0 GiB.

Possible reductions, not done: drop the lld module after a quiet period (its code is the largest single item after rustc's), make the link sysroot group lazy per crate, and give the VFS a smaller initial size. A large dependency graph (WP-22) will mostly grow the VFS and rustc's instance.
