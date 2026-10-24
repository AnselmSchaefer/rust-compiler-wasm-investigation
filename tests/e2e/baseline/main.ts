// Baseline harness page for the oligamiq rust_wasm v3 toolchain (WP-01 e2e test, WP-02 benchmarks).
// The page thread owns the in-memory filesystem (WASIFarm); rustc runs in a worker (rustc-worker.ts).
// Driven from Playwright through `window.harness`; every step reports its own timings.
import { ConsoleStdout, Directory, File, type Inode, PreopenDirectory, WASI } from '@bjorn3/browser_wasi_shim';
import { WASIFarm } from '@oligami/browser_wasi_shim-threads';

const VENDOR = '/vendor/rust_wasm-v3/';

export type RustcResult = { code?: number; error?: string; stdout: string; stderr: string; ms: number; memBytes?: number };

const io = { stdout: '', stderr: '' };
let root: PreopenDirectory;
let worker: Worker;
let pending: ((r: any) => void) | undefined;
let transferBytes = 0;

const ms = (since: number) => Math.round(performance.now() - since);

function capture(key: 'stdout' | 'stderr') {
  const dec = new TextDecoder();
  return new ConsoleStdout(buf => { io[key] += dec.decode(buf, { stream: true }); });
}

// Counts bytes on the wire (brotli-encoded when the server has a .br variant).
function countTransfer(url: string) {
  const e = performance.getEntriesByName(new URL(url, location.href).href).at(-1) as PerformanceResourceTiming | undefined;
  transferBytes += e?.encodedBodySize ?? 0;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const b = new Uint8Array(await r.arrayBuffer());
  countTransfer(url);
  return b;
}

// Build a nested Directory from "a/b/c.rlib" paths.
async function loadSysroot(): Promise<Directory> {
  const paths: string[] = await (await fetch(VENDOR + 'sysroot.json')).json();
  const tree = new Map<string, Inode>();
  await Promise.all(paths.map(async p => {
    const parts = p.split('/');
    let dir = tree;
    for (const part of parts.slice(0, -1)) {
      if (!dir.has(part)) dir.set(part, new Directory(new Map()));
      dir = (dir.get(part) as Directory).contents;
    }
    dir.set(parts.at(-1)!, new File(await fetchBytes(VENDOR + 'sysroot/' + p)));
  }));
  return new Directory(tree);
}

function call(msg: object): Promise<any> {
  return new Promise(res => { pending = res; worker.postMessage(msg); });
}

const harness = {
  /** Fetch + compile rustc.wasm and the sysroot, start the rustc worker. */
  async load(rustc = 'rustc_opt.wasm') {
    performance.setResourceTimingBufferSize(10_000);
    transferBytes = 0;
    const t0 = performance.now();
    const [sysroot, rustcBytes] = await Promise.all([
      loadSysroot().then(d => [d, ms(t0)] as const),
      fetchBytes(VENDOR + rustc).then(b => [b, ms(t0)] as const),
    ]);
    const t1 = performance.now();
    const module = await WebAssembly.compile(rustcBytes[0] as Uint8Array<ArrayBuffer>);
    const compileMs = ms(t1);

    root = new PreopenDirectory('/', new Map<string, Inode>([['sysroot', sysroot[0]], ['tmp', new Directory(new Map())]]));
    const farm = new WASIFarm(new ConsoleStdout(() => {}), capture('stdout'), capture('stderr'), [root], {
      // Reads go through a shared bounce buffer (default 10 MB); libcore.rlib alone is 32 MB.
      allocator_size: 128 * 1024 * 1024,
    });
    worker = new Worker('rustc-worker.js', { type: 'module' });
    worker.onmessage = e => pending?.(e.data);
    worker.onerror = e => pending?.({ error: String(e.message) });
    await call({ type: 'init', ref: farm.get_ref(), module });
    return {
      fetchSysrootMs: sysroot[1], fetchRustcMs: rustcBytes[1], compileRustcMs: compileMs, totalMs: ms(t0),
      transferBytes, rustcBytes: rustcBytes[0].byteLength,
    };
  },

  writeFile(path: string, text: string) {
    root.dir.contents.set(path.replace(/^\//, ''), new File(new TextEncoder().encode(text)));
  },

  /** One rustc invocation in a fresh instance (fresh linear memory). */
  async rustc(args: string[]): Promise<RustcResult> {
    io.stdout = io.stderr = '';
    const r = await call({ type: 'run', args });
    return { ...r, stdout: io.stdout, stderr: io.stderr };
  },

  /** Run a WASI command produced by rustc on the page thread. */
  async run(path: string) {
    const out = root.dir.contents.get(path.replace(/^\//, ''));
    if (!(out instanceof File)) throw new Error(`no ${path}`);
    const t0 = performance.now();
    let stdout = '';
    const dec = new TextDecoder();
    const wasi = new WASI([path], [], [
      new ConsoleStdout(() => {}), // empty stdin
      new ConsoleStdout(buf => { stdout += dec.decode(buf, { stream: true }); }),
      new ConsoleStdout(() => {}),
    ]);
    const inst = await WebAssembly.instantiate(await WebAssembly.compile(out.data as Uint8Array<ArrayBuffer>), {
      wasi_snapshot_preview1: wasi.wasiImport,
    });
    const code = wasi.start(inst as any);
    return { code, stdout, ms: ms(t0) };
  },

  /** Whole-agent memory (Chromium only, needs cross-origin isolation). Undefined if unavailable. */
  async measureMemory(timeoutMs = 30_000): Promise<number | undefined> {
    const p = (performance as any).measureUserAgentSpecificMemory?.();
    if (!p) return undefined;
    const r = await Promise.race([p, new Promise(res => setTimeout(res, timeoutMs))]);
    return (r as any)?.bytes;
  },
};

(window as any).harness = harness;
(window as any).harnessReady = true;
