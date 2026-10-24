#!/usr/bin/env bash
# WP-02 done-check: `pnpm bench` produces a result JSON with Chromium numbers, compare.ts reads it,
# and bench/baseline.md exists.
set -euo pipefail
cd "$(dirname "$0")/../.."
before=$(ls bench/results/*.json 2>/dev/null | wc -l)
file=$(pnpm --silent bench --iters 1 | tail -1)
[ -f "$file" ] || { echo "FAIL: bench did not write a result file"; exit 1; }
python3 - "$file" <<'EOF'
import json, sys
r = json.load(open(sys.argv[1]))
steps = r["browsers"]["chromium"]["steps"]
need = ["version", "check-hello", "build-hello", "check-medium", "build-medium", "build-medium-O", "run-hello", "run-medium"]
missing = [s for s in need if s not in steps]
assert not missing, f"missing chromium steps: {missing}"
assert r["browsers"]["chromium"]["load"]["transferBytes"] > 0
for k in ("wasmtime", "native"):
    assert k in r and r[k]["steps"]["build-hello"]["median"] > 0, k
print(f"  ok   {sys.argv[1]}: chromium build-hello {steps['build-hello']['median']} ms")
EOF
node bench/compare.ts "$file" "$file" >/dev/null && echo "  ok   compare.ts"
grep -q "Chromium" bench/baseline.md && echo "  ok   bench/baseline.md"
# The --iters 1 smoke result is not a real measurement; drop it unless it is the only one.
[ "$before" -gt 0 ] && rm "$file"
echo "WP-02 verified."
