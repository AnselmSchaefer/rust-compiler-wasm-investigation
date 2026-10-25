# Build planner and `cargo build` in the browser (WP-17)

*2026-10-25. Status: done. `scripts/verify/wp-17.sh` passes.*

## What it does

`web/build/cargo.ts` `cargoBuild` (the orchestrator worker's `build` op) runs `cargo build --target wasm32-wasip1` for a project in the VFS:

1. **Dependencies** (WP-16): `fetchDependencies` resolves Cargo.toml and unpacks every registry package to `/deps/<name>-<version>/`.
2. **Plan**: `crates/resolver/src/plan/` (in `resolver.wasm`; `Resolver.plan`) turns the resolve plus each package's Cargo.toml and file list into units, with their rustc arguments and environment, in dependency order.
3. **Execute**: each unit starts once its dependencies finish. Compiles go to the orchestrator, which now runs up to `workers` compile servers at once (started on demand). Build scripts run in the run sandbox. `Resolver.finish` adds a build script's `cargo:` output to its package's invocation. Executables are copied ("uplifted") to `target/wasm32-wasip1/debug/<name>.wasm`, as cargo does. Since WP-18 the target dir is `/target` by default, shared by all projects (`docs/cache.md`).

## Planner (Rust, `crates/resolver/src/plan/`)

It is ported from cargo 0.100, so that it produces cargo's invocations, not just working ones:

- `package.rs`: Cargo.toml → dependencies, the feature map (the resolver's `Summary`), targets with cargo's auto-detection (`src/lib.rs`, `src/main.rs`, `src/bin/*`, `build.rs`, `autolib`/`autobins`, explicit `[lib]`/`[[bin]]`/`build`), `CARGO_PKG_*` metadata (inferred readme included) and `[lints]` → `--<level>=<lint>` (cargo's order: priority, then bare lint name descending) plus `unexpected_cfgs`' check-cfg list. Dev dependencies count for feature validation but get no edges.
- `features.rs`: cargo's `FeatureResolver`. With resolver ≥ 2, features are computed per package *and side*: build dependencies, proc macros and everything below them get host features of their own. Only dependencies active on the platform count (`cfg(..)` through cargo-platform). Weak `dep?/feat` is deferred until the dependency is on, and `dep/feat` also turns on a same-named feature. The resolver's lockfile features (unified, all of the root's features) are not used for building.
- `mod.rs`: the unit graph (lib, root bins, build-script compile, build-script run), cargo's argument order (`--crate-name`, `--edition`, source, `--error-format=json`, crate type, `--emit`, profile flags, lints, `--cfg feature=`, check-cfg, `-C metadata`/`extra-filename`, `--out-dir`, `--target`, `-L dependency=`, `--extern` sorted by package, `--cap-lints allow` for registry packages, then build-script flags), the env of compiles (`CARGO_PKG_*`, `CARGO_CRATE_NAME`, `OUT_DIR`, `CARGO_BIN_NAME`, `CARGO_PRIMARY_PACKAGE`) and of build-script runs (`CARGO_CFG_*`, `CARGO_FEATURE_*`, `OUT_DIR`, `TARGET`, `HOST`, `PROFILE`, …). The layout is cargo's: target units in `target/<triple>/debug/`, host units in `target/debug/`. Packages that weren't downloaded are allowed (cargo also skips other platforms' crates) unless a unit needs one.
- `cfg.rs`: `rustc --print cfg` of 1.99.1 for wasm32-wasip1 (and x86_64 Linux for the native test), taken with cargo's crate types, which is why `crt-static` is missing.
- `build_output.rs`: `cargo:` and `cargo::` lines, as cargo's `BuildOutput::parse` reads them.

**Hashes** (`-C metadata`, file names) are our own: 64-bit FNV-1a over the unit's inputs (RUSTC_ID, package, kind, target, features, profile) and its dependencies' hashes. They are stable, but they aren't cargo's values. WP-18's cache key is separate.

## Golden test

`tests/planner/record.sh <case>` runs native `cargo +1.99.1 build -vv --target wasm32-wasip1` on `tests/planner/cases/<case>/` against the pinned index snapshot (index-proxy replay). It keeps every `Running` entry as JSON (`cargo-vv.jsonl`; `shlex`-parsed, since descriptions can span lines), each package's Cargo.toml and file list, and each build script's output (`build-output/<name>-<version>.txt`; host-side runs, i.e. build scripts of build dependencies and proc macros, as `.host.txt`). `crates/resolver/tests/plan_golden.rs` plans the same resolve, feeds in the recorded outputs, and compares unit sets, argument lists (in order) and environments. Two normalizations: 16-hex hashes → `H`, and `--cap-lints warn` → `allow`, because `-vv` shows dependencies' warnings.

| Case | Packages | Units | What it covers | Result |
|---|---|---|---|---|
| `serde_json` | 12 | 12 | three build scripts (zmij, serde_core, serde_json), `cfg`/`check-cfg` output, OUT_DIR | identical |
| `more` (WP-18) | 17 | 17 | 16 crates without build scripts (itertools, indexmap + hashbrown, semver, base64, bytes, typenum, …) | identical |
| `mix` | 24 | 22 | rand 0.10 (`cfg(target)` deps: getrandom, cpufeatures, libc not built), regex without default features, renamed `json = { package = "serde_json" }`, `[lints]` tables incl. clippy and priority | identical |
| `ws` (WP-25) | 15 | 15 | a virtual workspace: members by glob, an excluded path dependency, inheritance of package fields, dependencies and lints (`docs/projects.md`) | identical, Cargo.lock too |
| `ws-root` (WP-25) | 3 | 3 | a root package whose path dependency becomes a member but isn't primary | identical, Cargo.lock too |
| `derive` (WP-20) | 14 | 28 | proc macros: serde with `derive`, thiserror (serde_derive, thiserror-impl on the host side with syn/quote/proc-macro2), proc-macro2's host-side build script | identical, Cargo.lock too |

## Proc macros (WP-20)

A proc-macro package's lib unit is built for the host side, as cargo does: `--crate-type proc-macro --emit=dep-info,link -C prefer-dynamic`, its dependencies as `.rlib`s (it links), `--extern proc_macro` after the other externs, output `<dll_prefix><crate>-<hash><dll_suffix>` in the host `deps` dir (`libx-H.so` natively, `x-H.wasm` for wasm32-wasip1; `cfg.rs` `TargetInfo`). Its dependents get `--extern name=<that file>`. In the browser, `PlanInput.proc_macro_args` (from `web/build/cargo.ts`) adds the link arguments that make the module loadable by the host in rustc.wasm, and `-C save-temps`; see `docs/proc-macro.md` (WP-20).

## Build scripts (a slice of WP-21, moved forward)

All three build scripts in serde_json's graph are needed for the WP-17 crate set, so the basic path is done here. The script is compiled with `--target wasm32-wasip1` (the browser's rustc runs on wasm32-wasip1-threads, so host units get `--target` too: `target_flag_for_host`). It then runs in the sandbox with a copy of its package's files, cargo's environment and an empty `OUT_DIR`, which is copied back to the VFS. Its stdout goes to `<build dir>/output`, like cargo.

- `Command::new(RUSTC)` fails under WASI. zmij and serde_core treat that as "unknown version" and emit no cfgs, which is the right result for 1.99, but they then skip their `rustc-check-cfg` lines (only lint noise, and capped anyway). Routing `rustc --version` to the compile server is WP-21.
- The working directory is `/`, not the package directory (the sandbox's WASI has no cwd). Scripts that read relative paths need WP-21.
- Not yet done: `DEP_<links>_<key>` env (the planner orders `links` scripts, and `finish` sets the variables, but untested), `-L` from dependencies' scripts, the override list, `rerun-if-*`.

## Compile server: per-request env

`env!("OUT_DIR")`/`include!` and `env!("CARGO_PKG_*")` read rustc's process environment. `rustc-multi --server` now takes `"env": {...}` per request. It sets the variables before the compile and restores them afterwards (requests run one at a time per instance). New release `1.99.1-e6f1d21de137`.

## Results (Chromium, 4 compile servers, cold: nothing cached but the toolchain)

See `bench/build.md`. serde_json case 10.9 s (2.6 s native cargo), mix 11.6 s.

## Not covered yet

Dev units and `cargo test` (WP-26), `[profile]` sections and `--release` (the profile is an input, but manifests' `[profile]` tables are ignored), cdylib/staticlib outputs, and `-C incremental` (off in the browser until WP-27). Workspaces came with WP-25, proc macros with WP-20. The resolver's lockfile is regenerated on every build (no lockfile preference yet).
