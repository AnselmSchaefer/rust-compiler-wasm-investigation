// WP-11 e2e page: the WP-01 baseline rustc.wasm (oligamiq v3) on our own VFS + WASI adapter,
// instead of browser_wasi_shim. Driven through `window.rustcVfs`.
import { createVfs, Vfs, type VfsHandle } from '../../../web/vfs/vfs';
import { createProcess, freeProcess, ProcExit, WasiProcess } from '../../../web/wasi/wasi';
import { importedMemoryLimits, runProcess } from '../../../web/wasi/process';

const VENDOR = '/vendor/rust_wasm-v3/';
let handle: VfsHandle, vfs: Vfs, module: WebAssembly.Module, limits: { initial: number; maximum: number };

async function load(rustc = 'rustc_opt.wasm') {
  const t0 = performance.now();
  handle = await createVfs('vfs.wasm');
  vfs = await Vfs.attach(handle);
  const paths: string[] = await (await fetch(VENDOR + 'sysroot.json')).json();
  const [bytes] = await Promise.all([
    fetch(VENDOR + rustc).then(r => r.arrayBuffer()).then(b => new Uint8Array(b)),
    ...paths.map(async p => vfs.writeFile('/sysroot/' + p, new Uint8Array(await (await fetch(VENDOR + 'sysroot/' + p)).arrayBuffer()))),
  ]);
  const fetchMs = performance.now() - t0;
  limits = importedMemoryLimits(bytes);
  module = await WebAssembly.compile(bytes);
  vfs.mkdirAll('/work');
  vfs.mkdirAll('/proc');
  return { fetchMs: Math.round(fetchMs), totalMs: Math.round(performance.now() - t0), vfsInodes: vfs.inodeCount() };
}

let runs = 0;

async function rustc(args: string[]) {
  const n = ++runs, out = `/proc/${n}.out`, err = `/proc/${n}.err`;
  const memory = new WebAssembly.Memory({ ...limits, shared: true });
  const r = await runProcess(vfs, handle, module, memory, {
    args: ['rustc', ...args], env: ['RUST_MIN_STACK=16777216'], stdout: out, stderr: err, preopens: [['/', '/']],
  }, new URL('process-worker.js', location.href));
  const res = { ...r, stdout: vfs.readText(out), stderr: vfs.readText(err), memBytes: memory.buffer.byteLength };
  vfs.unlink(out);
  vfs.unlink(err);
  return res;
}

/** Run a (non-threaded) wasip1 program from the VFS on the page thread. */
async function run(path: string) {
  const t0 = performance.now();
  const pid = createProcess(vfs, { args: [path], env: [], stdout: '/proc/run.out', stderr: '/proc/run.err', preopens: [['/', '/']] });
  const wasi = new WasiProcess(vfs, pid, [path], []);
  const inst = await WebAssembly.instantiate(await WebAssembly.compile(vfs.readFile(path) as Uint8Array<ArrayBuffer>), {
    wasi_snapshot_preview1: wasi.imports,
  });
  wasi.setMemory((inst.exports as { memory: WebAssembly.Memory }).memory);
  let code = 0;
  try {
    (inst.exports as { _start(): void })._start();
  } catch (e) {
    if (!(e instanceof ProcExit)) throw e;
    code = e.code;
  }
  freeProcess(vfs, pid);
  const stdout = vfs.readText('/proc/run.out');
  vfs.unlink('/proc/run.out');
  vfs.unlink('/proc/run.err');
  return { code, stdout, ms: Math.round(performance.now() - t0) };
}

const writeFile = (path: string, text: string) => vfs.writeFile(path, text);
const ls = (path: string) => vfs.readdir(path).map(e => e.name);
const symlink = (target: string, path: string) => {
  vfs.mkdirAll(path.slice(0, path.lastIndexOf('/')));
  vfs.symlink(target, path);
};

(window as any).rustcVfs = { load, rustc, run, writeFile, ls, symlink };
(window as any).rustcVfsReady = true;
