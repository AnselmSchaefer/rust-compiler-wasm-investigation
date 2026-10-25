# Warm latency (WP-27)

Chromium, release 1.99.1-6c798e2613f0, 4 compile servers, `tests/e2e/warm.spec.ts`: after a cold build, 5 edits each followed by `check`, then 5 each followed by build + run. Medians (all five in brackets). Raw: `bench/results/2026-10-25-*-warm*.json`.

| Project | debuginfo | cold build | warm check | warm edit → run |
|---|---|---|---|---|
| medium.rs (563 lines, no deps) | 2 | 5.1 s | 244 ms [262 257 244 224 228] | 2,012 ms [2184 2058 1945 2012 1950] |
| | 1 | 4.9 s | 311 ms [339 319 311 293 283] | 1,478 ms [1803 1478 1621 1436 1343] |
| | **0 (default)** | 3.9–4.4 s | 241–288 ms [260 288 312 290 275] | 1,114–1,269 ms [1525 1356 1269 1105 1123] |
| check case (28 units: serde derive, serde_json, thiserror) | 2 | 18.0 s | 384 ms | 705 ms |
| | 0 (default) | 14.8–16.6 s | 344–347 ms | 606–623 ms |

Budgets (PROPOSAL §6): check < 1 s, edit → run < 2 s. Met with debuginfo 0, without incremental compilation, which rustc.wasm can't do yet (`docs/incremental.md`).
