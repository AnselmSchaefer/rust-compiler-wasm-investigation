# Proc-macro bridge overhead (WP-19)

*2026-10-25, this machine, native rustc 1.99.1, wasmtime 50 (Cranelift). `tests/proc-macro/bench.sh` via `scripts/verify/wp-19.sh`; raw numbers in `bench/results/*-proc-macro.json`.*

**Method.** A generated crate has 100 structs (8 fields, serde attributes) and 100 internally tagged enums, each with `#[derive(Serialize, Deserialize)]`: 400 macro calls. rustc's `macro_expand_crate` time (`-Ztime-passes`) is measured with the native serde_derive `.so` and with serde_derive compiled to wasm32-wasip1 (through `pm-shim-serde`), minus the same crate without derives. Best of 5 interleaved runs. The guest is always a release build (fat LTO). Two native profiles:

- **opt3:** proc macros and their dependencies at opt-level 3 (`[profile.dev.build-override]`), for both serde_derive and the shim (wasmtime, pm_host). This is the fair comparison.
- **dev:** cargo's default, with proc macros unoptimized. This mostly measures a debug build of wasmtime and pm_host, so it is not a meaningful ratio.

| | native serde_derive | serde_derive in Wasm | ratio |
|---|---|---|---|
| opt3, per call | 840–870 µs | 1676–1781 µs | **1.96–2.12×** (range over 7 benchmark runs) |
| opt3, without the proxy's own work (estimate) | | | **~1.7×** |
| dev, per call | 1325–1365 µs | 7180–7593 µs | 5.3–5.7× |

- Guest load: 465 ms the first time (Cranelift compile, cached as `.cwasm`), then ~4 ms per rustc process (deserialize + instantiate).
- Each serde derive makes **556 bridge calls**. With opt3, about half of the Wasm time is the server: the proxy plus the native rustc behind it. `ts_concat_trees` dominates (~250 calls per derive), followed by `ts_into_trees`, `ts_concat_streams`, `ts_clone` and `ts_drop`.
- **The proxy's own work** (decode, conversion to the public API, re-encode; the server time minus the time in native calls) is ~340 µs per call. It exists only in this native prototype. In rustc.wasm, rustc itself is the server (WP-20). The estimate subtracts it: (Wasm − load − proxy) / native ≈ 1.7×.
- **What helped** (2.67× → ~2.0×): caching the guest's export handles instead of looking them up by name on every dispatch, lending the request buffer for the reply, reusing one bridge buffer per expansion on the host, fat LTO for the guest, and building plain-string and decimal-integer literals with constructors instead of `from_str`, which is a round trip to rustc.

PLAN §7's risk trigger (> 5× → batched or typed bridge before WP-20) is not hit. The bytes-level bridge is fine.
