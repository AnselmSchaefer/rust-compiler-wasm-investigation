#!/usr/bin/env bash
# WP-16 done-check: in Chromium, serde + serde_json resolve against the sparse index (the pinned
# WP-15 snapshot served at /index/, since index.crates.io has no CORS), download from
# static.crates.io with sha256 checks, unpack into the VFS, and a reload works offline (OPFS).
# The browser's Cargo.lock must equal the native resolver's for the same manifest.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ ! -d build/wp-15/index ]; then
  mkdir -p build/wp-15
  zstd -dc tests/resolver/index-snapshot.tar.zst | tar -x -C build/wp-15
fi
bash scripts/build-vfs.sh
bash scripts/build-resolver.sh
node scripts/build-web-tests.mjs
# Expected lockfile from the native resolver (crates/resolver, = cargo per WP-15's golden test).
SCRATCH=build/wp-16; mkdir -p "$SCRATCH"
node -e "const s=require('fs').readFileSync('tests/e2e/deps.spec.ts','utf8');process.stdout.write(s.match(/const MANIFEST = \`([^\`]*)\`/)[1])" > "$SCRATCH/Cargo.toml"
(cd crates && cargo run -q --release -p resolver --example generate-lockfile -- "../$SCRATCH/Cargo.toml" ../build/wp-15/index) > build/www/deps-test/expected.lock
(cd crates && cargo test -q --release -p resolver 2>&1 | grep -E '^test result' | tail -2)
pnpm exec playwright test tests/e2e/deps.spec.ts --project=chromium --reporter=line
echo "WP-16 verified."
