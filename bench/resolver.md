# Resolver (WP-15)

*2026-10-24, this machine. `crates/resolver` against the pinned index snapshot (`tests/resolver/index-snapshot.tar.zst`), release build. Reproduce: `scripts/verify/wp-15.sh`.*

## Correctness

| Check | Result |
|---|---|
| Golden corpus, native (`crates/resolver/tests/golden.rs`) | **50/50** lockfiles byte-identical to cargo 1.99.1 |
| Golden corpus, wasm32-wasip1 under wasmtime | **50/50** byte-identical |
| Synthetic scenarios (`tests/scenarios.rs`) vs native cargo (`tests/resolver/check-scenarios.sh`) | **13/13** identical (backtracking, coexisting semver ranges, MSRV fallback ×4, missing feature, links, optional/weak ×3, rename + yanked, unsatisfiable) |

## Time per resolve (index files read from disk, parsed per resolve, no cache)

| Crate | Packages | Native | wasm32-wasip1 (wasmtime, precompiled) |
|---|---:|---:|---:|
| smallvec | 13 | 12 ms | 35 ms |
| serde_json | 47 | 38 ms | 87 ms |
| tokio | 161 | 118 ms | 199 ms |
| reqwest | 280 | 286 ms | 403 ms |
| sqlx | 364 | 325 ms | 462 ms |
| bevy | 792 | 568 ms | 768 ms |
| nu | 795 | 570 ms | 794 ms |

All 50 natively: 6.6 s. Most of the time is JSON-parsing every line of every index file the resolve touches (also versions that can never match). If it matters in the browser, parse lazily: read `vers` first and fully parse only lines whose version can match.

## Size

`generate-lockfile` example (resolver + toml + serde_json + cargo-util-schemas), wasm32-wasip1 release: 2,584 KiB, 423 KiB brotli-11.
