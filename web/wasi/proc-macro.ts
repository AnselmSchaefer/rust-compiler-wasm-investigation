// The host of Wasm proc macros inside rustc.wasm (WP-20), in the worker that runs the rustc
// thread. rustc-multi (toolchain/rustc-multi/pm.rs) imports `rust_pm.load` and `rust_pm.expand`.
// A proc macro is a wasm32-wasip1 module that rustc built with `--crate-type proc-macro`: it
// exports the decls static (a `&[Client]`), `_initialize`, its function table and
// `malloc`/`free`/`realloc` (the last ones from the planner's link arguments). This file drives its
// stock proc_macro client the way crates/pm-bridge/host/src/raw.rs does under wasmtime:
//
// - the macro's `BridgeConfig` is built in guest memory and `Client.run` is called through the
//   guest's table; wasm32 C ABI: structs by pointer, struct results through a return pointer;
// - the guest's bridge requests come to `dispatch` (a host function placed in the guest's table,
//   with `reserve` and `drop` for buffers the host allocates), which hands them to rustc through
//   `host_call` in rustc's table: rustc's real proc-macro server answers, synchronously, on this
//   thread.
//
// Everything is synchronous: rustc is inside the import call while the macro runs.

import type { Vfs } from '../vfs/vfs';

const dec = new TextDecoder();

// pm.rs `Ctx`: seven u32 words in rustc's memory.
const CTX = { helper: 0, ptr: 4, len: 8, cap: 12, call: 16, env: 20, version: 24 };
const RESERVE = 0, DISPATCH = 1;

/** FNV-1a over the module bytes: the version rustc keys its slot tables by. */
function version(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return h >>> 0;
}

/**
 * A module that exports wasm wrappers of three host functions (a funcref table only takes wasm
 * functions): reserve(sret, buf, additional), drop(buf), call(sret, env, buf).
 */
const HELPER = (() => {
  const t3 = [0x60, 3, 0x7f, 0x7f, 0x7f, 0], t1 = [0x60, 1, 0x7f, 0];
  const name = (s: string) => [s.length, ...[...s].map(c => c.charCodeAt(0))];
  const section = (id: number, body: number[]) => [id, body.length, ...body];
  const body = (args: number, f: number) => {
    const code = [0, ...Array.from({ length: args }, (_, i) => [0x20, i]).flat(), 0x10, f, 0x0b];
    return [code.length, ...code];
  };
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...section(1, [2, ...t3, ...t1]),
    ...section(2, [3, ...name('h'), ...name('r'), 0, 0, ...name('h'), ...name('d'), 0, 1, ...name('h'), ...name('c'), 0, 0]),
    ...section(3, [3, 0, 1, 0]),
    ...section(7, [3, ...name('reserve'), 0, 3, ...name('drop'), 0, 4, ...name('call'), 0, 5]),
    ...section(10, [3, ...body(3, 0), ...body(1, 1), ...body(3, 2)]),
  ]);
})();
let helperModule: WebAssembly.Module | undefined;

type Dispatch = (request: Uint8Array) => Uint8Array;

/** One instance of a proc-macro module (raw.rs `RawGuest`). */
class Guest {
  readonly clients: number[];
  private readonly memory: WebAssembly.Memory;
  private readonly table: WebAssembly.Table;
  private readonly malloc: (n: number) => number;
  private readonly free: (p: number) => void;
  private readonly realloc: (p: number, n: number) => number;
  private readonly fns: { reserve: number; drop: number; call: number };
  private dispatch: Dispatch | null = null;
  stderr = '';

