#!/usr/bin/env bash
# WP-07 done-check: the rustc host is built with panic=unwind (exnref Wasm EH). A compile error
# exits with 1 instead of trapping; in one instance (rustc-multi) an ICE and a compile error are
# followed by successful compiles, under wasmtime and in Chromium. WP-06 linking still works.
# Build first: toolchain/build-rustc.sh, then toolchain/build-rustc-multi.sh.
set -euo pipefail
cd "$(dirname "$0")/../.."
. toolchain/versions.env
# RUSTC_WASM / RUSTC_MULTI_WASM / RUSTLIB: test other artifacts, e.g. a release (scripts/verify/wp-10.sh);
# WASMTIME_ONLY=1 skips the Chromium part (its page loads from the build dirs).
W=${RUSTC_WASM:-build/rustc-wasm/build/wasm32-wasip1-threads/stage1/bin/rustc.wasm}
M=${RUSTC_MULTI_WASM:-build/rustc-wasm/rustc-multi.wasm}
for f in "$W" "$M"; do [ -f "$f" ] || { echo "FAIL: no $f"; exit 1; }; done
legacy=$(wasm-tools print "$W" | grep -cE '^\s*(try|delegate|rethrow)\b' || true)
[ "$legacy" = 0 ] || { echo "FAIL: rustc.wasm uses legacy EH ($legacy instructions)"; exit 1; }
echo "  ok   rustc.wasm uses exnref EH only (no legacy try/delegate/rethrow)"

RL=${RUSTLIB:-$(rustc +$RUST_TAG --print sysroot)/lib/rustlib}
T=build/wp-07/verify; rm -rf "$T"; mkdir -p "$T/root/sysroot/bin" "$T/root/work"
ln -s ../lib/rustc-is-a-wasm-module "$T/root/sysroot/bin/rustc"
cp tests/smoke/hello.rs "$T/root/work/"
printf 'fn main() { let x: u32 = "no"; }\n' > "$T/root/work/bad.rs"
run() { # module, wasmtime env flags..., --, rustc args...
  local m=$1; shift; local env=(); while [ "$1" != -- ]; do env+=("$1"); shift; done; shift
  wasmtime-threads run -W threads=y,shared-memory=y,exceptions=y -S threads=y "${env[@]}" --argv0 /sysroot/bin/rustc \
    --dir "$T/root::/" --dir "$RL::/sysroot/lib/rustlib" --dir "$RL::/lib/rustlib" "$m" "$@" 2>&1 | grep -v '^WARNING: the `-Sthreads`'
  return "${PIPESTATUS[0]}"
}
c=(--target wasm32-wasip1 --edition 2021 --emit=metadata)

set +e; out=$(run "$W" -- /work/bad.rs "${c[@]}" -o /work/bad.rmeta); code=$?; set -e
[ "$code" = 1 ] || { echo "FAIL: compile error exited with $code"; echo "$out" | tail -5; exit 1; }
grep -q 'error\[E0308\]' <<<"$out" || { echo "FAIL: no E0308"; exit 1; }
! grep -q 'wasm trap' <<<"$out" || { echo "FAIL: compile error trapped"; exit 1; }
echo "  ok   compile error: E0308, exit 1, no trap (wasmtime)"

s=$(date +%s%N)
set +e; out=$(run "$M" --env RUSTC_BOOTSTRAP=1 --env RUSTC_ICE=0 --env RUST_BACKTRACE=0 -- \
  /work/bad.rs "${c[@]}" -o /work/bad.rmeta -Ztreat-err-as-bug=1 --next \
  /work/bad.rs "${c[@]}" -o /work/bad.rmeta --next \
  /work/hello.rs "${c[@]}" -o /work/hello.rmeta --next \
  /work/hello.rs --target wasm32-wasip1 --edition 2021 --emit=obj -o /work/hello.o); code=$?; set -e
ms=$(( ($(date +%s%N) - s) / 1000000 ))
codes=$(grep -o 'rustc-multi: exit [0-9]*' <<<"$out" | awk '{print $3}' | tr '\n' ' ')
[ "$codes" = "101 1 0 0 " ] && [ "$code" = 0 ] || { echo "FAIL: rustc-multi exit codes '$codes', process $code"; echo "$out" | tail -20; exit 1; }
# A binary crate's .rmeta is empty.
[ -e "$T/root/work/hello.rmeta" ] && [ -s "$T/root/work/hello.o" ] || { echo "FAIL: no hello.rmeta/hello.o"; exit 1; }
echo "  ok   one instance: ICE (101), error (1), check (0), codegen (0) in ${ms} ms (wasmtime)"

scripts/verify/wp-06.sh | sed -n 's/^  ok   build-hello/  ok   WP-06 build-hello/p'

if [ "${WASMTIME_ONLY:-}" != 1 ]; then
  bash scripts/build-vfs.sh >/dev/null
  scripts/prep-rustc-host-page.sh >/dev/null
  node scripts/build-web-tests.mjs >/dev/null
  pnpm exec playwright test tests/e2e/rustc-host.spec.ts --project=chromium --reporter=line | tail -3
fi
echo "  size: rustc.wasm $(awk -v b="$(stat -c %s "$W")" 'BEGIN { printf "%.1f MiB", b/1048576 }'), brotli: see STATUS"
echo "WP-07 verified."
