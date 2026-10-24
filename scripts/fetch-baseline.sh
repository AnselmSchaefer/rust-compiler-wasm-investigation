#!/usr/bin/env bash
# Download and unpack the oligamiq rust_wasm prebuilt toolchain (WP-01 baseline) into build/vendor/.
# Idempotent: skips files that are already present.
set -euo pipefail
cd "$(dirname "$0")/.."
tag=v3.0.0-release
dir=build/vendor/rust_wasm-v3
mkdir -p "$dir"
cd "$dir"

for f in rustc_opt.wasm.br rustc_unwind_opt.wasm.br llvm_opt.wasm.br wasm32-wasip1.tar.br; do
  [ -f "$f" ] || gh release download "$tag" -R oligamiq/rust_wasm -p "$f"
  case "$f" in *.wasm.br) [ -f "${f%.br}" ] || brotli -dk "$f" ;; esac
done

# rustc looks for target libs in <sysroot>/lib/rustlib/<target>/lib; the tarball is flat.
lib=sysroot/lib/rustlib/wasm32-wasip1/lib
if [ ! -f "$lib/.stamp" ]; then
  rm -rf sysroot && mkdir -p "$lib"
  brotli -dc wasm32-wasip1.tar.br | tar -x -C "$lib"
  touch "$lib/.stamp"
fi

# Per-file brotli variants so the dev server can send them with Content-Encoding: br (realistic transfer sizes).
find sysroot -type f ! -name .stamp ! -name '*.br' | while read -r f; do [ -f "$f.br" ] || brotli -q 9 -k "$f"; done

# File list for the browser harness, which cannot list directories over HTTP.
(cd sysroot && find . -type f ! -name .stamp ! -name '*.br' | sed 's|^\./||' | sort) \
  | python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin]))' > sysroot.json
echo "baseline toolchain ready in $dir"
