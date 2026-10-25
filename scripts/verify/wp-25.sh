#!/usr/bin/env bash
# WP-25 done-check: projects and workspaces.
#  1. Resolver/planner (native): the workspace loader's and the Cargo.toml editor's unit tests,
#     and the planner golden test, now with two workspace cases recorded from native cargo
#     (tests/planner/cases/ws: virtual, members by glob, an excluded path dependency, package /
#     dependency / lints inheritance; ws-root: a root package whose path dependency becomes a
#     member). Units, arguments, environments and Cargo.lock must equal cargo's.
#  2. Chromium (tests/e2e/projects.spec.ts): a zipped workspace with ≥ 2 members is imported,
#     survives a reload (OPFS) and builds and runs; Cargo.toml edits report lockfile changes (a
#     failing one changes nothing); zip export round-trips; a GitHub repository imports.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ ! -d build/wp-15/index ]; then
  mkdir -p build/wp-15
  zstd -dc tests/resolver/index-snapshot.tar.zst | tar -x -C build/wp-15
fi
ls -d build/release/*/ >/dev/null 2>&1 || { echo "FAIL: no release (toolchain/release.sh)"; exit 1; }
(cd crates && cargo test -q --release -p resolver --lib 2>&1 | grep -E '^test result') || { echo "FAIL: resolver unit tests"; exit 1; }
(cd crates && cargo test -q --release -p resolver --test plan_golden -- --nocapture 2>&1 | grep -E '^(test result|[a-z_-]+: [0-9]+ units)') || { echo "FAIL: planner golden test"; exit 1; }
bash scripts/build-vfs.sh >/dev/null
bash scripts/build-resolver.sh >/dev/null
node scripts/build-web-tests.mjs >/dev/null
mkdir -p build/wp-25
pnpm exec playwright test tests/e2e/projects.spec.ts --project=chromium --reporter=line > build/wp-25/spec.log 2>&1 || { tail -40 build/wp-25/spec.log; echo "FAIL: projects.spec.ts"; exit 1; }
f=$(ls -t bench/results/*-projects.json | head -1)
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1]));
console.log(`  ok   import: ${r.import.files} files from a zip; after a reload ${r.reload.restored} restored from OPFS (init ${r.reload.initMs} ms)`);
console.log(`  ok   build: ${r.build.packages} packages, ${r.build.units} units (${r.build.local.join(", ")}) in ${r.build.ms.total} ms; app runs`);
console.log(`  ok   edits: add ${JSON.stringify(r.edits.add)}, remove ${JSON.stringify(r.edits.remove)}; failing edit: ${r.edits.bad}`);
console.log(`  ok   export ${r.export.bytes} bytes, round trip; GitHub import ${r.github.files} files in ${r.github.ms} ms`);
' "$f"
echo "WP-25 verified."
