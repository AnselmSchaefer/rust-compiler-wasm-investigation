# Sysroot packaging and peak memory (WP-08)

*2026-10-24. Our rustc 1.99.1 host (wasm32-wasip1-threads, panic=unwind, exnref) in Chromium (Playwright 1.64.1), on the WP-11 VFS + WASI adapter. Raw data: `bench/results/2026-10-24-e270603-sysroot-memory.json`. Reproduce: `scripts/verify/wp-08.sh`.*

## Sysroot asset

rustup's `rust-std-wasm32-wasip1` 1.99.1, unchanged, packaged by `toolchain/package-sysroot.mjs` (brotli quality 9, sha256 manifest):

| Group | Files | Raw | Brotli | Needed for |
|---|---|---|---|---|
| meta (`.rmeta`) | 27 | 80.5 MiB | 21.7 MiB | type checking and codegen |
| link (`.rlib`, `self-contained/`) | 31 | 23.5 MiB | 6.5 MiB | linking only (fetch on first link) |

Loading it on localhost: meta 388 ms, link 161 ms (fetch + decompress + VFS write). In the VFS: 113 MiB with meta, 137 MiB with both.

## Peak Wasm memory of rustc (3 runs each, max of the instance's memory)

| Step | Peak | Warm time | First run |
|---|---|---|---|
| check hello (`--emit=metadata`) | 102 MiB | 65–73 ms | 424 ms |
| codegen hello (`--emit=obj`) | 139 MiB | 157–211 ms | 441 ms |
| check medium (lib) | 111 MiB | 218–231 ms | 533 ms |
| codegen medium | 189 MiB | 624–666 ms | 758 ms |
| codegen medium `-O` | 168 MiB | 2084–2178 ms | 2856 ms |

The memory is the rustc instance's own; the VFS (sysroot + sources) is a separate shared memory of 113–137 MiB. For comparison, the WP-02 baseline (oligamiq 1.83) used 108–360 MiB per step and 447 ms for check-hello.

**WP-08 target met without lazy metadata:** hello peaks at 139 MiB, under 300 MB. danlapid's paged-metadata patch (D-0007) is therefore not used; it's also LLM-generated (see `docs/patches.md`). A full `.rmeta` read per crate is fine at this size. If memory becomes a problem later (big dependency graphs, WP-22), revisit with a human-written change.

Linking in the browser (wasm-ld.wasm on the VFS) is WP-12, so "build hello" here stops at the object file.
