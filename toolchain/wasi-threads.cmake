# CMake toolchain for wasm32-wasip1-threads with wasi-sdk (WASI_SDK_PREFIX).
# Based on wasi-sdk-34's share/cmake/wasi-sdk-pthread.cmake, which still uses the old
# `wasm32-wasi-threads` triple that its sysroot no longer has libraries for.
set(CMAKE_SYSTEM_NAME WASI)
set(CMAKE_SYSTEM_VERSION 1)
set(CMAKE_SYSTEM_PROCESSOR wasm32)
set(triple wasm32-wasip1-threads)
set(CMAKE_C_FLAGS_INIT "-pthread")
set(CMAKE_CXX_FLAGS_INIT "-pthread")
# wasi-threads needs an imported (shared) memory, and WASI needs it exported.
# Note: these *_INIT flags only apply when the caller does not set CMAKE_*_FLAGS itself.
set(CMAKE_EXE_LINKER_FLAGS_INIT "-Wl,--import-memory -Wl,--export-memory")
set(CMAKE_EXECUTABLE_SUFFIX .wasm)
list(APPEND CMAKE_MODULE_PATH "${WASI_SDK_PREFIX}/share/cmake")

set(CMAKE_C_COMPILER ${WASI_SDK_PREFIX}/bin/clang)
set(CMAKE_CXX_COMPILER ${WASI_SDK_PREFIX}/bin/clang++)
set(CMAKE_ASM_COMPILER ${WASI_SDK_PREFIX}/bin/clang)
set(CMAKE_AR ${WASI_SDK_PREFIX}/bin/llvm-ar)
set(CMAKE_RANLIB ${WASI_SDK_PREFIX}/bin/llvm-ranlib)
set(CMAKE_C_COMPILER_TARGET ${triple})
set(CMAKE_CXX_COMPILER_TARGET ${triple})
set(CMAKE_ASM_COMPILER_TARGET ${triple})

set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
