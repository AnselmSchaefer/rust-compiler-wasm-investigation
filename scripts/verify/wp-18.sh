#!/usr/bin/env bash
# WP-18 done-check: the build cache (L1 OPFS, L2 read-only HTTP) and tools/prebuild.
#  1. tools/prebuild builds the three planner cases (serde_json, mix, more: 30 registry crates)
#     under wasmtime with the release's rustc.wasm/wasm-ld.wasm, from scratch, into the L2 dir
#     build/l2/<RUSTC_ID>/, and the programs run.
#  2. Chromium (tests/e2e/cache.spec.ts): a cold build of the same cases with an empty L1; after a
#     reload, a second build is all L1 hits; edit → run is timed; with an empty L1 and the L2 from
#     step 1, every unit but the edited bin comes from L2.
#  3. Determinism: every unit of the browser's cold build has the same key and bit-identical
#     outputs as prebuild's (≥ 20 registry crates).
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ ! -d build/wp-15/index ]; then
  mkdir -p build/wp-15
  zstd -dc tests/resolver/index-snapshot.tar.zst | tar -x -C build/wp-15
fi
ls -d build/release/*/ >/dev/null 2>&1 || { echo "FAIL: no release (toolchain/release.sh)"; exit 1; }
(cd crates && cargo test -q --release -p resolver --test plan_golden 2>&1 | grep -E '^test result') || { echo "FAIL: planner golden test"; exit 1; }
bash scripts/build-vfs.sh >/dev/null
bash scripts/build-resolver.sh >/dev/null
node scripts/build-web-tests.mjs >/dev/null
node scripts/build-prebuild.mjs >/dev/null
mkdir -p build/wp-18
cases=(tests/planner/cases/serde_json tests/planner/cases/mix tests/planner/cases/more)
node build/prebuild/prebuild.mjs --rebuild --report build/wp-18/prebuild.json "${cases[@]}" | sed 's/^/  prebuild /' || { echo "FAIL: prebuild"; exit 1; }
node -e '
const r = JSON.parse(require("fs").readFileSync("build/wp-18/prebuild.json"));
for (const [n, c] of Object.entries(r.cases)) if (c.run?.code !== 0) { console.log(`FAIL: prebuild ${n} does not run`); process.exit(1); }'
pnpm exec playwright test tests/e2e/cache.spec.ts --project=chromium --reporter=line > build/wp-18/spec.log 2>&1 || { tail -40 build/wp-18/spec.log; echo "FAIL: cache.spec.ts"; exit 1; }
f=$(ls -t bench/results/*-cache.json | head -1)
node tests/cache/compare.mjs "$f" build/wp-18/prebuild.json || { echo "FAIL: browser and wasmtime builds differ"; exit 1; }
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1]));
for (const [k, s] of Object.entries(r.steps))
  console.log(`  ok   ${k}: ${s.units} units (${s.built} built, ${s.l1} L1, ${s.l2} L2, ${s.fresh} in VFS; ${s.skipped} not needed), build+run ${s.ms.buildAndRun} ms`);
console.log(`  release ${r.release} (${process.argv[1]})`);
' "$f"
echo "WP-18 verified."
