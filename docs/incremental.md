# Incremental compilation and warm latency (WP-27)

## Budgets (PROPOSAL §6): met without incremental

`tests/e2e/warm.spec.ts`, Chromium, release 1.99.1-6c798e2613f0, 4 compile servers, 5 edit rounds each after a cold build (medians; raw data in `bench/results/*-warm*.json`, summary in `bench/warm.md`):

| Project | Warm `cargo check` | Warm edit → run (build + link + run) |
|---|---|---|
| 500-line benchmark (`bench/programs/medium.rs`), debuginfo 2 (cargo's dev default) | 244 ms | 2,012 ms ✗ |
| same, debuginfo 1 (line tables) | 311 ms | 1,478 ms |
| **same, debuginfo 0 (the browser's default now)** | **241–288 ms** ✓ (< 1 s) | **1,114–1,269 ms** ✓ (< 2 s) |
| serde derive + serde_json + thiserror (`tests/planner/cases/check`), debuginfo 0 | 347 ms | 623 ms |

A warm edit → run of the benchmark is almost all rustc's codegen of the edited bin (~1.75 s of the 2.0 s with full debug info). The link is ~140 ms and the run ~30 ms. `web/build/cargo.ts` therefore builds with `debuginfo: 0` by default. Nothing in the browser reads DWARF yet: panics take file:line from `Location`, wasm32-wasip1 has no symbolized backtraces, and the debugger UI is deferred. `BuildOptions.profile.debuginfo` turns it back on.

`cargo check` is a planner mode now (`PlanInput.check`, op `check`). Target-side units emit only `dep-info,metadata`; build scripts, proc macros and their dependencies are built as usual. The golden case `tests/planner/cases/check` is identical to `cargo check -vv` (28 units).

## Incremental compilation: blocked on file locks in rustc [H]

With `-C incremental=<dir>`, rustc.wasm stops at once:

```
error: incremental compilation: could not create session directory lock file: file locks not supported on this platform
```

Why: `rustc_data_structures::flock` picks its implementation by target OS. WASI matches none of the cases (linux, redox, unix, windows), so it gets the `unsupported` implementation, whose `Lock::new` always returns an error. `rustc_incremental::persist::fs::lock_directory` emits a fatal error for any lock error, unsupported or not. So no incremental session can start on a WASI host. None of the reviewed human-written patch sets (bjorn3, oligamiq; `docs/patches.md`) cover this. danlapid's toolchain builds with `incremental = false`.

What a change has to achieve (for the user to write; the Rust tree's LLM policy applies, `build/rust/AGENTS.md`): on a WASI host, creating an incremental session must not fail just because the platform has no file locks. WASI preview 1 has no advisory locks at all. Here the browser never runs two compiles of the same crate into the same incremental directory at once (one unit per crate and profile, scheduled by `web/build/cargo.ts`), so a lock that always succeeds would be safe for us. Whether upstream would want that, or rather a non-fatal "unsupported" path in `lock_directory`, is the author's call.

After such a change (rebuild with `toolchain/build-rustc.sh`, about 5 min for a `rustc_data_structures`/`rustc_incremental` change), Claude's part:

1. Check the rest of the incremental path under wasmtime: session directory renames, hard links with copy fallback for work products, `SystemTime`, `canonicalize`.
2. Turn on `profile.incremental` for path packages in the browser (the planner already passes cargo's `-C incremental=<target>/<triple>/debug/incremental`).
3. Mirror `/target/**/incremental` to OPFS with the WP-11 persister, like `/projects` (WP-25).
4. Measure again with `INCREMENTAL=1 pnpm exec playwright test tests/e2e/warm.spec.ts`: an edit should then recompile only the changed codegen units.
