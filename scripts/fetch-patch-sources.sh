#!/usr/bin/env bash
# Fetch the existing "rustc as a Wasm host" patch sets catalogued in docs/patches.md (WP-03),
# pinned to the commits that were reviewed, into build/wp-03/src/.
set -euo pipefail
cd "$(dirname "$0")/.."
out=build/wp-03/src
mkdir -p "$out"/{bjorn3,oligamiq,danlapid,yowasp}

commit_patch() { # repo sha dest
  [ -s "$3" ] || gh api "repos/$1/commits/$2" -H "Accept: application/vnd.github.patch" > "$3"
}

# bjorn3/rust compile_rustc_for_wasm20 (base rust-lang/rust e6b64a2f4c, 2026-04-02)
i=1; for s in 1a0d591a9c a8da5c9fe0 3b6974e6ee; do commit_patch bjorn3/rust $s "$out/bjorn3/$i-$s.patch"; i=$((i+1)); done
# oligamiq/rust compile_rustc_for_wasm17 @ cf327c2068 (source of rust_wasm v3; base 39cb3386dd, 2024-11-27)
i=1; for s in 2af9f55799 08ec940e11 132c6388ad bab49c215b 315dd3f99d f7a223c1c2; do
  commit_patch oligamiq/rust $s "$out/oligamiq/$i-$s.patch"; i=$((i+1))
done
# YoWASP/llvm-project: WASI support for LLVM (main+wasm and llvmorg-22.1.0+wasm carry the same change)
commit_patch YoWASP/llvm-project 69bd8547e9 "$out/yowasp/69bd8547e9.patch"
commit_patch YoWASP/llvm-project 97196c8eeb "$out/yowasp/97196c8eeb-llvm22.patch"
# danlapid/rust-playground toolchain/rustc-patches @ 2e3887adc6 (2026-10-18; against rust 1.98.1)
ref=2e3887adc6
for f in $(gh api repos/danlapid/rust-playground/contents/toolchain/rustc-patches?ref=$ref -q '.[].name'); do
  [ -s "$out/danlapid/$f" ] || gh api "repos/danlapid/rust-playground/contents/toolchain/rustc-patches/$f?ref=$ref" -q .content | base64 -d > "$out/danlapid/$f"
done
ls "$out"/*/ | grep -c patch | xargs echo "patches:"
