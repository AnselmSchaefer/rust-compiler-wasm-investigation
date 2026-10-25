#!/usr/bin/env bash
# Build a proc-macro crate as a Wasm guest of the rust:proc-macro world (WP-19):
#   scripts/build-pm-guest.sh [--raw] <crate source dir> <out dir> [<Cargo.lock to pin versions from>]
# --raw (WP-20 experiment): the module rustc would emit for a proc-macro crate on wasm (only the
# decls static; `_initialize` from crt1-reactor.o; table, malloc/free/realloc exported by link
# arguments). Also writes <module>.macros.json (the macros in declaration order).
# pm-rewrite turns it into a cdylib using crates/pm-bridge/guest. Then native cargo builds it for
# wasm32-wasip1 with the pinned toolchain and `--extern proc_macro`, as cargo does for proc-macro
# crates. With a lockfile, the guest's dependencies get the same versions (cargo update --precise),
# so a native build and the guest compile the same code. Prints the module's path.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
source "$ROOT/toolchain/versions.env"
RAW=; [ "${1:-}" = --raw ] && { RAW=--raw; shift; }
SRC=$(realpath "$1"); OUT=$(realpath -m "$2"); LOCK=${3:+$(realpath "$3")}
(cd "$ROOT/crates/pm-bridge" && cargo build -q --release -p pm-rewrite)
MACROS=$("$ROOT/crates/pm-bridge/target/release/pm-rewrite" $RAW "$SRC" "$OUT" "$ROOT/crates/pm-bridge/guest")
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
if [ -n "$RAW" ]; then
  CRT=$(rustc "+$RUST_TAG" --print sysroot)/lib/rustlib/wasm32-wasip1/lib/self-contained/crt1-reactor.o
  RUSTC_BOOTSTRAP=$name cargo "+$RUST_TAG" rustc -q --release --target wasm32-wasip1 \
    --config profile.release.lto=true --config profile.release.codegen-units=1 -- --extern proc_macro \
    -Zcrate-attr='feature(proc_macro_internals)' -C link-arg="$CRT" -C link-arg=--export=_initialize \
    -C link-arg=--export-table -C link-arg=--growable-table -C link-arg=--export=malloc -C link-arg=--export=free -C link-arg=--export=realloc
else
  RUSTC_BOOTSTRAP=pm_guest cargo "+$RUST_TAG" rustc -q --release --target wasm32-wasip1 \
    --config profile.release.lto=true --config profile.release.codegen-units=1 -- --extern proc_macro
fi
echo "$MACROS" > "$OUT/target/wasm32-wasip1/release/$name.macros.json"
echo "$OUT/target/wasm32-wasip1/release/$name.wasm"
