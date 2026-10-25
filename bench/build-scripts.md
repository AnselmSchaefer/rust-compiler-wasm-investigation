# Build scripts (WP-21)

Chromium, release 1.99.1-7520bf319596, 4 compile servers, `tests/e2e/build-scripts.spec.ts` on `tests/planner/cases/scripts` (10 packages, 24 units, 7 build scripts). Raw: `bench/results/2026-10-25-*-build-scripts.json`.

| Step | Time |
|---|---|
| cold `cargo build` (empty L1; build-script std compiled too) | 8.7–9.0 s total (deps ~1.1 s, build 7.6–7.7 s) |
| fresh page, main.rs edited (23 units from L1, 1 built) | 1.0 s |

Script runs (sandbox start to output, probes included): anyhow 580–617 ms, proc-macro2 552–634 ms, libc 450–490 ms, rustversion (host) 157 ms, num-traits (autocfg: `-vV` + 2 probes) 124–142 ms, linka 97–104 ms, linkb 56–69 ms.

All 7 scripts print what they printed in the native `cargo build` (paths and hashes normalized); the program's output = the native build's.

WP-18's cases (serde_json, mix, more) with probes now working in zmij, serde_core and serde_json: browser and prebuild agree on all 51 units, including script stdout. Cold serde_json in the WP-18 spec is 32.0 s against 30.9 s in the committed result of the previous commit (same spec, same machine), so no measurable cost.
