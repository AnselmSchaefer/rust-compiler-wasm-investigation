#!/usr/bin/env bash
# Stage-0 toolchain for building rustc.wasm with panic=unwind (WP-07): rustup's 1.99.1, hard-linked,
# with its wasm32-wasip1-threads std swapped for one built from the same 1.99.1 library/ with
# -Cpanic=unwind and Wasm exception handling. Bootstrap links the stage-1 compiler against
# *stage 0's* std, and rustup's is panic=abort ("the crate `panic_unwind` does not have the panic
# strategy `unwind`"). Called by build-rustc.sh; prints the toolchain's path.
#
# Same technique as danlapid's build-std.sh: cargo -Zbuild-std on an empty crate, with the std
# sources taken from build/rust/library (unmodified). The std for *user* programs stays rustup's.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/toolchain/versions.env"
TAG=$RUST_TAG
HOST=wasm32-wasip1-threads
RUST="$ROOT/build/rust"
OUT="${RUSTC_WASM_OUT:-$ROOT/build/rustc-wasm}"
WORK="$OUT/host-std"
STAGE0="$OUT/stage0"
STABLE="$(rustc +$TAG --print sysroot)"

mkdir -p "$WORK/build/src"
cat > "$WORK/build/Cargo.toml" <<'EOF'
[package]
name = "host-std-build"
version = "0.0.0"
edition = "2024"
[profile.release]
debug = 0
EOF
: > "$WORK/build/src/lib.rs"
COMMIT="$(git -C "$RUST" rev-parse "$TAG^{commit}")"
(
  cd "$WORK/build"
  RUSTC_BOOTSTRAP=1 __CARGO_TESTS_ONLY_SRC_ROOT="$RUST/library" \
    CARGO_TARGET_DIR="$WORK/target" \
    CFLAGS_wasm32_wasip1_threads="-pthread" CC_wasm32_wasip1_threads="$ROOT/toolchain/bin/wasi-threads-clang" \
    RUSTFLAGS="-Cpanic=unwind -Ctarget-feature=+exception-handling --remap-path-prefix=$RUST=/rustc/$COMMIT" \
    cargo "+$TAG" build -q --release --target "$HOST" \
    -Zbuild-std=std,panic_abort,panic_unwind,proc_macro >&2
)

# The toolchain: hard links to rustup's files (never written to), except the host target's libs.
if [ ! -x "$STAGE0/bin/rustc" ]; then
  rm -rf "$STAGE0.tmp"
  cp -al "$STABLE" "$STAGE0.tmp"
  mv "$STAGE0.tmp" "$STAGE0"
fi
LIB="$STAGE0/lib/rustlib/$HOST/lib"
rm -rf "$LIB.new"; mkdir -p "$LIB.new"
for f in "$WORK/target/$HOST/release/deps"/*.rlib "$WORK/target/$HOST/release/deps"/*.rmeta; do
  case "$(basename "$f")" in libhost_std_build-*) continue ;; esac
  cp "$f" "$LIB.new/"
done
# The self-contained crt objects and libc are not part of std; keep rustup's.
cp -al "$STABLE/lib/rustlib/$HOST/lib/self-contained" "$LIB.new/"
rm -rf "$LIB"; mv "$LIB.new" "$LIB"
echo "$STAGE0"
