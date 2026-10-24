# Virtual filesystem and WASI layer (WP-11)

## Design
- **One shared `WebAssembly.Memory` holds the whole filesystem**: the tree, file bytes and per-process fd tables. `crates/vfs` (`no_std` Rust, 92 KB wasm) manages it. **Every worker instantiates the module on that same memory** (`Vfs.attach`), so all workers see one filesystem and access it synchronously. There is no server thread and no message round trip.
- **Locking:** one lock word in shared memory around every call. Workers block with `Atomics.wait`; the page thread spins. All Rust code, including the allocator (`dlmalloc` growing the shared memory), runs under that lock.
- **Per-instance stacks:** each instance claims a slot (`VFS_NEXT_SLOT`, up to 128) and points its exported `__stack_pointer` at that slot's 64 KiB stack. The slot's other 64 KiB is scratch space for paths and results. The memory's data segments are initialized once (wasm-ld's guarded `__wasm_init_memory`).
- **One copy per read or write:** a read copies straight from the VFS memory into the guest's memory (`rawRead(ino, off, guestView)`). A write reserves space in the file and copies straight from the guest. Compare `browser_wasi_shim-threads`, which copies every read through a fixed-size bounce buffer and a message to the filesystem owner (WP-01 finding #7).
- **fd tables live in the VFS, per pid**, so all threads of a WASI process (each in its own worker) share fds and seek positions. stdio are plain VFS files (the host picks the paths), so output from any thread lands in one place.
- **Persistence:** `persist.ts` mirrors a subtree (e.g. `/project`) to OPFS from one worker using sync access handles. The Rust core records dirty inodes and removed paths for persisted subtrees (`take_changes`). The persister waits on a change counter (`Atomics.waitAsync`), debounces 20 ms and writes the changes out: removals first, then directories, then files. On start it restores the subtree from OPFS.
- **No hard links or symlinks.** `path_link` returns ENOTSUP; rustc then falls back to copying. Every inode has exactly one parent, so its path can always be rebuilt for persistence.

## WASI preview 1 (`web/wasi/`)
- `wasi.ts`: all fd/path/clock/random/poll calls over the VFS. Sockets and signals return ENOSYS.
- `process.ts` + `process-worker.ts`: run a `wasip1-threads` program. The main thread runs in one worker, and each `thread-spawn` gets a new worker. A blocked thread can't start a worker itself, so spawn requests go through a shared ring buffer to the page, which never blocks. WP-12 replaces this with a pool.

## Measured (Chromium 156, 2026-10-24)
Same oligamiq rustc.wasm as WP-02, with only the filesystem/WASI layer swapped. Median of 3 runs, **taken while the LLVM build ran with `-j10`**, so these are upper bounds. A proper `pnpm bench` variant is a follow-up.

| Step | browser_wasi_shim-threads (WP-02) | our VFS + WASI |
|---|---|---|
| `rustc -V` | 93 ms | 39 ms |
| check-hello | 447 ms | 277 ms (216 best) |
| build-hello | 1010 ms | 673 ms (603 best) |
| build-medium | 1935 ms | 1849 ms (1563 best) |
| library build (`--crate-type lib`) | failed until the shim was patched | 231 ms |

- **VFS micro-benchmark:** 64 MiB written in 1 MiB chunks in 29–35 ms. The same file read into another worker's memory in one copy took 27–33 ms. 600 small files written by two workers concurrently in 12–14 ms.
- **Restore:** 603 files restored from OPFS on reload in well under a second.
