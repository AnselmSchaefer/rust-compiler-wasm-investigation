#!/usr/bin/env bash
# WP-08 done-check: rustup's 1.99.1 wasm32-wasip1 std is packaged as brotli assets with a manifest
# (toolchain/package-sysroot.mjs); every file and brotli copy matches its sha256; in Chromium, type
# checking and codegen work with only the metadata group loaded, and compiling hello peaks below
# 300 MiB of Wasm memory. Numbers: bench/results/*-sysroot-memory.json, bench/sysroot.md.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f build/rustc-wasm/rustc-multi.wasm ] || { echo "FAIL: build WP-07 first (toolchain/build-rustc-multi.sh)"; exit 1; }
bash scripts/build-vfs.sh >/dev/null
scripts/prep-rustc-host-page.sh | sed 's/^/  /'
S=build/www/rustc-host/sysroot
node -e '
const fs = require("fs"), zlib = require("zlib"), crypto = require("crypto");
const S = process.argv[1], m = JSON.parse(fs.readFileSync(S + "/manifest.json"));
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
for (const f of m.files) {
  const raw = fs.readFileSync(`${S}/${f.path}`), br = zlib.brotliDecompressSync(fs.readFileSync(`${S}/${f.path}.br`));
  if (raw.length !== f.size || sha(raw) !== f.sha256 || sha(br) !== f.sha256) { console.log("FAIL: " + f.path); process.exit(1); }
}
if (!m.files.some(f => /libstd-.*\.rmeta$/.test(f.path)) || !m.files.some(f => f.path.endsWith("self-contained/crt1-command.o"))) { console.log("FAIL: std or crt1 missing"); process.exit(1); }
console.log(`  ok   manifest: ${m.files.length} files, sha256 of every file and brotli copy matches`);
' "$S"
node scripts/build-web-tests.mjs >/dev/null
pnpm exec playwright test tests/e2e/sysroot-memory.spec.ts --project=chromium --reporter=line > build/wp-08-spec.log 2>&1 || { tail -40 build/wp-08-spec.log; echo "FAIL: sysroot-memory.spec.ts"; exit 1; }
f=$(ls -t bench/results/*-sysroot-memory.json | head -1)
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1]));
const s = r.steps;
console.log(`  ok   meta-only sysroot: check + codegen work (${r.load.sysroot.meta.files} .rmeta, ${(r.load.sysroot.meta.brSize / 2 ** 20).toFixed(1)} MiB brotli)`);
for (const k of Object.keys(s)) console.log(`  ok   ${k.padEnd(13)} peak ${String(s[k].peakMiB).padStart(3)} MiB, warm ${Math.min(...s[k].ms)} ms`);
console.log(`  vfs: ${r.vfsMiB.afterMeta} MiB with meta, ${r.vfsMiB.afterLink} MiB with link group (${process.argv[1]})`);
' "$f"
echo "WP-08 verified."
