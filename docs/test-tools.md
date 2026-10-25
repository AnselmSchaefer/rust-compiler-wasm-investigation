# cargo test, Clippy, rustfmt (WP-26)

## cargo test

**Planner** (`PlanInput.test`, `crates/resolver/src/plan/`): the roots' dev-dependencies become edges, so features unify as in `cargo test`. Packages now have examples and integration tests (`[[example]]`/`[[test]]` plus cargo's auto-detection of `examples/` and `tests/`, with `test`/`harness` flags). The units:
- a `--test` harness for the lib, for each bin, and for each integration test;
- the examples (built, not run);
- the bins, if there are integration tests, which get `CARGO_BIN_EXE_<name>` (the uplifted path) and `CARGO_TARGET_TMPDIR`.

Harnesses and examples link the lib, the dependencies and the dev-dependencies. `Plan.tests` lists the harnesses in cargo's naming (`unittests src/lib.rs`, `tests/integration.rs`). The golden case `tests/planner/cases/tests` (recorded from `cargo test --no-run -vv`: `record.cmd` holds the command) is identical to cargo: 10 units, arguments and environment.

**Runner** (`web/build/test.ts`, orchestrator op `test`): wasm32-wasip1 aborts on a panic, and a failing test would end its whole harness. So, like cargo's `-Zpanic-abort-tests`, each test runs in a sandbox process of its own:
1. `<harness> --list --format json`, then each selected test as `<harness> <name> --exact --nocapture --format json --report-time`, up to `workers` at a time. Each harness is compiled once per run.
2. libtest's JSON output is unstable. Stable libtest allows it when `RUSTC_BOOTSTRAP` is set at run time, so the harness's environment has `RUSTC_BOOTSTRAP=1` next to the unit's cargo environment.
3. The JSON events give status and time. The other stdout lines are the test's own output: `--nocapture`, because an aborted test can't print what libtest captured. A failure's message is the panic text from stderr.
4. `#[should_panic]` tests can't run on an aborting target: libtest reports them as ignored, and so does the runner, with that reason.

Results: `{suite, package, name, status: ok|failed|ignored, ms, stdout, stderr, message?, ignored?}`, with counts (passed, failed, ignored, filtered out). `filter` (substring) or `filter` + `exact` selects tests, as `cargo test <name> -- --exact` does; `includeIgnored` runs ignored ones too.

**Not covered:** doc tests (below), benches, `harness = false` targets (run but not split per test), the working directory (tests run with `/` as cwd; `env!("CARGO_MANIFEST_DIR")` paths work, relative ones don't).

## Clippy and rustfmt

Both are linked into rustc-multi (`toolchain/rustc-multi/tools.rs`), so they share its compiler crates. The release's `rustc.wasm` grew from 142 to 160 MB raw, 19.9 to 22.3 MB brotli.

- **Build** (`toolchain/build-rustc-tools.sh`): bootstrap builds Clippy's and rustfmt's crates for the wasm host with the compiler's config, no source changes. On a wasm host, its tool sysroot lacks `rustc_driver`: the stamp keeps only the dylib, which wasm doesn't have. For this build only, `build.rustc` is a wrapper around the same stage-0 rustc that adds `rustc_driver`'s directory with a plain `-L` (`crate=` paths serve only `extern crate`, `dependency=` only transitive lookups, and tool crates need both). Cargo doesn't see the flag, so the compiler stays fresh. The tools' own binaries don't link (rmeta-only sysroot); `toolchain/build-rustc-multi.sh` links their lib crates instead. Each tool gets its own bootstrap invocation, since bootstrap stops at the first failure.
- **Clippy** (request `"tool": "clippy"`, `rustc-multi --clippy`): the callbacks of Clippy's own driver: lint list and passes, `clippy.toml` via `Conf::load`, extra symbols, `mir_opt_level=0`, no format_args flattening, `--cfg clippy`. Orchestrator op `clippy` (`cargoClippy`): a normal build, then each primary package's lib and bin checked again as Clippy with `--emit=metadata` into a scratch dir. It returns the JSON diagnostics (level, message, code such as `clippy::needless_return`, primary span, rendered text).
- **rustfmt** (request `"tool": "rustfmt"`, `rustc-multi --rustfmt`): `rustfmt_nightly`'s `Session` on the request's stdin, `rustfmt.toml` from the working directory up, `--edition`, `--check` (diff, exit 1 if unformatted), `--config k=v`. The formatted text comes back in the answer's `out`, because formatted code could look like an answer line on stdout. Orchestrator op `fmt` formats a file in place, or reports with `check`.

## Doc tests: deferred

Doc tests need rustdoc. Bootstrap builds librustdoc for the wasm host only up to `extern crate test`: the host's stage-0 sysroot has no libtest, and bootstrap would build one only with a native stage-1 compiler, i.e. a native LLVM and rustc build. Options for later: build libtest for wasm32-wasip1-threads by hand (as `toolchain/build-host-std.sh` does for std), or extract doc tests ourselves.

## Results

`tests/e2e/test-tools.spec.ts`, Chromium, release 1.99.1-6c798e2613f0, cold:
- `cargo test` of the case (7 tests): build 3.0–3.1 s, running every test in its own process 130–151 ms;
- the failing test alone by name: 88–96 ms after an 18 ms build check;
- Clippy on a small lib: 58–67 ms after the build;
- rustfmt on a file: under 1 ms.
