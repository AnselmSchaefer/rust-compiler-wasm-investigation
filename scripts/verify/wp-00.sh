#!/usr/bin/env bash
# WP-00 done-check: tools present, hello world runs on every Wasm target, browsers expose required features.
set -euo pipefail
cd "$(dirname "$0")/../.."
bash scripts/doctor.sh

out=build/smoke; mkdir -p "$out"
expect() { grep -q "$2" <<<"$1" || { echo "FAIL: $3 printed: $1"; exit 1; }; }
for t in wasm32-wasip1 wasm32-wasip2 wasm32-wasip3; do
  rustc +nightly --target "$t" -O tests/smoke/hello.rs -o "$out/hello-$t.wasm"
  expect "$(wasmtime run "$out/hello-$t.wasm")" "Hello from Wasm" "$t"
  echo "  ok   smoke $t"
done
rustc +nightly --target wasm32-wasip1-threads -O tests/smoke/hello.rs -o "$out/hello-threads.wasm"
# wasi-threads was removed from wasmtime in v47; v46 is kept as wasmtime-threads.
expect "$(wasmtime-threads run -W threads=y,shared-memory=y -S threads=y "$out/hello-threads.wasm" 2>/dev/null)" \
  "thread says 42" "wasm32-wasip1-threads"
echo "  ok   smoke wasm32-wasip1-threads (real thread)"

pnpm exec playwright test tests/e2e/features.spec.ts
echo "WP-00 verified."
