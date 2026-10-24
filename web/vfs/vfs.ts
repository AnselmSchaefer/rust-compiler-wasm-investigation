// Shared virtual filesystem (WP-11). One WebAssembly.Memory holds the whole tree and all file
// bytes; every worker instantiates crates/vfs on it (`Vfs.attach`) and gets synchronous access.
// Reads and writes copy straight between that memory and the caller's buffer (e.g. rustc's memory).
//
// Concurrency: one lock word in shared memory around every call (see crates/vfs/src/ffi.rs).
// Workers block on it with Atomics.wait; the page thread, which may not block, spins.

export const ROOT = 0;

/** WASI preview 1 errno names for the values crates/vfs returns. */
const ERRNO: Record<number, string> = {
  20: 'EEXIST', 28: 'EINVAL', 31: 'EISDIR', 32: 'ELOOP', 37: 'ENAMETOOLONG', 44: 'ENOENT', 54: 'ENOTDIR', 55: 'ENOTEMPTY',
};

export class VfsError extends Error {
  constructor(readonly errno: number, op: string, path?: string) {
    super(`${op}${path ? ` ${path}` : ''}: ${ERRNO[errno] ?? `errno ${errno}`}`);
  }
}

export enum Kind { Dir = 3, File = 4, Symlink = 7 }
export type Stat = { kind: Kind; size: number; mtimeNs: bigint };
export type DirEntry = { name: string; ino: number; kind: Kind };
export type Changes = { removed: string[]; dirty: { path: string; kind: Kind }[] };

/** What a worker needs to attach: post it with postMessage (both parts are shareable). */
export type VfsHandle = { memory: WebAssembly.Memory; module: WebAssembly.Module };

export async function createVfs(wasmUrl: string | URL): Promise<VfsHandle> {
  const module = await WebAssembly.compileStreaming(fetch(wasmUrl));
  // 4 GiB maximum: the sysroot alone is ~100 MB, and it all lives here.
  const memory = new WebAssembly.Memory({ initial: 512, maximum: 65536, shared: true });
  return { memory, module };
}

type Exports = {
  __stack_pointer: WebAssembly.Global;
  VFS_LOCK: WebAssembly.Global; VFS_CHANGE_SEQ: WebAssembly.Global; VFS_NEXT_SLOT: WebAssembly.Global;
  VFS_SLOTS: WebAssembly.Global; VFS_SLOT_LAYOUT: WebAssembly.Global;
  vfs_lookup(dir: number, p: number, l: number): number;
  vfs_lookup_nofollow(dir: number, p: number, l: number): number;
  vfs_symlink(dir: number, tp: number, tl: number, p: number, l: number, now: bigint): number;
  vfs_readlink(dir: number, p: number, l: number, out: number): number;
  vfs_create(dir: number, p: number, l: number, flags: number, now: bigint): number;
  vfs_mkdir(dir: number, p: number, l: number, now: bigint): number;
  vfs_mkdir_all(dir: number, p: number, l: number, now: bigint): number;
  vfs_unlink(dir: number, p: number, l: number, now: bigint): number;
  vfs_rmdir(dir: number, p: number, l: number, now: bigint): number;
  vfs_remove_all(dir: number, p: number, l: number, now: bigint): number;
  vfs_rename(fd: number, fp: number, fl: number, td: number, tp: number, tl: number, now: bigint): number;
  vfs_stat(ino: number, out: number): number;
  vfs_data(ino: number, out: number): number;
  vfs_reserve(ino: number, off: bigint, len: number, now: bigint): number;
  vfs_truncate(ino: number, size: bigint, now: bigint): number;
  vfs_readdir(dir: number, index: number, out: number): number;
  vfs_set_persist(ino: number, persist: number): number;
  vfs_take_changes(out: number): number;
  vfs_inode_count(): number;
  vfs_proc_new(): number;
  vfs_proc_free(pid: number): void;
  vfs_fd_open(pid: number, ino: number, append: number, preopen: number, preopenLen: number): number;
  vfs_fd_get(pid: number, fd: number, out: number): number;
  vfs_fd_set_pos(pid: number, fd: number, pos: bigint): number;
  vfs_fd_close(pid: number, fd: number): number;
  vfs_fd_renumber(pid: number, from: number, to: number): number;
};

