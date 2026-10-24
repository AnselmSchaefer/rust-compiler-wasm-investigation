#!/usr/bin/env bash
# Build crates/vfs as a shared-memory wasm module (WP-11) → build/www/vfs/vfs.wasm.
# Every worker instantiates it on one shared WebAssembly.Memory, so it needs atomics (and a
# std-less core/alloc built with them) and an exported __stack_pointer (one stack per instance).
set -euo pipefail
cd "$(dirname "$0")/../crates"
RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals \
  -C link-arg=--shared-memory -C link-arg=--import-memory -C link-arg=--max-memory=4294967296 \
  -C link-arg=--export=__stack_pointer" \
  nice cargo +nightly build -q -p vfs --release --target wasm32-unknown-unknown -Zbuild-std=core,alloc
mkdir -p ../build/www/vfs
cp target/wasm32-unknown-unknown/release/vfs.wasm ../build/www/vfs/vfs.wasm
echo "built build/www/vfs/vfs.wasm ($(stat -c %s ../build/www/vfs/vfs.wasm) bytes)"
