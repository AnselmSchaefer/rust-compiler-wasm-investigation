#!/usr/bin/env bash
# WP-10 done-check: a release from toolchain/release.sh (default: the newest in build/release/) is
# complete and every hash in its manifest matches, raw and brotli; unpacked, its compiler, linker
# and sysroot pass the WP-06 and WP-07 tests under wasmtime. If a second, independent build was
# packaged (build/release-repro/, see docs/rebase.md), its files must be bit-identical.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
R=${1:-$(ls -td build/release/*/ 2>/dev/null | head -1)}
R=${R%/}
[ -f "$R/manifest.json" ] || { echo "FAIL: no release (run toolchain/release.sh)"; exit 1; }
U=build/wp-10/unpacked; rm -rf "$U"; mkdir -p "$U/sysroot"

node - "$R" "$U" <<'EOF'
const fs = require('fs'), zlib = require('zlib'), crypto = require('crypto');
const [R, U] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(`${R}/manifest.json`));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const fail = s => { console.log(`FAIL: ${s}`); process.exit(1); };
if (!/^1\.99\.1-[0-9a-f]{12}$/.test(m.RUSTC_ID) || !R.endsWith(m.RUSTC_ID)) fail(`RUSTC_ID ${m.RUSTC_ID}`);
const entries = { 'rustc.wasm': m.rustc, 'lld.wasm': m.lld, 'meta.tar': m.sysroot.meta, 'link.tar': m.sysroot.link };
for (const [name, e] of Object.entries(entries)) {
  const br = fs.readFileSync(`${R}/${e.file}`);
  if (br.length !== e.brSize || sha(br) !== e.brSha256) fail(`${e.file}: brotli size/sha256`);
  const raw = zlib.brotliDecompressSync(br);
  if (raw.length !== e.size || sha(raw) !== e.sha256) fail(`${e.file}: raw size/sha256`);
  fs.writeFileSync(`${U}/${name}`, raw);
}
if (!m.RUSTC_ID.endsWith(m.rustc.sha256.slice(0, 12))) fail('RUSTC_ID does not name the compiler');
const files = Object.values(m.sysroot).reduce((a, g) => a + g.files, 0);
const mib = b => (b / 2 ** 20).toFixed(1);
const total = Object.values(entries).reduce((a, e) => a + e.brSize, 0);
console.log(`  ok   ${m.RUSTC_ID}: 4 files, every sha256 matches (raw and brotli); ${files} sysroot files; ${mib(total)} MiB to download`);
EOF
for g in meta link; do tar -C "$U/sysroot" -xf "$U/$g.tar"; done
n=$(find "$U/sysroot" -type f | wc -l)
[ "$n" = "$(node -e 'const m=require(process.argv[1]); console.log(m.sysroot.meta.files+m.sysroot.link.files)' "$ROOT/$R/manifest.json")" ] || { echo "FAIL: $n files unpacked"; exit 1; }

export RUSTC_WASM=$ROOT/$U/rustc.wasm RUSTC_MULTI_WASM=$ROOT/$U/rustc.wasm WASM_LD_WASM=$ROOT/$U/lld.wasm RUSTLIB=$ROOT/$U/sysroot/lib/rustlib
echo "  WP-06 with the release:"
scripts/verify/wp-06.sh | sed 's/^/  /'
echo "  WP-07 with the release (wasmtime):"
WASMTIME_ONLY=1 scripts/verify/wp-07.sh | sed 's/^/  /'

if [ -f "build/release-repro/$(basename "$R")/manifest.json" ]; then
  for f in rustc.wasm.br lld.wasm.br sysroot-wasm32-wasip1-meta.tar.br sysroot-wasm32-wasip1-link.tar.br; do
    cmp -s "$R/$f" "build/release-repro/$(basename "$R")/$f" || { echo "FAIL: $f differs from the independent build"; exit 1; }
  done
  echo "  ok   independent second build (build/release-repro/): all 4 files bit-identical"
fi
echo "WP-10 verified."