/** `preopen` is only decoded when asked for (it is off the hot read/write path). */
export type FdInfo = { ino: number; append: boolean; pos: number; isPreopen: boolean; preopen: string | null };

const canBlock = typeof (globalThis as any).WorkerGlobalScope !== 'undefined';
const now = () => BigInt(Date.now()) * 1_000_000n;
const enc = new TextEncoder();
const dec = new TextDecoder();

export class Vfs {
  private constructor(
    private readonly x: Exports,
    private readonly memory: WebAssembly.Memory,
    private readonly scratch: number, // 64 KiB per instance: paths at +0, out params at +SCRATCH_OUT
  ) {}

  /** Instantiate the VFS on the shared memory in this worker (or the page). */
  static async attach({ memory, module }: VfsHandle): Promise<Vfs> {
    const inst = await WebAssembly.instantiate(module, { env: { memory } });
    const x = inst.exports as unknown as Exports;
    const i32 = new Int32Array(memory.buffer);
    const [slotSize, stackSize, maxSlots] = new Uint32Array(memory.buffer, x.VFS_SLOT_LAYOUT.value, 3);
    const slot = Atomics.add(i32, x.VFS_NEXT_SLOT.value >> 2, 1);
    if (slot >= maxSlots) throw new Error(`vfs: more than ${maxSlots} instances`);
    const base = x.VFS_SLOTS.value + slot * slotSize;
    x.__stack_pointer.value = base + stackSize; // stacks grow down; scratch follows the stack
    return new Vfs(x, memory, base + stackSize);
  }

  // ---------- locking and memory access ----------

  private get i32() { return new Int32Array(this.memory.buffer); }
  private get u8() { return new Uint8Array(this.memory.buffer); }

  /** Run `f` under the VFS lock. Everything that touches VFS memory must go through here. */
  locked<T>(f: () => T): T {
    const i32 = this.i32, lock = this.x.VFS_LOCK.value >> 2;
    while (Atomics.compareExchange(i32, lock, 0, 1) !== 0) {
      if (canBlock) Atomics.wait(i32, lock, 1, 5);
    }
    const seq = this.x.VFS_CHANGE_SEQ.value >> 2, before = Atomics.load(i32, seq);
    try {
      return f();
    } finally {
      Atomics.store(i32, lock, 0);
      Atomics.notify(i32, lock, 1);
      if (Atomics.load(i32, seq) !== before) Atomics.notify(i32, seq);
    }
  }

  private putPath(path: string, at = 0): [number, number] {
    // encodeInto() rejects shared buffers in Chromium; paths are short, so encode then copy.
    const bytes = enc.encode(path);
    if (bytes.length > 30 * 1024) throw new VfsError(37, 'path', path.slice(0, 64));
    this.u8.set(bytes, this.scratch + at);
    return [this.scratch + at, bytes.length];
  }

  private get out() { return this.scratch + 61 * 1024; }

  private check(r: number, op: string, path?: string): number {
    if (r < 0) throw new VfsError(-r, op, path);
    return r;
  }

  // ---------- raw calls (caller holds the lock; return -errno instead of throwing) ----------
  // Used by the WASI adapter, which needs errnos and already holds the lock.

  rawLookup(dir: number, path: string) { return this.x.vfs_lookup(dir, ...this.putPath(path)); }
  rawLookupNofollow(dir: number, path: string) { return this.x.vfs_lookup_nofollow(dir, ...this.putPath(path)); }
  rawSymlink(dir: number, target: string, path: string) {
    const [tp, tl] = this.putPath(target), [p, l] = this.putPath(path, 31 * 1024);
    return this.x.vfs_symlink(dir, tp, tl, p, l, now());
  }
  /** Link target as UTF-8 bytes, or -errno. */
  rawReadlink(dir: number, path: string): Uint8Array | number {
    const r = this.x.vfs_readlink(dir, ...this.putPath(path), this.out);
    if (r < 0) return r;
    const [ptr, len] = new Uint32Array(this.memory.buffer, this.out, 2);
    return this.u8.slice(ptr, ptr + len);
  }
  rawCreate(dir: number, path: string, excl: boolean, trunc: boolean) {
    return this.x.vfs_create(dir, ...this.putPath(path), (excl ? 1 : 0) | (trunc ? 2 : 0), now());
  }
  rawMkdir(dir: number, path: string) { return this.x.vfs_mkdir(dir, ...this.putPath(path), now()); }
  rawUnlink(dir: number, path: string) { return this.x.vfs_unlink(dir, ...this.putPath(path), now()); }
  rawRmdir(dir: number, path: string) { return this.x.vfs_rmdir(dir, ...this.putPath(path), now()); }
  rawRename(fromDir: number, from: string, toDir: number, to: string) {
    const [fp, fl] = this.putPath(from), [tp, tl] = this.putPath(to, 31 * 1024);
    return this.x.vfs_rename(fromDir, fp, fl, toDir, tp, tl, now());
  }
  rawStat(ino: number): Stat | number {
    const r = this.x.vfs_stat(ino, this.out);
    if (r < 0) return r;
    const v = new BigUint64Array(this.memory.buffer, this.out, 3);
    return { kind: Number(v[0]) as Kind, size: Number(v[1]), mtimeNs: v[2] };
  }
  rawTruncate(ino: number, size: number) { return this.x.vfs_truncate(ino, BigInt(size), now()); }

