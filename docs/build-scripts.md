# Build scripts (WP-21)

A build script is compiled for wasm32-wasip1 and runs in the run sandbox (WP-13) with a copy of its package's files, cargo's environment and an empty OUT_DIR (WP-17 did that basic path). WP-21 adds what real build scripts need on top of it:

| Need | How |
|---|---|
| `Command::new(rustc)`: `--version`, `-vV`, compile probes | the build-script std (below) sends the run to the host; it runs on a compile server |
| piped stdin (`rustc -`, autocfg) | the child runs once its result is needed, with everything written to its stdin |
| working directory = package dir | the build-script std enters `CARGO_MANIFEST_DIR` before `main` (a `.init_array` constructor) |
| `fs::metadata(..).permissions().readonly()` = false | `--wrap=stat,lstat,fstat,fstatat`: the wrappers add permission bits |
| `DEP_<links>_<KEY>` | run units carry `links`; `finish` maps the dependency script's metadata |
| `-L` from dependencies' scripts | `finish` collects the link-search paths of the scripts in the unit's linkable closure (cargo's `to_link`) |
| scripts that can't run (C compilers, other programs) | override list (`web/build/overrides.ts`) |

## The build-script std

WASI preview 1 has no processes, and std's `process` on wasip1 is the "unsupported" one, so every spawn fails. The Rust tree isn't ours to change (`build/rust/AGENTS.md`), so the fix sits outside it: `web/build/bs-std/lib.rs` is a crate **named `std`** that re-exports the real std (`pub use real::*`) and defines its own `process` module, with the same public API (Command, Child, ChildStdin/out/err, Stdio, Output, ExitStatus; ExitCode, Termination, exit, abort and id are the real ones). Every host-side compile gets `--extern std=<it>`, which takes precedence over the sysroot's std. The prelude, macros and lang items still come from the real std. Host-side units are build scripts, the crates they use, and proc macros: one crate graph needs one `std`, so all of them get it.

- It is a cached unit of its own (`hostStd` in `web/build/cargo.ts`): `<target>/bs-std/libstd-<source hash>.rlib`, compiled with one codegen unit before the first host-side compile that misses, and stored in L1 like any unit. Its source travels as text in the bundle (esbuild `loader: { '.rs': 'text' }`).
- `Command` builds a request (program, absolute cwd, stdin bytes, args, full environment) and calls the host import `rust_bs.run`, which blocks until the answer: an exit status, stdout and stderr, or -1 for "not found" (an `io::ErrorKind::NotFound` error, which build scripts treat like a missing tool). With stdin piped, the child runs on the first wait, try_wait, wait_with_output or read from its stdout or stderr. Otherwise it runs at spawn. Inherited stdout goes to the script's own stdout, as natively (cargo reads `cargo:` lines from it).
- Build-script links get `-u __bs_std_init` (pulls in the object with the constructor and the wrappers) and `--wrap` for the four stat functions. wasi-libc's `st_mode` has only the file-type bits, so without the wrappers every file looks read-only, and autocfg refuses its OUT_DIR. Wrapping keeps the real `fs::Metadata` type, so code that names it still compiles.
- wasm-ld drops the `rust_bs` imports from scripts that never spawn.

## The host side

`web/build/spawn.ts` decodes a request and runs it: only `$RUSTC`, `rustc` or `/sysroot/bin/rustc`, anything else is "not found". The rustc run is an ordinary compile-server job (`Orchestrator.rustcJob(args, env, {cwd, stdin})`), so it gets the same output handling and linking as any compile.

- **rustc-multi** (`toolchain/rustc-multi/main.rs`, out of tree) takes `"cwd"` and `"stdin"` per server request. rustc reads `-` from stdin before any callback runs, and the server's stdin carries the requests, so the server swaps `-` for a marker path. `Callbacks::config` turns that back into the `Input::Str { name: anon_source_code(..) }` that rustc builds from real stdin (`<anon>` in diagnostics, crate name `rust_out`). The cwd is entered in `config` too, after the session options are built: on WASI there's no `dll_path`, and rustc checks for `lib/rustlib` relative to the working directory while it looks for its sysroot (`relative_target_rustlib_path`), so entering earlier fails with "Failed finding sysroot". rustc's own stdout (`--version`) is the text before the request's answer line, which `CompileServer` now returns.
- **Browser** (`web/build/browser-host.ts`, `web/sandbox/`): the sandbox worker answers `rust_bs.run` by posting the request and blocking (`Atomics.wait`) on a growable SharedArrayBuffer, which the host fills with the answer. The script's OUT_DIR lives in the sandbox's own VFS and the compile server sees the orchestrator's VFS, so the OUT_DIR files go along with each call and the new or changed ones come back. OUT_DIR on the orchestrator side is cleared before the script runs and again before its bundle is restored, so a probe's leftovers (autocfg's `.ll` files, which the script deletes on its side) don't stay.
- **tools/prebuild**: build scripts now run under `node:wasi` in a worker thread (wasmtime's CLI can't provide `rust_bs`), with the same blocking channel. Probes go to one rustc-multi `--server` request under wasmtime, which handles cwd and stdin the same way. OUT_DIR is on disk for both, so nothing is copied.

Run units' stdout is now in the unit report (`UnitReport.stdout`), and `tests/cache/compare.mjs` checks it, so a browser/prebuild difference in what a script printed fails WP-18's determinism check.

## Override list

`web/build/overrides.ts`: name, version prefix, the stdout to use (`$OUT_DIR` substituted), optional OUT_DIR files, and the reason. A listed package's script isn't compiled or run, and its run unit's key includes the override. `BuildOptions.overrides` replaces the built-in list, which starts empty: WP-22's ecosystem matrix will show which scripts need entries (cc-based `-sys` crates are the expected first ones).

## Result

`tests/planner/cases/scripts` (recorded natively with `record.sh`, which now handles path packages with build scripts): num-traits (autocfg), rustversion (host side), libc, proc-macro2, anyhow, and the path pair linka/linkb (`links`, `cargo:KEY=VALUE` metadata, `rustc-link-search`, a relative read from the package dir). The planner golden test is identical to `cargo build -vv` on all 7 cases. In Chromium, every script prints exactly what it printed natively (paths and hashes normalized), and the program prints what the native build prints. Numbers are in `STATUS.md` and `bench/results/*-build-scripts.json`.

## Not covered

- Programs other than rustc (`cc`, `pkg-config`, `git`): "not found". Scripts that need them need an override, or clang-in-Wasm (PROPOSAL v2).
- `RUSTC_WRAPPER`, a `Child` that runs concurrently with its parent, and pipes between children (a `ChildStdout` turned into another child's stdin is read up front).
- Env removal (`env_remove`) reaches rustc only for variables the compile server doesn't have itself: requests set variables, they don't unset the server's (only `RUST_MIN_STACK`).
- `-L` relative paths in a probe resolve against `/`, not the probe's cwd: rustc reads `-L` directories before `config` runs.
- Proc-macro crates that spawn processes: the proc-macro host provides no `rust_bs`.
