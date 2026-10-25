#!/usr/bin/env bash
# WP-17 done-check: the build planner.
#  1. Golden: for each case in tests/planner/cases/ (recorded from native `cargo build -vv
#     --target wasm32-wasip1` by tests/planner/record.sh), the planner's units, rustc arguments
#     and environments (compiles and build-script runs) equal cargo's; only hashes differ.
#  2. Browser: `cargo build` of the serde_json case (serde_json, itoa, memchr, serde_core, zmij)
#     and the mix case (rand, regex, renamed serde_json) on 4 compile servers, with build scripts
#     run in the sandbox; both programs run and print the expected output.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ ! -d build/wp-15/index ]; then
  mkdir -p build/wp-15
  zstd -dc tests/resolver/index-snapshot.tar.zst | tar -x -C build/wp-15
fi
ls -d build/release/*/ >/dev/null 2>&1 || { echo "FAIL: no release (toolchain/release.sh)"; exit 1; }
# The compile server must take per-request env (OUT_DIR for serde_core's include!).
grep -q '"env"' toolchain/rustc-multi/main.rs
(cd crates && cargo test -q --release -p resolver --test plan_golden 2>&1 | grep -E '^(test result|[a-z_]+: [0-9]+ units)') || { echo "FAIL: planner golden test"; exit 1; }
bash scripts/build-vfs.sh >/dev/null
bash scripts/build-resolver.sh >/dev/null
node scripts/build-web-tests.mjs >/dev/null
mkdir -p build/wp-17
pnpm exec playwright test tests/e2e/build.spec.ts --project=chromium --reporter=line > build/wp-17/spec.log 2>&1 || { tail -40 build/wp-17/spec.log; echo "FAIL: build.spec.ts"; exit 1; }
f=$(ls -t bench/results/*-build-w4.json | head -1)
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1]));
for (const [name, c] of Object.entries(r.cases))
  console.log(`  ok   ${name}: ${c.packages} packages, ${c.units.length} units (${c.libs} libs, ${c.buildScripts} build scripts) built in ${c.ms.total} ms (deps ${c.ms.deps}, plan ${c.ms.plan}, build ${c.ms.build}) on ${r.workers} workers; runs`);
console.log(`  release ${r.release} (${process.argv[1]})`);
' "$f"
echo "WP-17 verified."