  /** Copy up to `dst.length` bytes at `offset` into `dst` (any memory, e.g. a guest's). */
  rawRead(ino: number, offset: number, dst: Uint8Array): number {
    const r = this.x.vfs_data(ino, this.out);
    if (r < 0) return r;
    const [ptr, len] = new Uint32Array(this.memory.buffer, this.out, 2);
    const start = Math.min(offset, len), n = Math.min(dst.length, len - start);
    dst.set(this.u8.subarray(ptr + start, ptr + start + n));
    return n;
  }

  /** Copy `src` into the file at `offset`, growing it as needed. */
  rawWrite(ino: number, offset: number, src: Uint8Array): number {
    const ptr = this.x.vfs_reserve(ino, BigInt(offset), src.length, now());
    if (ptr === 0 && src.length > 0) return -31; // a directory (or out of memory)
    this.u8.set(src, ptr);
    return src.length;
  }

  rawReaddir(dir: number, index: number): DirEntry | null | number {
    const r = this.x.vfs_readdir(dir, index, this.out);
    if (r <= 0) return r === 0 ? null : r;
    const [p, l, ino, kind] = new Uint32Array(this.memory.buffer, this.out, 4);
    return { name: dec.decode(this.u8.slice(p, p + l)), ino, kind: kind as Kind };
  }

  // ---------- per-process fd tables (shared by all threads of a WASI process) ----------

  rawProcNew() { return this.x.vfs_proc_new(); }
  rawProcFree(pid: number) { this.x.vfs_proc_free(pid); }
  rawFdOpen(pid: number, ino: number, append: boolean, preopen: string | null = null) {
    const [p, l] = preopen === null ? [0, 0] : this.putPath(preopen);
    return this.x.vfs_fd_open(pid, ino, append ? 1 : 0, p, l);
  }
  rawFdGet(pid: number, fd: number, withName = false): FdInfo | number {
    const r = this.x.vfs_fd_get(pid, fd, this.out);
    if (r < 0) return r;
    const u = new Uint32Array(this.memory.buffer, this.out, 6);
    const pos = Number(new BigUint64Array(this.memory.buffer, this.out + 8, 1)[0]);
    const isPreopen = u[4] !== 0;
    const preopen = isPreopen && withName ? dec.decode(this.u8.slice(u[4], u[4] + u[5])) : null;
    return { ino: u[0], append: u[1] !== 0, pos, isPreopen, preopen };
  }
  rawFdSetPos(pid: number, fd: number, pos: number) { return this.x.vfs_fd_set_pos(pid, fd, BigInt(pos)); }
  rawFdClose(pid: number, fd: number) { return this.x.vfs_fd_close(pid, fd); }
  rawFdRenumber(pid: number, from: number, to: number) { return this.x.vfs_fd_renumber(pid, from, to); }

  // ---------- convenience API (takes the lock, throws VfsError) ----------

