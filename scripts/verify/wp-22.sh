#!/usr/bin/env bash
# WP-22 done-check (M1): ≥ 90% of the top 100 crates (tests/ecosystem/top100.json) build in the
# browser, with default features, as a dependency of an empty lib.
#  1. Native baseline (tests/ecosystem/native.sh replay): native cargo for wasm32-wasip1 against
#     the ecosystem index snapshot; crates that fail there are class `target`.
#  2. Chromium (tests/e2e/ecosystem.spec.ts, ECO=1): every crate, one page each, L1 carried over.
#  3. tests/ecosystem/report.mjs → tests/ecosystem/results.md; passes / 100 ≥ 90 (target-class
#     failures count as failures).
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -d build/wp-22/index ] || { mkdir -p build/wp-22; zstd -dc tests/ecosystem/index-snapshot.tar.zst | tar -x -C build/wp-22; }
tests/ecosystem/native.sh replay > build/wp-22/native.log 2>&1 || { tail -20 build/wp-22/native.log; echo "FAIL: native baseline"; exit 1; }
echo "  ok   native: $(grep -c ' true ' build/wp-22/native.log)/$(wc -l < build/wp-22/native.log) build for wasm32-wasip1"
bash scripts/build-vfs.sh >/dev/null
bash scripts/build-resolver.sh >/dev/null
node scripts/build-web-tests.mjs >/dev/null
ECO=1 pnpm exec playwright test tests/e2e/ecosystem.spec.ts --project=chromium --reporter=line > build/wp-22/spec.log 2>&1 || { tail -40 build/wp-22/spec.log; echo "FAIL: ecosystem.spec.ts"; exit 1; }
node tests/ecosystem/report.mjs | sed 's/^/  /'
node -e '
const s = JSON.parse(require("fs").readFileSync("build/wp-22/summary.json"));
if (s.passed * 100 < 90 * s.total) { console.log(`FAIL: ${s.passed}/${s.total} < 90%`); process.exit(1); }'
echo "WP-22 verified (M1)."
