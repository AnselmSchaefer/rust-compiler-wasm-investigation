#!/usr/bin/env bash
# Record a planner golden case (WP-17): native `cargo build -vv --target wasm32-wasip1` of
# tests/planner/cases/<case>/ against the pinned index snapshot (WP-15), then keep what the
# planner's golden test needs, with machine paths replaced by $ROOT (the case), $REG (unpacked
# crates) and $TARGET (target dir):
#   cargo-vv.jsonl                every `Running` entry as {"env", "program", "args"}, one per line
#   crates/<name>-<ver>/Cargo.toml, files.txt   each registry package's manifest and file list
#   build-output/<name>-<ver>.txt                what its build script printed (target builds;
#                                                .host.txt: host-side builds)
# Usage: tests/planner/record.sh <case>
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
source "$ROOT/toolchain/versions.env"
CASE=$1; SRC="$ROOT/tests/planner/cases/$CASE"; W="$ROOT/build/wp-17/record/$CASE"; PORT=8797
[ -d "$ROOT/build/wp-15/index" ] || { mkdir -p "$ROOT/build/wp-15"; zstd -dc "$ROOT/tests/resolver/index-snapshot.tar.zst" | tar -x -C "$ROOT/build/wp-15"; }
rm -rf "$W"; mkdir -p "$W/home"; cp -r "$SRC" "$W/root"; rm -rf "$W/root/crates" "$W/root/build-output" "$W/root/cargo-vv.jsonl"
printf '[source.crates-io]\nreplace-with = "snap"\n[source.snap]\nregistry = "sparse+http://localhost:%s/"\n' "$PORT" > "$W/home/config.toml"
node "$ROOT/tests/resolver/index-proxy.mjs" replay "$ROOT/build/wp-15/index" "$PORT" > "$W/proxy.log" & proxy=$!
trap 'kill $proxy 2>/dev/null' EXIT
for _ in $(seq 50); do grep -q 'index proxy' "$W/proxy.log" 2>/dev/null && break; sleep 0.1; done
(cd "$W/root" && CARGO_HOME="$W/home" cargo "+$RUST_TAG" build -vv --target wasm32-wasip1) > "$W/build.log" 2>&1 || { tail -20 "$W/build.log"; exit 1; }
REG=$(ls -d "$W"/home/registry/src/*/)
REG=${REG%/}
TC=$(dirname "$(rustup +"$RUST_TAG" which rustc)")
norm() { sed -e "s#$REG#\$REG#g" -e "s#$W/root/target#\$TARGET#g" -e "s#$W/root#\$ROOT#g" -e "s#$TC/##g"; }
rm -rf "$SRC/crates" "$SRC/build-output"; mkdir -p "$SRC/crates" "$SRC/build-output"
# An entry can span lines (a description with newlines, inside shell quotes).
python3 -I - "$W/build.log" > "$W/vv.jsonl" <<'PY'
import json, re, shlex, sys
for m in re.finditer(r'^ *Running `(.*?)`$', open(sys.argv[1]).read(), re.M | re.S):
    w = shlex.split(m.group(1))
    n = next(i for i, x in enumerate(w) if not re.match(r'^[A-Z_][A-Z0-9_]*=', x))
    print(json.dumps({'env': dict(x.split('=', 1) for x in w[:n]), 'program': w[n], 'args': w[n + 1:]}))
PY
norm < "$W/vv.jsonl" > "$SRC/cargo-vv.jsonl"
for d in "$REG"/*/; do
  n=$(basename "$d"); mkdir -p "$SRC/crates/$n"
  cp "$d/Cargo.toml" "$SRC/crates/$n/"
  (cd "$d" && find . -type f ! -name .cargo-ok | sed 's#^\./##' | LC_ALL=C sort) > "$SRC/crates/$n/files.txt"
done
# <name>-<version> of a package: a registry crate, else a path package of the case (CARGO_PKG_VERSION).
pkgver() {
  local v
  v=$(grep -o "\$REG/$1-[0-9][^/\" ]*" "$SRC/cargo-vv.jsonl" | head -1 | sed "s#\$REG/##" || true)
  [ -n "$v" ] || v="$1-$(grep "\"CARGO_PKG_NAME\": \"$1\"" "$SRC/cargo-vv.jsonl" | head -1 | grep -o '"CARGO_PKG_VERSION": "[^"]*"' | cut -d'"' -f4)"
  echo "$v"
}
# Build-script output of each target-kind run: target/wasm32-wasip1/debug/build/<pkg>-<hash>/output
for o in "$W"/root/target/wasm32-wasip1/debug/build/*/output; do
  [ -f "$o" ] || continue
  pkg=$(basename "$(dirname "$o")"); pkg=${pkg%-*}
  ver=$(pkgver "$pkg")
  norm < "$o" > "$SRC/build-output/$ver.txt"
done
# Host-side runs (build scripts of build dependencies and proc macros): target/debug/build/.
for o in "$W"/root/target/debug/build/*/output; do
  [ -f "$o" ] || continue
  pkg=$(basename "$(dirname "$o")"); pkg=${pkg%-*}
  ver=$(pkgver "$pkg")
  norm < "$o" > "$SRC/build-output/$ver.host.txt"
done
echo "recorded $CASE: $(wc -l < "$SRC/cargo-vv.jsonl") invocations, $(ls "$SRC/crates" | wc -l) crates, $(ls "$SRC/build-output" | wc -l) build-script outputs"
