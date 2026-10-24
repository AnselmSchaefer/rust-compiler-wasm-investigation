#!/usr/bin/env bash
# WP-15 done-check: our resolver (crates/resolver) reproduces native cargo 1.99.1's Cargo.lock
# for the 50-crate golden corpus against the pinned index snapshot (need ≥ 48/50 identical),
# natively and as wasm32-wasip1 under wasmtime; the synthetic scenarios match native cargo too.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
if [ ! -d build/wp-15/index ]; then
  mkdir -p build/wp-15
  zstd -dc tests/resolver/index-snapshot.tar.zst | tar -x -C build/wp-15
fi

# 1. Native: golden corpus + scenario unit tests.
(cd crates && cargo test --release -p resolver -- --nocapture 2>&1) | tee build/wp-15/test.log | grep -E '^golden:|^test result'
grep -q '^test result: ok. 1 passed' build/wp-15/test.log
! grep -q 'FAILED' build/wp-15/test.log

# 2. Scenarios against native cargo.
tests/resolver/check-scenarios.sh > build/wp-15/scenarios.log || { cat build/wp-15/scenarios.log; exit 1; }
echo "scenarios: $(grep -c '  ok' build/wp-15/scenarios.log) match native cargo"

# 3. The same resolver as wasm32-wasip1 under wasmtime, all 50 crates.
(cd crates && cargo build -q --release -p resolver --example generate-lockfile --target wasm32-wasip1)
WASM=crates/target/wasm32-wasip1/release/examples/generate-lockfile.wasm
same=0; total=0
for name in $(grep -v '^#' tests/resolver/corpus.txt | sed '/^\s*$/d'); do
  total=$((total + 1))
  if wasmtime run --dir build/wp-15/index::/index --dir tests/resolver::/t "$WASM" "/t/manifests/$name.toml" /index \
      | cmp -s - "tests/resolver/golden/$name.lock"; then
    same=$((same + 1))
  else
    echo "  wasm DIFF $name"
  fi
done
echo "wasm32-wasip1: $same/$total identical ($(du -k "$WASM" | cut -f1) KiB)"
[ "$same" -ge 48 ]
echo "WP-15 verified."
