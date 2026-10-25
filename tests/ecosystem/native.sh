#!/usr/bin/env bash
# WP-22 native baseline: `cargo +<RUST_TAG> build --target wasm32-wasip1` of each wrapper
# (wrappers.mjs) against the ecosystem index snapshot, through tests/resolver/index-proxy.mjs
# (record: fetch what's missing from index.crates.io and keep it; replay: offline). A crate that
# doesn't build natively for wasm32-wasip1 can't be expected to build in the browser.
#   tests/ecosystem/native.sh record|replay [list.json]
# Output: build/wp-22/native/<name>.log and build/wp-22/native.json ({name: {ok, ms, error}}).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
source "$ROOT/toolchain/versions.env"
MODE=$1; LIST=${2:-$ROOT/tests/ecosystem/top100.json}
W=$ROOT/build/wp-22; IDX=$W/index; PORT=8796
mkdir -p "$W/home" "$W/native" "$IDX"
if [ ! -f "$IDX/config.json" ] && [ -f "$ROOT/tests/ecosystem/index-snapshot.tar.zst" ] && [ "$MODE" = replay ]; then
  zstd -dc "$ROOT/tests/ecosystem/index-snapshot.tar.zst" | tar -x -C "$W"
fi
node "$ROOT/tests/ecosystem/wrappers.mjs" "$LIST" "$W/wrappers" >/dev/null
printf '[source.crates-io]\nreplace-with = "snap"\n[source.snap]\nregistry = "sparse+http://localhost:%s/"\n[net]\nretry = 0\n' "$PORT" > "$W/home/config.toml"
node "$ROOT/tests/resolver/index-proxy.mjs" "$MODE" "$IDX" "$PORT" > "$W/proxy.log" 2>&1 & proxy=$!
trap 'kill $proxy 2>/dev/null' EXIT
for _ in $(seq 50); do grep -q 'index proxy' "$W/proxy.log" 2>/dev/null && break; sleep 0.1; done
echo '{' > "$W/native.json.tmp"; first=1
for d in "$W"/wrappers/*/; do
  n=$(basename "$d")
  t0=$(date +%s%N)
  if (cd "$d" && CARGO_HOME="$W/home" CARGO_TARGET_DIR="$W/native-target" cargo "+$RUST_TAG" build --target wasm32-wasip1 -q) > "$W/native/$n.log" 2>&1; then ok=true; else ok=false; fi
  ms=$(( ($(date +%s%N) - t0) / 1000000 ))
  err=$( (grep -m1 -E '^error' "$W/native/$n.log" || true) | head -c 300 | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')
  [ $first = 1 ] || echo ',' >> "$W/native.json.tmp"; first=0
  printf '"%s": {"ok": %s, "ms": %s, "error": %s}' "$n" "$ok" "$ms" "$err" >> "$W/native.json.tmp"
  echo "$n $ok ${ms}ms"
done
echo '}' >> "$W/native.json.tmp"; mv "$W/native.json.tmp" "$W/native.json"
