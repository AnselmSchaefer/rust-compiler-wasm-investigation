# Dependencies in the browser (WP-16)

*2026-10-24. Status: done for the snapshot index; the deployed index host is an open [H] decision.*

## CORS on crates.io (checked from Chromium, 2026-10-24)

| Host | CORS | Consequence |
|---|---|---|
| `index.crates.io` (sparse index) | **none**: no `Access-Control-Allow-Origin`, so `fetch` from a page fails | needs a same-origin reverse proxy or a CORS mirror |
| `static.crates.io` (`.crate` files) | `Access-Control-Allow-Origin: *`, `Cache-Control: immutable` | download directly |

In dev and in the tests, `scripts/serve.mjs` serves the pinned WP-15 snapshot at `/index/` (Playwright mounts it). For the deployed IDE, `SparseIndex` takes any base URL. The options, to be decided **[H]**:
1. **A reverse proxy on the app's own origin** (`/index/*` → `https://index.crates.io/*`), set up with the WP-29 deploy. No CORS needed, and nothing else to run.
2. **A CORS mirror Worker** (e.g. Cloudflare): a few lines that forward GETs and add `Access-Control-Allow-Origin`. Needs an account and deploy approval.

Either way the proxy should send a descriptive User-Agent. Browsers don't let pages set one, and crates.io's crawler policy asks for it. It should also forward only index paths (no open proxy) and keep crates.io's `Cache-Control`/ETag.

## Flow (`web/deps/`)

1. `resolver.ts`: `crates/resolver` as wasm32-wasip1 (`scripts/build-resolver.sh`, 2.6 MiB, 431 KiB br). It's wasip1, not unknown-unknown, because cargo-util-schemas uses `Url::from_file_path`. It never touches files, so eight WASI stubs are enough.
2. `deps.ts` `resolveManifest`: call `resolve(manifest)`. The answer is the lockfile, or `need: [names]` for index files it hasn't seen. Fetch those (16 at a time), add them, and resolve again. Like cargo with in-flight index requests, a round skips pending dependencies instead of stopping at the first one, so it takes about graph-depth rounds: serde_json 6, tokio 9, bevy (738 index files) 9. Parsed index files are kept between rounds (`IndexCache`), so the rounds cost little compute (bevy: 686 ms over all rounds vs 568 ms in one pass, native).
3. `index.ts` `SparseIndex`: network first, so the index stays fresh. Each file is written to OPFS (`deps-cache/index/…`, a 404 too), and the OPFS copy answers when the network fails.
4. `crates.ts`: `.crate` from OPFS if its sha256 matches, else from static.crates.io, checked against the lockfile checksum and then cached. Gunzip with `DecompressionStream`. Untar with `web/orchestrator/tar.ts`, now with GNU long names and pax paths. Entries outside `<name>-<version>/` are refused. Files land in the VFS at `/deps/<name>-<version>/`.

The plan said "unpack tar.gz inside Wasm". `DecompressionStream` is built into Chromium (and Firefox), so a Wasm inflater would only add size.

## Result (Chromium, `tests/e2e/deps.spec.ts`, `scripts/verify/wp-16.sh`)

`serde` (derive) + `serde_json`: 12 packages, the same Cargo.lock as the native resolver.

| | Index | Resolve | Crates | Download + unpack |
|---|---|---:|---|---:|
| Cold (index from local server, crates from static.crates.io) | 11 files, 1.5 MB | 70 ms (5 rounds) | 11, 962 KB, 474 files | 667 ms |
| After reload, offline | 11 from OPFS | 24 ms | 11 from OPFS | 26 ms |

Not in WP-16: refreshing the index cache without refetching everything (ETag / `If-None-Match`: crates.io supports it), and evicting old crates from OPFS.
