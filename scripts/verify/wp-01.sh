#!/usr/bin/env bash
# WP-01 done-check: the oligamiq rust_wasm v3 rustc.wasm compiles and runs hello world
# under wasmtime-threads and in Chromium + Firefox (tests/e2e/baseline.spec.ts).
set -euo pipefail
cd "$(dirname "$0")/../.."
bash scripts/fetch-baseline.sh
v=build/vendor/rust_wasm-v3

# wasmtime: rustc puts its temp dir at /rustcXXXX regardless of TMPDIR, so the work dir is mapped to /.
w=build/wp-01/wasmtime; rm -rf "$w"; mkdir -p "$w"
cp tests/smoke/hello.rs "$w/"
wasmtime-threads run -W threads=y,shared-memory=y -S threads=y --dir "$w::/" --dir "$v/sysroot::/sysroot" \
  "$v/rustc_opt.wasm" /hello.rs --sysroot /sysroot --target wasm32-wasip1 -o /hello.wasm >/dev/null 2>&1
out=$(wasmtime run "$w/hello.wasm")
grep -q Hello <<<"$out" || { echo "FAIL: wasmtime hello printed: $out"; exit 1; }
echo "  ok   rustc.wasm under wasmtime-threads: $out"

node scripts/build-baseline.mjs
# Chromium is the gate (scope decision 2026-10-24); Firefox is best-effort.
pnpm exec playwright test tests/e2e/baseline.spec.ts --project=chromium --reporter=line
echo "WP-01 verified."
