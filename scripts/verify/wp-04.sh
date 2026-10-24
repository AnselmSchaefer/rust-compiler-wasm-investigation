#!/usr/bin/env bash
# WP-04 done-check: llc.wasm and wasm-ld.wasm (LLVM 23.1 for a wasm32-wasip1-threads host) run under
# wasmtime-threads: llc compiles tests/smoke/hello-wasi.ll, wasm-ld links it, and the result prints.
set -euo pipefail
cd "$(dirname "$0")/../.."
inst=build/llvm-wasm-install
for f in "$inst/bin/llc.wasm" "$inst/bin/wasm-ld.wasm" "$inst/lib/libLLVMWebAssemblyCodeGen.a" "$inst/lib/liblldWasm.a"; do
  [ -f "$f" ] || { echo "FAIL: missing $f (run toolchain/build-llvm.sh)"; exit 1; }
done

w=build/wp-04/smoke; rm -rf "$w"; mkdir -p "$w"
cp tests/smoke/hello-wasi.ll "$w/"
run() { wasmtime-threads run -W threads=y,shared-memory=y -S threads=y --dir "$w::/" "$@" 2>&1 | grep -v '^WARNING: the `-Sthreads`' || true; }
run "$inst/bin/llc.wasm" -filetype=obj /hello-wasi.ll -o /hello.o
[ -s "$w/hello.o" ] || { echo "FAIL: llc.wasm produced no object"; exit 1; }
echo "  ok   llc.wasm: $(stat -c %s "$w/hello.o") byte object"
run "$inst/bin/wasm-ld.wasm" -flavor wasm /hello.o -o /hello.wasm
[ -s "$w/hello.wasm" ] || { echo "FAIL: wasm-ld.wasm produced no module"; exit 1; }
out=$(wasmtime run "$w/hello.wasm")
[ "$out" = "Hello from llc + wasm-ld" ] || { echo "FAIL: linked program printed: $out"; exit 1; }
echo "  ok   wasm-ld.wasm: linked program prints \"$out\""

mib() { awk -v b="$(stat -c %s "$1")" 'BEGIN { printf "%.1f MiB", b / 1048576 }'; }
echo "  sizes: llc.wasm $(mib "$inst/bin/llc.wasm"), wasm-ld.wasm $(mib "$inst/bin/wasm-ld.wasm"), static libs $(du -sh "$inst/lib" | cut -f1)"
echo "WP-04 verified."
