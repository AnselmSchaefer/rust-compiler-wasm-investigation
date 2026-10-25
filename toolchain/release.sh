#!/usr/bin/env bash
# Package the toolchain for the browser (WP-10):
#
#   toolchain/release.sh [out-dir]       default build/release
#
# Output, in <out-dir>/<RUSTC_ID>/:
#   rustc.wasm.br                        rustc-multi.wasm: a drop-in rustc, plus --next and --server
#   rustc-wasmtime.wasm.br               the same source without the browser's proc-macro host
#                                        imports, for the wasmtime CLI (tools/prebuild; WP-20)
#   lld.wasm.br                          wasm-ld.wasm (lld, run as wasm-ld)
#   sysroot-wasm32-wasip1-meta.tar.br    rustup 1.99.1's std: the .rmeta files (check + codegen)
#   sysroot-wasm32-wasip1-link.tar.br    the .rlib files, crt1 and libc (only the linker reads them)
#   manifest.json                        RUSTC_ID, sources, and per file: size + sha256, raw and brotli
#
# RUSTC_ID = <rustc version>-<first 12 hex of the compiler's sha256>, so caches key on the exact
# compiler. Tars are deterministic (sorted, mtime 0, uid/gid 0), and so is brotli, so the same
# inputs give the same bytes (see docs/rebase.md for what the compiler build itself does).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-$ROOT/build/release}"
B="${RUSTC_WASM_OUT:-$ROOT/build/rustc-wasm}"
RUSTC="$B/rustc-multi.wasm"
RUSTC_WT="$B/rustc-multi-wasmtime.wasm"
LLD="$ROOT/build/llvm-wasm-install/bin/wasm-ld.wasm"
. "$ROOT/toolchain/versions.env"
VERSION=$RUST_TAG
TARGET=wasm32-wasip1
for f in "$RUSTC" "$RUSTC_WT" "$LLD"; do [ -f "$f" ] || { echo "missing $f (build-rustc.sh, build-rustc-multi.sh, build-llvm.sh)" >&2; exit 1; }; done

ID="$VERSION-$(sha256sum "$RUSTC" | cut -c1-12)"
D="$OUT_DIR/$ID"
rm -rf "$D.tmp"; mkdir -p "$D.tmp"
br() { brotli -q 11 -c "$1" > "$2"; }

br "$RUSTC" "$D.tmp/rustc.wasm.br" &
br "$RUSTC_WT" "$D.tmp/rustc-wasmtime.wasm.br" &
br "$LLD" "$D.tmp/lld.wasm.br" &

# The sysroot: one deterministic tar per group (see toolchain/package-sysroot.mjs for the groups).
SR="$(rustc +$VERSION --print sysroot)"
LIB="lib/rustlib/$TARGET/lib"
tarball() { # group, find-filter...
  local g=$1; shift
  (cd "$SR" && find "$LIB" -type f "$@" | LC_ALL=C sort) > "$D.tmp/$g.list"
  tar -C "$SR" --format=ustar --mtime=@0 --owner=0 --group=0 --numeric-owner --mode=a+rX,u+w,go-w \
    -cf "$D.tmp/sysroot-$TARGET-$g.tar" -T "$D.tmp/$g.list"
  br "$D.tmp/sysroot-$TARGET-$g.tar" "$D.tmp/sysroot-$TARGET-$g.tar.br"
}
tarball meta -name '*.rmeta' &
tarball link ! -name '*.rmeta' &
wait

# Raw files the manifest describes (deleted afterwards; only .br files are shipped).
ln -f "$RUSTC" "$D.tmp/rustc.wasm"
ln -f "$RUSTC_WT" "$D.tmp/rustc-wasmtime.wasm"
ln -f "$LLD" "$D.tmp/lld.wasm"
node - "$D.tmp" "$ID" "$VERSION" "$TARGET" \
  "$(git -C "$ROOT/build/rust" rev-parse HEAD)" \
  "$(git -C "$ROOT/build/rust" diff | sha256sum | cut -d' ' -f1)" \
  "$(git -C "$ROOT/build/llvm-project" rev-parse HEAD)" \
  "$(head -1 "${WASI_SDK_PATH:-$HOME/opt/wasi-sdk}/VERSION")" \
  "$(git -C "$ROOT" rev-parse --short HEAD)" <<'EOF'
const fs = require('fs'), crypto = require('crypto');
const [dir, id, version, target, rustCommit, rustDiff, llvmCommit, wasiSdk, repo] = process.argv.slice(2);
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(`${dir}/${f}`)).digest('hex');
const size = f => fs.statSync(`${dir}/${f}`).size;
const entry = (raw, extra = {}) => ({ file: `${raw}.br`, size: size(raw), sha256: sha(raw), brSize: size(`${raw}.br`), brSha256: sha(`${raw}.br`), ...extra });
const sysroot = g => entry(`sysroot-${target}-${g}.tar`, { files: fs.readFileSync(`${dir}/${g}.list`, 'utf8').trim().split('\n').length });
const manifest = {
  RUSTC_ID: id, version, host: 'wasm32-wasip1-threads', target, created: new Date().toISOString().slice(0, 10),
  sources: { rust: rustCommit, rustWorkingTreeDiffSha256: rustDiff, llvm: llvmCommit, wasiSdk, repo },
  rustc: entry('rustc.wasm', { panic: 'unwind', eh: 'exnref' }),
  lld: entry('lld.wasm'),
  rustcWasmtime: entry('rustc-wasmtime.wasm'),
  sysroot: { meta: sysroot('meta'), link: sysroot('link') },
};
fs.writeFileSync(`${dir}/manifest.json`, JSON.stringify(manifest, null, 1) + '\n');
EOF
rm "$D.tmp"/*.list "$D.tmp"/*.tar "$D.tmp/rustc.wasm" "$D.tmp/rustc-wasmtime.wasm" "$D.tmp/lld.wasm"
rm -rf "$D"; mv "$D.tmp" "$D"
echo "$D"
ls -la "$D" | tail -n +2
