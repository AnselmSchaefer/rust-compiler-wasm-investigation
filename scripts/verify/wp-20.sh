#!/usr/bin/env bash
# WP-20 done-check: proc macros inside rustc.wasm.
#  1. The rust tree has the proc-macro changes (bjorn3's rust-lang/rust#160981 with the
#     wasm32-wasip1 tuple, the user's loader hook) and rustc.wasm builds a proc-macro crate for
#     wasm32-wasip1 with readable proc_macro_data (scripts/verify/wp-20-crate-type.sh).
#  2. The planner plans proc macros as cargo does: golden case tests/planner/cases/derive (serde
#     derive, thiserror, a host-side build script) identical to `cargo build -vv`, lockfile too.
#  3. Chromium (tests/e2e/proc-macro.spec.ts): `cargo build` of that case with the release's
#     rustc.wasm (rustc-multi with the loader of toolchain/rustc-multi/pm.rs) and the host in
#     web/wasi/proc-macro.ts; the program prints what the native build prints.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ ! -d build/wp-15/index ]; then
  mkdir -p build/wp-15
  zstd -dc tests/resolver/index-snapshot.tar.zst | tar -x -C build/wp-15
fi
grep -q 'register_wasm_proc_macro_loader' build/rust/compiler/rustc_metadata/src/lib.rs || { echo "FAIL: the loader hook (change 2) is not in build/rust"; exit 1; }
grep -q '"wasm32-wasip1"' build/rust/compiler/rustc_session/src/session.rs || { echo "FAIL: rust-lang/rust#160981 with the wasm32-wasip1 tuple is not in build/rust"; exit 1; }
bash scripts/verify/wp-20-crate-type.sh | sed 's/^/  /'
(cd crates && cargo test -q --release -p resolver --test plan_golden -- --nocapture 2>&1 | grep -E '^(test result|derive: [0-9]+ units)') || { echo "FAIL: planner golden test"; exit 1; }
rel=$(ls -t build/release | head -1)
node -e '
const m = new WebAssembly.Module(require("zlib").brotliDecompressSync(require("fs").readFileSync(process.argv[1])));
const pm = WebAssembly.Module.imports(m).filter(i => i.module === "rust_pm").map(i => i.name).sort().join(",");
const table = WebAssembly.Module.exports(m).some(e => e.name === "__indirect_function_table");
if (pm !== "expand,load" || !table) { console.log(`FAIL: release ${process.argv[1]} is not a rustc-multi with the proc-macro loader`); process.exit(1); }
' "build/release/$rel/rustc.wasm.br"
echo "  ok   release $rel: rustc-multi imports rust_pm.load/expand, exports its table"
bash scripts/build-vfs.sh >/dev/null
bash scripts/build-resolver.sh >/dev/null
node scripts/build-web-tests.mjs >/dev/null
mkdir -p build/wp-20
pnpm exec playwright test tests/e2e/proc-macro.spec.ts --project=chromium --reporter=line > build/wp-20/spec.log 2>&1 || { tail -40 build/wp-20/spec.log; echo "FAIL: proc-macro.spec.ts"; exit 1; }
grep -oE '\[proc-macro(-edit)?\] .*' build/wp-20/spec.log | sed 's/^/  ok   /'
echo "WP-20 verified."
