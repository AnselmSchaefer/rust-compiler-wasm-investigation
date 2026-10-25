#!/usr/bin/env bash
# WP-38's done-when with a real agent: Claude Code (`claude -p`), connected to the relay's MCP
# server and to nothing else (no built-in tools, --strict-mcp-config), does tests/relay/agent-task.md
# in the browser IDE. Then tests/relay/check-agent.py checks the project through the relay.
# Uses the user's Claude Code plan: run it only with the user's go-ahead ([H]).
#   tests/relay/agent-run.sh headed|headless [model]
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
MODE=${1:-headless}; MODEL=${2:-}
W="$ROOT/build/wp-38/agent-$MODE"; PORT=$([ "$MODE" = headed ] && echo 8792 || echo 8793)
rm -rf "$W"; mkdir -p "$W"
# The relay as the agent's only MCP server; the agent runs in an empty directory (no CLAUDE.md).
cat > "$W/mcp.json" <<JSON
{ "mcpServers": { "rust-ide": { "command": "python3", "args": ["-I", "$ROOT/tools/relay/relay.py", "--browser", "$MODE", "--port", "$PORT"] } } }
JSON
cd "$W"
t0=$(date +%s)
claude -p "$(cat "$ROOT/tests/relay/agent-task.md")" --mcp-config "$W/mcp.json" --strict-mcp-config --tools "" \
  --allowedTools "mcp__rust-ide" --output-format json ${MODEL:+--model "$MODEL"} > "$W/claude.json" 2> "$W/claude.err" || { tail -20 "$W/claude.err"; exit 1; }
echo "  claude finished in $(( $(date +%s) - t0 )) s"
python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print("  agent:", (r.get("result") or "")[:1500].replace("\n", "\n  agent: ")); print(f"  turns {r.get(\"num_turns\")}, cost {r.get(\"total_cost_usd\")}")' "$W/claude.json"
python3 -I "$ROOT/tests/relay/check-agent.py" --project wp38-agent --port $((PORT + 10)) --browser "$MODE"
