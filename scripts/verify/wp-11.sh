#!/usr/bin/env bash
# WP-11 done-check: VFS unit tests pass natively; in Chromium two workers see each other's writes
# and files survive a reload (OPFS); the baseline rustc.wasm builds and runs programs on the VFS +
# WASI adapter.
set -euo pipefail
cd "$(dirname "$0")/../.."
(cd crates && cargo test -q -p vfs 2>&1 | grep -E "^test result" | head -1)
bash scripts/build-vfs.sh
bash scripts/fetch-baseline.sh >/dev/null
node scripts/build-web-tests.mjs
pnpm exec playwright test tests/e2e/vfs.spec.ts tests/e2e/wasi-rustc.spec.ts --project=chromium --reporter=line
echo "WP-11 verified."
