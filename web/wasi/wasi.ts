// WASI preview 1 on top of the shared VFS (WP-11). One `WasiProcess` per thread: all threads of a
// process share the fd table (kept in the VFS by pid), so files opened in one worker can be used
// from another. Reads and writes copy directly between the VFS memory and the guest's memory.
//
// Covers what rustc imports (see docs/baseline-notes.md) plus the rest of the fd/path API;
// sockets and signals are ENOSYS.

import { Kind, ROOT, type Vfs } from '../vfs/vfs';

export const E = { SUCCESS: 0, ACCES: 2, BADF: 8, INVAL: 28, IO: 29, ISDIR: 31, NOSYS: 52, NOTDIR: 54, NOTSUP: 58, SPIPE: 70 } as const;
const FILETYPE_DIR = 3, FILETYPE_FILE = 4, FILETYPE_SYMLINK = 7;
const LOOKUP_SYMLINK_FOLLOW = 1;
const filetype = (k: Kind) => (k === Kind.Dir ? FILETYPE_DIR : k === Kind.Symlink ? FILETYPE_SYMLINK : FILETYPE_FILE);
const OFLAGS = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 };
const FDFLAGS_APPEND = 1;

export class ProcExit extends Error {
  constructor(readonly code: number) { super(`proc_exit(${code})`); }
}

export type ProcessSpec = {
  args: string[];
  env: string[];
  stdin?: string; // VFS paths; created if missing
  stdout: string;
  stderr: string;
  /** Guest-visible name → VFS directory, opened as fds 3, 4, … */
  preopens: [string, string][];
};

/** Create a process's fd table in the VFS (stdio + preopens). Returns its pid. */
export function createProcess(vfs: Vfs, spec: ProcessSpec): number {
  for (const p of [spec.stdin, spec.stdout, spec.stderr]) if (p && !vfs.exists(p)) vfs.writeFile(p, '');
  return vfs.locked(() => {
    const pid = vfs.rawProcNew();
    const open = (path: string | undefined, append: boolean) => {
      const ino = path ? vfs.rawLookup(ROOT, path) : vfs.rawCreate(ROOT, '/dev-null', false, true);
      if (ino < 0) throw new Error(`createProcess: ${path}: errno ${-ino}`);
      vfs.rawFdOpen(pid, ino, append);
    };
    open(spec.stdin, false);
    open(spec.stdout, true);
    open(spec.stderr, true);
    for (const [guest, path] of spec.preopens) {
      const ino = vfs.rawLookup(ROOT, path);
      if (ino < 0) throw new Error(`createProcess: preopen ${path}: errno ${-ino}`);
      vfs.rawFdOpen(pid, ino, false, guest);
    }
    return pid;
  });
}

