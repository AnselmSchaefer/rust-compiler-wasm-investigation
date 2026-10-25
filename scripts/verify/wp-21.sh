#!/usr/bin/env bash
# WP-21 done-check: build scripts.
#  1. The planner plans build scripts as cargo does, `links` metadata (DEP_<links>_*) and
#     dependencies' -L included: all golden cases, among them tests/planner/cases/scripts,
#     identical to `cargo build -vv`.
#  2. The release's rustc-multi takes a working directory and stdin per server request (a build
#     script's `rustc -` probe), and answers --version on stdout.
#  3. Chromium (tests/e2e/build-scripts.spec.ts): `cargo build` of the scripts case. autocfg
#     (num-traits), rustversion, libc, proc-macro2, anyhow and the links pair print exactly what
#     they printed natively, and the program prints what the native build's prints; after a
#     reload with main.rs edited, only the bin is built.
#  4. tools/prebuild runs build scripts with the same rustc probes: WP-18's check (scripts/verify/
#     wp-18.sh: same keys, bit-identical outputs, and now the same script stdout, browser vs
#     wasmtime) still passes.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ ! -d build/wp-15/index ]; then
  mkdir -p build/wp-15
  zstd -dc tests/resolver/index-snapshot.tar.zst | tar -x -C build/wp-15
fi
(cd crates && cargo test -q --release -p resolver --test plan_golden -- --nocapture 2>&1 | grep -E '^(test result|scripts: [0-9]+ units)') || { echo "FAIL: planner golden test"; exit 1; }
[ -f build/wp-17/record/scripts/root/target/wasm32-wasip1/debug/scripts.wasm ] || tests/planner/record.sh scripts >/dev/null
bash scripts/build-vfs.sh >/dev/null
bash scripts/build-resolver.sh >/dev/null
node scripts/build-web-tests.mjs >/dev/null
mkdir -p build/wp-21
pnpm exec playwright test tests/e2e/build-scripts.spec.ts --project=chromium --reporter=line > build/wp-21/spec.log 2>&1 || { tail -60 build/wp-21/spec.log; echo "FAIL: build-scripts.spec.ts"; exit 1; }
grep -oE '\[build-scripts(-edit)?\] .*' build/wp-21/spec.log | sed 's/^/  ok   /'
bash scripts/verify/wp-18.sh | sed 's/^/  wp-18: /' || { echo "FAIL: WP-18's determinism check with build-script probes"; exit 1; }
# Step 2 on prebuild's guest root (laid out like the browser's VFS; step 4 created it).
rel=$(ls -t build/release | head -1)
R=build/prebuild/work/root; W=build/wp-21/server
rm -rf "$W" "$R/tmp/wp21"; mkdir -p "$W" "$R/tmp/wp21/out"
brotli -dc "build/release/$rel/rustc-wasmtime.wasm.br" > "$W/rustc.wasm"
printf '%s\n' '{"id":1,"args":["--version"]}' \
  '{"id":2,"args":["--crate-name","probe","--crate-type=lib","--out-dir","out","--emit=metadata","--target","wasm32-wasip1","-"],"cwd":"/tmp/wp21","stdin":"pub fn f() -> u128 { 1 }"}' \
  '{"id":3,"quit":true}' > "$W/req.jsonl"
wasmtime-threads run -C cache=y -W threads=y,shared-memory=y,exceptions=y -S threads=y --dir "$R::/" --env RUST_MIN_STACK=16777216 \
  --argv0 /sysroot/bin/rustc "$W/rustc.wasm" --server < "$W/req.jsonl" > "$W/out.txt" 2>/dev/null || true
grep -q '^rustc 1\.' "$W/out.txt" && grep -q '"exit":0,"id":2' "$W/out.txt" && [ -f "$R/tmp/wp21/out/libprobe.rmeta" ] \
  || { cat "$W/out.txt"; echo "FAIL: rustc-multi server: --version, or a stdin probe in a working directory"; exit 1; }
echo "  ok   release $rel: rustc-multi prints --version, runs a stdin probe relative to its cwd"
echo "WP-21 verified."
