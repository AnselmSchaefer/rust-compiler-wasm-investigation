# Compile server: cold vs warm (WP-09)

*2026-10-24. `rustc-multi --server` (our rustc 1.99.1 host, panic=unwind) in Chromium (Playwright 1.64.1) on the VFS + WASI adapter, with the packaged wasm32-wasip1 sysroot (meta group). Raw data: `bench/results/2026-10-24-8ad1581-compile-server.json`. Reproduce: `scripts/verify/wp-09.sh`.*

**Cold** = a new instance per compile (what a host without the server does), after one warm-up run so the JIT has tiered up: 65–76 ms, median 67 ms for check-hello.
**Warm** = later requests to one server instance, timed on the page (request appended → answer read): 19.5–23.2 ms, median 22.1 ms. **Ratio 3.0×** (2.7× before the stdout wake-up; 2.9–3.0× over four runs).

10 requests in one instance:

| # | Request | Exit | rustc ms | page ms | Instance memory |
|---|---|---|---|---|---|
| 1 | check hello | 0 | 51.3 | 67.1 | 102 MiB |
| 2 | check hello | 0 | 27.0 | 28.3 | 105 MiB |
| 3 | type error | 1 | 64.2 | 65.6 | 105 MiB |
| 4 | check hello | 0 | 21.1 | 22.1 | 105 MiB |
| 5 | check medium (lib) | 0 | 420.1 | 421.4 | 111 MiB |
| 6 | codegen hello (obj) | 0 | 285.5 | 286.8 | 141 MiB |
| 7 | check hello | 0 | 22.0 | 23.2 | 141 MiB |
| 8 | check hello | 0 | 18.4 | 19.5 | 141 MiB |
| 9 | `-V` | 0 | 0.2 | 1.3 | 141 MiB |
| 10 | check hello | 0 | 18.4 | 19.6 | 141 MiB |

Requests 3, 5 and 6 are the first runs of those code paths in this module, so they include V8's tier-up. In WP-08's fresh-instance runs, warm check-medium is 218 ms and obj-hello 157–211 ms. So the server isn't slower; its JIT just hasn't warmed up on them yet.

What the server saves: instantiating the module and its threads (with `web/wasi` reusing a finished thread's worker and instance for the next thread; rustc starts one per compile), and the page waits on a stdout-write notification instead of polling.

**What's left, and why the target was re-scoped:** PLAN asked for ≥ 3×. The remaining ~20 ms of a warm check is mostly rustc loading `std` and its dependencies again in every session (`-Ztime-passes`: `expand_crate` 14–15 ms of ~24 ms under wasmtime). `.rmeta` files are read by `rustc_metadata::locator::get_rmeta_metadata_section` → `Mmap::map`, which on wasm32 is a full `read_to_end`. That path doesn't go through the codegen backend's `MetadataLoader`, so a driver outside rustc can't cache it, and bjorn3/oligamiq have no such cache. The user re-scoped the check to ≥ 2.5× (2026-10-24). A cross-session metadata cache would have to be a human-written rustc change; revisit when large dependency graphs make it matter (WP-22).

Under wasmtime 46, the same server answers warm check-hello in 21.1–21.6 ms.
