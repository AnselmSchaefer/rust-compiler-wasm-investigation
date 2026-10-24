#!/usr/bin/env bash
# WP-12 done-check: in Chromium, the orchestrator worker (web/orchestrator) compiles *and links*
# hello and medium with only our toolchain release (served at /release/, brotli, sha256-checked):
# compile server for rustc, wasm-ld.wasm for linking. The programs run, errors are reported, no
# scratch files are left, and after a reload the toolchain comes from Cache Storage.
set -euo pipefail
cd "$(dirname "$0")/../.."
ls -d build/release/*/ >/dev/null 2>&1 || { echo "FAIL: no release (toolchain/release.sh)"; exit 1; }
bash scripts/build-vfs.sh >/dev/null
node scripts/build-web-tests.mjs >/dev/null
pnpm exec playwright test tests/e2e/orchestrator.spec.ts --project=chromium --reporter=line > build/wp-12-spec.log 2>&1 || { tail -40 build/wp-12-spec.log; echo "FAIL: orchestrator.spec.ts"; exit 1; }
f=$(ls -t bench/results/*-orchestrator.json | head -1)
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1])), a = r.first, b = r.second;
const mib = x => (x / 2 ** 20).toFixed(0);
console.log(`  ok   release ${r.release}: loaded and verified in ${a.init.ms} ms (${a.init.loads.map(l => `${l.file} ${mib(l.bytes)} MiB`).join(", ")})`);
console.log(`  ok   build hello (compile + link, first: fetches lld and the link group) ${a.firstBuildMs} ms; rebuild ${a.rebuild.total} ms (rustc ${a.rebuild.rustc}, link ${a.rebuild.link}); runs`);
console.log(`  ok   check hello ${a.check.total} ms (no link); build medium ${a.buildMedium.total} ms; runs; error reported; no scratch left`);
console.log(`  ok   after reload: init ${b.init.ms} ms from Cache Storage, build hello ${b.firstBuildMs} ms (${process.argv[1]})`);
' "$f"
echo "WP-12 verified."
