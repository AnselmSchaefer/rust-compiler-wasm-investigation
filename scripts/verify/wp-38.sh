#!/usr/bin/env bash
# WP-38 done-check (M2): an agent develops in the browser IDE through the relay alone.
#  1. tests/relay/scenario.py, headless and headed: a scripted MCP client through
#     tools/relay/relay.py: project with serde (live crates.io through the relay's index proxy),
#     seeded compile error fixed from the diagnostics, failing test fixed (and rerun by name),
#     Clippy and rustfmt clean, cargo_run; the WebSocket refuses a wrong token and a foreign Origin.
#  2. With WP38_AGENT=1: tests/relay/agent-run.sh headed and headless: Claude Code itself does the
#     task with only the relay's tools (uses the user's Claude Code plan), checked through the relay.
set -euo pipefail
cd "$(dirname "$0")/../.."
bash scripts/build-vfs.sh >/dev/null
bash scripts/build-resolver.sh >/dev/null
node scripts/build-app.mjs >/dev/null
for mode in headless headed; do
  python3 -I tests/relay/scenario.py --browser "$mode" | sed 's/^/  /' || { echo "FAIL: scenario ($mode)"; exit 1; }
done
if [ "${WP38_AGENT:-}" = 1 ]; then
  for mode in headed headless; do
    echo "  Claude Code ($mode):"
    bash tests/relay/agent-run.sh "$mode" | sed 's/^/  /' || { echo "FAIL: Claude Code ($mode)"; exit 1; }
  done
else
  echo "  skip Claude Code runs (WP38_AGENT=1 runs them; they use the user's Claude Code plan)"
fi
echo "WP-38 verified."
