#!/usr/bin/env bash
# WP-06 done-check: rustc.wasm builds wasm32-wasip1 binaries under wasmtime, linked outside rustc
# by wasm-ld.wasm (toolchain/rustc-wasm.ts). The programs run, a rebuild over existing outputs
# works (stat shim), errors are reported, and no objects or temp dirs are left behind.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
# RUSTC_WASM / WASM_LD_WASM / RUSTLIB: test other artifacts, e.g. a release (scripts/verify/wp-10.sh).
W=${RUSTC_WASM:-build/rustc-wasm/build/wasm32-wasip1-threads/stage1/bin/rustc.wasm}
[ -f "$W" ] || { echo "FAIL: no $W (run toolchain/build-rustc.sh)"; exit 1; }
T=build/wp-06/verify; rm -rf "$T"; mkdir -p "$T/work" "$T/tmp"
cp tests/smoke/hello.rs bench/programs/medium.rs "$T/work/"
printf 'fn main() { let x: u32 = "no"; }\n' > "$T/work/bad.rs"
rw() { (cd "$T/work" && TMPDIR="$ROOT/$T/tmp" node "$ROOT/toolchain/rustc-wasm.ts" "$@"); }
ms() { local s=$(date +%s%N); "$@"; echo $(( ($(date +%s%N) - s) / 1000000 )); }
leftovers() {
  local extra; extra=$(ls -A "$T/work" | grep -vxE 'hello\.rs|medium\.rs|bad\.rs|hello\.wasm|medium\.wasm' || true)
  [ -z "$extra" ] || { echo "FAIL: left behind in the work dir: $extra"; exit 1; }
  [ -z "$(ls -A "$T/tmp")" ] || { echo "FAIL: left behind in TMPDIR: $(ls -A "$T/tmp")"; exit 1; }
}

t=$(ms rw hello.rs --target wasm32-wasip1 --edition 2021 -o hello.wasm | tail -1)
[ -s "$T/work/hello.wasm" ] || { echo "FAIL: no hello.wasm"; exit 1; }
out=$(wasmtime run "$T/work/hello.wasm")
[[ "$out" == Hello* ]] || { echo "FAIL: hello.wasm printed: $out"; exit 1; }
echo "  ok   build-hello (${t} ms incl. 2 wasmtime starts) → \"$out\""
leftovers; echo "  ok   no objects or temp dirs left behind"

rm "$T/work/hello.wasm"; touch "$T/work/hello.wasm"   # existing output: rustc checks it is writeable
rw hello.rs --target wasm32-wasip1 --edition 2021 -o hello.wasm >/dev/null
[[ "$(wasmtime run "$T/work/hello.wasm")" == Hello* ]] || { echo "FAIL: rebuild over an existing output"; exit 1; }
echo "  ok   rebuild over an existing output"

t=$(ms rw medium.rs --target wasm32-wasip1 --edition 2021 -o medium.wasm | tail -1)
wasmtime run "$T/work/medium.wasm" >/dev/null || { echo "FAIL: medium.wasm exited with $?"; exit 1; }
echo "  ok   build-medium (${t} ms), runs; $(stat -c %s "$T/work/medium.wasm") bytes"

if err=$(rw bad.rs --target wasm32-wasip1 --edition 2021 -o bad.wasm 2>&1); then echo "FAIL: bad.rs compiled"; exit 1; fi
grep -q 'error\[E0308\]' <<<"$err" || { echo "FAIL: no E0308 for bad.rs:"; echo "$err"; exit 1; }
[ ! -e "$T/work/bad.wasm" ] || { echo "FAIL: bad.wasm exists"; exit 1; }
leftovers; echo "  ok   compile error reported (E0308), nothing written"
echo "WP-06 verified."
