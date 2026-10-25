#!/usr/bin/env bash
# WP-27a done-check: warm latency against PROPOSAL §6 on the 500-line benchmark, in Chromium.
#  1. The planner plans `cargo check` as cargo does: golden case tests/planner/cases/check
#     identical to `cargo check -vv`.
#  2. tests/e2e/warm.spec.ts: warm `check` median < 1 s and warm edit → run median < 2 s on
#     bench/programs/medium.rs as a project (and the numbers for a project with dependencies).
# Incremental compilation (WP-27b) is blocked on file locks in rustc on WASI: docs/incremental.md.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ ! -d build/wp-15/index ]; then
  mkdir -p build/wp-15
  zstd -dc tests/resolver/index-snapshot.tar.zst | tar -x -C build/wp-15
fi
(cd crates && cargo test -q --release -p resolver --test plan_golden -- --nocapture 2>&1 | grep -E '^(test result|check: [0-9]+ units)') || { echo "FAIL: planner golden test"; exit 1; }
bash scripts/build-vfs.sh >/dev/null
bash scripts/build-resolver.sh >/dev/null
node scripts/build-web-tests.mjs >/dev/null
mkdir -p build/wp-27
pnpm exec playwright test tests/e2e/warm.spec.ts --project=chromium --reporter=line > build/wp-27/spec.log 2>&1 || { tail -40 build/wp-27/spec.log; echo "FAIL: warm.spec.ts"; exit 1; }
grep -oE '\[warm\] .*' build/wp-27/spec.log | sed 's/^/  ok   /'
echo "WP-27a verified."
