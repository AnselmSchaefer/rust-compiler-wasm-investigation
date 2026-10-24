#!/usr/bin/env bash
# WP-05 done-check: rustc 1.99.1 built for wasm32-wasip1-threads runs under wasmtime: --version
# reports exactly stable 1.99.1, and --emit=metadata produces .rmeta files (using rustup's std).
# Build first with toolchain/build-rustc.sh (needs the rustc changes in toolchain/patches/rust/).
set -euo pipefail
cd "$(dirname "$0")/../.."
. toolchain/versions.env
W=build/rustc-wasm/build/wasm32-wasip1-threads/stage1/bin/rustc.wasm
[ -f "$W" ] || { echo "FAIL: no $W (run toolchain/build-rustc.sh)"; exit 1; }
RL=$(rustc +$RUST_TAG --print sysroot)/lib/rustlib
T=build/wp-05/verify; rm -rf "$T"; mkdir -p "$T/root/sysroot/bin" "$T/root/work"
# rustc trusts argv[0] for its sysroot only if it is a symlink, and then checks for lib/rustlib
# relative to the *working directory* (/), hence the second rustlib mount (see docs/decisions.md).
ln -s ../lib/rustc-is-a-wasm-module "$T/root/sysroot/bin/rustc"
cp tests/smoke/hello.rs bench/programs/medium.rs "$T/root/work/"
run() {
  wasmtime-threads run -W threads=y,shared-memory=y,exceptions=y -S threads=y --argv0 /sysroot/bin/rustc \
    --dir "$T/root::/" --dir "$RL::/sysroot/lib/rustlib" --dir "$RL::/lib/rustlib" "$W" "$@" 2>&1 \
    | grep -v '^WARNING: the `-Sthreads`' || true
}
v=$(run -V | tr -d '\r' | grep '^rustc')
[ "$v" = "$(rustc +$RUST_TAG -V)" ] || { echo "FAIL: version '$v' != '$(rustc +$RUST_TAG -V)'"; exit 1; }
echo "  ok   $v (identical to stable)"
run /work/hello.rs --target wasm32-wasip1 --edition 2021 --emit=metadata -o /work/hello.rmeta >/dev/null
[ -f "$T/root/work/hello.rmeta" ] || { echo "FAIL: no hello.rmeta"; exit 1; }
echo "  ok   --emit=metadata hello.rs → .rmeta"
run /work/medium.rs --target wasm32-wasip1 --edition 2021 --crate-type lib --emit=metadata -o /work/libmedium.rmeta >/dev/null
[ -s "$T/root/work/libmedium.rmeta" ] || { echo "FAIL: libmedium.rmeta missing or empty"; exit 1; }
echo "  ok   library metadata: $(stat -c %s "$T/root/work/libmedium.rmeta") bytes"
echo "  size: rustc.wasm $(awk -v b="$(stat -c %s "$W")" 'BEGIN { printf "%.1f MiB", b/1048576 }')"
echo "WP-05 verified."
