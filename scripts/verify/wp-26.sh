#!/usr/bin/env bash
# WP-26 done-check: cargo test, Clippy, rustfmt.
#  1. The planner plans `cargo test` as cargo does: golden case tests/planner/cases/tests (lib, bin
#     and integration-test harnesses, an example, a dev-dependency) identical to
#     `cargo test --no-run -vv`.
#  2. The release's rustc-multi has Clippy and rustfmt linked in (toolchain/rustc-multi/tools.rs):
#     under wasmtime, --clippy reports clippy::needless_return, --rustfmt formats.
#  3. Chromium (tests/e2e/test-tools.spec.ts): a crate's tests run with per-test results, the
#     failing one again alone by name with the same structured result, Clippy lints a file
#     (JSON diagnostics), rustfmt formats one.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ ! -d build/wp-15/index ]; then
  mkdir -p build/wp-15
  zstd -dc tests/resolver/index-snapshot.tar.zst | tar -x -C build/wp-15
fi
(cd crates && cargo test -q --release -p resolver --test plan_golden -- --nocapture 2>&1 | grep -E '^(test result|tests: [0-9]+ units)') || { echo "FAIL: planner golden test"; exit 1; }
rel=$(ls -t build/release | head -1)
R=build/prebuild/work/root; W=build/wp-26/tools
[ -d "$R/sysroot" ] || { echo "FAIL: no prebuild guest root (run scripts/verify/wp-18.sh once)"; exit 1; }
rm -rf "$W" "$R/tmp/wp26"; mkdir -p "$W" "$R/tmp/wp26"
brotli -dc "build/release/$rel/rustc-wasmtime.wasm.br" > "$W/rustc.wasm"
printf 'pub fn f(v: &[u32]) -> u32 {\n    let n = v.len() as u32;\n    return n;\n}\n' > "$R/tmp/wp26/lint.rs"
WT=(wasmtime-threads run -C cache=y -W threads=y,shared-memory=y,exceptions=y -S threads=y --dir "$R::/" --env RUST_MIN_STACK=16777216 --argv0 /sysroot/bin/rustc "$W/rustc.wasm")
"${WT[@]}" --clippy --crate-type lib --edition 2021 --target wasm32-wasip1 --emit=metadata -o /tmp/wp26/lint.rmeta /tmp/wp26/lint.rs > "$W/clippy.txt" 2>&1 || true
grep -q 'clippy::needless_return' "$W/clippy.txt" || { cat "$W/clippy.txt"; echo "FAIL: --clippy"; exit 1; }
printf 'fn  main( ){let x=1;}\n' | "${WT[@]}" --rustfmt --edition 2021 > "$W/fmt.txt" 2>/dev/null
[ "$(cat "$W/fmt.txt")" = "$(printf 'fn main() {\n    let x = 1;\n}')" ] || { cat "$W/fmt.txt"; echo "FAIL: --rustfmt"; exit 1; }
echo "  ok   release $rel: rustc-multi --clippy (needless_return), --rustfmt"
bash scripts/build-vfs.sh >/dev/null
bash scripts/build-resolver.sh >/dev/null
node scripts/build-web-tests.mjs >/dev/null
mkdir -p build/wp-26
pnpm exec playwright test tests/e2e/test-tools.spec.ts --project=chromium --reporter=line > build/wp-26/spec.log 2>&1 || { tail -60 build/wp-26/spec.log; echo "FAIL: test-tools.spec.ts"; exit 1; }
grep -oE '\[test-tools\] .*' build/wp-26/spec.log | sed 's/^/  ok   /'
echo "WP-26 verified."