export function freeProcess(vfs: Vfs, pid: number) {
  vfs.locked(() => vfs.rawProcFree(pid));
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

export class WasiProcess {
  private memory!: WebAssembly.Memory;

  /** `onWrite` is called after each successful fd_write (the host's process runner uses it for stdout). */
  constructor(
    private readonly vfs: Vfs, readonly pid: number, private readonly args: string[], private readonly env: string[],
    private readonly onWrite?: (fd: number) => void,
  ) {}

  /** Call once the instance exists (the guest's memory is imported or exported). */
  setMemory(memory: WebAssembly.Memory) { this.memory = memory; }

  private get dv() { return new DataView(this.memory.buffer); }
  private get u8() { return new Uint8Array(this.memory.buffer); }
  private str(ptr: number, len: number) { return dec.decode(this.u8.slice(ptr, ptr + len)); }

  /** iovec array → list of guest byte views. */
  private iovs(ptr: number, n: number): Uint8Array[] {
    const dv = this.dv, u8 = this.u8, out: Uint8Array[] = [];
    for (let i = 0; i < n; i++) {
      const p = dv.getUint32(ptr + i * 8, true), l = dv.getUint32(ptr + i * 8 + 4, true);
      out.push(u8.subarray(p, p + l));
    }
    return out;
  }

  private writeStrings(list: string[], ptrs: number, buf: number) {
    const dv = this.dv, u8 = this.u8;
    for (const s of list) {
      dv.setUint32(ptrs, buf, true);
      ptrs += 4;
      const b = enc.encode(s);
      u8.set(b, buf);
      u8[buf + b.length] = 0;
      buf += b.length + 1;
    }
    return E.SUCCESS;
  }

  private sizes(list: string[], countPtr: number, sizePtr: number) {
    this.dv.setUint32(countPtr, list.length, true);
    this.dv.setUint32(sizePtr, list.reduce((n, s) => n + enc.encode(s).length + 1, 0), true);
    return E.SUCCESS;
  }

  /** Run `f` with the fd's info under the VFS lock; negative results are -errno. */
  private withFd(fd: number, f: (info: Exclude<ReturnType<Vfs['rawFdGet']>, number>) => number): number {
    return this.vfs.locked(() => {
      const info = this.vfs.rawFdGet(this.pid, fd);
      if (typeof info === 'number') return -info;
      const r = f(info);
      return r < 0 ? -r : r;
    });
  }

  private writeFilestat(out: number, ino: number): number {
    const s = this.vfs.rawStat(ino);
    if (typeof s === 'number') return s;
    const dv = this.dv;
    dv.setBigUint64(out, 0n, true); // dev
    dv.setBigUint64(out + 8, BigInt(ino), true);
    dv.setUint8(out + 16, filetype(s.kind));
    dv.setBigUint64(out + 24, 1n, true); // nlink
    dv.setBigUint64(out + 32, BigInt(s.size), true);
    dv.setBigUint64(out + 40, s.mtimeNs, true);
    dv.setBigUint64(out + 48, s.mtimeNs, true);
    dv.setBigUint64(out + 56, s.mtimeNs, true);
    return 0;
  }

  /** Directory inode behind a `dirfd` for path_* calls. */
  private dirOf(fd: number): number {
    const info = this.vfs.rawFdGet(this.pid, fd);
    return typeof info === 'number' ? info : info.ino;
  }

  readonly imports: Record<string, (...a: any[]) => number | void> = {
    args_sizes_get: (c: number, s: number) => this.sizes(this.args, c, s),
    args_get: (p: number, b: number) => this.writeStrings(this.args, p, b),
    environ_sizes_get: (c: number, s: number) => this.sizes(this.env, c, s),
    environ_get: (p: number, b: number) => this.writeStrings(this.env, p, b),

    clock_res_get: (_id: number, out: number) => { this.dv.setBigUint64(out, 1000n, true); return 0; },
    clock_time_get: (id: number, _precision: bigint, out: number) => {
      const ns = id === 0
        ? BigInt(Date.now()) * 1_000_000n
        : BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
      this.dv.setBigUint64(out, ns, true);
      return 0;
    },
    random_get: (ptr: number, len: number) => {
      // getRandomValues refuses shared views; 64 KiB per call.
      for (let o = 0; o < len; o += 65536) {
        const tmp = crypto.getRandomValues(new Uint8Array(Math.min(65536, len - o)));
        this.u8.set(tmp, ptr + o);
      }
      return 0;
    },

    fd_write: (fd: number, iovs: number, n: number, nwritten: number) => {
      const bufs = this.iovs(iovs, n);
      return this.withFd(fd, info => {
        let pos = info.append ? (this.vfs.rawStat(info.ino) as { size: number }).size : info.pos, total = 0;
        for (const b of bufs) {
          const r = this.vfs.rawWrite(info.ino, pos, b);
          if (r < 0) return r;
          pos += r;
          total += r;
        }
        this.vfs.rawFdSetPos(this.pid, fd, pos);
        this.dv.setUint32(nwritten, total, true);
        this.onWrite?.(fd);
        return 0;
      });
    },
    fd_pwrite: (fd: number, iovs: number, n: number, offset: bigint, nwritten: number) => {
      const bufs = this.iovs(iovs, n);
      return this.withFd(fd, info => {
        let pos = Number(offset), total = 0;
        for (const b of bufs) {
          const r = this.vfs.rawWrite(info.ino, pos, b);
          if (r < 0) return r;
          pos += r;
          total += r;
        }
        this.dv.setUint32(nwritten, total, true);
        return 0;
      });
    },
    fd_read: (fd: number, iovs: number, n: number, nread: number) => {
      const bufs = this.iovs(iovs, n);
      return this.withFd(fd, info => {
        let pos = info.pos, total = 0;
        for (const b of bufs) {
          const r = this.vfs.rawRead(info.ino, pos, b);
          if (r < 0) return r;
          pos += r;
          total += r;
          if (r < b.length) break;
        }
        this.vfs.rawFdSetPos(this.pid, fd, pos);
        this.dv.setUint32(nread, total, true);
        return 0;
      });
    },
    fd_pread: (fd: number, iovs: number, n: number, offset: bigint, nread: number) => {
      const bufs = this.iovs(iovs, n);
      return this.withFd(fd, info => {
        let pos = Number(offset), total = 0;
        for (const b of bufs) {
          const r = this.vfs.rawRead(info.ino, pos, b);
          if (r < 0) return r;
          pos += r;
          total += r;
          if (r < b.length) break;
        }
        this.dv.setUint32(nread, total, true);
        return 0;
      });
    },
    fd_seek: (fd: number, offset: bigint, whence: number, out: number) =>
      this.withFd(fd, info => {
        const size = (this.vfs.rawStat(info.ino) as { size: number }).size;
        const base = whence === 0 ? 0 : whence === 1 ? info.pos : whence === 2 ? size : NaN;
        const pos = base + Number(offset);
        if (!(pos >= 0)) return -E.INVAL;
        this.vfs.rawFdSetPos(this.pid, fd, pos);
        this.dv.setBigUint64(out, BigInt(pos), true);
        return 0;
      }),
    fd_tell: (fd: number, out: number) =>
      this.withFd(fd, info => { this.dv.setBigUint64(out, BigInt(info.pos), true); return 0; }),
    fd_close: (fd: number) => -Math.min(0, this.vfs.locked(() => this.vfs.rawFdClose(this.pid, fd))),
    fd_renumber: (from: number, to: number) => -Math.min(0, this.vfs.locked(() => this.vfs.rawFdRenumber(this.pid, from, to))),
    fd_sync: (fd: number) => this.withFd(fd, () => 0),
    fd_datasync: (fd: number) => this.withFd(fd, () => 0),
    fd_advise: (fd: number) => this.withFd(fd, () => 0),
    fd_allocate: (fd: number) => this.withFd(fd, () => 0),
    fd_fdstat_set_flags: (fd: number) => this.withFd(fd, () => 0),
    fd_fdstat_set_rights: (fd: number) => this.withFd(fd, () => 0),
    fd_fdstat_get: (fd: number, out: number) =>
      this.withFd(fd, info => {
        const s = this.vfs.rawStat(info.ino);
        if (typeof s === 'number') return s;
        const dv = this.dv;
        dv.setUint8(out, filetype(s.kind));
        dv.setUint16(out + 2, info.append ? FDFLAGS_APPEND : 0, true);
        dv.setBigUint64(out + 8, 0xffff_ffff_ffff_ffffn, true);
        dv.setBigUint64(out + 16, 0xffff_ffff_ffff_ffffn, true);
        return 0;
      }),
    fd_filestat_get: (fd: number, out: number) => this.withFd(fd, info => this.writeFilestat(out, info.ino)),
    fd_filestat_set_size: (fd: number, size: bigint) => this.withFd(fd, info => this.vfs.rawTruncate(info.ino, Number(size))),
    fd_filestat_set_times: (fd: number) => this.withFd(fd, () => 0),
    fd_prestat_get: (fd: number, out: number) =>
      this.vfs.locked(() => {
        const info = this.vfs.rawFdGet(this.pid, fd, true);
        if (typeof info === 'number') return -info;
        if (info.preopen === null) return E.BADF;
        this.dv.setUint8(out, 0);
        this.dv.setUint32(out + 4, enc.encode(info.preopen).length, true);
        return 0;
      }),
    fd_prestat_dir_name: (fd: number, ptr: number, len: number) =>
      this.vfs.locked(() => {
        const info = this.vfs.rawFdGet(this.pid, fd, true);
        if (typeof info === 'number') return -info;
        if (info.preopen === null) return E.BADF;
        this.u8.set(enc.encode(info.preopen).subarray(0, len), ptr);
        return 0;
      }),
    fd_readdir: (fd: number, buf: number, bufLen: number, cookie: bigint, usedPtr: number) =>
      this.withFd(fd, info => {
        const dv = this.dv, u8 = this.u8;
        let used = 0;
        for (let i = Number(cookie); used < bufLen; i++) {
          const e = this.vfs.rawReaddir(info.ino, i);
          if (typeof e === 'number') return e;
          if (e === null) break;
          const name = enc.encode(e.name), head = new Uint8Array(24), hv = new DataView(head.buffer);
          hv.setBigUint64(0, BigInt(i + 1), true);
          hv.setBigUint64(8, BigInt(e.ino), true);
          hv.setUint32(16, name.length, true);
          hv.setUint8(20, filetype(e.kind));
          const entry = new Uint8Array(24 + name.length);
          entry.set(head);
          entry.set(name, 24);
          const n = Math.min(entry.length, bufLen - used); // a truncated last entry tells the guest to call again
          u8.set(entry.subarray(0, n), buf + used);
          used += n;
        }
        dv.setUint32(usedPtr, used, true);
        return 0;
      }),

    path_open: (dirfd: number, _dirflags: number, p: number, l: number, oflags: number,
                _rb: bigint, _ri: bigint, fdflags: number, out: number) => {
      const path = this.str(p, l);
      return this.vfs.locked(() => {
        const dir = this.dirOf(dirfd);
        if (dir < 0) return -dir;
        let ino = oflags & OFLAGS.CREAT
          ? this.vfs.rawCreate(dir, path, !!(oflags & OFLAGS.EXCL), !!(oflags & OFLAGS.TRUNC))
          : this.vfs.rawLookup(dir, path);
        if (ino < 0) return -ino;
        const s = this.vfs.rawStat(ino) as { kind: Kind };
        if (oflags & OFLAGS.DIRECTORY && s.kind !== Kind.Dir) return E.NOTDIR;
        if (oflags & OFLAGS.TRUNC && !(oflags & OFLAGS.CREAT) && s.kind === Kind.File) this.vfs.rawTruncate(ino, 0);
        const fd = this.vfs.rawFdOpen(this.pid, ino, !!(fdflags & FDFLAGS_APPEND));
        if (fd < 0) return -fd;
        this.dv.setUint32(out, fd, true);
        return 0;
      });
    },
    path_create_directory: (fd: number, p: number, l: number) => this.pathOp(fd, p, l, (d, s) => this.vfs.rawMkdir(d, s)),
    path_remove_directory: (fd: number, p: number, l: number) => this.pathOp(fd, p, l, (d, s) => this.vfs.rawRmdir(d, s)),
    path_unlink_file: (fd: number, p: number, l: number) => this.pathOp(fd, p, l, (d, s) => this.vfs.rawUnlink(d, s)),
    path_filestat_get: (fd: number, flags: number, p: number, l: number, out: number) =>
      this.pathOp(fd, p, l, (d, s) => {
        const ino = flags & LOOKUP_SYMLINK_FOLLOW ? this.vfs.rawLookup(d, s) : this.vfs.rawLookupNofollow(d, s);
        return ino < 0 ? ino : this.writeFilestat(out, ino);
      }),
    path_filestat_set_times: (fd: number, _flags: number, p: number, l: number) =>
      this.pathOp(fd, p, l, (d, s) => Math.min(0, this.vfs.rawLookup(d, s))),
    path_readlink: (fd: number, p: number, l: number, buf: number, bufLen: number, usedPtr: number) =>
      this.pathOp(fd, p, l, (d, s) => {
        const t = this.vfs.rawReadlink(d, s);
        if (typeof t === 'number') return t;
        const n = Math.min(t.length, bufLen); // truncated, as POSIX readlink
        this.u8.set(t.subarray(0, n), buf);
        this.dv.setUint32(usedPtr, n, true);
        return 0;
      }),
    path_rename: (fd: number, p: number, l: number, fd2: number, p2: number, l2: number) => {
      const from = this.str(p, l), to = this.str(p2, l2);
      return this.vfs.locked(() => {
        const d1 = this.dirOf(fd), d2 = this.dirOf(fd2);
        if (d1 < 0) return -d1;
        if (d2 < 0) return -d2;
        return -Math.min(0, this.vfs.rawRename(d1, from, d2, to));
      });
    },
    path_link: () => E.NOTSUP, // callers (rustc's link_or_copy) fall back to copying
    path_symlink: (op: number, ol: number, fd: number, p: number, l: number) => {
      const target = this.str(op, ol);
      return this.pathOp(fd, p, l, (d, s) => this.vfs.rawSymlink(d, target, s));
    },

    poll_oneoff: (inPtr: number, outPtr: number, n: number, neventsPtr: number) => {
      // Clock subscriptions sleep; fd subscriptions are always ready (files never block).
      const dv = this.dv;
      let sleepNs = Infinity;
      for (let i = 0; i < n; i++) {
        const s = inPtr + i * 48;
        if (dv.getUint8(s + 8) === 0) {
          const timeout = Number(dv.getBigUint64(s + 24, true)), abs = dv.getUint16(s + 40, true) & 1;
          sleepNs = Math.min(sleepNs, abs ? Math.max(0, timeout - Date.now() * 1e6) : timeout);
        }
      }
      if (sleepNs !== Infinity && sleepNs > 0) Atomics.wait(sleepCell, 0, 0, sleepNs / 1e6);
      for (let i = 0; i < n; i++) {
        const s = inPtr + i * 48, e = outPtr + i * 32;
        dv.setBigUint64(e, dv.getBigUint64(s, true), true);
        dv.setUint16(e + 8, 0, true);
        dv.setUint8(e + 10, dv.getUint8(s + 8));
      }
      dv.setUint32(neventsPtr, n, true);
      return 0;
    },
    sched_yield: () => 0,
    proc_exit: (code: number) => { throw new ProcExit(code); },
    proc_raise: () => E.NOSYS,
    sock_accept: () => E.NOSYS,
    sock_recv: () => E.NOSYS,
    sock_send: () => E.NOSYS,
    sock_shutdown: () => E.NOSYS,
  };

  private pathOp(fd: number, p: number, l: number, f: (dir: number, path: string) => number): number {
    const path = this.str(p, l);
    return this.vfs.locked(() => {
      const dir = this.dirOf(fd);
      if (dir < 0) return -dir;
      return -Math.min(0, f(dir, path));
    });
  }
}
