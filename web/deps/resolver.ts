// The Cargo resolver (crates/resolver, built by scripts/build-resolver.sh) in the browser (WP-16).
// It's a wasm32-wasip1 module that never touches files, so a handful of WASI stubs does. JS
// supplies index files; each `resolve` reports either the files it still needs or the result.

export interface ResolvedPackage {
  name: string; version: string; source: 'path' | 'registry';
  checksum: string | null; features: string[];
  /** Indices into `packages`. */
  deps: number[];
}
export type ResolveResult =
  | { need: string[] }
  | { lock: string; packages: ResolvedPackage[] }
  | { error: string };

type Exports = {
  memory: WebAssembly.Memory;
  resolver_alloc(len: number): number;
  resolver_free(ptr: number, len: number): void;
  resolver_add_index(name: number, nameLen: number, data: number, dataLen: number, present: number): void;
  resolver_resolve(manifest: number, len: number): bigint;
};

const enc = new TextEncoder(), dec = new TextDecoder();
const ERRNO_BADF = 8, ERRNO_NOSYS = 52;

export class Resolver {
  private constructor(private readonly x: Exports, readonly stderr: string[]) {}

  static async load(url: string | URL): Promise<Resolver> {
    const module = await WebAssembly.compileStreaming(fetch(url));
    return Resolver.instantiate(module);
  }

  static async instantiate(module: WebAssembly.Module): Promise<Resolver> {
    const stderr: string[] = [];
    let x: Exports;
    const view = () => new DataView(x.memory.buffer);
    const wasi = {
      random_get: (p: number, n: number) => { crypto.getRandomValues(new Uint8Array(x.memory.buffer, p, n)); return 0; },
      environ_sizes_get: (c: number, s: number) => { view().setUint32(c, 0, true); view().setUint32(s, 0, true); return 0; },
      environ_get: () => 0,
      fd_prestat_get: () => ERRNO_BADF, // no preopened directories
      fd_prestat_dir_name: () => ERRNO_BADF,
      path_filestat_get: () => ERRNO_NOSYS,
      // Only panics write (to stderr); keep the text for error reports.
      fd_write: (_fd: number, iovs: number, n: number, written: number) => {
        let total = 0;
        for (let i = 0; i < n; i++) {
          const p = view().getUint32(iovs + 8 * i, true), l = view().getUint32(iovs + 8 * i + 4, true);
          stderr.push(dec.decode(new Uint8Array(x.memory.buffer, p, l)));
          total += l;
        }
        view().setUint32(written, total, true);
        return 0;
      },
      proc_exit: (code: number) => { throw new Error(`resolver exited (${code}): ${stderr.join('')}`); },
    };
    const inst = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
    x = inst.exports as unknown as Exports;
    return new Resolver(x, stderr);
  }

  private put(bytes: Uint8Array): [number, number] {
    const p = this.x.resolver_alloc(bytes.length);
    new Uint8Array(this.x.memory.buffer, p, bytes.length).set(bytes);
    return [p, bytes.length];
  }

  /** The index file of `name`, or null if the package doesn't exist. */
  addIndex(name: string, data: Uint8Array | null) {
    const [np, nl] = this.put(enc.encode(name));
    const [dp, dl] = this.put(data ?? new Uint8Array());
    this.x.resolver_add_index(np, nl, dp, dl, data ? 1 : 0);
  }

  resolve(manifest: string): ResolveResult {
    const [p, l] = this.put(enc.encode(manifest));
    let r: bigint;
    try {
      r = this.x.resolver_resolve(p, l);
    } catch (e) {
      throw new Error(`resolver trapped: ${(e as Error).message}\n${this.stderr.join('')}`);
    }
    const ptr = Number(r >> 32n), len = Number(r & 0xffffffffn);
    const text = dec.decode(new Uint8Array(this.x.memory.buffer, ptr, len));
    this.x.resolver_free(ptr, len);
    return JSON.parse(text);
  }
}
