// WP-01 baseline page: compile hello.rs with the oligamiq rust_wasm v3 rustc.wasm, then run the result.
// The page thread owns the in-memory filesystem (WASIFarm); rustc runs in a worker (rustc-worker.ts).
import { ConsoleStdout, Directory, File, type Inode, PreopenDirectory, WASI } from '@bjorn3/browser_wasi_shim';
import { WASIFarm } from '@oligami/browser_wasi_shim-threads';

const VENDOR = '/vendor/rust_wasm-v3/';
const HELLO = 'fn main() { println!("Hello from the browser"); }\n';

type Result = {
  ok: boolean; stage: string; error?: string;
  rustcStdout: string; rustcStderr: string; rustcExit?: number; programStdout: string;
  ms: Record<string, number>;
};
const result: Result = { ok: false, stage: 'start', rustcStdout: '', rustcStderr: '', programStdout: '', ms: {} };
(window as any).partial = result;
const log = (s: string) => { document.getElementById('log')!.textContent += s + '\n'; };

function capture(key: 'rustcStdout' | 'rustcStderr') {
  const dec = new TextDecoder();
  return new ConsoleStdout(buf => { result[key] += dec.decode(buf, { stream: true }); });
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

// Build a nested Directory from "a/b/c.rlib" paths.
async function loadSysroot(): Promise<Directory> {
  const paths: string[] = await (await fetch(VENDOR + 'sysroot.json')).json();
  const root = new Map<string, Inode>();
  await Promise.all(paths.map(async p => {
    const parts = p.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      if (!dir.has(part)) dir.set(part, new Directory(new Map()));
      dir = (dir.get(part) as Directory).contents;
    }
    dir.set(parts.at(-1)!, new File(await fetchBytes(VENDOR + 'sysroot/' + p)));
  }));
  return new Directory(root);
}

async function main() {
  const t0 = performance.now();
  const lap = (name: string, since: number) => (result.ms[name] = Math.round(performance.now() - since));

  result.stage = 'load-sysroot';
  const sysroot = await loadSysroot();
  lap('loadSysroot', t0);

  const root = new PreopenDirectory('/', new Map<string, Inode>([
    ['hello.rs', new File(new TextEncoder().encode(HELLO))],
    ['sysroot', sysroot],
    ['tmp', new Directory(new Map())],
  ]));
  const farm = new WASIFarm(new ConsoleStdout(() => {}), capture('rustcStdout'), capture('rustcStderr'), [root], {
    // Reads go through a shared bounce buffer (default 10 MB); libcore.rlib alone is 32 MB.
    allocator_size: 128 * 1024 * 1024,
  });

  result.stage = 'rustc';
  const t1 = performance.now();
  const worker = new Worker('rustc-worker.js', { type: 'module' });
  const done = new Promise<{ code?: number; error?: string; ms: Record<string, number> }>(res => {
    worker.onmessage = e => res(e.data);
    worker.onerror = e => res({ error: String(e.message), ms: {} });
  });
  worker.postMessage({
    ref: farm.get_ref(),
    wasmUrl: VENDOR + (new URLSearchParams(location.search).get('rustc') ?? 'rustc_opt.wasm'),
    args: ['/hello.rs', '--sysroot', '/sysroot', '--target', 'wasm32-wasip1', '-o', '/hello.wasm'],
  });
  const r = await done;
  Object.assign(result.ms, r.ms);
  lap('rustcTotal', t1);
  result.rustcExit = r.code;
  if (r.error) throw new Error('rustc worker: ' + r.error);
  if (r.code !== 0) throw new Error(`rustc exited with ${r.code}`);

  result.stage = 'run';
  const out = root.dir.contents.get('hello.wasm');
  if (!(out instanceof File)) throw new Error('rustc produced no /hello.wasm');
  const t2 = performance.now();
  const dec = new TextDecoder();
  const wasi = new WASI(['hello'], [], [
    new ConsoleStdout(() => {}), // empty stdin
    new ConsoleStdout(buf => { result.programStdout += dec.decode(buf, { stream: true }); }),
    capture('rustcStderr'),
  ]);
  const inst = await WebAssembly.instantiate(await WebAssembly.compile(out.data as Uint8Array<ArrayBuffer>), {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  wasi.start(inst as any);
  lap('run', t2);
  lap('total', t0);
  result.ok = true;
  result.stage = 'done';
}

main()
  .catch(e => { result.error = String(e?.stack ?? e); })
  .finally(() => {
    log(JSON.stringify(result, null, 2));
    (window as any).result = result;
  });
