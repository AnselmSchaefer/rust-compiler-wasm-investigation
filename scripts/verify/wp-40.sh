#!/usr/bin/env bash
# WP-40 done-check: the hands-on IDE (app/ide.html), one page for a person and an agent.
#  1. Chromium (tests/e2e/ide.spec.ts): the guided sample through the UI: Sample, Run with typed
#     input (first build: serde with serde_derive as a Wasm proc macro, a build script), Test with
#     one failure, the fix in the editor, Rerun of that test alone, Clippy (needless_return; the
#     problem jumps to its line, an editor marker), the fix, Format, Check clean, + Dependency,
#     Export.
#  2. The agent through the relay on the same page: tests/relay/scenario.py, headless.
#  3. The user tries it by hand and signs off [H] (not checked here).
set -euo pipefail
cd "$(dirname "$0")/../.."
bash scripts/build-vfs.sh >/dev/null
bash scripts/build-resolver.sh >/dev/null
node scripts/build-app.mjs >/dev/null
mkdir -p build/wp-40
pnpm exec playwright test tests/e2e/ide.spec.ts --project=chromium --reporter=line > build/wp-40/spec.log 2>&1 || { tail -40 build/wp-40/spec.log; echo "FAIL: ide.spec.ts"; exit 1; }
grep -oE '\[ide\] .*' build/wp-40/spec.log | sed 's/^/  ok   /'
python3 -I tests/relay/scenario.py --browser headless | tail -1 | sed 's/^/  ok   /' || { echo "FAIL: the agent through the relay"; exit 1; }
echo "WP-40 verified (the user's sign-off is separate)."