  constructor(module: WebAssembly.Module, symbol: string) {
    const ERRNO_NOSYS = 52;
    let memory!: WebAssembly.Memory;
    const view = () => new DataView(memory.buffer);
    const wasi: Record<string, (...a: number[]) => number> = {
      fd_write: (fd, iovs, n, written) => {
        let total = 0;
        for (let i = 0; i < n; i++) {
          const p = view().getUint32(iovs + 8 * i, true), l = view().getUint32(iovs + 8 * i + 4, true);
          if (fd === 1 || fd === 2) this.stderr += dec.decode(new Uint8Array(memory.buffer, p, l));
          total += l;
        }
        view().setUint32(written, total, true);
        return 0;
      },
      environ_sizes_get: (c, s) => { view().setUint32(c, 0, true); view().setUint32(s, 0, true); return 0; },
      environ_get: () => 0,
      random_get: (p, n) => { crypto.getRandomValues(new Uint8Array(memory.buffer, p, n)); return 0; },
      proc_exit: code => { throw new Error(`the proc macro called proc_exit(${code})`); },
    };
    const wasiImports = new Proxy(wasi, { get: (t, k: string) => t[k] ?? (() => ERRNO_NOSYS) });
    const inst = new WebAssembly.Instance(module, { wasi_snapshot_preview1: wasiImports });
    const x = inst.exports as Record<string, any>;
    memory = x.memory;
    this.memory = memory;
    this.table = x.__indirect_function_table;
    this.malloc = x.malloc;
    this.free = x.free;
    this.realloc = x.realloc;
    if (!this.table || !this.malloc || !this.free || !this.realloc || !x._initialize) {
      throw new Error('not a proc-macro module for this host: it needs the exports _initialize, __indirect_function_table, malloc, free, realloc (the planner\'s link arguments)');
    }
    x._initialize();
    const decls = x[symbol] as WebAssembly.Global | undefined;
    if (!decls) throw new Error(`no export ${symbol}`);
    // The static holds a `&[Client]`: (pointer, length); each Client is a table index.
    const addr = Number(decls.value), v = view();
    const [ptr, len] = [v.getUint32(addr, true), v.getUint32(addr + 4, true)];
    this.clients = Array.from({ length: len }, (_, i) => v.getUint32(ptr + 4 * i, true));

    helperModule ??= new WebAssembly.Module(HELPER);
    const h = new WebAssembly.Instance(helperModule, { h: { r: this.hostReserve, d: this.hostDrop, c: this.hostCall } }).exports;
    const base = this.table.grow(3);
    this.table.set(base, h.reserve as Function);
    this.table.set(base + 1, h.drop as Function);
    this.table.set(base + 2, h.call as Function);
    this.fns = { reserve: base, drop: base + 1, call: base + 2 };
  }

  private words(at: number, n: number): number[] {
    const v = new DataView(this.memory.buffer);
    return Array.from({ length: n }, (_, i) => v.getUint32(at + 4 * i, true));
  }

  private setWords(at: number, words: number[]) {
    const v = new DataView(this.memory.buffer);
    words.forEach((w, i) => v.setUint32(at + 4 * i, w >>> 0, true));
  }

  private fn(index: number): Function {
    return this.table.get(index) as Function;
  }

  /** reserve(sret, &Buffer, additional) for buffers the host allocated (with the guest's malloc). */
  private hostReserve = (sret: number, buf: number, additional: number) => {
    const [data, len, cap, r, d] = this.words(buf, 5);
    const newCap = Math.max(cap * 2, len + additional);
    const p = this.realloc(data, newCap);
    this.setWords(sret, [p, len, newCap, r, d]);
  };

  private hostDrop = (buf: number) => {
    this.free(this.words(buf, 1)[0]);
  };

  /** The bridge's dispatch closure: one request out, its reply back in the request's buffer. */
  private hostCall = (sret: number, _env: number, buf: number) => {
    const [data, len, cap, r, d] = this.words(buf, 5);
    const request = new Uint8Array(this.memory.buffer, data, len).slice();
    const reply = this.dispatch!(request);
    const n = reply.length;
    if (n <= cap) {
      new Uint8Array(this.memory.buffer).set(reply, data);
      this.setWords(sret, [data, n, cap, r, d]);
    } else {
      // Grow it with its own `reserve` (the client's or ours), from an empty buffer.
      this.setWords(buf + 4, [0]);
      this.fn(r)(sret, buf, n);
      const p = this.words(sret, 1)[0];
      new Uint8Array(this.memory.buffer).set(reply, p);
      this.setWords(sret + 4, [n]);
    }
  };

