; WP-04 smoke test: compiled by llc.wasm and linked by wasm-ld.wasm, then run in wasmtime.
target triple = "wasm32-unknown-wasi"

@msg = private constant [26 x i8] c"Hello from llc + wasm-ld\0A\00"
@iov = global { ptr, i32 } { ptr @msg, i32 25 }

declare i32 @fd_write(i32, ptr, i32, ptr) #0

define void @_start() {
  %written = alloca i32
  %r = call i32 @fd_write(i32 1, ptr @iov, i32 1, ptr %written)
  ret void
}

attributes #0 = { "wasm-import-module"="wasi_snapshot_preview1" "wasm-import-name"="fd_write" }