  lookup(path: string, dir = ROOT) { return this.locked(() => this.check(this.rawLookup(dir, path), 'lookup', path)); }
  exists(path: string) { return this.locked(() => this.rawLookup(ROOT, path) >= 0); }
  /** Create a symlink at `path` pointing to `target` (e.g. so rustc finds its sysroot from argv[0]). */
  symlink(target: string, path: string) { this.locked(() => this.check(this.rawSymlink(ROOT, target, path), 'symlink', path)); }
  readlink(path: string) {
    return this.locked(() => {
      const r = this.rawReadlink(ROOT, path);
      if (typeof r === 'number') throw new VfsError(-r, 'readlink', path);
      return dec.decode(r);
    });
  }
  mkdir(path: string) { return this.locked(() => this.check(this.rawMkdir(ROOT, path), 'mkdir', path)); }
  mkdirAll(path: string) {
    return this.locked(() => this.check(this.x.vfs_mkdir_all(ROOT, ...this.putPath(path), now()), 'mkdirAll', path));
  }
  unlink(path: string) { this.locked(() => this.check(this.rawUnlink(ROOT, path), 'unlink', path)); }
  rmdir(path: string) { this.locked(() => this.check(this.rawRmdir(ROOT, path), 'rmdir', path)); }
  removeAll(path: string) {
    this.locked(() => this.check(this.x.vfs_remove_all(ROOT, ...this.putPath(path), now()), 'removeAll', path));
  }
  rename(from: string, to: string) { this.locked(() => this.check(this.rawRename(ROOT, from, ROOT, to), 'rename', from)); }

  stat(path: string): Stat {
    return this.locked(() => {
      const s = this.rawStat(this.check(this.rawLookup(ROOT, path), 'stat', path));
      if (typeof s === 'number') throw new VfsError(-s, 'stat', path);
      return s;
    });
  }

  readFile(path: string): Uint8Array {
    return this.locked(() => {
      const ino = this.check(this.rawLookup(ROOT, path), 'readFile', path);
      this.check(this.x.vfs_data(ino, this.out), 'readFile', path);
      const [ptr, len] = new Uint32Array(this.memory.buffer, this.out, 2);
      return this.u8.slice(ptr, ptr + len);
    });
  }
  readText(path: string) { return dec.decode(this.readFile(path)); }

  /** Create or replace a file, creating parent directories. */
  writeFile(path: string, data: Uint8Array | string) {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    this.locked(() => {
      const parent = path.slice(0, path.lastIndexOf('/'));
      if (parent) this.check(this.x.vfs_mkdir_all(ROOT, ...this.putPath(parent), now()), 'writeFile', path);
      const ino = this.check(this.rawCreate(ROOT, path, false, true), 'writeFile', path);
      this.check(this.rawWrite(ino, 0, bytes), 'writeFile', path);
    });
  }

  readdir(path: string): DirEntry[] {
    return this.locked(() => {
      const dir = this.check(this.rawLookup(ROOT, path), 'readdir', path);
      const out: DirEntry[] = [];
      for (let i = 0; ; i++) {
        const e = this.rawReaddir(dir, i);
        if (e === null) return out;
        if (typeof e === 'number') throw new VfsError(-e, 'readdir', path);
        out.push(e);
      }
    });
  }

  /** Persist the subtree at `path` (see persist.ts). */
  setPersist(path: string, persist = true) {
    this.locked(() => this.x.vfs_set_persist(this.check(this.rawLookup(ROOT, path), 'setPersist', path), persist ? 1 : 0));
  }

  takeChanges(): Changes {
    return this.locked(() => {
      this.x.vfs_take_changes(this.out);
      const [ptr, len] = new Uint32Array(this.memory.buffer, this.out, 2);
      const buf = this.u8.slice(ptr, ptr + len), dv = new DataView(buf.buffer);
      let o = 0;
      const str = () => { const l = dv.getUint32(o, true); o += 4; const s = dec.decode(buf.subarray(o, o + l)); o += l; return s; };
      const removed = Array.from({ length: dv.getUint32((o += 4) - 4, true) }, str);
      const dirty = Array.from({ length: dv.getUint32((o += 4) - 4, true) }, () => {
        const kind = buf[o++] as Kind;
        return { kind, path: str() };
      });
      return { removed, dirty };
    });
  }

  /** Index (in an Int32Array over the memory) of the change counter, for Atomics.waitAsync. */
  get changeSeqIndex() { return this.x.VFS_CHANGE_SEQ.value >> 2; }
  get sharedI32() { return this.i32; }
  inodeCount() { return this.locked(() => this.x.vfs_inode_count()); }
}
