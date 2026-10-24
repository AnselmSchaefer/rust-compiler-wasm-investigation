#!/usr/bin/env bash
# Assets for the WP-07 browser page (tests/e2e/rustc-host): our rustc.wasm and rustc-multi.wasm, and
# rustup 1.99.1's wasm32-wasip1 std as /sysroot (packaged by toolchain/package-sysroot.mjs).
set -euo pipefail
cd "$(dirname "$0")/.."
P=build/www/rustc-host
B=build/rustc-wasm
mkdir -p "$P"
ln -f "$B/build/wasm32-wasip1-threads/stage1/bin/rustc.wasm" "$P/rustc.wasm"
ln -f "$B/rustc-multi.wasm" "$P/rustc-multi.wasm"
node toolchain/package-sysroot.mjs "$P/sysroot" wasm32-wasip1
