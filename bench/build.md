# `cargo build` in the browser (WP-17)

*2026-10-25, Chromium (Playwright), this machine. `tests/e2e/build.spec.ts`; raw numbers in `bench/results/*-build-w*.json`. Release 1.99.1-e6f1d21de137.*

Cold build: the toolchain is already loaded (init), but no build output is cached (WP-18 adds that). "deps" covers resolve, download and unpack, with crates from the network and the index from the local snapshot. "build" runs every unit and links.

| Case | Packages / units | Workers | Profile | deps | plan | build | total |
|---|---|---|---|---|---|---|---|
| serde_json (itoa, memchr, serde_core, zmij; 3 build scripts) | 12 / 12 | 4 | dev (debuginfo 2) | 721 ms | 37 ms | 10.1 s | **10.9 s** |
| serde_json | 12 / 12 | 1 | dev | 595 ms | 35 ms | 11.8 s | 12.5 s |
| serde_json | 12 / 12 | 4 | debuginfo 0 | 645 ms | 40 ms | 9.3 s | 10.0 s |
| mix (rand, regex, renamed serde_json; 4 build scripts) | 24 / 22 | 4 | dev | 742 ms | 20 ms | 10.9 s | **11.6 s** |
| mix | 24 / 22 | 1 | dev | 653 ms | 26 ms | 19.4 s | 20.1 s |
| mix | 24 / 22 | 4 | debuginfo 0 | 742 ms | 23 ms | 8.5 s | 9.3 s |

Native `cargo +1.99.1 build --target wasm32-wasip1` of the serde_json case, from clean (crates already downloaded): **2.6 s** with -j12 or -j4, 4.2 s with -j1. The browser is about 4× native with 4 workers.

## Where the time goes (serde_json, 4 workers)

The critical path is serial: serde_core's build script compile (~3.0 s) → run (~0.1 s) → serde_core lib (~4.8 s) → serde_json lib → bin + link. Four workers therefore help little here (12.5 → 10.9 s). They help a lot on the wider mix graph (20.1 → 11.6 s).

- Build-script compiles take ~2.7–3.0 s each, even with debuginfo 0. That's the codegen and wasm-ld link of a std-linked program, which is per script and the same every time: a prime target for WP-18's cache.
- Libraries: serde_core ~4.2–4.8 s, regex-syntax and regex-automata ~3.7–4.9 s each.
- `debuginfo=0` saves 10–20%. Cargo's dev profile stays the default (it's what the golden test checks); the profile is an input (`build` op `profile`), and the browser default can change once WP-18 measures cached builds.
