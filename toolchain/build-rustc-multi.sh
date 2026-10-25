#!/usr/bin/env bash
# Build toolchain/rustc-multi (WP-07) for the wasm32-wasip1-threads host, against the compiler
# crates of the last toolchain/build-rustc.sh run: the way bootstrap links rustc-main, with the
# same stage-0 rustc, flags and libraries, but our own main. Output: build/rustc-wasm/rustc-multi.wasm
# (and rustc-multi-wasmtime.wasm, for the wasmtime CLI; see main.rs)
# WP-20: the function table is exported (the proc-macro host calls back through it; pm.rs).
# WP-26: Clippy and rustfmt are linked in (tools.rs).
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
# Clippy's and rustfmt's crates and their dependencies (WP-26; toolchain/build-rustc-tools.sh).
TOOLS="$OUT/build/x86_64-unknown-linux-gnu/stage1-tools/wasm32-wasip1-threads/release/build"
tool() { ls -t "$TOOLS"/$1/*/out/lib$2-*.rlib 2>/dev/null | head -1; }
tools=()
for c in clippy_lints:clippy_lints clippy_config:clippy_config clippy_utils:clippy_utils declare_clippy_lint:declare_clippy_lint rustfmt-nightly:rustfmt_nightly; do
  f=$(tool "${c%%:*}" "${c##*:}"); [ -n "$f" ] || { echo "no ${c##*:} rlib: run toolchain/build-rustc-tools.sh" >&2; exit 1; }
  tools+=(--extern "${c##*:}=$f")
done
# Their proc macros were built for the build machine (stage1-tools/release, no target triple).
for d in "$TOOLS"/*/*/out "$OUT"/build/x86_64-unknown-linux-gnu/stage1-tools/release/build/*/*/out; do tools+=(-L "dependency=$d"); done
# The host rustflags, exactly as build-rustc.sh gave them to bootstrap.
mapfile -t flags < <(sed -n '/^rustflags = \[/,/\]$/p' "$OUT/bootstrap.toml" | grep -o '"[^"]*"' | tr -d '"')

# Two builds of the same source: the browser's (rustc-multi.wasm) and wasmtime's
# (rustc-multi-wasmtime.wasm: --cfg rust_pm_stub, no proc-macro host imports; see main.rs).
build() {
  RUSTC_BOOTSTRAP=1 "$OUT/stage0/bin/rustc" --edition=2024 --crate-type bin --crate-name rustc_multi \
    --target wasm32-wasip1-threads -C opt-level=3 -C linker="$ROOT/toolchain/bin/wasi-threads-clang" \
    "${flags[@]}" "${deps[@]}" "${native[@]}" \
    --extern rustc_driver="$DRIVER" --extern rustc_session="$(lib rustc_session)" --extern serde_json="$(lib serde_json)" \
    --extern rustc_interface="$(lib rustc_interface)" --extern rustc_metadata="$(lib rustc_metadata)" \
    --extern rustc_proc_macro="$(lib rustc_proc_macro)" --extern rustc_span="$(lib rustc_span)" "${tools[@]}" \
    -C link-arg=-Wl,--export-table --check-cfg 'cfg(rust_pm_stub)' "$@"
}
build "$ROOT/toolchain/rustc-multi/main.rs" -o "$OUT/rustc-multi.wasm"
build --cfg rust_pm_stub "$ROOT/toolchain/rustc-multi/main.rs" -o "$OUT/rustc-multi-wasmtime.wasm"
ls -la "$OUT/rustc-multi.wasm" "$OUT/rustc-multi-wasmtime.wasm"
