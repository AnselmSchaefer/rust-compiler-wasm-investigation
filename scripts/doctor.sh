#!/usr/bin/env bash
# Checks that every tool the work packages rely on is installed (PLAN.md WP-00).
set -u
fail=0
ok()  { printf '  \033[32mok\033[0m   %-28s %s\n' "$1" "$2"; }
bad() { printf '  \033[31mFAIL\033[0m %-28s %s\n' "$1" "$2"; fail=1; }
check() { # name, command producing a version line
  local name=$1; shift
  if out=$("$@" 2>&1 | head -1) && [ -n "$out" ]; then ok "$name" "$out"; else bad "$name" "missing"; fi
}

echo "Host tools"
check cmake cmake --version
check ninja ninja --version
check clang clang --version
check python3 python3 --version
check git git --version
check brotli brotli --version
check node node --version
check pnpm pnpm --version
check sccache sccache --version

echo "Wasm tools"
check wasmtime wasmtime --version
check "wasmtime-threads (v46)" wasmtime-threads --version
check wasm-tools wasm-tools --version
check jco jco --version
check "wasi-sdk clang" "$HOME/opt/wasi-sdk/bin/clang" --version

echo "Rust"
check "rustc stable" rustc +stable -V
check "rustc nightly" rustc +nightly -V
for t in wasm32-wasip1 wasm32-wasip1-threads wasm32-wasip2 wasm32-wasip3; do
  if rustup target list --installed --toolchain nightly | grep -qx "$t"; then ok "nightly target" "$t"; else bad "nightly target" "$t"; fi
done

echo "Browsers (Playwright)"
for b in chromium firefox; do
  if ls "$HOME/.cache/ms-playwright" 2>/dev/null | grep -q "^$b-"; then ok "playwright $b" installed; else bad "playwright $b" missing; fi
done

echo "Machine"
ok cores "$(nproc)"
ok memory "$(free -g | awk '/Mem:/ {print $2 " GB"}')"
ok "free disk (/home)" "$(df -h /home | awk 'NR==2 {print $4}')"

[ $fail -eq 0 ] && echo "All checks passed." || echo "Some checks failed."
exit $fail
