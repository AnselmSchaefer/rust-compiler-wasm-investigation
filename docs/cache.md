# Build cache and prebuild (WP-18)

*2026-10-25. Status: done. `scripts/verify/wp-18.sh` passes.*

## What it does

Every unit of a `cargo build` (web/build/cargo.ts) has a cache key. Before a unit runs, the build looks in three places, in this order:

1. **In the VFS already.** The same key was built or restored earlier in this session, and its files are still there (`fresh`). This is what makes edit → run in one session fast.
2. **L1**: OPFS directory `build-cache` on this device (`l1`).
3. **L2**: a read-only HTTP store shared by everyone, at `<base><key[0..2]>/<key>` (`l2`). Every file in an L2 bundle is checked against the sha256 in the bundle's header. Hits are copied into L1.

A miss is built. Its bundle then goes into L1.

**A hit needs none of its dependencies.** If the bin is a hit, nothing else is restored (`skipped` in the result). A miss first puts its whole dependency closure in place (from the VFS, L1, L2, or by building), because rustc also reads the dependencies' dependencies (`-L dependency=`). The target dir therefore isn't fully populated after a cached build, unlike cargo's. The agent API only needs the outputs.

The build op takes `cache: { l1?: boolean; l2?: string }` (L1 on by default) and `targetDir`.

## Key

`web/build/cache.ts` `unitKey` = sha256 of the JSON of:

- format version `wp18/1`, RUSTC_ID, unit kind
- the planned rustc arguments (or the build-script run's: none) and environment, sorted by name, without `NUM_JOBS`
- the package's source: `registry:<.crate sha256>`, or for a path package `path:<sha256 of "path\0sha256(file)\n" lines>` (the files the planner sees: everything but `target/`)
- the keys of the unit's dependencies, in plan order

The planned arguments already carry the target, `--cfg feature=…`, profile flags, `-C metadata` and the output paths. Build-script output that `Resolver.finish` adds later (`cargo:rustc-cfg`, `-L`, `DEP_*`) isn't in the key. It is fully determined by the run unit's key, and that is a dependency. `NUM_JOBS` is the worker count and doesn't change outputs. Keys are computed up front from the plan, before anything runs.

**Paths are part of the key on purpose.** Outputs embed them (debuginfo, `file!()`, `include!` of OUT_DIR files). So the browser and prebuild use one layout: crates at `/deps/<name>-<version>/`, the toolchain at `/sysroot`, **one target dir `/target` shared by all projects** (new default; cargo's `CARGO_TARGET_DIR` behaves the same), and rustc's working directory `/`. Registry crates' keys therefore don't depend on the project. Root packages are keyed by their path (`/<name>`) as well.

## Bundle

`"RCB1"`, a u32 LE header length, then a header JSON `{ files: [{path, size, sha256}], stdout? }`, then the file data. Paths are absolute VFS paths. Compile units store `Unit.outputs`: rlib + rmeta, an executable, or a build-script program. A build-script run stores its OUT_DIR files and stdout. Restoring a run puts the stdout back into the build's `outputs` and writes `<build dir>/output`, as running it would.

## tools/prebuild

`tools/prebuild/main.ts`, bundled by `scripts/build-prebuild.mjs` to `build/prebuild/prebuild.mjs`. It runs the same `cargoBuild` with a disk host:

- **Filesystem:** `build/prebuild/work/root/` is the guest's `/`, laid out like the orchestrator's VFS. It holds the release's sysroot tars (sha256-checked), the `sysroot/bin/rustc` and `lib/rustlib` links (relative, because wasmtime refuses absolute ones), `/deps`, `/target`, and the project at `/<name>`.
- **rustc:** the release's `rustc-wasmtime.wasm` (sha256-checked against the manifest; before WP-20 its `rustc.wasm`) under `wasmtime-threads`. It's the browser's rustc-multi built from the same source without the proc-macro host imports, which the wasmtime CLI can't give to spawned threads (`docs/proc-macro.md`, WP-20); the determinism check below still finds identical outputs. It runs one process per unit, with `--dir root::/` and the unit's env. It follows `Orchestrator.run`: outputs go to `/tmp/job-N`, rustc stops at the link step, the release's `wasm-ld.wasm` links, and the results move into place. Up to `--jobs` (default 4) run at once.
- **Build scripts:** `wasmtime` with only the package dir and an empty OUT_DIR mounted, like the sandbox.
- **Index and crates:** the WP-15 snapshot via `file:` URLs, and `.crate` files from static.crates.io with a User-Agent of our own. Downloads are cached in `build/prebuild/work/deps-cache`.
- **Output:** its L1 *is* the L2 directory (`--out`, default `build/l2/<RUSTC_ID>/`). `--rebuild` ignores what's there. `--report` writes every unit's key and output hashes.

The dev server mounts `build/l2` at `/l2/`. A deploy would put that directory on a CDN (WP-29). Bundles aren't compressed: 47 bundles are 110 MB raw and 17 MB as brotli 9. A CDN serving `.br` siblings, as the release does, would cut transfer about 6×.

## Determinism

`tests/cache/compare.mjs` compares the browser's cold build (Chromium, 4 compile servers, `rustc-multi --server`) with prebuild's (wasmtime, plain rustc processes). **All 51 units of the three cases have the same keys and bit-identical outputs**, covering 30 registry crates plus the three bins: rlibs, rmetas, build-script programs, OUT_DIR files and linked executables. The compile server's long-lived process, its scratch dir names and thread scheduling don't leak into the outputs.

## Cases

The planner's golden cases (`tests/planner/cases/`) double as cache cases. **New:** `more` (log, itertools + either, base64, once_cell, semver, smallvec, indexmap + hashbrown + equivalent, bytes, hex, fnv, byteorder, arrayvec, typenum: 16 crates, no build scripts), recorded with `tests/planner/record.sh more`. The planner golden test passes on it (17 units).

## Not covered yet

- Cargo's `rerun-if-changed`/`rerun-if-env-changed`. Not needed: a build script's key already covers the whole package and its env.
- Warnings of cached units aren't replayed (cargo replays them).
- Crates that use Wasm proc macros can't be prebuilt (WP-20: the wasmtime build has no proc-macro host); in the browser they're cached in L1 like any unit.
- L1 eviction (WP-22): a byte budget with LRU eviction in `web/deps/cache.ts`; see `docs/ecosystem.md`. No L2 upload from the browser (L2 is filled only by prebuild). No signing of L2 beyond per-file sha256 (the bundle header itself comes from L2; trust in the L2 host is assumed).
- Proc-macro artifacts (WP-20) will need the same keying. Their outputs are wasm modules for the host, not rlibs.
