# Ecosystem matrix (WP-22)

**M1 (≥ 90% of the top 100 crates build in the browser): met on 2026-10-25, 96/100.** The other 4 fail natively for wasm32-wasip1 too. Table: `tests/ecosystem/results.md`.

## Method

- **List:** `tests/ecosystem/top100.json`, crates.io by downloads (API `sort=downloads`, fetched 2026-10-25), each crate at its newest stable version.
- **What "builds" means:** an empty lib that depends on `<name> = "=<version>"` with default features (`tests/ecosystem/wrappers.mjs`). Building it builds the crate and its dependencies as a user's project would, including build scripts and proc macros. The planner builds every unit when there's no bin.
- **Index:** one snapshot recorded through `tests/resolver/index-proxy.mjs` while the native baseline ran (`tests/ecosystem/index-snapshot.tar.zst`, 173 files, 517 KB). Native cargo and the browser resolve against the same files.
- **Native baseline** (`tests/ecosystem/native.sh record|replay`): `cargo +1.99.1 build --target wasm32-wasip1` of each wrapper. A crate that fails there is class `target`: the browser can't do better than cargo for the same target.
- **Browser** (`tests/e2e/ecosystem.spec.ts`, `ECO=1`): Chromium, 4 compile servers, one page per crate (a hung build costs only its own timeout, 10 min), L1 emptied once at the start and carried over between crates. Crates come from static.crates.io. `ECO_ONLY=a,b` runs a subset; `ECO_KEEP=1` keeps earlier results.
- **Report** (`tests/ecosystem/report.mjs`): joins both and puts each browser failure in a reason class (timeout, host error, resolve, build script runs a program / trap / error, rustc ICE, trap / memory, proc macro, compile error).

Why Chromium and not wasmtime, as PLAN.md had it: tools/prebuild can't host Wasm proc macros yet (WP-20), and many top crates use them. The whole browser run takes 6.5 min, so wasmtime would not be faster anyway.

## Results (2026-10-25, release 1.99.1-7520bf319596)

| | Crates |
|---|---|
| build in the browser | 96 |
| fail natively for wasm32-wasip1 too (`target`) | 4: cpufeatures ("works only on aarch64, loongarch64, x86, x86-64"), linux-raw-sys, socket2 ("doesn't support the compile target"), rustls (default `aws-lc-sys` needs a C toolchain) |
| fail only in the browser | 0 |

## The failure class fixed this session

The first full run failed 30 crates from `toml` on with `QuotaExceededError`, each within 1 s, at the first cache write. A second run with the old code failed the same way from `generic-array` on. Both times storage use was about 0.85–0.93 GiB, while `navigator.storage.estimate()` reported a quota of about 11 GiB. So in Playwright's (ephemeral) context, writes fail long before the reported quota. Why isn't confirmed; the context being incognito-like is the likely reason. Two things made it fatal: the L1 build cache had no size limit (a WP-18 gap), and a failed cache write threw through the build.

Fix (`web/deps/cache.ts`, used by L1 and the dependency cache): a byte budget (default: half the reported quota, at most 2 GiB) with least-recently-used eviction (sizes and access times in `.lru.json`, rebuilt from the files if missing). On `QuotaExceededError` it evicts a quarter of the store and retries once. A write that still fails is dropped, never thrown (`UnitCache.put` doesn't throw either). In the fixed run, storage dropped three times (839→802, 808→791, 853→799 MiB) where the writes would have failed, and the run went on.

## Next

- Top 500 (PLAN: ≥ 95%, tracked through Phase E): the same tools with a longer list; expect `cc`-based `-sys` crates (build script runs a program) to be the first real class, which the override list (`web/build/overrides.ts`) or clang-in-Wasm would address.
- Non-default features (e.g. `tokio/full`, `serde/derive`) aren't in the matrix.
