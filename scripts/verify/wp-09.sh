#!/usr/bin/env bash
# WP-09 done-check: rustc-multi --server serves 10 sequential requests in one instance (checks, an
# error, codegen, -V) with correct results, under wasmtime (requests on stdin) and in Chromium (the
# VFS stdin file, tests/e2e/compile-server.spec.ts), and warm check-hello is at least 2.5x faster than
# cold in Chromium (3x in PLAN, re-scoped 2026-10-24; see bench/compile-server.md).
set -euo pipefail
cd "$(dirname "$0")/../.."
M=build/rustc-wasm/rustc-multi.wasm
[ -f "$M" ] || { echo "FAIL: no $M (toolchain/build-rustc-multi.sh)"; exit 1; }
RL=$(rustc +1.99.1 --print sysroot)/lib/rustlib
T=build/wp-09/verify; rm -rf "$T"; mkdir -p "$T/root/sysroot/bin" "$T/root/work"
ln -s ../lib/rustc-is-a-wasm-module "$T/root/sysroot/bin/rustc"
cp tests/smoke/hello.rs bench/programs/medium.rs "$T/root/work/"
printf 'fn main() { let x: u32 = "no"; }\n' > "$T/root/work/bad.rs"
req() { local id=$1; shift; printf '{"id":%s,"args":[' "$id"; local sep=; for a in "$@"; do printf '%s"%s"' "$sep" "$a"; sep=,; done; printf ']}\n'; }
c=(--target wasm32-wasip1 --edition 2021)
{
  for i in 1 2 3 4 5 6; do req "$i" /work/hello.rs "${c[@]}" --emit=metadata -o "/work/h$i.rmeta"; done
  req 7 /work/bad.rs "${c[@]}" --emit=metadata -o /work/bad.rmeta
  req 8 /work/medium.rs "${c[@]}" --crate-type lib --emit=metadata -o /work/libm.rmeta
  req 9 /work/hello.rs "${c[@]}" --emit=obj -o /work/h.o
  req 10 -V
  echo '{"id":11,"quit":true}'
} > "$T/requests.jsonl"
wasmtime-threads run -W threads=y,shared-memory=y,exceptions=y -S threads=y --argv0 /sysroot/bin/rustc \
  --dir "$T/root::/" --dir "$RL::/sysroot/lib/rustlib" --dir "$RL::/lib/rustlib" "$M" --server \
  < "$T/requests.jsonl" > "$T/out.txt" 2> "$T/err.txt"
node -e '
const fs = require("fs"), [out, err] = process.argv.slice(1).map(f => fs.readFileSync(f, "utf8"));
const answers = out.split("\n").filter(l => l.startsWith("{")).map(l => JSON.parse(l));
const want = { 7: 1 };
const done = answers.filter(a => "exit" in a);
if (done.length !== 10) { console.log(`FAIL: ${done.length} answers`); process.exit(1); }
for (const a of done) if (a.exit !== (want[a.id] ?? 0)) { console.log(`FAIL: request ${a.id} exited ${a.exit}`); process.exit(1); }
if (!answers.some(a => a.quit)) { console.log("FAIL: no quit answer"); process.exit(1); }
if (!/rustc 1\.99\.1/.test(out) || !/\x1e7\n/.test(err) || !/mismatched types[\s\S]*\x1e7\n/.test(err)) { console.log("FAIL: -V output or error diagnostics missing"); process.exit(1); }
const warm = done.filter(a => a.id >= 2 && a.id <= 6).map(a => a.ms);
console.log(`  ok   wasmtime: 10 requests in one instance (error exit 1, others 0); warm check-hello ${Math.min(...warm)}–${Math.max(...warm)} ms`);
' "$T/out.txt" "$T/err.txt"
[ -s "$T/root/work/h.o" ] && [ -s "$T/root/work/libm.rmeta" ] || { echo "FAIL: outputs missing"; exit 1; }

bash scripts/build-vfs.sh >/dev/null
scripts/prep-rustc-host-page.sh >/dev/null
node scripts/build-web-tests.mjs >/dev/null
pnpm exec playwright test tests/e2e/compile-server.spec.ts --project=chromium --reporter=line > build/wp-09-spec.log 2>&1 || { tail -40 build/wp-09-spec.log; echo "FAIL: compile-server.spec.ts"; exit 1; }
f=$(ls -t bench/results/*-compile-server.json | head -1)
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1]));
console.log(`  ok   Chromium: 10 requests in one instance; cold ${r.coldMedian} ms, warm ${r.warmMedian} ms (${(r.coldMedian / r.warmMedian).toFixed(1)}x), peak ${r.peakMiB} MiB (${process.argv[1]})`);
' "$f"
echo "WP-09 verified."
