#!/usr/bin/env bash
# WP-13 done-check: programs compiled by the orchestrator run in the sandbox (web/sandbox) in
# Chromium: stdin/args/env/files in and out with an exit code, a panic (non-zero exit, message on
# stderr), a busy loop killed by a timeout, an interactive program fed line by line, and a kill.
set -euo pipefail
cd "$(dirname "$0")/../.."
ls -d build/release/*/ >/dev/null 2>&1 || { echo "FAIL: no release (toolchain/release.sh)"; exit 1; }
bash scripts/build-vfs.sh >/dev/null
node scripts/build-web-tests.mjs >/dev/null
pnpm exec playwright test tests/e2e/sandbox.spec.ts --project=chromium --reporter=line > build/wp-13-spec.log 2>&1 || { tail -40 build/wp-13-spec.log; echo "FAIL: sandbox.spec.ts"; exit 1; }
node -e '
const log = require("fs").readFileSync("build/wp-13-spec.log", "utf8");
const r = JSON.parse(log.slice(log.indexOf("{\n"), log.lastIndexOf("\n}") + 2));
console.log(`  ok   stdin + args + env + files: exit ${r.io.code} in ${r.io.ms} ms, /data/out.txt written back`);
console.log(`  ok   panic: exit ${r.panic.code} (${r.panic.trap}), message on stderr`);
console.log(`  ok   busy loop: killed by the 1 s timeout after ${r.spinMs} ms`);
console.log(`  ok   interactive: ${JSON.stringify(r.repl.stdout)} streamed in ${r.repl.chunks} chunks; kill while waiting for input: ${r.killed.ms} ms`);
'
echo "WP-13 verified."
