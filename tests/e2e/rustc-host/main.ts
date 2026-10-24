// WP-07 e2e page: our rustc 1.99.1 host build (panic=unwind, exnref) on the VFS + WASI adapter, with
// rustup's wasm32-wasip1 std as the sysroot. Driven through `window.rustcHost`. Assets are prepared
// by scripts/prep-rustc-host-page.sh.
import { createVfs, Vfs, type VfsHandle } from '../../../web/vfs/vfs';
import { importedMemoryLimits, runProcess } from '../../../web/wasi/process';

let handle: VfsHandle, vfs: Vfs;
const modules: Record<string, { module: WebAssembly.Module; limits: { initial: number; maximum: number } }> = {};

async function load(names: string[]) {
  const t0 = performance.now();
  handle = await createVfs('vfs.wasm');
  vfs = await Vfs.attach(handle);
  const paths: string[] = await (await fetch('sysroot.json')).json();
  await Promise.all(paths.map(async p =>
    vfs.writeFile('/sysroot/' + p, new Uint8Array(await (await fetch('sysroot/' + p)).arrayBuffer()))));
  for (const n of names) {
    const bytes = new Uint8Array(await (await fetch(n)).arrayBuffer());
    modules[n] = { module: await WebAssembly.compile(bytes), limits: importedMemoryLimits(bytes) };
  }
  // rustc trusts argv[0] for its sysroot only if it is a symlink, then checks lib/rustlib relative
  // to the working directory (/), hence the second link (see scripts/verify/wp-05.sh).
  vfs.mkdirAll('/sysroot/bin');
  vfs.symlink('../lib/rustc-is-a-wasm-module', '/sysroot/bin/rustc');
  vfs.mkdirAll('/lib');
  vfs.symlink('/sysroot/lib/rustlib', '/lib/rustlib');
  vfs.mkdirAll('/work');
  vfs.mkdirAll('/proc');
  return { ms: Math.round(performance.now() - t0), sysrootFiles: paths.length };
}

let runs = 0;

/** One process (one Wasm instance) of `name` with `args`. */
async function rustc(name: string, args: string[], env: string[] = []) {
  const { module, limits } = modules[name];
  const n = ++runs, out = `/proc/${n}.out`, err = `/proc/${n}.err`;
  const memory = new WebAssembly.Memory({ ...limits, shared: true });
  const r = await runProcess(vfs, handle, module, memory, {
    args: ['/sysroot/bin/rustc', ...args], env: ['RUST_MIN_STACK=16777216', ...env], stdout: out, stderr: err, preopens: [['/', '/']],
  }, new URL('process-worker.js', location.href));
  const res = { ...r, stdout: vfs.readText(out), stderr: vfs.readText(err) };
  vfs.unlink(out);
  vfs.unlink(err);
  return res;
}

const writeFile = (path: string, text: string) => vfs.writeFile(path, text);
const ls = (path: string) => vfs.readdir(path).map(e => e.name);

(window as any).rustcHost = { load, rustc, writeFile, ls };
(window as any).rustcHostReady = true;