  expand(index: number, input: Uint8Array, force: boolean, dispatch: Dispatch): Uint8Array {
    const n = input.length;
    const data = this.malloc(Math.max(n, 1));
    new Uint8Array(this.memory.buffer).set(input, data);
    // BridgeConfig { input: Buffer, dispatch: Closure { call, env }, force_show_panics }, then
    // the return area.
    const cfg = this.malloc(32 + 20), sret = cfg + 32;
    this.setWords(cfg, [data, n, Math.max(n, 1), this.fns.reserve, this.fns.drop, this.fns.call, 0, force ? 1 : 0]);
    this.dispatch = dispatch;
    try {
      this.fn(this.clients[index])(sret, cfg);
    } finally {
      this.dispatch = null;
    }
    const [out, len, , , dropFn] = this.words(sret, 5);
    const bytes = new Uint8Array(this.memory.buffer, out, len).slice();
    this.fn(dropFn)(sret);
    this.free(cfg);
    return bytes;
  }
}

/**
 * The `rust_pm` imports for one rustc instance (one per thread worker). `rustc` is that instance,
 * set after instantiation; `memory` is rustc's shared memory.
 */
export function procMacroImports(vfs: Vfs, memory: WebAssembly.Memory, rustc: () => WebAssembly.Instance) {
  const modules = new Map<string, { version: number; module: WebAssembly.Module; guest?: Guest; symbol: string }>();
  const bytes = (p: number, n: number) => new Uint8Array(memory.buffer).slice(p, p + n);
  const ctxWord = (ctx: number, field: number) => new DataView(memory.buffer).getUint32(ctx + field, true);
  const setCtxWord = (ctx: number, field: number, v: number) => new DataView(memory.buffer).setUint32(ctx + field, v >>> 0, true);
  const hostCall = (ctx: number, op: number, n: number): number => {
    const table = rustc().exports.__indirect_function_table as WebAssembly.Table;
    return (table.get(ctxWord(ctx, CTX.helper)) as Function)(ctx, op, n) >>> 0;
  };
  const putScratch = (ctx: number, data: Uint8Array) => {
    const p = hostCall(ctx, RESERVE, data.length);
    new Uint8Array(memory.buffer).set(data, p);
  };
  const scratch = (ctx: number) => bytes(ctxWord(ctx, CTX.ptr), ctxWord(ctx, CTX.len));
  const fail = (ctx: number, e: unknown) => putScratch(ctx, new TextEncoder().encode(String((e as Error)?.message ?? e)));
  // rustc's working directory is /.
  const vfsPath = (p: string) => (p.startsWith('/') ? p : `/${p}`);

  /** The module at `path`, (re)compiled if the file changed; its instance comes on first use. */
  const get = (path: string, symbol?: string) => {
    const data = vfs.readFile(vfsPath(path));
    const v = version(data);
    let m = modules.get(path);
    if (!m || m.version !== v) {
      m = { version: v, module: new WebAssembly.Module(data as Uint8Array<ArrayBuffer>), symbol: symbol ?? m?.symbol ?? '' };
      modules.set(path, m);
    }
    if (symbol) m.symbol = symbol;
    m.guest ??= new Guest(m.module, m.symbol);
    return m;
  };

  return {
    load(pathPtr: number, pathLen: number, symPtr: number, symLen: number, ctx: number): number {
      try {
        const m = get(dec.decode(bytes(pathPtr, pathLen)), dec.decode(bytes(symPtr, symLen)));
        setCtxWord(ctx, CTX.version, m.version);
        return m.guest!.clients.length;
      } catch (e) {
        fail(ctx, e);
        return -1;
      }
    },
    expand(pathPtr: number, pathLen: number, index: number, force: number, ctx: number): number {
      let m: ReturnType<typeof get> | undefined;
      try {
        m = get(dec.decode(bytes(pathPtr, pathLen)));
        if (m.version !== ctxWord(ctx, CTX.version)) throw new Error('the module changed since rustc loaded it');
        const out = m.guest!.expand(index, scratch(ctx), force !== 0, request => {
          putScratch(ctx, request);
          const n = hostCall(ctx, DISPATCH, request.length);
          return bytes(ctxWord(ctx, CTX.ptr), n);
        });
        putScratch(ctx, out);
        return 0;
      } catch (e) {
        // A trapped instance may be in any state: the next use gets a fresh one.
        const stderr = m?.guest?.stderr ?? '';
        if (m) m.guest = undefined;
        fail(ctx, `${(e as Error)?.message ?? e}${stderr ? `\n${stderr}` : ''}`);
        return 1;
      }
    },
  };
}
