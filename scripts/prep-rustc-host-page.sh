#!/usr/bin/env bash
# Assets for the WP-07 browser page (tests/e2e/rustc-host): our rustc.wasm and rustc-multi.wasm, and
# rustup 1.99.1's wasm32-wasip1 std as /sysroot. Hard links, so nothing is copied.
set -euo pipefail
cd "$(dirname "$0")/.."
P=build/www/rustc-host
B=build/rustc-wasm
mkdir -p "$P"
ln -f "$B/build/wasm32-wasip1-threads/stage1/bin/rustc.wasm" "$P/rustc.wasm"
ln -f "$B/rustc-multi.wasm" "$P/rustc-multi.wasm"
RL=$(rustc +1.99.1 --print sysroot)/lib/rustlib
rm -rf "$P/sysroot"; mkdir -p "$P/sysroot/lib/rustlib/wasm32-wasip1"
cp -al "$RL/wasm32-wasip1/lib" "$P/sysroot/lib/rustlib/wasm32-wasip1/"
(cd "$P/sysroot" && find lib -type f | sort | node -e 'console.log(JSON.stringify(require("fs").readFileSync(0, "utf8").trim().split("\n")))') > "$P/sysroot.json"
echo "prepared $P ($(node -e 'console.log(require("./'"$P"'/sysroot.json").length)') sysroot files)"
