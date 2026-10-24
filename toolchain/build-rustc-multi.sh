#!/usr/bin/env bash
# Build toolchain/rustc-multi (WP-07) for the wasm32-wasip1-threads host, against the compiler
# crates of the last toolchain/build-rustc.sh run: the way bootstrap links rustc-main, with the
# same stage-0 rustc, flags and libraries, but our own main. Output: build/rustc-wasm/rustc-multi.wasm
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${RUSTC_WASM_OUT:-$ROOT/build/rustc-wasm}" # another dir: a second, independent build (WP-10 reproducibility)
REL="$OUT/build/x86_64-unknown-linux-gnu/stage1-rustc/wasm32-wasip1-threads/release"
STAMP="$REL/.librustc-stamp"
[ -f "$STAMP" ] || { echo "no $STAMP: run toolchain/build-rustc.sh" >&2; exit 1; }

# Every crate rustc-main can see: the directories of the libraries in bootstrap's stamp (t: target
# libraries, h: proc macros for the build machine). rustc_driver is rlib-only and not in the stamp.
DRIVER=$(ls -t "$REL"/build/rustc_driver/*/out/librustc_driver-*.rlib | head -1)
deps=(-L "dependency=$(dirname "$DRIVER")")
while read -r d; do deps+=(-L "dependency=$d"); done < <(tr '\0' '\n' < "$STAMP" | sed -n 's/^[th]//p' | xargs -n1 dirname | sort -u)
lib() { tr '\0' '\n' < "$STAMP" | sed -n "s/^t\(.*\/lib$1-[0-9a-f]*\)\.rmeta$/\1.rlib/p" | head -1; }
# Native libraries (LLVM, rustc_llvm's C++ wrapper, ...): the search paths from the build scripts
# of this build, i.e. each crate's most recent build-script run.
native=()
for c in "$REL"/build/*/; do
  f=$(ls -t "$c"*/run/stdout 2>/dev/null | head -1) || true
  [ -n "$f" ] || continue
  while read -r p; do native+=(-L "$p"); done < <(sed -n 's/^cargo:rustc-link-search=//p' "$f")
done
# The host rustflags, exactly as build-rustc.sh gave them to bootstrap.
mapfile -t flags < <(sed -n '/^rustflags = \[/,/\]$/p' "$OUT/bootstrap.toml" | grep -o '"[^"]*"' | tr -d '"')

RUSTC_BOOTSTRAP=1 "$OUT/stage0/bin/rustc" --edition=2024 --crate-type bin --crate-name rustc_multi \
  --target wasm32-wasip1-threads -C opt-level=3 -C linker="$ROOT/toolchain/bin/wasi-threads-clang" \
  "${flags[@]}" "${deps[@]}" "${native[@]}" \
  --extern rustc_driver="$DRIVER" --extern rustc_session="$(lib rustc_session)" --extern serde_json="$(lib serde_json)" \
  "$ROOT/toolchain/rustc-multi/main.rs" -o "$OUT/rustc-multi.wasm"
ls -la "$OUT/rustc-multi.wasm"
