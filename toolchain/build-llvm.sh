#!/usr/bin/env bash
# Build LLVM + lld for a wasm32-wasip1-threads host (WP-04): the LLVM that rustc 1.99.1 uses, with
# toolchain/patches/llvm applied. Resumable: each stage leaves a stamp in build/.stamps/, and ninja
# picks up where it stopped. Run in the background; logs go to build-logs/wp-04/.
#
#   toolchain/build-llvm.sh [stage...]    stages: source native configure build install (default: all)
#
# Outputs: build/llvm-wasm (build tree), build/llvm-wasm-install (static libs, headers, llc.wasm, wasm-ld.wasm,
# and a native llvm-config describing them for rustc's bootstrap).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LLVM_SHA=1b9c0d5ff9bbe7634aead059efe6b11a7eeba145 # rust-lang/rust 1.99.1 src/llvm-project (rustc/23.1-2026-07-22)
SRC="$ROOT/build/llvm-project"
NATIVE="$ROOT/build/llvm-native"
WASM="$ROOT/build/llvm-wasm"
INSTALL="$ROOT/build/llvm-wasm-install"
STAMPS="$ROOT/build/.stamps"
WASI_SDK="${WASI_SDK_PATH:-$HOME/opt/wasi-sdk}"
JOBS="${JOBS:-10}"
mkdir -p "$STAMPS"

stage_source() {
  if [ ! -d "$SRC/.git" ]; then
    git init -q "$SRC"
    git -C "$SRC" remote add origin https://github.com/rust-lang/llvm-project.git
    git -C "$SRC" sparse-checkout set llvm lld cmake third-party libunwind/include libc
    git -C "$SRC" fetch -q --depth 1 origin "$LLVM_SHA"
    git -C "$SRC" checkout -q FETCH_HEAD
  fi
  if ! git -C "$SRC" rev-parse -q --verify wasi-host >/dev/null; then
    git -C "$SRC" checkout -q -b wasi-host "$LLVM_SHA"
    git -C "$SRC" -c user.name=build -c user.email=build@localhost am -q "$ROOT"/toolchain/patches/llvm/*.patch
  fi
}

# Host tablegens, needed to cross-compile LLVM.
stage_native() {
  cmake -G Ninja -S "$SRC/llvm" -B "$NATIVE" -DCMAKE_BUILD_TYPE=Release \
    -DLLVM_TARGETS_TO_BUILD=WebAssembly -DLLVM_ENABLE_PROJECTS= \
    -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF \
    -DCMAKE_C_COMPILER_LAUNCHER=sccache -DCMAKE_CXX_COMPILER_LAUNCHER=sccache >/dev/null
  ninja -C "$NATIVE" -j "$JOBS" llvm-tblgen llvm-min-tblgen llvm-config
}

stage_configure() {
  # Flags after YoWASP/clang build.sh: LLVM has a few (unreachable for us) mmap calls; LLVM and lld
  # can need a lot of memory and stack. Threads stay on: rustc runs LLVM from several threads.
  # -pthread is repeated here because explicit CMAKE_*_FLAGS replace the toolchain file's *_INIT flags.
  local cflags="-pthread -D_WASI_EMULATED_MMAN"
  # --import-memory/--export-memory: threads must share one imported memory (the toolchain file's
  # *_INIT linker flags are replaced by this explicit value, like -pthread above).
  local ldflags="-Wl,--import-memory -Wl,--export-memory -lwasi-emulated-mman -Wl,--max-memory=4294967296 -Wl,-z,stack-size=8388608 -Wl,--stack-first"
  cmake -G Ninja -S "$SRC/llvm" -B "$WASM" \
    -DCMAKE_TOOLCHAIN_FILE="$ROOT/toolchain/wasi-threads.cmake" \
    -DWASI_SDK_PREFIX="$WASI_SDK" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$INSTALL" \
    -DCMAKE_C_COMPILER_LAUNCHER=sccache -DCMAKE_CXX_COMPILER_LAUNCHER=sccache \
    -DCMAKE_C_FLAGS="$cflags" -DCMAKE_CXX_FLAGS="$cflags" -DCMAKE_EXE_LINKER_FLAGS="$ldflags" \
    -DLLVM_NATIVE_TOOL_DIR="$NATIVE/bin" \
    -DLLVM_HOST_TRIPLE=wasm32-wasip1-threads \
    -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-wasip1 \
    -DLLVM_TARGETS_TO_BUILD=WebAssembly \
    -DLLVM_ENABLE_PROJECTS=lld \
    -DLLVM_ENABLE_THREADS=ON \
    -DLLVM_ENABLE_ASSERTIONS=OFF \
    -DLLVM_BUILD_STATIC=ON -DLLVM_ENABLE_PIC=OFF -DBUILD_SHARED_LIBS=OFF -DLLVM_BUILD_LLVM_DYLIB=OFF \
    -DLLVM_BUILD_TOOLS=OFF -DLLVM_INCLUDE_TOOLS=ON -DLLVM_BUILD_UTILS=OFF -DLLVM_INCLUDE_UTILS=OFF \
    -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_INCLUDE_DOCS=OFF \
    -DLLVM_BUILD_RUNTIME=OFF -DLLVM_INCLUDE_RUNTIMES=OFF \
    -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF -DLLVM_ENABLE_LIBXML2=OFF -DLLVM_ENABLE_TERMINFO=OFF \
    -DLLVM_ENABLE_LIBEDIT=OFF -DLLVM_ENABLE_LIBPFM=OFF -DLLVM_ENABLE_BACKTRACES=OFF \
    -DLLVM_ENABLE_CRASH_OVERRIDES=OFF -DLLVM_ENABLE_PLUGINS=OFF \
    -DLLVM_PARALLEL_LINK_JOBS=1
}

stage_build() {
  # Default target = every static library rustc_llvm may link; plus the two smoke-test tools.
  ninja -C "$WASM" -j "$JOBS"
  ninja -C "$WASM" -j "$JOBS" llc lld
}

stage_install() {
  ninja -C "$WASM" install >/dev/null
  mkdir -p "$INSTALL/bin"
  # LLVM names its executables without a suffix even for a wasm host.
  cp "$WASM/bin/llc" "$INSTALL/bin/llc.wasm"
  cp "$WASM/bin/lld" "$INSTALL/bin/wasm-ld.wasm" # multicall lld; pick the wasm flavor with `-flavor wasm`
  # rustc's bootstrap runs llvm-config natively, so it gets the native one (same version and
  # targets). Placed here, it derives lib/ and include/ from its own location and so describes
  # the wasm libraries.
  cp "$NATIVE/bin/llvm-config" "$INSTALL/bin/llvm-config"
}

stages=("$@"); [ ${#stages[@]} -gt 0 ] || stages=(source native configure build install)
for s in "${stages[@]}"; do
  if [ -f "$STAMPS/llvm-$s" ] && [ "$s" != build ]; then echo "== $s: done (stamp)"; continue; fi
  echo "== $s: $(date -Is)"
  "stage_$s"
  touch "$STAMPS/llvm-$s"
done
echo "== all done: $(date -Is)"
