#!/usr/bin/env bash
# WP-20, change 1 of docs/wp20-rustc-changes.md: with the user's patch, rustc.wasm compiles a
# proc-macro crate for wasm32-wasip1, and the module has readable crate metadata with
# proc_macro_data. Checks, on tests/proc-macro/hello_pm.rs:
#  1. rustc.wasm (under wasmtime, toolchain/rustc-wasm.ts) builds it with --crate-type
#     proc-macro --target wasm32-wasip1 -Zwasm-proc-macros and the planner's link arguments.
#  2. The module exports the decls global (__rustc_proc_macro_decls_<id>__), _initialize, the
#     table and the allocator, and has a `.rustc` custom section.
#  3. The stock native rustc reads its metadata through the dylib path (-Z ls=root):
#     proc_macro true, triple wasm32-wasip1. So does the patched rustc.wasm itself.
#  4. Prints the module's imports (WASI only is expected).
# Usage: scripts/verify/wp-20-crate-type.sh [rustc.wasm] (default: bootstrap's stage1 build)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
source toolchain/versions.env
RUSTC_WASM=${1:-$ROOT/build/rustc-wasm/build/wasm32-wasip1-threads/stage1/bin/rustc.wasm}
[ -f "$RUSTC_WASM" ] || { echo "FAIL: no $RUSTC_WASM (build it with toolchain/build-rustc.sh)"; exit 1; }
W=build/wp-20/crate-type; rm -rf "$W"; mkdir -p "$W"
cp tests/proc-macro/hello_pm.rs "$W/"
CRT=/sysroot/lib/rustlib/wasm32-wasip1/lib/self-contained/crt1-reactor.o  # guest path
# 1. Build (the paths are the guest's: the working directory is mounted as /).
# rustc 1.99.1 already gates wasm proc macros behind -Zwasm-proc-macros (rust-lang/rust#160854).
# -C save-temps: a dylib-like output links rustc's metadata object from a temp dir, and we link
# outside rustc, after it exited (toolchain/rustc-wasm.ts).
(cd "$W" && RUSTC_WASM=$RUSTC_WASM RUSTC_BOOTSTRAP=1 node "$ROOT/toolchain/rustc-wasm.ts" -Zwasm-proc-macros --edition 2021 --crate-type proc-macro --target wasm32-wasip1 \
  --crate-name hello_pm hello_pm.rs --out-dir out -C link-arg=$CRT -C link-arg=--export=_initialize -C link-arg=--export-table \
  -C link-arg=--growable-table -C link-arg=--export=malloc -C link-arg=--export=free -C link-arg=--export=realloc \
  -C save-temps) > "$W/rustc.log" 2>&1 \
  || { cat "$W/rustc.log"; echo "FAIL: rustc.wasm could not build a proc-macro crate for wasm32-wasip1"; exit 1; }
M=$(ls "$W"/out/*.wasm 2>/dev/null | head -1)
[ -n "$M" ] || { ls -la "$W/out"; echo "FAIL: no .wasm module emitted"; exit 1; }
echo "  ok   built $(basename "$M") ($(stat -c %s "$M") bytes)"
# 2. Exports and the metadata section.
wasm-tools print "$M" | grep -oE '^\s*\(export "[^"]+"' | sed 's/.*"\(.*\)"/\1/' | sort > "$W/exports.txt"
decls=$(grep -E '^__rustc_proc_macro_decls_[0-9a-f]+__$' "$W/exports.txt" || true)
[ -n "$decls" ] || { cat "$W/exports.txt"; echo "FAIL: the decls static is not exported"; exit 1; }
for e in _initialize __indirect_function_table malloc free realloc memory; do
  grep -qx "$e" "$W/exports.txt" || { cat "$W/exports.txt"; echo "FAIL: no export $e"; exit 1; }
done
wasm-tools objdump "$M" 2>/dev/null | grep -q '\.rustc' || { wasm-tools objdump "$M"; echo "FAIL: no .rustc custom section"; exit 1; }
echo "  ok   exports $decls, _initialize, table, allocator; .rustc section present"
# 3. Metadata, read by the stock native rustc and by rustc.wasm.
RUSTC_BOOTSTRAP=1 rustc "+$RUST_TAG" -Z ls=root "$M" > "$W/ls-native.txt" 2>&1 || true
grep -qx 'proc_macro true' "$W/ls-native.txt" && grep -qx 'triple wasm32-wasip1' "$W/ls-native.txt" \
  || { cat "$W/ls-native.txt"; echo "FAIL: native rustc doesn't read proc_macro_data from the module"; exit 1; }
(cd "$W" && RUSTC_WASM=$RUSTC_WASM RUSTC_BOOTSTRAP=1 node "$ROOT/toolchain/rustc-wasm.ts" -Z ls=root "out/$(basename "$M")") > "$W/ls-wasm.txt" 2>&1 || true
grep -qx 'proc_macro true' "$W/ls-wasm.txt" || { cat "$W/ls-wasm.txt"; echo "FAIL: rustc.wasm doesn't read proc_macro_data from the module"; exit 1; }
echo "  ok   -Z ls=root (native rustc and rustc.wasm): $(grep -E '^name ' "$W/ls-native.txt"), proc_macro true, triple wasm32-wasip1"
# 4. The imports, for the record.
node -e '
const m = new WebAssembly.Module(require("fs").readFileSync(process.argv[1]));
console.log(JSON.stringify(WebAssembly.Module.imports(m).map(i => i.module + "." + i.name)));
' "$M" > "$W/imports.json"
echo "  info imports: $(cat "$W/imports.json")"
echo "WP-20 crate-type check passed."
