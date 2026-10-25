#!/usr/bin/env bash
# Build a proc-macro crate as a Wasm guest of the rust:proc-macro world (WP-19):
#   scripts/build-pm-guest.sh <crate source dir> <out dir> [<Cargo.lock to pin versions from>]
# pm-rewrite turns it into a cdylib using crates/pm-bridge/guest. Then native cargo builds it for
# wasm32-wasip1 with the pinned toolchain and `--extern proc_macro`, as cargo does for proc-macro
# crates. With a lockfile, the guest's dependencies get the same versions (cargo update --precise),
# so a native build and the guest compile the same code. Prints the module's path.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
source "$ROOT/toolchain/versions.env"
SRC=$(realpath "$1"); OUT=$(realpath -m "$2"); LOCK=${3:+$(realpath "$3")}
(cd "$ROOT/crates/pm-bridge" && cargo build -q --release -p pm-rewrite)
"$ROOT/crates/pm-bridge/target/release/pm-rewrite" "$SRC" "$OUT" "$ROOT/crates/pm-bridge/guest" >/dev/null
cd "$OUT"
cargo "+$RUST_TAG" generate-lockfile -q
if [ -n "$LOCK" ]; then
  # Every package both lockfiles have, at the reference version.
  python3 -I - "$LOCK" Cargo.lock <<'PY' | while read -r spec ver; do cargo "+$RUST_TAG" update -q -p "$spec" --precise "$ver"; done
import re, sys
def pkgs(f):
    return re.findall(r'\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"\nsource = "registry', open(f).read())
ref = dict(pkgs(sys.argv[1]))
for name, ver in pkgs(sys.argv[2]):
    if name in ref and ref[name] != ver:
        print(f"{name}@{ver} {ref[name]}")
PY
fi
name=$(sed -n 's/^name = "\(.*\)"$/\1/p' Cargo.toml | head -1 | tr - _)
# Like a release that ships: fat LTO, one codegen unit.
RUSTC_BOOTSTRAP=pm_guest cargo "+$RUST_TAG" rustc -q --release --target wasm32-wasip1 \
  --config profile.release.lto=true --config profile.release.codegen-units=1 -- --extern proc_macro
echo "$OUT/target/wasm32-wasip1/release/$name.wasm"
