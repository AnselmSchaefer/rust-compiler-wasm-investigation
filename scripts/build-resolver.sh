#!/usr/bin/env bash
# Build crates/resolver for the browser (WP-16) → build/www/resolver/resolver.wasm (+ .br).
# A wasm32-wasip1 cdylib (cargo-util-schemas needs url's file-path API, which wasm32-unknown-unknown lacks); web/deps/resolver.ts gives it a few WASI stubs; web/deps/resolver.ts drives its exports (src/wasm.rs).
set -euo pipefail
cd "$(dirname "$0")/../crates"
nice cargo build -q -p resolver --release --lib --target wasm32-wasip1
mkdir -p ../build/www/resolver
cp target/wasm32-wasip1/release/resolver.wasm ../build/www/resolver/resolver.wasm
brotli -f -q 11 ../build/www/resolver/resolver.wasm
echo "built build/www/resolver/resolver.wasm ($(stat -c %s ../build/www/resolver/resolver.wasm) bytes, $(stat -c %s ../build/www/resolver/resolver.wasm.br) brotli)"
