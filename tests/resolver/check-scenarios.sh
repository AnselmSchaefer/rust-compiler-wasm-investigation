#!/usr/bin/env bash
# Cross-check the resolver's scenario tests (crates/resolver/tests/scenarios.rs) against native
# cargo: each case's synthetic index is served by index-proxy.mjs (replay), cargo
# generate-lockfile runs on its Cargo.toml, and the result must equal our lockfile byte for byte
# (or both must fail). Usage: tests/resolver/check-scenarios.sh [dump-dir]
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
source "$ROOT/toolchain/versions.env"
DUMP=${1:-$ROOT/build/wp-15/scenarios}
PORT=8798
rm -rf "$DUMP"
SCENARIO_DUMP="$DUMP" cargo test --release --manifest-path "$ROOT/crates/Cargo.toml" -p resolver --test scenarios -q >/dev/null

fail=0
for case in "$DUMP"/*/; do
  case=${case%/}; name=$(basename "$case")
  home="$case/cargo-home"; mkdir -p "$home"
  printf '[source.crates-io]\nreplace-with = "synthetic"\n[source.synthetic]\nregistry = "sparse+http://localhost:%s/"\n' "$PORT" > "$home/config.toml"
  node "$ROOT/tests/resolver/index-proxy.mjs" replay "$case/index" "$PORT" > "$case/proxy.log" &
  proxy=$!
  for _ in $(seq 50); do grep -q 'index proxy' "$case/proxy.log" 2>/dev/null && break; sleep 0.1; done
  if CARGO_HOME="$home" cargo "+$RUST_TAG" generate-lockfile -q --manifest-path "$case/Cargo.toml" 2> "$case/cargo.err"; then
    if cmp -s "$case/Cargo.lock" "$case/ours.lock"; then echo "  ok    $name"; else echo "  DIFF  $name"; diff "$case/Cargo.lock" "$case/ours.lock" | head -20; fail=1; fi
  else
    if [ "$(cat "$case/ours.lock")" = error ]; then echo "  ok    $name (both fail)"; else echo "  DIFF  $name: cargo failed: $(tail -1 "$case/cargo.err")"; fail=1; fi
  fi
  kill "$proxy"; wait "$proxy" 2>/dev/null || true
done
exit $fail
