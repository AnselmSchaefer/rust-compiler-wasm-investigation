# Build cache (WP-18)

*2026-10-25, Chromium (Playwright), this machine, 4 compile servers, cargo's dev profile. `tests/e2e/cache.spec.ts` via `scripts/verify/wp-18.sh`; raw numbers in `bench/results/2026-10-25-e217324-cache.json`. Release 1.99.1-e6f1d21de137.*

"build+run" is measured from the page: write Cargo.toml and main.rs, the `build` op (resolve, plan, units, uplift, L1 writes), then run the program in the sandbox. The index comes from the local snapshot. Crates are in the OPFS deps cache after the first step.

| Step | serde_json (12 units) | mix (22) | more (17) |
|---|---|---|---|
| Cold: empty L1, no L2 | 7.0 s | 8.2 s ¹ | 3.7 s |
| Second build after a reload (all L1; only the bin is restored) | **120 ms** | 219 ms | 83 ms |
| Edit main.rs → run, after a reload (bin built; 11 units from L1) | **575 ms** | | |
| Edit main.rs → run, same session (dependencies already in the VFS) | **278 ms** | | |
| Empty L1, prebuilt L2, main.rs edited (bin built, the rest from L2) | 665 ms | 700 ms ¹ | 576 ms |

¹ mix shares 4 units with serde_json through the shared `/target`: the itoa lib, and zmij's lib, build-script compile and run. They are in the VFS already.

- Of an in-session edit → run, the bin's compile + link is ~180 ms. The rest is deps (resolve against the index, unpack the crates: ~60 ms), plan and the run.
- The L1 bundle for the serde_json bin is 3.9 MB (debuginfo 2). The mix bin is 12.7 MB. The closure restored after a reload is 23 MB from OPFS.
- **tools/prebuild** under wasmtime (4 jobs, from scratch): serde_json 8.4 s, mix 11.9 s, more 7.9 s, 29 s in all for 47 bundles (110 MB raw, 17 MB brotli 9).

## Cold builds compared with WP-17

Today's cold serde_json build (`build.spec.ts`, no cache, its own target dir) took 6.9–7.5 s in two runs, and mix 7.5–7.7 s. `bench/build.md` recorded 10.9 s and 11.6 s in session 19. Per-unit times are lower across the board: serde_core lib 2.7–2.9 s (was 4.2–4.8 s), build-script compiles 1.8–1.9 s (was 2.7–3.0 s). The compile path didn't change in WP-18, and the cause wasn't investigated (machine state is likely). Session 19's raw results file was overwritten during that session, so there's no exact baseline to diff.
