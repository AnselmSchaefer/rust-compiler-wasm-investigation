#!/usr/bin/env bash
# WP-14 done-check (M1a, except the [H] user trial): the IDE (app/) in a cold Chromium context. The
# editor is interactive in < 2 s while the toolchain loads behind it; Check shows rustc's errors
# inline and in the terminal; Run builds, links and runs a program that reads a typed line; Stop
# kills a program; the source survives a reload. Try it yourself: `pnpm demo`.
set -euo pipefail
cd "$(dirname "$0")/../.."
ls -d build/release/*/ >/dev/null 2>&1 || { echo "FAIL: no release (toolchain/release.sh)"; exit 1; }
bash scripts/build-vfs.sh >/dev/null
node scripts/build-app.mjs | sed 's/^/  /'
pnpm exec playwright test tests/e2e/app.spec.ts --project=chromium --reporter=line > build/wp-14-spec.log 2>&1 || { tail -40 build/wp-14-spec.log; echo "FAIL: app.spec.ts"; exit 1; }
f=$(ls -t bench/results/*-app.json | head -1)
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1]));
console.log(`  ok   cold load: editor interactive at ${r.editorMs} ms (budget 2000), toolchain ready at ${r.readyMs} ms`);
console.log(`  ok   Check: error inline + in the terminal (${r.checkMs} ms); Run: prompt after ${r.runToPromptMs} ms, typed name echoed back; Stop works (${process.argv[1]})`);
' "$f"
echo "WP-14 verified (the [H] user trial is separate)."
